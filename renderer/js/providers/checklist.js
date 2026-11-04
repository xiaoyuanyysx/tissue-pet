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
  // 星标插在勾选框和正文之间（行内小星），会给正文占掉一点宽度，断行时要扣掉
  const STAR_RATIO = 0.72;
  // 自动序号的颜色：黑白主题下都够清楚
  const NUMBER_COLOR = '#94a3b8';
  // 随记：正文按 0.82 倍字号排（小一号，看上去是「注释」而不是正文）；
  // 折叠态只占一行小标签，点开 / 悬停才显示内容
  const NOTE_SIZE_RATIO = 0.82;
  const NOTE_CHIP_RATIO = 0.74;
  const NOTE_DEFAULT_MODE = 'always';

  /* ---------------- 随记模型 ----------------
     v2.7 起一条条目可以挂**多条**随记：item.notes = [{ id, text, mode }]。
     一条清单自然就对应任意多条备注（每条条目各挂各的）。
     旧数据 item.note = { text, mode } 在 Ops.normalize 里迁成数组。 */

  /** 把任意输入整理成合法的随记数组：空的、没文字的都丢掉 */
  function normNotes(v) {
    const raw = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
    const out = [];
    for (const n of raw) {
      const text = String((n && n.text) || '').trim();
      if (!text) continue;
      const mode = n && (n.mode === 'click' || n.mode === 'hover') ? n.mode : NOTE_DEFAULT_MODE;
      out.push({ id: (n && n.id) || NS.uid('note'), text, mode });
    }
    return out;
  }

  /* ---------------- 数据操作（纯函数，返回新数组） ---------------- */
  const Ops = {
    createList(lists, name) {
      const list = {
        id: NS.uid('list'),
        name: name || NS.t('paper.newListName'),
        createdAt: Date.now(),
        items: []
      };
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
      if (!item.text) item.text = NS.t('paper.emptyItem');
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
                // notes 传空数组 = 删光随记（不留下空壳）；旧字段 note 一并清掉
                if ('notes' in patch) {
                  const ns = normNotes(next.notes);
                  if (ns.length) next.notes = ns;
                  else delete next.notes;
                  delete next.note;
                }
                // note 传 null = 删掉这条随记（不留下空壳）
                if ('note' in patch && (!next.note || !String(next.note.text || '').trim())) delete next.note;
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
    },

    /* ---------------- 清除「主页面上的操作」 ----------------
       只清标记，不动条目本身（文字一定保留）：
         scope = 'done'  只取消勾选
         scope = 'page'  只去掉**在纸面上**设的格式（右键菜单里的加粗 / 颜色 / 划线）
       「别的地方设的」一概不动：勾选状态、高级编辑窗口里排的富文本（item.html）、
       随记，都属于「不是在纸面上改的格式」，清页面格式时保留。 */

    /** 这条条目上有没有主页面操作留下的痕迹 */
    hasMark(item, scope) {
      const it = item || {};
      if (scope === 'done') return !!it.done;
      const st = it.style || {};
      // page：只认纸面右键设的样式；html 是编辑器排的版，不算「页面格式」
      return !!(st.bold || st.strike || st.color);
    },

    countMarks(lists, listId, scope) {
      const list = (lists || []).find((l) => l.id === listId);
      if (!list) return 0;
      return (list.items || []).filter((it) => Ops.hasMark(it, scope)).length;
    },

    /** @returns {{ lists: object[], changed: number }} */
    clearMarks(lists, listId, scope) {
      const doneOnly = scope === 'done';
      let changed = 0;
      const next = (lists || []).map((l) => {
        if (l.id !== listId) return l;
        const items = (l.items || []).map((it) => {
          if (!Ops.hasMark(it, scope)) return it;
          changed++;
          // 两种粒度都收敛成「只改那一个字段」，别的字段原样带过去
          if (doneOnly) return Object.assign({}, it, { done: false });
          return Object.assign({}, it, { style: {} });
        });
        return Object.assign({}, l, { items });
      });
      return { lists: next, changed };
    },

    /** 条目上的随记（只读视图；旧的单条 note 也会被当数组返回） */
    notesOf(item) {
      return normNotes(item && (item.notes != null ? item.notes : item.note));
    },

    /** 写/改整组随记（一条条目可挂多条）：传空数组即删光 */
    setNotes(lists, listId, itemId, notes) {
      return Ops.updateItem(lists, listId, itemId, { notes: normNotes(notes) });
    },

    /** 星标：value 为空 = 切换 */
    toggleStar(lists, listId, itemId, value) {
      return lists.map((l) =>
        l.id === listId
          ? Object.assign({}, l, {
              items: l.items.map((it) =>
                it.id === itemId ? Object.assign({}, it, { starred: value == null ? !it.starred : !!value }) : it
              )
            })
          : l
      );
    },

    /**
     * 数据迁移（就地不改，返回新数组）：item.note → item.notes。
     * 启动时调用一次；返回 null 表示没有需要迁移的。
     */
    normalize(lists) {
      let dirty = false;
      const next = (lists || []).map((l) => {
        let listChanged = false;
        const items = (l.items || []).map((it) => {
          if (!('note' in it) && !('notes' in it)) return it;
          const ns = normNotes(it.notes != null ? it.notes : it.note);
          const copy = Object.assign({}, it);
          delete copy.note;
          if (ns.length) copy.notes = ns;
          else delete copy.notes;
          listChanged = true;
          return copy;
        });
        if (!listChanged) return l;
        dirty = true;
        return Object.assign({}, l, { items });
      });
      return dirty ? next : null;
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
     * @param {boolean} starred 有星标时正文左边插一颗小 ★，同样要给断行让出宽度
     */
    _linesOf(item, num, starred) {
      const fsize = Math.max(9, this.layout.fontSizePx);
      let innerW = Math.max(24, this.layout.paperWidthPx - TEXT_INSET_X);
      if (starred) innerW = Math.max(12, innerW - (Math.round(fsize * STAR_RATIO) + 2));
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

    /**
     * 随记的排版信息（一条条目可挂多条，没有随记返回 []）。
     *   mode='always' → 正文按小一号字排，跟着条目一起分页（太长会跨页，不裁字）
     *   mode='click'  → 折叠成一行小标签；点开时用便签卡显示全文（不改排版）
     *   mode='hover'  → 折叠成一行小标签；悬停时在标签旁弹一个小标签气泡显示全文
     */
    _noteInfos(item) {
      const notes = normNotes(item && (item.notes != null ? item.notes : item.note));
      const fsize = Math.max(9, this.layout.fontSizePx);
      // 随记左边还有 2px 竖线 + 5px 内缩（见 .cl-note.always），断行宽度要扣掉，否则会多折一个字
      const innerW = Math.max(24, this.layout.paperWidthPx - TEXT_INSET_X - 7);
      return notes.map((note) => {
        const key = `note|${note.id}|${fsize}|${innerW}|${note.mode}|${note.text}`;
        let info = this._lineCache.get(key);
        if (!info) {
          if (note.mode === 'always') {
            const size = Math.max(9, Math.round(fsize * NOTE_SIZE_RATIO));
            info = { mode: note.mode, size, text: note.text, chip: false, lines: NS.Rich.lines([{ text: note.text }], innerW, size) };
          } else {
            const size = Math.max(9, Math.round(fsize * NOTE_CHIP_RATIO));
            info = {
              mode: note.mode,
              size,
              text: note.text,
              chip: true,
              lines: [{ runs: [], h: size * NS.Rich.LINE_RATIO }]
            };
          }
          this._lineCache.set(key, info);
        }
        return Object.assign({ id: note.id }, info);
      });
    }

    _buildPages() {
      const list = this.list;
      const items = list ? list.items : [];
      // 缓存 key 必须包含勾选态、样式、富文本、随记与星标，否则右键改样式 / 编辑器保存后纸面不更新
      const sig = items
        .map(
          (i) =>
            `${i.id}\u0001${i.text}\u0001${i.html || ''}\u0001${i.done ? 1 : 0}\u0001${i.starred ? 1 : 0}\u0001${JSON.stringify(
              i.style || {}
            )}\u0001${JSON.stringify(normNotes(i.notes != null ? i.notes : i.note))}`
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
        // 一个条目 = 正文 +（可选）N 条随记；每段都按「行」分页
        const blocks = [{ kind: 'text', lines: this._linesOf(it, num, it.starred) }];
        for (const note of this._noteInfos(it)) {
          blocks.push({ kind: 'note', noteId: note.id, lines: note.lines });
        }

        for (const block of blocks) {
          const lines = block.lines;
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
              kind: block.kind,
              noteId: block.noteId || '',
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
        el.innerHTML = `<div class="empty-page">${NS.t('paper.checklistEmpty')}</div>`;
        return;
      }
      const box = document.createElement('div');
      box.className = 'checklist-page';
      const fsize = Math.max(9, this.layout.fontSizePx);
      box.style.fontSize = `${fsize}px`;
      if (this.infinite) box.classList.add('loop');

      const title = document.createElement('div');
      title.className = 'cl-title';
      title.textContent = paper.listName || NS.t('paper.defaultListName');
      box.appendChild(title);

      const currentIds = new Set(this._listItems().map((i) => i.id));
      const noted = new Set();
      for (const entry of paper.items || []) {
        const it = entry.item || entry;
        if (entry.kind === 'note') {
          this._renderNote(box, it, entry);
          continue;
        }
        const row = document.createElement('div');
        row.className = 'cl-item';
        if (it.done) row.classList.add('done');
        if (it.starred) row.classList.add('starred');
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
        else {
          // 方框可点：给了 role / title，鼠标移上去也知道这里能打勾
          boxEl.setAttribute('role', 'button');
          boxEl.title = it.done ? NS.t('tip.unmarkDone') : NS.t('tip.markDone');
        }
        const textEl = document.createElement('span');
        textEl.className = 'cl-text';
        const lines = this._linesOf(it, Number.isFinite(entry.num) ? entry.num : 0, !!it.starred);
        const from = Number.isFinite(entry.from) ? entry.from : 0;
        const to = Number.isFinite(entry.to) ? entry.to : lines.length;
        textEl.innerHTML = NS.Rich.linesToHtml(lines.slice(from, to)) || '&nbsp;';
        row.appendChild(boxEl);
        // 星标：插在勾选框和正文之间（v2.8 从行右上角挪过来，一眼就能看到哪条重要）
        if (it.starred && entry.first !== false) {
          const star = document.createElement('span');
          star.className = 'cl-star';
          star.title = NS.t('tip.starred');
          star.textContent = '★';
          row.appendChild(star);
        }
        row.appendChild(textEl);
        box.appendChild(row);
      }

      // 折叠态随记（点击才显示便签卡；悬停的用气泡、不画卡）：按需打开
      for (const entry of paper.items || []) {
        const it = entry.item || entry;
        if (entry.kind !== 'note' || noted.has(`${it.id}:${entry.noteId}`)) continue;
        noted.add(`${it.id}:${entry.noteId}`);
        const info = this._noteInfos(it).find((n) => n.id === entry.noteId);
        if (info && info.chip && info.mode === 'click') this._renderNoteCard(box, it, info);
      }
      el.appendChild(box);
    }

    /** 随记（always：跟着条目顺排；click/hover：只画一行小标签） */
    _renderNote(box, it, entry) {
      const info = this._noteInfos(it).find((n) => n.id === entry.noteId);
      if (!info) return;
      const wrap = document.createElement('div');
      wrap.className = 'cl-note';
      wrap.dataset.itemId = it.id;

      if (!info.chip) {
        wrap.classList.add('always');
        const text = document.createElement('div');
        text.className = 'cl-note-text';
        text.style.fontSize = `${info.size}px`;
        const from = Number.isFinite(entry.from) ? entry.from : 0;
        const to = Number.isFinite(entry.to) ? entry.to : info.lines.length;
        text.innerHTML = NS.Rich.linesToHtml(info.lines.slice(from, to)) || '&nbsp;';
        wrap.appendChild(text);
      } else if (entry.first !== false) {
        // 只有第一行画标签（续页不会有，但兜一下）
        wrap.classList.add('chip');
        wrap.style.height = `${info.lines[0].h}px`;
        const chip = document.createElement('span');
        chip.className = 'cl-note-chip';
        chip.dataset.itemId = it.id;
        chip.dataset.noteId = info.id;
        chip.dataset.mode = info.mode;
        chip.setAttribute('role', 'button');
        // 标签只写「怎么查看」这个功能，不剧透内容：内容悬停 / 点开自然能看到
        chip.textContent = info.mode === 'hover' ? '📎 注·悬停' : '📎 注·点击';
        chip.title = info.mode === 'hover' ? NS.t('tip.noteHover') : NS.t('tip.noteClick');
        wrap.appendChild(chip);
      }
      box.appendChild(wrap);
    }

    /** 便签卡：点开的随记全文盖在纸上（不参与排版，所以不会把纸撑破） */
    _renderNoteCard(box, it, info) {
      const card = document.createElement('div');
      card.className = 'cl-note-card';
      card.dataset.itemId = it.id;
      card.dataset.noteId = info.id;
      card.dataset.mode = info.mode;

      const head = document.createElement('div');
      head.className = 'cnc-head';
      const title = document.createElement('span');
      title.textContent = '📎 随记';
      const close = document.createElement('span');
      close.className = 'cnc-x';
      close.setAttribute('role', 'button');
      close.title = NS.t('tip.close');
      close.textContent = '×';
      head.appendChild(title);
      head.appendChild(close);

      const body = document.createElement('div');
      body.className = 'cnc-body';
      body.innerHTML = NS.Rich.plainToHtml(info.text);

      card.appendChild(head);
      card.appendChild(body);
      box.appendChild(card);
    }
  }

  NS.ChecklistProvider = ChecklistProvider;
  NS.ChecklistOps = Ops;
})(window);
