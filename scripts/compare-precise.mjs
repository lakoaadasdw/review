// 精确模式对照：javac 语法树 vs 硬扫解析器
// node scripts/compare-precise.mjs <backend-root>
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { indexJavaProject } from '../src/java-routes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.argv[2] || '<local-path>'
const tmp = join(process.env.TEMP || '/tmp', `javac-dump-${Date.now()}.json`)
const cp = join(here, '..', 'tools', 'out')

const t0 = Date.now()
const run = spawnSync('java', ['-cp', cp, 'JavacDump', root, tmp], { encoding: 'utf8' })
const javacMs = Date.now() - t0
if (run.status !== 0 || !existsSync(tmp)) {
  console.error('javac dump 失败', run.status, run.stderr?.slice(0, 400))
  process.exit(1)
}
const t1 = Date.now()
const ours = indexJavaProject(root)
const oursMs = Date.now() - t1
const precise = JSON.parse(readFileSync(tmp, 'utf8'))

// 我们这边的方法集与调用点集
const ourMethods = new Set()
const ourClassFiles = new Map()
for (const [key, node] of ours.methods) {
  ourMethods.add(key)
  const cls = node.cls || key.split('.')[0]
  if (!ourClassFiles.has(cls) && node.file) ourClassFiles.set(cls, node.file.split(String.fromCharCode(92)).join('/'))
}
const ourCalls = new Set()
for (const site of ours.callSites || []) {
  const file = (site.file || '').split(String.fromCharCode(92)).join('/')
  const relFile = file.indexOf('/src/main/java/') >= 0 ? file.slice(file.indexOf('/src/main/java/') + 1) : file
  ourCalls.add(`${relFile}|${site.callLine}|${site.toMethod}`)
}

// javac 侧
const javacCalls = precise.invocations || []
const decls = (precise.decls || []).filter((d) => d.name !== '<init>' && d.cls)
const javacDeclKeys = new Set(decls.map((d) => `${d.cls}.${d.name}`))
const projectMethodNames = new Set(decls.map((d) => d.name))

const rel = (p) => { const i = p.indexOf('/src/main/java/'); return i >= 0 ? p.slice(i + 1) : p }
const javacSet = new Set()
let projectInternal = 0
let projectInternalMatched = 0
for (const inv of javacCalls) {
  const file = rel(inv.file)
  const key = `${file}|${inv.line}|${inv.name}`
  javacSet.add(key)
  // javac 的 qualifier 是源码里的接收者表达式；用它粗判是否项目内调用
  const q = (inv.qualifier || '').trim()
  const first = q.split(/[.(]/)[0]
  const isProject = q && (ours.classes.has ? ours.classes.has(first) : false)
  if (isProject) {
    projectInternal++
    if (ourCalls.has(key)) projectInternalMatched++
  }
}
let matchedAll = 0
for (const k of javacSet) if (ourCalls.has(k)) matchedAll++
// 项目相关调用点：被调方法名在项目里有声明（排除 JDK/第三方）
let projectRelated = 0
let projectRelatedMatched = 0
for (const inv of javacCalls) {
  if (!projectMethodNames.has(inv.name)) continue
  projectRelated++
  const key = `${rel(inv.file)}|${inv.line}|${inv.name}`
  if (ourCalls.has(key)) projectRelatedMatched++
}
// 方法声明覆盖：javac 声明的方法里，我们的索引覆盖了多少
let declMatched = 0
for (const key of javacDeclKeys) if (ourMethods.has(key)) declMatched++
const fmt = (n) => `${n}`
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—')

console.log(`# 精确模式对照：${root}\n`)
console.log(`| 指标 | javac（编译器语法树） | 硬扫解析器 |`)
console.log(`| --- | --- | --- |`)
console.log(`| 文件数 | ${precise.files} | ${ours.files} |`)
console.log(`| 类型数 | ${precise.types} | ${ours.classes} |`)
console.log(`| 方法数 | ${precise.methods} | ${ours.methods.size} |`)
console.log(`| 调用点（语法层） | ${javacSet.size} | ${ourCalls.size} |`)
console.log(`| 耗时 | ${javacMs} ms | ${oursMs} ms |`)
console.log('')
console.log(`- 硬扫对 javac 调用点的命中率：**${pct(matchedAll, javacSet.size)}**（${matchedAll}/${javacSet.size}）`)
console.log(`- 方法声明覆盖率：**${pct(declMatched, javacDeclKeys.size)}**（${declMatched}/${javacDeclKeys.size}）`)
console.log(`- 项目相关调用点解析率（被调方法名在项目里有声明）：**${pct(projectRelatedMatched, projectRelated)}**（${projectRelatedMatched}/${projectRelated}）`)
if (projectInternal) {
  console.log(`- 接收者命中我们索引类的调用：${pct(projectInternalMatched, projectInternal)}（${projectInternalMatched}/${projectInternal}）`)
}
console.log(`- 未解析分类：项目内 ${ours.diagnostics?.actionable ?? 0} / 第三方 ${ours.diagnostics?.external ?? 0} / 生成代码 ${ours.diagnostics?.generated ?? 0}`)
