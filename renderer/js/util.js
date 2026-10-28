/* util.js —— 全局命名空间 XZ + 通用工具 */
(function (global) {
  'use strict';
  const NS = global.XZ || (global.XZ = {});

  NS.MODES = ['learn', 'leisure', 'checklist'];
  NS.MODE_LABEL = { learn: '学习', leisure: '休闲', checklist: '清单' };
  NS.VIEWPORT_TOP = 210;
  NS.BOTTOM_PADDING = 20;
  // 卷筒轴线（SVG 里 165..335 的中线），纸带始终以它为中心
  NS.ROLL_AXIS_X = 250;
  // 纸带整体相对轴线向左的微调：卷筒右下沿是一段向内收的弧线（335,180 → 300,230），
  // 纸若正好 165..335 会把右上角露在弧线外侧，看起来"纸比卷筒宽"。左移几像素即可塞进轮廓里。
  NS.PAGE_OFFSET_X = -6;

  NS.clamp = function (v, lo, hi) {
    if (hi < lo) return lo;
    return Math.min(hi, Math.max(lo, v));
  };

  NS.uid = function (prefix) {
    return `${prefix || 'id'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  };

  NS.escape = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  NS.truncate = function (s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? `${t.slice(0, n)}...` : t;
  };

  /** 统一解包 IpcResult；失败抛出带 code 的 Error（message 已是中文可读文案） */
  NS.call = async function (promise) {
    let res;
    try {
      res = await promise;
    } catch (err) {
      const e = new Error('与主进程通信失败，请重启应用');
      e.code = 'E_IPC';
      throw e;
    }
    if (!res || res.ok !== true) {
      const info = (res && res.error) || {};
      const e = new Error(info.message || '操作失败，请稍后再试');
      e.code = info.code || 'E_UNKNOWN';
      e.detail = info.detail;
      throw e;
    }
    return res.data;
  };

  NS.errorText = function (err) {
    if (!err) return '操作失败';
    return err.message || String(err);
  };

  /* ---------------- 字体测量（离屏 canvas，确定性） ---------------- */
  let measureCtx = null;
  NS.measureCtx = function () {
    if (!measureCtx) {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      measureCtx = canvas.getContext('2d');
    }
    return measureCtx;
  };

  const FONT_STACK = `-apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`;

  NS.measureText = function (text, fontPx, weight) {
    const ctx = NS.measureCtx();
    ctx.font = `${weight || 400} ${fontPx}px ${FONT_STACK}`;
    return ctx.measureText(String(text)).width;
  };

  /** 单词自适应字号：先按纸高定上限，再按纸宽伸缩（B2：既缩小也放大占满） */
  NS.fitWordFont = function (word, maxWidth, maxFont, minFont) {
    const text = String(word || '');
    if (!text) return maxFont;
    const hi = Math.max(minFont, maxFont);
    const lo = Math.max(8, minFont);
    let best = lo;
    // 二分：找不超过 maxWidth 的最大字号
    let a = lo;
    let b = hi;
    for (let i = 0; i < 18 && b - a > 0.35; i++) {
      const mid = (a + b) / 2;
      if (NS.measureText(text, mid, 800) <= maxWidth) {
        best = mid;
        a = mid;
      } else {
        b = mid;
      }
    }
    // 过窄则放大占满（上限 maxFont 已由二分保证）
    return Math.max(lo, Math.floor(best * 10) / 10);
  };

  NS.debounce = function (fn, wait) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, wait);
    };
  };

  NS.rafThrottle = function (fn) {
    let pending = false;
    let lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        fn.apply(this, lastArgs);
      });
    };
  };
})(window);
