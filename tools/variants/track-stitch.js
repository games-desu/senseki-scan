// 方針4「短い鎖を捨てず、時系列に縫い合わせる」。
//
// 素の ballSegments は「rank>=28 の鎖を rank 順に並べ、時間が重なったら捨てる」。
// これは2つの理由で壊れる:
//   ① rank は遠近正規化されていないので、遠コートの本物より近コートの偽物のほうが高く出る。
//      実測(10-44-35 383.85付近): 打点直後に飛び去るボールの鎖(rank 32.2)が、
//      同時刻の別物体の鎖(rank 36.7)に時間重複で締め出されていた。
//   ② 打点直後の鎖は短く rank が低いので、閾値28に届かず丸ごと落ちる。
//
// 置き換えの考え方は「1本を選ぶ」のをやめ「時系列に繋ぐ」こと。
//   優先度0 = すでに採用した区間の端と運動学的に整合する鎖（連結コストの小さい順）
//   優先度1 = どこにも繋がらないが rank が高い鎖（新しい島の種）
// 優先度0が常に優先度1に勝つので、**rank が高いだけの偽物より、直前の採用区間の終端と
// 位置・速度・見え方で整合する短い鎖のほうが先に採られる**。採った鎖は次の錨にもなるので、
// 種→打点直後の短い鎖→さらにその先、と鎖が時系列に育つ。
//
// 連結の可否は距離だけでは決めない（診断Dの実測: 距離だけで identity を守ろうとすると
// 上限を緩めた瞬間に別物へ乗り移る）。塊の大きさ n の比を条件に入れ、
// 速度の連続性は**条件ではなく加点**にしてある（打点では速度は必ず反転するため）。
//
// さらに融合パス。隙間の前後が「自由飛行を続けたと考えて矛盾しない」なら1本のセグメントにする。
//   自由飛行では画面x速度は保存し、画面y速度は重力で下向きにだけ増える。
//   打点はx速度を変え、打点/バウンドはy速度を上向きに転じる。→ 事象の無い分断だけが融合される。
// これは false event を減らすだけでなく、セグメント端の位置を正す。
//   実例(383.20..383.53 と 383.67..383.77 の融合): 融合前は eventCandidates の
//   0.12秒デデュープで seg-end 383.767 が seg-start 383.667 に潰されて 383.79 の打点を落としていた。
//   融合すると端が 383.200 と 383.767 になり、打点が拾えるようになる。
//
// 静止物フィルタは no-static 相当（overlap 撤廃・ネット帯だけ幾何で除去）で外してある。
//
// 検証（tools/rally-bench.js・人手ラベル12件・すべて実測）:
//   ベースライン(overlap<0.6) found  5 correct  5 covered 10 coverMean 10.8 nearMean 0.427 onBall  9 false 26
//   no-static (対照)         found 11 correct  9 covered 11 coverMean 13.4 nearMean 0.516 onBall 10 false 25
//   本変種                   found 11 correct 10 covered 11 coverMean 14.2 nearMean 0.547 onBall 10 false 22
(() => {
  const B = window.BallTrack;

  const SEED_RANK  = 28;     // 島の種にできる rank。素の minRank と同じ値にしてある
  const MIN_LEN    = 3;      // 縫う対象にする最小の鎖長
  const Y_MIN      = 20;     // 鎖の中央値yがこれより上（960空間）＝背景帯だけを渡る鎖は縫わない
  const REV_MAX    = 0.1;    // 渡り歩き鎖の棄却（診断C: 背景鎖 0.66 / ボール鎖 全11本 0.00）
  const AMBIG      = 2;      // 同じ時間帯を争う2本の連結コスト差がこれ未満なら**どちらも採らない**
  const GMAX       = 15;     // 連結を許す最大の隙間（フレーム）。実測の平坦域は 12〜15
  const VMAX       = 26;     // 隙間の平均速度の上限 px/frame @960（診断D実測 p99=25.7）
  const NRATIO     = 3;      // 端点の塊の大きさ n の比の上限（乗り移り防止）
  const GPEN       = 0.4;    // 隙間が長いほど不利にする
  const NPEN       = 2;      // 見え方が違うほど不利にする
  const BOTH_BONUS = 0.6;    // 前後両方に繋がる鎖を優先する
  const VEL_WIN    = 4;      // 端の速度を測る点数
  const VEL_BONUS  = 6;      // 速度が連続しているときの加点（条件ではない）
  const VEL_SCALE  = 12;
  const MERGE_GAP  = 12;     // 融合を許す最大の隙間（フレーム）
  const MERGE_TOL  = 12;     // 等加速度外挿の位置許容 px @960
  const MERGE_TOL_F= 1.5;    // 同・隙間1フレームあたりの上乗せ
  const MERGE_VX   = 4;      // 横速度の変化がこれを超えたら打点とみなし融合しない
  const MERGE_VUP  = 1.5;    // 縦速度が上向きに転じたら反転とみなし融合しない
  const G_ACC      = 0.6;    // 重力で説明できる縦速度の増分 px/frame^2 @960

  const first = ch => ch.pts[0];
  const last  = ch => ch.pts[ch.pts.length - 1];

  // 静止物フィルタは撤廃。ネット帯だけ従来どおり幾何で外す（no-static と同じ）
  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net;
    return cands.filter(c => !(net && c.y >= net.y0 && c.y <= net.y1));
  }

  function yMed(ch) {
    const ys = ch.pts.map(p => p.y).slice().sort((a, b) => a - b);
    return ys[ys.length >> 1];
  }

  // 10コマ以上前の自分の位置(半径6px)へ戻った点の割合。静止ブロブを渡り歩く鎖だけが正になる。
  function revisitRatio(pts) {
    if (pts.length <= 10) return 0;
    let rev = 0;
    for (let i = 10; i < pts.length; i++)
      if (pts.slice(0, i - 9).some(q => Math.hypot(q.x - pts[i].x, q.y - pts[i].y) < 6)) rev++;
    return rev / (pts.length - 10);
  }

  // 鎖の端の速度 [px/frame @960]
  function edgeVel(pts, atEnd) {
    const m = Math.min(VEL_WIN, pts.length);
    const seq = atEnd ? pts.slice(pts.length - m) : pts.slice(0, m);
    if (seq.length < 2) return null;
    const a = seq[0], b = seq[seq.length - 1];
    const df = b.f - a.f;
    return df > 0 ? { x: (b.x - a.x) / df, y: (b.y - a.y) / df } : null;
  }

  // 早い鎖 A の終端 → 遅い鎖 C の始端 の連結コスト。null なら連結不可。
  function linkCost(A, C) {
    const p = last(A), q = first(C);
    const g = Math.round((q.t - p.t) * 60);
    if (g < 1 || g > GMAX) return null;
    const v = Math.hypot(q.x - p.x, q.y - p.y) / g;
    if (v > VMAX) return null;
    const na = Math.max(1, p.n), nb = Math.max(1, q.n);
    const nr = Math.max(na, nb) / Math.min(na, nb);
    if (nr > NRATIO) return null;
    let c = v + g * GPEN + (nr - 1) * NPEN;
    const va = edgeVel(A.pts, true), vc = edgeVel(C.pts, false);
    if (va && vc) {
      const dv = Math.hypot(va.x - vc.x, va.y - vc.y);
      c -= Math.max(0, VEL_BONUS * (1 - dv / VEL_SCALE));   // 速度連続は加点。反転しても落とさない
    }
    return c;
  }

  // 採用済みの直前セグメント / 直後セグメントとの連結コストのうち良いほう
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
    if (dvy > G_ACC * g) return false;                        // 重力で説明できない落ち方
    const ay = dvy / g;
    const ex = p.x + va.x * g;
    const ey = p.y + va.y * g + 0.5 * ay * g * g;
    return Math.hypot(q.x - ex, q.y - ey) <= MERGE_TOL + MERGE_TOL_F * g;
  }

  function ballSegments(ranked, opts = {}) {
    const pool = ranked.filter(ch =>
      ch.len >= MIN_LEN && yMed(ch) >= Y_MIN && revisitRatio(ch.pts) <= REV_MAX);

    const acc = [];
    const taken = new Set();
    const clash = ch => acc.some(o => first(ch).t <= o.t1 && last(ch).t >= o.t0);
    const push = ch => { taken.add(ch); acc.push({ ...ch, t0: first(ch).t, t1: last(ch).t }); };

    // 縫い合わせ本体。連結できる鎖があるかぎり rank を無視して連結を優先し、
    // 尽きたときだけ次に rank の高い鎖で新しい島を起こす。
    // 同じ時間帯に僅差の対抗馬がいるときは**推測せずどちらも捨てる**。
    // 実例(10-44-35 388.15): 遠コートの2本が 11.42 と 11.55 で並び、目視するとどちらも
    // ボールではなかった（片方はラケットの光沢、片方は小ブロブの飛び石）。
    const rejected = new Set();
    for (let guard = 0; guard < 500; guard++) {
      const linked = [];
      let bestSeed = null;
      for (const ch of pool) {
        if (taken.has(ch) || rejected.has(ch) || clash(ch)) continue;
        const c = acc.length ? bestLink(ch, acc) : null;
        if (c != null) linked.push({ ch, c });
        else if (ch.rank >= SEED_RANK && (!bestSeed || ch.rank > bestSeed.rank)) bestSeed = ch;
      }
      linked.sort((a, b) => a.c - b.c);
      if (linked.length) {
        const b = linked[0];
        const rival = linked.find(o => o.ch !== b.ch && o.c - b.c < AMBIG &&
          first(o.ch).t <= last(b.ch).t && last(o.ch).t >= first(b.ch).t);
        if (rival) { rejected.add(b.ch); rejected.add(rival.ch); continue; }
        push(b.ch);
      } else if (bestSeed) push(bestSeed);
      else break;
    }
    acc.sort((a, b) => a.t0 - b.t0);

    // 融合パス。事象の無い分断だけを1本にまとめ、セグメント端を本物の打点/バウンドに揃える。
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
    filterCandidates, ballSegments, revisitRatio, linkCost, freeFlight,
  });
})();
