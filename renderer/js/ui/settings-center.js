/* settings-center.js —— A2 设置中心（全部设置收纳于此，齿轮图标展开）
   v3.0：外观并入「通用」（纸张/文字/语言/启动/说明一页管完，少一层翻找）；
         文案全量走 i18n，切语言就地重绘。 */
(function (global) {
  'use strict';
  const NS = global.XZ;
  const t = (k, p) => NS.I18N.t(k, p);

  /* 标签页顺序 = 从「最常改」到「最少动」：通用 → 撕纸 → 模式 → 快捷键 → 数据。
     key 同时是 settings.tab.<key> 的词条名。 */
  const TABS = [
    { key: 'general' },
    { key: 'tear' },
    { key: 'mode' },
    { key: 'keys' },
    { key: 'data' }
  ];

  /** 旧版「外观」页的入口（托盘/快捷键里可能还带着 look），统一折到通用 */
  const TAB_ALIAS = { look: 'general', global: 'general' };

  const ACTIONS = [
    { key: 'backtrack' },
    { key: 'toggleHidden' },
    { key: 'toggleStar' },
    { key: 'toggleVisible' },
    { key: 'toggleAutoTear' },
    { key: 'switchMode' }
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
      this.tab = 'general';
      this.dicts = [];
      this.docs = [];
      this.shortcuts = null;
      // 开机自启动状态由主进程现读系统启动项，不存盘（见 main/auto-launch.js）
      this.autoLaunch = null;
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
      if (tab) this.tab = TAB_ALIAS[tab] || tab;
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
      try {
        this.autoLaunch = await NS.call(window.petAPI.autoLaunchStatus());
      } catch {
        this.autoLaunch = null;
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

    /** 是否显示「（12）」这类**数量**括号（设置 → 全局 可关；「（导入）」这类状态标记不受影响） */
    _countsOn() {
      const s = this.store.get('settings') || {};
      return s.showCounts !== false;
    }

    /* ---------------- 渲染 ---------------- */

    render() {
      const s = this.store.get('settings');
      const wasScrolled = this.el.querySelector('.sp-body');
      const scrollTop = wasScrolled ? wasScrolled.scrollTop : 0;

      this.el.innerHTML = '';

      const head = el('div', 'sp-head');
      head.appendChild(el('span', null, t('settings.title')));
      const acts = el('div', 'sp-actions');
      const close = el('span', 'sp-close', '✕');
      close.addEventListener('click', () => this.close());
      acts.appendChild(close);
      head.appendChild(acts);
      this.el.appendChild(head);
      this._attachHeadDrag(head);

      const tabs = el('div', 'sp-tabs');
      for (const tab of TABS) {
        const b = el('div', `sp-tab${this.tab === tab.key ? ' active' : ''}`, t(`settings.tab.${tab.key}`));
        b.addEventListener('click', () => {
          this.tab = tab.key;
          this.render();
        });
        tabs.appendChild(b);
      }
      this.el.appendChild(tabs);

      const body = el('div', 'sp-body');
      this.el.appendChild(body);

      if (this.tab === 'general') this._renderGeneral(body, s);
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

    /* ---------------- 通用（语言 / 纸张与文字 / 界面细节 / 启动 / 说明） ----------------
       以前「外观」单开一页，实际只有四五个滑杆，来回切页比改设置还费事；
       现在一页从上往下就是「先看语言 → 再调外观 → 最后启动」，一屏基本够。 */

    _renderGeneral(body, s) {
      const st = s || this.store.get('settings') || {};

      /* 语言：放最上面。它是唯一「改完整个界面都变」的开关，翻到底才能找到不合理 */
      const langSec = this._sec(t('settings.general.langSection'));
      const langRow = el('div', 'sp-row');
      langRow.appendChild(el('label', null, t('settings.general.uiLang')));
      const langOptions = NS.I18N.OPTIONS.map((code) => ({
        value: code,
        label: NS.I18N.localeName(code)
      }));
      const curPref = st.locale || 'auto';
      const langSel = this._select(langOptions, curPref, (v) => this.app.setLocale(v));
      langSel.classList.add('grow');
      langRow.appendChild(langSel);
      langSec.appendChild(langRow);
      langSec.appendChild(this._hint(t('settings.general.langHint')));
      body.appendChild(langSec);

      /* 纸张与文字：原「外观」页的尺寸/阅读两块 */
      const sec = this._sec(t('settings.appearance.title'));
      sec.appendChild(
        this._slider(t('settings.appearance.paperHeight'), {
          min: 120,
          max: 400,
          step: 10,
          value: st.basePaperHeightPx,
          fmt: (v) => `${v}px`,
          onChange: (v) => this.app.applySettings({ basePaperHeightPx: v })
        })
      );
      sec.appendChild(
        this._slider(t('settings.appearance.scale'), {
          min: 0.5,
          max: 2,
          step: 0.05,
          value: st.scale,
          fmt: (v) => `${Math.round(v * 100)}%`,
          onChange: (v) => this.app.applyScale(v)
        })
      );
      sec.appendChild(
        this._slider(t('settings.appearance.fontSize'), {
          min: 10,
          max: 30,
          step: 1,
          value: st.fontSizePx,
          fmt: (v) => `${v}px`,
          onChange: (v) => this.app.applySettings({ fontSizePx: v })
        })
      );
      sec.appendChild(
        this._switchRow(t('settings.appearance.darkMode'), st.darkMode, (v) =>
          this.app.applySettings({ darkMode: v })
        )
      );
      sec.appendChild(
        this._switchRow(t('settings.appearance.corner'), st.scaleCornerEnabled, (v) =>
          this.app.applySettings({ scaleCornerEnabled: v })
        )
      );
      sec.appendChild(this._hint(t('settings.appearance.hint')));
      body.appendChild(sec);

      /* 界面细节：和具体模式无关的小开关 */
      const viewSec = this._sec(t('settings.display.title'));
      viewSec.appendChild(
        this._switchRow(t('settings.display.counts'), st.showCounts !== false, (v) =>
          this.app.applySettings({ showCounts: v })
        )
      );
      viewSec.appendChild(this._hint(t('settings.display.countsHint')));
      body.appendChild(viewSec);

      /* 启动：只留开关 + 一句「换位置自动跟着改」。
         状态看开关本身，写进系统的命令、各种「已开启 / 已关闭」的解释都不再占地方。 */
      const al = this.autoLaunch;
      const supported = !al || al.supported !== false;
      const startSec = this._sec(t('settings.start.title'));

      const row = el('div', 'sp-row');
      row.appendChild(el('label', null, t('settings.start.autoLaunch')));
      const sp = el('div', `switch${al && al.enabled ? ' on' : ''}${supported ? '' : ' disabled'}`);
      row.appendChild(sp);
      startSec.appendChild(row);

      // 唯一保留的说明：程序换位置时启动项会自动改写（v2.4 起的行为，不写一句没人知道）
      startSec.appendChild(this._hint(t('settings.start.pathHint')));
      // 系统不支持时开关是死的，得说一句，否则「点了没反应」像坏了（只在非 Windows 环境出现）
      if (!supported) {
        startSec.appendChild(this._hint((al && al.reason) || t('settings.start.unsupported')));
      }

      sp.addEventListener('click', async () => {
        if (!supported || sp.classList.contains('busy')) return;
        const next = !sp.classList.contains('on');
        sp.classList.add('busy');
        sp.classList.toggle('on', next); // 先动一下手，等主进程回读后再以真实状态回填
        try {
          const status = await this.app.setAutoLaunch(next);
          this.autoLaunch = status || this.autoLaunch;
          this.render(); // 重建本页：被系统关掉时要补出「去放行」按钮
        } catch (err) {
          sp.classList.remove('busy');
          sp.classList.toggle('on', !next);
          this.app.toast.error(NS.errorText(err));
        }
      });

      if (al && al.supported !== false && al.blocked) {
        const btnRow = el('div', 'sp-row');
        btnRow.appendChild(
          this._btn(t('settings.start.openSystem'), () => this.app.openStartupSettings(), 'ghost')
        );
        startSec.appendChild(btnRow);
      }
      body.appendChild(startSec);

      const guideSec = this._sec(t('settings.guide.title'));
      guideSec.appendChild(this._btn(t('settings.guide.open'), () => this.app.showGuide(), 'ghost'));
      guideSec.appendChild(this._hint(t('settings.guide.hint')));
      body.appendChild(guideSec);
    }

    /** v3 之前的老名字：外部若还调 _renderGlobal 也不会崩 */
    _renderGlobal(body, s) {
      this._renderGeneral(body, s);
    }

    _renderTear(body, s) {
      const sec = this._sec(t('settings.tear.title'));
      sec.appendChild(
        this._slider(t('settings.tear.threshold'), {
          min: 0.5,
          max: 6,
          step: 0.5,
          value: s.tearThresholdPages,
          fmt: (v) => `${v} ${t('unit.sheets')}`,
          onChange: (v) => this.app.applySettings({ tearThresholdPages: v })
        })
      );
      sec.appendChild(this._hint(t('settings.tear.thresholdHint')));
      sec.appendChild(
        this._slider(t('settings.tear.maxBacktrack'), {
          min: 1,
          max: 50,
          step: 1,
          value: s.maxBacktrack,
          fmt: (v) => `${v} ${t('unit.sheets')}`,
          onChange: (v) => this.app.applySettings({ maxBacktrack: v })
        })
      );
      sec.appendChild(this._hint(t('settings.tear.maxBacktrackHint')));
      sec.appendChild(
        this._switchRow(t('settings.tear.notifyLimit'), s.notifyBacktrackLimit !== false, (v) =>
          this.app.applySettings({ notifyBacktrackLimit: v })
        )
      );
      body.appendChild(sec);

      const sec2 = this._sec(t('settings.tear.autoTitle'));
      sec2.appendChild(
        this._switchRow(t('settings.tear.autoEnable'), !!(s.autoTear && s.autoTear.enabled), (v) =>
          this.app.setAutoTear(v)
        )
      );
      sec2.appendChild(
        this._slider(t('settings.tear.autoSpeed'), {
          min: 2,
          max: 120,
          step: 1,
          value: Math.round((s.autoTear && s.autoTear.pxPerSec) || 20),
          fmt: (v) => `${v} ${t('unit.pxPerSec')}`,
          onChange: (v) => this.app.setAutoTearSpeed(v)
        })
      );
      sec2.appendChild(this._hint(t('settings.tear.autoHint')));
      body.appendChild(sec2);
    }

    _renderMode(body, s) {
      const sec = this._sec(t('settings.mode.title'));
      const row = el('div', 'sp-row');
      for (const m of NS.MODES) {
        const b = this._btn(
          NS.modeLabel(m),
          () => this.app.switchMode(m),
          s.currentMode === m ? 'primary' : ''
        );
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
      const sec = this._sec(t('settings.learn.title'));
      const dictOptions = this.dicts.map((d) => ({
        value: d.id,
        label: `${NS.I18N.dictName(d.name)}${d.builtin ? '' : t('settings.learn.importedTag')}${
          this._countsOn() ? ` · ${d.count}` : ''
        }`
      }));
      if (!dictOptions.length) dictOptions.push({ value: '', label: t('settings.learn.noDict') });
      const curMeta = (this.dicts || []).find((d) => d.id === learn.currentDictId);
      const dictNodes = [this._select(dictOptions, learn.currentDictId, (v) => this.app.switchDict(v))];
      if (curMeta && !curMeta.builtin) {
        dictNodes.push(this._btn(t('common.delete'), () => this.app.removeDict(curMeta.id), 'sm danger'));
      }
      const dictRow = this._row(t('settings.learn.dict'), dictNodes);
      dictNodes[0].classList.add('grow');
      sec.appendChild(dictRow);
      const btnRow = el('div', 'sp-row');
      btnRow.appendChild(this._btn(t('settings.learn.importDict'), () => this.app.importDict(), 'ghost'));
      btnRow.appendChild(
        this._btn(t('settings.learn.resetProgress'), () => this.app.resetLearnProgress(), 'ghost')
      );
      sec.appendChild(btnRow);
      sec.appendChild(
        this._switchRow(t('settings.learn.shuffle'), !!learn.shuffle, (v) =>
          this.app.setLearnOption('shuffle', v)
        )
      );
      sec.appendChild(
        this._switchRow(t('settings.learn.hideDef'), !!learn.hideDefinition, (v) =>
          this.app.setLearnOption('hideDefinition', v)
        )
      );

      /* 语言：导入时选的语言事后可改，不必重导。
         两个下拉并排一行，改完点「刷新纸面」才真正生效——每动一下就重读词库
         会连纸带一起重建，手感很跳；刷新只重绘、不动纸张进度。 */
      let langSec = null;
      if (curMeta) {
        // ⚠️ 这些中文名是**数据键**（词库 meta 里就这么存），界面只翻译显示，见 NS.I18N.langName()
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

        langSec = this._sec(
          `${t('settings.learn.langTitle')}${curMeta.langOverridden ? t('settings.learn.langEdited') : ''}`
        );

        const stateEl = el('span', 'sp-lang-state', '');
        const refreshBtn = this._btn(
          t('settings.learn.refresh'),
          () => {
            if (refreshBtn.disabled) return;
            refreshBtn.disabled = true;
            stateEl.textContent = t('settings.learn.refreshing');
            stateEl.classList.remove('dirty');
            this.app
              .applyDictLang(learn.currentDictId, pendWord, pendDef)
              .then((ok) => {
                // 有改动时面板会整体重建，旧节点已失效，反馈交给 toast
                if (!stateEl.isConnected) return;
                if (ok) {
                  stateEl.textContent = t('settings.learn.refreshed');
                  stateEl.classList.remove('dirty');
                } else {
                  stateEl.textContent = t('settings.learn.refreshFailed');
                  stateEl.classList.add('dirty');
                }
              })
              .catch(() => {
                if (stateEl.isConnected) stateEl.textContent = t('settings.learn.refreshFailed');
              })
              .finally(() => {
                refreshBtn.disabled = false;
              });
          },
          'primary'
        );
        const markDirty = () => {
          const changed = pendWord !== curWord || pendDef !== curDef;
          stateEl.textContent = changed ? t('settings.learn.dirty') : '';
          stateEl.classList.toggle('dirty', changed);
        };

        /* 两个下拉互斥：各自只列「另一种语言没占用」的选项，从根上杜绝上下相同。
           词库里没有内容的语言也列出来但标「无内容」——手改语言标签
           （比如法语词库被识别成英语）时还能纠正分组，只是纸面会回落原文。 */
        const hasContent = (v) => dictLangs.includes(v);
        const optionsFor = (exclude) =>
          ALL.filter((v) => v !== exclude).map((v) => ({
            v,
            label: hasContent(v)
              ? NS.I18N.langName(v)
              : `${NS.I18N.langName(v)}${t('settings.learn.noContentTag')}`
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
          fillSel(wordSel, pair ? optionsFor(pendDef) : ALL.map((v) => ({ v, label: NS.I18N.langName(v) })), pendWord);
          fillSel(defSel, pair ? optionsFor(pendWord) : ALL.map((v) => ({ v, label: NS.I18N.langName(v) })), pendDef);
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
        swapBtn.title = t('settings.learn.swap');
        swapBtn.setAttribute('aria-label', t('settings.learn.swapAria'));
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
          stateEl.textContent = t('settings.learn.swapping');
          stateEl.classList.remove('dirty');
          try {
            // silent：成功提示由这里统一给，避免「已改为 / 已对调」两条 toast 打架
            const ok = await this.app.applyDictLang(learn.currentDictId, w, d, { silent: true });
            if (ok)
              this.app.toast.info(
                t('settings.learn.swapped', { w: NS.I18N.langName(w), d: NS.I18N.langName(d) })
              );
            // 有改动时面板会整体重建，旧节点失效，反馈交给 toast
            if (!stateEl.isConnected) return;
            stateEl.textContent = ok
              ? t('settings.learn.swapped', { w: NS.I18N.langName(w), d: NS.I18N.langName(d) })
              : t('settings.learn.swapFailed');
            stateEl.classList.toggle('dirty', !ok);
          } catch {
            if (stateEl.isConnected) {
              stateEl.textContent = t('settings.learn.swapFailed');
              stateEl.classList.add('dirty');
            }
          } finally {
            swapBusy = false;
            swapBtn.disabled = false;
          }
        });

        const langRow = el('div', 'sp-lang-row');
        langRow.appendChild(this._langCell(t('settings.learn.wordLang'), wordSel));
        langRow.appendChild(swapBtn);
        langRow.appendChild(this._langCell(t('settings.learn.defLang'), defSel));
        langSec.appendChild(langRow);

        // 选了词库里没有的语言时明说一句，否则纸面看起来「换了没反应」
        const emptyEl = el('div', 'sp-hint sp-lang-empty', '');
        refreshEmpty = () => {
          const miss = [];
          if (pendWord && !hasContent(pendWord)) miss.push(NS.I18N.langName(pendWord));
          if (pendDef && !hasContent(pendDef)) miss.push(NS.I18N.langName(pendDef));
          emptyEl.textContent = miss.length
            ? t('settings.learn.noContentHint', { langs: miss.join(' / ') })
            : '';
        };
        refreshEmpty();
        langSec.appendChild(emptyEl);

        const acts = el('div', 'sp-lang-actions');
        acts.appendChild(refreshBtn);
        acts.appendChild(stateEl);
        langSec.appendChild(acts);
      }
      body.appendChild(sec);
      if (langSec) body.appendChild(langSec);

      /* 词库管理：导入的词库以前只能去 userData/dicts/ 手删，这里给个入口 */
      const imported = (this.dicts || []).filter((d) => !d.builtin);
      const mgmtSec = this._sec(
        this._countsOn()
          ? t('settings.learn.mgmtCount', { n: imported.length })
          : t('settings.learn.mgmt')
      );
      if (!imported.length) {
        mgmtSec.appendChild(this._hint(t('settings.learn.mgmtEmpty')));
      } else {
        const box = el('div', 'sp-list');
        for (const d of imported) {
          const item = el('div', 'sp-list-item');
          const isCur = d.id === learn.currentDictId;
          const dn = NS.I18N.dictName(d.name);
          const line = t('settings.learn.countLine', { name: dn, n: d.count });
          const name = el('span', 'ell', line);
          name.title = `${line}${d.wordLang ? ` · ${NS.I18N.langName(d.wordLang)}` : ''}${
            isCur ? ` · ${t('settings.learn.inUse')}` : ''
          }`;
          item.appendChild(name);
          if (isCur) {
            const tag = el('span', null, t('settings.learn.inUse'));
            tag.style.fontSize = '10px';
            tag.style.color = 'var(--ink-mute)';
            tag.style.flex = '0 0 auto';
            item.appendChild(tag);
          }
          item.appendChild(this._btn(t('common.delete'), () => this.app.removeDict(d.id), 'sm danger'));
          box.appendChild(item);
        }
        mgmtSec.appendChild(box);
      }
      body.appendChild(mgmtSec);

      /* 不显示 / 标星按「语言」分组：这里只列「当前词库语言」这一份，其余语言给出条数提示 */
      // 语言从词库列表反查，这样停在休闲/清单模式时打开设置也能显示正确的一份
      const lp = this.app.providers.learn;
      const curDict = (this.dicts || []).find((d) => d.id === learn.currentDictId);
      const lang = (curDict && curDict.lang) || lp.lang || 'unknown';
      const langRaw = (curDict && curDict.wordLang) || lp.langLabel || '';
      const langName = langRaw ? NS.I18N.langName(langRaw) : t('settings.learn.unknownLang');
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
      const hiddenTitle = this._countsOn()
        ? t('settings.learn.hiddenTitleCount', { n: hiddenSplit.here.length, lang: langName })
        : `${t('settings.learn.hiddenTitle')} · ${langName}`;
      const listSec = this._sec(hiddenTitle);
      listSec.appendChild(
        this._foldList(
          hiddenSplit.here,
          t('settings.learn.show'),
          (w) => this.app.toggleHidden(w),
          t('unit.hiddenWord')
        )
      );
      if (hiddenSplit.stale.length) {
        listSec.appendChild(
          this._hint(t('settings.learn.staleNote', { n: hiddenSplit.stale.length }))
        );
      }
      const hiddenOther = otherCount(learn.hidden);
      if (hiddenOther) listSec.appendChild(this._hint(t('settings.learn.otherLangNote', { n: hiddenOther })));
      body.appendChild(listSec);

      const starSplit = splitByDict(group(learn.starred));
      const starTitle = this._countsOn()
        ? t('settings.learn.starredTitleCount', { n: starSplit.here.length, lang: langName })
        : `${t('settings.learn.starredTitle')} · ${langName}`;
      const starSec = this._sec(starTitle);
      starSec.appendChild(
        this._foldList(
          starSplit.here,
          t('settings.learn.unstar'),
          (w) => this.app.toggleStar(w),
          t('unit.starredWord')
        )
      );
      if (starSplit.stale.length) {
        starSec.appendChild(
          this._hint(t('settings.learn.staleNote', { n: starSplit.stale.length }))
        );
      }
      const starOther = otherCount(learn.starred);
      if (starOther) starSec.appendChild(this._hint(t('settings.learn.otherLangNote', { n: starOther })));
      body.appendChild(starSec);
    }

    /** 折叠列表：默认收起，点标题才展开 —— 避免十几条词把设置面板撑满 */
    _foldList(words, btnLabel, onClick, unit) {
      const wrap = el('div', 'sp-fold');
      const head = el('div', 'sp-fold-head');
      head.appendChild(el('span', 'sp-fold-arrow'));
      head.appendChild(
        el(
          'span',
          'ell',
          words.length
            ? t('common.expandCount', { n: words.length, unit: unit || '' }).trim()
            : t('common.none')
        )
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
        box.appendChild(el('div', 'sp-empty', t('common.none')));
        return box;
      }
      for (const w of words.slice(0, 200)) {
        const item = el('div', 'sp-list-item');
        item.appendChild(el('span', 'ell', w));
        const b = this._btn(btnLabel, () => onClick(w), 'sm');
        item.appendChild(b);
        box.appendChild(item);
      }
      if (words.length > 200)
        box.appendChild(el('div', 'sp-empty', t('common.more', { n: words.length - 200 })));
      return box;
    }

    _renderLeisure(body, s) {
      const leisure = this.store.get('leisure');
      const sec = this._sec(t('settings.leisure.docs'));
      sec.appendChild(this._btn(t('settings.leisure.importDoc'), () => this.app.importDoc(), 'ghost'));
      body.appendChild(sec);

      const listSec = this._sec(
        this._countsOn()
          ? t('settings.leisure.docsCount', { n: this.docs.length })
          : t('settings.leisure.docs')
      );
      const box = el('div', 'sp-list');
      if (!this.docs.length) {
        box.appendChild(el('div', 'sp-empty', t('settings.leisure.empty')));
      } else {
        for (const d of this.docs) {
          const item = el('div', `sp-list-item${leisure.activeDocId === d.docId ? ' active' : ''}`);
          const name = el('span', 'ell', d.name);
          name.title = `${d.name} · ${t('settings.leisure.blocks', { n: d.blockCount })}`;
          name.style.cursor = 'pointer';
          name.addEventListener('click', () => this.app.openDoc(d.docId));
          item.appendChild(name);
          item.appendChild(this._btn(t('common.delete'), () => this.app.removeDoc(d.docId), 'sm danger'));
          box.appendChild(item);
        }
      }
      listSec.appendChild(box);
      body.appendChild(listSec);
    }

    _renderChecklist(body, s) {
      const cl = this.store.get('checklists');
      const sec = this._sec(t('settings.cl.title'));
      const listOptions = (cl.lists || []).map((l) => ({
        value: l.id,
        label: this._countsOn() ? `${l.name}（${l.items.length}）` : l.name
      }));
      if (!listOptions.length) listOptions.push({ value: '', label: t('settings.cl.noList') });
      sec.appendChild(
        this._row(t('settings.cl.switch'), [this._select(listOptions, cl.activeListId, (v) => this.app.selectList(v))])
      );
      const rowBtn = el('div', 'sp-row');
      rowBtn.appendChild(this._btn(t('settings.cl.new'), () => this.app.createList(), 'ghost'));
      rowBtn.appendChild(this._btn(t('settings.cl.rename'), () => this.app.renameList(), 'ghost'));
      rowBtn.appendChild(
        this._btn(t('settings.cl.delete'), () => this.app.removeList(), 'ghost danger')
      );
      sec.appendChild(rowBtn);
      // 清单备份（v2.9 从右键菜单挪进来，摆在清单模式自己的设置里）
      const ioRow = el('div', 'sp-row');
      ioRow.appendChild(this._btn(t('settings.cl.export'), () => this.app.exportChecklists(), 'ghost'));
      ioRow.appendChild(this._btn(t('settings.cl.import'), () => this.app.importChecklists(), 'ghost'));
      sec.appendChild(ioRow);
      const noTear = s.checklistNoTear !== false;
      sec.appendChild(
        this._switchRow(t('settings.cl.noTear'), noTear, (v) => this.app.setChecklistNoTear(v))
      );
      sec.appendChild(
        this._switchRow(t('settings.cl.loop'), s.checklistLoop !== false, (v) =>
          this.app.setChecklistLoop(v)
        )
      );
      sec.appendChild(
        this._switchRow(t('settings.cl.numbering'), !!s.checklistNumbering, (v) =>
          this.app.setChecklistNumbering(v)
        )
      );
      body.appendChild(sec);

      const active = (cl.lists || []).find((l) => l.id === cl.activeListId) || (cl.lists || [])[0];
      if (!active) return;

      /* 清除：只清**在纸面上**做过的东西 —— 勾选，和右键设的加粗/颜色/划线；
         条目文字、高级编辑里排的版、随记都不动 */
      const items = active.items || [];
      const doneN = items.filter((it) => NS.ChecklistOps.hasMark(it, 'done')).length;
      const pageN = items.filter((it) => NS.ChecklistOps.hasMark(it, 'page')).length;
      const showN = this._countsOn();
      const clearSec = this._sec(t('settings.cl.clearTitle'));
      const clearRow = el('div', 'sp-row');
      const btnDone = this._btn(
        `${t('settings.cl.clearDone')}${showN && doneN ? ` (${doneN})` : ''}`,
        () => this.app.clearChecklistMarks('done'),
        'ghost'
      );
      btnDone.disabled = !doneN;
      const btnAll = this._btn(
        `${t('settings.cl.clearPage')}${showN && pageN ? ` (${pageN})` : ''}`,
        () => this.app.clearChecklistMarks('page'),
        'ghost'
      );
      btnAll.disabled = !pageN;
      clearRow.appendChild(btnDone);
      clearRow.appendChild(btnAll);
      clearSec.appendChild(clearRow);
      body.appendChild(clearSec);

      /* 定时清除：每天到点自动清一次，省得每天手动点 */
      const ac = s.checklistAutoClear || {};
      const autoSec = this._sec(t('settings.cl.autoTitle'));
      autoSec.appendChild(
        this._switchRow(t('settings.cl.autoEnable'), !!ac.enabled, (v) =>
          this.app.setAutoClear({ enabled: v })
        )
      );
      const timeRow = el('div', 'sp-row');
      timeRow.appendChild(el('label', null, t('settings.cl.time')));
      const timeInput = document.createElement('input');
      timeInput.type = 'time';
      timeInput.value = ac.time || '06:00';
      timeInput.disabled = !ac.enabled;
      timeInput.addEventListener('change', () =>
        this.app.setAutoClear({ time: timeInput.value || '06:00' })
      );
      timeRow.appendChild(timeInput);
      const scopeSel = this._select(
        [
          { value: 'page', label: t('settings.cl.scopePage') },
          { value: 'done', label: t('settings.cl.scopeDone') }
        ],
        ac.scope === 'done' ? 'done' : 'page',
        (v) => this.app.setAutoClear({ scope: v })
      );
      scopeSel.disabled = !ac.enabled;
      // 英文/法文的选项很长：给一个可收缩的基准宽度，别把整行顶出面板
      scopeSel.style.flex = '1 1 0';
      scopeSel.style.width = 'auto';
      scopeSel.style.minWidth = '0';
      scopeSel.style.maxWidth = '100%';
      timeRow.appendChild(scopeSel);
      autoSec.appendChild(timeRow);
      body.appendChild(autoSec);

      const itemSec = this._sec(
        this._countsOn()
          ? t('settings.cl.itemsCount', { n: items.length })
          : t('settings.cl.items')
      );
      const addRow = el('div', 'sp-row');
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = t('settings.cl.addPlaceholder');
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

      // 排版：跳独立窗口，像 doc 一样排版（字号/字色/高亮/加粗），纸面按段落折行分页
      const richRow = el('div', 'sp-row');
      const richBtn = this._btn(t('settings.cl.rich'), () => this.app.editItemRich(''), 'ghost');
      richBtn.style.flex = '0 0 auto';
      richBtn.title = t('settings.cl.richNewTip');
      richRow.appendChild(richBtn);
      itemSec.appendChild(richRow);

      const box = el('div', 'sp-list');
      if (!active.items.length) {
        box.appendChild(el('div', 'sp-empty', t('settings.cl.empty')));
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
        handle.title = t('settings.cl.drag');
        item.appendChild(handle);

        const txt = el('span', 'ell', `${it.done ? '✓ ' : ''}${it.text}`);
        if (it.style && it.style.bold) txt.style.fontWeight = '700';
        if (it.done) txt.style.opacity = '0.6';
        if (it.style && it.style.color) txt.style.color = it.style.color;
        txt.style.cursor = 'text';
        txt.title = t('settings.cl.dblclick');
        txt.addEventListener('dblclick', () => this.app.editItemText(it.id));
        item.appendChild(txt);
        const richBtn = this._btn(t('settings.cl.rich'), () => this.app.editItemRich(it.id), 'sm');
        richBtn.title = it.html ? t('settings.cl.richDoneTip') : t('settings.cl.richTip');
        const notes = NS.ChecklistOps.notesOf(it);
        const noteBtn = this._btn(t('settings.cl.note'), () => this.app.editItemNote(it.id), 'sm');
        noteBtn.textContent = notes.length
          ? t('settings.cl.noteCount', { n: notes.length })
          : t('settings.cl.note');
        noteBtn.title = notes.length
          ? notes
              .map((n) => `[${t(`menu.noteMode.${n.mode || 'always'}`)}] ${n.text}`)
              .join('\n')
          : t('settings.cl.noteTip');
        if (notes.length) noteBtn.style.opacity = '1';
        item.appendChild(noteBtn);
        const starBtn = this._btn('★', () => this.app.toggleItemStar(it.id), 'sm');
        starBtn.classList.toggle('starred', !!it.starred);
        starBtn.title = it.starred ? t('settings.cl.unstar') : t('settings.cl.star');
        if (it.starred) starBtn.style.opacity = '1';
        item.appendChild(starBtn);
        item.appendChild(richBtn);
        item.appendChild(this._btn('↑', () => this.app.moveItem(it.id, -1), 'sm'));
        item.appendChild(this._btn('↓', () => this.app.moveItem(it.id, 1), 'sm'));
        item.appendChild(this._btn('✕', () => this.app.removeItem(it.id), 'sm danger'));
        box.appendChild(item);
      }
      itemSec.appendChild(box);
      body.appendChild(itemSec);
    }

    _renderKeys(body) {
      const map = this.shortcuts || {};
      const sec = this._sec(t('settings.keys.title'));
      sec.appendChild(this._hint(t('settings.keys.hint')));
      for (const a of ACTIONS) {
        const cur = map[a.key] || { focused: '', global: '' };
        for (const scope of ['focused', 'global']) {
          const row = el('div', 'sp-row');
          row.appendChild(
            el(
              'label',
              null,
              scope === 'focused' ? t(`keys.action.${a.key}`) : `　↳ ${t('settings.keys.scope.global')}`
            )
          );
          const kbd = el('span', 'sp-kbd', cur[scope] || t('settings.keys.unset'));
          kbd.addEventListener('click', () => this.startRecord(a.key, scope, kbd));
          row.appendChild(kbd);
          if (scope === 'focused') {
            row.appendChild(
              this._btn(t('settings.keys.clear'), () => {
                this.app.setShortcut(a.key, '', scope).catch(() => {});
              }, 'sm')
            );
          }
          sec.appendChild(row);
        }
      }
      body.appendChild(sec);
    }

    _renderData(body) {
      const sec = this._sec(t('settings.data.dirTitle'));
      const info = this.app.info || {};
      const pathEl = el('div', 'sp-hint', info.userData || '');
      pathEl.style.wordBreak = 'break-all';
      pathEl.style.userSelect = 'text';
      sec.appendChild(pathEl);
      sec.appendChild(this._btn(t('settings.data.open'), () => this.app.openUserData(), 'ghost'));
      body.appendChild(sec);

      const resetSec = this._sec(t('settings.data.resetTitle'));
      const row = el('div', 'sp-row');
      row.appendChild(
        this._btn(t('settings.data.resetSettings'), () => this.app.resetData('settings'), 'ghost')
      );
      row.appendChild(
        this._btn(t('settings.data.clearAll'), () => this.app.resetData('all'), 'ghost danger')
      );
      resetSec.appendChild(row);
      body.appendChild(resetSec);
    }

    /* ---------------- 录键 ---------------- */

    startRecord(action, scope, node) {
      this.stopRecord();
      this.recording = { action, scope, node };
      node.classList.add('recording');
      node.textContent = t('settings.keys.recording');
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
          this.app.toast.warn(err.message || t('toast.keys.failed'));
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
