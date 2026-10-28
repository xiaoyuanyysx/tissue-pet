/* tear-controller.js —— E3 自动撕拽 + E4 撕纸/回溯状态机
   撕纸 = top += n（内容上移 n 张）；回溯 = top -= n（内容下移 n 张）
   回溯栈记录「逻辑 index + 内容锚点」，绝不复用被覆盖的 DOM。

   手势模型：
     向下拖 = 把纸从卷筒里拉出来 → 视口高 = 纸高 + shift，纸带随 shift 下移
              **拖动过程中一张都不撕**，拉多长都原样挂着（长度只受内容量限制）
     松手   = 唯一的结算点：先静默退役「整张滑出视口、完全看不见」的纸，
              可见的那部分够阈值才撕；不够阈值就停在原地 —— 不回弹。
              **撕纸一律静默（flushTear），纸带不滑动**：屏幕上其余内容的坐标一像素不变，
              只有最下面那几张连同视口底部一起消失。
     滚轮   = 满一张撕一张，零头留在 shift 上累积，同样不回弹 */
(function (global) {
  'use strict';
  const NS = global.XZ;

  class TearController {
    constructor({ engine, stack, hooks }) {
      this.engine = engine;
      this.stack = stack;
      this.hooks = hooks || {};
      this.mode = 'learn';
      this.dragging = false;
      this.pointerId = null;
      this.lastY = 0;
      this.autoRaf = 0;
      this.autoLast = 0;
      this.autoCfg = { enabled: false, pxPerSec: 20 };
      this.settings = { tearThresholdPages: 2 };
      this.bound = false;
      this._onMove = null;
      this._onUp = null;
      this._lastEmptyNotice = 0;
    }

    get provider() {
      return this.engine.getProvider();
    }

    get scale() {
      return this.engine.getScale ? this.engine.getScale() : 1;
    }

    setSettings(settings) {
      this.settings = {
        tearThresholdPages: NS.clamp(Number(settings.tearThresholdPages) || 2, 0.5, 6)
      };
      if (this.stack) this.stack.setCap(settings.maxBacktrack);
      this.setAutoTear(settings.autoTear || { enabled: false, pxPerSec: 20 });
    }

    adopt(mode, top, stackData) {
      this.mode = mode;
      this.stack.restore(stackData || []);
      const provider = this.provider;
      if (provider && provider.clearPins) provider.clearPins();
      this.engine.top = Math.max(0, top);
    }

    /* ---------------- 手势 ---------------- */

    attachPointerEvents(viewport) {
      if (this.bound) return;
      this.bound = true;

      viewport.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || this.engine.animating) return;
        this.dragging = true;
        this.pointerId = e.pointerId;
        this.lastY = e.clientY;
        viewport.classList.add('dragging');
        if (this.hooks.onDragState) this.hooks.onDragState(true);
      });

      this._onMove = (e) => {
        if (!this.dragging || this.engine.animating) return;
        // 只认按下的那根指针：鼠标 + 触控板/笔同时有事件时不会互相打断
        if (this.pointerId != null && e.pointerId != null && e.pointerId !== this.pointerId) return;
        // 屏幕像素 → 内容像素（舞台整体缩放过）
        const dy = (e.clientY - this.lastY) / this.scale;
        this.lastY = e.clientY;
        if (!dy) return;
        const engine = this.engine;
        if (dy < 0 && engine.shift <= 0) return;
        const next = engine.shift + dy;
        if (next > 0) {
          const rem = engine.remainingPapers();
          if (Number.isFinite(rem) && rem <= 0) {
            this._noticeEmpty();
            return;
          }
        }
        this.pullTo(next);
      };
      this._onUp = (e) => {
        if (e && this.pointerId != null && e.pointerId != null && e.pointerId !== this.pointerId) return;
        this.settle();
      };

      window.addEventListener('pointermove', this._onMove);
      window.addEventListener('pointerup', this._onUp);
      window.addEventListener('pointercancel', this._onUp);

      viewport.addEventListener(
        'wheel',
        (e) => {
          if (this.engine.animating) return;
          const engine = this.engine;
          const dy = e.deltaY / this.scale;
          if (!dy) return;
          e.preventDefault();
          if (dy < 0 && engine.shift <= 0) return;
          const H = engine.H;
          const cap = engine.maxShift();
          // 滚轮同样是「不回弹」：滚多少留在多少，累积够一整张才撕
          const cur = Math.min(engine.shift + dy, cap);
          if (cur <= 0) {
            engine.setShift(0);
            return;
          }
          const rem = engine.remainingPapers();
          if (cur >= H) {
            const n = Math.max(1, Math.min(Math.floor(cur / H), Number.isFinite(rem) ? rem : 8));
            engine.setShift(cur);
            // 与拖拽一致：静默撕，不做「纸带整体上滑」的过渡
            this.flushTear(n);
            return;
          }
          engine.setShift(cur);
          if (Number.isFinite(rem) && rem <= 0) this._noticeEmpty();
        },
        { passive: false }
      );
    }

    _noticeEmpty() {
      const now = Date.now();
      if (now - this._lastEmptyNotice < 1500) return;
      this._lastEmptyNotice = now;
      if (this.hooks.onNotice) this.hooks.onNotice('已经到末尾了');
    }

    /**
     * 松手才结算：拖动过程中一张都不撕，全部留到松手这一步。
     *
     * 三个分支都遵循同一条原则 —— **页面上的内容一像素都不动，只有底部在变**：
     * ① 整张滑出视口下边界的纸：静默退役（`top += n` 与 `位移 −= n×纸高` 同步）。
     * ② 剩下的位移在视口里且够阈值：同样静默撕掉，纸带不滑动，
     *    视口从底部收起那几张的高度 —— 观感就是「下面那张被扯走了」，上面的字不动。
     * ③ 不够阈值：停在原地，什么都不变。
     */
    settle() {
      if (!this.dragging) return;
      this.dragging = false;
      this.pointerId = null;
      this.engine.viewport.classList.remove('dragging');
      if (this.hooks.onDragState) this.hooks.onDragState(false);
      if (this.engine.animating) return;

      const engine = this.engine;
      const H = engine.H;
      // 只差不到半像素，归零让下一次从干净状态起步（肉眼不可见）
      if (engine.shift <= 0.5) {
        engine.setShift(0);
        if (this.hooks.onSettled) this.hooks.onSettled();
        return;
      }

      // ① 看不见的那部分：静默退役，位置一像素都不动
      this.retireOffscreen();

      // ② 看得见的那部分：够阈值才撕，不够就停在原地（不回弹）
      const p = engine.shift;
      const thr = this.thresholdPx();
      if (p < thr) {
        if (this.hooks.onSettled) this.hooks.onSettled();
        return;
      }
      // 阈值 = 触发撕纸所需的拉出量；超过阈值每多一张再多撕一张，但不会撕掉没拉满的整张
      let n = 1 + Math.floor(Math.max(0, p - thr) / H);
      n = Math.min(n, Math.max(1, Math.floor(p / H)));
      // ★ 用 flushTear 而不是 tear：不做「纸带整体上滑」的过渡动画。
      //   撕掉的几张连同视口底部一起消失，屏幕上其余内容的坐标完全不变。
      this.flushTear(n);
      if (this.hooks.onSettled) this.hooks.onSettled();
    }

    /** 触发撕纸所需的拉出量（px）。剩纸不足时按剩纸收敛，避免「最后一张永远撕不掉」 */
    thresholdPx() {
      const nominal = this.settings.tearThresholdPages * this.engine.H;
      const maxShift = this.engine.maxShift();
      if (!Number.isFinite(maxShift)) return nominal;
      return Math.min(nominal, Math.max(this.engine.H, maxShift));
    }

    /**
     * 把已经完全滑到视口下边界之外、用户看不见的那几张静默退役。
     * 判定：纸 `top` 占 `[位移, 位移 + 纸高]`，视口是 `[0, 视口高]`，
     * 所以 `位移 ≥ 视口高` 时它已经整张在视口下方。
     * 退役时两者同步平移一张纸高，可见内容零跳变。
     */
    retireOffscreen() {
      const engine = this.engine;
      const H = engine.H;
      let total = 0;
      let guard = 0;
      while (guard++ < 8) {
        const over = engine.shift - engine.viewportHeight;
        if (over < 0) break;
        const n = Math.max(1, Math.floor(over / H) + 1);
        const done = this.flushTear(n);
        if (done <= 0) break;
        total += done;
      }
      return total;
    }

    /* ---------------- 撕 / 回溯 ---------------- */

    /**
     * 把纸带位移推到 target。视口长到上限后 pull 停在 pullCap、多出来的记在 retract 上，
     * 于是纸带继续在视口里向下滚：最下面那张滑出视口，最上面不断有新纸卷出来。
     * 所以「能拉多长」只受内容量限制，跟窗口高度无关 —— 想拉多少拉多少。
     */
    pullTo(target) {
      const engine = this.engine;
      engine.setShift(target);
    }

    /**
     * 入栈 + 指针前移。
     * keepShift=true：位移维持不动（撕掉的都是已经滑出视口的纸，内容一像素不动），
     *                再由调用方 animate 到目标位移，做出「纸从下面被拉走」的过渡。
     */
    _commitTear(n, keepShift) {
      const engine = this.engine;
      const provider = this.provider;
      if (!provider) return 0;

      const rem = engine.remainingPapers();
      if (Number.isFinite(rem) && rem <= 0) {
        this._noticeEmpty();
        return 0;
      }
      let count = Math.max(1, Math.floor(n));
      if (Number.isFinite(rem)) count = Math.min(count, rem);
      if (count <= 0) return 0;

      const recs = [];
      for (let i = 0; i < count; i++) {
        const idx = engine.top + i;
        const anchor = provider.indexToAnchor ? provider.indexToAnchor(idx) : null;
        const rec = { logicalIndex: idx, tornAt: Date.now(), anchor };
        if (this.mode === 'checklist' && provider.snapshotAt) rec.snapshot = provider.snapshotAt(idx);
        const overflow = this.stack.push(rec);
        if (overflow && this.hooks.onOverflow) this.hooks.onOverflow(overflow);
        if (provider.clearPin) provider.clearPin(idx);
        recs.push(rec);
      }

      // 指针前移 count 张；位移保持不变时，页 ci+count 正好落在页 ci 原来的位置上
      const curShift = engine.shift;
      engine.setTop(engine.top + count, {
        shift: keepShift ? curShift : Math.max(0, curShift - count * engine.H)
      });
      if (this.hooks.onTear) this.hooks.onTear(recs);
      return count;
    }

    /** 无过渡地撕（掉出视口外的纸用它，用户看不见任何跳变） */
    flushTear(n = 1) {
      return this._commitTear(n, false);
    }

    /** 带过渡地撕：纸带连内容一起向上滑，视口从底部平滑收回 count 张 */
    tear(n = 1, targetShift) {
      const engine = this.engine;
      if (engine.animating) return 0;
      const baseShift = engine.shift;
      const count = this._commitTear(n, true);
      if (!count) return 0;
      const target = Number.isFinite(targetShift)
        ? Math.max(0, targetShift)
        : Math.max(0, baseShift - count * engine.H);
      engine.animate(target, 220, () => {
        if (this.hooks.onSettled) this.hooks.onSettled();
      });
      return count;
    }

    /**
     * 回溯 = 把纸卷回去：
     * 栈里有纸 → 指针回退 delta 张、位移补齐后整条纸带向上滑（内容与虚线一起滚）；
     * 栈里没纸但纸带还拉着（松手不回弹的常态）→ 就把拉出来的那段卷回 0。
     */
    backtrack(n = 1) {
      const engine = this.engine;
      const provider = this.provider;
      if (!provider || engine.animating) return false;

      const popped = [];
      const before = engine.top;
      let newTop = before;
      for (let i = 0; i < Math.max(1, Math.floor(n)); i++) {
        const rec = this.stack.pop();
        if (!rec) break;
        if (provider.setPin) provider.setPin(rec.logicalIndex, rec);
        newTop = Math.min(newTop, Math.max(0, rec.logicalIndex));
        popped.push(rec);
      }
      if (!popped.length) {
        // 没有撕下来的纸可以还，但纸带还拉着（松手不回弹之后很常见）：
        // 这时候「回溯」= 把拉出来的纸卷回去，别让按钮看起来是坏的。
        if (engine.shift > 0.5) {
          engine.animate(0, 280, () => {
            if (this.hooks.onSettled) this.hooks.onSettled();
          });
          return true;
        }
        if (this.hooks.onNotice) this.hooks.onNotice('没有可回溯的纸了');
        return false;
      }

      const delta = Math.max(1, before - newTop);
      // 起点补偿：先让内容保持在原位（位移 +delta 张），再整条纸带向上滑到 0。
      // 距离远（纸带已经滚了十几张）时适当拉长过渡，否则会是一道很快的残影。
      const from = engine.shift + delta * engine.H;
      engine.setTop(newTop, { shift: from });
      engine.animate(0, Math.min(560, Math.round(320 + from * 0.05)), () => {
        if (this.hooks.onSettled) this.hooks.onSettled();
      });
      if (this.hooks.onBacktrack) this.hooks.onBacktrack(popped);
      return true;
    }

    /* ---------------- E3 自动撕拽（连续下落） ---------------- */

    setAutoTear(cfg) {
      const enabled = !!(cfg && cfg.enabled);
      const pxPerSec = NS.clamp(Number(cfg && cfg.pxPerSec) || 20, 2, 200);
      this.autoCfg = { enabled, pxPerSec };
      this._stopAuto();
      if (!enabled) return;

      // 代际令牌：被 stop / 重设后，任何残留的旧循环都自行退出（防止双循环导致速度翻倍）
      this.autoGen = (this.autoGen || 0) + 1;
      const gen = this.autoGen;
      this.autoLast = 0;
      const loop = (now) => {
        if (gen !== this.autoGen) return;
        this.autoRaf = requestAnimationFrame(loop);
        if (document.hidden) {
          this.autoLast = 0;
          return;
        }
        if (!this.autoLast) {
          this.autoLast = now;
          return;
        }
        // 上限取 40ms（约 25fps）：窗口被节流时不会因为一次巨大 dt 突然跳好几张
        const dt = Math.min(40, now - this.autoLast) / 1000;
        this.autoLast = now;
        if (this.dragging || this.engine.animating) return;
        if (!this.provider) return;

        const engine = this.engine;
        const rem = engine.remainingPapers();
        if (Number.isFinite(rem) && rem <= 0) {
          this.setAutoTear({ enabled: false, pxPerSec });
          if (this.hooks.onAutoTearStop) this.hooks.onAutoTearStop();
          return;
        }

        const H = engine.H;
        const next = engine.shift + this.autoCfg.pxPerSec * dt;
        if (next > engine.pullCap + H) {
          // 视口已满：继续往下 = 纸带在视口里滚动。多滑出一张就静默退役一张
          // （位移同步减一张，位置完全不变，所以看不见任何跳变）。
          engine.setShift(next);
          this.flushTear(1);
        } else if (next >= H && engine.shift < engine.pullCap) {
          engine.setShift(H);
          this.tear(1);
        } else {
          engine.setShift(next);
        }
      };
      this.autoRaf = requestAnimationFrame(loop);
    }

    _stopAuto() {
      this.autoGen = (this.autoGen || 0) + 1;
      if (this.autoRaf) {
        cancelAnimationFrame(this.autoRaf);
        this.autoRaf = 0;
      }
      this.autoLast = 0;
    }

    toggleAutoTear() {
      const next = !this.autoCfg.enabled;
      this.setAutoTear({ enabled: next, pxPerSec: this.autoCfg.pxPerSec });
      return next;
    }

    dispose() {
      this._stopAuto();
      if (this._onMove) window.removeEventListener('pointermove', this._onMove);
      if (this._onUp) {
        window.removeEventListener('pointerup', this._onUp);
        window.removeEventListener('pointercancel', this._onUp);
      }
    }
  }

  NS.TearController = TearController;
})(window);
