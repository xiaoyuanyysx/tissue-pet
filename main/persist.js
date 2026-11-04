'use strict';
/**
 * PersistService —— A3 持久化框架
 * 分文件 + 原子写 + 分级落盘（critical 即时 / ordinary 防抖 500ms）+ 版本迁移 + 损坏自愈
 */
const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');

const STATE_VERSION = 1;

const FILE_OF = {
  settings: 'settings.json',
  learn: 'learn.json',
  leisure: 'leisure.json',
  checklists: 'checklists.json',
  torn: 'torn.json'
};
const SCOPES = Object.keys(FILE_OF);

function defaultShortcuts() {
  return {
    backtrack: { focused: 'Shift', global: 'Control+Shift+B' },
    // 学习模式：不显示当前词 / 标星当前词（默认只绑聚焦轨，不抢系统热键）
    toggleHidden: { focused: 'Control+Shift+H', global: '' },
    toggleStar: { focused: 'Control+Shift+S', global: '' },
    toggleVisible: { focused: 'Control+Shift+P', global: 'Control+Shift+P' },
    toggleAutoTear: { focused: 'Control+Shift+A', global: 'Control+Shift+A' },
    switchMode: { focused: 'Control+Shift+M', global: 'Control+Shift+M' }
  };
}

function defaultState() {
  return {
    settings: {
      currentMode: 'learn',
      // 界面语言：'auto'（跟随系统）| 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'fr'
      locale: 'auto',
      scale: 1.0,
      basePaperWidthPx: 170,
      basePaperHeightPx: 200,
      fontSizePx: 15,
      darkMode: false,
      scaleCornerEnabled: true,
      tearThresholdPages: 2,
      maxBacktrack: 10,
      // 「最多保留 N 张可回溯」提示：每次启动最多提示一次，可在此关闭
      notifyBacktrackLimit: true,
      // 清单循环浏览：纸带无限，拉到底接回第一页（与单词模式的轮次一致）
      checklistLoop: true,
      // 清单自动序号：按添加顺序在纸面上标 1. 2. 3.
      checklistNumbering: false,
      // 清单不撕纸：默认开（清单的纸只是同一个清单的分页视图，撕掉就看不见开头几条）；
      // 关掉后按「撕纸阈值」一张张撕，和单词模式一致
      checklistNoTear: true,
      // 清单定时清除：每天到点把**在纸面上**做的标记（勾选 / 右键设的加粗、颜色、划线）清掉。
      // lastDate 记「最后一次自动清除的日期」，用来保证同一天只清一次；
      // enabledAt 记「打开这个开关的时刻」，用来避免「刚开启就被立刻清空」。
      checklistAutoClear: {
        enabled: false,
        time: '06:00',
        // done = 只取消勾选；page = 只清纸面上设的格式（高级编辑里的排版、随记都不动）
        scope: 'page',
        lastDate: '',
        enabledAt: 0
      },
      // 设置面板里的数量括号：关掉后「今日目标（0）」只显示「今日目标」
      showCounts: true,
      // 功能说明窗口：第一次使用自动弹一次，弹完记 true（设置 → 通用 里可随时再看）
      guideShown: false,
      autoTear: { enabled: false, pxPerSec: 20 },
      shortcuts: defaultShortcuts(),
      windowPos: { displayId: -1, x: null, y: null },
      // 设置中心相对默认位置（右上角）的偏移，拖动后记住
      panelPos: { x: 0, y: 0 },
      // 高级编辑窗口上次被拉到多大（默认就是最小号 300×240）
      editorWindow: { width: 300, height: 240 },
      // 开机自启动的「用户意图」：勾没勾这一项。
      // 真实状态永远以系统启动项为准（见 main/auto-launch.js），这份只是为了
      // 程序被搬到别的位置之后，下次启动能把启动项改写到新路径。
      autoLaunch: false
    },
    learn: {
      currentDictId: 'cet4',
      headEntryIndex: 0,
      // 不显示 / 标星按「语言」分组：{ en: ['book'], ja: [...] }
      // 同一语言的不同词库共用一套（四级和雅思的英文词互认），不同语言互不影响
      hidden: {},
      starred: {},
      shuffle: false,
      roundSeed: 20261025,
      hideDefinition: false,
      // 手选的语言对：{ cet4: { word: '英语', def: '中文' } }
      // 导入后可随时改，主进程以它为准（优先于自动识别），释义语言决定纸面显示哪种释义
      dictLang: {}
    },
    leisure: {
      activeDocId: null,
      docs: [],
      progress: {}
    },
    checklists: {
      activeListId: 'default',
      lists: [
        { id: 'default', name: '今日目标', createdAt: Date.now(), items: [] }
      ]
    },
    torn: {
      learn: { headIndex: 0, stack: [] },
      leisure: { headIndex: 0, stack: [] },
      checklist: { headIndex: 0, stack: [] }
    }
  };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 用默认值补齐缺失字段（数组/标量直接取用户值） */
function fillDefaults(target, def) {
  const out = Array.isArray(def) ? [] : {};
  if (Array.isArray(def)) {
    return Array.isArray(target) ? target : def.slice();
  }
  for (const k of Object.keys(def)) {
    const dv = def[k];
    const tv = isPlainObject(target) ? target[k] : undefined;
    if (isPlainObject(dv)) out[k] = fillDefaults(tv, dv);
    else if (tv === undefined) out[k] = Array.isArray(dv) ? dv.slice() : dv;
    else out[k] = tv;
  }
  // 保留用户自定义的附加字段（未来版本兼容）
  if (isPlainObject(target)) {
    for (const k of Object.keys(target)) if (!(k in out)) out[k] = target[k];
  }
  return out;
}

class PersistService {
  /**
   * @param {string} dir userData 目录
   * @param {{ langOfDict?: (dictId: string) => string }} [opts]
   *   langOfDict 用于把老版本的「全局 hidden/starred 数组」迁移到当前词库所属语言下
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.langOfDict = typeof opts.langOfDict === 'function' ? opts.langOfDict : () => 'unknown';
    this.state = defaultState();
    this.dirty = new Set();
    this.timers = new Map();
    this.warnings = [];
    this.migrated = new Set();
  }

  init() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const def = defaultState();
    for (const scope of SCOPES) {
      const loaded = this._readScope(scope, def[scope]);
      this.state[scope] = loaded;
    }
    // 结构迁移（learn.hidden 数组 → 按语言分组）只在内存生效会把旧结构留在盘上，
    // 导致每次启动重复迁移；这里把结果落盘一次
    for (const scope of this.migrated) {
      try {
        this._write(scope);
      } catch {
        /* 写失败不影响本次运行 */
      }
    }
    return this;
  }

  _fileOf(scope) {
    return path.join(this.dir, FILE_OF[scope]);
  }

  _parseFile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return this._migrate(parsed);
  }

  _migrate(parsed) {
    // v0（无 version/data 包装）→ v1
    let version = 0;
    let data = parsed;
    if (parsed && typeof parsed.version === 'number' && parsed.data) {
      version = parsed.version;
      data = parsed.data;
    }
    if (version < STATE_VERSION) {
      // 迁移链预留：当前只有 v0 → v1（结构兼容，仅补默认字段）
      version = STATE_VERSION;
    }
    return { version, data: isPlainObject(data) ? data : {} };
  }

  _readScope(scope, def) {
    const file = this._fileOf(scope);
    let parsed = null;
    try {
      parsed = this._parseFile(file);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // 损坏 → 尝试 bak
        try {
          parsed = this._parseFile(file + '.bak');
          this.warnings.push(`「${FILE_OF[scope]}」损坏，已从备份恢复`);
        } catch {
          this.warnings.push(`「${FILE_OF[scope]}」损坏且备份不可用，已重置为默认值`);
          parsed = null;
        }
      }
    }
    if (!parsed) return this._finalize(scope, fillDefaults({}, def), {});
    return this._finalize(scope, fillDefaults(parsed.data, def), parsed.data);
  }

  /** 版本迁移收尾（只做数据修补，不改结构）；raw 是磁盘上的原始内容，用于判断「是否老字段」 */
  _finalize(scope, data, raw) {
    if (scope === 'settings' && data.autoTear) {
      const a = data.autoTear;
      const rawAuto = (raw && raw.autoTear) || {};
      // v1 用「张/分」，现改为「px/秒」连续滚动速度：按纸高换算（pagesPerMin * 纸高 / 60）
      if (rawAuto.pxPerSec == null && rawAuto.pagesPerMin != null) {
        const h = Number(raw.basePaperHeightPx) || Number(data.basePaperHeightPx) || 200;
        a.pxPerSec = Math.round((Number(rawAuto.pagesPerMin) * h) / 6) / 10;
      }
      a.pxPerSec = Math.min(200, Math.max(2, Number(a.pxPerSec) || 20));
      a.enabled = !!a.enabled;
    }
    if (scope === 'learn') {
      // 老版本：hidden / starred 是「全应用一份」的数组，换词库会串。
      // 新结构按语言分组，这里把旧数组整体归到当前词库所属语言下（不丢数据）。
      const lang = this.langOfDict(String(data.currentDictId || 'cet4'));
      for (const key of ['hidden', 'starred']) {
        const old = raw && raw[key];
        if (Array.isArray(old)) {
          const words = old.filter((w) => typeof w === 'string' && w);
          data[key] = words.length ? { [lang]: words } : {};
          // 语言都判不出来（词库文件不在场）时先别落盘：保留旧结构，等下次能用上真实词库再迁移
          if (lang !== 'unknown') this.migrated.add(scope);
          if (words.length) {
            this.warnings.push(
              `「${key === 'hidden' ? '不显示词' : '标星词'}」已改为按语言分组，${words.length} 条旧记录归入当前词库的语言`
            );
          }
        } else if (!isPlainObject(data[key])) {
          data[key] = {};
        } else {
          const clean = {};
          for (const k of Object.keys(data[key])) {
            if (Array.isArray(data[key][k])) clean[k] = data[key][k].filter((w) => typeof w === 'string' && w);
          }
          data[key] = clean;
        }
      }
    }
    return data;
  }

  get(scope) {
    return this.state[scope];
  }

  getAll() {
    return {
      version: STATE_VERSION,
      settings: this.state.settings,
      learn: this.state.learn,
      leisure: this.state.leisure,
      checklists: this.state.checklists,
      torn: this.state.torn
    };
  }

  /** 只允许该 scope 已定义的字段，未知字段丢弃并告警 */
  patch(scope, partial, opts = {}) {
    const def = defaultState()[scope];
    if (!def) throw Object.assign(new Error(i18n.t('error.scopeInvalid')), { code: 'E_SCOPE_INVALID' });
    if (!isPlainObject(partial)) throw Object.assign(new Error(i18n.t('error.payloadInvalid')), { code: 'E_SCOPE_INVALID' });
    const target = this.state[scope];
    for (const key of Object.keys(partial)) {
      if (!(key in def)) {
        console.warn(`[persist] 未知字段已丢弃：${scope}.${key}`);
        continue;
      }
      const val = partial[key];
      if (isPlainObject(val) && isPlainObject(def[key])) {
        target[key] = Object.assign({}, target[key], val);
      } else {
        target[key] = val;
      }
    }
    this.dirty.add(scope);
    if (opts.critical) {
      this._cancelTimer(scope);
      this._write(scope);
    } else {
      this._schedule(scope);
    }
    return null;
  }

  /** 把某个分区整体恢复成默认值并立即落盘（清空全部数据 = 对 5 个分区各调一次） */
  reset(scope) {
    const def = defaultState()[scope];
    if (!def) throw Object.assign(new Error(i18n.t('error.scopeInvalid')), { code: 'E_SCOPE_INVALID' });
    this._cancelTimer(scope);
    this.state[scope] = JSON.parse(JSON.stringify(def));
    this.dirty.add(scope);
    this._write(scope);
    return this.state[scope];
  }

  _cancelTimer(scope) {
    const t = this.timers.get(scope);
    if (t) {
      clearTimeout(t);
      this.timers.delete(scope);
    }
  }

  _schedule(scope) {
    this._cancelTimer(scope);
    const timer = setTimeout(() => {
      this.timers.delete(scope);
      this._write(scope);
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(scope, timer);
  }

  /** 原子写：tmp → bak → rename */
  _write(scope) {
    const file = this._fileOf(scope);
    const tmp = file + '.tmp';
    const bak = file + '.bak';
    const payload = JSON.stringify(
      { version: STATE_VERSION, data: this.state[scope] },
      null,
      2
    );
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, payload, 'utf8');
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, bak);
      } catch {
        /* bak 失败不影响主写入 */
      }
      fs.renameSync(tmp, file);
      this.dirty.delete(scope);
    } catch (err) {
      console.error('[persist] 写入失败', file, err);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  flush() {
    for (const scope of [...this.dirty]) {
      this._cancelTimer(scope);
      this._write(scope);
    }
  }
}

module.exports = { PersistService, defaultState, defaultShortcuts, SCOPES, STATE_VERSION };
