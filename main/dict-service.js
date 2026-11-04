'use strict';
/**
 * DictService —— B1 内置词库 / B3 导入词库
 * 内置：vocab/*.txt（Tab 分隔：单词<Tab>音标<Tab>释义），惰性解析 + 进程内缓存
 * 导入：userData/dicts/<id>.json，与内置走同一 getEntries 接口（B4 行为一致的实现基础）
 */
const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');

const BUILTIN = [
  { id: 'zhongkao', name: '中考', file: '中考.txt', wordLang: '英语', defLang: '中文' },
  { id: 'gaozhong', name: '高中', file: '高中.txt', wordLang: '英语', defLang: '中文' },
  { id: 'cet4', name: '四级', file: '四级.txt', wordLang: '英语', defLang: '中文' },
  { id: 'cet6', name: '六级', file: '六级.txt', wordLang: '英语', defLang: '中文' },
  { id: 'ielts', name: '雅思', file: '雅思.txt', wordLang: '英语', defLang: '中文' }
];

const MAX_COUNT = 500;

/**
 * 语言归一：不显示/标星集合按「语言」分组，同一语言的不同词库共用一套。
 * 用户导入时可能写「英语 / 英文 / English / en」，内置词库写「英语」，必须归到同一个 key。
 */
const LANG_ALIAS = {
  英语: 'en', 英文: 'en', english: 'en', en: 'en', eng: 'en', 美语: 'en', 英式英语: 'en',
  日语: 'ja', 日文: 'ja', japanese: 'ja', ja: 'ja', jpn: 'ja',
  中文: 'zh', 汉语: 'zh', 漢語: 'zh', chinese: 'zh', zh: 'zh', cmn: 'zh', 简体中文: 'zh', 繁體中文: 'zh', 繁体中文: 'zh', 简体: 'zh',
  韩语: 'ko', 韓語: 'ko', 朝鲜语: 'ko', korean: 'ko', ko: 'ko', kor: 'ko',
  法语: 'fr', french: 'fr', fr: 'fr', 德语: 'de', german: 'de', de: 'de',
  俄语: 'ru', russian: 'ru', ru: 'ru', 西班牙语: 'es', spanish: 'es', es: 'es'
};

/** 语言的稳定 key：已知语言 → 短码；未知 → 原样小写；空 → 'unknown' */
function langKey(wordLang) {
  const s = String(wordLang == null ? '' : wordLang).trim();
  if (!s) return 'unknown';
  const hit = LANG_ALIAS[s.toLowerCase()] || LANG_ALIAS[s];
  return hit || s.toLowerCase();
}

/** 语言的展示名（设置中心 / 提示用） */
function langLabel(wordLang) {
  const s = String(wordLang == null ? '' : wordLang).trim();
  if (!s) return '未标注语言';
  const names = { en: '英语', ja: '日语', zh: '中文', ko: '韩语', fr: '法语', de: '德语', ru: '俄语', es: '西班牙语' };
  const k = langKey(s);
  return names[k] || s;
}

const LANG_NAME = { en: '英语', ja: '日语', zh: '中文', ko: '韩语', fr: '法语', de: '德语', ru: '俄语', es: '西班牙语' };
const LATIN_LANGS = new Set(['en', 'fr', 'de', 'es']);

/**
 * 从「词条首列」判断书写系统。用于纠正历史导入里被标错语言的词库
 * （早期采样把 word+释义 混在一起做语言识别，中文释义占比最高，英语词库会被存成「中文」）。
 * 返回 'ja' | 'ko' | 'zh' | 'latin' | null。
 */
function guessScriptLang(words) {
  let ja = 0;
  let ko = 0;
  let zh = 0;
  let latin = 0;
  let total = 0;
  for (const w of words) {
    const s = String(w == null ? '' : w);
    if (!s) continue;
    total++;
    if (/[\u3040-\u30ff]/.test(s)) ja++;
    else if (/[\uac00-\ud7af\u1100-\u11ff]/.test(s)) ko++;
    else if (/[\u4e00-\u9fff]/.test(s)) zh++;
    else if (/[A-Za-z]/.test(s)) latin++;
  }
  if (!total) return null;
  if (ja / total >= 0.2) return 'ja';
  if (ko / total >= 0.2) return 'ko';
  if (zh / total >= 0.5) return 'zh';
  if (latin / total >= 0.8) return 'latin';
  return null;
}

