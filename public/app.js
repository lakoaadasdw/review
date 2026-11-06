const KIND_NAME = { click: '点击', handler: '事件处理', fe: '前端代码', request: 'HTTP 请求', response: 'HTTP 响应', error: '异常' }

// 顶部流程条
const FLOW_W = 190
const FLOW_H = 54
const FLOW_X = 24
const FLOW_Y = 16
const FLOW_GAP = 36
const FE_W = 430
const FE_LINE = 13

// 方法代码卡片
const CARD_W = 470
const HEAD_H = 28
const LINE_H = 15
const CODE_PAD = 8
const COL_GAP = 90
const GRAPH_TOP = 132   // 顶部流程条与分组之间留一条走线通道（y≈112）
const CARD_GAP = 14
const GROUP_HEAD_H = 32
const GROUP_GAP = 22
const IF_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f778ba', '#ffa657']

const view = { data: null, traceId: null, selected: null, expanded: new Map(), collapsed: new Map(), timer: null, dragPos: new Map(), motion: localStorage.getItem('apiflow.motion') !== '0', seenAt: {}, seenCount: {}, _sig: '' }

const $ = (id) => document.getElementById(id)

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// —— 监听目标：扫描本机前端 / 用受控浏览器打开 ——
async function refreshTargets() {
  const sel = $('sel-target')
  if (!sel) return
  let t
  try { t = await api('/api/targets') } catch { return }
  const prev = sel.value
  const opts = []
  const seen = new Set()
  for (const f of t.frontends || []) {
    if (seen.has(f.url)) continue
    seen.add(f.url)
    opts.push(`<option value="${escapeHtml(f.url)}">${escapeHtml(`${f.port} · ${f.title}${f.vite ? ' · vite' : ''}`)}</option>`)
  }
  for (const p of t.pages || []) {
    if (!/^https?:/i.test(p.url) || String(p.url).includes('127.0.0.1:7788')) continue
    if (seen.has(p.url)) continue
    seen.add(p.url)
    opts.push(`<option value="${escapeHtml(p.url)}">已打开 · ${escapeHtml(p.title || p.url)}</option>`)
  }
  sel.innerHTML = opts.join('') || '<option value="">没扫到本机前端</option>'
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev
  else if (t.lastUrl && [...sel.options].some((o) => o.value === t.lastUrl)) sel.value = t.lastUrl
  sel.title = t.chrome?.running
    ? `受控浏览器已连接 127.0.0.1:${t.chrome.port}`
    : '受控浏览器未启动，「打开并监听」会自动拉起'
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function shortUrl(url) {
  try { const u = new URL(url, 'http://localhost'); return `${u.pathname}` } catch { return String(url || '').slice(0, 48) }
}

function baseName(file) {
  return String(file || '').split(/[\\/]/).pop() || ''
}

async function tick() {
  try {
    view.data = await api('/api/state')
  } catch {
    $('pill-cdp').textContent = '服务未响应'
    $('pill-cdp').className = 'pill bad'
    return
  }
  renderPills()
  renderTraces()
  renderGraph()
}

function renderPills() {
  const cdp = view.data?.cdp || {}
  const pill = $('pill-cdp')
  pill.textContent = cdp.connected ? 'CDP 已连接' : `CDP 未连接${cdp.error ? `：${cdp.error}` : ''}`
  pill.className = `pill ${cdp.connected ? 'ok' : 'bad'}`

  const target = $('pill-target')
  if (cdp.target?.url) {
    target.hidden = false
    target.textContent = cdp.target.url
    target.title = cdp.target.title || ''
  } else target.hidden = true

  const b = view.data?.backend || {}
  const pill2 = $('pill-backend')
  if (b.summary) {
    pill2.textContent = `后端索引 ${b.summary.routes} 路由 / ${b.summary.controllers} Controller / ${b.summary.files} 文件`
    pill2.className = 'pill ok'
  } else {
    pill2.textContent = `后端索引失败${b.error ? `：${String(b.error).slice(0, 80)}` : ''}`
    pill2.className = 'pill bad'
  }
}

function activeTrace() {
  const traces = view.data?.traces || []
  if (!traces.length) return null
  if (!view.traceId || !traces.some((t) => t.id === view.traceId)) view.traceId = traces[0].id
  return traces.find((t) => t.id === view.traceId) || null
}

function expansionSet(trace) {
  if (!view.expanded.has(trace.id)) {
    const set = new Set()
    backendsOf(trace).forEach((b, bi) => { if (b.rootId) set.add(`b${bi}:${b.rootId}`) })
    view.expanded.set(trace.id, set)
  }
  return view.expanded.get(trace.id)
}

function renderTraces() {
  const el = $('traces')
  const traces = view.data?.traces || []
  if (!traces.length) {
    el.innerHTML = '<div class="hint">点击页面上的按钮，这里会出现一条链路</div>'
    return
  }
  const active = activeTrace()
  el.innerHTML = traces.map((t) => {
    const req = t.nodes.find((n) => n.kind === 'request')
    const time = new Date(t.startedAt).toLocaleTimeString('zh-CN', { hour12: false })
    return `<div class="trace ${active && t.id === active.id ? 'active' : ''} ${t.status === 'error' ? 'err' : ''}" data-id="${escapeHtml(t.id)}">
      <div class="t-head"><span>${time}</span><span>${t.nodes.length} 节点${t.backends && t.backends.length ? ` · ${t.backends.length} 接口 · ${t.backends[0].nodes.length} 方法` : ''}${t.status === 'error' ? ' · 异常' : ''}</span></div>
      <div class="t-url">${escapeHtml(req ? `${req.meta.method} ${shortUrl(req.meta.url)}` : t.reason || '—')}</div>
    </div>`
  }).join('')
  el.querySelectorAll('.trace').forEach((node) => {
    node.onclick = () => { view.traceId = node.dataset.id; view.selected = null; renderTraces(); renderGraph() }
  })
}

/** 计算方法卡片位置：按调用深度分列，列数放不下时折到下一行带；子卡片尽量对齐父方法的"调用行" */
function collapsedSet(trace, hidden = new Set()) {
  if (!view.collapsed.has(trace.id)) {
    const set = new Set()
    const backends = backendsOf(trace)
    // 默认只展开「第一个看得见的」接口；失败接口若被隐藏，就展开下一个成功接口
    const visible = backends.map((b, i) => i).filter((i) => !hidden.has(i))
    const first = visible.length ? visible[0] : -1
    backends.forEach((b, i) => { if (i !== first) set.add(i) })
    view.collapsed.set(trace.id, set)
  }
  return view.collapsed.get(trace.id)
}

function backendsOf(trace) {
  if (Array.isArray(trace?.backends) && trace.backends.length) return trace.backends
  if (trace?.methods) return [trace.methods]
  return []
}

function layoutMethods(trace, expanded, collapsed, topY = GRAPH_TOP, hidden = new Set()) {
  const backends = backendsOf(trace)
  if (!backends.length) return { pos: new Map(), order: [], width: 0, height: 0, cardW: CARD_W, cols: 1, groups: [] }

  const canvasW = ($('canvas')?.clientWidth || 1200) - 40
  const colGap = COL_GAP
  let cardW = CARD_W // 供调用方兜底；每棵树实际宽度见 group.cardW

  const pos = new Map()
  const order = []
  const groups = []
  let maxRight = 0
  let baseY = topY

  backends.forEach((backend, bi) => {
    // 接口层失败的那棵整棵不展示（成功接口的方法链要照常显示）
    if (hidden.has(bi)) return
    const prefix = `b${bi}:`
    const headerTop = baseY
    baseY += GROUP_HEAD_H + 10
    if (collapsed.has(bi)) {
      groups.push({ bi, prefix, backend, top: headerTop, headerH: GROUP_HEAD_H, collapsed: true, cardW: CARD_W, cols: 1, bottom: headerTop + GROUP_HEAD_H })
      baseY = headerTop + GROUP_HEAD_H + GROUP_GAP
      return
    }
    const byId = new Map(backend.nodes.map((n) => [n.id, n]))
    const parentOf = new Map()
    for (const e of backend.edges) parentOf.set(e.to, { id: e.from, line: e.line })

    // 每棵树按自己的最长源码行定卡片宽度/列数：短代码的树能排成多列，别被全局长行拖成一列
    let maxLen = 0
    for (const n of backend.nodes) {
      for (const line of String(n.code || '').split(/\r?\n/)) if (line.length > maxLen) maxLen = line.length
    }
    const treeW = Math.min(1100, Math.max(CARD_W, Math.ceil(maxLen * 6.9) + 88))
    // 调用图向右展开（画布可平移缩放），只有深度超过 6 层才折行，避免整棵树被挤成一条竖线
    let maxDepth = 0
    for (const n of backend.nodes) maxDepth = Math.max(maxDepth, n.depth || 0)
    const treeCols = Math.max(1, Math.min(6, maxDepth + 1))
    cardW = Math.max(cardW, treeW)

    const localOrder = []
    const queue = [backend.rootId]
    while (queue.length) {
      const id = queue.shift()
      if (!byId.has(id) || localOrder.includes(id)) continue
      localOrder.push(id)
      for (const e of backend.edges) if (e.from === id && !localOrder.includes(e.to)) queue.push(e.to)
    }

    const localPos = new Map()
    const colY = new Map()
    const bandBottom = new Map()

    for (const id of localOrder) {
      const node = byId.get(id)
      const depth = node.depth || 0
      const band = Math.floor(depth / treeCols)
      const col = depth % treeCols
      const lineCount = String(node.code || '').split(/\r?\n/).length
      const height = HEAD_H + (expanded.has(prefix + id) ? CODE_PAD * 2 + lineCount * LINE_H : 0)
      const slot = `${band}:${col}`
      let y = colY.get(slot) ?? 0
      const parent = parentOf.get(id)
      if (parent && localPos.has(parent.id) && parent.line != null) {
        const p = localPos.get(parent.id)
        const pNode = byId.get(parent.id)
        const sameBand = Math.floor((pNode.depth || 0) / treeCols) === band
        if (expanded.has(prefix + parent.id) && sameBand) {
          const off = HEAD_H + CODE_PAD + (parent.line - pNode.startLine) * LINE_H
          y = Math.max(y, p.y + off - HEAD_H / 2)
        }
      }
      const x = 24 + col * (treeW + colGap)
      localPos.set(id, { x, y, height, node })
      colY.set(slot, y + height + CARD_GAP)
      bandBottom.set(band, Math.max(bandBottom.get(band) ?? 0, y + height))
      maxRight = Math.max(maxRight, x + treeW)
    }

    const bandOffset = new Map()
    let acc = 0
    const bandCount = Math.max(0, ...bandBottom.keys()) + 1
    for (let b = 0; b < bandCount; b++) {
      bandOffset.set(b, acc)
      acc += (bandBottom.get(b) ?? 0) + 44
    }

    let localBottom = baseY
    for (const [id, p] of localPos) {
      const key = prefix + id
      p.y += bandOffset.get(Math.floor((p.node.depth || 0) / treeCols)) + baseY
      pos.set(key, p)
      order.push(key)
      localBottom = Math.max(localBottom, p.y + p.height)
    }
    groups.push({ bi, prefix, backend, top: headerTop, headerH: GROUP_HEAD_H, collapsed: false, cardW: treeW, cols: treeCols, bottom: localBottom })
    baseY = localBottom + 36
  })

  return { pos, order, cardW, cols: 1, width: maxRight + 24, height: baseY + 24, groups }
}

/** 把同类重复请求折叠成一个节点（15s 轮询/并发），详情里仍列出每一次 */
function aggregateFlow(trace) {
  const keyOf = (n) => `${n.kind} ${(n.meta || {}).method || ''} ${(n.meta || {}).url || ''}`
  const groups = new Map()
  for (const n of trace.nodes) {
    if (n.kind !== 'request' && n.kind !== 'response') continue
    const key = keyOf(n)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(n)
  }

  // 同一接口折叠后以「最近一次」为准：失败过、后来恢复 200，就该显示正常（已复通），
  // 历史失败次数放进 meta.errorCount，详情面板里仍能看到每次请求。
  const repOf = new Map()
  for (const [, list] of groups) {
    const rep = list[list.length - 1]
    for (const n of list) repOf.set(n.id, rep.id)
  }
  const mapId = (id) => repOf.get(id) || id

  const nodes = []
  const count = new Map()
  const occurrences = new Map()
  const done = new Set()
  const statusOf = new Map()
  for (const n of trace.nodes) {
    if (n.kind !== 'request' && n.kind !== 'response') {
      nodes.push(n)
      statusOf.set(n.id, n.status)
      continue
    }
    const rep = repOf.get(n.id) || n.id
    if (done.has(rep)) continue
    done.add(rep)
    const list = groups.get(keyOf(n)) || [n]
    const last = list[list.length - 1]
    const errorCount = list.filter((x) => x.status === 'error').length
    const okCount = list.length - errorCount
    const merged = {
      ...last,
      status: last.status,
      meta: { ...(last.meta || {}), count: list.length, errorCount, okCount },
    }
    nodes.push(merged)
    statusOf.set(last.id, merged.status)
    count.set(last.id, list.length)
    occurrences.set(last.id, list.map((x) => ({
      kind: x.kind,
      method: (x.meta || {}).method,
      url: (x.meta || {}).url,
      status: (x.meta || {}).status ?? null,
      duration: (x.meta || {}).duration ?? null,
      at: x.at,
    })))
  }

  const edges = []
  const seen = new Set()
  for (const e of trace.edges) {
    const from = mapId(e.from)
    const to = mapId(e.to)
    if (from === to) continue
    const k = `${from}->${to}`
    if (seen.has(k)) continue
    seen.add(k)
    const bad = statusOf.get(to) === 'error' || statusOf.get(from) === 'error'
    edges.push({ ...e, from, to, status: bad ? 'error' : 'ok' })
  }

  return { nodes, edges, count, occurrences, mapId }
}

function failKindOf(n) {
  if (!n) return null
  if (n.kind === 'error') return 'js'
  if (n.kind === 'response' && Number((n.meta || {}).status || 0) >= 400) return 'http'
  if (n.kind === 'request' && n.status === 'error') return 'net'
  return null
}

function analyzeErrors(trace, flow) {
  if (!trace || !flow) return null
  const fails = flow.nodes.filter((n) => failKindOf(n))
  if (!fails.length) return null
  // 优先级：5xx/4xx 响应 > 发不出去的请求 > JS 异常；同优先级按发生时间
  const rank = (n) => (n.kind === 'response' ? 0 : n.kind === 'request' ? 1 : 2)
  const sorted = [...fails].sort((a, b) => rank(a) - rank(b) || (a.at || 0) - (b.at || 0))
  const root = sorted[0]
  const http = fails.filter((n) => failKindOf(n) === 'http')
  const net = fails.filter((n) => failKindOf(n) === 'net')
  const js = fails.filter((n) => failKindOf(n) === 'js')
  const urls = new Set([...http, ...net].map((n) => (n.meta || {}).url).filter(Boolean))
  let hint = ''
  if (http.length && urls.size >= 2) {
    hint = `${urls.size} 个接口同时 ${root.meta?.status || '5xx'}：失败在接口层，先查后端服务/网关是否启动、代理配置是否正确，先不用追业务方法代码`
  } else if (http.length) {
    hint = `接口 ${root.meta?.url || root.label} 返回 ${root.meta?.status || ''}：接口层失败，先看这个接口的日志 / 断点，再决定是否追方法链`
  } else if (net.length) {
    hint = '请求发出去没有响应：后端没启动 / 跨域 / 网络中断'
  } else if (js.length) {
    hint = '前端 JS 异常：看右侧调用栈，找第一行业务代码'
  }
  return {
    rootId: root.id,
    failIds: new Set(fails.map((n) => n.id)),
    kind: failKindOf(root),
    hint,
    root,
    counts: { http: http.length, net: net.length, js: js.length },
  }
}

// 前端代码节点比普通流程节点大：按代码行数给高度，宽度固定，用来展示"这一行发起了请求"
function nodeSize(n) {
  if (n.kind === 'fe') {
    const lines = String(n.meta?.code || '').split('\n')
    const shown = Math.max(3, Math.min(lines.length, 12))
    return { w: FE_W, h: 32 + shown * FE_LINE }
  }
  return { w: FLOW_W, h: FLOW_H }
}

// 流程条按"依赖层级"排版：点击 → 事件处理 → 多个 HTTP 请求（并排/上下并列）→ 各自响应，
// 不再是所有节点连成一条横线，这样并发请求能一眼看出是分支而不是串联。
function layoutFlow(trace, flow) {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]))
  const parents = new Map()
  for (const e of flow.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    if (!parents.has(e.to)) parents.set(e.to, [])
    parents.get(e.to).push(e.from)
  }
  const depth = new Map()
  const calc = (id, guard = 0) => {
    if (depth.has(id)) return depth.get(id)
    if (guard > 30) return 0
    const ps = (parents.get(id) || []).filter((p) => byId.has(p))
    const d = ps.length ? Math.max(...ps.map((p) => calc(p, guard + 1))) + 1 : 0
    depth.set(id, d)
    return d
  }
  for (const n of flow.nodes) calc(n.id)

  const cols = new Map()
  for (const n of flow.nodes) {
    const d = depth.get(n.id) || 0
    if (!cols.has(d)) cols.set(d, [])
    cols.get(d).push(n)
  }
  const pos = new Map()
  const levels = [...cols.keys()].sort((a, b) => a - b)
  const colW = new Map()
  for (const d of levels) {
    let w = FLOW_W
    for (const n of cols.get(d)) w = Math.max(w, nodeSize(n).w)
    colW.set(d, w)
  }
  const xOf = new Map()
  let cursorX = FLOW_X
  for (const d of levels) {
    xOf.set(d, cursorX)
    cursorX += (colW.get(d) || FLOW_W) + FLOW_GAP
  }
  for (const d of levels) {
    const list = cols.get(d).sort((a, b) => (a.at || 0) - (b.at || 0))
    const listW = colW.get(d) || FLOW_W
    let prevBottom = null
    for (const n of list) {
      const size = nodeSize(n)
      const py = (parents.get(n.id) || []).map((p) => pos.get(p)).filter(Boolean)
      let y = py.length ? Math.round(py.reduce((s2, p) => s2 + p.y, 0) / py.length) : FLOW_Y
      if (prevBottom != null && y < prevBottom + 18) y = prevBottom + 18
      pos.set(n.id, { x: xOf.get(d) + Math.max(0, Math.round((listW - size.w) / 2)), y, w: size.w, h: size.h })
      prevBottom = y + size.h
    }
  }
  const bottom = Math.max(...[...pos.values()].map((p) => p.y + p.h), FLOW_Y + FLOW_H)
  return { pos, width: cursorX - FLOW_GAP + FLOW_X, height: bottom }
}

