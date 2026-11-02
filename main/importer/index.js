'use strict';
/**
 * ImportService —— B3 词库导入 / C1 文档导入
 * 管线：选文件 → 编码检测 → 按扩展名分发解析器 → DocModel → 落盘 → 元信息
 * 硬约束：任何异常都转为用户可读的中文错误（E_*），绝不抛到 IPC 顶层，绝不返回半解析内容
 */
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');

const { decodeBuffer, textToBlocks, sanitize } = require('./text');
const { parseDocx } = require('./docx');
const { parsePdf } = require('./pdf');

const MAX_BLOCK_CHUNK = 500;
const DOC_FILTERS = [
  { name: '所有支持的文件', extensions: ['txt', 'md', 'markdown', 'docx', 'pdf'] },
  { name: '文本文件', extensions: ['txt', 'md', 'markdown'] },
  { name: 'Word 文档', extensions: ['docx'] },
  { name: 'PDF 文档', extensions: ['pdf'] }
];

function err(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  e.expected = true;
  return e;
}

/* ---------------- 语言识别 ---------------- */

const LANG_BY_SCRIPT = [
  { name: '日语', re: /[\u3040-\u30ff]/g },
  { name: '韩语', re: /[\uac00-\ud7af\u1100-\u11ff]/g },
  { name: '中文', re: /[\u4e00-\u9fff\u3400-\u4dbf]/g },
  { name: '俄语', re: /[\u0400-\u04ff]/g },
  { name: '阿拉伯语', re: /[\u0600-\u06ff]/g },
  { name: '希腊语', re: /[\u0370-\u03ff]/g },
  { name: '英语', re: /[A-Za-z]/g }
];

const FRANC_MAP = {
  eng: '英语', cmn: '中文', jpn: '日语', kor: '韩语', rus: '俄语', ara: '阿拉伯语',
  fra: '法语', deu: '德语', spa: '西班牙语', ita: '意大利语', por: '葡萄牙语',
  nld: '荷兰语', swe: '瑞典语', pol: '波兰语', tur: '土耳其语', heb: '希伯来语',
  hin: '印地语', tha: '泰语', vie: '越南语', ukr: '乌克兰语', ell: '希腊语'
};

/** franc-min v6 为纯 ESM，运行时动态加载；不可用时静默降级为脚本判断 */
let francFn = null;
async function initFranc() {
  try {
    const mod = await import('franc-min');
    const fn = mod.franc || (mod.default && mod.default.franc) || mod.default;
    if (typeof fn === 'function') francFn = fn;
  } catch {
    francFn = null;
  }
}

function detectLanguages(sample) {
  const text = sanitize(String(sample || '')).slice(0, 200000);
  const counts = [];
  for (const { name, re } of LANG_BY_SCRIPT) {
    const n = (text.match(re) || []).length;
    if (n > 0) counts.push({ name, n });
  }
  counts.sort((a, b) => b.n - a.n);
  const total = counts.reduce((s, c) => s + c.n, 0) || 1;
  const out = counts
    .filter((c) => c.n / total >= 0.02)
    .map((c) => c.name);

  // 仅拉丁字母时用 franc-min 细分语种（低置信度只作为默认值，用户可改）。
  // 样本太短时 franc 会把 `apple / ruler` 判成德语，所以要求足够长的样本文本才采信；
  // 短样本仍保留「英语」作为首选（导入后可在设置里改，不必重导）。
  const onlyLatin = counts.length === 1 && counts[0].name === '英语';
  if (onlyLatin && francFn && text.length >= 500) {
    try {
      const code = francFn(text.slice(0, 2000), { minLength: 3 });
      const mapped = FRANC_MAP[code];
      if (mapped && mapped !== '英语') out.unshift(mapped);
    } catch {
      /* 静默降级 */
    }
  }
  if (!out.length) out.push('未知');
  return out.slice(0, 4);
}

/* ---------------- 词条行切分（附录 B） ---------------- */

