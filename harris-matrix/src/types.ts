/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断 */
export type RelationSource = 'observation' | 'inference'

export type RelationStatus = 'active' | 'retracted'

/** 解释方案：同一套层位/证据之上的一组独立关系集，可从来源方案派生 */
export interface Scheme {
  id: string
  name: string
  /** 派生来源方案；默认方案为 null。删除来源不会清空该字段（快照式引用），也不影响本方案数据 */
  derivedFrom: string | null
  createdAt: number
}

/** 地层身份：与画布位置完全分离 */
export interface StratUnit {
  id: string
  label: string
  type: UnitType
  note: string
  createdAt: number
}

/** 画布位置：独立成表，删除/修改不影响地层身份 */
export interface UnitPosition {
  unitId: string
  x: number
  y: number
}

export interface Relation {
  id: string
  /** 所属解释方案；旧版迁移记录归入默认方案 */
  schemeId: string
  /** 派生复制时的原始关系 id（跨方案语义对齐用）；本方案新建关系为 null */
  originId: string | null
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  status: RelationStatus
  /** 与既有记录构成环时被标记为矛盾记录（仍保留为证据）；仅对所属方案有意义 */
  conflict: boolean
  evidenceIds: string[]
  note: string
  createdAt: number
}

/** 原始证据：日记页码、照片号、剖面图编号等，仅保存在本地 IndexedDB */
export interface Evidence {
  id: string
  ref: string
  text: string
  createdAt: number
}

/** 被撤销的判断：单独成表保存快照与理由，不混入活跃关系 */
export interface Retraction {
  id: string
  schemeId: string
  relationId: string
  snapshot: Relation
  reason: string
  at: number
}

export type TableName = 'units' | 'positions' | 'relations' | 'evidences' | 'retractions'

/** 通用变更记录：before/after 支持正向应用与逆向撤销 */
export interface Mutation {
  table: TableName
  key: string
  before: unknown | null
  after: unknown | null
}

/** 一批操作（可整体撤销） */
export interface Batch {
  id: string
  /** 所属解释方案；层位/证据等跨方案变更为 null（在各方案批次列表中均可见） */
  schemeId: string | null
  label: string
  at: number
  undone: boolean
  mutations: Mutation[]
}

/** 应用级元数据（单键 k='app'）：当前方案等，刷新后恢复 */
export interface AppMeta {
  key: 'app'
  currentSchemeId: string
  compareSchemeAId: string | null
  compareSchemeBId: string | null
}

export interface RelationDraft {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceIds: string[]
  note: string
}

/** 单条有向先后结论：是否为直接记录边 */
export interface OrderConclusion {
  from: string
  to: string
  /** true = 存在直接活跃关系；false = 仅由传递闭包推出 */
  direct: boolean
}

export interface SchemeDiff {
  aId: string
  bId: string
  /** 直接关系（含同期）记录差异，按关系语义键对齐（originId 优先） */
  relationDiffs: RelationDiffItem[]
  /** 活跃“早于”有向边差异（直接先后结论） */
  orderDiffs: OrderDiffItem[]
  /** 闭包新增/失效的先后结论（含直接项，标注 direct） */
  closureAdded: OrderConclusion[]
  closureRemoved: OrderConclusion[]
  /** 同期关联差异（无向） */
  contemporaryAdded: Array<{ from: string; to: string }>
  contemporaryRemoved: Array<{ from: string; to: string }>
  /** 记录完全一致但撤回状态不同：直接边差异之外仍会改变闭包 */
  onlyStatusDifferences: RelationDiffItem[]
  counts: {
    relationsA: number
    relationsB: number
    pairsA: number
    pairsB: number
  }
}

export interface RelationDiffItem {
  key: string
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  /** present = 仅 B 有；missing = 仅 A 有；status = 双方都有但活跃/撤回状态不同；conflict = 同记录矛盾标记不同 */
  change: 'present' | 'missing' | 'status' | 'conflict'
  aStatus: RelationStatus | null
  bStatus: RelationStatus | null
  aConflict: boolean
  bConflict: boolean
}

export interface OrderDiffItem {
  from: string
  to: string
  change: 'present' | 'missing'
}

/** 导出文件格式 v2：携带全部解释方案与偏序闭包（当前方案）用于导入校验 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: 2
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  schemes: Scheme[]
  currentSchemeId: string
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  batches: Batch[]
  /** 导出时当前方案的活跃“早于”关系可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
}

/** 旧版（v1，单方案）导出格式，首次导入无损迁移为默认方案 */
export interface LegacyProjectExport {
  app: 'harris-matrix-workbench'
  version: 1
  exportedAt: string
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Array<Omit<Relation, 'schemeId' | 'originId'> & { schemeId?: string; originId?: string }>
  evidences: Evidence[]
  retractions: Array<Omit<Retraction, 'schemeId'> & { schemeId?: string }>
  partialOrder: string[]
}
