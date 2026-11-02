'use strict';
/**
 * preload —— 仅暴露 window.petAPI 白名单方法（不泄露 ipcRenderer 原对象）
 * 请求-响应型统一返回 IpcResult<T>：{ ok:true, data } | { ok:false, error }
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const send = (channel, payload) => ipcRenderer.send(channel, payload);

const api = {
  /* ---- 窗口 ---- */
  close: () => send('win:close'),
  resize: (height) => send('win:resize', { height }),
  setIgnoreMouseEvents: (ignore) => send('win:setIgnoreMouse', { ignore }),
  hide: () => invoke('win:hide'),
  show: () => invoke('win:show'),
  toggleVisible: () => invoke('win:toggleVisible'),
  moveBy: (dx, dy) => send('win:moveBy', { dx, dy }),
  applyScale: (scale) => invoke('win:applyScale', { scale }),
  getBounds: () => invoke('win:getBounds'),
  setPanel: (open) => invoke('win:setPanel', { open }),

  /* ---- 持久化 ---- */
  storeGet: () => invoke('store:get'),
  storePatch: (scope, partial, opts) =>
    invoke('store:patch', { scope, partial, critical: !!(opts && opts.critical) }),
  storeReset: (scope) => invoke('store:reset', { scope }),

  /* ---- 托盘状态同步（内存态，非持久化） ---- */
  traySyncBacktrack: (mode, depth) => send('tray:syncBacktrack', { mode, depth }),

  /* ---- 导入 ---- */
  importPickFile: (mode) => invoke('import:pickFile', { mode }),
  importParse: (filePath, mode) => invoke('import:parse', { filePath, mode }),
  importCommitDict: (opts) => invoke('import:commitDict', opts),

  /* ---- 文档 ---- */
  docList: () => invoke('doc:list'),
  docGetBlocks: (docId, offset, count) => invoke('doc:getBlocks', { docId, offset, count }),
  docRemove: (docId) => invoke('doc:remove', { docId }),

  /* ---- 词库 ---- */
  dictListBuiltin: () => invoke('dict:listBuiltin'),
  dictListImported: () => invoke('dict:listImported'),
  dictListAll: () => invoke('dict:listAll'),
  dictGetEntries: (dictId, offset, count) => invoke('dict:getEntries', { dictId, offset, count }),
  dictRemove: (dictId) => invoke('dict:remove', { dictId }),
  dictSetLang: (dictId, wordLang, defLang) => invoke('dict:setLang', { dictId, wordLang, defLang }),

  /* ---- 快捷键 ---- */
  shortcutSet: (action, accelerator, scope) => invoke('shortcut:set', { action, accelerator, scope }),
  shortcutGetAll: () => invoke('shortcut:getAll'),
  shortcutCaptureHint: () => send('shortcut:captureHint'),
  shortcutSetEditing: (editing) => send('shortcut:editing', { editing }),

  /* ---- 清单富文本编辑（独立窗口） ---- */
  editorOpen: (payload) => invoke('editor:open', payload || {}),
  /** 主题跟着纸面走：编辑器开着时切黑夜模式，窗口里的纸也要立刻变黑 */
  editorTheme: (dark) => send('editor:theme', { dark: !!dark }),

  /* ---- 应用 ---- */
  quitApp: () => send('app:quit'),
  openUserData: () => invoke('app:openUserData'),
  appInfo: () => invoke('app:info'),

  /* ---- 事件流 ---- */
  onAction(cb) {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on('action', handler);
    return () => ipcRenderer.removeListener('action', handler);
  },
  onNotice(cb) {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on('app:notice', handler);
    return () => ipcRenderer.removeListener('app:notice', handler);
  },
  /** 独立编辑窗口保存后回传（主进程转发，不直接读写磁盘） */
  onChecklistSave(cb) {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on('checklist:save', handler);
    return () => ipcRenderer.removeListener('checklist:save', handler);
  }
};

// 分组别名（可读性更好，等价于上面的扁平方法）
api.window = {
  close: api.close,
  resize: api.resize,
  setIgnoreMouseEvents: api.setIgnoreMouseEvents,
  hide: api.hide,
  show: api.show,
  toggleVisible: api.toggleVisible,
  moveBy: api.moveBy,
  applyScale: api.applyScale,
  getBounds: api.getBounds,
  setPanel: api.setPanel
};
api.store = { get: api.storeGet, patch: api.storePatch, reset: api.storeReset };
api.doc = { list: api.docList, getBlocks: api.docGetBlocks, remove: api.docRemove };
api.dict = {
  listBuiltin: api.dictListBuiltin,
  listImported: api.dictListImported,
  listAll: api.dictListAll,
  getEntries: api.dictGetEntries,
  remove: api.dictRemove,
  setLang: api.dictSetLang
};
api.shortcut = { set: api.shortcutSet, getAll: api.shortcutGetAll, captureHint: api.shortcutCaptureHint };
api.importer = {
  pickFile: api.importPickFile,
  parse: api.importParse,
  commitDict: api.importCommitDict
};

contextBridge.exposeInMainWorld('petAPI', api);

// 兼容旧名（现有 desk-pet.html 曾用 window.electronAPI）
contextBridge.exposeInMainWorld('electronAPI', {
  close: api.close,
  resizeWindow: api.resize,
  setIgnoreMouseEvents: api.setIgnoreMouseEvents
});
