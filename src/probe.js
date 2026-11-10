/**
 * 注入到页面的运行时探针（页面脚本执行前注入）。
 * 采集：点击 → 事件 handler（含源码位置）→ fetch/XHR 请求 → 响应/异常。
 * 通过 CDP binding __apiflowSend 把事件回传宿主。
 */
(() => {
  const PROBE_VERSION = 2
  if (window.__apiflow && window.__apiflow.version >= PROBE_VERSION) return
  window.__apiflow = { version: PROBE_VERSION, startedAt: Date.now() }

  const send = (payload) => {
    try { window.__apiflowSend && window.__apiflowSend(JSON.stringify(payload)) } catch {}
  }
  const uid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
  // 请求发起点的方法栈：宿主据此把 URL 映射回前端源码文件与行号
  // 请求参数：body（文本，最多 4000 字）+ 请求头（用于「参数随请求流动」展示）
  function reqDetail(body, headers) {
    const out = {}
    try {
      const b = typeof body === 'string' ? body : ''
      if (b && b.trim()) out.body = b.slice(0, 4000)
    } catch {}
    try {
      const obj = {}
      if (headers && typeof headers.forEach === 'function') {
        headers.forEach((v, k) => { if (obj[k] === undefined) obj[k] = String(v).slice(0, 300) })
      }
      if (Object.keys(obj).length) out.headers = obj
    } catch {}
    return out
  }

  const callStack = () => {
    try {
      const prev = Error.stackTraceLimit
      Error.stackTraceLimit = 30
      const st = String(new Error().stack || '').split(/\r?\n/).slice(1, 30).join('\n')
      Error.stackTraceLimit = prev
      return st
    } catch { return '' }
  }

  let currentTrace = null
  // 只有「点击后的一小段时间内」发生的请求才归到这条点击链路；
  // 之后的请求（定时轮询、页面定时刷新）开新链路，由宿主聚合到「轮询」页。
  let activeUntil = 0
  const REQUEST_WINDOW = 2500
  const traceOf = (reason) => {
    const now = Date.now()
    if (!currentTrace || now > activeUntil) {
      currentTrace = uid()
      activeUntil = now + REQUEST_WINDOW
      send({ kind: 'trace-start', trace: currentTrace, reason: reason && reason !== 'error' ? 'poll' : 'auto', at: now })
    }
    return currentTrace
  }

  const describe = (el) => {
    if (!el || el.nodeType !== 1) return String(el && el.nodeName || el)
    const tag = el.tagName.toLowerCase()
    const id = el.id ? `#${el.id}` : ''
    const cls = el.classList && el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : ''
    const text = (el.innerText || el.value || el.getAttribute?.('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)
    return `${tag}${id}${cls}${text ? ` "${text}"` : ''}`
  }

  // ---- 点击：开启一条新链路，并给目标元素打标记（供宿主用 CDP 反查 handler 源码位置）----
  document.addEventListener('click', (e) => {
    const trace = uid()
    currentTrace = trace
    activeUntil = Date.now() + REQUEST_WINDOW
    try {
      document.querySelectorAll('[data-apiflow-target]').forEach((el) => el.removeAttribute('data-apiflow-target'))
      if (e.target && e.target.nodeType === 1) e.target.setAttribute('data-apiflow-target', '1')
    } catch {}
    send({ kind: 'trace-start', trace, reason: 'click', at: Date.now() })
    send({ kind: 'click', trace, target: describe(e.target), x: e.clientX, y: e.clientY, at: Date.now() })
  }, true)

  // ---- 事件 handler 包装：记录被点击触发的方法栈 ----
  const origAdd = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (typeof fn === 'function' && /^(click|pointerdown|submit)$/.test(type)) {
      const wrapped = function (...args) {
        const trace = traceOf(type)
        activeUntil = Math.max(activeUntil, Date.now() + 2000)
        let stack = ''
        try { stack = String(new Error().stack || '').split('\n').slice(1, 7).join('\n') } catch {}
        send({ kind: 'handler', trace, event: type, target: describe(args[0]?.currentTarget || this), stack, at: Date.now() })
        try { return fn.apply(this, args) } catch (err) {
          send({ kind: 'error', trace, where: 'handler', message: String(err?.message ?? err), stack: String(err?.stack || ''), at: Date.now() })
          throw err
        }
      }
      return origAdd.call(this, type, wrapped, opts)
    }
    return origAdd.call(this, type, fn, opts)
  }

  // ---- fetch ----
  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = async function (input, init = {}) {
      const trace = traceOf('fetch')
      const reqId = uid()
      const url = typeof input === 'string' ? input : input?.url || String(input)
      const method = String(init.method || input?.method || 'GET').toUpperCase()
      const start = performance.now()
      const headers = new Headers(init.headers || input?.headers || undefined)
      headers.set('x-apiflow-trace', trace)
      send({ kind: 'request', trace, reqId, url, method, stack: callStack(), at: Date.now(), ...reqDetail(init.body, headers) })
      try {
        const res = await origFetch.call(this, input, { ...init, headers })
        let bodyPreview = ''
        let bodyTruncated = false
        try {
          const bodyText = await res.clone().text()
          bodyTruncated = bodyText.length > 20000
          bodyPreview = bodyText.slice(0, 20000)
        } catch {}
        send({
          kind: 'response', trace, reqId, url, method, status: res.status, ok: res.ok,
          duration: Math.round(performance.now() - start), bodyPreview, bodyTruncated, at: Date.now(),
        })
        return res
      } catch (err) {
        send({ kind: 'error', trace, reqId, url, where: 'fetch', message: String(err?.message ?? err), at: Date.now() })
        throw err
      }
    }
  }

  // ---- XHR ----
  const XHR = window.XMLHttpRequest
  if (XHR) {
    const origOpen = XHR.prototype.open
    const origSend = XHR.prototype.send
    XHR.prototype.open = function (method, url, ...rest) {
      this.__apiflow = { method: String(method || 'GET').toUpperCase(), url: String(url) }
      return origOpen.call(this, method, url, ...rest)
    }
    XHR.prototype.send = function (body) {
      const meta = this.__apiflow
      if (meta) {
        const trace = traceOf('xhr')
        const reqId = uid()
        const start = performance.now()
        meta.trace = trace
        meta.reqId = reqId
        send({ kind: 'request', trace, reqId, url: meta.url, method: meta.method, stack: callStack(), at: Date.now(), ...reqDetail(body) })
        this.addEventListener('loadend', () => {
          let bodyPreview = ''
          let bodyTruncated = false
          try {
            const bodyText = String(this.responseText || '')
            bodyTruncated = bodyText.length > 20000
            bodyPreview = bodyText.slice(0, 20000)
          } catch {}
          send({
            kind: 'response', trace, reqId, url: meta.url, method: meta.method, status: this.status,
            ok: this.status >= 200 && this.status < 300,
            duration: Math.round(performance.now() - start), bodyPreview, bodyTruncated, at: Date.now(),
          })
        })
      }
      return origSend.call(this, body)
    }
  }

  // ---- 全局异常 ----
  window.addEventListener('error', (e) => {
    send({ kind: 'error', trace: traceOf('error'), where: 'window', message: String(e.message || ''), stack: String(e.error?.stack || ''), at: Date.now() })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    send({ kind: 'error', trace: traceOf('rejection'), where: 'promise', message: String(r?.message ?? r), stack: String(r?.stack || ''), at: Date.now() })
  })
})()
