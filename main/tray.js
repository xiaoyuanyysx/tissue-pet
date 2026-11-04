'use strict';
/**
 * TrayService —— A4 系统托盘
 * 托盘只负责"收集用户意图"，一律转发成 action 事件由渲染进程执行。
 */
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const i18n = require('./i18n');

/** 兼容旧引用：菜单标签一律现取 i18n（语言切换后 refresh() 会重建菜单） */
const MODE_LABEL = {
  get learn() {
    return i18n.t('mode.learn');
  },
  get leisure() {
    return i18n.t('mode.leisure');
  },
  get checklist() {
    return i18n.t('mode.checklist');
  }
};

class TrayService {
  constructor({ persist, router, windowManager, autoLaunch, resourceDir }) {
    this.persist = persist;
    this.router = router;
    this.wm = windowManager;
    this.autoLaunch = autoLaunch || null;
    this.resourceDir = resourceDir;
    this.tray = null;
    // 回溯栈按用户要求只在内存里（重启即空），所以托盘不能用磁盘里的 torn.stack 判断。
    // 渲染层在撕纸/回溯/切模式后通过 tray:syncBacktrack 上报真实深度，这里只做缓存。
    this.depths = { learn: 0, leisure: 0, checklist: 0 };
  }

  /** 渲染层上报「当前模式可回溯几张」 */
  setBacktrackDepth(mode, depth) {
    if (!mode || !(mode in this.depths)) return;
    const n = Math.max(0, Number(depth) || 0);
    if (this.depths[mode] === n) return;
    this.depths[mode] = n;
    this.refresh();
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
    this.tray.setToolTip(i18n.t('tray.tooltip'));
    this.tray.on('click', () => {
      this.router.sendAction({ source: 'tray', action: 'toggleVisible' });
    });
    this.refresh();
    return this.tray;
  }

  /** 托盘里的「开机自启动」：写系统启动项后立刻回读，成败都同步给界面 */
  toggleAutoLaunch() {
    if (!this.autoLaunch) return;
    const cur = this.autoLaunch.status();
    try {
      const st = this.autoLaunch.set(!cur.enabled);
      // 记下用户的选择：程序以后被搬到别的位置，启动时靠它把启动项改到新路径
      this.persist.patch('settings', { autoLaunch: !!st.enabled }, { critical: true });
      this.refresh();
      if (st.blocked) {
        this.router.sendNotice(i18n.t('tray.notice.blocked'), 'warn');
      } else {
        this.router.sendNotice(
          st.enabled ? i18n.t('tray.notice.on') : i18n.t('tray.notice.off'),
          'info'
        );
      }
    } catch (err) {
      this.refresh();
      this.router.sendNotice((err && err.message) || i18n.t('tray.notice.failed'), 'warn');
    }
  }

  refresh() {
    if (!this.tray) return;
    const settings = this.persist.get('settings');
    const visible = this.wm ? this.wm.visible : true;
    const mode = settings.currentMode || 'learn';
    const auto = !!(settings.autoTear && settings.autoTear.enabled);
    this.tray.setToolTip(i18n.t('tray.tooltip'));

    const menu = Menu.buildFromTemplate([
      {
        label: visible ? i18n.t('tray.hide') : i18n.t('tray.show'),
        click: () => this.router.sendAction({ source: 'tray', action: 'toggleVisible' })
      },
      { type: 'separator' },
      {
        label: i18n.t('tray.mode'),
        submenu: Object.keys(MODE_LABEL).map((m) => ({
          label: MODE_LABEL[m],
          type: 'radio',
          checked: mode === m,
          click: () =>
            this.router.sendAction({ source: 'tray', action: 'switchMode', payload: { mode: m } })
        }))
      },
      {
        label: i18n.t('tray.backtrack'),
        enabled: (this.depths[mode] || 0) > 0,
        click: () => this.router.sendAction({ source: 'tray', action: 'backtrack' })
      },
      {
        label: i18n.t('tray.autoTear'),
        type: 'checkbox',
        checked: auto,
        click: () => this.router.sendAction({ source: 'tray', action: 'toggleAutoTear' })
      },
      {
        label: i18n.t('tray.autoLaunch'),
        type: 'checkbox',
        checked: this.autoLaunch ? !!this.autoLaunch.status().enabled : false,
        enabled: this.autoLaunch ? this.autoLaunch.supported : false,
        click: () => this.toggleAutoLaunch()
      },
      { type: 'separator' },
      {
        label: i18n.t('tray.quit'),
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
