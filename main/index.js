'use strict';
/**
 * 主进程入口：生命周期 / 单实例锁 / 服务装配 / IPC 注册
 */
const { app, ipcMain, shell, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const { PersistService, SCOPES } = require('./persist');
const { WindowManager } = require('./window-manager');
const { TrayService } = require('./tray');
const { ShortcutService, ACTIONS } = require('./shortcuts');
const { DictService } = require('./dict-service');
const { ImportService, initFranc } = require('./importer');
const { EditorWindow } = require('./editor-window');
const { AutoLaunchService } = require('./auto-launch');
const { IpcRouter } = require('./ipc-router');
const { dictDir, resourceDir, userDir, ensureDir } = require('./paths');
const i18n = require('./i18n');

// 冒烟自检只在开发态开：打包版带着 --smoke-test 启动时按正常方式运行，
// 免得发布出去的包还留着「读一个本地脚本并执行」的入口（DESKPET_PROBE）。
const isSmoke = !app.isPackaged && process.argv.includes('--smoke-test');

// 冒烟自检使用独立的临时数据目录，避免污染真实 userData（--fresh 时先清空）
if (isSmoke) {
  try {
    const os = require('os');
    const dir = path.join(os.tmpdir(), 'deskpet-smoke');
    if (process.argv.includes('--fresh')) {
      require('fs').rmSync(dir, { recursive: true, force: true });
    }
    require('fs').mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
  } catch (err) {
    console.warn('[smoke] 无法切换数据目录', err && err.message);
  }
}

let persist;
let wm;
let tray;
let shortcuts;
let dictService;
let importer;
let router;
let editor;
let autoLaunch;

/* ---------------- 单实例 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (wm) {
      wm.show();
      tray && tray.refresh();
    }
  });
}

app.disableHardwareAcceleration();

/**
 * 系统语言原值（如 zh-CN / en-US）。
 * 「跟随系统」要拿它去解析，不能拿 i18n.locale —— 那是已经解析过、会记忆上一次选择的结果。
 */
function systemLocale() {
  try {
    return app.getLocale() || '';
  } catch {
    return '';
  }
}

function bootstrap() {
  ensureDir(userDir());
  ensureDir(userDir('imports'));
  ensureDir(userDir('dicts'));

  // dictService 先于 persist 创建：持久化迁移需要知道「当前词库属于哪种语言」
  // langOverrides 是惰性闭包：persist 在 init() 期间还没赋值，此时返回空即可
  dictService = new DictService({
    dictDir: dictDir(),
    dictsDir: userDir('dicts'),
    langOverrides: () => {
      if (!persist) return null;
      const learn = persist.get('learn') || {};
      return learn.dictLang || null;
    }
  });
  persist = new PersistService(userDir(), { langOfDict: (dictId) => dictService.langOf(dictId) }).init();
  // 语言先定下来：后面的托盘、原生提示都要用它（渲染层切换时会再同步一次）
  i18n.init((persist.get('settings') || {}).locale || 'auto');
  // 迁移期间读过的词库 meta 里没有「用户手选语言」（那时 persist 还没赋值），清掉重读
  dictService.invalidateAll();

  router = new IpcRouter();
  importer = new ImportService({ dictService, importsDir: userDir('imports') });
  initFranc();

  wm = new WindowManager({
    persist,
    onVisibleChanged: () => tray && tray.refresh()
  });
  const win = wm.create();
  router.setMainWindow(win);

  // 清单条目的独立编辑窗口（保存后把 HTML 回传给主窗口，窗口尺寸记在 settings.editorWindow）
  editor = new EditorWindow({ router, persist, getParent: () => (wm ? wm.win : null) });
  // 切界面语言时，已经开着的排版窗口也要跟着换（它的工具带是独立页面）
  i18n.onChange(() => {
    if (!editor || !editor.win || editor.win.isDestroyed()) return;
    try {
      editor.win.webContents.send('editor:locale', { locale: i18n.pref, systemLocale: systemLocale() });
      editor.win.setTitle(i18n.t('editor.windowTitle'));
    } catch {
      /* 窗口正在关闭 */
    }
  });

  // 开机自启动：**系统启动项是唯一事实来源**（界面/托盘都现读，不拿缓存糊弄人）；
  // settings.autoLaunch 只记「用户上次的选择」，用来在程序被搬到别的位置后对账。
  autoLaunch = new AutoLaunchService();
  const heal = autoLaunch.syncIntent(!!persist.get('settings').autoLaunch);
  if (heal.action === 'healed') {
    // 换了安装目录 / 绿色版挪了文件夹：这次手动打开才有机会修，说一声比默默修更合适
    persist.warnings.push('程序位置变了，开机自启动已改到当前位置（本次登录系统时还没生效）');
  } else if (heal.action === 'error') {
    persist.warnings.push(`开机自启动对账失败：${heal.error}`);
  }

  tray = new TrayService({
    persist,
    router,
    windowManager: wm,
    autoLaunch,
    resourceDir: resourceDir()
  });
  tray.create();

  shortcuts = new ShortcutService({ persist, router });
  const failures = shortcuts.registerAll();
  if (failures.length) {
    console.warn('[shortcut] 以下全局快捷键注册失败：', failures);
    setTimeout(() => {
      router.sendNotice(i18n.t('notice.shortcuts', { n: failures.length }), 'warn');
    }, 1500);
  }

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      return; // Esc 交给渲染层（关闭面板/取消录键），不再直接退程序
    }
    if (shortcuts.handleBeforeInput(input)) event.preventDefault();
  });

  // 持久化自愈是静默发生的（损坏 → 备份恢复 / 回落默认值），不主动说用户只会觉得
  // 「设置自己变回去了」。窗口 ready 后统一推一次提示，推完清空避免重复。
  win.webContents.once('did-finish-load', () => {
    if (!persist.warnings.length) return;
    const list = persist.warnings.slice();
    persist.warnings.length = 0;
    setTimeout(() => {
      for (const w of list) router.sendNotice(w, 'warn');
    }, 1800);
  });

  registerIpc();
  initSmoke(win);
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try {
    persist && persist.flush();
    shortcuts && shortcuts.dispose();
    editor && editor.destroy();
    tray && tray.destroy();
  } catch {
    /* ignore */
  }
});

