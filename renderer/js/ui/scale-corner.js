/* scale-corner.js —— E5 左上角缩放角 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  const BASE_W = 500;
  const BASE_H = 600;

  class ScaleCorner {
    constructor({ el, onScale, getScale }) {
      this.el = el;
      this.onScale = onScale;
      this.getScale = getScale;
      this.dragging = false;
      this.startX = 0;
      this.startY = 0;
      this.startScale = 1;
      this.enabled = true;
      this._move = null;
      this._up = null;
      this._attach();
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (this.el) this.el.classList.toggle('hidden', !this.enabled);
    }

    _attach() {
      if (!this.el) return;
      this.el.addEventListener('pointerdown', (e) => {
        if (!this.enabled || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.dragging = true;
        this.startX = e.clientX;
        this.startY = e.clientY;
        this.startScale = this.getScale();
        this.el.setPointerCapture && this.el.setPointerCapture(e.pointerId);
      });
      this._move = (e) => {
        if (!this.dragging) return;
        const dx = (e.clientX - this.startX) / BASE_W;
        const dy = (e.clientY - this.startY) / BASE_H;
        const next = NS.clamp(this.startScale * (1 + (dx + dy) / 2), 0.5, 2);
        this.onScale(Math.round(next * 100) / 100);
      };
      this._up = () => {
        this.dragging = false;
      };
      window.addEventListener('pointermove', this._move);
      window.addEventListener('pointerup', this._up);
      window.addEventListener('pointercancel', this._up);
    }

    dispose() {
      if (this._move) window.removeEventListener('pointermove', this._move);
      if (this._up) window.removeEventListener('pointerup', this._up);
    }
  }

  NS.ScaleCorner = ScaleCorner;
})(window);