function renderGraph() {
  const trace = activeTrace()
  const nodesEl = $('nodes')
  const svg = $('edges')
  const empty = $('empty')
  if (!trace || !trace.nodes.length) {
    nodesEl.innerHTML = ''
    svg.innerHTML = ''
    empty.hidden = false
    return
  }
  empty.hidden = true

  // 轮询每 700ms 调一次 renderGraph；数据没变就别重建 DOM，
  // 否则一次性「流动」动画会被反复重放或直接打断。
  const sigParts = [trace.id, view.selected || '', view.bodyRawNid || '', view.forceTrees ? '1' : '0', view.motion ? '1' : '0']
  for (const n of trace.nodes) sigParts.push(`${n.id}:${n.at}:${n.status || ''}`)
  for (const e of trace.edges) sigParts.push(`${e.from}>${e.to}`)
  sigParts.push([...expansionSet(trace)].join(','))
  sigParts.push([...(view.collapsed.get(trace.id) || [])].join(','))
  sigParts.push(JSON.stringify([...view.dragPos].filter(([k]) => k.includes(trace.id))))
  sigParts.push(`${$('canvas').clientWidth}x${$('canvas').clientHeight}`)
  const sig = sigParts.join('|')
  if (sig === view._sig) return
  view._sig = sig

  const flow = aggregateFlow(trace)
  // 哪些节点是「刚到的」：用于给对应的边叠一次流动高光（只在请求出现的那一刻动）
  // 新 trace 第一次渲染：把最近 3 秒内产生的节点都当作“刚到”（否则新链一出现就全程静止，前端那段永远不会亮）
  const prevAt = view.seenAt[trace.id] ?? (Date.now() - 3000)
  const prevCount = view.seenCount[trace.id] || new Map()
  const fresh = new Set()
  let maxAt = 0
  for (const n of flow.nodes) {
    const c = flow.count.get(n.id) || 0
    if ((n.at || 0) > prevAt || c > (prevCount.get(n.id) || 0)) fresh.add(n.id)
    maxAt = Math.max(maxAt, n.at || 0)
  }
  const errInfo = analyzeErrors(trace, flow)
  const flowLay = layoutFlow(trace, flow)
  const flowPos = flowLay.pos
  const methodTop = flowLay.height + 40

  // 分组是否算“失败”也按最近一次响应判断：接口复通后，它后面的方法链不该继续红着
  const flowStatusOf = new Map(flow.nodes.map((n) => [n.id, n.status]))
  const groupBad = (g) => {
    const id = flow.mapId(g.backend.from)
    return flowStatusOf.has(id) ? flowStatusOf.get(id) === 'error' : g.backend.status === 'error'
  }

  // 失败发生在"接口层"（请求没发出去 / 响应 4xx-5xx 且后端静态树只作参考）时，
  // 默认把所有后端方法树收起：先让前端/接口层排查，别一上来就被方法链噪音带偏。
  const ifaceFailed = !!errInfo && (errInfo.kind === 'net' || errInfo.kind === 'http')
  const hideTrees = ifaceFailed && !view.forceTrees
  // 只隐藏“最近一次响应是失败”的接口；已经复通的接口照常展示方法链
  const hiddenBi = new Set()
  if (hideTrees) {
    const statusById = new Map(flow.nodes.map((n) => [n.id, n.status]))
    backendsOf(trace).forEach((b, bi) => {
      if (statusById.get(flow.mapId(b.from)) === 'error') hiddenBi.add(bi)
    })
  }
  let methodLay = { pos: new Map(), order: [], width: 0, height: 0, cardW: CARD_W, cols: 1, groups: [] }
  if (backendsOf(trace).length) methodLay = layoutMethods(trace, expansionSet(trace), collapsedSet(trace, hiddenBi), methodTop, hiddenBi)

  // 手动拖过的位置优先（按 trace + 节点 id 记住），并据此扩大画布
  let maxX = 0
  let maxY = 0
  for (const [id, p] of flowPos) {
    const o = view.dragPos.get(`f:${trace.id}:${id}`)
    if (o) { p.x = o.x; p.y = o.y }
    maxX = Math.max(maxX, p.x + p.w)
    maxY = Math.max(maxY, p.y + p.h)
  }
  for (const [id, p] of methodLay.pos) {
    const o = view.dragPos.get(`m:${trace.id}:${id}`)
    if (o) { p.x = o.x; p.y = o.y }
    maxX = Math.max(maxX, p.x + (methodLay.cardW || CARD_W))
    maxY = Math.max(maxY, p.y + p.height)
  }
  if (methodLay.pos.size) {
    methodLay.width = Math.max(methodLay.width, maxX + 24)
    methodLay.height = Math.max(methodLay.height, maxY + 24)
  }

  const width = Math.max(flowLay.width, methodLay.width, maxX + 24, 900)
  const height = Math.max(260, methodLay.height, maxY + 24, 220)

  svg.setAttribute('width', width)
  svg.setAttribute('height', height)
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)

  const defs = `<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#3d4756" /></marker>
    <marker id="arrow-err" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#f85149" /></marker>
    ${IF_COLORS.map((c, i) => `<marker id="arrow-if${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${c}" /></marker>`).join('')}
  </defs>`

  const curveD = (x1, y1, x2, y2) => {
    // 控制点偏移限制在 ±180：跨越整屏的连线不再甩出画布（否则会被 svg 边界裁掉，看起来"没有线"）
    const mid = Math.max(-180, Math.min(180, (x2 - x1) / 2))
    return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`
  }
  const curve = (x1, y1, x2, y2, bad) => `<path d="${curveD(x1, y1, x2, y2)}" fill="none"
      stroke="${bad ? '#f85149' : '#3d4756'}" stroke-width="${bad ? 2 : 1.4}" marker-end="url(#${bad ? 'arrow-err' : 'arrow'})" />`

  const anchorColors = new Map()
  for (let bi = 0; bi < methodLay.groups.length; bi++) {
    const g = methodLay.groups[bi]
    const aid = flow.mapId(g.backend.from)
    if (aid && !anchorColors.has(aid)) anchorColors.set(aid, IF_COLORS[bi % IF_COLORS.length])
  }

  let edgeHtml = ''
  let overlayHtml = ''
  const addFlow = (d, toId) => {
    if (view.motion && toId && fresh.has(toId)) overlayHtml += `<path class="flowpath" d="${d}" />`
  }
  for (const e of flow.edges) {
    const a = flowPos.get(e.from)
    const b = flowPos.get(e.to)
    if (!a || !b) continue
    const d = curveD(a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2)
    edgeHtml += `<path d="${d}" fill="none" stroke="${e.status === 'error' ? '#f85149' : '#3d4756'}" stroke-width="${e.status === 'error' ? 2 : 1.4}" marker-end="url(#${e.status === 'error' ? 'arrow-err' : 'arrow'})" />`
    addFlow(d, e.to)
  }

  // 响应 → 分组标题栏：每个接口一条独立折线（各自的颜色 + 各自的车道），
  // 从响应底部下到流程条下的空通道，沿左侧走廊下到该分组上方间隙，再折进标题栏。
  // 不同接口的车道错开，避免几条线并在一起看起来像“同一条线路”。
  {
    for (let bi = 0; bi < methodLay.groups.length; bi++) {
      const g = methodLay.groups[bi]
      if (g.collapsed) continue
      const a = flowPos.get(flow.mapId(g.backend.from))
      if (!a) continue
      const bad = groupBad(g)
      const color = bad ? '#f85149' : IF_COLORS[bi % IF_COLORS.length]
      const x1 = a.x + a.w / 2
      const y1 = a.y + a.h
      const laneY0 = Math.max(a.y + a.h + 10, flowLay.height + 8) + bi * 5   // 流程条下方的通道分层
      const busX = 8 + bi * 4              // 左侧走廊分层
      const laneY = Math.max(laneY0 + 6, g.top - 8 - bi * 3)
      const dElbow = `M ${x1} ${y1} V ${laneY0} H ${busX} V ${laneY} H 26 V ${g.top + 12}`
      edgeHtml += `<path d="${dElbow}" fill="none"
        stroke="${color}" stroke-width="1.4" stroke-opacity="0.9" stroke-linejoin="round"
        marker-end="url(#${bad ? 'arrow-err' : `arrow-if${bi % IF_COLORS.length}`})" />`
      addFlow(dElbow, flow.mapId(g.backend.from))
    }
  }

  // 方法间调用边：从父方法"那一行"拉出；父卡片收起时锚在右缘中部；子卡片折到下一行时改为纵向汇入卡片顶部
  {
    const expanded = expansionSet(trace)
    for (const g of methodLay.groups) {
      if (g.collapsed) continue
      const cw = g.cardW || methodLay.cardW || CARD_W
      const badAll = groupBad(g)
      for (const e of g.backend.edges) {
        const fromKey = g.prefix + e.from
        const toKey = g.prefix + e.to
        const a = methodLay.pos.get(fromKey)
        const b = methodLay.pos.get(toKey)
        if (!a || !b) continue
        const parentNode = a.node
        const parentOpen = expanded.has(fromKey)
        const off = parentOpen
          ? HEAD_H + CODE_PAD + (e.line - parentNode.startLine) * LINE_H + LINE_H / 2
          : HEAD_H / 2
        const x1 = a.x + cw
        const y1 = a.y + off
        const below = b.y > a.y + a.height - 4
        if (below) {
          const x2 = b.x + cw / 2
          const y2 = b.y
          const dDown = `M ${x1} ${y1} C ${x1 + 90} ${y1}, ${x2} ${y2 - 46}, ${x2} ${y2}`
          edgeHtml += `<path d="${dDown}" fill="none"
            stroke="${badAll ? '#f85149' : '#3d4756'}" stroke-width="${badAll ? 2 : 1.4}" marker-end="url(#${badAll ? 'arrow-err' : 'arrow'})" />`
          addFlow(dDown, toKey)
        } else {
          const dSide = curveD(x1, y1, b.x, b.y + HEAD_H / 2)
          edgeHtml += `<path d="${dSide}" fill="none" stroke="${badAll ? '#f85149' : '#3d4756'}" stroke-width="${badAll ? 2 : 1.4}" marker-end="url(#${badAll ? 'arrow-err' : 'arrow'})" />`
          addFlow(dSide, toKey)
        }
      }
    }
  }

  svg.innerHTML = defs + edgeHtml + overlayHtml
  view.seenAt[trace.id] = maxAt
  view.seenCount[trace.id] = new Map(flow.count)

  // 根因提示条：点一下选中根因节点
  let hintEl = $('errhint')
  if (!hintEl) {
    hintEl = document.createElement('div')
    hintEl.id = 'errhint'
    hintEl.onclick = () => { if (errInfo) { view.selected = errInfo.rootId; renderGraph(); renderDetail(trace) } }
    $('canvas').appendChild(hintEl)
  }
  if (errInfo) {
    hintEl.className = 'show'
    const extra = hideTrees
      ? '（失败接口的方法链已隐藏；成功接口仍展示方法树，点「显示方法树」可把失败的也展开参考）'
      : errInfo.kind === 'net'
        ? '（后端方法链已收起）'
        : errInfo.kind === 'http'
          ? '（后端方法链默认收起，点分组标题栏可展开参考）'
          : ''
    hintEl.innerHTML = `<b>⚡ 根因</b> ${escapeHtml(errInfo.root.label)}<span class="ehint">${escapeHtml((errInfo.hint || '') + extra)}</span>`
  } else {
    hintEl.className = ''
    hintEl.innerHTML = ''
  }

  // 顶部流程卡片
  let html = flow.nodes.map((n) => {
    const p = flowPos.get(n.id)
    const bad = n.status === 'error'
    const times = flow.count.get(n.id) || 0
    const acol = anchorColors.get(n.id)
    const isRoot = !!errInfo && errInfo.rootId === n.id
    const isDown = !!errInfo && errInfo.failIds.has(n.id) && !isRoot
    const isStop = hideTrees && isRoot
    const isFe = n.kind === 'fe'
    const feMeta = isFe ? (n.meta || {}) : null
    let feHtml = ''
    if (isFe) {
      const lines = String(feMeta.code || '').split('\n')
      const shown = Math.max(3, Math.min(lines.length, 12))
      feHtml = `<div class="fcode">${lines.slice(0, shown).map((text, i) => {
        const no = (feMeta.startLine || 1) + i
        return `<div class="fln ${no === feMeta.line ? 'hl' : ''}"><span class="fno">${no}</span><span class="ftx">${escapeHtml(text) || ' '}</span></div>`
      }).join('')}</div>`
    }
    return `<div class="node k-${escapeHtml(n.kind)} ${bad ? 'error' : ''} ${isRoot ? 'err-root' : ''} ${isDown ? 'err-down' : ''} ${view.selected === n.id ? 'sel' : ''}"
      style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" data-id="${escapeHtml(n.id)}">
      <span class="kind">${acol ? `<i class="ifdot" style="background:${acol}"></i>` : ''}${escapeHtml(KIND_NAME[n.kind] || n.kind)}${times > 1 ? `<i class="cnt">×${times}</i>` : ''}${isRoot ? '<i class="errtag">根因</i>' : ''}${isStop ? '<i class="stoptag">到此为止</i>' : ''}${isFe ? `<i class="ffe">${escapeHtml((feMeta.func ? feMeta.func + ' · ' : '') + (feMeta.file || ''))}</i>` : ''}</span>
      ${isFe ? feHtml : `<div class="label">${escapeHtml(n.label)}</div>`}
    </div>`
  }).join('')

  // 每个接口的分组标题栏（可折叠）：接口 + 重复次数 + 根方法
  for (const g of methodLay.groups) {
    const open = !g.collapsed
    const root = g.backend.nodes.find((n) => n.id === g.backend.rootId)
    const times = flow.count.get(flow.mapId(g.backend.from)) || 1
    html += `<div class="mgroup ${open ? 'open' : ''} ${groupBad(g) ? 'err' : ''}"
      style="left:24px;top:${g.top}px;width:${g.cardW || CARD_W}px" data-bi="${g.bi}">
      <span class="gchev">${open ? '▾' : '▸'}</span>
      <span class="groute"><i class="ifdot" style="background:${IF_COLORS[g.bi % IF_COLORS.length]}"></i>${escapeHtml(`${g.backend.route.method} ${g.backend.route.path}`)}</span>
      ${times > 1 ? `<span class="gcnt">×${times}</span>` : ''}
      <span class="groot">${root ? escapeHtml(`${root.cls}.${root.method}()`) : ''}</span>
      <span class="gstat">${open ? '收起' : '展开'}</span>
    </div>`
  }

  // 方法代码卡片（一条 trace 多个接口时按树分组，key 带 bN: 前缀）
  {
    const expanded = expansionSet(trace)
    for (const g of methodLay.groups) {
      if (g.collapsed) continue
      const badAll = groupBad(g)
      for (const key of methodLay.order) {
        if (!key.startsWith(g.prefix)) continue
        const p = methodLay.pos.get(key)
        const n = p.node
        const lines = String(n.code || '').split('\n')
        const callMap = new Map()
        for (const c of n.calls) {
          if (!callMap.has(c.line)) callMap.set(c.line, [])
          callMap.get(c.line).push(c)
        }
        const open = expanded.has(key)
        const callableCount = callMap.size
        html += `<div class="mcard ${open ? 'open' : ''} ${view.selected === key ? 'sel' : ''} ${badAll ? 'err' : ''}"
          style="left:${p.x}px;top:${p.y}px;width:${g.cardW || CARD_W}px" data-id="${escapeHtml(key)}">
          <div class="mhead" data-act="toggle">
            <span class="mchev">${open ? '▾' : '▸'}</span>
            <span class="mname">${escapeHtml(n.cls)}.${escapeHtml(n.method)}()</span>
            ${n.xml ? '<span class="mtag">XML</span>' : ''}
            <span class="mfile">${escapeHtml(baseName(n.file))}:${n.startLine}</span>
            <span class="mcall">${callableCount ? `${callableCount} 处调用` : ''}</span>
          </div>
          ${open ? `<div class="mcode">${lines.map((text, i) => {
            const lineNo = n.startLine + i
            const calls = callMap.get(lineNo) || []
            const targets = calls.map((c) => `${g.prefix}${c.toKey}@${c.line}`).join(',')
            return `<div class="ln ${calls.length ? 'callable' : ''}"${calls.length ? ` data-targets="${escapeHtml(targets)}"` : ''}><span class="lno">${n.xml ? '·' : lineNo}</span><span class="ltext">${escapeHtml(text) || ' '}</span>${calls.length ? '<span class="lgo">↳</span>' : ''}</div>`
          }).join('')}</div>` : ''}
        </div>`
      }
    }
  }

  nodesEl.innerHTML = html

  nodesEl.querySelectorAll('.node').forEach((el) => {
    el.onclick = () => { view.selected = el.dataset.id; renderGraph(); renderDetail(trace) }
  })
  nodesEl.querySelectorAll('.mgroup').forEach((el) => {
    el.onclick = () => {
      const bi = Number(el.dataset.bi)
      const set = collapsedSet(trace)
      if (set.has(bi)) set.delete(bi)
      else set.add(bi)
      renderGraph()
      renderDetail(trace)
    }
  })
  nodesEl.querySelectorAll('.mhead').forEach((el) => {
    el.onclick = () => {
      const card = el.closest('.mcard')
      const id = card.dataset.id
      const set = expansionSet(trace)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      view.selected = id
      renderGraph()
      renderDetail(trace)
    }
  })
  nodesEl.querySelectorAll('.ln.callable').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation()
      const set = expansionSet(trace)
      for (const t of String(el.dataset.targets || '').split(',').filter(Boolean)) {
        const key = t.split('@')[0]
        set.add(key)
      }
      renderGraph()
    }
  })

  // —— 自由拖动：流程节点整块拖，方法卡片拖标题栏；位置按 trace 记住，双击还原 ——
  nodesEl.querySelectorAll('.node').forEach((el) => {
    const id = el.dataset.id
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      beginNodeDrag(trace, 'f', id, el, e)
    })
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      view.dragPos.delete(`f:${trace.id}:${id}`)
      renderGraph()
    })
  })
  nodesEl.querySelectorAll('.mcard').forEach((card) => {
    const id = card.dataset.id
    const head = card.querySelector('.mhead')
    if (!head) return
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      beginNodeDrag(trace, 'm', id, card, e)
    })
    head.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      view.dragPos.delete(`m:${trace.id}:${id}`)
      renderGraph()
    })
  })
  // 只在选中内容变化时重绘详情面板：否则每 700ms 轮询都会重建 innerHTML，
  // 把用户刚点开的 JSON 节点（<details open>）又折叠回去。
  const detailKey = `${trace?.id}::${view.selected}::${view.bodyRawNid || ''}`
  if (view._detailKey !== detailKey) {
    view._detailKey = detailKey
    renderDetail(trace)
  }
}

let nodeDrag = null
function beginNodeDrag(trace, kind, id, el, e) {
  nodeDrag = {
    trace, kind, id, el,
    sx: e.clientX, sy: e.clientY,
    ox: parseFloat(el.style.left) || 0,
    oy: parseFloat(el.style.top) || 0,
    moved: false,
  }
  e.stopPropagation()
}

// —— 响应体：JSON 树 / 原文 双视图 ——
function parseJsonLoose(text) {
  if (typeof text !== 'string') return { ok: false }
  const t = text.trim()
  if (!t) return { ok: false }
  try { return { ok: true, value: JSON.parse(t) } } catch { return { ok: false } }
}

function renderJsonValue(value, depth = 0) {
  if (value === null) return '<span class="jt-null">null</span>'
  if (Array.isArray(value)) return renderJsonColl(value, depth, true)
  const t = typeof value
  if (t === 'object') return renderJsonColl(value, depth, false)
  if (t === 'string') return `<span class="jt-str">"${escapeHtml(value)}"</span>`
  if (t === 'number') return `<span class="jt-num">${value}</span>`
  if (t === 'boolean') return `<span class="jt-bool">${value}</span>`
  return `<span class="jt-null">${escapeHtml(String(value))}</span>`
}

function renderJsonColl(value, depth, isArray) {
  const entries = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value)
  const summary = isArray ? `[${entries.length}]` : `{${entries.length}}`
  if (!entries.length) return `<span class="jt-punc">${summary}</span>`
  const open = depth < 2 || entries.length <= 6
  const LIMIT = 300
  const rows = entries.slice(0, LIMIT).map(([k, v]) => {
    const key = isArray
      ? `<span class="jt-idx">${k}</span>`
      : `<span class="jt-key">"${escapeHtml(k)}"</span>`
    return `<div class="jt-row">${key}<span class="jt-colon">:</span>${renderJsonValue(v, depth + 1)}</div>`
  }).join('')
  const more = entries.length > LIMIT ? `<div class="jt-more">… 还有 ${entries.length - LIMIT} 项</div>` : ''
  return `<details class="jt"${open ? ' open' : ''}><summary class="jt-sum">${summary}</summary>${rows}${more}</details>`
}

function renderBody(meta, nid) {
  const text = meta.bodyPreview
  if (!text) return ''
  const parsed = parseJsonLoose(text)
  const notes = []
  if (meta.bodyTruncated) notes.push('已截断')
  if (!parsed.ok) notes.push('非合法 JSON，按原文显示')
  const raw = !parsed.ok || view.bodyRawNid === nid
  return `
    <div class="bhead">
      <h3>响应体</h3>
      <span class="bnote">${notes.length ? `（${notes.join('；')}）` : ''}</span>
      ${parsed.ok ? `<button class="bbtn" data-body-mode="1">${raw ? '格式化' : '原文'}</button>` : ''}
    </div>
    ${parsed.ok ? `<div class="jtree"${raw ? ' hidden' : ''}>${renderJsonValue(parsed.value)}</div>` : ''}
    <pre class="braw"${parsed.ok && !raw ? ' hidden' : ''}>${escapeHtml(text)}</pre>`
}

let lastRenderedTrace = null
function renderDetail(trace) {
  lastRenderedTrace = trace
  const body = $('detail-body')
  if (!trace) { body.innerHTML = '<p class="muted">选中图中任意节点查看详情</p>'; return }

  if (view.selected) {
    const backends = backendsOf(trace)
    let hit = null
    for (let bi = 0; bi < backends.length; bi++) {
      const prefix = `b${bi}:`
      if (!view.selected.startsWith(prefix)) continue
      const m = backends[bi].nodes.find((n) => n.id === view.selected.slice(prefix.length))
      if (m) { hit = { m, prefix, backend: backends[bi] }; break }
    }
    if (!hit) {
      // 兼容旧数据（key 无前缀）
      for (const backend of backends) {
        const m = backend.nodes.find((n) => n.id === view.selected)
        if (m) { hit = { m, prefix: '', backend }; break }
      }
    }
    if (hit) {
      const { m, prefix, backend } = hit
      const calls = m.calls.map((c) => `<div class="callrow"><code>L${c.line}</code> → <a href="#" data-key="${escapeHtml(prefix + c.toKey)}">${escapeHtml(c.toKey)}()</a></div>`).join('') || '<p class="muted">没有解析到方法内调用</p>'
      body.innerHTML = `<div class="kv">
        <b>类型</b><span>${m.xml ? 'MyBatis XML 语句' : '后端方法'}</span>
        <b>方法</b><span>${escapeHtml(m.cls)}.${escapeHtml(m.method)}()</span>
        <b>文件</b><span>${escapeHtml(baseName(m.file))}</span>
        <b>行号</b><span>${m.startLine}–${m.endLine}</span>
        <b>深度</b><span>${m.depth}</span>
        ${m.xml ? `<b>语句</b><span>&lt;${m.xmlTag || 'select'}&gt; ${escapeHtml(m.method)}</span>` : ''}
        <b>路由</b><span>${escapeHtml(`${backend.route.method} ${backend.route.path}`)}</span>
      </div>
      <h3 style="margin-top:14px">方法内调用（点行号展开）</h3>${calls}`
      body.querySelectorAll('a[data-key]').forEach((a) => {
        a.onclick = (ev) => { ev.preventDefault(); expansionSet(trace).add(a.dataset.key); renderGraph() }
      })
      return
    }
  }

  const flow = aggregateFlow(trace)
  // 折叠后的代表节点带着聚合信息（count / errorCount），详情必须用它，否则看不到“已复通”
  const node = flow.nodes.find((n) => n.id === view.selected) || trace.nodes.find((n) => n.id === view.selected)
  if (!node) {
    body.innerHTML = '<p class="muted">选中图中任意节点查看详情</p>'
    return
  }
  const times = flow.count.get(node.id) || 0
  const occ = flow.occurrences.get(node.id) || []
  const meta = node.meta || {}
  if (node.kind === 'fe') {
    const lines = String(meta.code || '').split('\n')
    const codeHtml = lines.map((t, i) => {
      const no = (meta.startLine || 1) + i
      return `<div class="ln ${no === meta.line ? 'hl' : ''}"><span class="lno">${no}</span><span class="ltext">${escapeHtml(t) || ' '}</span></div>`
    }).join('')
    body.innerHTML = `<div class="kv">
      <b>类型</b><span>前端代码</span>
      <b>文件</b><span>${escapeHtml(meta.file || '')}</span>
      <b>函数</b><span>${escapeHtml(meta.func || '(未命名)')}</span>
      <b>发起行</b><span>${meta.line || ''}</span>
      <b>函数范围</b><span>${meta.startLine}–${meta.endLine}</span>
    </div>
    <h3 style="margin-top:14px">源码（高亮行发起了请求）</h3><div class="mcode">${codeHtml}</div>`
    return
  }
  const kv = [
    ['类型', KIND_NAME[node.kind] || node.kind],
    ['状态', node.status === 'error' ? '<b style="color:#f85149">异常</b>' : '正常'],
    ['标签', node.label],
  ]
  if (times > 1) kv.push(['重复', `${times} 次（同类请求已折叠）`])
  if (meta.errorCount > 0) {
    kv.push(node.status === 'error'
      ? ['历史', `之前有 ${meta.okCount} 次成功，最近一次失败`]
      : ['历史', `之前失败过 ${meta.errorCount} 次，最近一次成功（已复通）`])
  }
  if (meta.url) kv.push(['URL', meta.url])
  if (meta.method) kv.push(['方法', meta.method])
  if (meta.status != null) kv.push(['HTTP', String(meta.status)])
  if (meta.duration != null) kv.push(['耗时', `${meta.duration}ms`])
  if (meta.path) kv.push(['路由', `${meta.path}`])
  if (meta.file) kv.push(['源码', `${meta.file}${meta.line ? `:${meta.line}` : ''}`])
  if (meta.frame?.file) kv.push(['触发处', `${meta.frame.file}:${meta.frame.line}`])
  if (meta.message) kv.push(['错误', meta.message])
  {
    const errInfo = analyzeErrors(trace, flow)
    if (errInfo) {
      const isRoot = errInfo.rootId === node.id
      const isDown = errInfo.failIds.has(node.id) && !isRoot
      if (isRoot) kv.push(['定位', '⚡ 根因（最早失败点）'])
      else if (isDown) kv.push(['定位', '受影响的异常节点（根因是更早那个红色节点）'])
      if (isRoot && errInfo.hint) kv.push(['判断', errInfo.hint])
    }
  }

  const occHtml = occ.length > 1
    ? `<h3 style="margin-top:14px">每次请求（${occ.length} 次）</h3><pre>${
      occ.map((o, i) => `#${i + 1}  ${o.method || ''} ${o.url || ''}  ${o.status != null ? o.status : ''}  ${o.duration != null ? `${o.duration}ms` : ''}`).join('\n')
    }</pre>`
    : ''

  body.innerHTML = `<div class="kv">${kv.map(([k, v]) => `<b>${escapeHtml(k)}</b><span>${k === '状态' ? v : escapeHtml(v)}</span>`).join('')}</div>`
    + occHtml
    + renderBody(meta, node.id)
    + (meta.stack ? `<h3 style="margin-top:14px">调用栈</h3><pre>${escapeHtml(meta.stack)}</pre>` : '')

  const bm = body.querySelector('[data-body-mode]')
  if (bm) bm.onclick = () => {
    view.bodyRawNid = view.bodyRawNid === node.id ? null : node.id
    renderDetail(lastRenderedTrace)
  }
}

// —— 右侧详情面板可折叠（记住上次状态），折叠后画布自动重排 ——
const detailEl = $('detail')
function applyDetailFold(collapsed) {
  detailEl.classList.toggle('collapsed', collapsed)
  try { localStorage.setItem('apiflow.detailCollapsed', collapsed ? '1' : '0') } catch {}
  setTimeout(() => { if (typeof renderGraph === 'function') renderGraph() }, 0)
}
$('btn-detail-fold').onclick = () => applyDetailFold(true)
$('btn-detail-open').onclick = () => applyDetailFold(false)
applyDetailFold(localStorage.getItem('apiflow.detailCollapsed') === '1')

// —— 画布拖动平移（代替滚动条）：按住空白/卡片拖动，双击空白复位 ——
const canvasEl = $('canvas')
const stageEl = $('stage')
const pan = { x: 0, y: 0 }
const zoom = { k: 1 }
let drag = null

function applyPan() {
  stageEl.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom.k})`
}

