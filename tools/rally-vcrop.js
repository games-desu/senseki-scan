// far 由来の打点の目視用: フル解像度の切り抜きを 20fps で 4x4 タイルにする。
//   node tools/rally-vcrop.js <video> <t> <x960> <y960> <out.png> [--pre 0.4] [--fps 20] [--mark t2]
// 赤枠 = 打点時刻 t のコマ・青枠 = --mark（トレイル元の時刻など）・黄色の小枠 = イベント位置（全コマ）
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');
function ff() { const base = 'C:/Program Files/CapCut/Apps'; for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, 'ffmpeg.exe'); if (fs.existsSync(p)) return p; } }
const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const [video, t, x, y, out] = [a[0], +a[1], +a[2], +a[3], a[4]];
const pre = +get('--pre', 0.4), fps = +get('--fps', 20), N = 16;
const W = 1200, H = 600;
const cx = Math.max(0, Math.min(1920 - W, Math.round(x * 2 - W / 2)));
const cy = Math.max(0, Math.min(1080 - H, Math.round(y * 2 - H / 2 - 60)));
const ts = t - pre;
const k = Math.round(pre * fps);
const f = [`fps=${fps}`, `crop=${W}:${H}:${cx}:${cy}`,
  `drawbox=x=${Math.round(x * 2 - cx - 22)}:y=${Math.round(y * 2 - cy - 22)}:w=44:h=44:color=yellow@0.8:t=2`,
  `drawbox=enable='eq(n,${k})':x=0:y=0:w=iw:h=ih:color=red:t=8`];
if (get('--mark')) f.push(`drawbox=enable='eq(n,${Math.round((+get('--mark') - ts) * fps)})':x=0:y=0:w=iw:h=ih:color=blue:t=8`);
f.push('scale=600:-1', 'tile=4x4');
const r = spawnSync(ff(), ['-y', '-v', 'error', '-ss', ts.toFixed(3), '-i', video, '-t', (N / fps + 0.05).toFixed(3), '-vf', f.join(','), '-frames:v', '1', out]);
if (r.status) { console.error(String(r.stderr)); process.exit(1); }
console.log(`${out}  t0=${ts.toFixed(3)} fps=${fps} red=frame${k} crop=${cx},${cy}`);
