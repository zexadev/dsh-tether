//! mobile-remote-host:dsh 审批遥控的电脑侧 iroh 端。
//!
//! `host` 模式作为 dsh 插件的 sidecar 运行:stdin/stdout 走 JSON-lines 与插件通信,
//! stderr 只做人读日志;iroh 侧一条连接一条控制 bi 流,同样 JSON-lines。
//! `phone-sim` 是手机端的参考实现/联调替身,与将来 Tauri 端说同一套线协议。
//!
//! 配对模型:6 位 CSPRNG 数字码 + 窗口 TTL + 全窗口 3 次尝试上限;配对通过后把
//! iroh TLS 已验证的 EndpointId 持久入白名单,之后凭 ID 直连,码即作废。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use clap::{Parser, Subcommand};
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId};
use rand::Rng;
use remote_core::{load_or_create_secret, read_line_bounded, write_line, Wire, ALPN, MAX_LINE, MAX_UNPAIRED_LINE};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Mutex};

const PAIRING_TTL: Duration = Duration::from_secs(600);
const PAIRING_MAX_ATTEMPTS: u32 = 3;

#[derive(Parser)]
#[command(name = "mobile-remote-host", about = "dsh 审批遥控:电脑侧 iroh 端(插件 sidecar)与手机模拟端")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// sidecar 模式:stdio JSON-lines 对插件,iroh 对手机
    Host {
        /// 身份与配对白名单目录
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// 启动即开配对窗口(默认仅在白名单为空时自动开)
        #[arg(long)]
        pair: bool,
    },
    /// 手机端替身:连接 host,打印审批请求并按策略应答
    PhoneSim {
        /// host 的设备 ID
        #[arg(long)]
        peer: String,
        /// 配对码(首次连接用;已配对则省略)
        #[arg(long)]
        code: Option<String>,
        /// 设备名(配对时登记)
        #[arg(long, default_value = "phone-sim")]
        name: String,
        /// 收到审批后的应答策略
        #[arg(long, value_parser = ["allow", "reject"], default_value = "allow")]
        auto: String,
        /// 应答前延迟毫秒(模拟人掏手机)
        #[arg(long, default_value_t = 2000)]
        delay: u64,
        #[arg(long)]
        data_dir: Option<PathBuf>,
    },
    /// 打印 host 身份 ID
    Id {
        #[arg(long)]
        data_dir: Option<PathBuf>,
    },
}

/// 插件 → sidecar(stdin)
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum PluginIn {
    Approval { id: String, tool_name: String, reason: String },
    ApprovalCancel { id: String },
    PairingBegin,
}

/// sidecar → 插件(stdout)
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum PluginOut {
    Ready { endpoint_id: String },
    Pairing { code: String, expires_in_sec: u64 },
    PairingClosed { reason: String },
    PairingDone { peer: String, name: String },
    PeerConnected { peer: String, name: String },
    PeerDisconnected { peer: String },
    Decision { id: String, outcome: String },
}

#[derive(Serialize, Deserialize, Default)]
struct PairedStore {
    devices: Vec<PairedDevice>,
}

#[derive(Serialize, Deserialize, Clone)]
struct PairedDevice {
    id: String,
    name: String,
    paired_at: String,
}

struct PairingWindow {
    code: String,
    deadline: tokio::time::Instant,
    attempts: u32,
}

struct HostState {
    store_path: PathBuf,
    store: PairedStore,
    pairing: Option<PairingWindow>,
    /// 已连接手机的下行发送端(EndpointId 字符串 → 控制流写队列)
    conns: HashMap<String, mpsc::Sender<String>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Id { data_dir } => {
            let dir = data_dir.unwrap_or_else(default_data_dir);
            let secret = load_or_create_secret(&dir.join("identity.key"))?;
            println!("{}", secret.public());
        }
        Cmd::Host { data_dir, pair } => host_main(data_dir.unwrap_or_else(default_data_dir), pair).await?,
        Cmd::PhoneSim { peer, code, name, auto, delay, data_dir } => {
            let dir = data_dir.unwrap_or_else(|| default_data_dir_named("dsh-remote-phone-sim"));
            phone_sim_main(dir, peer, code, name, auto, delay).await?
        }
    }
    Ok(())
}

fn default_data_dir() -> PathBuf {
    default_data_dir_named("dsh-remote")
}

fn default_data_dir_named(name: &str) -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join(name)
}

fn load_store(path: &Path) -> PairedStore {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_store(path: &Path, store: &PairedStore) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(store)?)?;
    Ok(())
}