/** 列名单元格：日文 / 中文 / 日文语法 / 中文意思 / word / meaning …（只在「整行都是列名」时才采信） */
const HEADER_CELL =
  /^(?:日文|日語?|中文|華語|英文|英语|英語|单词|單詞|词|詞|词汇|詞彙|词条|詞條|词组|詞組|短语|短語|读音|讀音|音标|音標|注音|拼音|发音|發音|假名|词性|詞性|意思|释义|釋義|解释|解釋|例句|备注|備註|序号|序號|编号|編號|no\.?|#|word|words|vocabulary|meaning|definition|translation|reading|pronunciation|phonetic|pos|partofspeech|example|phrase|unit|lesson)(?:语法|語法|惯用语|慣用語|意思|释义|釋義)?$/i;

/** 去掉列名外面可能带的斜杠 / 括号：/phonetic/ → phonetic */
const HEADER_TRIM = /^[\s/\\[\]【】()（）「」『』]+|[\s/\\[\]【】()（）「」『』]+$/g;

/**
 * 表头行判定：**整行每一格都是列名**才算。
 * 不能写成「只要有一格像列名就丢掉」——那样英文词 no / reading 会被当表头整条误删。
 * 分隔符：优先 tab（docx 表格），其次连续空格（PDF 教材词表常见「序号 单词 注音 释义」）。
 */
function isHeaderRow(raw) {
  const byTab = raw.indexOf('\t') >= 0;
  const cells = raw
    .split(byTab ? '\t' : /\s+/)
    .map((c) => String(c).replace(HEADER_TRIM, '').trim())
    .filter(Boolean);
  if (cells.length < 2) return false;
  return cells.every((c) => HEADER_CELL.test(c));
}

/**
 * 词尾的读音括号：「施す（ほどこす）」→ 词 = 施す、读音 = ほどこす。
 * 日文词条的标准写法，括号里是假名，不能按「句子标点」处理。
 */
const PAREN_TAIL = /^(.+?)\s*[（(]\s*([^（()）]{1,40})\s*[）)]$/;

/* ---- 英文教材词表（PDF 抽取后无任何分隔符）：序号 + 单词 + 音标 + 词性.释义 ----
   典型：`12 approach ə'prəutʃ n.接近 途径 方法 vt.向...靠近`
   这类行既没有 tab、也没有冒号/破折号，靠 splitEntryRow 的通用规则只能切到行首的序号，
   导致整份文件识别率过低而被当成「不是词库」拒掉。 */
const LATIN_HEAD = /^([A-Za-z][A-Za-z'’.\-]{0,23})\s+([\s\S]+)$/;
/* 词性缩写是「音标 / 释义」之间唯一稳定的锚点。PDF 常把 adj 的点吃掉（`adj情合理的`），
   所以点号可缺省；aux.v. 这种带内嵌点的要先于 aux 匹配。 */
const POS_MARK =
  /(?:^|[\s,;])((?:aux\.?v|abbr|prep|conj|pron|adj|adv|aux|art|num|int|vt|vi|ad|pl|n|v)\b\.?(?![A-Za-z]))/;
const IPA_CHAR = /[əʃʒθðŋɑɔɜʌæɪʊɒɡɐɛɚɝˈˌː]/;

function looksPhonetic(s) {
  if (!s) return false;
  if (!/\s/.test(s)) return true; // 位置已经确定是音标位，单 token 直接采信
  // 多 token（PDF 断行）：必须带音标专有记号，避免把正文里的 `is a pen` 当音标
  return /['ˌˈː/[]/.test(s) || IPA_CHAR.test(s);
}

function splitLatinEntryRow(raw) {
  const m = LATIN_HEAD.exec(raw);
  if (!m) return null;
  const word = m[1];
  const rest = m[2].trim();
  if (!rest) return null;
  const p = POS_MARK.exec(rest);
  if (!p) return null;
  const start = p.index + (p[0].length - p[1].length);
  // 词性与释义之间的分隔符（`apple - n.苹果`）会落进「音标位」，它是标点不是读音。
  // 不清掉的话纸面上会出现 `/ - /` 这种假音标。
  const head = rest.slice(0, start).replace(/^[\s\-–—:：,，;；|｜]+|[\s\-–—:：,，;；|｜]+$/g, '');
  const definition = rest.slice(start).trim();
  if (!definition) return null;
  let phonetic = '';
  if (head) {
    if (head.length > 40 || !looksPhonetic(head)) return null;
    // PDF 会把音标拆成 `'stju dənt`、`jə, jiə`，这里的空格是排版断行而非音节分隔
    phonetic = head.replace(/\s*,\s*/g, ',').replace(/\s+/g, '');
  }
  return { word, phonetic, definition };
}

function splitEntryRow(line) {
  let raw = String(line).replace(/\uFEFF/g, '').trim();
  if (!raw) return null;
  // 行首序号：`10. word` / `10、word` / `10 word`（PDF 抽取常见第三种）
  raw = raw.replace(/^\d{1,4}[.、)]\s*/, '').replace(/^\d{1,4}\s+/, '').trim();
  if (!raw) return null;
  if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]/.test(raw)) return null;
  if (isHeaderRow(raw)) return null;

  const latin = splitLatinEntryRow(raw);
  if (latin) return latin;

  const attempts = [];
  const tabAt = raw.indexOf('\t');
  if (tabAt > 0) attempts.push([raw.slice(0, tabAt), raw.slice(tabAt + 1)]);
  const colon = /^(.*?)\s*[：:]\s*(.+)$/.exec(raw);
  if (colon) attempts.push([colon[1], colon[2]]);
  const spacedDash = /^(.*?)\s+[-–—]\s+(.+)$/.exec(raw);
  if (spacedDash) attempts.push([spacedDash[1], spacedDash[2]]);
  const dash = /^([^-–—]{1,60})\s*[-–—]\s*(.+)$/.exec(raw);
  if (dash) attempts.push([dash[1], dash[2]]);
  const multiSpace = /^(\S+)\s{2,}(.+)$/.exec(raw);
  if (multiSpace) attempts.push([multiSpace[1], multiSpace[2]]);
  const singleSpace = /^(\S+)\s+(.+)$/.exec(raw);
  if (singleSpace) attempts.push([singleSpace[1], singleSpace[2]]);

  for (const [w, d] of attempts) {
    let word = String(w).trim();
    const definition = String(d).trim();
    if (!word || !definition) continue;
    // 释义得真的有内容：PDF 抽取常留下 `)` `--` 这类纯标点残渣
    if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]/.test(definition)) continue;

    // 先把词尾读音括号剥出来，再做「句子标点」判定——否则 （） 会把这个词整条否掉
    let phonetic = '';
    const pm = PAREN_TAIL.exec(word);
    if (pm) {
      word = pm[1].trim();
      phonetic = pm[2].trim();
    }

    if (!word || word.length > 24) continue;
    // 词条本体不应是句子：出现句读标点即视为普通正文
    if (/[，。！？；、…“”‘’（）《》]/.test(word)) continue;
    if (word.split(/\s+/).length > 5) continue;
    if (word === definition) continue;
    if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]/.test(word)) continue;
    return { word, phonetic, definition };
  }
  return null;
}

