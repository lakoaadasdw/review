/**
 * apiflow 服务端：
 *  - 静态服务 public/
 *  - /api/state 给前端轮询
 *  - 通过 CDP 附着到浏览器页面，注入探针，收集 点击→handler→请求→响应→后端静态链
 */
import { createServer } from 'node:http'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, relative as pathRelative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { CDP } from './cdp.mjs'
import { listAdapters, pickAdapter } from './adapters/index.mjs'
import { buildFrontendChain } from './frontend-graph.mjs'
import { browserStatus, defaultUserDataDir, ensureBrowser, findChrome, listPages, openTarget } from './browser.mjs'
import { scanFrontends } from './scan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PUBLIC = join(root, 'public')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function argGiven(name) {
  return process.argv.includes(`--${name}`) || !!process.env[`APIFLOW_${name.toUpperCase().replace(/-/g, '_')}`]
}

const CONFIG = {
  port: Number(arg('port', process.env.APIFLOW_PORT || 7788)),
  cdpPort: Number(arg('cdp', process.env.APIFLOW_CDP_PORT || 9222)),
  backendRoot: arg('backend', process.env.APIFLOW_BACKEND || '<local-path>'),
  targetPattern: arg('target', process.env.APIFLOW_TARGET || ''),
  chainDepth: Number(arg('depth', process.env.APIFLOW_DEPTH || 4)),
  lang: arg('lang', process.env.APIFLOW_LANG || 'auto'),
  python: arg('python', process.env.APIFLOW_PYTHON || 'python'),
  frontendRoot: arg('frontend', process.env.APIFLOW_FRONTEND || '<local-path>'),
  chromePath: arg('chrome', process.env.APIFLOW_CHROME || ''),
  userDataDir: arg('user-data', process.env.APIFLOW_USER_DATA || defaultUserDataDir()),
  lastUrl: '',
}

const CONFIG_FILE = join(root, 'apiflow.config.json')

async function loadSavedConfig() {
  try {
    const j = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    // 命令行/环境变量优先于上次保存的配置（否则第二份实例会被旧端口/旧地址带跑）
    if (Number(j.cdpPort) > 0 && !argGiven('cdp')) CONFIG.cdpPort = Number(j.cdpPort)
    if (typeof j.chromePath === 'string' && !argGiven('chrome')) CONFIG.chromePath = j.chromePath
    if (typeof j.userDataDir === 'string' && j.userDataDir && !argGiven('user-data')) CONFIG.userDataDir = j.userDataDir
    if (typeof j.lastUrl === 'string') CONFIG.lastUrl = j.lastUrl
  } catch {}
}

async function saveSavedConfig() {
  const data = { cdpPort: CONFIG.cdpPort, chromePath: CONFIG.chromePath, userDataDir: CONFIG.userDataDir, lastUrl: CONFIG.lastUrl }
  await writeFile(CONFIG_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8').catch(() => {})
}

async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try { return raw ? JSON.parse(raw) : {} } catch { return {} }
}

function sendJson(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const state = {
  startedAt: Date.now(),
  cdp: { connected: false, port: CONFIG.cdpPort, target: null, error: null },
  backend: { root: CONFIG.backendRoot, summary: null, error: null, adapter: null },
  adapters: listAdapters(),
  traces: new Map(),
  order: [],
  seq: 0,
}

let index = null
let adapter = null
let cdp = null
let currentTargetId = null
const scripts = new Map() // scriptId -> url
const treeCache = new Map() // 'METHOD path' -> 调用树

async function loadBackend() {
  try {
    adapter = pickAdapter(CONFIG.backendRoot, CONFIG.lang)
    index = await adapter.index(CONFIG.backendRoot, { python: CONFIG.python })
    state.backend.summary = adapter.summarize(index)
    state.backend.adapter = adapter.id
    state.backend.error = null
    treeCache.clear()
  } catch (err) {
    index = null
    state.backend.error = String(err?.message || err)
  }
}

// ---------- 轨迹聚合 ----------
function newTrace(id, reason) {
  const trace = { id, reason, startedAt: Date.now(), status: 'ok', nodes: [], edges: [], methods: null, backends: [], events: 0 }
  state.traces.set(id, trace)
  state.order.unshift(id)
  if (state.order.length > 200) state.order.length = 200
  return trace
}

function ensureTrace(id, reason = 'auto') {
  return state.traces.get(id) || newTrace(id, reason)
}

function addNode(trace, node) {
  if (trace.nodes.some((n) => n.id === node.id)) return trace.nodes.find((n) => n.id === node.id)
  trace.nodes.push(node)
  return node
}

function addEdge(trace, from, to, status = 'ok') {
  if (!from || !to || from === to) return
  if (trace.edges.some((e) => e.from === from && e.to === to)) return
  trace.edges.push({ from, to, status })
}

function markError(trace, nodeIds) {
  trace.status = 'error'
  for (const id of nodeIds) {
    const node = trace.nodes.find((n) => n.id === id)
    if (node) node.status = 'error'
  }
}

function topFrame(stack) {
  for (const line of String(stack || '').split('\n')) {
    const m = /(?:at\s+(?:.*?\()?)((?:https?|file):\/\/[^\s)]+|\/[^\s):]+):(\d+):(\d+)/.exec(line)
    if (m) return { file: m[1], line: Number(m[2]), column: Number(m[3]) }
  }
  return null
}

