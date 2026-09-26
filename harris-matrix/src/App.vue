<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import MatrixCanvas from './components/MatrixCanvas.vue'
import UnitPanel from './components/UnitPanel.vue'
import RelationPanel from './components/RelationPanel.vue'
import BatchPanel from './components/BatchPanel.vue'
import ComparePanel from './components/ComparePanel.vue'
import {
  autoLayout,
  cancelCycle,
  clearAll,
  confirmCycle,
  currentScheme,
  deleteScheme,
  deriveScheme,
  exportProject,
  importProject,
  lastBatch,
  loadSample,
  redundantIds,
  refresh,
  renameScheme,
  setCurrentScheme,
  state,
  undo,
  unitLabel,
} from './store'

const fileInput = ref<HTMLInputElement>()

const cyclePathText = computed(() => state.pendingCycle?.path.map(unitLabel).join(' → ') ?? '')

/** 当前方案的来源说明：来源被删除时仍显示名称快照 */
const sourceText = computed(() => {
  const s = currentScheme.value
  if (!s) return ''
  if (!s.sourceSchemeId) return '初始方案'
  const src = state.schemes.find((x) => x.id === s.sourceSchemeId)
  return src ? `派生自「${src.name}」` : `派生自「${s.sourceSchemeName ?? '未知'}」（已删除）`
})

onMounted(() => {
  void refresh()
})

function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) void importProject(file)
  if (fileInput.value) fileInput.value.value = ''
}

function onSwitchScheme(e: Event) {
  void setCurrentScheme((e.target as HTMLSelectElement).value)
}

function onDeriveScheme() {
  const name = window.prompt(
    '新方案名称（将复制当前方案的全部关系，之后两个方案的增删互不影响）：',
    currentScheme.value ? `${currentScheme.value.name}·分支` : '',
  )
  if (name !== null) void deriveScheme(name)
}

function onRenameScheme() {
  const s = currentScheme.value
  if (!s) return
  const name = window.prompt('方案重命名：', s.name)
  if (name !== null) void renameScheme(s.id, name)
}

function onDeleteScheme() {
  const s = currentScheme.value
  if (s) void deleteScheme(s.id)
}
</script>

<template>
  <div class="app">
    <header class="toolbar">
      <h1>地层矩阵编辑台</h1>
      <div class="view-toggle" role="tablist">
        <button :class="{ on: state.viewMode === 'raw' }" @click="state.viewMode = 'raw'">原始关系</button>
        <button :class="{ on: state.viewMode === 'simplified' }" @click="state.viewMode = 'simplified'">
          简化视图
        </button>
      </div>
      <span v-if="state.viewMode === 'simplified'" class="muted small">
        已隐藏 {{ redundantIds.size }} 条传递边（原始记录保留）
      </span>
      <span class="spacer"></span>
      <button @click="autoLayout">自动分层排布</button>
      <button :disabled="!lastBatch" :title="lastBatch ? `撤销：${lastBatch.label}` : '没有可撤销的操作'" @click="undo">
        撤销{{ lastBatch ? `：${lastBatch.label}` : '' }}
      </button>
      <button @click="loadSample">载入示例</button>
      <button @click="exportProject" :disabled="state.units.length === 0">导出工程</button>
      <button @click="fileInput?.click()">导入…</button>
      <input ref="fileInput" type="file" accept="application/json" hidden @change="onImportFile" />
      <button class="danger" @click="clearAll()">清空</button>
    </header>

    <div class="scheme-toolbar">
      <span class="scheme-title">解释方案</span>
      <select :value="state.currentSchemeId ?? ''" :disabled="state.schemes.length === 0" @change="onSwitchScheme">
        <option v-for="s in state.schemes" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <button :disabled="!currentScheme" @click="onDeriveScheme">从当前派生…</button>
      <button :disabled="!currentScheme" @click="onRenameScheme">重命名</button>
      <button class="danger" :disabled="state.schemes.length <= 1" @click="onDeleteScheme">删除方案</button>
      <button
        :class="{ on: state.compareOpen }"
        :disabled="state.schemes.length < 2"
        title="对比两个方案的直接边与传递闭包差异（只读）"
        @click="state.compareOpen = !state.compareOpen"
      >
        语义对比
      </button>
      <span v-if="currentScheme" class="muted small">来源：{{ sourceText }}</span>
      <span v-else class="muted small">暂无方案，添加关系时将自动创建默认方案</span>
    </div>

    <main class="main">
      <aside class="sidebar">
        <ComparePanel v-if="state.compareOpen" />
        <UnitPanel />
        <RelationPanel />
        <BatchPanel />
      </aside>
      <MatrixCanvas />
    </main>

    <footer class="statusbar">
      数据仅保存于本机浏览器 IndexedDB，不上传任何现场资料。解释方案按关系集分支，可独立编辑与语义对比；层位、证据与画布位置为各方案共享；撤销以批次为单位。
    </footer>

    <!-- 成环确认对话框：给出完整环路径 -->
    <div v-if="state.pendingCycle" class="modal-mask" @click.self="cancelCycle">
      <div class="modal">
        <h3>该关系将构成环</h3>
        <p>新增此先后关系后，将形成如下循环：</p>
        <p class="cycle-path">{{ cyclePathText }}</p>
        <p>这通常意味着两条记录互相矛盾。可以保留为矛盾记录（标红显示，不删除任何原始观察），或取消本次添加。</p>
        <div class="modal-actions">
          <button class="danger" @click="confirmCycle">保留为矛盾记录</button>
          <button @click="cancelCycle">取消</button>
        </div>
      </div>
    </div>

    <div v-if="state.toast" class="toast">{{ state.toast }}</div>
  </div>
</template>
