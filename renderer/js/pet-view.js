/* pet-view.js —— 卷纸造型层封装（结构禁区：只做参数化，绝不增删改 SVG 节点） */
(function (global) {
  'use strict';
  const NS = global.XZ;

  class PetView {
    constructor(doc) {
      this.stage = doc.getElementById('stage');
      this.deskPet = doc.getElementById('deskPet');
      this.pattern = doc.getElementById('dash-pattern');
      this.dashRect = doc.getElementById('roll-dash-rect');
      this.reflectionGroup = doc.getElementById('reflection-group');
      this.reflectionText = doc.getElementById('reflection-text');
      this.lastKey = '';
      this.lastPatternOff = -1;
      this.lastDepth = -1;
      this.scale = 1;
    }

    /** 同步虚线 pattern 尺寸（纸宽/纸高变化时调用） */
    setPaperSize(w, h) {
      if (!this.pattern) return;
      if (this.pattern.getAttribute('width') === String(w) && this.pattern.getAttribute('height') === String(h)) {
        return;
      }
      this.pattern.setAttribute('width', String(w));
      this.pattern.setAttribute('height', String(h));
    }

    /** 卷筒倒影文字（只改文本与字号，不动结构） */
    setReflection(text, style = {}) {
      if (!this.reflectionText) return;
      const key = `${text}|${style.fontSize || 16}|${style.bold ? 1 : 0}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.reflectionText.textContent = text || '';
        this.reflectionText.setAttribute('font-size', String(style.fontSize || 16));
        this.reflectionText.setAttribute('font-weight', style.bold ? '800' : 'normal');
      }
    }

    /** 倒影随纸带位移（视觉细节，保留原有行为） */
    setReflectionDepth(rem, pageHeight) {
      if (!this.reflectionText || !this.reflectionGroup) return;
      const ratio = NS.clamp(rem / pageHeight, 0, 1);
      // 每帧都写 SVG 属性会重绘整个卷筒，量化后再写
      const q = Math.round(ratio * 200) / 200;
      if (q === this.lastDepth) return;
      this.lastDepth = q;
      const y = 180 - q * 80;
      this.reflectionText.setAttribute('y', String(y));
      this.reflectionGroup.setAttribute('opacity', String(Math.max(0.05, 0.15 - q * 0.05)));
    }

    /** 虚线 pattern 与纸带边界对齐（ty 为纸带整体位移） */
    syncPatternOffset(ty, pageHeight) {
      if (!this.pattern) return;
      const H = pageHeight || 200;
      const off = Math.round((((ty % H) + H) % H) * 2) / 2;
      if (off === this.lastPatternOff) return;
      this.lastPatternOff = off;
      this.pattern.setAttribute('patternTransform', `translate(0, ${-off})`);
    }

    setScale(s) {
      this.scale = NS.clamp(s, 0.5, 2);
      if (this.stage) this.stage.style.transform = `scale(${this.scale})`;
    }

    setTheme(dark) {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    }
  }

  NS.PetView = PetView;
})(window);
