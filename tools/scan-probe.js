// 全編を1fpsでストリーム分類し、classify の3条件と提案ルールを毎秒記録する
//   node tools/scan-probe.js <video> <outJson> [maxSec]
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
const sb = { console, Math, Uint8Array, Uint32Array, Float32Array, Uint8ClampedArray, Object, JSON, Array, isFinite, isNaN };
sb.window = sb; vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'vision.js'), 'utf8'), sb, { filename: 'vision.js' });
const V = sb.Vision;

const W = 192, H = 108, FB = W * H * 4;
const isBlue = (r, g, b) => b > 120 && b > r + 40 && g < b;
const isOrange = (r, g, b) => r > 160 && g > 40 && g < 170 && b < 100;
const isWhite = (r, g, b) => r > 200 && g > 200 && b > 200;
const isDark = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < 60;

(async () => {
  const [video, outJson, maxSec] = [process.argv[2], process.argv[3], +(process.argv[4] || 1e9)];
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (isFinite(maxSec) && maxSec < 1e9) args.push('-t', String(maxSec));
  args.push('-i', video, '-vf', `fps=1,scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-');
  const ff = spawn(findFfmpeg(), args);
  ff.stderr.on('data', d => process.stderr.write(d));
  let buf = Buffer.alloc(0), t = 0;
  const rows = [];
  for await (const c of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= FB) {
      const img = { data: new Uint8ClampedArray(buf.subarray(0, FB)), width: W, height: H };
      buf = buf.subarray(FB);
      const cls = V.classify(img);
      const blue = V.frac(img, 67, 91, 78, 98, isBlue);
      const orange = V.frac(img, 111, 90, 124, 99, isOrange);
      const white = V.frac(img, 90, 89, 103, 100, isWhite);
      // 提案の追加手掛かり: 名前帯の黒（左右）
      const blackL = V.frac(img, 16, 91, 60, 98, isDark);
      const blackR = V.frac(img, 132, 91, 176, 98, isDark);
      rows.push({ t, cls, blue: +blue.toFixed(3), orange: +orange.toFixed(3), white: +white.toFixed(3),
                  bl: +blackL.toFixed(3), br: +blackR.toFixed(3) });
      t++;
    }
  }
  fs.writeFileSync(outJson, JSON.stringify(rows));
  console.log(JSON.stringify({ video: path.basename(video), frames: rows.length,
    vs: rows.filter(r => r.cls === 'vs').length }));
})();
