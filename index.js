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
/** 注入脚本报「这条消息从手机还是电脑发出」,按会话决定要不要告诉 agent 用户在小屏上 */
const PROMPT_ORIGIN_PATH = '/dsh-tether/prompt-origin'

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
    // sidecar 没了,它名下的连接全断,不会再有 peer-disconnected 来抵消计数
    phoneConnections = 0
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
  /**
   * 当前连着的手机连接数;>0 即「有手机在用」,喂给 systemPrompt 的动态上下文。
   * 计数而非布尔:sidecar 每条连接各发一次 peer-connected / peer-disconnected,
   * 同一台手机重连时新连接的 connected 可能先于旧连接收尾的 disconnected 到达,
   * 两台手机同连时断开其一也不该清零。
   */
  let phoneConnections = 0
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
        phoneConnections += 1
        console.log(`[tether] ${tt('手机已连接: ', 'phone connected: ')}${msg.name}`)
        break
      case 'peer-path':
        console.log(`[tether] ${msg.kind === 'direct'
          ? tt('连接路径: P2P 直连(NAT 打洞成功) ', 'path: direct P2P (NAT hole punch succeeded) ')
          : tt('连接路径: relay 中转(打洞未成,可用但延迟略高) ', 'path: via relay (hole punch failed; works, slightly higher latency) ')}${msg.remote}`)
        break
      case 'peer-disconnected':
        phoneConnections = Math.max(0, phoneConnections - 1)
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

  // 会话 → 最后一条消息是从哪端发的('phone' | 'desktop')。dsh 服务端分不出请求
  // 来自哪个浏览器(所有已认证浏览器共用一个 peer,prompt 记录里也没有来源),只有
  // 发送端自己知道:注入脚本在发 session/prompt 之前先报到这条路由。带 App 标记的
  // 是手机,其余(电脑浏览器、dsh 桌面端)是电脑。按「最后发送者」而不是「手机用
  // 过」:同一会话在手机上聊过、回到电脑接着聊,就该恢复成电脑的写法。
  const sessionOrigins = new Map()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PROMPT_ORIGIN_PATH,
    handler: async (req, res) => {
      if (!isTrustedRequest(req) || req.method !== 'POST') return refuse(res)
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4096) return refuse(res)
        chunks.push(chunk)
      }
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = undefined
      }
      const sessionId = body?.sessionId
      if (typeof sessionId === 'string' && sessionId !== '' && sessionId.length <= 256) {
        // 删了再放:Map 按插入序,最早的就是最久没人发过消息的,超量从头淘汰
        sessionOrigins.delete(sessionId)
        sessionOrigins.set(sessionId, body.phone === true ? 'phone' : 'desktop')
        while (sessionOrigins.size > 500) sessionOrigins.delete(sessionOrigins.keys().next().value)
      }
      res.writeHead(204)
      res.end()
    },
  }))

  // 让 agent 知道用户当前在手机上:dsh 每次模型请求前都会重算注册过的运行时
  // 上下文(text 收到的 context.agent.session 就是当前会话),这里只在「手机连着、
  // 且这个会话的最后一条消息是从手机发的」时给一段「用户在小屏上」的事实,agent
  // 就会按小屏来组织回答(结论先行、段落短、少用宽表格)。同时开着的电脑会话不受
  // 影响;手机断开,或回到电脑上在这个会话里发消息,这段就消失。systemPrompt 是
  // 新版 dsh 的服务:旧版没有提供方,inject 的回调永远不触发,等于没有这段(能力
  // 判据,不做版本号判断)。
  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.systemPrompt.context({
      name: 'tether:phone-client',
      order: 300,
      required: false,
      interpolate: false,
      text: (context) => (phoneConnections > 0 && sessionOrigins.get(context?.agent?.session?.id) === 'phone'
        ? tt(
          '用户当前正通过手机上的 DSH Tether 客户端使用。输出要适合手机小屏:结论先行、段落短、避免宽表格与多列并排,不要让关键信息藏在需要横向滚动才能看到的位置。',
          'The user is currently on the phone through the DSH Tether client. Keep the output phone-friendly: lead with the answer, keep paragraphs short, avoid wide tables and side-by-side columns, and keep critical information out of anything that needs horizontal scrolling.',
        )
        : ''),
    })
  })

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
 * 设置壳(带左侧导航的那个大弹窗)的窄屏样式。选择器认结构不认类名:
 * `> nav` 里还套着 `navList` 的 modal 对话框就是设置壳;0.2.2-rc 的原生
 * 侧栏抽屉里 nav 不带 navList,不会被误伤。
 *
 * 壳本身的盒子:铺满直角是窄屏下最差的观感,收成 dsh 自己的圆角卡片(圆角用
 * 它的 --dsw-radius-panel,和桌面一致),四周留 12px 边距。
 *
 * 壳内部的版式按 DOM 结构区分,不读版本号(注入侧拿不到,也不该为这个去碰
 * 解析器):
 * - 0.2.2-rc.1 起,dsh 自带 ≤767px 的窄屏布局(标题+关闭 / 标签 / 内容 三行
 *   网格),nav 前面还有标题 div,版式本身是对的——不碰它的 display,只改盒子。
 * - 更早的版本,壳是「左导航 + 右内容」,nav 是第一个孩子。按
 *   `> nav:first-child` 这个结构特征只给旧版做竖排:标题与标签行在上、内容
 *   占满下面。头部(操作+关闭键)留在内容 div 的流内,不再钉到右上角——
 *   那会盖住标签行;留在流内就没有任何重叠。
 *
 * 其余弹窗——登录、预览版说明、确认框——本来就是 dsh 的居中圆角卡片
 * (原生 380px 宽 + 圆角),一律不碰。`data-dsh-tether` 的排除保留:配对串/
 * 配置文件查看器是插件自己的弹窗,不归这里管。
 */
