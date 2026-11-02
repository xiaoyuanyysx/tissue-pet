/* mode-router.js —— A1 三模式框架：模式切换与各自进度/回溯栈的隔离恢复 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  class ModeRouter {
    constructor({ store, engine, tear, providers }) {
      this.store = store;
      this.engine = engine;
      this.tear = tear;
      this.providers = providers;
      this.mode = null;
      this.listeners = new Set();
      this.switching = false;
      // 回溯栈只服务「本次运行」：重启后不再恢复，避免回溯到上次启动前撕的纸
      this.session = {};
    }

    get current() {
      return this.mode;
    }

    get provider() {
      return this.mode ? this.providers[this.mode] : null;
    }

    onModeChanged(cb) {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }

    _emit() {
      for (const cb of this.listeners) {
        try {
          cb(this.mode);
        } catch (err) {
          console.error('[mode] 监听器异常', err);
        }
      }
    }

    /** 顶层逻辑纸 index（= 已撕纸张数），由引擎持有 */
    get top() {
      return this.engine.top;
    }

    /** 把当前模式的进度写入持久化域 */
    persistProgress(critical) {
      const mode = this.mode;
      if (!mode) return;
      const top = this.engine.top;
      const provider = this.providers[mode];
      if (mode === 'learn') {
        this.store.patch(
          'learn',
          { headEntryIndex: Math.max(0, provider.pos + top) },
          { critical: !!critical }
        );
      } else if (mode === 'leisure') {
        const anchor = provider.indexToAnchor(top);
        if (anchor && anchor.docId) {
          const progress = Object.assign({}, this.store.get('leisure').progress);
          progress[anchor.docId] = anchor.value;
          this.store.patch('leisure', { progress, activeDocId: anchor.docId }, { critical: !!critical });
        }
      }
      // 回溯栈留在内存（切换模式时保留，重启后清空）
      this.session[mode] = this.tear.stack.peekAll();
      // 清单不撕纸时指针恒为 0；headIndex 记录「当前首屏是第几页」，
      // 下次进来按它把纸带滚回原处（只存页号，不依赖任何 DOM 位置）。
      // 循环浏览时页号是无限的，存之前先对页数取模，免得滚了十几轮后数字越滚越大。
      // 打开「撕纸」后语义回到「已撕掉几张」（与单词模式一致），直接存 top。
      let head =
        mode === 'checklist' && typeof this.engine.readIndex === 'function' ? this.engine.readIndex() : top;
      if (mode === 'checklist') {
        const noTear = this.store.get('settings').checklistNoTear !== false;
        if (noTear) {
          const n = provider.pageCount || 1;
          head = ((Math.floor(head) % n) + n) % n;
        } else {
          head = Math.max(0, Math.floor(top));
        }
      }
      this.store.patch(
        'torn',
        { [mode]: { headIndex: head, stack: [] } },
        { critical: !!critical }
      );
    }

    /** 从持久化状态推导 "进入该模式时的顶层 index" */
    _restoreTop(mode) {
      const state = this.store.state;
      const torn = (state.torn && state.torn[mode]) || { headIndex: 0, stack: [] };
      const provider = this.providers[mode];
      let top = Math.max(0, Number(torn.headIndex) || 0);

      if (mode === 'learn') {
        const head = Math.max(0, Number(state.learn.headEntryIndex) || 0);
        provider.pos = Math.max(0, head - top);
        return top;
      }
      if (mode === 'leisure') {
        const docId = state.leisure.activeDocId;
        if (docId && provider.docId === docId && provider.plans.length) {
          const off = Number((state.leisure.progress || {})[docId]);
          if (Number.isFinite(off)) {
            const idx = provider.anchorToIndex({ type: 'charOffset', docId, value: off });
            if (idx != null) return idx;
          }
        }
        return 0;
      }
      if (mode === 'checklist') {
        // 不撕纸（默认）：清单页不是「消耗品」，指针永远停在 0（第一页），
        // 翻到哪儿只体现在纸带位移上；老数据里 headIndex 可能 > 0（当年撕过页），
        // 这里一律归零，让内容重新可见。
        if (state.settings.checklistNoTear !== false) return 0;
        // 撕纸模式：headIndex 就是「已经撕掉几张」，与单词模式同义；
        // 夹在当前页数内，条目变少了也不会停到内容之外。
        const n = provider.pageCount || 1;
        return Math.min(Math.max(0, Math.floor(Number(torn.headIndex) || 0)), Math.max(0, n - 1));
      }
      return top;
    }

    async boot() {
      const mode = this.store.get('settings').currentMode || 'learn';
      await this.enter(mode);
      return mode;
    }

    async enter(mode) {
      if (!NS.MODES.includes(mode)) mode = 'learn';
      this.switching = true;
      try {
        const state = this.store.state;
        const provider = this.providers[mode];

        if (mode === 'learn') {
          provider.applyState(state.learn);
          await provider.ensureLoaded(state.learn.currentDictId);
        } else if (mode === 'leisure') {
          provider.applyState(state.leisure);
          await provider.ensureLoaded(state.leisure);
        } else {
          // 清单循环：和单词模式一样，纸带无限，拉到底接回第一页（设置里可关）
          const noTear = state.settings.checklistNoTear !== false;
          provider.setLoop(state.settings.checklistLoop !== false);
          // 撕纸模式：纸是消耗品，不再循环取模（撕完又绕回来等于白撕）
          provider.setTearMode(!noTear);
          provider.setNumbering(!!state.settings.checklistNumbering);
          // 同一个开关下发给撕纸控制器：false = 只滚动浏览，true = 按阈值撕
          this.tear.setChecklistTear(!noTear);
          provider.applyState(state.checklists);
          await provider.ensureLoaded();
        }

        const top = this._restoreTop(mode);

        this.mode = mode;
        // 回溯栈只认「本次运行」：内存里有就用内存，否则一律空（不读磁盘里的旧栈）
        this.tear.adopt(mode, top, this.session[mode] || []);
        this.engine.setProvider(provider, { top });
        // 清单（不撕纸）：把纸带滚回上次看到的页（headIndex 存的就是「首屏页号」）
        // 撕纸模式下 headIndex 是「已撕张数」，位置由 top 体现，这里不再叠加位移。
        if (mode === 'checklist' && state.settings.checklistNoTear !== false) {
          const saved = (state.torn && state.torn.checklist && state.torn.checklist.headIndex) || 0;
          // 循环浏览时页号可能超出当前页数（条目改过），取模落回有效页
          const n = provider.pageCount || 1;
          const pages = ((Math.floor(Number(saved) || 0) % n) + n) % n;
          if (pages > 0) this.engine.setShift(pages * this.engine.H);
        }

        if (state.settings.currentMode !== mode) {
          this.store.patch('settings', { currentMode: mode }, { critical: true });
        }
        this._emit();
      } finally {
        this.switching = false;
      }
    }

    async switchTo(mode) {
      if (!mode || mode === this.mode) return;
      this.persistProgress(true);
      // 清理旧模式的临时 pin（内容重现由栈负责）
      const old = this.providers[this.mode];
      if (old && old.clearPins) old.clearPins();
      await this.enter(mode);
    }
  }

  NS.ModeRouter = ModeRouter;
})(window);
