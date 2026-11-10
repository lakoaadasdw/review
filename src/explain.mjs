/**
 * 方法解释：给调用链上的方法生成「一句话作用 + 数据流转 + 业务语义 + 风险点」。
 *
 * 两种来源：
 *  1) rule  —— 无 key / 调用失败时的降级：按方法名、注解、SQL、返回类型拼句子；
 *  2) llm   —— 配了 key 时走外部 API（OpenAI 兼容 /chat/completions），批量一次问一条链。
 *
 * 缓存：按「文件::方法」存到系统临时目录，key 里带方法体 hash，方法改了就自动重算，
 *      没改的方法直接读缓存（针对性缓存，不是整库缓存）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CACHE_VERSION = 1

export function methodHash(code) {
  return createHash('sha1').update(String(code || '')).digest('hex').slice(0, 12)
}

export function cachePathFor(root) {
  const h = createHash('sha1').update(String(root || '')).digest('hex').slice(0, 12)
  return join(tmpdir(), `apiflow-explain-${h}.json`)
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30

export function loadCache(root) {
  const file = cachePathFor(root)
  try {
    if (!existsSync(file)) return { file, data: {} }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || raw.v !== CACHE_VERSION || typeof raw.items !== 'object') return { file, data: {} }
    return { file, data: raw.items }
  } catch {
    return { file, data: {} }
  }
}

export function saveCache(file, data) {
  // 只留最近使用过的，避免无限增长
  const now = Date.now()
  const items = {}
  for (const [k, v] of Object.entries(data || {})) {
    if (!v || !v.hash) continue
    if (now - (v.at || 0) > CACHE_TTL_MS) continue
    items[k] = v
  }
  try {
    writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, items }), 'utf8')
  } catch {}
  return items
}

/** 方法名/注解/SQL → 中文一句话（降级方案，也用于给 LLM 提供提示） */
function ruleOf(node) {
  const name = String(node.method || '')
  const cls = String(node.cls || '')
  const code = String(node.code || '')
  const isSql = isSqlNode(node)
  const lower = name.toLowerCase()

  if (isSql) {
    const head = sqlHead(node, 46)
    return `MyBatis 查询：${head}${head.length >= 46 ? '…' : ''}`
  }

  let purpose = ''
  if (/^(get|safe|is|has)[A-Z_$]/.test(name)) purpose = '读取字段/兜底默认值'
  else if (/^(login|logout|signin|signup|authenticate|verifytoken)/.test(lower)) purpose = '认证与登录态处理'
  else if (/^(page|list|query|find|search|get|load|fetch|select|count)/.test(lower)) purpose = '查询数据'
  else if (/^(save|insert|create|add|register)/.test(lower)) purpose = '写入新数据'
  else if (/^(update|edit|modify|set|change)/.test(lower)) purpose = '更新已有数据'
  else if (/^(delete|remove|purge|clear)/.test(lower)) purpose = '删除数据'
  else if (/^(approve|reject|audit|review|confirm|cancel)/.test(lower)) purpose = '审核/状态流转'
  else if (/^(send|notify|push|publish|emit)/.test(lower)) purpose = '发送通知/消息'
  else if (/^(calc|compute|summary|stats|overview|dashboard)/.test(lower)) purpose = '统计/聚合计算'
  else if (/^(parse|convert|map|to[A-Z])/.test(name)) purpose = '数据转换'
  else purpose = '业务处理'

  const fsm = /static/.test(code) ? '' : cls ? `${cls} 的` : ''
  return `${fsm}${purpose}`.trim()
}

/** XML/原生 SQL 节点判定：MyBatis 节点 code 是 `<select id=...>…</select>` */
function isSqlNode(node) {
  const code = String(node.code || '')
  const tag = String(node.xmlTag || '')
  if (tag === 'sql') return true
  if (/^\s*<(select|insert|update|delete|sql)/i.test(code)) return true
  return /^\s*(select|insert|update|delete|with)/i.test(code)
}

/** 从 XML/SQL 里抽一句可读的 SQL 摘要 */
function sqlHead(node, max = 90) {
  let code = String(node.code || '')
  code = code.replace(/^\s*<[^>]+>/, '').replace(/<\/[^>]+>\s*$/, '')
  code = code.replace(/<[^>]+>/g, ' ').replace(/\$\{|#\{[^}]*\}/g, '?')
  code = code.replace(/\s+/g, ' ').trim()
  return code.slice(0, max)
}

const MODIFIERS = /^(?:(?:public|private|protected|static|final|synchronized|abstract|default|native|strictfp)\s+)+/

/** 从方法签名取入参名，从返回类型取个大概 */
function signatureOf(node) {
  const code = String(node.code || '')
  if (isSqlNode(node)) {
    return { args: [], ret: 'SQL 结果集', sql: true }
  }
  const head = (code.split(/\r?\n/).find((l) => l.includes('(')) || '').trim()
  const sig = head.split('(')[0].replace(/^@[\w.]+(\([^)]*\))?\s*/, '').replace(MODIFIERS, '').trim()
  const retMatch = sig.match(/^(.*?)\s+([\w$]+)$/)
  const ret = retMatch ? retMatch[1].replace(/\s+/g, ' ').trim() : ''
  const m = head.match(/\(([^)]*)\)/)
  const rawArgs = m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : []
  const args = rawArgs
    .map((a) => a.replace(/@[\w.]+(\([^)]*\))?/g, '').replace(/\.\.\./g, '').trim())
    .map((a) => (a.split(/\s+/).pop() || '').replace(/\[\]$/, ''))
    .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))
  return { args, ret }
}

