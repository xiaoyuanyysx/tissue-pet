/* learn.js —— 学习模式内容源（B1–B7）
   getPaper(index) 为纯函数：同一持久化状态下重复调用结果一致（I1）
   打乱 = 由 roundSeed + 轮次派生的确定性洗牌，禁止 Math.random 直排 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffleWithSeed(n, seed) {
    const rnd = mulberry32(seed);
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  class LearnProvider {
    constructor() {
      this.id = 'learn';
      this.dictId = '';
      this.entries = [];
      this.pos = 0;
      this.hidden = new Set();
      this.starred = new Set();
      this.shuffleOn = false;
      this.roundSeed = 1;
      this.hideDefinition = false;
      this.layout = { paperWidthPx: 170, paperHeightPx: 200, fontSizePx: 15, darkMode: false };
      this.orderCache = new Map();
      this.pins = new Map();
      this.loading = false;
    }

    get paperCount() {
      return Infinity;
    }

    get dictName() {
      return this.dictId;
    }

    /* ---------- 状态 ---------- */

    applyState(learnState) {
      this.hidden = new Set(learnState.hidden || []);
      this.starred = new Set(learnState.starred || []);
      this.shuffleOn = !!learnState.shuffle;
      this.roundSeed = Number(learnState.roundSeed) || 1;
      this.hideDefinition = !!learnState.hideDefinition;
      this.orderCache.clear();
    }

    async ensureLoaded(dictId) {
      if (this.dictId === dictId && this.entries.length) return;
      this.loading = true;
      try {
        let total = 0;
        try {
          const metas = await NS.call(window.petAPI.dictListAll());
          const meta = metas.find((m) => m.id === dictId);
          total = meta ? meta.count : 0;
        } catch {
          total = 0;
        }
        const entries = [];
        if (total > 0) {
          for (let off = 0; off < total; off += 500) {
            const chunk = await NS.call(window.petAPI.dictGetEntries(dictId, off, 500));
            if (!chunk || !chunk.length) break;
            entries.push(...chunk);
            if (chunk.length < 500) break;
          }
        }
        this.entries = entries;
        this.dictId = dictId;
        this.orderCache.clear();
      } finally {
        this.loading = false;
      }
    }

    relayout(layout) {
      this.layout = Object.assign({}, this.layout, layout);
    }

    serialize() {
      return { dictId: this.dictId, pos: this.pos };
    }

    restore(snapshot) {
      if (!snapshot) return;
      if (Number.isFinite(snapshot.pos)) this.pos = Math.max(0, snapshot.pos);
    }

    get currentWord() {
      const p = this.getPaper(0);
      return p ? p.word : '';
    }

    /* ---------- 顺序 ---------- */

    orderFor(round) {
      const n = this.entries.length;
      if (!this.shuffleOn) return null;
      if (this.orderCache.has(round)) return this.orderCache.get(round);
      const seed = (this.roundSeed ^ (round * 2654435761)) >>> 0;
      const arr = shuffleWithSeed(n, seed || 1);
      if (this.orderCache.size > 8) {
        const first = this.orderCache.keys().next().value;
        this.orderCache.delete(first);
      }
      this.orderCache.set(round, arr);
      return arr;
    }

    entryIndexAt(absPos) {
      const n = this.entries.length;
      if (!n) return -1;
      const round = Math.floor(absPos / n);
      const k = ((absPos % n) + n) % n;
      const order = this.orderFor(round);
      let idx = order ? order[k] : k;
      let guard = 0;
      while (this.hidden.has(this.entries[idx].word) && guard < n) {
        idx = (idx + 1) % n;
        guard++;
      }
      return idx;
    }

    /* ---------- 内容 ---------- */

    getPaper(index) {
      if (!this.entries.length) return null;
      const pin = this.pins.get(index);
      let ei;
      if (pin && Number.isFinite(pin.anchor && pin.anchor.value)) {
        ei = pin.anchor.value;
      } else {
        const abs = this.pos + index;
        if (abs < 0) return null;
        ei = this.entryIndexAt(abs);
        if (ei < 0) return null;
      }
      const e = this.entries[ei];
      if (!e) return null;
      return {
        kind: 'word',
        word: e.word,
        phonetic: e.phonetic,
        definition: e.definition,
        starred: this.starred.has(e.word)
      };
    }

    indexToAnchor(index) {
      const p = this.getPaper(index);
      if (!p) return null;
      const idx = this.entries.findIndex((e) => e.word === p.word);
      return { type: 'entryIndex', value: idx >= 0 ? idx : 0 };
    }

    anchorToIndex(anchor) {
      if (!anchor || anchor.type !== 'entryIndex') return null;
      const n = this.entries.length;
      if (!n) return null;
      for (let d = 0; d <= n; d++) {
        for (const abs of [this.pos + d, this.pos - d]) {
          if (abs < 0) continue;
          if (this.entryIndexAt(abs) === anchor.value) return abs - this.pos;
        }
      }
      return null;
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

    /* ---------- 渲染 ---------- */

    render(el, paper) {
      el.innerHTML = '';
      el.classList.remove('empty');
      if (!paper) {
        el.innerHTML = '<div class="empty-page">这个词库还没有内容</div>';
        return;
      }
      const layout = this.layout;
      const card = document.createElement('div');
      card.className = 'word-card';

      const wordEl = document.createElement('div');
      wordEl.className = 'word-main';
      const star = paper.starred ? '*' : '';
      wordEl.textContent = star + paper.word;

      const maxW = Math.max(30, layout.paperWidthPx - 20);
      const maxFont = Math.min(72, Math.round(layout.paperHeightPx * 0.36));
      const minFont = Math.min(12, maxFont);
      const fs = NS.fitWordFont(star + paper.word, maxW, maxFont, minFont);
      wordEl.style.fontSize = `${fs}px`;
      if (star) {
        const span = document.createElement('span');
        span.className = 'star';
        span.textContent = '*';
        wordEl.textContent = paper.word;
        wordEl.prepend(span);
      }
      card.appendChild(wordEl);

      if (paper.phonetic) {
        const ph = document.createElement('div');
        ph.className = 'word-phonetic';
        ph.textContent = `/${paper.phonetic.replace(/^\/|\/$/g, '')}/`;
        card.appendChild(ph);
      }

      if (paper.definition) {
        const def = document.createElement('div');
        def.className = 'word-def';
        if (this.hideDefinition) def.classList.add('hidden-def');
        def.textContent = paper.definition;
        def.style.setProperty('--def-size', `${Math.max(9, layout.fontSizePx)}px`);
        card.appendChild(def);
      }
      el.appendChild(card);

      // 纸面上的快捷按钮：标星 / 不显示（只在 .is-current 那张显示）
      const acts = document.createElement('div');
      acts.className = 'word-actions';
      const starBtn = document.createElement('span');
      starBtn.className = `wa-btn${paper.starred ? ' on' : ''}`;
      starBtn.dataset.act = 'star';
      starBtn.setAttribute('role', 'button');
      starBtn.title = paper.starred ? '取消标星' : '标星（难点词）';
      starBtn.textContent = '★';
      const hideBtn = document.createElement('span');
      hideBtn.className = 'wa-btn';
      hideBtn.dataset.act = 'hide';
      hideBtn.setAttribute('role', 'button');
      hideBtn.title = '不再显示这个词';
      hideBtn.textContent = '✕';
      acts.appendChild(starBtn);
      acts.appendChild(hideBtn);
      el.appendChild(acts);
    }
  }

  NS.LearnProvider = LearnProvider;
})(window);
