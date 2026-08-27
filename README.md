<h1 align="center">DSH Tether</h1>

<p align="center">
  <strong>Use the DeepSeek Harness on your dev machine, from your phone.</strong><br>
  Across networks, peer to peer, through no server at all.<br>
  No relay to configure, no shared Wi-Fi, no Linux on your phone.
</p>

<p align="center"><sub>An independent community project. Not affiliated with, partnered with, authorised by, or endorsed by DeepSeek.<br>No DeepSeek employee or upstream DeepSeek Harness team member is involved in this repository.<br><a href="README.zh.md">中文</a> · English</sub></p>

<p align="center">
  <img src="assets/banner.jpg" alt="Phone tethered directly to a dev machine — no server in between" width="100%">
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/zexadev/dsh-tether?style=flat&label=release&color=4D6BFE" alt="Latest release"></a>
  <a href="../../releases"><img src="https://img.shields.io/github/downloads/zexadev/dsh-tether/total?style=flat&label=downloads&color=4D6BFE" alt="Downloads"></a>
  <a href="../../stargazers"><img src="https://img.shields.io/github/stars/zexadev/dsh-tether?style=flat&label=%E2%98%85&color=08C" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.0--rc.7%20%7C%20rc.8-4D6BFE?style=flat" alt="dsh 0.1.0-rc.7 | rc.8">
  <img src="https://img.shields.io/badge/Android-4493F8?style=flat" alt="Android">
  <img src="https://img.shields.io/badge/iOS-beta-8E8E93?style=flat" alt="iOS beta">
  <a href="https://www.dsh.so/artifact/dsh-tether"><img src="https://www.dsh.so/badge/dsh-tether.svg" alt="dsh.so security scan"></a>
  <a href="https://www.dsh.so/artifact/dsh-tether"><img src="https://www.dsh.so/badge/install/dsh-tether.svg" alt="dsh.so install check"></a>
</p>

<p align="center">
  <img src="assets/phone-cellular.png" width="240" alt="A DSH session on the phone">
  <img src="assets/phone-sidebar-drawer.png" width="240" alt="The sidebar as an overlay drawer">
  <img src="assets/phone-settings.png" width="240" alt="Settings laid out for a phone">
</p>

DSH Tether carries the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web interface to your phone over a direct peer-to-peer connection. The agent keeps running on the machine your code lives on, and the phone gets DSH's own full interface — conversations, tool calls, approvals and settings, not a reimplementation of them. Pair once with a 6-digit code; after that the two ends find each other whatever network they are on.

## The case it solves

**You are not on your machine's network, and you do not want a server in the middle.**

