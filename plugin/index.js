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
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const name = 'dsh-plugin-tether'
const inject = ['webServer', 'settings']

/** 手机侧只读查看配置文件的路由 */
const CONFIG_DOCUMENT_PATH = '/dsh-tether/config-document'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{hostBinary?: string, pair?: boolean}} [config]
 */
function apply(ctx, config = {}) {
  const binary = config.hostBinary ?? defaultHostBinary()
  if (!existsSync(binary)) {
    throw new Error(`[tether] 找不到 sidecar 二进制: ${binary}(先 cargo build -p tether-host,或在插件 config.hostBinary 指定路径)`)
  }
  // webServer.port 是真实监听端口(config 写 0 时为 OS 分配值),手机由此拿到完整界面
  const proxyTarget = `${ctx.webServer.host}:${ctx.webServer.port}`

  const args = ['host', '--proxy-target', proxyTarget]
  if (config.pair) args.push('--pair')
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  ctx.effect(() => () => { child.kill() })
  child.on('exit', (code) => {
    // sidecar 死了必须可见:手机端会静默失联,而电脑侧一切照常
    console.error(`[tether] sidecar 退出 code=${code};手机端已失联`)
  })

  const send = (msg) => { child.stdin.write(JSON.stringify(msg) + '\n') }
  let endpointId = ''

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      console.error(`[tether] 无法解析 sidecar 消息: ${line}`)
      return
    }
    switch (msg.type) {
      case 'ready':
        endpointId = msg['endpoint_id']
        console.log(`[tether] 就绪,本机设备 ID: ${endpointId}`)
        console.log(`[tether] 手机将看到 http://${proxyTarget} 的完整界面`)
        break
      case 'pairing':
        // 一行可整体粘贴到手机,省去分别输 ID 和码
        console.log(`[tether] 配对串(${Math.round(msg['expires_in_sec'] / 60)} 分钟内有效): ${endpointId}#${msg.code}`)
        break
      case 'pairing-closed':
        console.log(`[tether] 配对窗口已关闭: ${msg.reason}`)
        break
      case 'pairing-done':
        console.log(`[tether] 配对成功: ${msg.name}(${msg.peer.slice(0, 16)}…)`)
        break
      case 'peer-connected':
        console.log(`[tether] 手机已连接: ${msg.name}`)
        break
      case 'peer-path':
        console.log(msg.kind === 'direct'
          ? `[tether] 连接路径: P2P 直连(NAT 打洞成功) ${msg.remote}`
          : `[tether] 连接路径: relay 中转(打洞未成,可用但延迟略高) ${msg.remote}`)
        break
      case 'peer-disconnected':
        console.log('[tether] 手机已断开')
        break
      default:
        console.error(`[tether] 未知 sidecar 消息: ${line}`)
    }
  })

  ctx.effect(() => ctx.webServer.tapIndex(injectNarrowScreenCss))

  // 「打开配置文件」在宿主机桌面开编辑器,手机上按了毫无反应。这条路由把同一份
  // 文件的内容原样交给手机自己渲染。路径由 Host 侧的 settings.documentPath 决定,
  // 不接受客户端传路径——否则就成了任意文件读取。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_DOCUMENT_PATH,
    handler: async (_req, res) => {
      const path = await ctx.settings.prepareDocument()
      if (path === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('当前的设置存储不是本地文件,没有可查看的配置文件')
        return
      }
      let text
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`读不到配置文件 ${path}: ${String(error)}`)
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ path, text }))
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

  /* 弹窗是「左导航 + 右内容」横向排列,导航固定 188px——在 412px 的手机上
     占掉 45%,内容只剩两百出头。改成导航横排在顶、内容占满整宽。
     导航是 <nav> 标签、内容是弹窗下唯一的直接 div,都用结构选择器命中。 */
  [role="dialog"][aria-modal="true"] { display: flex !important; flex-direction: column !important; }
  [role="dialog"][aria-modal="true"] > nav {
    width: 100% !important;
    height: auto !important;
    flex: none !important;
  }
  [role="dialog"][aria-modal="true"] > nav [class*="navList"] {
    flex-direction: row !important;
    overflow-x: auto !important;
    height: auto !important;
    gap: 6px;
    scrollbar-width: none;
  }
  [role="dialog"][aria-modal="true"] > nav [class*="navList"]::-webkit-scrollbar { display: none; }
  [role="dialog"][aria-modal="true"] > nav [class*="navCell"] {
    flex: none !important;
    width: auto !important;
    white-space: nowrap;
  }
  [role="dialog"][aria-modal="true"] > div {
    width: 100% !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }
  /* 侧栏展开时主框架把网格从「56px 内容」改成「280px 内容」,对话区被压到
     140px。改成抽屉:网格保持收起时的列宽,侧栏浮到内容之上盖住一部分。
     展开态没有专门的类名,但展开才会出现拖拽把手,用它作状态信号。
     把手本身在手机上没用(没法拖),隐掉。 */
  /* 网格恒定为收起时的列宽,侧栏恒定绝对定位、只让宽度随展开态变化——
     position 不可过渡,只有始终 absolute 才能做出滑入滑出的动画。
     侧栏脱离文档流后剩下的子元素会整体上移一列(对话区掉进 56px 那列,
     反而更窄),所以显式钉住列号。 */
  [class*="_frame"] {
    grid-template-columns: 56px minmax(0, 1fr) 0px !important;
  }
  [class*="_frame"] > [class*="centerCol"] { grid-column: 2 !important; }
  [class*="_frame"] > [class*="detailsCol"] { grid-column: 3 !important; }
  [class*="_frame"] > [class*="sidebarCol"] {
    position: absolute !important;
    top: 0;
    bottom: 0;
    left: 0;
    width: 56px !important;
    z-index: 30 !important;
    transition: width 220ms ease, box-shadow 220ms ease;
  }
  /* 展开态没有专门的类名,但展开才会出现拖拽把手,用它作状态信号 */
  [class*="_frame"]:has(> [class*="_handle"]) > [class*="sidebarCol"] {
    width: min(300px, 84vw) !important;
    box-shadow: 0 10px 36px rgba(0, 0, 0, 0.24);
  }
  /* 抽屉下的内容压暗。指针不拦——收起由注入的脚本接管,拦了反而会在脚本
     未生效时把整页点死。 */
  [class*="_frame"]::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 25;
    background: rgba(0, 0, 0, 0.28);
    opacity: 0;
    pointer-events: none;
    transition: opacity 220ms ease;
  }
  [class*="_frame"]:has(> [class*="_handle"])::after { opacity: 1; }
  [class*="_frame"] > [class*="_handle"] { display: none !important; }

  /* 侧栏收起时是图标条,「主机」按钮的文字跟着藏起来,和 dsh 自己的按钮一致 */
  [data-dsh-tether="hosts-label"] { display: none; }
  [class*="_frame"]:has(> [class*="_handle"]) [data-dsh-tether="hosts-label"] { display: inline; }
  @media (prefers-reduced-motion: reduce) {
    [class*="_frame"] > [class*="sidebarCol"],
    [class*="_frame"]::after { transition: none; }
  }

  /* 触摸时安卓 WebView 会按元素的 DOM 盒子刷一块蓝色高亮,方角、盖住圆角,
     和 dsh 自己的按下态叠在一起很脏。关掉它,按下反馈交给页面自己的样式。 */
  * { -webkit-tap-highlight-color: transparent; }

  /* 竖排之后,内容区自带的头部(关闭键)会落到标签栏下方、屏幕
     正中,很别扭。钉到弹窗右上角,与标题同一行——手机弹窗关闭键就该在那儿。 */
  [role="dialog"][aria-modal="true"] { position: relative !important; }
  [role="dialog"][aria-modal="true"] > div > [class*="_header"] {
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
  const script = `
(function () {
  var narrow = window.matchMedia('(max-width: 640px)')
  document.addEventListener('pointerdown', function (event) {
    if (!narrow.matches) return
    var frame = document.querySelector('[class*="_frame"]')
    if (!frame || !frame.querySelector(':scope > [class*="_handle"]')) return
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
  function viewer(title, body, error) {
    var mask = document.createElement('div')
    mask.setAttribute('data-dsh-tether', 'config-viewer')
    mask.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--dsh-tether-bg,#fff);display:flex;flex-direction:column;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#0f1115'
    if (matchMedia('(prefers-color-scheme: dark)').matches) mask.style.background = '#151517', mask.style.color = '#f9fafb'
    var bar = document.createElement('div')
    bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(128,128,128,.28)'
    var name = document.createElement('div')
    name.style.cssText = 'flex:1;min-width:0;font-size:12px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    name.textContent = title
    var close = document.createElement('button')
    close.textContent = '关闭'
    close.style.cssText = 'flex:none;font:inherit;font-size:12px;padding:5px 12px;border-radius:14px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit'
    close.addEventListener('click', function () { mask.remove() })
    bar.append(name, close)
    var pre = document.createElement('pre')
    pre.style.cssText = 'flex:1;margin:0;padding:14px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.7 ui-monospace,Consolas,monospace'
    pre.textContent = error ? error : body
    if (error) pre.style.color = '#b42318'
    mask.append(bar, pre)
    document.body.append(mask)
  }

  // 侧栏底部的 sidebar.footer.action 插槽:官方留给第三方放自己入口的位置。
  // 这里放「主机」按钮,点了让外层的手机客户端打开它自己的主机页。
  // 只在被 iframe 套着时出现——浏览器直接开 dsh web 的人按了没有意义。
  function mountHostsTrigger() {
    if (window.parent === window) return
    var slot = document.querySelector('[data-slot="sidebar.footer.action"]')
    if (!slot || slot.querySelector('[data-dsh-tether="hosts-trigger"]')) return
    var settings = document.querySelector('[data-slot="settings.trigger"]')
    var reference = settings && settings.closest ? settings.closest('button') : null
    if (!reference) return
    var button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-dsh-tether', 'hosts-trigger')
    button.setAttribute('aria-label', '主机')
    // 类名带内容哈希,照抄隔壁「设置」按钮当前的,外观自然一致
    button.className = reference.className
    button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg><span data-dsh-tether="hosts-label">主机</span>'
    button.addEventListener('click', function () {
      window.parent.postMessage({ type: 'dsh-tether:open-hosts' }, '*')
    })
    slot.append(button)
    // 侧栏展开/收起时「设置」按钮会换类名(rail 与否),跟着同步
    new MutationObserver(function () { button.className = reference.className })
      .observe(reference, { attributes: true, attributeFilter: ['class'] })
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
    fetch('${CONFIG_DOCUMENT_PATH}')
      .then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t) }) })
      .then(function (d) { viewer(d.path, d.text) })
      .catch(function (e) { viewer('配置文件', '', String(e && e.message ? e.message : e)) })
  }, true)
})()`
  return html.replace(
    '</head>',
    `<style data-dsh-tether="narrow-screen">${css}\n</style><script data-dsh-tether="narrow-screen">${script}\n</script></head>`,
  )
}

function defaultHostBinary() {
  const here = dirname(fileURLToPath(import.meta.url))
  const exe = process.platform === 'win32' ? 'tether-host.exe' : 'tether-host'
  return join(here, '..', 'target', 'debug', exe)
}

export { name, inject, apply }
