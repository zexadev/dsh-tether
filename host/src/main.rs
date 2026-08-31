//! tether-host:dsh 审批遥控的电脑侧 iroh 端。
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
use iroh::endpoint::{presets, Connection, RecvStream};
use iroh::{Endpoint, EndpointId};
use rand::Rng;
use tether_core::{
    load_or_create_secret, read_line_bounded, write_line, write_private, Wire, ALPN, MAX_LINE,
    MAX_UNPAIRED_LINE,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Mutex};

const PAIRING_TTL: Duration = Duration::from_secs(600);
const PAIRING_MAX_ATTEMPTS: u32 = 3;

#[derive(Parser)]
#[command(name = "tether-host", about = "dsh 审批遥控:电脑侧 iroh 端(插件 sidecar)与手机模拟端")]
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
        /// 已配对设备的代理流转发目标(dsh web 地址);不配则拒绝代理流
        #[arg(long)]
        proxy_target: Option<std::net::SocketAddr>,
    },
    /// 手机端替身:连接 host,打印审批请求并按策略应答
    PhoneSim {
        /// 本地起代理监听,经 host 的代理流访问其 dsh web(如 127.0.0.1:17380)
        #[arg(long)]
        proxy_listen: Option<std::net::SocketAddr>,
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
    DeviceList,
    DeviceForget { id: String },
    ProxyAuth { cookie: String, authority: String },
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
    /// 连接路径:direct=NAT 打洞直连 / relay=经中转
    PeerPath { peer: String, kind: String, remote: String },
    PeerDisconnected { peer: String },
    Decision { id: String, outcome: String },
    /// 手机第一次开代理流——即 WebView 真的开始拉界面了
    ProxyOpened,
    /// 已配对设备全量列表;online 标出此刻连着的那些
    Devices { devices: Vec<DeviceView> },
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

#[derive(Serialize)]
struct DeviceView {
    id: String,
    name: String,
    paired_at: String,
    online: bool,
}

struct PairingWindow {
    code: String,
    deadline: tokio::time::Instant,
    attempts: u32,
}

/// dsh 0.1.2-alpha 起浏览器界面要求认证 cookie。插件在电脑侧完成 token→cookie
/// 兑换后把材料下发到这里,代理流逐请求注入;没收到材料(旧版 dsh)则原样透传。
struct ProxyAuth {
    /// `name=value`,不含属性段
    cookie: String,
    /// dsh web 的规范 authority;cookie 签名绑定它,Host/Origin 都要改写成它
    authority: String,
}

/// 一台在线手机。连接句柄要留着:移除已配对设备时必须能主动断开它,
/// 只丢下行队列不行——那只会结束 writer,reader 与代理接收仍挂在连接上。
struct PeerConn {
    tx: mpsc::Sender<String>,
    conn: Connection,
}

struct HostState {
    store_path: PathBuf,
    store: PairedStore,
    pairing: Option<PairingWindow>,
    /// 在线手机(EndpointId 字符串 → 下行写队列 + 连接句柄)
    conns: HashMap<String, PeerConn>,
    proxy_auth: Option<Arc<ProxyAuth>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Id { data_dir } => {
            let dir = data_dir.unwrap_or_else(default_data_dir);
            let secret = load_or_create_secret(&dir.join("identity.key"))?;
            println!("{}", secret.public());
        }
        Cmd::Host { data_dir, pair, proxy_target } => {
            host_main(data_dir.unwrap_or_else(default_data_dir), pair, proxy_target).await?
        }
        Cmd::PhoneSim { proxy_listen, peer, code, name, auto, delay, data_dir } => {
            let dir = data_dir.unwrap_or_else(|| default_data_dir_named("dsh-tether-phone-sim"));
            phone_sim_main(dir, peer, code, name, auto, delay, proxy_listen).await?
        }
    }
    Ok(())
}

