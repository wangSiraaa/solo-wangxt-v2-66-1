/**
 * 解释方案分支验收测试（Node + fake-indexeddb，`npm test` 运行）。
 *
 * 覆盖验收点：
 * 1. 旧版单方案 IndexedDB 首次加载 → 无损迁移为默认方案（保留关系、撤销记录、批次）
 * 2. 从默认方案派生后分别编辑，方案间互不串扰；当前选择与来源引用持久化
 * 3. 传递闭包语义对比：桥接边删除后标出新增/失效的传递结论；冗余边场景闭包一致
 * 4. 成环冲突可保存，且冲突只属于该方案，不影响其他方案闭包
 * 5. 切换、关闭重开数据库（模拟刷新）、删除来源方案后数据一致
 * 6. 导入旧版工程 JSON → 自动生成默认方案并保留原关系与撤回记录
 * 7. v2 导出→导入往返：方案、选择、各方案关系、悬空来源引用全部恢复
 * 8. 撤销机制与方案操作兼容
 */
import './setup'
import Dexie from 'dexie'
import { db } from '../src/db'
import * as store from '../src/store'
import { compareSchemes } from '../src/compare'
import { reachablePairs } from '../src/graph'
import { DEFAULT_SCHEME_ID, type Relation, type RelationDraft } from '../src/types'

let checks = 0
let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}

const relsOf = (sid: string) => store.state.relations.filter((r) => r.schemeId === sid)
const idOf = (label: string) => store.state.units.find((u) => u.label === label)!.id
const draft = (from: string, to: string, kind: RelationDraft['kind'], source: RelationDraft['source'] = 'observation'): RelationDraft =>
  ({ from, to, kind, source, evidenceIds: [], note: '' })
const relPairs = (rels: Relation[]) =>
  reachablePairs(rels.filter((r) => r.status === 'active' && r.kind === 'earlier').map((r) => ({ id: r.id, from: r.from, to: r.to })))
const findActive = (sid: string, from: string, to: string, kind: Relation['kind'] = 'earlier') =>
  store.state.relations.find((r) => r.schemeId === sid && r.from === from && r.to === to && r.kind === kind && r.status === 'active')

async function simulateRefresh() {
  // 模拟刷新：关闭并重新打开数据库连接后重新加载全部状态
  await db.close()
  await db.open()
  await store.refresh()
}

