/* i18n.js —— 渲染层文案
 *
 * 词典来自 renderer/js/locales/*.js（同一份文件主进程 require、这里 <script> 加载），
 * 所以托盘、原生窗口标题和界面上的字永远是同一套说法。
 *
 * 用法：
 *   NS.t('settings.title')                 → 取词
 *   NS.t('toast.autoTear.on', { v: 20 })   → 插值 {v}
 *   NS.I18N.setLocale('en')                → 立刻换语言并通知监听者
 *   <span data-i18n="shell.gear">          → applyStatic() 会填 textContent
 *   <span data-i18n-title="...">           → 填 title（同理 data-i18n-aria）
 *
 * ⚠️ 语言名（英语 / 日语…）既是显示名也是数据键：界面只翻译「显示」，
 *    写回数据时保持中文原值，见 langName() 与 docs/国际化文案清单.md 第 6 节。
 */
(function (global) {
  'use strict';
  const NS = global.XZ || (global.XZ = {});
  const SOURCE = global.XZ_LOCALES || {};

  /** 可选语言（顺序即下拉顺序）；auto = 跟随系统 */
  const OPTIONS = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'fr'];
  const FALLBACK = 'zh-CN';

  /** 中文语言名 → 短码（只用来查显示名，不写回数据） */
  const LANG_CODE = {
    英语: 'en',
    英文: 'en',
    中文: 'zh',
    汉语: 'zh',
    日语: 'ja',
    日文: 'ja',
    韩语: 'ko',
    韩文: 'ko',
    俄语: 'ru',
    法语: 'fr',
    德语: 'de',
    西班牙语: 'es',
    意大利语: 'it'
  };

  /** 内置词库名是考试专有名词，给个短译名，别把下拉撑爆 */
  const DICT_KEY = {
    中考: 'dict.name.zhongkao',
    高中: 'dict.name.gaokao',
    四级: 'dict.name.cet4',
    六级: 'dict.name.cet6',
    雅思: 'dict.name.ielts'
  };

  let pref = 'auto';
  let locale = FALLBACK;
  const listeners = new Set();

  function normalize(tag) {
    const t = String(tag || '').toLowerCase();
    if (!t) return '';
    if (t.startsWith('zh')) return /hant|tw|hk|mo/.test(t) ? 'zh-TW' : 'zh-CN';
    if (t.startsWith('ja')) return 'ja';
    if (t.startsWith('fr')) return 'fr';
    if (t.startsWith('en')) return 'en';
    return '';
  }

  function resolve(p, systemLocale) {
    const want = String(p || 'auto');
    if (want !== 'auto') return OPTIONS.includes(want) ? want : 'en';
    const n = normalize(systemLocale || (navigator && navigator.language) || '');
    if (n) return n;
    const sys = String(systemLocale || (navigator && navigator.language) || '');
    return /^zh/i.test(sys) ? 'zh-CN' : 'en';
  }

  function fmt(str, params) {
    if (!params) return str;
    return String(str).replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
    );
  }

  const I18N = {
    OPTIONS,

    get pref() {
      return pref;
    },
    get locale() {
      return locale;
    },

    /** 初始化：pref 来自 settings.locale，systemLocale 来自主进程（没有就用 navigator） */
    init(p, systemLocale) {
      pref = p || 'auto';
      locale = resolve(pref, systemLocale);
      this._paint();
      return locale;
    },

    /** 换语言：更新 <html lang>、静态文案，然后通知各处重绘 */
    setLocale(p, systemLocale) {
      pref = p || 'auto';
      const next = resolve(pref, systemLocale);
      const changed = next !== locale;
      locale = next;
      this._paint();
      if (changed) {
        for (const fn of listeners) {
          try {
            fn(locale);
          } catch (err) {
            console.error('[i18n] 监听器异常', err);
          }
        }
      }
      return locale;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    _paint() {
      const root = global.document && global.document.documentElement;
      if (!root) return;
      root.setAttribute('lang', locale === 'zh-TW' ? 'zh-Hant' : locale);
      // 供 CSS 用：英文/法文标签更长，需要给设置面板的 label 多留点宽度
      root.setAttribute('data-locale', locale);
      // 窗口标题、任务栏标题都吃 <title>，切语言后要一起换。
      // 主窗口用默认的 app.title；排版窗口这类子窗口在 <html data-title-key> 上指定自己的 key
      if (global.document) {
        global.document.title = this.t(root.getAttribute('data-title-key') || 'app.title');
      }
      this.applyStatic(global.document);
    },

    /**
     * 填静态文案：data-i18n / data-i18n-title / data-i18n-aria
     * 只处理带属性的节点，普通 DOM 由各处 render() 自己走 t()。
     */
    applyStatic(root) {
      if (!root || !root.querySelectorAll) return;
      for (const el of root.querySelectorAll('[data-i18n]')) {
        el.textContent = this.t(el.getAttribute('data-i18n'));
      }
      for (const el of root.querySelectorAll('[data-i18n-title]')) {
        el.title = this.t(el.getAttribute('data-i18n-title'));
      }
      for (const el of root.querySelectorAll('[data-i18n-aria]')) {
        el.setAttribute('aria-label', this.t(el.getAttribute('data-i18n-aria')));
      }
    },

    /** 取词：当前语种 → 英文 → 中文基准 → key 本身 */
    t(key, params) {
      const cur = SOURCE[locale] || {};
      let v = cur[key];
      if (v === undefined) v = (SOURCE.en || {})[key];
      if (v === undefined) v = (SOURCE[FALLBACK] || {})[key];
      if (v === undefined) return key;
      return typeof v === 'string' ? fmt(v, params) : v;
    },

    /** 语言下拉的选项文案：每个语种用自己的名字写（"Français" 比 "French" 好认） */
    localeName(code) {
      if (code === 'auto') return this.t('settings.general.langAuto');
      return NATIVE[code] || code;
    },

    /** 词库里的语言名 → 当前界面语言的显示名（认不出来就原样返回，比如「其他1」） */
    langName(name) {
      const s = String(name || '');
      const code = LANG_CODE[s];
      if (!code) return s;
      const v = this.t(`lang.${code}`);
      return v === `lang.${code}` ? s : v;
    },

    /** 内置词库名 → 显示名；导入的词库保留用户文件名 */
    dictName(name) {
      const key = DICT_KEY[String(name || '')];
      if (!key) return String(name || '');
      const v = this.t(key);
      return v === key ? name : v;
    }
  };

  /** 每种语言用自己的名字显示（下拉里 "Français" 比 "French" 好认） */
  const NATIVE = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', fr: 'Français' };
  I18N.NATIVE = NATIVE;

  NS.I18N = I18N;
  NS.t = I18N.t.bind(I18N);
  NS.localeOf = resolve;
  NS.normalizeLocale = normalize;
})(window);