function syncZoomBtn() {
  const btn = $('btn-zoom')
  if (btn) btn.textContent = `${Math.round(zoom.k * 100)}%`
}

// Ctrl + 滚轮缩放：以鼠标位置为中心，缩放后鼠标下的点保持不动
canvasEl.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  const rect = canvasEl.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const step = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const k = Math.min(2.5, Math.max(0.3, zoom.k * step))
  if (k === zoom.k) return
  pan.x = mx - (mx - pan.x) * (k / zoom.k)
  pan.y = my - (my - pan.y) * (k / zoom.k)
  zoom.k = k
  applyPan()
  syncZoomBtn()
}, { passive: false })

canvasEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (e.target.closest('button, a, input, textarea, #detail, .mcard, .node')) return
  drag = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y, moved: false }
})

// 拖动单个节点 / 方法卡片：位置写进 view.dragPos，重绘时优先于自动布局
window.addEventListener('mousemove', (e) => {
  if (!nodeDrag) return
  const dx = (e.clientX - nodeDrag.sx) / zoom.k
  const dy = (e.clientY - nodeDrag.sy) / zoom.k
  if (!nodeDrag.moved && Math.hypot(dx * zoom.k, dy * zoom.k) > 3) nodeDrag.moved = true
  if (!nodeDrag.moved) return
  view.dragPos.set(`${nodeDrag.kind}:${nodeDrag.trace.id}:${nodeDrag.id}`, { x: Math.max(8, nodeDrag.ox + dx), y: Math.max(8, nodeDrag.oy + dy) })
  renderGraph()
})

