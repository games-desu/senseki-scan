// レート連鎖の後段（index.html の「レート連鎖検証」ループ）を切り出して回す回帰テスト。
//   node tools/chain-test.js
// 素材は 2026-09-09 ぴんやさんの実行ログ（senseki-scan-report_20260909.txt）の10試合。
// m4 は レートパネルの安定ランが1つしか取れず「変動後=3174（＝変動前の値）」になっていた回。
// 期待: m4 が 3174→3163 に直り、m5 の変動前(画面読み3163)が前試合のafterで上書きされないこと。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'index.html'), 'utf8');
const s = src.indexOf('  // レート連鎖検証:');
const e = src.indexOf('  for (const m of videoMatches) snapshotOrig(m);');
if (s < 0 || e < 0) { console.error('レート連鎖検証ループを抽出できませんでした（index.html の書き換えで目印が消えた？）'); process.exit(1); }
const body = src.slice(s, e);

// 実行ログの m1..m10（画面から読めた素の値。null = 読めなかった）
const raw = [
  { n: 1,  before: 3166, after: 3161, result: 'loss', lone: false },
  { n: 2,  before: 3161, after: 3190, result: 'win',  lone: false },
  { n: 3,  before: 3190, after: 3174, result: 'loss', lone: false },
  { n: 4,  before: null, after: 3174, result: 'loss', lone: true  }, // ← 不具合の試合
  { n: 5,  before: 3163, after: 3197, result: 'win',  lone: false },
  { n: 6,  before: 3197, after: 3202, result: 'win',  lone: false },
  { n: 7,  before: 3202, after: 3197, result: 'loss', lone: false },
  { n: 8,  before: 3197, after: 3202, result: 'win',  lone: false },
  { n: 9,  before: 3202, after: 3207, result: 'win',  lone: false },
  { n: 10, before: 3207, after: 3213, result: 'win',  lone: false },
];
// この録画（1080p配信レイアウト＝ゲーム画面1404x789）はレートが緩和読みになるので全件 weak＝要確認。
// そのため試合中の RATE_CHAIN は繋がらず、前向き補完はこの後段だけが効く（利用者のログと同じ状態）
const videoMatches = raw.map(r => ({
  n: r.n, mode: 'classic_singles', result: r.result,
  ratingBefore: r.before, ratingAfter: r.after,
  flags: { ratingBefore: true, ratingAfter: true },
  _ratingRead: { before: r.before, after: r.after, lone: r.lone },
}));

const logs = [];
vm.runInNewContext(body, { videoMatches, log: m => logs.push(m) });
logs.forEach(l => console.log('  ' + l));
for (const m of videoMatches) console.log(`m${m.n}: ${m.ratingBefore}→${m.ratingAfter}${m.ratingBefore === m.ratingAfter ? '  ★前後同値（誤り）' : ''}`);

const m4 = videoMatches[3], m5 = videoMatches[4];
const ok = m4.ratingBefore === 3174 && m4.ratingAfter === 3163 && m5.ratingBefore === 3163;
console.log(ok ? 'OK: m4=3174→3163 / m5の変動前=3163' : 'NG: 期待は m4=3174→3163・m5の変動前=3163');
process.exit(ok ? 0 : 1);
