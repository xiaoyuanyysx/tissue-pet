/* checklist.js —— 清单模式内容源（D1–D5）+ 清单数据操作 */
(function (global) {
  'use strict';
  const NS = global.XZ;

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
      const next = lists.filter((l) => l.id !== listId);
      return next;
    },
    addItem(lists, listId, text) {
      const item = {
        id: NS.uid('item'),
        text: String(text || '').trim(),
        done: false,
        style: {},
        createdAt: Date.now()
      };
      if (!item.text) return lists;
      return lists.map((l) => (l.id === listId ? Object.assign({}, l, { items: [...l.items, item] }) : l));
    },
    updateItem(lists, listId, itemId, patch) {
      return lists.map((l) =>
        l.id === listId
          ? Object.assign({}, l, {
              items: l.items.map((it) => (it.id === itemId ? Object.assign({}, it, patch) : it))
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
    }

    get paperCount() {
      return Math.max(1, this.pages.length);
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

    _buildPages() {
      const list = this.list;
      const items = list ? list.items : [];
      // 缓存 key 必须包含勾选态与样式，否则右键改样式后纸面不更新
      const sig = items
        .map((i) => `${i.id}\u0001${i.text}\u0001${i.done ? 1 : 0}\u0001${JSON.stringify(i.style || {})}`)
        .join('\u0002');
      const key = `${list ? list.id : ''}:${items.length}:${sig}:${this.layout.paperHeightPx}:${this.layout.fontSizePx}:${this.layout.paperWidthPx}`;
      if (key === this.cacheKey) return;
      this.cacheKey = key;

      const fsize = Math.max(9, this.layout.fontSizePx);
      const lineH = fsize * 1.45;
      const innerW = Math.max(24, this.layout.paperWidthPx - 22);
      const usable = Math.max(lineH, this.layout.paperHeightPx - 30);

      const pages = [];
      let cur = [];
      let h = 0;
      for (const it of items) {
        const lines = Math.max(1, NS.countLines(it.text || '', innerW, fsize, it.style && it.style.bold ? 700 : 400));
        const ih = lines * lineH + 2;
        if (cur.length && h + ih > usable) {
          pages.push(cur);
          cur = [];
          h = 0;
        }
        cur.push(it);
        h += ih;
      }
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
          deletedMarks: true
        };
      }
      const page = this.pages[NS.clamp(index, 0, Math.max(0, this.pages.length - 1))];
      if (!page) return null;
      if (index >= this.pages.length) return null;
      return {
        kind: 'checklist',
        listId: this.state.activeListId,
        listName: this.list ? this.list.name : '',
        items: page,
        deletedMarks: false
      };
    }

    indexToAnchor(index) {
      const page = this.pages[NS.clamp(index, 0, Math.max(0, this.pages.length - 1))];
      if (!page || !page.length) return { type: 'listItem', listId: this.state.activeListId, itemId: '' };
      return { type: 'listItem', listId: this.state.activeListId, itemId: page[0].id };
    }

    anchorToIndex(anchor) {
      if (!anchor || anchor.type !== 'listItem') return null;
      if (anchor.listId && anchor.listId !== this.state.activeListId) return null;
      const idx = this.pages.findIndex((p) => p.some((it) => it.id === anchor.itemId));
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
      const page = this.pages[NS.clamp(index, 0, Math.max(0, this.pages.length - 1))];
      if (!page) return [];
      return page.map((it) => JSON.parse(JSON.stringify(it)));
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

      const title = document.createElement('div');
      title.className = 'cl-title';
      title.textContent = paper.listName || '清单';
      box.appendChild(title);

      const currentIds = new Set(this._listItems().map((i) => i.id));
      for (const it of paper.items || []) {
        const row = document.createElement('div');
        row.className = 'cl-item';
        if (it.done) row.classList.add('done');
        const st = it.style || {};
        if (st.bold) row.classList.add('bold');
        if (st.strike) row.classList.add('strike');
        if (paper.deletedMarks && !currentIds.has(it.id)) row.classList.add('deleted');
        row.dataset.itemId = it.id;

        const boxEl = document.createElement('span');
        boxEl.className = 'cl-box';
        const textEl = document.createElement('span');
        textEl.className = 'cl-text';
        textEl.textContent = it.text || '';
        if (st.color) textEl.style.color = st.color;
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
