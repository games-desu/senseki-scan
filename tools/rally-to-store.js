// ラリー解析の結果（pts.json ＋ p<idx>.json）→ アプリの保存形式（app/renderer/rally-store.js）
//   node tools/rally-to-store.js <video> --points <pts.json> --dir <runDir> [--dir <runDir2> ...] [--out <file>]
// 同じ idx が複数の --dir にあれば先に書いた方を採る。--out を省くとアプリの保存先（%APPDATA%\SENSEKI SCAN\rally\）に書く。
const fs = require('fs');
const path = require('path');
const RS = require('../app/renderer/rally-store.js');

const args = process.argv.slice(2);
const video = args[0];
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const dirs = args.flatMap((a, i) => a === '--dir' ? [args[i + 1]] : []);
const ptsFile = opt('--points');
if (!video || !ptsFile || !dirs.length) {
  console.error('使い方: node tools/rally-to-store.js <video> --points <pts.json> --dir <runDir> [--dir ...] [--out <file>]');
  process.exit(1);
}
const pts = JSON.parse(fs.readFileSync(ptsFile, 'utf8'));
const details = {};
for (const d of dirs) {
  for (const f of fs.readdirSync(d)) {
    const m = /^p(\d+)\.json$/.exec(f);
    if (!m || details[+m[1]]) continue;
    details[+m[1]] = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  }
}
const vp = path.resolve(video);
const st = fs.existsSync(vp) ? fs.statSync(vp) : null;
const store = RS.fromAnalysis(pts, details, { name: path.basename(vp), path: st ? vp : null, size: st ? st.size : null });

let out = opt('--out');
if (!out) {
  const dir = path.join(process.env.APPDATA || '.', 'SENSEKI SCAN', 'rally');
  fs.mkdirSync(dir, { recursive: true });
  out = path.join(dir, path.basename(vp).replace(/\.[^.]+$/, '') + '.json');
}
fs.writeFileSync(out, JSON.stringify(store));
const c = RS.counts(store);
const missing = store.matches.flatMap(m => m.points.filter(p => p.missing).map(p => p.idx));
console.log(`${out}\n  試合${store.matches.length}・ポイント${c.pts}・打${c.shots}（要確認${c.flagged}）${missing.length ? '・解析結果なし p' + missing.join(',') : ''}`);
