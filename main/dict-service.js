'use strict';
/**
 * DictService —— B1 内置词库 / B3 导入词库
 * 内置：词库/*.txt（Tab 分隔：单词<Tab>音标<Tab>释义），惰性解析 + 进程内缓存
 * 导入：userData/dicts/<id>.json，与内置走同一 getEntries 接口（B4 行为一致的实现基础）
 */
const fs = require('fs');
const path = require('path');

const BUILTIN = [
  { id: 'zhongkao', name: '中考', file: '中考.txt' },
  { id: 'gaozhong', name: '高中', file: '高中.txt' },
  { id: 'cet4', name: '四级', file: '四级.txt' },
  { id: 'cet6', name: '六级', file: '六级.txt' },
  { id: 'ielts', name: '雅思', file: '雅思.txt' }
];

const MAX_COUNT = 500;

class DictService {
  constructor({ dictDir, dictsDir }) {
    this.dictDir = dictDir;
    this.dictsDir = dictsDir;
    this.cache = new Map(); // dictId -> { meta, entries }
    this.failed = new Set();
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
    const pack = {
      meta: { id: def.id, name: def.name, count: entries.length, builtin: true },
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
            .map((e) => ({
              word: String(e.word),
              phonetic: String(e.phonetic || ''),
              definition: String(e.definition || '')
            }))
        : [];
      const pack = {
        meta: {
          id,
          name: data.name || id,
          count: entries.length,
          builtin: false,
          wordLang: data.wordLang || '',
          defLang: data.defLang || ''
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
      const e = new Error('该词库不存在，可能已被删除');
      e.code = 'E_DICT_NOT_FOUND';
      e.expected = true;
      throw e;
    }
    const n = Math.min(Math.max(1, Number(count) || MAX_COUNT), MAX_COUNT);
    const start = Math.max(0, Number(offset) || 0);
    return pack.entries.slice(start, start + n).map((e) => ({
      id: e.word,
      word: e.word,
      phonetic: e.phonetic,
      definition: e.definition
    }));
  }

  getCount(dictId) {
    const pack = this._pack(dictId);
    return pack ? pack.entries.length : 0;
  }

  remove(dictId) {
    if (this._builtinMeta(dictId)) {
      const e = new Error('内置词库不可删除');
      e.code = 'E_DICT_BUILTIN';
      e.expected = true;
      throw e;
    }
    const file = path.join(this.dictsDir, `${dictId}.json`);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      this.cache.delete(dictId);
    } catch (err) {
      const e = new Error('删除词库失败，文件可能被占用');
      e.code = 'E_FILE_UNREADABLE';
      e.expected = true;
      throw e;
    }
    return null;
  }

  /** 供 ImporterService 写入导入词库 */
  saveImported({ name, wordLang, defLang, entries }) {
    fs.mkdirSync(this.dictsDir, { recursive: true });
    const id = `imp_${Date.now().toString(36)}`;
    const file = path.join(this.dictsDir, `${id}.json`);
    const payload = {
      id,
      name: name || '导入词库',
      wordLang: wordLang || '',
      defLang: defLang || '',
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

module.exports = { DictService, BUILTIN };