/**
 * 整库语言一致性清洗：一份英语词表里偶尔会混进几条「词列整块丢失」的残行
 * （PDF 抽不出单词时，行首就变成了释义里的中文）。它们不是词，留着只会让
 * 学习卡片上出现「汗」「跌」这种中文卡。
 * 只在「绝大多数词条是拉丁词」且「混入比例极低」时动手，中/日文词库完全不受影响。
 */
const CJK_IN = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

function dropLangOutliers(entries) {
  if (!entries || entries.length < 20) return entries;
  const latin = entries.filter((e) => /[A-Za-z]/.test(e.word) && !CJK_IN.test(e.word)).length;
  if (latin / entries.length < 0.85) return entries; // 不是以拉丁词为主，别乱删
  const bad = entries.filter((e) => CJK_IN.test(e.word));
  if (!bad.length) return entries;
  if (bad.length / entries.length > 0.05) return entries; // 中英混排词表，保守不动
  return entries.filter((e) => !CJK_IN.test(e.word));
}

/* ---------------- 多语言释义（B8 数据层） ---------------- */

/**
 * 一段文字属于哪种语言：按书写系统判，只用来给「同一条词条的多语言释义」贴标签。
 * 拉丁字母一律记「英语」——法语/德语靠 26 个字母分不出来，硬猜比标错更糟。
 */
