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
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointId};
use rand::Rng;
use tether_core::i18n::t;
use tether_core::{
    ALPN, pair_fail_text, PAIR_BAD_CODE, PAIR_EXPIRED, PAIR_NO_WINDOW, PAIR_TOO_MANY_ATTEMPTS, load_or_create_secret, MAX_LINE, MAX_UNPAIRED_LINE, ProxyAuth, read_line_bounded, read_request_head, rewrite_request_head, Wire, write_line, write_private,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Mutex};

/// clap 渲染 --help 时语言就得是定的,所以 --lang 得自己先从 argv 里捞一遍
fn lang_from_argv() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if let Some(v) = a.strip_prefix("--lang=") {
            return Some(v.to_string());
        }
        if a == "--lang" {
            return args.next();
        }
    }
    None
}

/// 人读日志与帮助的语言。插件启动 sidecar 时按电脑的系统语言传 --lang,两边始终一致;
/// 直接手跑时先看 LC_ALL/LANG,没有就问系统——Windows 和 macOS 上这两个变量通常根本不存在,
/// 只认环境变量就会把英文用户当中文用户;系统也问不出来才退回中文。
fn set_lang(explicit: Option<&str>) {
    let tag = resolve_tag(
        explicit,
        std::env::var("LC_ALL").ok(),
        std::env::var("LANG").ok(),
        sys_locale::get_locale(),
    );
    tether_core::i18n::set_from_tag(&tag);
}

/// 四个来源的优先级。取值都从外面传进来,才好逐条验——否则只能在跑的那台机器上碰运气。
fn resolve_tag(
    explicit: Option<&str>,
    lc_all: Option<String>,
    lang: Option<String>,
    system: Option<String>,
) -> String {
    [explicit.map(str::to_string), lc_all, lang, system]
        .into_iter()
        .flatten()
        .find(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "zh".to_string())
}

#[cfg(test)]
mod tests {
    use super::resolve_tag;

