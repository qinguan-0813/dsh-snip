/**
 * dsh-snip — 宿主半身。
 *
 * 职责很小：挂三条**只服务本机**的 HTTP 路由，把「抓一张屏幕 PNG」这件事
 * 交给 host/capture.ps1 去做，再把结果交回浏览器半身。
 *
 * 两条设计红线（都是踩过的坑换来的）：
 *
 * 1. **绝不碰窗口的尺寸/状态**。隐藏只用 SW_HIDE(0)、恢复只用 SW_SHOW(5)，
 *    不用 SW_RESTORE —— 后者的定义是「把最大化/全屏窗口还原成普通大小」，
 *    会让用户每截一次图就掉出全屏。
 *
 * 2. **PowerShell 的 stdout 只走 ASCII**。Windows PowerShell 5.1 用系统 ANSI 码页
 *    （简中 = GBK）写 stdout，而 Node 按 UTF-8 解；用户名或临时目录里只要有中文，
 *    路径回来就是乱码。所以脚本只回报 `OK <宽> <高> <x> <y> <是否隐藏>` 这种纯 ASCII，
 *    **输出路径由 Node 自己记着**，压根不从 PowerShell 那边取。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-snip'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'host', 'capture.ps1')
const WORK_DIR = join(tmpdir(), 'dsh-snip')
const PREFIX = '/api/dsh-snip'
const MAX_BODY = 64 * 1024
const SHELL_TIMEOUT = 25_000

/** 允许被界面覆盖并落盘的键（白名单：patch 里写错的键不会被界面写进磁盘） */
const SETTING_KEYS = ['hideWindow', 'screen']
const DEFAULTS = { hideWindow: false, screen: 'window', hotkey: 'Alt+A', powershell: '', debug: false }

let seq = 0

/* ──────────────────────────── 配置 ──────────────────────────── */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 用户的界面改动存在这儿；不写回 profile 的 YAML，免得手抖改坏启动配置 */
const settingsFile = () => join(dshHome(), 'dsh-snip.json')

function readSaved() {
  try {
    const text = readFileSync(settingsFile(), 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // 正式写出去的是 { version, values }；也容忍早期的扁平形状（手写/回退时会出现）
    const inner = parsed.values
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner
    return parsed
  } catch {
    return {}
  }
}

function writeSaved(values) {
  const path = settingsFile()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, values }, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)          // 原子替换：不会留下半个文件
}

/* ──────────────────────────── PowerShell ──────────────────────────── */

/** 探测解释器：只认**绝对路径**，存在才用（裸名会在没装的机器上 spawn ENOENT） */
function candidateShells(configured) {
  const list = []
  if (typeof configured === 'string' && configured.trim() !== '') list.push(configured.trim())
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const root = process.env.SystemRoot || 'C:\\Windows'
  list.push(
    join(pf, 'PowerShell', '7', 'pwsh.exe'),
    join(pf86, 'PowerShell', '7', 'pwsh.exe'),
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  )
  return list
}

function resolveShell(configured) {
  for (const path of candidateShells(configured)) {
    if (existsSync(path)) return path
  }
  // 最后的兜底：System32 一定在 PATH 上
  return 'powershell.exe'
}

function runShell(shell, args, log) {
  return new Promise((resolve, reject) => {
    const child = execFile(shell, args, {
      windowsHide: true,
      timeout: SHELL_TIMEOUT,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        // 超时/被杀：把已有输出带上，方便定位
        const tail = String(stderr || stdout || '').trim().slice(0, 300)
        reject(new Error(`${error.message}${tail ? ` | ${tail}` : ''}`))
        return
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        reject(new Error(`找不到 PowerShell 解释器：${shell}。可在插件配置里用 powershell: <绝对路径> 指定。`))
        return
      }
      reject(error)
    })
  })
}

/* ──────────────────────────── 抓屏 ──────────────────────────── */

