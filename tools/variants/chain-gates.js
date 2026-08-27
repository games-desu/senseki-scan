// 担当2「鎖づくり(buildChains)と区間選別(pickBall/ballSegments)の門を直す」
//
// 置き換えるのは buildChains / pickBall / ballSegments の3つだけ。
// candidates は素のまま、filterCandidates は no-static 相当（overlap 撤廃・ネット帯だけ幾何で除去）を
// 内蔵しているので、b0 = `--variant no-static` との差分がそのまま本変種の効果になる。
//
// 実測（tools/rally-bench.js・人手ラベル12件・すべて自分で実行）
//   現行(overlap<0.6)  found  5 correct  5 covered 10 coverMean 10.8 nearMean 0.427 onBall  9 false 26
//   b0 = no-static     found 11 correct  9 covered 11 coverMean 13.4 nearMean 0.516 onBall 10 false 25
//   本変種             found 12 correct 11 covered 12 coverMean 17.0 nearMean 0.624 onBall 10 false 25
//
// ------------------------------------------------------------------------------------------------
// 1. buildChains — 上限は遠近スケール、identity は「見え方＋速度」で守る
//
//   ・maxStep=18 固定をやめ cap = max(12, 2.5 * expectDiam(y)/SC) にする。
//     診断D の実測どおり打点直後は 21.9 px/frame @960 出るので 18 では検閲になる。
//     **floor(12) を 18 に上げてはいけない**: 遠コートで上限が緩むと 384.48 の打点を落とす（実測 c11→c8）。
//     逆に stepK は 2.4〜2.7 が平坦域で、2.3 まで下げると 122.30 の打点が消える。
//   ・minStep(d<1.2k) は撤廃。ロブ頂点のボールは 0.12〜1.3 px/frame しか動かない。
//   ・撤廃した分の identity は2つのゲートで守る（上限だけ上げると別物に乗り移り onBall 10→8）。
//       - 塊の大きさの比 max(n)/min(n) <= 3
//       - 速度変化 |v_new - v_prev| <= 13 px/frame  （12〜14 が平坦域。11 や 15 にすると correct が 3件落ちる）
//
// 2. pickBall — 遠近正規化＋「長さ加点の上限」
//
//   ・nAvg は期待面積 A(y)=0.785*expectDiam(y)^2 で、spanY は期待直径で割る。
//     素の式は同じ軌跡でも遠コートというだけで rank が30点前後不利になる。
//   ・**塊の大きさは「小さすぎ」だけ減点し「大きすぎ」は減点しない。**
//     飛行中の本物はトレイルと融合して n が期待面積の2〜3倍になるので、対称な減点だと
//     居座り物（打球エフェクトの残骸 nRel=0.89）が本物（nRel=2.0）に勝つ。実測でこれを踏んだ。
//   ・**len 加点に上限(8点)を入れるのが必須。** minStep を外すと画面固定のHUDアイコン(31,27)@960 が
//     len=400 の鎖になり、0.25/点だと rank 100点を稼いで全部の鎖を締め出す（実測 found 12→6）。
//
// 3. ballSegments — minRank 撤廃・縫い合わせ・重なりは「捨てず削る」
//
//   ・minRank=28 の足切りは廃止。採否は「時間的に隣接する採用済み区間と運動学＋見え方で繋がるか」で決め、
//     rank は新しい島の種を選ぶときだけ使う（tools/variants/track-stitch.js の設計を踏襲）。
//   ・**revisit 判定を「一度離れてから戻った点」に限定した。** 素の実装（離れたかを問わない）は
//     ゆっくり漂うロブ頂点のボールを静止物と誤判定する。実測で 10-44-35 386.07..386.77 の
//     ロブ頂点鎖(len32)が丸ごと落ち、386.42 の打点が消えていた。
//   ・静止物の棄却は (spanX+spanY)/期待直径 < 1.5 で行う。HUDアイコンは 0.35、ロブ頂点鎖は 12。
//     span そのものや移動量では判定しない（診断C: 背景鎖は静止ブロブを渡り歩くので span も速度も大きく出る）。
//   ・**採用済み区間と重なる鎖は捨てずに、重なった部分だけ削って残りを使う。**
//     トレイル融合で1つの飛行が「本体」と「尾」の2本の鎖に割れるため、丸ごと捨てると
//     打点直後の本物が消える（実測 387.60..387.85 の上昇軌跡）。
//   ・融合(freeFlight)の許容を実測に合わせた: 位置許容を期待直径に比例させ(5倍)、
//     下向き加速の許容を 0.6→3 px/frame^2 にした。どちらも「トレイルの尾から次の鎖が始まる」ための余裕で、
//     横速度の連続(±4px/frame)と「上向きに転じていないこと」という本質的な条件は締めたままにしてある。
//
// ------------------------------------------------------------------------------------------------
// falseEvents が増える主因（調べた結果）
//   シーン判定の不在ではなく、**セグメントの本数**だった。eventCandidates は各セグメントの
//   seg-start と seg-end を候補にするので、区間が1本増えるとイベントが最大2個増える。
//   実測: 総イベント数 - 14 が falseEvents にほぼ一致する（b0 39-14=25 / 本変種 39-14=25）。
//   さらに悪いことに、余計な境界は classifyEvents の tStop（次候補の 0.06 秒前で打ち切り）を通じて
//   **直前の本物のイベントの判定窓を潰す**。119.70 の打点が unknown だったのは、0.116 秒後の
//   seg-end のせいで窓が 0.026 秒に切り詰められていたためで、融合して境界を消したら qc=1.462 で正解した。
//   → falseEvents を下げる手は「短い区間を捨てる」ではなく「事象の無い分断を融合して境界を減らす」。
(() => {
  const B = window.BallTrack;
  const SC = 2;
  const d960At = y960 => B.expectDiam(y960 * SC) / SC;   // その画面yで期待されるボール直径（960空間）

  // ---- buildChains ----
  const STEP_K     = 2.5;   // 上限 = STEP_K * 期待直径。実測の最大比は 2.11〜2.85
  const STEP_FLOOR = 12;    // 遠コートの下限。18 に上げると 384.48 の打点を落とす
  const MAX_GAP    = 6;
  const MIN_LEN    = 5;
  const N_RATIO    = 3;     // 前後ノードの塊の大きさの比の上限
  const VEL_GATE   = 13;    // 速度変化の上限 [px/frame @960]

  // ---- pickBall ----
  const W_SIZE = 25, N_REL_LO = 0.6, N_REL_HI = 3.5;
  const W_SPAN = 3, SPAN_CAP = 20;
  const W_LEN = 0.25, LEN_CAP = 8;
  const W_VERT = 20, W_NET = 25;
  const FLAT_PEN = 25, FLAT_TH = 2.5;

  // ---- ballSegments ----
  const SEED_RANK   = 40;   // 新しい島の種にできる rank（28〜50 は同点。60 で崩れる）
  // 縫い合わせの対象にする最低 rank。素の minRank=28 のような「順位で足切り」ではなく、
  // 明らかに弱い鎖を土俵から下ろすだけ（採否は今も連結性で決まる）。
  // これが無いと 384.40..384.53 で**ハナチャンの頭の白い花**(rank 16)が縫い込まれる。目視で確認済み。
  // 18〜35 は7指標が完全に同点なので、真ん中を採った。
  const POOL_RANK   = 25;
  const MIN_LEN_SEG = 3;
  const Y_MIN       = 20;   // 鎖の中央値y（960空間）。背景帯だけを渡る鎖は縫わない
  const STATIC_SPAN = 1.5;  // (spanX+spanY)/期待直径。これ未満は静止物
  const REV_MAX     = 0.1;  // 渡り歩き率の上限
  const REV_NEAR    = 6;    // 「戻ってきた」とみなす距離
  const REV_LEAVE   = 20;   // 「一度離れた」とみなす距離。0 にすると漂うボールを殺す
  const AMBIG       = 2;    // 僅差の対抗馬がいたら**どちらも採らない**
  const GMAX        = 15;   // 連結を許す最大の隙間（フレーム）
  // 隙間の平均速度の上限 px/frame @960。GT実測の p99=25.7 に合わせる。
  // **32 以上にしてはいけない。** ベンチの数値は良くなる(coverMean 16.6→17.0)が、目視すると
  // 387.58〜387.78 の採用トラックが**ハナチャンの頭の白い花**に乗り換えている（実測で確認）。
  const VMAX        = 26;
  const SEG_NRATIO  = 3;
  const GPEN = 0.4, NPEN = 2, BOTH_BONUS = 0.6;
  const VEL_WIN = 4, VEL_BONUS = 6, VEL_SCALE = 12;

  // ---- 融合パス（事象の無い分断だけを1本にする） ----
  const MERGE_GAP  = 24;    // 融合を許す最大の隙間（フレーム）
  const MERGE_TOL  = 12;    // 位置許容の下限 px @960
  const MERGE_TOL_D= 5;     // 同・期待直径に比例する分（トレイルの先端と尾のズレを吸収する）
  const MERGE_TOL_F= 1.5;   // 同・隙間1フレームあたりの上乗せ
  const MERGE_VX   = 4;     // 横速度の変化がこれを超えたら打点とみなし融合しない
  const MERGE_VUP  = 1.5;   // 縦速度が上向きに転じたら反転とみなし融合しない
  const G_ACC      = 3;     // 下向きの加速の許容 px/frame^2。遠近効果とトレイルのズレで 4.8 まで出る

  // 静止物フィルタは撤廃。ネット帯だけ従来どおり幾何で外す（no-static 相当）
  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net;
    return cands.filter(c => !(net && c.y >= net.y0 && c.y <= net.y1));
  }

  function buildChains(frames, opts = {}) {
    const maxGap = opts.maxGap ?? MAX_GAP;
    const minLen = opts.minLen ?? MIN_LEN;
    const byFrame = frames.map(() => []);
    frames.forEach((fr, f) => (fr.c || []).forEach(c => {
      byFrame[f].push({ f, t: fr.t, x: c[0], y: c[1], n: c[2], fill: c[3], rg: c[4],
                        best: 1, prev: null, vel: null, used: false });
    }));
    const nodes = byFrame.flat();

    for (const nd of nodes) {
      for (let k = 1; k <= maxGap; k++) {
        const pf = nd.f - k;
        if (pf < 0) break;
        for (const p of byFrame[pf]) {
          const d = Math.hypot(nd.x - p.x, nd.y - p.y);
          // 上限は遠近スケール。下限（静止＝背景）はここでは持たない
          const cap = Math.max(STEP_FLOOR, STEP_K * d960At((nd.y + p.y) / 2));
          if (d > cap * k) continue;
          // identity ゲート①: 見え方（塊の大きさ）が急に変わる連結は別物
          const na = Math.max(1, p.n), nb = Math.max(1, nd.n);
          const nr = Math.max(na, nb) / Math.min(na, nb);
          if (nr > N_RATIO) continue;
          const vx = (nd.x - p.x) / k, vy = (nd.y - p.y) / k;
          let pen = 0;
          if (p.vel) {
            // identity ゲート②: 速度が飛ぶ連結は別物（打点での反転は鎖を切ってよい。区間側で縫う）
            const dv = Math.hypot(vx - p.vel.x, vy - p.vel.y);
            if (dv > VEL_GATE) continue;
            pen = Math.min(1.2, dv / 10);
          }
          const sc = p.best + 1 - pen - (k - 1) * 0.35;
          if (sc > nd.best) { nd.best = sc; nd.prev = p; nd.vel = { x: vx, y: vy }; }
        }
      }
    }

    const chains = [];
    const sorted = nodes.slice().sort((a, b) => b.best - a.best);
    for (const end of sorted) {
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

  // ---- 鎖の指標（すべて遠近正規化する） ----
  function yMedOf(ch) {
    const ys = ch.pts.map(p => p.y).slice().sort((a, b) => a - b);
    return ys[ys.length >> 1];
  }
  function stats(ch) {
    const nAvg = ch.pts.reduce((a, p) => a + p.n, 0) / ch.len;
    const d = Math.max(2, d960At(yMedOf(ch)));
    return {
      nAvg, d, nRel: nAvg / (0.785 * d * d),
      spanRel: ch.spanY / d, moveRel: (ch.spanX + ch.spanY) / d,
      vertRatio: ch.spanY / Math.max(20, ch.spanX + ch.spanY),
    };
  }

  function pickBall(chains, opts = {}) {
    const net = opts.net;
    return chains.map(ch => {
      const st = stats(ch);
      // 小さすぎ（ノイズ）は減点、大きすぎ（トレイル融合）は減点しない
      const sizeScore = st.nRel >= N_REL_LO
        ? Math.max(0, Math.min(1, 1 - (st.nRel - N_REL_HI) / N_REL_HI))
        : Math.max(0, st.nRel / N_REL_LO);
      let s = W_SIZE * sizeScore
            + Math.min(SPAN_CAP, st.spanRel * W_SPAN)
            + Math.min(LEN_CAP, ch.len * W_LEN)      // ← 上限が無いと静止物の長大な鎖が全部を締め出す
            + st.vertRatio * W_VERT;
      if (net && ch.y0 < net.y0 && ch.y1 > net.y1) s += W_NET;   // ネットをまたいだ＝確実にボール
      if (st.spanRel < FLAT_TH) s -= FLAT_PEN;                    // ほぼ水平＝キャラ付属物
      return { ...ch, rank: s, nAvg: +st.nAvg.toFixed(1), nRel: +st.nRel.toFixed(2),
               spanRel: +st.spanRel.toFixed(2), moveRel: +st.moveRel.toFixed(2),
               vertRatio: +st.vertRatio.toFixed(2) };
    }).sort((a, b) => b.rank - a.rank);
  }

  // ---- 区間の縫い合わせ ----
  const first = ch => ch.pts[0];
  const last  = ch => ch.pts[ch.pts.length - 1];

  // 「一度 REV_LEAVE px 以上離れてから、REV_NEAR px 以内に戻ってきた」点の割合。
  // 静止ブロブを渡り歩く背景鎖だけが正になる。漂うだけのボールは 0 のまま。
  function revisitRatio(pts) {
    if (pts.length <= 10) return 0;
    let rev = 0;
    for (let i = 10; i < pts.length; i++) {
      let back = false;
      for (let j = i - 10; j >= 0 && !back; j--) {
        if (Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) >= REV_NEAR) continue;
        for (let m = j + 1; m < i; m++)
          if (Math.hypot(pts[m].x - pts[i].x, pts[m].y - pts[i].y) > REV_LEAVE) { back = true; break; }
      }
      if (back) rev++;
    }
    return rev / (pts.length - 10);
  }

  function edgeVel(pts, atEnd) {
    const m = Math.min(VEL_WIN, pts.length);
    const seq = atEnd ? pts.slice(pts.length - m) : pts.slice(0, m);
    if (seq.length < 2) return null;
    const a = seq[0], b = seq[seq.length - 1], df = b.f - a.f;
    return df > 0 ? { x: (b.x - a.x) / df, y: (b.y - a.y) / df } : null;
  }

  // 早い鎖 A の終端 → 遅い鎖 C の始端 の連結コスト。null なら連結不可。
  // 速度の連続性は**条件ではなく加点**（打点では速度が必ず反転するため）。
  function linkCost(A, C) {
    const p = last(A), q = first(C);
    const g = Math.round((q.t - p.t) * 60);
    if (g < 1 || g > GMAX) return null;
    const v = Math.hypot(q.x - p.x, q.y - p.y) / g;
    if (v > VMAX) return null;
    const na = Math.max(1, p.n), nb = Math.max(1, q.n);
    const nr = Math.max(na, nb) / Math.min(na, nb);
    if (nr > SEG_NRATIO) return null;
    let c = v + g * GPEN + (nr - 1) * NPEN;
    const va = edgeVel(A.pts, true), vc = edgeVel(C.pts, false);
    if (va && vc) {
      const dv = Math.hypot(va.x - vc.x, va.y - vc.y);
      c -= Math.max(0, VEL_BONUS * (1 - dv / VEL_SCALE));
    }
    return c;
  }

  function bestLink(ch, acc) {
    const t0 = first(ch).t, t1 = last(ch).t;
    let A = null, D = null;
    for (const s of acc) {
      if (s.t1 <= t0 && (!A || s.t1 > A.t1)) A = s;
      if (s.t0 >= t1 && (!D || s.t0 < D.t0)) D = s;
    }
    const cA = A ? linkCost(A, ch) : null;
    const cD = D ? linkCost(ch, D) : null;
    if (cA == null && cD == null) return null;
    if (cA != null && cD != null) return Math.min(cA, cD) * BOTH_BONUS;
    return cA != null ? cA : cD;
  }

  // 隙間の間ボールが自由飛行を続けていたと考えて矛盾しないか（＝事象の無い分断か）
  function freeFlight(A, D) {
    const p = last(A), q = first(D);
    const g = Math.round((q.t - p.t) * 60);
    if (g < 1 || g > MERGE_GAP) return false;
    const va = edgeVel(A.pts, true), vd = edgeVel(D.pts, false);
    if (!va || !vd) return false;
    if (Math.abs(va.x - vd.x) > MERGE_VX) return false;      // 横速度が変わった＝打点
    const dvy = vd.y - va.y;                                  // +で下向きに加速
    if (dvy < -MERGE_VUP) return false;                       // 上向きに転じた＝バウンド/打点
    if (dvy > G_ACC * g) return false;
    const ay = dvy / g;
    const ex = p.x + va.x * g;
    const ey = p.y + va.y * g + 0.5 * ay * g * g;
    const tol = Math.max(MERGE_TOL, MERGE_TOL_D * d960At((p.y + q.y) / 2)) + MERGE_TOL_F * g;
    return Math.hypot(q.x - ex, q.y - ey) <= tol;
  }

  function ballSegments(ranked, opts = {}) {
    // 足切りは rank ではなく「静止物でないこと」だけ
    const pool = ranked.filter(ch =>
      ch.len >= MIN_LEN_SEG && yMedOf(ch) >= Y_MIN && ch.rank >= POOL_RANK &&
      stats(ch).moveRel >= STATIC_SPAN && revisitRatio(ch.pts) <= REV_MAX);

    const acc = [], taken = new Set(), rejected = new Set();
    const push = (ch, src) => {
      taken.add(src);
      acc.push({ ...ch, t0: first(ch).t, t1: last(ch).t });
    };

    // 採用済み区間と時間が重なる部分を削り、残った最長の連続部分を返す。
    // 丸ごと捨てると、トレイル融合で「本体」と「尾」に割れた飛行の本体側が消える。
    const trimFree = ch => {
      const free = ch.pts.filter(p => !acc.some(o => p.t >= o.t0 - 1e-9 && p.t <= o.t1 + 1e-9));
      if (!free.length) return null;
      let best = null, run = [free[0]];
      for (let i = 1; i < free.length; i++) {
        if (free[i].f - free[i - 1].f <= MAX_GAP) run.push(free[i]);
        else { if (!best || run.length > best.length) best = run; run = [free[i]]; }
      }
      if (!best || run.length > best.length) best = run;
      if (best.length < MIN_LEN_SEG) return null;
      if (best.length === ch.pts.length) return ch;
      const xs = best.map(p => p.x), ys = best.map(p => p.y);
      return { ...ch, pts: best, len: best.length,
               spanX: Math.max(...xs) - Math.min(...xs), spanY: Math.max(...ys) - Math.min(...ys),
               y0: Math.min(...ys), y1: Math.max(...ys) };
    };

    // 連結できる鎖があるかぎり rank を無視して連結を優先し、
    // 尽きたときだけ次に rank の高い鎖で新しい島を起こす。
    for (let guard = 0; guard < 500; guard++) {
      const linked = [];
      let bestSeed = null, bestSeedSrc = null;
      for (const src of pool) {
        if (taken.has(src) || rejected.has(src)) continue;
        const ch = trimFree(src);
        if (!ch) continue;
        const c = acc.length ? bestLink(ch, acc) : null;
        if (c != null) linked.push({ ch, c, src });
        else if (ch.rank >= SEED_RANK && (!bestSeed || ch.rank > bestSeed.rank)) { bestSeed = ch; bestSeedSrc = src; }
      }
      linked.sort((a, b) => a.c - b.c);
      if (linked.length) {
        const b = linked[0];
        const rival = linked.find(o => o.src !== b.src && o.c - b.c < AMBIG &&
          first(o.ch).t <= last(b.ch).t && last(o.ch).t >= first(b.ch).t);
        if (rival) { rejected.add(b.src); rejected.add(rival.src); continue; }
        push(b.ch, b.src);
      } else if (bestSeed) push(bestSeed, bestSeedSrc);
      else break;
    }
    acc.sort((a, b) => a.t0 - b.t0);

    // 融合パス。事象の無い分断だけを1本にまとめ、境界候補の乱立を抑える。
    const out = [];
    for (const s of acc) {
      const prev = out[out.length - 1];
      if (prev && freeFlight(prev, s)) {
        prev.pts = prev.pts.concat(s.pts);
        prev.len = prev.pts.length;
        prev.t1 = s.t1;
        prev.rank = Math.max(prev.rank, s.rank);
      } else {
        out.push({ ...s, pts: s.pts.slice() });
      }
    }
    return out;
  }

  window.BallTrack = Object.assign({}, B, {
    filterCandidates, buildChains, pickBall, ballSegments,
    revisitRatio, linkCost, freeFlight, chainStats: stats,
  });
})();
