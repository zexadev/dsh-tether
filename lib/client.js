// 客户端半边:把「连接手机」放成设置弹窗导航里的一页。
//
// 设置壳(ui-settings-general)的导航就是 `settings.section` 列表,每一项对应一个
// 页面,页面内容由注册方自己画。这一页的内容仍在宿主注入的脚本那一边——配对串、
// 已配对设备都从 Host 的路由取数——脚本把挂载函数放在 `__DSH_TETHER_MOUNT__` 上:
// 挂载时把节点交给它,卸载时跑它返回的清理函数,配对串的倒计时才不会在关掉设置
// 之后继续走。
//
// 手机 App 里这一页是一步跳转:在设置菜单点「我的电脑」就直接切回 App 自己的
// 主机列表并收起设置,因为主机管理和本地模式都在那个原生界面里。判据是 App 自己
// 挂的标记,不是 iframe 关系——dsh 桌面端的插件界面同样跑在内嵌 frame 里。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-tether',
  factory: (require) => {
    const React = require('react')

    const NS = 'dsh-tether'
    // 只注册基线语言(zh / en);其余语言由 locale 服务按回退链落到 en。
    const COPY = {
      zh: {
        nav: '连接手机',
        navApp: '我的电脑',
        notReady: '界面没有加载出来,重启 dsh 再试。',
      },
      en: {
        nav: 'Connect a phone',
        navApp: 'My computers',
        notReady: 'The interface did not load — restart dsh.',
      },
    }
    const zhUi = () => /^zh/i.test(document.documentElement.lang || '')
    let translate = null
    const tr = (key) => (typeof translate === 'function'
      ? translate(key)
      : (zhUi() ? COPY.zh[key] : COPY.en[key]))
    // App 挂的是版本号字符串,不是布尔值:按真假判,别拿 true 去等
    const inApp = () => Boolean(globalThis.__DSH_TETHER_APP__)
    const navLabel = () => (inApp() ? tr('navApp') : tr('nav'))

    // dsh 自己那套小图标的画法:16 视图框、1.3px 描边,字形落在 1.5~14.5 的方框里
    function PhoneGlyph(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        'aria-hidden': true,
      },
      React.createElement('rect', { x: 5.15, y: 2.15, width: 5.7, height: 11.7, rx: 1.6 }),
      React.createElement('path', { d: 'M7.1 11.6h1.8', strokeLinecap: 'round' }))
    }

    /** The settings page: a host node the injected script fills, or the app hand-off. */
    function TetherSettingsPage(props) {
      const host = React.useRef(null)
      const [missing, setMissing] = React.useState(false)
      // 设置壳可能重渲染这个页面;close 换成 ref 读,免得它换一次就重挂一次内容
      const close = React.useRef(props.close)
      close.current = props.close
      const app = inApp()

      React.useEffect(() => {
        if (app) {
          // 手机 App:这一页只是入口,进来就切到 App 自己的「我的电脑」并收起设置
          try {
            globalThis.parent.postMessage({ type: 'dsh-tether:open-hosts' }, '*')
          } catch (error) {
            console.warn('[dsh-tether] could not ask the app to open My computers', error)
          }
          if (typeof close.current === 'function') close.current()
          return undefined
        }
        const node = host.current
        if (node === null) return undefined
        const mount = globalThis.__DSH_TETHER_MOUNT__
        if (typeof mount !== 'function') {
          // 注入脚本没挂上(宿主 apply 失败、或旧宿主没这条注入通道):说清楚,
          // 别给一页空白
          console.warn('[dsh-tether] the injected UI is not loaded; the settings page stays empty')
          setMissing(true)
          return undefined
        }
        return mount(node)
      }, [app])

      if (app) return null
      if (missing) {
        return React.createElement('p', {
          'data-dsh-tether': 'settings-page',
          style: {
            margin: 0,
            fontSize: 14,
            lineHeight: '22px',
            color: 'var(--dsw-alias-label-tertiary)',
          },
        }, tr('notReady'))
      }
      return React.createElement('div', { ref: host, 'data-dsh-tether': 'settings-page' })
    }

    function apply(ctx) {
      // locale 是可选依赖:没有它照样能注册这一页,标签退回读 <html lang>
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale
      if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
        ctx.effect(() => locale.register(NS, { zh: COPY.zh, en: COPY.en }), 'dsh-tether: dictionaries')
        translate = locale.bind(NS)
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'tether',
        order: 40,
        label: navLabel,
      }, TetherSettingsPage))
      // 导航图标是 0.2.x 才声明的插槽;0.1.x 里这条 inject 永远不跑,设置壳退回
      // 它自己的齿轮图标,不影响入口本身。
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: 'tether',
        label: navLabel,
      }, PhoneGlyph))
    }

    return { name: 'dsh-plugin-tether', inject: ['slots'], apply }
  },
})
