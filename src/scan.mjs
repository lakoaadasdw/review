/**
 * 扫描本机正在监听的前端服务：netstat 取监听端口 → HTTP 探测是不是页面。
 * 结果给 UI 的「监听哪个前端」下拉用。
 *
 * 注意：vite 用 localhost 启动时常常只绑 IPv6 回环 [::1]，
 * 只探 127.0.0.1 会扫不到，所以按端口实际绑定的地址逐个探测。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const ALLOWED_HOSTS = ['127.0.0.1', '0.0.0.0', '[::]', '[::1]', '::1']

/** 监听端点：端口 + 它绑定的回环地址集合 */
export async function listeningEndpoints() {
  // 不要加 '-p TCP'：Windows 下它会过滤掉 IPv6 的 TCP 监听（[::1]:5173 这类会消失）
  const { stdout } = await run('netstat', ['-ano'], { maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  const map = new Map()
  for (const line of String(stdout).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    if (cols[0].toUpperCase() !== 'TCP') continue
    if (!/LISTENING/i.test(cols[cols.length - 2])) continue
    const local = cols[1]
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    const host = local.slice(0, idx)
    const port = Number(local.slice(idx + 1))
    if (!Number.isFinite(port) || port < 1024) continue
    if (!ALLOWED_HOSTS.includes(host)) continue
    if (!map.has(port)) map.set(port, new Set())
    map.get(port).add(host)
  }
  return [...map.entries()]
    .map(([port, hosts]) => ({ port, hosts: [...hosts] }))
    .sort((a, b) => a.port - b.port)
}

export async function listeningPorts() {
  return (await listeningEndpoints()).map((e) => e.port)
}

async function probePort(port, hosts = []) {
  const has4 = hosts.some((h) => h === '127.0.0.1' || h === '0.0.0.0')
  const has6 = hosts.some((h) => h === '[::1]' || h === '::1' || h === '[::]')
  const urls = []
  if (has4) urls.push(`http://127.0.0.1:${port}/`)
  if (has6) urls.push(`http://[::1]:${port}/`)
  if (!urls.length) urls.push(`http://127.0.0.1:${port}/`)
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      const ct = String(res.headers.get('content-type') || '')
      if (!ct.includes('text/html')) continue
      const html = (await res.text()).slice(0, 300000)
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [null, ''])[1].trim()
      const vite = /@vite\/client|\/@vite\/|vite\/client/.test(html)
      // 只监听 [::1] 的服务用 localhost 打开（浏览器会走 IPv6），127.0.0.1 打不开
      const openUrl = url.includes('[::1]') ? `http://localhost:${port}/` : url
      return { port, url: openUrl, title: title || `127.0.0.1:${port}`, vite }
    } catch {
      /* try next */
    }
  }
  return null
}

/** 探测在听端口里的前端页面；vite 的排前面 */
export async function scanFrontends({ exclude = [], limit = 80 } = {}) {
  let endpoints = []
  try {
    endpoints = await listeningEndpoints()
  } catch {
    return []
  }
  const pick = endpoints.filter((e) => !exclude.includes(e.port)).slice(0, limit)
  const found = (await Promise.all(pick.map((e) => probePort(e.port, e.hosts)))).filter(Boolean)
  found.sort((a, b) => Number(b.vite) - Number(a.vite) || a.port - b.port)
  return found
}
