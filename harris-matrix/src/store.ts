import { computed, reactive } from 'vue'
import { db, DEFAULT_SCHEME_ID, DEFAULT_SCHEME_NAME } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import { activeEarlierEdges, computeSchemeDiff } from './diff'
import { buildSample } from './sample'
import type {
  AppMeta,
  Batch,
  Evidence,
  LegacyProjectExport,
  Mutation,
  ProjectExport,
  Relation,
  RelationDraft,
  Retraction,
  Scheme,
  SchemeDiff,
  StratUnit,
  TableName,
  UnitPosition,
  UnitType,
} from './types'

export const state = reactive({
  loaded: false,
  units: [] as StratUnit[],
  positions: {} as Record<string, UnitPosition>,
  /** 全部解释方案 */
  schemes: [] as Scheme[],
  /** 当前方案的关系（切换方案时整体替换，各方案互不串扰） */
  relations: [] as Relation[],
  evidences: [] as Evidence[],
  /** 当前方案的撤销记录 */
  retractions: [] as Retraction[],
  /** 当前方案的批次 + 跨方案（schemeId=null）批次 */
  batches: [] as Batch[],
  currentSchemeId: DEFAULT_SCHEME_ID,
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 待确认的成环关系：记录员可选择保留为矛盾记录或取消 */
  pendingCycle: null as { draft: RelationDraft; path: string[] } | null,
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
  /** 比较视图状态（只读，不改写任何方案） */
  compareOpen: false,
  compareAId: null as string | null,
  compareBId: null as string | null,
  compareDiff: null as SchemeDiff | null,
  /** 定位信号：比较视图点击差异项时通知画布居中并闪烁层位（nonce 每次递增） */
  locateTarget: null as { unitId: string; nonce: number } | null,
})

/* ---------- 派生数据 ---------- */

export const currentScheme = computed(
  () => state.schemes.find((s) => s.id === state.currentSchemeId) ?? null,
)

export const activeRelations = computed(() => state.relations.filter((r) => r.status === 'active'))

/** 仅“早于”关系进入有向图；同期关联被明确排除 */
export const orderEdges = computed<OrderEdge[]>(() =>
  activeRelations.value.filter((r) => r.kind === 'earlier').map((r) => ({ id: r.id, from: r.from, to: r.to })),
)

/** 简化视图要隐藏的传递冗余边（只隐藏，不删除） */
export const redundantIds = computed(() => redundantEdges(orderEdges.value))

export const lastBatch = computed(() => {
  for (let i = state.batches.length - 1; i >= 0; i--) {
    if (!state.batches[i].undone) return state.batches[i]
  }
  return null
})

export function unitLabel(id: string): string {
  return state.units.find((u) => u.id === id)?.label ?? id
}

export function evidenceRef(id: string): string {
  return state.evidences.find((e) => e.id === id)?.ref ?? id
}

/* ---------- 基础工具 ---------- */

const uid = () => crypto.randomUUID()

let toastTimer = 0
export function toast(msg: string) {
  state.toast = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (state.toast = ''), 5000)
}

function tableOf(name: TableName) {
  return { units: db.units, positions: db.positions, relations: db.relations, evidences: db.evidences, retractions: db.retractions }[name]
}

/** 写入 IndexedDB 前去除 Vue 响应式代理（structuredClone 无法克隆 Proxy） */
function plain<T>(v: T): T {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}

async function applyForward(m: Mutation) {
  const t = tableOf(m.table)
  if (m.after == null) await t.delete(m.key)
  else await t.put(plain(m.after) as never)
}

async function applyInverse(m: Mutation) {
  const t = tableOf(m.table)
  if (m.before == null) await t.delete(m.key)
  else await t.put(plain(m.before) as never)
}

/** 新库首次启动：创建默认方案与元数据行（旧版库由 db v1→v2 upgrade 自动迁移，不走这里） */
async function ensureBootstrap() {
  const meta = await db.appmeta.get('app')
  if (meta) return
  const schemeCount = await db.schemes.count()
  if (schemeCount === 0) {
    await db.schemes.add({
      id: DEFAULT_SCHEME_ID,
      name: DEFAULT_SCHEME_NAME,
      derivedFrom: null,
      createdAt: Date.now(),
    })
  }
  const first = (await db.schemes.orderBy('createdAt').first()) ?? null
  await db.appmeta.put({
    key: 'app',
    currentSchemeId: first?.id ?? DEFAULT_SCHEME_ID,
    compareSchemeAId: null,
    compareSchemeBId: null,
  })
}

