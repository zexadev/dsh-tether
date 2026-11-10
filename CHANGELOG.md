# 更新日志

本文件记录面向用户的变化。每个版本的这一节会原样作为该版本 Release 的说明。

## 0.1.29

### 修复

- **键盘弹出时输入框还是留在键盘底下**。0.1.28 给 MainActivity 加了 `windowSoftInputMode=adjustResize`,但 App 在所有系统版本上都开了「边到边」布局(`enableEdgeToEdge()`),这种布局下 adjustResize 不再压缩窗口(Android 11 起如此,Android 15 起更是强制边到边),键盘直接盖住 WebView。现在插件把键盘高度转成内容区底部留白,WebView 随之变矮,输入框跟着键盘上移;不分系统版本。

- **手机上点文件/附件/图片的「下载」没有任何反应**。dsh 的下载全部是浏览器内存里的 `blob:` 地址,安卓 WebView 不会保存这种下载,系统下载器也只认 http/https。现在 App 在 dsh 界面里截下这类下载,把文件交给 App 存进手机的「下载」目录:页面底部提示「已保存到「下载」」,通知栏有完成通知,点开即用系统应用打开。Android 10 及以上不需要任何存储权限;Android 7–9 存在 App 专属的下载目录里,系统「下载」应用里可见,卸载 App 时会一并删除。单个文件上限 50 MB,更大的请在电脑上下载。这个修复在 App 里,不依赖电脑端插件版本,本地模式同样生效。

- **手机连接状态在重连时会误判为已断开**。电脑端插件原来用一个开关记「有没有手机连着」,同一台手机重连时旧连接收尾晚到,会把刚连上的状态清掉;两台手机同时连着断开一台也会清掉。现在按连接计数。

### 新增

- **「熄屏时保持连接」开关(仅安卓)**。保活前台服务只能防止 App 被系统杀掉或冻结,挡不住熄屏后手机 CPU 进入深度休眠——休眠久了连接心跳发不出去,连接照样会断。主机页新增这个开关,打开后连着电脑退到后台时会让 CPU 保持运行(屏幕照常关闭),熄屏很久也不断线;会更耗电,默认关闭,下次退到后台时生效。

- **agent 知道你在用手机**。在手机上发消息的会话里,电脑端插件经 dsh 的运行时上下文告诉 agent「用户正在手机上使用」,agent 会按小屏组织回答:结论先行、段落短、避免宽表格与多列并排。只作用于最后一条消息从手机发出的会话:手机连着时电脑上同时开着的会话不受影响,回到电脑在同一会话里发消息就恢复原来的写法;手机断开后这段消失。没有该能力的旧版 dsh 自动跳过。

### English

The composer still stayed under the keyboard. 0.1.28 set `windowSoftInputMode=adjustResize`, but the app enables edge-to-edge layout (`enableEdgeToEdge()`) on every Android version, and under edge-to-edge adjustResize no longer shrinks the window (from Android 11, and edge-to-edge is enforced from Android 15), so the keyboard simply covered the WebView. The plugin now turns the keyboard height into bottom padding on the content view, so the WebView shrinks and the composer rises with the keyboard, on every Android version.

Tapping "Download" on a file, attachment or image did nothing on the phone. Every dsh download is an in-memory `blob:` URL, which the Android WebView does not save and the system download manager cannot fetch (it only takes http/https). The app now intercepts these downloads inside the dsh page and saves the file to the phone's Downloads folder, with an in-page "Saved to Downloads" note and a completion notification that opens the file in the system app. Android 10+ needs no storage permission; on Android 7–9 files go to the app's own download folder, visible in the system Downloads app and removed when the app is uninstalled. Files are capped at 50 MB; download larger ones on the computer. The fix lives in the app, so it works with any desktop plugin version and in local mode.

The desktop plugin could think the phone had disconnected when it reconnected. It tracked "is a phone connected" as a single flag, so a late teardown of the old connection cleared the state of the new one, and with two phones connected, disconnecting one cleared it too. It now counts connections.

New "Stay connected with the screen off" switch (Android only). The keep-alive foreground service stops the system from killing or freezing the app, but not from putting the CPU into deep sleep once the screen is off; after a while the connection's heartbeats stop and it drops anyway. With the switch on, the CPU keeps running (the screen still turns off) while the app is in the background and connected, so long screen-off periods no longer drop the connection. It uses more battery, is off by default, and takes effect the next time the app goes to the background.

The agent now knows you are on the phone. In sessions where you send messages from the phone, the desktop plugin tells the agent through dsh's runtime context that the user is on a phone, and the agent shapes its answers for a small screen: the answer first, short paragraphs, no wide tables or side-by-side columns. It applies only to sessions whose latest message came from the phone: sessions open on the computer at the same time are unaffected, sending a message from the computer in the same session switches back, and the note disappears when the phone disconnects. Older dsh builds without this capability skip it.

## 0.1.28

### 修复

- **手机上的弹窗全是直角方块,文字还互相重叠**。0.1.0 起注入的窄屏样式把所有 `[role=dialog]` 一律改铺满全屏并压成直角(`border-radius:0`),那段规则本来只服务旧版 dsh 的「设置」大弹窗(800px 宽 + 188px 固定左导航,手机上放不下),却被后来的每个弹窗继承:登录、预览版说明、确认框本来是 dsh 自己的居中圆角卡片(380px 宽、28px 圆角),全被压成直角满屏;旧版设置壳的头部还被绝对定位钉到右上角,盖在内容文字上。现在弹窗样式只认「设置壳」本身(带左侧导航、`nav` 里套着 `navList` 的 modal 对话框),别的弹窗一律不碰,恢复 dsh 原生的圆角卡片;设置壳统一收成 dsh 自己的圆角卡片(`--dsw-radius-panel`,与桌面一致),四周留 12px 边距。0.2.2-rc.1 起 dsh 自带 ≤767px 的窄屏布局(标题+关闭 / 标签 / 内容 三行网格),这版式本来就是对的,不再去改它的 display——旧版壳按「nav 是第一个孩子」这个结构特征做竖排(标签横排在上、内容占满下面),头部回到流内,不再钉右上角。0.2.2-rc 的原生侧栏抽屉也是 `[role=dialog]`,但它 nav 里没有 `navList`,上面的规则不会误伤它——此前它被「直接 div 全部 flex:1」那条撑歪过。412×915 实量:预览版说明、登录弹窗回到原生 28px 圆角居中卡片,设置壳 388×891 圆角卡片、标题与关闭键同行不重叠、标签横排可滚动、各设置页内容全部收在视口内。

- **会话内容在手机上会把页面撑宽**。agent 输出的宽表格、长代码块、大图都可能比手机宽;现在针对会话滚动容器(`[data-conversation-scroll]`,dsh 自己标的属性)加了自适应兜底:图片/视频/画布收进视口宽,表格与代码块封顶 100%、在自己盒子里横向滚动,长到没法折行的原文(路径、命令、哈希)按词折行。界面自己的图标、控件不受影响。

- **手机上输入法弹出时,dsh 的输入框不上移,键盘把输入框盖住**。App 的 Android 清单没写 `windowSoftInputMode`,系统按默认策略处理;而 dsh 的输入框是 iframe 里的 contenteditable,系统的「自动平移」逻辑根本找不到它,键盘就直接盖上去。现在给 MainActivity 显式设 `adjustResize`:键盘弹出时 WebView 视口收缩,dsh 界面跟着上移,输入框保持在键盘上方。

- **App 退到后台时间久了,与电脑的连接就会断**。Android 会把后台进程缓存冻结(Doze),iroh 连接没有前台身份就活不下来。现在远程连接建立后,App 退到后台时自动挂一条保活前台服务(低优先级静默常驻通知,写明连着哪台电脑),系统就不冻进程、不断网;回到前台即撤掉。若后台期间连接仍掉了(电脑休眠、网络切换等),就地自动重连一次,再失败就收手,回前台照旧重连。本地模式已有自己的常驻服务,不受影响。

- **连上远程电脑后,常驻通知「本机 DSH 运行中」让人以为手机还连在本机**。本机 DSH 不会因连远程而关闭——这是有意保留的（切回本机免重启），但之前界面上没说明。现在主机页的本机卡片在运行时会写明「连接其它电脑后它也会继续在后台运行」，连接其它电脑时状态页也会提示「本机 DSH 仍在后台运行，连接电脑不会停掉它」；想停随时回主机页按「停止本机 DSH」。

