'use strict';
/**
 * ShortcutService —— A5 快捷键双轨
 * 全局轨：globalShortcut（失焦/隐藏时生效，必须是合法组合键）
 * 聚焦轨：before-input-event（窗口聚焦时拦截，支持单独 Shift 等任意键）
 */
const { globalShortcut } = require('electron');

const ACTIONS = [
  'backtrack',
  'toggleHidden',
  'toggleStar',
  'toggleVisible',
  'toggleAutoTear',
  'switchMode'
];

const MOD_ALIASES = {
  control: 'Control',
  ctrl: 'Control',
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  command: 'Command',
  cmd: 'Command',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super'
};

function isModifier(token) {
  return !!MOD_ALIASES[String(token).toLowerCase()];
}

/** 'ctrl+shift+p' → { mods:['Control','Shift'], key:'P' } */
function parseAccelerator(acc) {
  if (typeof acc !== 'string' || !acc.trim()) return null;
  const tokens = acc.split('+').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return null;
  const mods = [];
  const keys = [];
  for (const t of tokens) {
    const alias = MOD_ALIASES[t.toLowerCase()];
    if (alias) mods.push(alias);
    else keys.push(t);
  }
  if (!keys.length) return { mods, key: '', modifierOnly: true };
  return { mods, key: keys[keys.length - 1], modifierOnly: false };
}

function canonical(acc) {
  const p = parseAccelerator(acc);
  if (!p) return '';
  const order = ['Control', 'CommandOrControl', 'Command', 'Alt', 'AltGr', 'Shift', 'Super'];
  const mods = [...new Set(p.mods)]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .join('+');
  const key = p.key ? p.key.toUpperCase() : '';
  return mods ? `${mods}+${key}` : key;
}

function toElectronAccelerator(acc) {
  const p = parseAccelerator(acc);
  if (!p || p.modifierOnly) return null;
  return [...new Set(p.mods), p.key].join('+');
}

function validateGlobal(acc) {
  const p = parseAccelerator(acc);
  if (!p || p.modifierOnly) {
    throw mkErr('E_SHORTCUT_INVALID', '全局快捷键必须包含普通按键（如字母/数字）');
  }
  if (!p.mods.length) {
    throw mkErr('E_SHORTCUT_INVALID', '全局快捷键必须包含修饰键（Ctrl/Alt/Shift）');
  }
  if (p.key.length > 12) {
    throw mkErr('E_SHORTCUT_INVALID', '无法识别的按键');
  }
  return toElectronAccelerator(acc);
}

function mkErr(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  e.expected = true;
  return e;
}

class ShortcutService {
  constructor({ persist, router }) {
    this.persist = persist;
    this.router = router;
    this.map = null;
    this.registered = new Map(); // action -> accelerator(global)
    this.captureUntil = 0;
    this.editing = false;
  }

  /** 渲染层输入框获得焦点时，不再拦截按键（避免打字触发动作） */
  setEditing(v) {
    this.editing = !!v;
  }

  _load() {
    const s = this.persist.get('settings').shortcuts || {};
    const map = {};
    for (const action of ACTIONS) {
      const v = s[action] || {};
      map[action] = {
        focused: typeof v.focused === 'string' ? v.focused : '',
        global: typeof v.global === 'string' ? v.global : ''
      };
    }
    this.map = map;
    return map;
  }

  registerAll() {
    const map = this._load();
    const failures = [];
    for (const action of ACTIONS) {
      const acc = map[action].global;
      if (!acc) continue;
      if (!this._registerGlobal(action, acc)) {
        failures.push({ action, accelerator: acc });
      }
    }
    return failures;
  }