fn default_data_dir() -> PathBuf {
    default_data_dir_named("dsh-tether")
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

// 白名单里每条都是一把长期凭证,与身份密钥同等对待:仅属主可读。
fn save_store(path: &Path, store: &PairedStore) -> Result<()> {
    write_private(path, &serde_json::to_vec_pretty(store)?)
}

fn new_pairing_window() -> PairingWindow {
    let code = format!("{:06}", rand::rng().random_range(0..1_000_000u32));
    PairingWindow { code, deadline: tokio::time::Instant::now() + PAIRING_TTL, attempts: 0 }
}

fn emit(msg: &PluginOut) {
    // stdout 是插件协议通道;序列化失败属编程错误,直接崩比静默丢事件好
    println!("{}", serde_json::to_string(msg).expect("PluginOut 可序列化"));
}

async fn host_main(data_dir: PathBuf, force_pair: bool, proxy_target: Option<std::net::SocketAddr>) -> Result<()> {
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

    let mut state = HostState { store_path, store, pairing: None, conns: HashMap::new(), proxy_auth: None };
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
                    if let Err(e) = handle_phone(incoming, state, proxy_target).await {
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
            PluginIn::DeviceList => {
                let s = state.lock().await;
                emit(&PluginOut::Devices { devices: device_views(&s) });
            }
            PluginIn::DeviceForget { id } => {
                let mut s = state.lock().await;
                s.store.devices.retain(|d| d.id != id);
                let (path, store) = (s.store_path.clone(), &s.store);
                if let Err(e) = save_store(&path, store) {
                    eprintln!("[host] 写入配对白名单失败: {e:#}");
                }
                // 移出白名单只挡下次连接。此刻正连着的那条必须主动断,
                // 否则「移除」在设备下线前完全不生效。
                if let Some(peer) = s.conns.remove(&id) {
                    peer.conn.close(1u8.into(), b"forgotten");
                }
                emit(&PluginOut::Devices { devices: device_views(&s) });
            }
            PluginIn::ProxyAuth { cookie, authority } => {
                // 这两个值会被拼进转发的请求头;插件是可信父进程,但这是进程
                // 边界,控制字符(CRLF 注入)在这里挡一道
                if cookie.bytes().chain(authority.bytes()).any(|b| b < 0x20 || b == 0x7f) {
                    eprintln!("[host] proxy-auth 含控制字符,已丢弃");
                    continue;
                }
                state.lock().await.proxy_auth = Some(Arc::new(ProxyAuth { cookie, authority }));
                eprintln!("[host] 已装载浏览器认证 cookie,代理流将逐请求注入");
            }
        }
    }
}

fn device_views(s: &HostState) -> Vec<DeviceView> {
    s.store
        .devices
        .iter()
        .map(|d| DeviceView {
            id: d.id.clone(),
            name: d.name.clone(),
            paired_at: d.paired_at.clone(),
            online: s.conns.contains_key(&d.id),
        })
        .collect()
}

async fn broadcast(state: &Arc<Mutex<HostState>>, line: String) {
    let s = state.lock().await;
    for PeerConn { tx, .. } in s.conns.values() {
        let _ = tx.try_send(line.clone());
    }
}

async fn handle_phone(
    incoming: iroh::endpoint::Incoming,
    state: Arc<Mutex<HostState>>,
    proxy_target: Option<std::net::SocketAddr>,
) -> Result<()> {
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
        s.conns.insert(remote.clone(), PeerConn { tx, conn: conn.clone() });
    }
    emit(&PluginOut::PeerConnected { peer: remote.clone(), name: device_name });

    // 连接刚建立时通常还在 relay 路径;给 NAT 打洞几秒升级窗口再报,
    // 否则跨网验收会把「还没打通」误读成「打不通」。
    {
        let conn = conn.clone();
        let peer = remote.clone();
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            loop {
                let selected = conn.paths().iter().find(|p| p.is_selected()).map(|p| {
                    let addr = p.remote_addr();
                    (if addr.is_ip() { "direct" } else { "relay" }, format!("{addr:?}"))
                });
                let done = tokio::time::Instant::now() >= deadline;
                if let Some((kind, remote_addr)) = selected {
                    if kind == "direct" || done {
                        emit(&PluginOut::PeerPath { peer, kind: kind.to_string(), remote: remote_addr });
                        return
                    }
                } else if done {
                    return
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
    }

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
    // 控制流建立(已配对)后,同一连接的后续 bi 流是代理流:首行 {"type":"proxy"},
    // 之后整条流拼原始字节到 proxy_target(dsh web)。连接断开 accept_bi 报错,循环自然结束。
    let proxy_state = state.clone();
    let proxy_acceptor = async {
        let permits = Arc::new(tokio::sync::Semaphore::new(64));
        // 手机连上却看不到界面时,唯一能区分「WebView 压根没发请求」和「发了但转不通」
        // 的信号就是这里。只报第一条:一个页面会开很多条流,每条都打就成了刷屏。
        let mut announced = false;
        while let Ok((psend, mut precv)) = conn.accept_bi().await {
            if !announced {
                announced = true;
                emit(&PluginOut::ProxyOpened);
            }
            let Some(target) = proxy_target else {
                eprintln!("[host] 未配置 --proxy-target,拒绝代理流");
                continue;
            };
            let permit = permits.clone().acquire_owned().await.expect("semaphore 不会关闭");
            let auth_state = proxy_state.clone();
            tokio::spawn(async move {
                let _permit = permit;
                match read_line_bounded(&mut precv, 256).await.map(|l| serde_json::from_str::<Wire>(&l)) {
                    Ok(Ok(Wire::Proxy)) => {}
                    _ => return,
                }
                let auth = auth_state.lock().await.proxy_auth.clone();
                // 有认证材料时先把请求头读完改写;头之后的字节(请求体/升级后
                // 的 WebSocket 帧)仍走裸转发
                let head = match &auth {
                    None => None,
                    Some(auth) => match read_request_head(&mut precv).await {
                        Ok(head) => Some(rewrite_request_head(&head, auth)),
                        Err(e) => {
                            eprintln!("[host] 代理流请求头读取失败: {e:#}");
                            return;
                        }
                    },
                };
                let Ok(mut tcp) = tokio::net::TcpStream::connect(target).await else {
                    eprintln!("[host] 代理流无法连接 {target}(dsh web 未启动?)");
                    return;
                };
                if let Some(head) = head {
                    use tokio::io::AsyncWriteExt as _;
                    if tcp.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                }
                let mut stream = tokio::io::join(precv, psend);
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
            });
        }
    };
    tokio::join!(writer, reader, proxy_acceptor);

    {
        let mut s = state.lock().await;
        s.conns.remove(&remote);
    }
    emit(&PluginOut::PeerDisconnected { peer: remote });
    Ok(())
}

/// 逐字节读完一个 HTTP/1.1 请求头(含结尾空行)。逐字节与 read_line_bounded
/// 同理:不越读,头之后的字节(请求体)原样留在流里交给后面的裸转发。
async fn read_request_head(recv: &mut RecvStream) -> Result<String> {
    const MAX_HEAD: usize = 64 * 1024;
    let mut head = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        let Some(n) = recv.read(&mut byte).await? else {
            bail!("对端在请求头结束前关闭了流");
        };
        if n == 0 {
            continue;
        }
        head.push(byte[0]);
        if head.len() > MAX_HEAD {
            bail!("请求头超限({MAX_HEAD} 字节)");
        }
    }
    String::from_utf8(head).context("请求头不是 UTF-8")
}

