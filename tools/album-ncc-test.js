// アルバム操作バーの凡例帯を textVec(白ch) テンプレ照合で判定できるかの検証
//   node tools/album-ncc-test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
function findFfmpeg() {
  const base = 'C:/Program Files/CapCut/Apps';
  for (const d of fs.readdirSync(base).sort().reverse()) {
    const p = path.join(base, d, 'ffmpeg.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}
const sb = { console, Math, Uint8Array, Uint32Array, Float32Array, Uint8ClampedArray, Object, JSON, Array, isFinite, isNaN };
sb.window = sb; vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(REPO, 'app/renderer/vision.js'), 'utf8'), sb, { filename: 'vision.js' });
const V = sb.Vision;

async function grab(video, t, w, h) {
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video,
    '-frames:v', '1', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const cs = []; for await (const c of ff.stdout) cs.push(c);
  return { data: new Uint8ClampedArray(Buffer.concat(cs).subarray(0, w * h * 4)), width: w, height: h };
}
function crop(f, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, s = ((y0 + y) * f.width + x0 + x) * 4;
    out[o] = f.data[s]; out[o + 1] = f.data[s + 1]; out[o + 2] = f.data[s + 2]; out[o + 3] = 255;
  }
  return { data: out, width: w, height: h };
}
const BAND = [440, 502, 890, 521];   // 960空間の凡例帯（FHD 880-1780 / 1004-1042）

(async () => {
  const D = path.join(REPO, 'samples/2026-08-25 23-52-59.mp4');
  // テンプレ = アルバムのバーが写っている t=700
  const ref = await grab(D, 700, 960, 540);
  const tv = f => V.textVec(crop(f, ...BAND), 48, 4);
  const tpl = tv(ref);
  const test = async (video, t, label) => {
    const f = await grab(video, t, 960, 540);
    const s = V.nccWh(tv(f), tpl);
    console.log(label.padEnd(30), 't=' + String(t).padEnd(7), 'nccWh=' + s.toFixed(3));
  };
  console.log('--- アルバム（バー有り・目視確定） ---');
  for (const t of [696, 698, 710, 725, 740]) await test(D, t, 'アルバム再生');
  console.log('--- ライブの誤爆候補（fracルールで落ちた面々） ---');
  for (const t of [163, 168, 200, 505, 682, 1300, 2051]) await test(D, t, 'レート待機/その他');
  console.log('--- 通常ライブ各種 ---');
  for (const t of [49, 300, 600, 900, 1500, 1900]) await test(D, t, 'VS/ラリー/他');
  const F = path.join(REPO, 'samples/2026-08-25 23-10-02.mp4');
  for (const t of [46, 500, 1000, 1240, 1400]) await test(F, t, 'フィーバー動画');
  const C = path.join(REPO, 'samples/2026-08-25 22-20-27.mp4');
  for (const t of [10, 400, 1400, 2000]) await test(C, t, '720pクラシック');
})();
