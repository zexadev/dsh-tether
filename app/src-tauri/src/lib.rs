//! DSH Tether 手机端 Rust 核心:iroh 连接、配对、审批事件转发。
//!
//! 前端只做渲染与两个按钮;连接生命周期全在这层。按「打开 app 时连接」设计,
//! 无后台常驻(Android doze 语义下这是产品决定,不是缺陷)。

use std::path::PathBuf;

use anyhow::{bail, Context as _, Result};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId};
use tether_core::{load_or_create_secret, read_line_bounded, write_line, Wire, ALPN, MAX_LINE};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};

#[derive(Default)]
struct AppState {
    ep: Mutex<Option<Endpoint>>,
    /// 在线连接的决定发送端;None = 未连接
    outgoing: Mutex<Option<mpsc::Sender<Wire>>>,
    /// 本地代理监听端口;WebView 指向它即拿到主机的完整 dsh web UI
    proxy_port: Mutex<Option<u16>>,
}

/// 一台已配对主机
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostRecord {
    id: String,
    /// 配对时用户给这台主机起的名字;空则前端显示 ID 前缀
    #[serde(default)]
    label: String,
}

/// 手机侧的主机簿:配过的都留着,不必为换一台重填凭证
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HostBook {
    hosts: Vec<HostRecord>,
    /// 上次连的那台,下次打开直接用
    current: Option<String>,
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

fn host_book_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(data_dir(app)?.join("hosts.json"))
}

fn load_book(app: &AppHandle) -> HostBook {
    let Ok(path) = host_book_path(app) else { return HostBook::default() };
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(book) = serde_json::from_slice::<HostBook>(&bytes) {
            return book
        }
    }
    // 单主机时代的 host.json:读一次迁移过来,免得老用户要重新配对
    let Ok(dir) = data_dir(app) else { return HostBook::default() };
    let legacy = dir.join("host.json");
    let Ok(bytes) = std::fs::read(&legacy) else { return HostBook::default() };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return HostBook::default() };
    let Some(id) = value.get("id").and_then(|v| v.as_str()) else { return HostBook::default() };
    HostBook {
        hosts: vec![HostRecord { id: id.to_string(), label: String::new() }],
        current: Some(id.to_string()),
    }
}

fn save_book(app: &AppHandle, book: &HostBook) -> Result<()> {
    let path = host_book_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(book)?)?;
    Ok(())
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
async fn run_connection(app: AppHandle, peer: EndpointId, first: Wire, pair_label: Option<String>) {
    if let Err(e) = run_connection_inner(&app, peer, first, pair_label).await {
        emit_state(&app, "disconnected", format!("{e:#}"));
    } else {
        emit_state(&app, "disconnected", "连接已断开");
    }
    let state = app.state::<AppState>();
    *state.outgoing.lock().await = None;
}

async fn run_connection_inner(
    app: &AppHandle,
    peer: EndpointId,
    first: Wire,
    pair_label: Option<String>,
) -> Result<()> {
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
                let id = peer.to_string();
                let label = pair_label.unwrap_or_default();
                let mut book = load_book(app);
                match book.hosts.iter_mut().find(|h| h.id == id) {
                    Some(existing) => existing.label = label,
                    None => book.hosts.push(HostRecord { id: id.clone(), label }),
                }
                book.current = Some(id);
                save_book(app, &book)?;
            }
            Wire::PairFail { reason } => bail!("配对失败: {reason}"),
            _ => bail!("配对应答不符合协议"),
        }
    }

    let (tx, mut rx) = mpsc::channel::<Wire>(16);
    *state.outgoing.lock().await = Some(tx);

    // 本地代理:每条入站 TCP 对应一条 iroh 代理流,WebView 由此拿到主机的完整
    // dsh web UI。端口交给 OS 分配,避免与手机上其它应用抢固定端口。
    match start_proxy(app.clone(), conn.clone()).await {
        Ok(port) => {
            *state.proxy_port.lock().await = Some(port);
            let _ = app.emit("remote:proxy-ready", serde_json::json!({ "url": format!("http://127.0.0.1:{port}/") }));
        }
        Err(e) => emit_state(app, "connecting", format!("代理启动失败: {e:#}")),
    }
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

