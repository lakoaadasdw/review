/**
 * python-mini 的假后端 + 演示页（零依赖）。
 * 用途：没有 FastAPI 运行环境时，仍能产生真实 HTTP 请求，让 apiflow 的 Python 适配器
 * 走一遍「点击 → 请求 → 路由 → 方法链」的真实采集。
 *
 * 启动：node fixtures/python-mini/mock-server.mjs [port]
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] || 8011)

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>python-mini</title>
<style>body{font:14px/1.6 system-ui;background:#0d1117;color:#d8dee9;padding:32px}
button{padding:8px 14px;margin-right:12px;cursor:pointer}</style></head>
<body>
<h1>python-mini fixture</h1>
<p>这个页面发出的请求会命中 fixtures/python-mini 里的 FastAPI 路由。</p>
<button id="login">POST /auth/login</button>
<button id="me">GET /auth/me</button>
<button id="health">GET /health</button>
<pre id="out"></pre>
<script>
const out = document.getElementById('out')
const show = (x) => { out.textContent = JSON.stringify(x, null, 2) }
document.getElementById('login').addEventListener('click', async () => {
  const res = await fetch('/auth/login?username=demo&password=demo', { method: 'POST' })
  show({ status: res.status, body: await res.json() })
})
document.getElementById('me').addEventListener('click', async () => {
  const res = await fetch('/auth/me')
  show({ status: res.status, body: await res.json() })
})
document.getElementById('health').addEventListener('click', async () => {
  const res = await fetch('/health')
  show({ status: res.status, body: await res.json() })
})
</script>
</body></html>`

function json(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/auth/login' && req.method === 'POST') {
    json(res, 200, { token: 'token-demo', user: { name: url.searchParams.get('username') || 'demo', role: 'admin' } })
    return
  }
  if (url.pathname === '/auth/me') {
    json(res, 200, { name: 'demo', role: 'admin', token: 'token-demo' })
    return
  }
  if (url.pathname === '/health') {
    json(res, 200, { ok: true })
    return
  }
  json(res, 404, { detail: 'not found' })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[python-mini] http://127.0.0.1:${PORT}/`)
})
