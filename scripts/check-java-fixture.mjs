// 回归夹具自检：node scripts/check-java-fixture.mjs
import { fileURLToPath } from 'node:url'
import { indexJavaProject } from '../src/java-routes.mjs'

const ROOT = fileURLToPath(new URL('../fixtures/java-multi-line', import.meta.url))
const idx = indexJavaProject(ROOT)
const diag = idx.diagnostics || {}
const unresolved = diag.unresolved || []
const actionable = unresolved.filter((u) => u.kind === 'actionable')
const generated = unresolved.filter((u) => u.kind === 'generated')

const routes = idx.routes.map((r) => `${r.method} ${r.path}`).sort()
let failed = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

check('路由数 = 2', idx.routes.length === 2, routes.join(', '))
check('多行签名+泛型接口方法被索引', idx.methods.has('JoinService.listApplications'))
check('Controller 调用被解析', (idx.methods.get('JoinController.list')?.calls || []).some((c) => c.toKey === 'JoinService.listApplications' || c.toKey === 'JoinServiceImpl.listApplications'))
check('接口→实现跳转', (idx.methods.get('JoinServiceImpl.listApplications')?.calls || []).some((c) => c.toKey === 'JoinMapper.findForAdmin'), JSON.stringify((idx.methods.get('JoinServiceImpl.listApplications')?.calls || []).map((c) => c.toKey)))
check('项目内真断调用被标 actionable', actionable.some((u) => u.name === 'missingMethod'), JSON.stringify(actionable.map((u) => `${u.cls}.${u.from}->${u.name}`)))
check('Lombok builder 归为 generated', generated.some((u) => u.name === 'builder'), JSON.stringify(generated.map((u) => `${u.cls}->${u.name}`)))
check('诊断四项齐全', typeof diag.actionable === 'number' && typeof diag.external === 'number' && typeof diag.generated === 'number')
console.log(`\nfiles=${idx.files} classes=${idx.classes} routes=${idx.routes.length} methods=${idx.methods.size} actionable=${diag.actionable} external=${diag.external} generated=${diag.generated}`)
process.exit(failed ? 1 : 0)
