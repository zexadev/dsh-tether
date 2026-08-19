//! 审批遥控线协议与连接基元:host(电脑侧 sidecar)、手机 App、phone-sim 共用。
//! 协议:一连接一条控制 bi 流,JSON-lines;首行 Hello(已配对)或 Pair(配对)。

use std::path::Path;

use anyhow::{bail, Context as _, Result};
use iroh::endpoint::{RecvStream, SendStream};
use iroh::SecretKey;
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"dsh-remote/0";
/// 控制流单行上限;审批 reason 是模型生成的自然语言,给足余量
pub const MAX_LINE: usize = 64 * 1024;
/// 未配对连接首行上限:只够一条 pair 消息,不给未授权方喂大负载的机会
pub const MAX_UNPAIRED_LINE: usize = 512;

/// 线协议(iroh 控制流,双向)
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Wire {
    // 手机 → host(连接首条控制流的首行,二选一)
    Hello { name: String },
    Pair { code: String, name: String },
    // 手机 → host(后续代理流的首行;此行之后整条流是原始 TCP 字节)
    Proxy,
    // host → 手机(配对应答)
    PairOk,
    PairFail { reason: String },
    // host → 手机
    Approval { id: String, tool_name: String, reason: String },
    ApprovalCancel { id: String },
    // 手机 → host
    Decision { id: String, outcome: String },
}

pub fn load_or_create_secret(path: &Path) -> Result<SecretKey> {
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

/// 有界读一行:未配对方用小上限,防喂大负载
pub async fn read_line_bounded(recv: &mut RecvStream, max: usize) -> Result<String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let Some(n) = recv.read(&mut byte).await? else {
            bail!("对端在行结束前关闭了流");
        };
        if n == 0 {
            continue;
        }
        if byte[0] == b'\n' {
            return Ok(String::from_utf8(buf).context("控制流不是 UTF-8")?);
        }
        buf.push(byte[0]);
        if buf.len() > max {
            bail!("控制流单行超限({max} 字节)");
        }
    }
}

pub async fn write_line(send: &mut SendStream, line: &str) -> Result<()> {
    send.write_all(line.as_bytes()).await?;
    send.write_all(b"\n").await?;
    Ok(())
}
