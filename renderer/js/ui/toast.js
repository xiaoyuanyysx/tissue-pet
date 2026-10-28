/* toast.js —— 轻提示 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  class Toast {
    constructor(host) {
      this.host = host;
      this.queue = [];
    }

    show(message, level = 'info', ms = 2200) {
      if (!this.host) return;
      const el = document.createElement('div');
      el.className = `toast ${level === 'info' ? '' : level}`.trim();
      el.textContent = String(message || '');
      this.host.appendChild(el);
      // 最多同时 3 条
      while (this.host.children.length > 3) this.host.removeChild(this.host.firstChild);
      setTimeout(() => {
        el.style.transition = 'opacity .3s, transform .3s';
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';
        setTimeout(() => el.remove(), 320);
      }, ms);
    }

    info(m, ms) {
      this.show(m, 'info', ms || 2200);
    }
    warn(m, ms) {
      this.show(m, 'warn', ms || 3000);
    }
    error(m, ms) {
      this.show(m, 'error', ms || 3400);
    }
  }

  NS.Toast = Toast;
})(window);
