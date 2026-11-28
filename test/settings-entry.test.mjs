// 设置入口:客户端半边把「连接手机」注册成设置弹窗导航里的一页,页面内容由注入
// 脚本通过 `__DSH_TETHER_MOUNT__` 挂载;侧栏底部不再挂任何东西。
// 这里在 VM 里加载真正的 lib/client.js,用假的 React/ctx 断言注册面、挂载与卸载、
// App 里的一步跳转,另加静态检查,确认 Host 侧不再往 footer 插槽挂按钮。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const HOST = new URL('../index.js', import.meta.url)
const MANIFEST = new URL('../package.json', import.meta.url)

/** 假 React:effect 由 flushEffects 统一跑,模拟 React 提交 DOM 之后再执行 effect。 */
function createReact() {
  const effects = []
  return {
    effects,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useRef(initial) {
      return { current: initial }
    },
    useState(initial) {
      return [initial, () => {}]
    },
    useEffect(fn) {
      effects.push(fn)
    },
  }
}

function flushEffects(react) {
  const cleanups = []
  for (const fn of react.effects.splice(0)) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  return cleanups
}

function loadClient(overrides = {}) {
  const registrations = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    document: { documentElement: { lang: 'en' } },
    console: { warn: () => {} },
    setTimeout: () => 0,
    ...overrides,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-plugin-tether')
  const React = createReact()
  const exp = registrations[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { exp, sandbox, React }
}

/** 跑客户端半边的 apply,收回每个插槽上的注册。 */
function applyClient(exp, { locale } = {}) {
  const entries = []
  const ctx = {
    effect(callback) {
      callback()
    },
    get(name) {
      return name === 'locale' ? locale : undefined
    },
    slots: {
      inject(key, callback) {
        assert.equal(typeof key, 'string')
        callback()
      },
      register(options, component) {
        entries.push({ key: options.name, options, component })
        return () => {}
      },
    },
  }
  if (locale !== undefined) ctx.locale = locale
  exp.apply(ctx)
  return entries
}

function sectionEntry(entries) {
  const entry = entries.find((candidate) => candidate.key === 'settings.section')
  assert.ok(entry !== undefined, 'settings.section was not registered')
  return entry
}

test('registers the settings page instead of any sidebar entry', () => {
  const { exp } = loadClient()
  const entries = applyClient(exp)
  const section = sectionEntry(entries)
  assert.equal(section.options.id, 'tether')
  assert.equal(typeof section.options.order, 'number')
  assert.equal(entries.some((entry) => entry.key === 'sidebar.footer.action'), false)
  assert.equal(entries.some((entry) => entry.key === 'sidebar.panellist.actions'), false)
})

test('the nav label follows the dsh language', () => {
  const { exp, sandbox } = loadClient()
  const section = sectionEntry(applyClient(exp))
  assert.equal(section.options.label(), 'Connect a phone')
  // 语言写在 <html lang> 上;label thunk 每次渲染都重读,设置壳切语言时会重新取
  sandbox.document.documentElement.lang = 'zh-CN'
  assert.equal(section.options.label(), '连接手机')
})

test('the icon registration matches the section id', () => {
  const { exp } = loadClient()
  const entries = applyClient(exp)
  const icon = entries.find((candidate) => candidate.key === 'settings.section.icon')
  assert.ok(icon !== undefined, 'settings.section.icon was not registered')
  assert.equal(icon.options.id, 'tether')
  const node = icon.component({ size: 16, active: false })
  assert.equal(node.type, 'svg')
  assert.equal(node.props.width, 16)
  assert.equal(node.children[0].type, 'rect')
})

test('the page hands its node to the injected mount hook and disposes on unmount', () => {
  const mounted = []
  const disposed = []
  const { exp, sandbox, React } = loadClient()
  sandbox.__DSH_TETHER_MOUNT__ = (node) => {
    mounted.push(node)
    return () => disposed.push(node)
  }
  const section = sectionEntry(applyClient(exp))
  const node = section.component({ close: () => {} })
  assert.equal(node.props['data-dsh-tether'], 'settings-page')
  assert.equal(mounted.length, 0, 'mount must wait for the committed node')
  const host = { nodeType: 1 }
  node.props.ref.current = host
  const cleanups = flushEffects(React)
  assert.deepEqual(mounted, [host])
  assert.equal(cleanups.length, 1)
  cleanups[0]()
  assert.deepEqual(disposed, [host])
})

test('a missing injected UI is reported instead of an empty page', () => {
  const warnings = []
  const { exp, React } = loadClient({ console: { warn: (...args) => warnings.push(args) } })
  const section = sectionEntry(applyClient(exp))
  const node = section.component({ close: () => {} })
  node.props.ref.current = { nodeType: 1 }
  flushEffects(React)
  assert.equal(warnings.length, 1)
})

test('inside the app the page hands off to the native hosts view', () => {
  const posted = []
  const { exp, React } = loadClient({
    __DSH_TETHER_APP__: '0.1.35', // App 挂的是版本号字符串
    parent: { postMessage: (message, origin) => posted.push([message, origin]) },
  })
  let closed = 0
  const section = sectionEntry(applyClient(exp))
  const node = section.component({ close: () => { closed += 1 } })
  assert.equal(node, null)
  flushEffects(React)
  // 跨 realm 的对象原型不同,逐字段断言
  assert.equal(posted.length, 1)
  assert.equal(posted[0][0].type, 'dsh-tether:open-hosts')
  assert.equal(posted[0][1], '*')
  assert.equal(closed, 1)
})

test('the label is translated through the client locale service when present', () => {
  const registered = []
  const locale = {
    register: (ns, dictionaries) => {
      registered.push([ns, dictionaries])
      return () => {}
    },
    bind: () => (key) => (key === 'nav' ? 'Phone' : key),
  }
  const { exp } = loadClient()
  const section = sectionEntry(applyClient(exp, { locale }))
  assert.equal(registered.length, 1)
  assert.equal(registered[0][0], 'dsh-tether')
  assert.equal(section.options.label(), 'Phone')
})

test('the host no longer mounts a footer button', () => {
  const host = readFileSync(HOST, 'utf8')
  assert.match(host, /window\.__DSH_TETHER_MOUNT__ = function \(node\)/)
  assert.doesNotMatch(host, /sidebar\.footer\.action/)
  assert.doesNotMatch(host, /mountHostsTrigger/)
  assert.doesNotMatch(host, /__DSH_TETHER_OPEN__/)
  assert.doesNotMatch(host, /__DSH_TETHER_UI__/)
})

test('the manifest ships the client half', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.ok(manifest.files.includes('lib'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.scripts.check, 'node --check index.js && node --check lib/client.js')
})
