/* guide.js —— 使用说明（分级讲解）
 *
 * 分四档：上手 → 常用 → 进阶 → 疑难。每档若干条目，点标题展开。
 * 文案在 shared/locales/*.js 的 guide.levels 里（结构化数组，五语种同构），
 * 这里只负责排版与交互；切语言时若窗口开着会原地重绘。
 */
(function (global) {
  'use strict';
  const NS = global.XZ;
  const t = (k, p) => NS.I18N.t(k, p);

  class Guide {
    constructor(host) {
      this.host = host;
      this.mask = null;
      this.level = 0;
      this.openItems = new Set(); // '0-1' 形式的「级别-条目」键，重绘后保留展开状态
      this.version = '';
      this._off = null;
    }

    get isOpen() {
      return !!this.mask;
    }

    open(opts) {
      this.version = (opts && opts.version) || '';
      if (this.isOpen) {
        this.render();
        return;
      }
      // 每档第一条默认展开：先给点具体内容，别让人对着一排标题猜
      this.openItems = new Set(['0-0', '1-0', '2-0', '3-0']);
      this.mask = document.createElement('div');
      this.mask.className = 'modal-mask';
      this.mask.addEventListener('pointerdown', (e) => {
        if (e.target === this.mask) this.close();
      });
      this.host.appendChild(this.mask);
      // 语言在说明窗口开着时被切换：原地重绘，不闪一下关掉再打开
      this._off = NS.I18N.onChange(() => this.render());
      this.render();
    }

    close() {
      if (this._off) {
        this._off();
        this._off = null;
      }
      if (this.mask) this.mask.remove();
      this.mask = null;
    }

    render() {
      if (!this.mask) return;
      const levels = t('guide.levels') || [];
      if (!Array.isArray(levels) || !levels.length) return;
      if (this.level >= levels.length) this.level = 0;

      this.mask.innerHTML = '';
      const modal = document.createElement('div');
      modal.className = 'modal guide-modal';

      /* 标题栏 */
      const head = document.createElement('div');
      head.className = 'modal-head';
      head.appendChild(document.createTextNode(t('guide.title')));
      const x = document.createElement('span');
      x.className = 'sp-close guide-close';
      x.textContent = '✕';
      x.addEventListener('click', () => this.close());
      head.appendChild(x);
      modal.appendChild(head);

      /* 四档：标签式切换，一眼能看出「由浅入深」 */
      const chips = document.createElement('div');
      chips.className = 'gd-chips';
      levels.forEach((lv, i) => {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = `gd-chip${i === this.level ? ' active' : ''}`;
        c.textContent = lv.name;
        c.title = lv.sub || '';
        c.addEventListener('click', () => {
          this.level = i;
          this.render();
        });
        chips.appendChild(c);
      });
      modal.appendChild(chips);

      const body = document.createElement('div');
      body.className = 'modal-body guide-body';
      modal.appendChild(body);

      const lv = levels[this.level];
      const intro = document.createElement('div');
      intro.className = 'gd-sub';
      intro.textContent = lv.sub || '';
      body.appendChild(intro);

      (lv.items || []).forEach((it, j) => {
        const key = `${this.level}-${j}`;
        const open = this.openItems.has(key);
        const item = document.createElement('div');
        item.className = `gd-item${open ? ' open' : ''}`;

        const ih = document.createElement('div');
        ih.className = 'gd-head';
        const arrow = document.createElement('span');
        arrow.className = 'gd-arrow';
        arrow.textContent = '▸';
        const tt = document.createElement('span');
        tt.className = 'gd-title';
        tt.textContent = it.t;
        ih.appendChild(arrow);
        ih.appendChild(tt);
        ih.addEventListener('click', () => {
          const next = !item.classList.contains('open');
          item.classList.toggle('open', next);
          if (next) this.openItems.add(key);
          else this.openItems.delete(key);
        });
        item.appendChild(ih);

        const ib = document.createElement('div');
        ib.className = 'gd-body';
        // 正文里的空行分段：一段一个 <p>，比一整块大段落好读
        for (const para of String(it.b || '').split('\n')) {
          const p = document.createElement('p');
          p.textContent = para;
          if (para.trim()) ib.appendChild(p);
        }
        item.appendChild(ib);
        body.appendChild(item);
      });

      /* 底栏：版本 + 一句「数据只在本机」，比在正文里反复强调更自然 */
      const foot = document.createElement('div');
      foot.className = 'modal-foot guide-foot';
      const tip = document.createElement('div');
      tip.className = 'guide-privacy';
      tip.textContent = t('guide.privacy');
      foot.appendChild(tip);
      const ok = document.createElement('button');
      ok.className = 'btn primary';
      ok.textContent = t('guide.close');
      ok.addEventListener('click', () => this.close());
      foot.appendChild(ok);
      modal.appendChild(foot);

      if (this.version) {
        const ver = document.createElement('div');
        ver.className = 'guide-ver';
        ver.textContent = t('guide.version', { v: this.version });
        modal.appendChild(ver);
      }

      this.mask.appendChild(modal);
      body.scrollTop = 0;
    }
  }

  NS.Guide = Guide;
})(window);
