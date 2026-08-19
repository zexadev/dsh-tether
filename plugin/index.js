/**
 * dsh 手机客户端:电脑侧插件。sidecar(mobile-remote-host)内嵌 iroh endpoint,
 * 把本机 dsh web UI 经 P2P 直连带到已配对手机上。
 *
 * 审批不由本插件认领:手机上跑的就是完整 web UI,`dsh-host-apiproxy` 是它的终端
 * answerer,认领会把请求从浏览器手里抢走。这里只观察后 next(),并把待审批事件转给
 * 手机用于系统通知——人不看手机就不知道 agent 卡住了,通知才是移动端不可替代的部分。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const name = 'dsh-plugin-mobile-remote'
const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{hostBinary?: string, pair?: boolean}} [config]
 */
function apply(ctx, config = {}) {
  const binary = config.hostBinary ?? defaultHostBinary()
  if (!existsSync(binary)) {
    throw new Error(`[mobile-remote] 找不到 sidecar 二进制: ${binary}(先 cargo build -p mobile-remote-host,或在插件 config.hostBinary 指定路径)`)
  }
  // webServer.port 是真实监听端口(config 写 0 时为 OS 分配值),手机由此拿到完整界面
  const proxyTarget = `${ctx.webServer.host}:${ctx.webServer.port}`

  const args = ['host', '--proxy-target', proxyTarget]
  if (config.pair) args.push('--pair')
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  ctx.effect(() => () => { child.kill() })
  child.on('exit', (code) => {
    // sidecar 死了必须可见:手机端会静默失联,而电脑侧一切照常
    console.error(`[mobile-remote] sidecar 退出 code=${code};手机端已失联`)
  })

  const send = (msg) => { child.stdin.write(JSON.stringify(msg) + '\n') }
  let endpointId = ''

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.error(`[mobile-remote] 无法解析 sidecar 消息: ${line}`)
      return
    }
    switch (msg.type) {
      case 'ready':
        endpointId = msg['endpoint_id']
        console.log(`[mobile-remote] 就绪,本机设备 ID: ${endpointId}`)
        console.log(`[mobile-remote] 手机将看到 http://${proxyTarget} 的完整界面`)
        break
      case 'pairing':
        // 一行可整体粘贴到手机,省去分别输 ID 和码
        console.log(`[mobile-remote] 配对串(${Math.round(msg['expires_in_sec'] / 60)} 分钟内有效): ${endpointId}#${msg.code}`)
        break
      case 'pairing-closed':
        console.log(`[mobile-remote] 配对窗口已关闭: ${msg.reason}`)
        break
      case 'pairing-done':
        console.log(`[mobile-remote] 配对成功: ${msg.name}(${msg.peer.slice(0, 16)}…)`)
        break
      case 'peer-connected':
        console.log(`[mobile-remote] 手机已连接: ${msg.name}`)
        break
      case 'peer-path':
        console.log(msg.kind === 'direct'
          ? `[mobile-remote] 连接路径: P2P 直连(NAT 打洞成功) ${msg.remote}`
          : `[mobile-remote] 连接路径: relay 中转(打洞未成,可用但延迟略高) ${msg.remote}`)
        break
      case 'peer-disconnected':
        console.log('[mobile-remote] 手机已断开')
        break
      default:
        console.error(`[mobile-remote] 未知 sidecar 消息: ${line}`)
    }
  })

  ctx.effect(() => ctx.webServer.tapIndex(injectNarrowScreenCss))

  ctx.on('approval/request', async (req, next) => {
    send({ type: 'approval', id: req.callId, tool_name: req.toolName ?? '', reason: req.reason ?? '' })
    try {
      return await next()
    } finally {
      // 决定已出(通常是手机上那个 web UI 自己答的),撤掉通知
      send({ type: 'approval-cancel', id: req.callId })
    }
  })
}

/**
 * 窄屏修正:只在 ≤640px 生效,桌面浏览器拿到同一份 index.html 也不受影响。
 * 只用语义选择器(role/aria),不碰 dsh 的 CSS Module 类名——那些名字带内容
 * 哈希,dsh 一改样式就会变,针对它们写规则必碎。
 */
function injectNarrowScreenCss(html) {
  const css = `
@media (max-width: 640px) {
  /* hero 背后的装饰性发光椭圆比视口宽,会让整页能被横向拖动 */
  html, body { overflow-x: hidden; }
  /* 弹窗在窄屏铺满,别再留出用不上的边距 */
  [role="dialog"][aria-modal="true"] {
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    max-height: 100% !important;
    margin: 0 !important;
    border-radius: 0 !important;
  }
  /* 设置行是「说明文字 + 控件」一行排开,说明列 min-width:0,窄屏被控件挤到
     2px 宽,中文于是一字一行。让说明占满一行、控件换到下一行。
     选择器咬的是 CSS Module 的本地名(row/rowText),只有哈希前缀会随构建变;
     dsh 若重命名,规则失效退回现状,不会更糟。 */
  [class*="_row"]:not([class*="rowText"]) { flex-wrap: wrap !important; }
  [class*="rowText"] { flex: 1 1 100% !important; }
}`
  return html.replace('</head>', `<style data-dsh-remote="narrow-screen">${css}\n</style></head>`)
}

function defaultHostBinary() {
  const here = dirname(fileURLToPath(import.meta.url))
  const exe = process.platform === 'win32' ? 'mobile-remote-host.exe' : 'mobile-remote-host'
  return join(here, '..', 'target', 'debug', exe)
}

export { name, inject, apply }
