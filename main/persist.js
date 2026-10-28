'use strict';
/**
 * PersistService —— A3 持久化框架
 * 分文件 + 原子写 + 分级落盘（critical 即时 / ordinary 防抖 500ms）+ 版本迁移 + 损坏自愈
 */
const fs = require('fs');
const path = require('path');

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
      autoTear: { enabled: false, pxPerSec: 20 },
      shortcuts: defaultShortcuts(),
      windowPos: { displayId: -1, x: null, y: null },
      // 设置中心相对默认位置（右上角）的偏移，拖动后记住
      panelPos: { x: 0, y: 0 }
    },
    learn: {
      currentDictId: 'cet4',
      headEntryIndex: 0,
      hidden: [],
      starred: [],
      shuffle: false,
      roundSeed: 20261025,
      hideDefinition: false
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
  constructor(dir) {
    this.dir = dir;
    this.state = defaultState();
    this.dirty = new Set();
    this.timers = new Map();
    this.warnings = [];
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
    if (!def) throw Object.assign(new Error('非法 scope'), { code: 'E_SCOPE_INVALID' });
    if (!isPlainObject(partial)) throw Object.assign(new Error('非法载荷'), { code: 'E_SCOPE_INVALID' });
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
