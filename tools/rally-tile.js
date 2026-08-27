// ラリー解析の目視用タイル生成（Node・依存なし）。
// 指定時刻まわりのフレームを切り出し、拡大してタイル状に並べた PNG を書く。
// 検出候補（rally-node の frameLog）を重ねられるので「なぜ落ちたか」が目で追える。
//
//   node tools/rally-tile.js <video> <t0> <nFrames> --at <xFHD> <yFHD> [options]
//     --box 240 180     切り出す範囲（FHD px・既定 260x200）
//     --zoom 3          拡大率（既定 3）
//     --cols 6          横に並べる枚数（既定 6）
//     --marks log.json  frameLog を読み、候補を四角、採用トラックを十字で重ねる
//     --out out.png
//
// 目盛り: 各コマの左上に赤い階段状のドットでコマ番号（1コマ=1ドット、5コマごとに段を変える）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

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

function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

async function grabFrames(video, t0, n, fps) {
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error',
    '-ss', String(t0), '-t', String(n / fps + 0.02), '-i', video,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  ff.stderr.on('data', d => process.stderr.write(d));
  const need = FW * FH * 4, out = [];
  let buf = Buffer.alloc(0);
  for await (const c of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= need && out.length < n) { out.push(buf.subarray(0, need)); buf = buf.subarray(need); }
    if (out.length >= n) break;
  }
  ff.kill();
  return out;
}

function build(opts) {
  const { frames, cx, cy, bw, bh, zoom, cols, marks, t0, fps } = opts;
  const cw = bw * zoom, ch = bh * zoom, gap = 2;
  const rows = Math.ceil(frames.length / cols);
  const W = cols * (cw + gap) + gap, H = rows * (ch + gap) + gap;
  const img = Buffer.alloc(W * H * 4, 0);
  for (let i = 3; i < img.length; i += 4) img[i] = 255;
  const px = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b;
  };
  const x0f = Math.round(cx - bw / 2), y0f = Math.round(cy - bh / 2);

  frames.forEach((fr, k) => {
    const ox = gap + (k % cols) * (cw + gap), oy = gap + ((k / cols) | 0) * (ch + gap);
    for (let y = 0; y < ch; y++) {
      const sy = y0f + ((y / zoom) | 0);
      for (let x = 0; x < cw; x++) {
        const sx = x0f + ((x / zoom) | 0);
        if (sx < 0 || sy < 0 || sx >= FW || sy >= FH) { px(ox + x, oy + y, 24, 24, 24); continue; }
        const s = (sy * FW + sx) * 4;
        px(ox + x, oy + y, fr[s], fr[s + 1], fr[s + 2]);
      }
    }
    // コマ番号の目盛り（左上・赤ドット）: 1の位を横、5の位を縦に積む
    for (let d = 0; d < (k % 5) + 1; d++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) px(ox + 2 + d * 4 + a, oy + 2 + b, 255, 40, 40);
    for (let d = 0; d < ((k / 5) | 0); d++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) px(ox + 2 + a, oy + 7 + d * 4 + b, 60, 160, 255);

    // 候補（緑の枠）と採用トラック（黄の十字）を重ねる
    if (marks) {
      const t = +(t0 + k / fps).toFixed(4);
      const rec = marks.find(m => Math.abs(m.t - t) < 0.5 / fps);
      if (rec) {
        const draw = (xF, yF, r, g, b, half) => {
          const X = ox + (xF - x0f) * zoom, Y = oy + (yF - y0f) * zoom;
          for (let d = -half; d <= half; d++) { px(Math.round(X + d), Math.round(Y - half), r, g, b); px(Math.round(X + d), Math.round(Y + half), r, g, b);
                                                px(Math.round(X - half), Math.round(Y + d), r, g, b); px(Math.round(X + half), Math.round(Y + d), r, g, b); }
        };
        (rec.c || []).forEach(c => draw(c[0] * 2, c[1] * 2, 60, 255, 90, 9));
        if (rec.pick) { const [X, Y] = rec.pick; draw(X * 2, Y * 2, 255, 220, 40, 13); }
      }
    }
  });
  return { img, W, H };
}

async function main() {
  const a = process.argv.slice(2);
  const num = (flag, def) => { const i = a.indexOf(flag); return i >= 0 ? +a[i + 1] : def; };
  const str = (flag, def) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : def; };
  const video = a[0], t0 = +a[1], n = +a[2];
  const atI = a.indexOf('--at');
  const cx = atI >= 0 ? +a[atI + 1] : FW / 2, cy = atI >= 0 ? +a[atI + 2] : FH / 2;
  const boxI = a.indexOf('--box');
  const bw = boxI >= 0 ? +a[boxI + 1] : 260, bh = boxI >= 0 ? +a[boxI + 2] : 200;
  const fps = num('--fps', 60), zoom = num('--zoom', 3), cols = num('--cols', 6);
  const out = str('--out', 'tile.png');
  const markFile = str('--marks', null);
  let marks = null;
  if (markFile) {
    const j = JSON.parse(fs.readFileSync(markFile, 'utf8'));
    marks = j.frameLog || j;
    if (j.segPts) {                                  // 採用トラックを pick として畳み込む
      const byT = new Map();
      j.segPts.forEach(s => s.pts.forEach(p => byT.set(+p.t.toFixed(4), [p.x, p.y])));
      marks = marks.map(m => ({ ...m, pick: byT.get(+m.t.toFixed(4)) || null }));
    }
  }
  const frames = await grabFrames(video, t0, n, fps);
  if (!frames.length) { console.error('no frames decoded'); process.exit(1); }
  const { img, W, H } = build({ frames, cx, cy, bw, bh, zoom, cols, marks, t0, fps });
  writePng(out, W, H, img);
  console.log(JSON.stringify({ out, tiles: frames.length, cols, grid: `${cols}x${Math.ceil(frames.length / cols)}`,
    px: `${W}x${H}`, t0, fps, box: [bw, bh], center: [cx, cy], zoom,
    note: 'コマは左上から行優先。赤ドット=下1桁+1 / 青ドット=5コマ単位' }));
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { writePng, grabFrames, build };
