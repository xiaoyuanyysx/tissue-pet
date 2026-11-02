/* editor.js —— 独立编辑窗口：像 doc 一样给清单条目排版
   窗口只有两块：上面一条工具带，下面一整块能直接打字的纸（窗口本身就是那张纸）。
     · 工具栏改的是**选中文字**的样式（字号 / 颜色 / 加粗 / 斜体 / 下划线 / 删除线）；
     · 保存只回传 HTML，由主窗口净化后写进清单，编辑器不直接碰磁盘；
     · 不在窗口里做「纸张预览 / 字数统计」：这两样都要跑一遍断行，窗口一小就只剩数字，
       不如把地方全留给正文（纸面按行分页不裁字，是清单 provider 保证的，不靠这里数）。

   工具栏只留「真的会在纸面上生效」的项：
     · 不加「撤销 / 重做」：只能走 document.execCommand('undo')，它管不到我们手动包 span 的
       换色/换字号，点下去会先撤掉刚打的字而颜色留着，反而把内容弄乱；要撤回改动直接「取消」。
     · 不加「清除格式」：擦不掉外层 <b>/<u> 继承下来的样式（insertText 会沿用光标处的格式），
       单个维度的还原已经有「字号：跟随正文」「字体颜色：自动」「突出显示：无颜色」。 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const paper = $('edPaper');
  const btnSave = $('btnSave');
  const toastEl = $('edToast');
  const sizeSel = $('edSize');
  // 颜色：仿 Office —— 工具带上平时只有两个图标 + 下拉箭头，点开才弹色板
  const btnFg = $('btnFg');
  const btnHl = $('btnHl');
  const popFg = $('popFg');
  const popHl = $('popHl');
  const fgBar = $('fgBar');
  const hlBar = $('hlBar');

  let payload = { listId: '', itemId: '', listName: '清单', html: '', darkMode: false };
  let baseFontSize = 15;
  let dirty = false;
  let saving = false;
  let allowClose = false;

  /* ---------------- 载入 ---------------- */

  function fill(p) {
    if (!p) return;
    payload = Object.assign(payload, p);
    const pp = payload.paper || {};
    // 正文字号跟随纸面设置，这样「相对其他字大一号」在纸上也是大一号
    baseFontSize = Math.max(9, Number(pp.fontSize) || 15);
    paper.style.fontSize = `${baseFontSize}px`;
    paper.innerHTML = payload.html || '';
    applyTheme(!!payload.darkMode);
    setDirty(false);
    saving = false;
    allowClose = false;
    placeCaretEnd();
  }

  /** 纸色跟随主程序主题：黑夜模式 → 黑纸浅字（色值全在 editor.css 的 --ed-paper 里） */
  function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    payload.darkMode = !!dark;
  }

  function placeCaretEnd() {
    try {
      paper.focus();
      const r = document.createRange();
      r.selectNodeContents(paper);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch {
      /* ignore */
    }
  }

  /* ---------------- 状态 / 提示 ---------------- */

  /** 有未保存改动时，保存按钮右上角亮一个小点（不占布局） */
  function setDirty(v) {
    dirty = !!v;
    btnSave.classList.toggle('dirty', dirty);
    btnSave.title = dirty ? '有未保存的改动，点这里保存 (Ctrl+S)' : '保存 (Ctrl+S)';
  }

  function markDirty() {
    setDirty(true);
  }

  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1600);
  }

  /* ---------------- 选择区样式 ---------------- */

  /**
   * 记一份「最后一次有效选区」。
   * 点色板里的十六进制输入框时焦点会离开纸面、选区被清空，
   * 再回来应用颜色就找不到要改的文字了 —— 所以先把 range 存下来。
   */
  let savedRange = null;

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (!r.collapsed && paper.contains(r.startContainer)) savedRange = r.cloneRange();
  });

  /** 选区不在纸面上了（点了输入框 / 切了焦点）就把存下来的还回去 */
  function ensureSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (!r.collapsed && paper.contains(r.startContainer)) return sel;
    }
    if (savedRange) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    return window.getSelection();
  }

  /** 用 span 包住选区（比 execCommand 的 fontSize 可靠，输出也只有 span + 内联样式） */
  function wrapSelection(styleText) {
    const sel = ensureSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    const span = document.createElement('span');
    span.setAttribute('style', styleText);
    try {
      range.surroundContents(span);
    } catch {
      // 选区跨了多个节点：抽出内容整体塞进 span 再插回
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.addRange(r);
    return true;
  }

  function warnNeedSelection() {
    toast('先选中要改样式的文字，再点');
  }

  function exec(cmd, val) {
    paper.focus();
    try {
      document.execCommand('styleWithCSS', false, false);
      document.execCommand(cmd, false, val == null ? null : val);
    } catch {
      /* ignore */
    }
    markDirty();
  }

  /* ---------------- 工具栏 ---------------- */

  for (const btn of document.querySelectorAll('.ed-tool[data-cmd]')) {
    // 按下时不抢焦点，否则选区会消失
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => exec(btn.dataset.cmd));
  }

  sizeSel.addEventListener('mousedown', (e) => e.stopPropagation());
  sizeSel.addEventListener('change', () => {
    const px = Number(sizeSel.value);
    if (!px) {
      // 「跟随正文」= 去掉选中文字的 font-size
      const ok = unwrapStyle(['font-size']);
      if (!ok) warnNeedSelection();
      else markDirty();
      sizeSel.value = '';
      return;
    }
    if (!styleSelection('font-size', `font-size:${px}px`)) {
      warnNeedSelection();
      return;
    }
    markDirty();
    sizeSel.value = '';
  });

  /** 去掉选区内联样式（只去指定属性，其它样式保留） */
  function unwrapStyle(props) {
    const sel = ensureSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return false;
    const nodes = [];
    const root = range.commonAncestorContainer;
    const scope = root.nodeType === 1 ? root : root.parentElement;
    if (!scope) return false;
    for (const el of scope.querySelectorAll('span[style],font')) {
      if (!range.intersectsNode(el)) continue;
      nodes.push(el);
    }
    for (const el of nodes) {
      if (el.tagName === 'FONT') {
        const t = document.createTextNode(el.textContent || '');
        el.replaceWith(t);
        continue;
      }
      for (const prop of props) el.style.removeProperty(prop);
      // 属性剥干净后**不删这个空 span**：删节点会让选区边界失效，
      // 紧跟着 wrapSelection 就找不到要包的文字了。空 span 没有样式，不影响观感，
      // 真正落盘前会由 cleanedHtml() 抖掉，主窗口还会再走一遍 NS.Rich.sanitize。
    }
    markDirty();
    return true;
  }

  /* ---------------- 颜色（仿 Office：点开才出色板） ---------------- */

  // 8 列 × 3 行：第一行深、第二行标准、第三行浅（Office 主题色的排法）
  const FG_COLORS = [
    ['#3b3b3b', '#1f3864', '#1f4e79', '#833c00', '#7f6000', '#375623', '#7f0000', '#3f1f5c'],
    ['#767171', '#2f5597', '#2e75b6', '#c55a11', '#bf9000', '#548235', '#c00000', '#7030a0'],
    ['#bfbfbf', '#8faadc', '#bdd7ee', '#f8cbad', '#ffe699', '#c6e0b4', '#ff9999', '#d8b4fe']
  ];

  // 突出显示：Office 的荧光笔色板（落盘时统一转成半透明，黑纸上也压得住）
  const HL_COLORS = [
    ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000', '#000080', '#008080'],
    ['#ffe066', '#a9e34b', '#99e9f2', '#faa2c1', '#a5d8ff', '#ffa8a8', '#c0c0ff', '#96f2d7']
  ];

  /**
   * 高亮一律用**半透明**底色：黑纸上用不透明浅黄会把浅色文字吃掉，
   * 而 alpha 叠在纸色上，白纸/黑纸都能看清字。
   */
  function hexToRgba(hex, alpha) {
    const s = String(hex || '').replace('#', '').trim();
    const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    const n = parseInt(full, 16);
    const a = Number.isFinite(alpha) ? alpha : 0.42;
    if (!/^[0-9a-f]{6}$/i.test(full) || !Number.isFinite(n)) return `rgba(250, 204, 21, ${a})`;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  /** 输入框里的 3/6 位十六进制 → #rrggbb（非法返回空） */
  function normalizeHex(v) {
    const s = String(v || '')
      .trim()
      .replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) return `#${s.split('').map((c) => c + c).join('')}`.toLowerCase();
    if (/^[0-9a-f]{6}$/i.test(s)) return `#${s}`.toLowerCase();
    return '';
  }

  /**
   * 给选区套一段样式：先把**同名属性**从选中的 span 上剥掉，再统一包一层。
   * 不剥的话会出现 `外层 #2f5597 套内层 #c00000`，内层优先，看起来像「没换成功」。
   */
  function styleSelection(prop, styleText) {
    const sel = ensureSelection();
    if (!sel || !sel.rangeCount || sel.getRangeAt(0).collapsed) return false;
    unwrapStyle([prop]);
    return wrapSelection(styleText);
  }

  function applyFg(hex) {
    if (!styleSelection('color', `color:${hex}`)) {
      warnNeedSelection();
      return false;
    }
    fgBar.style.background = hex;
    markDirty();
    return true;
  }

  function applyHighlight(hex) {
    if (!styleSelection('background-color', `background-color:${hexToRgba(hex)}`)) {
      warnNeedSelection();
      return false;
    }
    hlBar.style.background = hexToRgba(hex, 0.62);
    markDirty();
    return true;
  }

  function buildGrid(gridEl, colors, onPick, translucent) {
    gridEl.innerHTML = '';
    for (const row of colors) {
      for (const hex of row) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'ed-cell';
        cell.dataset.hex = hex;
        cell.title = hex.toUpperCase();
        cell.style.backgroundColor = translucent ? hexToRgba(hex) : hex;
        // 按下不抢选区：否则一点颜色选区就没了
        cell.addEventListener('mousedown', (e) => e.preventDefault());
        cell.addEventListener('click', () => onPick(hex));
        gridEl.appendChild(cell);
      }
    }
  }

  function closePops() {
    for (const [btn, pop] of [
      [btnFg, popFg],
      [btnHl, popHl]
    ]) {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function togglePop(btn, pop) {
    const willOpen = pop.hidden;
    closePops();
    if (!willOpen) return;
    pop.classList.remove('right');
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // 窗口很小（最小 300px 宽），靠右的色板往右展开会被窗口裁掉 → 贴右边界展开
    const box = pop.getBoundingClientRect();
    if (box.right > window.innerWidth - 4) pop.classList.add('right');
    const input = pop.querySelector('.ed-hex input');
    if (input) input.value = '';
  }

  function bindHex(inputEl, pick) {
    // 输入框要能正常获得焦点，所以不能 preventDefault；选区靠 ensureSelection 还回去
    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const hex = normalizeHex(inputEl.value);
      if (!hex) {
        inputEl.select();
        return;
      }
      if (pick(hex)) closePops();
    });
  }

  buildGrid($('gridFg'), FG_COLORS, (hex) => {
    if (applyFg(hex)) closePops();
  });
  buildGrid(
    $('gridHl'),
    HL_COLORS,
    (hex) => {
      if (applyHighlight(hex)) closePops();
    },
    true
  );

  for (const [btn, pop] of [
    [btnFg, popFg],
    [btnHl, popHl]
  ]) {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => togglePop(btn, pop));
  }

  $('fgAuto').addEventListener('mousedown', (e) => e.preventDefault());
  $('fgAuto').addEventListener('click', () => {
    if (!unwrapStyle(['color'])) {
      warnNeedSelection();
      return;
    }
    fgBar.style.background = '';
    closePops();
  });

  $('hlNone').addEventListener('mousedown', (e) => e.preventDefault());
  $('hlNone').addEventListener('click', () => {
    if (!unwrapStyle(['background-color'])) {
      warnNeedSelection();
      return;
    }
    hlBar.style.background = '';
    closePops();
  });

  bindHex($('fgHex'), applyFg);
  bindHex($('hlHex'), applyHighlight);

  // 点色板以外的地方 / Esc 收起色板
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.ed-pop-wrap')) return;
    closePops();
  });

  /* ---------------- 输入 / 粘贴 ---------------- */

  paper.addEventListener('input', markDirty);

  // 只接受纯文本粘贴：外部网页/Word 的样式会把纸面排版带乱，也会被净化器剥光
  paper.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    if (!t) return;
    document.execCommand('insertText', false, t);
    markDirty();
  });

  paper.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  /* ---------------- 保存 / 取消 ---------------- */

  /**
   * 存之前把「空 span」抖掉。
   * 换色时为了不破坏选区，剥掉属性后会把空壳留着（删节点会让 range 失效），
   * 这里在克隆体上清理，落盘的结构就只有真正带样式的 span。
   */
  function cleanedHtml() {
    const clone = paper.cloneNode(true);
    // 属性被剥干净的 span 会剩下 style=""（换色/换字号后再点「自动 / 跟随正文」就会这样），
    // 先把它当空壳看，否则会带着一段无用的 <span style=""> 落盘
    for (const sp of clone.querySelectorAll('span[style]')) {
      if (!sp.getAttribute('style').trim()) sp.removeAttribute('style');
    }
    let guard = 0;
    let junk = [...clone.querySelectorAll('span')].filter((s) => !s.getAttribute('style'));
    while (junk.length && guard++ < 20) {
      for (const sp of junk) sp.replaceWith(...sp.childNodes);
      junk = [...clone.querySelectorAll('span')].filter((s) => !s.getAttribute('style'));
    }
    return clone.innerHTML;
  }

  async function save() {
    if (saving) return;
    saving = true;
    allowClose = true;
    const html = cleanedHtml();
    try {
      await window.editorAPI.save(html);
      // 主进程收到后会把窗口关掉，这里不用再做什么
    } catch {
      saving = false;
      allowClose = false;
      toast('保存失败，请重试（Ctrl+S）');
    }
  }

  function cancel() {
    if (dirty && !window.confirm('还有没保存的内容，确定关闭吗？')) return;
    dirty = false;
    allowClose = true;
    window.editorAPI.close();
  }

  btnSave.addEventListener('click', save);
  $('btnCancel').addEventListener('click', cancel);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // 色板开着就先收色板，别直接关窗口
      if (!popFg.hidden || !popHl.hidden) {
        closePops();
        return;
      }
      cancel();
    }
  });

  // 直接点窗口右上角关闭时，有未保存内容就问一句（保存/取消时 allowClose 已经放行）
  window.addEventListener('beforeunload', (e) => {
    if (allowClose || !dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /* ---------------- 启动 ---------------- */

  (async function boot() {
    try {
      const res = await window.editorAPI.payload();
      if (res && res.ok) fill(res.data);
    } catch {
      /* ignore */
    }
    if (window.editorAPI.onReload) {
      window.editorAPI.onReload((p) => fill(p));
    }
    if (window.editorAPI.onTheme) {
      // 主窗口切黑夜模式 → 这里的纸立刻跟着变黑
      window.editorAPI.onTheme((dark) => applyTheme(!!dark));
    }
  })();
})();
