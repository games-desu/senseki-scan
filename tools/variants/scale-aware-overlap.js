// 方針2: overlap 判定をスケールと速度に対して正しくする。
//
// ■ なぜ生の overlap<0.6 が誤りなのか（幾何）
//   直径 d の円板が v だけずれたときの重なり率は v/d だけで決まる:
//       ov = f(s) = (2/π)(acos s - s√(1-s²)),  s = v/d
//   f(0.6) の逆は s=0.31。つまり `ov>=0.6 で棄却` は **「移動量が直径の0.31倍未満なら棄却」**
//   と言っているにすぎない。直径は遠近で 6〜20px(@960) と3倍変わるので、
//   同じ 3px/frame の動きが、遠コートでは「動いている」、手前では「静止」と判定される。
//   さらにカメラがドリーする以上、静止物も画面上を 0〜3px/frame 動く。
//   → 見るべきは生の ov ではなく **「観測 ov」と「静止だと仮定したときの期待 ov」の差**。
//
// ■ 実測でわかった限界（これが設計を決めた）
//   10-44-35 t=387.23〜387.53 の転がるボール（19コマ）で実測すると:
//       |画面移動| = 1.27〜2.90 px/frame,  |背景流 F| = 2.00〜2.83 px/frame
//       |移動|-|F| = -1.25〜+0.67  ← スカラー差では静止物と全く分離しない
//       |移動-F|   =  0.50〜2.94   ← ベクトル差でも1コマでは分離しない
//   ボールの背景相対速度は 1px/frame 程度しかない。**1コマの overlap では原理的に判定不能**。
//   したがって overlap 由来の判定は **片側（＝「背景より確かに速い→残す」）にしか使えない**。
//   棄却は「背景相対の変位が何コマも同じ向きに積み上がらないこと」で行う。
//   転がるボールは 8コマで 6〜8px 積み上がるが、静止物は 0 のまま。ここで初めて分離する。
//
// ■ 構成
//   ① 背景流 F(y) … 色マスクの前フレームとの相互相関（放物線補間で小数画素まで）。
//      上部帯(観客席・構造物)とコート帯で視差があるので2帯で別々に求める。
//      Court.estimate は毎フレーム走らせると2.7倍遅く、隣接フレームのブレが p50 1.4px なので使わない。
//   ② スケール整合の overlap 検定（片側）… s_impl = f⁻¹(ov)·d_eff が |F| を EXCESS 以上
//      上回れば「背景より確かに速い」＝無条件で残す。静止物アンカーにも一切吸着させない。
//   ③ 背景固定アンカー … 候補を前フレームの候補に対応づけ、変位から F を引いた残差 rel を貯める。
//      同時に他アンカーの中央値で F の系統誤差を打ち消す（自己整合補正）。
//      MINAGE コマ以上生きていて、直近窓の **Σrel（＝背景相対の正味の移動）** が
//      その塊の大きさに見合う許容内に収まるものだけを「静止物」と断じて棄却する。
//      画面固定のUI（HUDアイコン）は Σ変位 そのものが 0 なので同じ枠で落ちる。
//   ④ ネット帯の除外は現行のまま（本変種の対象外・観点Bの担当）。
//
// ■ スタッター耐性
//   22-02-04 にはボールの描画が1コマだけ止まり ov=1.00 になる現象がある。
//   ②は「速い→残す」の片側なので誤棄却せず、③は MINAGE コマの持続を要求するので1コマでは発火しない。
(() => {
  const B = window.BallTrack;
  const W = 960, H = 540;

  // ---- 調整点（すべて960空間の px）----
  const FR       = 3;     // 背景流の探索半径
  const BAND_Y   = 64;    // 上部帯とコート帯の境界
  const EXCESS   = 1.6;   // 「背景より確かに速い」と言い切る余裕
  const MINAGE   = 12;    // 静止と断じるのに必要な持続コマ数
  const WIN      = 8;     // Σrel を取る窓
  const TN_ABS   = 2.6;   // 静止許容（絶対）
  const TN_REL   = 0.20;  // 静止許容（塊の直径に比例する分）
  const SCR_EPS  = 1.0;   // 画面固定UIとみなす1コマ変位
  const SCR_MIN  = 45;    // 画面固定と断じるのに必要な連続コマ数（0.75秒）
  const MISS_MAX = 30;    // アンカーを見失っても保持するコマ数
  const MR_ABS   = 2.8;   // 対応づけ半径（絶対）
  const MR_REL   = 0.18;  // 同（直径比例分）
  const NRATIO   = 3.0;   // 対応づけを許す面積比
  const DUP_PX   = 40;    // 準重複フレームとみなすマスクの対称差（間引き後の画素数）
  const DUP_DROP = 1;     // 準重複コマの候補を捨てる(1)か、前コマの採否をそのまま繰り返す(0)

  // ---- 円板の重なり率とその逆関数 ----
  function ovOfS(s) {
    if (s <= 0) return 1;
    if (s >= 1) return 0;
    return (2 / Math.PI) * (Math.acos(s) - s * Math.sqrt(1 - s * s));
  }
  const INV = new Float64Array(129);
  for (let i = 0; i <= 128; i++) {
    const ov = i / 128;
    let lo = 0, hi = 1;
    for (let k = 0; k < 26; k++) { const m = (lo + hi) / 2; if (ovOfS(m) > ov) lo = m; else hi = m; }
    INV[i] = (lo + hi) / 2;
  }
  function sOfOv(ov) {                       // ov -> 中心間距離/直径
    if (!(ov > 0)) return 1;
    if (ov >= 1) return 0;
    const f = ov * 128, i = Math.min(127, f | 0), a = f - i;
    return INV[i] * (1 - a) + INV[i + 1] * a;
  }
  // 面積等価な円の直径。融合CCでは過大になるが、その場合 s_impl も過大＝「速い」側に倒れるので安全。
  function effDiam(c) { return Math.sqrt(4 * c.n / Math.PI); }

  // ---- 背景流: 色マスクの相互相関 ----
  const SPAN = 2 * FR + 1;
  function peak(S) {                          // 整数argmax＋放物線補間
    let bi = 0;
    for (let i = 1; i < S.length; i++) if (S[i] > S[bi]) bi = i;
    const iy = (bi / SPAN) | 0, ix = bi - iy * SPAN;
    let fx = 0, fy = 0;
    if (ix > 0 && ix < SPAN - 1) {
      const a = S[iy * SPAN + ix - 1], b = S[bi], c = S[iy * SPAN + ix + 1], den = a - 2 * b + c;
      if (den < 0) fx = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    if (iy > 0 && iy < SPAN - 1) {
      const a = S[(iy - 1) * SPAN + ix], b = S[bi], c = S[(iy + 1) * SPAN + ix], den = a - 2 * b + c;
      if (den < 0) fy = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
    }
    return { x: ix - FR + fx, y: iy - FR + fy, score: S[bi] };
  }
  function bandFlow(on, prev) {
    if (on.length < 60) return null;
    const S = new Float64Array(SPAN * SPAN);
    for (let dy = -FR; dy <= FR; dy++) {
      for (let dx = -FR; dx <= FR; dx++) {
        const off = dy * W + dx;
        let c = 0;
        for (let k = 0; k < on.length; k++) { const j = on[k] - off; if (j >= 0 && j < W * H && prev[j]) c++; }
        S[(dy + FR) * SPAN + (dx + FR)] = c;
      }
    }
    const p = peak(S);
    if (p.score < 0.12 * on.length) return null;      // 相関が立たない＝信用しない
    return p;
  }
  // マスク全面を1回だけ走査し、上部帯とコート帯のONリストを作る（コート帯は行を間引く）。
  // ついでに指紋も作る。22-02-04 は 377コマ中41コマ(10.9%)が前コマとほぼ同一の
  // 準重複フレームで、そのコマでは**ボールを含む全候補の overlap が 1.00 になる**。
  // 重なり率は「動き」の代理でしかないので、動きが定義できないコマでは使ってはいけない。
  function scanMask(mask, prev) {
    const top = [], bot = [];
    let same = 0;
    for (let y = 0; y < 470; y++) {
      if (y >= BAND_Y && (y & 1)) continue;      // コート帯は行を間引く（画素が多いので）
      const row = y * W, dst = y < BAND_Y ? top : bot;
      for (let x = 0; x < W; x++) if (mask[row + x]) { dst.push(row + x); if (prev && prev[row + x]) same++; }
    }
    return { top, bot, n: top.length + bot.length, same };
  }

  // ---- 本体 ----
  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net;
    const st = ctx.state || {};
    if (!st.anchors) { st.anchors = []; st.f = -1; st.flowTop = { x: 0, y: 0 }; st.flowBot = { x: 0, y: 0 }; }
    const f = ctx.f == null ? st.f + 1 : ctx.f;

    // ① 背景流と準重複フレームの検出
    const mask = cands.mask || null;
    let dup = false;
    if (mask) {
      const sc = scanMask(mask, st.prevMask);
      // 対称差がこれだけ小さいのは「画が前コマと同じ」ときだけ。
      // ボールが1個動くだけでも 200画素前後は入れ替わるので取り違えない。
      dup = st.prevMask != null && (sc.n + st.prevN - 2 * sc.same) <= DUP_PX;
      st.prevN = sc.n;
      if (st.prevMask && !dup) {
        const ft = bandFlow(sc.top, st.prevMask), fb = bandFlow(sc.bot, st.prevMask);
        if (ft) st.flowTop = { x: ft.x, y: ft.y };
        if (fb) st.flowBot = { x: fb.x, y: fb.y };
        if (!ft && fb) st.flowTop = { x: fb.x, y: fb.y };
        if (!fb && ft) st.flowBot = { x: ft.x, y: ft.y };
      }
      st.prevMask = mask;
    }
    const flowAt = y => (y < BAND_Y ? st.flowTop : st.flowBot);

    // 幾何で先に落とす（ネット帯）。以降の対応づけ対象からも外す。
    const live = [];
    for (const c of cands) {
      if (net && c.y >= net.y0 && c.y <= net.y1) continue;
      live.push(c);
    }

    // 準重複フレーム: 画が前コマと同じなので overlap は動きを何も語らない。
    // アンカーは一切更新しない（rel に 0 を積むと動いているボールまで静止物に見えてしまう）。
    // 候補そのものも前コマの観測の写しでしかないので落とす。残すと
    // 「1/60秒でボールが動かなかった」という嘘の点が鎖に入り、離脱速度の当てはめを壊す。
    if (dup) {
      if (DUP_DROP) return [];
      const dropped = st.lastDrop || [];
      return live.filter(c => !dropped.some(q => Math.abs(q[0] - c.x) < 0.6 && Math.abs(q[1] - c.y) < 0.6));
    }

    // ② スケール整合の overlap 検定（片側）
    const info = live.map(c => {
      const d = effDiam(c);
      const F = flowAt(c.y), mF = Math.hypot(F.x, F.y);
      const sImpl = sOfOv(c.overlap) * d;
      return { c, d, sImpl, mF, fast: sImpl - mF > EXCESS };
    });

    // ③ アンカーへの対応づけ（fast なものは吸着させない）
    for (const a of st.anchors) a.hit = null;
    const pairs = [];
    for (const it of info) {
      if (it.fast) continue;
      const c = it.c, F = flowAt(c.y);
      const px = c.x - F.x, py = c.y - F.y;          // 静止だと仮定したときの前フレーム位置
      const mr = MR_ABS + MR_REL * it.d;
      let best = null;
      for (const a of st.anchors) {
        if (a.hit) continue;
        const nr = a.n > c.n ? a.n / Math.max(1, c.n) : c.n / Math.max(1, a.n);
        if (nr > NRATIO) continue;
        const dd = Math.hypot(a.x - px, a.y - py);
        if (dd > mr) continue;
        if (!best || dd < best.dd) best = { a, dd };
      }
      if (best) { best.a.hit = it; pairs.push({ a: best.a, it, dx: c.x - best.a.x, dy: c.y - best.a.y }); }
      else it.newAnchor = true;
    }

    // 自己整合補正: 対応づいた組の残差の中央値を引く。
    // 背景流の系統誤差（小数画素の取りこぼし）を、同じデータの中で打ち消す。
    let bx = 0, by = 0;
    if (pairs.length >= 3) {
      const rx = [], ry = [];
      for (const p of pairs) {
        const F = flowAt(p.it.c.y);
        const ex = p.dx - F.x, ey = p.dy - F.y;
        if (Math.hypot(ex, ey) <= 3.5) { rx.push(ex); ry.push(ey); }   // 明らかに動いている組は外す
      }
      if (rx.length >= 3) {
        rx.sort((a, b) => a - b); ry.sort((a, b) => a - b);
        bx = rx[rx.length >> 1]; by = ry[ry.length >> 1];
      }
    }

    for (const p of pairs) {
      const a = p.a, F = flowAt(p.it.c.y);
      a.rel.push({ x: p.dx - F.x - bx, y: p.dy - F.y - by });
      if (a.rel.length > WIN) a.rel.shift();
      // 画面固定UI（HUDアイコン）は画面上で1コマも動かない。長時間の連続で数える。
      a.scrStill = Math.hypot(p.dx, p.dy) <= SCR_EPS ? a.scrStill + 1 : 0;
      a.x = p.it.c.x; a.y = p.it.c.y; a.n = p.it.c.n; a.d = p.it.d;
      a.age++; a.miss = 0; a.f = f;
    }

    // ④ 静止判定と棄却
    // ロブの頂点では**ボールも画面上で止まって見える**（実測 386.07〜386.22 の26コマ）。
    // 「画面上で動かない」を短い窓で静止物の根拠にしてはいけない。UI は動画の全編で動かないので、
    // 画面固定の判定だけは SCR_MIN コマ(0.75秒)の連続を要求して分ける。
    const drop = new Set();
    for (const p of pairs) {
      const a = p.a;
      if (a.scrStill >= SCR_MIN) { drop.add(p.it.c); continue; }
      if (a.age < MINAGE || a.rel.length < WIN) continue;
      let sx = 0, sy = 0;
      for (const r of a.rel) { sx += r.x; sy += r.y; }
      const tn = Math.max(TN_ABS, TN_REL * a.d);
      if (Math.hypot(sx, sy) <= tn) drop.add(p.it.c);   // 背景に対する正味の移動が無い
    }

    // 新規アンカーの登録と、見失ったアンカーの管理
    for (const it of info) {
      if (it.fast || !it.newAnchor) continue;
      st.anchors.push({ x: it.c.x, y: it.c.y, n: it.c.n, d: it.d, age: 1, miss: 0, f, rel: [], scrStill: 0, hit: it });
    }
    const keepAnchors = [];
    for (const a of st.anchors) {
      if (!a.hit) {
        a.miss++;
        if (a.miss > MISS_MAX) continue;
        // 見えていない間は「背景と一緒に流れた」と仮置きしてアンカーを進める。
        // rel には 0 を積む。次に見つかったとき、その1コマの変位は
        // 「流したアンカー位置」との差なので、欠測期間の背景相対移動がそこで一括して現れる。
        // ＝ Σrel は欠測をまたいでも正味の背景相対移動を正しく表す。
        const F = flowAt(a.y);
        a.x += F.x; a.y += F.y;
        a.rel.push({ x: 0, y: 0 });
        a.scrStill = 0;
        if (a.rel.length > WIN) a.rel.shift();
        a.age++;
      }
      a.hit = null;
      keepAnchors.push(a);
    }
    st.anchors = keepAnchors;
    st.f = f;
    st.lastDrop = [...drop].map(c => [c.x, c.y]);

    return live.filter(c => !drop.has(c));
  }

  window.BallTrack = Object.assign({}, B, { filterCandidates, sOfOv, ovOfS });
})();