// —— 前端源码定位：把请求发起点的栈帧 URL 映射回本地源码文件，并截取所在函数 ——
const FRONTEND_EXTS = /\.(vue|tsx?|jsx?|mjs|svelte)$/i
const FRONTEND_SKIP = /(\/node_modules\/|\/@vite\/|\/@id\/|vite\/dist|vue\.runtime|\.vite\/deps)/

function mapFrontendUrl(url) {
  let p = String(url || '').replace(/\?.*$/, '')
  if (!p) return null
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice('file://'.length))
  else if (/^https?:\/\//.test(p)) { try { p = decodeURIComponent(new URL(p).pathname) } catch { return null } }
  if (!FRONTEND_EXTS.test(p)) return null
  if (p.includes('/@fs/')) {
    const f = p.split('/@fs/')[1]
    return { file: /^[A-Za-z]:/.test(f) ? f : '/' + f }
  }
  const i = p.indexOf('/src/')
  if (i < 0) return null
  return { file: join(CONFIG.frontendRoot, p.slice(i + 1)) }
}

// 在文件里向上找函数起点（function / const x = () => / 方法简写），再按花括号配对找结尾
function readFrontendSnippet(file, line) {
  let text = ''
  try {
    if (statSync(file).size > 400_000) return null
    text = readFileSync(file, 'utf8')
  } catch { return null }
  const lines = text.split('\n')
  if (!lines.length) return null
  const idx = Math.max(0, Math.min(lines.length - 1, line - 1))
  const head = /(?:function\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)\s*=|(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{|=>)/
  let start = -1
  for (let i = idx; i >= Math.max(0, idx - 120); i--) {
    if (head.test(lines[i])) { start = i; break }
  }
  if (start < 0) start = Math.max(0, idx - 15)
  let end = Math.min(lines.length - 1, start + 200)
  let depth = 0
  let opened = false
  for (let i = start; i <= end; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) { end = i; break }
  }
  if (!opened) end = Math.min(lines.length - 1, idx + 20)
  // 太短的片段（单行语句）补几行上下文，避免只显示一行
  if (end - start < 3) end = Math.min(lines.length - 1, start + 8)
  const rel = pathRelative(CONFIG.frontendRoot, file).split('\\').join('/')
  return {
    file: rel,
    startLine: start + 1,
    endLine: end + 1,
    line: idx + 1,
    code: lines.slice(start, end + 1).join('\n'),
  }
}

function parseStackFrames(stack) {
  const out = []
  for (const ln of String(stack || '').split('\n')) {
    const m = /(?:at\s+(?:.*?\()?)((?:https?|file):\/\/[^\s)]+|\/[^\s):]+):(\d+):(\d+)/.exec(ln)
    if (!m) continue
    const fm = /^\s*at\s+(?:async\s+)?((?:new\s+)?[^\s(]+)/.exec(ln)
    out.push({ url: m[1], line: Number(m[2]), col: Number(m[3]), func: fm ? fm[1] : '' })
  }
  return out
}

