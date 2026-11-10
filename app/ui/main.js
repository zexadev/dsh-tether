const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event
const notification = window.__TAURI__.notification

/** 项目主页;关于页的 GitHub 按钮、检查更新与下载都指到这里 */
const PROJECT_URL = 'https://github.com/zexadev/dsh-tether'
/** 最新版本查询与下载页 */
const LATEST_RELEASE_API = 'https://api.github.com/repos/zexadev/dsh-tether/releases/latest'
const RELEASES_URL = PROJECT_URL + '/releases'

const el = (id) => document.getElementById(id)
const views = { hosts: el('view-hosts'), pair: el('view-pair'), status: el('view-status'), about: el('view-about') }

/** 连接已建立且 web UI 正在显示——决定「取消/返回」该退回哪里 */
let live = false
let book = { hosts: [], current: null }
/** 本次连的是哪台;顶栏据此显示主机名,人才知道自己在操作哪台电脑 */
let connectingTo = null
/** 'remote' 连电脑 / 'local' 手机本地跑 dsh;远程状态事件只在 remote 模式下起作用 */
let mode = 'remote'
/** 本地模式代理的 URL;进程还活着时切回来不用重起 */
let localUrl = null
/** 本机 DSH 是否在跑:连远程时据此给用户一个「它不会关」的提示 */
let localRunning = false
/** 本 App 的版本号(构建时写死,启动时从 Rust 取);检查更新时与之比较 */
let appVersion = '0.0.0'
const LAST_MODE_KEY = 'dsh-tether:lastMode'
function rememberMode(m) {
  try { localStorage.setItem(LAST_MODE_KEY, m) } catch {}
}

function showView(name) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle('hidden', k !== name)
  el('webui').classList.add('hidden')
  setSlim(false)
  // 连接还活着时,主机页的「返回」原路退回会话;没连着则退回状态页(重连入口)
  el('pair-cancel').classList.toggle('hidden', false)
}

/** web UI 的来源;只认这个源发来的消息 */
let webUiOrigin = null

// 主机的完整 dsh web UI 顶上来:顶栏收窄成一条,把高度还给它
function showWebUi(url) {
  const frame = el('webui')
  webUiOrigin = new URL(url).origin
  // 每次加载都是新文档:面板能力要等新的注入脚本重新声明
  panelReady = false
  // 每次连上都重载:端口按主机派生后 URL 前后一致,而上一条连接的代理监听
  // 已随连接一起结束,旧页面里的 WebSocket 是死的,不重载就停在那儿。
  frame.src = url
  for (const v of Object.values(views)) v.classList.add('hidden')
  frame.classList.remove('hidden')
  setSlim(true)
  live = true
}

/** 回到已经连着的会话,不动连接 */
function backToLive() {
  const frame = el('webui')
  if (live && frame.getAttribute('src')) {
    for (const v of Object.values(views)) v.classList.add('hidden')
    frame.classList.remove('hidden')
    setSlim(true)
    return true
  }
  return false
}

/**
 * 告诉 web UI「连接已经建立」。dsh 界面里的注入脚本据此把连接阶段的加载文字
 * (正在加载工作区…)恢复原样。connected 事件到达时 iframe 可能还没跑完自己的
 * 脚本,所以 iframe 每次 load 都补发一次,由注入脚本自己幂等处理。
 */
function notifyConnected() {
  const frame = el('webui')
  if (!live || !webUiOrigin) return
  frame.contentWindow?.postMessage({ type: 'dsh-tether:connected' }, webUiOrigin)
}

function setSlim(slim) {
  el('topbar').classList.toggle('slim', slim)
  el('topbar-hosts').classList.toggle('hidden', !slim)
}

function setStatus(status, text) {
  el('status-dot').className = 'dot ' + (status === 'connected' ? 'dot-on' : status === 'connecting' ? 'dot-connecting' : 'dot-off')
  el('status-text').textContent = text
}

