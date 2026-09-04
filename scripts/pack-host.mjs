/**
 * 把当前平台(或 --target 指定的目标)的 tether-host 二进制打成一个可发布的平台子包。
 *
 * 结构照 dsh 自己的 @deepseek-ai/node-addon-landlock-run:主包用
 * optionalDependencies 列出各平台子包,子包声明 os/cpu,npm 只装匹配的那一个。
 *
 * 用法:
 *   node scripts/pack-host.mjs                     当前平台,读 target/release
 *   node scripts/pack-host.mjs --target aarch64-apple-darwin
 *
 * 产物在 packages/host-<platform>-<arch>/,可直接 npm publish。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/** Rust target triple → npm 的 os/cpu 值 */
const TARGETS = {
  'x86_64-pc-windows-msvc': { os: 'win32', cpu: 'x64', exe: 'tether-host.exe' },
  'x86_64-apple-darwin': { os: 'darwin', cpu: 'x64', exe: 'tether-host' },
  'aarch64-apple-darwin': { os: 'darwin', cpu: 'arm64', exe: 'tether-host' },
  'x86_64-unknown-linux-gnu': { os: 'linux', cpu: 'x64', exe: 'tether-host' },
  'aarch64-unknown-linux-gnu': { os: 'linux', cpu: 'arm64', exe: 'tether-host' },
  // Termux 的 Node 把 process.platform 报成 'android'(不是 'linux'),npm 的
  // os/cpu 字段就按这个值筛;二进制本身仍是普通 ELF,只是链的是 bionic 不是 glibc。
  'aarch64-linux-android': { os: 'android', cpu: 'arm64', exe: 'tether-host' },
}

const argTarget = process.argv.indexOf('--target')
const triple = argTarget === -1
  ? execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
  : process.argv[argTarget + 1]
const spec = TARGETS[triple]
if (spec === undefined) {
  console.error(`未知目标 ${triple};支持:\n  ${Object.keys(TARGETS).join('\n  ')}`)
  process.exit(1)
}

// 交叉编译时 cargo 把产物放在 target/<triple>/release,本机编译则在 target/release
const built = [
  join(root, 'target', triple, 'release', spec.exe),
  join(root, 'target', 'release', spec.exe),
].find((p) => existsSync(p))
if (built === undefined) {
  console.error(`没找到已构建的二进制,先跑:\n  cargo build --release -p tether-host --target ${triple}`)
  process.exit(1)
}

const name = `dsh-tether-host-${spec.os}-${spec.cpu}`
const out = join(root, 'packages', `host-${spec.os}-${spec.cpu}`)
mkdirSync(join(out, 'bin'), { recursive: true })
copyFileSync(built, join(out, 'bin', spec.exe))
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name,
  version,
  description: `tether-host sidecar binary for ${spec.os}-${spec.cpu}`,
  license: 'MIT',
  // 目录站按 repository 回链来核实包与仓库的对应关系;缺了这个字段,
  // 包在 npm 上就是一个没有出处的二进制,谁也无从判断它从哪来。
  repository: { type: 'git', url: 'git+https://github.com/zexadev/dsh-tether.git' },
  homepage: 'https://dsh-tether.zexa.cc/',
  bugs: { url: 'https://github.com/zexadev/dsh-tether/issues' },
  author: 'zexadev',
  os: [spec.os],
  cpu: [spec.cpu],
  files: ['bin/'],
}, null, 2)}\n`)
writeFileSync(join(out, 'README.md'), `# ${name}\n\n\`dsh-plugin-tether\` 的 ${spec.os}-${spec.cpu} sidecar 二进制。不要单独安装,它由主包按平台自动引入。\n`)

console.log(`已打包 ${name}@${version}`)
console.log(`  源: ${built}`)
console.log(`  出: ${out}`)
