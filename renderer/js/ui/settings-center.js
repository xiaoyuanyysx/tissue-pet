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

    /** 并排的「小标题 + 下拉」单元：标题在上、控件占满整格，两个并排也不挤 */
    _langCell(caption, select) {
      const cell = el('div', 'sp-lang-cell');
      cell.appendChild(el('span', null, caption));
      cell.appendChild(select);
      return cell;
    }

    _btn(label, onClick, cls) {
      const b = el('button', `btn ${cls || ''}`.trim(), label);
      b.type = 'button';
      if (onClick) b.addEventListener('click', onClick);
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
      const curMeta = (this.dicts || []).find((d) => d.id === learn.currentDictId);
      const dictNodes = [this._select(dictOptions, learn.currentDictId, (v) => this.app.switchDict(v))];
      if (curMeta && !curMeta.builtin) {
        dictNodes.push(this._btn('删除', () => this.app.removeDict(curMeta.id), 'sm danger'));
      }
      const dictRow = this._row('词库', dictNodes);
      dictNodes[0].classList.add('grow');
      sec.appendChild(dictRow);
      const btnRow = el('div', 'sp-row');
      btnRow.appendChild(this._btn('导入词库…', () => this.app.importDict(), 'ghost'));
      btnRow.appendChild(this._btn('重置进度…', () => this.app.resetLearnProgress(), 'ghost'));
      sec.appendChild(btnRow);
      sec.appendChild(this._hint('只回到第一张纸，标星词与不显示词都会保留。'));
      sec.appendChild(this._switchRow('打乱模式（每轮重洗）', !!learn.shuffle, (v) => this.app.setLearnOption('shuffle', v)));
      sec.appendChild(
        this._switchRow('隐藏释义（单击纸显示）', !!learn.hideDefinition, (v) =>
          this.app.setLearnOption('hideDefinition', v)
        )
      );

      /* 语言：导入时选的语言事后可改，不必重导。
         两个下拉并排一行，改完点「刷新纸面」才真正生效——每动一下就重读词库
         会连纸带一起重建，手感很跳；刷新只重绘、不动纸张进度。 */
      let langSec = null;
      if (curMeta) {
        const LANG_CHOICES = ['英语', '中文', '日语', '韩语', '俄语', '法语', '德语', '西班牙语'];
        const curWord = curMeta.wordLang || '';
        const curDef = curMeta.defLang || '';
        const defLangs = Array.isArray(curMeta.defLangs) ? curMeta.defLangs : [];
        // 词库实际带哪些语言（导入时勾选的槽位，含「其他1 / 意大利语」这类自定义名）
        const dictLangs =
          Array.isArray(curMeta.langs) && curMeta.langs.length
            ? curMeta.langs.filter(Boolean)
            : [...new Set([curMeta.srcWordLang, curWord, curDef, ...defLangs].filter(Boolean))];
        const ALL = [...new Set([...dictLangs, ...LANG_CHOICES].filter(Boolean))];

        let pendWord = curWord || ALL[0] || '英语';
        let pendDef = curDef;
        // 上下不能是同一语言：老数据存成相同值时，自动挪到另一种语言
        if (!pendDef || pendDef === pendWord) {
          pendDef = ALL.find((v) => v !== pendWord) || '';
        }

        langSec = this._sec(`语言${curMeta.langOverridden ? '（已手改）' : ''}`);

        const stateEl = el('span', 'sp-lang-state', '');
        const refreshBtn = this._btn(
          '刷新纸面',
          () => {
            if (refreshBtn.disabled) return;
            refreshBtn.disabled = true;
            stateEl.textContent = '正在刷新…';
            stateEl.classList.remove('dirty');
            this.app
              .applyDictLang(learn.currentDictId, pendWord, pendDef)
              .then((ok) => {
                // 有改动时面板会整体重建，旧节点已失效，反馈交给 toast
                if (!stateEl.isConnected) return;
                if (ok) {
                  stateEl.textContent = '已应用，进度保持';
                  stateEl.classList.remove('dirty');
                } else {
                  stateEl.textContent = '刷新失败，请重试';
                  stateEl.classList.add('dirty');
                }
              })
              .catch(() => {
                if (stateEl.isConnected) stateEl.textContent = '刷新失败，请重试';
              })
              .finally(() => {
                refreshBtn.disabled = false;
              });
          },
          'primary'
        );
        const markDirty = () => {
          const changed = pendWord !== curWord || pendDef !== curDef;
          stateEl.textContent = changed ? '有改动，点刷新生效' : '';
          stateEl.classList.toggle('dirty', changed);
        };

        /* 两个下拉互斥：各自只列「另一种语言没占用」的选项，从根上杜绝上下相同。
           词库里没有内容的语言也列出来但标「无内容」——手改语言标签
           （比如法语词库被识别成英语）时还能纠正分组，只是纸面会回落原文。 */
        const hasContent = (v) => dictLangs.includes(v);
        const optionsFor = (exclude) =>
          ALL.filter((v) => v !== exclude).map((v) => ({
            v,
            label: hasContent(v) ? v : `${v}（无内容）`
          }));
        const fillSel = (sel, list, val) => {
          sel.innerHTML = '';
          let opts = list;
          if (val && !opts.some((o) => o.v === val)) opts = [...opts, { v: val, label: val }];
          for (const o of opts) {
            const op = document.createElement('option');
            op.value = o.v;
            op.textContent = o.label;
            sel.appendChild(op);
          }
          sel.value = val || (opts[0] ? opts[0].v : '');
        };
        const wordSel = document.createElement('select');
        const defSel = document.createElement('select');
        const refreshSel = () => {
          const pair = ALL.length >= 2;
          fillSel(wordSel, pair ? optionsFor(pendDef) : ALL.map((v) => ({ v, label: v })), pendWord);
          fillSel(defSel, pair ? optionsFor(pendWord) : ALL.map((v) => ({ v, label: v })), pendDef);
          if (refreshEmpty) refreshEmpty();
        };
        let refreshEmpty = null;
        wordSel.addEventListener('change', () => {
          const v = wordSel.value;
          if (v === pendDef) pendDef = pendWord; // 兜底：真撞上了就互换
          pendWord = v;
          refreshSel();
          markDirty();
        });
        defSel.addEventListener('change', () => {
          const v = defSel.value;
          if (v === pendWord) pendWord = pendDef;
          pendDef = v;
          refreshSel();
          markDirty();
        });
        refreshSel();

        /* 一键对调：右上角「⇄」把上下的语言直接互换并立刻生效。
           和「刷新纸面」的分工——下拉改选走刷新（可以先改两个再一起应用），
           对调只是一次交换，点一下就落地，省掉「改成 B / 再改成 A」两步。
           纸面进度由 applyDictLang 兜底保留；交换期间加锁，
           否则连点两次会让两次写盘交错、上下又变回原样。 */
        let swapBusy = false;
        const swapBtn = this._btn('⇄', null, 'swap sp-lang-swap');
        swapBtn.title = '交换上下（点一下立即生效，进度保留）';
        swapBtn.setAttribute('aria-label', '交换学习语言与释义语言');
        swapBtn.disabled = ALL.length < 2;
        swapBtn.addEventListener('click', async () => {
          if (swapBusy || swapBtn.disabled) return;
          const w = pendDef;
          const d = pendWord;
          if (!w || w === d) return; // 只有一种语言、或下方为空时没得换
          pendWord = w;
          pendDef = d;
          refreshSel();
          markDirty();
          swapBusy = true;
          swapBtn.disabled = true;
          stateEl.textContent = '正在交换…';
          stateEl.classList.remove('dirty');
          try {
            // silent：成功提示由这里统一给，避免「已改为 / 已对调」两条 toast 打架
            const ok = await this.app.applyDictLang(learn.currentDictId, w, d, { silent: true });
            if (ok) this.app.toast.info(`已对调：上「${w}」下「${d}」`);
            // 有改动时面板会整体重建，旧节点失效，反馈交给 toast
            if (!stateEl.isConnected) return;
            stateEl.textContent = ok ? `已交换：上「${w}」下「${d}」` : '交换失败，请重试';
            stateEl.classList.toggle('dirty', !ok);
          } catch {
            if (stateEl.isConnected) {
              stateEl.textContent = '交换失败，请重试';
              stateEl.classList.add('dirty');
            }
          } finally {
            swapBusy = false;
            swapBtn.disabled = false;
          }
        });

        const langRow = el('div', 'sp-lang-row');
        langRow.appendChild(this._langCell('学习语言（上）', wordSel));
        langRow.appendChild(swapBtn);
        langRow.appendChild(this._langCell('释义语言（下）', defSel));
        langSec.appendChild(langRow);

        // 选了词库里没有的语言时明说一句，否则纸面看起来「换了没反应」
        const emptyEl = el('div', 'sp-hint sp-lang-empty', '');
        refreshEmpty = () => {
          const miss = [];
          if (pendWord && !hasContent(pendWord)) miss.push(`上方「${pendWord}」`);
          if (pendDef && !hasContent(pendDef)) miss.push(`下方「${pendDef}」`);
          emptyEl.textContent = miss.length ? `${miss.join('、')}在这本词库里没有内容，该行会回落原文。` : '';
        };
        refreshEmpty();
        langSec.appendChild(emptyEl);

        const acts = el('div', 'sp-lang-actions');
        acts.appendChild(refreshBtn);
        acts.appendChild(stateEl);
        langSec.appendChild(acts);

        langSec.appendChild(
          this._hint(
            '上方取「学习语言」的内容，下方取「释义语言」的内容；两种语言不能相同，所以对调后纸面上下就真的互换了。'
          )
        );
        langSec.appendChild(
          this._hint('下拉之间的小「⇄」是对调按钮：点一下就把上下互换并立即生效，进度不动。')
        );
        langSec.appendChild(
          this._hint('「标星 / 不显示」跟着学习语言分组保存，同一语言的不同词库共用一份。')
        );
        langSec.appendChild(
          this._hint(
            dictLangs.length > 2
              ? `该词库有 ${dictLangs.join(' / ')}（共 ${dictLangs.length} 种）可放到上下两行；某一行没有该语言时回落原文。`
              : `该词库只有 ${dictLangs.join(' / ') || '两种'} 两种语言；导入带多语言内容的词表（如「apple - n.苹果 / りんご」）后可自由配对。`
          )
        );
        langSec.appendChild(
          this._hint('语言名（含「其他1 / 其他2」）在导入时确定；要改名请重新导入该词表。')
        );
      }
      body.appendChild(sec);
      if (langSec) body.appendChild(langSec);

      /* 词库管理：导入的词库以前只能去 userData/dicts/ 手删，这里给个入口 */
      const imported = (this.dicts || []).filter((d) => !d.builtin);
      const mgmtSec = this._sec(`词库管理（导入 ${imported.length}）`);
      if (!imported.length) {
        mgmtSec.appendChild(this._hint('暂无导入词库；内置词库不可删除。'));
      } else {
        const box = el('div', 'sp-list');
        for (const d of imported) {
          const item = el('div', 'sp-list-item');
          const isCur = d.id === learn.currentDictId;
          const name = el('span', 'ell', `${d.name} · ${d.count} 条`);
          name.title = `${d.name} · ${d.count} 条${d.wordLang ? ` · ${d.wordLang}` : ''}${isCur ? ' · 当前使用' : ''}`;
          item.appendChild(name);
          if (isCur) {
            const tag = el('span', null, '使用中');
            tag.style.fontSize = '10px';
            tag.style.color = 'var(--ink-mute)';
            tag.style.flex = '0 0 auto';
            item.appendChild(tag);
          }
          item.appendChild(this._btn('删除', () => this.app.removeDict(d.id), 'sm danger'));
          box.appendChild(item);
        }
        mgmtSec.appendChild(box);
        mgmtSec.appendChild(
          this._hint('删除当前词库会自动切回内置词库；标星词与不显示词按语言保存，不会一起删掉。')
        );
      }
      body.appendChild(mgmtSec);

      /* 不显示 / 标星按「语言」分组：这里只列「当前词库语言」这一份，其余语言给出条数提示 */
      // 语言从词库列表反查，这样停在休闲/清单模式时打开设置也能显示正确的一份
      const lp = this.app.providers.learn;
      const curDict = (this.dicts || []).find((d) => d.id === learn.currentDictId);
      const lang = (curDict && curDict.lang) || lp.lang || 'unknown';
      const langName = (curDict && curDict.wordLang) || lp.langLabel || '未标注语言';
      const group = (map) =>
        map && !Array.isArray(map) && Array.isArray(map[lang]) ? map[lang] : [];
      const otherCount = (map) => {
        if (!map || Array.isArray(map)) return 0;
        return Object.keys(map).reduce(
          (s, k) => s + (k === lang ? 0 : Array.isArray(map[k]) ? map[k].length : 0),
          0
        );
      };

      /* 同一语言的词库共用一份集合，但「四级标过、雅思没有」的词在本词库里永远抽不到，
         原样列出来会让人以为切换词库时串了。这里把它们折成一行计数。
         只有 learn provider 正持有当前词库时才能判断，否则一律按全部显示。 */
      const curWords =
        lp.dictId && lp.dictId === learn.currentDictId && lp.entries.length
          ? new Set(lp.entries.map((e) => String(e.word || '').toLowerCase()))
          : null;
      const hasCur = (w) => !curWords || curWords.has(String(w).toLowerCase());
      const splitByDict = (list) => ({
        here: list.filter(hasCur),
        stale: curWords ? list.filter((w) => !hasCur(w)) : []
      });

      const hiddenSplit = splitByDict(group(learn.hidden));
      const listSec = this._sec(`不显示词（${hiddenSplit.here.length} · ${langName}）`);
      listSec.appendChild(this._hint(`仅对「${langName}」词库生效；同一语言的不同词库共用这一份。`));
      listSec.appendChild(
        this._foldList(hiddenSplit.here, '显示', (w) => this.app.toggleHidden(w), '个不显示词')
      );
      if (hiddenSplit.stale.length) {
        listSec.appendChild(
          this._hint(`另有 ${hiddenSplit.stale.length} 个词不在当前词库（切到包含它们的词库时仍然生效）。`)
        );
      }
      const hiddenOther = otherCount(learn.hidden);
      if (hiddenOther) listSec.appendChild(this._hint(`其他语言另有 ${hiddenOther} 条，切换过去才会显示。`));
      body.appendChild(listSec);

      const starSplit = splitByDict(group(learn.starred));
      const starSec = this._sec(`标星词（${starSplit.here.length} · ${langName}）`);
      starSec.appendChild(
        this._foldList(starSplit.here, '取消标星', (w) => this.app.toggleStar(w), '个标星词')
      );
      if (starSplit.stale.length) {
        starSec.appendChild(
          this._hint(`另有 ${starSplit.stale.length} 个词不在当前词库（切到包含它们的词库时仍然生效）。`)
        );
      }
      const starOther = otherCount(learn.starred);
      if (starOther) starSec.appendChild(this._hint(`其他语言另有 ${starOther} 条，切换过去才会显示。`));
      body.appendChild(starSec);
    }

    /** 折叠列表：默认收起，点标题才展开 —— 避免十几条词把设置面板撑满 */
    _foldList(words, btnLabel, onClick, unit) {
      const wrap = el('div', 'sp-fold');
      const head = el('div', 'sp-fold-head');
      head.appendChild(el('span', 'sp-fold-arrow'));
      head.appendChild(
        el('span', 'ell', words.length ? `展开查看 ${words.length} ${unit || '项'}` : '暂无')
      );
      wrap.appendChild(head);
      const body = el('div', 'sp-fold-body collapsed');
      body.appendChild(this._wordList(words, btnLabel, onClick));
      wrap.appendChild(body);
      if (words.length) {
        head.addEventListener('click', () => {
          const closed = body.classList.contains('collapsed');
          body.classList.toggle('collapsed', !closed);
          wrap.classList.toggle('open', closed);
        });
      }
      return wrap;
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
      const noTear = s.checklistNoTear !== false;
      sec.appendChild(
        this._switchRow('不撕纸', noTear, (v) => this.app.setChecklistNoTear(v))
      );
      sec.appendChild(
        this._hint(
          noTear
            ? '清单的每一页只是同一个清单的分页视图：下拉/滚轮只是往下浏览，松手对齐到整页，往上滚就能回到第一页。'
            : '关掉后和单词模式一样：拉出超过「撕纸阈值」就撕掉一张（可在「手势」里调阈值），撕下来的能回溯。'
        )
      );
      sec.appendChild(
        this._switchRow('循环浏览', s.checklistLoop !== false, (v) => this.app.setChecklistLoop(v))
      );
      sec.appendChild(
        this._hint(
          noTear
            ? '和单词模式一样：纸带无限，拉到底会接回第一页。关掉后拉到最后一张就停。'
            : '撕纸模式下纸带不再循环（撕完又绕回来等于白撕），这条开关只在「不撕纸」时起作用。'
        )
      );
      sec.appendChild(
        this._switchRow('自动序号', !!s.checklistNumbering, (v) => this.app.setChecklistNumbering(v))
      );
      sec.appendChild(
        this._hint('勾选后纸面按添加顺序标 1. 2. 3.：新条目接在最后，序号自动往后排；删掉中间一条，后面的序号会往前补。')
      );
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

      // 高级编辑：跳独立窗口，像 doc 一样排版（字号/字色/高亮/加粗），纸面按段落折行分页
      const richRow = el('div', 'sp-row');
      const richBtn = this._btn('高级编辑', () => this.app.editItemRich(''), 'ghost');
      richBtn.style.flex = '0 0 auto';
      richRow.appendChild(richBtn);
      richRow.appendChild(el('span', 'sp-hint', '字号 / 字色 / 突出显示 / 加粗'));
      itemSec.appendChild(richRow);

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
        txt.style.cursor = 'text';
        txt.title = '双击修改文字';
        txt.addEventListener('dblclick', () => this.app.editItemText(it.id));
        item.appendChild(txt);
        const richBtn = this._btn('Aa', () => this.app.editItemRich(it.id), 'sm');
        richBtn.title = it.html ? '高级编辑（这条已排版）' : '高级编辑（字号/字色/高亮/加粗）';
        item.appendChild(richBtn);
        item.appendChild(this._btn('↑', () => this.app.moveItem(it.id, -1), 'sm'));
        item.appendChild(this._btn('↓', () => this.app.moveItem(it.id, 1), 'sm'));
        item.appendChild(this._btn('✕', () => this.app.removeItem(it.id), 'sm danger'));
        box.appendChild(item);
      }
      itemSec.appendChild(box);
      itemSec.appendChild(
        this._hint(
          '「Aa」打开「高级编辑」窗口（字号/字色/突出显示/加粗，写大段文字）；双击文字改成纯文本；排序即数组顺序；纸上右键可改颜色/加粗/划线/勾选。'
        )
      );
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
      sec.appendChild(this._hint('设置、进度、清单均保存在本机，不会上传；回溯栈只存在内存里，退出即清空。'));
      body.appendChild(sec);

      const resetSec = this._sec('重置');
      resetSec.appendChild(
        this._hint('导入的文档与词库文件不会被这两个按钮删除，需要清理时在上面的模式分区里单独删。')
      );
      const row = el('div', 'sp-row');
      row.appendChild(this._btn('恢复默认设置', () => this.app.resetData('settings'), 'ghost'));
      row.appendChild(this._btn('清空全部数据', () => this.app.resetData('all'), 'ghost danger'));
      resetSec.appendChild(row);
      resetSec.appendChild(
        this._hint('「恢复默认设置」只重置外观/撕纸/快捷键；「清空全部数据」会连学习进度、阅读进度、清单一起清掉。')
      );
      body.appendChild(resetSec);

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