// —— 待审批通知 ——
// 审批在上面那个 web UI 里点(它就是 dsh 自己的界面)。通知只负责把
// 「agent 卡住了」送到锁屏——人不看手机就不知道,这是移动端不可替代的部分。

let notifyAllowed = false

async function ensureNotifyPermission() {
  if (notification === undefined) return
  // 走 Rust 侧插件的原生请求:JS 的 Notification.requestPermission 在 Android
  // WebView 里永远返回 granted,但系统权限其实没给——通知会被系统静默丢掉。
  // 首次进入时这行会弹出系统半屏授权框(Android 13+);13 以下恒为已授权。
  notifyAllowed = await invoke('notify_permission_state').catch(() => false)
  if (!notifyAllowed) notifyAllowed = await invoke('notify_request_permission').catch(() => false)
}

function notifyApproval({ toolName, reason }) {
  if (!notifyAllowed) return
  notification.sendNotification({
    title: t('notify.title', { tool: toolName || t('notify.someAction') }),
    body: reason || t('notify.body'),
  })
}

// —— 主机列表 ——

const shortId = (id) => id.slice(0, 8) + '…' + id.slice(-4)

/** 主机的显示名:配对时起的名字,没起就退回 ID 缩写 */
function hostName(id) {
  const host = book.hosts.find((h) => h.id === id)
  return host === undefined ? '' : (host.label || shortId(host.id))
}

/** 行内模式:'view' 浏览 / 'rename' 改名 / 'confirm' 确认删除 */
const rowMode = new Map()

function showHostsError(e) {
  const box = el('hosts-error')
  box.textContent = String(e)
  box.classList.remove('hidden')
}

async function runHostAction(promise) {
  try {
    book = await promise
    el('hosts-error').classList.add('hidden')
  } catch (e) {
    showHostsError(e)
  }
  renderHosts()
  if (live) showConnectedLabel()
}

