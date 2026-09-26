import Dexie, { type Table } from 'dexie'
import type { AppMeta, Batch, Evidence, Relation, Retraction, Scheme, StratUnit, UnitPosition } from './types'

/** 旧版单方案数据首次加载时迁入的默认方案 id（固定值，迁移与导入共用） */
export const DEFAULT_SCHEME_ID = 'scheme-default'
export const DEFAULT_SCHEME_NAME = '默认方案'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 关系 / 撤销判断 / 批次按解释方案（schemeId）隔离；层位、证据、位置全方案共享。
 */
class MatrixDB extends Dexie {
  units!: Table<StratUnit, string>
  positions!: Table<UnitPosition, string>
  schemes!: Table<Scheme, string>
  relations!: Table<Relation, string>
  evidences!: Table<Evidence, string>
  retractions!: Table<Retraction, string>
  batches!: Table<Batch, string>
  appmeta!: Table<AppMeta, string>

  constructor() {
    super('harris-matrix')
    // v1：旧版单方案库结构（保留声明以触发 v1→v2 无损迁移）
    this.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    // v2：解释方案分支
    this.version(2)
      .stores({
        units: 'id',
        positions: 'unitId',
        schemes: 'id, createdAt',
        relations: 'id, schemeId, from, to, status',
        evidences: 'id',
        retractions: 'id, schemeId, relationId',
        batches: 'id, schemeId, at',
        appmeta: 'key',
      })
      .upgrade(async (tx) => {
        // 旧版单方案数据无损迁移：全部关系/撤销记录/批次归入默认方案
        await tx.table('schemes').add({
          id: DEFAULT_SCHEME_ID,
          name: DEFAULT_SCHEME_NAME,
          derivedFrom: null,
          createdAt: Date.now(),
        })
        await tx.table('relations').toCollection().modify((r: Relation) => {
          r.schemeId = DEFAULT_SCHEME_ID
          r.originId = null
        })
        await tx.table('retractions').toCollection().modify((x: Retraction) => {
          x.schemeId = DEFAULT_SCHEME_ID
          x.snapshot.schemeId = DEFAULT_SCHEME_ID
          x.snapshot.originId = null
        })
        await tx.table('batches').toCollection().modify((b: Batch) => {
          // 旧批次可能跨关系与层位变更，标记为全局批次以保持可撤销语义
          b.schemeId = null
        })
        await tx.table('appmeta').add({
          key: 'app',
          currentSchemeId: DEFAULT_SCHEME_ID,
          compareSchemeAId: null,
          compareSchemeBId: null,
        })
      })
  }
}

export const db = new MatrixDB()