window.addEventListener('mouseup', () => {
  if (!nodeDrag) return
  const moved = nodeDrag.moved
  nodeDrag = null
  if (!moved) return
  // 拖动后吞掉这次 click：方法卡片标题的 click 会切换展开，节点 click 会选中，都不该被拖动误触
  const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault() }
  canvasEl.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => canvasEl.removeEventListener('click', swallow, { capture: true }), 300)
})

window.addEventListener('mousemove', (e) => {
  if (!drag) return
  const dx = e.clientX - drag.sx
  const dy = e.clientY - drag.sy
  if (!drag.moved && Math.hypot(dx, dy) > 4) {
    drag.moved = true
    canvasEl.classList.add('dragging')
  }
  if (drag.moved) {
    pan.x = drag.ox + dx
    pan.y = drag.oy + dy
    applyPan()
  }
})

window.addEventListener('mouseup', () => {
  if (!drag) return
  const moved = drag.moved
  drag = null
  canvasEl.classList.remove('dragging')
  if (moved) {
    // 拖动结束后吞掉这一次 click，避免误触卡片的展开/收起
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault() }
    canvasEl.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => canvasEl.removeEventListener('click', swallow, { capture: true }), 300)
  }
})

canvasEl.addEventListener('dblclick', (e) => {
  if (e.target.closest('.mcard, .node')) return
  pan.x = 0
  pan.y = 0
  zoom.k = 1
  applyPan()
  syncZoomBtn()
})

