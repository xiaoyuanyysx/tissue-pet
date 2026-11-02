/* checklist.js —— 清单模式内容源（D1–D5）+ 清单数据操作
   分页模型（v1.7 重写）：
     · 一个条目可以很长（富文本编辑器写的大段计划），所以分页单位是「行」而不是「条目」；
     · 行由 NS.Rich.lines 按纸宽 + 每段自己的字号断好，渲染时逐行输出（<br>），
       断出来的行 == 画出来的行 —— 纸再窄也不会把最后几行裁掉；
     · 一个条目跨页时，续页上的那几行不画勾选框（.cl-box.cont），避免误以为多了一条。
   循环模型：
     · 清单纸带和单词模式一样是**无限**的：拉到底继续往下，会接回第一页（round 循环），
       不再是「已经到末尾了」。想关掉可在设置 → 模式 → 清单里关「循环浏览」。
*/
(function (global) {
  'use strict';
  const NS = global.XZ;

  // 纸面上下内边距（.checklist-page: 24px 8px 6px）+ 标题行高
  const PAGE_PAD_Y = 30;
  const TITLE_H = 18;
  // 勾选框 9 + 间隙 4 ≈ 文字左侧让位；两侧 padding 各 8
  const TEXT_INSET_X = 29;
  // 自动序号的颜色：黑白主题下都够清楚
  const NUMBER_COLOR = '#94a3b8';

  /* ---------------- 数据操作（纯函数，返回新数组） ---------------- */
  const Ops = {
    createList(lists, name) {
      const list = { id: NS.uid('list'), name: name || '新清单', createdAt: Date.now(), items: [] };
      return { lists: [...lists, list], listId: list.id };
    },
    renameList(lists, listId, name) {
      return lists.map((l) => (l.id === listId ? Object.assign({}, l, { name }) : l));
    },
    removeList(lists, listId) {
      return lists.filter((l) => l.id !== listId);
    },
    /** html 可选：大段文字（富文本）条目同时存纯文本 text，列表/搜索用 text，纸面用 html */
    addItem(lists, listId, text, html) {
      const item = {
        id: NS.uid('item'),
        text: String(text || '').trim(),
        done: false,
        style: {},
        createdAt: Date.now()
      };
      const rich = typeof html === 'string' ? html.trim() : '';
      if (rich) item.html = rich;
      if (!item.text && !rich) return lists;
      if (!item.text) item.text = '（空）';
      return lists.map((l) => (l.id === listId ? Object.assign({}, l, { items: [...l.items, item] }) : l));
    },
    updateItem(lists, listId, itemId, patch) {
      return lists.map((l) =>
        l.id === listId
          ? Object.assign({}, l, {
              items: l.items.map((it) => {
                if (it.id !== itemId) return it;
                const next = Object.assign({}, it, patch);
                // html 传空串 = 清掉富文本，回到纯文本
                if ('html' in patch && !next.html) delete next.html;
                return next;
              })
            })
          : l
      );
    },
    removeItem(lists, listId, itemId) {
      return lists.map((l) =>
        l.id === listId ? Object.assign({}, l, { items: l.items.filter((it) => it.id !== itemId) }) : l
      );
    },
    moveItem(lists, listId, itemId, delta) {
      return lists.map((l) => {
        if (l.id !== listId) return l;
        const items = [...l.items];
        const i = items.findIndex((it) => it.id === itemId);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= items.length) return l;
        const t = items[i];
        items[i] = items[j];
        items[j] = t;
        return Object.assign({}, l, { items });
      });
    },
    moveItemBefore(lists, listId, dragId, targetId) {
      return lists.map((l) => {
        if (l.id !== listId) return l;
        const items = [...l.items];
        const from = items.findIndex((it) => it.id === dragId);
        const to = items.findIndex((it) => it.id === targetId);
        if (from < 0 || to < 0 || from === to) return l;
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved);
        return Object.assign({}, l, { items });
      });
    },
    toggleDone(lists, listId, itemId, value) {
      return lists.map((l) =>
        l.id === listId
          ? Object.assign({}, l, {
              items: l.items.map((it) =>
                it.id === itemId ? Object.assign({}, it, { done: value == null ? !it.done : !!value }) : it
              )
            })
          : l
      );
    }
  };

  class ChecklistProvider {
    constructor() {
      this.id = 'checklist';
      this.state = { activeListId: '', lists: [] };
      this.layout = { paperWidthPx: 170, paperHeightPx: 200, fontSizePx: 15, darkMode: false };
      this.pages = [];
      this.pins = new Map();
      this.cacheKey = '';
      // 循环浏览：纸带无限，拉到底继续往下会接回第一页（与单词模式的轮次一致）
      this.loop = true;
      // 撕纸模式：打开后纸是「消耗品」，撕到底就没了 —— 此时不再循环（撕完又绕回来等于白撕）
      this.tearMode = false;
      // 自动序号：按条目在清单里的先后顺序，纸面上加「1. 2. 3.」
      this.numbering = false;
      this._lineCache = new Map();
    }

    /** 实际排出来的页数（循环定位/进度取模都按它算） */
    get pageCount() {
      return Math.max(1, this.pages.length);
    }

    /** 纸带是否真的无限：既要开了循环，又必须是「不撕纸」的浏览模式 */
    get infinite() {
      return this.loop && !this.tearMode;
    }

    /** 对外报的纸数：无限时 Infinity，否则就是页数 */
    get paperCount() {
      if (this.infinite && this.pages.length) return Infinity;
      return Math.max(1, this.pages.length);
    }

    setLoop(on) {
      const v = !!on;
      if (v === this.loop) return;
      this.loop = v;
    }

    /** 撕纸模式：撕纸时纸会一张张少下去，所以不再循环取模 */
    setTearMode(on) {
      const v = !!on;
      if (v === this.tearMode) return;
      this.tearMode = v;
      if (v) this.clearPins();
    }

    /** 自动序号：和「循环」一样只影响纸面绘制，不改数据 */
    setNumbering(on) {
      const v = !!on;
      if (v === this.numbering) return;
      this.numbering = v;
      // 序号会挤占首行宽度，断行结果必须重算
      this.cacheKey = '';
      this._lineCache.clear();
      this._buildPages();
    }

    _norm(index) {
      const n = this.pages.length || 1;
      return ((Math.floor(index) % n) + n) % n;
    }

    setState(state) {
      this.state = {
        activeListId: state.activeListId,
        lists: state.lists || []
      };
      this._buildPages();
    }

    applyState(state) {
      this.setState(state);
    }

    async ensureLoaded() {
      this._buildPages();
    }

    relayout(layout) {
      this.layout = Object.assign({}, this.layout, layout);
      this._buildPages();
    }

    get list() {
      return this.state.lists.find((l) => l.id === this.state.activeListId) || this.state.lists[0] || null;
    }

    /* ---------------- 断行（按字号 + 纸宽，结果即渲染结果） ---------------- */

    /**
     * @param {object} item 条目
     * @param {number} num  自动序号（0 = 不加），会作为首行前缀参与断行，
     *                      这样「1. 」占的宽度也会被算进去，首行不会因此挤出一个字
     */
    _linesOf(item, num) {
      const fsize = Math.max(9, this.layout.fontSizePx);
      const innerW = Math.max(24, this.layout.paperWidthPx - TEXT_INSET_X);
      const n = Math.max(0, Math.floor(Number(num) || 0));
      const key = `${item.id}|${fsize}|${innerW}|${n}`;
      const hit = this._lineCache.get(key);
      if (hit) return hit;

      let runs;
      if (item.html) runs = NS.Rich.parse(item.html);
      else runs = [{ text: String(item.text || '') }];
      const st = item.style || {};
      if (st.bold) runs = runs.map((r) => (r.bold ? r : Object.assign({}, r, { bold: true })));
      if (st.color) runs = runs.map((r) => (r.color ? r : Object.assign({}, r, { color: st.color })));
      if (n && runs.length) {
        // 序号用灰色小字，且与正文同一字号（否则首行行高会被它改掉）
        runs = [{ text: `${n}. `, color: NUMBER_COLOR }].concat(runs);
      }
      if (n && !runs.length) runs = [{ text: `${n}. `, color: NUMBER_COLOR }];

      let lines = NS.Rich.lines(runs, innerW, fsize);
      if (!lines.length) lines = [{ runs: [], h: fsize * NS.Rich.LINE_RATIO }];
      this._lineCache.set(key, lines);
      return lines;
    }

    _buildPages() {
      const list = this.list;
      const items = list ? list.items : [];
      // 缓存 key 必须包含勾选态、样式与富文本，否则右键改样式 / 编辑器保存后纸面不更新
      const sig = items
        .map(
          (i) =>
            `${i.id}\u0001${i.text}\u0001${i.html || ''}\u0001${i.done ? 1 : 0}\u0001${JSON.stringify(
              i.style || {}
            )}`
        )
        .join('\u0002');
      const key = `${list ? list.id : ''}:${items.length}:${sig}:${this.layout.paperHeightPx}:${this.layout.fontSizePx}:${this.layout.paperWidthPx}:${this.numbering ? 1 : 0}`;
      if (key === this.cacheKey) return;
      this.cacheKey = key;
      this._lineCache.clear();

      const fsize = Math.max(9, this.layout.fontSizePx);
      const minLineH = fsize * NS.Rich.LINE_RATIO;
      // ★ 可用高度必须扣掉标题行：以前只减了 padding，标题那 18px 会挤掉最后一行
      const usable = Math.max(minLineH, this.layout.paperHeightPx - PAGE_PAD_Y - TITLE_H);

      const pages = [];
      let cur = [];
      let h = 0;

      items.forEach((it, itemIndex) => {
        const num = this.numbering ? itemIndex + 1 : 0;
        const lines = this._linesOf(it, num);
        let i = 0;
        while (i < lines.length) {
          // 这一页还能放几行（每行高度按它自己最大的字号算）
          let take = 0;
          let acc = 0;
          while (i + take < lines.length) {
            const lh = lines[i + take].h + (take === 0 ? 2 : 0);
            if (h + acc + lh > usable) break;
            acc += lh;
            take++;
          }
          if (take === 0) {
            if (cur.length) {
              pages.push(cur);
              cur = [];
              h = 0;
              continue;
            }
            // 纸太矮，一行都放不下：硬放一行（宁可超出一点，也不能把字裁掉）
            acc = lines[i].h + 2;
            take = 1;
          }
          cur.push({
            item: it,
            num,
            from: i,
            to: i + take,
            first: i === 0,
            last: i + take >= lines.length
          });
          h += acc;
          i += take;
          if (i < lines.length) {
            pages.push(cur);
            cur = [];
            h = 0;
          }
        }
      });
      if (cur.length || !pages.length) pages.push(cur);
      this.pages = pages;
    }

    _listItems() {
      return this.list ? this.list.items : [];
    }

    getPaper(index) {
      if (index < 0) return null;
      const pin = this.pins.get(index);
      if (pin && Array.isArray(pin.snapshot)) {
        return {
          kind: 'checklist',
          listId: this.state.activeListId,
          listName: this.list ? this.list.name : '',
          items: pin.snapshot,
          deletedMarks: true,
          loop: this.infinite
        };
      }
      if (!this.pages.length) return null;
      const idx = this.infinite ? this._norm(index) : Math.floor(index);
      if (idx < 0 || idx >= this.pages.length) return null;
      const page = this.pages[idx];
      if (!page) return null;
      return {
        kind: 'checklist',
        listId: this.state.activeListId,
        listName: this.list ? this.list.name : '',
        items: page,
        deletedMarks: false,
        loop: this.infinite
      };
    }

    indexToAnchor(index) {
      const idx = this.infinite ? this._norm(index) : Math.floor(index);
      const page = this.pages[idx];
      if (!page || !page.length) return { type: 'listItem', listId: this.state.activeListId, itemId: '' };
      return { type: 'listItem', listId: this.state.activeListId, itemId: page[0].item.id };
    }

    anchorToIndex(anchor) {
      if (!anchor || anchor.type !== 'listItem') return null;
      if (anchor.listId && anchor.listId !== this.state.activeListId) return null;
      const idx = this.pages.findIndex((p) => p.some((e) => e.item.id === anchor.itemId));
      return idx >= 0 ? idx : null;
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

    /** 撕纸时给回溯栈留下条目快照（内容可变域） */
    snapshotAt(index) {
      const idx = this.infinite ? this._norm(index) : Math.floor(index);
      const page = this.pages[idx];
      if (!page) return [];
      return JSON.parse(JSON.stringify(page));
    }

    render(el, paper) {
      el.innerHTML = '';
      if (!paper) {
        el.innerHTML = '<div class="empty-page">这个清单还没有条目</div>';
        return;
      }
      const box = document.createElement('div');
      box.className = 'checklist-page';
      const fsize = Math.max(9, this.layout.fontSizePx);
      box.style.fontSize = `${fsize}px`;
      if (this.infinite) box.classList.add('loop');

      const title = document.createElement('div');
      title.className = 'cl-title';
      title.textContent = paper.listName || '清单';
      box.appendChild(title);

      const currentIds = new Set(this._listItems().map((i) => i.id));
      for (const entry of paper.items || []) {
        const it = entry.item || entry;
        const row = document.createElement('div');
        row.className = 'cl-item';
        if (it.done) row.classList.add('done');
        const st = it.style || {};
        if (st.bold) row.classList.add('bold');
        if (st.strike) row.classList.add('strike');
        if (paper.deletedMarks && !currentIds.has(it.id)) row.classList.add('deleted');
        if (entry.first === false) row.classList.add('cont');
        row.dataset.itemId = it.id;

        const boxEl = document.createElement('span');
        boxEl.className = 'cl-box';
        // 续页：条目被切开的后半段，勾选框留白对齐，避免看起来像新条目
        if (entry.first === false) boxEl.classList.add('cont');
        const textEl = document.createElement('span');
        textEl.className = 'cl-text';
        const lines = this._linesOf(it, Number.isFinite(entry.num) ? entry.num : 0);
        const from = Number.isFinite(entry.from) ? entry.from : 0;
        const to = Number.isFinite(entry.to) ? entry.to : lines.length;
        textEl.innerHTML = NS.Rich.linesToHtml(lines.slice(from, to)) || '&nbsp;';
        row.appendChild(boxEl);
        row.appendChild(textEl);
        box.appendChild(row);
      }
      el.appendChild(box);
    }
  }

  NS.ChecklistProvider = ChecklistProvider;
  NS.ChecklistOps = Ops;
})(window);
