// GT 裏取り用のコンタクトシート: 時刻ラベル付き（各コマ左上に t を描く）。
//   node tools/rally-gsheet.js <video> <t0> <t1> <out.png> [--fps 20] [--crop x,y,w,h (1920x1080 座標)] [--w 480] [--cols 6] [--mark t,t2]
// --mark の時刻に最も近いコマは赤枠。
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const { writePng } = require('./rally-tile.js');
function ff() { const base = 'C:/Program Files/CapCut/Apps'; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, 'ffmpeg.exe'); if (fs.existsSync(p)) return p; } }
const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const [video, T0, T1, out] = [a[0], +a[1], +a[2], a[3]];
const fps = +get('--fps', 20), cols = +get('--cols', 6);
const [cx, cy, cw, ch] = get('--crop', '0,0,1920,1080').split(',').map(Number);
const w = +get('--w', 480); const h = Math.round(w * ch / cw / 2) * 2;
const marks = (get('--mark', '') || '').split(',').filter(Boolean).map(Number);
// 3x5 digits
const F = { '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001001001', '8': '111101111101111', '9': '111101111001111', '.': '000000000000010' };
function text(buf, W, x0, y0, s, sc) {
  let x = x0;
  for (const c of s) { const g = F[c]; if (!g) { x += 4 * sc; continue; }
    // bg
    for (let yy = -1; yy < 6 * sc; yy++) for (let xx = -1; xx < 4 * sc; xx++) { const X = x + xx, Y = y0 + yy; if (X < 0 || Y < 0 || X >= W) continue; const o = (Y * W + X) * 4; buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; }
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r * 3 + q] === '1') for (let yy = 0; yy < sc; yy++) for (let xx = 0; xx < sc; xx++) { const o = ((y0 + r * sc + yy) * W + x + q * sc + xx) * 4; buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 0; }
    x += 4 * sc; }
}
(async () => {
  const BYTES = w * h * 4;
  const p = spawn(ff(), ['-hide_banner', '-loglevel', 'error', '-ss', T0.toFixed(3), '-t', (T1 - T0).toFixed(3), '-i', video,
    '-vf', `fps=${fps},crop=${cw}:${ch}:${cx}:${cy},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  p.stderr.on('data', d => process.stderr.write(d));
  const frames = []; let buf = Buffer.alloc(0);
  for await (const c of p.stdout) { buf = Buffer.concat([buf, c]); while (buf.length >= BYTES) { frames.push(Buffer.from(buf.subarray(0, BYTES))); buf = buf.subarray(BYTES); } }
  const n = frames.length, rows = Math.ceil(n / cols), G = 4;
  const W = cols * (w + G), H = rows * (h + G);
  const img = Buffer.alloc(W * H * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = T0 + i / fps; const col = i % cols, row = Math.floor(i / cols);
    const ox = col * (w + G), oy = row * (h + G);
    for (let y = 0; y < h; y++) frames[i].copy(img, ((oy + y) * W + ox) * 4, y * w * 4, (y + 1) * w * 4);
    const isMark = marks.some(m => Math.abs(m - t) < 0.5 / fps);
    if (isMark) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 3 || y < 3 || x >= w - 3 || y >= h - 3) { const o = ((oy + y) * W + ox + x) * 4; img[o] = 255; img[o + 1] = 0; img[o + 2] = 0; }
    text(img, W, ox + 4, oy + 4, t.toFixed(2), 3);
  }
  for (let i = 3; i < img.length; i += 4) img[i] = 255;
  writePng(out, W, H, img);
  console.log(`${out} frames=${n} ${W}x${H}`);
})();
