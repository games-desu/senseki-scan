// 方針1: 静止物の棄却を「毎フレームの overlap」から「鎖の段階」へ移す。
//
// ── なぜ毎フレームの overlap が間違いなのか（実測）
// candidates() が返す overlap は前フレームのマスクとの重なり率で、幾何的には
//     overlap ≒ 1 − (1フレーム移動量) / (見かけ直径)
// でしかない。つまり overlap>=0.6 は「移動量が直径の45%未満」と同義であって、
// 「静止している」ことを測っていない。実測でボールは
//   ・打点/バウンド直後の減速期  ・山なりの頂点  ・カメラ軸方向に飛ぶ局面  ・手前で大きく写る局面
// のいずれでも 0.6 を超える。10-44-35 の t=387.22〜387.55 では、完全に見えている
// ボールが19コマ連続で「静止物」として捨てられていた。
//
// ── 置き換えの原理: 静止物は「動かない」のではなく「同じ場所に居続ける」
// カメラはラリー中もドリーする（実測 最大 5px/frame @FHD = 2.5px/frame @960）ので、
// 静止物も画面上を動く。よって1コマの移動量では判定できない。
// 代わりに、カメラドリーの上限内でしか動けない候補を時間方向に繋いだ「居座り鎖」を作り、
// その鎖の**寿命**で静止物を決める。ボールは同じ場所に留まれないので必ず短い鎖にしかならない。
// 転がるボールは「ゆっくり」だが一方向へ進み続けるので、平滑アンカーから離れて鎖が切れる。
//
// ── 実測（fl_1044/fl_2202 の候補 3590 個・参照ボール点 354 個）
//   ボール点の居座り長: <6コマ 348点(98.3%) / 6〜29コマ 6点(1.7%) / 30コマ以上 **0点**
//   一方 HUDアイコン(31,27)@960 は 381/402・375/378 コマ居座る。分離は桁違い。
//   ボール軌跡の隣接リンクの最小移動量 1.23〜1.27 px/frame。
//     現行の静止下限 d<1.2*k は余裕 1.03倍しかない（＝少し遅い転がりで切れる）。
//     本変種は 0.6 なので余裕 2.05倍。しかも「両端が居座り候補のときだけ」適用する。
//
// ── 構成（3段）
//   ① 候補: overlap 判定を完全撤去（ネット帯の幾何除外だけ残す）
//   ② 鎖:   居座り鎖 30コマ以上の候補は削除。ほぼ動かないリンクの禁止は
//            「両端の居座り長 >= 6コマ」のときだけ適用（静止らしさを候補の属性に落とした形）
//   ③ 鎖:   渡り歩き鎖（自分が居た場所へ戻る）を revisit率で棄却。背景鎖は
//            複数の静止ブロブを縫って進むので span も見かけ速度も大きく出るため、
//            span や移動量では落とせない。実測 背景鎖 0.66 / ボール鎖 全11本が 0.00。
//
// ── 検証（tools/rally-bench.js・人手ラベル12件・すべて実行して得た値）
//   現行(overlap<0.6)  found  5 correct 5 covered 10 coverMean 10.8 nearMean 0.427 onBall  9 false 26
//   本変種             found 11 correct 9 covered 11 coverMean 14.1 nearMean 0.547 onBall 10 false 24
//   参考 no-static     found 11 correct 9 covered 11 coverMean 13.4 nearMean 0.516 onBall 10 false 25
(() => {
  const B = window.BallTrack;

  // カメラドリーの実測上限 5px/frame @FHD = 2.5px/frame @960。
  // これを超えて動くものは、その時点で静止物ではありえない。
  const DWELL_R    = 2.5;
  const DWELL_GAP  = 8;    // 色マスクが瞬いて欠測しても同じ居座りとみなすコマ数
  const DWELL_KILL = 30;   // 0.5秒 居座ったら静止物確定（ボールの最長は実測8コマ → 余裕3.7倍）
  const DWELL_GATE = 6;    // ここから上を「静止らしい候補」とみなす（1〜2コマの重なりでは棄却しない）
  const MIN_STEP   = 0.6;  // 静止らしい候補同士の、ほぼ動かないリンクの下限（実測ボール最小 1.23 の半分）
  const REV_MAX    = 0.2;  // 渡り歩き鎖の棄却しきい値

  // ---- ① 候補: 静止物の棄却をここでは一切やらない ----
  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net;
    return cands.filter(c => !(net && c.y >= net.y0 && c.y <= net.y1));
  }

  // ---- 居座り鎖 ----
  // 平滑アンカー(EMA)から R*gap 以内にある候補だけを繋ぐ。
  // EMA にしているのが要で、一方向へ進み続けるもの（＝転がるボール）は
  // 1コマの移動量が小さくてもアンカーから置いていかれて鎖が切れる。
  // 「ゆっくり動く」ではなく「同じ場所に居続ける」を測るための仕掛け。
  // 返り値: "frameIndex:candIndex" → その候補が属する居座り鎖の長さ
  function dwellChains(frames, R = DWELL_R, maxGapF = DWELL_GAP) {
    const all = [], live = [];
    frames.forEach((fr, f) => {
      const cs = fr.c || [];
      const used = new Set();
      for (let j = live.length - 1; j >= 0; j--) {
        const t = live[j], gap = f - t.lastF;
        if (gap > maxGapF) { live.splice(j, 1); continue; }
        let best = null;
        for (let i = 0; i < cs.length; i++) {
          if (used.has(i)) continue;
          const d = Math.hypot(cs[i][0] - t.x, cs[i][1] - t.y);
          if (d > R * gap) continue;
          if (!best || d < best.d) best = { i, d };
        }
        if (best) {
          used.add(best.i);
          const c = cs[best.i];
          t.x = t.x * 0.85 + c[0] * 0.15;
          t.y = t.y * 0.85 + c[1] * 0.15;
          t.n++; t.lastF = f; t.nodes.push(f + ':' + best.i);
        }
      }
      for (let i = 0; i < cs.length; i++) {
        if (used.has(i)) continue;
        const o = { x: cs[i][0], y: cs[i][1], n: 1, lastF: f, nodes: [f + ':' + i] };
        all.push(o); live.push(o);
      }
    });
    const len = new Map();
    for (const t of all) for (const k of t.nodes) len.set(k, t.n);
    return len;
  }

  // ---- ② 鎖づくり ----
  // ball.js の buildChains と同じ動的計画法。違いは2点だけ:
  //   ・居座り長 >= DWELL_KILL の候補はノードにしない
  //   ・ほぼ動かないリンクの禁止を、両端が「静止らしい候補」のときだけに限定する
  function buildChains(frames, opts = {}) {
    const maxStep = opts.maxStep ?? 18;
    const maxGap = opts.maxGap ?? 6;
    const minLen = opts.minLen ?? 5;
    const dwell = dwellChains(frames);

    const byFrame = frames.map(() => []);
    frames.forEach((fr, f) => (fr.c || []).forEach((c, ci) => {
      const dw = dwell.get(f + ':' + ci) || 1;
      if (dw >= DWELL_KILL) return;                     // 静止物確定。ボールは実測で一度も届かない
      byFrame[f].push({ f, t: fr.t, x: c[0], y: c[1], n: c[2], fill: c[3], rg: c[4], dw,
                        best: 1, prev: null, vel: null, used: false });
    }));
    const nodes = byFrame.flat();

    for (const nd of nodes) {
      for (let k = 1; k <= maxGap; k++) {
        const pf = nd.f - k;
        if (pf < 0) break;
        for (const p of byFrame[pf]) {
          const d = Math.hypot(nd.x - p.x, nd.y - p.y);
          if (d > maxStep * k) continue;
          // 静止ゲート。**両端が居座り候補のときだけ**適用する。
          // 素の ball.js は無条件に d<1.2*k を切るので、ロブ頂点や転がりのボールを巻き添えにする。
          if (d < MIN_STEP * k && nd.dw >= DWELL_GATE && p.dw >= DWELL_GATE) continue;
          let pen = 0;
          if (p.vel) {
            const vx = (nd.x - p.x) / k, vy = (nd.y - p.y) / k;
            pen = Math.min(1.2, Math.hypot(vx - p.vel.x, vy - p.vel.y) / 10);
          }
          const sc = p.best + 1 - pen - (k - 1) * 0.35;
          if (sc > nd.best) {
            nd.best = sc; nd.prev = p; nd.vel = { x: (nd.x - p.x) / k, y: (nd.y - p.y) / k };
          }
        }
      }
    }

    const chains = [];
    for (const end of nodes.slice().sort((a, b) => b.best - a.best)) {
      if (end.used) continue;
      const path = [];
      for (let nd = end; nd; nd = nd.prev) { if (nd.used) break; path.push(nd); }
      if (path.length < minLen) continue;
      path.reverse();
      path.forEach(nd => { nd.used = true; });
      const xs = path.map(p => p.x), ys = path.map(p => p.y);
      chains.push({
        pts: path.map(p => ({ t: p.t, f: p.f, x: p.x, y: p.y, n: p.n })),
        len: path.length, score: end.best,
        spanX: Math.max(...xs) - Math.min(...xs),
        spanY: Math.max(...ys) - Math.min(...ys),
        y0: Math.min(...ys), y1: Math.max(...ys),
      });
    }
    return chains.sort((a, b) => b.score - a.score);
  }

  // ---- ③ 渡り歩き鎖の棄却 ----
  // 10コマ以上前の自分の位置(半径6px)へ戻った点の割合。本物のボールは常に 0。
  function revisitRatio(pts) {
    if (pts.length <= 10) return 0;
    let rev = 0;
    for (let i = 10; i < pts.length; i++)
      if (pts.slice(0, i - 9).some(q => Math.hypot(q.x - pts[i].x, q.y - pts[i].y) < 6)) rev++;
    return rev / (pts.length - 10);
  }

  function pickBall(chains, opts = {}) {
    return B.pickBall(chains, opts).filter(ch => revisitRatio(ch.pts) <= REV_MAX);
  }

  window.BallTrack = Object.assign({}, B, {
    filterCandidates, buildChains, pickBall, dwellChains, revisitRatio,
  });
})();