fn new_pairing_window() -> PairingWindow {
    let code = format!("{:06}", rand::rng().random_range(0..1_000_000u32));
    PairingWindow { code, deadline: tokio::time::Instant::now() + PAIRING_TTL, attempts: 0 }
}

fn emit(msg: &PluginOut) {
    // stdout 是插件协议通道;序列化失败属编程错误,直接崩比静默丢事件好
    println!("{}", serde_json::to_string(msg).expect("PluginOut 可序列化"));
}

async fn host_main(data_dir: PathBuf, force_pair: bool) -> Result<()> {
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    let store_path = data_dir.join("paired.json");
    let store = load_store(&store_path);
    let ep = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .context("iroh endpoint 启动失败")?;
    emit(&PluginOut::Ready { endpoint_id: ep.id().to_string() });

    let mut state = HostState { store_path, store, pairing: None, conns: HashMap::new() };
    if force_pair || state.store.devices.is_empty() {
        let w = new_pairing_window();
        emit(&PluginOut::Pairing { code: w.code.clone(), expires_in_sec: PAIRING_TTL.as_secs() });
        state.pairing = Some(w);
    }
    let state = Arc::new(Mutex::new(state));

    // stdin:插件下发审批/取消/开配对
    tokio::spawn(stdin_loop(state.clone()));

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            incoming = ep.accept() => {
                let Some(incoming) = incoming else { break };
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_phone(incoming, state).await {
                        eprintln!("[host] 入站连接处理失败: {e:#}");
                    }
                });
            }
        }
    }
    ep.close().await;
    Ok(())
}

async fn stdin_loop(state: Arc<Mutex<HostState>>) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let msg: PluginIn = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[host] 无法解析插件消息: {e}: {line}");
                continue;
            }
        };
        match msg {
            PluginIn::Approval { id, tool_name, reason } => {
                let wire = serde_json::to_string(&Wire::Approval { id, tool_name, reason }).expect("Wire 可序列化");
                broadcast(&state, wire).await;
            }
            PluginIn::ApprovalCancel { id } => {
                let wire = serde_json::to_string(&Wire::ApprovalCancel { id }).expect("Wire 可序列化");
                broadcast(&state, wire).await;
            }
            PluginIn::PairingBegin => {
                let mut s = state.lock().await;
                let w = new_pairing_window();
                emit(&PluginOut::Pairing { code: w.code.clone(), expires_in_sec: PAIRING_TTL.as_secs() });
                s.pairing = Some(w);
            }
        }
    }
}

async fn broadcast(state: &Arc<Mutex<HostState>>, line: String) {
    let s = state.lock().await;
    for tx in s.conns.values() {
        let _ = tx.try_send(line.clone());
    }
}

async fn handle_phone(incoming: iroh::endpoint::Incoming, state: Arc<Mutex<HostState>>) -> Result<()> {
    let conn = incoming.await.context("接受连接失败")?;
    let remote = conn.remote_id().to_string();
    let paired = { state.lock().await.store.devices.iter().any(|d| d.id == remote) };
    let (mut send, mut recv) = conn.accept_bi().await.context("接受控制流失败")?;

    let first = tokio::time::timeout(
        Duration::from_secs(15),
        read_line_bounded(&mut recv, if paired { MAX_LINE } else { MAX_UNPAIRED_LINE }),
    )
    .await
    .context("等待首行超时")??;
    let hello: Wire = serde_json::from_str(&first).context("首行不是合法消息")?;

    let device_name = match (paired, hello) {
        (true, Wire::Hello { name }) => name,
        (false, Wire::Pair { code, name }) => {
            let mut s = state.lock().await;
            let verdict = match &mut s.pairing {
                None => Err("当前没有开放的配对窗口"),
                Some(w) if tokio::time::Instant::now() > w.deadline => Err("配对窗口已过期"),
                Some(w) if w.attempts >= PAIRING_MAX_ATTEMPTS => Err("尝试次数超限"),
                Some(w) => {
                    w.attempts += 1;
                    if w.code == code { Ok(()) } else { Err("配对码不正确") }
                }
            };
            match verdict {
                Ok(()) => {
                    s.pairing = None;
                    s.store.devices.push(PairedDevice {
                        id: remote.clone(),
                        name: name.clone(),
                        paired_at: chrono_now(),
                    });
                    let (path, store) = (s.store_path.clone(), &s.store);
                    save_store(&path, store).context("写入配对白名单失败")?;
                    emit(&PluginOut::PairingDone { peer: remote.clone(), name: name.clone() });
                    drop(s);
                    write_line(&mut send, &serde_json::to_string(&Wire::PairOk)?).await?;
                    name
                }
                Err(reason) => {
                    // 3 次错完关窗:6 位码空间 1e6,窗口内只许猜 3 次
                    if s.pairing.as_ref().is_some_and(|w| w.attempts >= PAIRING_MAX_ATTEMPTS) {
                        s.pairing = None;
                        emit(&PluginOut::PairingClosed { reason: "尝试次数超限".into() });
                    }
                    drop(s);
                    write_line(&mut send, &serde_json::to_string(&Wire::PairFail { reason: reason.into() })?).await?;
                    // finish + 短等:让 PairFail 行先于连接关闭到达对端,失败原因不被 close 吃掉
                    let _ = send.finish();
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    conn.close(1u8.into(), b"pair-fail");
                    return Ok(());
                }
            }
        }
        _ => {
            conn.close(1u8.into(), b"protocol");
            bail!("未按协议发首行(paired={paired})");
        }
    };

    // 注册连接:下行走 mpsc,写坏即断开
    let (tx, mut rx) = mpsc::channel::<String>(64);
    {
        let mut s = state.lock().await;
        s.conns.insert(remote.clone(), tx);
    }
    emit(&PluginOut::PeerConnected { peer: remote.clone(), name: device_name });

    let writer = async {
        while let Some(line) = rx.recv().await {
            if write_line(&mut send, &line).await.is_err() {
                break;
            }
        }
    };
    let reader = async {
        loop {
            match read_line_bounded(&mut recv, MAX_LINE).await {
                Ok(line) => match serde_json::from_str::<Wire>(&line) {
                    Ok(Wire::Decision { id, outcome }) => emit(&PluginOut::Decision { id, outcome }),
                    Ok(_) => eprintln!("[host] 忽略非决定消息: {line}"),
                    Err(e) => eprintln!("[host] 无法解析手机消息: {e}"),
                },
                Err(_) => break,
            }
        }
    };
    tokio::join!(writer, reader);

    {
        let mut s = state.lock().await;
        s.conns.remove(&remote);
    }
    emit(&PluginOut::PeerDisconnected { peer: remote });
    Ok(())
}

