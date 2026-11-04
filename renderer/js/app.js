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
      autoTear.enabled
        ? NS.t('toast.autoTear.on', { v: autoTear.pxPerSec })
        : NS.t('toast.autoTear.off')
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
      app.toast.info(NS.t('toast.mode.switched', { mode: NS.modeLabel(mode) }));
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
      app.toast.info(NS.t('toast.dict.switched'));
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  /** 重置当前词库的学习进度：回到第一张纸并清空本次运行的回溯栈（标星/不显示不动） */
  app.resetLearnProgress = async function () {
    const ok = window.confirm(
      NS.t('dialog.learn.reset')
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
      app.toast.info(NS.t('toast.learn.reset'));
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
    const label = meta ? NS.I18N.dictName(meta.name) : NS.t('tip.thatDict');
    const ok = window.confirm(NS.t('dialog.dict.remove', { name: label }));
    if (!ok) return;
    try {
      await NS.call(petAPI.dictRemove(dictId));
      app.toast.info(NS.t('toast.dict.removed', { name: label }));
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
      if (!silent)
        app.toast.info(
          NS.t('toast.lang.applied', {
            pair: `${NS.I18N.langName(meta.wordLang)}${
              meta.defLang ? ` / ${NS.I18N.langName(meta.defLang)}` : ''
            }`
          })
        );
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
    if (same && !silent)
      app.toast.info(
        NS.t('toast.lang.refreshed', {
          pair: `${NS.I18N.langName(w)}${d ? ` / ${NS.I18N.langName(d)}` : ''}`
        })
      );
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
        app.toast.info(NS.t('toast.lang.oneOnly'));
        return false;
      }
      const ok = await app.applyDictLang(id, w, d, { silent: true });
      if (ok)
        app.toast.info(
          NS.t('toast.lang.swapped', { w: NS.I18N.langName(w), d: NS.I18N.langName(d) })
        );
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
      app.toast.info(NS.t('toast.dict.parsing'));
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
      app.toast.info(NS.t('toast.dict.imported', { n: res.count }));
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
      app.toast.info(NS.t('toast.doc.parsing'));
      const res = await NS.call(petAPI.importParse(file.filePath, 'leisure'));
      if (!res || res.kind !== 'doc') return;
      const leisure = app.store.get('leisure');
      const docs = (leisure.docs || []).filter((d) => d.docId !== res.docId);
      docs.push({ docId: res.docId, name: res.name, importedAt: Date.now() });
      const progress = Object.assign({}, leisure.progress, { [res.docId]: 0 });
      app.store.patch('leisure', { docs, activeDocId: res.docId, progress }, { critical: true });
      app.store.patch('torn', { leisure: { headIndex: 0, stack: [] } }, { critical: true });
      app.toast.info(
        NS.t('toast.doc.imported', { n: res.blockCount, p: res.placeholderCount })
      );
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
    if (!window.confirm(NS.t('dialog.doc.remove', { name: doc ? doc.name : docId }))) return;
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
    const name = await promptText(NS.t('dialog.list.newTitle'), NS.t('dialog.list.defaultName'));
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
    const name = await promptText(NS.t('dialog.list.renameTitle'), cur.name);
    if (!name) return;
    patchLists(NS.ChecklistOps.renameList(cl.lists, cur.id, name));
  };

  app.removeList = async function () {
    const cl = app.store.get('checklists');
    if (cl.lists.length <= 1) {
      app.toast.warn(NS.t('toast.cl.keepOne'));
      return;
    }
    const cur = cl.lists.find((l) => l.id === cl.activeListId);
    if (!cur || !window.confirm(NS.t('dialog.cl.remove', { name: cur.name }))) return;
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

  /** 主页面正在显示的那份清单 */
  function activeList() {
    const cl = app.store.get('checklists');
    return (cl.lists || []).find((l) => l.id === cl.activeListId) || (cl.lists || [])[0] || null;
  }

  /** 点方框打勾（也供右键菜单用）：返回切换后的状态，条目不在就返回 null */
  app.toggleDone = function (itemId) {
    const list = activeList();
    const item = list ? (list.items || []).find((i) => i.id === itemId) : null;
    if (!item) return null;
    app.updateItem(itemId, { done: !item.done });
    return !item.done;
  };

  /** 条目星标：勾选框旁边会挂一颗行内小 ★ */
  app.toggleItemStar = function (itemId) {
    const list = activeList();
    const item = list ? (list.items || []).find((i) => i.id === itemId) : null;
    if (!item) return;
    const cl = app.store.get('checklists');
    patchLists(NS.ChecklistOps.toggleStar(cl.lists, cl.activeListId, itemId));
    app.toast.info(NS.t(item.starred ? 'toast.word.unstarred' : 'toast.word.starred'));
  };

  /* ---------------- 清单导入导出（v2.8，仅本系统清单） ---------------- */

  /** 把导入来的清单补齐 id（旧文件 / 手改文件可能缺 id 或撞 id） */
  function ensureListIds(list) {
    const copy = Object.assign({}, list, { id: list.id || NS.uid('list'), items: [] });
    for (const it of list.items || []) {
      const c = Object.assign({}, it, { id: it.id || NS.uid('item') });
      if (Array.isArray(c.notes)) c.notes = c.notes.map((n) => Object.assign({}, n, { id: n.id || NS.uid('note') }));
      copy.items.push(c);
    }
    return copy;
  }

  /** 导出当前全部清单为一个 JSON 备份文件（系统弹保存框选位置） */
  app.exportChecklists = async function () {
    try {
      const res = await NS.call(petAPI.checklistExport());
      if (!res || res.canceled) return;
      app.toast.info(NS.t('toast.cl.exported', { n: res.count }));
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  /** 从 JSON 备份文件导入清单：追加到现有清单后面，绝不覆盖已有内容 */
  app.importChecklists = async function () {
    let res;
    try {
      res = await NS.call(petAPI.checklistImport());
    } catch (err) {
      app.toast.error(NS.errorText(err));
      return;
    }
    if (!res || res.canceled) return;
    const cl = app.store.get('checklists');
    const existIds = new Set(cl.lists.map((l) => l.id));
    const incoming = [];
    for (const raw of res.lists || []) {
      const list = ensureListIds(raw);
      // 和现有清单撞 id 的（重复导入同一份文件）：换个新 id，两条都保留
      if (existIds.has(list.id)) list.id = NS.uid('list');
      existIds.add(list.id);
      incoming.push(list);
    }
    if (!incoming.length) {
      app.toast.warn(NS.t('toast.cl.noImport'));
      return;
    }
    const merged = NS.ChecklistOps.normalize(cl.lists.concat(incoming)) || cl.lists.concat(incoming);
    patchLists(merged, { activeListId: incoming[0].id });
    app.engine.setTop(0, { shift: 0 });
    app.toast.info(NS.t('toast.cl.imported', { n: incoming.length }));
  };

  /**
   * 随记便签卡的开合（只有「点击后显示」的随记才有卡）。
   * 卡片是画在纸面里的绝对定位浮层，不参与排版 —— 所以开合不会把纸撑破、也不会跳页。
   * @param {Element|string} target 点中的标签元素（纸带里同时存在多张纸，按元素就近找卡片）
   */
  app.toggleNoteCard = function (target, force, auto) {
    const el = typeof target === 'string' ? null : target;
    const noteId = el && el.dataset ? el.dataset.noteId : String(target || '');
    if (!noteId) return false;
    const page = el && el.closest ? el.closest('.checklist-page') : null;
    const scope = page || viewport;
    let card = null;
    scope.querySelectorAll('.cl-note-card').forEach((c) => {
      if (c.dataset.noteId === noteId) card = c;
    });
    // 同一时刻只开一张：别的卡片（含其它纸页上的副本）一律收起
    viewport.querySelectorAll('.cl-note-card').forEach((c) => {
      if (c !== card) c.classList.remove('open', 'pinned');
    });
    if (!card) return false;
    const open = typeof force === 'boolean' ? force : !card.classList.contains('open');
    card.classList.toggle('open', open);
    // pinned：点开的卡片不跟着鼠标移开就消失；悬停（auto）出来的才会自动收起
    card.classList.toggle('pinned', open && !auto);
    return open;
  };

  /**
   * 悬停随记的小气泡：贴在标签下方的一个轻量提示条（不是便签卡 —— 悬停只是瞄一眼，
   * 不值得盖住半张纸）。不参与排版，鼠标离开标签 / 气泡或纸面就收起。
   */
  app.showNoteTip = function (chip, on) {
    const page = chip && chip.closest ? chip.closest('.checklist-page') : null;
    if (!page) return;
    let tip = page.querySelector('.cl-note-tip');
    if (!on) {
      if (tip) tip.classList.remove('on');
      return;
    }
    const list = activeList();
    const item = list ? (list.items || []).find((i) => i.id === chip.dataset.itemId) : null;
    const note = item ? NS.ChecklistOps.notesOf(item).find((n) => n.id === chip.dataset.noteId) : null;
    if (!note) return;
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'cl-note-tip';
      // 气泡自己也会在移出时收起（从标签移进气泡的那段路不算离开）
      tip.addEventListener('pointerleave', () => tip.classList.remove('on'));
      page.appendChild(tip);
    }
    tip.innerHTML = NS.Rich.plainToHtml(note.text);
    tip.classList.add('on');
    // 先摆到左缘量宽度，再夹回纸面内
    tip.style.left = '0px';
    tip.style.top = `${chip.offsetTop + chip.offsetHeight + 3}px`;
    const maxLeft = Math.max(4, page.clientWidth - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, Math.min(chip.offsetLeft, maxLeft))}px`;
  };

  app.countChecklistMarks = function (scope) {
    const list = activeList();
    if (!list) return 0;
    return NS.ChecklistOps.countMarks(app.store.get('checklists').lists, list.id, scope);
  };

  /**
   * 清除主页面上做的操作痕迹（条目文字保留）：
   *   scope 'done' = 只取消勾选
   *   scope 'page' = 只去掉「在纸面上」设的格式（右键菜单的加粗 / 颜色 / 划线）
   * 高级编辑窗口里排的版（html）、勾选状态、随记都不动 —— 那些不是「页面格式」。
   * opts.auto = 定时触发：不弹确认、不打扰（结果只用 toast 说一句）
   */
  app.clearChecklistMarks = function (scope, opts) {
    const o = opts || {};
    const list = activeList();
    if (!list) return 0;
    const mode = scope === 'done' ? 'done' : 'page';
    const n = NS.ChecklistOps.countMarks(app.store.get('checklists').lists, list.id, mode);
    if (!n) {
      if (!o.auto && !o.silent) app.toast.info(NS.t('toast.cl.noMarks'));
      return 0;
    }
    if (!o.auto && !o.silent) {
      const msg =
        mode === 'done'
          ? NS.t('dialog.cl.clearDone', { name: list.name, n })
          : NS.t('dialog.cl.clearPage', { name: list.name, n });
      if (!window.confirm(msg)) return 0;
    }
    const res = NS.ChecklistOps.clearMarks(app.store.get('checklists').lists, list.id, mode);
    // 定时清除可能在别的模式里触发：那时不要去动当前模式的纸（engine.setTop 会重建正在看的那张）
    if (app.router && app.router.current !== 'checklist') {
      app.store.patch('checklists', { lists: res.lists }, { critical: true });
      app.providers.checklist.setState(app.store.get('checklists'));
      if (app.settings) app.settings.refresh();
    } else {
      patchLists(res.lists);
    }
    if (!o.silent) {
      app.toast.info(
        NS.t(mode === 'done' ? 'toast.cl.clearedDone' : 'toast.cl.clearedPage', {
          n: res.changed
        })
      );
    }
    return res.changed;
  };

  /* ---------------- 定时清除 ---------------- */

  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  /** 'HH:MM' → 当天第几分钟；非法返回 null */
  function timeToMinutes(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
    return h * 60 + mi;
  }

  /**
   * 到点就清一次（每 30 秒巡检，启动时也补一次）。
   * 三个条件都满足才动手，确保「同一天只清一次」「还没到点不清」「刚打开开关不会被立刻清空」。
   */
  app.checkAutoClear = function () {
    const s = app.store.get('settings');
    const cfg = (s && s.checklistAutoClear) || {};
    if (!cfg.enabled) return false;
    const now = new Date();
    const today = dayKey(now);
    if (cfg.lastDate === today) return false; // 今天已经清过
    const at = timeToMinutes(cfg.time);
    if (at == null) return false;
    const sched = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(at / 60), at % 60, 0, 0);
    if (now < sched) return false; // 还没到点
    // 今天才打开这个开关、而设定时刻已经过去：今天不补清，从明天那一轮开始
    const since = Number(cfg.enabledAt) || 0;
    if (since && since > sched.getTime()) return false;
    const changed = app.clearChecklistMarks(cfg.scope === 'done' ? 'done' : 'page', { auto: true });
    app.store.patch('settings', { checklistAutoClear: { lastDate: today } }, { critical: true });
    if (changed) app.toast.info(NS.t('toast.cl.autoCleared', { n: changed, time: cfg.time }));
    return true;
  };

  /** 改定时清除的配置（开关 / 时间 / 范围） */
  app.setAutoClear = function (patch) {
    const s = app.store.get('settings');
    const cur = Object.assign(
      { enabled: false, time: '06:00', scope: 'page', lastDate: '', enabledAt: 0 },
      s.checklistAutoClear || {}
    );
    const next = Object.assign({}, cur, patch || {});
    // 从关到开记一个时刻：避免「上午设晚上 6 点」之外的「刚开启就被补清」错觉
    if (patch && 'enabled' in patch && patch.enabled && !cur.enabled) next.enabledAt = Date.now();
    if (next.time && timeToMinutes(next.time) == null) next.time = '06:00';
    // 老版本存的是 'marks'（会连富文本一起清），现在只有「只清勾选 / 清页面格式」两档
    next.scope = next.scope === 'done' ? 'done' : 'page';
    app.store.patch('settings', { checklistAutoClear: next }, { critical: true });
    if (app.settings && app.settings.isOpen) app.settings.refresh();
  };

  app.startAutoClearTimer = function () {
    if (app._autoClearTimer) clearInterval(app._autoClearTimer);
    app._autoClearTimer = setInterval(() => {
      try {
        app.checkAutoClear();
      } catch (err) {
        console.error('[checklist] 定时清除失败', err);
      }
    }, 30 * 1000);
    // 启动补做：昨天该清而没清（程序当时没开着）的，进来就补一次
    setTimeout(() => {
      try {
        app.checkAutoClear();
      } catch {
        /* ignore */
      }
    }, 1500);
  };

  /** 改条目文字：设置面板双击、纸上右键菜单都走这里（空文本视为取消，不允许把条目改成空） */
  app.editItemText = async function (itemId) {
    const cl = app.store.get('checklists');
    const list = (cl.lists || []).find((l) => l.id === cl.activeListId);
    const item = list ? (list.items || []).find((i) => i.id === itemId) : null;
    if (!item) return;
    const next = await promptText(NS.t('dialog.item.editTitle'), item.text);
    if (next == null) return;
    const text = String(next).trim();
    if (!text || text === item.text) return;
    // 改成纯文本后旧富文本就作废了，否则纸面还会按 html 画（与列表里的文字对不上）
    app.updateItem(itemId, { text, html: '' });
  };

  /**
   * 随记：给某一条写备注，**可以挂多条**，每条各自选显示方式
   * （直接显示 / 点击后显示 / 悬停显示）。弹窗里整组编辑：每条一块，
   * 可加可删，保存时一次写回。
   */
  app.editItemNote = async function (itemId) {
    const list = activeList();
    const item = list ? (list.items || []).find((i) => i.id === itemId) : null;
    if (!item) return;
    const res = await promptNotes(item);
    if (!res) return;
    const cl = app.store.get('checklists');
    const before = NS.ChecklistOps.notesOf(item);
    const lists = NS.ChecklistOps.setNotes(cl.lists, cl.activeListId, itemId, res.notes);
    patchLists(lists);
    const n = res.notes.length;
    if (!n && before.length) app.toast.info(NS.t('toast.note.deleted'));
    else if (!n) app.toast.info(NS.t('toast.note.nothing'));
    else app.toast.info(NS.t('toast.note.saved', { n }));
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
          listName: list ? list.name : NS.t('paper.defaultListName'),
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
      app.toast.warn(NS.t('toast.cl.gone'));
      return;
    }
    const existing = p.itemId ? (list.items || []).find((i) => i.id === p.itemId) : null;
    if (existing) {
      patchLists(
        NS.ChecklistOps.updateItem(lists, listId, existing.id, {
          html,
          text: text || NS.t('paper.emptyItem')
        })
      );
      app.toast.info(NS.t('toast.cl.saved'));
    } else {
      if (!html || !text) {
        app.toast.info(NS.t('toast.cl.noContent'));
        return;
      }
      patchLists(NS.ChecklistOps.addItem(lists, listId, text, html));
      app.toast.info(NS.t('toast.cl.created'));
    }
    if (app.router && app.router.current === 'checklist') app.router.persistProgress(true);
  };

  /** 清单循环浏览开关：和单词模式一样纸带无限（拉到底接回第一页） */
  app.setChecklistLoop = function (on) {
    app.applySettings({ checklistLoop: !!on });
    app.toast.info(NS.t(on ? 'toast.cl.loopOn' : 'toast.cl.loopOff'));
  };

  /** 清单是否撕纸：开（默认）= 只滚动浏览，关 = 按撕纸阈值一张张撕 */
  app.setChecklistNoTear = function (on) {
    app.applySettings({ checklistNoTear: !!on });
    app.toast.info(NS.t(on ? 'toast.cl.noTearOn' : 'toast.cl.noTearOff'));
  };

  /** 清单自动序号：按添加顺序在纸面上标 1. 2. 3. */
  app.setChecklistNumbering = function (on) {
    app.applySettings({ checklistNumbering: !!on });
    app.toast.info(NS.t(on ? 'toast.cl.numberingOn' : 'toast.cl.numberingOff'));
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

  /**
   * 换界面语言：
   *   1) 存偏好的语言（'auto' 或具体语种）→ 主进程收到 store:patch 会重建托盘；
   *   2) 渲染层立刻换词典并重绘（设置面板 / 右键菜单 / 说明窗口）；
   *   3) 只换界面文字，纸面上的词、文章、清单一个字都不动。
   */
  app.setLocale = function (pref) {
    const p = pref || 'auto';
    app.store.patch('settings', { locale: p }, { critical: true });
    const sysLocale = (app.info && app.info.systemLocale) || '';
    NS.I18N.setLocale(p, sysLocale);
    if (app.settings) app.settings.refresh();
    app.toast.info(NS.t('toast.lang.changed'));
  };

  app.openUserData = function () {
    petAPI.openUserData();
  };

  /* ---------------- 功能说明（v3：分级讲解，文案在语言包里） ---------------- */

  app.showGuide = function () {
    if (!app.guide) return;
    app.guide.open({ version: (app.info && app.info.version) || '' });
  };

  /**
   * 开机自启动：真正写系统启动项的是主进程，这里只负责解包 + 提示。
   * 返回主进程回读到的真实状态（界面拿它回填开关，不靠乐观值）。
   */
  app.setAutoLaunch = async function (enabled) {
    const st = await NS.call(petAPI.setAutoLaunch(enabled));
    if (app.toast) {
      if (st && st.blocked) {
        app.toast.warn(NS.t('toast.autoLaunch.blocked'));
      } else if (st && st.enabled) {
        app.toast.info(NS.t('toast.autoLaunch.on'));
      } else {
        app.toast.info(NS.t('toast.autoLaunch.off'));
      }
    }
    return st;
  };

  /** 打开系统的「启动应用」设置页（被安全软件 / 系统启动项管理禁用时去那里放行） */
  app.openStartupSettings = async function () {
    try {
      await NS.call(petAPI.openStartupSettings());
    } catch (err) {
      app.toast.error(NS.errorText(err));
    }
  };

  /**
   * 数据重置：'settings' 只恢复默认设置，'all' 清空全部本地数据。
   * 重置是磁盘操作，内存里还挂着旧的 Provider / 引擎状态，所以重置完直接重载界面
   * （比重建整条状态链更不容易漏），重载前先把待写数据落盘，避免旧值覆盖新默认值。
   */
  app.resetData = async function (scope) {
    const isAll = scope === 'all';
    const msg = isAll
      ? NS.t('dialog.data.clearAll')
      : NS.t('dialog.data.resetSettings');
    if (!window.confirm(msg)) return;
    const scopes = isAll
      ? ['settings', 'learn', 'leisure', 'checklists', 'torn']
      : ['settings'];
    try {
      await app.store.flush();
      for (const s of scopes) await NS.call(petAPI.storeReset(s));
      if (app.tear) app.tear.setAutoTear({ enabled: false, pxPerSec: 20 });
      app.toast.info(NS.t(isAll ? 'toast.data.cleared' : 'toast.data.reset'));
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
      ok.textContent = NS.t('common.ok');
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = NS.t('common.cancel');
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
   * 随记弹窗（多条管理）：已有随记一条一块（文字 + 显示方式 + 删除），
   * 「再加一条」随时追加，保存时统一写回。
   * @returns {Promise<{notes:Array<{id?:string,text:string,mode:string}>}|null>} null = 取消
   */
  function promptNotes(item) {
    return new Promise((resolve) => {
      const existing = NS.ChecklistOps.notesOf(item);
      const m = makeModal(
        existing.length ? NS.t('notes.title', { n: existing.length }) : NS.t('notes.titleNew')
      );
      const rows = [];
      const MODES = [
        { v: 'always', label: NS.t('notes.mode.always'), tip: NS.t('notes.mode.alwaysTip') },
        { v: 'click', label: NS.t('notes.mode.click'), tip: NS.t('notes.mode.clickTip') },
        { v: 'hover', label: NS.t('notes.mode.hover'), tip: NS.t('notes.mode.hoverTip') }
      ];
      const wrap = document.createElement('div');
      wrap.className = 'note-list';
      m.body.appendChild(wrap);

      const addRow = (note) => {
        const row = document.createElement('div');
        row.className = 'note-row';
        // 已有的随记把 id 记在行上，保存时原样带回（保住便签卡的对应关系）
        if (note && note.id) row.dataset.existingId = note.id;
        const ta = document.createElement('textarea');
        ta.className = 'note-input';
        ta.rows = 2;
        ta.placeholder = NS.t('notes.placeholder');
        ta.value = note ? String(note.text || '') : '';
        ta.addEventListener('keydown', (e) => e.stopPropagation());
        row.appendChild(ta);

        const modeWrap = document.createElement('div');
        modeWrap.className = 'note-modes';
        const mode = note && note.mode ? note.mode : 'always';
        for (const opt of MODES) {
          const lab = document.createElement('label');
          lab.className = 'note-mode';
          lab.title = opt.tip;
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = `note-mode-${rows.length}`;
          radio.value = opt.v;
          radio.checked = opt.v === mode;
          const span = document.createElement('span');
          span.textContent = opt.label;
          lab.appendChild(radio);
          lab.appendChild(span);
          modeWrap.appendChild(lab);
        }
        row.appendChild(modeWrap);

        const btnDel = document.createElement('button');
        btnDel.className = 'btn sm danger';
        btnDel.textContent = NS.t('common.delete');
        btnDel.title = NS.t('notes.deleteTitle');
        btnDel.addEventListener('click', () => row.remove());
        row.appendChild(btnDel);

        wrap.appendChild(row);
        rows.push(row);
        if (rows.length === 1) setTimeout(() => ta.focus(), 30);
      };
      for (const n of existing) addRow(n);
      if (!existing.length) addRow(null);

      const btnAdd = document.createElement('button');
      btnAdd.className = 'btn sm';
      btnAdd.textContent = NS.t('notes.add');
      btnAdd.addEventListener('click', () => addRow(null));
      m.body.appendChild(btnAdd);

      const btnSave = document.createElement('button');
      btnSave.className = 'btn primary';
      btnSave.textContent = NS.t('common.save');
      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn';
      btnCancel.textContent = NS.t('common.cancel');
      const done = (v) => {
        m.close();
        resolve(v);
      };
      m.foot.appendChild(btnCancel);
      m.foot.appendChild(btnSave);
      btnSave.addEventListener('click', () => {
        const notes = [];
        for (const row of rows) {
          if (!row.isConnected) continue; // 被删掉的块不收
          const ta = row.querySelector('.note-input');
          const text = String(ta.value || '').trim();
          if (!text) continue;
          const radio = row.querySelector('.note-modes input:checked');
          notes.push({ id: row.dataset.existingId || undefined, text, mode: radio ? radio.value : 'always' });
        }
        done({ notes });
      });
      btnCancel.addEventListener('click', () => done(null));
      m.mask.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') done(null);
      });
    });
  }

  /**
   * 导入词库：预览 + 语言槽位勾选。
   * - 词表支持多语言（一行里有中文 / 日语…）：可以勾选要保留哪几种，名字可改；
   * - 只有一种释义语言：固定保留「词条 + 释义」两种，只让用户确认/改名字；
   * - 名字可以随便写（其他1 / 其他2 / 意大利语…），导入时会写进译文键。
   */
  function showDictPreview(preview, fileName) {
    return new Promise((resolve) => {
      const m = makeModal(NS.t('import.title'));
      const total = document.createElement('div');
      total.className = 'sp-hint';
      total.textContent = NS.t('import.summary', {
        n: preview.totalRows,
        m: preview.previewRows.length
      });
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
      nameLabel.textContent = NS.t('import.nameLabel');
      m.body.appendChild(nameLabel);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = String(fileName || NS.t('import.defaultName')).replace(/\.[^.]+$/, '');
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
      langHead.textContent = NS.t('import.langHead');
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
        tag.textContent = s.kind === 'word' ? NS.t('import.tag.word') : NS.t('import.tag.def');
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
          otherBtn.textContent = NS.t('import.other');
          otherBtn.title = NS.t('import.otherTitle');
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
        meta.textContent = sample
          ? NS.t('import.meta', { sample, n: s.count })
          : NS.t('import.metaPlain', { n: s.count });
        row.appendChild(meta);

        box.appendChild(row);
      }

      const note = document.createElement('div');
      note.className = 'sp-hint';
      note.textContent = multi
        ? NS.t('import.hintMulti')
        : NS.t('import.hintSingle');
      m.body.appendChild(note);

      const errEl = document.createElement('div');
      errEl.className = 'sp-hint imp-lang-err';
      m.body.appendChild(errEl);

      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = NS.t('common.cancel');
      const ok = document.createElement('button');
      ok.className = 'btn primary';
      ok.textContent = NS.t('common.import');
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
        if (!plan.some((p) => p.key === '__word__')) return fail(NS.t('import.err.keepWord'));
        if (!defs.length) return fail(NS.t('import.err.needDef'));
        if (plan.some((p) => !p.name)) return fail(NS.t('import.err.emptyName'));
        const low = plan.map((p) => p.name.toLowerCase());
        if (new Set(low).size !== low.length) {
          return fail(NS.t('import.err.sameLang'));
        }
        done({
          name: nameInput.value.trim() || NS.t('import.defaultName'),
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
        label: hidden
          ? NS.t('menu.restoreWord', { w: NS.truncate(label, 12) })
          : NS.t('menu.hideWord', { w: NS.truncate(label, 12) }),
        icon: '🚫',
        hint: app.keyHint('toggleHidden'),
        onClick: () => app.toggleHidden(key)
      });
      items.push({
        label: hit.paper.starred ? NS.t('menu.unstarWord') : NS.t('menu.starWord'),
        icon: '★',
        hint: app.keyHint('toggleStar'),
        onClick: () => app.toggleStar(key)
      });
      // 语言对调：不开设置面板也能一键把上下互换（只有一种语言时置灰）
      const lp = app.providers.learn;
      const canSwap = !!(lp.defLang && lp.langLabel && lp.defLang !== lp.langLabel);
      items.push({
        label: NS.t('menu.swapLangs'),
        icon: '⇄',
        hint: canSwap
          ? `${NS.I18N.langName(lp.langLabel)} ⇄ ${NS.I18N.langName(lp.defLang)}`
          : '',
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
            label: item.done ? NS.t('menu.unmarkDone') : NS.t('menu.markDone'),
            icon: '✓',
            onClick: () => app.updateItem(itemId, { done: !item.done })
          });
          items.push({
            label: item.starred ? NS.t('menu.unstar') : NS.t('menu.star'),
            icon: '★',
            hint: item.starred ? NS.t('menu.starredHint') : '',
            onClick: () => app.toggleItemStar(itemId)
          });
          items.push({ sep: true });
          // 颜色收进二级菜单：条目菜单本来就有十来项，五档颜色平铺会把「随记 / 编辑」挤到屏幕外
          const COLOR_PRESETS = [
            { v: '', key: 'menu.color.default' },
            { v: '#dc2626', key: 'menu.color.red' },
            { v: '#2563eb', key: 'menu.color.blue' },
            { v: '#16a34a', key: 'menu.color.green' },
            { v: '#d97706', key: 'menu.color.orange' }
          ];
          const curColor = style.color || '';
          const curPreset = COLOR_PRESETS.find((c) => (c.v || '') === curColor) || COLOR_PRESETS[0];
          items.push({
            label: NS.t('menu.color'),
            icon: '●',
            hint: NS.t(curPreset.key),
            children: COLOR_PRESETS.map((c) => ({
              label: NS.t(c.key),
              icon: (c.v || '') === curColor ? '●' : '',
              onClick: () =>
                app.updateItem(itemId, { style: Object.assign({}, style, { color: c.v || undefined }) })
            }))
          });
          items.push({
            label: style.bold ? NS.t('menu.unbold') : NS.t('menu.bold'),
            icon: 'B',
            onClick: () =>
              app.updateItem(itemId, { style: Object.assign({}, style, { bold: !style.bold }) })
          });
          items.push({
            label: style.strike ? NS.t('menu.unstrike') : NS.t('menu.strike'),
            icon: 'S',
            onClick: () =>
              app.updateItem(itemId, { style: Object.assign({}, style, { strike: !style.strike }) })
          });
          // 随记：这一条可以挂多条，每条各自选显示方式（直接显示 / 点击后 / 悬停）
          const notes = NS.ChecklistOps.notesOf(item);
          items.push({
            label: notes.length ? NS.t('menu.notes', { n: notes.length }) : NS.t('menu.addNote'),
            icon: '注',
            hint: notes.length
              ? notes.map((n) => NS.t(`menu.noteMode.${n.mode || 'always'}`)).join(' / ')
              : NS.t('menu.noteHint'),
            onClick: () => app.editItemNote(itemId)
          });
          items.push({ sep: true });
          items.push({
            label: NS.t('menu.rich'),
            icon: '📝',
            onClick: () => app.editItemRich(itemId)
          });
          items.push({
            label: NS.t('menu.editText'),
            icon: '✎',
            onClick: () => app.editItemText(itemId)
          });
          items.push({
            label: NS.t('menu.moveUp'),
            icon: '↑',
            onClick: () => app.moveItem(itemId, -1)
          });
          items.push({
            label: NS.t('menu.moveDown'),
            icon: '↓',
            onClick: () => app.moveItem(itemId, 1)
          });
          items.push({
            label: NS.t('menu.removeItem'),
            icon: '✕',
            danger: true,
            onClick: () => app.removeItem(itemId)
          });
          items.push({ sep: true });
        }
      }
      // 清单级：清除**在纸面上**做过的操作（勾选 / 加粗 / 颜色 / 划线），条目文字与编辑器排版保留
      const doneN = app.countChecklistMarks('done');
      const pageN = app.countChecklistMarks('page');
      items.push({
        label: NS.t('menu.clearDone'),
        icon: '☐',
        hint: doneN ? `${doneN}` : NS.t('menu.noDone'),
        disabled: !doneN,
        onClick: () => app.clearChecklistMarks('done')
      });
      items.push({
        label: NS.t('menu.clearPage'),
        icon: '🧹',
        hint: pageN ? `${pageN}` : NS.t('menu.noFormat'),
        disabled: !pageN,
        onClick: () => app.clearChecklistMarks('page')
      });
      items.push({ sep: true });
      // 清单：右键就能在「撕纸 / 不撕纸」之间切换（默认不撕，只滚动浏览）
      const noTear = app.store.get('settings').checklistNoTear !== false;
      items.push({
        label: noTear ? NS.t('menu.toTear') : NS.t('menu.toNoTear'),
        icon: noTear ? '✂' : '☰',
        hint: noTear ? NS.t('menu.curScroll') : NS.t('menu.curTear'),
        onClick: () => app.setChecklistNoTear(!noTear)
      });
      // 清单：不开设置面板也能切换自动序号（勾选后纸面按添加顺序标 1. 2. 3.）
      const numberingOn = !!app.store.get('settings').checklistNumbering;
      items.push({
        label: numberingOn ? NS.t('menu.cancelNumbering') : NS.t('menu.numbering'),
        icon: numberingOn ? '☑' : '☐',
        onClick: () => app.setChecklistNumbering(!numberingOn)
      });
      items.push({ sep: true });
    }

    items.push({
      label: NS.t('menu.backtrack'),
      icon: '↩',
      hint: app.keyHint('backtrack'),
      disabled: !app.stack || app.stack.size === 0,
      onClick: () => app.tear.backtrack(1)
    });
    items.push({ label: NS.t('menu.settings'), icon: '⚙', onClick: () => app.settings.open() });
    items.push({
      label: NS.t('menu.hidePet'),
      icon: '👁',
      hint: app.keyHint('toggleVisible'),
      onClick: () => petAPI.hide()
    });
    items.push({ sep: true });
    items.push({ label: NS.t('menu.quit'), icon: '⏻', danger: true, onClick: () => petAPI.quitApp() });
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

    // 随记数据迁移（v2.7）：旧的单条 item.note → notes 数组，一条条目从此可以挂多条随记。
    // 只在有旧数据时写回一次，之后全走 notes。
    const cl0 = store.get('checklists');
    const normedLists = NS.ChecklistOps.normalize(cl0.lists);
    if (normedLists) store.patch('checklists', { lists: normedLists }, { critical: true });

    const s0 = store.get('settings');
    /* 语言要在任何界面渲染前定下来：设置面板、右键菜单、说明窗口全都走 NS.t()。
       systemLocale 此时还拿不到（app.info 在后面），先用 navigator.language 兜着，
       等主进程信息回来再用它的结果对齐一次。 */
    NS.I18N.init(s0.locale || 'auto');

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
          toast.warn(NS.t('toast.backtrack.cap', { n: ev.cap }));
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

    // 使用说明（分级）：单独一个模块，切语言时它会自己重绘
    app.guide = new NS.Guide(uiRoot);

    // 清单定时清除：每 30 秒巡检一次，启动时也补做一次（详见 checkAutoClear）
    app.startAutoClearTimer();

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

    // 清单：点方框打勾 / 点随记标签展开便签卡。
    // 不能只挂 click —— 方框在拉纸区域里，按下即进入拖拽态；这里用「按下 → 抬起」的位移判定，
    // 位移小于 4px 才算点击，拖纸手势完全不受影响（也绝不 stopPropagation，否则 tear 收不到 pointerup 会卡在拖拽态）。
    let viewTap = null;
    viewport.addEventListener(
      'pointerdown',
      (e) => {
        viewTap = null;
        if (router.current !== 'checklist') return;
        const target = e.target;
        // 便签卡是「盖在纸上的浮层」：按在卡上只是看备注，不该顺手把纸拉走
        if (target && target.closest && target.closest('.cl-note-card')) {
          e.stopPropagation();
          return;
        }
        if (e.button !== 0) return;
        const chip = target && target.closest ? target.closest('.cl-note-chip') : null;
        if (chip) {
          viewTap = { kind: 'note', el: chip, x: e.screenX, y: e.screenY, t: Date.now(), id: chip.dataset.itemId };
          return;
        }
        const box = target && target.closest ? target.closest('.cl-box') : null;
        if (!box || box.classList.contains('cont')) return;
        const row = box.closest('.cl-item');
        if (!row || !row.dataset.itemId) return;
        viewTap = { kind: 'box', x: e.screenX, y: e.screenY, t: Date.now(), id: row.dataset.itemId };
      },
      true
    );
    viewport.addEventListener(
      'pointerup',
      (e) => {
        const d = viewTap;
        viewTap = null;
        if (!d) return;
        if (Math.abs(e.screenX - d.x) > 4 || Math.abs(e.screenY - d.y) > 4) return; // 是拖纸，不是点击
        if (Date.now() - d.t > 700) return;
        if (router.current !== 'checklist') return;
        if (engine.animating) return; // 松手回弹动画中，先别抢
        if (d.kind === 'note') app.toggleNoteCard(d.el || d.id);
        else app.toggleDone(d.id);
      },
      true
    );

    // 随记：悬停显示的那一种，鼠标移到标签上就在标签旁弹一个小气泡；移开即收
    viewport.addEventListener('pointerover', (e) => {
      if (router.current !== 'checklist') return;
      const chip = e.target && e.target.closest ? e.target.closest('.cl-note-chip') : null;
      if (!chip || chip.dataset.mode !== 'hover') return;
      app.showNoteTip(chip, true);
    });
    viewport.addEventListener('pointerout', (e) => {
      const chip = e.target && e.target.closest ? e.target.closest('.cl-note-chip') : null;
      if (chip && chip.dataset.mode === 'hover') {
        const to = e.relatedTarget;
        // 移进气泡不算离开（气泡里可以慢慢看 / 选中复制）
        if (!(to && to.closest && to.closest('.cl-note-tip'))) app.showNoteTip(chip, false);
      }
    });
    viewport.addEventListener('pointerleave', () => {
      viewport.querySelectorAll('.cl-note-card.open:not(.pinned)').forEach((c) => c.classList.remove('open'));
      viewport.querySelectorAll('.cl-note-tip.on').forEach((t) => t.classList.remove('on'));
    });
    // 便签卡上的 × 关掉；点纸面别处也把它收起来（避免一层卡一直盖着清单）
    viewport.addEventListener('click', (e) => {
      const x = e.target && e.target.closest ? e.target.closest('.cnc-x') : null;
      if (x) {
        const card = x.closest('.cl-note-card');
        if (card) {
          card.classList.remove('open', 'pinned');
          e.stopPropagation();
        }
        return;
      }
      const onCard = e.target && e.target.closest && e.target.closest('.cl-note-card');
      const onChip = e.target && e.target.closest && e.target.closest('.cl-note-chip');
      if (!onCard && !onChip) {
        viewport.querySelectorAll('.cl-note-card.open').forEach((c) => c.classList.remove('open', 'pinned'));
        viewport.querySelectorAll('.cl-note-tip.on').forEach((t) => t.classList.remove('on'));
      }
    });

    // 清单：双击某一条直接进富文本编辑窗口（拖纸不会误触发，双击才是编辑）
    viewport.addEventListener('dblclick', (e) => {
      if (router.current !== 'checklist') return;
      // 双击方框 = 想快速连点两下打勾，别把编辑窗口弹出来
      if (e.target && e.target.closest && e.target.closest('.cl-box')) return;
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
            toast.info(NS.t('toast.keys.modeOnly'));
          } else if (ev.action === 'toggleHidden') {
            const nowHidden = app.toggleHidden(p.id);
            toast.info(
              NS.t(nowHidden ? 'toast.word.hidden' : 'toast.word.shown', { w: p.word })
            );
          } else {
            const nowStarred = app.toggleStar(p.id);
            toast.info(
              NS.t(nowStarred ? 'toast.word.starred' : 'toast.word.unstarred', { w: p.word })
            );
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

    /* 主进程已经把「跟随系统」解析成具体语言了：拿它的结果再对齐一次，
       避免渲染层 navigator.language 与 app.getLocale() 不一致（比如系统装了多语言包）。
       setLocale 内部只在真变化时才重绘，所以这里不会白刷一遍界面。 */
    if (app.info && app.info.systemLocale) {
      // 用系统的原始语言标签（zh-CN / en-US…）而不是主进程已解析的结果，
      // 否则「跟随系统」会被解析成「当前语言」，切回来就再也回不到系统语言
      NS.I18N.setLocale(store.get('settings').locale || 'auto', app.info.systemLocale);
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

    // 功能说明：第一次使用自动弹一次（记在 settings.guideShown；「清空全部数据」后也会再看到）
    try {
      if (store.get('settings').guideShown !== true) {
        store.patch('settings', { guideShown: true }, { critical: true });
        setTimeout(() => app.showGuide(), 900);
      }
    } catch {
      /* ignore */
    }

    // 回溯只保留「本次运行」撕下的纸：启动时提示一次上限（设置里可关）
    if (app.noticeAllowed()) {
      const s1 = app.store.get('settings');
      setTimeout(() => {
        toast.info(
          NS.t('toast.backtrack.intro', { n: NS.clamp(s1.maxBacktrack, 1, 50) }),
          4200
        );
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
      d.textContent = NS.t('app.startFailed', { msg: NS.errorText(err) });
      host.appendChild(d);
    }
  });
})(window);
