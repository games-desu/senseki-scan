// 試合まるごとのラリー解析（Node・ヘッドレス）。
// Phase A（得点HUD → ポイント境界）で「ラリーが映っている区間」だけを切り出し（＝ラリーゲート）、
// その区間だけにボール追跡（Phase C・tools/variants/merged2）を走らせる。
//
//   node tools/rally-match.js <video> [--points pts.json] [--only 3,4,5] [--variant merged2] [--fever auto|banners.json]
//                             [--pre 0] [--post 0.3] [--out samples/rally/<name>/]
//
// --points を省略すると highlight-node.run() で Phase A を走らせる（2fps・12分動画で約2.5分）。
// 出力: <out>/points.json（ポイント一覧＋各ポイントのイベント）・<out>/p<idx>.json（rally-node の生結果）
const fs = require('fs');
const path = require('path');
const { analyze } = require('./rally-node.js');
const HL = require('./highlight-node.js');
const FB = require('./fever-banners-node.js');

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
  // フィーバーショット: ラケット名バナー（tools/fever-banners-node.js）の時刻 ±(0.5/0.6) 秒にある打点を 'fever' にする。
  // 無ければバナー時刻に打点を補う（側は直前の打点の反対・無ければ マイラケット=自分）。'auto' はポイント区間ごとに 5fps で走査
  let banners = null;
  if (opts.fever && opts.fever !== 'auto' && fs.existsSync(opts.fever)) banners = JSON.parse(fs.readFileSync(opts.fever, 'utf8'));
  const feverFile = path.join(outDir, 'fever-banners.json');
  if (opts.fever === 'auto' && fs.existsSync(feverFile)) banners = JSON.parse(fs.readFileSync(feverFile, 'utf8'));
  // 既存の points.json があれば --only で解析しなかったポイントを残す（以前は --only のたびに上書きされて消えていた）
  const pointsFile = path.join(outDir, 'points.json');
  const prevPoints = fs.existsSync(pointsFile) ? (JSON.parse(fs.readFileSync(pointsFile, 'utf8')).points || []) : [];
  const summary = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (only && !only.has(i)) continue;
    const t0 = +(p.hudOn - (opts.pre || 0)).toFixed(2), t1 = +(p.hudOff + (opts.post == null ? 0.3 : opts.post)).toFixed(2);
    const started = Date.now();
    const r = await analyze({ video, t0, t1, fps, variant: opts.variant || 'merged2', trail: true });
    if (opts.fever === 'auto' && !banners) { banners = []; }
    if (opts.fever === 'auto') {
      const have = banners.some(b => b.t0 >= t0 - 1 && b.t0 <= t1 + 1) || (banners._scanned || []).some(w => w[0] === t0);
      if (!have) { const ev = await FB.scan({ video, t0, t1, fps: 5 }); banners.push(...ev); (banners._scanned = banners._scanned || []).push([t0, t1]); }
    }
    if (banners && r.rally) {
      for (const b of banners) {
        if (b.t0 < t0 - 1 || b.t0 > t1 + 1) continue;
        const cand = r.rally.filter(h => h.t >= b.t0 - 0.5 && h.t <= b.t0 + 0.6).sort((x, y) => Math.abs(x.t - b.t0) - Math.abs(y.t - b.t0))[0];
        if (cand) { cand.clsColor = cand.clsColor || cand.cls; cand.cls = 'fever'; cand.racket = b.name || null; cand.bannerT = b.t0; }
        else {
          const prev = [...r.rally].reverse().find(h => h.t < b.t0 && h.t >= b.t0 - 2.0);
          const side = prev ? (prev.side === 'me' ? 'opp' : 'me') : (b.name === 'マイラケット' ? 'me' : 'opp');
          r.rally.push({ t: +b.t0.toFixed(3), side, cls: 'fever', src: 'banner', racket: b.name || null, bannerT: b.t0, serve: false, land: null });
          r.rally.sort((x, y) => x.t - y.t);
        }
      }
    }
    const file = path.join(outDir, `p${i}.json`);
    fs.writeFileSync(file, JSON.stringify(r, null, 1));
    const evs = r.events.map(e => ({ t: +e.t.toFixed(3), kind: e.kind, side: e.side, x: +e.x.toFixed(1), y: +e.y.toFixed(1),
                                     X: e.X, Z: e.Z, qc: e.qc, src: e.src, suspect: e.suspect || null }));
    const rally = (r.rally || []).map(h => ({ t: h.t, side: h.side, cls: h.cls, src: h.src, serve: !!h.serve, suspect: h.suspect || null, from: h.from, land: h.land, racket: h.racket, clsColor: h.clsColor, apex: h.apex, apexTrail: h.apexTrail }));
    const row = { idx: i, game: p.game, winner: p.winner, score: `${p.scoreBefore} → ${p.scoreAfter}`, rally,
                  t0, t1, dur: +(t1 - t0).toFixed(2), ms: Date.now() - started,
                  nSeg: r.segments.length, nEv: evs.length, events: evs, file: path.basename(file) };
    summary.push(row);
    const line = evs.map(e => `${e.t.toFixed(2)}${e.kind === 'hit' ? 'H' : e.kind === 'bounce' ? 'B' : '?'}${e.side === 'me' ? 'm' : 'o'}${e.suspect ? '!' : ''}`).join(' ');
    console.log(`p${i} ${row.score.padEnd(12)} ${t0}-${t1} (${row.dur}s ${(row.ms / 1000).toFixed(1)}s) seg=${row.nSeg} ev=${row.nEv}`);
    for (const h of rally) console.log(`    ${h.t.toFixed(2)} ${h.side.padEnd(3)} ${h.cls.padEnd(7)} ${h.src}${h.racket ? ' [' + h.racket + ']' : ''}${h.serve ? ' SERVE' : ''}${h.suspect ? ' !' + h.suspect : ''}  land ${h.land ? `${h.land.t.toFixed(2)} X${h.land.X} Z${h.land.Z}${h.land.inCourt ? '' : ' OUT'}${h.land.bridged ? ' ~' : ''}` : '-'}`);
    const merged = prevPoints.filter(p => !summary.some(q => q.idx === p.idx)).concat(summary).sort((a, b) => a.idx - b.idx);
    fs.writeFileSync(pointsFile, JSON.stringify({ video, info, variant: opts.variant || 'merged2', points: merged }, null, 1));
    if (banners && opts.fever === 'auto') fs.writeFileSync(feverFile, JSON.stringify(banners.filter(b => b.t0 != null), null, 1));
  }
  return { outDir, summary };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const video = a[0];
  if (!video) { console.error('usage: node tools/rally-match.js <video> [--points pts.json] [--only 3,4] [--variant merged2] [--out dir]'); process.exit(2); }
  run({ video, points: get('--points'), only: get('--only') ? get('--only').split(',').map(Number) : null,
        variant: get('--variant'), out: get('--out'), pre: +get('--pre', 0), post: +get('--post', 0.3), fever: get('--fever') })
    .then(r => console.log(`done → ${r.outDir}`)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run };
