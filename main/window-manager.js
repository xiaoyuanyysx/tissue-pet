'use strict';
/**
 * WindowManager —— 窗口 / 穿透 / 置顶 / DPI / 缩放 / 隐藏显示
 */
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const BASE_WIDTH = 500; // 逻辑画布宽度（scale = 1 时）
// 至少要能放下一张纸：顶部留白 210 + 纸高 200 + 底部留白 20
const MIN_LOGICAL_HEIGHT = 440;
// 桌宠本体（卷筒 + 一张纸）在逻辑坐标下占的高度：移动窗口时用它判断能放到多低，
// 不能用「窗口实际高度」，否则窗口为了拉纸长高之后就再也拖不下去了
const CORE_LOGICAL_HEIGHT = 440;
// 窗口顶部有一段透明留白（齿轮 96 / 卷筒 130 才开始有画面）。
// 允许窗口越过屏幕顶边这么多，桌宠本体才能贴到屏幕最上面。
const TOP_INSET = 96;
// 窗口底部至少要留在工作区内的像素（保证还能抓到）
const KEEP_VISIBLE = 48;

class WindowManager {
  constructor({ persist, onVisibleChanged }) {
    this.persist = persist;
    this.onVisibleChanged = onVisibleChanged || (() => {});
    this.win = null;
    this.scale = 1;
    this.logicalHeight = 430;
    this.moveTimer = null;
    this.visible = true;
    this.panelExtra = 0; // 设置面板打开时向右扩展窗口，避免遮挡桌宠
  }

  _width() {
    return Math.round((BASE_WIDTH + this.panelExtra) * this.scale);
  }

  setPanelOpen(open) {
    this.panelExtra = open ? 330 : 0;
    if (!this.win || this.win.isDestroyed()) return this.getBounds();
    const b = this.win.getBounds();
    const w = this._width();
    const h = Math.round(this.logicalHeight * this.scale);
    if (b.width !== w || b.height !== h) {
      this.win.setBounds({ x: b.x, y: b.y, width: w, height: h });
    }
    return this.getBounds();
  }