Reaching your own dev machine from a phone usually asks for one of two things: both ends on the same LAN, or a relay you deploy, configure and trust. This asks for neither. The two ends hole-punch to each other through [iroh](https://www.iroh.computer/), and once they do, nothing passes through a third party; the fallback relay only ever carries ciphertext it cannot read.

If you only use your phone on the same Wi-Fi as your machine, you don't need any of this — a LAN setup is simpler.

## Download and install

| Where | Download | How |
| --- | --- | --- |
| Machine | — | `dsh plugin --profile web add dsh-plugin-tether` |
| Phone | `dsh-tether-<version>-arm64.apk` from the [Release](../../releases/latest) | Signed — install it directly |
| Phone (iOS) | `dsh-tether-<version>-ios-unsigned.ipa` from the [Release](../../releases/latest) | **Beta**, unsigned — sign it yourself |

The plugin carries a small Rust sidecar that owns the iroh connection, shipped as one package per platform; installing pulls only the one matching your system, with nothing to choose.

The phone build is split by CPU architecture. **Any Android phone from the last decade takes `arm64`**; `arm` is for 32-bit legacy devices, and `x86` / `x86_64` are for emulators and ChromeOS. Picking the wrong one simply gets refused at install time.

The iOS build is **beta**: this project has no Mac, so the package is only ever built in CI and has never run on a real device. You sign it yourself with AltStore, Sideloadly or similar (a free Apple ID expires after 7 days). Please open an issue if you hit anything.

You can also build the sidecar from source (needs Rust):

```sh
git clone https://github.com/zexadev/dsh-tether && cd dsh-tether
cargo build --release -p tether-host
dsh plugin --profile web add .
```

## Pair

Start `dsh web` as you normally would, then click **Connect phone** at the bottom of the sidebar. You get one line to copy:

On the phone, open DSH Tether → **Add computer** → paste that whole line → name the computer → connect.

From then on the app connects by itself when you open it.

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Direct across networks</h3>
      <p>The two ends hole-punch to each other through iroh, and once connected nothing passes through a third party. Phone on 4G/5G and machine on home broadband works — no public IP, no tunnel service, no relay of your own. Only a failed hole-punch falls back to a relay, which carries ciphertext it cannot read.</p>
    </td>
    <td width="50%" valign="top">
      <h3>DSH's own interface</h3>
      <p>What runs on your phone is DSH's own web interface, not a reimplementation: conversations, tool calls, approvals and settings are all there. Narrow screens get adjustments — the sidebar becomes an overlay drawer, the settings dialog puts its navigation on top, and content takes the full width.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Several machines</h3>
      <p><em>My computers</em>, at the bottom of the phone's sidebar, keeps every machine you have paired: switch, rename, remove, or add another. Changing machines never means re-entering credentials, and <em>Connect phone</em> on the computer mints a fresh code any time.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Approval notifications</h3>
      <p>When the agent is waiting on your approval, the phone raises a system notification. You approve inside DSH's own interface — this plugin deliberately does not answer approvals for you; it only carries "it's waiting for you" to your lock screen.</p>
    </td>
  </tr>
</table>

## Security

- Pairing is a 6-digit CSPRNG code, valid 10 minutes, 3 attempts per window. After pairing, access is granted by the phone's iroh public key, which iroh's TLS verifies and nobody can forge.
- An unpaired peer cannot reach your interface: proxy streams are only served on a connection that already completed the control-stream handshake, and an unpaired connection may send at most 512 bytes before being rejected.
- Traffic is end-to-end encrypted by iroh (QUIC/TLS). When hole-punching succeeds it touches no third party; when it falls back, the relay only carries ciphertext it cannot read.
- The plugin's own two HTTP routes apply the same browser-trust rules dsh applies to `/api`: the `Host` must be a loopback authority, an explicit cross-site marker is refused, and an attached `Origin` must match the Host. Cross-site requests from a malicious page and DNS-rebinding attempts both get a 403.
- **Known limit**: those rules stop a browser from being used as a confused deputy; they do **not** stop a local process. A local process presents a loopback `Host`, so it can mint a pairing code and pair itself as a "phone" — meaning **an attacker who can already run code on your dev machine can turn that into long-term access**. Don't run this plugin on a machine where you run untrusted code.

## Known limitations

- The iOS build is beta: built only in CI, never run on a real device, and you sign it yourself. Android is the one verified on real hardware.
- The app connects when you open it and holds no background connection — Android's doze would not let it anyway.
- The interface on the phone is DSH's own; the narrow-screen fit comes from minimal injected styles, so a dsh layout change may need a follow-up here.
- Verified against dsh **`0.1.0-rc.7`** and **`0.1.0-rc.8`**. dsh is in developer preview — check this line before assuming a newer dsh works.

## What has been verified

Direct cross-network connection is the whole point of the project, so here is the evidence rather than the claim. With the phone's Wi-Fi off and only 5G, and the machine on home broadband, the plugin reported a public address on the selected path — meaning the two ends punched through to each other and the relay was never used. The first screenshot above is the phone rendering DSH over that path; note the absent Wi-Fi icon in its status bar.

Pairing (including a wrong code being refused), approval delivery, and switching between saved machines were all verified on a real device. **The relay fallback has not yet been triggered on a real network.**

## Relationship to DeepSeek Harness

<p align="center"><img src="assets/dsh-mark.svg" height="36" alt="DeepSeek Harness"></p>

DSH Tether is an independent community project built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and its Cordis plugin mechanism. It **does not modify upstream source**: a pinned dsh runs unmodified, and this project joins it as an ordinary DSH plugin using only officially published extension points.

This repository is maintained independently by the community. It is not affiliated with, partnered with, authorised by, or endorsed by DeepSeek, and no DeepSeek employee or upstream team member is involved in its development, maintenance or governance. The DeepSeek Harness mark used in this README identifies the upstream this project serves; it does not imply any authorisation or endorsement. The phone app icon derives from that same upstream mark.

Upstream provides the agent capabilities, the plugin system and the web interface. This project provides:

- the peer-to-peer connection and pairing between machine and phone
- carrying that web interface to the phone, with a narrow-screen fit
- multi-machine management and system notifications on the phone

## Building from source

Needs Node ^22.19 || >=24 and Rust; building the APK also needs JDK 21 and the Android SDK/NDK (`scripts/setup-android-env.ps1` sets that up on Windows).

```sh
cargo build --release -p tether-host          # the machine-side sidecar
cd app && pnpm install
pnpm exec tauri android build --apk --target aarch64
```

## License

MIT

## Links

- [LINUX DO](https://linux.do) — where this project is shared

<p align="center">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/%E7%A4%BE%E5%8C%BA-LINUX%20DO-4D6BFE?style=for-the-badge" alt="LINUX DO"></a>
</p>
