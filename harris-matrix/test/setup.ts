/**
 * 测试引导：必须在任何 src 模块（尤其 db.ts 的 Dexie 实例化）求值之前完成安装。
 * 通过 import 顺序保证：本模块在 acceptance.ts 中第一个静态导入。
 */
import Dexie from 'dexie'
import fakeIDB from 'fake-indexeddb'

Dexie.dependencies.indexedDB = fakeIDB.indexedDB
Dexie.dependencies.IDBKeyRange = fakeIDB.IDBKeyRange
;(globalThis as { indexedDB: unknown }).indexedDB = fakeIDB.indexedDB

const noop = () => {}
let confirmResult = true
const promptQueue: string[] = []

globalThis.window = {
  confirm: () => confirmResult,
  alert: noop,
  prompt: () => (promptQueue.length ? promptQueue.shift()! : ''),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  URL,
  Blob,
  document: {
    createElement: () => ({ click: noop, href: '', download: '' }),
  },
} as unknown as Window & typeof globalThis

export function setConfirm(v: boolean) {
  confirmResult = v
}

export function queuePrompt(v: string) {
  promptQueue.push(v)
}

// store 的导出逻辑直接使用全局 document.createElement
;(globalThis as { document?: unknown }).document = {
  createElement: () => ({ click: noop, href: '', download: '' }),
}

export { fakeIDB }
