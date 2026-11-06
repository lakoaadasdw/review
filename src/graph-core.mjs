/**
 * 语言无关的图逻辑：路由匹配、调用树、节点工装、摘要。
 *
 * 适配器（adapters/*.mjs）只负责「把某种语言的源码变成统一 IR」：
 *   index = {
 *     root, files, classes, routes: [{ method, path, entryId, file, line, ... }],
 *     methods: Map<id, { id, cls, method, file, startLine, endLine, code, calls: [{ toKey, callLine, snippet }], xml?, xmlTag? }>,
 *     warnings: string[],
 *   }
 * 本模块只吃这个 IR，不认识 Java / Python 语法。
 */

/** 把 base 与子路径拼成规范化的 URL 路径 */
export function normalizeRoutePath(base, p) {
  const joined = `${base || ''}/${p || ''}`.replace(/\/{2,}/g, '/')
  const normalized = joined.replace(/\/+$/, '') || '/'
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

/** 路由 path → 正则：支持 {var} 与结尾 /** */
function pathToRegExp(path) {
  const src = path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^}]*\\\}/g, '[^/]+')
    .replace(/\/\*\*$/, '.*')
  return new RegExp(`^${src}/?$`)
}

function routeScore(path) {
  return path.split('/').filter(Boolean).length * 10 - (path.match(/\{/g) || []).length
}

// 路由正则在启动时按 path 预编译一次（原来每次请求都 new RegExp）
const RE_CACHE = new Map()
function pathRe(path) {
  let re = RE_CACHE.get(path)
  if (!re) {
    re = pathToRegExp(path)
    RE_CACHE.set(path, re)
  }
  return re
}

// 按 HTTP method 分组，避免每次请求遍历全量路由；以 routes 数组为键缓存
const BY_METHOD = new WeakMap()
function routesByMethod(routes) {
  let map = BY_METHOD.get(routes)
  if (!map) {
    map = new Map()
    for (const route of routes) {
      const key = route.method || 'GET'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(route)
    }
    BY_METHOD.set(routes, map)
  }
  return map
}

/** 用请求 path 匹配静态路由；失败时再试去掉 /api 前缀。越具体越优先。 */
export function matchRoute(routes, httpMethod, pathname) {
  if (!routes || !routes.length) return null
  const groups = routesByMethod(routes)
  const pool = (groups.get(httpMethod) || []).concat(groups.get('ANY') || [])
  const stripped = pathname.replace(/^\/api(?=\/)/, '')
  const candidates = []
  for (const route of pool) {
    const re = pathRe(route.path)
    if (re.test(pathname) || (stripped !== pathname && re.test(stripped))) candidates.push(route)
  }
  if (!candidates.length) return null
  if (candidates.length === 1) return candidates[0]
  candidates.sort((a, b) => routeScore(b.path) - routeScore(a.path))
  return candidates[0]
}

function entryIdOf(route) {
  return route.entryId || route.key || `${route.controller || ''}.${route.javaMethod || ''}`
}

/**
 * 把一条路由展开成「代码块调用树」：
 *   nodes: 每个函数一个节点，带完整源码、起止行、调用点行号
 *   edges: { from, to, line }，line 是被调用发生在父函数里的行
 */
export function buildCallTree(index, route, maxDepth = 4) {
  const rootId = entryIdOf(route)
  const nodes = new Map()
  const edges = []

  const visit = (key, depth, parentId, callLine, status = 'ok') => {
    const meta = index.methods.get(key)
    if (!meta) return false
    if (parentId) edges.push({ from: parentId, to: key, line: callLine, status })
    if (nodes.has(key)) return true
    nodes.set(key, {
      id: key,
      key,
      cls: meta.cls,
      method: meta.method,
      file: meta.file,
      startLine: meta.startLine,
      endLine: meta.endLine,
      code: meta.code,
      xml: !!meta.xml,
      xmlTag: meta.xmlTag,
      depth,
      calls: (meta.calls || []).map((c) => ({ line: c.callLine, snippet: c.snippet, toKey: c.toKey })),
    })
    if (depth < maxDepth) {
      for (const c of meta.calls || []) visit(c.toKey, depth + 1, key, c.callLine, c.status || 'ok')
    }
    return true
  }

  if (!visit(rootId, 0, null, null)) return null
  return { rootId, nodes: [...nodes.values()], edges }
}

/** 统一摘要：各语言适配器可覆盖字段，但前三个字段口径一致 */
export function summarize(index) {
  const routes = index.routes || []
  const owners = routes.map((r) => r.controller || r.module || r.handlerFile || '?')
  return {
    root: index.root,
    files: index.files,
    classes: index.classes ?? index.modules ?? 0,
    routes: routes.length,
    controllers: new Set(owners).size,
    unresolved: (index.diagnostics && index.diagnostics.actionable) || 0,
    warnings: index.warnings || [],
  }
}
