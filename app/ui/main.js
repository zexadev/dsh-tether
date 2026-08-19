const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event
const notification = window.__TAURI__.notification

const el = (id) => document.getElementById(id)
const views = { hosts: el('view-hosts'), pair: el('view-pair'), status: el('view-status') }

/** 连接已建立且 web UI 正在显示——决定「取消/返回」该退回哪里 */
let live = false
let book = { hosts: [], current: null }

function showView(name) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle('hidden', k !== name)
  el('webui').classList.add('hidden')
  setSlim(false)
  // 连接还活着时,主机页和配对页都能原路退回,不必重连
  el('hosts-back').classList.toggle('hidden', !live)
  el('pair-cancel').classList.toggle('hidden', false)
}

// 主机的完整 dsh web UI 顶上来:顶栏收窄成一条,把高度还给它
function showWebUi(url) {
  const frame = el('webui')
  if (frame.src !== url) frame.src = url
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

function setSlim(slim) {
  el('topbar').classList.toggle('slim', slim)
  el('switch-host').classList.toggle('hidden', !slim)
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
  notifyAllowed = await notification.isPermissionGranted()
  if (!notifyAllowed) notifyAllowed = (await notification.requestPermission()) === 'granted'
}

function notifyApproval({ toolName, reason }) {
  if (!notifyAllowed) return
  notification.sendNotification({
    title: `等待你批准:${toolName || '一个操作'}`,
    body: reason || '打开 DSH Remote 查看并批准',
  })
}

// —— 主机列表 ——

const shortId = (id) => id.slice(0, 8) + '…' + id.slice(-4)

function renderHosts() {
  const list = el('host-list')
  list.replaceChildren()
  for (const host of book.hosts) {
    const li = document.createElement('li')
    li.className = 'host-item'

    const main = document.createElement('button')
    main.className = 'host-pick'
    const name = document.createElement('span')
    name.className = 'host-name'
    name.textContent = host.label || shortId(host.id)
    const meta = document.createElement('span')
    meta.className = 'host-meta'
    meta.textContent = host.id === book.current ? `${shortId(host.id)} · 上次使用` : shortId(host.id)
    main.append(name, meta)
    main.addEventListener('click', () => { startConnect(host.id) })

    const del = document.createElement('button')
    del.className = 'btn btn-slim'
    del.textContent = '删除'
    del.addEventListener('click', async () => {
      try {
        book = await invoke('forget_host', { id: host.id })
        renderHosts()
      } catch (e) {
        el('hosts-error').textContent = String(e)
        el('hosts-error').classList.remove('hidden')
      }
    })

    li.append(main, del)
    list.append(li)
  }
  el('hosts-empty').classList.toggle('hidden', book.hosts.length > 0)
}

async function refreshHosts() {
  book = await invoke('list_hosts')
  renderHosts()
}

// —— 连接状态 ——

function onState({ status, detail }) {
  if (status === 'connected') {
    setStatus('connected', '已连接')
    el('reconnect-row').classList.add('hidden')
  } else if (status === 'connecting') {
    setStatus('connecting', '连接中…')
  } else {
    live = false
    setStatus('disconnected', '未连接')
    el('webui').removeAttribute('src')
    // 配对页正开着就把失败原因显示在那里,别把用户踢走
    if (!views.pair.classList.contains('hidden')) {
      const err = el('pair-error')
      err.textContent = detail
      err.classList.remove('hidden')
      el('pair-submit').disabled = false
      return
    }
    showView('status')
    el('connecting-note').classList.add('hidden')
    el('reconnect-text').textContent = detail
    el('reconnect-row').classList.remove('hidden')
  }
}

function startConnect(id) {
  el('reconnect-row').classList.add('hidden')
  el('connecting-note').classList.remove('hidden')
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
    err.textContent = '配对串不完整:需要主机 ID 和 6 位配对码'
    err.classList.remove('hidden')
    return
  }
  el('pair-submit').disabled = true
  live = false
  el('connecting-note').classList.remove('hidden')
  showView('status')
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
el('reconnect').addEventListener('click', () => { startConnect(null) })
el('open-hosts').addEventListener('click', () => { refreshHosts(); showView('hosts') })
el('switch-host').addEventListener('click', () => { refreshHosts(); showView('hosts') })

// 回前台即重连:Android 会在后台掐掉网络,回来时旧连接多半已死
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !live && book.hosts.length > 0
      && views.pair.classList.contains('hidden') && views.hosts.classList.contains('hidden')) {
    startConnect(null)
  }
})

// —— 启动 ——

async function boot() {
  await listen('remote:state', (e) => onState(e.payload))
  await listen('remote:proxy-ready', (e) => showWebUi(e.payload.url))
  await listen('remote:approval', (e) => notifyApproval(e.payload))
  await ensureNotifyPermission()
  await refreshHosts()
  if (book.hosts.length > 0) startConnect(null)
  else showView('pair')
}
boot()
