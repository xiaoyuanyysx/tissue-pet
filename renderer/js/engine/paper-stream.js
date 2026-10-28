/* paper-stream.js —— 纸带虚拟化引擎（0.3 重构为「逻辑纸」模型）
   不变式：
     I1 内容由 provider.getPaper(index) 纯函数提供
     I2 DOM 节点只是 index 的缓存，可随时丢弃重建
     I3 headIndex（本引擎的 top）只由 TearController 修改
   视觉：内容 y = shift - (index - top) * 纸高，其中 shift = pull − retract
        视口高 = min(窗口能给的高度, 纸高 + pull)
   ★ shift 才是拉纸的「真实手势量」：视口长到上限后 pull 停在 pullCap，
     多出来的位移记在 retract 上，纸带于是继续在视口里向下滚 —— 可以无限拉。
*/
(function (global) {
  'use strict';
  const NS = global.XZ;

  class PaperStreamEngine {
    constructor({ viewport, stream, petView }) {
      this.viewport = viewport;
      this.stream = stream;
      this.petView = petView;
      this.provider = null;
      this.layout = {
        paperWidthPx: 170,
        paperHeightPx: 200,
        fontSizePx: 15,
        darkMode: false
      };
      this.top = 0;
      // 纸带整体位移（= pull − retract）。视口长到上限后它继续增长、由 retract 承担，
      // 于是可以无限往下拉：纸带一直向下滚，最下面那张滑出视口后静默退役。
      this.shift = 0;
      this.nodes = new Map(); // ci -> element
      this.firstSlot = 0;
      this.lastSlot = -1;
      this._raf = 0;
      this.animating = false;
      this.lastRangeKey = '';
      this.listeners = new Map();
      // 视口最多能长多高（由窗口高度决定），超出部分不做「纸变长」而是滚动
      this.viewportCap = 600;
      this._cssKey = '';
      this._vh = -1;
      this._curCi = -1;
    }

    get H() {
      return this.layout.paperHeightPx;
    }

    get paperCount() {
      return this.provider ? this.provider.paperCount : 0;
    }

    /** 当前视口高度（CSS 逻辑像素，未乘缩放） */
    get viewportHeight() {
      return this._vh > 0 ? this._vh : this.H;
    }

    /**
     * 视口真正「长高」的那部分，上限 pullCap（= 窗口能给的高度 − 一张纸）。
     * 超过之后 pull 不再增长，多出来的位移记在 retract 上 —— 视口就那么高，
     * 纸带继续在视口里往下滚。
     */
    get pull() {
      return Math.min(this.shift, this.pullCap);
    }

    /** 反向补偿量：shift 超过视口上限后由它承担，保证 shift = pull − retract */
    get retract() {
      return this.pull - this.shift;
    }

    on(ev, cb) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev).add(cb);
      return () => this.listeners.get(ev).delete(cb);
    }

    _emit(ev, payload) {
      const set = this.listeners.get(ev);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(payload);
        } catch (err) {
          console.error('[engine] 监听器异常', err);
        }
      }
    }

    /* ---------------- provider / layout ---------------- */

    setProvider(provider, opts = {}) {
      this.provider = provider;
      const top = Number.isFinite(opts.top) ? Math.max(0, opts.top) : 0;
      this.top = this._clampTop(top);
      this.shift = 0;
      if (provider && provider.relayout) provider.relayout(this.layout);
      this.rebuild();
      this._emit('providerChanged', provider);
    }

    getProvider() {
      return this.provider;
    }

    setLayout(partial) {
      const prevAnchor =
        this.provider && this.provider.indexToAnchor ? this.provider.indexToAnchor(this.top) : null;
      this.layout = Object.assign({}, this.layout, partial || {});
      if (this.provider && this.provider.relayout) this.provider.relayout(this.layout);
      // 验收 3：布局变化后按锚点重定位，字与纸的对应关系保持不变
      if (prevAnchor && this.provider && this.provider.anchorToIndex) {
        const idx = this.provider.anchorToIndex(prevAnchor);
        if (idx != null && Number.isFinite(idx)) this.top = this._clampTop(idx);
      } else {
        this.top = this._clampTop(this.top);
      }
      this.applyCss();
      this.rebuild();
      this._emit('layoutChanged', this.layout);
    }

    getLayout() {
      return this.layout;
    }

    _clampTop(top) {
      const count = this.paperCount;
      if (Number.isFinite(count) && count > 0) return NS.clamp(top, 0, count - 1);
      return Math.max(0, top);
    }

    /**
     * I3：唯一修改指针的入口（由 TearController 调用）。
     * opts.shift 指定「纸带整体位移」——撕纸/回溯时把当前位置原样传进来，
     * 内容一像素都不动；不传则保持当前位移（就地刷新内容）。
     * 需要彻底回到静止态的场景（切模式、切清单）显式传 { shift: 0 }。
     */
    setTop(nextTop, opts = {}) {
      const before = this.top;
      this.top = this._clampTop(nextTop);
      this.shift = Math.max(0, Number.isFinite(opts.shift) ? opts.shift : this.shift);
      this.applyCss();
      this.rebuild();
      return this.top !== before;
    }

    /** 还能撕掉多少张（有限内容源当前顶纸之外还有多少页） */
    remainingPapers() {
      const count = this.paperCount;
      if (!Number.isFinite(count)) return Infinity;
      return Math.max(0, count - 1 - this.top);
    }

    /** 视口高度上限变化（窗口尺寸 / 缩放变化时由 app 推送） */
    setViewportCap(cap) {
      const v = Math.max(this.H, Math.round(Number(cap) || this.H));
      if (v === this.viewportCap) return;
      this.viewportCap = v;
      if (this.shift > this.maxShift()) this.shift = this.maxShift();
      this.applyCss();
      this.renderRange();
      this.updateTransform();
    }

    /**
     * 「视口刚好填满」的位移。超过它，视口不再变高，纸带开始向下滚动
     * （pull 固定在 pullCap，多出来的位移记在 retract 上）。
     */
    get pullCap() {
      return Math.max(0, this.viewportCap - this.H);
    }

    /**
     * 纸带位移上限。只受内容量限制，**不受视口高度限制**——
     * 视口放不下就滚动，所以内容无限时位移也无限。
     */
    maxShift() {
      const rem = this.remainingPapers();
      if (!Number.isFinite(rem)) return Infinity;
      return Math.max(0, rem * this.H);
    }

    /** 兼容旧名 */
    maxPull() {
      return this.maxShift();
    }

    /** 把纸带整体位移设为 s（可超过视口高度：超出的部分会自动转成滚动） */
    setShift(s) {
      if (this.animating) return;
      this.shift = NS.clamp(Number(s) || 0, 0, this.maxShift());
      this.applyCss();
      this.renderRange();
      this.updateTransform();
    }

    setPull(p) {
      this.setShift(p);
    }

    /* ---------------- 视觉 ---------------- */

    applyCss() {
      const H = this.H;
      const W = this.layout.paperWidthPx;
      // ★ 只在真正变化时写 CSS 变量：documentElement 上的自定义属性会触发全文档重算，
      //   每帧写一次正是「拖动卡顿」的主因。
      const key = `${W}|${H}`;
      if (key !== this._cssKey) {
        this._cssKey = key;
        document.documentElement.style.setProperty('--page-height', `${H}px`);
        document.documentElement.style.setProperty('--page-width', `${W}px`);
        // 纸带以卷筒轴线为中心，再整体左移几像素（见 NS.PAGE_OFFSET_X）
        const left = NS.ROLL_AXIS_X - W / 2 + (NS.PAGE_OFFSET_X || 0);
        document.documentElement.style.setProperty('--page-left', `${left}px`);
        if (this.petView) this.petView.setPaperSize(W, H);
      }
      const vh = Math.round(Math.min(this.viewportCap, Math.max(H, H + this.pull)));
      if (vh !== this._vh) {
        this._vh = vh;
        if (this.viewport) this.viewport.style.height = `${vh}px`;
      }
      this._emit('geometry', {
        pull: this.pull,
        retract: this.retract,
        shift: this.shift,
        height: H,
        viewportHeight: vh
      });
    }

    /** 视口当前需要的逻辑高度（内容坐标，未乘缩放） */
    requiredLogicalHeight(topOffset, bottomPadding) {
      return Math.round((topOffset || 0) + this.H + this.pull + (bottomPadding || 0));
    }

    /** 缩放值（拉出的像素需要按缩放折算成屏幕像素） */
    getScale() {
      return this.petView && this.petView.scale ? this.petView.scale : 1;
    }

    /**
     * 可见逻辑纸区间。
     * 视觉公式：y(ci) = shift - (ci - top) * 纸高
     * 即 index 越大越靠上：新纸从卷筒下方进入，旧纸被推向下、最后从底部撕掉
     * （与参考实现一致：最先出来的那张在最后面，也最先被撕）。
     */
    readIndex() {
      const H = this.H;
      return this._clampTop(this.top + Math.floor(this.shift / H));
    }

    _ciRange() {
      const H = this.H;
      const shift = this.shift;
      const vh = this._vh > 0 ? this._vh : H;
      const count = this.paperCount;
      const maxCi = Number.isFinite(count) && count > 0 ? count - 1 : Infinity;
      // 可见判据：纸的纵向区间 [shift-(ci-top+1)H+H, shift-(ci-top)H] 与 [0, vh] 相交
      let first = Math.max(0, Math.floor(this.top + (shift - vh) / H));
      let last = Math.ceil(this.top + (shift + H) / H);
      // 内容有限时两头都收在有效区间内（滚动过头 / 撕纸动画中途都不会取到界外页）
      if (first > maxCi) first = Math.max(0, maxCi);
      if (last > maxCi) last = maxCi;
      return [first, Math.max(first, last)];
    }

    rebuild() {
      for (const [, node] of this.nodes) node.remove();
      this.nodes.clear();
      this.lastRangeKey = '';
      this._curCi = -1;
      this.applyCss();
      this.renderRange(true);
      this.updateTransform();
    }

    _createNode(ci) {
      const el = document.createElement('div');
      el.className = 'page-item';
      const paper = this.provider ? this.provider.getPaper(ci) : null;
      el._ci = ci;
      el._paper = paper;
      el.dataset.ci = String(ci);
      // 每张纸的纵向位置只跟 (top, ci) 有关，撕纸/回溯时整体重建，因此一次定位即可
      el.style.transform = `translate3d(0, ${(this.top - ci) * this.H}px, 0)`;
      try {
        if (this.provider) this.provider.render(el, paper, this.layout);
        else el.innerHTML = '<div class="empty-page">—</div>';
      } catch (err) {
        console.error('[engine] 渲染失败', err);
        el.innerHTML = '<div class="empty-page">内容渲染失败</div>';
      }
      if (ci === this._curCi) el.classList.add('is-current');
      return el;
    }

    renderRange(force) {
      if (!this.provider) return;
      const [first, last] = this._ciRange();
      const key = `${first}:${last}:${this.top}`;
      if (!force && key === this.lastRangeKey) return;
      this.lastRangeKey = key;
      this.firstSlot = first;
      this.lastSlot = last;

      for (const [ci, node] of [...this.nodes]) {
        if (ci < first || ci > last) {
          node.remove();
          this.nodes.delete(ci);
        }
      }
      for (let ci = first; ci <= last; ci++) {
        if (!this.nodes.has(ci)) this.nodes.set(ci, this._createNode(ci));
      }
      const frag = document.createDocumentFragment();
      for (let ci = first; ci <= last; ci++) frag.appendChild(this.nodes.get(ci));
      this.stream.appendChild(frag);
    }

    updateTransform() {
      // 纸带整体随位移下移；单张纸的绝对位置由节点自身的 transform 决定
      const shift = this.shift;
      this.stream.style.transform = `translateY(${shift}px)`;
      if (this.petView) {
        this.petView.syncPatternOffset(shift, this.H);
        this._updateReflection();
      }
      this._syncCurrent();
    }

    /** 只有「卷筒正下方那张」带 .is-current（页面上的操作按钮只在它上面显示） */
    _syncCurrent() {
      const ci = this.readIndex();
      if (ci === this._curCi) return;
      this._curCi = ci;
      for (const [key, node] of this.nodes) node.classList.toggle('is-current', key === ci);
    }

    _updateReflection() {
      const paper = this.contentAt(this.readIndex());
      if (!paper) {
        this.petView.setReflection('', { fontSize: 16 });
        return;
      }
      if (paper.kind === 'word') {
        this.petView.setReflection(paper.word || '', { fontSize: 45, bold: true });
      } else if (paper.kind === 'text') {
        const first = (paper.lines && paper.lines[0] && paper.lines[0].text) || '';
        this.petView.setReflection(NS.truncate(first, 8), { fontSize: 16, bold: false });
      } else {
        this.petView.setReflection(NS.truncate(paper.listName || '清单', 8), { fontSize: 16, bold: false });
      }
      this.petView.setReflectionDepth(this.shift % this.H, this.H);
    }

    /* ---------------- 查询 ---------------- */

    contentAt(index) {
      if (!this.provider) return null;
      try {
        return this.provider.getPaper(index);
      } catch (err) {
        console.error('[engine] getPaper 异常', err);
        return null;
      }
    }

    /** 卷筒下方正在看的那张纸（静止时等于 top） */
    topPaper() {
      return this.contentAt(this.readIndex());
    }

    hitTest(target) {
      if (!target || !target.closest) return null;
      const el = target.closest('.page-item');
      if (!el) return null;
      return { el, ci: el._ci, paper: el._paper };
    }

    /** 重渲染当前窗口（标星/勾选/样式变化后调用） */
    refresh() {
      this.rebuild();
    }

    /** 只刷新某个逻辑 index 的节点（若可见） */
    refreshIndex(index) {
      for (const [, node] of this.nodes) {
        if (node._ci === index) {
          const paper = this.provider ? this.provider.getPaper(index) : null;
          node._paper = paper;
          this.provider.render(node, paper, this.layout);
        }
      }
    }

    /* ---------------- 动画 ---------------- */

    /**
     * 平滑把纸带位移过渡到 targetShift（px，可超过视口高度）。
     * 视口高度每一帧由 applyCss 从位移反推，所以「收回到只剩一张」和
     * 「滚动到第 N 张」是同一套插值，不会出现尺寸与位置不同步的跳变。
     */
    animate(targetShift, duration, onDone) {
      if (this._raf) cancelAnimationFrame(this._raf);
      const start = this.shift;
      const target = Math.max(0, Number.isFinite(targetShift) ? targetShift : 0);
      const t0 = performance.now();
      const dur = Math.max(1, duration || 220);
      this.animating = true;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        this.shift = start + (target - start) * e;
        this.applyCss();
        this.renderRange(k >= 1);
        this.updateTransform();
        if (k < 1) {
          this._raf = requestAnimationFrame(step);
        } else {
          this._raf = 0;
          this.animating = false;
          this.shift = target;
          this.applyCss();
          this.renderRange(true);
          this.updateTransform();
          if (onDone) onDone();
        }
      };
      this._raf = requestAnimationFrame(step);
    }

    stopAnimation() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      this.animating = false;
    }
  }

  NS.PaperStreamEngine = PaperStreamEngine;
})(window);
