# 更新日志

本文件记录面向用户的变化。每个版本的这一节会原样作为该版本 Release 的说明。

## 0.1.11

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
