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

  // 仅拉丁字母时用 franc-min 细分语种（低置信度只作为默认值，用户可改）
  const onlyLatin = counts.length === 1 && counts[0].name === '英语';
  if (onlyLatin && francFn) {
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

function splitEntryRow(line) {
  let raw = String(line).replace(/\uFEFF/g, '').trim();
  if (!raw) return null;
  raw = raw.replace(/^\d+[.、)]\s*/, '');
  if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]/.test(raw)) return null;

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
    const word = String(w).trim();
    const definition = String(d).trim();
    if (!word || !definition) continue;
    if (word.length > 24) continue;
    // 词条本体不应是句子：出现句读标点即视为普通正文
    if (/[，。！？；、…“”‘’（）《》]/.test(word)) continue;
    if (word.split(/\s+/).length > 5) continue;
    if (word === definition) continue;
    if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]/.test(word)) continue;
    return { word, definition };
  }
  return null;
}

function parseDictRows(text) {
  const lines = sanitize(text).split('\n');
  const entries = [];
  const seen = new Set();
  let firstRaw = null;
  let totalLines = 0;
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
    let phonetic = '';
    // 形如 "word\t/bʊk/\t书" 的三列：中间列是音标
    if (definition.includes('\t')) {
      const parts = definition.split('\t').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2 && /^[/[]/.test(parts[0])) {
        phonetic = parts[0].replace(/^[/[]|[/\]]$/g, '').trim();
        definition = parts.slice(1).join(' ');
      } else {
        definition = parts.join(' ');
      }
    }
    entries.push({ word: row.word, phonetic, definition });
  }
  return { entries, firstRaw, totalLines };
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
      const { entries, firstRaw, totalLines } = parseDictRows(rawText);
      // 词条识别率过低说明这不是一份词库（避免把正文误当词表）
      const ratio = totalLines ? entries.length / totalLines : 0;
      if (!entries.length || ratio < 0.5) {
        throw err('E_NOT_WORDLIST', '未在该文件中找到词条（需要每行一条：词 + 释义）');
      }
      const token = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      this.pending.set(token, { filePath, entries });
      const sample = entries.slice(0, 200).map((e) => `${e.word} ${e.definition}`).join('\n');
      return {
        kind: 'dict-preview',
        token,
        totalRows: entries.length,
        previewRows: entries.slice(0, 8).map((e) => `${e.word}  ${e.definition}`),
        languages: detectLanguages(sample),
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

  commitDict({ token, name, wordLang, defLang, rows }) {
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
    if (token) this.pending.delete(token);
    const { dictId, count } = this.dictService.saveImported({
      name: name || '导入词库',
      wordLang: wordLang || '',
      defLang: defLang || '',
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

module.exports = { ImportService, detectLanguages, splitEntryRow, parseDictRows, initFranc };
