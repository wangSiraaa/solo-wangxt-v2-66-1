import Dexie, { type Table } from 'dexie'
import {
  DEFAULT_SCHEME_ID,
  type Batch,
  type Evidence,
  type MetaEntry,
  type Relation,
  type Retraction,
  type Scheme,
  type StratUnit,
  type UnitPosition,
} from './types'

/**
 * 纯本地存储：所有现场资料只写入浏览器 IndexedDB，不发生任何网络上传。
 * 原始观察 / 推断关系（relations 表，以 source 区分）、被撤销判断（retractions 表）分开保存。
 * v2 起关系与撤销记录按解释方案（schemes 表）分支；当前方案选择存于 meta 表。
 */
class MatrixDB extends Dexie {
  units!: Table<StratUnit, string>
  positions!: Table<UnitPosition, string>
  relations!: Table<Relation, string>
  evidences!: Table<Evidence, string>
  retractions!: Table<Retraction, string>
  batches!: Table<Batch, string>
  schemes!: Table<Scheme, string>
  meta!: Table<MetaEntry, string>

  constructor() {
    super('harris-matrix')
    this.version(1).stores({
      units: 'id',
      positions: 'unitId',
      relations: 'id, from, to, status',
      evidences: 'id',
      retractions: 'id, relationId',
      batches: 'id, at',
    })
    /**
     * v2：解释方案分支。旧版单方案数据无损迁移——
     * 自动创建默认方案，全部既有关系与撤销记录归入其中，当前选择指向默认方案。
     */
    this.version(2)
      .stores({
        relations: 'id, from, to, status, schemeId',
        retractions: 'id, relationId, schemeId',
        schemes: 'id, createdAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx.table('schemes').put({
          id: DEFAULT_SCHEME_ID,
          name: '默认方案',
          createdAt: Date.now(),
          sourceSchemeId: null,
          sourceSchemeName: null,
        })
        await tx
          .table('relations')
          .toCollection()
          .modify((r: { schemeId?: string }) => {
            r.schemeId ??= DEFAULT_SCHEME_ID
          })
        await tx
          .table('retractions')
          .toCollection()
          .modify((x: { schemeId?: string }) => {
            x.schemeId ??= DEFAULT_SCHEME_ID
          })
        await tx.table('meta').put({ key: 'currentSchemeId', value: DEFAULT_SCHEME_ID })
      })
  }
}

export const db = new MatrixDB()
