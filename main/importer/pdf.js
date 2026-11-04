'use strict';
/**
 * pdf.js —— pdf → Block[]
 * pdfjs-dist 取文本项 + 坐标，按 y 聚行、按 x 排序，重排为段落流（非整页截图）
 */
const path = require('path');
const i18n = require('../i18n');

let pdfjs = null;
function loadPdfjs() {
  if (pdfjs) return pdfjs;
  try {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  }
  return pdfjs;
}

function pdfErr(msg) {
  const e = new Error(i18n.t(msg));
  e.code = 'E_PARSE_PDF';
  e.expected = true;
  return e;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

function isCJK(ch) {
  return CJK_RE.test(ch || '');
}

/** 图片算子码集合（不同 pdfjs 版本有的算子不存在，逐个探测，全缺就返回 null 表示不支持） */
function imageOpCodes(pdfjsLib) {
  const OPS = pdfjsLib && pdfjsLib.OPS;
  if (!OPS) return null;
  const codes = new Set();
  for (const key of ['paintImageXObject', 'paintJpegXObject', 'paintInlineImageXObject']) {
    if (typeof OPS[key] === 'number') codes.add(OPS[key]);
  }
  return codes.size ? codes : null;
}

/**
 * 数一页里有几处图片绘制。
 * pdfjs 的文本流里根本没有图片，只能从算子列表里数；拿不到就算 0，
 * 宁可少一个占位符也不能让整份文档导入失败。
 */
async function countPageImages(page, codes) {
  if (!codes) return 0;
  try {
    const ops = await page.getOperatorList();
    const fns = ops && ops.fnArray;
    if (!fns) return 0;
    let n = 0;
    for (let i = 0; i < fns.length; i++) if (codes.has(fns[i])) n++;
    return n;
  } catch {
    return 0;
  }
}

function imagePlaceholder(count) {
  const label = count > 1 ? `[.png 图片 × ${count}]` : '[.png 图片]';
  return { type: 'placeholder', media: 'image', ext: 'png', label };
}

function joinChunk(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const a = prev[prev.length - 1];
  const b = next[0];
  if (isCJK(a) || isCJK(b)) return prev + next;
  if (prev.endsWith('-') && /^[a-z]/.test(next)) return prev.slice(0, -1) + next;
  return `${prev} ${next}`;
}

async function parsePdf(buf, opts = {}) {
  const pdfjsLib = loadPdfjs();
  let doc = null;
  try {
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: false,
      isEvalSupported: false,
      disableFontFace: true,
      useWorkerFetch: false,
      verbosity: 0
    });
    doc = await task.promise;
  } catch (err) {
    const name = err && err.name;
    if (name === 'PasswordException' || /password/i.test(String(err && err.message))) {
      throw pdfErr('error.pdfEncrypted');
    }
    throw pdfErr('error.pdfBroken');
  }

  const blocks = [];
  let totalChars = 0;
  let totalImages = 0;
  const opCodes = imageOpCodes(pdfjsLib);

  for (let p = 1; p <= doc.numPages; p++) {
    let page;
    try {
      page = await doc.getPage(p);
    } catch {
      continue;
    }
    // 图片数要在取文本之前先算出来：文本流里没有图片信息，只能在页末补一条占位，
    // 否则 C4「非文字内容一律占位」在 PDF 上等于没做（图表/截图会凭空消失）。
    const imgCount = await countPageImages(page, opCodes);
    totalImages += imgCount;
    let content;
    try {
      content = await page.getTextContent();
    } catch {
      content = null;
    }

    if (content) {
      const items = (content.items || []).filter((it) => typeof it.str === 'string');

      // 教材词表常见「序号 | 单词 | 音标 | 释义」四列版式：序号垂直居中于词条块，
      // 释义又常折成 2~3 行，按 y 聚行必然把释义续行错挂到下一个词条上。
      // 这种版式改走「按列切块」，其余 PDF 仍用原有的段落流。
      const table = detectTable(items);
      if (table) {
        for (const b of buildTableBlocks(items, table)) {
          const text = `${b.word}\t${b.ph}\t${b.def}`.trimEnd();
          if (!text.replace(/\t/g, '').trim()) continue;
          blocks.push({ type: 'paragraph', text });
          totalChars += b.word.length + b.def.length;
        }
      } else {
        const lines = groupLines(items);
        const heights = lines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
        const median = heights.length ? heights[Math.floor(heights.length / 2)] : 12;

        let prev = null;
        let para = '';
        const flush = () => {
          const text = para.replace(/\s+/g, ' ').trim();
          para = '';
          if (!text) return;
          totalChars += text.length;
          if (prev && prev.heading) blocks.push({ type: 'heading', level: prev.level, text });
          else blocks.push({ type: 'paragraph', text });
        };

        for (const line of lines) {
          const text = line.text.trim();
          if (!text) continue;
          const big = line.height > median * 1.32 && text.length < 42;
          const gapBreak = line.gap > median * 0.85;
          if (big) {
            flush();
            blocks.push({
              type: 'heading',
              level: line.height > median * 1.9 ? 1 : line.height > median * 1.55 ? 2 : 3,
              text
            });
            totalChars += text.length;
            prev = null;
            continue;
          }
          if (gapBreak) {
            flush();
          }
          para = joinChunk(para, text);
          prev = { heading: false };
        }
        flush();
      }
    }

    // 页末补占位：位置不精确（不知道图在行间的确切位置），但保证「不会漏」
    if (imgCount > 0) blocks.push(imagePlaceholder(imgCount));
  }

  try {
    await doc.destroy();
  } catch {
    /* ignore */
  }

  if (!blocks.length || totalChars < 3) {
    const hint = totalImages
      ? `该 PDF 只有图片没有可提取文本（扫描件，共 ${totalImages} 处图片），无法显示内容`
      : '该 PDF 不含可提取文本（可能是扫描件），无法显示内容';
    throw pdfErr(hint);
  }
  return blocks;
}

