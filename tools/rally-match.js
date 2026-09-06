// 試合まるごとのラリー解析（Node・ヘッドレス）。
// Phase A（得点HUD → ポイント境界）で「ラリーが映っている区間」だけを切り出し（＝ラリーゲート）、
// その区間だけにボール追跡（Phase C・tools/variants/merged2）を走らせる。
//
//   node tools/rally-match.js <video> [--points pts.json] [--only 3,4,5] [--variant merged2]
//                             [--pre 0] [--post 0.3] [--out samples/rally/<name>/]
//
// --points を省略すると highlight-node.run() で Phase A を走らせる（2fps・12分動画で約2.5分）。
// 出力: <out>/points.json（ポイント一覧＋各ポイントのイベント）・<out>/p<idx>.json（rally-node の生結果）
const fs = require('fs');
const path = require('path');
const { analyze } = require('./rally-node.js');
const HL = require('./highlight-node.js');

async function loadPoints(video, pointsFile) {
  if (pointsFile && fs.existsSync(pointsFile)) {
    const r = JSON.parse(fs.readFileSync(pointsFile, 'utf8'));
    return { info: r.info, points: r.points };
  }
  const r = await HL.run({ video, fps: 2 });
  if (pointsFile) fs.writeFileSync(pointsFile, JSON.stringify(r, null, 1));
  return { info: r.info, points: r.points };
}

async function run(opts) {
  const { video } = opts;
  const name = path.basename(video).replace(/\.[^.]+$/, '').replace(/[^0-9A-Za-z_-]+/g, '_');
  const outDir = opts.out || path.join(__dirname, '..', 'samples', 'rally', name);
  fs.mkdirSync(outDir, { recursive: true });
  const { info, points } = await loadPoints(video, opts.points || path.join(outDir, 'phaseA.json'));
  const fps = info && info.fps ? info.fps : 60;
  const only = opts.only ? new Set(opts.only) : null;
  const summary = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (only && !only.has(i)) continue;
    const t0 = +(p.hudOn - (opts.pre || 0)).toFixed(2), t1 = +(p.hudOff + (opts.post == null ? 0.3 : opts.post)).toFixed(2);
    const started = Date.now();
    const r = await analyze({ video, t0, t1, fps, variant: opts.variant || 'merged2', trail: true });
    const file = path.join(outDir, `p${i}.json`);
    fs.writeFileSync(file, JSON.stringify(r, null, 1));
    const evs = r.events.map(e => ({ t: +e.t.toFixed(3), kind: e.kind, side: e.side, x: +e.x.toFixed(1), y: +e.y.toFixed(1),
                                     X: e.X, Z: e.Z, qc: e.qc, src: e.src, suspect: e.suspect || null }));
    const rally = (r.rally || []).map(h => ({ t: h.t, side: h.side, cls: h.cls, src: h.src, serve: !!h.serve, suspect: h.suspect || null, from: h.from, land: h.land }));
    const row = { idx: i, game: p.game, winner: p.winner, score: `${p.scoreBefore} → ${p.scoreAfter}`, rally,
                  t0, t1, dur: +(t1 - t0).toFixed(2), ms: Date.now() - started,
                  nSeg: r.segments.length, nEv: evs.length, events: evs, file: path.basename(file) };
    summary.push(row);
    const line = evs.map(e => `${e.t.toFixed(2)}${e.kind === 'hit' ? 'H' : e.kind === 'bounce' ? 'B' : '?'}${e.side === 'me' ? 'm' : 'o'}${e.suspect ? '!' : ''}`).join(' ');
    console.log(`p${i} ${row.score.padEnd(12)} ${t0}-${t1} (${row.dur}s ${(row.ms / 1000).toFixed(1)}s) seg=${row.nSeg} ev=${row.nEv}`);
    for (const h of rally) console.log(`    ${h.t.toFixed(2)} ${h.side.padEnd(3)} ${h.cls.padEnd(7)} ${h.src}${h.serve ? ' SERVE' : ''}${h.suspect ? ' !' + h.suspect : ''}  land ${h.land ? `${h.land.t.toFixed(2)} X${h.land.X} Z${h.land.Z}${h.land.inCourt ? '' : ' OUT'}${h.land.bridged ? ' ~' : ''}` : '-'}`);
    fs.writeFileSync(path.join(outDir, 'points.json'), JSON.stringify({ video, info, variant: opts.variant || 'merged2', points: summary }, null, 1));
  }
  return { outDir, summary };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const video = a[0];
  if (!video) { console.error('usage: node tools/rally-match.js <video> [--points pts.json] [--only 3,4] [--variant merged2] [--out dir]'); process.exit(2); }
  run({ video, points: get('--points'), only: get('--only') ? get('--only').split(',').map(Number) : null,
        variant: get('--variant'), out: get('--out'), pre: +get('--pre', 0), post: +get('--post', 0.3) })
    .then(r => console.log(`done → ${r.outDir}`)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run };