function slimButton(text, onClick, quiet) {
  const b = document.createElement('button')
  b.className = 'btn btn-slim' + (quiet ? ' btn-slim-quiet' : '')
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

function renderHosts() {
  const list = el('host-list')
  list.replaceChildren()
  for (const host of book.hosts) {
    const mode = rowMode.get(host.id) ?? 'view'
    const li = document.createElement('li')
    li.className = 'host-item'

    if (mode === 'rename') {
      const input = document.createElement('input')
      input.className = 'host-rename'
      input.value = host.label
      input.placeholder = t('hosts.namePlaceholder')
      const save = () => {
        rowMode.delete(host.id)
        runHostAction(invoke('rename_host', { id: host.id, label: input.value }))
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
      li.append(input, slimButton(t('hosts.save'), save), slimButton(t('common.cancel'), () => {
        rowMode.delete(host.id)
        renderHosts()
      }, true))
      list.append(li)
      input.focus()
      continue
    }

    const main = document.createElement('button')
    main.className = 'host-pick'
    const name = document.createElement('span')
    name.className = 'host-name'
    name.textContent = host.label || shortId(host.id)
    const meta = document.createElement('span')
    meta.className = 'host-meta'
    meta.textContent = mode === 'confirm'
      ? t('hosts.deleteWarning')
      : (host.id === book.current ? t('hosts.lastUsed', { id: shortId(host.id) }) : shortId(host.id))
    main.append(name, meta)
    if (mode === 'view') main.addEventListener('click', () => { startConnect(host.id) })
    li.append(main)

    if (mode === 'confirm') {
      li.append(slimButton(t('hosts.confirmDelete'), () => {
        rowMode.delete(host.id)
        runHostAction(invoke('forget_host', { id: host.id }))
      }), slimButton(t('common.cancel'), () => {
        rowMode.delete(host.id)
        renderHosts()
      }, true))
    } else {
      li.append(slimButton(t('hosts.rename'), () => {
        rowMode.set(host.id, 'rename')
        renderHosts()
      }, true), slimButton(t('hosts.delete'), () => {
        rowMode.set(host.id, 'confirm')
        renderHosts()
      }, true))
    }
    list.append(li)
  }
  el('hosts-empty').classList.toggle('hidden', book.hosts.length > 0)
}

/** 顶栏的「已连接 · X」;改名后要跟着变,所以单独一处 */
function showConnectedLabel() {
  if (mode === 'local') {
    setStatus('connected', t('status.local'))
    return
  }
  const n = hostName(connectingTo)
  setStatus('connected', n ? t('status.connectedTo', { name: n }) : t('status.connected'))
}

async function refreshHosts() {
  book = await invoke('list_hosts')
  renderHosts()
  await refreshLocalCard()
  if (live) showConnectedLabel()
}

// —— 连接状态 ——

function onState({ status, detail }) {
  // 切到本地模式后远程连接可能仍在收尾,它的断开不该把本机界面撤掉
  if (mode !== 'remote') return
  // 同步给 dsh 界面里长着的主机面板(没面板/没 iframe 时消息自然没人收)
  lastRemoteState = { status, detail }
  forwardToFrame({ type: 'dsh-tether:event', name: 'remote:state', payload: lastRemoteState })
  if (status === 'connected') {
    live = true
    bgRetried = false
    showConnectedLabel()
    notifyConnected()
    // 连接是在退到后台期间建立的:立刻挂上保活服务,别让它一建立就被冻结
    if (document.visibilityState !== 'visible') startKeepAlive()
    // 刚配对完的主机还不在本地簿里,取回来补上名字
    if (hostName(connectingTo) === '') refreshHosts().catch(() => {})
    el('reconnect-row').classList.add('hidden')
  } else if (status === 'connecting') {
    const n = hostName(connectingTo)
    setStatus('connecting', n ? t('status.connectingTo', { name: n }) : t('status.connecting'))
  } else {
    live = false
    setStatus('disconnected', t('status.disconnected'))
    el('webui').removeAttribute('src')
    // 配对页正开着就把失败原因显示在那里,别把用户踢走
    if (!views.pair.classList.contains('hidden')) {
      const err = el('pair-error')
      err.textContent = detail
      err.classList.remove('hidden')
      el('pair-submit').disabled = false
      return
    }
    // 退到后台期间掉的线:保活服务还撑着进程,就地试一次重连;
    // 再失败就彻底收手(见 bgRetried),回前台再连
    if (document.visibilityState !== 'visible' && !bgRetried && book.hosts.length > 0) {
      bgRetried = true
      startConnect(null)
      return
    }
    stopKeepAlive()
    showView('status')
    el('connecting-note').classList.add('hidden')
    el('reconnect-text').textContent = detail
    el('reconnect-row').classList.remove('hidden')
  }
}

// 后台断线重试:退到后台期间连接掉了,试一次自动重连(有保活服务,进程还活着);
// 这次再失败就彻底收手,等服务收掉,回前台再连。回前台或连上时重置。
let bgRetried = false

/**
 * 退后台时挂一条保活前台服务:系统才把进程当前台进程,不进 Doze、不被缓存
 * 冻结,iroh 连接与 keepalive 才活得下来(后台久了断线就是被冻没的)。通知是
 * 低优先级静默的,只是系统要求前台服务必须有这么一条。本地模式有自己的常驻
 * 服务,不走这条。
 */
function startKeepAlive() {
  const name = hostName(connectingTo)
  invoke('keep_alive_start', {
    title: name ? t('status.connectedTo', { name }) : t('status.connected'),
    text: t('keepAlive.text'),
  }).catch(() => {})
}

function stopKeepAlive() {
  invoke('keep_alive_stop').catch(() => {})
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    if (mode === 'remote' && live) startKeepAlive()
    return
  }
  // 回前台:保活服务收掉,重试标记重置;连接还活着就接着用
  stopKeepAlive()
  bgRetried = false
  if (!views.pair.classList.contains('hidden') || !views.hosts.classList.contains('hidden')) return
  if (mode === 'local') {
    invoke('local_status').then((st) => { if (!st.running) startLocal() }).catch(() => {})
    return
  }
  if (!live && book.hosts.length > 0) startConnect(null)
})

