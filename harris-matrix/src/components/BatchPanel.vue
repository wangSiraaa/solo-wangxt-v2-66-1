<script setup lang="ts">
import { state } from '../store'

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function scopeLabel(schemeId: string | null): string {
  if (schemeId === null) return '全局'
  if (schemeId === state.currentSchemeId) return '本方案'
  const s = state.schemes.find((x) => x.id === schemeId)
  return s ? s.name : '其他方案'
}
</script>

<template>
  <section class="panel">
    <h3>操作批次（{{ state.batches.length }}）</h3>
    <ul class="list">
      <li v-for="b in [...state.batches].reverse()" :key="b.id" :class="{ undone: b.undone }">
        <span class="grow" :class="{ undone: b.undone }">
          {{ b.label }}
          <span class="tag scope" :class="{ global: b.schemeId === null }">{{ scopeLabel(b.schemeId) }}</span>
          <br />
          <small class="muted">{{ fmtTime(b.at) }}　{{ b.mutations.length }} 项变更</small>
        </span>
        <span v-if="b.undone" class="tag hidden">已撤销</span>
      </li>
      <li v-if="state.batches.length === 0" class="muted">暂无操作</li>
    </ul>
  </section>
</template>

<style scoped>
.undone {
  text-decoration: line-through;
  opacity: 0.6;
}
.tag.scope {
  background: #eceff1;
  color: #455a64;
  font-weight: normal;
}
.tag.scope.global {
  background: #fff3e0;
  color: #e65100;
}
</style>
