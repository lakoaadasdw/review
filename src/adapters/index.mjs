/** 适配器注册表：按 --lang 选择，或 auto 探测后端根目录里的项目标记。 */
import { javaAdapter } from './java.mjs'
import { pythonAdapter } from './python.mjs'

export const ADAPTERS = [javaAdapter, pythonAdapter]

export function listAdapters() {
  return ADAPTERS.map((adapter) => ({ id: adapter.id, label: adapter.label }))
}

export function pickAdapter(root, lang = 'auto') {
  const wanted = String(lang || 'auto').toLowerCase()
  if (wanted !== 'auto') {
    const found = ADAPTERS.find((adapter) => adapter.id === wanted)
    if (!found) throw new Error(`未知的后端语言：${lang}（可选：${ADAPTERS.map((a) => a.id).join(' / ')} 或 auto）`)
    return found
  }
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.detect(root)) return adapter
    } catch {}
  }
  throw new Error(`无法自动识别后端语言：${root}（可用 --lang java|python 显式指定）`)
}
