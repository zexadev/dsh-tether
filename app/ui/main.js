const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

const el = (id) => document.getElementById(id)
const views = { pair: el('view-pair'), main: el('view-main') }

function showView(name) {
  for (const [k, v] of Object.entries(views)) v.classList.toggle('hidden', k !== name)
}

function setStatus(status, text) {
  const dot = el('status-dot')
  dot.className = 'dot ' + (status === 'connected' ? 'dot-on' : status === 'connecting' ? 'dot-connecting' : 'dot-off')
  el('status-text').textContent = text
}

// —— 审批卡片 ——

const cards = el('cards')

function refreshEmpty() {
  el('empty').classList.toggle('hidden', cards.children.length > 0)
}

function addCard({ id, toolName, reason }) {
  if (document.getElementById('card-' + id)) return
  const card = document.createElement('div')
  card.className = 'card'
  card.id = 'card-' + id

  const tool = document.createElement('span')
  tool.className = 'tool'
  tool.textContent = toolName || '未知操作'

  const text = document.createElement('p')
  text.className = 'reason'
  text.textContent = reason || '(无说明)'

  const actions = document.createElement('div')
  actions.className = 'actions'
  const reject = document.createElement('button')
  reject.className = 'btn btn-danger'
  reject.textContent = '拒绝'
  const approve = document.createElement('button')
  approve.className = 'btn'
  approve.textContent = '批准'
  const decide = async (allow) => {
    reject.disabled = approve.disabled = true
    try {
      await invoke('decide', { id, allow })
      removeCard(id)
    } catch (e) {
      reject.disabled = approve.disabled = false
      setStatus('disconnected', String(e))
    }
  }
  reject.addEventListener('click', () => decide(false))
  approve.addEventListener('click', () => decide(true))
  actions.append(reject, approve)

  card.append(tool, text, actions)
  cards.prepend(card)
  refreshEmpty()
}

function removeCard(id) {
  document.getElementById('card-' + id)?.remove()
  refreshEmpty()
}

// —— 连接状态 ——

let paired = false

function onState({ status, detail }) {
  if (status === 'connected') {
    paired = true
    setStatus('connected', '已连接')
    el('reconnect-row').classList.add('hidden')
    showView('main')
  } else if (status === 'connecting') {
    setStatus('connecting', '连接中…')
  } else {
    setStatus('disconnected', '未连接')
    cards.replaceChildren()
    refreshEmpty()
    if (paired) {
      el('reconnect-text').textContent = detail
      el('reconnect-row').classList.remove('hidden')
    } else {
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

// —— 启动 ——

async function boot() {
  await listen('remote:state', (e) => onState(e.payload))
  await listen('remote:approval', (e) => addCard(e.payload))
  await listen('remote:approval-cancel', (e) => removeCard(e.payload.id))
  const host = await invoke('get_host')
  if (host) {
    paired = true
    showView('main')
    refreshEmpty()
    invoke('connect').catch((e) => onState({ status: 'disconnected', detail: String(e) }))
  } else {
    showView('pair')
  }
}
boot()
