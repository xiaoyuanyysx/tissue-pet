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

  /**
   * 把「当前模式还能回溯几张」上报给托盘。
   * 回溯栈按需求只存在内存里（重启即空），主进程读不到，只能由渲染层主动同步，
   * 否则托盘菜单里那一项会永远是灰的。
   */
  const syncTrayDepth = () => {
    if (!app.router || !app.stack) return;
    try {
      petAPI.traySyncBacktrack(app.router.current || '', app.stack.size);
    } catch {
      /* 托盘可能尚未创建，忽略 */
    }
  };

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

    if ('darkMode' in patch) {
      app.petView.setTheme(!!s.darkMode);
      // 编辑窗口（若开着）也跟着换：纸是同一张纸，不能一半白一半黑
      try {
        petAPI.editorTheme(!!s.darkMode);
      } catch {
        /* 编辑窗口没开时无所谓 */
      }
    }
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
    if ('checklistLoop' in patch) {
      // 清单循环：纸带无限 ↔ 到底为止（切模式时 mode-router 也会重新下发一次）
      app.providers.checklist.setLoop(s.checklistLoop !== false);
      // 从「无限」切回「到底」时，纸带可能停在了内容的后面，收回上限内
      const max = app.engine.maxShift();
      if (Number.isFinite(max) && app.engine.shift > max) app.engine.setShift(max);
      app.engine.refresh();
    }
    if ('checklistNoTear' in patch) {
      // 清单是否撕纸：true（默认）= 只滚动浏览；false = 按「撕纸阈值」一张张撕
      const noTear = s.checklistNoTear !== false;
      app.tear.setChecklistTear(!noTear);
      app.providers.checklist.setTearMode(!noTear);
      // 撕纸模式下纸带不再无限循环（撕完又绕回来等于白撕），循环交给 provider 的 infinite 判定
      app.providers.checklist.setLoop(s.checklistLoop !== false);
      // 只在清单模式里动指针和位移：在别的模式改这个开关，不能把当前模式的进度清零
      if (app.router && app.router.current === 'checklist') {
        if (noTear) {
          // 切回「不撕纸」：把已经撕掉的那几张放回去，指针与位移都归零，第一页立刻可见
          if (app.engine.top > 0) app.engine.setTop(0, { shift: 0 });
          app.engine.setShift(0);
          // 撕纸时才有的回溯记录在这里失效了（纸并没有真的被拿走），清掉免得托盘还亮着
          if (app.tear.stack) {
            app.tear.stack.clear();
            syncTrayDepth();
          }
        } else {
          // 切到「撕纸」：分页滚动出来的位移没有意义了（撕纸会自己重算位置）
          app.engine.setShift(0);
        }
        app.engine.refresh();
        app.router.persistProgress(true);
      }
    }
    if ('checklistNumbering' in patch) {
      // 自动序号只改纸面绘制（序号会占首行宽度，provider 内部会重排）
      app.providers.checklist.setNumbering(!!s.checklistNumbering);
      app.engine.refresh();
    }
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

  /** 重置当前词库的学习进度：回到第一张纸并清空本次运行的回溯栈（标星/不显示不动） */
  app.resetLearnProgress = async function () {
    const ok = window.confirm(
      '确定把当前词库的学习进度重置到第一张纸吗？\n\n标星词和不显示词不会被清除，只重置「读到哪了」。'
    );
    if (!ok) return;
    try {
      app.engine.stopAnimation();
      if (app.router.session) app.router.session.learn = [];
      const p = app.providers.learn;
      p.pos = 0;
      if (p.clearPins) p.clearPins();
      app.store.patch('learn', { headEntryIndex: 0 }, { critical: true });
      app.store.patch('torn', { learn: { headIndex: 0, stack: [] } }, { critical: true });
      await app.router.enter('learn');
      resizeWindow();
      app.toast.info('学习进度已重置到第一张纸');
      if (app.settings) app.settings.refresh();
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  /** 删除导入的词库（内置词库由主进程拒绝）；标星/不显示按语言存，不随词库删除而丢失 */
  app.removeDict = async function (dictId) {
    if (!dictId) return;
    const all = (app.settings && app.settings.dicts) || [];
    const meta = all.find((x) => x.id === dictId);
    const label = meta ? meta.name : '该词库';
    const ok = window.confirm(
      `确定删除词库「${label}」吗？\n\n只移除导入的数据，标星词与不显示词不会被清除。`
    );
    if (!ok) return;
    try {
      await NS.call(petAPI.dictRemove(dictId));
      app.toast.info(`已删除词库「${label}」`);
      if (app.store.get('learn').currentDictId === dictId) {
        // 删的正好是当前词库：必须先切走，否则 Provider 还挂着已删的 dictId，
        // 下次 ensureLoaded 会拉到空数组，纸面变成「这个词库还没有内容」
        const next = all.find((x) => x.builtin) || all.find((x) => x.id !== dictId);
        if (next) await app.switchDict(next.id);
      }
      if (app.settings) await app.settings.refresh();
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

  /** 不显示 / 标星按语言分组写入：同名同语言的词库共享，跨语言互不影响 */
  function toggleWordInGroup(scope, word) {
    const learn = app.store.get('learn');
    const provider = app.providers.learn;
    const lang = provider.lang || 'unknown';
    const groups = Object.assign({}, learn[scope] || {});
    const set = new Set(Array.isArray(groups[lang]) ? groups[lang] : []);
    if (set.has(word)) set.delete(word);
    else set.add(word);
    groups[lang] = [...set];
    app.store.patch('learn', { [scope]: groups }, { critical: true });
    provider.applyState(app.store.get('learn'));
    app.engine.refresh();
    if (app.settings) app.settings.refresh();
    return set.has(word);
  }

  app.toggleHidden = function (word) {
    return toggleWordInGroup('hidden', word);
  };

  app.toggleStar = function (word) {
    return toggleWordInGroup('starred', word);
  };

  /**
   * 语言分组迁移：只搬「当前词库里确实存在的词」。
   * 旧分组里可能还有同语言其他词库的词（四级/雅思共用 en），那些不该被牵走。
   */
  function migrateLangGroups(oldLang, newLang) {
    if (!oldLang || !newLang || oldLang === newLang) return;
    const p = app.providers.learn;
    const known = new Set(p.entries.map((e) => String(e.word || '').toLowerCase()));
    if (!known.size) return;
    const learn = app.store.get('learn');
    const patch = {};
    for (const scope of ['hidden', 'starred']) {
      const groups = Object.assign({}, learn[scope] || {});
      const from = Array.isArray(groups[oldLang]) ? groups[oldLang] : [];
      const move = from.filter((w) => known.has(String(w).toLowerCase()));
      if (!move.length) continue;
      const to = new Set(Array.isArray(groups[newLang]) ? groups[newLang] : []);
      for (const w of move) to.add(w);
      groups[newLang] = [...to];
      const rest = from.filter((w) => !known.has(String(w).toLowerCase()));
      // store.patch 是「浅合并」，删键不会生效，所以用空数组表示这一组已空
      groups[oldLang] = rest;
      patch[scope] = groups;
    }
    if (Object.keys(patch).length) app.store.patch('learn', patch, { critical: true });
  }

  /**
   * 改词库语言（导入时选错了可以随时改，不用重导）：
   * 学习语言 → 决定「标星 / 不显示」按哪种语言保存，并把当前词库的记录迁到新分组
   * 释义语言 → 词库带多语言释义时，纸面按它取那一份
   */
  app.setDictLang = async function (dictId, patch, opts) {
    if (!dictId || !patch) return null;
    const word = String(patch.word || '').trim();
    if (!word) return null;
    const silent = !!(opts && opts.silent); // 调用方自己给反馈时不重复 toast
    try {
      // 旧语言必须从主进程现取：设置面板没打开时 this.settings.dicts 是空的
      const all = await NS.call(petAPI.dictListAll());
      const before = (all || []).find((d) => d.id === dictId) || null;
      const def = patch.def == null ? (before && before.defLang) || '' : String(patch.def).trim();
      const meta = await NS.call(petAPI.dictSetLang(dictId, word, def));
      if (!meta) return null;
      if (before && before.lang !== meta.lang) migrateLangGroups(before.lang, meta.lang);
      const p = app.providers.learn;
      if (p.dictId === dictId) {
        p.applyMeta(meta);
        p.applyState(app.store.get('learn'));
      }
      app.engine.refresh();
      if (app.settings) await app.settings.refresh();
      if (!silent) app.toast.info(`已改为「${meta.wordLang}${meta.defLang ? ` / ${meta.defLang}` : ''}」`);
      return meta;
    } catch (err) {
      app.toast.error(NS.errorText(err));
      return null;
    }
  };

  /**
   * 「刷新纸面」：把两个下拉的选择一次性应用。
   * 和学习语言/释义语言分别即时生效相比，这里多了两件事——
   *  1) 语言没变也重绘一次（纯刷新语义）；
   *  2) 进度兜底：只重建可见纸，绝不把已撕张数打回 0。
   */
  app.applyDictLang = async function (dictId, word, def, opts) {
    if (!dictId) return false;
    const w = String(word || '').trim();
    if (!w) return false;
    const d = def == null ? '' : String(def).trim();
    const silent = !!(opts && opts.silent);
    const engine = app.engine;
    const topBefore = engine ? engine.top : 0;

    let cur = null;
    try {
      cur = ((await NS.call(petAPI.dictListAll())) || []).find((x) => x.id === dictId) || null;
    } catch {
      /* 读不到就按「有改动」处理 */
    }
    const same = !!cur && (cur.wordLang || '') === w && (cur.defLang || '') === d;

    if (!same) {
      const meta = await app.setDictLang(dictId, { word: w, def: d }, { silent });
      if (!meta) return false;
    }
    // setDictLang 内部已经 refresh 过一次；这里保证 top 不被动过（下面的写入也会落盘）
    if (engine) {
      if (engine.top !== topBefore) engine.setTop(topBefore, { shift: 0 });
      engine.refresh();
    }
    if (app.router) app.router.persistProgress(true);
    if (same && !silent) app.toast.info(`纸面已刷新：${w}${d ? ` / ${d}` : ''}`);
    return true;
  };

  /**
   * 一键对调「学习语言 / 释义语言」：设置面板的「⇄」与纸面右键菜单共用这条路。
   * 上下不能同语言，所以「对调」永远是合法组合，不用校验重名；
   * 进度照旧由 applyDictLang 兜底（只重绘可见纸，不回第一张）。
   */
  app.swapDictLang = async function (dictId) {
    const id = dictId || (app.store.get('learn') || {}).currentDictId;
    if (!id) return false;
    try {
      // 必须现取：设置面板没打开时缓存里的 meta 可能是旧的
      const all = await NS.call(petAPI.dictListAll());
      const cur = (all || []).find((d) => d.id === id) || null;
      if (!cur) return false;
      const w = cur.defLang || '';
      const d = cur.wordLang || '';
      if (!w || w === d) {
        app.toast.info('这本词库只有一种语言，没有可对调的内容');
        return false;
      }
      const ok = await app.applyDictLang(id, w, d, { silent: true });
      if (ok) app.toast.info(`已对调：上「${w}」下「${d}」`);
      return ok;
    } catch (err) {
      app.toast.error(NS.errorText(err));
      return false;
    }
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
          defLang: choice.defLang,
          // 勾选的语言槽位：主进程据此裁剪译文、写入自定义语言名
          langPlan: choice.langPlan
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
    // 清单不撕纸、只滚动：条目变少后纸带可能「超出内容」，把位移收回上限
    if (app.engine.shift > app.engine.maxShift()) app.engine.setShift(app.engine.maxShift());
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

  /** 改条目文字：设置面板双击、纸上右键菜单都走这里（空文本视为取消，不允许把条目改成空） */
  app.editItemText = async function (itemId) {
    const cl = app.store.get('checklists');
    const list = (cl.lists || []).find((l) => l.id === cl.activeListId);
    const item = list ? (list.items || []).find((i) => i.id === itemId) : null;
    if (!item) return;
    const next = await promptText('修改条目', item.text);
    if (next == null) return;
    const text = String(next).trim();
    if (!text || text === item.text) return;
    // 改成纯文本后旧富文本就作废了，否则纸面还会按 html 画（与列表里的文字对不上）
    app.updateItem(itemId, { text, html: '' });
  };

  /**
   * 富文本编辑：开一个独立的「像 doc 一样」的窗口，能改字号 / 颜色 / 加粗 / 划掉…
   * 结果由主进程回传（checklist:save），保存/取消都不动纸面进度。
   */
  app.editItemRich = async function (itemId) {
    const cl = app.store.get('checklists');
    const list = (cl.lists || []).find((l) => l.id === cl.activeListId) || (cl.lists || [])[0];
    const item = itemId && list ? (list.items || []).find((i) => i.id === itemId) : null;
    try {
      await NS.call(
        petAPI.editorOpen({
          listId: list ? list.id : '',
          itemId: item ? item.id : '',
          listName: list ? list.name : '清单',
          html: item ? item.html || NS.Rich.plainToHtml(item.text) : '',
          // 编辑器窗口和纸面同一套主题（黑夜模式下纸是黑的、字是浅的）
          darkMode: !!app.store.get('settings').darkMode,
          // 只需要正文字号：改出来的「大一号」在纸上也是大一号（窗口不再算页数，纸宽高不用带）
          paper: { fontSize: app.engine.layout.fontSizePx }
        })
      );
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  /** 编辑器保存回来：有 itemId 就更新，没有就新建一条（纯文本 text 永远跟着 html 一起写） */
  app.applyRichSave = function (p) {
    if (!p) return;
    const html = NS.Rich.sanitize(p.html || '');
    const text = (NS.Rich.plain(html) || '').replace(/\s+/g, ' ').trim();
    const cl = app.store.get('checklists');
    const lists = cl.lists || [];
    const listId = p.listId || cl.activeListId;
    const list = lists.find((l) => l.id === listId);
    if (!list) {
      app.toast.warn('这个清单已经不在了，编辑内容没有保存');
      return;
    }
    const existing = p.itemId ? (list.items || []).find((i) => i.id === p.itemId) : null;
    if (existing) {
      patchLists(NS.ChecklistOps.updateItem(lists, listId, existing.id, { html, text: text || '（空）' }));
      app.toast.info('已保存到清单');
    } else {
      if (!html || !text) {
        app.toast.info('内容为空，没有新建条目');
        return;
      }
      patchLists(NS.ChecklistOps.addItem(lists, listId, text, html));
      app.toast.info('已新建条目');
    }
    if (app.router && app.router.current === 'checklist') app.router.persistProgress(true);
  };

  /** 清单循环浏览开关：和单词模式一样纸带无限（拉到底接回第一页） */
  app.setChecklistLoop = function (on) {
    app.applySettings({ checklistLoop: !!on });
    app.toast.info(on ? '清单已改为循环浏览' : '清单已改为到底为止');
  };

  /** 清单是否撕纸：开（默认）= 只滚动浏览，关 = 按撕纸阈值一张张撕 */
  app.setChecklistNoTear = function (on) {
    app.applySettings({ checklistNoTear: !!on });
    app.toast.info(on ? '清单已改为「不撕纸」：滚动浏览，往上滚能回到第一页' : '清单已改为「撕纸」：够阈值就撕掉，可回溯');
  };

  /** 清单自动序号：按添加顺序在纸面上标 1. 2. 3. */
  app.setChecklistNumbering = function (on) {
    app.applySettings({ checklistNumbering: !!on });
    app.toast.info(on ? '清单已自动编号（按添加顺序）' : '清单已取消自动编号');
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

  /**
   * 数据重置：'settings' 只恢复默认设置，'all' 清空全部本地数据。
   * 重置是磁盘操作，内存里还挂着旧的 Provider / 引擎状态，所以重置完直接重载界面
   * （比重建整条状态链更不容易漏），重载前先把待写数据落盘，避免旧值覆盖新默认值。
   */
  app.resetData = async function (scope) {
    const isAll = scope === 'all';
    const msg = isAll
      ? '确定清空全部本地数据吗？\n\n学习进度、标星/不显示词、阅读进度、清单内容、全部设置都会恢复默认。\n（已导入的文档与词库文件仍保留，可在对应分区里删除）\n\n此操作不可撤销。'
      : '确定把全部设置恢复默认值吗？\n\n缩放、黑夜模式、字号、撕纸阈值、快捷键、编辑窗口大小都会回到初始值；学习进度与清单不受影响。';
    if (!window.confirm(msg)) return;
    const scopes = isAll
      ? ['settings', 'learn', 'leisure', 'checklists', 'torn']
      : ['settings'];
    try {
      await app.store.flush();
      for (const s of scopes) await NS.call(petAPI.storeReset(s));
      if (app.tear) app.tear.setAutoTear({ enabled: false, pxPerSec: 20 });
      app.toast.info(isAll ? '已清空全部数据，正在重载界面…' : '已恢复默认设置，正在重载界面…');
      setTimeout(() => window.location.reload(), 700);
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
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
  // 设置面板 / 右键菜单要复用同一个弹窗，挂到 app 上（原先只在模块内可见）
  app.promptText = promptText;

  /**
   * 导入词库：预览 + 语言槽位勾选。
   * - 词表支持多语言（一行里有中文 / 日语…）：可以勾选要保留哪几种，名字可改；
   * - 只有一种释义语言：固定保留「词条 + 释义」两种，只让用户确认/改名字；
   * - 名字可以随便写（其他1 / 其他2 / 意大利语…），导入时会写进译文键。
   */
  function showDictPreview(preview, fileName) {
    return new Promise((resolve) => {
      const m = makeModal('导入词库');
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

      /* ---- 语言槽位 ---- */
      const rawSlots =
        Array.isArray(preview.langSlots) && preview.langSlots.length
          ? preview.langSlots
          : [
              {
                key: '__word__',
                label: (preview.languages && preview.languages[0]) || '英语',
                kind: 'word',
                fixed: true,
                count: preview.totalRows,
                sample: ''
              }
            ].concat(
              ((preview.defLanguages && preview.defLanguages.length ? preview.defLanguages : ['中文'])).map(
                (l, i) => ({ key: l, label: l, kind: 'def', base: i === 0, count: preview.totalRows, sample: '' })
              )
            );
      const multi = !!preview.multiLangSupported;

      const langHead = document.createElement('div');
      langHead.className = 'sp-hint';
      langHead.textContent = '这个词库包含的语言（可改名）';
      m.body.appendChild(langHead);

      const SUGGEST = ['英语', '中文', '日语', '韩语', '俄语', '法语', '德语', '西班牙语'];
      const listId = `dl_lang_${Date.now().toString(36)}`;
      const datalist = document.createElement('datalist');
      datalist.id = listId;
      m.body.appendChild(datalist);
      const fillSuggest = (extra) => {
        datalist.innerHTML = '';
        for (const v of [...new Set([...SUGGEST, ...extra].filter(Boolean))]) {
          const o = document.createElement('option');
          o.value = v;
          datalist.appendChild(o);
        }
      };
      fillSuggest(['其他1', '其他2']);

      const box = document.createElement('div');
      box.className = 'imp-lang-box';
      m.body.appendChild(box);

      const slots = rawSlots.map((s) => ({
        key: s.key,
        kind: s.kind === 'word' || s.key === '__word__' ? 'word' : 'def',
        base: !!s.base,
        fixed: !!s.fixed,
        count: s.count || 0,
        sample: s.sample || ''
      }));

      const getNames = () => slots.map((s) => String(s.input ? s.input.value : '').trim());
      const nextOther = () => {
        const used = new Set(getNames());
        for (let i = 1; i <= 20; i++) if (!used.has(`其他${i}`)) return `其他${i}`;
        return `其他${slots.filter((s) => s.kind === 'def').length + 1}`;
      };

      for (const s of slots) {
        const row = document.createElement('div');
        row.className = 'imp-lang-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        // 只有一种释义语言时没有「勾掉」的余地：两种语言都必须留
        cb.disabled = !multi || s.fixed;
        s.checked = true;
        cb.addEventListener('change', () => {
          s.checked = cb.checked;
        });
        row.appendChild(cb);

        const tag = document.createElement('span');
        tag.className = 'imp-lang-tag';
        tag.textContent = s.kind === 'word' ? '词条' : '释义';
        row.appendChild(tag);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'imp-lang-name';
        input.setAttribute('list', listId);
        input.value = (rawSlots.find((r) => r.key === s.key) || {}).label || '';
        s.input = input;
        row.appendChild(input);

        if (s.kind === 'def') {
          const otherBtn = document.createElement('button');
          otherBtn.className = 'btn imp-lang-other';
          otherBtn.textContent = '其他';
          otherBtn.title = '改成「其他1 / 其他2…」，也可以直接在左边输入自定义语言名';
          otherBtn.addEventListener('click', () => {
            input.value = nextOther();
            fillSuggest(slots.filter((x) => x.input).map((x) => x.input.value.trim()));
          });
          row.appendChild(otherBtn);
        } else {
          row.appendChild(document.createElement('span')).className = 'imp-lang-other';
        }

        const meta = document.createElement('span');
        meta.className = 'imp-lang-meta';
        const sample = String(s.sample || '').replace(/\s+/g, ' ').slice(0, 16);
        meta.textContent = sample ? `${sample} · ${s.count} 条` : `${s.count} 条`;
        row.appendChild(meta);

        box.appendChild(row);
      }

      const note = document.createElement('div');
      note.className = 'sp-hint';
      note.textContent = multi
        ? '这个词表一行里有多种语言，勾掉的语言不会导入；「其他」可连续点，依次得到其他1、其他2。'
        : '这个词表每行只有一种释义语言，两种语言都会保留（词条 / 释义），名字可改；语言不在列表里就点「其他」或直接输入。';
      m.body.appendChild(note);

      const errEl = document.createElement('div');
      errEl.className = 'sp-hint imp-lang-err';
      m.body.appendChild(errEl);

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
      ok.addEventListener('click', () => {
        const plan = slots
          .filter((s) => s.checked)
          .map((s) => ({ key: s.key, name: String(s.input.value || '').trim(), base: s.base }));
        const defs = plan.filter((p) => p.key !== '__word__');
        const fail = (msg) => {
          errEl.textContent = msg;
        };
        if (!plan.some((p) => p.key === '__word__')) return fail('必须保留词条列');
        if (!defs.length) return fail('至少要保留一种释义语言');
        if (plan.some((p) => !p.name)) return fail('语言名不能为空');
        const low = plan.map((p) => p.name.toLowerCase());
        if (new Set(low).size !== low.length) {
          return fail('上下两行不能是同一种语言：改个名字，或用「其他1 / 其他2」区分');
        }
        done({
          name: nameInput.value.trim() || '导入词库',
          langPlan: plan,
          wordLang: plan.find((p) => p.key === '__word__').name,
          defLang: defs[0].name
        });
      });
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
      // key 是词条主键（不随语言变），label 是纸面上此刻显示的文本
      const key = hit.paper.id;
      const label = hit.paper.word;
      const hidden = app.providers.learn.isHidden(key);
      items.push({
        label: hidden ? `恢复显示「${NS.truncate(label, 12)}」` : `不显示「${NS.truncate(label, 12)}」`,
        icon: '🚫',
        hint: app.keyHint('toggleHidden'),
        onClick: () => app.toggleHidden(key)
      });
      items.push({
        label: hit.paper.starred ? '取消标星' : '标星（难点词）',
        icon: '★',
        hint: app.keyHint('toggleStar'),
        onClick: () => app.toggleStar(key)
      });
      // 语言对调：不开设置面板也能一键把上下互换（只有一种语言时置灰）
      const lp = app.providers.learn;
      const canSwap = !!(lp.defLang && lp.langLabel && lp.defLang !== lp.langLabel);
      items.push({
        label: '交换上下语言',
        icon: '⇄',
        hint: canSwap ? `${lp.langLabel} ⇄ ${lp.defLang}` : '',
        disabled: !canSwap,
        onClick: () => app.swapDictLang()
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
            label: '高级编辑…',
            icon: '📝',
            hint: '独立窗口',
            onClick: () => app.editItemRich(itemId)
          });
          items.push({
            label: '修改文字…',
            icon: '✎',
            onClick: () => app.editItemText(itemId)
          });
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
        // 清单：右键就能在「撕纸 / 不撕纸」之间切换（默认不撕，只滚动浏览）
        const noTear = app.store.get('settings').checklistNoTear !== false;
        items.push({
          label: noTear ? '改成撕纸（够阈值才撕）' : '改成不撕纸（滚动浏览）',
          icon: noTear ? '✂' : '☰',
          hint: noTear ? '当前：滚动' : '当前：撕纸',
          onClick: () => app.setChecklistNoTear(!noTear)
        });
        // 清单：不开设置面板也能切换自动序号（勾选后纸面按添加顺序标 1. 2. 3.）
        const numberingOn = !!app.store.get('settings').checklistNumbering;
        items.push({
          label: numberingOn ? '取消自动序号' : '自动序号（1. 2. 3.）',
          icon: numberingOn ? '☑' : '☐',
          onClick: () => app.setChecklistNumbering(!numberingOn)
        });
        items.push({ sep: true });
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
        onTear: () => {
          app.router && app.router.persistProgress(true);
          syncTrayDepth();
        },
        onBacktrack: () => {
          app.router && app.router.persistProgress(true);
          syncTrayDepth();
        },
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
    // 切模式后栈内容换成了该模式自己的一份，托盘要跟着刷新
    router.onModeChanged(() => syncTrayDepth());

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
      if (btn.dataset.act === 'star') app.toggleStar(paper.id);
      else if (btn.dataset.act === 'hide') app.toggleHidden(paper.id);
    });

    // 清单：双击某一条直接进富文本编辑窗口（拖纸不会误触发，双击才是编辑）
    viewport.addEventListener('dblclick', (e) => {
      if (router.current !== 'checklist') return;
      const row = e.target && e.target.closest ? e.target.closest('.cl-item') : null;
      if (!row || !row.dataset.itemId) return;
      e.preventDefault();
      e.stopPropagation();
      app.editItemRich(row.dataset.itemId);
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
            const nowHidden = app.toggleHidden(p.id);
            toast.info(
              nowHidden ? `已不显示「${p.word}」，可在设置中心恢复` : `已恢复显示「${p.word}」`
            );
          } else {
            const nowStarred = app.toggleStar(p.id);
            toast.info(nowStarred ? `已标星「${p.word}」` : `已取消标星「${p.word}」`);
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

    // 独立编辑窗口保存后由主进程回传（编辑器在另一个渲染进程里，不共享 store）
    petAPI.onChecklistSave((p) => {
      try {
        app.applyRichSave(p);
      } catch (err) {
        toast.error(NS.errorText(err));
      }
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
    syncTrayDepth();
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
        if (p.kind === 'word') return `word:${p.id}`;
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
