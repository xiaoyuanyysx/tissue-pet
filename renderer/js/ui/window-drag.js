/* window-drag.js —— 卷筒拖动移动窗口
   为什么不用 -webkit-app-region: drag：
     Electron/Chromium 在「舞台有 transform（缩放）」+「透明窗口」+「鼠标穿透 toggle」
     叠加时，可拖拽区域命中测试经常失效（表现为桌宠钉死在屏幕中间）。
     这里直接用 pointer 事件 + 主进程 moveBy 增量移动，行为可预测且支持缩放。
*/
(function (global) {
  'use strict';
  const NS = global.XZ;

  class WindowDrag {
    constructor({ el, onStart, onEnd, enabled }) {
      this.el = el;
      this.onStart = onStart || (() => {});
      this.onEnd = onEnd || (() => {});
      this.enabled = enabled !== false;
      this.dragging = false;
      this.lx = 0;
      this.ly = 0;
      this.accX = 0;
      this.accY = 0;
      this.moved = false;
      this.pid = null;
    }

    setEnabled(v) {
      this.enabled = !!v;
      if (this.el) this.el.style.display = v ? '' : 'none';
      if (!v) this._end();
    }

    attach() {
      if (!this.el) return;
      this.el.addEventListener('pointerdown', (e) => {
        if (!this.enabled || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.dragging = true;
        this.moved = false;
        this.lx = e.screenX;
        this.ly = e.screenY;
        this.accX = 0;
        this.accY = 0;
        this.pid = e.pointerId;
        try {
          this.el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        this.onStart();
      });

      const onMove = (e) => {
        if (!this.dragging) return;
        if (this.pid != null && e.pointerId !== this.pid) return;
        const dx = e.screenX - this.lx;
        const dy = e.screenY - this.ly;
        if (!dx && !dy) return;
        this.lx = e.screenX;
        this.ly = e.screenY;
        this.accX += dx;
        this.accY += dy;
        const mx = Math.trunc(this.accX);
        const my = Math.trunc(this.accY);
        if (!mx && !my) return;
        this.accX -= mx;
        this.accY -= my;
        this.moved = true;
        if (window.petAPI && window.petAPI.moveBy) window.petAPI.moveBy(mx, my);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', () => this._end());
      window.addEventListener('pointercancel', () => this._end());
      window.addEventListener('blur', () => this._end());
      // 拖完立刻进入过「一起点就松手」的点击场景：用 click 阻止误触穿透
      this.el.addEventListener('click', (e) => {
        if (this.moved) e.stopPropagation();
      });
    }

    _end() {
      if (!this.dragging) return;
      this.dragging = false;
      try {
        if (this.pid != null && this.el.hasPointerCapture(this.pid)) {
          this.el.releasePointerCapture(this.pid);
        }
      } catch {
        /* ignore */
      }
      this.pid = null;
      this.onEnd();
    }
  }

  NS.WindowDrag = WindowDrag;
})(window);