const SEG_SCRIPT = [
  { name: '日语', re: /[\u3040-\u30ff]/ },
  { name: '韩语', re: /[\uac00-\ud7af\u1100-\u11ff]/ },
  { name: '中文', re: /[\u4e00-\u9fff\u3400-\u4dbf]/ },
  { name: '俄语', re: /[\u0400-\u04ff]/ },
  { name: '英语', re: /[A-Za-z]/ }
];

function segmentLang(seg) {
  for (const { name, re } of SEG_SCRIPT) {
    if (re.test(seg)) return name;
  }
  return '';
}

/** 释义里的分隔符：分号 / 竖线 / 两侧带空格的斜杠（见 splitDefinitionLangs） */

/**
 * 把「n.苹果 / りんご」切成 { 中文: 'n.苹果', 日语: 'りんご' }。
 * 只在**能看出明确的多语言结构**时才切：
 *  - 出现假名/谚文/西里尔字母，或用了竖线、带空格的斜杠
 * 中文释义内部常见的「；」不切（切了也是同一种语言，合并回去反而会改动原文）。
 * 拿不准时返回 null，保持 definition 原文不动 —— 宁可少一个功能，不可丢内容。
 */
function splitDefinitionLangs(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 240) return null;
  const exotic = /[\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(raw);
  const explicitSep = /[|｜]|\s[/／]\s/.test(raw);
  if (!exotic && !explicitSep) return null;

  // 有假名/谚文/西里尔时，「-」也可以当分隔符（尺子 - ものさし）；
  // 纯汉语释义里的破折号不算，否则「苹果 - 苹果树」这类会被误切。
  const sep = exotic ? /\s*[;；|｜]\s*|\s+[/／–—-]\s+/ : /\s*[;；|｜]\s*|\s+[/／]\s+/;

  const segs = raw.split(sep).map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2 || segs.length > 6) return null;

  const groups = new Map();
  for (const s of segs) {
    const lang = segmentLang(s);
    if (!lang) return null; // 有段落判不出语言 → 结构不可靠，不动
    groups.set(lang, groups.has(lang) ? `${groups.get(lang)}；${s}` : s);
  }
  if (groups.size < 2) return null;
  return Object.fromEntries(groups);
}

/**
 * 词库的「语言槽位」——导入对话框据此让用户勾选「这份词表包含哪些语言」。
 * 槽位 = 词条列（固定要留）+ 各释义语言；释义里没切出多语言的条目归到「原文释义」槽位。
 */
function buildLangSlots(entries) {
  const head = entries.slice(0, 300);
  const wordLang = detectLanguages(head.map((e) => e.word).join('\n'))[0] || '未知';
  const plain = entries.filter((e) => !e.translations);
  const plainSample = (plain.length ? plain : head)
    .slice(0, 300)
    .map((e) => e.definition)
    .join('\n');
  const plainLang = detectLanguages(plainSample)[0] || '中文';

  const counts = new Map();
  const samples = new Map();
  for (const e of entries) {
    if (!e.translations) continue;
    for (const [k, v] of Object.entries(e.translations)) {
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!samples.has(k)) samples.set(k, v);
    }
  }
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  // 原文释义槽位：有条目没切分过 → 它就是这些释义的语言；全都切分过 → 取出现最多的译文语言
  const baseGuess = plain.length ? plainLang : byCount[0] || plainLang;

  const slots = [
    {
      key: '__word__',
      label: wordLang,
      kind: 'word',
      fixed: true, // 词条列是主键，必须保留
      count: entries.length,
      sample: head[0] ? head[0].word : ''
    }
  ];
  // 和词条列同名的释义槽位（`cat - n.猫 | cat` 里的英文 cat）与词形重复，没有切换意义：
  // 只要还有别的释义语言就丢掉它，避免一导入就因「上下同名」被拦。
  const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const allDefKeys = [baseGuess, ...byCount.filter((k) => k !== baseGuess)];
  const filtered = allDefKeys.filter((k) => !same(k, wordLang));
  const defKeys = filtered.length ? filtered : allDefKeys;
  const base = defKeys.includes(baseGuess) ? baseGuess : defKeys[0];
  const plainSampleText = (plain[0] || {}).definition || '';
  for (const key of defKeys) {
    let n = 0;
    for (const e of entries) {
      if (e.translations) {
        if (e.translations[key]) n++;
      } else if (key === base) {
        n++;
      }
    }
    slots.push({
      key,
      label: key,
      kind: 'def',
      base: key === base,
      count: n,
      sample: samples.get(key) || (key === base ? plainSampleText : '')
    });
  }
  return { slots, multiLang: byCount.length >= 2 };
}

