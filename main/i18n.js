'use strict';
/**
 * i18n.js —— 主进程文案（托盘、原生窗口标题、系统提示）
 * 与渲染层共用 renderer/js/locales/*.js：同一份词典，主进程 require、界面 <script>，两边各取所需。
 *
 * 语言偏好（settings.locale）取值：'auto' | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'fr'
 * 'auto' 交给 app.getLocale() 解析；拿不到或不认识时回落 en（中文系统回落 zh-CN）。
 */
const { app } = require('electron');

const LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'fr'];
const dicts = {};
// 语言包放在 renderer 里：主进程 require、渲染层 <script> 都读同一份文件，不另存一份副本
for (const l of LANGS) dicts[l] = require(`../renderer/js/locales/${l}.js`);

let pref = 'auto';
let locale = 'zh-CN';
const listeners = new Set();

/** 把系统语言标签（zh-CN / zh-TW / en-US / ja-JP …）收成我们支持的 5 种 */
function normalize(tag) {
  const t = String(tag || '').toLowerCase();
  if (!t) return '';
  if (t.startsWith('zh')) {
    // 繁体：台港澳 + 显式 Hant
    return /hant|tw|hk|mo/.test(t) ? 'zh-TW' : 'zh-CN';
  }
  if (t.startsWith('ja')) return 'ja';
  if (t.startsWith('fr')) return 'fr';
  if (t.startsWith('en')) return 'en';
  return '';
}

function resolve(p) {
  const want = String(p || 'auto');
  if (want !== 'auto') return LANGS.includes(want) ? want : 'en';
  let sys = '';
  try {
    sys = app.getLocale() || app.getSystemLocale() || '';
  } catch {
    sys = '';
  }
  const n = normalize(sys);
  if (n) return n;
  // 系统语言不在支持列表：中文环境仍走中文，其他一律英文
  return /^zh/i.test(sys) ? 'zh-CN' : 'en';
}

function fmt(str, params) {
  if (!params) return str;
  return String(str).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
  );
}

const i18n = {
  LANGS,

  init(p) {
    pref = p || 'auto';
    locale = resolve(pref);
    return locale;
  },

  /** 换语言：只换偏好，解析结果与监听者一起更新 */
  setPref(p) {
    pref = p || 'auto';
    const next = resolve(pref);
    const changed = next !== locale;
    locale = next;
    if (changed) for (const fn of listeners) {
      try {
        fn(locale);
      } catch (err) {
        console.error('[i18n] 监听器异常', err);
      }
    }
    return locale;
  },

  get pref() {
    return pref;
  },
  get locale() {
    return locale;
  },

  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** 取词：当前语种 → 英文 → 中文基准 → key 本身（永远不返回 undefined） */
  t(key, params) {
    const d = dicts[locale] || dicts.en;
    let v = d[key];
    if (v === undefined) v = dicts.en[key];
    if (v === undefined) v = dicts['zh-CN'][key];
    if (v === undefined) return key;
    return typeof v === 'string' ? fmt(v, params) : v;
  }
};

module.exports = i18n;
