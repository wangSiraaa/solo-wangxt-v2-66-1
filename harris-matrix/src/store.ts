import { computed, reactive } from 'vue'
import { db } from './db'
import { cyclePathIfAdded, layeredPositions, reachablePairs, redundantEdges, type OrderEdge } from './graph'
import { buildSample } from './sample'
import {
  DEFAULT_SCHEME_ID,
  type Batch,
  type Evidence,
  type Mutation,
  type ProjectExport,
  type Relation,
  type RelationDraft,
  type Retraction,
  type Scheme,
  type StratUnit,
  type TableName,
  type UnitPosition,
  type UnitType,
} from './types'

export const state = reactive({
  loaded: false,
  units: [] as StratUnit[],
  positions: {} as Record<string, UnitPosition>,
  /** 全部解释方案；关系/撤销记录按 schemeId 归属各方案 */
  schemes: [] as Scheme[],
  /** 当前方案选择（持久化于 meta 表，刷新后恢复） */
  currentSchemeId: null as string | null,
  relations: [] as Relation[],
  evidences: [] as Evidence[],
  retractions: [] as Retraction[],
  batches: [] as Batch[],
  viewMode: 'raw' as 'raw' | 'simplified',
  selectedUnitId: null as string | null,
  /** 待确认的成环关系：记录员可选择保留为矛盾记录或取消 */
  pendingCycle: null as { draft: RelationDraft; path: string[] } | null,
  /** 方案语义对比面板开关 */
  compareOpen: false,
  /** 对比视图定位高亮的层位（只读标记，不写入任何方案） */
  compareHighlight: [] as string[],
  toast: '',
  /** 自增以通知画布重排（身份与位置分离，位置变化不触发数据刷新） */
  layoutVersion: 0,
})

/* ---------- 派生数据 ---------- */

export const currentScheme = computed(() => state.schemes.find((s) => s.id === state.currentSchemeId) ?? null)

/** 当前方案的全部关系（含已撤回）；其他方案的关系不受影响也不参与显示 */
export const schemeRelations = computed(() => state.relations.filter((r) => r.schemeId === state.currentSchemeId))

export const activeRelations = computed(() => schemeRelations.value.filter((r) => r.status === 'active'))

/** 当前方案的撤销记录 */
export const schemeRetractions = computed(() => state.retractions.filter((x) => x.schemeId === state.currentSchemeId))

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
  toastTimer = window.setTimeout(() => (state.toast = ''), 4000)
}

