// ラリー解析の目視用コンタクトシート（Node・依存なし）。
// 区間を一定fpsで舐めて縮小コマをタイル状に並べ、rally-node の結果（採用トラック点・イベント）を重ねる。
// 正解ラベル（GT）を人手で作るときと、追跡が何を掴んでいるかを確かめるときに使う。
//
//   node tools/rally-sheet.js <video> <t0> <t1> [--fps 10] [--cols 5] [--w 384] [--run run.json] [--out sheet.png]
//
// 重ね描き（--run 指定時）:
//   緑の丸      = 採用トラック点（そのコマの時刻に最も近い点・±1/fps/2 以内）
//   赤の縦棒    = そのコマに 'hit' イベント（側 me=下辺 / opp=上辺 に短い棒）
//   青の縦棒    = 'bounce' イベント、灰=unknown
//   赤い階段ドット = コマ番号（左上・1コマ1ドット・5コマごとに段が変わる）。t = t0 + idx/fps
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { writePng } = require('./rally-tile.js');

const FW = 1920, FH = 1080;

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

async function* frames(video, t0, t1, fps, w, h) {
  const BYTES = w * h * 4;
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error',
    '-ss', String(t0), '-t', String(Math.max(0.001, t1 - t0)), '-i', video,
    '-vf', `fps=${fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  ff.stderr.on('data', d => process.stderr.write(d));
  let buf = Buffer.alloc(0), i = 0;
  for await (const c of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= BYTES) { yield { i: i++, raw: buf.subarray(0, BYTES) }; buf = buf.subarray(BYTES); }
  }
}

function put(out, W, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W) return;
  const o = (y * W + x) * 4; if (o + 3 >= out.length) return;
  out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
}
function circle(out, W, cx, cy, rad, rgb) {
  for (let a = 0; a < 64; a++) {
    const x = Math.round(cx + rad * Math.cos(a / 64 * Math.PI * 2)), y = Math.round(cy + rad * Math.sin(a / 64 * Math.PI * 2));
    put(out, W, x, y, ...rgb); put(out, W, x + 1, y, ...rgb); put(out, W, x, y + 1, ...rgb);
  }
}
function vbar(out, W, x, y0, y1, rgb, thick = 3) {
  for (let y = y0; y <= y1; y++) for (let k = 0; k < thick; k++) put(out, W, x + k, y, ...rgb);
}

async function build(opts) {
  const { video, t0, t1, fps = 10, cols = 5, w = 384 } = opts;
  const h = Math.round(w * 9 / 16);
  const n = Math.round((t1 - t0) * fps);
  const rows = Math.ceil(n / cols);
  const W = w * cols, H = h * rows;
  const out = Buffer.alloc(W * H * 4);
  let track = [], events = [], trailLog = [], shots = [];
  if (opts.run) {
    const r = JSON.parse(fs.readFileSync(opts.run, 'utf8'));
    (r.segPts || []).forEach(s => s.pts.forEach(p => track.push(p)));
    track.sort((a, b) => a.t - b.t);
    events = r.events || [];
    trailLog = r.trailLog || []; shots = r.shots || [];
  }
  const CLS_RGB = { topspin: [255, 90, 0], slice: [0, 200, 255], flat: [230, 0, 255], lob: [255, 230, 0], drop: [255, 255, 255], unknown: [0, 0, 0] };
  const sx = w / FW, sy = h / FH;   // FHD→タイル
  let count = 0;
  for await (const fr of frames(video, t0, t1, fps, w, h)) {
    if (fr.i >= n) break;
    const col = fr.i % cols, row = Math.floor(fr.i / cols);
    const ox = col * w, oy = row * h;
    for (let y = 0; y < h; y++) fr.raw.copy(out, ((oy + y) * W + ox) * 4, y * w * 4, (y + 1) * w * 4);
    const t = t0 + fr.i / fps;
    // 採用点（このコマの時刻に最も近いもの）
    const near = track.filter(p => Math.abs(p.t - t) <= 0.5 / fps);
    for (const p of near) circle(out, W, ox + Math.round(p.x * 2 * sx), oy + Math.round(p.y * 2 * sy), 7, [0, 255, 80]);
    // イベント
    for (const e of events) {
      if (Math.abs(e.t - t) > 0.5 / fps) continue;
      const rgb = e.kind === 'hit' ? [255, 40, 40] : e.kind === 'bounce' ? [60, 120, 255] : [200, 200, 200];
      const ex = ox + Math.round(e.x * 2 * sx), ey = oy + Math.round(e.y * 2 * sy);
      circle(out, W, ex, ey, 11, rgb); circle(out, W, ex, ey, 13, rgb);
      // 側の目印: me=下辺 / opp=上辺
      if (e.side === 'me') vbar(out, W, ox + 4, oy + h - 26, oy + h - 4, rgb, 5);
      else vbar(out, W, ox + 4, oy + 4, oy + 26, rgb, 5);
    }
    // トレイル blob（そのコマに最も近い trailLog）: 重心に小さな四角（種別色）、先端→尾に線
    if (trailLog.length) {
      let best = null; for (const f of trailLog) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
      if (best && Math.abs(best.t - t) <= 0.5 / fps) for (const b of best.blobs) {
        const rgb = CLS_RGB[b.cls] || [0, 0, 0];
        const bx = ox + Math.round(b.cx * 2 * sx), by = oy + Math.round(b.cy * 2 * sy);
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) put(out, W, bx + dx, by + dy, ...rgb);
        const n = 20; for (let i = 0; i <= n; i++) put(out, W, ox + Math.round((b.tail.x + (b.tip.x - b.tail.x) * i / n) * 2 * sx), oy + Math.round((b.tail.y + (b.tip.y - b.tail.y) * i / n) * 2 * sy), ...rgb);
      }
    }
    // ショット開始（run の t0 がこのコマ）: 尾の位置に二重リング＋左辺に種別色の帯
    for (const s of shots) {
      if (Math.abs(s.t0 - t) > 0.5 / fps) continue;
      const rgb = CLS_RGB[s.cls] || [0, 0, 0];
      circle(out, W, ox + Math.round(s.tail.x * 2 * sx), oy + Math.round(s.tail.y * 2 * sy), 16, rgb);
      circle(out, W, ox + Math.round(s.tail.x * 2 * sx), oy + Math.round(s.tail.y * 2 * sy), 19, rgb);
      vbar(out, W, ox + w - 12, oy + (s.side === 'me' ? h - 40 : 4), oy + (s.side === 'me' ? h - 4 : 40), rgb, 8);
    }
    // コマ番号の階段ドット
    for (let k = 0; k <= fr.i % 100; k++) {
      const dx = 30 + (k % 5) * 5, dy = 6 + Math.floor(k / 5) * 4;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) put(out, W, ox + dx + a, oy + dy + b, 255, 0, 0);
    }
    count++;
  }
  writePng(opts.out, W, H, out);
  return { n: count, W, H };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const num = (f, d) => { const i = a.indexOf(f); return i >= 0 ? +a[i + 1] : d; };
  const str = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const video = a[0], t0 = +a[1], t1 = +a[2];
  if (!video || !isFinite(t0) || !isFinite(t1)) { console.error('usage: node tools/rally-sheet.js <video> <t0> <t1> [--fps 10] [--cols 5] [--w 384] [--run run.json] [--out sheet.png]'); process.exit(2); }
  build({ video, t0, t1, fps: num('--fps', 10), cols: num('--cols', 5), w: num('--w', 384), run: str('--run', null), out: str('--out', 'sheet.png') })
    .then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { build };
