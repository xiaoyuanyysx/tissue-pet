/* context-menu.js —— A7/D3 自绘 HTML 右键菜单 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  class ContextMenu {
    constructor(host) {
      this.host = host;
      this.el = document.createElement('div');
      this.el.className = 'context-menu hidden';
      this.host.appendChild(this.el);
      this.open = false;
      this._onDocDown = (e) => {
        if (this.open && !this.el.contains(e.target)) this.close();
      };
      document.addEventListener('pointerdown', this._onDocDown, true);
      window.addEventListener('blur', () => this.close());
    }

    /** items: [{label, icon, danger, disabled, onClick} | {sep:true}] */
    show(x, y, items) {
      const list = (items || []).filter(Boolean);
      if (!list.length) return;
      this.el.innerHTML = '';
      for (const it of list) {
        if (it.sep) {
          const sep = document.createElement('div');
          sep.className = 'cm-sep';
          this.el.appendChild(sep);
          continue;
        }
        const row = document.createElement('div');
        row.className = `cm-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`;
        const ico = document.createElement('span');
        ico.className = 'cm-ico';
        ico.textContent = it.icon || '';
        const label = document.createElement('span');
        label.textContent = it.label;
        row.appendChild(ico);
        row.appendChild(label);
        if (it.hint) {
          const hint = document.createElement('span');
          hint.className = 'cm-hint';
          hint.textContent = it.hint;
          row.appendChild(hint);
        }
        if (!it.disabled) {
          row.addEventListener('click', () => {
            this.close();
            try {
              it.onClick && it.onClick();
            } catch (err) {
              console.error('[menu] 执行失败', err);
            }
          });
        }
        this.el.appendChild(row);
      }

      this.el.classList.remove('hidden');
      this.open = true;
      // 定位（防溢出）
      const rect = this.el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.min(x, Math.max(4, vw - rect.width - 6));
      const top = Math.min(y, Math.max(4, vh - rect.height - 6));
      this.el.style.left = `${Math.max(4, left)}px`;
      this.el.style.top = `${Math.max(4, top)}px`;
    }

    close() {
      if (!this.open) return;
      this.open = false;
      this.el.classList.add('hidden');
    }

    get isOpen() {
      return this.open;
    }
  }

  NS.ContextMenu = ContextMenu;
})(window);