/// ISO-8601 UTC 当前时间(避免引 chrono,秒级精度够用)
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

async fn phone_sim_main(
    data_dir: PathBuf,
    peer: String,
    code: Option<String>,
    name: String,
    auto: String,
    delay: u64,
) -> Result<()> {
    let peer: EndpointId = peer.trim().parse().map_err(|e| anyhow::anyhow!("无效的 --peer 设备 ID: {e}"))?;
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    let ep = Endpoint::builder(presets::N0).secret_key(secret).bind().await?;
    eprintln!("[phone-sim] 本机 ID: {}", ep.id());
    let conn = ep.connect(peer, ALPN).await.context("连接 host 失败")?;
    let (mut send, mut recv) = conn.open_bi().await.context("打开控制流失败")?;

    let first = match &code {
        Some(code) => Wire::Pair { code: code.clone(), name: name.clone() },
        None => Wire::Hello { name: name.clone() },
    };
    write_line(&mut send, &serde_json::to_string(&first)?).await?;
    if code.is_some() {
        let resp = read_line_bounded(&mut recv, MAX_LINE).await?;
        match serde_json::from_str::<Wire>(&resp)? {
            Wire::PairOk => eprintln!("[phone-sim] 配对成功"),
            Wire::PairFail { reason } => bail!("配对失败: {reason}"),
            _ => bail!("配对应答不符合协议: {resp}"),
        }
    }
    eprintln!("[phone-sim] 已连接,应答策略 {auto}(延迟 {delay}ms),等待审批请求…");

    loop {
        let line = tokio::select! {
            r = read_line_bounded(&mut recv, MAX_LINE) => r?,
            reason = conn.closed() => bail!("连接断开: {reason}"),
            _ = tokio::signal::ctrl_c() => break,
        };
        match serde_json::from_str::<Wire>(&line)? {
            Wire::Approval { id, tool_name, reason } => {
                eprintln!("[phone-sim] 审批请求 id={id} tool={tool_name}");
                eprintln!("[phone-sim]   理由: {reason}");
                tokio::time::sleep(Duration::from_millis(delay)).await;
                let outcome = if auto == "allow" { "allowed-once" } else { "rejected" };
                eprintln!("[phone-sim] 应答: {outcome}");
                write_line(&mut send, &serde_json::to_string(&Wire::Decision { id, outcome: outcome.into() })?).await?;
            }
            Wire::ApprovalCancel { id } => eprintln!("[phone-sim] 审批已取消 id={id}"),
            _ => eprintln!("[phone-sim] 忽略消息: {line}"),
        }
    }
    ep.close().await;
    Ok(())
}
