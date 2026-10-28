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

  /* ---- 快捷键 ---- */
  shortcutSet: (action, accelerator, scope) => invoke('shortcut:set', { action, accelerator, scope }),
  shortcutGetAll: () => invoke('shortcut:getAll'),
  shortcutCaptureHint: () => send('shortcut:captureHint'),
  shortcutSetEditing: (editing) => send('shortcut:editing', { editing }),

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
api.store = { get: api.storeGet, patch: api.storePatch };
api.doc = { list: api.docList, getBlocks: api.docGetBlocks, remove: api.docRemove };
api.dict = {
  listBuiltin: api.dictListBuiltin,
  listImported: api.dictListImported,
  listAll: api.dictListAll,
  getEntries: api.dictGetEntries,
  remove: api.dictRemove
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
