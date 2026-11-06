// 前端代码调用链（静态启发式）：
// 从「发请求的那个函数」出发，按同文件局部函数 + import 解析它调用的函数，
// 生成 组件函数 → 被调函数 → … 的代码卡片链，和 Java 那条方法链对应。
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const CACHE = new Map()
const MAX_BYTES = 400_000
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue']

function readText(file) {
  const hit = CACHE.get(file)
  if (hit !== undefined) return hit
  let text = null
  try {
    if (statSync(file).size <= MAX_BYTES) text = readFileSync(file, 'utf8')
  } catch { text = null }
  CACHE.set(file, text)
  return text
}

const HEAD = /(?:export\s+)?(?:async\s+)?function\s+([\w$]+)|(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function|\()|(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:async\s+)?([\w$]+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{/

// 从 startLine 向上找函数头，向下按花括号配对
export function functionAt(lines, lineNo) {
  const idx = Math.max(0, Math.min(lines.length - 1, lineNo - 1))
  let start = -1
  let name = ''
  for (let i = idx; i >= Math.max(0, idx - 160); i--) {
    const m = HEAD.exec(lines[i])
    if (m) { start = i; name = m[1] || m[2] || m[3] || m[4] || m[5] || ''; break }
  }
  if (start < 0) return null
  let depth = 0
  let opened = false
  let end = Math.min(lines.length - 1, start + 240)
  for (let i = start; i <= end; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) { end = i; break }
  }
  if (!opened) end = Math.min(lines.length - 1, idx + 24)
  if (end - start < 3) end = Math.min(lines.length - 1, start + 10)
  return { name, start, end }
}

function parseImports(text) {
  const map = new Map() // localName -> { spec, imported }
  const re = /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+([\w$]+)\s*)?from\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(text))) {
    const spec = m[4]
    if (m[1]) map.set(m[1], { spec, imported: 'default' })
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const p = part.trim()
        if (!p) continue
        const [orig, alias] = p.split(/\s+as\s+/)
        map.set((alias || orig).trim(), { spec, imported: orig.trim() })
      }
    }
    if (m[3]) map.set(m[3], { spec, imported: '*' })
  }
  return map
}

function resolveModule(fromFile, spec, frontendRoot) {
  let base
  if (spec.startsWith('@/')) base = join(frontendRoot, 'src', spec.slice(2))
  else if (spec.startsWith('/')) base = join(frontendRoot, spec.slice(1))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null // 第三方包不展开
  const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, 'index' + e))]
  for (const c of candidates) {
    const t = readText(c)
    if (t != null) return c
  }
  return null
}

// 在目标模块里找某个导出的定义（函数/const/箭头函数），返回 { file, start, end, name }
function findExportDef(file, importedName) {
  const text = readText(file)
  if (!text) return null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (!/\b(?:export|const|let|var|function)\b/.test(ln)) continue
    const m = HEAD.exec(ln)
    if (!m) continue
    const nm = m[1] || m[2] || m[3] || m[4] || m[5] || m[4] || m[5]
    if (!nm) continue
    if (importedName !== 'default' && importedName !== '*' && nm !== importedName) continue
    if (importedName === 'default' && !/export\s+default/.test(ln) && !/export\s+(?:async\s+)?function/.test(ln)) {
      // default 导出：取文件里第一个函数定义兜底
    }
    const def = functionAt(lines, i + 1)
    if (def) return { file, ...def }
  }
  return null
}

function callsIn(code) {
  const names = []
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g
  let m
  while ((m = re.exec(code))) {
    const n = m[1]
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'async', 'function', 'new'].includes(n)) continue
    if (!names.includes(n)) names.push(n)
  }
  return names
}

function looksLikeHttp(code) {
  return /\b(http|axios|request|fetch|api|client)\b/.test(code) || /\.(get|post|put|delete)\s*\(/.test(code)
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 对象成员定义：按括号配平 + 行尾符号判断片段结束（箭头函数体常续到下一行）
function memberEnd(lines, start) {
  let depth = 0
  let opened = false
  for (let i = start; i < Math.min(lines.length, start + 40); i++) {
    for (const ch of lines[i]) {
      if (ch === '(' || ch === '{') { depth++; opened = true } else if (ch === ')' || ch === '}') depth--
    }
    const t = lines[i].trim()
    if (opened && depth <= 0 && /[),;]$/.test(t) && (i > start || /\(.*\)/.test(t))) return i
  }
  return start
}

// 在模块里按名字找定义（对象属性、函数、const），返回 {file, start, end, name}
function findDefInModule(file, name) {
  const text = readText(file)
  if (!text) return null
  const lines = text.split('\n')
  const re = new RegExp(`(?:^|[\\s{,])(?:async\\s+)?${escapeRe(name)}\\s*(?::|\\()`)
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue
    return { file, name, start: i, end: memberEnd(lines, i) }
  }
  return null
}

