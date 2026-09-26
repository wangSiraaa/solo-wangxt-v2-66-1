<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { locateUnits, state, unitLabel } from '../store'
import { compareSchemes } from '../compare'
import type { Relation, RelationSource } from '../types'

/**
 * 方案语义对比（只读）：列出两个方案的直接边差异，
 * 并标出因传递闭包变化而新增/失效的先后结论。
 * 点击差异项只在画布定位相关层位，绝不改写任一方案。
 */
const aId = ref(state.currentSchemeId ?? '')
const bId = ref('')

const nameOf = (id: string) => state.schemes.find((s) => s.id === id)?.name ?? '？'

/** 默认对比对象：当前方案 vs 它的来源方案（来源已删则取第一个其他方案） */
function pickDefaultB() {
  const a = state.schemes.find((s) => s.id === aId.value)
  const src = a?.sourceSchemeId && state.schemes.some((s) => s.id === a.sourceSchemeId) ? a.sourceSchemeId : null
  bId.value = src ?? state.schemes.find((s) => s.id !== aId.value)?.id ?? ''
}
pickDefaultB()

watch(aId, () => {
  if (aId.value === bId.value) pickDefaultB()
})

const comparison = computed(() => {
  if (!aId.value || !bId.value || aId.value === bId.value) return null
  const relsA = state.relations.filter((r) => r.schemeId === aId.value)
  const relsB = state.relations.filter((r) => r.schemeId === bId.value)
  return compareSchemes(relsA, relsB)
})

const directSame = computed(
  () => comparison.value !== null && comparison.value.directOnlyA.length === 0 && comparison.value.directOnlyB.length === 0,
)

const sourceNames: Record<RelationSource, string> = { observation: '观察', inference: '推断' }

function describe(r: Relation): string {
  return r.kind === 'earlier'
    ? `${unitLabel(r.from)} 早于 ${unitLabel(r.to)}`
    : `${unitLabel(r.from)} ≈ ${unitLabel(r.to)}（同期）`
}

/** 只读定位：高亮相关层位，不触碰任何方案数据 */
function locate(from: string, to: string) {
  locateUnits([from, to])
}
</script>

<template>
  <section class="panel compare">
    <h3>方案语义对比 <span class="tag readonly">只读</span></h3>
    <div class="row">
      <select v-model="aId">
        <option v-for="s in state.schemes" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <span class="vs">⇄</span>
      <select v-model="bId">
        <option v-for="s in state.schemes" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
    </div>

    <template v-if="comparison">
      <p class="hint">点击差异项可在画布定位相关层位；对比不会修改任何方案。</p>

      <h4>直接边差异</h4>
      <p v-if="directSame" class="muted small">两方案的直接边完全一致。</p>
      <ul v-else class="list">
        <li v-for="d in comparison.directOnlyA" :key="'a' + d.relation.id" class="clickable" @click="locate(d.from, d.to)">
          <span class="grow">
            <span class="tag only">仅「{{ nameOf(aId) }}」</span>
            {{ describe(d.relation) }}
            <span class="tag" :class="d.relation.source">{{ sourceNames[d.relation.source] }}</span>
            <span v-if="d.relation.conflict" class="tag conflict">矛盾</span>
          </span>
        </li>
        <li v-for="d in comparison.directOnlyB" :key="'b' + d.relation.id" class="clickable" @click="locate(d.from, d.to)">
          <span class="grow">
            <span class="tag only">仅「{{ nameOf(bId) }}」</span>
            {{ describe(d.relation) }}
            <span class="tag" :class="d.relation.source">{{ sourceNames[d.relation.source] }}</span>
            <span v-if="d.relation.conflict" class="tag conflict">矛盾</span>
          </span>
        </li>
      </ul>

      <h4>先后结论（传递闭包）差异</h4>
      <p v-if="comparison.closureSame" class="ok small">
        两方案的先后结论完全一致（传递闭包相同）<template v-if="!directSame">；直接边差异不影响先后结论</template>。
      </p>
      <ul v-else class="list">
        <li
          v-for="p in comparison.closureOnlyA"
          :key="'ca' + p.from + p.to"
          class="clickable"
          @click="locate(p.from, p.to)"
        >
          <span class="grow">
            <span class="tag only">仅「{{ nameOf(aId) }}」成立</span>
            {{ unitLabel(p.from) }} 早于 {{ unitLabel(p.to) }}
            <span class="tag" :class="p.direct ? 'direct' : 'transitive'">{{ p.direct ? '直接边' : '传递结论' }}</span>
          </span>
        </li>
        <li
          v-for="p in comparison.closureOnlyB"
          :key="'cb' + p.from + p.to"
          class="clickable"
          @click="locate(p.from, p.to)"
        >
          <span class="grow">
            <span class="tag only">仅「{{ nameOf(bId) }}」成立</span>
            {{ unitLabel(p.from) }} 早于 {{ unitLabel(p.to) }}
            <span class="tag" :class="p.direct ? 'direct' : 'transitive'">{{ p.direct ? '直接边' : '传递结论' }}</span>
          </span>
        </li>
      </ul>
      <p v-if="!comparison.closureSame" class="hint">
        「传递结论」指并非直接边、只因传递闭包变化而新增或失效的先后结论。
      </p>
    </template>
    <p v-else class="muted small">选择两个不同的方案进行对比。</p>
  </section>
</template>

<style scoped>
.compare .row {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}
.vs {
  color: #999;
  flex-shrink: 0;
}
h4 {
  margin: 10px 0 6px;
  font-size: 12px;
  color: #6d5c47;
  border-top: 1px dashed #e3ddd3;
  padding-top: 8px;
}
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: #888;
}
.ok {
  color: #2e7d32;
}
.small {
  font-size: 12px;
}
.muted {
  color: #999;
}
.tag.readonly {
  border-color: #607d8b;
  color: #607d8b;
}
.tag.only {
  border-color: #8d6e63;
  color: #8d6e63;
  margin-left: 0;
  margin-right: 4px;
}
.tag.direct {
  border-color: #607d8b;
  color: #607d8b;
}
.tag.transitive {
  border-color: #ef6c00;
  color: #ef6c00;
  font-weight: 600;
}
.tag.observation {
  border-color: #2e7d32;
  color: #2e7d32;
}
.tag.inference {
  border-color: #ef6c00;
  color: #ef6c00;
}
.tag.conflict {
  border-color: #c62828;
  color: #c62828;
}
.list li.clickable {
  cursor: pointer;
}
.list li.clickable:hover {
  border-color: #ef6c00;
  background: #fff8f0;
}
</style>