/**
 * 连远程时,本机 DSH 还在后台跑就给个提示:通知栏的「本机 DSH 运行中」是它,
 * 不会被这次连接关掉。提示只在状态页(连接中)出现,连上后被 dsh 界面盖掉。
 */
function showLocalBgNote() {
  el('local-bg-note').classList.toggle('hidden', !localRunning)
}

function startConnect(id) {
  mode = 'remote'
  rememberMode('remote')
  el('connecting-note').textContent = t('status.connectingPc')
  connectingTo = id ?? book.current ?? (book.hosts[0]?.id ?? null)
  el('reconnect-row').classList.add('hidden')
  el('connecting-note').classList.remove('hidden')
  showLocalBgNote()
  showView('status')
  invoke('connect', { id: id ?? null }).catch((e) => onState({ status: 'disconnected', detail: String(e) }))
}

// —— 配对 ——

function openPairView() {
  el('pair-error').classList.add('hidden')
  el('pair-submit').disabled = false
  showView('pair')
}

el('pair-submit').addEventListener('click', async () => {
  const err = el('pair-error')
  err.classList.add('hidden')
  let peer = el('pair-peer').value.trim()
  let code = el('pair-code').value.trim()
  // 支持「主机ID#配对码」整行粘贴
  if (peer.includes('#')) {
    const [p, c] = peer.split('#', 2)
    peer = p.trim()
    if (!code) code = c.trim()
  }
  if (!peer || !code) {
    err.textContent = t('pair.incomplete')
    err.classList.remove('hidden')
    return
  }
  el('pair-submit').disabled = true
  live = false
  el('connecting-note').classList.remove('hidden')
  showLocalBgNote()
  showView('status')
  connectingTo = peer
  try {
    await invoke('pair', { peer, code, name: el('pair-name').value, label: el('pair-label').value })
    await refreshHosts()
  } catch (e) {
    el('pair-error').textContent = String(e)
    openPairView()
    el('pair-error').classList.remove('hidden')
  }
})

// 取消/返回:连接还活着就原路回到会话,什么都不重连
el('pair-cancel').addEventListener('click', () => {
  if (backToLive()) return
  showView('hosts')
})
el('hosts-back').addEventListener('click', () => {
  if (backToLive()) return
  showView('status')
})
el('add-host').addEventListener('click', openPairView)
el('reconnect').addEventListener('click', () => { if (mode === 'local') startLocal(); else startConnect(null) })
el('topbar-hosts').addEventListener('click', () => {
  // 新插件的主机页长在 dsh 界面里,顶栏按钮直接叫面板出来;
  // 旧插件没面板,退回 App 自己的主机页
  if (live && panelReady) forwardToFrame({ type: 'dsh-tether:open-hosts' })
  else { refreshHosts(); showView('hosts') }
})

// —— 关于与致谢页 ——
// 版本号、检查更新、GitHub 入口。外链一律走 opener 插件由系统浏览器打开:
// WebView 就地导航会把 App 界面顶掉且退不回来。

/** 发现过的新版本;再点一次「前往下载」就打开 Releases 页 */
let foundVersion = null

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** a 是否比 b 新;解析不了就按不新处理 */
function isNewer(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i]
  return false
}

function openExternal(url) {
  invoke('plugin:opener|open_url', { url }).catch(() => {})
}