/**
 * 按导入对话框勾选的语言槽位整理词条：
 * 去掉未勾选语言的译文、把槽位名（可自定义：其他1 / 意大利语…）写成译文键。
 */
function applyLangPlan(entries, plan) {
  const slots = (Array.isArray(plan) ? plan : []).filter((s) => s && typeof s.key === 'string');
  const wordSlot = slots.find((s) => s.key === '__word__');
  const defSlots = slots.filter((s) => s.key !== '__word__');
  if (!wordSlot || !defSlots.length) return null;

  const clean = (v) => String(v == null ? '' : v).trim().slice(0, 20);
  const wordLang = clean(wordSlot.name) || clean(wordSlot.label) || '未标注语言';
  const rename = new Map();
  for (const s of defSlots) {
    const name = clean(s.name) || clean(s.label) || s.key;
    rename.set(s.key, name);
  }
  const keep = new Set(rename.keys());
  const baseKept = defSlots.some((s) => s.base);

  const out = entries.map((e) => {
    const n = { word: e.word, phonetic: e.phonetic, definition: e.definition };
    if (e.translations) {
      const t = {};
      for (const [k, v] of Object.entries(e.translations)) {
        if (!keep.has(k)) continue;
        const name = rename.get(k) || k;
        // 两个槽位改成同一个名字时合并，不静默丢内容
        t[name] = t[name] ? `${t[name]}；${v}` : v;
      }
      if (Object.keys(t).length) n.translations = t;
    }
    // 原文释义的槽位被取消勾选：definition 只剩「抄一份剩下的第一种语言」，
    // 否则它会被当成剩下的那种语言，上下两行显示同一句。
    if (!baseKept && n.translations) {
      const first = Object.keys(n.translations)[0];
      if (first) n.definition = n.translations[first];
    }
    return n;
  });

  const langs = [wordLang, ...defSlots.map((s) => rename.get(s.key))].filter(Boolean);
  // 上下两行是同一个名字时没有切换意义，直接拦下来（渲染层也会再拦一次）
  const uniq = new Set(langs.map((x) => x.toLowerCase()));
  if (uniq.size < langs.length) {
    throw err('E_LANG_DUP', '词条语言和释义语言不能是同一种，请改名后再导入');
  }
  return { entries: out, wordLang, defLang: rename.get(defSlots[0].key), langs };
}

function parseDictRows(text) {
  const lines = sanitize(text).split('\n');
  const entries = [];
  const seen = new Set();
  let firstRaw = null;
  let totalLines = 0;
  let multiLang = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    totalLines++;
    if (!firstRaw) firstRaw = t;
    const row = splitEntryRow(t);
    if (!row) continue;
    const key = row.word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let definition = row.definition;
    // 读音有两个来源：词尾括号（日文词条）优先，其次是三列表的中间列
    let phonetic = row.phonetic || '';
    // 形如 "word\t/bʊk/\t书" 或 "sweat\tswet\tn. 汗" 的三列：中间列是音标
    if (definition.includes('\t')) {
      const parts = definition.split('\t').map((s) => s.trim()).filter(Boolean);
      const phCell =
        parts.length >= 2 &&
        !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(parts[0]) &&
        (/^[/[]/.test(parts[0]) || looksPhonetic(parts[0]));
      if (parts.length >= 2 && !phonetic && phCell) {
        phonetic = parts[0].replace(/^[/[]|[/\]]$/g, '').trim();
        definition = parts.slice(1).join(' ');
      } else {
        definition = parts.join(' ');
      }
    }
    const translations = splitDefinitionLangs(definition);
    if (translations) multiLang++;
    entries.push(
      translations
        ? { word: row.word, phonetic, definition, translations }
        : { word: row.word, phonetic, definition }
    );
  }
  return { entries, firstRaw, totalLines, multiLang };
}

