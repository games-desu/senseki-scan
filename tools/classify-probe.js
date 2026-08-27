// シーン分類のヘッドレス診断: 指定時刻のフレームを classify に通し、3条件の実測値を出す
//   node tools/classify-probe.js <video> <t> <t> ...
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

function findFfmpeg() {
  const base = 'C:/Program Files/CapCut/Apps';
  for (const d of fs.readdirSync(base).sort().reverse()) {
    const p = path.join(base, d, 'ffmpeg.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}
function loadVision() {
  const sandbox = { console, Math, Uint8Array, Uint32Array, Float32Array, Uint8ClampedArray, Object, JSON, Array, isFinite, isNaN };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'vision.js'), 'utf8'), sandbox, { filename: 'vision.js' });
  return sandbox.Vision;
}
async function grab(video, t, w, h) {
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video,
    '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const chunks = [];
  for await (const c of ff.stdout) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return { data: new Uint8ClampedArray(buf.subarray(0, w * h * 4)), width: w, height: h };
}
(async () => {
  const V = loadVision();
  const video = process.argv[2];
  const isBlue = (r, g, b) => b > 120 && b > r + 40 && g < b;
  const isOrange = (r, g, b) => r > 160 && g > 40 && g < 170 && b < 100;
  const isWhite = (r, g, b) => r > 200 && g > 200 && b > 200;
  for (const ts of process.argv.slice(3)) {
    const img = await grab(video, +ts, 192, 108);
    const cls = V.classify(img);
    const fr = (x0, y0, x1, y1, f) => +V.frac(img, x0, y0, x1, y1, f).toFixed(3);
    console.log(ts, 'cls=' + cls,
      'blue(67-78,91-98)=' + fr(67, 91, 78, 98, isBlue),
      'orange(111-124,90-99)=' + fr(111, 90, 124, 99, isOrange),
      'white(90-103,89-100)=' + fr(90, 89, 103, 100, isWhite));
  }
})();
