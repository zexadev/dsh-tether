/**
 * 从 CHANGELOG.md 取出某个版本那一节,接上 .github/release-footer.md 的下载说明,作为 Release 说明。
 * 取不到就以非零码退出——宁可让流水线红,也不要发一个说明为空的 Release。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
  console.error('用法: node scripts/changelog-section.mjs <版本号> [输出文件]')
  process.exit(1)
}
const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const lines = text.split(/\r?\n/)
const at = lines.findIndex((l) => l.trim() === `## ${version}`)
if (at === -1) {
  console.error(`CHANGELOG.md 里没有 "## ${version}" 这一节`)
  process.exit(1)
}
const rest = lines.slice(at + 1)
const until = rest.findIndex((l) => l.startsWith('## '))
const body = rest.slice(0, until === -1 ? rest.length : until).join('\n').trim()
if (body === '') {
  console.error(`"## ${version}" 这一节是空的`)
  process.exit(1)
}
// 每版都一样的下载说明(选哪个包、ipa 怎么装)接在后面;CHANGELOG 只写这一版变了什么
const footer = readFileSync(new URL('../.github/release-footer.md', import.meta.url), 'utf8')
  .replaceAll('{version}', version)
  .trim()
const notes = `${body}\n\n${footer}\n`
const out = process.argv[3]
if (out) writeFileSync(out, notes)
else process.stdout.write(notes)
