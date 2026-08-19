//! DSH Remote 手机端 Rust 核心:iroh 连接、配对、审批事件转发。
//!
//! 前端只做渲染与两个按钮;连接生命周期全在这层。按「打开 app 时连接」设计,
//! 无后台常驻(Android doze 语义下这是产品决定,不是缺陷)。

use std::path::PathBuf;

use anyhow::{bail, Context as _, Result};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId};
use remote_core::{load_or_create_secret, read_line_bounded, write_line, Wire, ALPN, MAX_LINE};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};

#[derive(Default)]
struct AppState {
    ep: Mutex<Option<Endpoint>>,
    /// 在线连接的决定发送端;None = 未连接
    outgoing: Mutex<Option<mpsc::Sender<Wire>>>,
}

/// 已配对 host 的持久记录
#[derive(Serialize, Deserialize, Clone)]
struct HostRecord {
    id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    status: &'static str,
    detail: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovalEvent {
    id: String,
    tool_name: String,
    reason: String,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_data_dir().context("取不到应用数据目录")
}

fn host_record_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(data_dir(app)?.join("host.json"))
}

fn emit_state(app: &AppHandle, status: &'static str, detail: impl Into<String>) {
    let _ = app.emit("remote:state", StateEvent { status, detail: detail.into() });
}

async fn get_or_init_endpoint(app: &AppHandle, state: &AppState) -> Result<Endpoint> {
    let mut guard = state.ep.lock().await;
    if let Some(ep) = guard.as_ref() {
        return Ok(ep.clone());
    }
    let secret = load_or_create_secret(&data_dir(app)?.join("identity.key"))?;
    let ep = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .bind()
        .await
        .context("iroh endpoint 启动失败")?;
    *guard = Some(ep.clone());
    Ok(ep)
}

/// 连接 actor:发首行(Pair 或 Hello),配对成功即持久化 host,
/// 之后读侧转事件给前端、写侧从 mpsc 取决定,断开清理并广播状态。
async fn run_connection(app: AppHandle, peer: EndpointId, first: Wire) {
    if let Err(e) = run_connection_inner(&app, peer, first).await {
        emit_state(&app, "disconnected", format!("{e:#}"));
    } else {
        emit_state(&app, "disconnected", "连接已断开");
    }
    let state = app.state::<AppState>();
    *state.outgoing.lock().await = None;
}

async fn run_connection_inner(app: &AppHandle, peer: EndpointId, first: Wire) -> Result<()> {
    emit_state(app, "connecting", "正在连接主机…");
    let state = app.state::<AppState>();
    let ep = get_or_init_endpoint(app, &state).await?;
    let conn = ep
        .connect(peer, ALPN)
        .await
        .context("连不上主机(插件未运行、ID 不对或网络不可达)")?;
    let (mut send, mut recv) = conn.open_bi().await.context("打开控制流失败")?;

    let pairing = matches!(first, Wire::Pair { .. });
    write_line(&mut send, &serde_json::to_string(&first)?).await?;
    if pairing {
        let resp = read_line_bounded(&mut recv, MAX_LINE)
            .await
            .context("配对被主机拒绝(配对码错误或窗口已关闭)")?;
        match serde_json::from_str::<Wire>(&resp)? {
            Wire::PairOk => {
                let path = host_record_path(app)?;
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(&path, serde_json::to_vec(&HostRecord { id: peer.to_string() })?)?;
            }
            Wire::PairFail { reason } => bail!("配对失败: {reason}"),
            _ => bail!("配对应答不符合协议"),
        }
    }

    let (tx, mut rx) = mpsc::channel::<Wire>(16);
    *state.outgoing.lock().await = Some(tx);
    emit_state(app, "connected", "已连接");

    let writer = async {
        while let Some(msg) = rx.recv().await {
            let line = serde_json::to_string(&msg).expect("Wire 可序列化");
            if write_line(&mut send, &line).await.is_err() {
                break;
            }
        }
    };
    let reader = async {
        loop {
            let line = match read_line_bounded(&mut recv, MAX_LINE).await {
                Ok(l) => l,
                Err(_) => break,
            };
            match serde_json::from_str::<Wire>(&line) {
                Ok(Wire::Approval { id, tool_name, reason }) => {
                    let _ = app.emit("remote:approval", ApprovalEvent { id, tool_name, reason });
                }
                Ok(Wire::ApprovalCancel { id }) => {
                    let _ = app.emit("remote:approval-cancel", serde_json::json!({ "id": id }));
                }
                _ => {}
            }
        }
    };
    tokio::join!(writer, reader);
    Ok(())
}

fn parse_peer(peer: &str) -> Result<EndpointId, String> {
    peer.trim().parse().map_err(|e| format!("主机 ID 无效: {e}"))
}

#[tauri::command]
fn get_host(app: AppHandle) -> Option<String> {
    let path = host_record_path(&app).ok()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice::<HostRecord>(&bytes).ok().map(|r| r.id)
}

#[tauri::command]
async fn pair(app: AppHandle, peer: String, code: String, name: String) -> Result<(), String> {
    let peer = parse_peer(&peer)?;
    let code = code.trim().to_string();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err("配对码应为 6 位数字".into());
    }
    let name = if name.trim().is_empty() { "我的手机".to_string() } else { name.trim().to_string() };
    tauri::async_runtime::spawn(run_connection(app, peer, Wire::Pair { code, name }));
    Ok(())
}

#[tauri::command]
async fn connect(app: AppHandle) -> Result<(), String> {
    let Some(saved) = get_host(app.clone()) else {
        return Err("尚未配对主机".into());
    };
    let peer = parse_peer(&saved)?;
    let name = "我的手机".to_string();
    tauri::async_runtime::spawn(run_connection(app, peer, Wire::Hello { name }));
    Ok(())
}

#[tauri::command]
async fn decide(state: State<'_, AppState>, id: String, allow: bool) -> Result<(), String> {
    let outcome = if allow { "allowed-once" } else { "rejected" };
    let guard = state.outgoing.lock().await;
    let Some(tx) = guard.as_ref() else {
        return Err("当前未连接主机".into());
    };
    tx.send(Wire::Decision { id, outcome: outcome.into() })
        .await
        .map_err(|_| "连接已断开".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![get_host, pair, connect, decide])
        .run(tauri::generate_context!())
        .expect("tauri 启动失败");
}
