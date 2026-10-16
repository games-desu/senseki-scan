// SENSEKI SCAN — ラリー解析の実行役（main.js が子プロセスとして起動する。ELECTRON_RUN_AS_NODE で素の Node として動く）
// 中身は tools/rally-match.js（Phase A → ポイントごとのボール追跡・フィーバーのバナー）と rally-store.js の fromAnalysis。
// 解析は重いので main の中では回さない（回すとウィンドウが固まる）。進捗は process.send で親へ。
//
//   起動: fork(rally-runner.js, [], { env: { SENSEKI_TOOLS, SENSEKI_FFMPEG } }) → 親から { video, workDir, out }
//   親へ: { type:'progress', stage:'phaseA'|'points'|'save', ratio, text } / { type:'done', out, counts } / { type:'error', error }
// ffmpeg は tools 側の findFfmpeg が SENSEKI_FFMPEG を見るので、アプリと同じ同梱 ffmpeg（ffmpeg-static）になる。
'use strict';
const fs = require('fs');
const path = require('path');
const RS = require('./renderer/rally-store.js');

const send = m => { if (process.send) process.send(m); };
// 最後の知らせは届いてから終わる（すぐ exit すると親に届かないことがある）
const sendWait = m => new Promise(r => process.send ? process.send(m, () => r()) : r());
// tools の console.log（ポイントごとの打の一覧）は捨てる。親が stdout を読まないので溜まって止まらないように
console.log = () => {};

async function main({ video, workDir, out }) {
  const tools = process.env.SENSEKI_TOOLS;
  const RM = require(path.join(tools, 'rally-match.js'));
  // 前回の途中結果が混ざらないよう作業フォルダは空にする
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  // 進捗の配分: Phase A（得点表示の読み取り）を 0〜15%、ポイントごとの解析を 15〜97%、保存を残り
  await RM.run({
    video, out: workDir, fever: 'auto',
    onPhaseA: (t, dur) => send({ type: 'progress', stage: 'phaseA', ratio: 0.15 * Math.min(1, t / dur), text: `得点表示を読んでいます ${Math.round(t)} / ${Math.round(dur)} 秒` }),
    onPoint: ({ done, total }) => send({ type: 'progress', stage: 'points', ratio: 0.15 + 0.82 * done / total, text: `ラリーを解析しています ${done} / ${total} ポイント` }),
  });

  send({ type: 'progress', stage: 'save', ratio: 0.98, text: '保存しています' });
  const phaseA = JSON.parse(fs.readFileSync(path.join(workDir, 'phaseA.json'), 'utf8'));
  if (!phaseA.points || !phaseA.points.length) throw new Error('ポイントが見つかりませんでした（対戦の録画か確かめてください）');
  const details = {};
  for (const f of fs.readdirSync(workDir)) {
    const m = /^p(\d+)\.json$/.exec(f);
    if (m) details[+m[1]] = JSON.parse(fs.readFileSync(path.join(workDir, f), 'utf8'));
  }
  const st = fs.statSync(video);
  const store = RS.fromAnalysis(phaseA, details, { name: path.basename(video), path: video, size: st.size });
  fs.writeFileSync(out + '.tmp', JSON.stringify(store));
  fs.renameSync(out + '.tmp', out);
  await sendWait({ type: 'done', out, counts: RS.counts(store) });
}

process.once('message', job => {
  main(job).then(() => process.exit(0), async e => {
    await sendWait({ type: 'error', error: String(e && e.message || e), detail: String(e && e.stack || '') });
    process.exit(1);
  });
});