// 取「组件/调用方 → … → 真正发请求的函数」的调用链；最内层在前，返回时翻转为外层在前
function frontendChain(stack, maxFrames = 3) {
  const chain = []
  for (const f of parseStackFrames(stack)) {
    if (FRONTEND_SKIP.test(f.url)) continue
    const loc = mapFrontendUrl(f.url)
    if (!loc) continue
    const snippet = readFrontendSnippet(loc.file, f.line)
    if (!snippet) continue
    if (chain.some((c) => c.file === snippet.file && c.line === snippet.line)) continue
    chain.push({ ...snippet, func: f.func })
    if (chain.length >= maxFrames) break
  }
  return chain.reverse()
}

// 从调用栈里取「最内层的业务帧」作为静态解析的起点：返回绝对路径文件 + 行号
function frontendOrigin(stack) {
  for (const f of parseStackFrames(stack)) {
    if (FRONTEND_SKIP.test(f.url)) continue
    const loc = mapFrontendUrl(f.url)
    if (!loc) continue
    if (!readFrontendSnippet(loc.file, f.line)) continue
    return { file: loc.file, line: f.line, func: f.func }
  }
  return null
}

let lastClickNode = null
let lastHandlerNode = null
let lastRequestNode = null

function ingest(payload) {
  if (!payload || !payload.trace) return
  const trace = ensureTrace(payload.trace, payload.reason)
  trace.events++
  trace.lastEventAt = Date.now()

  switch (payload.kind) {
    case 'trace-start':
      trace.reason = payload.reason || trace.reason
      break

    case 'click': {
      const node = addNode(trace, {
        id: `${trace.id}#click`,
        kind: 'click',
        label: payload.target || 'click',
        status: 'ok',
        at: payload.at,
        meta: { x: payload.x, y: payload.y, target: payload.target },
      })
      lastClickNode = node.id
      lastHandlerNode = null
      setTimeout(() => { resolveHandlerSource(trace) }, 60)
      break
    }

    case 'handler': {
      const n = trace.nodes.filter((x) => x.kind === 'handler').length + 1
      const frame = topFrame(payload.stack)
      const node = addNode(trace, {
        id: `${trace.id}#handler${n}`,
        kind: 'handler',
        label: frame ? `${shortPath(frame.file)}:${frame.line}` : payload.event || 'handler',
        status: 'ok',
        at: payload.at,
        meta: { event: payload.event, target: payload.target, frame, stack: payload.stack },
      })
      addEdge(trace, lastClickNode, node.id)
      lastHandlerNode = node.id
      break
    }

    case 'request': {
      // 前端调用链：发请求的函数 → 它调用的函数 → … （静态解析），再连到 HTTP 请求
      let parent = lastHandlerNode || lastClickNode
      const origin = payload.stack ? frontendOrigin(payload.stack) : null
      const chain = origin
        ? buildFrontendChain({ file: origin.file, line: origin.line, funcName: origin.func, frontendRoot: CONFIG.frontendRoot })
        : { nodes: [], edges: [] }
      const idOf = new Map()
      for (const fe of chain.nodes) {
        const rel = pathRelative(CONFIG.frontendRoot, fe.file).split('\\').join('/')
        const feId = `${trace.id}#fe:${rel}:${fe.line}`
        idOf.set(fe.id, feId)
        if (!trace.nodes.some((n) => n.id === feId)) {
          addNode(trace, {
            id: feId,
            kind: 'fe',
            label: `${rel}:${fe.line}`,
            status: 'ok',
            at: (payload.at || Date.now()) - 1,
            meta: {
              file: rel,
              func: fe.func,
              role: fe.role,
              startLine: fe.startLine,
              endLine: fe.endLine,
              line: fe.line,
              requestLine: fe.requestLine,
              code: fe.code,
            },
          })
        }
      }
      for (const e of chain.edges) {
        const from = idOf.get(e.from)
        const to = idOf.get(e.to)
        if (from && to) addEdge(trace, from, to)
      }
      const rootFe = chain.nodes.length ? idOf.get(chain.nodes[0].id) : null
      const lastFe = chain.nodes.length ? idOf.get(chain.nodes[chain.nodes.length - 1].id) : null
      if (rootFe) addEdge(trace, parent, rootFe)
      parent = lastFe || rootFe || parent
      const node = addNode(trace, {
        id: `${trace.id}#req${payload.reqId}`,
        kind: 'request',
        label: `${payload.method} ${shortUrl(payload.url)}`,
        status: 'ok',
        at: payload.at,
        meta: { url: payload.url, method: payload.method, reqId: payload.reqId },
      })
      addEdge(trace, parent, node.id)
      lastRequestNode = node.id
      break
    }

    case 'response': {
      const reqId = `${trace.id}#req${payload.reqId}`
      const status = Number(payload.status) || 0
      const bad = !payload.ok || status >= 400
      const node = addNode(trace, {
        id: `${trace.id}#resp${payload.reqId}`,
        kind: 'response',
        label: `${status} ${payload.duration ?? '?'}ms`,
        status: bad ? 'error' : 'ok',
        at: payload.at,
        meta: { url: payload.url, method: payload.method, status, duration: payload.duration, bodyPreview: payload.bodyPreview, bodyTruncated: !!payload.bodyTruncated },
      })
      const req = trace.nodes.find((n) => n.id === reqId)
      if (req) {
        req.meta = { ...req.meta, status, duration: payload.duration }
        if (bad) { req.status = 'error'; markError(trace, [req.id]) }
      }
      addEdge(trace, reqId, node.id, bad ? 'error' : 'ok')
      if (bad) markError(trace, [node.id])
      // 后端静态链
      attachBackendChain(trace, payload)
      break
    }

    case 'error': {
      const n = trace.nodes.filter((x) => x.kind === 'error').length + 1
      const node = addNode(trace, {
        id: `${trace.id}#err${n}`,
        kind: 'error',
        label: payload.where === 'fetch' ? `请求失败 ${shortUrl(payload.url || '')}` : String(payload.message || 'error').slice(0, 80),
        status: 'error',
        at: payload.at,
        meta: { where: payload.where, message: payload.message, stack: payload.stack, url: payload.url },
      })
      addEdge(trace, lastRequestNode || lastHandlerNode || lastClickNode, node.id, 'error')
      markError(trace, [node.id])
      break
    }
  }
}

