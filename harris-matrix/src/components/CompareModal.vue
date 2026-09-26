<script setup lang="ts">
import { computed } from 'vue'
import { closeCompare, locateInCompare, schemeName, state, unitLabel } from '../store'
import type { RelationDiffItem } from '../types'

const diff = computed(() => state.compareDiff)
const nameA = computed(() => schemeName(diff.value?.aId ?? null))
const nameB = computed(() => schemeName(diff.value?.bId ?? null))

const directEdgeCount = computed(() => diff.value?.orderDiffs.length ?? 0)
const closureDelta = computed(
  () => (diff.value?.closureAdded.length ?? 0) + (diff.value?.closureRemoved.length ?? 0),
)
/** 记录边无差异（无新增/缺失/状态不同），仅矛盾标记可能不同 */
const statusOnly = computed(() => diff.value?.onlyStatusDifferences ?? [])

/** 记录差异中过滤掉已在“撤回状态不同”小节单独展示的 status 项，避免重复 */
const recordDiffs = computed(() => diff.value?.relationDiffs.filter((d) => d.change !== 'status') ?? [])

function changeText(d: RelationDiffItem): string {
  switch (d.change) {
    case 'present':
      return 'B 独有'
    case 'missing':
      return 'A 独有'
    case 'status':
      return d.aStatus === 'active' ? 'A 活跃 / B 撤回' : 'A 撤回 / B 活跃'
    case 'conflict':
      return '矛盾标记不同'
  }
}
</script>

