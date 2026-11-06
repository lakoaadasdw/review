/**
 * Python 适配器（FastAPI / Flask 起步，Django 后续）：
 *   python ast_dump.py → JSON → 统一 IR（routes + methods + calls）
 * 只读源码、只做静态解析，不执行项目代码。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCallTree, matchRoute, normalizeRoutePath, summarize } from '../graph-core.mjs'

const AST_DUMP = fileURLToPath(new URL('../py/ast_dump.py', import.meta.url))
const ROUTE_METHODS = {
  get: ['GET'], post: ['POST'], put: ['PUT'], delete: ['DELETE'],
  patch: ['PATCH'], head: ['HEAD'], options: ['OPTIONS'],
}
const ROUTE_ANY = new Set(['route', 'api_route'])
const VENV_SKIP = new Set(['__pycache__', '.venv', 'venv', 'env', '.git', 'node_modules', 'site-packages'])

/** 向上最多 4 层找 Python 项目标记；root 本身也可以是项目根 */
export function detectPython(root) {
  const markers = ['pyproject.toml', 'setup.py', 'setup.cfg', 'manage.py', 'requirements.txt', 'Pipfile']
  let cur = root
  for (let i = 0; i < 5; i++) {
    for (const m of markers) {
      try {
        if (statSync(join(cur, m)).isFile()) return true
      } catch {}
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

/** pyproject.toml / requirements.txt 里认出 FastAPI / Flask / Django（用于给前端提示当前框架） */
function detectFramework(root) {
  for (const rel of ['pyproject.toml', 'requirements.txt', 'Pipfile']) {
    let text = ''
    try {
      text = readFileSync(join(root, rel), 'utf8')
    } catch {
      continue
    }
    const lower = text.toLowerCase()
    if (lower.includes('fastapi')) return 'fastapi'
    if (lower.includes('django')) return 'django'
    if (lower.includes('flask')) return 'flask'
  }
  return 'python'
}

function moduleNameOf(relFile) {
  const noExt = relFile.replace(/\.py$/, '')
  const parts = noExt.split('/')
  if (parts[parts.length - 1] === '__init__') parts.pop()
  return parts.join('.')
}

function dirModules(relFile) {
  const noExt = relFile.replace(/\.py$/, '')
  const parts = noExt.split('/')
  if (parts[parts.length - 1] === '__init__') parts.pop()
  const out = new Set()
  for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('.'))
  return out
}

function joinRoutePath(...parts) {
  let out = ''
  for (const part of parts) {
    if (!part) continue
    out = normalizeRoutePath(out, part)
  }
  return out || '/'
}

function readLines(root, relFile) {
  try {
    return readFileSync(join(root, relFile), 'utf8').split('\n')
  } catch {
    return []
  }
}

function snippetAt(lines, line) {
  const text = lines[line - 1]
  return (text || '').trim().slice(0, 120)
}

function walkMarkers(root) {
  const counts = { py: 0 }
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (VENV_SKIP.has(entry.name) || entry.name.startsWith('.')) continue
        stack.push(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.py')) counts.py++
    }
  }
  return counts
}

/** 目录指纹：所有 .py 的相对路径 + 大小 + mtime，用于判断缓存是否失效 */
function dirFingerprint(root) {
  const parts = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (VENV_SKIP.has(entry.name) || entry.name.startsWith('.')) continue
        stack.push(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        const abs = join(dir, entry.name)
        let st
        try {
          st = statSync(abs)
        } catch {
          continue
        }
        const rel = abs.slice(root.length).split(String.fromCharCode(92)).join('/')
        parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`)
      }
    }
  }
  parts.sort()
  return createHash('sha1').update(parts.join(String.fromCharCode(10))).digest('hex')
}

function cachePathFor(root) {
  const key = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)
  return join(tmpdir(), `apiflow-pyast-${key}.json`)
}

function dumpAst(root, python) {
  const useCache = process.env.APIFLOW_NO_CACHE !== '1'
  const cachePath = cachePathFor(root)
  let fingerprint = null
  if (useCache) {
    try {
      fingerprint = dirFingerprint(root)
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
        if (cached && cached.fingerprint === fingerprint && cached.dump) {
          return cached.dump
        }
      }
    } catch {
      fingerprint = null
    }
  }
  let raw
  try {
    raw = execFileSync(python, ['-X', 'utf8', AST_DUMP, root], {
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const stderr = String(err?.stderr || '').trim()
    throw new Error(`python ast 解析失败（${python}）：${stderr || String(err?.message || err)}`)
  }
  const parsed = JSON.parse(raw)
  if (parsed.error) throw new Error(parsed.error)
  if (useCache && fingerprint) {
    try {
      writeFileSync(cachePath, JSON.stringify({ fingerprint, createdAt: Date.now(), root, dump: parsed }))
    } catch {
      /* 缓存写失败不影响主流程 */
    }
  }
  return parsed
}

export function indexPythonProject(root, options = {}) {
  const python = options.python || process.env.APIFLOW_PYTHON || 'python'
  const dump = dumpAst(root, python)
  const files = dump.files || []
  const relSet = new Set(files.map((f) => f.file))
  const dottedToRel = new Map()
  for (const file of files) dottedToRel.set(moduleNameOf(file.file), file.file)

  const linesByFile = new Map()
  const linesOf = (rel) => {
    if (!linesByFile.has(rel)) linesByFile.set(rel, readLines(root, rel))
    return linesByFile.get(rel)
  }

  // 每个文件的 import 别名表
  const modulesByFile = new Map() // rel -> Map<local, dottedModule>
  const namesByFile = new Map() // rel -> Map<local, { module, name }>
  for (const file of files) {
    const mods = new Map()
    const names = new Map()
    for (const imp of file.imports || []) {
      if (imp.kind === 'import') {
        const local = imp.asname || imp.module.split('.')[0]
        if (imp.asname) mods.set(local, imp.module)
        else {
          for (const dir of dirModules(`${imp.module.split('.').join('/')}.py`)) mods.set(dir.split('.').pop(), dir)
        }
      } else if (imp.module) {
        const dotted = imp.level ? '' : imp.module
        if (!dotted) continue
        const full = imp.name ? `${dotted}.${imp.name}` : dotted
        if (dottedToRel.has(full)) mods.set(imp.asname || imp.name, full)
        else names.set(imp.asname || imp.name, { module: dotted, name: imp.name })
      }
    }
    modulesByFile.set(file.file, mods)
    namesByFile.set(file.file, names)
  }

  const resolveModule = (rel, local) => {
    const dotted = modulesByFile.get(rel)?.get(local)
    return dotted ? dottedToRel.get(dotted) || null : null
  }

  // 路由前缀：文件内 APIRouter(prefix=…)，再叠加 include_router(prefix=…)
  const routerPrefixByFile = new Map() // rel -> Map<var, prefix>
  for (const file of files) {
    const map = new Map()
    for (const router of file.routers || []) {
      if (!/Router$|^FastAPI$|^Blueprint$/.test(String(router.kind || ''))) continue
      map.set(router.var, String(router.kw?.prefix || ''))
    }
    if (map.size) routerPrefixByFile.set(file.file, map)
  }
  const includePrefix = new Map() // `${rel}#${var}` -> prefix
  for (const file of files) {
    for (const inc of file.includes || []) {
      const [base, attr] = String(inc.target).split('.')
      const prefix = String(inc.kw?.prefix || '')
      if (!prefix) continue
      let targetRel = resolveModule(file.file, base)
      let targetVar = attr || 'router'
      if (targetRel) {
        const key = `${targetRel}#${targetVar}`
        if (!includePrefix.has(key)) includePrefix.set(key, prefix)
        continue
      }
      // app.include_router(auth.router)：base 是模块别名、attr 是 router 变量
      if (attr) {
        targetRel = dottedToRel.get(base) || resolveModule(file.file, base)
        if (targetRel) {
          const key = `${targetRel}#${attr}`
          if (!includePrefix.has(key)) includePrefix.set(key, prefix)
        }
      }
    }
  }

  // 函数索引
  const methods = new Map()
  const functionsByFile = new Map() // rel -> Map<qual, id>
  const addFunction = (rel, entry) => {
    const id = `${rel}::${entry.qual}`
    const lines = linesOf(rel)
    const startLine = entry.lineno
    const endLine = entry.end_lineno || startLine
    methods.set(id, {
      id,
      cls: entry.cls || basename(rel, '.py'),
      method: entry.name,
      file: rel,
      startLine,
      endLine,
      code: lines.slice(startLine - 1, endLine).join('\n'),
      calls: [],
    })
    if (!functionsByFile.has(rel)) functionsByFile.set(rel, new Map())
    functionsByFile.get(rel).set(entry.qual, id)
    return id
  }
  for (const file of files) {
    for (const fn of file.functions || []) addFunction(file.file, fn)
    for (const cls of file.classes || []) {
      for (const fn of cls.methods || []) addFunction(file.file, fn)
    }
  }

  const resolveCall = (file, call, cls) => {
    const local = functionsByFile.get(file)
    if (call.kind === 'name') {
      if (local?.has(call.name)) return local.get(call.name)
      const imported = namesByFile.get(file)?.get(call.name)
      if (imported) {
        const targetRel = dottedToRel.get(imported.module)
        const fnMap = targetRel ? functionsByFile.get(targetRel) : null
        if (fnMap?.has(imported.name)) return fnMap.get(imported.name)
      }
      return null
    }
    if (call.kind !== 'attr') return null
    const base = String(call.base || '')
    if (base === 'self' || base === 'cls') {
      return local?.get(`${cls}.${call.name}`) || null
    }
    const moduleRel = resolveModule(file, base)
    if (!moduleRel) return null
    const fnMap = functionsByFile.get(moduleRel)
    return fnMap?.get(call.name) || null
  }

  const warnings = []
  let edges = 0
  for (const file of files) {
    const all = [...(file.functions || []), ...(file.classes || []).flatMap((c) => c.methods || [])]
    for (const fn of all) {
      const fromId = functionsByFile.get(file.file)?.get(fn.qual)
      const meta = fromId ? methods.get(fromId) : null
      if (!meta) continue
      const seen = new Set()
      for (const call of fn.calls || []) {
        const toKey = resolveCall(file.file, call, fn.cls)
        if (!toKey || toKey === fromId || seen.has(`${toKey}:${call.lineno}`)) continue
        seen.add(`${toKey}:${call.lineno}`)
        meta.calls.push({ toKey, callLine: call.lineno, snippet: snippetAt(linesOf(file.file), call.lineno) })
        edges++
      }
    }
  }

  // 路由
  const routes = []
  const seenRoutes = new Set()
  for (const file of files) {
    const routers = routerPrefixByFile.get(file.file) || new Map()
    const functions = [...(file.functions || []), ...(file.classes || []).flatMap((c) => c.methods || [])]
    for (const fn of functions) {
      for (const dec of fn.decorators || []) {
        const name = String(dec.name || '')
        const isRouteAny = ROUTE_ANY.has(name)
        const httpMethods = ROUTE_METHODS[name] || (isRouteAny ? null : null)
        if (!httpMethods && !isRouteAny) continue
        const base = dec.base ? String(dec.base) : ''
        const ownPrefix = routers.get(base)
        const incPrefix = includePrefix.get(`${file.file}#${base}`) || ''
        if (ownPrefix === undefined && !incPrefix) {
          // @app.get / 未识别的前缀变量：仍然接受 '@app' 这种常量变量
          if (base !== 'app' && base !== 'application') continue
        }
        const pathArg = typeof dec.args?.[0] === 'string' ? dec.args[0] : ''
        const methods = httpMethods || (Array.isArray(dec.kw?.methods) ? dec.kw.methods.map((m) => String(m).toUpperCase()) : ['GET'])
        const routePath = joinRoutePath(incPrefix, ownPrefix || '', pathArg)
        const entryId = functionsByFile.get(file.file)?.get(fn.qual)
        if (!entryId) continue
        for (const httpMethod of methods) {
          const key = `${httpMethod} ${routePath} ${entryId}`
          if (seenRoutes.has(key)) continue
          seenRoutes.add(key)
          routes.push({
            method: httpMethod,
            path: routePath,
            controller: fn.cls || basename(file.file, '.py'),
            javaMethod: fn.name,
            entryId,
            file: file.file,
            line: fn.lineno,
          })
        }
      }
    }
  }

  if (!routes.length) warnings.push(`在 ${root} 下没有解析到 Python 路由（支持 FastAPI/Flask 装饰器）`)
  if (!files.length) warnings.push(`在 ${root} 下没有找到 .py 文件`)

  const counts = walkMarkers(root)
  return {
    lang: 'python',
    framework: detectFramework(root),
    root,
    files: files.length,
    modules: files.length,
    pyFiles: counts.py,
    routes,
    methods,
    edges,
    warnings,
  }
}

export const pythonAdapter = {
  id: 'python',
  label: 'Python / FastAPI · Flask',
  detect: detectPython,
  index: indexPythonProject,
  buildCallTree,
  matchRoute,
  summarize: (index) => ({ ...summarize(index), lang: 'python', framework: index.framework }),
}