/// 起本地 TCP 监听,每条连接开一条 iroh 代理流转发;返回 OS 分配的端口。
/// 监听任务随连接生命周期结束:连接断开后 open_bi 失败,浏览器侧表现为加载失败。
async fn start_proxy(app: AppHandle, conn: iroh::endpoint::Connection) -> Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("本地代理监听失败")?;
    let port = listener.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        let _keep_app_alive = app;
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else { break };
            let conn = conn.clone();
            tauri::async_runtime::spawn(async move {
                let Ok((mut send, recv)) = conn.open_bi().await else { return };
                let line = serde_json::to_string(&Wire::Proxy).expect("Wire 可序列化");
                if write_line(&mut send, &line).await.is_err() {
                    return;
                }
                let mut stream = tokio::io::join(recv, send);
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
            });
        }
    });
    Ok(port)
}

fn parse_peer(peer: &str) -> Result<EndpointId, String> {
    peer.trim().parse().map_err(|e| format!("主机 ID 无效: {e}"))
}

#[tauri::command]
fn list_hosts(app: AppHandle) -> HostBook {
    load_book(&app)
}

/// 构建时写死的版本号,避免界面上再手抄一份而漂移
#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// 给已保存的主机改名。凭证不变,只动本地显示名。
#[tauri::command]
fn rename_host(app: AppHandle, id: String, label: String) -> Result<HostBook, String> {
    let mut book = load_book(&app);
    let Some(host) = book.hosts.iter_mut().find(|h| h.id == id) else {
        return Err("这台电脑不在已配对列表里".into());
    };
    host.label = label.trim().to_string();
    save_book(&app, &book).map_err(|e| format!("{e:#}"))?;
    Ok(book)
}

#[tauri::command]
fn forget_host(app: AppHandle, id: String) -> Result<HostBook, String> {
    let mut book = load_book(&app);
    book.hosts.retain(|h| h.id != id);
    if book.current.as_deref() == Some(id.as_str()) {
        book.current = book.hosts.first().map(|h| h.id.clone());
    }
    save_book(&app, &book).map_err(|e| format!("{e:#}"))?;
    Ok(book)
}

#[tauri::command]
async fn pair(
    app: AppHandle,
    peer: String,
    code: String,
    name: String,
    label: String,
) -> Result<(), String> {
    let peer = parse_peer(&peer)?;
    let code = code.trim().to_string();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err("配对码应为 6 位数字".into());
    }
    let name = if name.trim().is_empty() { "我的手机".to_string() } else { name.trim().to_string() };
    tauri::async_runtime::spawn(run_connection(
        app,
        peer,
        Wire::Pair { code, name },
        Some(label.trim().to_string()),
    ));
    Ok(())
}

/// 连接指定主机;不给 id 就连上次那台。选定的会记为 current。
#[tauri::command]
async fn connect(app: AppHandle, id: Option<String>) -> Result<(), String> {
    let mut book = load_book(&app);
    let target = id.or_else(|| book.current.clone()).or_else(|| book.hosts.first().map(|h| h.id.clone()));
    let Some(target) = target else {
        return Err("还没有配对过的电脑".into());
    };
    if !book.hosts.iter().any(|h| h.id == target) {
        return Err("这台电脑不在已配对列表里".into());
    }
    if book.current.as_deref() != Some(target.as_str()) {
        book.current = Some(target.clone());
        save_book(&app, &book).map_err(|e| format!("{e:#}"))?;
    }
    let peer = parse_peer(&target)?;
    let name = "我的手机".to_string();
    tauri::async_runtime::spawn(run_connection(app, peer, Wire::Hello { name }, None));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_hosts,
            rename_host,
            forget_host,
            pair,
            connect,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("tauri 启动失败");
}