/* ---------------- IPC 注册 ---------------- */

// 导出文件的「身份证」：导入时靠它判断是不是本系统导出的清单备份
const CHECKLIST_EXPORT_KIND = 'tissue-pet-checklists';

/**
 * 只收「本系统清单」该有的字段（白名单式清洗，文件里别的内容一概不进数据）。
 * 接受两种形态：导出文件整体 { kind, version, lists } 或裸的 lists 数组。
 */
function sanitizeChecklistLists(raw) {
  const src = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && raw.kind === CHECKLIST_EXPORT_KIND && Array.isArray(raw.lists)
      ? raw.lists
      : [];
  const out = [];
  for (const l of src.slice(0, 200)) {
    if (!l || typeof l !== 'object') continue;
    const items = [];
    for (const it of (Array.isArray(l.items) ? l.items : []).slice(0, 5000)) {
      if (!it || typeof it !== 'object') continue;
      const style = it.style && typeof it.style === 'object' ? it.style : {};
      const item = {
        id: typeof it.id === 'string' ? it.id.slice(0, 64) : '',
        text: String(it.text || '').slice(0, 20000) || '（空）',
        done: !!it.done,
        style: {
          bold: !!style.bold,
          strike: !!style.strike,
          color: typeof style.color === 'string' ? style.color.slice(0, 32) : undefined
        },
        starred: !!it.starred,
        createdAt: Number.isFinite(it.createdAt) ? it.createdAt : Date.now()
      };
      if (typeof it.html === 'string' && it.html) item.html = it.html.slice(0, 500000);
      if (Array.isArray(it.notes) && it.notes.length) {
        const notes = it.notes
          .filter((n) => n && typeof n === 'object' && String(n.text || '').trim())
          .slice(0, 50)
          .map((n) => ({
            id: typeof n.id === 'string' ? n.id.slice(0, 64) : '',
            text: String(n.text).slice(0, 20000),
            mode: n.mode === 'click' || n.mode === 'hover' ? n.mode : 'always'
          }));
        if (notes.length) item.notes = notes;
      }
      items.push(item);
    }
    out.push({
      id: typeof l.id === 'string' ? l.id.slice(0, 64) : '',
      name: String(l.name || '').slice(0, 100) || '导入的清单',
      createdAt: Number.isFinite(l.createdAt) ? l.createdAt : Date.now(),
      items
    });
  }
  return out;
}