function blocksToLines(blocks) {
  return blocks
    .map((b) => {
      if (b.type === 'placeholder') return b.label || '';
      return b.text || '';
    })
    .filter((t) => String(t).trim())
    .join('\n');
}

/* ---------------- ImportService ---------------- */

class ImportService {
  constructor({ dictService, importsDir }) {
    this.dictService = dictService;
    this.importsDir = importsDir;
    this.cache = new Map(); // docId -> { meta, blocks }
    this.pending = new Map(); // token -> { filePath, entries }
  }

  async pickFile(mode) {
    const res = await dialog.showOpenDialog({
      title: mode === 'learn' ? '选择词库文件' : '选择资料文件',
      properties: ['openFile'],
      filters: DOC_FILTERS
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      /* ignore */
    }
    return { filePath, size, name: path.basename(filePath) };
  }

  _read(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error('not file');
      if (stat.size > 200 * 1024 * 1024) {
        throw err('E_FILE_UNREADABLE', '文件过大（超过 200MB），无法导入');
      }
      return fs.readFileSync(filePath);
    } catch (e) {
      if (e && e.expected) throw e;
      throw err('E_FILE_UNREADABLE', '无法读取文件，可能已被移动或占用');
    }
  }

  /** 解析为 { blocks, rawText }：rawText 保留"一行一条"的原始行结构（词库模式依赖） */
  async _parseFile(filePath, buf) {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    if (ext === 'docx') {
      const blocks = await parseDocx(buf);
      return { blocks, rawText: blocksToLines(blocks) };
    }
    if (ext === 'pdf') {
      const blocks = await parsePdf(buf);
      return { blocks, rawText: blocksToLines(blocks) };
    }
    if (ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'text') {
      const { text, encoding } = decodeBuffer(buf);
      const markdown = ext !== 'txt' && ext !== 'text';
      const blocks = textToBlocks(text, { markdown });
      if (!blocks.length) throw err('E_EMPTY_DOC', '文档是空的，没有可显示的内容');
      return { blocks, rawText: text, encoding };
    }
    if (ext === 'doc') throw err('E_PARSE_DOCX', '不支持旧版 .doc 格式，请另存为 .docx 后再导入');
    throw err('E_FILE_UNREADABLE', '不支持的文件类型，请使用 txt / md / docx / pdf');
  }

  async parse({ filePath, mode }) {
    if (!filePath) throw err('E_FILE_UNREADABLE', '没有选择文件');
    const buf = this._read(filePath);
    const baseName = path.basename(filePath).replace(/\.[^.]+$/, '');
    const { blocks, rawText } = await this._parseFile(filePath, buf);

    if (mode === 'learn') {
      const parsed = parseDictRows(rawText);
      const { firstRaw, totalLines } = parsed;
      // 词条识别率过低说明这不是一份词库（避免把正文误当词表）
      const ratio = totalLines ? parsed.entries.length / totalLines : 0;
      if (!parsed.entries.length || ratio < 0.5) {
        throw err('E_NOT_WORDLIST', '未在该文件中找到词条（需要每行一条：词 + 释义）');
      }
      const entries = dropLangOutliers(parsed.entries);
      const token = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      this.pending.set(token, { filePath, entries });
      // 学习语言只看「词」这一列，释义语言只看「释义」列：
      // 混在一起采样时中文释义占比最高，会把英语词库默认标成「中文」，
      // 而语言决定不显示/标星的分组，标错就会和同语言的内置词库对不上。
      const wordSample = entries.slice(0, 300).map((e) => e.word).join('\n');
      const defSample = entries.slice(0, 300).map((e) => e.definition).join('\n');
      const langInfo = buildLangSlots(entries);
      return {
        kind: 'dict-preview',
        token,
        totalRows: entries.length,
        previewRows: entries.slice(0, 8).map((e) => `${e.word}  ${e.definition}`),
        languages: detectLanguages(wordSample),
        defLanguages: detectLanguages(defSample),
        // 导入对话框的语言勾选列表：第一项固定是词条列，其余是释义语言
        langSlots: langInfo.slots,
        multiLangSupported: langInfo.multiLang,
        // 有多少条带「多语言释义」（导入后可在设置里切换显示哪种语言的释义）
        multiLangCount: parsed.multiLang,
        firstRaw
      };
    }

    // 休闲模式：直接落盘
    const docId = `doc_${Date.now().toString(36)}`;
    const placeholderCount = blocks.filter((b) => b.type === 'placeholder').length;
    const payload = {
      docId,
      name: baseName,
      importedAt: Date.now(),
      blocks
    };
    fs.mkdirSync(this.importsDir, { recursive: true });
    fs.writeFileSync(path.join(this.importsDir, `${docId}.json`), JSON.stringify(payload), 'utf8');
    this.cache.set(docId, { meta: { docId, name: baseName, importedAt: payload.importedAt, blockCount: blocks.length }, blocks });
    return {
      kind: 'doc',
      docId,
      name: baseName,
      blockCount: blocks.length,
      placeholderCount
    };
  }

