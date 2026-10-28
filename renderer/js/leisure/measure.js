/* measure.js —— 离屏文本测量与断行（确定性：结果只取决于文本与字号） */
(function (global) {
  'use strict';
  const NS = global.XZ;

  const widthCache = new Map();

  function charWidth(ch, fontPx, weight) {
    const key = `${weight}|${fontPx}|${ch}`;
    let w = widthCache.get(key);
    if (w == null) {
      w = NS.measureText(ch, fontPx, weight);
      widthCache.set(key, w);
    }
    return w;
  }

  /**
   * 文本 → 行数组（CJK 逐字断行，西文优先在空格处断）
   * @returns {string[]}
   */
  function wrapText(text, maxWidth, fontPx, weight) {
    const out = [];
    const src = String(text == null ? '' : text);
    const blocks = src.split('\n');
    for (const block of blocks) {
      if (!block) {
        out.push('');
        continue;
      }
      let line = '';
      let lineW = 0;
      let lastSpace = -1;
      for (const ch of block) {
        const w = charWidth(ch, fontPx, weight);
        if (lineW + w > maxWidth && line) {
          if (lastSpace > 0 && line.length - lastSpace > 1) {
            const head = line.slice(0, lastSpace);
            const tail = line.slice(lastSpace + 1);
            out.push(head);
            line = tail;
            lineW = 0;
            for (const c of tail) lineW += charWidth(c, fontPx, weight);
          } else {
            out.push(line);
            line = '';
            lineW = 0;
          }
          lastSpace = -1;
        }
        line += ch;
        lineW += w;
        if (ch === ' ' || ch === '\t') lastSpace = line.length - 1;
      }
      out.push(line);
    }
    return out;
  }

  NS.wrapText = wrapText;

  /** 估算一段文本占多少行 */
  NS.countLines = function (text, maxWidth, fontPx, weight) {
    return wrapText(text, maxWidth, fontPx, weight).length;
  };
})(window);
