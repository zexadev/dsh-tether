/**
 * dsh 手机客户端:电脑侧插件。sidecar(tether-host)内嵌 iroh endpoint,
 * 把本机 dsh web UI 经 P2P 直连带到已配对手机上。
 *
 * 审批不由本插件认领:手机上跑的就是完整 web UI,`dsh-host-apiproxy` 是它的终端
 * answerer,认领会把请求从浏览器手里抢走。这里只观察后 next(),并把待审批事件转给
 * 手机用于系统通知——人不看手机就不知道 agent 卡住了,通知才是移动端不可替代的部分。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const name = 'dsh-plugin-tether'
const inject = ['webServer', 'settings']

// 文案三处出处各不相同,各自跟随自己那一侧的语言:
//   终端输出  → 电脑的系统语言
//   路由的报错 → 请求方声明的语言(手机侧界面会带 x-dsh-tether-lang,其余按 Accept-Language)
//   注入 dsh 界面的那部分 → dsh 自己的语言设置,它写在 <html lang> 上
const terminalZh = /^zh/i.test(
  process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '',
)
/** 终端文案 */
const tt = (zh, en) => (terminalZh ? zh : en)
/**
 * sidecar 发的是配对失败原因码(tether-core 定义),不是人话——同一条消息手机上也要显示,
 * 只能各端各译。认不出的原样带出:0.1.16 及更早的 sidecar 直接发中文句子。
 */
const pairFailText = (code) => ({
  'no-window': tt('主机上没有开着的配对窗口', 'no pairing window is open'),
  expired: tt('配对窗口已过期', 'the pairing window expired'),
  'too-many-attempts': tt('配对码试错次数超限', 'too many wrong codes'),
  'bad-code': tt('配对码不正确', 'wrong pairing code'),
}[code] ?? code)
/** 路由文案 */
const tr = (req, zh, en) => {
  const declared = req.headers['x-dsh-tether-lang'] || req.headers['accept-language'] || ''
  return /(^|[\s,])zh/i.test(declared) ? zh : en
}

/** 手机侧只读查看配置文件的路由 */
const CONFIG_DOCUMENT_PATH = '/dsh-tether/config-document'
/** 按需开一个配对窗口,拿回配对串 */
const PAIRING_PATH = '/dsh-tether/pairing'
const DEVICES_PATH = '/dsh-tether/devices'

/** dsh 的回环判定:localhost、IPv6 回环、以及整个 127/8 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 浏览器信任栅栏,判据照抄 dsh 自己 `/api` 那套(它的 isTrustedApiRequest 没有
 * 从包里导出,只能同判据重写一份):Host 必须是回环权威;带 `sec-fetch-site:
 * cross-site` 标记的一律拒;带 Origin 时其 authority 必须与 Host 相同。
 *
 * 挡的是浏览器打开的两条「受骗代理」路径:DNS 重绑定(Host 写攻击者域名而套接字
 * 落到本机)和恶意页面发出的跨站请求。**挡不住本机进程** —— 本机 curl 的 Host
 * 就是回环,照样通过,这是这套栅栏的设计边界,不是实现疏漏。
 *
 * 这里不接受 trustedHosts:本插件的路由只服务本机,没有远程授权的语义。
 */
function isTrustedRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 未通过栅栏时统一的拒绝应答,和 dsh 的 /api 一样是裸 403,不泄露路由细节 */
/** 读 POST body 里的 {"id": "..."};格式不对一律当作没给 */
async function readForgetId(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // 请求体只可能是一个 64 位十六进制 id,超过这个量级就是异常输入
    if (size > 4096) return undefined
    chunks.push(chunk)
  }
  try {
    const id = JSON.parse(Buffer.concat(chunks).toString('utf8')).id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

function refuse(res) {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('forbidden')
}

/**
 * 挂「应用内浏览」目录选择器(directoryPicker 服务的 browse 后端)。
 *
 * 原本这个 host 半边和 client 半边一样,由 cordis.patch.yml 直接 insert 成一条
 * loader entry。dsh 0.2.2-rc.1 在桌面端(Windows)把默认的 auto 选择器解析成
 * native(系统对话框),而插件管理器里的「热启用」不重启进程:补丁把 auto 停掉是
 * 异步卸载 native,新 insert 的 browse 却在 native 还没让位时就注册
 * `directoryPicker`——一个服务只能注册一次,browse 于是报
 * `service "directoryPicker" has been registered at <NativeDirectoryPicker>`。
 * 冷启动没有这个问题(补丁先叠好、auto 根本没挂 native),只有热启用会踩中。
 *
 * 所以 host 半边改到这里用代码挂,并带重试:冷启动第一次就成功;热启用时按
 * 100ms 重试,直到 native 让位。client 半边仍在 patch 里,它不注册该服务。
 */
async function mountBrowsePicker(ctx) {
  let BrowseDirectoryPicker
  try {
    ;({ default: BrowseDirectoryPicker } = await import('@deepseek-ai/dsh-host-directory-picker-browse'))
  } catch (error) {
    console.error(`[tether] ${tt(
      '目录浏览后端不可用,手机端「添加工作区」将无法选目录: ',
      'the browse directory picker is unavailable, so the phone cannot choose a workspace: ',
    )}${error}`)
    return
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await ctx.plugin(BrowseDirectoryPicker, {})
      console.log(`[tether] ${tt(
        '目录浏览后端已就绪,手机端可浏览选择工作区',
        'browse directory picker ready; the phone can browse and choose a workspace',
      )}`)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 只有「服务已被别人注册」才值得等——native 卸载是异步的,重试即可;
      // 其它错误(包坏了、配置不合法等)重试也没用,原样打出来。
      if (!/has been registered/.test(message)) {
        console.error(`[tether] ${tt(
          '目录浏览后端注册失败: ',
          'the browse directory picker failed to register: ',
        )}${error}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  console.error(`[tether] ${tt(
    '目录浏览后端迟迟注册不上(默认选择器一直占着 directoryPicker),手机端「添加工作区」不可用',
    'the browse directory picker never registered (the default picker kept directoryPicker), so the phone cannot add a workspace',
  )}`)
}

/** 与 sidecar 无关的部分:窄屏适配注入,以及手机上看配置文件的路由 */
function applyUi(ctx) {
  mountTetherUi(ctx)
  void mountBrowsePicker(ctx)

  // 「打开配置文件」在宿主机桌面开编辑器,手机上按了毫无反应。这条路由把同一份
  // 文件的内容原样交给手机自己渲染。路径由 Host 侧的 settings.documentPath 决定,
  // 不接受客户端传路径——否则就成了任意文件读取。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_DOCUMENT_PATH,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return refuse(res)
      const path = await ctx.settings.prepareDocument()
      if (path === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(tr(req, '当前的设置存储不是本地文件,没有可查看的配置文件', 'The settings store is not a local file, so there is no config file to show'))
        return
      }
      let text
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`${tr(req, '读不到配置文件 ', 'cannot read the config file ')}${path}: ${String(error)}`)
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ path, text }))
    },
  }))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{hostBinary?: string, pair?: boolean, sidecar?: boolean}} [config]
 */
function apply(ctx, config = {}) {
  // 手机 App 的本地模式:dsh 就跑在手机上,没有远端也没有配对,只要窄屏适配与
  // 目录选择器替换(patch 里那两条)。侧栏底部的按钮在 iframe 里照样出现,它把
  // 「打开主机页」交给外层 App,与远程模式一致。
  if (config.sidecar === false) {
    applyUi(ctx)
    return
  }
  const binary = config.hostBinary ?? resolveHostBinary()
  if (binary === undefined || !existsSync(binary)) {
    throw new Error(
      `[tether] ${tt(
        `找不到 sidecar 二进制(平台 ${process.platform}-${process.arch})。从源码用:先跑 cargo build --release -p tether-host;`
        + '或在插件 config.hostBinary 里指定路径。若你是从 npm/GitHub 安装的,说明该平台的 dsh-tether-host-* 子包还没发布,请提 issue。',
        `sidecar binary not found for ${process.platform}-${process.arch}. From source: run cargo build --release -p tether-host, `
        + 'or point config.hostBinary at it. If you installed from npm/GitHub, the dsh-tether-host-* package for this platform is not published yet — please open an issue.',
      )}`,
    )
  }
  // dsh 0.2.1-alpha.2 起 webServer 能开 TLS。隧道里转的是明文 HTTP(代理流还要改写请求头),
  // 对着 HTTPS 监听器只会让手机白屏,所以这里直接拒,不留给用户去猜。protocol 是那一版才有的,
  // 旧版本读不到就按 http 算
  if ((ctx.webServer.protocol ?? 'http:') !== 'http:') {
    throw new Error(
      `[tether] ${tt(
        'dsh web 开了 TLS(https),而手机走的代理流只能转明文 HTTP,连上只会白屏。去掉 webServer 的 tls 配置再用手机连接。',
        'dsh web is serving HTTPS, but the proxy stream the phone uses can only carry plain HTTP — the phone would get a blank page. Remove the tls config from webServer before connecting the phone.',
      )}`,
    )
  }
  // webServer.port 是真实监听端口(config 写 0 时为 OS 分配值),手机由此拿到完整界面。
  // host 从 0.2.1-alpha.2 起可以是任意字面地址:IPv6 的要带方括号,否则 sidecar 那边按
  // SocketAddr 解析 --proxy-target 直接失败(`::1:3000` 不是合法写法)
  const host = ctx.webServer.host.includes(':') ? `[${ctx.webServer.host}]` : ctx.webServer.host
  const proxyTarget = `${host}:${ctx.webServer.port}`

  // sidecar 的人读日志与这里打在同一个终端上,语言跟着走,免得一半中文一半英文
  const args = ['host', '--proxy-target', proxyTarget, '--lang', terminalZh ? 'zh' : 'en']
  if (config.pair) args.push('--pair')
  // windowsHide:dsh desktop 的插件宿主是 ELECTRON_RUN_AS_NODE 跑的 Electron,GUI 子系统、自己没有
  // console,于是 Windows 给这个 console 子系统的 sidecar 分配一个新 console 并把窗口显示出来。该
  // 选项让 libuv 传 SW_HIDE,新分配的窗口不显示;stderr 的 inherit 不受影响,在终端里跑 dsh 时
  // sidecar 的日志照旧打在同一个终端
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  ctx.effect(() => () => { child.kill() })
  /** sidecar 不在了的原因;undefined = 活着。等它回话的路由用来立即报错 */
  let sidecarGone
  child.on('exit', (code) => {
    // sidecar 死了必须可见:手机端会静默失联,而电脑侧一切照常
    sidecarGone = tt(`sidecar 已退出(code=${code})`, `the sidecar exited (code=${code})`)
    console.error(`[tether] ${tt(`sidecar 退出 code=${code};手机端已失联`, `the sidecar exited with code=${code}; the phone is now cut off`)}`)
  })
  // spawn 失败只走 error 不走 exit;不接住就是 uncaught。EACCES 曾实发过:
  // 打包丢了二进制执行位,现场只有一句干瘪的 Permission denied,毫无指向
  child.on('error', (error) => {
    const hint = error.code === 'EACCES'
      ? tt(';EACCES 通常是二进制缺可执行位,试 chmod 0755 该文件并升级插件', '; EACCES usually means the binary lost its execute bit — try chmod 0755 on it and update the plugin')
      : ''
    sidecarGone = `${tt('sidecar 启动失败: ', 'the sidecar failed to start: ')}${error.message}${hint}`
    console.error(`[tether] ${sidecarGone}(${binary})`)
  })

  const send = (msg) => { child.stdin.write(JSON.stringify(msg) + '\n') }
  let endpointId = ''
  /** 等着拿配对串的那个请求;sidecar 回 pairing 时兑现 */
  let pendingPairing
  /** 等着拿设备列表的那些请求;sidecar 回 devices 时一并兑现 */
  let pendingDevices = []

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.error(`[tether] ${tt('无法解析 sidecar 消息: ', 'cannot parse the sidecar message: ')}${line}`)
      return
    }
    switch (msg.type) {
      case 'ready':
        endpointId = msg['endpoint_id']
        console.log(`[tether] ${tt('就绪,本机设备 ID: ', 'ready, device ID of this machine: ')}${endpointId}`)
        console.log(`[tether] ${tt(`手机将看到 http://${proxyTarget} 的完整界面`, `the phone will see the full interface at http://${proxyTarget}`)}`)
        break
      case 'pairing': {
        // 一行可整体粘贴到手机,省去分别输 ID 和码
        const pairingString = `${endpointId}#${msg.code}`
        console.log(`[tether] ${tt(`配对串(${Math.round(msg['expires_in_sec'] / 60)} 分钟内有效): `, `pairing string (valid for ${Math.round(msg['expires_in_sec'] / 60)} min): `)}${pairingString}`)
        const waiter = pendingPairing
        pendingPairing = undefined
        waiter?.({ pairingString, expiresInSec: msg['expires_in_sec'] })
        break
      }
      case 'pairing-closed':
        console.log(`[tether] ${tt('配对窗口已关闭: ', 'the pairing window closed: ')}${pairFailText(msg.reason)}`)
        break
      case 'pairing-done':
        console.log(`[tether] ${tt('配对成功: ', 'paired: ')}${msg.name}(${msg.peer.slice(0, 16)}…)`)
        break
      case 'peer-connected':
        console.log(`[tether] ${tt('手机已连接: ', 'phone connected: ')}${msg.name}`)
        break
      case 'peer-path':
        console.log(`[tether] ${msg.kind === 'direct'
          ? tt('连接路径: P2P 直连(NAT 打洞成功) ', 'path: direct P2P (NAT hole punch succeeded) ')
          : tt('连接路径: relay 中转(打洞未成,可用但延迟略高) ', 'path: via relay (hole punch failed; works, slightly higher latency) ')}${msg.remote}`)
        break
      case 'peer-disconnected':
        console.log(`[tether] ${tt('手机已断开', 'phone disconnected')}`)
        break
      case 'proxy-opened':
        console.log(`[tether] ${tt('手机已开始加载界面', 'the phone started loading the interface')}`)
        break
      case 'devices': {
        const waiters = pendingDevices
        pendingDevices = []
        for (const w of waiters) w(msg.devices)
        break
      }
      default:
        console.error(`[tether] ${tt('未知 sidecar 消息: ', 'unknown sidecar message: ')}${line}`)
    }
  })

  applyUi(ctx)

  // dsh 0.1.2-alpha 起浏览器界面要求认证:进程启动 token 经 GET /?token= 换成
  // HMAC 签名 cookie,index 与 /api 无 cookie 一律 401。cookie 是 SameSite=Strict
  // 且绑定 Host authority——手机 WebView 的 iframe 属跨站上下文,cookie 根本不会
  // 随请求发出,把 token 交给手机没有用;唯一可行位置在电脑侧:这里自己完成兑换,
  // 把 cookie 交给 sidecar 在代理流上逐请求注入。
  ctx.inject(['connection'], (connCtx) => {
    // rc.7/rc.8 也有 connection 服务,只是没有浏览器认证;判据必须是能力
    // 本身而不是服务存在性(实测 rc.8 走到这里,靠服务存在性判会误报错)
    if (typeof connCtx.connection.authenticatedUrl !== 'function') return
    const authority = new URL(`http://${proxyTarget}`).host
    const exchange = async () => {
      const url = connCtx.connection.authenticatedUrl(`http://${proxyTarget}/`)
      const res = await fetch(url, { redirect: 'manual' })
      const setCookie = res.headers.getSetCookie()
      if (res.status !== 303 || setCookie.length !== 1) {
        throw new Error(`${tt('token 兑换应答异常: ', 'unexpected token-exchange reply: ')}HTTP ${res.status}, set-cookie ×${setCookie.length}`)
      }
      send({ type: 'proxy-auth', cookie: setCookie[0].split(';', 1)[0], authority })
    }
    const exchangeWithRetry = async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await exchange()
        } catch (error) {
          if (attempt >= 3) {
            console.error(`[tether] ${tt('浏览器认证 cookie 获取失败,手机端将收到 401:', 'could not obtain the browser auth cookie; the phone will get 401:')}`, error)
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        }
      }
    }
    void exchangeWithRetry()
    // cookie 绝对有效期默认 30 天,dsh 进程可能活得更久;定期重兑换续上
    const timer = setInterval(() => { void exchangeWithRetry() }, 12 * 60 * 60 * 1000)
    connCtx.effect(() => () => clearInterval(timer))
  })

  // 配对窗口只在白名单为空时自动开一次;换手机、加第二台设备都得能再开一个,
  // 否则用户只能去手工删 paired.json。这条路由就是那个开关。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PAIRING_PATH,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return refuse(res)
      // sidecar 不在了就别让人干等 5 秒换一个不明所以的 504
      if (sidecarGone !== undefined) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(sidecarGone)
        return
      }
      const result = await new Promise((resolve) => {
        pendingPairing = resolve
        send({ type: 'pairing-begin' })
        setTimeout(() => {
          if (pendingPairing !== resolve) return
          pendingPairing = undefined
          resolve(undefined)
        }, 5000)
      })
      if (result === undefined) {
        res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(tr(req, 'sidecar 没有在 5 秒内给出配对码', 'the sidecar did not return a pairing code within 5 seconds'))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result))
    },
  }))

  // 白名单只增不减是个安全问题:手机每重装一次 App 就换一把身份密钥,旧的那把
  // 仍留在白名单里持有访问权,而电脑端此前没有任何入口能看见或撤销它们。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEVICES_PATH,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) return refuse(res)
      if (sidecarGone !== undefined) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(sidecarGone)
        return
      }
      if (req.method === 'POST') {
        const id = await readForgetId(req)
        if (id === undefined) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(tr(req, '缺少要移除的设备 id', 'the device id to remove is missing'))
          return
        }
        send({ type: 'device-forget', id })
      } else {
        send({ type: 'device-list' })
      }
      const devices = await new Promise((resolve) => {
        pendingDevices.push(resolve)
        setTimeout(() => {
          const at = pendingDevices.indexOf(resolve)
          if (at === -1) return
          pendingDevices.splice(at, 1)
          resolve(undefined)
        }, 5000)
      })
      if (devices === undefined) {
        res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(tr(req, 'sidecar 没有在 5 秒内返回设备列表', 'the sidecar did not return the device list within 5 seconds'))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ devices }))
    },
  }))

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
 * 注入有两条通道,按宿主 webserver 的能力二选一:
 *
 * - 结构化的 `webserver/index-inject` 表(dsh 0.2.x 起):行是纯数据,一张表喂两个
 *   渲染器。浏览器那边由宿主渲进 index.html 文本;**dsh desktop** 的 index.html 是
 *   应用自带的前端产物,走 file:// 加 IPC,根本不经过宿主 renderIndex,只会把这张表
 *   经 boot 通道(ready.injections)交给渲染器逐行建元素。桌面端要看到这部分界面,
 *   只能走这条。
 * - `tapIndex` 字符串变换(老宿主):只作用于宿主渲染的 index.html,桌面端永远看不到。
 *
 * 判据是能力(collectIndexInjections 在不在)而不是版本号。两条只走一条:同一份文本
 * 注两遍没有意义,样式和监听器都会多一份。
 */
