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
    // 未解析调用诊断（只把「项目内真断」的 actionable 暴露给 UI，最多 200 条）
    const diag = index.diagnostics || null
    state.backend.diagnostics = diag ? {
      counts: { actionable: diag.actionable || 0, external: diag.external || 0, generated: diag.generated || 0 },
      actionable: (diag.unresolved || []).filter((u) => u.kind === 'actionable').slice(0, 200),
    } : null
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
        meta: { url: payload.url, method: payload.method, reqId: payload.reqId, params: requestParams(payload) },
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

const MASK_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-token', 'x-auth-token'])

/** 从钩子上报里抽出「这次请求带了什么参数」：query / body(JSON 顶层) / headers */
function requestParams(payload) {
  const out = { query: {}, body: {}, path: {}, headers: {} }
  try {
    const u = new URL(payload.url, 'http://localhost')
    for (const [k, v] of u.searchParams) out.query[k] = v
  } catch {}
  const raw = typeof payload.body === 'string' ? payload.body.trim() : ''
  if (raw) {
    try {
      const json = JSON.parse(raw)
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        for (const [k, v] of Object.entries(json).slice(0, 40)) {
          out.body[k] = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v)
        }
      } else {
        out.body['(body)'] = (Array.isArray(json) ? `[${json.length} 项]` : String(json)).slice(0, 120)
      }
    } catch {
      out.body['(raw)'] = raw.slice(0, 160)
    }
  }
  const hs = payload.headers && typeof payload.headers === 'object' ? payload.headers : {}
  for (const [k, v] of Object.entries(hs).slice(0, 24)) {
    const lk = String(k).toLowerCase()
    if (lk === 'x-apiflow-trace') continue
    const val = MASK_HEADERS.has(lk) ? '••••' : String(v).slice(0, 160)
    if (!out.headers[lk]) out.headers[lk] = val
  }
  return out
}

/** /admin/orders/{id} + /admin/orders/42 → {id: '42'} */
function pathParamsOf(routePath, pathname) {
  const out = {}
  const tpl = String(routePath || '').split('/').filter(Boolean)
  const act = String(pathname || '').split('/').filter(Boolean)
  const n = Math.min(tpl.length, act.length)
  const t = tpl.slice(tpl.length - n)
  const a = act.slice(act.length - n)
  for (let i = 0; i < n; i++) {
    const m = t[i].match(/^\{(.+?)\}$/)
    if (m) { try { out[m[1]] = decodeURIComponent(a[i]) } catch { out[m[1]] = a[i] } }
  }
  return out
}

