//! 审批遥控线协议与连接基元:host(电脑侧 sidecar)、手机 App、phone-sim 共用。
//! 协议:一连接一条控制 bi 流,JSON-lines;首行 Hello(已配对)或 Pair(配对)。

use std::io::Write as _;
use std::path::Path;

use anyhow::{bail, Context as _, Result};
use iroh::endpoint::{RecvStream, SendStream};
use iroh::SecretKey;
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"dsh-tether/0";
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

/// 把既有文件/目录的权限收到仅属主可读写(目录再加可进入)。
/// Windows 没有 POSIX 权限位,是空操作。
#[cfg(unix)]
fn restrict(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(mode);
    std::fs::set_permissions(path, perms)
        .with_context(|| format!("收紧权限失败: {}", path.display()))
}
#[cfg(not(unix))]
fn restrict(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

/// 建一个仅属主可进入的目录。
fn create_private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("创建目录失败: {}", dir.display()))?;
    restrict(dir, 0o700)
}

/// 原子地写一个只有属主读得到的文件。
///
/// 两件事必须同时成立:
///
/// 一、权限。std::fs::write 按 0o666 & ~umask 建文件,通常落到 0o644,同机器上
/// 任何用户都读得到。而这里写的恰好是长期凭证——身份私钥、配对白名单——
/// 读到即可冒充,不需要能执行代码。
///
/// 二、原子性。就地截断再写,写到一半掉电或被杀就留下一个半截文件;对
/// identity.key 而言那等于主机身份丢失,所有已配对的手机都要重新配对。
/// 故先写同目录的临时文件再 rename——同一文件系统上 rename 是原子的,
/// 目标要么是旧内容要么是新内容,不会是半截。
///
/// OpenOptions 的 mode() 只在「新建」时生效。临时文件总是新建,拿得到 0o600;
/// 但 rename 之后仍显式 restrict 一次,好把老版本留下的宽权限一并收紧。
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    create_private_dir(dir)?;

    // 临时文件必须与目标同目录:跨文件系统 rename 不是原子操作,还可能直接失败。
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("write")
    ));

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&tmp)
        .with_context(|| format!("写入失败: {}", tmp.display()))?;
    let written = file
        .write_all(bytes)
        // 落盘后再 rename,否则崩溃时可能 rename 了一个内容还没落地的文件
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written {
        std::fs::remove_file(&tmp).ok();
        return Err(e).with_context(|| format!("写入失败: {}", tmp.display()));
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        std::fs::remove_file(&tmp).ok();
        return Err(e).with_context(|| format!("替换失败: {}", path.display()));
    }
    restrict(path, 0o600)
}

pub fn load_or_create_secret(path: &Path) -> Result<SecretKey> {
    if let Ok(bytes) = std::fs::read(path) {
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .with_context(|| format!("身份密钥文件损坏(长度不是 32 字节): {}", path.display()))?;
        // 旧版本以 0o644 写下的密钥仍在用户磁盘上;每次加载顺手收紧,
        // 否则升级了也修不好已经泄露面的那些机器。
        restrict(path, 0o600)?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let key = SecretKey::generate();
    write_private(path, &key.to_bytes())
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

// 权限位只在 unix 上存在;Windows 下这些断言无意义,整块不编译。
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    /// 每个用例一个独立目录,避免并行跑测试时互相干扰。
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tether-test-{}-{}", std::process::id(), name));
        std::fs::remove_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn 新建的私密文件与其目录只有属主可访问() {
        let dir = scratch("fresh");
        let path = dir.join("identity.key");
        write_private(&path, b"secret").unwrap();
        assert_eq!(mode_of(&path), 0o600, "文件权限应为 0600");
        assert_eq!(mode_of(&dir), 0o700, "目录权限应为 0700");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 重写会收紧旧版本留下的宽权限文件() {
        let dir = scratch("rewrite");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("paired.json");
        // 模拟旧版本 std::fs::write 的产物
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(mode_of(&path), 0o644, "前置条件:先是宽权限");

        write_private(&path, b"new").unwrap();
        assert_eq!(mode_of(&path), 0o600, "重写后应被收紧");
        assert_eq!(std::fs::read(&path).unwrap(), b"new", "内容应已更新");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 写入完成后不留临时文件() {
        let dir = scratch("atomic");
        let path = dir.join("identity.key");
        write_private(&path, b"one").unwrap();
        write_private(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 加载既有密钥时会顺手收紧权限() {
        let dir = scratch("load");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("identity.key");
        let key = SecretKey::generate();
        std::fs::write(&path, key.to_bytes()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        // 升级后的第一次启动:不重新生成密钥,但要把权限修好
        let loaded = load_or_create_secret(&path).unwrap();
        assert_eq!(loaded.to_bytes(), key.to_bytes(), "身份不能变");
        assert_eq!(mode_of(&path), 0o600, "既有密钥应被收紧");
        std::fs::remove_dir_all(&dir).ok();
    }
}
