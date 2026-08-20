<h1 align="center">DSH Tether</h1>

<p align="center">
  <strong>在手机上用你开发机里的 DeepSeek Harness。</strong><br>
  跨网络,点对点直连,中间不经过任何服务器。<br>
  不用配中转,不用同一个 WiFi,不用在手机上装 Linux。
</p>

<p align="center"><sub>独立的社区开源项目,与深度求索不存在隶属、合作、授权或背书关系。<br>本仓库无深度求索员工或 DeepSeek Harness 上游官方团队成员参与。<br>中文 · <a href="README.md">English</a></sub></p>

<p align="center">
  <img src="assets/banner.jpg" alt="手机与开发机直接相连,中间没有服务器" width="100%">
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/zexadev/dsh-tether?style=flat&label=release&color=4D6BFE" alt="最新版本"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/zexadev/dsh-tether/total?style=flat&label=downloads&color=4D6BFE" alt="下载量"></a>
  <a href="../../stargazers"><img src="https://img.shields.io/github/stars/zexadev/dsh-tether?style=flat&label=%E2%98%85&color=08C" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.0--rc.7-4D6BFE?style=flat" alt="dsh 0.1.0-rc.7">
  <img src="https://img.shields.io/badge/Android-4493F8?style=flat" alt="Android">
</p>

<p align="center">
  <img src="assets/phone-cellular.png" width="240" alt="手机上的 DSH 会话界面">
  <img src="assets/phone-sidebar-drawer.png" width="240" alt="侧栏以抽屉方式覆盖">
  <img src="assets/phone-settings.png" width="240" alt="设置页按手机版式重排">
</p>

DSH Tether 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 界面通过点对点直连带到手机上。agent 依旧跑在你代码所在的那台电脑,手机拿到的是 DSH 自己的完整界面——会话、工具调用、审批、设置全都在,不是另做一套。用 6 位码配对一次,之后两端在哪个网络都能互相找到。

## 它解决什么

**你不在电脑那个网络里,又不想中间有一台服务器。**