// —— 调用点实参解析：把「请求参数/上游实参」映射到每个调用的形参上 ——
function splitTopLevel(s) {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      cur += ch
      if (ch === quote && s[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if ('([{<'.includes(ch)) depth++
    else if (')]}>'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function formalsOf(code, method) {
  const text = String(code || '')
  const head = method + '('
  const at = text.indexOf(head)
  if (at < 0) return []
  let depth = 0
  let quote = null
  let args = ''
  for (let i = at + head.length - 1; i < text.length; i++) {
    const ch = text[i]
    if (quote) { args += ch; if (ch === quote && text[i - 1] !== '\\') quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; args += ch; continue }
    if (ch === '(') { depth++; if (depth === 1) continue }
    else if (ch === ')') { depth--; if (!depth) break }
    args += ch
  }
  if (!args) return []
  return splitTopLevel(args).map((part) => {
    const clean = part.replace(/@[\w.]+(?:\s*\([^)]*\))?/g, ' ').replace(/\bfinal\b/g, ' ').trim()
    const words = clean.split(/\s+/).filter(Boolean)
    if (!words.length) return null
    const name = words[words.length - 1].replace(/,$/, '')
    // 形参类型：去掉泛型与数组后缀，取最后一个标识符（`List<String> ids` → ids 是名字，List 是类型）
    const typeRaw = words.slice(0, -1).join(' ').replace(/<[^>]*>/g, '').replace(/\[\]/g, '').trim()
    const typeWords = typeRaw.split(/\s+/).filter(Boolean)
    const type = typeWords.length ? typeWords[typeWords.length - 1] : ''
    // 注解参数：@RequestParam(value = "hours", defaultValue = "24")
    const ann = part.match(/@([\w.]+)\s*(?:\(([^)]*)\))?/)
    const annName = ann ? ann[1] : ''
    const annArgs = ann && ann[2] ? ann[2] : ''
    const pick = (key) => {
      const m = annArgs.match(new RegExp('\\b' + key + '\\s*=\\s*"([^"]*)"'))
      return m ? m[1] : ''
    }
    const firstStr = (ann && ann[2] && ann[2].match(/"([^"]*)"/)) || null
    return {
      name,
      type,
      annotation: annName,
      paramKey: pick('value') || pick('name') || (firstStr ? firstStr[1] : ''),
      defaultValue: pick('defaultValue'),
    }
  }).filter(Boolean)
}

/** 把 query / body 这类对象形参渲染成 `{page:1, size:20, +6}` 的紧凑形态 */
function shapeOf(obj, maxKeys = 4) {
  const keys = Object.keys(obj || {})
  if (!keys.length) return null
  const parts = keys.slice(0, maxKeys).map((k) => {
    const v = String(obj[k])
    return `${k}:${v.length > 18 ? v.slice(0, 18) + '…' : v}`
  })
  const more = keys.length > maxKeys ? `, +${keys.length - maxKeys}` : ''
  return `{${parts.join(', ')}${more}}`
}

function callArgsAt(lines, lineNo, calleeName, startLine) {
  const idx = lineNo - startLine
  if (idx < 0 || idx >= lines.length) return null
  const text = lines.slice(idx, idx + 4).join('\n')
  const at = text.indexOf(calleeName + '(')
  if (at < 0) return null
  const rest = text.slice(at + calleeName.length)
  let depth = 0
  let quote = null
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (quote) { if (ch === quote && rest[i - 1] !== '\\') quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (!depth) return splitTopLevel(rest.slice(1, i)) }
  }
  return null
}

function resolveArg(expr, scope) {
  const e = String(expr || '').trim()
  if (!e) return { expr: e, value: null, resolved: false }
  const str = e.match(/^(["'])([\s\S]*)\1$/)
  if (str) return { expr: e, value: str[2], resolved: true }
  if (/^-?\d+(\.\d+)?$/.test(e) || /^(true|false|null)$/.test(e)) return { expr: e, value: e, resolved: true }
  const call = e.match(/^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/)
  if (call) {
    const inner = splitTopLevel(call[2])[0]
    const r = resolveArg(inner, scope)
    return { expr: e, value: r.resolved ? call[1] + '(' + r.value + ')' : null, resolved: r.resolved }
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e) && scope.has(e)) return { expr: e, value: scope.get(e), resolved: true }
  return { expr: e, value: null, resolved: false }
}

/** 基于本次请求参数，给每条调用边补上「调用点实参」（形参名 → 值） */
function annotateArgs(tree, params) {
  const scope0 = new Map()
  const put = (obj) => { for (const [k, v] of Object.entries(obj || {})) if (!scope0.has(k)) scope0.set(k, String(v)) }
  put(params && params.path)
  put(params && params.query)
  put(params && params.body)
  const nodes = new Map(tree.nodes.map((n) => [n.id, n]))
  const root = nodes.get(tree.rootId)
  const scopes = new Map()
  const rootFormals = root ? formalsOf(root.code, root.method) : []
  const m = new Map()
  const DTO_SKIP = /^(String|CharSequence|Long|Integer|Int|Short|Byte|Boolean|Double|Float|BigDecimal|BigInteger|Date|Calendar|LocalDate|LocalDateTime|LocalTime|Instant|Duration|List|ArrayList|Map|HashMap|Set|HashSet|Collection|Optional|Object|Class)$/
  for (const f of rootFormals) {
    const key = f.paramKey || f.name
    if (scope0.has(key)) { m.set(f.name, scope0.get(key)); continue }
    if (scope0.has(f.name)) { m.set(f.name, scope0.get(f.name)); continue }
    if (f.defaultValue) { m.set(f.name, f.defaultValue); continue }
    // 对象形参（如 `AllocationQuery query`）：Spring 从 query string / body 绑定，
    // 这里把能看到的键值汇总成 {page:1, size:20, +6} 塞进作用域，别让它显示成 null
    const isDto = f.type && /^[A-Z]/.test(f.type) && !DTO_SKIP.test(f.type)
    const looksContainer = /^(query|request|form|body|param|params|dto|vo|qo)$/i.test(f.name) || /Query|Request|Form|Body|Dto|DTO|Vo|VO|Qo|QO$/.test(f.type || '')
    if (isDto || looksContainer) {
      const src = (params.body && Object.keys(params.body).length) ? params.body : (params.query || {})
      const shape = shapeOf(src, 4)
      if (shape) { m.set(f.name, shape); continue }
    }
  }
  if (root) scopes.set(root.id, m)
  const queue = root ? [root.id] : []
  const seen = new Set(queue)
  const out = []
  while (queue.length) {
    const fromId = queue.shift()
    const from = nodes.get(fromId)
    if (!from) continue
    const lines = String(from.code || '').split('\n')
    const callerScope = scopes.get(fromId) || scope0
    for (const e of tree.edges) {
      if (e.from !== fromId) continue
      const child = nodes.get(e.to)
      if (!child) continue
      const raw = callArgsAt(lines, e.line, child.method, from.startLine)
      const formals = formalsOf(child.code, child.method)
      const args = []
      const childScope = new Map(callerScope)
      if (raw) {
        raw.forEach((expr, i) => {
          const r = resolveArg(expr, callerScope)
          const name = (formals[i] && formals[i].name) || ('arg' + (i + 1))
          args.push({ name, expr: r.expr, value: r.value, resolved: r.resolved })
          if (r.resolved) childScope.set(name, r.value)
        })
      }
      out.push(Object.assign({}, e, args.length ? { args } : {}))
      if (!scopes.has(e.to)) {
        scopes.set(e.to, childScope)
        if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to) }
      }
    }
  }
  for (const e of tree.edges) if (!out.some((x) => x.from === e.from && x.to === e.to && x.line === e.line)) out.push(e)

  // 卡内所有调用行都给一份实参注解：就算被调方法没解析出来（接口/外部类），
  // 也能在调用行下面看到「这次传进去的是什么」。
  for (const n of tree.nodes) {
    const scope = scopes.get(n.id)
    if (!scope) continue
    const lines = String(n.code || '').split(String.fromCharCode(10))
    const list = []
    for (const c of n.calls || []) {
      const callee = String(c.toKey || '').split('.').pop()
      // 索引器有时会把方法签名本身当成一次自调用（`public X page(Q q)`），这里跳过
      if (callee && callee === n.method) continue
      const raw = callee ? callArgsAt(lines, c.line, callee, n.startLine) : null
      const child = nodes.get(c.toKey)
      const cformals = child ? formalsOf(child.code, child.method) : []
      const args = (raw || []).map((expr, i) => {
        const r = resolveArg(expr, scope)
        return { name: (cformals[i] && cformals[i].name) || '', expr: r.expr, value: r.value, resolved: r.resolved, index: i }
      })
      if (args.length) list.push({ line: c.line, callee, args })
    }
    if (list.length) n.callArgs = list
  }

  // 再扫一遍「调用表达式」：即使是接口/实现类（没进方法树）的调用，
  // 只要它在索引里能按方法名找到，就把这一行的实参也解析出来。
  const byName = new Map()
  if (index && index.methods) {
    for (const m of index.methods.values()) if (!byName.has(m.method)) byName.set(m.method, m)
  }
  for (const n of tree.nodes) {
    const scope = scopes.get(n.id)
    if (!scope) continue
    const lines = String(n.code || '').split(String.fromCharCode(10))
    const merged = new Map((n.callArgs || []).map((x) => [x.line, (x.items || [{ callee: x.callee || '', args: x.args || [] }]).slice()]))
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]
      if (!text.includes('(')) continue
      if (/^\s*(public|private|protected|static|class|interface|if|for|while|switch|catch)/.test(text)) continue
      const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g
      let m
      while ((m = re.exec(text))) {
        const callee = m[1].split('.').pop()
        if (callee === n.method) continue
        const def = byName.get(callee)
        if (!def) continue
        const start = m.index + m[0].length - 1
        let depth = 0
        let quote = null
        let body = null
        for (let k = start; k < text.length; k++) {
          const ch = text[k]
          if (quote) { if (ch === quote && text[k - 1] !== String.fromCharCode(92)) quote = null; continue }
          if (ch === '"' || ch === "'") { quote = ch; continue }
          if (ch === '(') depth++
          else if (ch === ')') { depth--; if (!depth) { body = text.slice(start + 1, k); break } }
        }
        if (body === null) continue
        const formals = formalsOf(def.code, def.method)
        const explicit = splitTopLevel(body)
        if (!explicit.length) continue
        const args = explicit.map((expr, idx) => {
          const r = resolveArg(expr, scope)
          return { name: (formals[idx] && formals[idx].name) || '', expr: r.expr, value: r.value, resolved: r.resolved }
        })
        const lineNo = n.startLine + i
        const bucket = merged.get(lineNo) || []
        if (!bucket.some((b) => b.callee === callee)) bucket.push({ line: lineNo, callee, args })
        merged.set(lineNo, bucket)
      }
    }
    if (merged.size) {
      n.callArgs = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([line, bucket]) => ({ line, items: bucket }))
    }
  }
  return out
}

