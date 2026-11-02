'use strict';
/**
 * EditorWindow —— 清单条目的独立富文本编辑窗口
 *
 * 为什么单开窗口：桌宠窗口只有 500 逻辑像素宽、还带缩放，里面塞一个像 doc 的编辑器
 * 会既挤又容易被纸带手势抢事件。独立窗口可以贴着桌宠摆、可调大小，
 * 保存后只把 HTML 回传给主窗口，数据仍然只有主窗口一份。
 *
 * 尺寸（v2.3）：默认最小号 300×240；用户拉扯过就**记住上次的大小**（settings.editorWindow），
 * 下次打开按上次的尺寸、贴着桌宠摆。一整扇窗就是那张纸，上面一条工具带，
 * 不铺窗口底色、不做纸张卡片。
 */
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const MIN_SIZE = { width: 300, height: 240 };
// 默认就是最小尺寸：没拉扯过时打开不占地方，窗口小、工具带会自己折成两行（不裁字）
const DEFAULT_SIZE = MIN_SIZE;
const GAP = 12;
// 窗口底色 = 纸色：整扇窗就是那张纸，启动瞬间也不会先闪一块灰
const PAPER_BG = { light: '#ffffff', dark: '#111827' };
// 拉扯窗口时不要每 1px 都写一次盘
const SIZE_SAVE_DELAY = 300;

/**
 * 摆位：窗口小，就别压住桌宠的纸面 —— 优先放它左边，左边不够放右边，
 * 两边都放不下（或没有父窗口）才回到屏幕居中。纵向跟父窗口顶部对齐并夹在工作区内。
 */
function placeBeside(parent, area, width, height) {
  const clampY = (v) => Math.max(area.y + 16, Math.min(v, area.y + area.height - height - 16));
  const center = {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + Math.max(16, (area.height - height) / 2 - 24))
  };
  let pb = null;
  try {
    if (parent && !parent.isDestroyed()) pb = parent.getBounds();
  } catch {
    pb = null;
  }
  if (!pb) return center;

  const left = pb.x - width - GAP;
  if (left >= area.x + 8) return { x: Math.round(left), y: Math.round(clampY(pb.y)) };
  const right = pb.x + pb.width + GAP;
  if (right + width <= area.x + area.width - 8) return { x: Math.round(right), y: Math.round(clampY(pb.y)) };

  // 两侧都塞不下（窗口被拉大了，或者副屏很窄）：贴着「空间更大那一侧」的屏幕边，
  // 只压到桌宠最少的一角，而不是傻乎乎居中把它整个盖住
  const leftRoom = pb.x - (area.x + 8);
  const rightRoom = area.x + area.width - 8 - (pb.x + pb.width);
  const edgeX = rightRoom >= leftRoom ? area.x + area.width - width - 8 : area.x + 8;
  const maxX = Math.max(area.x + 8, area.x + area.width - width - 8);
  const x = Math.min(Math.max(edgeX, area.x + 8), maxX);
  return { x: Math.round(x), y: Math.round(clampY(pb.y)) };
}

class EditorWindow {
  constructor({ router, persist, getParent }) {
    this.router = router;
    this.persist = persist || null;
    this.getParent = getParent || (() => null);
    this.win = null;
    this.payload = null;
    // 上一次落盘的尺寸，用来跳过「其实没变」的写入
    this.savedSize = null;
    this.sizeTimer = 0;
  }

  /** 读上次的尺寸：老数据 / 脏数据都退回默认（persist 未就绪时也能开） */
  readSize() {
    let raw = null;
    try {
      raw = this.persist && this.persist.get('settings').editorWindow;
    } catch {
      raw = null;
    }
    return raw || {};
  }

  /**
   * 夹到「不小于最小、不超过当前工作区 92%」：
   * 换了小屏 / 改了缩放之后，上次那个大尺寸不能开出一个比屏幕还大的窗口。
   */
  fitSize(raw, area) {
    const num = (v, d) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    const clamp = (v, min, maxRatio, span) => Math.min(Math.max(min, v), Math.max(min, Math.round(span * maxRatio)));
    return {
      width: clamp(num(raw.width, DEFAULT_SIZE.width), MIN_SIZE.width, 0.92, area.width),
      height: clamp(num(raw.height, DEFAULT_SIZE.height), MIN_SIZE.height, 0.92, area.height)
    };
  }

