// Phase C のベンチマーク。docs/rally-probe/discriminator.md の人手ラベル12件に対して
// 現行パイプラインを走らせ、**再捕捉率**（イベント直後に何点追えているか）と種別正答を測る。
//
//   node tools/rally-bench.js [--json out.json] [--only 10-44-35]
//
// 測るもの:
//   found     ラベル時刻±TOL に検出イベントがあるか（検出率）
//   kind      その種別が正解と一致するか
//   cover     [t+0.03, t+0.50] に追跡点が何個あるか ← これが「再捕捉率」の実体。
//             slopeZ は3点必要。0〜2点だと種別が unknown になる。
//   trackCov  イベント前後 ±0.5秒のうち追跡できていたフレームの割合
const path = require('path');
const { analyze } = require('./rally-node.js');

const SAMPLES = path.join(__dirname, '..', 'samples');
const TOL = 0.12;                    // ラベル時刻とのマッチ許容
const MIN_SLOPE_PTS = 3;             // slopeZ が成立する最小点数

// discriminator.md §3 の正解データ（人手ラベル・目視確定）
const LABELS = [
  { id: 1,  vid: '2026-08-20 10-44-35.mp4', t: 383.79, kind: 'hit',    side: 'me',  x: 591,  y: 676 },
  { id: 2,  vid: '2026-08-20 10-44-35.mp4', t: 384.48, kind: 'hit',    side: 'opp', x: 1164, y: 211 },
  { id: 3,  vid: '2026-08-20 10-44-35.mp4', t: 385.19, kind: 'bounce', side: 'me',  x: 605,  y: 825 },
  { id: 4,  vid: '2026-08-20 10-44-35.mp4', t: 385.39, kind: 'hit',    side: 'me',  x: 640,  y: 826 },
  { id: 5,  vid: '2026-08-20 10-44-35.mp4', t: 386.42, kind: 'hit',    side: 'opp', x: 781,  y: 235 },
  { id: 6,  vid: '2026-08-20 10-44-35.mp4', t: 387.22, kind: 'bounce', side: 'me',  x: 454,  y: 812 },
  { id: 7,  vid: '2026-08-20 10-44-35.mp4', t: 387.55, kind: 'hit',    side: 'me',  x: 475,  y: 854 },  // とびつき
  { id: 8,  vid: '2026-08-20 10-44-35.mp4', t: 389.23, kind: 'bounce', side: 'me',  x: 510,  y: 924 },
  { id: 9,  vid: '2026-08-20 22-02-04.mp4', t: 117.25, kind: 'bounce', side: 'me',  x: 1331, y: 932 },
  { id: 10, vid: '2026-08-20 22-02-04.mp4', t: 118.56, kind: 'hit',    side: 'me',  x: 1272, y: 711 },
  { id: 11, vid: '2026-08-20 22-02-04.mp4', t: 119.70, kind: 'hit',    side: 'opp', x: 619,  y: 110 },
  { id: 12, vid: '2026-08-20 22-02-04.mp4', t: 122.30, kind: 'hit',    side: 'me',  x: 1330, y: 510 },
];

// ラベルを包む解析窓（前後に助走をつける）
const WINDOWS = [
  { vid: '2026-08-20 10-44-35.mp4', t0: 383.2, t1: 389.9 },
  { vid: '2026-08-20 22-02-04.mp4', t0: 116.7, t1: 123.0 },
];

function mergeTrack(segments) {
  const pts = [];
  segments.forEach(s => s.pts.forEach(p => pts.push(p)));
  return pts.sort((a, b) => a.t - b.t);
}

async function run(opts = {}) {
  const rows = [];
  const runs = [];
  for (const w of WINDOWS) {
    if (opts.only && !w.vid.includes(opts.only)) continue;
    const r = await analyze({ video: path.join(SAMPLES, w.vid), t0: w.t0, t1: w.t1, variant: opts.variant || null, overlapMax: opts.overlapMax });
    runs.push({ ...w, r });
    const track = mergeTrack(r.segPts || []);
    for (const L of LABELS.filter(L => L.vid === w.vid)) {
      const hits = r.events.filter(e => Math.abs(e.t - L.t) <= TOL);
      const m = hits.sort((a, b) => Math.abs(a.t - L.t) - Math.abs(b.t - L.t))[0] || null;
      const cover = track.filter(p => p.t >= L.t + 0.03 && p.t <= L.t + 0.50).length;
      const near = track.filter(p => p.t >= L.t - 0.50 && p.t <= L.t + 0.50).length;
      // ラベル座標(FHD)に追跡点が来ているか＝位置の正しさ
      const at = track.reduce((b, p) => (!b || Math.abs(p.t - L.t) < Math.abs(b.t - L.t) ? p : b), null);
      const dpx = at ? Math.hypot(at.x * 2 - L.x, at.y * 2 - L.y) : null;
      rows.push({
        id: L.id, t: L.t, want: L.kind, side: L.side,
        got: m ? m.kind : '—', dt: m ? +(m.t - L.t).toFixed(3) : null,
        ok: m ? (m.kind === L.kind) : false,
        cover, slopeOk: cover >= MIN_SLOPE_PTS,
        near: +(near / 61).toFixed(2),
        dpx: dpx == null ? null : Math.round(dpx),
        qc: m ? m.qc : null,
      });
    }
  }
  const found = rows.filter(r => r.got !== '—').length;
  const correct = rows.filter(r => r.ok).length;
  const covered = rows.filter(r => r.slopeOk).length;
  const extra = runs.reduce((s, x) => s + x.r.events.filter(e =>
    !LABELS.some(L => L.vid === x.vid && Math.abs(e.t - L.t) <= TOL)).length, 0);
  return {
    rows,
    variant: opts.variant || null,
    summary: {
      n: rows.length, found, correct, covered, falseEvents: extra,
      coverMean: +(rows.reduce((s, r) => s + r.cover, 0) / rows.length).toFixed(1),
      nearMean: +(rows.reduce((s, r) => s + r.near, 0) / rows.length).toFixed(3),
      onBall: rows.filter(r => r.dpx != null && r.dpx <= 40).length,
      ms: runs.reduce((s, x) => s + x.r.ms, 0),
    },
    runs: runs.map(x => ({ vid: x.vid, t0: x.t0, t1: x.t1, chains: x.r.chains,
                           segments: x.r.segments, events: x.r.events, camOk: x.r.camOk })),
  };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const jsonAt = a.indexOf('--json'), onlyAt = a.indexOf('--only'), varAt = a.indexOf('--variant'), ovAt = a.indexOf('--overlap');
  run({ only: onlyAt >= 0 ? a[onlyAt + 1] : null, variant: varAt >= 0 ? a[varAt + 1] : null, overlapMax: ovAt >= 0 ? (a[ovAt+1]==='off' ? null : +a[ovAt+1]) : undefined }).then(res => {
    console.table(res.rows);
    console.log(JSON.stringify(res.summary));
    if (jsonAt >= 0) require('fs').writeFileSync(a[jsonAt + 1], JSON.stringify(res, null, 1));
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, LABELS, WINDOWS };
