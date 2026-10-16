// アプリで手直しした保存ファイル → 調整用GT（tools/rally-bench2.js が読む gt-edit 形式）
//   node tools/rally-store-gt.js <store.json> [--out samples/rally/gt-app-<名前>.json]
// 確認済みのポイントだけを書く（方針B: 手直しした結果を調整用GTとして溜める）。
const fs = require('fs');
const path = require('path');
const RS = require('../app/renderer/rally-store.js');

const args = process.argv.slice(2);
if (!args[0]) { console.error('使い方: node tools/rally-store-gt.js <store.json> [--out <gt.json>]'); process.exit(1); }
const store = JSON.parse(fs.readFileSync(args[0], 'utf8'));
const i = args.indexOf('--out');
const out = i >= 0 ? args[i + 1]
  : path.join(__dirname, '..', 'samples', 'rally', 'gt-app-' + store.video.name.replace(/\.[^.]+$/, '').replace(/[^0-9A-Za-z-]+/g, '') + '.json');
const gt = RS.toGt(store);
fs.writeFileSync(out, JSON.stringify(gt, null, 1));
console.log(`${out}\n  確認済み ${gt.points.length} ポイント・打 ${gt.points.reduce((a, p) => a + p.hits.length, 0)}`);