手机连回自己开发机,常见做法要么要求两端在同一个局域网,要么要求你部署并信任一台中转。这个项目两样都不要:两端靠 [iroh](https://www.iroh.computer/) 直接打洞,打通后流量不经过任何第三方;打不通才退回 relay,而 relay 上过的也只是它读不懂的密文。

如果你只在和电脑同一个 WiFi 下用手机,你并不需要这些——局域网方案更简单。

## 下载与安装

| 装在哪 | 下载 | 安装方式 |
| --- | --- | --- |
| 电脑 | — | `dsh plugin --profile web add dsh-plugin-tether` |
| 手机 | [Release](../../releases/latest) 里的 `app-universal-release.apk` | 已签名,直接安装 |

插件带一个 Rust 写的 sidecar 负责 iroh 连接,按平台拆成独立子包;安装时只会下载与你系统匹配的那一个,不用手动选。

也可以从源码构建 sidecar(需要 Rust):

```sh
git clone https://github.com/zexadev/dsh-tether && cd dsh-tether
cargo build --release -p tether-host
dsh plugin --profile web add .
```

## 配对

电脑上照常启动 `dsh web`,在侧栏底部点**「连接手机」**,会给出一行配对串:

<p align="center"><img src="assets/pc-pairing.png" width="620" alt="电脑上出示配对串"></p>

手机上打开 DSH Tether →「添加电脑」→ 把那一整行粘进去 → 给这台电脑起个名字 → 连接。

之后每次打开 App 自动连上,不用再配对。

## 主要功能

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>跨网直连</h3>
      <p>两端靠 iroh 直接打洞,打通后流量不经过任何第三方。手机在 4G/5G、电脑在家宽也能连上,不需要公网 IP、内网穿透或自建中转。打洞失败才退回 relay,而 relay 上过的只是它读不懂的密文。</p>
    </td>
    <td width="50%" valign="top">
      <h3>完整的 DSH 界面</h3>
      <p>手机上跑的就是 DSH 自己的 Web 界面,不是另做一套:会话、工具调用、审批、设置一个不少。窄屏下做了适配——侧栏改成抽屉覆盖、设置页导航横排、内容占满整宽。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>多台电脑</h3>
      <p>手机侧栏底部的「我的电脑」里,配过的电脑都留着,可以切换、改名、删除,也能添加新的。换一台不用重新填凭证。电脑侧栏的「连接手机」随时能出新的配对码。</p>
    </td>
    <td width="50%" valign="top">
      <h3>审批通知</h3>
      <p>agent 卡在等你批准时,手机会推一条系统通知。批准本身在 DSH 自己的界面里点——本插件刻意不代答审批,只把「它在等你」送到锁屏上。</p>
    </td>
  </tr>
</table>

## 安全

- 配对码是 6 位随机数(CSPRNG),10 分钟有效,每个窗口只许试 3 次。配对之后凭手机的 iroh 公钥授权,那是 TLS 验证过的,伪造不了。
- 未配对方够不到你的界面:代理流只在完成控制流握手的连接上提供,未配对连接首行最多 512 字节就被拒。
- 流量由 iroh 端到端加密(QUIC/TLS)。打洞成功时不经过任何第三方;退回 relay 时,relay 上过的也只是它读不懂的密文。
- 插件自己那两条 HTTP 路由套了与 dsh `/api` 同一套浏览器信任判据:Host 必须是回环权威,跨站标记一律拒,带 Origin 时必须与 Host 同源。恶意网页的跨站请求和 DNS 重绑定都会拿到 403。
- **已知边界**:上面那套判据防的是浏览器被当枪使,**挡不住本机进程**。本机进程的 Host 就是回环,能取到一个配对码,进而把自己配成一台「手机」。也就是说,**已经能在你开发机上执行代码的攻击者,可以借此拿到长期访问权**。若你的机器上会跑不受信任的代码,别用这个插件。

## 已知限制

- 只有 Android。iOS 暂不做。
- App 打开时才连接,不在后台常驻——Android 的 doze 也留不住它。
- 手机上的界面是 DSH 自己的,窄屏适配靠注入的最小样式完成;dsh 改版式时可能需要跟进。
- 已针对 dsh **`0.1.0-rc.7`** 验证。dsh 处于 developer preview,换更新的 dsh 之前先看这一行。

## 验证过什么

跨网直连是这个项目的立意,所以给证据而不是给说法。手机关掉 WiFi 只走 5G、电脑在家宽,插件侧输出:

```
[tether] 手机已连接: 我的手机
[tether] 连接路径: P2P 直连(NAT 打洞成功) Ip(…:41341)
```

选中路径是公网地址,说明两端是打洞打通的,relay 全程没用上。上面第一张截图就是手机在这条路径上渲染的 DSH 界面——状态栏没有 WiFi 图标。

配对(含错码被拒)、审批送达、多设备切换都在真机上验证过。**打洞失败退回 relay 这条路径,尚未在真实网络下触发过。**

## 与 DeepSeek Harness 的关系

<p align="center"><img src="assets/dsh-mark.svg" height="36" alt="DeepSeek Harness"></p>

DSH Tether 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 Cordis 插件机制构建的独立社区项目。它**不修改上游源码**:固定版本的 dsh 原样运行,本项目作为一个普通 DSH 插件接入,只依赖官方公开的扩展点。

本仓库由社区独立维护,与深度求索不存在隶属、合作、授权或背书关系,也无深度求索员工或上游官方团队成员参与开发、维护或治理。README 中使用的 DeepSeek Harness 标识仅用于说明本项目服务于该上游,不代表任何授权或背书关系;手机应用图标同样取自该上游标识。

上游提供智能体能力、插件系统和 Web 界面;本项目负责:

- 电脑与手机之间的点对点连接与配对
- 把上游的 Web 界面带到手机上,并做窄屏适配
- 手机端的多设备管理与系统通知

## 从源码构建

需要 Node ^22.19 || >=24、Rust;构建 APK 另需 JDK 21 与 Android SDK/NDK(Windows 上可用 `scripts/setup-android-env.ps1` 装齐)。

```sh
cargo build --release -p tether-host          # 电脑侧 sidecar
cd app && pnpm install
pnpm exec tauri android build --apk --target aarch64
```

## 许可证

MIT