function mountTetherUi(ctx) {
  if (typeof ctx.webServer.collectIndexInjections === 'function') {
    ctx.effect(() =>
      ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'style', text: tetherCss })
        table.push({ kind: 'script', placement: 'head', text: tetherScript })
      }),
    )
    return
  }
  ctx.effect(() => ctx.webServer.tapIndex(injectNarrowScreenCss))
}

/**
 * 窄屏修正:只在 ≤640px 生效,桌面浏览器拿到同一份 index.html 也不受影响。
 * 只用语义选择器(role/aria),不碰 dsh 的 CSS Module 类名——那些名字带内容
 * 哈希,dsh 一改样式就会变,针对它们写规则必碎。
 */
const tetherCss = `
/* 侧栏底部的 sidebar.footer.action 是横排 flex 行,官方设想里放并排的小动作。
   「连接手机」照抄「设置」的类,是占满一行的触发行;别的插件(dsh-cost-meter)
   又往同一行放 width:100% 的面板,横排下两者互挤:本按钮被压到只剩图标,
   rail 态更被顶出 56px 的侧栏。改成纵向堆叠,各占一行;独占时与横排等价。
   rail 态容器宽随内容,居中才与「设置」图标对齐。 */
[class*="footArea"] > [class*="footerActions"] {
  flex-direction: column !important;
  align-items: stretch !important;
}
[class*="collapsed"] [class*="footArea"] > [class*="footerActions"] { align-items: center !important; }
@media (max-width: 640px) {
  /* hero 背后的装饰性发光椭圆比视口宽,会让整页能被横向拖动 */
  html, body { overflow-x: hidden; }
  /* 弹窗在窄屏铺满,别再留出用不上的边距 */
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) {
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
     dsh 若重命名,规则失效退回现状,不会更糟。
     必须要求带 rowText 直接子元素:光凭名字里有 row 还会命中会话里的工具调用
     行,那种行高度写死 24px 且 overflow:hidden,一换行标题就被切掉半截。 */
  [class*="_row"]:has(> [class*="rowText"]) { flex-wrap: wrap !important; }
  [class*="_row"] > [class*="rowText"] { flex: 1 1 100% !important; }

  /* 弹窗是「左导航 + 右内容」横向排列,导航固定 188px——在 412px 的手机上
     占掉 45%,内容只剩两百出头。改成导航横排在顶、内容占满整宽。
     导航是 <nav> 标签、内容是弹窗下唯一的直接 div,都用结构选择器命中。 */
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) { display: flex !important; flex-direction: column !important; }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) > nav {
    width: 100% !important;
    height: auto !important;
    flex: none !important;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) > nav [class*="navList"] {
    flex-direction: row !important;
    overflow-x: auto !important;
    height: auto !important;
    gap: 6px;
    scrollbar-width: none;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) > nav [class*="navList"]::-webkit-scrollbar { display: none; }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) > nav [class*="navCell"] {
    flex: none !important;
    width: auto !important;
    white-space: nowrap;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) > div {
    width: 100% !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }
  /* 侧栏展开时主框架把网格从「56px 内容」改成「280px 内容」,对话区被压到
     140px。改成抽屉:网格保持收起时的列宽,侧栏浮到内容之上盖住一部分。
     展开态读 dsh 自己写在 frame 上的 data-sidebar-collapsed(收起为 "true",
     展开时该属性不在),0.1.0-rc.7 起每个版本都带。把手本身在手机上没用
     (没法拖),隐掉。 */
  /* 网格恒定为收起时的列宽,侧栏恒定绝对定位、只让宽度随展开态变化——
     position 不可过渡,只有始终 absolute 才能做出滑入滑出的动画。
     侧栏脱离文档流后剩下的子元素会整体上移一列(对话区掉进 56px 那列,
     反而更窄),所以显式钉住列号。 */
  /* 只认最外层那个 frame。dsh 里好几个组件的局部类名也带 _frame(会话区、
     附件缩略图、子代理、文档预览),它们都长在它里面:附件缩略图自己是个
     单格网格,被这条列模板改掉后图片会挤进 56px 的第一列。 */
  /* dsh 0.2.2-rc 起在 <768px 自带抽屉:frame 挂 data-sidebar-drawer,自带
     遮罩(z-index 70)与滑入动画。这段手工抽屉只服务没有原生抽屉的旧版本,
     原生抽屉出现时整体让位——否则我们的 z-index:30 会落到原生遮罩(70)下面,
     侧栏被遮罩压成一块黑、点也点不到。 */
  [class*="_frame"]:not([class*="_frame"] *):not([data-sidebar-drawer]) {
    grid-template-columns: 56px minmax(0, 1fr) 0px !important;
  }
  [class*="_frame"]:not([data-sidebar-drawer]) > [class*="centerCol"] { grid-column: 2 !important; }
  /* 右列 dsh 0.1.5 起从 detailsCol 改名 rightbarCol,两个名字都钉住 */
  [class*="_frame"]:not([data-sidebar-drawer]) > [class*="detailsCol"],
  [class*="_frame"]:not([data-sidebar-drawer]) > [class*="rightbarCol"] { grid-column: 3 !important; }
  [class*="_frame"]:not([data-sidebar-drawer]) > [class*="sidebarCol"] {
    position: absolute !important;
    top: 0;
    bottom: 0;
    left: 0;
    width: 56px !important;
    z-index: 30 !important;
    transition: width 220ms ease, box-shadow 220ms ease;
  }
  [class*="_frame"]:not([data-sidebar-drawer]):not([data-sidebar-collapsed="true"]) > [class*="sidebarCol"] {
    width: min(300px, 84vw) !important;
    box-shadow: 0 10px 36px rgba(0, 0, 0, 0.24);
  }
  /* 抽屉下的内容压暗。指针不拦——收起由注入的脚本接管,拦了反而会在脚本
     未生效时把整页点死。 */
  [class*="_frame"]:not([class*="_frame"] *):not([data-sidebar-drawer])::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 25;
    background: rgba(0, 0, 0, 0.28);
    opacity: 0;
    pointer-events: none;
    transition: opacity 220ms ease;
  }
  [class*="_frame"]:not([class*="_frame"] *):not([data-sidebar-drawer]):not([data-sidebar-collapsed="true"])::after { opacity: 1; }
  [class*="_frame"]:not([data-sidebar-drawer]) > [class*="_handle"] { display: none !important; }

  /* 侧栏收起时是图标条,「主机」按钮的文字跟着藏起来,和 dsh 自己的按钮一致 */
  [data-dsh-tether="hosts-label"] { display: none; }
  [class*="_frame"]:not([data-sidebar-collapsed="true"]) [data-dsh-tether="hosts-label"] { display: inline; }
  @media (prefers-reduced-motion: reduce) {
    [class*="_frame"]:not([data-sidebar-drawer]) > [class*="sidebarCol"],
    [class*="_frame"]:not([data-sidebar-drawer])::after { transition: none; }
  }

  /* 触摸时安卓 WebView 会按元素的 DOM 盒子刷一块蓝色高亮,方角、盖住圆角,
     和 dsh 自己的按下态叠在一起很脏。关掉它,按下反馈交给页面自己的样式。 */
  * { -webkit-tap-highlight-color: transparent; }

  /* 竖排之后,内容区自带的头部(关闭键)会落到标签栏下方、屏幕
     正中,很别扭。钉到弹窗右上角,与标题同一行——手机弹窗关闭键就该在那儿。 */
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) { position: relative !important; }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]) > div > [class*="_header"] {
    position: absolute !important;
    top: 10px;
    right: 12px;
    left: auto !important;
    width: auto !important;
    height: auto !important;
    z-index: 2;
  }
}`

