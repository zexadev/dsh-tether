//! dsh-tunnel:用 iroh P2P 把远端机器上的 localhost 服务带到本机。
//!
//! serve 端(跑服务的机器)把入站 iroh 流转发到固定 target;connect 端起本地
//! TCP 监听,每个 TCP 连接对应一条 iroh bi 流(QUIC 多路复用,互不队头阻塞)。
//! 协议 v0 无握手负载:target 由 serve 启动参数固定,远端无法指定转发目标。

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointId, SecretKey};
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

const ALPN: &[u8] = b"dsh-tunnel/0";
/// 单个 iroh 连接上并发转发流上限(浏览器并行请求 + 两条长连 WebSocket 足够)
const MAX_STREAMS: usize = 64;

#[derive(Parser)]
#[command(name = "dsh-tunnel", about = "用 iroh P2P 把远端 localhost 服务带到本机,不经过任何服务器")]
struct Cli {
    /// 身份密钥文件路径(默认 配置目录/dsh-tunnel/identity.key;设备 ID 由它决定)
    #[arg(long, global = true)]
    identity: Option<PathBuf>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 打印本机设备 ID(供对端 --allow / --peer 使用)
    Id,
    /// 在跑服务的机器上启动:把授权设备的入站流转发到 target
    Serve {
        /// 转发目标(本机服务地址)
        #[arg(long, default_value = "127.0.0.1:3080")]
        target: SocketAddr,
        /// 允许连入的设备 ID,可重复;不配置则拒绝一切连接并打印来访者 ID
        #[arg(long = "allow")]
        allow: Vec<String>,
    },
    /// 在使用方机器上启动:本地监听,经 iroh 转发到对端的 target
    Connect {
        /// 对端(serve 端)设备 ID
        #[arg(long)]
        peer: String,
        /// 本地监听地址
        #[arg(long, default_value = "127.0.0.1:3080")]
        listen: SocketAddr,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let identity_path = cli.identity.unwrap_or_else(default_identity_path);
    let secret = load_or_create_secret(&identity_path)?;
    match cli.cmd {
        Cmd::Id => {
            let ep = bind_endpoint(secret, false).await?;
            println!("{}", ep.id());
            ep.close().await;
        }
        Cmd::Serve { target, allow } => serve(secret, target, allow).await?,
        Cmd::Connect { peer, listen } => connect(secret, peer, listen).await?,
    }
    Ok(())
}

fn default_identity_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-tunnel")
        .join("identity.key")
}

/// 读取或创建持久身份密钥:设备 ID 重启不变,配对(allow 名单)才有意义
fn load_or_create_secret(path: &Path) -> Result<SecretKey> {
    if let Ok(bytes) = std::fs::read(path) {
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .with_context(|| format!("身份密钥文件损坏(长度不是 32 字节): {}", path.display()))?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let key = SecretKey::generate();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, key.to_bytes())
        .with_context(|| format!("保存身份密钥失败: {}", path.display()))?;
    Ok(key)
}

async fn bind_endpoint(secret: SecretKey, accept_incoming: bool) -> Result<Endpoint> {
    let mut builder = Endpoint::builder(presets::N0).secret_key(secret);
    if accept_incoming {
        builder = builder.alpns(vec![ALPN.to_vec()]);
    }
    builder.bind().await.context("iroh endpoint 启动失败")
}

/// 当前选中路径类型:direct=NAT 打洞直连 / relay=经中转
fn conn_path_type(conn: &Connection) -> Option<&'static str> {
    conn.paths()
        .iter()
        .find(|p| p.is_selected())
        .map(|p| if p.remote_addr().is_ip() { "direct" } else { "relay" })
}

/// 连接刚建立通常还在 relay;给打洞 ~1.5s 升级窗口后报告路径类型
async fn report_path_type(conn: Connection, label: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
    let mut kind = conn_path_type(&conn);
    while kind != Some("direct") && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        kind = conn_path_type(&conn);
    }
    match kind {
        Some("direct") => println!("{label}: direct(P2P 直连)"),
        Some(_) => println!("{label}: relay(打洞未成,经中转,可用但延迟略高)"),
        None => {}
    }
}