if ($('btn-motion')) {
  const syncMotion = () => { $('btn-motion').textContent = view.motion ? '动效 开' : '动效 关'; $('btn-motion').classList.toggle('off', !view.motion) }
  syncMotion()
  $('btn-motion').onclick = () => {
    view.motion = !view.motion
    localStorage.setItem('apiflow.motion', view.motion ? '1' : '0')
    view._sig = ''
    syncMotion()
    renderGraph()
  }
}

$('btn-trees').onclick = () => {
  view.forceTrees = !view.forceTrees
  $('btn-trees').textContent = view.forceTrees ? '隐藏方法树' : '显示方法树'
  renderGraph()
}
$('btn-groups').onclick = () => {
  const trace = activeTrace()
  if (!trace) return
  const set = collapsedSet(trace)
  const total = backendsOf(trace).length
  const allOpen = set.size === 0
  set.clear()
  if (allOpen) for (let i = 0; i < total; i++) set.add(i)
  renderGraph()
  renderDetail(trace)
}

$('btn-zoom').onclick = () => {
  pan.x = 0
  pan.y = 0
  zoom.k = 1
  applyPan()
  syncZoomBtn()
}

$('btn-connect').onclick = async () => { $('pill-cdp').textContent = '连接中…'; await api('/api/connect', 'POST'); tick() }
$('btn-reload').onclick = async () => { await api('/api/reload', 'POST'); view.expanded.clear(); tick() }
$('btn-reset').onclick = async () => { await api('/api/reset', 'POST'); view.traceId = null; view.selected = null; view.expanded.clear(); view.collapsed.clear(); view.dragPos.clear(); tick() }

$('btn-scan').onclick = () => refreshTargets()
$('btn-launch').onclick = async () => {
  const sel = $('sel-target')
  const target = sel.value
  if (!target) return
  const btn = $('btn-launch')
  const old = btn.textContent
  btn.disabled = true
  btn.textContent = '启动中…'
  try {
    const r = await api('/api/launch', 'POST', { url: target })
    if (!r.ok) throw new Error(r.error || '启动失败')
    view.traceId = null; view.selected = null
    view.expanded.clear(); view.collapsed.clear(); view.dragPos.clear()
    await tick()
    refreshTargets()
  } catch (err) {
    $('pill-cdp').textContent = `启动失败：${err.message}`
    $('pill-cdp').className = 'pill bad'
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

refreshTargets()
setInterval(() => {
  const sel = $('sel-target')
  if (!sel || document.activeElement === sel) return
  refreshTargets()
}, 8000)

tick()
view.timer = setInterval(() => { if (!document.hidden) tick() }, 700)
