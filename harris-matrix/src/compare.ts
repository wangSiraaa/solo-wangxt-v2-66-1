import { reachablePairs, type OrderEdge } from './graph'
import type { Relation, RelationKind } from './types'

/** 直接边差异：仅存在于某一方的关系记录（按语义键匹配，与关系 id 无关） */
export interface DirectEdgeDiff {
  from: string
  to: string
  kind: RelationKind
  relation: Relation
}

/** 传递闭包差异：仅在某一方案成立的先后结论（可达对） */
export interface ClosurePairDiff {
  from: string
  to: string
  /** true = 该结论在所属方案中有直接边；false = 纯传递结论（因闭包变化而新增/失效） */
  direct: boolean
}

export interface SchemeComparison {
  /** 仅 A 有的直接边（含同期关联） */
  directOnlyA: DirectEdgeDiff[]
  /** 仅 B 有的直接边（含同期关联） */
  directOnlyB: DirectEdgeDiff[]
  /** 仅 A 成立的先后结论 */
  closureOnlyA: ClosurePairDiff[]
  /** 仅 B 成立的先后结论 */
  closureOnlyB: ClosurePairDiff[]
  /** 两方案的先后结论（传递闭包）是否完全一致 */
  closureSame: boolean
}

/** 关系的语义键：派生副本 id 不同但 (起点,终点,种类) 相同即视为同一条解释 */
const keyOf = (r: Relation) => `${r.from}→${r.to}|${r.kind}`

/**
 * 语义对比两个方案的关系集（只比较活跃关系，已撤回判断不参与解释）：
 * - 直接边差异按语义键匹配，与关系 id 无关；
 * - 闭包差异比较活跃“早于”关系的可达对，并标出其中的纯传递结论——
 *   即并非直接边、只因传递闭包变化而新增或失效的先后结论。
 */
export function compareSchemes(relsA: Relation[], relsB: Relation[]): SchemeComparison {
  const actA = relsA.filter((r) => r.status === 'active')
  const actB = relsB.filter((r) => r.status === 'active')

  const mapA = new Map(actA.map((r) => [keyOf(r), r]))
  const mapB = new Map(actB.map((r) => [keyOf(r), r]))
  const toDiff = (r: Relation): DirectEdgeDiff => ({ from: r.from, to: r.to, kind: r.kind, relation: r })
  const directOnlyA = [...mapA.values()].filter((r) => !mapB.has(keyOf(r))).map(toDiff)
  const directOnlyB = [...mapB.values()].filter((r) => !mapA.has(keyOf(r))).map(toDiff)

  const edgesOf = (rels: Relation[]): OrderEdge[] =>
    rels.filter((r) => r.kind === 'earlier').map((r) => ({ id: r.id, from: r.from, to: r.to }))
  const directPairsOf = (rels: Relation[]) =>
    new Set(rels.filter((r) => r.kind === 'earlier').map((r) => `${r.from}→${r.to}`))

  const pairsA = new Set(reachablePairs(edgesOf(actA)))
  const pairsB = new Set(reachablePairs(edgesOf(actB)))
  const dirA = directPairsOf(actA)
  const dirB = directPairsOf(actB)

  const closureOnlyA: ClosurePairDiff[] = []
  for (const p of pairsA) {
    if (pairsB.has(p)) continue
    const [from, to] = p.split('→')
    closureOnlyA.push({ from, to, direct: dirA.has(p) })
  }
  const closureOnlyB: ClosurePairDiff[] = []
  for (const p of pairsB) {
    if (pairsA.has(p)) continue
    const [from, to] = p.split('→')
    closureOnlyB.push({ from, to, direct: dirB.has(p) })
  }
  // 纯传递结论排在前面，便于重点关注
  closureOnlyA.sort((x, y) => Number(x.direct) - Number(y.direct))
  closureOnlyB.sort((x, y) => Number(x.direct) - Number(y.direct))

  return {
    directOnlyA,
    directOnlyB,
    closureOnlyA,
    closureOnlyB,
    closureSame: closureOnlyA.length === 0 && closureOnlyB.length === 0,
  }
}