/**
 * 解析词库语言：声明值优先，但书写系统与之明显冲突时以内容为准。
 * 只纠正「纯拉丁词条却声明成中文/未标注」这一类，法语/德语等拉丁语言仍信任用户选择。
 */
function resolveLang(declared, words) {
  const d = langKey(declared);
  const s = guessScriptLang(words || []);
  if (!s) return d;
  if (s === 'latin') return d === 'zh' || d === 'unknown' ? 'en' : d;
  if (d === 'unknown') return s;
  if (d === s) return d;
  // 声明是拉丁语言但内容明显是假名/韩文/汉字 → 以内容为准
  if (LATIN_LANGS.has(d)) return s;
  return d;
}

/** 用户手选的语言名：去空白 + 限长，避免把整段文本塞进 meta */
function cleanLang(v) {
  return String(v == null ? '' : v).trim().slice(0, 20);
}

/** 词库可用的「释义语言」清单（来自词条 translations），少于 2 种时没有切换意义 */
function collectDefLangs(entries) {
  const set = new Set();
  for (const e of entries) {
    if (!e || !e.translations) continue;
    for (const k of Object.keys(e.translations)) set.add(k);
    if (set.size >= 8) break;
  }
  return [...set];
}

/**
 * 词库的「语言槽位」：纸面上方/下方各挑一个槽位显示。
 * 顺序即 UI 下拉顺序：词形语言 → 原文释义语言 → 多语言释义里出现的语言。
 * 自定义语言（其他1 / 意大利语…）也走这里，不做白名单限制。
 */
function collectLangs(srcWordLang, srcDefLang, entries) {
  const out = [];
  const push = (v) => {
    const s = cleanLang(v);
    if (s && !out.includes(s)) out.push(s);
  };
  push(srcWordLang);
  push(srcDefLang);
  for (const k of collectDefLangs(entries)) push(k);
  return out;
}

class DictService {
  constructor({ dictDir, dictsDir, langOverrides }) {
    this.dictDir = dictDir;
    this.dictsDir = dictsDir;
    // 用户手选的语言对（learn.dictLang）：优先于自动识别，且优先于 resolveLang 的「按内容纠正」，
    // 否则用户明明选了「日语」，下次启动又会被内容判定改回「中文」。
    this.langOverrides = typeof langOverrides === 'function' ? langOverrides : () => ({});
    this.cache = new Map(); // dictId -> { meta, entries }
    this.failed = new Set();
  }

  _override(dictId) {
    try {
      const all = this.langOverrides() || {};
      const ov = all[dictId];
      if (!ov || typeof ov !== 'object') return null;
      const word = cleanLang(ov.word);
      if (!word) return null;
      return { word, def: cleanLang(ov.def) };
    } catch {
      return null;
    }
  }

  /** 丢掉缓存，让下次读取重新应用语言覆盖（改语言后必须调用） */
  invalidate(dictId) {
    this.cache.delete(dictId);
    this.failed.delete(dictId);
  }

  /**
   * 全部失效：启动时 persist 的迁移会先读一遍词库，那时语言覆盖还读不到
   * （persist 尚未赋值），缓存里存的是「自动识别」的 meta。迁移结束后必须清一次。
   */
  invalidateAll() {
    this.cache.clear();
    this.failed.clear();
  }

  metaOf(dictId) {
    const pack = this._pack(dictId);
    return pack ? pack.meta : null;
  }

  _builtinMeta(id) {
    const def = BUILTIN.find((d) => d.id === id);
    return def || null;
  }

