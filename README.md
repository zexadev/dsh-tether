<p align="center"><img src="assets/banner.jpg" alt="Phone tethered directly to a dev machine — no server in between" width="800"></p>

<h1 align="center">DSH Tether</h1>

<p align="center">
  <img src="assets/dsh-mark.svg" height="16" align="top" alt="">
  A third-party community project for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> · not official
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-0f1115?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/dsh-0.1.0--rc.7-8FA6F0?style=flat-square" alt="dsh 0.1.0-rc.7">
  <img src="https://img.shields.io/badge/Android-8+-81858c?style=flat-square" alt="Android">
</p>

[中文](README.zh.md)

**Use the DeepSeek Harness on your dev machine from your phone. Across networks, through no server at all.**

The agent keeps running on the machine your code lives on. Your phone gets DSH's own full interface, delivered over a direct P2P connection — pair once with a 6-digit code, and after that the two ends find each other whatever network they are on.

## The case it solves

**You are not on your machine's network, and you do not want a server in the middle.**

Reaching your own dev machine from a phone usually asks for one of two things: both ends on the same LAN, or a relay you deploy, configure and trust. This asks for neither. The two ends hole-punch to each other through [iroh](https://www.iroh.computer/), and once they do, nothing passes through a third party; the fallback relay only ever carries ciphertext it cannot read.

If you only use your phone on the same Wi-Fi as your machine, you don't need any of this — a LAN setup is simpler.

## What it looks like

<p align="center">
  <img src="assets/phone-cellular.png" width="240" alt="A DSH session on the phone">
  <img src="assets/phone-sidebar-drawer.png" width="240" alt="The sidebar as an overlay drawer">
  <img src="assets/phone-settings.png" width="240" alt="Settings laid out for a phone">
</p>

What runs on your phone is DSH's own interface, not a reimplementation of it: conversations, tool calls, approvals and settings are all there. Narrow screens get adjustments — the sidebar becomes an overlay drawer, the settings dialog puts its navigation on top, and content takes the full width.

## Install

### 1. The plugin, on your machine

```sh
dsh plugin --profile web add github:zexadev/dsh-tether
```

The plugin carries a small Rust sidecar that owns the iroh connection. **Platform binaries currently ship with each [Release](../../releases) and are not on npm yet**, so add the one for your platform too — download `dsh-tether-host-<platform>-<version>.tgz`, then:

```sh
dsh plugin --profile web add ./dsh-tether-host-win32-x64-0.1.0.tgz
```

Or build it from source (needs Rust):

```sh
git clone https://github.com/zexadev/dsh-tether && cd dsh-tether
cargo build --release -p tether-host
dsh plugin --profile web add .
```

### 2. The app, on your phone

Download `app-universal-release.apk` from the [Release](../../releases). It is signed; install it directly.

### 3. Pair

Start dsh as you normally would:

```sh
dsh web
```

At the bottom of the sidebar, click **Connect phone**. You get one line to copy:

<p align="center"><img src="assets/pc-pairing.png" width="560" alt="The pairing string, shown on the computer"></p>

On the phone, open DSH Tether → **Add computer** → paste that whole line → name the computer → connect.

From then on the app connects by itself when you open it.

## New phone, second device

**Connect phone** in the computer's sidebar mints a fresh pairing code any time; it is valid for 10 minutes.

**My computers** at the bottom of the phone's sidebar is your own page: every computer you have paired lives there, and you can switch, rename, remove, or add another — changing machines never means re-entering credentials.

<p align="center"><img src="assets/phone-hosts.png" width="240" alt="The saved computers list on the phone"></p>

## Notifications

When the agent is waiting on your approval, the phone raises a system notification. You approve inside DSH's own interface — this plugin deliberately does not answer approvals for you; it only carries "it's waiting for you" to your lock screen, which is the one thing a web page in your pocket cannot do for itself.

## Security

- Pairing is a 6-digit CSPRNG code, valid 10 minutes, 3 attempts per window. After pairing, access is granted by the phone's iroh public key, which iroh's TLS verifies and nobody can forge.
- An unpaired peer cannot reach your interface: proxy streams are only served on a connection that already completed the control-stream handshake, and an unpaired connection may send at most 512 bytes before being rejected.
- Traffic is end-to-end encrypted by iroh (QUIC/TLS). When hole-punching succeeds it touches no third party; when it falls back, the relay only carries ciphertext it cannot read.
- The plugin's own two HTTP routes apply the same browser-trust rules dsh applies to `/api`: the `Host` must be a loopback authority, an explicit cross-site marker is refused, and an attached `Origin` must match the Host. Cross-site requests from a malicious page and DNS-rebinding attempts both get a 403.
- **Known limit**: those rules stop a browser from being used as a confused deputy; they do **not** stop a local process. A local process presents a loopback `Host`, so it can mint a pairing code and pair itself as a "phone" — meaning **an attacker who can already run code on your dev machine can turn that into long-term access**. Don't run this plugin on a machine where you run untrusted code.

## Known limitations

- Android only. iOS is not planned for now.
- The app connects when you open it and holds no background connection — Android's doze would not let it anyway.
- The interface on the phone is DSH's own; the narrow-screen fit comes from minimal injected styles, so a dsh layout change may need a follow-up here.
- Verified against dsh **`0.1.0-rc.7`**. dsh is in developer preview — check this line before assuming a newer dsh works.

## What has been verified

Direct cross-network connection is the whole point of the project, so here is the evidence rather than the claim. With the phone's Wi-Fi off and only 5G, and the machine on home broadband, the plugin reported:

```
[tether] 手机已连接: 我的手机
[tether] 连接路径: P2P 直连(NAT 打洞成功) Ip(…:41341)
```

A public address on the selected path means the two ends punched through to each other; the relay was never used. The first screenshot above is the phone rendering DSH over that path — note the absent Wi-Fi icon in its status bar.

Pairing (including a wrong code being refused), approval delivery, and switching between saved computers were all verified on a real device. **The relay fallback has not yet been triggered on a real network.**

## Building from source

Needs Node ^22.19 || >=24 and Rust; building the APK also needs JDK 21 and the Android SDK/NDK (`scripts/setup-android-env.ps1` sets that up on Windows).

```sh
cargo build --release -p tether-host          # the machine-side sidecar
cd app && pnpm install
pnpm exec tauri android build --apk --target aarch64
```

## License

MIT
