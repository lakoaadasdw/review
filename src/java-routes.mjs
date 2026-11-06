/**
 * Java 静态适配器：解析 Spring Controller，得到
 *   URL → Controller 方法 → （有限的）方法调用链。
 * 纯正则实现，不依赖 Maven/JDK；精度是"方法级近似"，反射/动态代理处会断链。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { buildCallTree, matchRoute, normalizeRoutePath, summarize } from './graph-core.mjs'

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw', 'synchronized', 'try', 'else', 'do', 'super', 'this'])

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

function walkJava(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'target', '.git', 'build'].includes(e.name)) continue
      walkJava(full, out)
    } else if (e.isFile() && e.name.endsWith('.java')) out.push(full)
  }
  return out
}

function walkFiles(dir, ext, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'target', '.git', 'build', 'dist'].includes(e.name)) continue
      walkFiles(full, ext, out)
    } else if (e.isFile() && e.name.endsWith(ext)) out.push(full)
  }
  return out
}

/**
 * 解析 MyBatis Mapper XML：namespace + 每个语句（select/insert/update/delete/sql）的源码块。
 * code 保留原标签；sql 把 <include refid="..."/> 递归替换成对应 <sql> 片段，方便直接看最终 SQL。
 */
function parseMapperXml(file) {
  const raw = readFileSync(file, 'utf8')
  const nsMatch = /<mapper\s+[^>]*namespace\s*=\s*"([^"]+)"/.exec(raw)
  if (!nsMatch) return null
  const namespace = nsMatch[1]
  const rawStatements = new Map()
  for (const m of raw.matchAll(/<(select|insert|update|delete|sql)\b([^>]*)>/g)) {
    const tag = m[1]
    const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(m[2] || '')
    if (!idMatch) continue
    const id = idMatch[1]
    const closeIdx = raw.indexOf(`</${tag}>`, m.index)
    if (closeIdx < 0) continue
    const endIdx = closeIdx + `</${tag}>`.length
    rawStatements.set(id, {
      id,
      tag,
      file,
      startLine: lineAt(raw, m.index),
      endLine: lineAt(raw, endIdx),
      code: raw.slice(m.index, endIdx),
    })
  }

  const expand = (text, depth = 0) => {
    if (depth > 4) return text
    return text.replace(/<include\b[^>]*refid\s*=\s*"([^"]+)"[^>]*\/?>(?:<\/include>)?/g, (whole, refid) => {
      const frag = rawStatements.get(refid)
      if (!frag) return whole
      return expand(frag.code.replace(/^<sql\b[^>]*>/, '').replace(/<\/sql>\s*$/, ''), depth + 1)
    })
  }

  for (const st of rawStatements.values()) st.sql = expand(st.code)
  return { namespace, file, statements: rawStatements }
}

