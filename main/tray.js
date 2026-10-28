'use strict';
/**
 * TrayService —— A4 系统托盘
 * 托盘只负责"收集用户意图"，一律转发成 action 事件由渲染进程执行。
 */
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const MODE_LABEL = { learn: '学习', leisure: '休闲', checklist: '清单' };

class TrayService {
  constructor({ persist, router, windowManager, resourceDir }) {
    this.persist = persist;
    this.router = router;
    this.wm = windowManager;
    this.resourceDir = resourceDir;
    this.tray = null;
  }

  create() {
    const iconPath = path.join(this.resourceDir, 'tray.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      image = nativeImage.createEmpty();
    } else {
      image = image.resize({ width: 16, height: 16 });
    }
    this.tray = new Tray(image);
    this.tray.setToolTip('小纸巾 · 学习卷纸桌宠');
    this.tray.on('click', () => {
      this.router.sendAction({ source: 'tray', action: 'toggleVisible' });
    });
    this.refresh();
    return this.tray;
  }

  refresh() {
    if (!this.tray) return;
    const settings = this.persist.get('settings');
    const visible = this.wm ? this.wm.visible : true;
    const mode = settings.currentMode || 'learn';
    const auto = !!(settings.autoTear && settings.autoTear.enabled);

    const menu = Menu.buildFromTemplate([
      {
        label: visible ? '隐藏桌宠' : '显示桌宠',
        click: () => this.router.sendAction({ source: 'tray', action: 'toggleVisible' })
      },
      { type: 'separator' },
      {
        label: '模式',
        submenu: Object.keys(MODE_LABEL).map((m) => ({
          label: MODE_LABEL[m],
          type: 'radio',
          checked: mode === m,
          click: () =>
            this.router.sendAction({ source: 'tray', action: 'switchMode', payload: { mode: m } })
        }))
      },
      {
        label: '回溯上一张',
        enabled: (this.persist.get('torn')[mode] || { stack: [] }).stack.length > 0,
        click: () => this.router.sendAction({ source: 'tray', action: 'backtrack' })
      },
      {
        label: '自动滚落',
        type: 'checkbox',
        checked: auto,
        click: () => this.router.sendAction({ source: 'tray', action: 'toggleAutoTear' })
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.router.sendAction({ source: 'tray', action: 'quit' });
        }
      }
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayService, MODE_LABEL };
