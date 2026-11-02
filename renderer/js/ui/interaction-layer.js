/* interaction-layer.js —— 鼠标穿透判定（白名单）+ 右键分发 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  class InteractionLayer {
    constructor() {
      // ★ 可交互元素白名单集中在这里。新增浮层 UI 时请一并把选择器加进来，
      //   否则该区域会被判定成「透明区」，鼠标直接穿透到下面的桌面。
      //   （旧版提供的 registerHitTarget() 从未被任何模块调用，已删除以免误导。）
      this.selectors = [
        '.viewport',
        '.drag-zone',
        '.gear-btn',
        '.scale-corner',
        '.settings-panel',
        '.context-menu',
        '.toast-host',
        '.modal-mask',
        '.modal'
      ];
      this.ignoring = null;
      this.forced = false;
      this._raf = 0;
      this._lastEvent = null;
    }

    attach() {
      document.addEventListener('mousemove', (e) => {
        this._lastEvent = e;
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
          this._raf = 0;
          this._sync(this._lastEvent);
        });
      });
      document.addEventListener('mouseleave', () => {
        if (!this.forced) this._apply(true);
      });
      // 保险：任何按下都先取消穿透（转发模式下 move 偶尔会丢）
      document.addEventListener(
        'pointerdown',
        () => {
          this._apply(false);
        },
        true
      );
    }

    /** 拖纸 / 缩放角拖动期间强制不穿透 */
    setForced(v) {
      this.forced = !!v;
      if (this.forced) this._apply(false);
      else if (this._lastEvent) this._sync(this._lastEvent);
    }

    _sync(e) {
      if (this.forced) {
        this._apply(false);
        return;
      }
      if (!e) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      let hit = false;
      if (el && el.closest) {
        for (const sel of this.selectors) {
          if (el.closest(sel)) {
            hit = true;
            break;
          }
        }
      }
      this._apply(!hit);
    }

    _apply(ignore) {
      if (this.ignoring === ignore) return;
      this.ignoring = ignore;
      if (window.petAPI && window.petAPI.setIgnoreMouseEvents) {
        window.petAPI.setIgnoreMouseEvents(ignore);
      }
    }
  }

  NS.InteractionLayer = InteractionLayer;
})(window);
