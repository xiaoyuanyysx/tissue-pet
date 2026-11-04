'use strict';
/**
 * make-icon.js —— 生成应用图标（build/icon.ico + build/icon.png）
 *
 * 造型与托盘图标一致：一只纸卷，纸从卷筒下方垂下来，底边是撕口。
 * 只依赖 canvas（已经是运行时依赖），不引第三方图标库：
 *   node scripts/make-icon.js
 *
 * 输出的 ico 内嵌 7 个尺寸（PNG 压缩的 ICO，Vista 以上原生支持），
 * 16/32 这种小尺寸会自动省掉纸面横线，避免糊成一团。
 */
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BASE = 512; // 设计稿坐标系

const INK = '#f8f5ef'; // 纸白
const PAPER = '#fdfbf7';
const RULE = '#ded7c8'; // 纸上的横线
const BG_TOP = '#1e2839';
const BG_BOTTOM = '#2c3b55';

function roundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 撕纸底边：一条水平边，等距切出三角缺口 */
function tornEdge(ctx, x0, x1, y, teeth, depth) {
  const step = (x1 - x0) / teeth;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  for (let i = 0; i < teeth; i++) {
    const a = x0 + step * i;
    ctx.lineTo(a + step / 2, y - depth);
    ctx.lineTo(a + step, y);
  }
  ctx.lineTo(x1, y);
}

function draw(ctx, size) {
  const s = size / BASE;
  ctx.scale(s, s);
  const detail = size >= 64; // 小尺寸不画纸面横线
  const fine = size >= 96;

  // 背景：深色圆角方块，右下略亮，和浅色任务栏区分得开
  const g = ctx.createLinearGradient(0, 0, BASE, BASE);
  g.addColorStop(0, BG_TOP);
  g.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = g;
  roundRect(ctx, 0, 0, BASE, BASE, 116);
  ctx.fill();

  // 纸：从卷筒下方垂出，底边带撕口
  const px = 190;
  const pw = 132;
  const py = 236; // 从卷筒下缘出来，不是从卷芯穿过去
  const pbot = 452;
  ctx.fillStyle = PAPER;
  roundRect(ctx, px, py, pw, pbot - py - 12, 10);
  ctx.fill();
  ctx.fillStyle = PAPER;
  tornEdge(ctx, px, px + pw, pbot, 6, 14);
  ctx.lineTo(px + pw, pbot - 14);
  ctx.lineTo(px, pbot - 14);
  ctx.closePath();
  ctx.fill();

  // 纸面上的字迹暗示（只在大尺寸画，否则就是噪点）
  if (detail) {
    ctx.fillStyle = RULE;
    const lines = [
      [216, 306, 14],
      [216, 342, 20],
      [216, 378, 12],
      [216, 410, 18]
    ];
    for (const [lx, ly, w] of lines) {
      roundRect(ctx, lx, ly, pw - (lx - px) * 2 - w, 7, 3.5);
      ctx.fill();
    }
  }

  // 卷筒：外环盖住纸上沿，形成「纸从卷里出来」的层次
  ctx.lineWidth = fine ? 34 : 38;
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(256, 168, 100, 0, Math.PI * 2);
  ctx.stroke();

  // 卷芯：小一号的环，卷筒中空才像纸卷而不是甜甜圈
  if (fine) {
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.arc(256, 168, 36, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function png(size) {
  const cv = createCanvas(size, size);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  draw(ctx, size);
  return cv.toBuffer('image/png');
}

/** 多尺寸 PNG 内嵌 ICO（width/height 为 0 表示 256） */
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  const entries = [];
  const blobs = [];
  let offset = 6 + 16 * images.length;
  for (const img of images) {
    const e = Buffer.alloc(16);
    const dim = img.size >= 256 ? 0 : img.size;
    e.writeUInt8(dim, 0);
    e.writeUInt8(dim, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.buf.length;
    entries.push(e);
    blobs.push(img.buf);
  }
  return Buffer.concat([head, ...entries, ...blobs]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const images = SIZES.map((size) => ({ size, buf: png(size) }));
const icoBuf = ico(images);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), icoBuf);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png(512));
console.log(
  `icon.ico ${icoBuf.length} 字节（${SIZES.join('/')}），icon.png ${fs.statSync(path.join(OUT_DIR, 'icon.png')).size} 字节`
);
