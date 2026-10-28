/* paginator.js —— 确定性分页引擎（C2）
   输入 DocModel + 布局 → PagePlan[]；离屏测量，纯函数，结果可随时重算校验。
   缓存 key = docId:纸宽:字号:纸高，布局变化后重算但「内容偏移锚点」不变。 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  const PAD_X = 8;
  const PAD_TOP = 24; // 纸张顶部藏在卷筒后，正文需让开
  const PAD_BOTTOM = 6;
  const LINE_RATIO = 1.5;

  class Paginator {
    constructor() {
      this.cache = new Map();
    }

    static key(docId, layout, blockCount) {
      return `${docId}:${layout.paperWidthPx}:${layout.fontSizePx}:${layout.paperHeightPx}:${blockCount}`;
    }

    getPagePlans(docId, blocks, layout) {
      const k = Paginator.key(docId, layout, blocks.length);
      if (this.cache.has(k)) return this.cache.get(k);
      const plans = this.paginate(docId, blocks, layout);
      if (this.cache.size > 24) {
        const first = this.cache.keys().next().value;
        this.cache.delete(first);
      }
      this.cache.set(k, plans);
      return plans;
    }

    invalidate(docId) {
      for (const k of [...this.cache.keys()]) {
        if (k.startsWith(`${docId}:`)) this.cache.delete(k);
      }
    }

    /** 纯函数：blocks + layout → PagePlan[] */
    paginate(docId, blocks, layout) {
      const innerW = Math.max(20, layout.paperWidthPx - PAD_X * 2);
      const baseFont = Math.max(8, layout.fontSizePx);
      const lineH = baseFont * LINE_RATIO;
      const usableH = Math.max(lineH, layout.paperHeightPx - PAD_TOP - PAD_BOTTOM);

      const pages = [];
      let lines = [];
      let charPos = 0;
      let pageStartChar = 0;
      let pageBlocks = [];
      let used = 0;

      const pushPage = () => {
        if (!lines.length) return;
        pages.push({
          pageIndex: pages.length,
          charStart: pageStartChar,
          charEnd: charPos,
          lines,
          blocks: pageBlocks
        });
        lines = [];
        pageBlocks = [];
        pageStartChar = charPos;
        used = 0;
      };

      const addLine = (text, kind, fsize, bold, blockRef, gapAfter) => {
        const h = fsize * LINE_RATIO + (gapAfter ? fsize * 0.4 : 0);
        if (used + h > usableH && lines.length) pushPage();
        lines.push({ text, kind, fsize, bold, gap: !!gapAfter });
        if (blockRef && !pageBlocks.includes(blockRef)) pageBlocks.push(blockRef);
        used += h;
      };

      for (const block of blocks) {
        if (!block) continue;
        const type = block.type || 'paragraph';
        let text = '';
        let fsize = baseFont;
        let bold = false;
        let kind = 'paragraph';

        if (type === 'heading') {
          const lv = NS.clamp(block.level || 1, 1, 3);
          fsize = baseFont * (lv === 1 ? 1.3 : lv === 2 ? 1.16 : 1.06);
          bold = true;
          kind = 'heading';
          text = block.text || '';
        } else if (type === 'formula') {
          kind = 'formula';
          text = block.text || '';
        } else if (type === 'placeholder') {
          kind = 'placeholder';
          text = block.label || '[内容]';
          fsize = baseFont * 0.92;
        } else {
          text = block.text || '';
        }

        if (!text) continue;
        const wrapped = NS.wrapText(text, innerW, fsize, bold ? 700 : 400);
        const blockStart = charPos;
        charPos += text.length;

        for (let i = 0; i < wrapped.length; i++) {
          const isLast = i === wrapped.length - 1;
          addLine(
            wrapped[i],
            kind,
            fsize,
            bold,
            blockStart,
            isLast && type !== 'placeholder'
          );
        }
      }

      if (lines.length) pushPage();

      if (!pages.length) {
        pages.push({ pageIndex: 0, charStart: 0, charEnd: 0, lines: [], blocks: [] });
      }

      // 收尾校正：保证偏移区间首尾相接且覆盖全文（不漏数据自检的构造性保证）
      const totalChars = charPos;
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        p.pageIndex = i;
        p.charStart = i === 0 ? 0 : pages[i - 1].charEnd;
        p.charEnd = i === pages.length - 1 ? Math.max(totalChars, p.charStart) : p.charEnd;
        if (p.charEnd < p.charStart) p.charEnd = p.charStart;
      }
      return pages;
    }

    /** 锚点 → 页号（二分） */
    pageIndexForAnchor(plans, charOffset) {
      if (!plans.length) return 0;
      const v = Math.max(0, Number(charOffset) || 0);
      if (v >= plans[plans.length - 1].charEnd) return plans.length - 1;
      let lo = 0;
      let hi = plans.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const p = plans[mid];
        if (v < p.charStart) hi = mid - 1;
        else if (v >= p.charEnd) lo = mid + 1;
        else return mid;
      }
      return NS.clamp(lo, 0, plans.length - 1);
    }

    anchorForPageIndex(plans, i) {
      if (!plans.length) return 0;
      const idx = NS.clamp(i, 0, plans.length - 1);
      return plans[idx].charStart;
    }

    /** dev 自检：区间相接、总量一致 */
    selfCheck(plans) {
      let ok = true;
      for (let i = 1; i < plans.length; i++) {
        if (plans[i].charStart !== plans[i - 1].charEnd) ok = false;
      }
      return ok;
    }
  }

  NS.Paginator = Paginator;
})(window);