/** 仅载入当前方案相关数据；层位/证据/位置为全方案共享数据 */
export async function refresh() {
  await ensureBootstrap()
  const meta = (await db.appmeta.get('app')) as AppMeta
  const sid = meta.currentSchemeId
  const [units, positions, schemes, relations, evidences, retractions, allBatches] = await Promise.all([
    db.units.toArray(),
    db.positions.toArray(),
    db.schemes.orderBy('createdAt').toArray(),
    db.relations.where('schemeId').equals(sid).toArray(),
    db.evidences.toArray(),
    db.retractions.where('schemeId').equals(sid).toArray(),
    db.batches.toArray(),
  ])
  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.schemes = schemes
  state.currentSchemeId = sid
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  // IndexedDB 不索引 null 值，全局批次（schemeId=null）在 JS 中过滤
  state.batches = allBatches
    .filter((b) => b.schemeId === null || b.schemeId === sid)
    .sort((a, b) => a.at - b.at)
  state.compareAId = meta.compareSchemeAId
  state.compareBId = meta.compareSchemeBId
  state.loaded = true
}

/** 以批次执行一组变更：全部正向应用后登记批次，供整体撤销 */
async function runBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), schemeId: state.currentSchemeId, label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
}

/** 跨方案变更（层位、证据）使用全局批次，在各方案中均可撤销 */
async function runGlobalBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), schemeId: null, label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
}

/** 撤销最近一个未撤销的批次（当前方案或全局批次）：关系与证据引用随逆向变更一起恢复 */
export async function undo() {
  const batch = [...state.batches].reverse().find((b) => !b.undone)
  if (!batch) {
    toast('没有可撤销的操作')
    return
  }
  for (const m of [...batch.mutations].reverse()) await applyInverse(m)
  await db.batches.update(batch.id, { undone: true })
  await refresh()
  toast(`已撤销：${batch.label}`)
}

/* ---------- 解释方案分支 ---------- */

/** 从当前关系集创建命名方案：完整深拷贝关系（含撤回记录），新旧 id 解耦，删除来源不影响派生方案 */
export async function branchScheme(name: string): Promise<string | null> {
  name = name.trim()
  if (!name) return null
  const sid = state.currentSchemeId
  const now = Date.now()
  const scheme: Scheme = { id: uid(), name, derivedFrom: sid, createdAt: now }

  const idMap = new Map<string, string>()
  const clonedRels: Relation[] = state.relations.map((r) => {
    const newId = uid()
    idMap.set(r.id, newId)
    return { ...plain(r), id: newId, schemeId: scheme.id, originId: r.originId ?? r.id, createdAt: r.createdAt }
  })
  const clonedRetractions: Retraction[] = state.retractions.map((x) => {
    const newRelationId = idMap.get(x.relationId) ?? x.relationId
    return {
      ...plain(x),
      id: uid(),
      schemeId: scheme.id,
      relationId: newRelationId,
      snapshot: {
        ...plain(x.snapshot),
        id: newRelationId,
        schemeId: scheme.id,
        originId: x.snapshot.originId ?? x.snapshot.id,
      },
    }
  })

  await db.transaction('rw', [db.schemes, db.relations, db.retractions, db.appmeta], async () => {
    await db.schemes.add(plain(scheme))
    if (clonedRels.length) await db.relations.bulkPut(plain(clonedRels))
    if (clonedRetractions.length) await db.retractions.bulkPut(plain(clonedRetractions))
    await db.appmeta.update('app', { currentSchemeId: scheme.id })
  })
  await refresh()
  toast(`已从「${schemeName(sid)}」派生新方案「${name}」（${clonedRels.length} 条关系独立副本）`)
  return scheme.id
}

export async function renameScheme(id: string, name: string) {
  name = name.trim()
  if (!name) return
  await db.schemes.update(id, { name })
  await refresh()
}