  _loadBuiltin(def) {
    if (this.cache.has(def.id)) return this.cache.get(def.id);
    const file = path.join(this.dictDir, def.file);
    let lines = [];
    try {
      const raw = fs.readFileSync(file, 'utf8');
      lines = raw.split(/\r?\n/).filter((l) => l.trim());
    } catch (err) {
      this.failed.add(def.id);
      console.warn('[dict] 内置词库读取失败', file, err.message);
    }
    const entries = lines.map(parseLine).filter(Boolean);
    const ov = this._override(def.id);
    const wordLang = (ov && ov.word) || def.wordLang;
    const defLang = (ov && ov.def) || def.defLang;
    const pack = {
      meta: {
        id: def.id,
        name: def.name,
        count: entries.length,
        builtin: true,
        wordLang,
        defLang,
        // 词形（word 列）本身属于哪种语言，**不受手选影响**：
        // 纸面「上方」可以选别的语言，但那不会把词形改成别的语种
        srcWordLang: def.wordLang,
        // 原文释义（definition 列）属于哪种语言，同样固定：上层选中它时
        // 「上方」就要能显示释义文本，否则内置词库只有一列词，上方永远换不了
        srcDefLang: def.defLang,
        langs: [def.wordLang, def.defLang].filter(Boolean),
        lang: langKey(wordLang),
        langOverridden: !!ov,
        defLangs: collectDefLangs(entries)
      },
      entries
    };
    this.cache.set(def.id, pack);
    return pack;
  }

  listBuiltin() {
    return BUILTIN.map((def) => this._loadBuiltin(def).meta);
  }

  _importedFiles() {
    try {
      return fs
        .readdirSync(this.dictsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(this.dictsDir, f));
    } catch {
      return [];
    }
  }