async function checkUpdate() {
  const btn = el('about-update')
  const status = el('update-status')
  btn.disabled = true
  status.classList.remove('hidden')
  status.textContent = t('update.checking')
  try {
    const res = await fetch(LATEST_RELEASE_API)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const latest = String(data.tag_name || '').replace(/^v/, '')
    if (isNewer(latest, appVersion)) {
      foundVersion = latest
      status.textContent = t('update.available', { version: 'v' + latest })
      btn.textContent = t('update.download')
    } else {
      status.textContent = t('update.latest')
      btn.textContent = t('update.check')
    }
  } catch {
    status.textContent = t('update.failed')
    btn.textContent = t('update.check')
  } finally {
    btn.disabled = false
  }
}

el('open-about').addEventListener('click', () => showView('about'))
// 页脚版本号也能点进关于页,多个入口
el('about-version').addEventListener('click', () => showView('about'))
el('about-back').addEventListener('click', () => showView('hosts'))
el('about-github').addEventListener('click', () => openExternal(PROJECT_URL))
el('about-update').addEventListener('click', () => {
  if (foundVersion) openExternal(RELEASES_URL)
  else checkUpdate()
})
el('local-open').addEventListener('click', () => { startLocal() })
el('local-stop').addEventListener('click', () => { stopLocal() })
el('open-hosts').addEventListener('click', () => { refreshHosts(); showView('hosts') })

// 主机页的入口在 dsh 侧栏底部(插件往 sidebar.footer.action 插槽挂的按钮),
// 那个按钮在 iframe 里、跨源,只能经 postMessage 过来;只认 web UI 那个源。
// 新版插件把主机页做进了 dsh 界面内部(「会话 / 我的电脑」两栏 tab),数据经
// 下面的 invoke 桥走 Rust;旧版插件仍发 open-hosts,退回 App 自己的主机页。
let panelReady = false
let lastRemoteState = { status: 'disconnected', detail: '' }

function forwardToFrame(msg) {
  const frame = el('webui')
  if (webUiOrigin === null) return
  frame.contentWindow?.postMessage(msg, webUiOrigin)
}

window.addEventListener('message', (e) => {
  if (webUiOrigin === null || e.origin !== webUiOrigin) return
  const d = e.data
  if (d?.type === 'dsh-tether:invoke') {
    const frame = el('webui')
    invoke(d.cmd, d.args ?? {}).then(
      (value) => frame.contentWindow?.postMessage({ type: 'dsh-tether:invoke-result', id: d.id, ok: true, value }, webUiOrigin),
      (error) => frame.contentWindow?.postMessage({ type: 'dsh-tether:invoke-result', id: d.id, ok: false, error: String(error) }, webUiOrigin),
    )
    return
  }
  if (d?.type === 'dsh-tether:panel-ready') {
    // 面板刚挂上,把当前连接状态补给它(它可能错过了前面的 remote:state)
    panelReady = true
    forwardToFrame({ type: 'dsh-tether:event', name: 'remote:state', payload: lastRemoteState })
    return
  }
  if (d?.type === 'dsh-tether:local-start') { startLocal(); return }
  if (d?.type === 'dsh-tether:local-stop') { stopLocal(); return }
  if (d?.type === 'dsh-tether:open-url') {
    invoke('plugin:opener|open_url', { url: d.url }).catch(() => {})
    return
  }
  if (d?.type !== 'dsh-tether:open-hosts') return
  refreshHosts()
  showView('hosts')
})

// 回前台即重连:Android 会在后台掐掉网络,回来时旧连接多半已死。
// 本地模式则看 node 进程还在不在,被系统杀了就重起(会话已落盘,不丢)。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (!views.pair.classList.contains('hidden') || !views.hosts.classList.contains('hidden')) return
  if (mode === 'local') {
    invoke('local_status').then((st) => { if (!st.running) startLocal() }).catch(() => {})
    return
  }
  if (!live && book.hosts.length > 0) startConnect(null)
})

// —— 本地模式 ——

