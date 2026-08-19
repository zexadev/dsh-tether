# DSH Tether

[中文](README.zh.md)

**Reach the DeepSeek Harness running on your dev machine from your phone — across networks, through no server at all. No relay to configure, no shared Wi-Fi, no Termux.**

Your agent keeps running where your code is. The phone gets the real thing: DSH's own web UI, over a direct P2P connection ([iroh](https://www.iroh.computer/): NAT hole-punching, with relay only as a fallback). Pair once with a 6-digit code; after that your phone and your machine find each other wherever they are.

> Status: working, early. Cross-network use is verified for the transport; see [Verified](#verified) for exactly what has and has not been tested.

## How it differs

Nine mobile clients exist for DSH. Two are worth your attention besides this one, and you should know when to prefer them:

- **[sorsama/deepseek-harness-mobile](https://github.com/sorsama/deepseek-harness-mobile)** — a polished Kotlin/Compose client with more features and 11 languages than this has. **If you only ever use your phone on the same Wi-Fi as your machine, use it instead.** Its own README scopes it to your local network.
- **[april-jk/dsh-mobile-plugin](https://github.com/april-jk/dsh-mobile-plugin)** — same plugin-shaped architecture, and it does work across networks. The difference is that it routes through a relay you must deploy, configure, and trust.

This one exists for the remaining case: **you are not on your machine's network, and you do not want a server in the middle.**

## How it works

```
[Android · Tauri 2]                          [your dev machine]
 WebView  ─── http://127.0.0.1:<port> ─┐      dsh web
 (DSH's own web UI)                    │       └─ dsh-plugin-tether
 iroh client ──── P2P, direct ─────────┴──────────  (Cordis plugin, embeds iroh)
```

The plugin is a normal DSH plugin: `dsh` itself runs unmodified, and the plugin joins through the official composition mechanism. It reads the web server's real listening port from `ctx.webServer`, so there is nothing to configure. Each TCP connection the phone opens becomes one stream on the same iroh connection, so the UI's HTTP requests and its WebSocket event downlinks multiplex without head-of-line blocking.

Approvals are answered by DSH's own web UI on your phone — this plugin deliberately does not claim them. It only observes them, so the app can raise a **system notification** when your agent is waiting on you, which is the one thing a web UI in your pocket cannot do for itself.

## Security

- Pairing is a 6-digit CSPRNG code, valid 10 minutes, 3 attempts per window. After pairing, the phone's iroh public key (verified by iroh's TLS, not forgeable) is what grants access.
- An unpaired peer cannot reach the proxy: proxy streams are only served on a connection that already completed the control-stream handshake, and an unpaired connection may send at most 512 bytes before being rejected.
- Traffic is end-to-end encrypted by iroh (QUIC/TLS) and, when hole-punching succeeds, never touches a third party. The fallback relay carries only ciphertext it cannot read.
- The app permits cleartext HTTP to `127.0.0.1` only — that is the local end of the tunnel, not the network.

## Install

Requires Node ^22.19 || >=24, Rust, and (for building the APK) JDK 21 + Android SDK/NDK. `scripts/setup-android-env.ps1` sets up the Android side on Windows.

```sh
cargo build --release -p tether-host       # the plugin's sidecar
dsh plugin --profile web add /path/to/dsh-tether/plugin
dsh web                                            # prints the pairing string
```

Build the phone app:

```sh
cd app && pnpm install
pnpm exec tauri android build --apk --target aarch64
```

Then open the app, paste the pairing string (`<host-id>#<code>`) from the `dsh web` output, and your machine's DSH appears on your phone.

## Verified

Tested against **dsh `0.1.0-rc.7`** (the ecosystem has split — the desktop client pins rc.7, april-jk pins rc.6; this one is rc.7).

| | |
|---|---|
| Pairing, wrong/right code, allowlist persistence | ✅ real device |
| Full DSH web UI rendered in the app | ✅ (`__DSH_BOOT__` present, live transcript) |
| WebSocket event downlink over iroh | ✅ 60s hold and 5min idle, identical to direct |
| HTTP latency / 20-way concurrency | ✅ 21ms, 20/20 |
| Approval reaches the phone, agent continues | ✅ real device |
| **Across networks (phone on 5G, Wi-Fi off ↔ PC on home broadband)** | ✅ **real device, hole-punched direct — no relay** |

The last row is the whole point of the project, so here is the evidence rather than a claim. With the phone's Wi-Fi switched off (`wifi_on=0`, only 5G in the status bar) and the machine on home broadband, the plugin reported:

```
[tether] 手机已连接: 我的手机
[tether] 连接路径: P2P 直连(NAT 打洞成功) Ip(152.67.154.117:41341)
```

A public address on the selected path means the two ends hole-punched through to each other; the relay was never used. (The phone also had a VPN on, so the peer address is its VPN exit — the point stands: two different networks, no server in between.) The phone rendered the full DSH web UI over that path — see [`assets/phone-cellular.png`](assets/phone-cellular.png).

## Known limitations

- Android only. iOS is not planned for now.
- The app connects when you open it; it does not hold a connection in the background (Android doze would kill it anyway).
- The debug APK is large because it keeps debug symbols; build `--release` for a normal-sized one.
- The web UI is DSH's desktop layout. It is usable on a phone but not adapted; adapting it means injecting minimal CSS, never rewriting DSH's interface.

## License

MIT
