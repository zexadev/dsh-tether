---

### 下载说明

- **电脑端插件**:不用在这里下。在 dsh 的插件页添加 `dsh-plugin-tether`(npm 包),对应平台的 sidecar 会一起装好。下面的 `dsh-tether-host-*.tgz` 是同一份 npm 子包,一般用不到。
- **Android**:大多数手机选 `dsh-tether-{version}-arm64.apk`,只有它带本地模式(在手机上直接跑 dsh)。32 位老手机选 `arm`,模拟器选 `x86_64` / `x86`。国内下载慢可以去 [官网](https://dsh-tether.zexa.cc) 下。已装 0.1.32 及以上的,在 App「关于 → 检查更新」里就能直接更新。
- **iOS(测试版)**:`dsh-tether-{version}-ios-unsigned.ipa` 是未签名包,可以用 TrollStore 直接装,或用 AltStore、Sideloadly 等工具自签(免费 Apple ID 签的 7 天过期)。本项目没有 iPhone,ipa 只在 CI 上构建过、没有在真机上验证;装不上或闪退请提 issue 并附上崩溃日志。

### Downloads

- **Desktop plugin**: nothing to download here. Add `dsh-plugin-tether` (npm) from dsh's Plugins page and the sidecar for your platform comes with it. The `dsh-tether-host-*.tgz` files below are the same npm sub-packages; you normally don't need them.
- **Android**: most phones want `dsh-tether-{version}-arm64.apk`, the only build with local mode (running dsh on the phone itself). Older 32-bit phones take `arm`, emulators `x86_64` / `x86`. The [website](https://dsh-tether.zexa.cc) has the same files. From 0.1.32 on, About → Check for updates in the app updates it in place.
- **iOS (beta)**: `dsh-tether-{version}-ios-unsigned.ipa` is unsigned. Install it with TrollStore, or sign it yourself with AltStore, Sideloadly or similar (apps signed with a free Apple ID expire after 7 days). This project has no iPhone: the ipa is only built in CI and has never been run on a real device. If it won't install or crashes, please open an issue with the crash log.
