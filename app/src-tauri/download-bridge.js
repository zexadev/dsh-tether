// 文件下载桥:在 dsh 界面所在的 iframe 里、页面自己的脚本之前跑(只注给安卓)。
//
// dsh 的每条下载路径(文件/图片右键下载、消息附件、PDF 预览里的下载键)都是
// 先把字节读到浏览器里,包成 Blob,URL.createObjectURL 出一个 blob: 地址,再造
// <a href=blob: download=名字> 调 .click()。桌面浏览器会存文件;安卓 WebView
// 把 blob: 交给 DownloadListener,而系统 DownloadManager 只认 http/https,
// 用户看到的就是点了没反应。blob: 地址只在 iframe 自己的源里能读,外层 App
// 的页面跨源读不到,所以只能在这里截。
//
// 截法:凡是带 download 属性、地址是 blob:/data:/同源 http 的 <a>,不论是
// 程序 .click() 还是用户真点,都改为在这里 fetch 成 Blob,经 postMessage 交给
// 外层 App(Blob 可跨源结构化克隆),由 App 存进系统「下载」目录。
;(function () {
  if (window.top === window) return
  if (window.__DSH_TETHER_DOWNLOAD__) return
  window.__DSH_TETHER_DOWNLOAD__ = true

  // base64 经 IPC 进 Rust,整份文件在内存里要过好几道;超过就让用户去电脑上下
  var MAX_BYTES = 50 * 1024 * 1024
  var seq = 0
  var waiters = {}
  // 还没 fetch 完的 blob: 地址;页面在 click() 后立刻 revoke 也得等这边读完
  var pending = {}
  var deferredRevoke = {}

  function tx(zh, en) { return /^zh/i.test(navigator.language || '') ? zh : en }

  function toast(text) {
    var box = document.createElement('div')
    box.setAttribute('data-dsh-tether', 'download-toast')
    box.textContent = text
    box.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:calc(24px + env(safe-area-inset-bottom, 0px))',
      'transform:translateX(-50%)', 'z-index:2147483647', 'max-width:calc(100vw - 32px)',
      'box-sizing:border-box', 'padding:10px 16px', 'border-radius:12px',
      'background:rgba(30,30,32,0.92)', 'color:#fff', 'font-size:14px', 'line-height:20px',
      'word-break:break-all', 'pointer-events:none',
    ].join(';')
    ;(document.body || document.documentElement).append(box)
    setTimeout(function () { box.remove() }, 3500)
  }

  function fileName(anchor, url) {
    var name = anchor.getAttribute('download')
    if (name) return name
    try {
      var last = new URL(url).pathname.split('/').pop()
      if (last) return decodeURIComponent(last)
    } catch (e) {}
    return 'download'
  }

  function eligible(anchor) {
    if (!anchor || typeof anchor.hasAttribute !== 'function' || !anchor.hasAttribute('download')) return false
    var url = anchor.href || ''
    if (/^(blob|data):/i.test(url)) return true
    // 同源 http(dsh 的 /api/file 之类):cookie 由电脑侧代理逐请求注入,fetch 得到
    return url.indexOf(location.origin + '/') === 0
  }

  function save(name, blob) {
    return new Promise(function (resolve, reject) {
      var id = 'dl' + (++seq)
      waiters[id] = { resolve: resolve, reject: reject }
      window.parent.postMessage({ type: 'dsh-tether:save-download', id: id, name: name, blob: blob }, '*')
      setTimeout(function () {
        var w = waiters[id]
        if (!w) return
        delete waiters[id]
        w.reject(new Error(tx('超时', 'timed out')))
      }, 120000)
    })
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.type !== 'dsh-tether:save-download-result') return
    var w = waiters[data.id]
    if (!w) return
    delete waiters[data.id]
    if (data.ok) w.resolve(data.value)
    else w.reject(new Error(data.error || 'failed'))
  })

  function take(anchor) {
    if (!eligible(anchor)) return false
    var url = anchor.href
    var name = fileName(anchor, url)
    pending[url] = (pending[url] || 0) + 1
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.blob()
      })
      .then(function (blob) {
        if (blob.size > MAX_BYTES) {
          throw new Error(tx('文件超过 50 MB,请在电脑上下载', 'the file is over 50 MB; download it on the computer'))
        }
        return save(name, blob)
      })
      .then(function (saved) {
        toast(tx('已保存到「下载」:', 'Saved to Downloads: ') + ((saved && saved.name) || name))
      })
      .catch(function (e) {
        toast(tx('下载失败:', 'Download failed: ') + (e && e.message ? e.message : String(e)))
      })
      .then(function () {
        pending[url] -= 1
        if (pending[url] > 0) return
        delete pending[url]
        if (deferredRevoke[url]) {
          delete deferredRevoke[url]
          revoke.call(URL, url)
        }
      })
    return true
  }

  var revoke = URL.revokeObjectURL
  URL.revokeObjectURL = function (url) {
    if (pending[url]) {
      deferredRevoke[url] = true
      return
    }
    return revoke.call(URL, url)
  }

  // 程序触发:dsh 造一个(往往不挂进文档的)<a> 直接 .click()
  var click = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    if (take(this)) return
    return click.apply(this, arguments)
  }

  // 用户真点:文档里的 <a download>
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented) return
    var target = event.target
    var anchor = target && target.closest ? target.closest('a[download]') : null
    if (!anchor || !take(anchor)) return
    event.preventDefault()
    event.stopPropagation()
  }, true)
})()
