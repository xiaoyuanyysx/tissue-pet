/* app.js —— 渲染进程装配与总控 */
(function (global) {
  'use strict';
  const NS = global.XZ;
  const petAPI = window.petAPI;

  const app = {
    store: null,
    petView: null,
    engine: null,
    router: null,
    tear: null,
    stack: null,
    providers: null,
    paginator: null,
    toast: null,
    menu: null,
    interaction: null,
    settings: null,
    scaleCorner: null,
    info: {},
    ready: false,
    errors: []
  };
  global.XZApp = app;

  const viewport = document.getElementById('viewport');
  const streamEl = document.getElementById('paperStream');
  const toastHost = document.getElementById('toastHost');
  const uiRoot = document.getElementById('uiRoot');

  /* ---------------- 窗口尺寸 ---------------- */

  // 窗口高度 = 顶部留白 + 纸带可视区 + 底部留白。
  // ★ 拖动时**不再逐帧改窗口大小**：Windows 上透明无边框窗口每次 resize 都要重排整窗，
  //   一帧一次就是「拉纸卡顿」的根因。现在纸带在视口内部滚动，窗口尺寸只在
  //   布局/缩放/移动桌宠时变一次。
  // ★ 不再写死「4 张」：这里报一个大数，由主进程按**屏幕实际能给的高度**截断，
  //   也就是「屏幕放得下几张就几张」。放不下的部分靠纸带滚动，拉纸本身不设上限。
  const MAX_PAPER_SLOTS = 24;

  const desiredLogicalHeight = () =>
    NS.VIEWPORT_TOP + (app.engine ? app.engine.H : 200) * MAX_PAPER_SLOTS + NS.BOTTOM_PADDING;

  /** 窗口实际能给出的纸带高度 → 视口上限；顺便把 toast 贴到纸的下边缘 */
  const syncViewport = () => {
    if (!app.engine) return;
    const s = app.petView ? app.petView.scale || 1 : 1;
    const winH = window.innerHeight || 0; // CSS px，等于窗口 DIP 高度
    const cap = winH / s - NS.VIEWPORT_TOP - NS.BOTTOM_PADDING;
    app.engine.setViewportCap(Math.max(app.engine.H, cap));
    placeToast();
  };

  const placeToast = () => {
    if (!app.engine || !toastHost) return;
    const s = app.petView ? app.petView.scale : 1;
    const vh = app.engine.viewportHeight;
    const winH = window.innerHeight || 600;
    const top = Math.min((NS.VIEWPORT_TOP + vh) * s + 10, winH - 46);
    toastHost.style.top = `${Math.max(8, Math.round(top))}px`;
    // 水平锚在纸的中线上（设置面板展开时窗口会变宽，toast 不能跟着跑偏）
    toastHost.style.left = `${Math.round(NS.ROLL_AXIS_X * s)}px`;
  };

  const resizeWindow = () => {
    if (!app.engine) return;
    petAPI.resize(desiredLogicalHeight());
  };

  window.addEventListener('resize', syncViewport);

  /* ---------------- 设置应用 ---------------- */

  const applyLayout = NS.debounce(() => {
    const s = app.store.get('settings');
    app.engine.setLayout({
      paperWidthPx: s.basePaperWidthPx,
      paperHeightPx: s.basePaperHeightPx,
      fontSizePx: s.fontSizePx,
      darkMode: !!s.darkMode
    });
    if (app.router && app.router.current) app.router.persistProgress(true);
    resizeWindow();
    setTimeout(syncViewport, 60);
  }, 50);

  app.applyScale = async function (scale) {
    const v = NS.clamp(Math.round(scale * 100) / 100, 0.5, 2);
    app.store.patch('settings', { scale: v }, { critical: false });
    app.petView.setScale(v);
    try {
      await petAPI.applyScale(v);
    } catch {
      /* ignore */
    }
    resizeWindow();
    setTimeout(syncViewport, 60);
  };

  app.applySettings = function (patch) {
    app.store.patch('settings', patch, { critical: true });
    const s = app.store.get('settings');

    if ('darkMode' in patch) app.petView.setTheme(!!s.darkMode);
    if ('basePaperHeightPx' in patch || 'fontSizePx' in patch || 'darkMode' in patch || 'basePaperWidthPx' in patch) {
      applyLayout();
    }
    if ('tearThresholdPages' in patch || 'maxBacktrack' in patch || 'autoTear' in patch) {
      app.tear.setSettings({
        tearThresholdPages: s.tearThresholdPages,
        maxBacktrack: s.maxBacktrack,
        autoTear: s.autoTear
      });
    }
    if ('scaleCornerEnabled' in patch) app.scaleCorner.setEnabled(!!s.scaleCornerEnabled);
    if (app.settings) app.settings.refresh();
  };

  app.setAutoTear = function (enabled) {
    const s = app.store.get('settings');
    const autoTear = {
      enabled: !!enabled,
      pxPerSec: NS.clamp((s.autoTear && s.autoTear.pxPerSec) || 20, 2, 200)
    };
    app.store.patch('settings', { autoTear }, { critical: true });
    app.tear.setAutoTear(autoTear);
    app.toast.info(
      autoTear.enabled ? `自动滚落已开启（${autoTear.pxPerSec} px/秒）` : '自动滚落已关闭'
    );
    if (app.settings) app.settings.refresh();
  };

  app.setAutoTearSpeed = function (v) {
    const s = app.store.get('settings');
    const autoTear = {
      enabled: !!(s.autoTear && s.autoTear.enabled),
      pxPerSec: NS.clamp(v, 2, 200)
    };
    app.store.patch('settings', { autoTear }, { critical: true });
    app.tear.setAutoTear(autoTear);
    if (app.settings) app.settings.refresh();
  };

  /* ---------------- 模式 / 词库 / 资料 ---------------- */

  app.switchMode = async function (mode) {
    if (!mode || mode === app.router.current) return;
    try {
      await app.router.switchTo(mode);
      resizeWindow();
      if (app.settings) app.settings.refresh();
      app.toast.info(`已切换到${NS.MODE_LABEL[mode]}模式`);
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  app.switchDict = async function (dictId) {
    if (!dictId) return;
    try {
      app.store.patch('learn', { currentDictId: dictId, headEntryIndex: 0 }, { critical: true });
      app.store.patch('torn', { learn: { headIndex: 0, stack: [] } }, { critical: true });
      app.engine.stopAnimation();
      await app.router.enter('learn');
      resizeWindow();
      if (app.settings) app.settings.refresh();
      app.toast.info('已切换词库');
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  app.setLearnOption = function (key, value) {
    app.store.patch('learn', { [key]: value }, { critical: true });
    const p = app.providers.learn;
    p.applyState(app.store.get('learn'));
    if (key === 'shuffle' && value) {
      // 新一轮：更新种子
      app.store.patch('learn', { roundSeed: Math.floor(Math.random() * 1e9) }, { critical: true });
      p.applyState(app.store.get('learn'));
    }
    app.engine.refresh();
    if (app.settings) app.settings.refresh();
  };

  app.toggleHidden = function (word) {
    const learn = app.store.get('learn');
    const hidden = new Set(learn.hidden || []);
    if (hidden.has(word)) hidden.delete(word);
    else hidden.add(word);
    app.store.patch('learn', { hidden: [...hidden] }, { critical: true });
    app.providers.learn.applyState(app.store.get('learn'));
    app.engine.refresh();
    if (app.settings) app.settings.refresh();
  };

  app.toggleStar = function (word) {
    const learn = app.store.get('learn');
    const starred = new Set(learn.starred || []);
    if (starred.has(word)) starred.delete(word);
    else starred.add(word);
    app.store.patch('learn', { starred: [...starred] }, { critical: true });
    app.providers.learn.applyState(app.store.get('learn'));
    app.engine.refresh();
    if (app.settings) app.settings.refresh();
  };

  /** 当前纸面上的那张纸（学习模式即单词卡） */
  app.topPaper = function () {
    return app.engine ? app.engine.topPaper() : null;
  };

  /** 「最多保留 N 张可回溯」这类提示是否允许弹（设置里可关，且每次启动只提示一次） */
  app.noticeAllowed = function () {
    const s = app.store.get('settings');
    return s.notifyBacktrackLimit !== false;
  };

  app.importDict = async function () {
    try {
      const file = await NS.call(petAPI.importPickFile('learn'));
      if (!file) return;
      app.toast.info('正在解析词库…');
      const preview = await NS.call(petAPI.importParse(file.filePath, 'learn'));
      if (!preview || preview.kind !== 'dict-preview') return;
      const choice = await showDictPreview(preview, file.name);
      if (!choice) return;
      const res = await NS.call(
        petAPI.importCommitDict({
          token: preview.token,
          name: choice.name,
          wordLang: choice.wordLang,
          defLang: choice.defLang
        })
      );
      app.toast.info(`词库导入成功：${res.count} 条`);
      await app.settings.refresh();
      await app.switchDict(res.dictId);
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  app.importDoc = async function () {
    try {
      const file = await NS.call(petAPI.importPickFile('leisure'));
      if (!file) return;
      app.toast.info('正在解析资料…');
      const res = await NS.call(petAPI.importParse(file.filePath, 'leisure'));
      if (!res || res.kind !== 'doc') return;
      const leisure = app.store.get('leisure');
      const docs = (leisure.docs || []).filter((d) => d.docId !== res.docId);
      docs.push({ docId: res.docId, name: res.name, importedAt: Date.now() });
      const progress = Object.assign({}, leisure.progress, { [res.docId]: 0 });
      app.store.patch('leisure', { docs, activeDocId: res.docId, progress }, { critical: true });
      app.store.patch('torn', { leisure: { headIndex: 0, stack: [] } }, { critical: true });
      app.toast.info(`导入成功：${res.blockCount} 段，${res.placeholderCount} 个占位符`);
      await app.router.enter('leisure');
      resizeWindow();
      if (app.settings) app.settings.refresh();
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  app.openDoc = async function (docId) {
    try {
      const leisure = app.store.get('leisure');
      const progress = Object.assign({}, leisure.progress);
      if (progress[docId] == null) progress[docId] = 0;
      app.store.patch('leisure', { activeDocId: docId, progress }, { critical: true });
      app.store.patch('torn', { leisure: { headIndex: 0, stack: [] } }, { critical: true });
      await app.router.enter('leisure');
      resizeWindow();
      if (app.settings) app.settings.refresh();
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  app.removeDoc = async function (docId) {
    const doc = (app.store.get('leisure').docs || []).find((d) => d.docId === docId);
    if (!window.confirm(`删除资料「${doc ? doc.name : docId}」及其阅读进度？`)) return;
    try {
      await NS.call(petAPI.docRemove(docId));
      const leisure = app.store.get('leisure');
      const docs = (leisure.docs || []).filter((d) => d.docId !== docId);
      const progress = Object.assign({}, leisure.progress);
      delete progress[docId];
      const activeDocId = leisure.activeDocId === docId ? (docs[0] ? docs[0].docId : null) : leisure.activeDocId;
      app.store.patch('leisure', { docs, progress, activeDocId }, { critical: true });
      app.providers.leisure.loadDoc(activeDocId || null).then(() => app.engine.refresh());
      await app.settings.refresh();
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  /* ---------------- 清单 ---------------- */

  function patchLists(lists, extra) {
    app.store.patch('checklists', Object.assign({ lists }, extra || {}), { critical: true });
    app.providers.checklist.setState(app.store.get('checklists'));
    app.engine.setTop(app.engine.top, {});
    if (app.settings) app.settings.refresh();
  }

  app.createList = async function () {
    const name = await promptText('新建清单', '今日目标');
    if (!name) return;
    const cl = app.store.get('checklists');
    const res = NS.ChecklistOps.createList(cl.lists, name);
    patchLists(res.lists, { activeListId: res.listId });
    app.engine.setTop(0, { shift: 0 });
  };

  app.renameList = async function () {
    const cl = app.store.get('checklists');
    const cur = cl.lists.find((l) => l.id === cl.activeListId);
    if (!cur) return;
    const name = await promptText('重命名清单', cur.name);
    if (!name) return;
    patchLists(NS.ChecklistOps.renameList(cl.lists, cur.id, name));
  };

  app.removeList = async function () {
    const cl = app.store.get('checklists');
    if (cl.lists.length <= 1) {
      app.toast.warn('至少保留一个清单');
      return;
    }
    const cur = cl.lists.find((l) => l.id === cl.activeListId);
    if (!cur || !window.confirm(`删除清单「${cur.name}」及全部条目？`)) return;
    const lists = NS.ChecklistOps.removeList(cl.lists, cur.id);
    patchLists(lists, { activeListId: lists[0] ? lists[0].id : '' });
    app.engine.setTop(0, { shift: 0 });
  };

  app.selectList = function (listId) {
    patchLists(app.store.get('checklists').lists, { activeListId: listId });
    app.engine.setTop(0, { shift: 0 });
  };

  app.addItem = function (text) {
    const cl = app.store.get('checklists');
    patchLists(NS.ChecklistOps.addItem(cl.lists, cl.activeListId, text));
  };

  app.removeItem = function (itemId) {
    const cl = app.store.get('checklists');
    patchLists(NS.ChecklistOps.removeItem(cl.lists, cl.activeListId, itemId));
  };

  app.moveItem = function (itemId, delta) {
    const cl = app.store.get('checklists');
    patchLists(NS.ChecklistOps.moveItem(cl.lists, cl.activeListId, itemId, delta));
  };

  /** 拖拽排序：把 dragId 插到 targetId 之前 */
  app.moveItemBefore = function (dragId, targetId) {
    const cl = app.store.get('checklists');
    patchLists(NS.ChecklistOps.moveItemBefore(cl.lists, cl.activeListId, dragId, targetId));
  };

  app.updateItem = function (itemId, patch) {
    const cl = app.store.get('checklists');
    patchLists(NS.ChecklistOps.updateItem(cl.lists, cl.activeListId, itemId, patch));
  };

  /* ---------------- 其它 ---------------- */

  app.setShortcut = async function (action, accelerator, scope) {
    await NS.call(petAPI.shortcutSet(action, accelerator, scope));
    try {
      app.shortcuts = (await NS.call(petAPI.shortcutGetAll())) || {};
    } catch {
      /* ignore */
    }
  };

  /** 右键菜单里显示的快捷键提示（取聚焦轨，没有就用全局轨） */
  app.keyHint = function (action) {
    const m = (app.shortcuts || {})[action] || {};
    const acc = m.focused || m.global || '';
    return acc ? acc.replace(/CommandOrControl|Control/g, 'Ctrl').replace(/\+/g, '+') : '';
  };

  app.openSettings = function (tab) {
    app.settings.open(tab);
  };

  app.openUserData = function () {
    petAPI.openUserData();
  };

  app.toast = null;
  app.shortcuts = {};

  /* ---------------- 弹窗 ---------------- */

  function makeModal(title) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const head = document.createElement('div');
    head.className = 'modal-head';
    head.textContent = title;
    const body = document.createElement('div');
    body.className = 'modal-body';
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    mask.appendChild(modal);
    uiRoot.appendChild(mask);
    return {
      mask,
      body,
      foot,
      close() {
        mask.remove();
      }
    };
  }

  function promptText(title, defaultValue) {
    return new Promise((resolve) => {
      const m = makeModal(title);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = defaultValue || '';
      m.body.appendChild(input);
      const ok = document.createElement('button');
      ok.className = 'btn primary';
      ok.textContent = '确定';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = '取消';
      m.foot.appendChild(cancel);
      m.foot.appendChild(ok);
      const done = (v) => {
        m.close();
        resolve(v);
      };
      ok.addEventListener('click', () => done(input.value.trim()));
      cancel.addEventListener('click', () => done(null));
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(input.value.trim());
        if (e.key === 'Escape') done(null);
      });
      setTimeout(() => input.focus(), 30);
    });
  }

  function showDictPreview(preview, fileName) {
    return new Promise((resolve) => {
      const m = makeModal('导入词库预览');
      const total = document.createElement('div');
      total.className = 'sp-hint';
      total.textContent = `共识别 ${preview.totalRows} 条词条；以下为前 ${preview.previewRows.length} 条：`;
      m.body.appendChild(total);

      const rows = document.createElement('div');
      rows.style.margin = '6px 0 10px';
      for (const r of preview.previewRows) {
        const d = document.createElement('div');
        d.className = 'preview-row';
        d.textContent = r;
        rows.appendChild(d);
      }
      m.body.appendChild(rows);

      const nameLabel = document.createElement('div');
      nameLabel.className = 'sp-hint';
      nameLabel.textContent = '词库名称';
      m.body.appendChild(nameLabel);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = String(fileName || '导入词库').replace(/\.[^.]+$/, '');
      m.body.appendChild(nameInput);

      const langs = preview.languages && preview.languages.length ? preview.languages : ['英语'];
      const common = ['英语', '中文', '日语', '韩语', '俄语', '法语', '德语', '西班牙语'];
      const options = [...new Set([...langs, ...common])];

      const wl = document.createElement('div');
      wl.className = 'sp-hint';
      wl.textContent = '学习语言（词条语言）';
      m.body.appendChild(wl);
      const wordSel = document.createElement('select');
      for (const l of options) {
        const o = document.createElement('option');
        o.value = l;
        o.textContent = l;
        wordSel.appendChild(o);
      }
      wordSel.value = langs[0];
      m.body.appendChild(wordSel);

      const dl = document.createElement('div');
      dl.className = 'sp-hint';
      dl.textContent = '释义语言';
      m.body.appendChild(dl);
      const defSel = document.createElement('select');
      for (const l of options) {
        const o = document.createElement('option');
        o.value = l;
        o.textContent = l;
        defSel.appendChild(o);
      }
      defSel.value = langs[1] || '中文';
      m.body.appendChild(defSel);

      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = '取消';
      const ok = document.createElement('button');
      ok.className = 'btn primary';
      ok.textContent = '导入';
      m.foot.appendChild(cancel);
      m.foot.appendChild(ok);
      const done = (v) => {
        m.close();
        resolve(v);
      };
      ok.addEventListener('click', () =>
        done({ name: nameInput.value.trim() || '导入词库', wordLang: wordSel.value, defLang: defSel.value })
      );
      cancel.addEventListener('click', () => done(null));
      m.body.addEventListener('keydown', (e) => e.stopPropagation());
    });
  }

  /* ---------------- 右键菜单 ---------------- */

  function buildMenuItems(e) {
    const hit = app.engine.hitTest(e.target);
    const mode = app.router.current;
    const items = [];

    if (mode === 'learn' && hit && hit.paper && hit.paper.kind === 'word') {
      const word = hit.paper.word;
      const learn = app.store.get('learn');
      const hidden = (learn.hidden || []).includes(word);
      items.push({
        label: hidden ? `恢复显示「${NS.truncate(word, 12)}」` : `不显示「${NS.truncate(word, 12)}」`,
        icon: '🚫',
        hint: app.keyHint('toggleHidden'),
        onClick: () => app.toggleHidden(word)
      });
      items.push({
        label: hit.paper.starred ? '取消标星' : '标星（难点词）',
        icon: '★',
        hint: app.keyHint('toggleStar'),
        onClick: () => app.toggleStar(word)
      });
      items.push({ sep: true });
    }

    if (mode === 'checklist' && hit) {
      const itemEl = e.target.closest ? e.target.closest('.cl-item') : null;
      if (itemEl && itemEl.dataset.itemId) {
        const itemId = itemEl.dataset.itemId;
        const cl = app.store.get('checklists');
        const list = cl.lists.find((l) => l.id === cl.activeListId);
        const item = list ? list.items.find((i) => i.id === itemId) : null;
        if (item) {
          const style = item.style || {};
          items.push({
            label: item.done ? '取消完成' : '勾选完成',
            icon: '✓',
            onClick: () => app.updateItem(itemId, { done: !item.done })
          });
          items.push({ sep: true });
          for (const c of [
            { v: '', label: '默认色' },
            { v: '#dc2626', label: '红色' },
            { v: '#2563eb', label: '蓝色' },
            { v: '#16a34a', label: '绿色' },
            { v: '#d97706', label: '橙色' }
          ]) {
            items.push({
              label: `颜色：${c.label}`,
              icon: style.color === c.v || (!style.color && !c.v) ? '●' : '',
              onClick: () => app.updateItem(itemId, { style: Object.assign({}, style, { color: c.v || undefined }) })
            });
          }
          items.push({
            label: style.bold ? '取消加粗' : '加粗',
            icon: 'B',
            onClick: () => app.updateItem(itemId, { style: Object.assign({}, style, { bold: !style.bold }) })
          });
          items.push({
            label: style.strike ? '取消划线' : '划线',
            icon: 'S',
            onClick: () => app.updateItem(itemId, { style: Object.assign({}, style, { strike: !style.strike }) })
          });
          items.push({ sep: true });
          items.push({
            label: '上移',
            icon: '↑',
            onClick: () => app.moveItem(itemId, -1)
          });
          items.push({
            label: '下移',
            icon: '↓',
            onClick: () => app.moveItem(itemId, 1)
          });
          items.push({
            label: '删除条目',
            icon: '✕',
            danger: true,
            onClick: () => app.removeItem(itemId)
          });
          items.push({ sep: true });
        }
      }
    }

    items.push({
      label: '回溯上一张',
      icon: '↩',
      hint: app.keyHint('backtrack'),
      disabled: !app.stack || app.stack.size === 0,
      onClick: () => app.tear.backtrack(1)
    });
    items.push({ label: '设置中心', icon: '⚙', onClick: () => app.settings.open() });
    items.push({
      label: '隐藏桌宠',
      icon: '👁',
      hint: app.keyHint('toggleVisible'),
      onClick: () => petAPI.hide()
    });
    items.push({ sep: true });
    items.push({ label: '退出', icon: '⏻', danger: true, onClick: () => petAPI.quitApp() });
    return items;
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    window.addEventListener('error', (ev) => {
      app.errors.push(String(ev.message || ev.error));
    });
    window.addEventListener('unhandledrejection', (ev) => {
      app.errors.push(String((ev.reason && ev.reason.message) || ev.reason));
    });

    const store = new NS.RendererStore();
    await store.init();
    app.store = store;

    const s0 = store.get('settings');

    const petView = new NS.PetView(document);
    app.petView = petView;
    petView.setTheme(!!s0.darkMode);
    petView.setScale(s0.scale);

    const engine = new NS.PaperStreamEngine({ viewport, stream: streamEl, petView });
    app.engine = engine;
    engine.on('geometry', placeToast);
    engine.setLayout({
      paperWidthPx: s0.basePaperWidthPx || 170,
      paperHeightPx: s0.basePaperHeightPx || 200,
      fontSizePx: s0.fontSizePx || 15,
      darkMode: !!s0.darkMode
    });

    const paginator = new NS.Paginator();
    app.paginator = paginator;

    const providers = {
      learn: new NS.LearnProvider(),
      leisure: new NS.LeisureProvider(paginator),
      checklist: new NS.ChecklistProvider()
    };
    app.providers = providers;

    const stack = new NS.BacktrackStack(s0.maxBacktrack);
    app.stack = stack;

    const toast = new NS.Toast(toastHost);
    app.toast = toast;

    const menu = new NS.ContextMenu(uiRoot);
    app.menu = menu;

    const interaction = new NS.InteractionLayer();
    interaction.attach();
    app.interaction = interaction;

    const tear = new NS.TearController({
      engine,
      stack,
      hooks: {
        onTear: () => app.router && app.router.persistProgress(true),
        onBacktrack: () => app.router && app.router.persistProgress(true),
        onOverflow: (ev) => {
          // 每次运行只提示一次「最多保留 N 张」，且可在设置中关闭
          if (app._overflowNoticed || !app.noticeAllowed()) return;
          app._overflowNoticed = true;
          toast.warn(`最多保留 ${ev.cap} 张可回溯的纸，更早的纸已不可恢复（本次运行内有效）`);
        },
        onNotice: (msg) => toast.info(msg),
        onDragState: (dragging) => interaction.setForced(dragging),
        onAutoTearStop: () => {
          const s = app.store.get('settings');
          const autoTear = {
            enabled: false,
            pxPerSec: NS.clamp((s.autoTear && s.autoTear.pxPerSec) || 20, 2, 200)
          };
          app.store.patch('settings', { autoTear }, { critical: true });
          if (app.settings) app.settings.refresh();
        }
      }
    });
    app.tear = tear;
    tear.setSettings({
      tearThresholdPages: s0.tearThresholdPages,
      maxBacktrack: s0.maxBacktrack,
      autoTear: s0.autoTear
    });
    tear.attachPointerEvents(viewport);

    const router = new NS.ModeRouter({ store, engine, tear, providers });
    app.router = router;

    const settings = new NS.SettingsCenter({ host: uiRoot, store, app });
    app.settings = settings;

    const scaleCorner = new NS.ScaleCorner({
      el: document.getElementById('scaleCorner'),
      getScale: () => app.store.get('settings').scale,
      onScale: NS.rafThrottle((s) => app.applyScale(s))
    });
    scaleCorner.setEnabled(!!s0.scaleCornerEnabled);
    app.scaleCorner = scaleCorner;

    document.getElementById('gearBtn').addEventListener('click', () => settings.toggle());

    // 卷筒拖动 = 移动窗口（不用 -webkit-app-region: drag，见 window-drag.js 注释）
    const windowDrag = new NS.WindowDrag({
      el: document.getElementById('dragZone'),
      enabled: true,
      onStart: () => {
        interaction.setForced(true);
        petAPI.setIgnoreMouseEvents(false);
      },
      onEnd: () => {
        interaction.setForced(false);
        // 移动后工作区剩余高度可能变了，重新申请一次并刷新视口上限
        resizeWindow();
        setTimeout(syncViewport, 60);
      }
    });
    windowDrag.attach();
    app.windowDrag = windowDrag;

    // 隐藏释义时：轻点纸面显示/收起释义。
    // 不能挂在 click 上——松手会立刻启动回弹动画，click 阶段 animating 仍为 true 会被拦掉。
    let tapDown = null;
    viewport.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('.wa-btn')) {
          tapDown = null;
          return;
        }
        tapDown = { x: e.screenX, y: e.screenY, t: Date.now() };
      },
      true
    );
    viewport.addEventListener(
      'pointerup',
      (e) => {
        const d = tapDown;
        tapDown = null;
        if (!d) return;
        if (Math.abs(e.screenX - d.x) > 4 || Math.abs(e.screenY - d.y) > 4) return;
        if (Date.now() - d.t > 800) return;
        if (router.current !== 'learn') return;
        if (!app.store.get('learn').hideDefinition) return;
        const hit = engine.hitTest(e.target);
        if (!hit) return;
        const def = hit.el.querySelector('.word-def');
        if (!def) return;
        def.classList.toggle('hidden-def');
      },
      true
    );

    // 纸面上的「标星 / 不显示」按钮：拦截 pointerdown，避免顺带触发拉纸手势
    viewport.addEventListener(
      'pointerdown',
      (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.wa-btn') : null;
        if (!btn) return;
        e.stopImmediatePropagation();
      },
      true
    );
    viewport.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.wa-btn') : null;
      if (!btn) return;
      e.stopPropagation();
      const hit = engine.hitTest(btn);
      const paper = hit && hit.paper;
      if (!paper || paper.kind !== 'word') return;
      if (btn.dataset.act === 'star') app.toggleStar(paper.word);
      else if (btn.dataset.act === 'hide') app.toggleHidden(paper.word);
    });

    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (e.target.closest && e.target.closest('.settings-panel')) return;
      menu.show(e.clientX, e.clientY, buildMenuItems(e));
    });

    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (menu.isOpen) {
        menu.close();
        return;
      }
      const mask = uiRoot.querySelector('.modal-mask');
      if (mask) {
        mask.remove();
        return;
      }
      if (settings.isOpen) {
        settings.close();
        return;
      }
      petAPI.quitApp();
    });

    // 输入框获得/失去焦点时，通知主进程暂停快捷键拦截（避免打字触发回溯等）
    const isField = (el) =>
      !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
    document.addEventListener('focusin', (e) => {
      if (isField(e.target)) petAPI.shortcutSetEditing(true);
    });
    document.addEventListener('focusout', (e) => {
      if (isField(e.target)) petAPI.shortcutSetEditing(false);
    });

    const handleAction = async (ev) => {
      try {
        if (ev.action === 'backtrack') tear.backtrack(1);
        else if (ev.action === 'toggleHidden' || ev.action === 'toggleStar') {
          const p = engine.topPaper();
          if (router.current !== 'learn' || !p || p.kind !== 'word') {
            toast.info('这个快捷键只对学习模式的单词纸有效');
          } else if (ev.action === 'toggleHidden') {
            app.toggleHidden(p.word);
            const hidden = (app.store.get('learn').hidden || []).includes(p.word);
            toast.info(hidden ? `已不显示「${p.word}」，可在设置中心恢复` : `已恢复显示「${p.word}」`);
          } else {
            app.toggleStar(p.word);
            const starred = (app.store.get('learn').starred || []).includes(p.word);
            toast.info(starred ? `已标星「${p.word}」` : `已取消标星「${p.word}」`);
          }
        } else if (ev.action === 'toggleVisible') await petAPI.toggleVisible();
        else if (ev.action === 'toggleAutoTear') {
          const s = app.store.get('settings');
          app.setAutoTear(!(s.autoTear && s.autoTear.enabled));
        } else if (ev.action === 'switchMode') {
          const next =
            (ev.payload && ev.payload.mode) ||
            NS.MODES[(NS.MODES.indexOf(router.current) + 1) % NS.MODES.length];
          await router.switchTo(next);
          resizeWindow();
          if (settings.isOpen) settings.refresh();
        } else if (ev.action === 'quit') {
          petAPI.quitApp();
        }
      } catch (err) {
        toast.error(NS.errorText(err));
      }
    };
    petAPI.onAction(handleAction);
    app.handleAction = handleAction;

    petAPI.onNotice((n) => {
      if (!n) return;
      toast.show(n.message, n.level === 'warn' ? 'warn' : 'info', 4000);
    });

    try {
      app.info = await NS.call(petAPI.appInfo());
    } catch {
      app.info = {};
    }

    try {
      app.shortcuts = (await NS.call(petAPI.shortcutGetAll())) || {};
    } catch {
      app.shortcuts = {};
    }

    await router.boot();
    resizeWindow();
    syncViewport();
    setTimeout(syncViewport, 150);
    app.ready = true;

    // 回溯只保留「本次运行」撕下的纸：启动时提示一次上限（设置里可关）
    if (app.noticeAllowed()) {
      const s1 = app.store.get('settings');
      setTimeout(() => {
        toast.info(`回溯仅限本次运行撕下的纸，最多保留 ${NS.clamp(s1.maxBacktrack, 1, 50)} 张`, 4200);
      }, 1200);
    }

    window.__smoke = () => ({
      ready: app.ready,
      mode: router.current,
      top: engine.top,
      paperCount: engine.paperCount,
      nodes: engine.nodes.size,
      layout: engine.layout,
      firstPaper: (() => {
        const p = engine.contentAt(engine.top);
        if (!p) return null;
        if (p.kind === 'word') return `word:${p.word}`;
        if (p.kind === 'text') return `text:${p.charStart}-${p.charEnd}`;
        return `checklist:${(p.items || []).length}`;
      })(),
      errors: app.errors
    });

    // 调试/探针入口（--smoke-test 也用这里读写引擎状态）
    window.__pet = { app, engine, tear, router, settings, store, petView };
  }

  init().catch((err) => {
    console.error('[app] 启动失败', err);
    const host = document.getElementById('toastHost');
    if (host) {
      const d = document.createElement('div');
      d.className = 'toast error';
      d.textContent = `启动失败：${NS.errorText(err)}`;
      host.appendChild(d);
    }
  });
})(window);