export async function switchScheme(id: string) {
  if (id === state.currentSchemeId) return
  await db.appmeta.update('app', { currentSchemeId: id })
  state.pendingCycle = null
  state.selectedUnitId = null
  await refresh()
  toast(`已切换到方案「${schemeName(id)}」`)
}

/** 删除方案：仅删本方案自己的关系/撤销/批次；派生方案持有独立副本与 originId，不受影响 */
export async function deleteScheme(id: string) {
  if (state.schemes.length <= 1) {
    toast('至少保留一个方案')
    return
  }
  const scheme = state.schemes.find((s) => s.id === id)
  if (!scheme) return
  const fallbackId = state.schemes.find((s) => s.id !== id)?.id ?? null
  const derivedCount = state.schemes.filter((s) => s.derivedFrom === id).length
  if (
    !window.confirm(
      `删除方案「${scheme.name}」？该方案的关系、撤回记录将一并删除。` +
        (derivedCount > 0 ? `\n其 ${derivedCount} 个派生方案持有独立副本，不会被破坏，来源引用保留为历史记录。` : ''),
    )
  )
    return
  await db.transaction(
    'rw',
    [db.schemes, db.relations, db.retractions, db.batches, db.appmeta],
    async () => {
      await db.relations.where('schemeId').equals(id).delete()
      await db.retractions.where('schemeId').equals(id).delete()
      await db.batches.where('schemeId').equals(id).delete()
      await db.schemes.delete(id)
      const meta = (await db.appmeta.get('app')) as AppMeta
      const patch: Partial<AppMeta> = {}
      if (meta.currentSchemeId === id && fallbackId) patch.currentSchemeId = fallbackId
      if (meta.compareSchemeAId === id) patch.compareSchemeAId = null
      if (meta.compareSchemeBId === id) patch.compareSchemeBId = null
      if (Object.keys(patch).length) await db.appmeta.update('app', patch)
    },
  )
  state.compareOpen = false
  state.compareDiff = null
  await refresh()
  toast(`方案「${scheme.name}」已删除，派生方案数据完好`)
}

export function schemeName(id: string | null): string {
  if (!id) return '（无来源）'
  return state.schemes.find((s) => s.id === id)?.name ?? '（来源方案已删除）'
}

/* ---------- 方案语义对比（纯只读） ---------- */

export async function loadRelationsOfScheme(id: string): Promise<Relation[]> {
  return db.relations.where('schemeId').equals(id).toArray()
}

export async function openCompare(aId: string, bId: string) {
  const [relsA, relsB] = await Promise.all([loadRelationsOfScheme(aId), loadRelationsOfScheme(bId)])
  state.compareDiff = computeSchemeDiff(aId, bId, relsA, relsB)
  state.compareAId = aId
  state.compareBId = bId
  state.compareOpen = true
  await db.appmeta.update('app', { compareSchemeAId: aId, compareSchemeBId: bId })
}

export function closeCompare() {
  state.compareOpen = false
}

/** 比较视图点击差异项：只定位（选中）相关层位，绝不改写任何方案 */
export function locateInCompare(unitId: string) {
  state.selectedUnitId = unitId
  state.locateTarget = { unitId, nonce: Date.now() }
  toast(`已定位层位 ${unitLabel(unitId)}（比较视图只读，方案未被修改）`)
}

/* ---------- 层位（跨方案共享） ---------- */

export async function addUnit(label: string, type: UnitType, note: string) {
  label = label.trim()
  if (!label) return
  if (state.units.some((u) => u.label === label)) {
    toast(`层位 ${label} 已存在`)
    return
  }
  const unit: StratUnit = { id: uid(), label, type, note: note.trim(), createdAt: Date.now() }
  await runGlobalBatch(`新增层位 ${label}`, [{ table: 'units', key: unit.id, before: null, after: unit }])
  toast(`已新增层位 ${label}（各方案共享）`)
}

