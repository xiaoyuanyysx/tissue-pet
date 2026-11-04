'use strict';
/**
 * AutoLaunchService —— 开机自启动（登录系统时自动拉起桌宠）
 *
 * 只用 Electron 原生接口（app.setLoginItemSettings / app.getLoginItemSettings）：
 * Windows 落到 HKCU\Software\Microsoft\Windows\CurrentVersion\Run，macOS 落到登录项。
 * 原生接口内部按 UTF-16 写注册表，中文安装路径、带空格路径的引号都由它处理，比手拼
 * reg.exe 命令稳（reg 的 stdout 还是系统 OEM 代码页，中文路径读回来会乱码）。
 *
 * 三个容易踩空的地方：
 * 1. **绿色版（portable）**：process.execPath 指向临时解包目录，重启后那个目录早没了。
 *    必须注册便携包本体（electron-builder 给的 PORTABLE_EXECUTABLE_FILE）。
 * 2. **开发态（electron .）**：只写 electron.exe 会在登录时弹一个空壳，必须带上工程目录参数。
 * 3. **「注册项里有」≠「登录时真的会起来」**：被「任务管理器 → 启动」关掉之后
 *    openAtLogin 依然是 true，只有 executableWillLaunchAtLogin 会变 false。这种情况不能
 *    报错（写是写进去了），只能在界面上说清楚并给个去系统设置放行的入口。
 */
const { app, shell } = require('electron');
const fs = require('fs');
const i18n = require('./i18n');

/** 登录拉起时附带的标记参数：给以后做「静默启动 / 延迟启动」留的判别位 */
const LOGIN_ARG = '--autostart';

function fail(message, code) {
  return Object.assign(new Error(message), { code, expected: true });
}

/** 展示用的命令行：含空格的路径加引号，和注册表里存的样子一致 */
function quote(p) {
  const s = String(p || '');
  return /\s/.test(s) ? `"${s}"` : s;
}

class AutoLaunchService {
  get supported() {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  /** 登录时应当执行的命令（exe + 参数） */
  command() {
    // 绿色版：拉起便携包自己（它会解包再启动），不能写临时目录里的那个 exe
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (process.platform === 'win32' && portable) return { exe: portable, args: [LOGIN_ARG] };
    // 开发态：electron.exe + 工程目录，否则登录时只会起来一个空壳 Electron
    if (!app.isPackaged) return { exe: process.execPath, args: [app.getAppPath(), LOGIN_ARG] };
    return { exe: process.execPath, args: [LOGIN_ARG] };
  }

  _read(cmd) {
    if (process.platform === 'win32') {
      return app.getLoginItemSettings({ path: cmd.exe, args: cmd.args });
    }
    return app.getLoginItemSettings();
  }

  /**
   * 当前状态（只读，供界面与托盘使用）
   * @returns {{supported:boolean, enabled:boolean, blocked:boolean, dev:boolean,
   *            portable:boolean, exe:string, args:string[], command:string, reason?:string}}
   */
  status() {
    const cmd = this.command();
    const base = {
      supported: this.supported,
      enabled: false,
      blocked: false,
      dev: !app.isPackaged,
      portable: !!process.env.PORTABLE_EXECUTABLE_FILE,
      exe: cmd.exe,
      args: cmd.args,
      command: [cmd.exe, ...cmd.args].map(quote).join(' ')
    };
    if (!this.supported) {
      return Object.assign(base, { reason: i18n.t('error.autostartUnsupported') });
    }
    try {
      const st = this._read(cmd);
      base.enabled = !!st.openAtLogin;
      // macOS 上「系统设置 → 登录项」被关掉、Windows 上被任务管理器关掉，都会走到这里
      base.blocked = base.enabled && st.executableWillLaunchAtLogin === false;
      return base;
    } catch (err) {
      return Object.assign(base, {
        reason: i18n.t('error.autostartReadFail', { msg: (err && err.message) || String(err) })
      });
    }
  }

  /**
   * 开启 / 取消开机自启动；写完立刻回读校验，别让界面显示一个系统并不认的状态。
   * @param {boolean} enable
   * @returns {ReturnType<AutoLaunchService['status']>}
   */
  set(enable) {
    const on = !!enable;
    if (!this.supported) throw fail('当前系统不支持开机自启动', 'E_AUTOLAUNCH_UNSUPPORTED');

    const cmd = this.command();
    if (process.platform === 'win32' && !fs.existsSync(cmd.exe)) {
      throw fail(`找不到程序文件，无法注册启动项：${cmd.exe}`, 'E_AUTOLAUNCH_MISSING');
    }

    try {
      if (process.platform === 'win32') {
        app.setLoginItemSettings({ openAtLogin: on, path: cmd.exe, args: cmd.args });
      } else {
        app.setLoginItemSettings({ openAtLogin: on });
      }
    } catch (err) {
      throw fail(`写入启动项失败：${(err && err.message) || '未知错误'}`, 'E_AUTOLAUNCH_WRITE');
    }

    const st = this.status();
    if (on && !st.enabled) {
      throw fail('系统没有接受这条启动项（可能被安全软件或组策略拦下）', 'E_AUTOLAUNCH_REJECTED');
    }
    if (!on && st.enabled) {
      throw fail('取消开机自启动失败，启动项仍然存在，请稍后重试', 'E_AUTOLAUNCH_KEEP');
    }
    return st;
  }

  /**
   * 启动时对账：把「用户上次的选择」和「系统里实际那条启动项」拉齐。
   *
   * 只有一种情况需要动手——**程序被搬到了别的位置**（换安装目录、绿色版挪文件夹、
   * 工程目录改名）。启动项里记的是绝对路径，旧路径那条在登录时会静默失败（Windows
   * 不会报错，就是什么都不发生），而程序自己没运行的时候没法自我修复，所以只能等
   * 用户下次手动打开时把启动项改写到当前位置。
   *
   * 反方向的清理同样需要：用户关掉开关后如果注册项还留着（比如换了一份程序，
   * 或者手动删过），这里顺手删干净，避免「界面说关着、系统还在拉起」。
   * 被系统「启动应用」管理禁用（blocked）时不跟它抢：那是系统那侧的开关。
   *
   * @param {boolean} intent 用户上次的选择（settings.autoLaunch）
   * @returns {{changed:boolean, action:'none'|'healed'|'removed'|'error',
   *            status:object, error?:string}}
   */
  syncIntent(intent) {
    const st = this.status();
    if (!st.supported) return { changed: false, action: 'none', status: st };
    const want = !!intent;
    if (want === !!st.enabled) return { changed: false, action: 'none', status: st };
    try {
      const next = this.set(want);
      return { changed: true, action: want ? 'healed' : 'removed', status: next };
    } catch (err) {
      return {
        changed: false,
        action: 'error',
        status: st,
        error: (err && err.message) || '未知错误'
      };
    }
  }

  /** 打开系统的「启动应用」设置页：被系统或安全软件禁用时，只能去那里放行 */
  async openSystemSettings() {    const url =
      process.platform === 'win32'
        ? 'ms-settings:startupapps'
        : process.platform === 'darwin'
          ? 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
          : '';
    if (!url) throw fail('当前系统没有可打开的启动项设置', 'E_AUTOLAUNCH_UNSUPPORTED');
    await shell.openExternal(url);
    return null;
  }
}

module.exports = { AutoLaunchService, LOGIN_ARG };