const shellDialogCss = `
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]):has(> nav [class*="navList"]) {
    width: calc(100% - 24px) !important;
    max-width: none !important;
    height: calc(100% - 24px) !important;
    max-height: none !important;
    margin: 0 !important;
    border-radius: var(--dsw-radius-panel) !important;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]):has(> nav:first-child [class*="navList"]) {
    flex-direction: column !important;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]):has(> nav:first-child [class*="navList"]) > nav {
    width: 100% !important;
    height: auto !important;
    flex: none !important;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]):has(> nav:first-child [class*="navList"]) > nav [class*="navList"] {
    flex-direction: row !important;
    overflow-x: auto !important;
    height: auto !important;
    gap: 6px;
    scrollbar-width: none;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]):has(> nav:first-child [class*="navList"]) > nav [class*="navList"]::-webkit-scrollbar { display: none; }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]):has(> nav:first-child [class*="navList"]) > nav [class*="navCell"] {
    flex: none !important;
    width: auto !important;
    white-space: nowrap;
  }
  [role="dialog"][aria-modal="true"]:not([data-dsh-tether]):has(> nav:first-child [class*="navList"]) > div {
    width: 100% !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }`

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
  /* 设置行是「说明文字 + 控件」一行排开,说明列 min-width:0,窄屏被控件挤到
     2px 宽,中文于是一字一行。让说明占满一行、控件换到下一行。
     选择器咬的是 CSS Module 的本地名(row/rowText),只有哈希前缀会随构建变;
     dsh 若重命名,规则失效退回现状,不会更糟。
     必须要求带 rowText 直接子元素:光凭名字里有 row 还会命中会话里的工具调用
     行,那种行高度写死 24px 且 overflow:hidden,一换行标题就被切掉半截。 */
  [class*="_row"]:has(> [class*="rowText"]) { flex-wrap: wrap !important; }
  [class*="_row"] > [class*="rowText"] { flex: 1 1 100% !important; }

