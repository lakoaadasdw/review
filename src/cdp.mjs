/**
 * 极简 Chrome DevTools Protocol 客户端。
 * 只用 Node 22 自带的全局 WebSocket / fetch，无第三方依赖。
 */
export class CDP {
  #ws
  #nextId = 0
  #pending = new Map()
  #handlers = new Map()

  constructor(wsUrl) {
    this.#ws = new WebSocket(wsUrl)
    this.#ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id != null && this.#pending.has(msg.id)) {
        const { resolve, reject, timer } = this.#pending.get(msg.id)
        this.#pending.delete(msg.id)
        clearTimeout(timer)
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'}`))
        else resolve(msg.result)
        return
      }
      if (msg.method) {
        for (const cb of this.#handlers.get(msg.method) || []) {
          try { cb(msg.params) } catch (err) { console.error('[cdp] handler error', err) }
        }
      }
    })
    this.#ws.addEventListener('close', () => {
      for (const { reject, timer } of this.#pending.values()) { clearTimeout(timer); reject(new Error('CDP closed')) }
      this.#pending.clear()
    })
    this.#ws.addEventListener('error', (err) => console.error('[cdp] socket error', err?.message || err))
  }

  static async version(port, timeoutMs = 1500) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
      return res.ok ? await res.json() : null
    } catch { return null }
  }

  static async targets(port, timeoutMs = 1500) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return []
      const list = await res.json()
      return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
    } catch { return [] }
  }

  static async attach(wsUrl) {
    const cdp = new CDP(wsUrl)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      cdp.#ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      cdp.#ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WebSocket connect failed')) }, { once: true })
    })
    return cdp
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP ${method} timeout`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, cb) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, [])
    this.#handlers.get(method).push(cb)
  }

  close() {
    try { this.#ws.close() } catch {}
  }
}
