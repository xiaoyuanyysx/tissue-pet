'use strict';
/**
 * preload-editor —— 独立编辑窗口的桥
 * 只暴露编辑所需的四个方法，不泄露 ipcRenderer。
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('editorAPI', {
  /** 当前要编辑的内容（主进程暂存，窗口重开时也能拿到） */
  payload: () => invoke('editor:payload'),
  /** 保存：把 HTML 交回主进程 → 主窗口净化后写入清单 */
  save: (html) => invoke('editor:save', { html }),
  /** 取消 / 关闭 */
  close: () => invoke('editor:close'),
  /** 已经开着的窗口被再次调用时，主进程推新内容过来 */
  onReload(cb) {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('editor:reload', handler);
    return () => ipcRenderer.removeListener('editor:reload', handler);
  },
  /** 主窗口切黑夜模式 → 编辑窗口跟着换主题 */
  onTheme(cb) {
    const handler = (_e, p) => cb(p && p.dark);
    ipcRenderer.on('editor:theme', handler);
    return () => ipcRenderer.removeListener('editor:theme', handler);
  }
});