function matchBrace(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 平衡括号匹配（跳过字符串，避免参数里的注解括号干扰） */
function matchParen(text, openIndex) {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++ }
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 解析一个 Java 文件：类名、字段类型、方法（位置/方法体/原始调用片段） */
function parseJavaFile(file) {
  const raw = readFileSync(file, 'utf8')
  const text = stripComments(raw)
  const classMatch = /(?:public\s+)?(?:final\s+|abstract\s+)?class\s+(\w+)/.exec(text)
  const ifaceMatch = /(?:public\s+)?interface\s+(\w+)/.exec(text)
  const className = classMatch ? classMatch[1] : ifaceMatch ? ifaceMatch[1] : null
  if (!className) return null
  const isInterface = !classMatch
  const implementsList = classMatch
    ? [...(/(?:implements)\s+([\w$.,<>\s]+?)(?:\{|$)/.exec(text.slice(classMatch.index))?.[1] || '').matchAll(/([A-Z][\w$]*)/g)].map((x) => x[1])
    : []

  const fields = new Map()
  for (const m of text.matchAll(/(?:private|protected|public)\s+(?:final\s+)?([A-Z]\w*)\s+(\w+)\s*[;=]/g)) {
    fields.set(m[2], m[1])
  }

  const methods = new Map()
  // 接口：只解析方法签名（Mapper / Service interface），签名可能跨多行
  if (isInterface) {
    const declRe = /([A-Za-z_$][\w$<>\[\],.?\s]*?)\b([A-Za-z_$][\w$]*)\s*\(/g
    for (const m of text.matchAll(declRe)) {
      const name = m[2]
      if (KEYWORDS.has(name) || methods.has(name) || name === className) continue
      const typeTokens = m[1].trim().split(/\s+/).filter(Boolean)
      if (typeTokens.length < 1) continue
      const lastType = typeTokens[typeTokens.length - 1]
      if (!/^(?:[A-Z][\w$<>\[\],.?]*|void|int|long|short|byte|char|boolean|double|float|String|Object|List|Map|Set|Optional|Page)$/.test(lastType)) continue
      const parenOpen = m.index + m[0].length - 1
      const parenClose = matchParen(text, parenOpen)
      if (parenClose < 0) continue
      let k = parenClose + 1
      while (k < text.length && /\s/.test(text[k])) k++
      if (text[k] !== ';') continue
      methods.set(name, {
        name,
        line: lineAt(text, m.index),
        endLine: lineAt(text, parenClose),
        start: 0,
        end: 0,
        body: '',
        params: parseParamTypes(text, parenOpen, parenClose),
        iface: true,
      })
    }
    const implementsList = []
    return { file, className, fields, methods, text, raw, isInterface, implementsList }
  }
  const declRe = /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]*>\s*)?[\w$<>\[\],\s.?]+\s+(\w+)\s*\(/g
  for (const m of text.matchAll(declRe)) {
    const name = m[1]
    if (KEYWORDS.has(name)) continue
    const parenOpen = m.index + m[0].length - 1
    // 参数列表可能跨多行且含注解括号，用平衡括号向前扫
    let depth = 0
    let parenClose = -1
    for (let i = parenOpen; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"' || ch === "'") {
        const quote = ch
        i++
        while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++ }
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) { parenClose = i; break } }
    }
    if (parenClose < 0) continue
    const braceOpen = text.indexOf('{', parenClose)
    if (braceOpen < 0 || braceOpen - parenClose > 200) continue
    const bodyClose = matchBrace(text, braceOpen)
    if (bodyClose < 0) continue
    if (methods.has(name)) continue // 重载只保留第一个
    methods.set(name, {
      name,
      line: lineAt(text, m.index),
      endLine: lineAt(text, bodyClose),
      start: braceOpen + 1,
      end: bodyClose,
      body: text.slice(braceOpen + 1, bodyClose),
      params: parseParamTypes(text, parenOpen, parenClose),
    })
  }
  return { file, className, fields, methods, text, raw, implementsList }
}

/**
 * 抽取"方法直接调用了谁"：依赖字段调用 / this 调用 / 同类本地调用 / 静态类名调用。
 * 每条调用带调用点行号与所在代码片段，供前端从"那一行"拉线。
 */
