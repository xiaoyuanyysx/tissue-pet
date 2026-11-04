'use strict';
/**
 * check-i18n.js —— 语种完整性自检（开发用，不进包）
 *   node scripts/check-i18n.js
 * 校验三件事：
 *   1) 每个语种的 key 与基准 zh-CN 完全一致（缺 / 多都报）；
 *   2) 同一 key 的 {变量} 集合一致（漏了 {n} 会导致数字不显示）；
 *   3) guide.levels 的结构一致（层级 / 条目数 / 字段名）。
 */
const path = require('path');
const fs = require('fs');

const DIR = path.join(__dirname, '..', 'renderer', 'js', 'locales');
const BASE = 'zh-CN';
const LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'fr'];

const dicts = {};
for (const l of LANGS) {
  const file = path.join(DIR, `${l}.js`);
  if (!fs.existsSync(file)) {
    console.error(`✗ 缺少语种文件：${l}.js`);
    process.exitCode = 1;
    continue;
  }
  dicts[l] = require(file);
}

const base = dicts[BASE];
if (!base) process.exit(1);

const varsOf = (s) => (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');
let problems = 0;
const report = (msg) => {
  problems++;
  console.error(`  ✗ ${msg}`);
};

for (const lang of LANGS) {
  const d = dicts[lang];
  if (!d) continue;
  const keys = Object.keys(d);
  const baseKeys = Object.keys(base);
  const missing = baseKeys.filter((k) => !(k in d));
  const extra = keys.filter((k) => !(k in base));
  if (missing.length) report(`${lang} 缺 ${missing.length} 个 key：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
  if (extra.length) report(`${lang} 多 ${extra.length} 个 key（基准里没有）：${extra.slice(0, 8).join(', ')}`);

  for (const k of baseKeys) {
    if (!(k in d) || k === 'guide.levels') continue;
    const a = varsOf(base[k]);
    const b = varsOf(d[k]);
    if (a !== b) report(`${lang} 的 ${k} 变量不一致：基准 [${a}] vs 实际 [${b}]`);
    if (!String(d[k]).trim()) report(`${lang} 的 ${k} 是空串`);
  }

  // guide 结构
  const gb = base['guide.levels'];
  const gl = d['guide.levels'];
  if (!Array.isArray(gl)) report(`${lang} 的 guide.levels 不是数组`);
  else {
    if (gl.length !== gb.length) report(`${lang} guide 层级数 ${gl.length} ≠ ${gb.length}`);
    gb.forEach((lv, i) => {
      const l2 = gl[i];
      if (!l2) return;
      if (l2.id !== lv.id) report(`${lang} guide[${i}] id 不一致`);
      if (!l2.name || !l2.sub) report(`${lang} guide[${i}] 缺 name/sub`);
      if (!Array.isArray(l2.items) || l2.items.length !== lv.items.length) {
        report(`${lang} guide[${i}] 条目数不一致`);
        return;
      }
      l2.items.forEach((it, j) => {
        if (!it || !it.t || !it.b) report(`${lang} guide[${i}].items[${j}] 缺 t/b`);
      });
    });
  }
}

const baseCount = Object.keys(base).length;

/* ---- 反向检查：代码里 t('xxx') 用到、但词典里没有的 key ----
   这类问题界面上不会报错，只会把 key 原样印出来（"settings.mode.title"），
   比缺翻译更难发现，所以放进自检。动态拼的 key（含 ${}）跳过。 */
const fs2 = fs;
const used = new Map();
const walk = (dir) => {
  for (const name of fs2.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs2.statSync(p);
    if (st.isDirectory()) {
      if (name === 'locales' || name === 'node_modules') continue;
      walk(p);
    } else if (name.endsWith('.js')) {
      const src = fs2.readFileSync(p, 'utf8');
      const re = /(?:NS\.t|i18n\.t|\bt)\(\s*'([^'$]+)'/g;
      let m;
      while ((m = re.exec(src))) {
        if (!used.has(m[1])) used.set(m[1], p);
      }
    }
  }
};
for (const dir of [path.join(__dirname, '..', 'renderer'), path.join(__dirname, '..', 'main')]) walk(dir);
for (const [k, p] of used) {
  if (!(k in base)) report(`代码用到但词典里没有：${k}（${path.relative(process.cwd(), p)}）`);
}

if (problems) {
  console.error(`\n共 ${problems} 处问题（基准 ${baseCount} 个 key）。`);
  process.exitCode = 1;
} else {
  console.log(`✓ 5 个语种一致，基准 ${baseCount} 个 key，guide ${base['guide.levels'].length} 级。`);
}