  _loadImported(file) {
    const id = path.basename(file, '.json');
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entries = Array.isArray(data.entries)
        ? data.entries
            .filter((e) => e && typeof e.word === 'string')
            .map((e) => {
              const out = {
                word: String(e.word),
                phonetic: String(e.phonetic || ''),
                definition: String(e.definition || '')
              };
              // 多语言释义：导入时按分隔符切出来的，键是语言名（「中文」「日语」…）。
              // 只要有一个键就留着——剩下的那一段比合并后的原文更干净。
              if (e.translations && typeof e.translations === 'object') {
                const t = {};
                for (const [k, v] of Object.entries(e.translations)) {
                  const kk = cleanLang(k);
                  const vv = String(v == null ? '' : v).trim();
                  if (kk && vv) t[kk] = vv;
                }
                if (Object.keys(t).length > 0) out.translations = t;
              }
              return out;
            })
        : [];
      const words = entries.slice(0, 300).map((e) => e.word);
      const ov = this._override(id);
      // 导入时勾选过语言的词库，名字是用户定的（可能是「其他1 / 意大利语」），
      // 一律信任、不再按书写系统纠正；老词库才走 resolveLang 纠偏。
      const hasPlan = Array.isArray(data.langs) && data.langs.length > 0;
      const baseLang = hasPlan ? langKey(cleanLang(data.wordLang)) : resolveLang(data.wordLang, words);
      // 词形自己的语言只看声明/内容，**不看手选**——否则「学习语言」改一下，
      // 词形所属语言也跟着漂，纸面上方就永远换不了语言。
      const srcWordLang = hasPlan
        ? cleanLang(data.wordLang) || LANG_NAME[baseLang] || ''
        : LANG_NAME[baseLang] || cleanLang(data.wordLang) || '';
      // 原文释义所属语言（导入时确定，含自定义名字），手选不改它
      const srcDefLang =
        cleanLang(data.defLang) || collectDefLangs(entries)[0] || '';
      // 手选语言 > 自动纠正 > 声明值
      const lang = ov ? langKey(ov.word) : baseLang;
      const pack = {
        meta: {
          id,
          name: data.name || id,
          count: entries.length,
          builtin: false,
          // 声明语言与实际书写系统冲突时，展示名也跟着纠正（不写盘，只影响本次运行）
          wordLang: ov ? ov.word : srcWordLang,
          defLang: ov ? ov.def || srcDefLang : srcDefLang,
          srcWordLang,
          srcDefLang,
          // 导入时勾选的语言（含自定义名）优先；老词库按实际内容推出来
          langs: (Array.isArray(data.langs) && data.langs.length
            ? data.langs.map(cleanLang).filter(Boolean)
            : collectLangs(srcWordLang, srcDefLang, entries)),
          lang,
          langOverridden: !!ov,
          defLangs: collectDefLangs(entries)
        },
        entries
      };
      this.cache.set(id, pack);
      return pack;
    } catch (err) {
      console.warn('[dict] 导入词库读取失败', file, err.message);
      return null;
    }
  }

  listImported() {
    const out = [];
    for (const f of this._importedFiles()) {
      const pack = this._loadImported(f);
      if (pack) out.push(pack.meta);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  listAll() {
    return [...this.listBuiltin(), ...this.listImported()];
  }

  exists(dictId) {
    if (this._builtinMeta(dictId)) return true;
    return this._importedFiles().some((f) => path.basename(f, '.json') === dictId);
  }

  _pack(dictId) {
    const def = this._builtinMeta(dictId);
    if (def) return this._loadBuiltin(def);
    const file = path.join(this.dictsDir, `${dictId}.json`);
    if (fs.existsSync(file)) return this._loadImported(file);
    return null;
  }

  getEntries({ dictId, offset = 0, count = MAX_COUNT } = {}) {
    const pack = this._pack(dictId);
    if (!pack) {
      const e = new Error(i18n.t('error.dictMissing'));
      e.code = 'E_DICT_NOT_FOUND';
      e.expected = true;
      throw e;
    }
    const n = Math.min(Math.max(1, Number(count) || MAX_COUNT), MAX_COUNT);
    const start = Math.max(0, Number(offset) || 0);
    return pack.entries.slice(start, start + n).map((e) => {
      const out = {
        id: e.word,
        word: e.word,
        phonetic: e.phonetic,
        definition: e.definition
      };
      if (e.translations) out.translations = e.translations;
      return out;
    });
  }

  getCount(dictId) {
    const pack = this._pack(dictId);
    return pack ? pack.entries.length : 0;
  }

  /** 词库的语言 key（供持久化迁移 / 渲染层分组用）；词库不存在时回退 unknown */
  langOf(dictId) {
    const pack = this._pack(dictId);
    return pack ? pack.meta.lang : 'unknown';
  }

  /** 词库的语言展示名 */
  langLabelOf(dictId) {
    const pack = this._pack(dictId);
    return langLabel(pack ? pack.meta.wordLang : '');
  }

  remove(dictId) {
    if (this._builtinMeta(dictId)) {
      const e = new Error(i18n.t('error.dictBuiltin'));
      e.code = 'E_DICT_BUILTIN';
      e.expected = true;
      throw e;
    }
    const file = path.join(this.dictsDir, `${dictId}.json`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      this.cache.delete(dictId);
    } catch (err) {
      const e = new Error(i18n.t('error.dictDeleteBusy'));
      e.code = 'E_FILE_UNREADABLE';
      e.expected = true;
      throw e;
    }
    return null;
  }

  /** 供 ImporterService 写入导入词库 */
  saveImported({ name, wordLang, defLang, langs, entries }) {
    fs.mkdirSync(this.dictsDir, { recursive: true });
    const id = `imp_${Date.now().toString(36)}`;
    const file = path.join(this.dictsDir, `${id}.json`);
    const list = (Array.isArray(langs) ? langs : []).map(cleanLang).filter(Boolean);
    const payload = {
      id,
      name: name || '导入词库',
      wordLang: wordLang || '',
      defLang: defLang || '',
      // 导入时勾选的语言槽位（含「其他1 / 意大利语」这类自定义名），决定下拉里能挑哪些
      langs: list.length ? list : collectLangs(wordLang, defLang, entries),
      createdAt: Date.now(),
      entries
    };
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    this.cache.delete(id);
    return { dictId: id, count: entries.length };
  }
}

function parseLine(line) {
  const raw = String(line).replace(/\uFEFF/g, '').trim();
  if (!raw) return null;
  const parts = raw.split('\t');
  if (parts.length >= 3) {
    return {
      word: parts[0].trim(),
      phonetic: parts[1].trim(),
      definition: parts.slice(2).join(' ').trim()
    };
  }
  if (parts.length === 2) {
    return { word: parts[0].trim(), phonetic: '', definition: parts[1].trim() };
  }
  return null;
}

module.exports = { DictService, BUILTIN, langKey, langLabel, resolveLang, guessScriptLang };