- **安卓上一打开 App 就崩溃(点「连接」即退)**。iroh 1.0 引入的 reqwest 0.13 以 `rustls-no-provider` 构建,而 App 从没安装过 rustls 全局 crypto provider:自动重连第一次建 iroh 端点时,reqwest 建第一个 HTTP 客户端就直接 panic("No rustls crypto provider is configured"),进程 SIGABRT——0.1.27 的 APK 在 Android 16 真机上实测必现。现在 App 启动时安装 ring provider(与 iroh 默认 tls-ring 同一后端,零额外链接成本),真机配对、连接、代理浏览全部跑通。

- **安卓上首次使用不弹通知授权,通知被系统静默丢弃**。App 原来用 JS 的 `Notification.requestPermission()` 请求权限,而 Android WebView 里这个 API 永远返回 granted——系统权限其实没给,所有通知被系统按「禁止通知」静默丢掉,用户还得自己去设置里开。现在改走插件 Kotlin 侧的原生请求:Android 13+ 首次进入即弹系统半屏授权框(「允许 DSH Tether 发送通知?」),13 以下无此权限、恒为已授权。真机验证:清数据后首启必弹框,点「始终允许」后 POST_NOTIFICATIONS 正常授予。

### 变更

- **连接电脑时用 dsh 自己的加载界面,不再放 App 自制的加载页**。原来连接时手机显示 App 自己的「正在打开电脑上的 DeepSeek Harness…」;现在连接阶段的文字就是「正在连接至电脑」,并且 dsh 界面里的加载文字「正在加载工作区…」在连接阶段也改写成「正在连接至电脑」(英文对应 `Connecting to the computer`)。App 连上后向 web UI 发一条 `dsh-tether:connected`,注入脚本收到即停,之后的加载文字恢复 dsh 原文;桌面浏览器和 dsh 桌面端没有 App 标记,这段完全不生效。

- **侧栏「连接手机」按钮在电脑端打开的不再是单页配对串查看页,而是完整的功能页**。三段:配对新手机(配对串 + 复制 + 有效期倒计时 + 重新获取)、已配对设备(名称、在线状态、两步确认移除,与原来一致)、使用说明(安装 App → 粘贴配对串 → 远程使用)。窄屏铺满、宽屏居中卡片,与原来同套视觉。手机 App 里这个按钮仍打开 App 自己的主机页,不变。

- **主机页新增电池白名单提示(仅安卓)**。部分国产系统会强杀后台应用,保活前台服务也扛不住;现在主机页上写明「若退到后台后连接仍会断开,请在系统设置的电池/省电策略里把本应用设为不限制」,让用户自己动手,不做自动申请豁免的弹窗。

- **手机 App 增加「关于与致谢」页与检查更新**。主机页的「返回」按钮此前只有连接还活着时才显示,断开后打开主机页只能点设备重连,现在任何时候都在(没连着时退回状态页/重连入口)。页脚版本号与「关于与致谢」进入新页面:明显的 GitHub 按钮、检查更新(对照 GitHub 最新 Release,有新版本时按钮变「前往下载」并提示版本号)、致谢。外链一律交给系统浏览器打开,不占用 App 界面。

- **手机上的「我的电脑」长进了 dsh 界面里,不再整页切走**。此前点侧栏按钮会把整个界面交给 App 外壳,割裂感强;现在注入脚本在 dsh 界面内部做「会话 / 我的电脑」两栏 tab:主机列表(连接/改名/两步删除)、配对表单、本机卡片、连接状态与重连、关于与致谢,全部用 dsh 自己的主题变量渲染,主题语言都跟 dsh 走。数据与动作经 postMessage 桥走 App 的 Rust(带 15 秒超时),连接/本机状态事件由 App 实时转发进面板;顶栏「主机」按钮按能力路由——新插件开面板,旧插件仍回退 App 自己的主机页。

- **保活通知升级成 Android 16 的「Live Update」胶囊(安卓版灵动岛)**。退到后台时那条保活常驻通知现在带系统计时(chronometer,从连接时刻起自己走秒)和 Android 16 的 `ProgressStyle`(不定进度)——在 Android 16 的状态栏显示成实时胶囊,锁屏与常显屏同样渲染;点开通知栏则是计时的钟。Android 15 及以下仍是普通常驻通知,不受影响。真机(Xiaomi 23113RKC6C / Android 16)验证:dumpsys 确认 `ProgressStyle` + `showChronometer` 已挂上。

### English

Dialogs on the phone were all square-cornered blocks with text overlapping. Since 0.1.0 the injected narrow-screen styles forced every `[role=dialog]` full-screen with `border-radius:0` — that rule only ever existed for the old dsh settings shell (800px wide with a fixed 188px left nav, unusable on a phone), but every dialog that came later inherited it: sign-in, the preview notice and confirmations are natively centred rounded cards (380px wide, 28px radius) and were all flattened into square full-screen blocks, and on the old shell the header was additionally pinned absolute to the top-right corner, covering the content text. The dialog rules now only match the settings shell itself (the modal whose `nav` contains a `navList`); every other dialog is left alone and keeps dsh's native rounded card, and the shell becomes dsh's own rounded card (`--dsw-radius-panel`, matching the desktop) with 12px margins. Since 0.2.2-rc.1 dsh ships its own ≤767px layout for the shell (title+close / tabs / content in three grid rows), which is already correct, its display is no longer touched — older shells are detected by the structural fact that their `nav` is the first child, reflowed to tabs-on-top with content below, and their header stays in flow instead of being pinned over the tabs. The native drawer in 0.2.2-rc is also a `[role=dialog]`, but its nav has no `navList`, so these rules never touch it — previously the blanket "every direct div is flex:1" rule had distorted it. Measured at 412×915: the preview notice and sign-in dialog are back to native 28px rounded centred cards, the settings shell is a 388×891 rounded card with the title and close button on one row without overlap, horizontally scrollable tabs, and every settings page fits inside the viewport.

Conversation content could push the page wider than the phone: wide tables, long code blocks and large images from agent output. The conversation scroller (`[data-conversation-scroll]`, an attribute dsh itself sets) now gets adaptive fallbacks: images/videos/canvases are capped to the viewport width, tables and code blocks are capped at 100% and scroll inside their own boxes, and unbreakable prose (paths, commands, hashes) wraps at word boundaries. Chrome icons and controls are untouched.

On a phone the dsh composer stopped rising when the keyboard opened, so the keyboard covered it. The app's Android manifest did not set `windowSoftInputMode`, leaving the system's default policy in charge, and since the dsh composer is a contenteditable inside an iframe the system's auto-pan logic cannot find it — the keyboard just covered it. The MainActivity now sets `adjustResize` explicitly: the WebView viewport shrinks while the keyboard is up, the dsh interface follows, and the composer stays above the keyboard.

The connection to the computer dropped after the app sat in the background for a while. Android freezes cached background processes (Doze), and the iroh connection has no chance without a foreground identity. Once a remote connection is established, going to the background now starts a keep-alive foreground service — a silent, low-importance ongoing notification naming the connected computer — so the system neither freezes the process nor cuts its network; it is removed again on returning to the foreground. If the connection still drops while backgrounded (the computer slept, the network switched, …), the app retries once on the spot, gives up if that fails too, and reconnects as usual when brought back to the foreground. Local mode keeps its own existing service, unaffected.

After connecting to a remote computer, the ongoing "DSH running on this phone" notification made it look like the phone was still on the local instance. The local DSH does not stop when you connect elsewhere — that is deliberate (switching back needs no restart), but the interface never said so. The hosts page's local card now explains, while running, that it keeps running in the background after you connect to another computer, and the status page adds "the DSH on this phone keeps running in the background — connecting to a computer does not stop it" while connecting. Stop it anytime from the hosts page.