export async function deleteUnit(id: string) {
  const unit = state.units.find((u) => u.id === id)
  if (!unit) return
  const mutations: Mutation[] = [{ table: 'units', key: id, before: unit, after: null }]
  const pos = state.positions[id]
  if (pos) mutations.push({ table: 'positions', key: id, before: pos, after: null })
  // 仅连带删除当前方案中涉及该层位的关系；其他方案的解释独立保留，删除层位不破坏派生方案
  for (const r of state.relations.filter((r) => r.from === id || r.to === id)) {
    mutations.push({ table: 'relations', key: r.id, before: r, after: null })
    for (const x of state.retractions.filter((x) => x.relationId === r.id)) {
      mutations.push({ table: 'retractions', key: x.id, before: x, after: null })
    }
  }
  // 该批次同时改共享层位与当前方案关系，归入当前方案；其他方案引用悬空层位时画布仅不显示该点
  await runBatch(`删除层位 ${unit.label}（当前方案连带关系）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  toast(`已删除层位 ${unit.label}（仅影响当前方案的关系）`)
}

/* ---------- 证据（跨方案共享） ---------- */

export async function addEvidence(ref: string, text: string) {
  ref = ref.trim()
  if (!ref) return
  const ev: Evidence = { id: uid(), ref, text: text.trim(), createdAt: Date.now() }
  await runGlobalBatch(`登记证据 ${ref}`, [{ table: 'evidences', key: ev.id, before: null, after: ev }])
  toast(`已登记证据 ${ref}`)
}

/* ---------- 关系（仅当前方案） ---------- */

function makeRelation(draft: RelationDraft, conflict: boolean): Relation {
  return {
    id: uid(),
    schemeId: state.currentSchemeId,
    originId: null,
    from: draft.from,
    to: draft.to,
    kind: draft.kind,
    source: draft.source,
    status: 'active',
    conflict,
    evidenceIds: [...draft.evidenceIds],
    note: draft.note.trim(),
    createdAt: Date.now(),
  }
}

function describe(draft: RelationDraft): string {
  return draft.kind === 'earlier'
    ? `${unitLabel(draft.from)} 早于 ${unitLabel(draft.to)}`
    : `${unitLabel(draft.from)} 与 ${unitLabel(draft.to)} 同期`
}

/**
 * 新增关系。先后关系先做有向成环检测：若成环则挂起并给出完整环路径，
 * 由记录员决定保留为矛盾记录或取消。同期关联不进入有向图，直接保存。
 * 成环冲突只属于当前方案，其他方案（含来源/派生方案）不写入该边，自然无冲突。
 */
export async function addRelation(draft: RelationDraft, allowConflict = false) {
  if (!draft.from || !draft.to) return
  if (draft.kind === 'earlier' && draft.from === draft.to) {
    toast('层位不能早于其自身')
    return
  }
  const dup = activeRelations.value.some(
    (r) => r.from === draft.from && r.to === draft.to && r.kind === draft.kind,
  )
  if (dup) {
    toast('相同的关系已存在')
    return
  }

  if (draft.kind === 'contemporary') {
    // 同期关联：只存档，不作为有向边参与偏序
    const relation = makeRelation(draft, false)
    await runBatch(`新增同期关联：${describe(draft)}`, [
      { table: 'relations', key: relation.id, before: null, after: relation },
    ])
    toast('已保存同期关联（不进入有向图）')
    return
  }

  const cycle = cyclePathIfAdded(orderEdges.value, draft.from, draft.to)
  if (cycle && !allowConflict) {
    state.pendingCycle = { draft: { ...draft }, path: cycle }
    return
  }
  const relation = makeRelation(draft, cycle !== null)
  await runBatch(
    cycle ? `新增矛盾记录：${describe(draft)}` : `新增先后关系：${describe(draft)}`,
    [{ table: 'relations', key: relation.id, before: null, after: relation }],
  )
  toast(cycle ? '已保存为矛盾记录（成环路径见画布红边），冲突仅属于本方案' : '已添加先后关系')
}

/** 确认保留成环关系为矛盾记录 */
export async function confirmCycle() {
  const pending = state.pendingCycle
  if (!pending) return
  state.pendingCycle = null
  await addRelation(pending.draft, true)
}

export function cancelCycle() {
  state.pendingCycle = null
}

/** 撤回判断：关系标记为 retracted，快照与理由单独存入 retractions 表（仅当前方案） */
export async function retractRelation(id: string, reason: string) {
  const rel = state.relations.find((r) => r.id === id)
  if (!rel || rel.status !== 'active') return
  const retraction: Retraction = {
    id: uid(),
    schemeId: state.currentSchemeId,
    relationId: id,
    snapshot: { ...rel },
    reason: reason.trim() || '（未填写理由）',
    at: Date.now(),
  }
  await runBatch(`撤回判断：${unitLabel(rel.from)} → ${unitLabel(rel.to)}`, [
    { table: 'relations', key: id, before: rel, after: { ...rel, status: 'retracted' as const } },
    { table: 'retractions', key: retraction.id, before: null, after: retraction },
  ])
  toast('已撤回，判断与理由已单独存档')
}

/* ---------- 画布位置（与地层身份分离，不进入撤销批次） ---------- */

export async function savePosition(unitId: string, x: number, y: number) {
  const pos: UnitPosition = { unitId, x, y }
  await db.positions.put(pos)
  state.positions = { ...state.positions, [unitId]: pos }
}

/** 按最长路径分层自动排布（忽略成环边；位置全方案共享） */
export async function autoLayout() {
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  for (const [id, p] of auto) await db.positions.put({ unitId: id, x: p.x, y: p.y })
  await refresh()
  state.layoutVersion++
  toast('已按当前方案的地层早晚自动分层排布')
}

/* ---------- 示例 / 清空 / 导出 / 导入 ---------- */

export async function loadSample() {
  if (state.units.length > 0 && !window.confirm('载入示例将先清空当前工程（不可撤销），继续？')) return
  await clearAll(false)
  const now = Date.now()
  const sample = buildSample(now)
  const positions = layeredPositions(
    sample.units.map((u) => u.id),
    sample.relations.filter((r) => r.kind === 'earlier' && r.status === 'active'),
  )
  const sid = DEFAULT_SCHEME_ID
  const mutations: Mutation[] = []
  for (const u of sample.units) mutations.push({ table: 'units', key: u.id, before: null, after: u })
  for (const e of sample.evidences) mutations.push({ table: 'evidences', key: e.id, before: null, after: e })
  for (const r of sample.relations) {
    mutations.push({
      table: 'relations',
      key: r.id,
      before: null,
      after: { ...r, schemeId: sid, originId: null },
    })
  }
  for (const x of sample.retractions) {
    mutations.push({
      table: 'retractions',
      key: x.id,
      before: null,
      after: { ...x, schemeId: sid, snapshot: { ...x.snapshot, schemeId: sid, originId: null } },
    })
  }
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), schemeId: sid, label: '载入示例工程', at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await db.appmeta.update('app', { currentSchemeId: sid, compareSchemeAId: null, compareSchemeBId: null })
  await refresh()
  state.layoutVersion++
  toast('示例工程已载入（含切割事件、孤立层位、矛盾记录与已撤销判断）')
}

export async function clearAll(confirm = true) {
  if (confirm && !window.confirm('清空全部工程数据（含所有解释方案）？此操作不可撤销。')) return
  await db.transaction(
    'rw',
    [db.units, db.positions, db.schemes, db.relations, db.evidences, db.retractions, db.batches, db.appmeta],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.schemes.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.appmeta.clear(),
      ])
    },
  )
  state.compareOpen = false
  state.compareDiff = null
  state.selectedUnitId = null
  await refresh()
  if (confirm) toast('工程已清空')
}

export async function exportProject() {
  // 导出全部分支：直接从库中读取所有方案的关系/撤回/批次（state 仅持有当前方案数据）
  const [allRelations, allRetractions, allBatches] = await Promise.all([
    db.relations.toArray(),
    db.retractions.toArray(),
    db.batches.toArray(),
  ])
  const data: ProjectExport = {
    app: 'harris-matrix-workbench',
    version: 2,
    exportedAt: new Date().toISOString(),
    units: state.units,
    positions: Object.values(state.positions),
    schemes: state.schemes,
    currentSchemeId: state.currentSchemeId,
    relations: allRelations,
    evidences: state.evidences,
    retractions: allRetractions,
    batches: allBatches,
    // 偏序闭包随当前方案导出（用于导入后一致性校验）
    partialOrder: reachablePairs(orderEdges.value),
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast(
    `已导出全部 ${state.schemes.length} 个方案（${allRelations.length} 条关系；` +
      `当前方案偏序闭包 ${data.partialOrder.length} 个可达对）`,
  )
}

/** 将旧版 v1 单方案导出无损迁移为默认方案：原关系、撤回记录、批次全部保留 */
function migrateLegacy(data: LegacyProjectExport): {
  relations: Relation[]
  retractions: Retraction[]
  batches: Batch[]
  scheme: Scheme
} {
  const sid = DEFAULT_SCHEME_ID
  const scheme: Scheme = {
    id: sid,
    name: DEFAULT_SCHEME_NAME,
    derivedFrom: null,
    createdAt: Date.now(),
  }
  const relations: Relation[] = (data.relations ?? []).map((r) => ({
    ...r,
    schemeId: sid,
    originId: null,
  }))
  const retractions: Retraction[] = (data.retractions ?? []).map((x) => ({
    ...x,
    schemeId: sid,
    snapshot: { ...x.snapshot, schemeId: sid, originId: null },
  }))
  // 旧版无批次表数据可导出；撤回记录本身已完整保留
  const batches: Batch[] = []
  return { relations, retractions, batches, scheme }
}

export async function importProject(file: File) {
  let data: ProjectExport | LegacyProjectExport
  try {
    data = JSON.parse(await file.text())
  } catch {
    toast('导入失败：不是有效的 JSON 文件')
    return
  }
  if (data?.app !== 'harris-matrix-workbench' || !Array.isArray(data.units) || !Array.isArray(data.relations)) {
    toast('导入失败：文件格式不符')
    return
  }
  if (!window.confirm('导入将替换当前工程（不可撤销），继续？')) return

  const isLegacy = (data as ProjectExport).version !== 2 || !Array.isArray((data as ProjectExport).schemes)
  let schemes: Scheme[]
  let relations: Relation[]
  let retractions: Retraction[]
  let batches: Batch[]
  let currentSchemeId: string

  if (isLegacy) {
    // 旧工程：无损迁移为默认方案
    const mig = migrateLegacy(data as LegacyProjectExport)
    schemes = [mig.scheme]
    relations = mig.relations
    retractions = mig.retractions
    batches = mig.batches
    currentSchemeId = mig.scheme.id
  } else {
    const d2 = data as ProjectExport
    schemes = d2.schemes
    relations = d2.relations
    retractions = d2.retractions ?? []
    batches = d2.batches ?? []
    currentSchemeId = schemes.some((s) => s.id === d2.currentSchemeId)
      ? d2.currentSchemeId
      : schemes[0]?.id ?? DEFAULT_SCHEME_ID
  }

  await db.transaction(
    'rw',
    [db.units, db.positions, db.schemes, db.relations, db.evidences, db.retractions, db.batches, db.appmeta],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.schemes.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
      ])
      await db.units.bulkPut(data.units)
      await db.positions.bulkPut(data.positions ?? [])
      await db.schemes.bulkPut(schemes)
      await db.relations.bulkPut(relations)
      await db.evidences.bulkPut((data as ProjectExport).evidences ?? [])
      await db.retractions.bulkPut(retractions)
      if (batches.length) await db.batches.bulkPut(batches)
      await db.appmeta.put({
        key: 'app',
        currentSchemeId,
        compareSchemeAId: null,
        compareSchemeBId: null,
      })
    },
  )
  state.compareOpen = false
  state.compareDiff = null
  await refresh()
  state.layoutVersion++

  // 偏序一致性校验：重算当前方案可达对并与导出快照比对（旧工程同样校验）
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(activeEarlierEdges(relations).map((r) => ({ id: r.id, from: r.from, to: r.to })))
  const same = JSON.stringify(expected) === JSON.stringify(actual)
  const migNote = isLegacy ? '旧版单方案工程已无损迁移为默认方案，原关系与撤回记录保留；' : ''
  toast(
    migNote +
      (same
        ? `导入完成，偏序校验一致（${actual.length} 个可达对）`
        : '导入完成，但偏序与导出时不一致，请检查数据'),
  )
}
