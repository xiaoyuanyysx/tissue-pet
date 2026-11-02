/* rich.js —— 清单富文本：解析 / 净化 / 按纸宽断行
   为什么需要它：
   清单条目现在可以写「一整段带不同字号的文字」。如果交给 CSS 自动折行，
   分页时只能凭字数估行数，估偏一行，纸面就 overflow:hidden 把最后一两行裁掉，
   用户看到的就是「字迹显示不全」。
   这里用**和渲染完全相同的字体/字号/字重**做断行，纸面按断好的行逐行渲染（<br> 换行），
   于是「估出来的行」== 「画出来的行」，多长都只是多占一张纸，不会再裁字。

   对外 API：
     NS.Rich.parse(html)                → runs[]（{text,size,bold,italic,underline,strike,color}）
     NS.Rich.sanitize(html)             → 只保留白名单标签/内联样式的安全 HTML
     NS.Rich.toHtml(runs)               → runs 序列化成安全 HTML
     NS.Rich.plain(html)                → 纯文本（列表、搜索、导出用）
     NS.Rich.plainToHtml(text)          → 纯文本转 HTML（\n → <br>）
     NS.Rich.lines(runs, maxW, basePx)  → 行数组 [{runs:[], h}]，h 是该行高度
     NS.Rich.linesToHtml(lines)         → 一段行渲染成 HTML
     NS.Rich.heightOf(lines)            → 行数组总高
*/
(function (global) {
  'use strict';
  const NS = global.XZ;

  const BLOCK_TAGS = {
    DIV: 1, P: 1, LI: 1, UL: 1, OL: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1,
    BLOCKQUOTE: 1, PRE: 1, SECTION: 1, ARTICLE: 1, TR: 1, TABLE: 1
  };
  const MIN_SIZE = 9;
  const MAX_SIZE = 48;
  const LINE_RATIO = 1.45;

  const widthCache = new Map();

  function clampSize(v, base) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return base;
    return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
  }

  function parseColor(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
    if (/^rgba?\(\s*[\d.\s,%]+\)$/i.test(s)) return s;
    return '';
  }

  function charWidth(ch, size, bold) {
    const key = `${bold ? 1 : 0}|${size}|${ch}`;
    let w = widthCache.get(key);
    if (w == null) {
      w = NS.measureText(ch, size, bold ? 700 : 400);
      if (widthCache.size > 30000) widthCache.clear();
      widthCache.set(key, w);
    }
    return w;
  }

  const sameStyle = (a, b) =>
    (a.size || 0) === (b.size || 0) &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    (a.color || '') === (b.color || '') &&
    (a.bg || '') === (b.bg || '');

  /** <mark> 的默认荧光笔底色（半透明，黑夜模式下也压得住浅色字） */
  const MARK_BG = 'rgba(250, 204, 21, 0.42)';

  /* ---------------- 解析 ---------------- */

  function parse(html) {
    const runs = [];
    const src = String(html == null ? '' : html);
    if (!src.trim()) return runs;

    let root = null;
    try {
      const doc = new DOMParser().parseFromString(`<div id="__rich_root">${src}</div>`, 'text/html');
      root = doc.getElementById('__rich_root');
    } catch {
      root = null;
    }
    if (!root) return [{ text: src }];

    const base = { size: 0, bold: false, italic: false, underline: false, strike: false, color: '', bg: '' };
    walk(root, base);
    return tidy(runs);

    function push(text, st) {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && sameStyle(last, st)) last.text += text;
      else runs.push(Object.assign({ text }, st));
    }

    /** 段落边界只加一个换行：<div>a</div><div>b</div> 不该变成中间空一行 */
    function pushBreak(st) {
      const last = runs[runs.length - 1];
      if (!last) return;
      if (last.text.slice(-1) === '\n') return;
      push('\n', st);
    }

    function walk(node, st) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          push(child.nodeValue, st);
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = String(child.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'META' || tag === 'LINK') continue;
        if (tag === 'BR') {
          push('\n', st);
          continue;
        }
        const next = Object.assign({}, st);
        if (tag === 'B' || tag === 'STRONG') next.bold = true;
        if (tag === 'I' || tag === 'EM') next.italic = true;
        if (tag === 'U') next.underline = true;
        if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next.strike = true;

        const style = child.style || {};
        if (style.fontSize) {
          const px = parseFloat(style.fontSize);
          // 只认 px：em/rem/% 在纸面这种固定排版里没有参照，按继承字号处理更安全
          if (Number.isFinite(px) && /px$/i.test(String(style.fontSize).trim())) next.size = px;
        }
        if (style.fontWeight && (String(style.fontWeight) === 'bold' || Number(style.fontWeight) >= 600)) {
          next.bold = true;
        }
        if (String(style.fontStyle || '').includes('italic')) next.italic = true;
        const deco = `${style.textDecoration || ''} ${style.textDecorationLine || ''}`;
        if (deco.includes('underline')) next.underline = true;
        if (deco.includes('line-through')) next.strike = true;
        if (style.color) {
          const c = parseColor(style.color);
          if (c) next.color = c;
        }
        // 突出显示（荧光笔）：background / background-color 都认，纸面按底色绘制
        const bgRaw = style.backgroundColor || style.background || '';
        if (bgRaw) {
          const b = parseColor(bgRaw);
          if (b) next.bg = b;
        }
        if (tag === 'MARK') next.bg = MARK_BG;
        if (tag === 'FONT') {
          const fa = child.getAttribute('size');
          if (fa && Number.isFinite(Number(fa))) next.size = 12 + Number(fa) * 2;
          const fc = parseColor(child.getAttribute('color'));
          if (fc) next.color = fc;
        }

        const isBlock = !!BLOCK_TAGS[tag];
        if (isBlock) pushBreak(st);
        walk(child, next);
        if (isBlock) pushBreak(st);
      }
    }
  }

  /** 收尾：压缩连续空行、去掉首尾换行、字号钳位 */
  function tidy(runs) {
    const out = [];
    for (const r of runs) {
      if (!r || !r.text) continue;
      out.push({
        text: String(r.text),
        size: r.size ? clampSize(r.size, 0) : 0,
        bold: !!r.bold,
        italic: !!r.italic,
        underline: !!r.underline,
        strike: !!r.strike,
        color: r.color || '',
        bg: r.bg || ''
      });
    }
    if (!out.length) return out;
    // 首尾换行没有意义（分页会把它算成空行）
    out[0].text = out[0].text.replace(/^\n+/, '');
    const last = out.length - 1;
    out[last].text = out[last].text.replace(/\n+$/, '');
    // 连续 3 个以上换行压成 2 个（一个空行）
    for (const r of out) r.text = r.text.replace(/\n{3,}/g, '\n\n');
    return out.filter((r) => r.text);
  }

  /* ---------------- 序列化（同时充当净化器） ---------------- */

  function runHtml(r) {
    const text = String(r.text || '');
    if (!text) return '';
    let html = NS.escape(text).replace(/\n/g, '<br>');
    if (r.underline) html = `<u>${html}</u>`;
    if (r.strike) html = `<s>${html}</s>`;
    if (r.italic) html = `<i>${html}</i>`;
    if (r.bold) html = `<b>${html}</b>`;
    const st = [];
    if (r.size) st.push(`font-size:${r.size}px`);
    if (r.color) st.push(`color:${r.color}`);
    if (r.bg) st.push(`background-color:${r.bg}`);
    if (st.length) html = `<span style="${st.join(';')}">${html}</span>`;
    return html;
  }

  function toHtml(runs) {
    return (runs || []).map(runHtml).join('');
  }

  function sanitize(html) {
    return toHtml(parse(html));
  }

  function plain(html) {
    const runs = parse(html);
    return runs
      .map((r) => r.text)
      .join('')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function plainToHtml(text) {
    const t = String(text == null ? '' : text);
    if (!t) return '';
    return NS.escape(t).replace(/\r\n|\r|\n/g, '<br>');
  }

  /* ---------------- 断行 ---------------- */

  /**
   * 按纸宽断行。返回 [{ runs: [{text,size,bold,...}], h }]
   * 断行单位是「字符」：中文逐字、西文到宽度也会断（纸本来就窄，
   * 与原先 CSS `word-break: break-word` 的效果一致，但结果是确定的）。
   */
  function lines(runs, maxWidth, baseSize) {
    const base = Math.max(MIN_SIZE, Number(baseSize) || 14);
    const maxW = Math.max(12, Number(maxWidth) || 120);
    const out = [];
    let cur = { runs: [], w: 0, h: 0 };

    const flush = () => {
      // 空行也要占一整行高度：HTML 里 <br><br> 会画出一行空白，
      // 这里若按 0 算，分页就会少留一行，最后一行被纸边裁掉。
      if (!cur.h) cur.h = base * LINE_RATIO;
      out.push(cur);
      cur = { runs: [], w: 0, h: 0 };
    };

    const add = (ch, r, size) => {
      const h = size * LINE_RATIO;
      cur.h = Math.max(cur.h, h);
      const last = cur.runs[cur.runs.length - 1];
      const style = {
        size: size === base ? 0 : size,
        bold: !!r.bold,
        italic: !!r.italic,
        underline: !!r.underline,
        strike: !!r.strike,
        color: r.color || '',
        bg: r.bg || ''
      };
      if (last && sameStyle(last, style)) last.text += ch;
      else cur.runs.push(Object.assign({ text: ch }, style));
    };

    for (const r of runs || []) {
      const text = String(r.text || '');
      if (!text) continue;
      const size = clampSize(r.size || base, base);
      for (const ch of text) {
        if (ch === '\n') {
          flush();
          continue;
        }
        const w = charWidth(ch, size, r.bold);
        if (cur.w > 0 && cur.w + w > maxW) flush();
        add(ch, r, size);
        cur.w += w;
      }
    }
    if (cur.runs.length || !out.length) flush();
    // 末尾空行不占纸（除非整段都是空的，上面已经兜住）
    while (out.length > 1 && !out[out.length - 1].runs.length) out.pop();
    return out;
  }

  function linesToHtml(seg) {
    if (!seg || !seg.length) return '';
    return seg
      .map((l) => (l.runs && l.runs.length ? l.runs.map(runHtml).join('') : '&nbsp;'))
      .join('<br>');
  }

  function heightOf(seg) {
    let h = 0;
    for (const l of seg || []) h += l.h || 0;
    return h;
  }

  NS.Rich = {
    parse,
    tidy,
    sanitize,
    toHtml,
    plain,
    plainToHtml,
    lines,
    linesToHtml,
    heightOf,
    LINE_RATIO,
    MIN_SIZE,
    MAX_SIZE
  };
})(window);
