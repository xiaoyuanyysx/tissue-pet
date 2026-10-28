'use strict';
/**
 * IpcRouter —— 通道集中注册 + 统一错误包装
 * invoke 型：自动 try/catch → IpcResult<T>
 * send 型  ：校验 event.sender 为主窗口
 */
const { ipcMain, BrowserWindow, webContents } = require('electron');

class IpcRouter {
  constructor() {
    this.sendChannels = new Set();
  }

  /** invoke 型注册；handler 可返回纯数据，也可抛 { code, message } 错误 */
  handle(ns, action, handler) {
    const channel = `${ns}:${action}`;
    ipcMain.handle(channel, async (event, payload) => {
      try {
        const data = await handler(payload, event);
        return { ok: true, data: data === undefined ? null : data };
      } catch (err) {
        const code = (err && err.code) || 'E_UNKNOWN';
        const message = (err && err.message) || '操作失败，请稍后再试';
        const detail = err && err.detail;
        if (!err || !err.expected) console.error(`[ipc] ${channel} 失败：`, err);
        return { ok: false, error: { code, message, detail } };
      }
    });
  }

  /** send 型注册（通知型，无返回值） */
  on(ns, action, handler) {
    const channel = `${ns}:${action}`;
    this.sendChannels.add(channel);
    ipcMain.on(channel, (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win !== this.mainWindow) return;
      try {
        handler(payload, event);
      } catch (err) {
        console.error(`[ipc] ${channel} 处理异常：`, err);
      }
    });
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  /** 主→渲染 统一出口（事件型） */
  broadcast(channel, payload) {
    if (!this.mainWindow) return;
    try {
      this.mainWindow.webContents.send(channel, payload);
    } catch {
      /* 窗口可能已销毁 */
    }
  }

  sendAction(ev) {
    this.broadcast('action', ev);
  }

  sendNotice(message, level = 'info') {
    this.broadcast('app:notice', { message, level });
  }
}

module.exports = { IpcRouter };
