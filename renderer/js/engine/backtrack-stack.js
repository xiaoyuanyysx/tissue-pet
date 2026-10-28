/* backtrack-stack.js —— E4 回溯栈（逻辑纸 index + 内容锚点，绝不存 DOM 引用） */
(function (global) {
  'use strict';
  const NS = global.XZ;

  const HARD_CAP = 50;

  class BacktrackStack {
    constructor(cap) {
      this.cap = NS.clamp(Number(cap) || 10, 1, HARD_CAP);
      this.items = [];
    }

    static get HARD_CAP() {
      return HARD_CAP;
    }

    setCap(cap) {
      this.cap = NS.clamp(Number(cap) || 10, 1, HARD_CAP);
      while (this.items.length > this.cap) this.items.shift();
    }

    get size() {
      return this.items.length;
    }

    /** 溢出时淘汰最早记录并返回事件（验收 5：给出提示） */
    push(rec) {
      this.items.push(rec);
      if (this.items.length > this.cap) {
        const evicted = this.items.shift();
        return { evicted, cap: this.cap };
      }
      return null;
    }

    pop() {
      return this.items.length ? this.items.pop() : null;
    }

    peek() {
      return this.items.length ? this.items[this.items.length - 1] : null;
    }

    peekAll() {
      return this.items.slice();
    }

    clear() {
      this.items.length = 0;
    }

    serialize() {
      return { stack: this.items.slice() };
    }

    restore(stack) {
      this.items = Array.isArray(stack) ? stack.slice(-this.cap) : [];
    }
  }

  NS.BacktrackStack = BacktrackStack;
})(window);
