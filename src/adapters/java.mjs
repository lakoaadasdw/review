/** Java / Spring Boot 适配器：语法解析在 java-routes.mjs，图逻辑在 graph-core。 */
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { indexJavaProject } from '../java-routes.mjs'
import { buildCallTree, matchRoute, summarize } from '../graph-core.mjs'

export function detectJava(root) {
  const markers = ['pom.xml', 'build.gradle', 'build.gradle.kts']
  let cur = root
  for (let i = 0; i < 6; i++) {
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

export const javaAdapter = {
  id: 'java',
  label: 'Java / Spring Boot',
  detect: detectJava,
  index: indexJavaProject,
  buildCallTree,
  matchRoute,
  summarize,
}
