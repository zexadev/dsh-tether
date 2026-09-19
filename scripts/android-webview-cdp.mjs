// 经 adb 驱动手机上 debug 包的 WebView(开着远程调试),不用解锁屏幕:
//   node scripts/android-webview-cdp.mjs pages                 列出页面
//   node scripts/android-webview-cdp.mjs eval '<js 表达式>'    在 App 页面里求值(可 await;如 startLocal())
//   node scripts/android-webview-cdp.mjs shot out.png          截 WebView 画面
// 环境变量:PKG(默认 cc.zexa.dshtether.dev)、PAGE_MATCH(默认 tauri.localhost)、TIMEOUT(毫秒)
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const ADB = process.env.ANDROID_HOME.replace(/\\/g, '/') + '/platform-tools/adb.exe'
const PKG = process.env.PKG || 'cc.zexa.dshtether.dev'
const sh = (cmd) => spawnSync(ADB, ['shell', cmd], { encoding: 'utf8' }).stdout
const [cmd, ...args] = process.argv.slice(2)
// WebView 的调试 socket 名带 pid:webview_devtools_remote_<pid>
const pid = sh(`pidof ${PKG}`).trim()
if (!pid) { console.error('App 没在跑:', PKG); process.exit(1) }
const socks = sh('cat /proc/net/unix').split('\n').filter((l) => l.includes(`webview_devtools_remote_${pid}`))
if (!socks.length) { console.error('没找到 WebView 调试 socket(不是 debug 包?)'); process.exit(1) }
spawnSync(ADB, ['forward', 'tcp:9229', `localabstract:webview_devtools_remote_${pid}`])
// 用完立即撤销端口转发,避免该未鉴权的 CDP 调试端口在脚本退出后仍暴露给本机其它进程
process.on('exit', () => spawnSync(ADB, ['forward', '--remove', 'tcp:9229']))
// CDP 只在本机 loopback 上以 HTTP 提供服务(不支持 TLS),流量不会离开本机
const cdpOrigin = ['http:', '', '127.0.0.1:9229'].join('/')
const pages = await (await fetch(`${cdpOrigin}/json`)).json()
if (cmd === 'pages') { for (const p of pages) console.log(p.type, p.url, p.title); process.exit(0) }
// App 自己的页面在 tauri 源;dsh 的 iframe 是另一个 target,按需选
const want = process.env.PAGE_MATCH || 'tauri.localhost'
const page = pages.find((p) => p.type === 'page' && p.url.includes(want)) || pages.find((p) => p.type === 'page')
if (!page) { console.error('没有页面'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0; const pending = new Map(); const logs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400))
  if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 400)) }
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable')
setTimeout(() => { console.error('watchdog 超时'); process.exit(2) }, +(process.env.TIMEOUT || 180000)).unref()
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: args.join(' '), returnByValue: true, awaitPromise: true })
  const v = r.result?.result
  if (r.result?.exceptionDetails) console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text))
  else console.log(typeof v?.value === 'object' ? JSON.stringify(v.value, null, 2) : String(v?.value ?? v?.description ?? ''))
  if (logs.length) console.log('--- console ---\n' + logs.join('\n'))
} else if (cmd === 'shot') {
  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(args[0] || 'tmp_wv.png', Buffer.from(shot.result.data, 'base64'))
  console.log('saved', args[0] || 'tmp_wv.png')
}
ws.close()
process.exit(0)