const MAX_NODES = 5
const MAX_DEPTH = 2

// 按函数名在文件里定位定义（.vue 运行时行号带 script 偏移，名字更可靠）
function findByName(lines, name) {
  if (!name) return null
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(lines[i])
    if (!m) continue
    const nm = m[1] || m[2] || m[3] || m[4] || m[5] || m[4] || m[5]
    if (nm === name) return functionAt(lines, i + 1)
  }
  return null
}

function httpCallLine(lines, def) {
  for (let i = def.start; i <= def.end; i++) {
    if (/\.(?:get|post|put|delete|patch|request)\s*\(|\bfetch\s*\(|\baxios\b/.test(lines[i])) return i + 1
  }
  return def.start + 1
}

// 主入口：从 (file, line|funcName) 生成调用链节点与边
export function buildFrontendChain({ file, line, funcName, frontendRoot }) {
  const text = readText(file)
  if (!text) return { nodes: [], edges: [] }
  let lines = text.split('\n')
  let curFile = file
  let def = findByName(lines, funcName) || functionAt(lines, line)
  if (!def) return { nodes: [], edges: [] }

  const nodes = []
  const edges = []
  const seen = new Set()
  const keyOf = (f, d) => `${f}:${d.start}`
  const addNode = (f, d, role) => {
    const k = keyOf(f, d)
    if (seen.has(k)) return null
    seen.add(k)
    const ls = readText(f)?.split('\n') || lines
    const code = ls.slice(d.start, d.end + 1).join('\n')
    const id = `fe${nodes.length}`
    nodes.push({
      id, file: f, role,
      func: d.name || '',
      startLine: d.start + 1,
      endLine: d.end + 1,
      line: d.start + 1, // 默认高亮函数头；发起请求的节点后面覆盖
      code,
    })
    return id
  }

  const rootId = addNode(curFile, def, 'root')
  const rootNode = nodes[0]
  const reqLine = httpCallLine(lines, def)
  rootNode.line = reqLine
  rootNode.requestLine = reqLine

  const byKey = new Map()
  let current = rootId
  let currentFile = curFile
  let currentDef = def

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    if (nodes.length >= MAX_NODES) break
    const ls = readText(currentFile)?.split('\n') || []
    const code = ls.slice(currentDef.start, currentDef.end + 1).join('\n')
    const imports = parseImports(ls.join('\n'))
    const localDefs = new Map()
    for (let i = 0; i < ls.length; i++) {
      const m = HEAD.exec(ls[i])
      if (m) {
        const nm = m[1] || m[2] || m[3] || m[4] || m[5]
        if (nm && !localDefs.has(nm)) localDefs.set(nm, i + 1)
      }
    }
    // 按源码里出现的顺序收集可解析的调用，逐个尝试：
    // 1) xxx.method(...)：obj 是 import 来的 API 模块，method 在模块里有定义
    // 2) 同文件局部函数
    // 3) 直接 import 的函数
    const callRe = /\b([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\(/g
    const ordered = []
    let mm
    while ((mm = callRe.exec(code))) {
      const [, first, method] = mm
      if (method) {
        const imp = imports.get(first)
        if (!imp) continue
        const target = resolveModule(currentFile, imp.spec, frontendRoot)
        if (!target) continue
        const d = findDefInModule(target, method)
        if (d) ordered.push({ file: target, def: d, name: `${first}.${method}` })
        continue
      }
      if (first === currentDef.name) continue
      if (localDefs.has(first)) {
        const d = functionAt(ls, localDefs.get(first))
        if (d) ordered.push({ file: currentFile, def: d, name: first })
        continue
      }
      const imp = imports.get(first)
      if (!imp) continue
      const target = resolveModule(currentFile, imp.spec, frontendRoot)
      if (!target) continue
      const d = findExportDef(target, imp.imported)
      if (d) ordered.push({ file: target, def: d, name: first })
    }
    if (!ordered.length) break
    // 优先跟「函数体里真的在发 HTTP」的那个（API 层），其次按调用出现顺序
    const bodyOf = (c) => readText(c.file)?.split('\n').slice(c.def.start, c.def.end + 1).join('\n') || ''
    if (process.env.FGDEBUG) console.log('[fg] ordered', ordered.map((c) => `${c.name}:${c.def.start + 1}:${looksLikeHttp(bodyOf(c))}`))
    const next = ordered.find((c) => looksLikeHttp(bodyOf(c))) || ordered[0]
    const id = addNode(next.file, next.def, 'call')
    if (!id) break
    nodes[nodes.length - 1].line = next.def.start + 1
    edges.push({ from: current, to: id, line: currentDef.start + 1 })
    current = id
    currentFile = next.file
    currentDef = next.def
  }
  return { nodes, edges }
}
