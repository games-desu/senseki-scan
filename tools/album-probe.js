// アルバム操作バー検出の実測: 1fpsストリームで候補特徴を全編記録
//   node tools/album-probe.js <video> <outJson>
// 特徴 (192x108空間):
//   legendWhite = 凡例行 (88-178, 100-104) の白画素率（L>200・低彩度）
//   legendDark  = 同帯の暗画素率（L<70）
//   ctrlWhite   = コントローラーアイコン域 (6-17, 99-107) の白画素率
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
const W = 960, H = 540, FB = W * H * 4;
const isWhite = (r, g, b) => r > 200 && g > 200 && b > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 40;
const isDark = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < 70;

(async () => {
  const [video, outJson] = [process.argv[2], process.argv[3]];
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', video,
    '-vf', `fps=1,scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  ff.stderr.on('data', d => process.stderr.write(d));
  let buf = Buffer.alloc(0), t = 0;
  const rows = [];
  for await (const c of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= FB) {
      const img = { data: new Uint8ClampedArray(buf.subarray(0, FB)), width: W, height: H };
      buf = buf.subarray(FB);
      rows.push({
        t,
        lw: +V.frac(img, 440, 502, 890, 521, isWhite).toFixed(3),
        ld: +V.frac(img, 440, 502, 890, 521, isDark).toFixed(3),
        cw: +V.frac(img, 35, 500, 85, 538, isWhite).toFixed(3),
      });
      t++;
    }
  }
  fs.writeFileSync(outJson, JSON.stringify(rows));
  console.log(JSON.stringify({ video: path.basename(video), frames: rows.length }));
})();
