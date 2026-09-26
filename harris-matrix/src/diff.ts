import { buildGraph, type OrderEdge } from './graph'
import type { OrderConclusion, Relation, RelationDiffItem, SchemeDiff } from './types'

export const pairKey = (from: string, to: string) => `${from}→${to}`
const contempKey = (a: string, b: string) => [a, b].sort().join('≈')

/** 跨方案对齐同一条记录：派生关系按 originId 认祖，本方案新建关系按自身 id */
function lineageKey(r: Relation): string {
  return r.originId ? `o:${r.originId}` : `n:${r.id}`
}

/** 活跃“早于”关系（含矛盾记录：矛盾记录仍是被保存的原始观察，参与闭包，仅标记不删除） */
export function activeEarlierEdges(relations: Relation[]): OrderEdge[] {
  return relations
    .filter((r) => r.status === 'active' && r.kind === 'earlier')
    .map((r) => ({ id: r.id, from: r.from, to: r.to }))
}

/**
 * 全部先后结论（传递闭包）：key 为 "a→b"，direct 标记该结论是否同时存在直接活跃边。
 * 图中若含成环边，环上各对在两个方向上都可达——与既有偏序导出语义保持一致。
 */
export function closureConclusions(relations: Relation[]): Map<string, OrderConclusion> {
  const edges = activeEarlierEdges(relations)
  const directPairs = new Set(edges.map((e) => pairKey(e.from, e.to)))
  const g = buildGraph(edges)
  const out = new Map<string, OrderConclusion>()
  g.forEachNode((source) => {
    const seen = new Set<string>([source])
    const queue: string[] = [source]
    while (queue.length > 0) {
      const cur = queue.shift()!
      g.forEachOutboundNeighbor(cur, (nb) => {
        if (seen.has(nb)) return
        seen.add(nb)
        out.set(pairKey(source, nb), {
          from: source,
          to: nb,
          direct: directPairs.has(pairKey(source, nb)),
        })
        queue.push(nb)
      })
    }
  })
  return out
}

/** 活跃同期关联（无向） */
function contemporaryPairs(relations: Relation[]): Map<string, { from: string; to: string }> {
  const out = new Map<string, { from: string; to: string }>()
  for (const r of relations) {
    if (r.status === 'active' && r.kind === 'contemporary') {
      const k = contempKey(r.from, r.to)
      if (!out.has(k)) out.set(k, { from: r.from, to: r.to })
    }
  }
  return out
}

function sortByPair<T extends { from: string; to: string }>(items: T[]): T[] {
  return [...items].sort((x, y) =>
    pairKey(x.from, x.to) < pairKey(y.from, y.to) ? -1 : pairKey(x.from, x.to) > pairKey(y.from, y.to) ? 1 : 0,
  )
}

/**
 * 两个解释方案的语义对比：
 * 1. 记录差异：按血缘键（originId）对齐同一条记录，再按语义对兜底对齐；
 *    双方都有但撤回状态不同者单列为 status（直接边相同的记录层面差异，仍会改变闭包）。
 * 2. 直接活跃先后边差异（按 from→to 去重）。
 * 3. 传递闭包结论差异：新增/失效的先后结论，逐条标注 direct（直接/间接推出）。
 * 4. 同期关联差异（无向）。
 * 纯函数，只读传入数据，绝不改写任一方案。
 */