  _registerGlobal(action, acc) {
    try {
      const el = validateGlobal(acc);
      globalShortcut.unregister(el);
      const ok = globalShortcut.register(el, () => this.emit(action, 'shortcut'));
      if (ok) {
        this.registered.set(action, acc);
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[shortcut] 全局注册失败', action, acc, err.message);
      return false;
    }
  }

  _unregisterGlobal(action) {
    const cur = this.registered.get(action);
    if (!cur) return;
    try {
      const el = toElectronAccelerator(cur);
      if (el) globalShortcut.unregister(el);
    } catch {
      /* ignore */
    }
    this.registered.delete(action);
  }

  getAll() {
    if (!this.map) this._load();
    return JSON.parse(JSON.stringify(this.map));
  }

  set(action, accelerator, scope) {
    if (!ACTIONS.includes(action)) throw mkErr('E_SCOPE_INVALID', '未知的快捷键动作');
    if (scope !== 'focused' && scope !== 'global') throw mkErr('E_SCOPE_INVALID', '未知的快捷键轨');
    const next = String(accelerator || '').trim();
    if (!next) {
      // 仅聚焦轨允许清空（表示不绑定）
      if (scope !== 'focused') throw mkErr('E_SHORTCUT_INVALID', '全局快捷键不能为空');
      this.map[action].focused = '';
      this.persist.patch('settings', { shortcuts: this.getAll() }, { critical: true });
      return null;
    }

    const canonicalNext = canonical(next);
    for (const other of ACTIONS) {
      if (other === action) continue;
      const cur = this.map[other][scope];
      if (cur && canonical(cur) === canonicalNext) {
        throw mkErr('E_SHORTCUT_CONFLICT', `该组合键已被「${labelOf(other)}」占用`, {
          conflictWith: other
        });
      }
    }

    if (scope === 'global') {
      validateGlobal(next);
      const prev = this.map[action].global;
      this._unregisterGlobal(action);
      if (!this._registerGlobal(action, next)) {
        if (prev) this._registerGlobal(action, prev);
        throw mkErr('E_SHORTCUT_INVALID', '该快捷键无法注册（可能已被系统或其他软件占用）');
      }
    }

    this.map[action][scope] = next;
    this.persist.patch('settings', { shortcuts: this.getAll() }, { critical: true });
    return null;
  }

  /** 录键期间暂停拦截 */
  pauseForCapture(ms = 2500) {
    this.captureUntil = Date.now() + ms;
  }

  handleBeforeInput(input) {
    if (!this.map) this._load();
    if (this.editing) return false;
    if (Date.now() < this.captureUntil) return false;
    if (input.type !== 'keyDown' || input.isAutoRepeat) return false;

    for (const action of ACTIONS) {
      const acc = this.map[action].focused;
      if (!acc) continue;
      if (matchInput(acc, input)) {
        this.emit(action, 'key');
        return true;
      }
    }
    return false;
  }

  emit(action, source, payload) {
    this.router.sendAction({ source, action, payload });
  }

  dispose() {
    for (const action of ACTIONS) this._unregisterGlobal(action);
  }
}

function matchInput(acc, input) {
  const p = parseAccelerator(acc);
  if (!p) return false;
  const mods = new Set(p.mods.map((m) => (m === 'CommandOrControl' ? 'Control' : m)));
  const wantsCtrl = mods.has('Control');
  const wantsShift = mods.has('Shift');
  const wantsAlt = mods.has('Alt') || mods.has('AltGr');
  const wantsSuper = mods.has('Super') || mods.has('Command');
  if (!!input.control !== wantsCtrl) return false;
  if (!!input.alt !== wantsAlt) return false;
  if (!!input.meta !== wantsSuper) return false;
  if (p.modifierOnly) {
    // 单独修饰键：要求该键自身被按下且没有其他修饰键
    const only = p.mods.length === 1 ? p.mods[0] : '';
    if (!only) return false;
    if (only === 'Shift') return input.key === 'Shift' && !!input.shift && !input.control && !input.alt && !input.meta;
    return false;
  }
  if (!!input.shift !== wantsShift) return false;
  const key = String(input.key || '');
  const want = p.key;
  if (key.toLowerCase() === want.toLowerCase()) return true;
  // 特殊键名映射
  const alias = { ' ': 'Space', esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter' };
  const k = key.toLowerCase();
  if (alias[k] && alias[k].toLowerCase() === want.toLowerCase()) return true;
  return false;
}

function labelOf(action) {
  return (
    {
      backtrack: '回溯上一张纸',
      toggleHidden: '不显示当前词',
      toggleStar: '标星当前词',
      toggleVisible: '隐藏/显示',
      toggleAutoTear: '自动滚落开关',
      switchMode: '切换模式'
    }[action] || action
  );
}

module.exports = { ShortcutService, ACTIONS, canonical, parseAccelerator, labelOf };