/** 主机页顶部的「本机」卡片:这个构建有运行时才显示;在跑就给「打开 / 停止」 */
async function refreshLocalCard() {
  let st
  try { st = await invoke('local_status') } catch { st = { available: false, running: false, url: null } }
  localRunning = st.running
  const card = el('local-card')
  card.classList.toggle('hidden', !st.available)
  if (!st.available) return
  el('local-state').textContent = t(st.running ? 'local.running' : 'local.idle')
  el('local-open').textContent = t(st.running ? 'local.open' : 'local.start')
  el('local-stop').classList.toggle('hidden', !st.running)
  // 在跑时说明它「连远程也不会停」,免得通知栏那条常驻通知让人摸不着头脑
  el('local-card-note').classList.toggle('hidden', !st.running)
  if (st.running) localUrl = st.url
}

function onLocalState({ status, detail }) {
  if (mode !== 'local') return
  // 解压与启动的进度都打在状态页那行字上
  el('connecting-note').textContent = detail
  // 同步给 dsh 界面里长着的主机面板(本地卡片的进度行)
  forwardToFrame({ type: 'dsh-tether:event', name: 'local:state', payload: { status, detail } })
}

async function startLocal() {
  mode = 'local'
  rememberMode('local')
  connectingTo = null
  el('local-error').classList.add('hidden')
  el('reconnect-row').classList.add('hidden')
  el('connecting-note').textContent = t('local.starting')
  el('connecting-note').classList.remove('hidden')
  showView('status')
  try {
    localUrl = await invoke('local_start')
    localRunning = true
  } catch (e) {
    live = false
    el('webui').removeAttribute('src')
    el('connecting-note').classList.add('hidden')
    el('reconnect-text').textContent = String(e)
    el('reconnect').textContent = t('status.retry')
    el('reconnect-row').classList.remove('hidden')
    return
  }
  el('reconnect').textContent = t('status.reconnect')
  showWebUi(localUrl)
  setStatus('connected', t('status.local'))
}

async function stopLocal() {
  try { await invoke('local_stop') } catch {}
  // 界面正显示着本机就一并撤掉;显示的是远程的话不动它
  if (mode === 'local') {
    live = false
    el('webui').removeAttribute('src')
    setStatus('disconnected', t('status.disconnected'))
    mode = 'remote'
  }
  localUrl = null
  localRunning = false
  await refreshLocalCard()
  showView('hosts')
}

// —— 启动 ——

async function boot() {
  // Rust 侧的报错也会显示在界面上,先把语言告诉它再做别的
  await invoke('set_lang', { tag: navigator.language || '' }).catch(() => {})
  await listen('remote:state', (e) => onState(e.payload))
  await listen('remote:proxy-ready', (e) => showWebUi(e.payload.url))
  await listen('remote:approval', (e) => notifyApproval(e.payload))
  await listen('local:state', (e) => onLocalState(e.payload))
  // 见 notifyConnected:connected 可能先于 iframe 脚本就位,load 时补发
  el('webui').addEventListener('load', notifyConnected)
  await ensureNotifyPermission()
  invoke('app_version')
    .then((v) => {
      appVersion = v
      el('about-version').textContent = `DSH Tether v${v}`
      el('about-version-line').textContent = `DSH Tether v${v}`
    })
    .catch(() => {})
  await refreshHosts()
  // 电池白名单提示只在安卓有意义:保活前台服务是安卓机制,iOS 没有可设的项
  if (/Android/i.test(navigator.userAgent)) el('battery-hint').classList.remove('hidden')
  let lastMode = null
  try { lastMode = localStorage.getItem(LAST_MODE_KEY) } catch {}
  const localAvailable = !el('local-card').classList.contains('hidden')
  if (lastMode === 'local' && localAvailable) startLocal()
  else if (book.hosts.length > 0) startConnect(null)
  else if (localAvailable) showView('hosts')
  else showView('pair')
}
boot()
