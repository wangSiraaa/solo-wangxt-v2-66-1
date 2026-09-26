/**
 * 验收测试在 Node 中运行（fake-indexeddb 内存库），测试引导见 ./setup.ts。
 */
import './setup'
import { IDBFactory } from 'fake-indexeddb'
import assert from 'node:assert/strict'
import { queuePrompt } from './setup'

let passed = 0
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(e)
    process.exitCode = 1
  }
}

/* ================= 场景 1-4：新库（v2）完整流程 ================= */

async function main() {
  const store = await import('../src/store')
  const dbModule = await import('../src/db')
  const diffModule = await import('../src/diff')

  /** 把 db 单例切换到全新的内存 indexedDB 工厂（用于独立测试 v1→v2 升级） */
  function swapDBFactory() {
    const factory = new IDBFactory()
    // Dexie 实例在构造时捕获 _deps；替换实例依赖才能让已存在的单例指向新库
    ;(dbModule.db as unknown as { _deps: { indexedDB: IDBFactory } })._deps.indexedDB = factory
    return factory
  }

  await test('载入示例工程后存在默认方案', async () => {
    await store.loadSample()
    assert.equal(store.state.schemes.length, 1)
    assert.equal(store.state.schemes[0].id, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.currentSchemeId, dbModule.DEFAULT_SCHEME_ID)
    // 示例：11 条关系（10 活跃，其中 1 条矛盾；另 1 条已撤回）
    assert.equal(store.state.relations.length, 11)
    assert.equal(store.state.retractions.length, 1)
    assert.ok(store.state.relations.every((r) => r.schemeId === dbModule.DEFAULT_SCHEME_ID))
  })

  let branchId = ''
  let branchBId = ''

  await test('从默认方案派生两个命名方案，关系为独立副本且保留 originId', async () => {
    branchId = (await store.branchScheme('乙记录员意见'))!
    assert.ok(branchId)
    assert.equal(store.state.currentSchemeId, branchId, '派生后应自动切换到新方案')
    const scheme = store.state.schemes.find((s) => s.id === branchId)!
    assert.equal(scheme.derivedFrom, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.relations.length, 11)
    assert.equal(store.state.retractions.length, 1, '撤回记录应随方案复制')
    assert.ok(store.state.relations.every((r) => r.schemeId === branchId))
    assert.ok(store.state.relations.every((r) => r.originId !== null), '派生关系应保留 originId 血缘')
    // 撤回快照中的关系 id 与新关系 id 对齐
    const x = store.state.retractions[0]
    assert.ok(store.state.relations.some((r) => r.id === x.relationId))
    assert.equal(x.snapshot.schemeId, branchId)

    branchBId = (await store.branchScheme('剖面复核版'))!
    assert.ok(branchBId && branchBId !== branchId)
  })

  const isolated = '1018' // 示例中的孤立层位
  const other = '1003'

  await test('在派生方案中独立增删关系，不影响默认方案（互不串扰）', async () => {
    // 当前在 branchB：新增 1018 早于 1003（孤立层位挂上去，不成环）
    await store.addRelation({
      from: isolated,
      to: other,
      kind: 'earlier',
      source: 'inference',
      evidenceIds: [],
      note: 'B 方案独有推断',
    })
    assert.equal(store.state.relations.filter((r) => r.status === 'active').length, 11)

    // 撤回一条：1003→1001
    const edge = store.state.relations.find((r) => r.from === '1003' && r.to === '1001' && r.status === 'active')!
    queuePrompt('B 方案撤回理由')
    await store.retractRelation(edge.id, 'B 方案撤回理由')
    assert.equal(store.state.retractions.length, 2)
    assert.equal(store.state.relations.find((r) => r.id === edge.id)!.status, 'retracted')

    // 新增一条同期关联
    await store.addRelation({
      from: '1018',
      to: '1015',
      kind: 'contemporary',
      source: 'observation',
      evidenceIds: [],
      note: '',
    })

    // 切回 branchId 方案：不应看到 B 的任何改动
    await store.switchScheme(branchId)
    assert.equal(store.state.relations.length, 11, '分支 A 关系数不变')
    const stillThere = store.state.relations.find((r) => r.from === '1003' && r.to === '1001')!
    assert.equal(stillThere.status, 'active')
    assert.ok(!store.state.relations.some((r) => r.from === '1018' && r.to === '1003'))
    assert.ok(!store.state.relations.some((r) => r.kind === 'contemporary' && r.from === '1018'))
    assert.equal(store.state.retractions.length, 1, '分支 A 撤回记录不变')

    // 默认方案也不受影响
    await store.switchScheme(dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.relations.length, 11)
    assert.equal(store.state.retractions.length, 1)
  })

  await test('闭包差异：B 撤回 1003→1001 后，多个传递结论失效', async () => {
    const relsDefault = await store.loadRelationsOfScheme(dbModule.DEFAULT_SCHEME_ID)
    const relsB = await store.loadRelationsOfScheme(branchBId)
    const diff = diffModule.computeSchemeDiff(dbModule.DEFAULT_SCHEME_ID, branchBId, relsDefault, relsB)

    // 直接边差异：1003→1001 仅默认方案活跃
    const missingEdge = diff.orderDiffs.find((d) => d.change === 'missing' && d.from === '1003' && d.to === '1001')
    assert.ok(missingEdge, '应标出直接边 1003→1001 仅 A 有')

    // 闭包失效结论：所有需要经过 1003→1001 才能到达 1001 的对，如 1007→1001
    const lostPairs = new Set(diff.closureRemoved.map((c) => `${c.from}→${c.to}`))
    assert.ok(lostPairs.has('1007→1001'), '1007 早于 1001 的传递结论应失效')
    assert.ok(lostPairs.has('1005→1001'), '1005 早于 1001 的传递结论应失效')
    // B 新增：1018→1003 是直接新边；由于 1003 在 B 中不再到 1001，1018 仅推出到 1003
    const gainedPairs = new Set(diff.closureAdded.map((c) => `${c.from}→${c.to}`))
    assert.ok(gainedPairs.has('1018→1003'))
    assert.ok(!gainedPairs.has('1018→1001'), '1003→1001 已撤回，1018→1001 不应成为 B 的结论')
    // 同期差异
    assert.ok(diff.contemporaryAdded.some((p) => p.from === '1018' && p.to === '1015'))

    // 撤回状态不同被单列（相同记录 originId 对齐）
    assert.ok(
      diff.onlyStatusDifferences.some((d) => d.from === '1003' && d.to === '1001'),
      '1003→1001 应出现在撤回状态差异中',
    )
  })

  await test('直接边相同但闭包不同的防御判定与撤回状态提示', async () => {
    // 图的闭包完全由活跃边集合决定：活跃直接边相同则闭包必相同。
    // 两方案真正的“直接记录相同却结论不同”只能来自同记录撤回状态差异（撤回即删活跃边）。
    const mk = (id: string, status: 'active' | 'retracted', from = 'a', to = 'b') => ({
      id,
      schemeId: 'sA',
      originId: id,
      from,
      to,
      kind: 'earlier' as const,
      source: 'observation' as const,
      status,
      conflict: false,
      evidenceIds: [],
      note: '',
      createdAt: 1,
    })
    const relsA = [mk('r1', 'active'), mk('r2', 'retracted', 'b', 'c')]
    const relsB = [{ ...mk('r1', 'retracted') }, { ...mk('r2', 'retracted', 'b', 'c') }]
    const diff = diffModule.computeSchemeDiff('sA', 'sB', relsA, relsB)
    assert.ok(diff.onlyStatusDifferences.some((d) => d.from === 'a' && d.to === 'b'))
    assert.ok(diff.closureRemoved.some((c) => c.from === 'a' && c.to === 'b'))

    const identical = diffModule.computeSchemeDiff('sA', 'sB', relsA, relsA.map((r) => ({ ...r, schemeId: 'sB' })))
    assert.equal(identical.orderDiffs.length, 0)
    assert.equal(identical.closureAdded.length + identical.closureRemoved.length, 0)
    assert.equal(identical.onlyStatusDifferences.length, 0)
  })

  await test('成环冲突方案可保存，且冲突只属于该方案', async () => {
    // 现有链：1012→1010→1009→1003→1001。加 1001→1012 直接成环。
    await store.switchScheme(branchId)
    const draft = { from: '1001', to: '1012', kind: 'earlier' as const, source: 'observation' as const, evidenceIds: [] as string[], note: '环' }
    await store.addRelation(draft)
    assert.ok(store.state.pendingCycle, '应检测到环并挂起确认')
    assert.deepEqual(store.state.pendingCycle!.path[0], '1001')
    assert.deepEqual(store.state.pendingCycle!.path.at(-1), '1001')
    await store.confirmCycle()
    const conflictRel = store.state.relations.find((r) => r.from === '1001' && r.to === '1012')!
    assert.equal(conflictRel.status, 'active')
    assert.equal(conflictRel.conflict, true, '保留为矛盾记录应打冲突标记')

    // 默认方案与 B 方案都没有这条边，也没有冲突
    const defRels = await store.loadRelationsOfScheme(dbModule.DEFAULT_SCHEME_ID)
    assert.ok(!defRels.some((r) => r.from === '1001' && r.to === '1012'))
    const bRels = await store.loadRelationsOfScheme(branchBId)
    assert.ok(!bRels.some((r) => r.from === '1001' && r.to === '1012'))
    // 默认方案中原有矛盾记录（1009→1012）的冲突标记不受 A 方案影响
    assert.ok(defRels.some((r) => r.from === '1009' && r.to === '1012' && r.conflict === true))
  })

  await test('刷新（重新从 IndexedDB 载入）后恢复当前方案与比较选择', async () => {
    await store.refresh()
    assert.equal(store.state.currentSchemeId, branchId)
    assert.equal(store.state.schemes.length, 3)
    assert.ok(store.state.relations.some((r) => r.from === '1001' && r.to === '1012' && r.conflict))
    // 比较选择持久化
    await store.openCompare(dbModule.DEFAULT_SCHEME_ID, branchBId)
    assert.equal(store.state.compareOpen, true)
    await store.refresh()
    assert.equal(store.state.compareAId, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.compareBId, branchBId)
    // compareOpen 是纯视图状态（不持久化）；刷新页面后初始为 false，比较选择可一键重开
    assert.ok(store.state.compareAId && store.state.compareBId)
  })

  await test('比较视图只读：定位不改写任何方案', async () => {
    await store.openCompare(dbModule.DEFAULT_SCHEME_ID, branchBId)
    const before = JSON.stringify(await store.loadRelationsOfScheme(dbModule.DEFAULT_SCHEME_ID))
    const beforeB = JSON.stringify(await store.loadRelationsOfScheme(branchBId))
    store.locateInCompare('1007')
    assert.equal(store.state.selectedUnitId, '1007')
    assert.equal(JSON.stringify(await store.loadRelationsOfScheme(dbModule.DEFAULT_SCHEME_ID)), before)
    assert.equal(JSON.stringify(await store.loadRelationsOfScheme(branchBId)), beforeB)
    store.closeCompare()
  })

  await test('删除来源方案不破坏已派生方案；当前选择自动跳转', async () => {
    // branchId / branchBId 均派生自默认方案；删除默认方案
    await store.switchScheme(dbModule.DEFAULT_SCHEME_ID)
    await store.deleteScheme(dbModule.DEFAULT_SCHEME_ID)
    assert.ok(!store.state.schemes.some((s) => s.id === dbModule.DEFAULT_SCHEME_ID))
    assert.notEqual(store.state.currentSchemeId, dbModule.DEFAULT_SCHEME_ID)
    // 派生方案仍在，derivedFrom 保留为悬空历史引用，数据完好
    const a = store.state.schemes.find((s) => s.id === branchId)!
    assert.equal(a.derivedFrom, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.schemeName(a.derivedFrom), '（来源方案已删除）')
    const relsA = await store.loadRelationsOfScheme(branchId)
    assert.equal(relsA.length, 12, 'A 方案 11 + 1 条矛盾边')
    assert.ok(relsA.some((r) => r.conflict && r.from === '1001' && r.to === '1012'))
    const relsB = await store.loadRelationsOfScheme(branchBId)
    assert.equal(relsB.length, 13, 'B 方案 11 + 独有先后边 + 同期（撤回不改条数）')
    // 已删方案的关系/撤回确实清空
    const orphanRels = await dbModule.db.relations.where('schemeId').equals(dbModule.DEFAULT_SCHEME_ID).count()
    assert.equal(orphanRels, 0)
    // 删除当前正在编辑的方案时也能自动跳转
    await store.switchScheme(branchBId)
    await store.deleteScheme(branchBId)
    assert.equal(store.state.currentSchemeId, branchId)
    assert.equal(store.state.schemes.length, 1)
  })

  await test('撤销在正确方案内生效（批次隔离）', async () => {
    const beforeCount = await dbModule.db.relations
      .where('schemeId')
      .equals(branchId)
      .filter((r) => r.from === '1001' && r.to === '1012')
      .count()
    assert.ok(beforeCount >= 1)
    await store.undo()
    const afterCount = await dbModule.db.relations
      .where('schemeId')
      .equals(branchId)
      .filter((r) => r.from === '1001' && r.to === '1012')
      .count()
    assert.equal(afterCount, 0, '撤销应移除本方案矛盾边')
  })

  /* ================= 场景 5：导入旧版 v1 工程（通过导入路径迁移） ================= */

  const legacyData = {
    app: 'harris-matrix-workbench',
    version: 1,
    exportedAt: new Date().toISOString(),
    units: [{ id: 'u1', label: '2001', type: 'deposit', note: '', createdAt: 1 }],
    positions: [],
    relations: [
      { id: 'old-r1', from: 'u1', to: 'u2', kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '旧观察', createdAt: 1 },
      { id: 'old-r2', from: 'u2', to: 'u3', kind: 'earlier', source: 'inference', status: 'retracted', conflict: false, evidenceIds: [], note: '旧推断', createdAt: 2 },
      { id: 'old-r3', from: 'u1', to: 'u3', kind: 'contemporary', source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: 3 },
    ],
    evidences: [],
    retractions: [
      { id: 'old-x1', relationId: 'old-r2', snapshot: { id: 'old-r2', from: 'u2', to: 'u3', kind: 'earlier', source: 'inference', status: 'active', conflict: false, evidenceIds: [], note: '旧推断', createdAt: 2 }, reason: '旧撤回理由', at: 9 },
    ],
    partialOrder: ['u1→u2'],
  }

  await test('导入旧版 v1 工程：自动生成默认方案并保留原关系与撤回记录', async () => {
    const file = { text: async () => JSON.stringify(legacyData) } as unknown as File
    await store.importProject(file)
    assert.equal(store.state.schemes.length, 1)
    assert.equal(store.state.schemes[0].id, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.schemes[0].name, dbModule.DEFAULT_SCHEME_NAME)
    assert.equal(store.state.currentSchemeId, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.relations.length, 3)
    assert.ok(store.state.relations.every((r) => r.schemeId === dbModule.DEFAULT_SCHEME_ID))
    assert.deepEqual(
      store.state.relations.map((r) => [r.id, r.status, r.note]).sort(),
      [
        ['old-r1', 'active', '旧观察'],
        ['old-r2', 'retracted', '旧推断'],
        ['old-r3', 'active', ''],
      ].sort(),
    )
    assert.equal(store.state.retractions.length, 1)
    const x = store.state.retractions[0]
    assert.equal(x.id, 'old-x1')
    assert.equal(x.reason, '旧撤回理由')
    assert.equal(x.snapshot.schemeId, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(x.snapshot.status, 'active', '快照保留撤回前的原始状态')
    // 闭包按迁移后的活跃边重算，与旧文件 partialOrder 一致
    const c = diffModule.closureConclusions(store.state.relations)
    assert.deepEqual([...c.keys()], ['u1→u2'])
  })

  /* ================= 场景 5b：v2 多方案导出再导入（往返一致） ================= */

  await test('v2 导出往返：全部方案、撤回记录与批次完整恢复', async () => {
    // 重新建一个含两个分支的工程
    await store.clearAll(false)
    await store.loadSample()
    const b2 = (await store.branchScheme('往返分支'))!
    await store.addRelation({ from: '1018', to: '1001', kind: 'earlier', source: 'inference', evidenceIds: [], note: '往返独有' })
    await store.switchScheme(dbModule.DEFAULT_SCHEME_ID)

    const captured: { blob: Blob | null } = { blob: null }
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = (blob: Blob) => {
      captured.blob = blob
      return 'blob:test'
    }
    URL.revokeObjectURL = () => {}
    await store.exportProject()
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevoke
    assert.ok(captured.blob)
    const parsed = JSON.parse(await captured.blob.text())
    assert.equal(parsed.version, 2)
    assert.equal(parsed.schemes.length, 2)
    assert.ok(parsed.relations.some((r: { note: string }) => r.note === '往返独有'))
    assert.equal(parsed.currentSchemeId, dbModule.DEFAULT_SCHEME_ID)

    // 清空再导入，两个方案都应恢复
    await store.importProject({ text: async () => await captured.blob!.text() } as unknown as File)
    assert.equal(store.state.schemes.length, 2)
    assert.equal(store.state.currentSchemeId, dbModule.DEFAULT_SCHEME_ID, '当前选择恢复')
    const b2Rels = await store.loadRelationsOfScheme(b2)
    assert.ok(b2Rels.some((r) => r.note === '往返独有'))
    assert.equal(b2Rels.length, 12)
    const branchScheme = store.state.schemes.find((s) => s.id === b2)!
    assert.equal(branchScheme.derivedFrom, dbModule.DEFAULT_SCHEME_ID, '来源引用恢复')
    // 默认方案撤回记录恢复
    assert.equal(store.state.retractions.length, 1)
    // 批次恢复（示例批次等）
    assert.ok(store.state.batches.length >= 1)
  })

  /* ================= 场景 6：IndexedDB v1→v2 自动升级（全新内存库） ================= */

  await test('旧版数据库首次加载经 Dexie upgrade 无损迁移', async () => {
    await dbModule.db.close()
    const factory = swapDBFactory()

    // 用 v1 结构手工建库并写入旧数据
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('harris-matrix', 1)
      req.onupgradeneeded = () => {
        const idb = req.result
        idb.createObjectStore('units', { keyPath: 'id' })
        idb.createObjectStore('positions', { keyPath: 'unitId' })
        idb.createObjectStore('relations', { keyPath: 'id' })
        idb.createObjectStore('evidences', { keyPath: 'id' })
        idb.createObjectStore('retractions', { keyPath: 'id' })
        idb.createObjectStore('batches', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const idb = req.result
        const tx = idb.transaction(['relations', 'retractions', 'batches'], 'readwrite')
        tx.objectStore('relations').put({
          id: 'v1r1', from: 'a', to: 'b', kind: 'earlier', source: 'observation',
          status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: 1,
        })
        tx.objectStore('retractions').put({
          id: 'v1x1', relationId: 'v1r1',
          snapshot: { id: 'v1r1', from: 'a', to: 'b', kind: 'earlier', source: 'observation', status: 'active', conflict: false, evidenceIds: [], note: '', createdAt: 1 },
          reason: '迁移前撤回', at: 2,
        })
        tx.objectStore('batches').put({ id: 'v1b1', label: '旧批次', at: 1, undone: false, mutations: [] })
        tx.oncomplete = () => {
          idb.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    // db.close() 后 Dexie 不会自动重开；显式 open() 触发 v1→v2 upgrade，再 refresh 载入
    await dbModule.db.open()
    await store.refresh()
    assert.equal(store.state.schemes.length, 1)
    assert.equal(store.state.schemes[0].id, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.currentSchemeId, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.relations.length, 1)
    assert.equal(store.state.relations[0].schemeId, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.relations[0].originId, null)
    assert.equal(store.state.retractions.length, 1)
    assert.equal(store.state.retractions[0].schemeId, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.retractions[0].snapshot.schemeId, dbModule.DEFAULT_SCHEME_ID)
    assert.equal(store.state.batches.length, 1)
    assert.equal(store.state.batches[0].id, 'v1b1')
    assert.equal(store.state.batches[0].schemeId, null, '旧批次标记为全局批次')
  })

  console.log(`\n${passed} 个验收测试通过`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
