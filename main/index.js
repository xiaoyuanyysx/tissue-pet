'use strict';
/**
 * 主进程入口：生命周期 / 单实例锁 / 服务装配 / IPC 注册
 */
const { app, ipcMain, shell } = require('electron');
const path = require('path');

const { PersistService } = require('./persist');
const { WindowManager } = require('./window-manager');
const { TrayService } = require('./tray');
const { ShortcutService, ACTIONS } = require('./shortcuts');
const { DictService } = require('./dict-service');
const { ImportService, initFranc } = require('./importer');
const { IpcRouter } = require('./ipc-router');
const { dictDir, resourceDir, userDir, ensureDir } = require('./paths');

const isSmoke = process.argv.includes('--smoke-test');

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

function bootstrap() {
  ensureDir(userDir());
  ensureDir(userDir('imports'));
  ensureDir(userDir('dicts'));

  persist = new PersistService(userDir()).init();

  router = new IpcRouter();
  dictService = new DictService({ dictDir: dictDir(), dictsDir: userDir('dicts') });
  importer = new ImportService({ dictService, importsDir: userDir('imports') });
  initFranc();

  wm = new WindowManager({
    persist,
    onVisibleChanged: () => tray && tray.refresh()
  });
  const win = wm.create();
  router.setMainWindow(win);

  tray = new TrayService({ persist, router, windowManager: wm, resourceDir: resourceDir() });
  tray.create();

  shortcuts = new ShortcutService({ persist, router });
  const failures = shortcuts.registerAll();
  if (failures.length) {
    console.warn('[shortcut] 以下全局快捷键注册失败：', failures);
    setTimeout(() => {
      router.sendNotice(
        `有 ${failures.length} 个全局快捷键被系统或其他软件占用，可到设置中心改键`,
        'warn'
      );
    }, 1500);
  }

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      return; // Esc 交给渲染层（关闭面板/取消录键），不再直接退程序
    }
    if (shortcuts.handleBeforeInput(input)) event.preventDefault();
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
    tray && tray.destroy();
  } catch {
    /* ignore */
  }
});

/* ---------------- IPC 注册 ---------------- */

function registerIpc() {
  /* 窗口 */
  router.on('win', 'close', () => app.quit());
  router.on('win', 'resize', (p) => wm.resize(p && p.height));
  router.on('win', 'setIgnoreMouse', (p) => wm.setIgnoreMouse(p && p.ignore));
  router.on('win', 'moveBy', (p) => wm.moveBy((p && p.dx) || 0, (p && p.dy) || 0));
  router.handle('win', 'hide', () => ({ visible: (wm.hide(), wm.visible) }));
  router.handle('win', 'show', () => ({ visible: (wm.show(), wm.visible) }));
  router.handle('win', 'toggleVisible', () => ({ visible: wm.toggleVisible() }));
  router.handle('win', 'applyScale', (p) => {    const scale = Math.min(2, Math.max(0.5, Number(p && p.scale) || 1));
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
      if (tray) tray.refresh();
      if (wm && Number.isFinite(s.scale) && Math.abs(s.scale - wm.scale) > 0.001) {
        wm.applyScale(s.scale);
      }
    }
    return null;
  });

  /* 导入 */
  router.handle('import', 'pickFile', (p) => importer.pickFile(p && p.mode));
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
    packaged: app.isPackaged
  }));

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
        if (process.env.DESKPET_SHOT) {
          const dir = process.env.DESKPET_SHOT;
          require('fs').mkdirSync(dir, { recursive: true });
          const img = await win.capturePage();
          const file = require('path').join(dir, `shot-${Date.now()}.png`);
          require('fs').writeFileSync(file, img.toPNG());
          logs.push(`[shot] ${file} ${JSON.stringify(win.getBounds())}`);
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