  commitDict({ token, name, wordLang, defLang, langPlan, rows }) {
    let entries = null;
    const pending = token ? this.pending.get(token) : null;
    if (pending) entries = pending.entries;
    if (!entries && Array.isArray(rows) && rows.length) {
      const parsed = parseDictRows(rows.join('\n'));
      entries = parsed.entries;
    }
    if (!entries || !entries.length) {
      throw err('E_NOT_WORDLIST', '词条数据已失效，请重新导入文件');
    }
    let plan = null;
    if (Array.isArray(langPlan) && langPlan.length) {
      plan = applyLangPlan(entries, langPlan);
      if (plan) entries = plan.entries;
    }
    if (token) this.pending.delete(token);
    const { dictId, count } = this.dictService.saveImported({
      name: name || '导入词库',
      wordLang: (plan && plan.wordLang) || wordLang || '',
      defLang: (plan && plan.defLang) || defLang || '',
      langs: plan ? plan.langs : undefined,
      entries
    });
    return { dictId, count };
  }

  _readDoc(docId) {
    if (this.cache.has(docId)) return this.cache.get(docId);
    const file = path.join(this.importsDir, `${docId}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const pack = {
        meta: {
          docId,
          name: data.name || docId,
          importedAt: data.importedAt || 0,
          blockCount: Array.isArray(data.blocks) ? data.blocks.length : 0
        },
        blocks: Array.isArray(data.blocks) ? data.blocks : []
      };
      if (this.cache.size >= 6) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(docId, pack);
      return pack;
    } catch {
      throw err('E_DOC_NOT_FOUND', '该资料不存在，可能已被清理');
    }
  }

  listDocs() {
    let files = [];
    try {
      files = fs.readdirSync(this.importsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const docId = path.basename(f, '.json');
      try {
        out.push(this._readDoc(docId).meta);
      } catch {
        /* 跳过损坏项 */
      }
    }
    return out.sort((a, b) => b.importedAt - a.importedAt);
  }

  getBlocks({ docId, offset = 0, count = MAX_BLOCK_CHUNK } = {}) {
    const pack = this._readDoc(docId);
    const n = Math.min(Math.max(1, Number(count) || MAX_BLOCK_CHUNK), MAX_BLOCK_CHUNK);
    const start = Math.max(0, Number(offset) || 0);
    return pack.blocks.slice(start, start + n);
  }

  getMeta(docId) {
    return this._readDoc(docId).meta;
  }

  removeDoc(docId) {
    const file = path.join(this.importsDir, `${docId}.json`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      this.cache.delete(docId);
    } catch {
      throw err('E_DOC_NOT_FOUND', '删除失败，文件可能被占用');
    }
    return null;
  }
}

module.exports = {
  ImportService,
  detectLanguages,
  splitEntryRow,
  parseDictRows,
  buildLangSlots,
  applyLangPlan,
  initFranc
};