/// 改写一个请求头:Host/Origin 指到 dsh 真实 authority、注入认证 cookie、
/// 非升级请求强制 Connection: close。
///
/// close 是「逐请求注入」的实现前提:keep-alive 连接上后续请求同样要注入,
/// 那要求按 Content-Length/chunked 给请求体分帧;强制一连接一请求后,浏览器
/// 每个请求都另开连接,每条都从头经过这里,分帧逻辑整个省掉。WebSocket 升级
/// 例外:保留原 Connection/Upgrade 头,升级后整条流裸转发。
///
/// Origin 只在本来就是回环时才改写——它与 Host 的差异纯粹是代理搬家造成的;
/// 非回环的 Origin(手机浏览器里的恶意页面打手机本地端口)原样放行,让 dsh
/// 自己的跨站栅栏照旧拒绝。
fn rewrite_request_head(head: &str, auth: &ProxyAuth) -> String {
    let head = head.strip_suffix("\r\n\r\n").unwrap_or(head);
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let headers: Vec<&str> = lines.collect();
    let upgrade = headers.iter().any(|l| header_value(l, "upgrade").is_some());
    let mut out = String::with_capacity(head.len() + 128);
    out.push_str(request_line);
    out.push_str("\r\n");
    for line in &headers {
        if header_value(line, "host").is_some() {
            out.push_str("host: ");
            out.push_str(&auth.authority);
        } else if let Some(origin) = header_value(line, "origin") {
            out.push_str("origin: ");
            match rewrite_origin(origin, &auth.authority) {
                Some(rewritten) => out.push_str(&rewritten),
                None => out.push_str(origin),
            }
        } else if !upgrade
            && (header_value(line, "connection").is_some()
                || header_value(line, "proxy-connection").is_some())
        {
            continue;
        } else {
            out.push_str(line);
        }
        out.push_str("\r\n");
    }
    out.push_str("cookie: ");
    out.push_str(&auth.cookie);
    out.push_str("\r\n");
    if !upgrade {
        out.push_str("connection: close\r\n");
    }
    out.push_str("\r\n");
    out
}

/// line 形如 `Name: value`;名字命中(大小写不敏感)返回去掉首尾空白的值
fn header_value<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let (key, value) = line.split_once(':')?;
    key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
}

/// `http://<回环>[:port]` → `http://<authority>`;其余不动
fn rewrite_origin(origin: &str, authority: &str) -> Option<String> {
    let rest = origin.strip_prefix("http://")?;
    let host = rest.split('/').next().unwrap_or(rest);
    let hostname = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(host),
    };
    is_loopback(hostname).then(|| format!("http://{authority}"))
}