// 抽屉遮罩只是画上去的,点它不会收起——那需要脚本。这段只做这一件事:
// 窄屏下点到抽屉外面就替用户按一次侧栏开关。
const tetherScript = `
(function () {
  var narrow = window.matchMedia('(max-width: 640px)')
  // 这一部分长在 dsh 界面里,语言就该跟 dsh 的设置走;它把当前语言写在 <html lang> 上
  function zhUi() { return /^zh/i.test(document.documentElement.lang || '') }
  function tx(zh, en) { return zhUi() ? zh : en }
  function langHeaders() { return { 'x-dsh-tether-lang': zhUi() ? 'zh' : 'en' } }
  document.addEventListener('pointerdown', function (event) {
    if (!narrow.matches) return
    var frame = document.querySelector('[class*="_frame"]')
    // dsh 0.2.2-rc 起自带抽屉,遮罩自己会点外收起;这里只补没有原生抽屉的旧版
    if (!frame || frame.hasAttribute('data-sidebar-drawer')) return
    // 抽屉开着才有「点外面收起来」可言;判据和样式那边同一个
    if (frame.getAttribute('data-sidebar-collapsed') === 'true') return
    var drawer = frame.querySelector(':scope > [class*="sidebarCol"]')
    if (!drawer || drawer.contains(event.target)) return
    var toggle = document.querySelector('button[aria-label*="侧边栏"], button[aria-label*="sidebar" i]')
    if (!toggle) return
    // 这一下只用来收抽屉,不该顺带点到底下的东西
    event.preventDefault()
    event.stopPropagation()
    toggle.click()
  }, true)

  // 「打开配置文件」会在宿主机桌面开编辑器,手机上按了毫无反应。窄屏下改成
  // 就地渲染文件内容——只读,想改仍然去电脑上改。
  // 色值/圆角/字重全部取自 dsh 自身的实测计算值,别在人家界面里插一块不一样的东西。
  // 窄屏铺满一屏,宽屏收成居中卡片——和 dsh 的弹窗一个做法。
  function viewer(title, body, error, extraFactory) {
    var dark = matchMedia('(prefers-color-scheme: dark)').matches
    var t = dark
      ? { fg: '#f9fafb', surface: '#2c2c2e', line: 'rgba(255,255,255,.12)', muted: '#adb2b8', danger: '#f5766b' }
      : { fg: '#0f1115', surface: '#ffffff', line: 'rgba(0,0,0,.1)', muted: '#81858c', danger: '#b42318' }

    var mask = document.createElement('div')
    mask.setAttribute('data-dsh-tether', 'viewer')
    mask.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;'
      + 'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:' + t.fg + ';'
      + (narrow.matches ? 'background:' + t.surface : 'background:rgba(0,0,0,.32);padding:24px')

    var card = document.createElement('div')
    card.setAttribute('data-dsh-tether', 'card')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    card.style.cssText = 'display:flex;flex-direction:column;background:' + t.surface + ';'
      + (narrow.matches
        ? 'width:100%;height:100%'
        : 'width:min(620px,100%);max-height:min(70vh,720px);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.24)')

    var bar = document.createElement('div')
    bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ' + t.line
    var name = document.createElement('div')
    name.style.cssText = 'flex:1;min-width:0;font-size:12px;color:' + t.muted
    name.textContent = title

    // dsh 的次要按钮就是这个样子:透明底 + 1px 描边 + 14 圆角 + 12px 常规字重
    var slim = 'flex:none;font:inherit;font-size:12px;font-weight:400;padding:5px 12px;border-radius:14px;'
      + 'border:1px solid ' + t.line + ';background:transparent;color:inherit;cursor:pointer'
    var copy = document.createElement('button')
    copy.textContent = tx('复制', 'Copy')
    copy.style.cssText = slim
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(body).then(
        function () { copy.textContent = tx('已复制', 'Copied') },
        function () { copy.textContent = tx('复制失败', 'Copy failed') },
      )
    })
    var close = document.createElement('button')
    close.textContent = tx('关闭', 'Close')
    close.style.cssText = slim
    close.addEventListener('click', function () { mask.remove() })
    bar.append(name)
    if (!error) bar.append(copy)
    bar.append(close)

    var pre = document.createElement('pre')
    pre.style.cssText = 'flex:1;margin:0;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-all;'
      + 'font:13px/1.8 ui-monospace,"SF Mono",Consolas,monospace' + (error ? ';color:' + t.danger : '')
    pre.textContent = error ? error : body

    card.append(bar, pre)
    if (extraFactory) card.append(extraFactory(t, slim))
    mask.append(card)
    // 宽屏点遮罩关闭,窄屏没有遮罩可点
    if (!narrow.matches) mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove() })
    document.body.append(mask)
  }

  // 侧栏底部的 sidebar.footer.action 插槽:官方留给第三方放自己入口的位置。
  // 这里放「主机」按钮,点了让外层的手机客户端打开它自己的主机页。
  // 同一个按钮两种归宿:手机 App 里打开它自己的主机页;电脑浏览器里出示配对串,
  // 好让用户换手机、加设备时有地方拿新配对码(否则只能去删 paired.json)。
  // 判据是「App 自己挂的标记」,不是「我在不在 iframe 里」:dsh 桌面端的插件界面
  // 同样跑在宿主的内嵌 frame 里,按 window.parent !== window 判会被当成手机 App,
  // 按钮变「我的电脑」、点了只往父窗口发一条消息——桌面端没有这条消息的监听者,
  // 按钮就是死的。标记拿不到一律按浏览器处理,出示配对串,至少点得动;
  // 0.1.24 及更早的 App 没有这个标记,在 App 里也会出示配对串(它自己的顶栏有
  // 「主机」入口,功能不丢)。
  var inApp = !!window.__DSH_TETHER_APP__

  // 已配对手机列表。白名单每条都持有访问权,而手机重装 App 会换身份密钥,
  // 旧条目就此变成没人认识的常驻凭证——这里是撤销它们的地方。
  function devicesBlock(t, slim) {
    var box = document.createElement('div')
    box.style.cssText = 'flex:none;border-top:1px solid ' + t.line + ';padding:12px 16px 14px'
    var head = document.createElement('div')
    head.style.cssText = 'font-size:12px;color:' + t.muted + ';padding-bottom:8px'
    head.textContent = tx('已配对的手机', 'Paired phones')
    var list = document.createElement('div')
    box.append(head, list)

    function render(devices) {
      list.textContent = ''
      if (!devices.length) {
        var none = document.createElement('div')
        none.style.cssText = 'font-size:12px;color:' + t.muted
        none.textContent = tx('还没有手机配对过', 'No phone paired yet')
        list.append(none)
        return
      }
      devices.forEach(function (d) {
        var row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:7px 0'
        var dot = document.createElement('span')
        dot.style.cssText = 'flex:none;width:7px;height:7px;border-radius:50%;background:'
          + (d.online ? '#12b76a' : t.line)
        dot.title = d.online ? tx('在线', 'online') : tx('离线', 'offline')
        var label = document.createElement('div')
        label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        label.textContent = d.name
        var idTag = document.createElement('span')
        idTag.style.cssText = 'font-size:12px;color:' + t.muted
          + ';font-family:ui-monospace,"SF Mono",Consolas,monospace;padding-left:8px'
        idTag.textContent = d.id.slice(0, 8)
        label.append(idTag)
        // 不用原生 confirm:第一下改文案,第二下才真删
        var drop = document.createElement('button')
        drop.textContent = tx('移除', 'Remove')
        drop.style.cssText = slim
        var armed = false
        drop.addEventListener('click', function () {
          if (!armed) {
            armed = true
            drop.textContent = tx('确认移除?', 'Remove it?')
            drop.style.color = t.danger
            setTimeout(function () {
              if (!armed) return
              armed = false
              drop.textContent = tx('移除', 'Remove')
              drop.style.color = 'inherit'
            }, 4000)
            return
          }
          drop.disabled = true
          drop.textContent = tx('移除中', 'Removing')
          fetch('${DEVICES_PATH}', {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, langHeaders()),
            body: JSON.stringify({ id: d.id }),
          })
            .then(function (r) { return r.ok ? r.json() : r.text().then(function (x) { throw new Error(x) }) })
            .then(function (x) { render(x.devices) })
            .catch(function (e) {
              drop.disabled = false
              drop.textContent = tx('移除失败', 'Removal failed')
              console.error('[dsh-tether] ' + tx('移除设备失败', 'could not remove the device'), e)
            })
        })
        row.append(dot, label, drop)
        list.append(row)
      })
    }

    var loading = document.createElement('div')
    loading.style.cssText = 'font-size:12px;color:' + t.muted
    loading.textContent = tx('读取中…', 'Loading…')
    list.append(loading)
    fetch('${DEVICES_PATH}', { headers: langHeaders() })
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (x) { throw new Error(x) }) })
      .then(function (x) { render(x.devices) })
      .catch(function (e) { loading.textContent = tx('读取失败: ', 'Loading failed: ') + (e && e.message ? e.message : e) })
    return box
  }

  function showPairing() {
    fetch('${PAIRING_PATH}', { headers: langHeaders() })
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t) }) })
      .then(function (d) {
        viewer(
          tx('在手机上「添加电脑」里粘贴整行,', 'Paste the whole line into “Add a computer” on the phone; valid for ')
            + Math.round(d.expiresInSec / 60) + tx(' 分钟内有效', ' min'),
          d.pairingString,
          undefined,
          devicesBlock,
        )
      })
      .catch(function (e) { viewer(tx('配对', 'Pairing'), '', String(e && e.message ? e.message : e)) })
  }

  // 可抄样式的参照行。浏览器侧是「设置」:triggerRow(定高的横排容器)套 trigger
  // (flex:1 1 0%)两层,只抄里层放进纵向堆叠的插槽,basis 0% 会变成高度、按钮塌成
  // 一行字,所以两层都抄。dsh desktop 的设置入口在原生壳里(⌘,),侧栏里没有
  // settings.trigger,但 footer 底下那一行(登录后是账号行,没登录是「更多」)是同一
  // 族的 triggerRow,改抄它。
  function hostsReference() {
    var settings = document.querySelector('[data-slot="settings.trigger"]')
    var trigger = settings && settings.closest ? settings.closest('button') : null
    if (trigger && trigger.parentElement) return { row: trigger.parentElement, trigger: trigger, browser: true }
    var row = document.querySelector('[class*="settingsArea"] [class*="triggerRow"]')
    var button = row && row.querySelector('button')
    if (row && button) return { row: row, trigger: button, browser: false }
    return null
  }

  // 同一行里 padding + 图标 + gap 决定文字从哪开始,所以图标与参照行一样宽,两行的
  // 图标列和文字列才对齐。桌面端那一行会随登录状态换形态(没登录是 14px 字形,登录
  // 后是 24px 头像),宽度因此是量参照行量出来的,不写死;量不到就退回 16。
  function referenceIconWidth(trigger) {
    var art = trigger.querySelector('svg, img')
    var width = art ? Math.round(art.getBoundingClientRect().width) : 0
    return width >= 12 && width <= 24 ? width : 16
  }

  // 参照行里装文字的那个 span。登录后账号行是「头像 span + 文字 span」两个,头像那个
  // 24×24、圆、带 skeleton 底色,抄到它中文就竖成一字一行;头像恒在文字前面,所以取
  // 末位。判据是「里面没有元素、不带 data-avatar-status」,不认类名 —— 类名带内容哈希。
  // 侧栏收起时那一行只有图标、没有文字 span,返回 null。
  function referenceLabelOf(trigger) {
    var spans = trigger.querySelectorAll('span')
    var picked = null
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i]
      if (span.children.length === 0 && !span.hasAttribute('data-avatar-status')) picked = span
    }
    return picked
  }

  // dsh 自己那套小图标的画法:16 视图框、1.3px 描边,字形落在 1.5~14.5 的方框里
  function phoneIcon(size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">'
      + '<rect x="5.15" y="2.15" width="5.7" height="11.7" rx="1.6"/><path d="M7.1 11.6h1.8" stroke-linecap="round"/></svg>'
  }

  function mountHostsTrigger() {
    var slot = document.querySelector('[data-slot="sidebar.footer.action"]')
    if (!slot || slot.querySelector('[data-dsh-tether="hosts-trigger"]')) return
    var reference = hostsReference()
    var row = document.createElement('div')
    row.setAttribute('data-dsh-tether', 'hosts-row')
    var button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-dsh-tether', 'hosts-trigger')
    var label = inApp ? tx('我的电脑', 'My computers') : tx('连接手机', 'Connect a phone')
    button.setAttribute('aria-label', label)
    // 浏览器侧沿用原来那个 18px 图标,一字不改;抄不到「设置」时按参照行的尺寸画
    var icon = reference === null || reference.browser
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>'
      : phoneIcon(referenceIconWidth(reference.trigger))
    button.innerHTML = icon + '<span data-dsh-tether="hosts-label">' + label + '</span>'
    button.addEventListener('click', function () {
      if (inApp) window.parent.postMessage({ type: 'dsh-tether:open-hosts' }, '*')
      else showPairing()
    })
    row.append(button)
    slot.append(row)
    if (reference === null) {
      ensureFallbackStyle()
    } else {
      var labelSpan = button.querySelector('[data-dsh-tether="hosts-label"]')
      // 类名带内容哈希,照抄参照行当前的,外观自然跟随 dsh 自己的构建。侧栏收起/
      // 展开、登录状态变化时它会换类名,也会换图标尺寸,跟着同步
      var sync = function () {
        row.className = reference.row.className
        button.className = reference.trigger.className
        if (reference.browser) return
        // 参照行换形态时文字 span 会换一个节点(登录后前面多出头像),每次重挑
        var referenceLabel = referenceLabelOf(reference.trigger)
        // 侧栏收成竖条时参照行干脆不渲染文字,我们的文字也跟着收掉
        labelSpan.style.display = referenceLabel ? '' : 'none'
        if (referenceLabel) labelSpan.className = referenceLabel.className
        // 账号行的形态写在自己的 data-* 上(没登录 32px 矮一截,收起时 36×36 居中),
        // 光抄类名只拿到组件的默认形态,会比隔壁高一截。属性名按前缀抄,不写死是哪几个
        for (var i = button.attributes.length - 1; i >= 0; i--) {
          var own = button.attributes[i].name
          if (own.indexOf('data-') === 0 && own !== 'data-dsh-tether') button.removeAttribute(own)
        }
        for (var j = 0; j < reference.trigger.attributes.length; j++) {
          var attr = reference.trigger.attributes[j]
          if (attr.name.indexOf('data-') === 0 && attr.name !== 'data-dsh-tether') button.setAttribute(attr.name, attr.value)
        }
        var svg = button.querySelector('svg')
        var width = referenceIconWidth(reference.trigger)
        if (svg) { svg.setAttribute('width', width); svg.setAttribute('height', width) }
      }
      sync()
      // 浏览器侧只有类名会变,照旧只盯 class;桌面端那一行换形态是改 data-*,得全盯
      new MutationObserver(sync).observe(reference.row, reference.browser
        ? { attributes: true, attributeFilter: ['class'], subtree: true }
        : { attributes: true, subtree: true })
    }
    // dsh 的语言能在设置里当场切,这个标签跟着换
    new MutationObserver(function () {
      var next = inApp ? tx('我的电脑', 'My computers') : tx('连接手机', 'Connect a phone')
      button.setAttribute('aria-label', next)
      var span = button.querySelector('[data-dsh-tether="hosts-label"]')
      if (span) span.textContent = next
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  }
  // 两处参照都抄不到时的兜底。只保证这一行能看、能点:宽度铺满插槽、行高与 dsh 的
  // panelRow 一致,颜色圆角焦点环全取 --dsw-* 变量,不碰任何带内容哈希的类名,也不
  // 去猜隔壁此刻长什么样。抄不到就不挂按钮的话,桌面端等于没有配对入口。
  var fallbackStyleInstalled = false
  function ensureFallbackStyle() {
    if (fallbackStyleInstalled) return
    fallbackStyleInstalled = true
    var style = document.createElement('style')
    style.setAttribute('data-dsh-tether', 'fallback-style')
    style.textContent = [
      '[data-dsh-tether="hosts-row"] { box-sizing: border-box; flex: none; display: flex; align-items: center; width: 100%; }',
      '[data-dsh-tether="hosts-row"] > [data-dsh-tether="hosts-trigger"] {',
      '  -webkit-appearance: none; appearance: none; box-sizing: border-box;',
      '  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px;',
      '  height: 36px; margin: 0; padding: 6px; border: none;',
      '  border-radius: var(--dsw-radius-md); background: transparent;',
      '  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;',
      '  text-align: left; cursor: pointer; overflow: hidden;',
      '}',
      '[data-dsh-tether="hosts-row"] > [data-dsh-tether="hosts-trigger"]:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '[data-dsh-tether="hosts-row"] [data-dsh-tether="hosts-label"] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '[data-sidebar-collapsed] [data-dsh-tether="hosts-row"] > [data-dsh-tether="hosts-trigger"] { justify-content: center; gap: 0; padding: 0; }',
      '[data-sidebar-collapsed] [data-dsh-tether="hosts-label"] { display: none; }',
    ].join(' ')
    document.head.append(style)
  }

  mountHostsTrigger()
  new MutationObserver(mountHostsTrigger).observe(document.documentElement, { childList: true, subtree: true })

  document.addEventListener('click', function (event) {
    if (!narrow.matches) return
    var target = event.target
    var button = target && target.closest ? target.closest('button') : null
    if (!button || !/打开配置文件|Open config|open the config/i.test(button.textContent || '')) return
    event.preventDefault()
    event.stopPropagation()
    fetch('${CONFIG_DOCUMENT_PATH}', { headers: langHeaders() })
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t) }) })
      .then(function (d) { viewer(d.path, d.text) })
      .catch(function (e) { viewer(tx('配置文件', 'Config file'), '', String(e && e.message ? e.message : e)) })
  }, true)
})()`