  create() {
    const settings = this.persist.get('settings');
    this.scale = clamp(Number(settings.scale) || 1, 0.5, 2);
    // 初始高度只是「渲染层报到之前的保守值」，真正的尺寸由渲染层调 resize() 决定：
    // 那边报一个大数，这里按「窗口当前位置到屏幕底部还剩多少」截断 ——
    // 也就是屏幕放得下几张就几张，纸带本身不设张数上限（放不下就滚动）。
    const ph = Number(settings.basePaperHeightPx) || 200;
    this.logicalHeight = Math.max(MIN_LOGICAL_HEIGHT, 230 + ph * 4);

    const width = this._width();
    const height = Math.round(this.logicalHeight * this.scale);
    const pos = this._initialPosition(width, height, settings.windowPos);

    this.win = new BrowserWindow({
      width,
      height,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // 保留可调整能力：无边框窗口用户拖不到边框，但 setSize 更可靠
      resizable: true,
      alwaysOnTop: true,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: path.join(__dirname, '..', 'preload.js')
      }
    });

    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'desk-pet.html'));
    this.win.setIgnoreMouseEvents(true, { forward: true });

    this.win.once('ready-to-show', () => this.win.showInactive());
    this.win.on('blur', () => this.reinforceAlwaysOnTop());
    // 禁止用户手动拉伸（会破坏等比布局），但程序内 setBounds 仍然有效
    this.win.on('will-resize', (e) => e.preventDefault());
    this.win.on('moved', () => this._scheduleSavePos());
    this.win.on('closed', () => {
      this.win = null;
    });
    this.win.on('hide', () => {
      this.visible = false;
      this.onVisibleChanged(false);
    });
    this.win.on('show', () => {
      this.visible = true;
      this.onVisibleChanged(true);
    });

    const hookDisplay = () => {
      this.reinforceAlwaysOnTop();
      this.ensureOnScreen();
    };
    screen.on('display-added', hookDisplay);
    screen.on('display-removed', hookDisplay);
    screen.on('display-metrics-changed', hookDisplay);

    return this.win;
  }

  _initialPosition(width, height, windowPos) {
    let display = screen.getPrimaryDisplay();
    if (windowPos && windowPos.displayId >= 0) {
      const found = screen.getAllDisplays().find((d) => d.id === windowPos.displayId);
      if (found) display = found;
    }
    const wa = display.workArea;
    const minY = this._minY(wa);
    let x = windowPos && Number.isFinite(windowPos.x) ? windowPos.x : wa.x + Math.floor((wa.width - width) / 2);
    let y = windowPos && Number.isFinite(windowPos.y) ? windowPos.y : wa.y;
    x = clamp(x, wa.x - width + KEEP_VISIBLE, wa.x + wa.width - KEEP_VISIBLE);
    y = clamp(y, minY, this._maxY(wa));
    return { x: Math.round(x), y: Math.round(y) };
  }

  /** 允许的最高 y（比工作区顶边再高出一个透明留白，桌宠本体可贴到屏幕最上方） */
  _minY(wa) {
    return wa.y - Math.round(TOP_INSET * this.scale);
  }

  /** 允许的最低 y：按桌宠本体高度算，窗口下面再长也不影响能拖到哪 */
  _maxY(wa) {
    return Math.max(this._minY(wa), wa.y + wa.height - Math.round(CORE_LOGICAL_HEIGHT * this.scale));
  }

  /** 当前窗口位置往下还能长多少（逻辑像素），作为纸带视口的上限 */
  availableLogicalHeight() {
    if (!this.win || this.win.isDestroyed()) return MIN_LOGICAL_HEIGHT;
    const b = this.win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const room = wa.y + wa.height - b.y;
    const logical = Math.floor(room / this.scale);
    return Math.max(MIN_LOGICAL_HEIGHT, Math.min(logical, Math.floor(wa.height / this.scale) + TOP_INSET));
  }

  _scheduleSavePos() {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      const b = this.win.getBounds();
      const display = screen.getDisplayMatching(b);
      this.persist.patch(
        'settings',
        { windowPos: { displayId: display.id, x: b.x, y: b.y } },
        { critical: false }
      );
    }, 400);
  }

  /** 显示器增删/分辨率变化后，把窗口钳回最近的可用工作区（A6） */
  ensureOnScreen() {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const x = clamp(b.x, wa.x - b.width + KEEP_VISIBLE, wa.x + wa.width - KEEP_VISIBLE);
    const y = clamp(b.y, this._minY(wa), this._maxY(wa));
    if (Math.round(x) !== b.x || Math.round(y) !== b.y) {
      this.win.setPosition(Math.round(x), Math.round(y));
    }
  }

  reinforceAlwaysOnTop() {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.win.isAlwaysOnTop()) this.win.setAlwaysOnTop(true, 'screen-saver');
  }

  /**
   * 逻辑高度（未乘缩放）→ 实际窗口像素。
   * 窗口只负责「最多能显示多高」，纸带在渲染层内部滚动，所以尺寸变化只发生在
   * 布局变更 / 缩放 / 移动窗口这些低频时机，拖动时一帧都不会 resize。
   */
  resize(logicalHeight) {
    if (!this.win || this.win.isDestroyed()) return this.availableLogicalHeight();
    const b = this.win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const maxLogical = this.availableLogicalHeight();
    const h = clamp(Math.round(Number(logicalHeight) || MIN_LOGICAL_HEIGHT), MIN_LOGICAL_HEIGHT, maxLogical);
    this.logicalHeight = h;
    const width = this._width();
    const px = Math.round(h * this.scale);

    // 放不下就把整个窗口上移，保证拉出来的纸看得见
    const maxBottom = wa.y + wa.height;
    let y = b.y;
    if (y + px > maxBottom) y = Math.max(this._minY(wa), maxBottom - px);
    const height = Math.min(px, maxBottom - Math.round(y));
    if (b.width === width && b.height === height && Math.round(y) === b.y) return this.availableLogicalHeight();
    this.win.setBounds({ x: b.x, y: Math.round(y), width, height });
    return this.availableLogicalHeight();
  }

  setIgnoreMouse(ignore) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setIgnoreMouseEvents(!!ignore, { forward: true });
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
    this.visible = false;
    this.onVisibleChanged(false);
  }

  show() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.visible = true;
    this.onVisibleChanged(true);
  }

  toggleVisible() {
    if (this.visible) this.hide();
    else this.show();
    return this.visible;
  }

  moveBy(dx, dy) {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const x = clamp(b.x + Math.round(dx), wa.x - b.width + KEEP_VISIBLE, wa.x + wa.width - KEEP_VISIBLE);
    const y = clamp(b.y + Math.round(dy), this._minY(wa), this._maxY(wa));
    this.win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  }

  applyScale(scale) {
    if (!this.win || this.win.isDestroyed()) {
      this.scale = clamp(scale, 0.5, 2);
      return this.getBounds();
    }
    this.scale = clamp(Number(scale) || 1, 0.5, 2);
    const wa = screen.getDisplayMatching(this.win.getBounds()).workArea;
    const width = this._width();
    const maxLogical = Math.floor(wa.height / this.scale);
    const logical = clamp(this.logicalHeight, MIN_LOGICAL_HEIGHT, maxLogical);
    this.logicalHeight = logical;
    this.win.setSize(width, Math.round(logical * this.scale));
    this.reinforceAlwaysOnTop();
    return this.getBounds();
  }

  getBounds() {
    if (!this.win || this.win.isDestroyed()) {
      return { x: 0, y: 0, width: BASE_WIDTH, height: MIN_LOGICAL_HEIGHT, displayId: -1 };
    }
    const b = this.win.getBounds();
    const display = screen.getDisplayMatching(b);
    return { x: b.x, y: b.y, width: b.width, height: b.height, displayId: display.id };
  }

  get webContents() {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }
}

function clamp(v, lo, hi) {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, v));
}

module.exports = { WindowManager, BASE_WIDTH, MIN_LOGICAL_HEIGHT };
