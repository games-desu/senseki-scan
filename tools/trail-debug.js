// Phase D（トレイル）の1フレーム診断。マスクとblobを重ねたPNGを書き、各段の所要時間も測る。
//   node tools/trail-debug.js <video> <t> [--out dbg.png] [--n 4]
//   --n: t から連続 n コマ読む（hist を作るため。最後のコマを描く）
const fs = require('fs');
const path = require('path');
const { loadModules, frames } = require('./rally-node.js');
const { writePng } = require('./rally-tile.js');

async function main() {
  const a = process.argv.slice(2);
  const video = a[0], t = +a[1];
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const out = get('--out', 'trail-dbg.png'), n = +get('--n', 4);
  const { Court, Trail } = loadModules(null);
  const W = 960, H = 540;
  let cam = null, hist = [], last = null, img = null, tt = 0;
  const times = [];
  for await (const fr of frames(video, t - (n - 1) / 60, t + 0.001, 60)) {
    const e = Court.estimate(fr.img);
    console.log("estimate", fr.t, e.ok, e.reason, e.suspect, e.agree); if (e.ok && !e.suspect) cam = e;
    const s = Date.now();
    const r = Trail.detect(fr.img, { cam, hist });
    times.push(Date.now() - s);
    hist.unshift({ mask: r.mask, blobs: r.blobs }); if (hist.length > 3) hist.pop();
    last = r; img = fr.img; tt = fr.t;
  }
  if (!last) { console.error('no frame'); process.exit(1); }
  console.log('t', tt, 'cam', cam && { c0: cam.c0, c1: cam.c1, Xc: cam.Xc }, 'ref', last.ref, 'detect ms', times);
  // 段ごとの時間
  if (cam && last.ref) {
    const T = {};
    let s = Date.now(); for (let i = 0; i < 5; i++) Trail.courtRef(img, cam); T.courtRef = (Date.now() - s) / 5;
    s = Date.now(); for (let i = 0; i < 5; i++) Trail.detect(img, { cam, hist }); T.detectAll = (Date.now() - s) / 5;
    console.log('stage ms', T);
  }
  for (const b of last.blobs) console.log(JSON.stringify(b));
  // 描画: 生マスク=赤半透明、blob 主軸=先端(緑)→尾(青)、ライン近傍=薄い黄
  const buf = Buffer.from(img.data.buffer, img.data.byteOffset, W * H * 4);
  const o = Buffer.alloc(W * H * 4); buf.copy(o);
  const m = last.mask;
  for (let i = 0; i < W * H; i++) {
    if (m && m[i]) { o[i * 4] = Math.min(255, o[i * 4] * 0.4 + 160); o[i * 4 + 1] *= 0.4; o[i * 4 + 2] *= 0.4; }
  }
  const line = (x0, y0, x1, y1, rgb) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)); for (let i = 0; i <= n; i++) { const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n); for (let k = -1; k <= 1; k++) { const j = ((y + k) * W + x) * 4; if (j >= 0 && j < o.length) { o[j] = rgb[0]; o[j + 1] = rgb[1]; o[j + 2] = rgb[2]; } const j2 = (y * W + x + k) * 4; if (j2 >= 0 && j2 < o.length) { o[j2] = rgb[0]; o[j2 + 1] = rgb[1]; o[j2 + 2] = rgb[2]; } } } };
  for (const b of last.blobs) {
    line(b.tail.x, b.tail.y, b.tip.x, b.tip.y, b.cls === 'drop' ? [255, 255, 255] : b.cls === 'topspin' ? [255, 80, 0] : b.cls === 'slice' ? [0, 200, 255] : b.cls === 'flat' ? [220, 0, 255] : b.cls === 'lob' ? [255, 230, 0] : [0, 0, 0]);
    // 先端に緑の点
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const j = ((b.tip.y + dy) * W + b.tip.x + dx) * 4; if (j >= 0 && j < o.length) { o[j] = 0; o[j + 1] = 255; o[j + 2] = 0; } }
  }
  writePng(out, W, H, o);
  console.log('wrote', out);
}
main().catch(e => { console.error(e); process.exit(1); });