/** 把那两份注入以字符串变换塞进 index.html */
function injectNarrowScreenCss(html) {
  return html.replace(
    '</head>',
    `<style data-dsh-tether="narrow-screen">${tetherCss}\n</style><script data-dsh-tether="narrow-screen">${tetherScript}\n</script></head>`,
  )
}

/**
 * sidecar 二进制的解析顺序:
 * 1. 平台子包 `dsh-tether-host-<platform>-<arch>` —— 发布路径。子包声明 os/cpu,
 *    npm 只装匹配当前平台的那一个(dsh 自己的 node-addon-landlock-run 同款结构)。
 * 2. 仓库内 cargo 产物 —— 开发路径,release 优先于 debug。
 * 返回 undefined 表示两处都没有,由调用方给出可操作的报错。
 */
function resolveHostBinary() {
  const exe = process.platform === 'win32' ? 'tether-host.exe' : 'tether-host'
  const platformPackage = `dsh-tether-host-${process.platform}-${process.arch}`
  try {
    return createRequire(import.meta.url).resolve(`${platformPackage}/bin/${exe}`)
  } catch {
    // 未安装平台子包(源码使用或该平台尚未发布),继续找本地构建
  }
  const here = dirname(fileURLToPath(import.meta.url))
  for (const profile of ['release', 'debug']) {
    const candidate = join(here, 'target', profile, exe)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export { name, inject, apply }
