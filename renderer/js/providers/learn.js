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
      // 不显示 / 标星按语言分组：同一语言的词库（四级/雅思…）共用一套，换语言才是干净状态
      this.lang = '';
      this.langLabel = '';
      // 释义语言：词库带多语言释义时，纸面按这个语言取值（缺该语言回落 definition）
      this.defLang = '';
      this.defLangs = [];
      // 词库可切换的全部语言槽位（导入时勾选的，含自定义名）
      this.langs = [];
      // 词形（上方那行原始单词）所属语言，不随手选的学习语言漂移
      this.srcLang = '';
      // 原文释义所属语言，同样固定
      this.srcDefLang = '';
      this.state = null;
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
      const st = learnState || {};
      this.state = st;
      this.shuffleOn = !!st.shuffle;
      this.roundSeed = Number(st.roundSeed) || 1;
      this.hideDefinition = !!st.hideDefinition;
      this.orderCache.clear();
      this._syncSets();
    }

    /** 从分组存储里取出「当前词库语言」那一份；lang 未定（词库还没加载）时先空着 */
    _syncSets() {
      const st = this.state || {};
      const key = this.lang || 'unknown';
      const pick = (v) => {
        if (Array.isArray(v)) return v; // 老结构兜底（正常情况下主进程启动时已迁移）
        if (v && Array.isArray(v[key])) return v[key];
        return [];
      };
      this.hidden = new Set(pick(st.hidden));
      this.starred = new Set(pick(st.starred));
    }

    isHidden(word) {
      return this.hidden.has(word);
    }

    isStarred(word) {
      return this.starred.has(word);
    }

    async ensureLoaded(dictId) {
      if (this.dictId === dictId && this.entries.length) return;
      this.loading = true;
      try {
        let total = 0;
        let meta = null;
        try {
          const metas = await NS.call(window.petAPI.dictListAll());
          meta = metas.find((m) => m.id === dictId) || null;
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
        this.applyMeta(meta);
        this.orderCache.clear();
      } finally {
        this.loading = false;
      }
    }

    /** 吸收词库 meta：语言决定「不显示/标星」的分组，上下两种语言决定纸面两行取什么 */
    applyMeta(meta) {
      this.lang = (meta && meta.lang) || 'unknown';
      // 纸面上方 = 学习语言（wordLang），纸面下方 = 释义语言（defLang）
      this.langLabel = (meta && meta.wordLang) || NS.t('settings.learn.unknownLang');
      this.defLang = (meta && meta.defLang) || '';
      // 词形 / 原文释义各自的语言，固定不随手选漂移：手选日语时上方要能取到「りんご」，
      // 但 `entry.word` 永远属于英语那一栏，不能把它记到日语名下（否则上方永远换不了）
      this.srcLang = (meta && meta.srcWordLang) || this.langLabel;
      this.srcDefLang = (meta && meta.srcDefLang) || '';
      const list = meta && Array.isArray(meta.defLangs) ? meta.defLangs.filter(Boolean) : [];
      this.defLangs = list.length ? list : this.defLang ? [this.defLang] : [];
      // 词库实际可切换的语言（导入时勾选的槽位，含自定义名）
      const langs = meta && Array.isArray(meta.langs) ? meta.langs.filter(Boolean) : [];
      this.langs = langs.length ? langs : [...new Set([this.srcLang, this.defLang, ...this.defLangs].filter(Boolean))];
      this._syncSets();
    }

    /**
     * 一条词条在各语言下的文本，例如
     * `apple - n.苹果 / りんご` → { 英语:'apple', 中文:'n.苹果', 日语:'りんご' }。
     * 词形归 `srcLang`、原文释义归 `srcDefLang`（两者都固定），
     * 多语言释义再按各自语言覆盖上去——同一语言时以切分出来的那一段为准。
     */
    formsOf(entry) {
      if (!entry) return {};
      const forms = {};
      const src = this.srcLang || this.langLabel;
      if (src && entry.word) forms[src] = entry.word;
      if (this.srcDefLang && entry.definition) forms[this.srcDefLang] = entry.definition;
      return Object.assign(forms, entry.translations || {});
    }

    /** 纸面上方 = 学习语言对应的那份文本；该语言没有内容时回落词形 */
    wordOf(entry) {
      if (!entry) return '';
      const forms = this.formsOf(entry);
      const w = this.langLabel ? forms[this.langLabel] : '';
      return w || entry.word || '';
    }

    /**
     * 纸面下方 = 释义语言对应的那份文本；该语言没有内容时回落原文释义。
     * 上下不能是同一语言（设置里已互斥），这里再兜一层：同语言时直接给原释义。
     */
    definitionOf(entry) {
      if (!entry) return '';
      const dl = this.defLang;
      if (!dl || dl === this.langLabel) return entry.definition || '';
      const forms = this.formsOf(entry);
      return forms[dl] || entry.definition || '';
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
      // guard 用完 = 整个词库都被设为「不显示」。这时不能把隐藏词当结果返回，
      // 交给上层当成「没有可显示的词」（render 会给出可读的空态提示）。
      if (guard >= n) return -1;
      return idx;
    }

    /** 空态原因：没有词 / 词全被隐藏 —— 两种情况给不同的提示文案 */
    get emptyReason() {
      const n = this.entries.length;
      if (!n) return 'empty';
      let hidden = 0;
      for (const e of this.entries) {
        if (this.hidden.has(e.word)) hidden++;
      }
      return hidden >= n ? 'all-hidden' : 'none';
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
        // id 是内部主键（词条原始词形）：标星、不显示、进度锚点都用它。
        // word / definition 是「按当前语言设置取出来的显示文本」，会随语言切换而变，不能当键。
        id: e.word,
        word: this.wordOf(e),
        // 音标属于词形那一行：上方换成译文时不显示，免得多出一行对不上的注音
        phonetic: this.langLabel && this.langLabel !== this.srcLang ? '' : e.phonetic,
        definition: this.definitionOf(e),
        starred: this.starred.has(e.word)
      };
    }

    indexToAnchor(index) {
      const p = this.getPaper(index);
      if (!p) return null;
      const idx = this.entries.findIndex((e) => e.word === p.id);
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
        const msg =
          this.emptyReason === 'all-hidden'
            ? NS.t('paper.learnAllHidden')
            : NS.t('paper.learnEmpty');
        const d = document.createElement('div');
        d.className = 'empty-page';
        d.textContent = msg;
        el.appendChild(d);
        return;
      }
      const layout = this.layout;
      const card = document.createElement('div');
      card.className = 'word-card';

      const wordEl = document.createElement('div');
      wordEl.className = 'word-main';
      const star = paper.starred ? '*' : '';
      wordEl.textContent = star + paper.word;

      // 字号自适应：常规单词单行缩放；放不下一行就折行，底线是「一个字母都不能丢」。
      // 折行判定用真实测量（canvas 量 12px 下的宽度），不靠「西文≈0.62em/字符」的估算——
      // 中日文词条的字符宽度接近 1em，估算会把「12px 其实已经放不下」判成放得下。
      const text = star + paper.word;
      const maxW = Math.max(30, layout.paperWidthPx - 20);
      const maxFont = Math.min(72, Math.round(layout.paperHeightPx * 0.36));
      const w12 = Math.max(1, NS.measureText(text, 12, 800)); // 12px 下的实际宽度
      const wrap = w12 > maxW;
      let minFont = Math.min(12, Math.max(8, Math.floor((maxW / w12) * 12)));
      if (wrap) minFont = 12;
      minFont = NS.clamp(minFont, 8, Math.max(8, maxFont));
      const fs = NS.fitWordFont(text, wrap ? maxW * 2 : maxW, maxFont, minFont);
      wordEl.style.fontSize = `${fs}px`;
      if (wrap) {
        wordEl.classList.add('word-long');
        // 折行后还要保证纵向放得下：按行数把字号再压一次（极端长词也不会被高度裁掉）
        const maxH = layout.paperHeightPx * 0.58;
        let size = fs;
        for (let i = 0; i < 3; i++) {
          const lines = Math.max(1, Math.ceil(((w12 * size) / 12) / maxW));
          const byH = maxH / (lines * 1.14);
          if (byH >= size) break;
          size = Math.max(6, Math.floor(byH * 10) / 10);
        }
        wordEl.style.fontSize = `${size}px`;
      }
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
      starBtn.title = paper.starred ? NS.t('tip.unstarWord') : NS.t('tip.starWord');
      starBtn.textContent = '★';
      const hideBtn = document.createElement('span');
      hideBtn.className = 'wa-btn';
      hideBtn.dataset.act = 'hide';
      hideBtn.setAttribute('role', 'button');
      hideBtn.title = NS.t('tip.hideWord');
      hideBtn.textContent = '✕';
      acts.appendChild(starBtn);
      acts.appendChild(hideBtn);
      el.appendChild(acts);
    }
  }

  NS.LearnProvider = LearnProvider;
})(window);