async function main() {
  console.log('\n[1] 旧版单方案 IndexedDB 首次加载 → 无损迁移为默认方案')
  {
    // 以 v1 结构写入旧数据（应用 db 在首次操作时才打开，此时尚未触发升级）
    const legacy = new Dexie('harris-matrix')
    legacy.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    const now = Date.now()
    await legacy.open()
    await legacy.table('units').bulkPut([
      { id: 'U1', label: 'U1', type: 'deposit', note: '', createdAt: now },
      { id: 'U2', label: 'U2', type: 'deposit', note: '', createdAt: now },
      { id: 'U3', label: 'U3', type: 'deposit', note: '', createdAt: now },
    ])
    await legacy.table('relations').bulkPut([
      { id: 'L1', from: 'U1', to: 'U2', kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: now },
      { id: 'L2', from: 'U2', to: 'U3', kind: 'earlier', source: 'inference', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: now + 1 },
      { id: 'L3', from: 'U1', to: 'U3', kind: 'earlier', source: 'observation', status: 'retracted', conflict: false, evidenceIds: [], note: '', createdAt: now + 2 },
    ])
    const l3Snapshot = { id: 'L3', from: 'U1', to: 'U3', kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: now + 2 }
    await legacy.table('retractions').put({ id: 'X1', relationId: 'L3', snapshot: l3Snapshot, reason: '复核后撤回', at: now + 3 })
    await legacy.table('batches').put({ id: 'B1', label: '旧批次', at: now, undone: false, mutations: [] })
    await legacy.close()

    // 首次打开应用：触发 v1 → v2 升级
    await store.refresh()

    check('自动创建唯一的默认方案', store.state.schemes.length === 1 && store.state.schemes[0].name === '默认方案')
    check('默认方案使用固定 id', store.state.schemes[0].id === DEFAULT_SCHEME_ID)
    check('当前方案选择持久化到 meta', (await db.meta.get('currentSchemeId'))?.value === DEFAULT_SCHEME_ID)
    check('首次加载后当前方案为默认方案', store.state.currentSchemeId === DEFAULT_SCHEME_ID)
    check('原关系全部保留（3 条）', store.state.relations.length === 3)
    check('关系全部归入默认方案', store.state.relations.every((r) => r.schemeId === DEFAULT_SCHEME_ID))
    check('活跃关系 2 条、已撤回 1 条', store.activeRelations.value.length === 2 && store.schemeRetractions.value.length === 1)
    const x1 = store.state.retractions.find((x) => x.id === 'X1')
    check('撤回记录无损保留（理由与快照）', x1?.reason === '复核后撤回' && x1?.schemeId === DEFAULT_SCHEME_ID && x1?.snapshot.from === 'U1' && x1?.snapshot.status === 'active')
    check('撤销批次记录保留', store.state.batches.length === 1 && store.state.batches[0].label === '旧批次')
    check('传递闭包正确：U1 早于 U3（U1→U2→U3）', relPairs(relsOf(DEFAULT_SCHEME_ID)).includes('U1→U3'))

    await store.refresh()
    check('再次加载结果稳定（迁移幂等）', store.state.schemes.length === 1 && store.state.relations.length === 3)
  }

  console.log('\n[2] 从默认方案派生后分别编辑，方案间互不串扰')
  {
    await store.deriveScheme('方案乙')
    const bId = store.state.schemes.find((s) => s.name === '方案乙')!.id
    check('派生后方案数为 2', store.state.schemes.length === 2)
    check('派生后自动切换到新方案', store.state.currentSchemeId === bId)
    const bRow = await db.schemes.get(bId)
    check('来源方案持久化（id + 名称快照）', bRow?.sourceSchemeId === DEFAULT_SCHEME_ID && bRow?.sourceSchemeName === '默认方案')
    check('副本包含全部关系（含已撤回）', relsOf(bId).length === 3)
    check('副本包含撤销记录', store.state.retractions.filter((x) => x.schemeId === bId).length === 1)
    check('副本使用全新关系 id', !relsOf(bId).some((r) => ['L1', 'L2', 'L3'].includes(r.id)))

    // 在方案乙中：新增推断边 U1→U3、撤回 U1→U2、新增同期关联 U2≈U3
    await store.addRelation(draft('U1', 'U3', 'earlier', 'inference'))
    await store.retractRelation(findActive(bId, 'U1', 'U2')!.id, '方案乙中重新判断')
    await store.addRelation(draft('U2', 'U3', 'contemporary'))

    // 切回默认方案：不应受到乙的任何影响
    await store.setCurrentScheme(DEFAULT_SCHEME_ID)
    check('默认方案活跃关系仍为 2 条', store.activeRelations.value.length === 2)
    check('默认方案未出现 U1→U3', !findActive(DEFAULT_SCHEME_ID, 'U1', 'U3'))
    check('默认方案 U1→U2 仍活跃', !!findActive(DEFAULT_SCHEME_ID, 'U1', 'U2'))
    check('默认方案无同期关联', !store.activeRelations.value.some((r) => r.kind === 'contemporary'))
    check('默认方案撤销记录仍 1 条', store.schemeRetractions.value.length === 1)

    // 再切回方案乙：编辑都在
    await store.setCurrentScheme(bId)
    check('乙存在推断边 U1→U3', !!findActive(bId, 'U1', 'U3') && findActive(bId, 'U1', 'U3')?.source === 'inference')
    check('乙的 U1→U2 已撤回且存档', !findActive(bId, 'U1', 'U2') && store.schemeRetractions.value.some((x) => x.reason === '方案乙中重新判断'))
    check('乙存在同期关联 U2≈U3', !!findActive(bId, 'U2', 'U3', 'contemporary'))

    await simulateRefresh()
    check('刷新后当前方案恢复为乙', store.state.currentSchemeId === bId)
    check('刷新后乙的编辑仍在（推断边、同期、撤回）', !!findActive(bId, 'U1', 'U3') && !!findActive(bId, 'U2', 'U3', 'contemporary') && !findActive(bId, 'U1', 'U2'))
    check('刷新后默认方案仍不受影响', !findActive(DEFAULT_SCHEME_ID, 'U1', 'U3') && !!findActive(DEFAULT_SCHEME_ID, 'U1', 'U2'))
  }

  console.log('\n[3] 语义对比：传递闭包变化导致的新增/失效结论')
  {
    await store.clearAll(false)
    await store.addUnit('A', 'deposit', '')
    await store.addUnit('B', 'deposit', '')
    await store.addUnit('C', 'deposit', '')
    const [a, b, c] = [idOf('A'), idOf('B'), idOf('C')]
    await store.addRelation(draft(a, b, 'earlier'))
    await store.addRelation(draft(b, c, 'earlier'))
    check('清空后首次添加关系自动创建默认方案', store.state.schemes.length === 1 && store.state.currentSchemeId === DEFAULT_SCHEME_ID)

    // 乙：撤回桥接边 B→C。直接边只差 B→C，但闭包还失去传递结论 A→C
    await store.deriveScheme('去掉BC')
    const p2 = store.state.currentSchemeId!
    await store.retractRelation(findActive(p2, b, c)!.id, '去掉桥接边')
    const cmp = compareSchemes(relsOf(DEFAULT_SCHEME_ID), relsOf(p2))
    check('直接边差异：仅默认方案多 B→C 一条', cmp.directOnlyA.length === 1 && cmp.directOnlyA[0].from === b && cmp.directOnlyA[0].to === c && cmp.directOnlyB.length === 0)
    check('标出失效的纯传递结论 A→C', cmp.closureOnlyA.some((p) => p.from === a && p.to === c && !p.direct))
    check('B→C 在闭包差异中标为直接边', cmp.closureOnlyA.some((p) => p.from === b && p.to === c && p.direct))
    check('反向闭包差异为空', cmp.closureOnlyB.length === 0)
    check('闭包不一致被明确标出', !cmp.closureSame)

    // 丙：新增冗余边 A→C。直接边有差异，但先后结论（闭包）完全一致
    await store.setCurrentScheme(DEFAULT_SCHEME_ID)
    await store.deriveScheme('加冗余边')
    const p3 = store.state.currentSchemeId!
    await store.addRelation(draft(a, c, 'earlier', 'inference'))
    const cmp2 = compareSchemes(relsOf(DEFAULT_SCHEME_ID), relsOf(p3))
    check('冗余边场景：直接边差异仅 A→C', cmp2.directOnlyB.length === 1 && cmp2.directOnlyA.length === 0)
    check('冗余边场景：闭包一致，不误报先后结论差异', cmp2.closureSame && cmp2.closureOnlyA.length === 0 && cmp2.closureOnlyB.length === 0)

    // 同一方案自身对比：完全一致
    const cmp3 = compareSchemes(relsOf(DEFAULT_SCHEME_ID), relsOf(DEFAULT_SCHEME_ID))
    check('同一方案对比：直接边与闭包均一致', cmp3.directOnlyA.length === 0 && cmp3.directOnlyB.length === 0 && cmp3.closureSame)
  }

  console.log('\n[4] 成环冲突方案可保存，冲突只属于该方案')
  {
    await store.setCurrentScheme(DEFAULT_SCHEME_ID)
    const [a, b, c] = [idOf('A'), idOf('B'), idOf('C')]
    await store.deriveScheme('冲突方案')
    const p4 = store.state.currentSchemeId!
    await store.addRelation(draft(c, a, 'earlier'))
    check('成环被挂起并要求确认', store.state.pendingCycle !== null)
    await store.confirmCycle()
    const conflict = store.state.relations.find((r) => r.schemeId === p4 && r.from === c && r.to === a)
    check('成环关系保存为活跃矛盾记录', !!conflict && conflict.status === 'active' && conflict.conflict === true)
    check('矛盾记录已落盘', (await db.relations.get(conflict!.id))?.conflict === true)
    check('默认方案无任何矛盾记录', !store.state.relations.some((r) => r.schemeId === DEFAULT_SCHEME_ID && r.conflict))
    const defPairs = relPairs(relsOf(DEFAULT_SCHEME_ID))
    check('默认方案闭包不含成环结论 C→A', !defPairs.includes(`${c}→${a}`))
    const p4Pairs = relPairs(relsOf(p4))
    check('冲突方案闭包含成环结论 C→A', p4Pairs.includes(`${c}→${a}`))
    await simulateRefresh()
    check('刷新后矛盾记录仍在且只属于冲突方案',
      store.state.relations.some((r) => r.schemeId === p4 && r.conflict) &&
      !store.state.relations.some((r) => r.schemeId === DEFAULT_SCHEME_ID && r.conflict))
  }

  console.log('\n[5] 切换 / 删除来源方案 / 刷新后数据一致')
  {
    const p4 = store.state.schemes.find((s) => s.name === '冲突方案')!.id
    await store.deriveScheme('孙方案')
    const p5 = store.state.currentSchemeId!
    const p5Count = relsOf(p5).length
    const p5Retractions = store.state.retractions.filter((x) => x.schemeId === p5).length
    check('孙方案来源为冲突方案', store.state.schemes.find((s) => s.id === p5)?.sourceSchemeId === p4)

    await store.deleteScheme(p4) // 删除的是来源方案，不是当前方案
    check('来源方案已删除', !store.state.schemes.some((s) => s.id === p4))
    check('已派生方案关系完整未受影响', relsOf(p5).length === p5Count)
    check('已派生方案撤销记录完整未受影响', store.state.retractions.filter((x) => x.schemeId === p5).length === p5Retractions)
    const p5row = store.state.schemes.find((s) => s.id === p5)!
    check('悬空来源引用保留（id + 名称快照）', p5row.sourceSchemeId === p4 && p5row.sourceSchemeName === '冲突方案')
    await store.setCurrentScheme(p5)
    check('已派生方案仍可正常切换', store.state.currentSchemeId === p5)

    await store.deleteScheme(p5) // 删除当前方案
    check('删除当前方案后回退到默认方案', store.state.currentSchemeId === DEFAULT_SCHEME_ID)

    await simulateRefresh()
    check('刷新后方案列表一致（已删方案不复活）',
      store.state.schemes.length === 3 &&
      !store.state.schemes.some((s) => s.id === p4 || s.id === p5))

    const p2 = store.state.schemes.find((s) => s.name === '去掉BC')!.id
    const p3 = store.state.schemes.find((s) => s.name === '加冗余边')!.id
    await store.deleteScheme(p2)
    await store.deleteScheme(p3)
    check('删除到仅剩一个方案', store.state.schemes.length === 1)
    await store.deleteScheme(DEFAULT_SCHEME_ID)
    check('最后一个方案不可删除', store.state.schemes.length === 1 && store.state.toast.includes('至少保留一个方案'))
  }

  console.log('\n[6] 导入旧版工程 JSON → 自动生成默认方案并保留原关系与撤回记录')
  {
    const now = Date.now()
    const legacyRelations = [
      { id: 'J1', from: 'N1', to: 'N2', kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: now },
      { id: 'J2', from: 'N2', to: 'N3', kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: now + 1 },
      { id: 'J3', from: 'N1', to: 'N3', kind: 'earlier', source: 'inference', status: 'retracted', conflict: false, evidenceIds: [], note: '', createdAt: now + 2 },
    ]
    const legacyJson = {
      app: 'harris-matrix-workbench',
      version: 1,
      exportedAt: new Date().toISOString(),
      units: [
        { id: 'N1', label: 'N1', type: 'deposit', note: '', createdAt: now },
        { id: 'N2', label: 'N2', type: 'deposit', note: '', createdAt: now },
        { id: 'N3', label: 'N3', type: 'deposit', note: '', createdAt: now },
      ],
      positions: [],
      relations: legacyRelations,
      evidences: [],
      retractions: [
        { id: 'JX1', relationId: 'J3', snapshot: { ...legacyRelations[2], status: 'active' }, reason: '旧工程撤回', at: now + 3 },
      ],
      partialOrder: ['N1→N2', 'N2→N3', 'N1→N3'],
    }
    await store.importProject(new File([JSON.stringify(legacyJson)], 'legacy.json', { type: 'application/json' }))

    check('旧工程导入后自动生成默认方案', store.state.schemes.length === 1 && store.state.schemes[0].id === DEFAULT_SCHEME_ID)
    check('当前方案为默认方案', store.state.currentSchemeId === DEFAULT_SCHEME_ID)
    check('原关系全部保留并归属默认方案',
      store.state.relations.length === 3 && store.state.relations.every((r) => r.schemeId === DEFAULT_SCHEME_ID))
    check('原撤回记录保留',
      store.state.retractions.length === 1 &&
      store.state.retractions[0].reason === '旧工程撤回' &&
      store.state.retractions[0].schemeId === DEFAULT_SCHEME_ID)
    check('偏序校验一致', store.state.toast.includes('偏序校验一致'))
  }

  console.log('\n[7] v2 导出 → 导入往返')
  {
    await store.deriveScheme('方案二')
    const s2 = store.state.currentSchemeId!
    await store.addRelation(draft('N3', 'N1', 'contemporary'))
    const exported = store.buildExportData()
    check('导出版本 2，携带方案与当前选择', exported.version === 2 && exported.schemes?.length === 2 && exported.currentSchemeId === s2)
    check('导出携带各方案独立关系',
      exported.relations.some((r) => r.schemeId === DEFAULT_SCHEME_ID && r.id === 'J1') &&
      exported.relations.some((r) => r.schemeId === s2 && r.kind === 'contemporary'))

    await store.clearAll(false)
    check('已清空全部方案', store.state.schemes.length === 0)
    await store.importProject(new File([JSON.stringify(exported)], 'v2.json', { type: 'application/json' }))

    check('方案全部恢复', store.state.schemes.length === 2 && store.state.schemes.some((s) => s.name === '方案二'))
    check('当前选择恢复', store.state.currentSchemeId === s2)
    check('方案二关系恢复（含同期）', store.state.relations.some((r) => r.schemeId === s2 && r.kind === 'contemporary' && r.status === 'active'))
    check('默认方案无方案二的同期关联', !store.state.relations.some((r) => r.schemeId === DEFAULT_SCHEME_ID && r.kind === 'contemporary'))
    check('来源引用恢复', store.state.schemes.find((s) => s.id === s2)?.sourceSchemeId === DEFAULT_SCHEME_ID)
  }

  console.log('\n[8] 撤销机制与方案操作兼容')
  {
    const s2 = store.state.schemes.find((s) => s.name === '方案二')!.id
    await store.setCurrentScheme(s2)
    await store.addRelation(draft('N1', 'N3', 'earlier', 'inference'))
    check('方案二新增推断边 N1→N3', !!findActive(s2, 'N1', 'N3'))
    await store.undo()
    check('撤销：新增的关系从方案二移除', !findActive(s2, 'N1', 'N3'))
    check('撤销不影响默认方案', !!findActive(DEFAULT_SCHEME_ID, 'N1', 'N2'))

    const countBefore = store.state.schemes.length
    await store.deriveScheme('临时方案')
    check('临时方案已派生', store.state.schemes.length === countBefore + 1)
    await store.undo()
    check('撤销派生：方案与其副本一并移除', store.state.schemes.length === countBefore)
    check('撤销派生后当前方案回退到有效方案', store.state.currentSchemeId === DEFAULT_SCHEME_ID)
  }

  console.log('\n[9] 示例工程载入默认方案并可派生分支')
  {
    await store.loadSample()
    check('示例载入后存在默认方案', store.state.schemes.length === 1 && store.state.schemes[0].id === DEFAULT_SCHEME_ID)
    check('示例关系全部归属默认方案', store.state.relations.length > 0 && store.state.relations.every((r) => r.schemeId === DEFAULT_SCHEME_ID))
    check('示例含矛盾记录与已撤销判断', store.state.relations.some((r) => r.conflict) && store.schemeRetractions.value.length === 1)
    const activeBefore = store.activeRelations.value.length

    await store.deriveScheme('示例分支')
    const br = store.state.currentSchemeId!
    const target = store.activeRelations.value.find((r) => r.kind === 'earlier' && !r.conflict)!
    await store.retractRelation(target.id, '分支内撤回')
    check('分支内撤回生效', store.activeRelations.value.length === activeBefore - 1)
    check('示例默认方案不受影响', relsOf(DEFAULT_SCHEME_ID).filter((r) => r.status === 'active').length === activeBefore)
    const cmp = compareSchemes(relsOf(DEFAULT_SCHEME_ID), relsOf(br))
    check(
      '示例与分支可语义对比（按语义键匹配，与关系 id 无关）',
      cmp.directOnlyA.length === 1 && cmp.directOnlyA[0].from === target.from && cmp.directOnlyA[0].to === target.to,
    )
  }

  console.log(`\n${failures === 0 ? `全部通过（${checks} 项检查）` : `${failures}/${checks} 项检查失败`}`)
  ;(globalThis as { process?: { exit?: (code: number) => void } }).process?.exit?.(failures ? 1 : 0)
}

void main()