async fn serve(secret: SecretKey, target: SocketAddr, allow: Vec<String>) -> Result<()> {
    let allow: Vec<EndpointId> = allow
        .iter()
        .map(|s| s.trim().parse().map_err(|e| anyhow::anyhow!("无效的 --allow 设备 ID {s}: {e}")))
        .collect::<Result<_>>()?;
    let ep = bind_endpoint(secret, true).await?;
    println!("本机设备 ID: {}", ep.id());
    println!("转发目标: {target}");
    if allow.is_empty() {
        println!("警告: 未配置 --allow,所有连接都会被拒绝;在客户端跑 `dsh-tunnel id` 取其 ID 后加 --allow <ID> 重启");
    }
    println!("等待设备连入…(Ctrl+C 退出)");
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            incoming = ep.accept() => {
                let Some(incoming) = incoming else { break };
                let allow = allow.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_client(incoming, target, allow).await {
                        eprintln!("入站连接处理失败: {e:#}");
                    }
                });
            }
        }
    }
    ep.close().await;
    Ok(())
}

async fn handle_client(
    incoming: iroh::endpoint::Incoming,
    target: SocketAddr,
    allow: Vec<EndpointId>,
) -> Result<()> {
    let conn = incoming.await.context("接受连接失败")?;
    // 鉴权前置:remote_id 是 iroh TLS 已验证的对端公钥,不可伪造;
    // 不在名单则在读任何数据前关闭
    let remote = conn.remote_id();
    if !allow.contains(&remote) {
        eprintln!("拒绝未授权设备: {remote}");
        eprintln!("  如需允许,serve 加参数 --allow {remote} 重启");
        conn.close(1u8.into(), b"unauthorized");
        return Ok(());
    }
    println!("设备已连接: {remote}");
    tokio::spawn(report_path_type(conn.clone(), "连接路径"));
    let permits = Arc::new(Semaphore::new(MAX_STREAMS));
    loop {
        let (send, recv) = match conn.accept_bi().await {
            Ok(pair) => pair,
            Err(e) => {
                println!("设备 {remote} 连接结束: {e}");
                break;
            }
        };
        let permit = permits.clone().acquire_owned().await.expect("semaphore 不会关闭");
        tokio::spawn(async move {
            let _permit = permit;
            let Ok(mut tcp) = TcpStream::connect(target).await else {
                // target 未启动:丢弃流,客户端侧表现为该请求失败
                eprintln!("转发失败: 无法连接 {target}(目标服务未启动?)");
                return;
            };
            let mut stream = tokio::io::join(recv, send);
            // 浏览器随手关页产生的 reset 属正常结束,不作为错误上报
            let _ = copy_bidirectional(&mut tcp, &mut stream).await;
        });
    }
    Ok(())
}

async fn connect(secret: SecretKey, peer: String, listen: SocketAddr) -> Result<()> {
    let peer: EndpointId = peer
        .trim()
        .parse()
        .map_err(|e| anyhow::anyhow!("无效的 --peer 设备 ID: {e}"))?;
    let ep = bind_endpoint(secret, false).await?;
    println!("本机设备 ID: {}", ep.id());
    let conn = ep
        .connect(peer, ALPN)
        .await
        .context("连接对端失败(对端 serve 未启动、ID 不对或网络不可达)")?;
    tokio::spawn(report_path_type(conn.clone(), "连接路径"));
    let listener = TcpListener::bind(listen)
        .await
        .with_context(|| format!("本地监听失败: {listen}"))?;
    println!("隧道就绪: http://{listen} → [iroh] → {peer}");
    println!("(Ctrl+C 退出)");
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            reason = conn.closed() => {
                // 对端 close 的 reason 会带过来(如 unauthorized),原样打印便于定位
                anyhow::bail!("iroh 连接已断开: {reason}");
            }
            accepted = listener.accept() => {
                let (mut tcp, _) = accepted.context("本地 accept 失败")?;
                let conn = conn.clone();
                tokio::spawn(async move {
                    let Ok((send, recv)) = conn.open_bi().await else { return };
                    let mut stream = tokio::io::join(recv, send);
                    let _ = copy_bidirectional(&mut tcp, &mut stream).await;
                });
            }
        }
    }
    ep.close().await;
    Ok(())
}
