// VS画面の照合対象クロップをPNGに書く（目視診断用）
//   node tools/vs-dump.js <video> <t> <outPrefix>
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const zlib = require('zlib');

function findFfmpeg() {
  const base = 'C:/Program Files/CapCut/Apps';
  for (const d of fs.readdirSync(base).sort().reverse()) {
    const p = path.join(base, d, 'ffmpeg.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) { CRC_T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c ^ -1;
}
function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const VW = 1280, VH = 720;
async function grabFull(video, t) {
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const chunks = []; for await (const c of ff.stdout) chunks.push(c);
  return { data: new Uint8ClampedArray(Buffer.concat(chunks).subarray(0, VW * VH * 4)), width: VW, height: VH };
}
function cropRegion(frame, r) {
  const k = VW / 1920;
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const sx = (r.x + x) * k, sy = (r.y + y) * k;
    const x0 = Math.min(VW - 2, Math.floor(sx)), y0 = Math.min(VH - 2, Math.floor(sy));
    const fx = sx - x0, fy = sy - y0, o = (y * r.w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const p00 = frame.data[(y0 * VW + x0) * 4 + c], p01 = frame.data[(y0 * VW + x0 + 1) * 4 + c];
      const p10 = frame.data[((y0 + 1) * VW + x0) * 4 + c], p11 = frame.data[((y0 + 1) * VW + x0 + 1) * 4 + c];
      out[o + c] = p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy;
    }
    out[o + 3] = 255;
  }
  return { data: out, width: r.w, height: r.h };
}
(async () => {
  const sandbox = { console, Math, Uint8Array, Uint32Array, Float32Array, Uint8ClampedArray, Object, JSON, Array, isFinite, isNaN };
  sandbox.window = sandbox; vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'vision.js'), 'utf8'), sandbox, { filename: 'vision.js' });
  const V = sandbox.Vision;
  const [video, t, prefix] = [process.argv[2], +process.argv[3], process.argv[4]];
  const fr = await grabFull(video, t);
  for (const key of ['court', 'myicon', 'oppicon', 'oppname']) {
    const img = cropRegion(fr, V.REGIONS[key]);
    writePng(`${prefix}_${key}.png`, img.width, img.height, img.data);
  }
  console.log('dumped', prefix);
})();
