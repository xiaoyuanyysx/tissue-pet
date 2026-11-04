/* context-menu.js —— A7/D3 自绘 HTML 右键菜单
   支持二级菜单：item.children = [...]，鼠标移上去从右侧展开（贴到窗口右边时向左翻），
   点一下也能展开 —— 免得在触控板/小窗口里「悬停」不好使。 */
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
      this._subTimer = 0;
      this._onDocDown = (e) => {
        if (this.open && !this.el.contains(e.target)) this.close();
      };
      document.addEventListener('pointerdown', this._onDocDown, true);
      window.addEventListener('blur', () => this.close());
    }

    /** items: [{label, icon, danger, disabled, hint, onClick, children} | {sep:true}] */
    show(x, y, items) {
      const list = (items || []).filter(Boolean);
      if (!list.length) return;
      this.el.innerHTML = '';
      this._build(this.el, list);

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

    _build(container, items) {
      for (const it of items) {
        if (it.sep) {
          const sep = document.createElement('div');
          sep.className = 'cm-sep';
          container.appendChild(sep);
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
        container.appendChild(row);

        const kids = Array.isArray(it.children) ? it.children.filter(Boolean) : null;
        if (kids && kids.length) {
          row.classList.add('has-sub');
          const arrow = document.createElement('span');
          arrow.className = 'cm-arrow';
          arrow.textContent = '▸';
          row.appendChild(arrow);

          const sub = document.createElement('div');
          sub.className = 'context-menu cm-sub hidden';
          this._build(sub, kids);
          container.appendChild(sub);

          row.addEventListener('pointerenter', () => this._openSub(row, sub));
          row.addEventListener('click', () => this._openSub(row, sub));
          sub.addEventListener('pointerenter', () => clearTimeout(this._subTimer));
          sub.addEventListener('pointerleave', () => this._scheduleHide(sub));
          row.addEventListener('pointerleave', () => this._scheduleHide(sub));
          continue;
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
      }
    }

    /** 展开子菜单：先关掉同级其它子菜单，再按空间决定往右还是往左 */
    _openSub(row, sub) {
      clearTimeout(this._subTimer);
      const host = sub.parentElement;
      if (!host) return;
      host.querySelectorAll(':scope > .cm-sub').forEach((s) => {
        if (s !== sub) s.classList.add('hidden');
      });
      sub.classList.remove('hidden');
      const hostRect = host.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const sw = sub.offsetWidth;
      const sh = sub.offsetHeight;
      let left = rowRect.right - hostRect.left - 4;
      // 右边放不下就翻到父菜单左侧（贴外沿，避免盖住父菜单）
      if (rowRect.right + sw > window.innerWidth - 4) left = -sw - 2;
      let top = rowRect.top - hostRect.top - 5;
      top = Math.max(4, Math.min(top, window.innerHeight - sh - 6));
      sub.style.left = `${Math.round(left)}px`;
      sub.style.top = `${Math.round(top)}px`;
    }

    _scheduleHide(sub) {
      clearTimeout(this._subTimer);
      this._subTimer = setTimeout(() => sub.classList.add('hidden'), 260);
    }

    close() {
      if (!this.open) return;
      this.open = false;
      clearTimeout(this._subTimer);
      this.el.classList.add('hidden');
      this.el.querySelectorAll('.cm-sub').forEach((s) => s.classList.add('hidden'));
    }

    get isOpen() {
      return this.open;
    }
  }

  NS.ContextMenu = ContextMenu;
})(window);