function extractCalls(parsed, classes, implOf) {
  const calls = []
  const sites = []
  const unresolved = []
  const self = parsed.methods
  const { text } = parsed
  // 三分类：actionable（项目内真断了）/ external（JDK、第三方库）/ generated（Lombok、MyBatis Mapper 代理等生成代码）
  const miss = (method, absIndex, recv, name, reason) => {
    let kind = 'actionable'
    if (reason === 'unknown-receiver' || reason === 'unknown-class') kind = 'external'
    else if (reason === 'no-such-method') {
      // 接收者是字段/形参 → 项目内类真的没这个方法（actionable）；接收者是大写类名 → Lombok builder / 静态工具（generated）
      const fromField = parsed.fields.has(recv)
      const fromParam = method.params && method.params.has(recv)
      // Lombok 生成器：getXxx()/setXxx()/isXxx()/builder()/build() 在源码里不存在
      const lombokLike = /^(get|set|is)[A-Z]\w*$|^(builder|build)$/.test(name)
      kind = (fromField || fromParam) && !lombokLike ? 'actionable' : 'generated'
    } else if (reason === 'iface-no-impl') {
      // Mapper 接口的实现由 MyBatis 运行时生成
      const iface = (classes.get(recv) || classes.get(recv)) || null
      const isMapper = /Mapper$/.test(recv) || (iface && /@Mapper/.test(iface.text || ''))
      kind = isMapper ? 'generated' : 'actionable'
    }
    unresolved.push({
      cls: parsed.className,
      from: method.name,
      line: lineAt(text, absIndex),
      recv,
      name,
      reason,
      kind,
    })
  }
  for (const method of parsed.methods.values()) {
    const seen = new Set()
    // 方法体内局部变量声明（含 for-each / try-with-resources），用于解析 user.getName() 这类本地变量调用
    const localTypes = new Map()
    if (method.body) {
      for (const m of method.body.matchAll(/(?:^|[^\w$.])([A-Z][\w$]*(?:<[^;=(){}]*>)?)\s+([a-z_$][\w$]*)\s*(?=[=;:,)])/g)) {
        localTypes.set(m[2], m[1].replace(/<.*>$/, '').trim())
      }
      for (const m of method.body.matchAll(/for\s*\(\s*(?:final\s+)?([A-Z][\w$]*(?:<[^;:]*>)?)\s+([a-z_$][\w$]*)\s*:/g)) {
        localTypes.set(m[2], m[1].replace(/<.*>$/, '').trim())
      }
    }
    const push = (toClass, toMethod, absIndex) => {
      const key = `${toClass}.${toMethod}`
      // 每个调用点都记一条（site），图上的边仍按目标去重
      sites.push({ toClass, toMethod, callLine: lineAt(text, absIndex) })
      if (seen.has(key)) return
      seen.add(key)
      calls.push({
        from: method.name,
        toClass,
        toMethod,
        key,
        callLine: lineAt(text, absIndex),
        snippet: String(text.slice(absIndex, absIndex + 160)).split('\n')[0].trim().slice(0, 140),
      })
    }
    // 1) 接收者调用：xxx.foo(...)  xxx 可能是字段 / this / 静态类名
    for (const m of method.body.matchAll(/([a-zA-Z_$][\w$]*)\s*\.\s*([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const [, recv, name] = m
      if (KEYWORDS.has(name) || KEYWORDS.has(recv)) continue
      const absIndex = method.start + m.index
      const localType = localTypes.get(recv)
      const owner = recv === 'this'
        ? parsed.className
        : localType || parsed.fields.get(recv) || (method.params && method.params.get(recv)) || (classes.has(recv) ? recv : null)
      if (!owner) { miss(method, absIndex, recv, name, 'unknown-receiver'); continue }
      let target = classes.get(owner)
      if (!target) { miss(method, absIndex, recv, name, 'unknown-class'); continue }
      if (!target.methods.has(name)) {
        if (target.isInterface) {
          const impls = implOf && implOf.has(owner) ? (implOf.get(owner) || []).filter((c) => classes.get(c) && classes.get(c).methods.has(name)) : []
          if (impls.length === 1) {
            target = classes.get(impls[0])
          } else if (impls.length > 1) {
            miss(method, absIndex, recv, name, `iface-multi-impl(${impls.length})`); continue
          } else {
            miss(method, absIndex, recv, name, 'iface-no-impl'); continue
          }
        } else {
          miss(method, absIndex, recv, name, 'no-such-method'); continue
        }
      }
      // 字段声明成接口（Service/Mapper）：如果只有一个实现类且实现了这个方法，就跳到实现类
      if (target.isInterface && implOf && implOf.has(owner)) {
        const impls = (implOf.get(owner) || []).filter((c) => classes.get(c) && classes.get(c).methods.has(name))
        if (impls.length === 1) target = classes.get(impls[0])
      }
      const toClass = target.className
      if (!target.methods.has(name)) { miss(method, absIndex, recv, name, 'unresolved-after-impl'); continue }
      push(toClass, name, absIndex)
    }
    // 2) 同类本地调用： foo(...)
    for (const m of method.body.matchAll(/(?:^|[^.\w$])([a-z][\w$]*)\s*\(/g)) {
      const name = m[1]
      if (KEYWORDS.has(name) || name === method.name) continue
      if (!self.has(name)) continue
      push(parsed.className, name, method.start + m.index)
    }
  }
  return { calls, sites, unresolved }
}

/** 按顶层逗号切分（忽略括号与字符串内的逗号） */
function splitParams(s) {
  const out = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"' || ch === "'") {
      const q = ch
      cur += ch
      i++
      while (i < s.length && s[i] !== q) { cur += s[i]; if (s[i] === String.fromCharCode(92)) { i++; cur += s[i] } i++ }
      continue
    }
    if (ch === '(' || ch === '<' || ch === '[') depth++
    else if (ch === ')' || ch === '>' || ch === ']') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** 从参数列表文本解析 形参名 -> 类型（去掉注解/final/可变参数） */
function parseParamTypes(text, parenOpen, parenClose) {
  const map = new Map()
  if (parenOpen < 0 || parenClose <= parenOpen) return map
  const raw = text.slice(parenOpen + 1, parenClose)
  for (const part of splitParams(raw)) {
    const clean = part
      .replace(/@[\w$.]+\s*\([^)]*\)/g, ' ')
      .replace(/@[\w$.]+/g, ' ')
      .replace(/final/g, ' ')
      .replace(/\.\.\./g, ' ')
      .replace(/<[^<>]*>/g, ' ')
      .trim()
    if (!clean) continue
    const m = /([A-Za-z_$][\w$]*(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*$/.exec(clean)
    if (!m) continue
    map.set(m[2], m[1])
  }
  return map
}

const MAPPING_RE = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/g
const HTTP_METHOD = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' }

/** 从注解名之后解析括号参数（跳过字符串、支持嵌套），无括号返回空串 */
function readAnnotationArgs(text, startIndex) {
  let i = startIndex
  while (i < text.length && /\s/.test(text[i])) i++
  if (text[i] !== '(') return { args: '', end: i }
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (ch === '"' || ch === "'") {
      const quote = ch
      j++
      while (j < text.length && text[j] !== quote) { if (text[j] === '\\') j++; j++ }
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return { args: text.slice(i, j + 1), end: j + 1 } }
  }
  return { args: '', end: i }
}

function annotationPaths(args) {
  const paths = [...String(args).matchAll(/["']([^"']*)["']/g)].map((m) => m[1]).filter((p) => p.startsWith('/'))
  return paths.length ? paths : ['']
}

function annotationHttpMethods(args) {
  const found = [...String(args).matchAll(/RequestMethod\.([A-Z]+)/g)].map((m) => m[1])
  return found.length ? found : null
}

function isImportMatch(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1
  return /^\s*import\s/.test(text.slice(lineStart, index))
}

function expandChain(startKey, classes, edges, maxDepth) {
  const out = []
  const visited = new Set([startKey])
  const queue = [{ key: startKey, depth: 0 }]
  while (queue.length) {
    const { key, depth } = queue.shift()
    if (depth >= maxDepth) continue
    for (const next of edges.get(key) || []) {
      const nextKey = `${next.toClass}.${next.toMethod}`
      const target = classes.get(next.toClass)
      const meta = target?.methods.get(next.toMethod)
      if (!target || !meta) continue
      const item = { key: nextKey, cls: next.toClass, method: next.toMethod, file: target.file, line: meta.line, depth: depth + 1 }
      out.push(item)
      if (!visited.has(nextKey)) { visited.add(nextKey); queue.push({ key: nextKey, depth: depth + 1 }) }
    }
  }
  return out
}

/** 主入口：扫描一个后端源码根目录，返回路由表 + 方法索引 */
export function indexJavaProject(root) {
  const files = walkJava(root)
  const classes = new Map()
  const parsedList = []

  // 第一遍：解析所有类的方法/字段
  for (const file of files) {
    const parsed = parseJavaFile(file)
    if (!parsed) continue
    parsedList.push(parsed)
    classes.set(parsed.className, parsed)
  }

  // 第二遍：方法全量索引（含完整源码），以及方法间调用边
  const methodIndex = new Map() // 'Cls.method' -> { key, cls, method, file, startLine, endLine, code, calls: [...] }
  for (const parsed of parsedList) {
    const lines = parsed.raw.split('\n')
    for (const m of parsed.methods.values()) {
      const key = `${parsed.className}.${m.name}`
      if (methodIndex.has(key)) continue
      methodIndex.set(key, {
        key,
        cls: parsed.className,
        method: m.name,
        file: parsed.file,
        startLine: m.line,
        endLine: m.endLine,
        code: lines.slice(m.line - 1, m.endLine).join('\n'),
        calls: [],
      })
    }
  }

  const edges = new Map() // 'Cls.method' -> [{ toClass, toMethod, callLine, snippet }]
  const implOf = new Map()
  for (const parsed of parsedList) {
    for (const iface of parsed.implementsList || []) {
      if (!implOf.has(iface)) implOf.set(iface, [])
      implOf.get(iface).push(parsed.className)
    }
  }
  const unresolvedAll = []
  const allSites = []
  for (const parsed of parsedList) {
    const { calls: fileCalls, sites: fileSites, unresolved: fileUnresolved } = extractCalls(parsed, classes, implOf)
    for (const site of fileSites) allSites.push({ ...site, file: parsed.file })
    for (const u of fileUnresolved) unresolvedAll.push({ ...u, file: parsed.file })
    for (const call of fileCalls) {
      const fromKey = `${parsed.className}.${call.from}`
      if (!edges.has(fromKey)) edges.set(fromKey, [])
      edges.get(fromKey).push(call)
      const own = methodIndex.get(fromKey)
      const target = methodIndex.get(call.key)
      if (own && target) {
        own.calls.push({ toKey: call.key, toClass: call.toClass, toMethod: call.toMethod, callLine: call.callLine, snippet: call.snippet })
      }
    }
  }

  // 第三遍：抽取 Controller 路由
  const routes = []
  const seenRoutes = new Set()
  for (const parsed of parsedList) {
    if (!/@(RestController|Controller)\b/.test(parsed.text)) continue
    const classMatch = /(?:public\s+)?(?:final\s+|abstract\s+)?class\s+(\w+)/.exec(parsed.text)
    const classIndex = classMatch ? classMatch.index : 0
    const beforeClass = parsed.text.slice(0, classIndex)
    const baseAnnotations = [...beforeClass.matchAll(/@RequestMapping\s*\(([^)]*)\)/g)]
    const basePaths = baseAnnotations.length ? annotationPaths(baseAnnotations[baseAnnotations.length - 1][1]) : ['']

    for (const m of parsed.text.matchAll(MAPPING_RE)) {
      if (isImportMatch(parsed.text, m.index)) continue
      const kind = m[1]
      const { args, end } = readAnnotationArgs(parsed.text, m.index + m[0].length)
      // 注解之后（可隔其它注解）必须是方法签名
      const tail = parsed.text.slice(end, end + 500)
      const sig = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w$<>\[\],\s.?]+\s+(\w+)\s*\(/.exec(tail)
      if (!sig) continue
      const javaMethod = sig[1]
      const methodMeta = parsed.methods.get(javaMethod)
      if (!methodMeta) continue

      const paths = annotationPaths(args)
      const kinds = kind === 'RequestMapping' ? (annotationHttpMethods(args) || ['GET']) : [HTTP_METHOD[kind] || 'GET']
      for (const base of basePaths) {
        for (const p of paths) {
          for (const httpMethod of kinds) {
            const path = normalizeRoutePath(base, p)
            const key = `${httpMethod} ${path} ${parsed.className}.${javaMethod}`
            if (seenRoutes.has(key)) continue
            seenRoutes.add(key)
            routes.push({
              method: httpMethod,
              path,
              controller: parsed.className,
              javaMethod,
              entryId: `${parsed.className}.${javaMethod}`,
              file: parsed.file,
              line: methodMeta.line,
            })
          }
        }
      }
    }
  }

  // 为每条路由展开静态调用链（扁平 depth 2，用于路由概览）
  for (const route of routes) {
    route.chain = expandChain(`${route.controller}.${route.javaMethod}`, classes, edges, 2)
  }

  // 第四遍：MyBatis Mapper XML —— 把 Mapper 接口方法的节点换成 XML 里的 SQL 语句块
  const backendBase = root.replace(/src.main.java$/, '')
  const resourcesDir = join(backendBase, 'src', 'main', 'resources')
  const mapperByClass = new Map()
  for (const xmlFile of walkFiles(resourcesDir, '.xml')) {
    const mp = parseMapperXml(xmlFile)
    if (!mp) continue
    const simple = mp.namespace.split('.').pop()
    mapperByClass.set(simple, mp)
  }
  let mapperHits = 0
  for (const entry of methodIndex.values()) {
    const cls = classes.get(entry.cls)
    if (!cls || !cls.isInterface) continue
    const mp = mapperByClass.get(entry.cls)
    const st = mp && mp.statements.get(entry.method)
    if (!st) continue
    entry.file = st.file
    entry.startLine = st.startLine
    entry.endLine = st.endLine
    entry.code = st.sql || st.code
    entry.xml = true
    entry.xmlTag = st.tag
    mapperHits++
  }

  const warnings = []
  if (!routes.length) warnings.push(`在 ${root} 下没有解析到 Spring Controller 路由`)
  // 去重（同一类同一方法里同一接收者同一方法名只记一次）
  const seenMiss = new Set()
  const unresolved = []
  for (const u of unresolvedAll) {
    const k = `${u.cls}|${u.from}|${u.recv}|${u.name}`
    if (seenMiss.has(k)) continue
    seenMiss.add(k)
    unresolved.push(u)
  }
  const actionable = unresolved.filter((u) => u.kind === 'actionable')
  const external = unresolved.filter((u) => u.kind === 'external')
  const generated = unresolved.filter((u) => u.kind === 'generated')
  const diagnostics = { unresolved, actionable: actionable.length, external: external.length, generated: generated.length }
  if (actionable.length) warnings.push(`有 ${actionable.length} 处项目内方法调用未解析（详见 diagnostics.unresolved）`)
  return { root, files: files.length, classes: classes.size, routes, methods: methodIndex, callSites: allSites, mappers: mapperByClass.size, mapperHits, diagnostics, warnings }
}

// 语言无关的 matchRoute / buildCallTree / summarize 来自 graph-core，这里按旧接口再导出，
// 方便 server 与历史脚本继续按 java-routes 的入口调用。
export { buildCallTree, matchRoute, summarize }
