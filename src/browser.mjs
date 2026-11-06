/**
 * 本机 Chrome 的启动 / 复用 / 开页能力。
 * 目标：用户不必再手动执行 chrome --remote-debugging-port=9222，
 * 工具自己拉起（或复用已开的）带调试端口的浏览器，并打开指定页面。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CDP } from './cdp.mjs'

const CHROME_CANDIDATES = [
  process.env.APIFLOW_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

export function findChrome(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p
  return null
}

export function defaultUserDataDir() {
  return join(tmpdir(), 'apiflow-chrome')
}

let childPid = null

export async function browserStatus(port) {
  // CDP.version 失败时会返回 null，不能只看有没有抛异常（否则 Chrome 已退出也误判为 running）
  const v = await CDP.version(port).catch(() => null)
  if (!v || !v.webSocketDebuggerUrl) return { running: false, port, version: null }
  return { running: true, port, version: v?.Browser || null, reused: true }
}

/** 已有调试端口就直接复用；否则 spawn 一个带调试端口的 Chrome 并等它就绪。 */
export async function ensureBrowser({ port, userDataDir, chromePath, startUrl }) {
  const st = await browserStatus(port)
  if (st.running) return { ...st, pid: null }

  const bin = findChrome(chromePath)
  if (!bin) throw new Error('没找到 Chrome / Edge，可用 --chrome 指定可执行文件路径')

  const dir = userDataDir || defaultUserDataDir()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--window-size=1440,960',
    startUrl || 'about:blank',
  ]
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
  child.unref()
  childPid = child.pid || null

  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const s = await browserStatus(port)
    if (s.running) return { ...s, reused: false, pid: childPid, chromePath: bin, userDataDir: dir }
  }
  throw new Error(
    `浏览器没有在 127.0.0.1:${port} 打开调试端口。` +
      `常见原因：该 --user-data-dir（${dir}）已被另一个没开调试端口的 Chrome 占用，先关掉那个窗口或换个数据目录。`,
  )
}

/** 在受控浏览器里新开一个标签页 */
export async function openTarget(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`
  let res = await fetch(endpoint, { method: 'PUT' }).catch(() => null)
  if (!res || !res.ok) res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`).catch(() => null)
  if (!res || !res.ok) throw new Error(`无法在浏览器里打开 ${url}（/json/new ${res ? res.status : 'failed'}）`)
  const t = await res.json()
  return { id: t.id, url: t.url, title: t.title || '' }
}

export async function listPages(port) {
  try {
    const all = await CDP.targets(port)
    return all.map((t) => ({ id: t.id, url: t.url, title: t.title || '' }))
  } catch {
    return []
  }
}
