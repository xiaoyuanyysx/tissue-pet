'use strict';
/**
 * 路径解析：内置词库、托盘图标、userData 子目录
 * 开发态词库位于项目根目录 词库/；打包后为 extraResources/词库
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function dictDir() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, '词库'));
  const appPath = app.getAppPath();
  candidates.push(path.join(appPath, '词库'));
  candidates.push(path.join(appPath, '..', '词库'));
  candidates.push(path.join(__dirname, '..', '..', '词库'));
  for (const c of candidates) {
    if (existsDir(c)) return path.resolve(c);
  }
  return path.resolve(candidates[candidates.length - 1]);
}

function resourceDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'resources');
  const local = path.join(app.getAppPath(), 'resources');
  if (existsDir(local)) return local;
  return path.join(__dirname, '..', 'resources');
}

function userDir(...segs) {
  const base = app.getPath('userData');
  return path.join(base, ...segs);
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
  return p;
}

module.exports = { dictDir, resourceDir, userDir, ensureDir };
