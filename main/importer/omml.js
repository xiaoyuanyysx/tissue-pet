'use strict';
/**
 * omml.js —— 极轻量 XML 解析器 + OMML（Word 公式）→ Unicode 数学串转换
 * 策略：① 常见上下标/分式/根式/求和/积分 → Unicode；② 失败降级为 [公式]，绝不输出乱码
 */

/* ---------------- 轻量 XML ---------------- */

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s || '';
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITY[body] != null ? ENTITY[body] : m;
  });
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function parseAttrs(body) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(body))) attrs[m[1]] = decodeEntities(m[3] != null ? m[3] : m[4]);
  return attrs;
}

/** XML 字符串 → 节点树 {tag, attrs, children}，容错解析（不抛异常） */
function parseXml(xml) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const len = xml.length;
  let i = 0;
  const pushText = (text) => {
    if (!text) return;
    const t = decodeEntities(text);
    if (!t) return;
    stack[stack.length - 1].children.push({ tag: '#text', text: t });
  };

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      pushText(xml.slice(i));
      break;
    }
    if (lt > i) pushText(xml.slice(i, lt));
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const gt = xml.indexOf('>', lt);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    if (gt < 0) break;
    const raw = xml.slice(lt + 1, gt);
    if (raw[0] === '/') {
      const tag = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([\w:.-]+)/.exec(body);
    if (m) {
      const tag = m[1];
      const node = { tag, attrs: parseAttrs(body.slice(tag.length)), children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
    i = gt + 1;
  }
  return root;
}

function childrenOf(node, tag) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => c.tag === tag);
}

function firstOf(node, tag) {
  const arr = childrenOf(node, tag);
  return arr.length ? arr[0] : null;
}

/** 递归查找后代节点（限定标签） */
function findAll(node, tags, out = []) {
  if (!node || !node.children) return out;
  for (const c of node.children) {
    if (tags.includes(c.tag)) out.push(c);
    findAll(c, tags, out);
  }
  return out;
}

/* ---------------- Unicode 上下标 ---------------- */

const SUP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ', 'o': 'ᵒ',
  'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ', 'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'j': 'ʲ', 'k': 'ᵏ',
  'l': 'ˡ', 'm': 'ᵐ', 'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ', 'v': 'ᵛ', 'w': 'ʷ', 'y': 'ʸ', 'z': 'ᶻ'
};
const SUB = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'o': 'ₒ', 'x': 'ₓ', 'h': 'ₕ', 'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ',
  'p': 'ₚ', 's': 'ₛ', 't': 'ₜ', 'i': 'ᵢ', 'j': 'ⱼ', 'r': 'ᵣ', 'u': 'ᵤ', 'v': 'ᵥ'
};

function mapChars(str, table) {
  let out = '';
  for (const ch of str) {
    const rep = table[ch] || table[ch.toLowerCase()];
    if (!rep) return null;
    out += rep;
  }
  return out;
}

function wrap(s) {
  return s == null ? '' : s;
}

function paren(s) {
  const t = wrap(s).trim();
  if (t.length <= 1) return t;
  if (/^\(.*\)$/.test(t)) return t;
  return `(${t})`;
}

/* ---------------- OMML 求值 ---------------- */

const ACCENTS = { '\u0302': '̂', '\u0304': '̄', '\u0305': '̄', '\u0307': '̇', '\u0308': '̈', '\u0303': '̃', '\u20D7': '⃗' };

