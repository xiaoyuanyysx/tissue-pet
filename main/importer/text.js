'use strict';
/**
 * text.js —— txt / md 解码与文本块切分
 * 编码：BOM → chardet → iconv-lite（GBK 系兜底），保证"绝不乱码"
 */
const chardet = require('chardet');
const iconv = require('iconv-lite');

const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g;

function sanitize(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(CTRL_RE, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E]/g, '');
}

function looksGarbled(text) {
  if (!text) return false;
  const bad = (text.match(/[\uFFFD]/g) || []).length;
  return bad > Math.max(2, text.length * 0.01);
}

/** buf → { text, encoding } */
function decodeBuffer(buf) {
  if (!buf || !buf.length) {
    const e = new Error('文件是空的，没有可显示的内容');
    e.code = 'E_EMPTY_DOC';
    e.expected = true;
    throw e;
  }
  // BOM 优先
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: sanitize(buf.slice(3).toString('utf8')), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: sanitize(iconv.decode(buf, 'utf16-le')), encoding: 'utf16-le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: sanitize(iconv.decode(buf, 'utf16-be')), encoding: 'utf16-be' };
  }

  let detected = null;
  try {
    detected = chardet.detect(buf, { sampleSize: 64 * 1024 });
  } catch {
    detected = null;
  }

  const candidates = [];
  if (detected) candidates.push(normalizeEnc(detected));
  candidates.push('utf-8', 'gb18030');

  const decodeRaw = (enc) => {
    try {
      return iconv.decode(buf, enc);
    } catch {
      return null;
    }
  };

  let best = null;
  const seen = new Set();
  for (const enc of candidates) {
    if (!enc || seen.has(enc)) continue;
    seen.add(enc);
    const raw = decodeRaw(enc);
    if (raw == null) continue;
    // 关键：在清洗之前判断替换符（\uFFFD），否则会被 sanitize 抹掉而误判
    const bad = (raw.match(/\uFFFD/g) || []).length;
    if (bad === 0) return { text: sanitize(raw), encoding: enc };
    if (!best || bad < best.bad) best = { raw, enc, bad };
  }

  if (best && best.bad / Math.max(1, best.raw.length) < 0.02) {
    return { text: sanitize(best.raw), encoding: best.enc };
  }

  const e = new Error('文件编码无法识别（不是 UTF-8/GBK 系）');
  e.code = 'E_ENCODING';
  e.expected = true;
  throw e;
}

function normalizeEnc(enc) {
  const e = String(enc).toLowerCase().replace(/[_\s]/g, '-');
  if (e === 'utf-8' || e === 'utf8' || e === 'ascii' || e === 'iso-8859-1') return 'utf-8';
  if (e.includes('utf-16le') || e === 'utf-16-le') return 'utf16-le';
  if (e.includes('utf-16be')) return 'utf16-be';
  if (e.includes('gb') || e.includes('big5') || e.includes('euc-cn')) return 'gb18030';
  if (e.includes('windows-1252')) return 'utf-8';
  return e;
}

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function extOf(p) {
  const m = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(p || '');
  return m ? m[1].toLowerCase() : '';
}

function mediaBlock(ext) {
  const img = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff'];
  const audio = ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac'];
  const video = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv'];
  let media = 'object';
  if (img.includes(ext)) media = 'image';
  else if (audio.includes(ext)) media = 'audio';
  else if (video.includes(ext)) media = 'video';
  const label = ext ? `[.${ext} ${media === 'image' ? '图片' : media === 'audio' ? '音频' : media === 'video' ? '视频' : '对象'}]` : '[附件]';
  return { type: 'placeholder', media, ext: ext || '', label };
}

/** md/txt → Block[] */
function textToBlocks(text, { markdown = false } = {}) {
  const blocks = [];
  const src = sanitize(text);
  if (!src.trim()) return blocks;

  const lines = src.split('\n');
  let buf = [];

  const flush = () => {
    const joined = buf.join('\n').replace(/\n+/g, markdown ? '\n' : ' ');
    const t = joined.trim();
    if (t) blocks.push({ type: 'paragraph', text: t });
    buf = [];
  };

  for (let raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    if (markdown) {
      const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (h) {
        flush();
        blocks.push({ type: 'heading', level: Math.min(3, h[1].length), text: cleanInline(h[2]) });
        continue;
      }
      if (/^([-*_])\1{2,}$/.test(trimmed)) {
        flush();
        continue;
      }
      const imgOnly = /^!\[[^\]]*\]\([^)]+\)$/.test(trimmed);
      if (imgOnly) {
        flush();
        const m = /^!\[[^\]]*\]\(([^)\s]+)/.exec(trimmed);
        blocks.push(mediaBlock(extOf(m ? m[1] : '')));
        continue;
      }
      const li = /^([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
      if (li) {
        flush();
        blocks.push({ type: 'paragraph', text: `· ${cleanInline(li[2])}` });
        continue;
      }
      if (/^>/.test(trimmed)) {
        flush();
        blocks.push({ type: 'paragraph', text: cleanInline(trimmed.replace(/^>\s?/, '')) });
        continue;
      }
      if (/^```/.test(trimmed)) {
        flush();
        continue;
      }
      buf.push(cleanInline(trimmed.replace(MD_IMAGE_RE, () => '')));
      continue;
    }

    buf.push(line);
  }
  flush();

  // 剔除空段落
  return blocks.filter((b) => b.type !== 'paragraph' || b.text.trim().length > 0);
}

function cleanInline(s) {
  return sanitize(
    String(s)
      .replace(MD_IMAGE_RE, '')
      .replace(MD_LINK_RE, '$1')
      .replace(/[*_~`]{1,3}/g, '')
      .replace(/<[^>]{1,80}>/g, '')
  ).trim();
}

module.exports = { decodeBuffer, sanitize, textToBlocks, mediaBlock, extOf };
