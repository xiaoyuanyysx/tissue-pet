'use strict';
/**
 * pdf.js —— pdf → Block[]
 * pdfjs-dist 取文本项 + 坐标，按 y 聚行、按 x 排序，重排为段落流（非整页截图）
 */
const path = require('path');

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
  const e = new Error(msg);
  e.code = 'E_PARSE_PDF';
  e.expected = true;
  return e;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

function isCJK(ch) {
  return CJK_RE.test(ch || '');
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
      throw pdfErr('该 PDF 已加密，无法读取文本');
    }
    throw pdfErr('该 PDF 已损坏或格式不受支持，无法读取文本');
  }

  const blocks = [];
  let totalChars = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    let page;
    try {
      page = await doc.getPage(p);
    } catch {
      continue;
    }
    let content;
    try {
      content = await page.getTextContent();
    } catch {
      continue;
    }

    const items = (content.items || []).filter((it) => typeof it.str === 'string');
    const lines = groupLines(items);
    if (!lines.length) continue;

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
        blocks.push({ type: 'heading', level: line.height > median * 1.9 ? 1 : line.height > median * 1.55 ? 2 : 3, text });
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
    prev = null;
  }

  try {
    await doc.destroy();
  } catch {
    /* ignore */
  }

  if (!blocks.length || totalChars < 3) {
    throw pdfErr('该 PDF 不含可提取文本（可能是扫描件），无法显示内容');
  }
  return blocks;
}

/** 按 y 聚行，行内按 x 排序 */
function groupLines(items) {
  const rows = [];
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
