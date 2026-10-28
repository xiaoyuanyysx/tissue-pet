/* settings-center.js —— A2 设置中心（全部设置收纳于此，齿轮图标展开） */
(function (global) {
  'use strict';
  const NS = global.XZ;

  const TABS = [
    { key: 'look', label: '外观' },
    { key: 'tear', label: '撕纸' },
    { key: 'mode', label: '模式' },
    { key: 'keys', label: '快捷键' },
    { key: 'data', label: '数据' }
  ];

  const ACTIONS = [
    { key: 'backtrack', label: '回溯上一张' },
    { key: 'toggleHidden', label: '不显示当前词' },
    { key: 'toggleStar', label: '标星当前词' },
    { key: 'toggleVisible', label: '隐藏/显示' },
    { key: 'toggleAutoTear', label: '自动滚落' },
    { key: 'switchMode', label: '切换模式' }
  ];

  const COLOR_CHOICES = [
    { v: '', label: '默认' },
    { v: '#dc2626', label: '红' },
    { v: '#2563eb', label: '蓝' },
    { v: '#16a34a', label: '绿' },
    { v: '#d97706', label: '橙' }
  ];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  class SettingsCenter {
    constructor({ host, store, app }) {
      this.host = host;
      this.store = store;
      this.app = app;
      this.el = el('div', 'settings-panel hidden');
      this.host.appendChild(this.el);
      this.tab = 'look';
      this.dicts = [];
      this.docs = [];
      this.shortcuts = null;
      this.recording = null;
      this._onKey = this._onKey.bind(this);
      this.itemDraft = '';
      const p0 = (store.get('settings') || {}).panelPos || { x: 0, y: 0 };
      this.pos = { x: Number(p0.x) || 0, y: Number(p0.y) || 0 };
      // 窗口宽度会随面板开合变化 → 重新钳一次，别让面板跑到窗口外面
      window.addEventListener('resize', () => {
        if (this.isOpen) this._applyPos();
      });
    }

    get isOpen() {
      return !this.el.classList.contains('hidden');
    }

    async open(tab) {
      if (tab) this.tab = tab;
      this.el.classList.remove('hidden');
      // 窗口向右扩展，避免面板遮住桌宠
      try {
        await window.petAPI.setPanel(true);
      } catch {
        /* ignore */
      }
      await this.reload();
      this.render();
      // 主进程刚把窗口加宽，等一帧再按真实宽度钳位
      requestAnimationFrame(() => this._applyPos());
    }

    close() {
      this.stopRecord();
      this.el.classList.add('hidden');
      try {
        window.petAPI.setPanel(false);
      } catch {
        /* ignore */
      }
    }

    toggle() {
      if (this.isOpen) this.close();
      else this.open();
    }

    async reload() {
      try {
        this.dicts = await NS.call(window.petAPI.dictListAll());
      } catch {
        this.dicts = [];
      }
      try {
        this.docs = await NS.call(window.petAPI.docList());
      } catch {
        this.docs = [];
      }
      try {
        this.shortcuts = await NS.call(window.petAPI.shortcutGetAll());
      } catch {
        this.shortcuts = null;
      }
    }

    async refresh() {
      if (!this.isOpen) return;
      await this.reload();
      this.render();
    }

    /* ---------------- 构件 ---------------- */

    _row(labelText, nodes) {
      const row = el('div', 'sp-row');
      if (labelText != null) row.appendChild(el('label', null, labelText));
      for (const n of [].concat(nodes)) row.appendChild(n);
      return row;
    }

    _slider(labelText, { min, max, step, value, onChange, fmt }) {
      const row = el('div', 'sp-row');
      row.appendChild(el('label', null, labelText));
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      const val = el('span', 'val', fmt ? fmt(value) : String(value));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        val.textContent = fmt ? fmt(v) : String(v);
        onChange(v);
      });
      row.appendChild(input);
      row.appendChild(val);
      return row;
    }

    _switchRow(labelText, value, onChange) {
      const row = el('div', 'sp-row');
      row.appendChild(el('label', null, labelText));
      const sp = el('div', `switch${value ? ' on' : ''}`);
      sp.addEventListener('click', () => {
        const next = !sp.classList.contains('on');
        sp.classList.toggle('on', next);
        onChange(next);
      });
      row.appendChild(sp);
      return row;
    }

    _select(options, value, onChange) {
      const sel = document.createElement('select');
      for (const o of options) {
        const op = document.createElement('option');
        op.value = o.value;
        op.textContent = o.label;
        if (o.value === value) op.selected = true;
        sel.appendChild(op);
      }
      sel.addEventListener('change', () => onChange(sel.value));
      return sel;
    }

    _btn(label, onClick, cls) {
      const b = el('button', `btn ${cls || ''}`.trim(), label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    }

    _sec(title) {
      const s = el('div', 'sp-sec');
      if (title) s.appendChild(el('h4', null, title));
      return s;
    }

    _hint(text) {
      return el('div', 'sp-hint', text);
    }

    /* ---------------- 渲染 ---------------- */

    render() {
      const s = this.store.get('settings');
      const wasScrolled = this.el.querySelector('.sp-body');
      const scrollTop = wasScrolled ? wasScrolled.scrollTop : 0;

      this.el.innerHTML = '';

      const head = el('div', 'sp-head');
      head.appendChild(el('span', null, '设置中心'));
      const acts = el('div', 'sp-actions');
      const close = el('span', 'sp-close', '✕');
      close.addEventListener('click', () => this.close());
      acts.appendChild(close);
      head.appendChild(acts);
      this.el.appendChild(head);
      this._attachHeadDrag(head);

      const tabs = el('div', 'sp-tabs');
      for (const t of TABS) {
        const b = el('div', `sp-tab${this.tab === t.key ? ' active' : ''}`, t.label);
        b.addEventListener('click', () => {
          this.tab = t.key;
          this.render();
        });
        tabs.appendChild(b);
      }
      this.el.appendChild(tabs);

      const body = el('div', 'sp-body');
      this.el.appendChild(body);

      if (this.tab === 'look') this._renderLook(body, s);
      else if (this.tab === 'tear') this._renderTear(body, s);
      else if (this.tab === 'mode') this._renderMode(body, s);
      else if (this.tab === 'keys') this._renderKeys(body, s);
      else this._renderData(body, s);

      body.scrollTop = scrollTop;
      this._applyPos();
    }

    /* ---------------- 面板拖动 ---------------- */

    _applyPos() {
      const W = window.innerWidth || 500;
      const H = window.innerHeight || 430;
      const w = this.el.offsetWidth || 322;
      const h = this.el.offsetHeight || 260;
      // 面板默认贴右上角：向左可移到窗口最左边，向下可移到底边贴住窗口
      const minX = -Math.max(0, W - w - 20);
      const maxY = Math.max(0, H - h - 10);
      const x = NS.clamp(Number(this.pos.x) || 0, minX, 0);
      const y = NS.clamp(Number(this.pos.y) || 0, 0, maxY);
      this.pos = { x, y };
      this.el.style.transform = x || y ? `translate(${Math.round(x)}px, ${Math.round(y)}px)` : '';
    }

    _attachHeadDrag(head) {
      let drag = null;
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('.sp-close')) return;
        e.preventDefault();
        drag = { x: e.clientX, y: e.clientY, ox: this.pos.x, oy: this.pos.y };
        this.el.classList.add('dragging');
        try {
          head.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      });
      head.addEventListener('pointermove', (e) => {
        if (!drag) return;
        this.pos = { x: drag.ox + (e.clientX - drag.x), y: drag.oy + (e.clientY - drag.y) };
        this._applyPos();
      });
      const end = () => {
        if (!drag) return;
        drag = null;
        this.el.classList.remove('dragging');
        this.app.store.patch(
          'settings',
          { panelPos: { x: Math.round(this.pos.x), y: Math.round(this.pos.y) } },
          { critical: false }
        );
      };
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    }

    _renderLook(body, s) {
      const sec = this._sec('尺寸（统一由缩放驱动）');
      sec.appendChild(
        this._slider('纸张高度', {
          min: 120,
          max: 400,
          step: 10,
          value: s.basePaperHeightPx,
          fmt: (v) => `${v}px`,
          onChange: (v) => this.app.applySettings({ basePaperHeightPx: v })
        })
      );
      sec.appendChild(
        this._slider('整体缩放', {
          min: 0.5,
          max: 2,
          step: 0.05,
          value: s.scale,
          fmt: (v) => `${Math.round(v * 100)}%`,
          onChange: (v) => this.app.applyScale(v)
        })
      );
      sec.appendChild(
        this._hint('纸宽 = 基准 170px × 缩放比例，横向同步等比变化；缩放角可在下方关闭。')
      );
      body.appendChild(sec);

      const sec2 = this._sec('阅读');
      sec2.appendChild(
        this._slider('正文字号', {
          min: 10,
          max: 30,
          step: 1,
          value: s.fontSizePx,
          fmt: (v) => `${v}px`,
          onChange: (v) => this.app.applySettings({ fontSizePx: v })
        })
      );
      sec2.appendChild(
        this._switchRow('黑夜模式', s.darkMode, (v) => this.app.applySettings({ darkMode: v }))
      );
      sec2.appendChild(
        this._switchRow('左上角缩放角', s.scaleCornerEnabled, (v) =>
          this.app.applySettings({ scaleCornerEnabled: v })
        )
      );
      body.appendChild(sec2);
    }

    _renderTear(body, s) {
      const sec = this._sec('撕纸');
      sec.appendChild(
        this._slider('撕纸阈值', {
          min: 0.5,
          max: 6,
          step: 0.5,
          value: s.tearThresholdPages,
          fmt: (v) => `${v} 张`,
          onChange: (v) => this.app.applySettings({ tearThresholdPages: v })
        })
      );
      sec.appendChild(
        this._hint('拉出这么多张之后松手才会撕纸；不到这个量松手就停在原地，不会回弹。拖动过程中一张都不撕，全留到松手时结算。')
      );
      sec.appendChild(
        this._slider('回溯上限', {
          min: 1,
          max: 50,
          step: 1,
          value: s.maxBacktrack,
          fmt: (v) => `${v} 张`,
          onChange: (v) => this.app.applySettings({ maxBacktrack: v })
        })
      );
      sec.appendChild(
        this._hint(
          `硬上限 50 张。当前可回溯 ${this.app.stack ? this.app.stack.size : 0} 张；超出上限后最早的纸不可恢复并会提示。`
        )
      );
      sec.appendChild(
        this._hint('纸带可以无限下拉：整张滑出视口、完全看不见的纸会在松手时静默撕掉并记入回溯栈。')
      );
      sec.appendChild(
        this._switchRow('启动时提示回溯上限', s.notifyBacktrackLimit !== false, (v) =>
          this.app.applySettings({ notifyBacktrackLimit: v })
        )
      );
      sec.appendChild(
        this._hint('回溯只对「本次运行」撕下的纸有效；重启后栈清空，不会回溯到上次启动前的内容。')
      );
      body.appendChild(sec);

      const sec2 = this._sec('自动滚落');
      sec2.appendChild(
        this._switchRow('开启自动滚落', !!(s.autoTear && s.autoTear.enabled), (v) =>
          this.app.setAutoTear(v)
        )
      );
      sec2.appendChild(
        this._slider('速度', {
          min: 2,
          max: 120,
          step: 1,
          value: Math.round((s.autoTear && s.autoTear.pxPerSec) || 20),
          fmt: (v) => `${v} px/秒`,
          onChange: (v) => this.app.setAutoTearSpeed(v)
        })
      );
      sec2.appendChild(
        this._hint('纸带按设定速度持续向下滚落，每满一张自动撕掉并计入回溯栈。')
      );
      body.appendChild(sec2);
    }

    _renderMode(body, s) {
      const sec = this._sec('当前模式');
      const row = el('div', 'sp-row');
      for (const m of NS.MODES) {
        const b = this._btn(NS.MODE_LABEL[m], () => this.app.switchMode(m), s.currentMode === m ? 'primary' : '');
        b.style.marginRight = '4px';
        row.appendChild(b);
      }
      sec.appendChild(row);
      body.appendChild(sec);

      if (s.currentMode === 'learn') this._renderLearn(body, s);
      else if (s.currentMode === 'leisure') this._renderLeisure(body, s);
      else this._renderChecklist(body, s);
    }

    _renderLearn(body, s) {
      const learn = this.store.get('learn');
      const sec = this._sec('学习模式');
      const dictOptions = this.dicts.map((d) => ({
        value: d.id,
        label: `${d.name}${d.builtin ? '' : '（导入）'} · ${d.count}`
      }));
      if (!dictOptions.length) dictOptions.push({ value: '', label: '没有可用词库' });
      sec.appendChild(
        this._row('词库', [
          this._select(dictOptions, learn.currentDictId, (v) => this.app.switchDict(v))
        ])
      );
      const btnRow = el('div', 'sp-row');
      btnRow.appendChild(this._btn('导入词库…', () => this.app.importDict(), 'ghost'));
      btnRow.appendChild(this._btn('管理不显示/标星', () => this.app.openSettings('mode'), 'ghost'));
      sec.appendChild(btnRow);
      sec.appendChild(this._switchRow('打乱模式（每轮重洗）', !!learn.shuffle, (v) => this.app.setLearnOption('shuffle', v)));
      sec.appendChild(
        this._switchRow('隐藏释义（单击纸显示）', !!learn.hideDefinition, (v) =>
          this.app.setLearnOption('hideDefinition', v)
        )
      );
      body.appendChild(sec);

      const listSec = this._sec(`不显示词（${(learn.hidden || []).length}）`);
      listSec.appendChild(this._wordList(learn.hidden || [], '显示', (w) => this.app.toggleHidden(w)));
      body.appendChild(listSec);

      const starSec = this._sec(`标星词（${(learn.starred || []).length}）`);
      starSec.appendChild(this._wordList(learn.starred || [], '取消标星', (w) => this.app.toggleStar(w)));
      body.appendChild(starSec);
    }

    _wordList(words, btnLabel, onClick) {
      const box = el('div', 'sp-list');
      if (!words.length) {
        box.appendChild(el('div', 'sp-empty', '暂无'));
        return box;
      }
      for (const w of words.slice(0, 200)) {
        const item = el('div', 'sp-list-item');
        item.appendChild(el('span', 'ell', w));
        const b = this._btn(btnLabel, () => onClick(w), 'sm');
        item.appendChild(b);
        box.appendChild(item);
      }
      if (words.length > 200) box.appendChild(el('div', 'sp-empty', `还有 ${words.length - 200} 个…`));
      return box;
    }

    _renderLeisure(body, s) {
      const leisure = this.store.get('leisure');
      const sec = this._sec('休闲资料');
      sec.appendChild(this._btn('导入资料（docx / md / txt / pdf）…', () => this.app.importDoc(), 'ghost'));
      sec.appendChild(this._hint('导入后按内容确定性分页，进度以字符偏移量记录，任何设置变化都不会丢失。'));
      body.appendChild(sec);

      const listSec = this._sec(`资料库（${this.docs.length}）`);
      const box = el('div', 'sp-list');
      if (!this.docs.length) {
        box.appendChild(el('div', 'sp-empty', '还没有导入资料'));
      } else {
        for (const d of this.docs) {
          const item = el('div', `sp-list-item${leisure.activeDocId === d.docId ? ' active' : ''}`);
          const name = el('span', 'ell', d.name);
          name.title = `${d.name} · ${d.blockCount} 段`;
          name.style.cursor = 'pointer';
          name.addEventListener('click', () => this.app.openDoc(d.docId));
          item.appendChild(name);
          item.appendChild(this._btn('删除', () => this.app.removeDoc(d.docId), 'sm danger'));
          box.appendChild(item);
        }
      }
      listSec.appendChild(box);
      body.appendChild(listSec);
    }

    _renderChecklist(body, s) {
      const cl = this.store.get('checklists');
      const sec = this._sec('清单');
      const listOptions = (cl.lists || []).map((l) => ({ value: l.id, label: `${l.name}（${l.items.length}）` }));
      if (!listOptions.length) listOptions.push({ value: '', label: '没有清单' });
      sec.appendChild(
        this._row('切换', [this._select(listOptions, cl.activeListId, (v) => this.app.selectList(v))])
      );
      const rowBtn = el('div', 'sp-row');
      rowBtn.appendChild(this._btn('新建', () => this.app.createList(), 'ghost'));
      rowBtn.appendChild(this._btn('重命名', () => this.app.renameList(), 'ghost'));
      rowBtn.appendChild(this._btn('删除', () => this.app.removeList(), 'ghost danger'));
      sec.appendChild(rowBtn);
      body.appendChild(sec);

      const active = (cl.lists || []).find((l) => l.id === cl.activeListId) || (cl.lists || [])[0];
      if (!active) return;

      const itemSec = this._sec(`条目（${active.items.length}）`);
      const addRow = el('div', 'sp-row');
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '输入条目后回车添加';
      input.value = this.itemDraft || '';
      input.addEventListener('input', () => {
        this.itemDraft = input.value;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = input.value.trim();
          if (v) {
            this.app.addItem(v);
            this.itemDraft = '';
          }
        }
        e.stopPropagation();
      });
      addRow.appendChild(input);
      itemSec.appendChild(addRow);

      const box = el('div', 'sp-list');
      if (!active.items.length) {
        box.appendChild(el('div', 'sp-empty', '还没有条目'));
      }
      let dragId = null;
      for (const it of active.items) {
        const item = el('div', 'sp-list-item');
        item.draggable = true;
        item.dataset.itemId = it.id;
        item.addEventListener('dragstart', (e) => {
          dragId = it.id;
          item.style.opacity = '0.45';
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try {
              e.dataTransfer.setData('text/plain', it.id);
            } catch {
              /* ignore */
            }
          }
        });
        item.addEventListener('dragend', () => {
          dragId = null;
          item.style.opacity = '';
        });
        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        });
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          if (!dragId || dragId === it.id) return;
          this.app.moveItemBefore(dragId, it.id);
          dragId = null;
        });

        const handle = el('span', 'sp-drag', '⋮⋮');
        handle.title = '拖动排序';
        item.appendChild(handle);

        const txt = el('span', 'ell', `${it.done ? '✓ ' : ''}${it.text}`);
        if (it.style && it.style.bold) txt.style.fontWeight = '700';
        if (it.done) txt.style.opacity = '0.6';
        if (it.style && it.style.color) txt.style.color = it.style.color;
        item.appendChild(txt);
        item.appendChild(this._btn('↑', () => this.app.moveItem(it.id, -1), 'sm'));
        item.appendChild(this._btn('↓', () => this.app.moveItem(it.id, 1), 'sm'));
        item.appendChild(this._btn('✕', () => this.app.removeItem(it.id), 'sm danger'));
        box.appendChild(item);
      }
      itemSec.appendChild(box);
      itemSec.appendChild(this._hint('排序即数组顺序；纸上可通过右键菜单改颜色/加粗/划线/勾选。'));
      body.appendChild(itemSec);
    }

    _renderKeys(body) {
      const map = this.shortcuts || {};
      const sec = this._sec('核心快捷键（录键式改键，自动检测冲突）');
      for (const a of ACTIONS) {
        const cur = map[a.key] || { focused: '', global: '' };
        for (const scope of ['focused', 'global']) {
          const row = el('div', 'sp-row');
          row.appendChild(el('label', null, scope === 'focused' ? a.label : '　↳ 全局'));
          const kbd = el('span', 'sp-kbd', cur[scope] || '未设置');
          kbd.addEventListener('click', () => this.startRecord(a.key, scope, kbd));
          row.appendChild(kbd);
          if (scope === 'focused') {
            row.appendChild(
              this._btn('清除', () => {
                this.app.setShortcut(a.key, '', scope).catch(() => {});
              }, 'sm')
            );
          }
          sec.appendChild(row);
        }
      }
      body.appendChild(sec);
      body.appendChild(
        this._hint(
          '聚焦轨：桌宠窗口激活时生效，支持任意键（含单独 Shift）；全局轨：任意场景生效，必须是组合键。冲突时会提示被占用。'
        )
      );
    }

    _renderData(body) {
      const sec = this._sec('数据目录');
      const info = this.app.info || {};
      const pathEl = el('div', 'sp-hint', info.userData || '');
      pathEl.style.wordBreak = 'break-all';
      pathEl.style.userSelect = 'text';
      sec.appendChild(pathEl);
      sec.appendChild(this._btn('打开数据目录', () => this.app.openUserData(), 'ghost'));
      sec.appendChild(this._hint('设置、进度、清单、回溯栈均保存在本机，不会上传。'));
      body.appendChild(sec);

      const sec2 = this._sec('关于');
      sec2.appendChild(this._hint(`小纸巾 · 学习卷纸桌宠 v${info.version || '1.0.0'}`));
      body.appendChild(sec2);
    }

    /* ---------------- 录键 ---------------- */

    startRecord(action, scope, node) {
      this.stopRecord();
      this.recording = { action, scope, node };
      node.classList.add('recording');
      node.textContent = '按下按键…';
      window.petAPI.shortcutCaptureHint();
      window.addEventListener('keydown', this._onKey, true);
    }

    stopRecord() {
      window.removeEventListener('keydown', this._onKey, true);
      if (this.recording && this.recording.node) {
        this.recording.node.classList.remove('recording');
      }
      this.recording = null;
      this.render();
    }

    _onKey(e) {
      if (!this.recording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.stopRecord();
        return;
      }
      const acc = accelFromEvent(e);
      if (!acc) return;
      const { action, scope } = this.recording;
      this.recording = null;
      window.removeEventListener('keydown', this._onKey, true);
      this.app
        .setShortcut(action, acc, scope)
        .then(() => this.refresh())
        .catch((err) => {
          this.app.toast.warn(err.message || '快捷键设置失败');
          this.refresh();
        });
    }
  }

  function accelFromEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const key = e.key;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
      if (mods.length === 1 && key === 'Shift') return 'Shift';
      if (mods.length === 1 && key === 'Control') return 'Control';
      if (mods.length === 1 && key === 'Alt') return 'Alt';
      return null;
    }
    const map = {
      ' ': 'Space',
      Escape: 'Escape',
      Enter: 'Enter',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      '+': 'Plus'
    };
    const k = map[key] || (key.length === 1 ? key.toUpperCase() : key);
    return [...mods, k].join('+');
  }

  NS.SettingsCenter = SettingsCenter;
})(window);