function attachBackendChain(trace, payload) {
  if (!index || !payload.url) return
  let pathname
  try { pathname = new URL(payload.url, 'http://localhost').pathname } catch { return }
  const reqNode = trace.nodes.find((n) => n.kind === 'request' && n.meta && n.meta.reqId === payload.reqId)
  const route = adapter.matchRoute(index.routes, String(payload.method || 'GET').toUpperCase(), pathname)
  if (!route) {
    // 索引快照里没有这条路由：可能是新加接口没重载索引，或路径拼写/Host 不同
    if (reqNode && reqNode.meta) reqNode.meta.unmatched = true
    return
  }
  const routeKey = `${route.method} ${route.path}`
  if (!treeCache.has(routeKey)) treeCache.set(routeKey, adapter.buildCallTree(index, route, CONFIG.chainDepth))
  const tree = treeCache.get(routeKey)
  if (!tree) return

  const resp = trace.nodes.find((n) => n.id === `${trace.id}#resp${payload.reqId}`)
  const linkStatus = resp && resp.status === 'error' ? 'error' : 'ok'
  const routeInfo = { method: route.method, path: route.path, file: route.file, line: route.line }
  if (reqNode && reqNode.meta) delete reqNode.meta.unmatched
  const reqParams = (reqNode && reqNode.meta.params) || requestParams(payload)
  const pathVars = pathParamsOf(route.path, pathname)
  if (Object.keys(pathVars).length) {
    reqParams.path = Object.assign({}, reqParams.path, pathVars)
    if (reqNode) reqNode.meta.params = reqParams
  }
  const edges = annotateArgs(tree, reqParams)
  // 一条 trace 里可能打了多个接口（轮询/多请求）：每个不同的路由各挂一棵方法树
  if (!trace.backends.some((b) => b.route.method === routeInfo.method && b.route.path === routeInfo.path)) {
    trace.backends.push({
      from: resp ? resp.id : lastRequestNode,
      rootId: tree.rootId,
      nodes: tree.nodes,
      edges,
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