  /** 记住当前尺寸（最大化时取「还原后」的尺寸，否则会把整屏大小存进去） */
  rememberSize() {
    if (!this.win || this.win.isDestroyed()) return;
    let b = null;
    try {
      b = this.win.isMaximized() ? this.win.getNormalBounds() : this.win.getBounds();
    } catch {
      return;
    }
    if (!b || !b.width || !b.height) return;
    const size = { width: b.width, height: b.height };
    if (this.savedSize && this.savedSize.width === size.width && this.savedSize.height === size.height) return;
    this.savedSize = size;
    if (!this.persist) return;
    try {
      this.persist.patch('settings', { editorWindow: size });
    } catch (err) {
      console.warn('[editor] 窗口尺寸未能保存', err && err.message);
    }
  }

  scheduleSizeSave() {
    clearTimeout(this.sizeTimer);
    this.sizeTimer = setTimeout(() => {
      this.sizeTimer = 0;
      this.rememberSize();
    }, SIZE_SAVE_DELAY);
    if (typeof this.sizeTimer.unref === 'function') this.sizeTimer.unref();
  }

  open(payload) {
    this.payload = Object.assign(
      { listId: '', itemId: '', listName: '清单', html: '', darkMode: false, paper: null },
      payload || {}
    );
    const p = this.payload;
    p.html = String(p.html || '').slice(0, 200000);
    p.listName = String(p.listName || '清单').slice(0, 40);
    p.darkMode = !!p.darkMode;

    if (this.win && !this.win.isDestroyed()) {
      // 已经开着：换内容继续编辑（同一时刻只允许一个编辑窗口）
      this.win.webContents.send('editor:reload', p);
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
      return { reused: true };
    }

    const parent = this.getParent();
    let area = screen.getPrimaryDisplay().workArea;
    try {
      if (parent && !parent.isDestroyed()) area = screen.getDisplayMatching(parent.getBounds()).workArea;
    } catch {
      /* 窗口刚销毁，用主屏兜底 */
    }
    // 尺寸：上次拉多大就开多大（没拉过 = 最小号），再夹进当前工作区
    const size = this.fitSize(this.readSize(), area);
    this.savedSize = size;
    // 贴着桌宠窗口放（优先左边、放不下再右边）：窗口很小，就别挡住纸面
    const { x, y } = placeBeside(parent, area, size.width, size.height);

    this.win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x,
      y,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: '高级编辑',
      backgroundColor: this.payload.darkMode ? PAPER_BG.dark : PAPER_BG.light,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, '..', 'preload-editor.js')
      }
    });
    // 桌宠窗口是 screen-saver 级置顶，编辑窗口必须同级，否则会被压在下面点不到
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'editor.html'));
    this.win.once('ready-to-show', () => {
      if (!this.win || this.win.isDestroyed()) return;
      this.win.show();
      this.win.focus();
    });
    // 拉扯后记住尺寸：拖动过程中防抖，落下 300ms 才写一次盘
    this.win.on('resize', () => this.scheduleSizeSave());
    this.win.on('close', () => {
      // 关窗前把最后一次尺寸落定（此时窗口还没销毁，getBounds 仍然有效）
      clearTimeout(this.sizeTimer);
      this.sizeTimer = 0;
      this.rememberSize();
    });
    this.win.on('closed', () => {
      this.win = null;
      this.payload = null;
    });
    return { reused: false };
  }

  /** 主题跟着纸面走：主窗口切黑夜模式时把编辑窗口一起换掉 */
  setTheme(dark) {
    const v = !!dark;
    if (this.payload) this.payload.darkMode = v;
    if (!this.win || this.win.isDestroyed()) return { applied: false };
    try {
      this.win.setBackgroundColor(v ? PAPER_BG.dark : PAPER_BG.light);
      this.win.webContents.send('editor:theme', { dark: v });
    } catch {
      /* 窗口正在关闭 */
    }
    return { applied: true };
  }

  getPayload() {
    return this.payload;
  }

  /** 保存：只把 html 回传给主窗口（主窗口负责净化并写进 checklists） */
  save(p) {
    if (!this.payload) return { saved: false };
    const html = String((p && p.html) || '');
    this.router.broadcast('checklist:save', {
      listId: this.payload.listId,
      itemId: this.payload.itemId,
      html
    });
    this.close();
    return { saved: true };
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
    this.payload = null;
    return null;
  }

  destroy() {
    clearTimeout(this.sizeTimer);
    this.sizeTimer = 0;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.payload = null;
  }
}

module.exports = { EditorWindow };
