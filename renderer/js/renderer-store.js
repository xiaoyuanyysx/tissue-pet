/* renderer-store.js —— A3 渲染进程状态镜像与分级上报 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  const SCOPES = ['settings', 'learn', 'leisure', 'checklists', 'torn'];

  function isPlain(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  class RendererStore {
    constructor() {
      this.state = null;
      this.timers = new Map();
      this.pending = new Map();
      this.listeners = new Map();
    }

    async init() {
      this.state = await NS.call(window.petAPI.storeGet());
      return this.state;
    }

    get(scope) {
      return this.state[scope];
    }

    on(scope, cb) {
      if (!this.listeners.has(scope)) this.listeners.set(scope, new Set());
      this.listeners.get(scope).add(cb);
      return () => this.listeners.get(scope).delete(cb);
    }

    _emit(scope) {
      const set = this.listeners.get(scope);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(this.state[scope]);
        } catch (err) {
          console.error('[store] 监听器异常', err);
        }
      }
    }

    /**
     * critical: 撕纸/回溯/勾选/切模式/标星/导入/设置写入 → 立即落盘
     * ordinary: 滚动位置等 → 500ms 防抖合并
     */
    patch(scope, partial, opts = {}) {
      if (!this.state || !SCOPES.includes(scope)) return;
      const target = this.state[scope];
      for (const key of Object.keys(partial)) {
        const cur = target[key];
        const next = partial[key];
        if (isPlain(cur) && isPlain(next)) target[key] = Object.assign({}, cur, next);
        else target[key] = next;
      }

      const acc = this.pending.get(scope) || {};
      for (const key of Object.keys(partial)) {
        const cur = acc[key];
        const next = partial[key];
        if (isPlain(cur) && isPlain(next)) acc[key] = Object.assign({}, cur, next);
        else acc[key] = next;
      }
      this.pending.set(scope, acc);
      this._emit(scope);

      if (opts.critical) {
        this._cancel(scope);
        this._flushScope(scope, true);
      } else if (!this.timers.has(scope)) {
        const timer = setTimeout(() => {
          this.timers.delete(scope);
          this._flushScope(scope, false);
        }, 500);
        this.timers.set(scope, timer);
      }
    }

    _cancel(scope) {
      const t = this.timers.get(scope);
      if (t) {
        clearTimeout(t);
        this.timers.delete(scope);
      }
    }

    _flushScope(scope, critical) {
      const payload = this.pending.get(scope);
      if (!payload) return;
      this.pending.delete(scope);
      NS.call(window.petAPI.storePatch(scope, payload, { critical })).catch((err) => {
        console.error('[store] 持久化失败', scope, err);
      });
    }

    async flush() {
      for (const scope of [...this.pending.keys()]) {
        this._cancel(scope);
        this._flushScope(scope, true);
      }
    }
  }

  NS.RendererStore = RendererStore;
})(window);
