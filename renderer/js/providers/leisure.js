/* leisure.js —— 休闲模式内容源（C1–C5）
   唯一进度表示：{docId, charOffset}；分页结果由 Paginator 纯函数生成，布局变化后按锚点重定位。 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  class LeisureProvider {
    constructor(paginator) {
      this.id = 'leisure';
      this.paginator = paginator;
      this.docId = null;
      this.docName = '';
      this.blocks = [];
      this.plans = [];
      this.layout = { paperWidthPx: 170, paperHeightPx: 200, fontSizePx: 15, darkMode: false };
      this.pins = new Map();
      this.loading = false;
    }

    get paperCount() {
      return this.plans.length;
    }

    applyState(leisureState) {
      this.docId = leisureState.activeDocId || null;
      const meta = (leisureState.docs || []).find((d) => d.docId === this.docId);
      this.docName = meta ? meta.name : '';
    }

    async loadDoc(docId) {
      this.docId = docId || null;
      this.blocks = [];
      this.plans = [];
      this.pins.clear();
      if (!docId) return;
      this.loading = true;
      try {
        const blocks = [];
        for (let off = 0; ; off += 500) {
          const chunk = await NS.call(window.petAPI.docGetBlocks(docId, off, 500));
          if (!chunk || !chunk.length) break;
          blocks.push(...chunk);
          if (chunk.length < 500) break;
        }
        this.blocks = blocks;
        this.repaginate();
      } finally {
        this.loading = false;
      }
    }

    async ensureLoaded(leisureState) {
      const docId = leisureState.activeDocId || null;
      if (docId === this.docId && this.plans.length) return;
      await this.loadDoc(docId);
    }

    repaginate() {
      if (!this.docId) {
        this.plans = [];
        return;
      }
      this.plans = this.paginator.getPagePlans(this.docId, this.blocks, this.layout);
    }

    relayout(layout) {
      this.layout = Object.assign({}, this.layout, layout);
      this.repaginate();
    }

    get hasDoc() {
      return !!this.docId && this.plans.length > 0;
    }

    getPaper(index) {
      if (!this.plans.length) return null;
      const pin = this.pins.get(index);
      let plan = null;
      if (pin && pin.anchor && pin.anchor.type === 'charOffset') {
        const pi = this.paginator.pageIndexForAnchor(this.plans, pin.anchor.value);
        plan = this.plans[pi];
      } else {
        plan = this.plans[index] || null;
      }
      if (!plan) return null;
      return {
        kind: 'text',
        docId: this.docId,
        pageIndex: plan.pageIndex,
        charStart: plan.charStart,
        charEnd: plan.charEnd,
        lines: plan.lines,
        blocks: plan.blocks
      };
    }

    indexToAnchor(index) {
      if (!this.plans.length) return null;
      const i = NS.clamp(index, 0, this.plans.length - 1);
      return { type: 'charOffset', docId: this.docId, value: this.plans[i].charStart };
    }

    anchorToIndex(anchor) {
      if (!anchor || anchor.type !== 'charOffset' || !this.plans.length) return null;
      return this.paginator.pageIndexForAnchor(this.plans, anchor.value);
    }

    setPin(index, record) {
      this.pins.set(index, record);
    }

    clearPin(index) {
      this.pins.delete(index);
    }

    clearPins() {
      this.pins.clear();
    }

    render(el, paper) {
      el.innerHTML = '';
      if (!paper) {
        el.innerHTML = '<div class="empty-page">没有可显示的内容<br />可在设置中导入资料</div>';
        return;
      }
      const box = document.createElement('div');
      box.className = 'text-page';
      for (const line of paper.lines || []) {
        const div = document.createElement('div');
        div.className = `text-line ${line.kind || ''}`.trim();
        div.textContent = line.text || '\u00A0';
        div.style.fontSize = `${line.fsize}px`;
        div.style.lineHeight = '1.5';
        div.style.fontWeight = line.bold ? '700' : '400';
        if (line.gap) div.style.marginBottom = `${Math.round((line.fsize || 14) * 0.4)}px`;
        box.appendChild(div);
      }
      el.appendChild(box);
    }
  }

  NS.LeisureProvider = LeisureProvider;
})(window);