On Android the app crashed the moment it connected. iroh 1.0 pulls in reqwest 0.13 built with `rustls-no-provider`, and the app never installed a global rustls crypto provider: on the first automatic reconnect the endpoint setup builds its first plain reqwest client and panics ("No rustls crypto provider is configured"), aborting the process — reproduced on a real Android 16 device with the 0.1.27 APK. The app now installs the ring provider at startup (the same backend as iroh's default tls-ring, so nothing extra is linked); pairing, connecting and browsing through the proxy all verified on the device.

On Android the first run never asked for notification permission, and every notification was silently dropped. The app used JS `Notification.requestPermission()`, which in the Android WebView always reports "granted" while the real system permission was never given, so all notifications were discarded as if notifications were disabled — and the user had to go find the setting themselves. The app now requests through the plugin's native Kotlin path: on Android 13+ the first launch shows the system half-screen dialog ("Allow DSH Tether to send notifications?"); below 13 there is no such permission and it is always granted. Verified on a real device: after clearing app data, the first launch shows the dialog, and tapping "Always allow" grants POST_NOTIFICATIONS.

Connecting to a computer now uses dsh's own loading interface instead of the app's home-made loading page. The app's connecting text used to read "Opening the DeepSeek Harness on your computer…"; it now reads "正在连接至电脑" ("Connecting to the computer"), and while the connection is being established the injected script rewrites dsh's own loading text "正在加载工作区…" / "Loading workspaces…" to the same. Once connected, the app posts `dsh-tether:connected` to the web UI and the script stops rewriting, so later loading text is dsh's original again. Desktop browsers and the dsh desktop app carry no app marker, so this never runs there.

The sidebar's "Connect a phone" button no longer opens the single-purpose pairing-string viewer on the computer; it now opens a full feature page with three sections: pair a new phone (pairing string with copy, a live validity countdown and a refresh button), paired devices (name, online status, two-step removal — as before), and a short how-to (install the app → paste the pairing string → use dsh remotely). It fills the screen when narrow and is a centred card when wide, in the same visual language as before. Inside the phone app the same button still opens the app's own machines page, unchanged.

The hosts page gains a battery-whitelist note (Android only). Some OEM systems kill background apps aggressively enough that even the keep-alive foreground service cannot help; the hosts page now says "if the connection still drops in the background, set this app to Unrestricted under the system battery settings", leaving that one tap to the user instead of popping an automatic exemption request.

The phone app gains an "About & thanks" page and an update check. The hosts page's "Back" button used to appear only while a session was live, so after a disconnect the hosts page had no way out except tapping a device to reconnect — it is now always present (leading back to the status page and its reconnect entry when nothing is live). The footer version and an "About & thanks" entry open a new page with a prominent GitHub button, an update check (compared against the latest GitHub release; when a newer version exists the button turns into "Download" and the version is shown), and the acknowledgements. External links always open in the system browser and never replace the app's own interface.

"My computers" on the phone now lives inside the dsh interface instead of taking over the whole screen. Tapping the sidebar button used to hand the entire UI over to the app shell, which felt jarring; the injected script now switches a two-tab "Chat / My computers" strip inside dsh itself: the host list (connect / rename / two-step removal), the pairing form, the local-mode card, connection status and reconnect, and the about-and-thanks section, all rendered with dsh's own theme variables and following dsh's language and theme. Data and actions travel over a postMessage bridge to the app's Rust core (with a 15-second timeout), and connection/local-mode state events are relayed into the panel in real time. The top bar's "Machines" button routes by capability: the new plugin opens the panel, an older plugin still falls back to the app's own hosts page.

The keep-alive notification is now an Android 16 "Live Update" chip — Android's Dynamic Island. The silent ongoing notification shown while connected in the background now carries a system chronometer (ticking from the moment the connection started) and Android 16's `ProgressStyle` with indeterminate progress: on Android 16 it appears as a live chip in the status bar and renders on the lock screen and always-on display, and in the shade it expands into a ticking timer. Android 15 and below keep the plain ongoing notification, unaffected. Verified on a real device (Xiaomi 23113RKC6C, Android 16): dumpsys confirms `ProgressStyle` and `showChronometer` are attached.

## 0.1.27

### 修复

- **桌面端热启用插件失败:`service "directoryPicker" has been registered at <NativeDirectoryPicker>`,每次启用或更新插件都要重启应用**。插件的目录选择器补丁一边停用默认的 auto 选择器、一边插入「应用内浏览」后端,两条一起动;冷启动没问题(补丁先叠好、auto 根本没挂 native),但桌面端插件管理器里的热启用不重启进程——loader 并发执行「卸载 auto 挂着的 native」和「激活新插入的 browse」,browse 总是抢在 native 让位之前注册 `directoryPicker` 服务(一个服务只能注册一次),于是整条 entry 报这个错、启用被标失败。现在 host 半边不再由补丁 insert,改由插件 `apply` 用代码注册 `BrowseDirectoryPicker`:撞上「has been registered」就每 100ms 重试,等 native 卸载完再注册,冷启动第一次就成功;client 半边仍在补丁里,它不注册该服务。此后在插件管理器里启用、更新插件都不再需要重启应用,目录选择器行为与之前完全一致(手机经隧道仍走应用内浏览)。

### English

Hot-enabling the plugin in the dsh desktop app failed with `service "directoryPicker" has been registered at <NativeDirectoryPicker>`, so every enable or update needed a full application restart. The plugin's directory-picker patch both disabled the default auto chooser and inserted the in-app browse backend at once; a cold boot was fine — patches compose before anything activates — but the desktop plugin manager's hot enable does not restart the process, and the loader unloads the auto chooser's native backend and activates the newly inserted browse entry concurrently, so browse always registered the one-per-context `directoryPicker` service before native let go, failing that entry and marking the enable as failed. The host half is no longer inserted by the patch: the plugin's `apply` now registers `BrowseDirectoryPicker` from code, retrying every 100 ms on the "has been registered" error until the native backend finishes unloading, while a cold boot succeeds on the first attempt. The client half stays in the patch, since it registers no service. Enabling or updating the plugin in the plugin manager no longer needs an application restart, and the directory picker behaves exactly as before (the phone still browses in-app through the tunnel).

## 0.1.26

### 修复

- **dsh 0.2.2-rc 上手机打开侧栏变成一块黑、点不动**。0.2.2-rc 起 dsh 在 <768px 自带抽屉:主框架挂 `data-sidebar-drawer`,并渲染一层 `z-index:70` 的遮罩;tether 注入的窄屏抽屉把侧栏钉成 `z-index:30`,侧栏于是被原生遮罩压到下面——深色主题下遮罩是 50% 黑,侧栏看起来就是一块黑,遮罩的 `pointer-events:auto` 又把点击全吞了。现在这段手工抽屉只在 dsh 没有原生抽屉(框架不带 `data-sidebar-drawer`)时生效,原生抽屉出现时整体让位:滑入滑出、遮罩、点外收起都交给 dsh 自己,侧栏里的「连接手机/我的电脑」按钮照常挂载;点外收起那段脚本同样只在没有原生抽屉时接管。老版本 dsh 行为不变。

### English

On dsh 0.2.2-rc and later the sidebar turned into a black block and stopped responding when opened on a phone. Since 0.2.2-rc dsh ships its own drawer below 768px: the frame carries `data-sidebar-drawer` and renders a mask at `z-index:70`, while tether's injected narrow-screen drawer pinned the sidebar to `z-index:30`, so the native mask stacked on top — in dark mode that mask is 50% black, which is exactly the black block, and its `pointer-events:auto` swallowed every tap. The hand-rolled drawer now only applies when dsh has no native drawer (the frame lacks `data-sidebar-drawer`) and steps aside when the native drawer is present, leaving the slide-in/out, the mask and tap-outside-to-close to dsh itself; the "Connect a phone / My computers" button still mounts as usual. Behaviour on older dsh versions is unchanged.

## 0.1.25

### 修复

- **窄屏下侧栏卡在 56px:标签文字渲染出来却被裁掉,侧栏开关也找不到**([#22](https://github.com/zexadev/dsh-tether/issues/22))。0.1.24 的窄屏样式用「主框架下有没有拖拽把手」判断侧栏是否展开,这个判据要靠 `:has()`。有的厂商 WebView 会把带 `:has()` 的规则整条丢掉(报告机型:华为 Mate 50 / HarmonyOS 4.2),于是「展开时侧栏 300px」那条不生效,而 dsh 自己处在展开态——标签照常渲染,被 56px 的盒子裁成每行一两个字;开关只在收起态渲染,页面上也找不到,界面就卡在这个混态。现在改读 dsh 写在主框架上的 `data-sidebar-collapsed`(收起为 `"true"`,展开时属性不存在),不再用 `:has()`;插件声明支持的五段 dsh 范围各取一版查过,这个属性每版都有。拖拽把手那条规则一并删掉,手机上它本来也拖不动。实测 480×1056:收起侧栏 57px、无遮罩、「主机」标签隐藏;按开关 301px、遮罩出现、标签显示;点内容区收回。
- **dsh 桌面端里「我的电脑」按钮点了没有任何反应**([#23](https://github.com/zexadev/dsh-tether/issues/23))。按钮的文案和行为原本按 `window.parent !== window` 判断「是不是在 tether 手机 App 里」,而 dsh 桌面端的插件界面同样跑在宿主的内嵌 frame 里,于是桌面端被当成手机:按钮显示「我的电脑」,点击只向父窗口发一条 `dsh-tether:open-hosts` 消息——桌面宿主没有这条消息的监听者,按钮因此是死的,也没有别的出路。现在改成 App 建窗口时往所有 frame 注入 `window.__DSH_TETHER_APP__`,谁是 App 谁挂标记;拿不到标记一律按浏览器处理,当场出示配对串。桌面端因此也能拿到配对串(换手机、加设备时用),不必再手动开浏览器访问本机地址。这条要配新版 App 才完整:老 App 没有这个标记,装上新插件后按钮会显示「连接手机」并出示配对串。
- **窄屏下附件缩略图被挤变形**(修 #22 时发现)。窄屏那几条规则用 `[class*="_frame"]` 选主框架,但 dsh 的会话区、附件缩略图、子代理、文档预览的局部类名也带 `_frame`,而且都长在主框架里面。附件缩略图自己是个单格网格,被 `grid-template-columns: 56px minmax(0,1fr) 0px` 改成三列之后,图片挤进 56px 的第一列;侧栏遮罩那条同理会糊在每个嵌套元素上。这几条现在限定成「带 `_frame` 且不在任何 `_frame` 里面」。

### 变更

- 声明支持 dsh `0.2.1-rc.5` 与 `0.2.2-alpha.2`。dsh 从 0.1.7 起会拒装声明范围没覆盖自己的插件,所以 0.2.2-alpha 线上原本装不上。两个版本都实跑验证过:布局包的类名与 `data-sidebar-collapsed` 和 0.2.1-rc.3 逐字相同,抽屉、设置弹窗、侧栏按钮行为一致。APK 内置的 dsh 仍是 `0.2.1-rc.2`,本次不动。

### English

On a narrow screen the sidebar could get stuck at 56px with its labels rendered but clipped and no sidebar toggle in sight ([#22](https://github.com/zexadev/dsh-tether/issues/22)). The narrow-screen styling in 0.1.24 decided whether the sidebar was expanded by looking for the drag handle under the frame, which needs `:has()`. Some vendor WebViews drop every rule containing `:has()` (reported on a Huawei Mate 50 running HarmonyOS 4.2), so the "sidebar is 300px when expanded" rule never applied while dsh itself was in the expanded state: the labels rendered and were clipped to one or two characters by the 56px box, and the toggle is only rendered while collapsed, so there was no way out of that mixed state. The expanded state is now read from `data-sidebar-collapsed`, which dsh writes on the frame itself (`"true"` when collapsed, absent when expanded), with no `:has()` involved; the attribute was checked in one version from each of the five dsh ranges the plugin declares. The drag-handle rule is gone as well — it was never draggable on a phone. Measured at 480×1056: collapsed sidebar 57px, no veil, hosts label hidden; after the toggle 301px with the veil and the label; tapping the content column collapses it again.

In the dsh desktop app the "My computers" button did nothing when clicked ([#23](https://github.com/zexadev/dsh-tether/issues/23)). The label and the behaviour were chosen by `window.parent !== window`, meant to detect "running inside the tether phone app", but the plugin UI in the dsh desktop shell also lives in an embedded frame, so the desktop was treated as a phone: the button read "My computers" and a click only posted `dsh-tether:open-hosts` to the parent window — which the desktop shell does not listen for, leaving the button dead with nothing else to fall back on. The app now injects `window.__DSH_TETHER_APP__` into every frame when it creates the window, so whoever is the app says so; without that marker the plugin treats the page as a browser and shows the pairing string. Desktop users can therefore get the pairing string (for a new phone or an extra device) without opening a browser by hand. This one needs the new app build to be complete: an older app does not set the marker, so with the new plugin its button reads "Connect a phone" and shows the pairing string.

Attachment thumbnails were squeezed out of shape on narrow screens (found while fixing #22). Those narrow-screen rules selected the frame with `[class*="_frame"]`, but the conversation area, attachment thumbnails, subagent and document-preview components all carry local class names containing `_frame` and all live inside the frame. An attachment thumbnail is a single-cell grid, so `grid-template-columns: 56px minmax(0,1fr) 0px` turned it into three columns and pushed the image into the 56px first column, and the sidebar veil would likewise be painted over every nested element. Those rules are now restricted to a `_frame` that is not inside another `_frame`.

Support is now declared for dsh `0.2.1-rc.5` and `0.2.2-alpha.2`. Since 0.1.7 dsh refuses to install a plugin whose declared range does not cover it, so the 0.2.2-alpha line could not install this plugin at all. Both versions were verified by running them: the layout package class names and `data-sidebar-collapsed` are identical to 0.2.1-rc.3, and the drawer, settings dialog and sidebar button all behave the same. The dsh bundled inside the APK stays at `0.2.1-rc.2`.

## 0.1.24

### 修复

- **老 WebView 上 dsh 界面整个起不来:停在「正在加载工作区…」,或点「选择工作区」时报 `AbortSignal.any is not a function`**([#20](https://github.com/zexadev/dsh-tether/issues/20))。dsh 0.2.1-rc 的前端用到 `Promise.withResolvers`(Chrome 119 起有)和 `AbortSignal.any`(Chrome 116 起有),而华为等厂商随系统发的 WebView 还停在 Chromium 114,两个都没有。前者让启动脚本当场抛错,后者让读取远端数据那一步次次失败,界面于是无限转圈重连。现在 App 在建窗口时就补上这两个 API,并且补进页面里内嵌的 dsh 界面那一层——它和外壳不同源,只补外壳够不着。补之前先探测,WebView 自带的就不动,新机器上等于没有这段代码。真机对照:华为 TET-AN50 / Android 12 / WebView 114.0.5.302,修前必现,修后 dsh 正常启动、目录列表正常、脚本报错为零;本机模式与终端不受影响。
- **放一段时间后界面卡在「重新连接中」,等多久都不恢复,只能强停 App 重开**([#19](https://github.com/zexadev/dsh-tether/issues/19))。四处缺陷叠在一起:
  - 链路死了也不报断开。读写两侧用「都结束才算完」来等,而写侧平时一直阻塞在待发队列上、只有读侧会报错,这个条件于是永远不成立。实测杀掉电脑侧 sidecar 七分钟,手机顶栏一直显示「已连接」,一条断开事件都没发出来。改成任一侧结束即收尾,现在约半分钟内就会报「连接已断开」并给出「重新连接」。
  - 本地代理的监听口既不随连接关闭,换连接时也不让出。按主机派生的那个固定端口因此被废弃的监听长期占着,新连接只能退回随机端口。更要命的是废监听照样接受 TCP 连接、但每个请求都被丢掉——页面看着是连上的,实际一个请求也出不去,这正是「显示正常却一直重连」的来由。
  - 端口一换,对 dsh 来说就是换了个来源,按来源存的状态(当前会话、界面偏好)全是空的,于是每次重连都像第一次打开。
  - 旧连接收尾时不看自己还是不是当前那条,一律广播断开并清空发送端。刚建好的新连接会被它一起判死:顶栏在连上的同一毫秒跳回「未连接」,审批决定也发不出去。
  
  真机验证:杀掉电脑侧进程后 37 秒内报断开;重连回到同一个固定端口;连按三次重连,手机上始终只有那一个监听口,也不再出现多余的断开事件。
- **会话里工具调用那几行被切掉大半,只剩文字最上面一道横杠**([#18](https://github.com/zexadev/dsh-tether/issues/18))。这是 0.1.0 起给窄屏注入的样式写宽了:那条规则本来只给设置弹窗的「说明 + 控件」行用,判据却只看类名里带不带 `row`,把会话里的工具调用行一并命中了。那种行高度写死、超出即裁,被强行允许换行之后图标占满第一行、标题掉到第二行,露在外面的只剩第二行最上面几个像素。文件路径、命令、报错这类长标题全中招,短标题排得下反而没事,所以一问一答看不出来、任务一跑长就满屏横杠。判据改成「这一行里确实有说明列」:设置弹窗照旧,会话里的行恢复单行加省略号。顺带说明,这跟手机型号和 WebView 版本都没关系——把桌面浏览器窗口收到同样宽度,一样会出现。

### English

The whole dsh interface failed to start on older WebViews: it sat at "Loading workspace…", or choosing a workspace reported `AbortSignal.any is not a function` ([#20](https://github.com/zexadev/dsh-tether/issues/20)). The dsh 0.2.1-rc frontend uses `Promise.withResolvers` (Chrome 119 and later) and `AbortSignal.any` (Chrome 116 and later), and the system WebView shipped by Huawei and others is still on Chromium 114, which has neither. The first made the boot script throw outright; the second made every read of remote data fail, so the client looped on "connection lost, retry". The app now supplies both APIs when it creates the window, including inside the embedded dsh interface — that frame has a different origin, so patching the shell alone never reaches it. Each API is feature-detected first and left alone when the WebView already has it, so on a current device this code does nothing. Checked on a real device, Huawei TET-AN50 / Android 12 / WebView 114.0.5.302: the failure was reproducible before and gone after, with dsh starting, the directory list rendering, and no script errors. Local mode and the terminal are unaffected.

After sitting idle the interface got stuck on "Reconnecting", never recovered however long you waited, and only a force stop brought it back ([#19](https://github.com/zexadev/dsh-tether/issues/19)). Four defects stacked up. First, a dead link was never reported: the connection waited for both its reader and its writer to finish, and the writer normally blocks forever on the outgoing queue while only the reader errors out, so that condition never came true — with the computer-side sidecar killed, the phone kept showing "Connected" for seven minutes without emitting a single disconnect. Either side finishing now ends the connection, so the disconnect and the Reconnect button appear within about half a minute. Second, the local proxy listener was neither closed when its connection ended nor released when a new connection replaced it, so the port derived from the computer stayed occupied by a dead listener and every later connection fell back to a random one — and the dead listener still accepted TCP while dropping every request, which is exactly how the page can look connected while nothing gets through. Third, once the port changes dsh sees a different origin, so everything stored per origin (the current session, interface preferences) comes up empty and every reconnect looks like a first run. Fourth, a connection tearing down did not check whether it was still the current one, and broadcast a disconnect and cleared the send channel regardless, killing a connection that had just been established: the status flipped back to "Not connected" in the same millisecond it connected, and approval decisions could no longer be sent. Verified on a real device: the disconnect now arrives 37 seconds after the computer-side process is killed, a reconnect returns to the same derived port, and three reconnects in a row leave exactly one listener on the phone with no spurious disconnects.

Tool-call rows in a conversation were sliced down to a sliver of their top edge ([#18](https://github.com/zexadev/dsh-tether/issues/18)). The narrow-screen styling injected since 0.1.0 was written too broadly: the rule was meant for the "description plus control" rows of the settings dialog, but it matched on nothing more than the word `row` in a class name, so it also caught the tool-call rows in the conversation. Those rows have a fixed height and clip their overflow, so once wrapping was forced on them the icon filled the first line, the title dropped to a second line, and only a few pixels of that second line stayed visible. Long titles — file paths, commands, error messages — all hit this, while short ones still fitted on one line, which is why a single question and answer looked fine and a longer task filled the screen with slivers. The rule now requires the row to actually contain a description column: the settings dialog is unchanged, and conversation rows are back to one line with an ellipsis. For the record, this had nothing to do with the phone model or the WebView version — narrowing a desktop browser window to the same width reproduces it.

## 0.1.23

### 修复

- **登录账号后,侧栏里「连接手机」四个字竖成一列、后面顶着一个灰圆**([#17](https://github.com/zexadev/dsh-tether/issues/17))。0.1.22 起这个按钮改抄侧栏底部那一行的样式,抄文字样式时取的是那一行里的第一个文字块:没登录时它正好是文字,登录之后那一行最前面多了头像,抄来的就成了头像的样式 —— 一个 24 像素宽的圆形色块,四个汉字塞进去只能一字一行。现在改抄那一行里最末尾的纯文字块,并且那一行每次换形态(登录、退出、侧栏收放)都重新挑一次。dsh 0.2.1-rc 的浏览器界面登录后同样会这样,一并修了。按钮本身一直能点,配对不受影响。
- **侧栏收成竖条时,「连接手机」的文字还挤在图标旁边**。dsh 自己那一行在竖条态只画图标、不画文字,我们没跟着收。现在参照的那一行不显示文字时,按钮也只留图标;按钮的无障碍名称一直都在,读屏不受影响。

### English

Signed in, the Connect a phone label in the sidebar stacked one character per line with a grey circle behind it ([#17](https://github.com/zexadev/dsh-tether/issues/17)). Since 0.1.22 the button copies the styling of the row at the bottom of the sidebar, and it picked the first text block in that row to copy from. Signed out that block is the label; signed in the row gains an avatar in front, so the button copied the avatar's styling instead — a round 24-pixel swatch, which a four-character label can only enter one character at a time. The button now copies the last plain-text block in that row, and picks it again every time the row changes shape (signing in or out, collapsing or expanding the sidebar). The browser interface of dsh 0.2.1-rc did the same thing once signed in, and is fixed as well. The button itself always worked, and pairing was never affected.

With the sidebar collapsed to a strip, the Connect a phone label was still crammed next to the icon. The dsh row above it draws only its icon in that state, and the button did not follow. The button now drops its label whenever the row it copies has none; its accessible name stays in place, so screen readers are unaffected.

## 0.1.22

### 修复

- **dsh 0.2.1-rc 上侧栏里的「连接手机」按钮不见了;dsh desktop 上它从来没出现过**([#16](https://github.com/zexadev/dsh-tether/pull/16))。这个按钮是照抄侧栏「设置」入口的样式挂上去的,抄不到就干脆不挂。dsh 0.2.1-rc 把设置入口从侧栏挪走了,浏览器界面上的按钮于是跟着消失;dsh desktop 的设置本来就在应用自己的菜单里,侧栏从来没有可抄的对象,所以那边一次都没出现过。首次配对不受影响(白名单为空时会自动弹出配对码),但换手机、加第二台设备只能靠这个按钮,没有它就只能手工删配对记录。现在抄不到「设置」就改抄侧栏底部那一行(登录后是账号行,没登录是「更多」),两处都抄不到也照样把按钮挂出来。顺带一提,注入界面走的通道也换了:dsh desktop 的界面来自应用自带的前端产物,老通道根本到不了它。
- **(手机本地模式)目录 fsync 的跳过条件收严**。0.1.20 为了绕开沙箱限制,改成「打不开的目录就跳过 fsync」;但「打不开」和「写不进去」是两回事,一个可写不可读的目录里真可能有本进程刚创建的条目,跳过就等于悄悄少落一次盘。现在要「打不开、而且也确实写不进去」才跳过。手机上那条路径(`/data/user/0` 及其以上对 App 只有执行权限)行为不变。

### 变更

- **手机本地模式内置的 dsh 从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`**。装上这一版后,第一次启动本地模式会重新解压运行时。真机逐条验过:解压、选工作区、发一条消息、发一张图。arm64 包因内置运行时变大,从约 78 MB 涨到约 83 MB;其余 ABI 不含运行时,体积不变。
- **已验证的 dsh 版本补上 `0.2.1-rc.2`**。声明的兼容范围本来就覆盖 0.2.1 这一族,不用改,装不装得上没有变化。

### English

The Connect a phone button disappeared from the sidebar on dsh 0.2.1-rc, and never appeared at all in dsh desktop ([#16](https://github.com/zexadev/dsh-tether/pull/16)). The button is mounted by copying the style of the sidebar Settings entry, and it simply did not mount when there was nothing to copy. dsh 0.2.1-rc moved that entry out of the sidebar, so the button vanished in the browser interface; dsh desktop keeps its settings in the application menu, so the sidebar there never had anything to copy and the button never showed up at all. First pairing was unaffected — a pairing code appears by itself while no device is paired — but switching phones or adding a second device needs this button, and without it the only way out was deleting the pairing record by hand. The button now falls back to copying the row at the bottom of the sidebar (the account row when signed in, the More row when not), and it mounts with its own styling when neither reference exists. The channel the interface is injected through changed as well: the dsh desktop interface comes from the frontend bundled into the application, which the old channel could never reach.

In local mode on the phone, the condition for skipping a directory fsync is now stricter. To work around the sandbox, 0.1.20 skipped fsync for any directory the app could not open; but "cannot open" and "cannot write" are different things, and a directory that is writable but not readable may genuinely hold entries this process just created, so skipping it quietly loses a durability step. The fallback now skips only when the directory can neither be opened nor written. Behaviour on the phone is unchanged, since `/data/user/0` and everything above it grants an ordinary app execute only.

The dsh bundled into Android local mode moves from `0.2.0-rc.2` to `0.2.1-rc.2`. The first local-mode start after this update unpacks the runtime again. Verified on a real device end to end — unpacking, choosing a workspace, sending a message, and sending an image. The `arm64` APK grows from about 78 MB to about 83 MB because of the larger bundled runtime; the other ABIs carry no runtime and are unchanged.

The list of verified dsh versions gains `0.2.1-rc.2`. The declared compatibility range already covered the 0.2.1 family, so nothing changes about whether the plugin installs.
## 0.1.21

### 修复

- **在 dsh desktop 里启动时会弹出一个控制台窗口**([#15](https://github.com/zexadev/dsh-tether/issues/15))。插件拉起 sidecar 时没让 Windows 隐藏新窗口。dsh desktop 的插件宿主是以 Node 模式运行的 Electron,属 GUI 程序、自己没有控制台,Windows 于是给 sidecar(控制台程序)新分配一个控制台,连窗口一起显示出来。在终端里跑 dsh 不会这样:宿主已有控制台,子进程直接继承,所以这个窗口只在 desktop 下出现。现在新分配的窗口不再显示;终端里跑 dsh 时 sidecar 的日志照旧打在同一个终端。

### English

Starting the plugin inside dsh desktop popped up a console window ([#15](https://github.com/zexadev/dsh-tether/issues/15)). The plugin spawned its sidecar without asking Windows to hide the new window. The plugin host of dsh desktop is Electron running in Node mode — a GUI program that owns no console — so Windows allocated a fresh console for the sidecar, which is a console program, and showed its window along with it. Running dsh in a terminal never did this, because the host already owns a console and the child simply inherits it, which is why the window only ever appeared under desktop. The newly allocated window is now hidden, and sidecar logs still go to the same terminal when you run dsh there.

## 0.1.20

### 修复

- **手机本地模式下发不出图**(0.1.14 起每一版都有)。附件入库时 dsh 会把目标目录的每一级祖先逐个 fsync,边界却取的是文件系统根,于是这个 walk 一定会走出 App 的沙箱。Android 上 `/data/user/0` 的权限是 `drwxrwx--x`,普通 App 只有 x 没有 r,而 fsync 一个目录必须先只读打开它 —— 于是恒 EACCES,界面报 `prompt rejected`,详情是 `EACCES: permission denied, open '/data/user/0'`。发消息不受影响:会话落盘那条路只 fsync 自己那两三层目录、从不往上 walk,所以只验发消息永远发现不了这个问题。现在打包运行时时把目录 fsync 改成「没权限就跳过这一级」。不损失 durability:App 能创建的目录都在沙箱内、照旧被 fsync,再往上全是本进程从未改动过的系统目录。

### 变更

- **手机本地模式内置的 dsh 从 `0.1.5-rc.2` 升到 `0.2.0-rc.2`**。装上这一版后,第一次启动本地模式会重新解压运行时。dsh 0.2 换了会话记录的格式:手机上已有的会话打开后照常显示,再发消息时会迁到新格式,旧文件原样留着。真机上逐条验过——重新解压、旧会话打开与迁移、新建会话、发一条消息、发一张图。arm64 包因内置运行时变大,从约 71 MB 涨到约 78 MB;其余 ABI 不含运行时,体积不变。

### English

Sending an image in local mode on the phone has never worked since 0.1.14. Ingesting an attachment fsyncs every ancestor of the target directory up to a boundary, and that boundary is the filesystem root — so the walk always leaves the app sandbox. On Android `/data/user/0` is `drwxrwx--x`, leaving an ordinary app with execute but no read, and fsyncing a directory requires opening it read-only first, so it always fails with `EACCES: permission denied, open '/data/user/0'` and the interface reports `prompt rejected`. Sending text was never affected, because session persistence only fsyncs its own two or three levels and never walks upward — which is exactly why testing only "send a message" could never surface it. Directory fsync now skips any level the app may not open; nothing durable is lost, since every directory the app can create is inside the sandbox and still gets fsynced, and everything above it is a system directory this process never touched.

The dsh bundled into Android local mode moves from `0.1.5-rc.2` to `0.2.0-rc.2`. The first local-mode start after this update unpacks the runtime again. dsh 0.2 changes the session record format: sessions already on the phone still open and display as before, and migrate to the new format the next time you send a message, with the old file left in place. Verified on a real device end to end — unpacking, opening and migrating an existing session, creating a new one, sending a message, and sending an image. The `arm64` APK grows from about 71 MB to about 78 MB because of the larger bundled runtime; the other ABIs carry no runtime and are unchanged.

## 0.1.19

### 修复

- **dsh 0.2 装不上这个插件**。dsh 从 0.1.7 起会按插件声明的兼容范围拦安装:范围没覆盖当前 runtime 就直接拒装,而本插件的范围到 0.1.7 族为止。npm 上 dsh 的默认版本现已是 0.2.0-rc.2,也就是说今天新装 dsh 的人拿到的就是 0.2,一律被拒。范围补上 0.2.0 与 0.2.1 两族。放宽之前 0.2.0-rc.2 与 0.2.1-alpha.1 都逐条实测过:插件加载与 sidecar、浏览器认证的 cookie 兑换与逐请求注入(以及不带 cookie 必须 401)、注入进界面的手机版式、三条路由与跨站栅栏(伪 Host / 跨站标记 / 跨源 Origin 全部 403)、目录选择器补丁、审批事件的透传、以及经 P2P 代理流取到的界面与电脑上直接打开的逐字一致。手机本地模式内置的 dsh 仍是 `0.1.5-rc.2`,这一版没动它。

### English

dsh has refused to install plugins whose declared compatibility range does not cover the running dsh since 0.1.7, and this plugin's range stopped at the 0.1.7 family. npm now serves 0.2.0-rc.2 as dsh's default version, so anyone installing dsh today lands on 0.2 and is turned away. The range now covers the 0.2.0 and 0.2.1 families, after verifying both 0.2.0-rc.2 and 0.2.1-alpha.1 end to end: plugin load and sidecar startup, the browser-auth cookie exchange and per-request injection (including the 401 when the cookie is absent), the phone layout injected into the interface, the three plugin routes with their cross-site guard, the directory-picker patch, approval events, and the interface fetched through the proxy stream matching the one served locally byte for byte. The dsh bundled into Android local mode is still `0.1.5-rc.2`; this release does not change it.

## 0.1.18

### 修复

- **dsh 0.1.7 装不上这个插件**([#13](https://github.com/zexadev/dsh-tether/issues/13))。dsh 从 0.1.7 起会按插件声明的兼容范围拦安装:范围没覆盖当前 runtime 就直接拒装,而本插件的范围停在 0.1.5 族,于是 0.1.6 和 0.1.7 的用户一律被拒(0.1.6 本身没有这道闸,照装不提示)。范围放宽到 0.1.7 族。放宽之前 0.1.6-alpha.2 与 0.1.7-rc.2 都逐条实测过:插件加载与 sidecar、浏览器认证的 cookie 兑换与逐请求注入、注入进界面的手机版式、三条路由与跨站栅栏(伪 Host / 跨站标记 / 跨源 Origin 全部 403)、目录选择器补丁、以及经 P2P 代理流取到的界面与电脑上直接打开的逐字一致。

### English

dsh 0.1.7 started refusing to install plugins whose declared compatibility range does not cover the running dsh, and this plugin still declared up to the 0.1.5 family — so everyone on 0.1.6 or 0.1.7 was turned away at install time. The range now covers the 0.1.7 family, after verifying both 0.1.6-alpha.2 and 0.1.7-rc.2 end to end: pairing over P2P, browser-auth cookie exchange and per-request injection, the phone layout injected into the interface, the three plugin routes with their cross-site guard, the directory-picker patch, and the interface fetched through the proxy stream matching the one served locally byte for byte.

## 0.1.17

### 修复

- **sidecar 自己的 `--help` 还是中文**([#8](https://github.com/zexadev/dsh-tether/issues/8))。0.1.16 把界面和终端输出都做了英文,唯独 `tether-host --help` 和每个参数的说明漏了,手跑二进制的人只能对着中文猜参数。现在帮助文本也按语言出中英。
- **Windows 和 macOS 上手跑 sidecar 恒出中文**。判定语言只认 `LC_ALL`/`LANG`,而这两个系统本来就不设这两个变量,英文用户于是必得中文。现在环境变量没有就问系统语言。
- **配对失败的原因在手机上显示成中文**。原因是电脑侧直接把中文句子发给了手机——这句该由看到它的那一端来措辞。线上改成只传原因码,手机 App 和 dsh 界面各按自己那侧的语言显示。另有几处写死的中文一并补齐(phone-sim 的代理就绪、本地代理监听失败、前台服务日志、移除设备失败)。

### English

This release finishes what 0.1.16 started: `tether-host --help` and all option descriptions are now English on an English machine, the language is detected from the system when `LC_ALL`/`LANG` are unset (which is the normal case on Windows and macOS), and a failed pairing is now worded by whichever side displays it, so the phone no longer shows a Chinese reason. Nothing a user can see is Chinese-only any more; if you find something, please open an issue.

## 0.1.16

### 新增

- **英文界面**([#8](https://github.com/zexadev/dsh-tether/issues/8))。手机 App 的界面、连接与本地模式的报错、常驻通知,以及电脑上插件与 sidecar 打在终端里的输出,现在都有英文。没有单独的语言开关,各处跟随各自那一侧的语言:App 跟手机的系统语言,终端输出跟电脑的系统语言,插件注入在 dsh 界面里的那部分(侧栏按钮、配对串弹窗、已配对手机列表)跟 dsh 自己的语言设置,在 dsh 设置里切换语言即时生效。dsh 界面本身的语言仍由 dsh 的设置决定。

## 0.1.15

### 新增

- **手机本地模式内置的 dsh 升到 `0.1.5-rc.2`**(此前是 `0.1.2-rc.1`)。升级后第一次进入本地模式会重新解压运行时(约 9 秒);手机上已有的会话会在打开时自动迁移到新版日志格式,内容不丢。dsh 本身的变化见它自己的更新说明。

### 修复

- **电脑上的 dsh 升到 0.1.5 后,手机上的版式右侧一列错位、对话区被挤窄**。上游把布局类名从 `detailsCol` 改成了 `rightbarCol`,插件注入的窄屏样式匹配不到就静默失效。两个名字现在都兼容,新旧 dsh 都正常。

## 0.1.14

### 修复

- **Android 本地模式:每一轮对话都失败,报 `EACCES: permission denied, link ...`**([#9](https://github.com/zexadev/dsh-tether/issues/9))。Android 系统的 SELinux 策略禁止普通 App 创建硬链接,与机型、ROM、系统版本无关;dsh 新会话首次落盘用的正是硬链接,所以 0.1.13 的本地模式在任何手机上都新建不了会话,发送图片也会以 `ATTACHMENT_WRITE_FAILED` 失败。现在本地模式内置的 dsh 在硬链接被拒时改为「写一份副本并落盘 → 确认目标不存在 → 原子改名」,文件仍然完整出现、不会覆盖已有会话。升级后第一次进入本地模式会重新解压运行时(约 9 秒)。远程模式(连电脑)不受影响。

## 0.1.13

### 新增

- **Android 本地模式:没电脑也能用,DSH 直接跑在手机上**。同一个 App 两种模式:有电脑连电脑(原有能力),没电脑在「主机」页点「在本机运行」。Node 24 与 dsh `0.1.2-rc.1` 的完整依赖树打在 `arm64` APK 里,首次启动离线解压(实测 9 秒),之后每次约 2 秒;没有配对、没有远端,会话和设置只存在手机里,与连电脑时的状态完全分开;运行期间挂一条常驻通知(前台服务),退后台、锁屏不被系统收掉,进程被杀后下次打开自动重起。手机上的 dsh 同样带窄屏适配。只有 `arm64` 包带本地模式(约 71 MB,其余包约 32 MB);iOS 沙箱不允许子进程,没有这个入口。手机上没有 bash 与完整 coreutils,依赖 shell 的工具用不全。
- 顶栏常驻「主机」按钮,任何模式下都能回到主机页。

### 变更

- 插件 `peerDependencies` 加入 dsh `0.1.5` 版本族;`0.1.2-rc.1` 与 `0.1.5-alpha.1` 已在隔离环境实测(patch、cookie 兑换、路由栅栏、侧栏注入、经代理流的手机链路)。实测 pnpm 在 peer 范围不含当前版本族时照常安装且无警告,该声明只记录已验证范围。
- 插件新增 `config.sidecar: false`:只做界面适配,不找也不起 sidecar;供手机本地模式使用。
- README、网页与包描述改为如实表述:直连优先,打不通才退回 relay,relay 只见密文;不再写「不经过任何服务器」。
## 0.1.12

### 修复

- **Termux:`tether-host` 启动时打一段 `android context was not initialized` 的 panic 栈**([#5](https://github.com/zexadev/dsh-tether/issues/5))。iroh 默认解析器在 android 上经 JNI 读系统 DNS,Termux 没有 JVM;iroh 内部接住 panic 后回退 Google DNS,进程照常工作,但栈已经打出来了。现在 android 目标直接用等价的解析器,不再走 JNI。
- **侧栏底部「连接手机」按钮与 dsh-cost-meter 互挤,被压成只剩图标的竖条**([#7](https://github.com/zexadev/dsh-tether/issues/7))。两者共用 `sidebar.footer.action` 插槽,横排下互挤。现改为纵向堆叠、各占一行,展开态与折叠成图标条两种状态都与「设置」按钮几何一致。
- **手机每次打开 App,dsh web UI 都当作全新访问;配合 Prefab Anchored Standard 一类一进会话就写入历史的预设,每开一次多一条会话**([#7](https://github.com/zexadev/dsh-tether/issues/7))。手机侧本地代理端口此前每次连接随机,web UI 按源保存的「当前会话」等状态永远读不到。现在端口按主机派生固定,同一台电脑每次同源;不同电脑不同源,状态互不串。

## 0.1.11

### 新增

- **`tether-host` 新增 android-arm64 平台子包,支持在 Termux 里跑**([#5](https://github.com/zexadev/dsh-tether/issues/5))。sidecar 本身是与 tauri 无关的纯 CLI,交叉编译到 `aarch64-linux-android`(NDK,API 24)与其余四个平台走的是同一套打包流程。Termux 的 Node 把 `process.platform` 报成 `android`(不是 `linux`),`index.js` 现有的自动选包逻辑按这个字段筛,所以是新增一个平台子包而不是复用 linux-arm64。

### 修复

- **iOS:配对必然 `timed out`,主机侧完全收不到配对请求**([#6](https://github.com/zexadev/dsh-tether/issues/6))。iOS 14 起,发往同网段私网 IP 的收发受内核层 Local Network Privacy 管控,且不区分是否经 NWFramework——iroh/quinn 用的原始 UDP socket 同样受限。此前 `Info.ios.plist` 只有 `NSAllowsLocalNetworking`(管 WebView 加载本机代理页面的 ATS 例外),没有 `NSLocalNetworkUsageDescription`,系统既不弹权限询问也不放行局域网收发。

  现补上这个键,系统会弹一次性授权询问。**本修复未在 iOS 真机验证**,由用户反馈发现;若升级后仍 timed out,麻烦在 issue 里确认安装后是否弹出过「本地网络」权限询问、以及设置里该权限是否开启。

## 0.1.10

### 修复

- **macOS / Linux:sidecar 起不来,配对时报「sidecar 没有在 5 秒内给出配对码」,终端见 Permission denied**。npm 平台子包里的 `tether-host` 二进制自首个版本起就缺可执行位——CI 的 artifact 传输不保留 Unix 权限位,打包时原样带进了 tgz。Windows 不看执行位,故只在 Mac/Linux 上暴露。由 Mac 用户反馈发现。

  现打包前补回执行位,并对每个发布产物断言执行位存在,缺位则发布直接失败。**Mac/Linux 用户升级本版即修复**:`dsh plugin --profile web add dsh-plugin-tether@0.1.10`。如暂不升级,也可手动 `chmod 0755` 装好的 `dsh-tether-host-*/bin/tether-host` 应急。

- sidecar 启动失败不再只留一句干瘪的错误:插件现在会接住并打印可读原因(EACCES 附排查提示),「连接手机」弹窗里也会立即显示原因,而不是干等 5 秒换一个 504。

## 0.1.9

### 新增

- **适配 dsh 0.1.2-alpha 的浏览器认证**([#4](https://github.com/zexadev/dsh-tether/issues/4))。dsh 0.1.2-alpha 起,网页界面与 Host API 要求持有经启动 token 兑换的签名 cookie,无凭据一律 401——手机端表现为连上后一片 401 提示。

  适配完全在电脑侧完成:插件启动时自动完成 token→cookie 兑换,sidecar 在代理出口把认证注入每个转发请求。**手机 App 无需更新**;dsh 的跨站请求防护经隧道原样保留(伪造来源仍被 403 拒绝)。

  cookie 是 `SameSite=Strict` 且绑定地址端口,手机 WebView 的内嵌页面属跨站上下文、cookie 根本不会随请求发出,所以「把登录链接发给手机打开」这条路在浏览器规则下走不通,注入只能发生在电脑侧。

- 继续兼容 dsh 0.1.0-rc.7 / rc.8:旧版没有浏览器认证,代理保持原样透传,行为不变。

## 0.1.8

### 修复

- **iOS:连接成功但界面空白**。iOS 的 App Transport Security 默认禁止 WebView 加载明文 HTTP,而手机端的界面正是从本机代理出口 `http://127.0.0.1:<端口>` 加载的。安卓侧一直有对应配置放行回环流量,iOS 侧没有。iroh 连接是原生代码不受 ATS 约束,所以「显示已连接」与「界面空白」会同时出现。

  现只放行回环、`.local` 与链路本地地址(`NSAllowsLocalNetworking`),其余域仍受 ATS 约束——与安卓侧只放行 `127.0.0.1` / `localhost` 的做法一致。

  由用户反馈发现。**本修复未在 iOS 真机验证**,若仍有问题请在 issue 里补充电脑侧终端的完整输出。

### 新增

- 手机第一次开始加载界面时,电脑侧会打印「手机已开始加载界面」。此前电脑侧对代理流完全静默,「连上却空白」无从判断是手机压根没发请求,还是发了但转发不通。

## 0.1.7

### 元数据

- **补上 `repository`、`homepage`、`bugs`、`author`**。主包与五个平台子包此前在 npm 上都没有仓库链接,`npm view repository` 为空——包页面上看不到出处。插件目录站按 `repository` 回链核实包与仓库的对应关系,缺这个字段就建立不起对应。
- **描述与关键词改为覆盖真实搜索词**。原描述里没有 Android、iOS、mobile、remote 这些词,而目录站的搜索匹配的正是描述文本:实测搜 `phone`、`手机` 能命中,搜 `android`、`mobile`、`远程` 则排不进前列。

本版无代码变更。

## 0.1.6

### 安全

- **身份密钥与配对白名单改为仅属主可读**。此前这些文件以默认权限写入,在 Unix 上通常是 `0644`——同一台机器上任何本地用户都能读到 `identity.key`(32 字节裸私钥),读到即可冒充主机、给自己签发配对码,从而取得对 dsh 界面的完整访问权。

  这比此前文档中已说明的边界更宽:那条边界要求攻击者能在机器上执行代码,而本问题**只需读权限**。

  受影响的是 Linux 与 macOS;Windows 无 POSIX 权限位,不受影响。**升级即修复**:程序在读取既有密钥时会一并收紧权限,不需要重新配对,主机身份也不会变。

  由 [@kagura-agent](https://github.com/kagura-agent) 报告([#1](https://github.com/zexadev/dsh-tether/issues/1))。

### 修复

- **私密文件改为原子写**。此前是就地截断再写,写入过程中掉电或进程被杀会留下半截文件;对 `identity.key` 而言等同于主机身份丢失,所有已配对的手机都需重新配对。现改为先写临时文件再 rename,目标文件要么是旧内容要么是新内容。

## 0.1.5

### 新增

- **iOS 客户端(测试版)**。Release 里新增 `dsh-tether-<版本>-ios-unsigned.ipa`,未签名,需要自行签名安装(AltStore、Sideloadly 等)。功能与安卓版一致:同样的 iroh 直连、同样显示 DSH 自己的完整界面、同样的配对流程。

  **请当作测试版对待。** 本项目没有 Mac,这个包只在 CI 上构建过,**从未在真机上运行**——能编译、结构正确、架构是 arm64 真机版,但装上去是否可用、连接与通知是否正常,一概未经验证。遇到任何问题请提 issue,附上 iOS 版本与签名方式,我按反馈修。

  自签的有效期取决于你的账号:免费 Apple ID 签的应用 7 天过期,付费开发者账号一年。

## 0.1.4

### 兼容性

- **确认支持 dsh `0.1.0-rc.8`**。已在 rc.8 环境下逐项核对本插件依赖的上游接触面:patch 引用的三个包名仍存在且 patch 实际生效(`--dump-config` 可见 `directory-picker` 已停用、两个 browse 条目已挂上);窄屏样式依赖的布局 class 未变;`sidebar.footer.action` 与 `settings.trigger` 两个插槽仍在;插件的三条 HTTP 路由均正常且跨站请求仍被拒。
- `peerDependencies` 由精确的 `0.1.0-rc.7` 放宽为 `>=0.1.0-rc.7`。此前的精确版本号会让 rc.8 用户在安装时收到 unmet peer 警告,而两个版本实测都可用。

## 0.1.3

### 新增

- **电脑端可以查看并移除已配对的手机**。侧栏「连接手机」弹出的配对串下方新增列表,显示每台手机的名字、ID 前 8 位与在线状态,可逐台移除。
  此前白名单只增不减,而手机每重装一次 App 就会生成一把新的身份密钥,旧的那把仍留在白名单里持有访问权,电脑端却没有任何入口能看见或撤销它们——只能手工编辑 `paired.json`。
  移除会同时断开该手机当前的连接:白名单只在握手时读取一次,若不主动断开,正连着的那台要等它自己下线才真正失效。
- 手机端「我的电脑」页脚的项目主页链接现在可用,由系统浏览器打开。此前该链接为空,不显示。

### 文档

- 补上 LINUX DO 社区链接与徽章。
- 32 位 APK 的实际文件名是 `arm` 而非 `armv7`,文档按实际产出更正。
- 移除配对章节中包含真实配对串的截图。

## 0.1.2

### 新增

- **APK 改为四个 CPU 架构全量构建**:`arm64`、`arm`、`x86`、`x86_64`。此前只构建 `aarch64`,而产物却被命名为 `universal`——那是「不按 ABI 拆分」这个构建变体的名字,不代表包含所有架构;解包可见其中只有 `arm64-v8a`。
- APK 文件名改为 `dsh-tether-<版本>-<架构>.apk`,此前是不含版本号的 `app-universal-release.apk`。

### 移除

- 删除 `dsh-tunnel`——插件化之前的独立隧道原型,其能力已由 `tether-host --proxy-target` 覆盖。

## 0.1.1

### 新增

- **新增 `linux-arm64` 平台子包**。主包的 `optionalDependencies` 本已声明五个平台,构建矩阵却只产出四个;缺失的那个按 npm 的可选依赖语义被静默跳过,安装期毫无提示,直到运行时才会发现找不到二进制。
- 打 tag 时自动发布到 npm,先发平台子包再发主包。

## 0.1.0

首个发布版本。

- DeepSeek Harness 插件 + Android App,通过 iroh P2P 直连,中间不经过任何服务器。
- 手机上显示的是 DSH 自身的完整 Web 界面,窄屏下注入最小样式适配(侧栏改抽屉、设置页导航横排)。
- 6 位配对码,10 分钟有效,每窗口 3 次尝试上限;配对后凭手机的 iroh 公钥授权。
- 手机端可保存多台电脑并切换;agent 等待审批时推送系统通知。
- 平台子包覆盖 win32-x64、darwin-x64、darwin-arm64、linux-x64。