async function capture(settings, log) {
  if (!existsSync(SCRIPT)) throw new Error(`抓屏脚本不在：${SCRIPT}`)
  mkdirSync(WORK_DIR, { recursive: true })
  seq += 1
  const out = join(WORK_DIR, `snip-${Date.now()}-${String(seq)}.png`)   // ← 路径由 Node 独占记忆
  const hide = settings.hideWindow === true
  const screen = ['window', 'primary', 'all'].includes(settings.screen) ? settings.screen : 'window'
  const shell = resolveShell(settings.powershell)

  const started = Date.now()
  const { stdout, stderr } = await runShell(shell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Out', out,
    '-Hide', hide ? '1' : '0',
    '-Screen', screen,
  ], log)
  const ms = Date.now() - started

  const line = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').pop() ?? ''
  if (!line.startsWith('OK ')) {
    const detail = line.startsWith('ERR ') ? line.slice(4) : (line || String(stderr).trim().slice(0, 300) || '没有输出')
    rmSync(out, { force: true })
    throw new Error(`抓屏失败：${detail}`)
  }
  const [, w, h, x, y, hidden] = line.split(/\s+/)
  const buf = readFileSync(out)
  rmSync(out, { force: true })                                          // 用完即焚，不留垃圾
  if (log && settings.debug === true) log.info(`抓屏 ${w}x${h} hide=${hidden} ${ms}ms`)

  return {
    ok: true,
    dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    width: Number(w),
    height: Number(h),
    x: Number(x),
    y: Number(y),
    hidOwn: hidden === '1',
    screen,
    elapsedMs: ms,
  }
}

/* ──────────────────────────── HTTP ──────────────────────────── */

function hostnameOf(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return null
  try { return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname } catch { return null }
}

/** 只服务本机：对端地址 + Host + Origin 全是回环才放行 */
function isLocalRequest(req) {
  const addr = String(req.socket?.remoteAddress ?? '')
  const okAddr = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!okAddr) return false
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
  const host = hostnameOf(req.headers?.host)
  const origin = hostnameOf(req.headers?.origin ?? req.headers?.referer)
  if (host !== null && !loopback.has(host)) return false
  if (origin !== null && !loopback.has(origin)) return false
  return true
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/* ──────────────────────────── 插件 ──────────────────────────── */

export function apply(ctx, config = {}) {
  const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-snip') : console
  const patchDefaults = {
    hideWindow: config.hideWindow === true,
    screen: ['window', 'primary', 'all'].includes(config.screen) ? config.screen : 'window',
    hotkey: typeof config.hotkey === 'string' ? config.hotkey : DEFAULTS.hotkey,
    powershell: typeof config.powershell === 'string' ? config.powershell : '',
    debug: config.debug === true,
  }
  /** 界面能看到的设置 = patch 默认值 + 用户在界面上改过的（仅白名单键） */
  const effective = () => {
    const saved = readSaved()
    const out = { ...patchDefaults }
    for (const key of SETTING_KEYS) {
      if (Object.hasOwn(saved, key)) out[key] = saved[key]
    }
    return out
  }

  if (!existsSync(SCRIPT)) log.warn?.(`抓屏脚本不在：${SCRIPT}`)
  else log.info?.(`就绪，PowerShell = ${resolveShell(patchDefaults.powershell)}`)

  const route = (path, handler) => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: `${PREFIX}${path}`, handler })
    ctx.effect(() => () => { try { dispose() } catch { /* 卸载时路由可能已经没了 */ } })
  }

  route('/settings', async (req, res) => {
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '仅限本机' }); return }
    if (req.method === 'GET') { sendJson(res, 200, { ok: true, settings: effective() }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只支持 GET / POST' }); return }
    try {
      const patch = await readJsonBody(req)
      const saved = readSaved()
      for (const key of SETTING_KEYS) {
        if (!Object.hasOwn(patch, key)) continue
        if (key === 'hideWindow') saved[key] = patch[key] === true
        if (key === 'screen' && ['window', 'primary', 'all'].includes(patch[key])) saved[key] = patch[key]
      }
      writeSaved(saved)
      sendJson(res, 200, { ok: true, settings: effective() })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })

  route('/capture', async (req, res) => {
    if (!isLocalRequest(req)) { sendJson(res, 403, { ok: false, error: '仅限本机' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只支持 POST' }); return }
    try {
      const body = await readJsonBody(req)
      const settings = effective()
      if (typeof body.hide === 'boolean') settings.hideWindow = body.hide
      if (['window', 'primary', 'all'].includes(body.screen)) settings.screen = body.screen
      sendJson(res, 200, await capture(settings, log))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn?.(`抓屏失败：${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  })
}
