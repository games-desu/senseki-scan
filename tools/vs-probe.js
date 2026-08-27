// VS画面の照合をヘッドレスで再現する診断ツール
//   node tools/vs-probe.js <video> <t> [<t>...]
// court / oppicon / myicon の照合スコア上位を出す
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
const VW = 1280, VH = 720;
async function grabFull(video, t) {
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const chunks = [];
  for await (const c of ff.stdout) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return { data: new Uint8ClampedArray(buf.subarray(0, VW * VH * 4)), width: VW, height: VH };
}
// cropRegion 相当（バイリニア縮小/拡大）。ブラウザの drawImage と厳密一致はしないが特徴量には十分
function cropRegion(frame, r) {
  const k = VW / 1920;
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const sx = (r.x + x) * k, sy = (r.y + y) * k;
    const x0 = Math.min(VW - 2, Math.floor(sx)), y0 = Math.min(VH - 2, Math.floor(sy));
    const fx = sx - x0, fy = sy - y0;
    const o = (y * r.w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const p00 = frame.data[(y0 * VW + x0) * 4 + c], p01 = frame.data[(y0 * VW + x0 + 1) * 4 + c];
      const p10 = frame.data[((y0 + 1) * VW + x0) * 4 + c], p11 = frame.data[((y0 + 1) * VW + x0 + 1) * 4 + c];
      out[o + c] = p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy;
    }
    out[o + 3] = 255;
  }
  return { data: out, width: r.w, height: r.h };
}
function wake(arr) {
  return arr.map(t => { const v = new Float32Array(t.v); if (t.aspect != null) v.aspect = t.aspect; return { ...t, v }; });
}
(async () => {
  const V = loadVision();
  const tj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'templates.json'), 'utf8'));
  const TPL = Object.fromEntries(Object.entries(tj.sets).map(([k, a]) => [k, wake(a)]));
  const video = process.argv[2];
  const R = V.REGIONS;
  for (const ts of process.argv.slice(3)) {
    const fr = await grabFull(video, +ts);
    const cv = V.textVec(cropRegion(fr, R.court), 32, 8);
    const scores = TPL.courts.map(t => ({ name: t.name, s: V.ncc(cv, t.v) }));
    const byName = {};
    for (const s of scores) byName[s.name] = Math.max(byName[s.name] ?? -1, s.s);
    const top = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const ov = V.iconVec(cropRegion(fr, R.oppicon), 16, 16);
    const oScores = {};
    for (const t of TPL.vsIcons) oScores[t.name] = Math.max(oScores[t.name] ?? -1, V.ncc(ov, t.v));
    const oTop = Object.entries(oScores).sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log('t=' + ts);
    console.log('  court:', top.map(([n, s]) => `${n}=${s.toFixed(3)}`).join('  '));
    console.log('  opp  :', oTop.map(([n, s]) => `${n}=${s.toFixed(3)}`).join('  '));
  }
})();

// --dump モード: クロップをPNGで書き出す（目視用）
if (process.argv.includes('--dump')) {
  // 上の即時関数と競合しないよう、環境変数で分岐する設計にはしていない。
  // このブロックは module.exports 用のダミー。実際のダンプは vs-dump.js を使う。
}
