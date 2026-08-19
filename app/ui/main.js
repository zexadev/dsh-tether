const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event
const notification = window.__TAURI__.notification

const el = (id) => document.getElementById(id)
const views = { pair: el('view-pair'), main: el('view-main') }

function showView(name) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle('hidden', k !== name)
  el('webui').classList.add('hidden')
}

// 主机的完整 dsh web UI:代理就绪后 iframe 指过去,本页只留顶部状态条
function showWebUi(url) {
  const frame = el('webui')
  if (frame.src !== url) frame.src = url
  views.pair.classList.add('hidden')
  views.main.classList.add('hidden')
  frame.classList.remove('hidden')
}

function setStatus(status, text) {
  const dot = el('status-dot')
  dot.className = 'dot ' + (status === 'connected' ? 'dot-on' : status === 'connecting' ? 'dot-connecting' : 'dot-off')
  el('status-text').textContent = text
}

// —— 待审批通知 ——
// 审批本身在上面那个 web UI 里点(它就是 dsh 自己的界面)。通知只负责把
// 「agent 卡住了」这件事送到锁屏——人不看手机就不知道,这是移动端不可替代的部分。

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

// —— 连接状态 ——

let paired = false

function onState({ status, detail }) {
  if (status === 'connected') {
    paired = true
    setStatus('connected', '已连接')
    el('reconnect-row').classList.add('hidden')
  } else if (status === 'connecting') {
    setStatus('connecting', '连接中…')
  } else {
    setStatus('disconnected', '未连接')
    el('webui').removeAttribute('src')
    if (paired) {
      showView('main')
      el('reconnect-text').textContent = detail
      el('reconnect-row').classList.remove('hidden')
    } else {
      showView('pair')
      const err = el('pair-error')
      err.textContent = detail
      err.classList.remove('hidden')
      el('pair-submit').disabled = false
    }
  }
}

// —— 配对 ——

el('pair-submit').addEventListener('click', async () => {
  const err = el('pair-error')
  err.classList.add('hidden')
  let peer = el('pair-peer').value.trim()
  let code = el('pair-code').value.trim()
  // 支持「ID#配对码」组合串整体粘贴
  if (peer.includes('#')) {
    const [p, c] = peer.split('#', 2)
    peer = p.trim()
    if (!code) code = c.trim()
  }
  if (!peer || !code) {
    err.textContent = '主机 ID 与配对码都要填'
    err.classList.remove('hidden')
    return
  }
  el('pair-submit').disabled = true
  try {
    await invoke('pair', { peer, code, name: el('pair-name').value })
  } catch (e) {
    err.textContent = String(e)
    err.classList.remove('hidden')
    el('pair-submit').disabled = false
  }
})

el('reconnect').addEventListener('click', () => {
  el('reconnect-row').classList.add('hidden')
  invoke('connect').catch((e) => onState({ status: 'disconnected', detail: String(e) }))
})

// 回前台即重连:Android 会在后台掐掉网络,回来时旧连接多半已死
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && paired && el('webui').classList.contains('hidden')) {
    invoke('connect').catch(() => {})
  }
})

// —— 启动 ——

async function boot() {
  await listen('remote:state', (e) => onState(e.payload))
  await listen('remote:proxy-ready', (e) => showWebUi(e.payload.url))
  await listen('remote:approval', (e) => notifyApproval(e.payload))
  await ensureNotifyPermission()
  const host = await invoke('get_host')
  if (host) {
    paired = true
    showView('main')
    invoke('connect').catch((e) => onState({ status: 'disconnected', detail: String(e) }))
  } else {
    showView('pair')
  }
}
boot()
