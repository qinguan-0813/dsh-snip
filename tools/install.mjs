#!/usr/bin/env node
/**
 * dsh-snip 安全安装器（本地目录 → DSH profile）。
 *
 * 为什么不用 `npm install` / pnpm：
 *   本插件通常用 **junction** 装在 profile 的 node_modules 里（改源码即时生效）。
 *   而 pnpm 一旦跑起来，会按 manifest 重建 node_modules ——
 *   把用户手做的 junction（比如别的本地开发插件）一起冲掉。
 *
 * 这个脚本只做四件事，每一步都可回退：
 *   1. 备份 profile 的 package.json / cordis.patch.yml 到带时间戳的目录
 *   2. 把包放进 node_modules（默认复制；--link 用 junction）
 *   3. 改 profile 的 package.json：dependencies + dsh.profile.bundles
 *   4. 三层校验：字节无 BOM / JSON 可解析 / 每个 js 文件 node --check
 *
 * 用法：
 *   node tools/install.mjs                      # 装当前目录，默认复制
 *   node tools/install.mjs --link               # 装当前目录，用 junction
 *   node tools/install.mjs --profile <profileDir>
 *
 * 卸载：把 node_modules/<包名> 删掉，并从 profile 的 package.json 里
 *       去掉 dependencies 与 dsh.profile.bundles 里的对应条目
 *       （脚本会打印一行现成的回滚命令）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const srcDir = path.resolve(valueOf('--src', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')))
const profile = path.resolve(valueOf('--profile', process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')))
const useLink = flag('--link')

const log = (...a) => console.log(...a)
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1) }

const srcManifestPath = path.join(srcDir, 'package.json')
if (!fs.existsSync(srcManifestPath)) fail(`找不到包清单：${srcManifestPath}`)
const srcManifest = JSON.parse(fs.readFileSync(srcManifestPath, 'utf8'))
if (!srcManifest.dsh?.bundle?.patch) fail('这个目录不是 DSH 组合包（package.json 里没有 dsh.bundle.patch）')
const pkgName = srcManifest.name
const version = srcManifest.version

const manifestPath = path.join(profile, 'package.json')
const patchPath = path.join(profile, 'cordis.patch.yml')
if (!fs.existsSync(manifestPath)) fail(`找不到 profile 清单：${manifestPath}（用 --profile 指定）`)

const rawBytes = fs.readFileSync(manifestPath)
if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) fail('现有 profile package.json 带 BOM，先修它再装')
const manifest = JSON.parse(rawBytes.toString('utf8'))

log(`包      : ${pkgName}@${version}  (${srcDir})`)
log(`profile : ${profile}`)
log(`现有 bundles: ${JSON.stringify(manifest.dsh?.profile?.bundles ?? [])}`)

// 1. 备份
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupDir = path.join(profile, `_backup_${stamp}`)
fs.mkdirSync(backupDir, { recursive: true })
fs.copyFileSync(manifestPath, path.join(backupDir, 'package.json'))
if (fs.existsSync(patchPath)) fs.copyFileSync(patchPath, path.join(backupDir, 'cordis.patch.yml'))
log(`✅ 备份到 ${backupDir}`)

// 2. 放进 node_modules
const target = path.join(profile, 'node_modules', pkgName)
if (fs.existsSync(target)) {
  log(`   目标已存在，先删：${target}`)
  fs.rmSync(target, { recursive: true, force: true })
}
if (useLink) {
  execFileSync('cmd', ['/c', 'mklink', '/J', target, srcDir], { stdio: 'pipe' })
  log(`✅ junction: ${target} -> ${srcDir}`)
} else {
  fs.cpSync(srcDir, target, { recursive: true })
  log(`✅ 复制到 ${target}`)
}
const installed = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
if (installed.name !== pkgName) fail(`装进去的包名不符：${installed.name} != ${pkgName}`)

// 3. 改 profile 清单（Node 写 = 天然无 BOM）
const next = structuredClone(manifest)
next.dependencies ??= {}
// 依赖登记用 file: 指向源码目录 —— 这样下次谁跑 pnpm 也不会去 registry 上找一个不存在的版本号
next.dependencies[pkgName] = `file:${srcDir.replace(/\\/g, '/')}`
next.dsh ??= {}
next.dsh.profile ??= {}
next.dsh.profile.bundles ??= []
if (!next.dsh.profile.bundles.includes(pkgName)) next.dsh.profile.bundles.push(pkgName)
const tmp = manifestPath + '.tmp'
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
fs.renameSync(tmp, manifestPath)
log('✅ profile package.json 已更新（dependencies + bundles）')

// 4. 三层校验
const after = fs.readFileSync(manifestPath)
if (after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf) {
  fs.copyFileSync(path.join(backupDir, 'package.json'), manifestPath)
  fail('写入后检出 BOM，已回滚')
}
log('   a. 字节层：无 BOM ✅')
try { JSON.parse(after.toString('utf8')) } catch (e) { fail('b. 语法层：' + e.message) }
log('   b. 语法层：JSON 可解析 ✅')

const require = createRequire(path.join(profile, 'noop.js'))
try { require.resolve(pkgName + '/package.json'); log('   c. 模块层：require.resolve ✅') }
catch (e) { log('   c. 模块层：require.resolve 警告 → ' + e.message) }

const jsFiles = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) jsFiles.push(p)
  }
}
walk(target)
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) }
  catch (e) { fail(`语法错误：${f}\n${e.stderr?.toString() ?? e.message}`) }
}
log(`   c. 模块层：${jsFiles.length} 个 js 文件 node --check 通过 ✅`)

log('')
log('最终 bundles: ' + JSON.stringify(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dsh.profile.bundles))
log('回滚：Copy-Item "' + path.join(backupDir, 'package.json') + '" "' + manifestPath + '" -Force')
log('装了之后：DSH 开着 HMR 时通常立刻生效；客户端半身若没出现，刷新一次页面。')
