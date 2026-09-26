/** 层位类型：堆积 / 切割 / 填充 / 界面 */
export type UnitType = 'deposit' | 'cut' | 'fill' | 'interface' | 'other'

/** 关系种类：earlier = 有向先后（from 早于 to）；contemporary = 同期关联（不进入有向图） */
export type RelationKind = 'earlier' | 'contemporary'

/** 关系来源：原始观察 / 推断 */
export type RelationSource = 'observation' | 'inference'

export type RelationStatus = 'active' | 'retracted'

/** 迁移旧数据 / 清空重建时使用的默认方案固定 id */
export const DEFAULT_SCHEME_ID = 'scheme-default'

/**
 * 解释方案：一组独立的关系解释（观察/推断/同期）。
 * 层位、证据、画布位置为各方案共享的现场资料；只有关系解释按方案分支。
 */
export interface Scheme {
  id: string
  name: string
  createdAt: number
  /** 派生来源方案 id；来源被删除后保留作溯源（悬空引用，不置空、不级联） */
  sourceSchemeId: string | null
  /** 来源方案名快照：来源删除后仍可显示「派生自 X（已删除）」 */
  sourceSchemeName: string | null
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
  /** 所属解释方案 */
  schemeId: string
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  status: RelationStatus
  /** 与既有记录构成环时被标记为矛盾记录（仍保留为证据） */
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
  /** 所属解释方案（与被撤回关系一致） */
  schemeId: string
  relationId: string
  snapshot: Relation
  reason: string
  at: number
}

export type TableName = 'units' | 'positions' | 'relations' | 'evidences' | 'retractions' | 'schemes'

/** 元信息键值（当前方案选择等），不进入撤销批次 */
export interface MetaEntry {
  key: string
  value: unknown
}

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
  label: string
  at: number
  undone: boolean
  mutations: Mutation[]
}

export interface RelationDraft {
  from: string
  to: string
  kind: RelationKind
  source: RelationSource
  evidenceIds: string[]
  note: string
}

/**
 * 导出文件格式：携带偏序闭包用于导入校验。
 * version 2 起携带方案表与当前选择；导入旧版（version 1，无 schemes）时自动迁移为默认方案。
 */
export interface ProjectExport {
  app: 'harris-matrix-workbench'
  version: number
  exportedAt: string
  /** v2 新增：解释方案表（旧版文件没有此字段） */
  schemes?: Scheme[]
  /** v2 新增：导出时的当前方案 */
  currentSchemeId?: string | null
  units: StratUnit[]
  positions: UnitPosition[]
  relations: Relation[]
  evidences: Evidence[]
  retractions: Retraction[]
  /** 当前方案活跃“早于”关系的可达对闭包（排序后），导入时重算比对 */
  partialOrder: string[]
}