<template>
  <div v-if="state.compareOpen && diff" class="modal-mask compare-mask" @click.self="closeCompare">
    <div class="modal compare-modal">
      <header class="cmp-head">
        <h3>方案语义对比（只读）</h3>
        <button class="sm" @click="closeCompare">关闭</button>
      </header>
      <p class="cmp-sub">
        <b>{{ nameA }}</b>（A） ↔ <b>{{ nameB }}</b>（B）
        <span class="muted">
          关系 {{ diff.counts.relationsA }} / {{ diff.counts.relationsB }} 条；
          先后结论（闭包）{{ diff.counts.pairsA }} / {{ diff.counts.pairsB }} 对
        </span>
      </p>
      <p class="cmp-note muted">点击层位编号可在画布定位。比较视图不会修改任何方案。</p>

      <!-- 特殊提示 -->
      <div v-if="statusOnly.length > 0" class="banner info">
        ℹ 有 {{ statusOnly.length }} 条同源记录在两方案中<b>撤回状态不同</b>：撤回即移除活跃直接边，
        直接记录看似一致，<b>传递推出的先后结论却因此新增或失效</b>（见下）。
      </div>
      <div v-else-if="directEdgeCount === 0 && closureDelta > 0" class="banner warn">
        ⚠ 活跃直接边集合相同，但闭包结论不同，请检查矛盾/成环记录。
      </div>
      <div
        v-if="diff.orderDiffs.length === 0 && diff.closureAdded.length === 0 && diff.closureRemoved.length === 0 && diff.contemporaryAdded.length === 0 && diff.contemporaryRemoved.length === 0 && recordDiffs.length === 0 && statusOnly.length === 0"
        class="banner ok"
      >
        ✓ 两方案语义完全一致（关系记录、先后结论、同期关联均相同）。
      </div>

      <div class="cmp-body">
        <!-- 撤回状态不同 -->
        <section v-if="statusOnly.length">
          <h4>撤回状态不同（{{ statusOnly.length }}）</h4>
          <ul class="cmp-list">
            <li v-for="d in statusOnly" :key="'s' + d.key">
              <button class="unit-chip" @click="locateInCompare(d.from)">{{ unitLabel(d.from) }}</button>
              <span class="arrow">早于</span>
              <button class="unit-chip" @click="locateInCompare(d.to)">{{ unitLabel(d.to) }}</button>
              <span class="tag diff-status">{{ changeText(d) }}</span>
            </li>
          </ul>
        </section>

        <!-- 直接先后边差异 -->
        <section v-if="diff.orderDiffs.length">
          <h4>直接先后边差异（{{ diff.orderDiffs.length }}）</h4>
          <ul class="cmp-list">
            <li v-for="(d, i) in diff.orderDiffs" :key="'o' + i">
              <button class="unit-chip" @click="locateInCompare(d.from)">{{ unitLabel(d.from) }}</button>
              <span class="arrow">早于</span>
              <button class="unit-chip" @click="locateInCompare(d.to)">{{ unitLabel(d.to) }}</button>
              <span class="tag" :class="d.change === 'present' ? 'add' : 'rm'">
                {{ d.change === 'present' ? `仅 ${nameB} 有` : `仅 ${nameA} 有` }}
              </span>
            </li>
          </ul>
        </section>

        <!-- 闭包结论 -->
        <section v-if="diff.closureAdded.length || diff.closureRemoved.length">
          <h4>传递闭包推出的先后结论</h4>
          <ul v-if="diff.closureAdded.length" class="cmp-list">
            <li v-for="(c, i) in diff.closureAdded" :key="'ca' + i" class="added">
              <button class="unit-chip" @click="locateInCompare(c.from)">{{ unitLabel(c.from) }}</button>
              <span class="arrow">早于</span>
              <button class="unit-chip" @click="locateInCompare(c.to)">{{ unitLabel(c.to) }}</button>
              <span class="tag add">{{ nameB }} 新增结论</span>
              <span class="tag" :class="c.direct ? 'direct' : 'indirect'">{{ c.direct ? '直接' : '间接推出' }}</span>
            </li>
          </ul>
          <ul v-if="diff.closureRemoved.length" class="cmp-list">
            <li v-for="(c, i) in diff.closureRemoved" :key="'cr' + i" class="removed">
              <button class="unit-chip" @click="locateInCompare(c.from)">{{ unitLabel(c.from) }}</button>
              <span class="arrow">早于</span>
              <button class="unit-chip" @click="locateInCompare(c.to)">{{ unitLabel(c.to) }}</button>
              <span class="tag rm">{{ nameB }} 中失效</span>
              <span class="tag" :class="c.direct ? 'direct' : 'indirect'">{{ c.direct ? '直接' : '间接推出' }}</span>
            </li>
          </ul>
        </section>

        <!-- 同期关联差异 -->
        <section v-if="diff.contemporaryAdded.length || diff.contemporaryRemoved.length">
          <h4>同期关联差异</h4>
          <ul class="cmp-list">
            <li v-for="(p, i) in diff.contemporaryAdded" :key="'na' + i">
              <button class="unit-chip" @click="locateInCompare(p.from)">{{ unitLabel(p.from) }}</button>
              <span class="arrow">≈</span>
              <button class="unit-chip" @click="locateInCompare(p.to)">{{ unitLabel(p.to) }}</button>
              <span class="tag add">{{ nameB }} 新增同期</span>
            </li>
            <li v-for="(p, i) in diff.contemporaryRemoved" :key="'nr' + i">
              <button class="unit-chip" @click="locateInCompare(p.from)">{{ unitLabel(p.from) }}</button>
              <span class="arrow">≈</span>
              <button class="unit-chip" @click="locateInCompare(p.to)">{{ unitLabel(p.to) }}</button>
              <span class="tag rm">{{ nameB }} 中取消同期</span>
            </li>
          </ul>
        </section>

        <!-- 其他记录差异（矛盾标记等） -->
        <section v-if="recordDiffs.length">
          <h4>其他记录差异（{{ recordDiffs.length }}）</h4>
          <ul class="cmp-list">
            <li v-for="d in recordDiffs" :key="'r' + d.key">
              <button class="unit-chip" @click="locateInCompare(d.from)">{{ unitLabel(d.from) }}</button>
              <span class="arrow">{{ d.kind === 'earlier' ? '早于' : '≈' }}</span>
              <button class="unit-chip" @click="locateInCompare(d.to)">{{ unitLabel(d.to) }}</button>
              <span class="tag" :class="d.change === 'present' ? 'add' : d.change === 'missing' ? 'rm' : 'diff-status'">
                {{ changeText(d) }}
              </span>
              <span v-if="d.change === 'conflict'" class="muted small">
                A：{{ d.aConflict ? '矛盾' : '正常' }} ／ B：{{ d.bConflict ? '矛盾' : '正常' }}
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compare-mask {
  z-index: 30;
}
.compare-modal {
  width: min(820px, 92vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
}
.cmp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.cmp-head h3 {
  margin: 0;
  color: #3e3229;
}
.cmp-sub {
  margin: 8px 0 2px;
}
.cmp-note {
  margin: 0 0 8px;
  font-size: 12px;
}
.banner {
  border-radius: 6px;
  padding: 8px 12px;
  margin: 6px 0;
  font-size: 13px;
}
.banner.warn {
  background: #fff3e0;
  border: 1px solid #ffb74d;
}
.banner.info {
  background: #e3f2fd;
  border: 1px solid #64b5f6;
}
.banner.ok {
  background: #e8f5e9;
  border: 1px solid #81c784;
}
.cmp-body {
  overflow-y: auto;
  margin-top: 6px;
}
.cmp-body section {
  margin-bottom: 12px;
}
.cmp-body h4 {
  margin: 8px 0 4px;
  font-size: 13px;
  color: #444;
}
.cmp-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.cmp-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
}
.unit-chip {
  border: 1px solid #90caf9;
  background: #f1f8fe;
  border-radius: 4px;
  padding: 1px 8px;
  cursor: pointer;
  font-size: 13px;
}
.unit-chip:hover {
  background: #bbdefb;
}
.arrow {
  color: #666;
}
.tag.add {
  background: #e8f5e9;
  color: #2e7d32;
}
.tag.rm {
  background: #ffebee;
  color: #c62828;
}
.tag.direct {
  background: #ede7f6;
  color: #5e35b1;
}
.tag.indirect {
  background: #f5f5f5;
  color: #757575;
}
.tag.diff-status {
  background: #fff8e1;
  color: #ef6c00;
}
.added .unit-chip {
  border-color: #a5d6a7;
}
.removed .unit-chip {
  border-color: #ef9a9a;
}
</style>