function evaluate(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.text;
  const tag = node.tag;

  switch (tag) {
    case 'm:oMath':
    case 'm:oMathPara':
    case 'm:e':
    case 'm:box':
    case 'm:borderBox':
    case 'm:phant':
    case 'm:groupChr':
    case 'm:limLow':
    case 'm:limUpp':
      return joinChildren(node);

    case 'm:r':
      return joinChildren(node);

    case 'm:t':
      // m:t 内部的空白是内容，需保留
      return node.children.map((c) => (c.tag === '#text' ? c.text : '')).join('');

    case 'm:f': {
      const num = wrap(evaluate(firstOf(node, 'm:num')));
      const den = wrap(evaluate(firstOf(node, 'm:den')));
      if (!num && !den) return '';
      return `${paren(num)}/${paren(den)}`;
    }

    case 'm:sSup': {
      const base = wrap(evaluate(firstOf(node, 'm:e')));
      const sup = wrap(evaluate(firstOf(node, 'm:sup')));
      const mapped = mapChars(sup.trim(), SUP);
      return mapped ? `${base}${mapped}` : `${base}^${paren(sup)}`;
    }

    case 'm:sSub': {
      const base = wrap(evaluate(firstOf(node, 'm:e')));
      const sub = wrap(evaluate(firstOf(node, 'm:sub')));
      const mapped = mapChars(sub.trim(), SUB);
      return mapped ? `${base}${mapped}` : `${base}_${paren(sub)}`;
    }

    case 'm:sSubSup': {
      const base = wrap(evaluate(firstOf(node, 'm:e')));
      const sub = wrap(evaluate(firstOf(node, 'm:sub')));
      const sup = wrap(evaluate(firstOf(node, 'm:sup')));
      const ms = mapChars(sub.trim(), SUB);
      const mp = mapChars(sup.trim(), SUP);
      if (ms && mp) return `${base}${ms}${mp}`;
      return `${base}_${paren(sub)}^${paren(sup)}`;
    }

    case 'm:sPre': {
      const base = wrap(evaluate(firstOf(node, 'm:e')));
      const sub = wrap(evaluate(firstOf(node, 'm:sub')));
      const sup = wrap(evaluate(firstOf(node, 'm:sup')));
      return `${mapChars(sub.trim(), SUB) || sub}${mapChars(sup.trim(), SUP) || sup}${base}`;
    }

    case 'm:rad': {
      const deg = wrap(evaluate(firstOf(node, 'm:deg'))).trim();
      const e = wrap(evaluate(firstOf(node, 'm:e')));
      if (!e) return '';
      return deg ? `${deg}√${paren(e)}` : `√${paren(e)}`;
    }

    case 'm:d': {
      const inner = childrenOf(node, 'm:e').map((e) => evaluate(e)).join(', ');
      const pr = firstOf(node, 'm:dPr');
      let beg = '(';
      let end = ')';
      if (pr) {
        const b = firstOf(pr, 'm:begChr');
        const en = firstOf(pr, 'm:endChr');
        if (b && b.attrs['m:val'] != null) beg = b.attrs['m:val'];
        if (en && en.attrs['m:val'] != null) end = en.attrs['m:val'];
      }
      return `${beg}${inner}${end}`;
    }

    case 'm:nary': {
      const pr = firstOf(node, 'm:naryPr');
      let chr = '∫';
      let sub = '';
      let sup = '';
      if (pr) {
        const c = firstOf(pr, 'm:chr');
        if (c && c.attrs['m:val']) chr = c.attrs['m:val'];
        if (firstOf(pr, 'm:subHide') && firstOf(pr, 'm:subHide').attrs['m:val'] === '1') sub = 'hide';
        if (firstOf(pr, 'm:supHide') && firstOf(pr, 'm:supHide').attrs['m:val'] === '1') sup = 'hide';
        if (!sub) sub = wrap(evaluate(firstOf(node, 'm:sub')));
        if (!sup) sup = wrap(evaluate(firstOf(node, 'm:sup')));
      } else {
        sub = wrap(evaluate(firstOf(node, 'm:sub')));
        sup = wrap(evaluate(firstOf(node, 'm:sup')));
      }
      const e = wrap(evaluate(firstOf(node, 'm:e')));
      const subTxt = sub === 'hide' ? '' : sub;
      const supTxt = sup === 'hide' ? '' : sup;
      const idx = subTxt ? mapChars(subTxt.trim(), SUB) || `_${paren(subTxt)}` : '';
      const idxUp = supTxt ? mapChars(supTxt.trim(), SUP) || `^${paren(supTxt)}` : '';
      return `${chr}${idx}${idxUp}${e ? ` ${e}` : ''}`;
    }

    case 'm:func': {
      const name = wrap(evaluate(firstOf(node, 'm:fName'))).trim();
      const e = wrap(evaluate(firstOf(node, 'm:e')));
      return `${name} ${e}`.trim();
    }

    case 'm:acc': {
      const e = wrap(evaluate(firstOf(node, 'm:e')));
      const pr = firstOf(node, 'm:accPr');
      let ch = '\u0302';
      if (pr) {
        const c = firstOf(pr, 'm:chr');
        if (c && c.attrs['m:val']) ch = c.attrs['m:val'];
      }
      const acc = ACCENTS[ch] || ch;
      return `${e}${acc}`;
    }

    case 'm:bar': {
      const e = wrap(evaluate(firstOf(node, 'm:e')));
      return `${e}\u0305`;
    }

    case 'm:eqArr': {
      const parts = childrenOf(node, 'm:e').map((e) => wrap(evaluate(e)).trim()).filter(Boolean);
      return parts.join('; ');
    }

    case 'm:m': {
      const rows = childrenOf(node, 'm:mr').map((mr) =>
        childrenOf(mr, 'm:e')
          .map((e) => wrap(evaluate(e)).trim())
          .filter(Boolean)
          .join(', ')
      );
      return rows.filter(Boolean).join('; ');
    }

    default: {
      if (/(Pr|props)$/.test(tag)) return '';
      return joinChildren(node);
    }
  }
}

function joinChildren(node) {
  if (!node || !node.children) return '';
  let out = '';
  for (const c of node.children) {
    // 元素之间的排版空白不参与公式文本
    if (c.tag === '#text') {
      if (!c.text || !c.text.trim()) continue;
      out += c.text.trim();
    } else {
      out += evaluate(c);
    }
  }
  return out;
}

/** 从包含 OMML 的 XML 片段中提取公式串；失败返回 null */
function ommlToText(fragment) {
  try {
    const tree = parseXml(fragment);
    const maths = findAll(tree, ['m:oMath', 'm:oMathPara']);
    if (!maths.length) return null;
    const text = maths.map((n) => evaluate(n)).join(' ');
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(cleaned)) return null;
    return cleaned;
  } catch {
    return null;
  }
}

module.exports = { parseXml, ommlToText, evaluate, findAll, firstOf, childrenOf };