function registerIpc() {
  /* 窗口 */
  router.on('win', 'close', () => app.quit());
  router.on('win', 'resize', (p) => wm.resize(p && p.height));
  router.on('win', 'setIgnoreMouse', (p) => wm.setIgnoreMouse(p && p.ignore));
  router.on('win', 'moveBy', (p) => wm.moveBy((p && p.dx) || 0, (p && p.dy) || 0));
  router.handle('win', 'hide', () => ({ visible: (wm.hide(), wm.visible) }));
  router.handle('win', 'show', () => ({ visible: (wm.show(), wm.visible) }));
  router.handle('win', 'toggleVisible', () => ({ visible: wm.toggleVisible() }));
  router.handle('win', 'applyScale', (p) => {
    const scale = Math.min(2, Math.max(0.5, Number(p && p.scale) || 1));
    persist.patch('settings', { scale }, { critical: false });
    return wm.applyScale(scale);
  });
  router.handle('win', 'getBounds', () => {
    const b = wm.getBounds();
    return Object.assign({}, b, { scale: wm.scale });
  });
  router.handle('win', 'setPanel', (p) => {
    const b = wm.setPanelOpen(!!(p && p.open));
    return Object.assign({}, b, { scale: wm.scale });
  });

  /* 持久化 */
  router.handle('store', 'get', () => persist.getAll());
  router.handle('store', 'patch', (p) => {
    const { scope, partial, critical } = p || {};
    persist.patch(scope, partial, { critical: !!critical });
    if (scope === 'settings') {
      const s = persist.get('settings');
      // 界面语言变了：先换主进程文案，再重建托盘（原生菜单是一次性快照，不会自己变）
      const pref = s.locale || 'auto';
      if (i18n.pref !== pref) i18n.setPref(pref);
      if (tray) tray.refresh();
      if (wm && Number.isFinite(s.scale) && Math.abs(s.scale - wm.scale) > 0.001) {
        wm.applyScale(s.scale);
      }
    }
    return null;
  });
  router.handle('store', 'reset', (p) => {
    const scope = p && p.scope;
    if (!SCOPES.includes(scope)) {
      throw Object.assign(new Error(i18n.t('error.scopeInvalid')), { code: 'E_SCOPE_INVALID', expected: true });
    }
    persist.reset(scope);
    if (scope === 'settings') {
      // 「恢复默认设置」不该顺手关掉开机自启动：把意图改回系统现状，
      // 否则下次启动对账会把用户明明开着的启动项删掉
      persist.patch(
        'settings',
        { autoLaunch: !!(autoLaunch && autoLaunch.status().enabled) },
        { critical: true }
      );
      const s = persist.get('settings');
      if (i18n.pref !== (s.locale || 'auto')) i18n.setPref(s.locale || 'auto');
      if (tray) tray.refresh();
      if (wm) {
        wm.applyScale(s.scale);
        wm.resize(wm.logicalHeight);
      }
      if (shortcuts) shortcuts.registerAll();
    }
    return persist.getAll();
  });

  /* 托盘：回溯深度同步（栈只在内存，托盘不能用磁盘状态判断） */
  router.on('tray', 'syncBacktrack', (p) => {
    if (!tray || !p) return;
    tray.setBacktrackDepth(p.mode, p.depth);
  });

  /* 导入 */
  router.handle('import', 'pickFile', (p) => {
    // 冒烟自检用：DESKPET_PICK_FILE=<绝对路径> 时跳过系统文件框，直接返回该文件
    const forced = process.env.DESKPET_PICK_FILE;
    if (forced) {
      return { filePath: forced, size: 0, name: path.basename(forced) };
    }
    return importer.pickFile(p && p.mode);
  });
  router.handle('import', 'parse', (p) => importer.parse(p || {}));
  router.handle('import', 'commitDict', (p) => importer.commitDict(p || {}));

  /* 文档 */
  router.handle('doc', 'list', () => importer.listDocs());
  router.handle('doc', 'getBlocks', (p) => importer.getBlocks(p || {}));
  router.handle('doc', 'remove', (p) => importer.removeDoc(p && p.docId));

  /* 词库 */
  router.handle('dict', 'listBuiltin', () => dictService.listBuiltin());
  router.handle('dict', 'listImported', () => dictService.listImported());
  router.handle('dict', 'listAll', () => dictService.listAll());
  router.handle('dict', 'getEntries', (p) => dictService.getEntries(p || {}));
  router.handle('dict', 'remove', (p) => dictService.remove(p && p.dictId));
  /* 改语言：导入时选的语言可以随时改，手选值优先于自动识别，重启后仍然生效 */
  router.handle('dict', 'setLang', (p) => {
    const dictId = p && p.dictId;
    if (!dictId || typeof dictId !== 'string') throw new Error('没有指定词库');
    if (!dictService.metaOf(dictId)) throw new Error('该词库不存在，可能已被删除');
    const word = String((p && p.wordLang) || '').trim().slice(0, 20);
    const def = String((p && p.defLang) || '').trim().slice(0, 20);
    if (!word) throw new Error('学习语言不能为空');
    const learn = persist.get('learn') || {};
    const dictLang = Object.assign({}, learn.dictLang || {});
    dictLang[dictId] = { word, def };
    persist.patch('learn', { dictLang }, { critical: true });
    dictService.invalidate(dictId);
    return dictService.metaOf(dictId);
  });

  /* 清单条目的独立编辑窗口 */
  router.handle('editor', 'open', (p) => (editor ? editor.open(p || {}) : null));
  router.handle('editor', 'payload', () => {
    const p = editor ? editor.getPayload() : null;
    if (!p) return null;
    // 带上界面语言：排版窗口是独立页面，自己解析 auto 会跟主窗口不一致
    return Object.assign({}, p, { locale: i18n.pref, systemLocale: systemLocale() });
  });
  router.handle('editor', 'save', (p) => (editor ? editor.save(p || {}) : null));
  router.handle('editor', 'close', () => (editor ? editor.close() : null));
  // 主题同步（send 型）：切黑夜模式时编辑窗口里的纸也要变黑
  router.on('editor', 'theme', (p) => (editor ? editor.setTheme(p && p.dark) : null));

  /* 清单导入导出（v2.8）：只针对本系统自己的清单数据，走 JSON 备份文件 */
  router.handle('checklist', 'export', async () => {
    const lists = (persist.get('checklists') || {}).lists || [];
    if (!lists.length) {
      throw Object.assign(new Error('还没有清单可以导出'), { expected: true });
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    let dir;
    try {
      dir = app.getPath('documents');
    } catch {
      dir = app.getPath('userData');
    }
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出清单',
      defaultPath: path.join(dir, `卷纸清单-${stamp}.json`),
      filters: [
        { name: '清单备份 (JSON)', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (canceled || !filePath) return { canceled: true };
    const payload = {
      kind: CHECKLIST_EXPORT_KIND,
      version: 1,
      exportedAt: new Date().toISOString(),
      lists
    };
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { canceled: false, filePath, count: lists.length };
  });
  router.handle('checklist', 'import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入清单',
      filters: [
        { name: '清单备份 (JSON)', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(filePaths[0], 'utf8'));
    } catch {
      throw Object.assign(new Error('文件不是有效的 JSON，无法导入'), { expected: true });
    }
    const lists = sanitizeChecklistLists(raw);
    if (!lists.length) {
      throw Object.assign(new Error('文件里没有可导入的清单（只支持本系统导出的清单备份）'), { expected: true });
    }
    return { canceled: false, lists, count: lists.length };
  });

  /* 快捷键 */
  router.handle('shortcut', 'set', (p) => shortcuts.set(p && p.action, p && p.accelerator, p && p.scope));
  router.handle('shortcut', 'getAll', () => shortcuts.getAll());
  router.on('shortcut', 'captureHint', () => shortcuts.pauseForCapture());
  router.on('shortcut', 'editing', (p) => shortcuts.setEditing(p && p.editing));

  /* 应用 */
  router.on('app', 'quit', () => app.quit());
  router.handle('app', 'openUserData', async () => {
    await shell.openPath(app.getPath('userData'));
    return null;
  });
  router.handle('app', 'info', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    dictDir: dictDir(),
    packaged: app.isPackaged,
    // 主进程解析好的界面语言：渲染层拿它兜住「跟随系统」时两边不一致的情况
    locale: i18n.locale,
    localePref: i18n.pref,
    systemLocale: systemLocale()
  }));

  /* 开机自启动：状态实时读系统启动项；settings.autoLaunch 只记用户的选择，供下次启动对账 */
  router.handle('app', 'autoLaunchStatus', () => autoLaunch.status());
  router.handle('app', 'setAutoLaunch', (p) => {
    const st = autoLaunch.set(p && p.enabled);
    // 记「实际写成功的结果」而不是请求值：写失败会抛错，这里不会被执行
    persist.patch('settings', { autoLaunch: !!st.enabled }, { critical: true });
    if (tray) tray.refresh(); // 托盘里同一项要跟着打勾/取消
    return st;
  });
  router.handle('app', 'openStartupSettings', () => autoLaunch.openSystemSettings());

  /* 兼容旧通道（M1 周期内保留） */
  ipcMain.on('window-close', () => app.quit());
  ipcMain.on('resize-window', (e, height) => wm.resize(height));
  ipcMain.on('set-ignore-mouse-events', (e, ignore) => wm.setIgnoreMouse(ignore));
}

