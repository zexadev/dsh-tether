/**
 * dsh 审批遥控:电脑侧插件。经官方 `approval/request` waterfall 订阅审批,
 * 通过 sidecar(mobile-remote-host,iroh P2P)把请求发到已配对手机,等人决定。
 *
 * 回落语义:无手机在线 → 立即 next() 交还给其它 answerer;手机在线但超时/断线 →
 * 撤回手机卡片后 next()。只有手机明确决定才由本插件回答,绝不静默放行。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const name = 'dsh-plugin-mobile-remote'

/** 手机响应等待上限;人在地铁上,给足时间,但不能永远占住审批链 */
const DEFAULT_DECISION_TIMEOUT_MS = 600_000

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{hostBinary?: string, decisionTimeoutMs?: number, pair?: boolean}} [config]
 */
function apply(ctx, config = {}) {
  const binary = config.hostBinary ?? defaultHostBinary()
  if (!existsSync(binary)) {
    throw new Error(`[mobile-remote] 找不到 sidecar 二进制: ${binary}(先 cargo build -p mobile-remote-host,或在插件 config.hostBinary 指定路径)`)
  }
  const timeoutMs = config.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS

  /** @type {Map<string, (outcome: string) => void>} 在途审批 callId → resolve */
  const pending = new Map()
  let connectedPeers = 0

  const args = ['host']
  if (config.pair) args.push('--pair')
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  ctx.effect(() => () => { child.kill() })
  child.on('exit', (code) => {
    // sidecar 死了必须可见:审批遥控静默失效比失败更糟
    console.error(`[mobile-remote] sidecar 退出 code=${code};手机审批不可用,审批将回落给其它 answerer`)
    connectedPeers = 0
    for (const resolve of pending.values()) resolve('__sidecar-gone__')
    pending.clear()
  })

  const send = (msg) => { child.stdin.write(JSON.stringify(msg) + '\n') }

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
        console.log(`[mobile-remote] 就绪,本机设备 ID: ${msg['endpoint_id']}`)
        break
      case 'pairing':
        console.log(`[mobile-remote] 配对窗口已开,配对码: ${msg.code}(${Math.round(msg['expires_in_sec'] / 60)} 分钟内有效,手机端输入 ID+码完成配对)`)
        break
      case 'pairing-closed':
        console.log(`[mobile-remote] 配对窗口已关闭: ${msg.reason}`)
        break
      case 'pairing-done':
        console.log(`[mobile-remote] 配对成功: ${msg.name}(${msg.peer.slice(0, 16)}…)`)
        break
      case 'peer-connected':
        connectedPeers++
        console.log(`[mobile-remote] 手机已连接: ${msg.name}`)
        break
      case 'peer-disconnected':
        connectedPeers = Math.max(0, connectedPeers - 1)
        console.log('[mobile-remote] 手机已断开')
        break
      case 'decision': {
        const resolve = pending.get(msg.id)
        if (resolve) resolve(msg.outcome)
        break
      }
      default:
        console.error(`[mobile-remote] 未知 sidecar 消息: ${line}`)
    }
  })

  ctx.on('approval/request', async (req, next) => {
    if (connectedPeers === 0) return next()
    const id = req.callId
    send({ type: 'approval', id, tool_name: req.toolName ?? '', reason: req.reason ?? '' })
    console.log(`[mobile-remote] 审批已推送到手机,等待决定(上限 ${Math.round(timeoutMs / 60000)} 分钟)…`)

    const outcome = await new Promise((resolve) => {
      pending.set(id, resolve)
      const timer = setTimeout(() => resolve('__timeout__'), timeoutMs)
      const onAbort = () => resolve('__aborted__')
      req.signal?.addEventListener('abort', onAbort, { once: true })
      const settle = pending.get(id)
      pending.set(id, (v) => {
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onAbort)
        settle(v)
      })
    })
    pending.delete(id)

    switch (outcome) {
      case 'allowed-once':
      case 'rejected':
        console.log(`[mobile-remote] 手机已决定: ${outcome}`)
        return outcome
      case '__aborted__':
        send({ type: 'approval-cancel', id })
        return 'cancelled'
      default:
        // 超时/sidecar 消失:撤回手机卡片,交还审批链,不代替人做决定
        send({ type: 'approval-cancel', id })
        console.log(`[mobile-remote] 手机未决定(${outcome === '__timeout__' ? '超时' : 'sidecar 不可用'}),交还其它 answerer`)
        return next()
    }
  })
}

function defaultHostBinary() {
  const here = dirname(fileURLToPath(import.meta.url))
  const exe = process.platform === 'win32' ? 'mobile-remote-host.exe' : 'mobile-remote-host'
  return join(here, '..', 'target', 'debug', exe)
}

export { name, apply }
