// 着弾点の目視確認シート（Node・依存なし）。rally-node の結果（pN.json）の各打点の land（予測着弾）について、
// 着弾時刻の少し後のコマを予測点の周りで切り出し、十字を描いてタイル状に並べる。ロブは地面に星マーカーが出るので合否が一目で分かる。
//
//   node tools/rally-landcheck.js <video> <run.json> [--out land.png] [--size 320] [--cols 6] [--dt 0.15] [--only me|opp]
//
// タイルの左上: 通し番号（階段ドット・5個で段が変わる）。右上の帯: 側（me=下・opp=上）。十字の中心 = 予測着弾（画面座標）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writePng } = require('./rally-tile.js');

function findFfmpeg() {
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, 'ffmpeg.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return 'ffmpeg';
}
function grab(video, t, x, y, size) {
  // FHD 座標 (x,y) を中心に size×size を切り出す（はみ出しは pad で埋める）
  const x0 = Math.round(x - size / 2), y0 = Math.round(y - size / 2);
  const vf = `pad=iw+${size}:ih+${size}:${size / 2}:${size / 2}:black,crop=${size}:${size}:${x0 + size / 2}:${y0 + size / 2}`;
  return new Promise((resolve, reject) => {
    const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video, '-frames:v', '1',
                                    '-vf', `scale=1920:1080,${vf}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const chunks = []; ff.stdout.on('data', c => chunks.push(c)); ff.stderr.on('data', d => process.stderr.write(d));
    ff.on('close', () => { const b = Buffer.concat(chunks); b.length >= size * size * 4 ? resolve(b) : reject(new Error('short frame at ' + t)); });
  });
}
function put(out, W, x, y, r, g, b) { if (x < 0 || y < 0 || x >= W) return; const o = (y * W + x) * 4; if (o + 3 >= out.length) return; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255; }

async function build({ video, run, out = 'land.png', size = 320, cols = 6, dt = 0.15, only = null }) {
  const r = JSON.parse(fs.readFileSync(run, 'utf8'));
  const shots = (r.rally || []).filter(h => h.land && (!only || h.side === only));
  if (!shots.length) { console.error('no landings'); return null; }
  const rows = Math.ceil(shots.length / cols), W = size * cols, H = size * rows;
  const buf = Buffer.alloc(W * H * 4);
  const rowsOut = [];
  for (let i = 0; i < shots.length; i++) {
    const h = shots[i], L = h.land;
    const tile = await grab(video, L.t + dt, L.x * 2, L.y * 2, size);
    const ox = (i % cols) * size, oy = Math.floor(i / cols) * size;
    for (let y = 0; y < size; y++) tile.copy(buf, ((oy + y) * W + ox) * 4, y * size * 4, (y + 1) * size * 4);
    const c = size / 2, rgb = h.side === 'me' ? [255, 60, 60] : [60, 120, 255];
    for (let k = -30; k <= 30; k++) { if (Math.abs(k) < 6) continue; put(buf, W, ox + c + k, oy + c, ...rgb); put(buf, W, ox + c, oy + c + k, ...rgb); }
    for (let k = 0; k <= i % 100; k++) { const dx = 6 + (k % 5) * 5, dy = 6 + Math.floor(k / 5) * 4; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) put(buf, W, ox + dx + a, oy + dy + b, 255, 255, 0); }
    for (let y = 0; y < 24; y++) for (let x = 0; x < 8; x++) put(buf, W, ox + size - 10 + x, oy + (h.side === 'me' ? size - 26 : 2) + y, ...rgb);
    rowsOut.push({ i, t: h.t, side: h.side, cls: h.cls, landT: L.t, x: L.x, y: L.y, X: L.X, Z: L.Z, inCourt: L.inCourt, bridged: !!L.bridged, drop: L.drop });
  }
  writePng(out, W, H, buf);
  console.table(rowsOut);
  return { n: shots.length, out };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const str = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const video = a[0], run = a[1];
  if (!video || !run) { console.error('usage: node tools/rally-landcheck.js <video> <run.json> [--out land.png] [--size 320] [--cols 6] [--dt 0.15] [--only me|opp]'); process.exit(2); }
  build({ video, run, out: str('--out', 'land.png'), size: +str('--size', 320), cols: +str('--cols', 6), dt: +str('--dt', 0.15), only: str('--only', null) })
    .then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { build };