/** 用 CDP 反查刚被点击元素上注册的事件 handler 源码位置（前端"方法"落点） */
async function resolveHandlerSource(trace) {
  if (!cdp) return
  let objectId
  try {
    const ev = await cdp.send('Runtime.evaluate', {
      expression: "document.querySelector('[data-apiflow-target]')",
      returnByValue: false,
    })
    objectId = ev.result?.objectId
    if (!objectId) return
    const res = await cdp.send('DOMDebugger.getEventListeners', { objectId, depth: 1, pierce: false })
    await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {})
    const frames = []
    for (const listener of res.listeners || []) {
      if (!['click', 'pointerdown', 'submit'].includes(listener.type)) continue
      const loc = listener.location
      if (!loc) continue
      const url = scripts.get(loc.scriptId) || ''
      if (!url) continue
      frames.push({ file: url, line: (loc.lineNumber || 0) + 1, column: (loc.columnNumber || 0) + 1, type: listener.type })
    }
    if (!frames.length) return
    const handler = [...trace.nodes].reverse().find((n) => n.kind === 'handler')
    if (!handler) return
    handler.meta = { ...handler.meta, frame: frames[0], frames }
    handler.label = `${shortPath(frames[0].file)}:${frames[0].line}`
  } catch {}
}

function attachBackendChain(trace, payload) {
  if (!index || !payload.url) return
  let pathname
  try { pathname = new URL(payload.url, 'http://localhost').pathname } catch { return }
  const route = adapter.matchRoute(index.routes, String(payload.method || 'GET').toUpperCase(), pathname)
  if (!route) return
  const routeKey = `${route.method} ${route.path}`
  if (!treeCache.has(routeKey)) treeCache.set(routeKey, adapter.buildCallTree(index, route, CONFIG.chainDepth))
  const tree = treeCache.get(routeKey)
  if (!tree) return

  const resp = trace.nodes.find((n) => n.id === `${trace.id}#resp${payload.reqId}`)
  const linkStatus = resp && resp.status === 'error' ? 'error' : 'ok'
  const routeInfo = { method: route.method, path: route.path, file: route.file, line: route.line }
  // 一条 trace 里可能打了多个接口（轮询/多请求）：每个不同的路由各挂一棵方法树
  if (!trace.backends.some((b) => b.route.method === routeInfo.method && b.route.path === routeInfo.path)) {
    trace.backends.push({
      from: resp ? resp.id : lastRequestNode,
      rootId: tree.rootId,
      nodes: tree.nodes,
      edges: tree.edges,
      route: routeInfo,
      status: linkStatus,
    })
  }
  trace.methods = trace.backends[0] || null
}

