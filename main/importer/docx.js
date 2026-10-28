'use strict';
/**
 * docx.js —— docx → Block[]
 * 直接解 zip + 走 OOXML 节点树：保证「文字 / 公式 / 图片占位符」在段落内的原始顺序不被打乱
 * （mammoth 会把 OMML 公式静默丢弃，故此处自解析；mammoth 仅作兜底）
 */
const JSZip = require('jszip');
const { parseXml } = require('./omml');
const { evaluate } = require('./omml');
const { mediaBlock, extOf, sanitize } = require('./text');

const IMG = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'emf', 'wmf'];
const AUDIO = ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac', 'wma'];
const VIDEO = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv'];

function docxErr(msg, code = 'E_PARSE_DOCX') {
  const e = new Error(msg);
  e.code = code;
  e.expected = true;
  return e;
}

function walk(node, fn) {
  if (!node) return;
  fn(node);
  if (node.children) for (const c of node.children) walk(c, fn);
}

function findFirst(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    const r = findFirst(c, tag);
    if (r) return r;
  }
  return null;
}

function collectParagraphs(node, out) {
  if (!node) return out;
  if (node.tag === 'w:p') {
    out.push(node);
    return out;
  }
  if (node.children) for (const c of node.children) collectParagraphs(c, out);
  return out;
}

async function readRels(zip) {
  const map = {};
  const file = zip.file('word/_rels/document.xml.rels');
  if (!file) return map;
  try {
    const xml = await file.async('string');
    const re = /<Relationship\b[^>]*>/g;
    let m;
    while ((m = re.exec(xml))) {
      const tag = m[0];
      const id = /\bId\s*=\s*"([^"]+)"/.exec(tag);
      const target = /\bTarget\s*=\s*"([^"]+)"/.exec(tag);
      if (id && target) map[id[1]] = target[1];
    }
  } catch {
    /* ignore */
  }
  return map;
}

function mediaKind(ext) {
  if (IMG.includes(ext)) return 'image';
  if (AUDIO.includes(ext)) return 'audio';
  if (VIDEO.includes(ext)) return 'video';
  return 'object';
}

function relIdOf(node) {
  const a = node.attrs || {};
  return (
    a['r:embed'] ||
    a['r:id'] ||
    a['r:link'] ||
    a['o:relid'] ||
    (node.children && node.children.find((c) => c.tag === 'a:blip' && c.attrs['r:embed'])
      ? node.children.find((c) => c.tag === 'a:blip').attrs['r:embed']
      : null)
  );
}

/** 段落内联内容按顺序收集：text / media / formula */
function inlineParts(pNode, rels) {
  const parts = [];
  const pushText = (t) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === 'text') last.value += t;
    else parts.push({ kind: 'text', value: t });
  };

  const visit = (node) => {
    if (!node || !node.children) return;
    for (const c of node.children) {
      const tag = c.tag;
      if (tag === 'w:pPr' || tag === 'w:rPr' || /Pr$/.test(tag)) {
        // 属性节点内仍可能藏着公式/图片（罕见），但对文本无贡献
        if (tag === 'w:pPr' || tag === 'w:rPr') continue;
      }
      if (tag === '#text') continue;
      if (tag === 'w:t') {
        pushText(c.children.map((x) => (x.tag === '#text' ? x.text : '')).join(''));
        continue;
      }
      if (tag === 'w:tab') {
        pushText(' ');
        continue;
      }
      if (tag === 'w:br' || tag === 'w:cr') {
        pushText('\n');
        continue;
      }
      if (tag === 'w:noBreakHyphen') {
        pushText('-');
        continue;
      }
      if (tag === 'm:oMath' || tag === 'm:oMathPara') {
        parts.push({ kind: 'formula', value: safeEval(c) });
        continue;
      }
      if (tag === 'w:drawing' || tag === 'w:pict' || tag === 'w:object' || tag === 'w:objectEmbed') {
        const id = relIdOf(c) || findRelIdDeep(c);
        const target = id ? rels[id] : null;
        const ext = extOf(target);
        parts.push({ kind: 'media', block: mediaBlock(ext, mediaKind(ext)) });
        continue;
      }
      if (tag === 'w:proofErr' || tag === 'w:bookmarkStart' || tag === 'w:bookmarkEnd') continue;
      visit(c);
    }
  };
  visit(pNode);
  return parts;
}