    fn s(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn explicit_lang_wins() {
        assert_eq!(
            resolve_tag(Some("en"), s("zh_CN.UTF-8"), s("zh_CN.UTF-8"), s("zh-CN")),
            "en"
        );
    }

    #[test]
    fn lc_all_before_lang() {
        assert_eq!(resolve_tag(None, s("en_GB.UTF-8"), s("zh_CN.UTF-8"), None), "en_GB.UTF-8");
    }

    #[test]
    fn system_locale_when_env_absent() {
        // Windows 与 macOS 上 LC_ALL/LANG 通常都没有,只认环境变量就会把英文用户当中文用户
        assert_eq!(resolve_tag(None, None, None, s("en-GB")), "en-GB");
    }

    #[test]
    fn empty_env_does_not_count() {
        // LANG= 空串是"没设",不是"设成了非中文"
        assert_eq!(resolve_tag(None, s(""), s("  "), s("zh-CN")), "zh-CN");
    }

    #[test]
    fn chinese_when_nothing_is_known() {
        assert_eq!(resolve_tag(None, None, None, None), "zh");
    }
}

const PAIRING_TTL: Duration = Duration::from_secs(600);
const PAIRING_MAX_ATTEMPTS: u32 = 3;

// 帮助文本同样走 t()。不用 /// 写:那样中文注释与英文帮助得各存一份,改一边忘一边。
#[derive(Parser)]
#[command(name = "tether-host", about = t(
    "dsh 审批遥控:电脑侧 iroh 端(插件 sidecar)与手机模拟端",
    "dsh approval tether: the computer-side iroh endpoint (the plugin's sidecar), plus a phone stand-in",
))]
struct Cli {
    #[arg(long, global = true, help = t(
        "人读日志与这份帮助的语言(zh / en);不给则看 LC_ALL、LANG",
        "language for the logs and for this help (zh / en); otherwise LC_ALL and LANG decide",
    ))]
    lang: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    #[command(about = t(
        "sidecar 模式:stdio JSON-lines 对插件,iroh 对手机",
        "sidecar mode: JSON-lines over stdio to the plugin, iroh to the phone",
    ))]
    Host {
        #[arg(long, help = t(
            "身份与配对白名单目录",
            "where the identity key and the paired-device list live",
        ))]
        data_dir: Option<PathBuf>,
        #[arg(long, help = t(
            "启动即开配对窗口(默认仅在白名单为空时自动开)",
            "open a pairing window right away (by default one opens only while nothing is paired yet)",
        ))]
        pair: bool,
        #[arg(long, help = t(
            "已配对设备的代理流转发目标(dsh web 地址);不配则拒绝代理流",
            "where to forward proxy streams from paired devices (the dsh web address); without it they are refused",
        ))]
        proxy_target: Option<std::net::SocketAddr>,
    },
    #[command(about = t(
        "手机端替身:连接 host,打印审批请求并按策略应答",
        "phone stand-in: connects to a host, prints approval requests and answers them by policy",
    ))]
    PhoneSim {
        #[arg(long, help = t(
            "本地起代理监听,经 host 的代理流访问其 dsh web(如 127.0.0.1:17380)",
            "listen here and reach the host's dsh web over a proxy stream (e.g. 127.0.0.1:17380)",
        ))]
        proxy_listen: Option<std::net::SocketAddr>,
        #[arg(long, help = t("host 的设备 ID", "the host's device ID"))]
        peer: String,
        #[arg(long, help = t(
            "配对码(首次连接用;已配对则省略)",
            "pairing code (only for the first connection; omit once paired)",
        ))]
        code: Option<String>,
        #[arg(long, default_value = "phone-sim", help = t(
            "设备名(配对时登记)",
            "device name, as recorded when pairing",
        ))]
        name: String,
        #[arg(long, value_parser = ["allow", "reject"], default_value = "allow", help = t(
            "收到审批后的应答策略",
            "how to answer an approval request",
        ))]
        auto: String,
        #[arg(long, default_value_t = 2000, help = t(
            "应答前延迟毫秒(模拟人掏手机)",
            "milliseconds to wait before answering, as if reaching for the phone",
        ))]
        delay: u64,
        #[arg(long, help = t(
            "身份与配对记录目录",
            "where the identity key and the pairing record live",
        ))]
        data_dir: Option<PathBuf>,
    },
    #[command(about = t("打印 host 身份 ID", "print the host's identity ID"))]
    Id {
        #[arg(long, help = t(
            "身份与配对白名单目录",
            "where the identity key and the paired-device list live",
        ))]
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
    /// reason 是 tether-core 里的配对失败原因码,插件按 dsh 那侧的语言渲染
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
    // 先定语言再 parse:--help 是 parse 里渲染的,等 cli.lang 到手就晚了
    set_lang(lang_from_argv().as_deref());
    let cli = Cli::parse();
    match cli.cmd {
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
    println!("{}", serde_json::to_string(msg).expect("PluginOut is serializable"));
}

/// Termux 里没有 JVM:iroh 默认解析器在 android 目标上经 JNI 读系统 DNS,
/// ndk-context 未初始化即 panic。iroh 用 catch_unwind 接住后回退 Google DNS,
/// 但默认 panic hook 已先把整段栈打到 stderr,看着像启动失败。这里直接给出
/// 与那条回退等价的解析器,根本不进 JNI。
#[cfg(target_os = "android")]
fn android_dns_resolver() -> iroh::dns::DnsResolver {
    use iroh::dns::DnsProtocol;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    const GOOGLE: [IpAddr; 4] = [
        IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
        IpAddr::V4(Ipv4Addr::new(8, 8, 4, 4)),
        IpAddr::V6(Ipv6Addr::new(0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888)),
        IpAddr::V6(Ipv6Addr::new(0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8844)),
    ];
    iroh::dns::DnsResolver::builder()
        .with_nameservers(GOOGLE.into_iter().flat_map(|ip| {
            let addr = SocketAddr::new(ip, 53);
            [(addr, DnsProtocol::Udp), (addr, DnsProtocol::Tcp)]
        }))
        .build()
}

fn endpoint_builder() -> iroh::endpoint::Builder {
    let builder = Endpoint::builder(presets::N0);
    #[cfg(target_os = "android")]
    let builder = builder.dns_resolver(android_dns_resolver());
    // 排障开关:去掉 IP 传输,所有流量只走 relay。打洞在多数网络下都会成功,
    // 不强制就没法单独验 relay 这条数据面
    if std::env::var_os("DSH_TETHER_RELAY_ONLY").is_some_and(|v| !v.is_empty() && v != "0") {
        eprintln!("[tether] {}", t("DSH_TETHER_RELAY_ONLY:只走 relay,不打洞", "DSH_TETHER_RELAY_ONLY: relay only, no hole-punching"));
        return builder.clear_ip_transports();
    }
    builder
}