function ruleDetail(node) {
  const { args, ret } = signatureOf(node)
  const short = ruleOf(node)
  if (isSqlNode(node)) {
    return { short, purpose: short, flow: `SQL：${sqlHead(node, 80)}`, risk: '直接访问数据库，注意条件、分页与排序' }
  }
  const flow = args.length || ret
    ? `入参 ${args.length ? args.join('、') : '无'} → 返回 ${ret || '未知'}`
    : '入参/返回值未解析'
  const risk = node.xmlTag === 'xml' || node.xmlTag === 'sql'
    ? '直接读写数据库，注意条件与分页边界'
    : /throw|Exception/.test(String(node.code || ''))
      ? '包含显式抛错/异常分支'
      : '未见显式异常分支'
  return { short, purpose: short, flow, risk }
}

/** 组装给 LLM 的请求体（方法裁剪：只留签名 + 前 24 行） */
function clipForPrompt(node) {
  const code = String(node.code || '').split(/\r?\n/)
  return {
    id: node.id,
    cls: node.cls,
    method: node.method,
    file: node.file,
    startLine: node.startLine,
    signature: code.slice(0, 3).join('\n').slice(0, 300),
    body: code.slice(0, 24).join('\n').slice(0, 1200),
    sql: node.xmlTag === 'sql' ? String(node.code || '').slice(0, 800) : undefined,
  }
}

const PROMPT = `你是 Java 后端代码阅读助手。给你一组调用链上的方法（可能来自 Controller/Service/Mapper/MyBatis XML）。
对每个方法输出四项，全部用简体中文：
- purpose：一句话作用（≤24 字，动词开头）
- flow：数据流转（入参 → 关键处理 → 返回，≤40 字）
- biz：业务语义（它服务于哪个业务动作，≤30 字）
- risk：风险/注意点（空字符串表示没有明显风险，≤30 字）
只输出 JSON：{"items":[{"id":"...","purpose":"","flow":"","biz":"","risk":""}]}。不要输出多余文字。`

async function callLLM(nodes, conf) {
  const base = String(conf.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  const body = {
    model: conf.model || 'deepseek-chat',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify({ items: nodes.map(clipForPrompt) }) },
    ],
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Number(conf.timeoutMs) || 60000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content || ''
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed.items) ? parsed.items : []
    const map = new Map()
    for (const it of list) if (it && it.id) map.set(String(it.id), it)
    return map
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给一批节点生成解释。
 * @returns {Promise<{items: Record<string, any>, source: 'llm'|'rule'|'mixed', error?: string}>}
 */
export async function explainNodes(nodes, opts = {}) {
  const root = opts.root || ''
  const conf = opts.llm || {}
  const { file, data } = loadCache(root)
  const items = {}
  const pending = []

  for (const node of nodes) {
    const key = `${node.file || ''}::${node.cls || ''}::${node.method || ''}`
    const hash = methodHash(node.code)
    const hit = data[key]
    // 命中规则：方法体没变就复用；但如果现在有模型 key 而缓存是规则生成的，则升级重算
    if (hit && hit.hash === hash && hit.short && (hit.value.source === 'llm' || !conf.apiKey)) {
      items[node.id] = { ...hit.value, cached: true }
      hit.at = Date.now()
      continue
    }
    pending.push({ node, key, hash })
  }

  let source = pending.length ? 'rule' : 'none'
  let error = ''
  if (pending.length && conf.apiKey) {
    try {
      const got = await callLLM(pending.map((p) => p.node), conf)
      for (const p of pending) {
        const it = got.get(p.node.id)
        const base = ruleDetail(p.node)
        const value = {
          short: (it && it.purpose) || base.short,
          purpose: (it && it.purpose) || base.purpose,
          flow: (it && it.flow) || base.flow,
          biz: (it && it.biz) || '',
          risk: (it && it.risk) || base.risk,
          source: 'llm',
        }
        items[p.node.id] = { ...value, cached: false }
        data[p.key] = { hash: p.hash, at: Date.now(), value }
      }
      source = 'llm'
    } catch (e) {
      error = String(e && e.message ? e.message : e)
    }
  }

  if (pending.length && source !== 'llm') {
    for (const p of pending) {
      const base = ruleDetail(p.node)
      const value = { short: base.short, purpose: base.purpose, flow: base.flow, biz: '', risk: base.risk, source: 'rule' }
      items[p.node.id] = { ...value, cached: false }
      // 规则结果也落盘：同一方法再打开直接读缓存；方法体变了 hash 变，自动重算。
      // 之后配了模型 key 时，命中规则缓存会按上面的规则升级成模型解释。
      data[p.key] = { hash: p.hash, at: Date.now(), value }
    }
    source = 'rule'
  }

  saveCache(file, data)
  return { items, source, error, cacheFile: file, pending: pending.length }
}

/** 连通性测试：最小请求，确认 key/端点/模型可用 */
export async function pingLLM(conf) {
  const base = String(conf.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.apiKey}` },
      body: JSON.stringify({
        model: conf.model || 'deepseek-chat',
        max_tokens: 200,
        temperature: 0,
        messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
      }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`)
    let data = null
    try { data = JSON.parse(text) } catch {}
    const choice = data && data.choices && data.choices[0]
    const msg = (choice && choice.message) || {}
    const content = String(msg.content || '').trim()
    const reasoning = String(msg.reasoning_content || '').trim()
    const finish = (choice && choice.finish_reason) || ''
    let quote = content
    if (!quote && reasoning) quote = '（推理模型，无正文）' + reasoning.slice(0, 30)
    if (!quote) quote = `无正文（finish_reason=${finish || '未知'}，response.object=${(data && data.object) || '?'}）`
    return {
      quote,
      model: (data && data.model) || conf.model,
      finish,
      object: (data && data.object) || '',
      empty: !content,
    }
  } finally {
    clearTimeout(timer)
  }
}