/* ---------------- 冒烟自检（--smoke-test） ---------------- */

function initSmoke(win) {
  if (!isSmoke) return;
  const logs = [];
  win.webContents.on('console-message', (e, level, message, line, source) => {
    logs.push(`[renderer:${level}] ${message} (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc) => {
    logs.push(`[fail-load] ${code} ${desc}`);
  });
  win.webContents.on('preload-error', (e, p, err) => {
    logs.push(`[preload-error] ${p} ${err && err.message}`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    logs.push(`[render-gone] ${JSON.stringify(details)}`);
  });
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        let expr = 'window.__smoke ? JSON.stringify(window.__smoke()) : "no-probe"';
        if (process.env.DESKPET_PROBE) {
          try {
            expr = require('fs').readFileSync(process.env.DESKPET_PROBE, 'utf8');
          } catch (err) {
            expr = `JSON.stringify({probeReadError:${JSON.stringify(String(err && err.message))}})`;
          }
        }
        const probe = await win.webContents.executeJavaScript(expr);
        logs.push(`[probe] ${typeof probe === 'string' ? probe : JSON.stringify(probe)}`);

        // 编辑窗口探针（可选：DESKPET_EDITOR_PROBE=脚本路径，脚本里 return 一个对象即可）
        if (process.env.DESKPET_EDITOR_PROBE) {
          const sub = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed());
          if (!sub) {
            logs.push('[editor-probe] 没有编辑窗口');
          } else {
            await new Promise((r) => setTimeout(r, 700));
            try {
              const src = require('fs').readFileSync(process.env.DESKPET_EDITOR_PROBE, 'utf8');
              const r = await sub.webContents.executeJavaScript(`(async () => { ${src} })()`);
              logs.push(`[editor-probe] ${typeof r === 'string' ? r : JSON.stringify(r)}`);
            } catch (err) {
              logs.push(`[editor-probe-error] ${err && err.message}`);
            }
          }
        }
        // 端到端验一下编辑窗口的保存链路（可选：DESKPET_EDITOR_TEST=1）
        if (process.env.DESKPET_EDITOR_TEST) {
          const sub = BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed());
          if (!sub) {
            logs.push('[editor-save] 没有编辑窗口');
          } else {
            await new Promise((r) => setTimeout(r, 700));
            try {
              const r = await sub.webContents.executeJavaScript(
                `(async () => {
                  const paper = document.getElementById('edPaper');
                  paper.innerHTML = '<b>编辑器保存</b><span style="font-size:20px">大字</span>';
                  paper.dispatchEvent(new Event('input'));
                  // 走真实按钮，顺带验 cleanedHtml（保存前抖掉空 span）
                  document.getElementById('btnSave').click();
                  return 'clicked-save';
                })()`
              );
              await new Promise((r2) => setTimeout(r2, 800));
              const check = await win.webContents.executeJavaScript(
                `JSON.stringify((() => {
                  const cl = window.__pet.store.get('checklists');
                  const l = cl.lists.find((x) => x.id === cl.activeListId);
                  const it = l.items.find((i) => (i.html || '').includes('编辑器保存')) || null;
                  return it ? { text: it.text, html: it.html } : { found: false, count: l.items.length };
                })())`
              );
              logs.push(`[editor-save] ${r} ${check}`);
            } catch (err) {
              logs.push(`[editor-save-error] ${err && err.message}`);
            }
          }
        }
        // 托盘的回溯深度只存在主进程内存里，探针读不到，这里顺手带出来
        logs.push(`[tray] ${JSON.stringify(tray ? tray.depths : null)}`);
        logs.push(`[autoLaunch] ${JSON.stringify(autoLaunch ? autoLaunch.status() : null)}`);
        logs.push(`[persistWarnings] ${JSON.stringify(persist ? persist.warnings : null)}`);
        if (process.env.DESKPET_SHOT) {
          const dir = process.env.DESKPET_SHOT;
          require('fs').mkdirSync(dir, { recursive: true });
          const img = await win.capturePage();
          const file = require('path').join(dir, `shot-${Date.now()}.png`);
          require('fs').writeFileSync(file, img.toPNG());
          logs.push(`[shot] ${file} ${JSON.stringify(win.getBounds())}`);
          // 顺带把独立窗口（例如富文本编辑窗口）也截一张，方便验收
          const others = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed());
          if (others.length) {
            await new Promise((r) => setTimeout(r, 900));
            for (const w of others) {
              if (w.isDestroyed()) continue;
              const im = await w.capturePage();
              const f = require('path').join(dir, `shot-sub-${Date.now()}.png`);
              require('fs').writeFileSync(f, im.toPNG());
              // 顺便把独立窗口的主题/纸色读出来：验收「编辑窗口跟着黑夜模式变黑」
              let look = '';
              try {
                look = await w.webContents.executeJavaScript(
                  `JSON.stringify((() => {
                    const cs = getComputedStyle(document.getElementById('edPaper'));
                    return {
                      theme: document.documentElement.dataset.theme,
                      paperBg: cs.backgroundColor,
                      paperInk: cs.color,
                      bodyBg: getComputedStyle(document.body).backgroundColor
                    };
                  })())`
                );
              } catch {
                look = '{}';
              }
              logs.push(`[shot-sub] ${f} ${JSON.stringify(w.getBounds())} ${look}`);
            }
          }
        }
      } catch (err) {
        logs.push(`[probe-error] ${err && err.message}`);
      }
      console.log('=== SMOKE START ===');
      console.log(logs.join('\n') || '(no logs)');
      console.log('=== SMOKE END ===');
      app.exit(0);
    }, 4000);
  });
}