${shellDialogCss}

  /* 会话内容自适应:agent 输出的图片、表格、代码块不把页面撑过视口宽——
     宽内容在自己的盒子里横向滚动,页面本身不产生横向溢出。选择器认 dsh
     标在会话滚动容器上的 [data-conversation-scroll] 属性,只作用在会话里,
     不碰界面自己的图标和控件。 */
  [data-conversation-scroll] img,
  [data-conversation-scroll] video,
  [data-conversation-scroll] canvas { max-width: 100% !important; height: auto; }
  [data-conversation-scroll] pre,
  [data-conversation-scroll] table { max-width: 100%; }
  /* 长到没法折行的原文(路径、命令、哈希)在会话里折行,别把行撑出去 */
  [data-conversation-scroll] { overflow-wrap: break-word; }
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

  // 发消息前先报「这条从手机还是电脑发出」(按会话)。dsh 服务端分不出请求来自哪个
  // 浏览器,只有发送端自己知道;电脑端插件据此只在手机正用着的会话里告诉 agent
  // 用户在小屏上。dsh 的一元 RPC 每次调用都现取 globalThis.fetch,包在这里即可;
  // 先等上报落地(最多 1.5 秒)再发原请求,保证 agent 组装上下文时已经知道来源。
  // 上报失败或超时都照常发消息,不拦用户。
  ;(function () {
    var nativeFetch = window.fetch
    if (typeof nativeFetch !== 'function') return
    var fromApp = !!window.__DSH_TETHER_APP__
    var PROMPT_SUFFIX = 'api/session/prompt'
    function findSessionId(value, depth) {
      if (!value || typeof value !== 'object' || depth > 6) return null
      if (typeof value.sessionId === 'string' && value.sessionId) return value.sessionId
      for (var key in value) {
        var found = findSessionId(value[key], depth + 1)
        if (found) return found
      }
      return null
    }
    window.fetch = function (input, init) {
      var args = arguments
      var sessionId = null
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || ''
        var path = url.split('?')[0]
        if (path.slice(-PROMPT_SUFFIX.length) === PROMPT_SUFFIX && init && typeof init.body === 'string') {
          sessionId = findSessionId(JSON.parse(init.body), 0)
        }
      } catch (e) {}
      if (!sessionId) return nativeFetch.apply(window, args)
      var report = nativeFetch.call(window, '${PROMPT_ORIGIN_PATH}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, phone: fromApp }),
      }).catch(function () {})
      var timeout = new Promise(function (resolve) { setTimeout(resolve, 1500) })
      return Promise.race([report, timeout]).then(function () { return nativeFetch.apply(window, args) })
    }
  })()

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
  // 同一个按钮两种归宿:手机 App 里打开它自己的主机页;电脑浏览器/桌面端打开
  // 「连接手机」功能页(配对新手机、已配对设备、使用说明),好让用户换手机、
  // 加设备时有地方拿新配对码(否则只能去删 paired.json)。
  // 判据是「App 自己挂的标记」,不是「我在不在 iframe 里」:dsh 桌面端的插件界面
  // 同样跑在宿主的内嵌 frame 里,按 window.parent !== window 判会被当成手机 App,
  // 按钮变「我的电脑」、点了只往父窗口发一条消息——桌面端没有这条消息的监听者,
  // 按钮就是死的。标记拿不到一律按浏览器处理,打开功能页,至少点得动;
  // 0.1.24 及更早的 App 没有这个标记,在 App 里也会打开功能页(它自己的顶栏有
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

  // —— 「连接手机」功能页 ——
  // 侧栏按钮在浏览器/桌面端打开的是这个功能页:配对新手机、已配对设备管理、
  // 使用说明三段,不再是原来只有一个配对串的查看页。样式 token 与 viewer 同源,
  // 窄屏铺满、宽屏居中卡片,行为也一致(宽屏点遮罩关闭)。
  function showPairing() {
    var dark = matchMedia('(prefers-color-scheme: dark)').matches
    var t = dark
      ? { fg: '#f9fafb', surface: '#2c2c2e', line: 'rgba(255,255,255,.12)', muted: '#adb2b8', danger: '#f5766b', fill: '#353638' }
      : { fg: '#0f1115', surface: '#ffffff', line: 'rgba(0,0,0,.1)', muted: '#81858c', danger: '#b42318', fill: '#f5f6f7' }

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
        : 'width:min(560px,100%);max-height:min(80vh,720px);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.24)')

    // dsh 的次要按钮就是这个样子:透明底 + 1px 描边 + 14 圆角 + 12px 常规字重
    var slim = 'flex:none;font:inherit;font-size:12px;font-weight:400;padding:5px 12px;border-radius:14px;'
      + 'border:1px solid ' + t.line + ';background:transparent;color:inherit;cursor:pointer'

    var bar = document.createElement('div')
    bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ' + t.line
    var name = document.createElement('div')
    name.style.cssText = 'flex:1;min-width:0;font-size:16px;font-weight:500'
    name.textContent = tx('连接手机', 'Connect a phone')
    var close = document.createElement('button')
    close.textContent = tx('关闭', 'Close')
    close.style.cssText = slim
    close.addEventListener('click', function () { mask.remove() })
    bar.append(name, close)

    var body = document.createElement('div')
    body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:18px'

    function sectionTitle(text) {
      var head = document.createElement('div')
      head.style.cssText = 'font-size:12px;color:' + t.muted + ';padding-bottom:8px;font-weight:500'
      head.textContent = text
      return head
    }

    // —— 配对新手机 ——
    var pairBox = document.createElement('div')
    pairBox.style.cssText = 'flex:none'
    pairBox.append(sectionTitle(tx('配对新手机', 'Pair a new phone')))
    var pairRow = document.createElement('div')
    pairRow.style.cssText = 'display:flex;align-items:center;gap:8px'
    var pairCode = document.createElement('div')
    pairCode.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      + 'font:13px/1.8 ui-monospace,"SF Mono",Consolas,monospace;background:' + t.fill + ';border-radius:8px;padding:8px 12px'
    pairCode.textContent = tx('获取中…', 'Fetching…')
    var copy = document.createElement('button')
    copy.textContent = tx('复制', 'Copy')
    copy.style.cssText = slim
    copy.disabled = true
    copy.addEventListener('click', function () {
      if (!pairingValue) return
      navigator.clipboard.writeText(pairingValue).then(
        function () { copy.textContent = tx('已复制', 'Copied') },
        function () { copy.textContent = tx('复制失败', 'Copy failed') },
      )
    })
    var refresh = document.createElement('button')
    refresh.textContent = tx('重新获取', 'Refresh')
    refresh.style.cssText = slim
    refresh.addEventListener('click', fetchPairing)
    pairRow.append(pairCode, copy, refresh)
    var pairHint = document.createElement('div')
    pairHint.style.cssText = 'font-size:12px;color:' + t.muted + ';margin-top:8px'
    pairBox.append(pairRow, pairHint)

    // 配对串的获取与有效期倒计时;过期后只有「重新获取」一条路
    var pairingValue = null
    var tick = null
    var expiresAt = 0
    function fetchPairing() {
      pairingValue = null
      copy.disabled = true
      copy.textContent = tx('复制', 'Copy')
      if (tick !== null) { clearInterval(tick); tick = null }
      pairCode.textContent = tx('获取中…', 'Fetching…')
      pairHint.style.color = t.muted
      pairHint.textContent = ''
      fetch('${PAIRING_PATH}', { headers: langHeaders() })
        .then(function (r) { return r.ok ? r.json() : r.text().then(function (x) { throw new Error(x) }) })
        .then(function (d) {
          pairingValue = d.pairingString
          expiresAt = Date.now() + d.expiresInSec * 1000
          pairCode.textContent = d.pairingString
          pairCode.title = d.pairingString
          copy.disabled = false
          tick = setInterval(function () {
            var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
            if (left === 0) {
              clearInterval(tick)
              tick = null
              pairingValue = null
              copy.disabled = true
              pairHint.style.color = t.danger
              pairHint.textContent = tx('配对串已失效,点「重新获取」。', 'The pairing string expired — press "Refresh".')
              return
            }
            pairHint.textContent = tx('在手机上「添加电脑」里整行粘贴。', 'Paste the whole line into “Add a computer” on the phone.')
              + ' ' + Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2)
          }, 1000)
        })
        .catch(function (e) {
          pairHint.style.color = t.danger
          pairHint.textContent = tx('获取失败: ', 'Fetch failed: ') + (e && e.message ? e.message : e)
          pairCode.textContent = tx('获取失败', 'Fetch failed')
        })
    }
    fetchPairing()

    // —— 已配对设备 ——(与旧查看页同一份列表:名称、在线状态、两步移除)
    var devices = devicesBlock(t, slim)

    // —— 使用说明 ——
    var guide = document.createElement('div')
    guide.style.cssText = 'flex:none;border-top:1px solid ' + t.line + ';padding-top:14px'
    guide.append(sectionTitle(tx('使用说明', 'How it works')))
    var steps = [
      tx('在手机上安装 DSH Tether(github.com/zexadev/dsh-tether)。', 'Install DSH Tether on your phone (github.com/zexadev/dsh-tether).'),
      tx('App 里点「添加电脑」,把上面的配对串整行粘贴。', 'In the app, tap “Add a computer” and paste the pairing string above.'),
      tx('配对成功后,手机即可远程使用这台电脑上的 dsh;审批请求会以通知送到手机。', 'Once paired, the phone can use dsh on this computer remotely; approval requests arrive as notifications on the phone.'),
    ]
    for (var i = 0; i < steps.length; i++) {
      var step = document.createElement('div')
      step.style.cssText = 'display:flex;gap:8px;font-size:13px;line-height:1.7;margin-bottom:6px'
      var num = document.createElement('span')
      num.style.cssText = 'flex:none;width:18px;height:18px;border-radius:50%;background:' + t.fill + ';color:' + t.muted
        + ';font-size:11px;display:flex;align-items:center;justify-content:center'
      num.textContent = String(i + 1)
      var text = document.createElement('span')
      text.style.cssText = 'min-width:0'
      text.textContent = steps[i]
      step.append(num, text)
      guide.append(step)
    }

    body.append(pairBox, devices, guide)
    card.append(bar, body)
    mask.append(card)
    // 宽屏点遮罩关闭,窄屏没有遮罩可点
    if (!narrow.matches) mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove() })
    document.body.append(mask)
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
      if (inApp) openHostsPanel()
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

  // —— 连接阶段的加载文字 ——
  // 手机 App 里,连接阶段把 dsh 自己的加载文字「正在加载工作区… / Loading
  // workspaces…」改写成「正在连接至电脑」;顶层 App 连上后会发
  // dsh-tether:connected(iframe load 之后还会补发一次,覆盖「iframe 还没起来
  // connected 就到了」的时序),收到即停,之后加载文字恢复 dsh 原文。
  // 桌面浏览器与 dsh desktop 没有 App 标记,这段完全不生效。
  if (inApp) {
    var tetherConnected = false
    window.addEventListener('message', function (event) {
      var data = event.data
      if (data && data.type === 'dsh-tether:connected') tetherConnected = true
    })
    function connectingText(text) {
      if (text === '正在加载工作区…') return '正在连接至电脑'
      if (text === 'Loading workspaces…') return 'Connecting to the computer'
      return null
    }
    function rewriteLoadingNode(node) {
      if (node.nodeType === 3) {
        var next = connectingText(node.data)
        if (next !== null && node.data !== next) node.data = next
        return
      }
      // 加载状态行是「一个元素只含这一句文本」,整体替换最省事;
      // 带子元素的节点不碰,交给它自己的文本节点进到上面的分支
      if (node.nodeType === 1 && node.children.length === 0) {
        var next2 = connectingText(node.textContent)
        if (next2 !== null) node.textContent = next2
      }
    }
    new MutationObserver(function (records) {
      if (tetherConnected) return
      for (var i = 0; i < records.length; i++) {
        var record = records[i]
        if (record.type === 'characterData') rewriteLoadingNode(record.target)
        for (var j = 0; j < record.addedNodes.length; j++) rewriteLoadingNode(record.addedNodes[j])
      }
    }).observe(document.documentElement, { childList: true, characterData: true, subtree: true })
  }

  // ===== 「我的电脑」面板:长在 dsh 界面里,不再把整个界面交给 App 外壳 =====
  // 侧栏按钮/App 顶栏的「主机」在 dsh 界面内部切换「会话 / 我的电脑」两栏
  // tab,不再整页切走(割裂感就是那个整页切换)。数据与动作经 postMessage 走
  // 外层 App 的 Rust:invoke 请求带 id,结果/事件原路回;本地模式的启停与
  // 打开外链是专用消息。面板样式全部用 dsh 自己的 --dsw-* 变量,主题语言
  // 都跟 dsh 走,不另起一套。
  if (inApp) {
    var tetherInvokeSeq = 0
    var tetherInvokeWaiters = {}
    var panelData = { hosts: [], current: null, local: null, remote: null, localProgress: null, version: '' }
    var panelEl = null
    var panelPairing = false
    var panelUpdateFound = null

    var PT = {
      bg: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-2)',
      fg: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-tertiary)',
      line: 'var(--dsw-alias-border-l3)',
      fill: 'var(--dsw-alias-interactive-bg-hover)',
      danger: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    function tetherInvoke(cmd, args) {
      return new Promise(function (resolve, reject) {
        var id = ++tetherInvokeSeq
        tetherInvokeWaiters[id] = { resolve: resolve, reject: reject }
        window.parent.postMessage({ type: 'dsh-tether:invoke', id: id, cmd: cmd, args: args || {} }, '*')
        setTimeout(function () {
          var w = tetherInvokeWaiters[id]
          if (!w) return
          delete tetherInvokeWaiters[id]
          w.reject(new Error('timeout'))
        }, 15000)
      })
    }

    window.addEventListener('message', function (event) {
      var data = event.data
      if (!data) return
      if (data.type === 'dsh-tether:invoke-result') {
        var w = tetherInvokeWaiters[data.id]
        if (!w) return
        delete tetherInvokeWaiters[data.id]
        if (data.ok) w.resolve(data.value)
        else w.reject(new Error(data.error || 'invoke failed'))
      } else if (data.type === 'dsh-tether:event') {
        if (data.name === 'remote:state') panelOnRemote(data.payload)
        else if (data.name === 'local:state') panelOnLocal(data.payload)
      } else if (data.type === 'dsh-tether:open-hosts') {
        openHostsPanel()
      }
    })

    function panelOnRemote(payload) {
      panelData.remote = payload
      renderHostsPanel()
    }
    function panelOnLocal(payload) {
      panelData.localProgress = payload
      renderHostsPanel()
    }

    // 面板自带的消息:本地模式启停、外链
    function panelLocalStart() { window.parent.postMessage({ type: 'dsh-tether:local-start' }, '*') }
    function panelLocalStop() { window.parent.postMessage({ type: 'dsh-tether:local-stop' }, '*') }
    function panelOpenUrl(url) { window.parent.postMessage({ type: 'dsh-tether:open-url', url: url }, '*') }

    function panelBtn(text, primary) {
      var b = document.createElement('button')
      b.textContent = text
      b.style.cssText = 'flex:none;font:inherit;font-size:12px;font-weight:400;padding:5px 12px;border-radius:14px;cursor:pointer;color:' + PT.fg + ';'
        + (primary
          ? 'border:1px solid transparent;background:' + PT.fill
          : 'border:1px solid ' + PT.line + ';background:transparent')
      return b
    }

    function panelSection(title) {
      var box = document.createElement('div')
      box.style.cssText = 'flex:none;border-top:1px solid ' + PT.line + ';padding:14px 0'
      var head = document.createElement('div')
      head.style.cssText = 'font-size:12px;color:' + PT.muted + ';padding-bottom:8px;font-weight:500'
      head.textContent = title
      box.append(head)
      return box
    }

    function panelHostRow(host) {
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0'
      var main = document.createElement('button')
      main.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;text-align:left;font:inherit;'
        + 'color:' + PT.fg + ';background:' + PT.surface + ';border:1px solid ' + PT.line + ';border-radius:12px;padding:8px 12px;cursor:pointer'
      var nm = document.createElement('span')
      nm.style.cssText = 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      nm.textContent = host.label || shortHostId(host.id)
      var meta = document.createElement('span')
      meta.style.cssText = 'font-size:11px;color:' + PT.muted
      meta.textContent = host.id === panelData.current ? tx('上次使用', 'last used') : shortHostId(host.id)
      main.append(nm, meta)
      main.addEventListener('click', function () {
        tetherInvoke('connect', { id: host.id }).catch(function (e) { panelFail(String(e)) })
      })
      row.append(main)
      var rename = panelBtn(tx('改名', 'Rename'))
      rename.addEventListener('click', function () {
        var input = document.createElement('input')
        input.value = host.label || ''
        input.style.cssText = 'flex:1;min-width:0;font:inherit;font-size:13px;padding:8px 12px;border-radius:12px;'
          + 'border:1px solid ' + PT.line + ';background:' + PT.bg + ';color:' + PT.fg + ';outline:none'
        var save = panelBtn(tx('保存', 'Save'), true)
        var cancel = panelBtn(tx('取消', 'Cancel'))
        function done() { renderHostsPanel() }
        save.addEventListener('click', function () {
          tetherInvoke('rename_host', { id: host.id, label: input.value })
            .then(function (book) { panelData.hosts = book.hosts || []; panelData.current = book.current || null; done() })
            .catch(function (e) { panelFail(String(e)) })
        })
        cancel.addEventListener('click', done)
        row.replaceChildren(input, save, cancel)
        input.focus()
      })
      row.append(rename)
      var del = panelBtn(tx('删除', 'Remove'))
      var armed = false
      del.addEventListener('click', function () {
        if (!armed) {
          armed = true
          del.textContent = tx('确认删除?', 'Remove it?')
          del.style.color = PT.danger
          setTimeout(function () {
            if (!armed) return
            armed = false
            del.textContent = tx('删除', 'Remove')
            del.style.color = PT.fg
          }, 4000)
          return
        }
        armed = false
        del.textContent = tx('删除', 'Remove')
        del.style.color = PT.fg
        tetherInvoke('forget_host', { id: host.id })
          .then(function (book) { panelData.hosts = book.hosts || []; panelData.current = book.current || null; renderHostsPanel() })
          .catch(function (e) { panelFail(String(e)) })
      })
      row.append(del)
      return row
    }

    function panelPairForm(box) {
      var mk = function (labelText, ph) {
        var lab = document.createElement('div')
        lab.style.cssText = 'font-size:12px;color:' + PT.muted + ';margin-bottom:10px'
        lab.textContent = labelText
        var input = document.createElement('input')
        input.style.cssText = 'display:block;width:100%;margin-top:6px;font:inherit;font-size:16px;padding:10px 12px;border-radius:12px;'
          + 'border:1px solid ' + PT.line + ';background:' + PT.bg + ';color:' + PT.fg + ';outline:none;box-sizing:border-box'
        if (ph) input.placeholder = ph
        lab.append(input)
        return { lab: lab, input: input }
      }
      var peer = mk(tx('配对串', 'Pairing string'), tx('粘贴电脑上显示的那一整行', 'Paste the whole line shown on the computer'))
      var code = mk(tx('配对码(已在上面粘贴则免填)', 'Pairing code (skip if the line above has one)'), tx('6 位数字', '6 digits'))
      var label = mk(tx('给这台电脑起个名字', 'Name this computer'), '')
      var name = mk(tx('本机名称(电脑上会显示成这个)', "This phone's name (shown on the computer)"), '')
      var err = document.createElement('div')
      err.style.cssText = 'font-size:12px;color:' + PT.danger + ';margin-top:8px;display:none'
      var submit = panelBtn(tx('配对并连接', 'Pair and connect'), true)
      var cancel = panelBtn(tx('取消', 'Cancel'))
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:8px;margin-top:12px'
      row.append(submit, cancel)
      box.append(peer.lab, code.lab, label.lab, name.lab, err, row)
      cancel.addEventListener('click', function () { panelPairing = false; renderHostsPanel() })
      submit.addEventListener('click', function () {
        var v = peer.input.value.trim()
        var c = code.input.value.trim()
        if (v.indexOf('#') >= 0) {
          var parts = v.split('#', 2)
          v = parts[0].trim()
          if (!c) c = parts[1].trim()
        }
        if (!v || !c) {
          err.textContent = tx('配对串不完整:要电脑上显示的那一整行', 'Incomplete pairing string — paste the whole line shown on the computer')
          err.style.display = 'block'
          return
        }
        submit.disabled = true
        tetherInvoke('pair', { peer: v, code: c, name: name.input.value, label: label.input.value })
          .then(function () { refreshHostsPanel() })
          .catch(function (e) {
            submit.disabled = false
            err.textContent = String(e && e.message ? e.message : e)
            err.style.display = 'block'
          })
      })
    }

    function panelFail(text) {
      panelData.remote = { status: 'disconnected', detail: text }
      renderHostsPanel()
    }

    function panelLocalCard() {
      var st = panelData.local
      var box = panelSection(tx('本机运行 DSH', 'Run DSH on this phone'))
      if (!st || !st.available) {
        box.style.display = 'none'
        return box
      }
      var head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:8px'
      var title = document.createElement('div')
      title.style.cssText = 'flex:1;min-width:0;font-size:13px'
      title.textContent = tx('本机运行 DSH', 'Run DSH on this phone')
      var state = document.createElement('span')
      state.style.cssText = 'flex:none;font-size:11px;color:' + (st.running ? PT.ok : PT.muted)
      state.textContent = st.running ? tx('运行中', 'Running') : tx('未启动', 'Not running')
      head.append(title, state)
      box.append(head)
      if (st.running) {
        var note = document.createElement('div')
        note.style.cssText = 'font-size:11px;color:' + PT.muted + ';margin-top:6px;line-height:1.6'
        note.textContent = tx('连接其它电脑后它也会继续在后台运行;要停,按下面的「停止本机 DSH」。', 'It keeps running in the background after you connect to another computer; stop it with the button below.')
        box.append(note)
      }
      var progress = panelData.localProgress && panelData.localProgress.detail
      if (progress) {
        var prog = document.createElement('div')
        prog.style.cssText = 'font-size:12px;color:' + PT.muted + ';margin-top:6px'
        prog.textContent = progress
        box.append(prog)
      }
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:8px;margin-top:10px'
      var open = panelBtn(st.running ? tx('打开', 'Open') : tx('在本机运行', 'Run on this phone'), true)
      open.addEventListener('click', panelLocalStart)
      row.append(open)
      if (st.running) {
        var stop = panelBtn(tx('停止本机 DSH', 'Stop DSH on this phone'))
        stop.addEventListener('click', panelLocalStop)
        row.append(stop)
      }
      box.append(row)
      return box
    }

    function panelStatusBlock() {
      var st = panelData.remote
      var box = panelSection(tx('连接', 'Connection'))
      if (st === null) { box.style.display = 'none'; return box }
      var line = document.createElement('div')
      line.style.cssText = 'font-size:13px;line-height:1.7'
      if (st.status === 'connecting') line.textContent = tx('正在连接至电脑', 'Connecting to the computer')
      else if (st.status === 'connected') { box.style.display = 'none'; return box }
      else {
        line.textContent = st.detail || tx('连接已断开', 'Connection closed')
        line.style.color = PT.danger
        var btn = panelBtn(tx('重新连接', 'Reconnect'), true)
        btn.addEventListener('click', function () {
          tetherInvoke('connect', { id: null }).catch(function (e) { panelFail(String(e)) })
        })
        var row = document.createElement('div')
        row.style.cssText = 'margin-top:10px'
        row.append(btn)
        box.append(line, row)
        return box
      }
      box.append(line)
      return box
    }

    function panelAboutBlock() {
      var box = panelSection(tx('关于与致谢', 'About & thanks'))
      var ver = document.createElement('div')
      ver.style.cssText = 'font-size:12px;color:' + PT.muted
      ver.textContent = 'DSH Tether v' + panelData.version
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap'
      var github = panelBtn('GitHub', true)
      github.addEventListener('click', function () { panelOpenUrl('https://github.com/zexadev/dsh-tether') })
      var update = panelBtn(tx('检查更新', 'Check for updates'))
      update.addEventListener('click', function () {
        if (panelUpdateFound) { panelOpenUrl('https://github.com/zexadev/dsh-tether/releases'); return }
        update.disabled = true
        update.textContent = tx('检查中…', 'Checking…')
        fetch('https://api.github.com/repos/zexadev/dsh-tether/releases/latest')
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
          .then(function (d) {
            var latest = String(d.tag_name || '').replace(/^v/, '')
            if (panelNewer(latest, panelData.version)) {
              panelUpdateFound = latest
              update.textContent = tx('前往下载', 'Download')
              ver.textContent = 'DSH Tether v' + panelData.version + ' → v' + latest
            } else {
              update.textContent = tx('已是最新', 'Up to date')
            }
          })
          .catch(function () { update.textContent = tx('检查失败', 'Check failed') })
          .then(function () { update.disabled = false })
      })
      row.append(github, update)
      var thanks = document.createElement('div')
      thanks.style.cssText = 'font-size:11px;color:' + PT.muted + ';margin-top:10px;line-height:1.7'
      thanks.textContent = tx('DSH Tether 基于 DeepSeek Harness、iroh 与 Tauri 构建。感谢这些开源项目,也感谢每一位试用、反馈与支持的朋友。', 'DSH Tether is built on DeepSeek Harness, iroh and Tauri. Thanks to those projects, and to everyone who tried it, reported issues and helped.')
      box.append(ver, row, thanks)
      return box
    }

    function renderHostsPanel() {
      if (!panelEl || panelEl.style.display === 'none') return
      var body = panelEl.querySelector('[data-dsh-tether="panel-body"]')
      body.replaceChildren()
      var list = panelSection(tx('我的电脑', 'My computers'))
      if (panelData.hosts.length === 0) {
        var empty = document.createElement('div')
        empty.style.cssText = 'font-size:12px;color:' + PT.muted
        empty.textContent = tx('还没有配对过的电脑。', 'No computer paired yet.')
        list.append(empty)
      }
      for (var i = 0; i < panelData.hosts.length; i++) list.append(panelHostRow(panelData.hosts[i]))
      var add = document.createElement('div')
      add.style.cssText = 'margin-top:10px'
      var addBtn = panelBtn(tx('添加电脑', 'Add a computer'), true)
      addBtn.addEventListener('click', function () { panelPairing = !panelPairing; renderHostsPanel() })
      add.append(addBtn)
      list.append(add)
      body.append(panelStatusBlock())
      body.append(list)
      if (panelPairing) {
        var pairBox = panelSection(tx('添加电脑', 'Add a computer'))
        panelPairForm(pairBox)
        body.append(pairBox)
      }
      body.append(panelLocalCard())
      // 电池白名单提示:仅安卓有意义
      if (/Android/i.test(navigator.userAgent)) {
        var batt = document.createElement('div')
        batt.style.cssText = 'flex:none;font-size:11px;color:' + PT.muted + ';line-height:1.7;padding:10px 0'
        batt.textContent = tx('若退到后台后连接仍会断开(部分安卓系统会强杀后台应用),请在系统设置的电池/省电策略里把本应用设为「不限制」。', 'If the connection still drops in the background (some Android systems kill background apps aggressively), set this app to "Unrestricted" under the system battery settings.')
        body.append(batt)
      }
      body.append(panelAboutBlock())
    }

    function ensureHostsPanel() {
      if (panelEl) return
      panelEl = document.createElement('div')
      panelEl.setAttribute('data-dsh-tether', 'hosts-panel')
      panelEl.style.cssText = 'position:fixed;inset:0;z-index:2147482000;display:none;flex-direction:column;'
        + 'background:' + PT.bg + ';color:' + PT.fg + ';'
        + 'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif'

      // 头部:两栏 tab「会话 / 我的电脑」
      var bar = document.createElement('div')
      bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid ' + PT.line
      function tab(text, active, onClick) {
        var b = document.createElement('button')
        b.textContent = text
        b.style.cssText = 'font:inherit;font-size:13px;font-weight:400;padding:5px 14px;border-radius:14px;cursor:pointer;color:' + PT.fg + ';'
          + (active
            ? 'border:1px solid transparent;background:' + PT.fill
            : 'border:1px solid ' + PT.line + ';background:transparent')
        b.addEventListener('click', onClick)
        return b
      }
      var toChat = tab(tx('会话', 'Chat'), false, function () { panelEl.style.display = 'none' })
      var toHosts = tab(tx('我的电脑', 'My computers'), true, function () {})
      var hint = document.createElement('div')
      hint.style.cssText = 'flex:1;text-align:right;font-size:11px;color:' + PT.muted
      hint.textContent = tx('长在 DSH 界面里,不再整页切走', '')
      bar.append(toChat, toHosts, hint)
      panelEl.append(bar)

      var body = document.createElement('div')
      body.setAttribute('data-dsh-tether', 'panel-body')
      body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:2px 16px 24px'
      panelEl.append(body)
      document.body.append(panelEl)
    }

    function shortHostId(id) { return String(id || '').slice(0, 8) + '…' + String(id || '').slice(-4) }

    function panelNewer(a, b) {
      var pa = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(a || '').trim())
      var pb = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(b || '').trim())
      if (!pa || !pb) return false
      for (var i = 1; i <= 3; i++) {
        if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i])
      }
      return false
    }

    function refreshHostsPanel() {
      tetherInvoke('list_hosts').then(function (book) {
        panelData.hosts = book.hosts || []
        panelData.current = book.current || null
        renderHostsPanel()
      }).catch(function () {})
      tetherInvoke('local_status').then(function (st) {
        panelData.local = st
        renderHostsPanel()
      }).catch(function () {})
      tetherInvoke('app_version').then(function (v) {
        panelData.version = v
        renderHostsPanel()
      }).catch(function () {})
    }

    function openHostsPanel() {
      ensureHostsPanel()
      panelEl.style.display = 'flex'
      refreshHostsPanel()
    }

    // 面板能力声明:App 据此决定顶栏「主机」按钮走面板还是走旧的主机页
    window.parent.postMessage({ type: 'dsh-tether:panel-ready' }, '*')
  }

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
