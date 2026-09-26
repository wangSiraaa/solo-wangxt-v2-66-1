<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  branchScheme,
  currentScheme,
  deleteScheme,
  openCompare,
  renameScheme,
  schemeName,
  state,
  switchScheme,
} from '../store'

const newName = ref('')
const compareA = ref('')
const compareB = ref('')

// 刷新后从 IndexedDB 恢复比较选择（不自动弹窗，可一键重新打开）
watch(
  () => [state.compareAId, state.compareBId, state.loaded] as const,
  ([a, b]) => {
    if (a && state.schemes.some((s) => s.id === a)) compareA.value = a
    if (b && state.schemes.some((s) => s.id === b)) compareB.value = b
  },
  { immediate: true },
)

async function submitBranch() {
  const name = newName.value.trim()
  if (!name) return
  const id = await branchScheme(name)
  if (id) newName.value = ''
}

function startRename(id: string, oldName: string) {
  const name = window.prompt('方案名称：', oldName)
  if (name !== null) void renameScheme(id, name)
}

function doCompare() {
  if (compareA.value && compareB.value && compareA.value !== compareB.value) {
    void openCompare(compareA.value, compareB.value)
  }
}

function reopenLast() {
  if (state.compareAId && state.compareBId) void openCompare(state.compareAId, state.compareBId)
}

function derivedLine(from: string | null): string {
  if (!from) return '独立创建'
  return `派生自「${schemeName(from)}」`
}
</script>

<template>
  <section class="panel schemes">
    <h3>解释方案（{{ state.schemes.length }}）</h3>
    <p class="cur-line">当前编辑：<b>{{ currentScheme?.name ?? '—' }}</b></p>
    <ul class="list scheme-list">
      <li v-for="s in state.schemes" :key="s.id" :class="{ selected: s.id === state.currentSchemeId }">
        <span class="grow" @click="void switchScheme(s.id)">
          <b>{{ s.name }}</b>
          <span v-if="s.id === state.currentSchemeId" class="tag cur">编辑中</span>
          <br />
          <small class="muted">{{ derivedLine(s.derivedFrom) }}</small>
        </span>
        <button class="sm" title="重命名" @click="startRename(s.id, s.name)">改名</button>
        <button class="danger sm" title="删除方案（派生方案不受影响）" @click="void deleteScheme(s.id)">删</button>
      </li>
    </ul>
    <form class="form" @submit.prevent="submitBranch">
      <input v-model="newName" placeholder="新方案名称，如：乙记录员意见" />
      <button type="submit">从当前关系集派生方案</button>
      <p class="hint">派生时完整复制当前方案的关系与撤回记录；之后两方案独立增删，互不串扰。</p>
    </form>
    <div class="compare-box">
      <h4>方案语义对比（只读）</h4>
      <div class="row">
        <select v-model="compareA">
          <option value="" disabled>方案 A</option>
          <option v-for="s in state.schemes" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <span>↔</span>
        <select v-model="compareB">
          <option value="" disabled>方案 B</option>
          <option v-for="s in state.schemes" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </div>
      <button :disabled="!compareA || !compareB || compareA === compareB" @click="doCompare">比较两个方案</button>
      <button
        v-if="!state.compareOpen && state.compareAId && state.compareBId"
        class="linklike"
        @click="reopenLast"
      >
        重新打开上次对比（{{ schemeName(state.compareAId) }} ↔ {{ schemeName(state.compareBId) }}）
      </button>
    </div>
  </section>
</template>

<style scoped>
.cur-line {
  margin: 0 0 6px;
  font-size: 12px;
}
.scheme-list li {
  cursor: default;
}
.scheme-list .grow {
  cursor: pointer;
}
.tag.cur {
  background: #e3f2fd;
  color: #1565c0;
}
.compare-box {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #ddd;
}
.compare-box h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.compare-box .row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.compare-box select {
  flex: 1;
  min-width: 0;
}
.linklike {
  background: none;
  border: none;
  color: #1565c0;
  padding: 4px 0;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.hint {
  margin: 4px 0 0;
  font-size: 12px;
  color: #888;
}
</style>