function shortUrl(url) {
  try { const u = new URL(url, 'http://localhost'); return `${u.pathname}${u.search ? '?…' : ''}` } catch { return String(url).slice(0, 60) }
}function shortPath(file) {
  const s = String(file).replace(/^https?:\/\/[^/]+/, '')
  const parts = s.split('/')
  return parts.slice(-2).join('/')
}

// ---------- CDP 采集 ----------
async function connectCDP(pattern) {
  try {
    if (cdp) { cdp.close(); cdp = null }
    const all = await CDP.targets(CONFIG.cdpPort)
    // 绝不能把自己的工具页选成采集目标（否则点工具页自己的按钮会产生假链路）
    const ownPrefix = `http://127.0.0.1:${CONFIG.port}`
    const targets = all.filter((t) => !String(t.url).startsWith(ownPrefix) && !String(t.url).startsWith('chrome://'))
    const want = String(pattern || CONFIG.targetPattern || '')
    const target = (want ? targets.find((t) => String(t.id).startsWith(want) || String(t.url).includes(want)) : null) || targets[0] || all[0]
    if (!target) throw new Error(`127.0.0.1:${CONFIG.cdpPort} 上没有可用页面`)
    state.targetPattern = want || null
    cdp = await CDP.attach(target.webSocketDebuggerUrl)
    currentTargetId = target.id
    state.cdp = { connected: true, port: CONFIG.cdpPort, target: { id: target.id, url: target.url, title: target.title }, error: null }

    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Network.enable')
    try { await cdp.send('Debugger.enable') } catch {}
    cdp.on('Debugger.scriptParsed', (p) => { if (p.url) scripts.set(p.scriptId, p.url) })
    try { await cdp.send('Runtime.addBinding', { name: '__apiflowSend' }) } catch (err) { console.error('[cdp] addBinding', err.message) }

    cdp.on('Runtime.bindingCalled', (p) => {
      if (p.name !== '__apiflowSend') return
      try { ingest(JSON.parse(p.payload)) } catch (err) { console.error('[ingest]', err.message) }
    })
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {}
      ingest({ kind: 'error', trace: lastTraceId(), where: 'cdp-exception', message: d.text || d.exception?.description || 'exception', stack: d.exception?.description, at: Date.now() })
    })

    const probe = await readFile(join(here, 'probe.js'), 'utf8')
    // runImmediately 会直接注入到当前页面，已有探针的页面不再强制刷新（避免打断用户正在看的页面）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probe, runImmediately: true })
    let hasProbe = false
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: '!!window.__apiflow', returnByValue: true })
      hasProbe = !!(r && r.result && r.result.value)
    } catch {}
    if (!hasProbe) {
      try { await cdp.send('Page.reload', { ignoreCache: false }) } catch {}
    }
    console.log(`[cdp] attached ${target.url}${hasProbe ? ' (probe already present)' : ''}`)
  } catch (err) {
    state.cdp = { connected: false, port: CONFIG.cdpPort, target: null, error: String(err?.message || err) }
    console.error('[cdp]', err.message)
  }
}

function lastTraceId() {
  return state.order[0] || `orphan-${Date.now()}`
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }

async function serveStatic(res, pathname) {
  const clean = pathname === '/' ? '/index.html' : pathname
  const file = normalize(join(PUBLIC, clean))
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return }
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not file')
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
  }
}