async fn host_main(data_dir: PathBuf, force_pair: bool, proxy_target: Option<std::net::SocketAddr>) -> Result<()> {
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    let store_path = data_dir.join("paired.json");
    let store = load_store(&store_path);
    let ep = endpoint_builder()
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .context(t("iroh endpoint 启动失败", "failed to start the iroh endpoint"))?;
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
                        eprintln!("[host] {}{e:#}", t("入站连接处理失败: ", "inbound connection failed: "));
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
                eprintln!("[host] {}{e}: {line}", t("无法解析插件消息: ", "cannot parse the plugin message: "));
                continue;
            }
        };
        match msg {
            PluginIn::Approval { id, tool_name, reason } => {
                let wire = serde_json::to_string(&Wire::Approval { id, tool_name, reason }).expect("Wire is serializable");
                broadcast(&state, wire).await;
            }
            PluginIn::ApprovalCancel { id } => {
                let wire = serde_json::to_string(&Wire::ApprovalCancel { id }).expect("Wire is serializable");
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
                    eprintln!("[host] {}{e:#}", t("写入配对白名单失败: ", "cannot write the paired-device list: "));
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
                    eprintln!("[host] {}", t("proxy-auth 含控制字符,已丢弃", "the proxy-auth value has control characters; dropped"));
                    continue;
                }
                state.lock().await.proxy_auth = Some(Arc::new(ProxyAuth { cookie, authority }));
                eprintln!("[host] {}", t("已装载浏览器认证 cookie,代理流将逐请求注入", "browser auth cookie loaded; it will be injected per request on proxy streams"));
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
    let conn = incoming.await.context(t("接受连接失败", "failed to accept the connection"))?;
    let remote = conn.remote_id().to_string();
    let paired = { state.lock().await.store.devices.iter().any(|d| d.id == remote) };
    let (mut send, mut recv) = conn.accept_bi().await.context(t("接受控制流失败", "failed to accept the control stream"))?;

    let first = tokio::time::timeout(
        Duration::from_secs(15),
        read_line_bounded(&mut recv, if paired { MAX_LINE } else { MAX_UNPAIRED_LINE }),
    )
    .await
    .context(t("等待首行超时", "timed out waiting for the first line"))??;
    let hello: Wire = serde_json::from_str(&first).context(t("首行不是合法消息", "the first line is not a valid message"))?;

    let device_name = match (paired, hello) {
        (true, Wire::Hello { name }) => name,
        (false, Wire::Pair { code, name }) => {
            let mut s = state.lock().await;
            let verdict = match &mut s.pairing {
                None => Err(PAIR_NO_WINDOW),
                Some(w) if tokio::time::Instant::now() > w.deadline => Err(PAIR_EXPIRED),
                Some(w) if w.attempts >= PAIRING_MAX_ATTEMPTS => Err(PAIR_TOO_MANY_ATTEMPTS),
                Some(w) => {
                    w.attempts += 1;
                    if w.code == code { Ok(()) } else { Err(PAIR_BAD_CODE) }
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
                    save_store(&path, store).context(t("写入配对白名单失败", "cannot write the paired-device list"))?;
                    emit(&PluginOut::PairingDone { peer: remote.clone(), name: name.clone() });
                    drop(s);
                    write_line(&mut send, &serde_json::to_string(&Wire::PairOk)?).await?;
                    name
                }
                Err(reason) => {
                    // 3 次错完关窗:6 位码空间 1e6,窗口内只许猜 3 次
                    if s.pairing.as_ref().is_some_and(|w| w.attempts >= PAIRING_MAX_ATTEMPTS) {
                        s.pairing = None;
                        emit(&PluginOut::PairingClosed { reason: PAIR_TOO_MANY_ATTEMPTS.into() });
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
            bail!("{}(paired={paired})", t("未按协议发首行", "the first line does not follow the protocol"));
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
                    Ok(_) => eprintln!("[host] {}{line}", t("忽略非决定消息: ", "ignoring a non-decision message: ")),
                    Err(e) => eprintln!("[host] {}{e}", t("无法解析手机消息: ", "cannot parse the phone message: ")),
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
                eprintln!("[host] {}", t("未配置 --proxy-target,拒绝代理流", "no --proxy-target configured; refusing the proxy stream"));
                continue;
            };
            let permit = permits.clone().acquire_owned().await.expect("the semaphore is never closed");
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
                            eprintln!("[host] {}{e:#}", t("代理流请求头读取失败: ", "cannot read the proxy request head: "));
                            return;
                        }
                    },
                };
                let Ok(mut tcp) = tokio::net::TcpStream::connect(target).await else {
                    eprintln!("[host] {}{target}{}", t("代理流无法连接 ", "the proxy stream cannot reach "), t("(dsh web 未启动?)", " (is dsh web running?)"));
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
    let peer: EndpointId = peer.trim().parse().map_err(|e| anyhow::anyhow!("{}{e}", t("无效的 --peer 设备 ID: ", "invalid --peer device ID: ")))?;
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    let ep = endpoint_builder().secret_key(secret).bind().await?;
    eprintln!("[phone-sim] {}{}", t("本机 ID: ", "local ID: "), ep.id());
    let conn = ep.connect(peer, ALPN).await.context(t("连接 host 失败", "failed to connect to the host"))?;
    let (mut send, mut recv) = conn.open_bi().await.context(t("打开控制流失败", "failed to open the control stream"))?;

    let first = match &code {
        Some(code) => Wire::Pair { code: code.clone(), name: name.clone() },
        None => Wire::Hello { name: name.clone() },
    };
    write_line(&mut send, &serde_json::to_string(&first)?).await?;
    if code.is_some() {
        let resp = read_line_bounded(&mut recv, MAX_LINE).await?;
        match serde_json::from_str::<Wire>(&resp)? {
            Wire::PairOk => eprintln!("[phone-sim] {}", t("配对成功", "paired")),
            Wire::PairFail { reason } => bail!("{}{}", t("配对失败: ", "pairing failed: "), pair_fail_text(&reason)),
            _ => bail!("{}{resp}", t("配对应答不符合协议: ", "the pairing reply does not follow the protocol: ")),
        }
    }
    eprintln!("[phone-sim] {}{auto}({delay}ms){}", t("已连接,应答策略 ", "connected, reply policy "), t(",等待审批请求…", ", waiting for approval requests…"));

    if let Some(listen) = proxy_listen {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .with_context(|| format!("{}{listen}", t("本地代理监听失败: ", "the local proxy could not listen on ")))?;
        eprintln!(
            "[phone-sim] {}http://{listen}{}",
            t("代理就绪: ", "proxy ready: "),
            t(" → [iroh] → host 那台的 dsh web", " → [iroh] → the dsh web on the host machine"),
        );
        let pconn = conn.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else { break };
                let conn = pconn.clone();
                tokio::spawn(async move {
                    let Ok((mut psend, precv)) = conn.open_bi().await else { return };
                    if write_line(&mut psend, &serde_json::to_string(&Wire::Proxy).expect("Wire is serializable")).await.is_err() {
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
            reason = conn.closed() => bail!("{}{reason}", t("连接断开: ", "connection closed: ")),
            _ = tokio::signal::ctrl_c() => break,
        };
        match serde_json::from_str::<Wire>(&line)? {
            Wire::Approval { id, tool_name, reason } => {
                eprintln!("[phone-sim] {}id={id} tool={tool_name}", t("审批请求 ", "approval request "));
                eprintln!("[phone-sim]   {}{reason}", t("理由: ", "reason: "));
                tokio::time::sleep(Duration::from_millis(delay)).await;
                let outcome = if auto == "allow" { "allowed-once" } else { "rejected" };
                eprintln!("[phone-sim] {}{outcome}", t("应答: ", "replied: "));
                write_line(&mut send, &serde_json::to_string(&Wire::Decision { id, outcome: outcome.into() })?).await?;
            }
            Wire::ApprovalCancel { id } => eprintln!("[phone-sim] {}id={id}", t("审批已取消 ", "approval cancelled ")),
            _ => eprintln!("[phone-sim] {}{line}", t("忽略消息: ", "ignoring message: ")),
        }
    }
    ep.close().await;
    Ok(())
}