function findRelIdDeep(node) {
  let found = null;
  walk(node, (n) => {
    if (found) return;
    const a = n.attrs || {};
    if (a['r:embed']) found = a['r:embed'];
    else if (a['r:id']) found = a['r:id'];
    else if (a['o:relid']) found = a['o:relid'];
  });
  return found;
}

function safeEval(node) {
  try {
    const text = evaluate(node).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function headingLevel(pNode) {
  const pPr = pNode.children.find((c) => c.tag === 'w:pPr');
  if (!pPr) return 0;
  const style = pPr.children.find((c) => c.tag === 'w:pStyle');
  if (style && style.attrs['w:val']) {
    const v = String(style.attrs['w:val']);
    const h = /heading\s*([1-9])/i.exec(v) || /标题\s*([1-9])/.exec(v) || /^([1-9])$/.exec(v);
    if (h) return Math.min(3, Number(h[1]));
  }
  const outline = pPr.children.find((c) => c.tag === 'w:outlineLvl');
  if (outline && outline.attrs['w:val'] != null) {
    const lv = Number(outline.attrs['w:val']);
    if (Number.isFinite(lv) && lv >= 0 && lv <= 2) return lv + 1;
  }
  return 0;
}

async function parseDocx(buf) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw docxErr('该文件不是有效的 Word 文档');
  }
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw docxErr('该文件不是有效的 Word 文档（缺少正文）');

  let xml = '';
  try {
    xml = await docFile.async('string');
  } catch {
    throw docxErr('Word 文档正文无法读取，文件可能已损坏');
  }
  const rels = await readRels(zip);

  const tree = parseXml(xml);
  const body = findFirst(tree, 'w:body') || tree;
  const paragraphs = collectParagraphs(body, []);
  const blocks = [];

  for (const p of paragraphs) {
    const level = headingLevel(p);
    const parts = inlineParts(p, rels);
    let textBuf = '';

    const flushText = () => {
      const t = sanitize(textBuf).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
      textBuf = '';
      if (!t) return;
      if (level > 0) blocks.push({ type: 'heading', level, text: t });
      else blocks.push({ type: 'paragraph', text: t });
    };

    for (const part of parts) {
      if (part.kind === 'text') {
        textBuf += part.value;
        continue;
      }
      flushText();
      if (part.kind === 'formula') {
        if (part.value) blocks.push({ type: 'formula', text: part.value });
        else blocks.push({ type: 'placeholder', media: 'formula', ext: '', label: '[公式]' });
      } else if (part.kind === 'media') {
        blocks.push(part.block);
      }
    }
    flushText();
  }

  if (!blocks.length) {
    const fallback = await mammothFallback(buf);
    if (fallback.length) return fallback;
    throw docxErr('文档是空的，没有可显示的内容', 'E_EMPTY_DOC');
  }
  return blocks;
}

/** 兜底：mammoth 转 HTML → 粗粒度 Block（保底不丢字） */
async function mammothFallback(buf) {
  try {
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    const blocks = [];
    const re = /<(h[1-3]|p|li)>([\s\S]*?)<\/\1>|<img[^>]*src="data:[^;]+;base64|placeholder/gi;
    let m;
    while ((m = re.exec(value))) {
      if (m[0].toLowerCase().startsWith('<img')) {
        blocks.push({ type: 'placeholder', media: 'image', ext: 'png', label: '[.png 图片]' });
        continue;
      }
      if (m[0] === 'placeholder') continue;
      const tag = m[1];
      const inner = m[2] || '';
      const text = sanitize(
        inner
          .replace(/<img[^>]*>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
      ).trim();
      if (!text) continue;
      if (tag.toLowerCase().startsWith('h')) {
        blocks.push({ type: 'heading', level: Math.min(3, Number(tag[1])), text });
      } else {
        blocks.push({ type: 'paragraph', text });
      }
    }
    return blocks;
  } catch {
    return [];
  }
}

module.exports = { parseDocx };