/* ---------------- 表格型词表：按列切块 ---------------- */

const COL_GAP = 10; // 相邻两列的 x 间隙阈值
const NUM_CELL = /^\d{1,4}$/;

/**
 * 识别「序号 | 单词 | 音标 | 释义」四列词表。
 * 三条硬条件都满足才认，否则返回 null 走普通段落流：
 * ① 至少 3 列；② 最左列 60% 以上是 1~4 位纯数字（序号）；③ 第二列 50% 以上含拉丁字母（单词）。
 */
function detectTable(items) {
  const list = items.filter((it) => it.str && it.str.trim());
  if (list.length < 12) return null;

  const xs = list.map((it) => it.transform[4]).sort((a, b) => a - b);
  let cols = [];
  for (const x of xs) {
    const last = cols[cols.length - 1];
    if (last && x - last.max <= COL_GAP) {
      last.max = x;
      last.n++;
    } else {
      cols.push({ min: x, max: x, n: 1 });
    }
  }
  // 音标常被拆成 `tʃ` + `ɑ` + `:t` 这种碎片，零散小簇要并回左邻，否则列序整体错位
  const tiny = Math.max(2, Math.floor(list.length * 0.02));
  const merged = [];
  for (const c of cols) {
    const prev = merged[merged.length - 1];
    if (prev && c.n <= tiny && c.min - prev.max < 45) {
      prev.max = c.max;
      prev.n += c.n;
    } else {
      merged.push({ min: c.min, max: c.max, n: c.n });
    }
  }
  cols = merged;
  if (cols.length < 3 || cols.length > 5) return null;

  let num = 0;
  let total0 = 0;
  let latin = 0;
  let total1 = 0;
  for (const it of list) {
    const x = it.transform[4];
    if (x < cols[1].min) {
      total0++;
      if (NUM_CELL.test(it.str.trim())) num++;
    } else if (x < cols[2].min) {
      total1++;
      if (/[A-Za-z]/.test(it.str)) latin++;
    }
  }
  if (total0 < 4 || num / total0 < 0.6) return null;
  if (total1 < 4 || latin / total1 < 0.5) return null;

  return cols.map((c) => c.min);
}

function colOf(cols, x) {
  for (let i = cols.length - 1; i >= 0; i--) {
    if (x >= cols[i] - 1.5) return i;
  }
  return 0;
}

/**
 * 按列切块：**单词列出现的那一行 = 新词条起点**，其余行都是续行。
 * 序号是垂直居中的（不在第一行），音标又常比单词行高 2px，所以音标要先攒着，
 * 等下一个词条行到来时一起用；释义按行序往下接（中文断行不加空格）。
 */
function buildTableBlocks(items, cols) {
  const rows = [];
  for (const it of items) {
    const s = it.str;
    if (!s || !s.trim()) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4];
    const y = tr[5];
    const h = Math.abs(tr[3] || it.height || 12);
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.5));
    if (!row) {
      row = { y, h, cells: [] };
      rows.push(row);
    }
    row.h = Math.max(row.h, h);
    row.cells.push({ x, s, col: colOf(cols, x) });
  }
  rows.sort((a, b) => b.y - a.y);

  const out = [];
  let cur = null;
  let pendingPh = '';
  const cellText = (cells) => cells.map((c) => c.s).join('');

  for (const row of rows) {
    row.cells.sort((a, b) => a.x - b.x);
    const at = (i) => row.cells.filter((c) => c.col === i);
    const wordCell = at(1).find((c) => /[A-Za-z]/.test(c.s));
    const phCells = at(2);
    const defCells = row.cells.filter((c) => c.col >= 3);
    const noCells = at(0);

    if (wordCell) {
      if (cur) out.push(cur);
      cur = { word: wordCell.s.trim(), ph: pendingPh, def: '' };
      pendingPh = '';
      if (phCells.length) cur.ph += cellText(phCells);
      if (defCells.length) cur.def = cellText(defCells);
      continue;
    }
    // 只有音标、没有单词也没有释义的行：下一个词条的音标（PDF 里排在上方）
    if (phCells.length && !defCells.length && !noCells.length) {
      pendingPh += cellText(phCells);
      continue;
    }
    if (!cur) continue;
    if (phCells.length) cur.ph += cellText(phCells);
    if (defCells.length) cur.def = joinChunk(cur.def, cellText(defCells));
  }
  if (cur) out.push(cur);
  return out.filter((b) => b.word && (b.def || b.ph));
}

/** 按 y 聚行，行内按 x 排序 */
function groupLines(items) {  const rows = [];
  for (const it of items) {
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4];
    const y = tr[5];
    const h = Math.abs(tr[3] || it.height || 12);
    if (!it.str) continue;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.45));
    if (!row) {
      row = { y, height: h, items: [] };
      rows.push(row);
    }
    row.height = Math.max(row.height, h);
    row.items.push({ x, str: it.str, w: it.width || 0 });
  }

  rows.sort((a, b) => b.y - a.y);
  const lines = [];
  let prevY = null;
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let text = '';
    let lastX = null;
    for (const it of row.items) {
      if (lastX != null) {
        const gap = it.x - lastX;
        if (gap > row.height * 0.28 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      lastX = it.x + (it.w || 0);
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const gap = prevY == null ? 999 : Math.abs(prevY - row.y);
    lines.push({ text, height: row.height, gap });
    prevY = row.y;
  }
  return lines;
}

module.exports = { parsePdf };
