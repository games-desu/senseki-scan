// ラリー解析ベンチ v2（打点の目視GTに対する再現率・適合率・種別正答）
//   node tools/rally-bench2.js samples/rally/gt-0908.json [--only 0,3] [--dir samples/rally/0908] [--run]
//   --run: rally-node を走らせ直す（無ければ <dir>/p<idx>.json を読む）
const fs = require('fs');
const path = require('path');
const { analyze } = require('./rally-node.js');
const TOL = 0.4;   // 目視GTの時刻は 10fps シート読みで ±0.3 秒ぶれる（チャージの閃光と打点の前後が紛らわしい）

async function main() {
  const a = process.argv.slice(2);
  const gt = JSON.parse(fs.readFileSync(a[0], 'utf8'));
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const only = get('--only') ? new Set(get('--only').split(',').map(Number)) : null;
  const dir = get('--dir', path.join('samples', 'rally', path.basename(a[0]).replace(/^gt-|\.json$/g, '')));
  const rerun = a.includes('--run');
  let F = 0, C = 0, N = 0, X = 0, S = 0;
  const rows = [];
  for (const p of gt.points) {
    if (only && !only.has(p.idx)) continue;
    const file = path.join(dir, `p${p.idx}.json`);
    let r;
    if (rerun || !fs.existsSync(file)) {
      r = await analyze({ video: gt.video, t0: p.t0, t1: p.t1, variant: 'merged2', trail: true });
      fs.writeFileSync(file, JSON.stringify(r, null, 1));
    } else r = JSON.parse(fs.readFileSync(file, 'utf8'));
    const det = (r.rally || []).slice();
    const used = new Set();
    for (const h of p.hits) {
      N++;
      let best = null;
      const tol = h.serve ? 0.6 : TOL;   // サーブはカット直後でカメラ復帰待ちの分だけ遅れる
      det.forEach((d, i) => { if (!used.has(i) && Math.abs(d.t - h.t) <= tol && d.side === h.side && (!best || Math.abs(d.t - h.t) < Math.abs(det[best].t - h.t))) best = i; });
      const d = best != null ? det[best] : null;
      if (d) { used.add(best); F++; if (d.cls === h.cls) C++; }
      rows.push({ p: p.idx, t: h.t, side: h.side, want: h.cls, got: d ? d.cls : '—', dt: d ? +(d.t - h.t).toFixed(2) : null, src: d ? d.src : null });
    }
    det.forEach((d, i) => { if (!used.has(i)) { X++; rows.push({ p: p.idx, t: d.t, side: d.side, want: '(extra)', got: d.cls, dt: null, src: d.src }); } });
    S++;
  }
  rows.sort((a, b) => a.p - b.p || a.t - b.t);
  console.table(rows);
  console.log(JSON.stringify({ points: S, gtHits: N, found: F, clsOk: C, extra: X, recall: +(F / N).toFixed(3), precision: +(F / (F + X)).toFixed(3), clsAcc: +(C / Math.max(1, F)).toFixed(3) }));
}
main().catch(e => { console.error(e); process.exit(1); });
