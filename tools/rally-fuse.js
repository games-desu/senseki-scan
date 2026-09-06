// SENSEKI SCAN ラリー解析: トレイル（Phase D）とボール追跡（Phase C）の融合（ブラウザ用・依存: Court があれば座標も出す）
//   RallyFuse.fuse({ shots, events, track, camAt, t0, t1 }) → { shots: [...] }
//
//  方針（2026-09-07）:
//   - 打点（誰が・いつ・何を打ったか）は **トレイルの出現** を正とする。トレイルは打点の +0.02〜0.05秒で立ち上がり
//     0.32秒以上残るので取りこぼしにくく、色がそのまま種別になる。
//   - 追跡イベント（kink/seg-end）の 'hit' は、トレイルが無い打点（とびつき・低い返球＝色エフェクトが出ない 27%）の補完にだけ使う。
//     ラリーは側が交替するので、同じ側の連続打点の間に反対側の追跡 'hit' があればそれを採る。
//   - 着弾（バウンド）は qc 判別器ではなく **追跡点の画面 y の極大**、または追跡の切れ目をまたぐ直線外挿の交点で取る。
//     無ければ null（ボレーか取りこぼし。当て推量はしない）。
window.RallyFuse = (() => {
  const LEAD = 0.03;   // トレイル出現 → 打点は少し前

  // 追跡が静止物（ネットポスト・看板・雲）に乗り移った区間を捨てる。
  // 静止物はカメラのドリーで最大 2.5px/コマ(960) 流れるので「動かない」では取れない。
  // 「毎コマ 2.5px 未満のゆっくりした動きが 12 コマ以上続く」を静止物とみなす（実測: 右ネットポスト 894→914 / 0.27秒）。
  // 窓で切る前に全体に掛けること（窓で切ると静止区間が短く見えて残る）。
  function purgeStatic(pts) {
    const out = [];
    let i = 0;
    while (i < pts.length) {
      let j = i;
      while (j + 1 < pts.length) {
        const dt = pts[j + 1].t - pts[j].t;
        if (dt > 0.07) break;                                   // 欠測が 4 コマを超えたら別の連なり
        if (Math.hypot(pts[j + 1].x - pts[j].x, pts[j + 1].y - pts[j].y) / Math.max(1, Math.round(dt * 60)) >= 2.5) break;
        j++;
      }
      if (j - i + 1 >= 12) { i = j + 1; continue; }
      out.push(pts[i]); i++;
    }
    return out;
  }
  function slope(pts) {           // dy/dt（px/秒）
    const n = pts.length; if (n < 2) return null;
    let st = 0, sy = 0, stt = 0, sty = 0;
    for (const p of pts) { st += p.t; sy += p.y; stt += p.t * p.t; sty += p.t * p.y; }
    const d = n * stt - st * st; if (Math.abs(d) < 1e-9) return null;
    return (n * sty - st * sy) / d;
  }

  // 着弾＝打点と打点の間で **画面 y が極大** になる追跡点（落ちてきて跳ね返る瞬間）。
  // 手前へ来る球も奥へ行く球も、地面で y の増加→減少に転じる。前後 0.25 秒で 4px(960) 以上の落差を要求し、
  // 最初に立つ極大を採る（跳ねた後にラケットへ落ちていく2つ目の最下点は後ろに来る）。
  // 追跡がバウンド前後で切れているときは、切れ目の前が下降・後が上昇なら直線外挿の交点で補う（bridged）。
  // 着弾点は地面に接しているので、地面ホモグラフィの見かけZに高さバイアスが乗らない＝座標が正確。
  function landingFromTrack(track, tA, tB, camAt, side = null) {
    const pts = track.filter(p => p.t > tA + 0.15 && p.t < tB - 0.05);
    if (pts.length < 5) return null;
    // 打った側のコートに落ちることはない（ネットに掛かる場合を除く）。座標が出せる候補は側で篩う
    const okSide = p => {
      if (!side || !camAt || typeof Court === 'undefined') return true;
      const cam = camAt(p.t); if (!cam || !cam.ok) return true;
      const Z = Court.toCourt(p.x * 2, p.y * 2, cam).Z;
      return side === 'me' ? Z > -0.5 : Z < 0.5;
    };
    let best = null;
    // (a) 切れ目をまたぐ推定
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t < 0.08) continue;
      const before = pts.slice(Math.max(0, i - 6), i), after = pts.slice(i, Math.min(pts.length, i + 6));
      const sa = slope(before), sb = slope(after);
      if (sa == null || sb == null || !(sa > 60) || !(sb < -60)) continue;   // px/秒（60fps で ±1px/コマ以上）
      const pa = before[before.length - 1], pb = after[0];
      const ts = (pb.y - pa.y + sa * pa.t - sb * pb.t) / (sa - sb);
      if (!(ts >= pa.t && ts <= pb.t)) continue;
      const y = pa.y + sa * (ts - pa.t), x = pa.x + (pb.x - pa.x) * (ts - pa.t) / (pb.t - pa.t);
      const p = { t: +ts.toFixed(3), x: +x.toFixed(1), y: +y.toFixed(1) };
      if (!okSide(p)) continue;
      best = { p, drop: +Math.min(y - pa.y, y - pb.y).toFixed(1), bridged: true };
      break;
    }
    // (b) 連続追跡の中の極大
    // 次の打点の直前 0.2 秒は除く（ラケットに入る直前の最下点を着弾と取り違える）
    for (let i = 2; !best && i < pts.length - 2; i++) {
      const p = pts[i];
      if (p.t >= tB - 0.2) break;
      if (!(p.y >= pts[i - 1].y && p.y >= pts[i + 1].y && p.y > pts[i - 2].y && p.y > pts[i + 2].y)) continue;
      if (!okSide(p)) continue;
      const before = pts.filter(q => q.t >= p.t - 0.25 && q.t < p.t), after = pts.filter(q => q.t > p.t && q.t <= p.t + 0.25);
      if (before.length < 2 || after.length < 2) continue;
      const drop = Math.min(p.y - Math.min(...before.map(q => q.y)), p.y - Math.min(...after.map(q => q.y)));
      if (drop >= 4) { best = { p, drop, bridged: false }; break; }
    }
    if (!best) return null;
    const base = { t: best.p.t, x: best.p.x, y: best.p.y, drop: +best.drop.toFixed(1), bridged: best.bridged };
    const cam = camAt ? camAt(best.p.t) : null;
    if (!cam || !cam.ok || typeof Court === 'undefined') return base;
    const c = Court.toCourt(best.p.x * 2, best.p.y * 2, cam);
    return Object.assign(base, { X: +c.X.toFixed(2), Z: +c.Z.toFixed(2), inCourt: Court.inCourt(c.X, c.Z, 0.3) });
  }

  function fuse({ shots = [], events = [], track = [], camAt = null, t0 = -Infinity, t1 = Infinity } = {}) {
    track = purgeStatic(track);
    const hits = shots.map(s => ({ t: +(s.t0 - LEAD).toFixed(3), side: s.side, cls: s.cls, src: 'trail',
                                   from: s.tail ? { X: s.tail.X, Z: s.tail.Z } : null, n: s.n, nMax: s.nMax, disp: s.disp }))
                      .sort((a, b) => a.t - b.t);
    // 同側連続 → 間に反対側の追跡 hit があれば補完
    const out = [];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i], prev = out[out.length - 1];
      if (prev && prev.side === h.side) {
        const cand = events.filter(e => e.kind === 'hit' && e.side !== h.side && e.t > prev.t + 0.15 && e.t < h.t - 0.1)
                           .sort((a, b) => (b.qc || 0) - (a.qc || 0))[0];
        if (cand) out.push({ t: cand.t, side: cand.side, cls: 'unknown', src: 'track', from: { X: cand.X, Z: cand.Z }, qc: cand.qc });
        else h.suspect = 'same-side';
      }
      out.push(h);
    }
    for (let i = 0; i < out.length; i++) {
      const h = out[i], tNext = i + 1 < out.length ? out[i + 1].t : t1;
      h.land = landingFromTrack(track, h.t, tNext, camAt, h.side);
      if (h.land && h.land.Z != null) h.land.wrongSide = h.side === 'me' ? h.land.Z < -0.5 : h.land.Z > 0.5;
      h.serve = i === 0;
    }
    return { shots: out };
  }
  return { fuse, landingFromTrack, purgeStatic };
})();