/// 回环判据与 dsh 一致:localhost、IPv6 回环、整个 127/8
fn is_loopback(hostname: &str) -> bool {
    if hostname == "localhost" || hostname == "::1" {
        return true;
    }
    let parts: Vec<&str> = hostname.split('.').collect();
    parts.len() == 4
        && parts[0] == "127"
        && parts.iter().all(|p| {
            (1..=3).contains(&p.len())
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u32>().is_ok_and(|n| n <= 255)
        })
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
    proxy_listen: Option<std::net::SocketAddr>,
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

    if let Some(listen) = proxy_listen {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .with_context(|| format!("本地代理监听失败: {listen}"))?;
        eprintln!("[phone-sim] 代理就绪: http://{listen} → [iroh] → host 的 dsh web");
        let pconn = conn.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else { break };
                let conn = pconn.clone();
                tokio::spawn(async move {
                    let Ok((mut psend, precv)) = conn.open_bi().await else { return };
                    if write_line(&mut psend, &serde_json::to_string(&Wire::Proxy).expect("Wire 可序列化")).await.is_err() {
                        return;
                    }
                    let mut stream = tokio::io::join(precv, psend);
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                });
            }
        });
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> ProxyAuth {
        ProxyAuth { cookie: "dsh-auth-abc=v1.xyz".into(), authority: "127.0.0.1:18000".into() }
    }

    #[test]
    fn 普通请求改写host_注入cookie_强制close() {
        let head = "GET /api/x HTTP/1.1\r\nHost: 127.0.0.1:39411\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n";
        let out = rewrite_request_head(head, &auth());
        assert!(out.starts_with("GET /api/x HTTP/1.1\r\n"));
        assert!(out.contains("host: 127.0.0.1:18000\r\n"), "{out}");
        assert!(out.contains("cookie: dsh-auth-abc=v1.xyz\r\n"), "{out}");
        assert!(out.contains("connection: close\r\n"), "{out}");
        assert!(!out.contains("keep-alive"), "原 Connection 应被移除: {out}");
        assert!(out.contains("Accept: */*\r\n"), "无关头原样保留: {out}");
        assert!(out.ends_with("\r\n\r\n"));
        assert!(!out.contains("Host: 127.0.0.1:39411"), "{out}");
    }

    #[test]
    fn 升级请求保留connection与upgrade头_不加close() {
        let head = "GET /stream HTTP/1.1\r\nHost: 127.0.0.1:39411\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://127.0.0.1:39411\r\n\r\n";
        let out = rewrite_request_head(head, &auth());
        assert!(out.contains("Connection: Upgrade\r\n"), "{out}");
        assert!(out.contains("Upgrade: websocket\r\n"), "{out}");
        assert!(!out.contains("connection: close"), "{out}");
        assert!(out.contains("cookie: dsh-auth-abc=v1.xyz\r\n"), "{out}");
        assert!(out.contains("origin: http://127.0.0.1:18000\r\n"), "{out}");
    }

    #[test]
    fn 回环origin改写_非回环origin原样留给dsh栅栏拒绝() {
        assert_eq!(
            rewrite_origin("http://127.0.0.1:39411", "127.0.0.1:18000").as_deref(),
            Some("http://127.0.0.1:18000")
        );
        assert_eq!(
            rewrite_origin("http://localhost:8080", "127.0.0.1:18000").as_deref(),
            Some("http://127.0.0.1:18000")
        );
        assert_eq!(
            rewrite_origin("http://[::1]:8080", "127.0.0.1:18000").as_deref(),
            Some("http://127.0.0.1:18000")
        );
        assert_eq!(rewrite_origin("http://evil.example", "127.0.0.1:18000"), None);
        assert_eq!(rewrite_origin("https://127.0.0.1:39411", "127.0.0.1:18000"), None);
        assert_eq!(rewrite_origin("null", "127.0.0.1:18000"), None);
    }

    #[test]
    fn 回环判定的边界值() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.255.255.255"));
        assert!(is_loopback("localhost"));
        assert!(is_loopback("::1"));
        // 128/8 不是回环;256 越界;127.1 缩写不按四段判
        assert!(!is_loopback("128.0.0.1"));
        assert!(!is_loopback("127.0.0.256"));
        assert!(!is_loopback("127.1"));
        assert!(!is_loopback("evil.com"));
        assert!(!is_loopback(""));
    }

    #[test]
    fn 手机自带cookie头原样保留_注入的另起一行() {
        let head = "GET / HTTP/1.1\r\nHost: 127.0.0.1:39411\r\nCookie: stale=1\r\n\r\n";
        let out = rewrite_request_head(head, &auth());
        assert!(out.contains("Cookie: stale=1\r\n"), "{out}");
        assert!(out.contains("cookie: dsh-auth-abc=v1.xyz\r\n"), "{out}");
    }
}