export function computeSchemeDiff(aId: string, bId: string, relsA: Relation[], relsB: Relation[]): SchemeDiff {
  const relationDiffs: RelationDiffItem[] = []
  const onlyStatusDifferences: RelationDiffItem[] = []

  const pushRecord = (
    change: RelationDiffItem['change'],
    a: Relation | null,
    b: Relation | null,
  ) => {
    const base = a ?? b!
    const item: RelationDiffItem = {
      key: `${base.kind}|${base.from}|${base.to}|${change}`,
      from: base.from,
      to: base.to,
      kind: base.kind,
      source: b?.source ?? a!.source,
      change,
      aStatus: a ? a.status : null,
      bStatus: b ? b.status : null,
      aConflict: a?.conflict ?? false,
      bConflict: b?.conflict ?? false,
    }
    relationDiffs.push(item)
    if (change === 'status') onlyStatusDifferences.push(item)
  }

  // —— 第一层：按血缘键对齐（派生复制保留 originId，删除来源方案不影响对齐） ——
  const byLineageA = new Map<string, Relation[]>()
  const byLineageB = new Map<string, Relation[]>()
  for (const r of relsA) {
    const k = lineageKey(r)
    byLineageA.set(k, [...(byLineageA.get(k) ?? []), r])
  }
  for (const r of relsB) {
    const k = lineageKey(r)
    byLineageB.set(k, [...(byLineageB.get(k) ?? []), r])
  }

  const leftoverA: Relation[] = []
  const leftoverB: Relation[] = []
  for (const [k, listA] of byLineageA) {
    const listB = byLineageB.get(k) ?? []
    const n = Math.min(listA.length, listB.length)
    for (let i = 0; i < n; i++) {
      const a = listA[i]
      const b = listB[i]
      if (a.status !== b.status) pushRecord('status', a, b)
      else if (a.conflict !== b.conflict) pushRecord('conflict', a, b)
    }
    leftoverA.push(...listA.slice(n))
    if (listB.length > n) leftoverB.push(...listB.slice(n))
  }
  for (const [k, listB] of byLineageB) if (!byLineageA.has(k)) leftoverB.push(...listB)

  // —— 第二层：未对齐记录按语义对（kind+from+to）兜底匹配 ——
  const semKey = (r: Relation) => `${r.kind}|${r.from}|${r.to}`
  const poolA = new Map<string, Relation[]>()
  const poolB = new Map<string, Relation[]>()
  for (const r of leftoverA) poolA.set(semKey(r), [...(poolA.get(semKey(r)) ?? []), r])
  for (const r of leftoverB) poolB.set(semKey(r), [...(poolB.get(semKey(r)) ?? []), r])

  const restA: Relation[] = []
  for (const [k, listA] of poolA) {
    const listB = poolB.get(k) ?? []
    const n = Math.min(listA.length, listB.length)
    for (let i = 0; i < n; i++) {
      const a = listA[i]
      const b = listB[i]
      if (a.status !== b.status) pushRecord('status', a, b)
    }
    restA.push(...listA.slice(n))
    if (listB.length > n) for (const b of listB.slice(n)) pushRecord('present', null, b)
    poolB.delete(k)
  }
  for (const listB of poolB.values()) for (const b of listB) pushRecord('present', null, b)
  for (const a of restA) pushRecord('missing', a, null)

  // —— 直接活跃先后边（按对去重） ——
  const directA = new Set(activeEarlierEdges(relsA).map((e) => pairKey(e.from, e.to)))
  const directB = new Set(activeEarlierEdges(relsB).map((e) => pairKey(e.from, e.to)))
  const orderDiffs: SchemeDiff['orderDiffs'] = []
  for (const k of directB) if (!directA.has(k)) orderDiffs.push({ from: k.split('→')[0], to: k.split('→')[1], change: 'present' })
  for (const k of directA) if (!directB.has(k)) orderDiffs.push({ from: k.split('→')[0], to: k.split('→')[1], change: 'missing' })
  sortByPair(orderDiffs)

  // —— 闭包结论 ——
  const closureA = closureConclusions(relsA)
  const closureB = closureConclusions(relsB)
  const closureAdded: OrderConclusion[] = []
  const closureRemoved: OrderConclusion[] = []
  for (const [k, c] of closureB) if (!closureA.has(k)) closureAdded.push(c)
  for (const [k, c] of closureA) if (!closureB.has(k)) closureRemoved.push(c)
  sortByPair(closureAdded)
  sortByPair(closureRemoved)

  // —— 同期关联 ——
  const contA = contemporaryPairs(relsA)
  const contB = contemporaryPairs(relsB)
  const contemporaryAdded: Array<{ from: string; to: string }> = []
  const contemporaryRemoved: Array<{ from: string; to: string }> = []
  for (const [k, v] of contB) if (!contA.has(k)) contemporaryAdded.push(v)
  for (const [k, v] of contA) if (!contB.has(k)) contemporaryRemoved.push(v)
  sortByPair(contemporaryAdded)
  sortByPair(contemporaryRemoved)

  return {
    aId,
    bId,
    relationDiffs: relationDiffs.sort((x, y) => x.key.localeCompare(y.key)),
    orderDiffs,
    closureAdded,
    closureRemoved,
    contemporaryAdded,
    contemporaryRemoved,
    onlyStatusDifferences,
    counts: { relationsA: relsA.length, relationsB: relsB.length, pairsA: closureA.size, pairsB: closureB.size },
  }
}
