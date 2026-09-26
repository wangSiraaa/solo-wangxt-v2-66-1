/**
 * 测试环境准备：IndexedDB 使用 fake-indexeddb；
 * store 中用到 window.confirm / window.setTimeout 等浏览器全局，这里打桩。
 * 本模块必须在 import store 之前执行。
 */
import 'fake-indexeddb/auto'

const g = globalThis as Record<string, unknown>
g.window = {
  confirm: () => true,
  prompt: () => null,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
}
