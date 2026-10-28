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
      this.store.patch(
        'torn',
        { [mode]: { headIndex: top, stack: [] } },
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
        const count = provider.paperCount;
        return NS.clamp(top, 0, Math.max(0, count - 1));
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
          provider.applyState(state.checklists);
          await provider.ensureLoaded();
        }

        const top = this._restoreTop(mode);

        this.mode = mode;
        // 回溯栈只认「本次运行」：内存里有就用内存，否则一律空（不读磁盘里的旧栈）
        this.tear.adopt(mode, top, this.session[mode] || []);
        this.engine.setProvider(provider, { top });

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
