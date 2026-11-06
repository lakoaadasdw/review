/**
 * 扫描本机正在监听的前端服务：netstat 取监听端口 → HTTP 探测是不是页面。
 * 结果给 UI 的「监听哪个前端」下拉用。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function listeningPorts() {
  const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  const ports = new Set()
  for (const line of String(stdout).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    if (!/LISTENING/i.test(cols[cols.length - 2])) continue
    const local = cols[1]
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    const host = local.slice(0, idx)
    const port = Number(local.slice(idx + 1))
    if (!Number.isFinite(port) || port < 1024) continue
    if (!['127.0.0.1', '0.0.0.0', '[::]', '[::1]'].includes(host)) continue
    ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

async function probePort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    const ct = String(res.headers.get('content-type') || '')
    if (!ct.includes('text/html')) return null
    const html = (await res.text()).slice(0, 300000)
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [null, ''])[1].trim()
    const vite = /@vite\/client|\/@vite\/|vite\/client/.test(html)
    return { port, url: `http://127.0.0.1:${port}/`, title: title || `127.0.0.1:${port}`, vite }
  } catch {
    return null
  }
}

/** 探测在听端口里的前端页面；vite 的排前面 */
export async function scanFrontends({ exclude = [], limit = 80 } = {}) {
  let ports = []
  try {
    ports = await listeningPorts()
  } catch {
    return []
  }
  const pick = ports.filter((p) => !exclude.includes(p)).slice(0, limit)
  const found = (await Promise.all(pick.map(probePort))).filter(Boolean)
  found.sort((a, b) => Number(b.vite) - Number(a.vite) || a.port - b.port)
  return found
}