function tableOf(name: TableName) {
  return {
    units: db.units,
    positions: db.positions,
    relations: db.relations,
    evidences: db.evidences,
    retractions: db.retractions,
    schemes: db.schemes,
  }[name]
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

function makeDefaultScheme(): Scheme {
  return { id: DEFAULT_SCHEME_ID, name: '默认方案', createdAt: Date.now(), sourceSchemeId: null, sourceSchemeName: null }
}

export async function refresh() {
  const [units, positions, relations, evidences, retractions, batches, schemes, metaRows] = await Promise.all([
    db.units.toArray(),
    db.positions.toArray(),
    db.relations.toArray(),
    db.evidences.toArray(),
    db.retractions.toArray(),
    db.batches.orderBy('at').toArray(),
    db.schemes.orderBy('createdAt').toArray(),
    db.meta.toArray(),
  ])

  // 兼容旧批次撤销恢复出的无 schemeId 记录：归入默认方案并回写修复（无损）
  if (relations.some((r) => !r.schemeId) || retractions.some((x) => !x.schemeId)) {
    let def = schemes.find((s) => s.id === DEFAULT_SCHEME_ID) ?? schemes[0]
    if (!def) {
      def = makeDefaultScheme()
      await db.schemes.put(def)
      schemes.push(def)
    }
    for (const r of relations) {
      if (!r.schemeId) {
        r.schemeId = def.id
        await db.relations.put(plain(r))
      }
    }
    for (const x of retractions) {
      if (!x.schemeId) {
        x.schemeId = def.id
        await db.retractions.put(plain(x))
      }
    }
  }

  state.units = units.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  state.positions = Object.fromEntries(positions.map((p) => [p.unitId, p]))
  state.schemes = schemes
  state.relations = relations.sort((a, b) => a.createdAt - b.createdAt)
  state.evidences = evidences.sort((a, b) => a.createdAt - b.createdAt)
  state.retractions = retractions.sort((a, b) => a.at - b.at)
  state.batches = batches

  // 当前方案选择：读取持久化值；失效（如来源方案被撤销/删除）时回退到默认/最早方案
  const saved = metaRows.find((m) => m.key === 'currentSchemeId')?.value as string | undefined
  const valid = saved != null && schemes.some((s) => s.id === saved)
  state.currentSchemeId = valid
    ? (saved as string)
    : (schemes.find((s) => s.id === DEFAULT_SCHEME_ID)?.id ?? schemes[0]?.id ?? null)
  if (state.currentSchemeId && state.currentSchemeId !== saved) {
    await db.meta.put({ key: 'currentSchemeId', value: state.currentSchemeId })
  }
  state.loaded = true
}

/** 以批次执行一组变更：全部正向应用后登记批次，供整体撤销 */
async function runBatch(label: string, mutations: Mutation[]) {
  if (mutations.length === 0) return
  for (const m of mutations) await applyForward(m)
  const batch: Batch = { id: uid(), label, at: Date.now(), undone: false, mutations }
  await db.batches.put(plain(batch))
  await refresh()
}

/** 撤销最近一个未撤销的批次：关系与证据引用随逆向变更一起恢复 */
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

/* ---------- 解释方案 ---------- */

/** 切换当前方案并持久化选择（刷新后恢复） */
export async function setCurrentScheme(id: string) {
  if (id === state.currentSchemeId) return
  const scheme = state.schemes.find((s) => s.id === id)
  if (!scheme) return
  state.currentSchemeId = id
  state.pendingCycle = null
  state.compareHighlight = []
  await db.meta.put({ key: 'currentSchemeId', value: id })
  toast(`已切换到方案「${scheme.name}」`)
}

/** 保证存在当前方案：清空工程后首次添加关系时自动建立默认方案 */
async function ensureScheme(): Promise<string | null> {
  if (state.currentSchemeId && state.schemes.some((s) => s.id === state.currentSchemeId)) {
    return state.currentSchemeId
  }
  if (state.schemes.length > 0) {
    await setCurrentScheme(state.schemes[0].id)
    return state.schemes[0].id
  }
  const scheme = makeDefaultScheme()
  await db.schemes.put(scheme)
  await db.meta.put({ key: 'currentSchemeId', value: scheme.id })
  state.schemes = [scheme]
  state.currentSchemeId = scheme.id
  return scheme.id
}

/**
 * 从当前方案派生命名方案：完整复制当前关系集（含已撤回判断与撤销记录），
 * 副本使用全新 id，此后两个方案的增删互不影响；来源方案仅作溯源引用，删除不级联。
 */
export async function deriveScheme(name: string) {
  const src = currentScheme.value
  if (!src) {
    toast('当前没有可派生的方案')
    return
  }
  name = name.trim()
  if (!name) return
  if (state.schemes.some((s) => s.name === name)) {
    toast(`方案「${name}」已存在`)
    return
  }
  const scheme: Scheme = {
    id: uid(),
    name,
    createdAt: Date.now(),
    sourceSchemeId: src.id,
    sourceSchemeName: src.name,
  }
  const mutations: Mutation[] = [{ table: 'schemes', key: scheme.id, before: null, after: scheme }]
  const idMap = new Map<string, string>()
  for (const r of state.relations.filter((r) => r.schemeId === src.id)) {
    const copy: Relation = { ...plain(r), id: uid(), schemeId: scheme.id }
    idMap.set(r.id, copy.id)
    mutations.push({ table: 'relations', key: copy.id, before: null, after: copy })
  }
  for (const x of state.retractions.filter((x) => x.schemeId === src.id)) {
    const relationId = idMap.get(x.relationId) ?? x.relationId
    const copy: Retraction = {
      ...plain(x),
      id: uid(),
      schemeId: scheme.id,
      relationId,
      snapshot: { ...plain(x.snapshot), id: relationId, schemeId: scheme.id },
    }
    mutations.push({ table: 'retractions', key: copy.id, before: null, after: copy })
  }
  await runBatch(`派生方案「${name}」（源自「${src.name}」）`, mutations)
  await setCurrentScheme(scheme.id)
  toast(`已派生方案「${name}」，可独立编辑`)
}

/** 删除方案及其全部关系与撤销记录（整批可撤销）；已派生的方案持有独立副本，不受影响 */
export async function deleteScheme(id: string) {
  const scheme = state.schemes.find((s) => s.id === id)
  if (!scheme) return
  if (state.schemes.length <= 1) {
    toast('至少保留一个方案')
    return
  }
  const relCount = state.relations.filter((r) => r.schemeId === id).length
  if (
    !window.confirm(
      `删除方案「${scheme.name}」？其 ${relCount} 条关系与相关撤销记录将一并删除（可整体撤销）。已派生的方案不受影响。`,
    )
  ) {
    return
  }
  const mutations: Mutation[] = [{ table: 'schemes', key: id, before: plain(scheme), after: null }]
  for (const r of state.relations.filter((r) => r.schemeId === id)) {
    mutations.push({ table: 'relations', key: r.id, before: plain(r), after: null })
  }
  for (const x of state.retractions.filter((x) => x.schemeId === id)) {
    mutations.push({ table: 'retractions', key: x.id, before: plain(x), after: null })
  }
  await runBatch(`删除方案「${scheme.name}」`, mutations)
  if (state.currentSchemeId === id) {
    const fallback = state.schemes.find((s) => s.id === DEFAULT_SCHEME_ID) ?? state.schemes[0]
    if (fallback) await setCurrentScheme(fallback.id)
  }
  toast(`已删除方案「${scheme.name}」`)
}

/** 重命名方案（组织性操作，不进入撤销批次） */
export async function renameScheme(id: string, name: string) {
  name = name.trim()
  const scheme = state.schemes.find((s) => s.id === id)
  if (!scheme || !name || name === scheme.name) return
  if (state.schemes.some((s) => s.name === name && s.id !== id)) {
    toast(`方案「${name}」已存在`)
    return
  }
  await db.schemes.update(id, { name })
  await refresh()
  toast(`已重命名为「${name}」`)
}

/** 比较视图定位：仅高亮相关层位，不修改任何方案数据 */
export function locateUnits(ids: string[]) {
  state.compareHighlight = ids.filter((id) => state.units.some((u) => u.id === id))
  state.selectedUnitId = state.compareHighlight[0] ?? null
}

/* ---------- 层位 ---------- */

export async function addUnit(label: string, type: UnitType, note: string) {
  label = label.trim()
  if (!label) return
  if (state.units.some((u) => u.label === label)) {
    toast(`层位 ${label} 已存在`)
    return
  }
  const unit: StratUnit = { id: uid(), label, type, note: note.trim(), createdAt: Date.now() }
  await runBatch(`新增层位 ${label}`, [{ table: 'units', key: unit.id, before: null, after: unit }])
  toast(`已新增层位 ${label}`)
}

export async function deleteUnit(id: string) {
  const unit = state.units.find((u) => u.id === id)
  if (!unit) return
  const mutations: Mutation[] = [{ table: 'units', key: id, before: unit, after: null }]
  const pos = state.positions[id]
  if (pos) mutations.push({ table: 'positions', key: id, before: pos, after: null })
  // 连带删除所有方案中涉及该层位的关系及其撤销记录（全部记入批次，可整体撤销）
  for (const r of state.relations.filter((r) => r.from === id || r.to === id)) {
    mutations.push({ table: 'relations', key: r.id, before: r, after: null })
    for (const x of state.retractions.filter((x) => x.relationId === r.id)) {
      mutations.push({ table: 'retractions', key: x.id, before: x, after: null })
    }
  }
  await runBatch(`删除层位 ${unit.label}（连带 ${mutations.length - (pos ? 2 : 1)} 条关系）`, mutations)
  if (state.selectedUnitId === id) state.selectedUnitId = null
  state.compareHighlight = state.compareHighlight.filter((x) => x !== id)
  toast(`已删除层位 ${unit.label}`)
}

/* ---------- 证据 ---------- */

export async function addEvidence(ref: string, text: string) {
  ref = ref.trim()
  if (!ref) return
  const ev: Evidence = { id: uid(), ref, text: text.trim(), createdAt: Date.now() }
  await runBatch(`登记证据 ${ref}`, [{ table: 'evidences', key: ev.id, before: null, after: ev }])
  toast(`已登记证据 ${ref}`)
}

/* ---------- 关系 ---------- */

function makeRelation(draft: RelationDraft, conflict: boolean, schemeId: string): Relation {
  return {
    id: uid(),
    schemeId,
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

/** 批次标签带上方案名，便于在批次列表中区分各方案的编辑 */
const schemeTag = () => (currentScheme.value ? `【${currentScheme.value.name}】` : '')

/**
 * 新增关系到当前方案。先后关系先做有向成环检测（仅基于本方案的边集）：
 * 若成环则挂起并给出完整环路径，由记录员决定保留为矛盾记录或取消。
 * 同期关联不进入有向图，直接保存。矛盾标记只落在本方案的记录上。
 */
export async function addRelation(draft: RelationDraft, allowConflict = false) {
  if (!draft.from || !draft.to) return
  if (draft.kind === 'earlier' && draft.from === draft.to) {
    toast('层位不能早于其自身')
    return
  }
  const schemeId = await ensureScheme()
  if (!schemeId) return
  const dup = activeRelations.value.some(
    (r) => r.from === draft.from && r.to === draft.to && r.kind === draft.kind,
  )
  if (dup) {
    toast('相同的关系已存在')
    return
  }

  if (draft.kind === 'contemporary') {
    // 同期关联：只存档，不作为有向边参与偏序
    const relation = makeRelation(draft, false, schemeId)
    await runBatch(`${schemeTag()}新增同期关联：${describe(draft)}`, [
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
  const relation = makeRelation(draft, cycle !== null, schemeId)
  await runBatch(
    cycle ? `${schemeTag()}新增矛盾记录：${describe(draft)}` : `${schemeTag()}新增先后关系：${describe(draft)}`,
    [{ table: 'relations', key: relation.id, before: null, after: relation }],
  )
  toast(cycle ? '已保存为矛盾记录（成环路径见画布红边）' : '已添加先后关系')
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

/** 撤回判断：关系标记为 retracted，快照与理由单独存入 retractions 表（归属同一方案） */
export async function retractRelation(id: string, reason: string) {
  const rel = state.relations.find((r) => r.id === id)
  if (!rel || rel.status !== 'active') return
  const retraction: Retraction = {
    id: uid(),
    schemeId: rel.schemeId,
    relationId: id,
    snapshot: { ...rel },
    reason: reason.trim() || '（未填写理由）',
    at: Date.now(),
  }
  await runBatch(`${schemeTag()}撤回判断：${unitLabel(rel.from)} → ${unitLabel(rel.to)}`, [
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

/** 按最长路径分层自动排布（忽略成环边） */
export async function autoLayout() {
  const auto = layeredPositions(
    state.units.map((u) => u.id),
    orderEdges.value,
  )
  for (const [id, p] of auto) await db.positions.put({ unitId: id, x: p.x, y: p.y })
  await refresh()
  state.layoutVersion++
  toast('已按地层早晚自动分层排布')
}

/* ---------- 示例 / 清空 / 导出 / 导入 ---------- */

export async function loadSample() {
  if (state.units.length > 0 && !window.confirm('载入示例将先清空当前工程（不可撤销），继续？')) return
  await clearAll(false)
  const now = Date.now()
  const sample = buildSample(now)
  const scheme: Scheme = { ...makeDefaultScheme(), createdAt: now }
  const positions = layeredPositions(
    sample.units.map((u) => u.id),
    sample.relations.filter((r) => r.kind === 'earlier' && r.status === 'active'),
  )
  const mutations: Mutation[] = [{ table: 'schemes', key: scheme.id, before: null, after: scheme }]
  for (const u of sample.units) mutations.push({ table: 'units', key: u.id, before: null, after: u })
  for (const e of sample.evidences) mutations.push({ table: 'evidences', key: e.id, before: null, after: e })
  for (const r of sample.relations) {
    mutations.push({ table: 'relations', key: r.id, before: null, after: { ...r, schemeId: scheme.id } })
  }
  for (const x of sample.retractions) {
    mutations.push({
      table: 'retractions',
      key: x.id,
      before: null,
      after: { ...x, schemeId: scheme.id, snapshot: { ...x.snapshot, schemeId: scheme.id } },
    })
  }
  for (const u of sample.units) {
    const p = positions.get(u.id)
    if (p) mutations.push({ table: 'positions', key: u.id, before: null, after: { unitId: u.id, ...p } })
  }
  await runBatch('载入示例工程', mutations)
  await setCurrentScheme(scheme.id)
  state.layoutVersion++
  toast('示例工程已载入（含切割事件、孤立层位、矛盾记录与已撤销判断）')
}

export async function clearAll(confirm = true) {
  if (confirm && !window.confirm('清空全部工程数据？此操作不可撤销。')) return
  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches, db.schemes, db.meta],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.schemes.clear(),
        db.meta.clear(),
      ])
    },
  )
  state.selectedUnitId = null
  state.pendingCycle = null
  state.compareHighlight = []
  if (confirm) {
    // 独立清空后立即建立一个空的默认方案，保证有可工作的方案上下文
    const scheme = makeDefaultScheme()
    await db.schemes.put(scheme)
    await db.meta.put({ key: 'currentSchemeId', value: scheme.id })
  }
  await refresh()
  if (confirm) toast('工程已清空')
}

/** 组装导出数据（纯函数，便于校验与测试） */
export function buildExportData(): ProjectExport {
  return {
    app: 'harris-matrix-workbench',
    version: 2,
    exportedAt: new Date().toISOString(),
    schemes: plain(state.schemes),
    currentSchemeId: state.currentSchemeId,
    units: plain(state.units),
    positions: plain(Object.values(state.positions)),
    relations: plain(state.relations),
    evidences: plain(state.evidences),
    retractions: plain(state.retractions),
    partialOrder: reachablePairs(orderEdges.value),
  }
}

export function exportProject() {
  const data = buildExportData()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `harris-matrix-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast(`已导出 ${data.schemes?.length ?? 0} 个方案（当前方案偏序闭包 ${data.partialOrder.length} 个可达对）`)
}

export async function importProject(file: File) {
  let data: ProjectExport
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

  // 方案归一化：旧版单方案工程（无 schemes）整体迁移为默认方案；新版校验 schemeId 有效性
  let schemes: Scheme[]
  let relations: Relation[]
  let retractions: Retraction[]
  let currentSchemeId: string | null
  if (Array.isArray(data.schemes) && data.schemes.length > 0) {
    schemes = data.schemes.map((s) => ({
      ...s,
      sourceSchemeId: s.sourceSchemeId ?? null,
      sourceSchemeName: s.sourceSchemeName ?? null,
    }))
    const ids = new Set(schemes.map((s) => s.id))
    const fallback = schemes[0].id
    relations = data.relations.map((r) => (ids.has(r.schemeId) ? r : { ...r, schemeId: fallback }))
    retractions = (data.retractions ?? []).map((x) => (ids.has(x.schemeId) ? x : { ...x, schemeId: fallback }))
    currentSchemeId = data.currentSchemeId && ids.has(data.currentSchemeId) ? data.currentSchemeId : fallback
  } else {
    const def = makeDefaultScheme()
    schemes = [def]
    relations = data.relations.map((r) => ({ ...r, schemeId: def.id }))
    retractions = (data.retractions ?? []).map((x) => ({ ...x, schemeId: def.id }))
    currentSchemeId = def.id
  }

  await db.transaction(
    'rw',
    [db.units, db.positions, db.relations, db.evidences, db.retractions, db.batches, db.schemes, db.meta],
    async () => {
      await Promise.all([
        db.units.clear(),
        db.positions.clear(),
        db.relations.clear(),
        db.evidences.clear(),
        db.retractions.clear(),
        db.batches.clear(),
        db.schemes.clear(),
        db.meta.clear(),
      ])
      await db.units.bulkPut(data.units)
      await db.positions.bulkPut(data.positions ?? [])
      await db.relations.bulkPut(plain(relations))
      await db.evidences.bulkPut(data.evidences ?? [])
      await db.retractions.bulkPut(plain(retractions))
      await db.schemes.bulkPut(plain(schemes))
      await db.meta.put({ key: 'currentSchemeId', value: currentSchemeId })
    },
  )
  await refresh()
  state.layoutVersion++
  // 偏序一致性校验：重算当前方案可达对并与导出快照比对
  const expected = [...(data.partialOrder ?? [])].sort()
  const actual = reachablePairs(orderEdges.value)
  const same = JSON.stringify(expected) === JSON.stringify(actual)
  toast(
    same
      ? `导入完成（${schemes.length} 个方案），偏序校验一致（${actual.length} 个可达对）`
      : '导入完成，但偏序与导出时不一致，请检查数据',
  )
}
