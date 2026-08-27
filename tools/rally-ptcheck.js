// 採用トラック点の「on-ball率」目視用タイル。
// 採用点を等間隔サンプルし、各点を中心にクロップを並べる。中央にボールが写っていれば正しい追跡。
//   node tools/rally-ptcheck.js <video> <runJson> [--every 8] [--box 90] [--zoom 2] [--out pts.png]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writePng } = require('./rally-tile.js');

function findFfmpeg() {
  const base = 'C:/Program Files/CapCut/Apps';
  for (const d of fs.readdirSync(base).sort().reverse()) {
    const p = path.join(base, d, 'ffmpeg.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}
const FW = 1920, FH = 1080;
async function grab(video, t) {
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video,
    '-frames:v', '1', '-vf', `scale=${FW}:${FH}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const cs = []; for await (const c of ff.stdout) cs.push(c);
  const b = Buffer.concat(cs);
  return b.length >= FW * FH * 4 ? new Uint8ClampedArray(b.subarray(0, FW * FH * 4)) : null;
}
async function main() {
  const a = process.argv.slice(2);
  const num = (f, d) => { const i = a.indexOf(f); return i >= 0 ? +a[i + 1] : d; };
  const str = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const video = a[0];
  const run = JSON.parse(fs.readFileSync(a[1], 'utf8'));
  const every = num('--every', 8), box = num('--box', 90), zoom = num('--zoom', 2);
  const out = str('--out', 'pts.png');
  const pts = [];
  run.segPts.forEach(s => s.pts.forEach(p => pts.push(p)));
  pts.sort((a, b) => a.t - b.t);
  const sample = pts.filter((_, i) => i % every === 0).slice(0, 36);
  const cw = box * zoom, ch = box * zoom, cols = 6, gap = 2;
  const rows = Math.ceil(sample.length / cols);
  const W = cols * (cw + gap) + gap, H = rows * (ch + gap) + gap;
  const img = Buffer.alloc(W * H * 4, 20);
  for (let i = 3; i < img.length; i += 4) img[i] = 255;
  for (let k = 0; k < sample.length; k++) {
    const p = sample[k];
    const fr = await grab(video, p.t);
    if (!fr) continue;
    const ox = gap + (k % cols) * (cw + gap), oy = gap + ((k / cols) | 0) * (ch + gap);
    const x0 = Math.round(p.x * 2 - box / 2), y0 = Math.round(p.y * 2 - box / 2);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = x0 + ((x / zoom) | 0), sy = y0 + ((y / zoom) | 0);
      const o = ((oy + y) * W + ox + x) * 4;
      if (sx < 0 || sy < 0 || sx >= FW || sy >= FH) { img[o] = 24; img[o + 1] = 24; img[o + 2] = 24; continue; }
      const s = (sy * FW + sx) * 4;
      img[o] = fr[s]; img[o + 1] = fr[s + 1]; img[o + 2] = fr[s + 2];
    }
    // 中心マーカー（マゼンタ十字）
    const cx = ox + cw / 2, cy = oy + ch / 2;
    for (let d = -6; d <= 6; d++) {
      const o1 = ((cy | 0) * W + (cx + d | 0)) * 4, o2 = (((cy + d) | 0) * W + (cx | 0)) * 4;
      img[o1] = 255; img[o1 + 1] = 0; img[o1 + 2] = 255;
      img[o2] = 255; img[o2 + 1] = 0; img[o2 + 2] = 255;
    }
    // res点は左上に黄マーク
    if (p.res) for (let yy = 0; yy < 6; yy++) for (let xx = 0; xx < 6; xx++) {
      const o = ((oy + yy) * W + ox + xx) * 4; img[o] = 255; img[o + 1] = 220; img[o + 2] = 0;
    }
  }
  writePng(out, W, H, img);
  console.log(JSON.stringify({ out, sampled: sample.length, of: pts.length, grid: `${cols}x${rows}` }));
}
main().catch(e => { console.error(e); process.exit(1); });
