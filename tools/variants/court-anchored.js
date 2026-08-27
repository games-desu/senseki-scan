// 方針3「コート座標が不変なら静止物」の実装。
//
// ── なぜ overlap ではダメで、これなら効くのか ────────────────────────────────
// 現行の overlap>=0.6 は本質的に `1 − 移動量/見かけ直径` を測っているだけで、
// 「動いていない」ではなく「動きが直径に比べて小さい」しか見ていない。だから
// 打点/バウンド直後の減速期・ロブの頂点・カメラ軸方向に飛ぶ球を静止物として殺す。
// 一方カメラは**回転しない**ので、コート座標 (X,Z) が不変な点は次の3パラメータの
// アフィン写像に従う（w=1/(yF−YVP)=c0+c1Z, s=(xF−XVP)/(yF−YVP)=(X−Xc)c1/K）:
//
//     wB = a*wA + d      sB = a*sA + b        （a = c1B/c1A で w/s 共通）
//
// この写像を**横線ピークの w 列と縦線ピークの s 列の対応から直接**推定する。
// 「どの横線がベースラインか」を当てる必要がない＝絶対カメラ推定より遥かに頑健。
// （実測: Court.estimate の絶対解は 22-02-04 で |ΔyBase|/frame の p90 が 85px、
//   378フレーム中87フレームが suspect。ワープ推定なら横線の残差が p50 0.04〜0.15 FHD px）
//
// ── 判定 ────────────────────────────────────────────────────────────────
// 候補を最近傍で連結してトラックにし、各トラックについて
//   devC = 「最初の位置を固定コート点とみなしてワープで前進させた予測」からの生涯最大ズレ
//   devS = 「最初の画面位置」からの生涯最大ズレ（画面固定のHUD/UI用）
// を持つ。**len >= N_STATIC 連続で min(devC,devS) <= DEV_MAX を保った**トラックだけを
// 静止物と断定し、以後その候補を落とす。1コマの重なりではなく持続性で判定するので、
// 転がる球（実測19コマ）もロブ頂点（実測11コマ）も殺さない。
//
// ── 実測（自分で計測。数値は報告に貼ったものと同一） ──────────────────────
//   ワープの横線残差(FHD px) p50/p90:  ワープ後 0.038/2.44 (10-44-35)、0.153/3.98 (22-02-04)
//                                      ワープ無し 1.996/6.00、1.990/8.00
//   ボール由来トラックの最長 len: 22 (10-44-35) / 17 (22-02-04)
//   ボール由来トラックの min(devC,devS) 最小: 8.0 → DEV_MAX=5 で 1.6倍の余裕
//   N=20/DEV=5 で落とす候補 621/2567(24%) と 381/1261(30%)、うちGTボール点 0/429・0/291
//   コスト: 線特徴 約1.9ms/frame（Court.estimate をそのまま毎フレーム回すと 14〜17ms）
//
// ── カメラが解けないフレームのフォールバック ─────────────────────────────
// ワープが推定できない/暴走した（WARP_MAX 超）フレームは恒等写像で代用する。
// すると静止物の devC が伸びてトラックが成熟しなくなる＝**落とし損ねる側に倒れる**。
// ボールを殺す側には倒れないので安全。画面固定のUIは devS 側で拾い続ける。
(() => {
  const B = window.BallTrack;
  const W = 960, H = 540, SC = 2, XVP = 960, YVP = -651;

  // ---- パラメータ（すべて960空間） ----
  const R_ASSOC  = 4.5;   // 候補をアンカーに繋ぐ半径。カメラドリー上限 2.5px/frame を包む
  const N_STATIC = 20;    // 静止と断定するまでの**累積ヒット数**（連続である必要はない）
  const DEV_MAX  = 5.0;   // 固定点からの生涯最大ズレ。これを超えたアンカーは即座に捨てる
  const KILL_R   = 3.0;   // 成熟した静止アンカーが候補を掴む半径（超えたら別物として離す）
  const GAP_NEW  = 30;    // 未成熟アンカーが無ヒットで生き残るコマ数
  const GAP_OLD  = 150;   // 成熟した静止アンカーが無ヒットで生き残るコマ数
  const WARP_MAX = 8.0;   // 1フレームのワープ変位の上限。超えたら推定失敗とみなす

  // ================= 線特徴（Court.estimate の 1/8 のコスト） =================
  // Court.lineMask のコストの大半は「コート面輝度の中央値を sort で出す」部分（実測 7.1ms）。
  // ヒストグラムに置き換えると 0.11ms。マスク本体は g の下限で早期棄却する
  // （max−min<46 なら lum <= g+19 なので g < thr−19 の画素は必ず落ちる＝安全な枝刈り）。
  function lineFeat(img, Court) {
    const d = img.data;
    const hist = new Int32Array(256);
    let ns = 0;
    for (let y = 189; y < 497; y += 3) {
      let i = (y * W + 144) * 4;
      for (let x = 144; x < 816; x += 3, i += 12) { hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++; ns++; }
    }
    let acc = 0, CL = 0;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc * 2 >= ns) { CL = k; break; } }
    const thr = Math.max(CL * 1.06, 170), gmin = thr - 19;
    const mask = new Uint8Array(W * H);
    for (let y = 64; y < H; y++) {
      let i = y * W * 4; const row = y * W;
      for (let x = 0; x < W; x++, i += 4) {
        const g = d[i + 1];
        if (g < gmin) continue;
        const r = d[i], b = d[i + 2];
        if (0.299 * r + 0.587 * g + 0.114 * b <= thr) continue;
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx - mn < 46) mask[row + x] = 1;
      }
    }
    const prof = Court.rowProfile(mask);
    const hp = Court.peaksOf(prof, Court.TH.rowPeak, 5);
    const sp = Court.voteS(mask, prof);
    // 総当たり回数を抑えるため強い順に6本まで
    const topH = hp.slice().sort((a, b) => b.v - a.v).slice(0, 6);
    const topS = sp.slice().sort((a, b) => b.v - a.v).slice(0, 6);
    return { w: topH.map(p => 1 / (p.y * SC - YVP)), s: topS.map(p => p.s) };
  }

  // wB = a*wA + d を、対応の分からないピーク列から推定する（2点仮説 + インライア最大）
  function fitWarp(A, C) {
    if (!A || !C || A.w.length < 2 || C.w.length < 2) return null;
    let best = null;
    for (let i = 0; i < A.w.length; i++) for (let j = 0; j < A.w.length; j++) {
      if (i === j) continue;
      const dA = A.w[i] - A.w[j];
      if (Math.abs(dA) < 1e-7) continue;
      for (let p = 0; p < C.w.length; p++) for (let qq = 0; qq < C.w.length; qq++) {
        if (p === qq) continue;
        const a = (C.w[p] - C.w[qq]) / dA;
        if (!(a > 0.94 && a < 1.065)) continue;          // 1フレームで c1 が数%以上動くことはない
        const d = C.w[p] - a * A.w[i];
        let inl = 0, res = 0;
        for (const wa of A.w) {
          const wp = a * wa + d;
          if (!(wp > 1e-9)) continue;
          const yp = 1 / wp;
          let bd = 1e9;
          for (const wc of C.w) bd = Math.min(bd, Math.abs(1 / wc - yp));
          if (bd < 4) { inl++; res += bd; }              // 4 FHD px 以内を一致とみなす
        }
        if (!best || inl > best.inl || (inl === best.inl && res < best.res)) best = { a, d, inl, res };
      }
    }
    if (!best || best.inl < 2) return null;
    // s 側は a を共有し、オフセット b だけをインライア最大で決める
    let bb = 0;
    if (A.s.length && C.s.length) {
      let bs = null;
      for (const sa of A.s) for (const sc of C.s) {
        const b = sc - best.a * sa;
        let inl = 0, res = 0;
        for (const x of A.s) {
          const sp2 = best.a * x + b;
          let bd = 1e9;
          for (const y of C.s) bd = Math.min(bd, Math.abs(y - sp2));
          if (bd < 0.006) { inl++; res += bd; }
        }
        if (!bs || inl > bs.inl || (inl === bs.inl && res < bs.res)) bs = { b, inl, res };
      }
      if (bs) bb = bs.b;
    }
    const Wr = { a: best.a, d: best.d, b: bb };
    // 妥当性: 画面3点の変位が WARP_MAX を超えたら推定失敗とみなす（実測で稀に暴走する）
    for (const p of [{ x: 480, y: 60 }, { x: 480, y: 270 }, { x: 480, y: 460 }]) {
      const o = apply(Wr, p);
      if (!isFinite(o.x) || !isFinite(o.y) || Math.hypot(o.x - p.x, o.y - p.y) > WARP_MAX) return null;
    }
    return Wr;
  }

  // 前フレームの点(960空間)を現フレームへ写す。コート座標が不変な点はここに来る。
  function apply(Wr, p) {
    if (!Wr) return { x: p.x, y: p.y };
    const u = p.y * SC - YVP;
    const w2 = Wr.a * (1 / u) + Wr.d, s2 = Wr.a * ((p.x * SC - XVP) / u) + Wr.b;
    if (!(w2 > 1e-9)) return { x: p.x, y: p.y };
    const u2 = 1 / w2;
    return { x: (XVP + s2 * u2) / SC, y: (u2 + YVP) / SC };
  }

  // ================= 状態（analyze 1回ごとに新しいサンドボックスなので実行間で混ざらない） =================
  const ST = { img: null, prevFeat: null, tracks: [], lastF: -1, warpOk: 0, warpNg: 0, featMs: 0 };

  function candidates(img, opts) {
    ST.img = img;                       // filterCandidates は画像を受け取らないのでここで捕まえる
    return B.candidates(img, opts);
  }

  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net;
    const list = cands.map((c, i) => ({ c, i, x: c.x, y: c.y, n: c.n, taken: false }));

    // --- 1) ワープ ---
    let Wr = null;
    if (ST.img && typeof Court !== 'undefined') {
      const t0 = Date.now();
      const F = lineFeat(ST.img, Court);
      ST.featMs += Date.now() - t0;
      Wr = fitWarp(ST.prevFeat, F);
      ST.prevFeat = F;
      if (Wr) ST.warpOk++; else ST.warpNg++;
    }

    // --- 2) アンカー更新 ---
    // アンカーは「固定コート点」(ax,ay: ワープで前進させるだけで観測では補正しない) と
    // 「固定画面点」(sx,sy: 不変) の2つを持つ。候補はどちらかの近傍に来たときだけ紐づく。
    // 連続である必要はないので、明滅する背景（マスクが沸き立つ観客席）も累積できる。
    const f = ctx.f == null ? ++ST.lastF : ctx.f;
    const alive = [];
    for (const tr of ST.tracks) {
      tr.ax = (tr.pc = apply(Wr, { x: tr.ax, y: tr.ay })).x; tr.ay = tr.pc.y;   // コートアンカーを前進
      const rad = tr.stat ? KILL_R : R_ASSOC;
      let hit = null, bd = 1e9;
      for (const o of list) {
        if (o.taken) continue;
        const d = Math.min(Math.hypot(o.x - tr.ax, o.y - tr.ay), Math.hypot(o.x - tr.sx, o.y - tr.sy));
        if (d < bd) { bd = d; hit = o; }
      }
      if (hit && bd <= rad) {
        hit.taken = true; hit.track = tr;
        tr.hits++; tr.lastF = f;
        tr.devC = Math.max(tr.devC, Math.hypot(hit.x - tr.ax, hit.y - tr.ay));
        tr.devS = Math.max(tr.devS, Math.hypot(hit.x - tr.sx, hit.y - tr.sy));
        if (!tr.stat && tr.hits >= N_STATIC && Math.min(tr.devC, tr.devS) <= DEV_MAX) {
          tr.stat = true; tr.mode = tr.devC <= tr.devS ? 'court' : 'screen';
        }
      }
      // 固定点から DEV_MAX 以上ズレた＝コート座標が不変でない＝静止物ではない。即座に捨てる。
      if (!tr.stat && Math.min(tr.devC, tr.devS) > DEV_MAX) continue;
      if (f - tr.lastF > (tr.stat ? GAP_OLD : GAP_NEW)) continue;
      alive.push(tr);
    }
    for (const o of list) {
      if (o.taken) continue;
      alive.push({ hits: 1, lastF: f, devC: 0, devS: 0, stat: false, mode: null,
                   ax: o.x, ay: o.y, sx: o.x, sy: o.y });
    }
    ST.tracks = alive;

    // --- 3) 棄却 ---
    return list.filter(o => {
      if (net && o.y >= net.y0 && o.y <= net.y1) return false;   // ネット帯は幾何で（従来どおり）
      if (o.track && o.track.stat) return false;                 // コート座標が不変＝静止物
      return true;
    }).map(o => o.c);
  }

  window.BallTrack = Object.assign({}, B, { candidates, filterCandidates, _caState: ST, _caWarp: { fitWarp, apply, lineFeat } });
})();