function snapshot() {
  const traces = state.order.map((id) => state.traces.get(id)).filter(Boolean).map((t) => ({
    id: t.id, reason: t.reason, startedAt: t.startedAt, lastEventAt: t.lastEventAt, status: t.status,
    nodes: t.nodes, edges: t.edges, methods: t.methods, backends: t.backends,
  }))
  return {
    startedAt: state.startedAt,
    cdp: state.cdp,
    backend: state.backend,
    adapters: state.adapters,
    traces,
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(snapshot()))
      return
    }
    if (url.pathname === '/api/routes') {
      const list = (index?.routes || []).map((r) => ({ method: r.method, path: r.path, controller: r.controller, javaMethod: r.javaMethod, file: r.file, line: r.line, chain: (r.chain || []).length }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ summary: state.backend.summary, routes: list }))
      return
    }
    if (url.pathname === '/api/reload') {
      void loadBackend()
      treeCache.clear()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, summary: state.backend.summary, error: state.backend.error }))
      return
    }
    if (url.pathname === '/api/targets') {
      const [chrome, frontends, pages] = await Promise.all([
        browserStatus(CONFIG.cdpPort),
        scanFrontends({ exclude: [CONFIG.port, CONFIG.cdpPort] }),
        listPages(CONFIG.cdpPort),
      ])
      sendJson(res, 200, {
        chrome: { ...chrome, chromeBin: findChrome(CONFIG.chromePath), userDataDir: CONFIG.userDataDir },
        frontends,
        pages: pages.filter((p) => /^https?:/i.test(p.url)),
        lastUrl: CONFIG.lastUrl || '',
        current: state.cdp.target,
      })
      return
    }
    if (url.pathname === '/api/launch' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const targetUrl = String(body.url || '').trim()
      if (!/^https?:\/\//i.test(targetUrl)) { sendJson(res, 400, { ok: false, error: 'url 必须是 http(s) 地址' }); return }
      const browser = await ensureBrowser({ port: CONFIG.cdpPort, userDataDir: CONFIG.userDataDir, chromePath: CONFIG.chromePath })
      // 已经开着同一个地址就直接复用那个标签页，避免每点一次多开一个
      const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase()
      const opened = await listPages(CONFIG.cdpPort)
      const existing = opened.find((p) => {
        if (String(p.url).includes(`127.0.0.1:${CONFIG.port}`)) return false
        return norm(p.url).startsWith(norm(targetUrl))
      })
      const target = existing || (await openTarget(CONFIG.cdpPort, targetUrl))
      await connectCDP(target.id)
      if (!state.cdp.connected) { sendJson(res, 500, { ok: false, error: state.cdp.error || '连接失败', browser }); return }
      CONFIG.lastUrl = targetUrl
      await saveSavedConfig()
      sendJson(res, 200, { ok: true, browser: { port: CONFIG.cdpPort, reused: !!browser.reused }, target: state.cdp.target })
      return
    }
    if (url.pathname === '/api/connect') {
      await connectCDP(url.searchParams.get('target') || '')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(state.cdp))
      return
    }
    if (url.pathname === '/api/navigate') {
      const target = url.searchParams.get('url')
      if (!target) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('missing url'); return }
      if (!cdp) { res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }).end('cdp not connected'); return }
      await cdp.send('Page.navigate', { url: target })
      if (state.cdp.target) state.cdp.target.url = target
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, url: target }))
      return
    }
    if (url.pathname === '/api/reset') {
      state.traces.clear(); state.order = []
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname.startsWith('/api/')) { res.writeHead(404).end('no route'); return }
    await serveStatic(res, url.pathname)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err?.stack || err))
  }
})

await loadSavedConfig()
void loadBackend()
server.listen(CONFIG.port, () => {
  console.log(`[apiflow] http://127.0.0.1:${CONFIG.port}`)
  console.log(`[apiflow] adapter: ${CONFIG.lang} -> ${state.backend.adapter || '?'}${state.backend.summary?.lang ? ` (${state.backend.summary.lang})` : ''}`)
console.log(`[apiflow] backend: ${CONFIG.backendRoot} -> ${state.backend.summary ? `${state.backend.summary.routes} routes / ${state.backend.summary.controllers} controllers` : `ERROR ${state.backend.error}`}`)
  console.log(`[apiflow] mappers: ${index ? `${index.mappers || 0} xml / ${index.mapperHits || 0} statements mapped` : 'none'}`)
  if (CONFIG.targetPattern) connectCDP(CONFIG.targetPattern)
  else browserStatus(CONFIG.cdpPort).then((s) => { if (s.running) connectCDP(CONFIG.lastUrl || '') })
})
