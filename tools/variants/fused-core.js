// 担当1: トレイル融合したCCから「ボールの核」を彫り出す。
//
// ── なぜ現行が壊れているか（実測）──────────────────────────────
// ball.js の candidates() は
//     if (c.n < 0.35*A || c.n > 3.0*A) continue;
//     if (c.fill <= 0.42) continue;
//     if (Math.max(c.bw,c.bh) > 3.0*d960) continue;
// を通してから「融合CCの再重心づけ」に入る。上振れ側の巨大CCはその手前で消えるので、
// **再重心づけは重症例では一度も走らない**（デッドコード）。
//
// 目視（22-02-04 t=122.47〜122.78 / t=116.70〜117.02・タイル fcA.png / fcB.png）で
// 分かった重症例は2種類あり、**原因が別物**だった:
//
//  (A) 「巨大トレイル＋ボール」型（t=122.5 / n=586〜1101・22x60）
//      ロブの黄トレイルの r/g が 1.00〜1.02 とボールの帯(0.84〜1.02)の内側に入り、
//      本体と尾がひと続きのリボンになる。ただし本体と尾のあいだには
//      **幅1〜3px の「くびれ」** がある（行プロファイル実測 t=122.50:
//      head 4,10,8,10,10,10,7,8 → neck 5,8,3,2,2,6,5,1,1 → tail 18,20,20,20,...）。
//      → **収縮(erode)でくびれを切り、片ごとに測り直す**のが正解。
//      ※「前フレームのマスクに無い新規画素＝先端」は**実測で使えない**。トレイル自体が
//        毎フレーム広がるので、新規画素の重心 (676.0,92.0) は尾のまん中に落ちた（本体は y≈68）。
//      ※ r/g 重みつき重心（ball.js の既存コード）も**使えない**。トレイルの r/g が
//        1.01 でボール(0.98)とほぼ同じなので、重心は尾に引きずられる（実測 core c=(678.2,90.6)）。
//
//  (B) 「近くの飛球」型（t=116.7〜117.0 / n=225〜254・16x21）
//      ボールが**完全に単独で・遮蔽も融合もなく**写っているのに落ちる。expectDiam() は
//      「その画面yに接地しているボール」の直径なので、高く上がって手前に来た球には
//      2.5〜3倍の過小評価になる（見かけ 16x21px@960 に対し A=39・n/A=6.1）。
//      彫り出す核が無いので、面積上限を外して丸ごと通すしかない。
//      → **実測ではこれを通すと逆効果**だった。ベンチ7指標:
//         本変種(既定)  found 10 correct 9 covered 11 coverMean 16.3 nearMean 0.581 onBall 10 false 28
//         ＋(B)も通す   found  9 correct 8 covered 11 coverMean 15.1 nearMean 0.575 onBall 10 false 29
//         理由は追跡の質ではない。(B) を通すと 22-02-04 の 116.70〜117.92 が1本の鎖に繋がり、
//         **117.15 にあった鎖の切れ目（seg-start）が消える**。ラベル id9(117.25 バウンド)は
//         その切れ目を refineTime が 117.221 に寄せて拾っていただけで、本物の kink は
//         カメラ推定が15コマおきなことによる見かけZの段差(t=117.333 で 3.6m 跳ぶ)に潰されている。
//         つまり **追跡が良くなるほど eventCandidates の材料(鎖の切れ目)が減る**。
//      → よって既定は WHOLE_ROUND=0（(B)は通さない）。(B) を試すには 1 にする。
//
// ── 設計 ────────────────────────────────────────────────
// 面積の**下限(0.35A)と fill(0.42) は現行のまま。緩めない**。上限だけを置き換える:
//   1) 枠内       → 現行と完全に同じ（融合CCの再重心づけも含めて素の実装のまま）
//   2) 上振れ     → 収縮でくびれを切る。**切れた(2片以上に割れた)ときだけ**、その片には
//                   面積上限を外して丸さ(長辺/短辺<=1.6)と絶対上限(26px@960)で判定する。
//                   割れなかった＝くびれの証拠が無いので、上限は緩めない。
//                   片は測地膨張で元の広がりに戻してから測る（n が縮むと pickBall の nAvg が痩せる）。
//   3) 1つのCCから出す核は**最大2個**（打点バーストの塊を掴まないため）。
//
// 静止物フィルタは no-static 相当（overlap 撤廃・ネット帯は現状のまま）を内蔵する。
//
// ── 実測（tools/rally-bench.js・人手ラベル12件）────────────────
//   現行(overlap<0.6) found  5 correct 5 covered 10 coverMean 10.8 nearMean 0.427 onBall  9 false 26
//   no-static (b0)    found 11 correct 9 covered 11 coverMean 13.4 nearMean 0.516 onBall 10 false 25
//   本変種            found 10 correct 9 covered 11 coverMean 16.3 nearMean 0.581 onBall 10 false 28
//   候補数 +4.4%/+4.5%、採用トラック点 218→237 / 136→160、鎖の区間数 10→6 / 7→6。
//   found が 11→10 なのは 383.79(打点) を b0 が **bounce と誤判定**して拾っていた1件が消えたため。
//   correct は 9 のまま。
//
// ── 既知の残課題（本変種の責任範囲外・実測で確認済み）────────────
//   22-02-04 のロブ頂点(t=122.63 付近)で、彫り出した核はボールに乗っているのに
//   buildChains の `d < 1.2*k` が **見かけ移動量 1.1px/frame の頂点リンクを棄却**するため、
//   鎖がそこで途切れ、代わりに右奥の得点看板(静止物)へ乗り移る。
//   ラベル id12 の cover 21点のうち 122.65 以降の10点はその看板の上。
//   ＝ chain-gates 側の minStep 撤廃が入れば実質の追跡点に変わる。
(() => {
  const B = window.BallTrack;
  const W = 960, H = 540, SC = 2, YVP = -651;
  const expectDiam = yF => 0.0155 * (yF - YVP);

  const FILL_MIN  = 0.42;   // 現行と同じ。緩めない
  const LO_A      = 0.35;   // 現行と同じ。緩めない
  const HI_A      = 3.0;    // 現行と同じ「枠内」の上限
  const ROUND_ASP = 1.6;    // 割れた片に上振れを許すときの丸さ
  const MAX_D960  = 26;     // ボールの見かけ直径の絶対上限(960空間) = FHD 52px
  const MAX_N     = 560;    // 0.785 * 26^2
  const ERODE_MAX = 3;      // くびれ切りの収縮回数の上限
  const CORES_MAX = 2;      // 1つのCCから出す核の数（3にすると correct 9→8）
  const CORE_RG_TOL = 0.07; // 核の平均 r/g がボール核(0.94)からどれだけ離れてよいか
  const CC_MAX_PX = 20000;  // これより大きいCCは彫らない（コスト保険）
  const WHOLE_ROUND = 0;    // 1 にすると (B)型「丸くて大きい単独CC」も丸ごと通す（上のコメント参照）
  const CARVE_LOWFILL = 1;  // 1 なら fill<=0.42 の巨大CCも彫る対象にする

  // ---- 局所（bbox内）のビットマップ操作 ----
  function erode(src, w, h) {
    const dst = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!src[i]) continue;
        if (src[i - 1] && src[i + 1] && src[i - w] && src[i + w] &&
            src[i - w - 1] && src[i - w + 1] && src[i + w - 1] && src[i + w + 1]) dst[i] = 1;
      }
    }
    return dst;
  }
  // ref の内側だけに広がる測地膨張
  function dilateGeo(seed, ref, w, h, times) {
    let cur = seed;
    for (let t = 0; t < times; t++) {
      const nx = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!ref[i]) continue;
          if (cur[i]) { nx[i] = 1; continue; }
          let on = 0;
          for (let dy = -1; dy <= 1 && !on; dy++) {
            const ny = y + dy; if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const ax = x + dx; if (ax < 0 || ax >= w) continue;
              if (cur[ny * w + ax]) { on = 1; break; }
            }
          }
          nx[i] = on;
        }
      }
      cur = nx;
    }
    return cur;
  }
  function localCC(m, w, h) {
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), out = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i0 = y * w + x;
        if (!m[i0] || seen[i0]) continue;
        let sp = 0; stack[sp++] = i0; seen[i0] = 1;
        const pts = [];
        while (sp) {
          const p = stack[--sp], py = (p / w) | 0, px = p - py * w;
          pts.push(p);
          for (let dy = -1; dy <= 1; dy++) {
            const ny = py + dy; if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const ax = px + dx; if (ax < 0 || ax >= w) continue;
              const ni = ny * w + ax;
              if (m[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; }
            }
          }
        }
        out.push(pts);
      }
    }
    return out;
  }

  // ---- 領域の測定（局所インデックス → 画面座標）----
  function measure(pts, w, ox, oy, data, prev) {
    const n = pts.length;
    let sx = 0, sy = 0, bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9, sr = 0, sg = 0, ov = 0;
    for (const p of pts) {
      const ly = (p / w) | 0, lx = p - ly * w, x = ox + lx, y = oy + ly;
      sx += x; sy += y;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      const gi = y * W + x, i = gi * 4;
      sr += data[i]; sg += data[i + 1];
      if (prev && prev[gi]) ov++;
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    return { n, cx: sx / n, cy: sy / n, bw, bh, fill: n / (bw * bh),
             rg: sg > 0 ? sr / sg : 0, overlap: n ? ov / n : 0 };
  }

  function geom(m) {
    const yF = m.cy * SC, d960 = expectDiam(yF) / SC;
    return { d960, A: 0.785 * d960 * d960,
             dim: Math.max(m.bw, m.bh),
             asp: Math.max(m.bw, m.bh) / Math.max(1, Math.min(m.bw, m.bh)) };
  }

  // 'ok'    現行の枠内（面積・fill・寸法すべて現行どおり）
  // 'round' 上振れだが丸い。allowRound が真のときだけ返す
  // 'carve' 上振れ。核を彫る対象
  // null    捨てる
  function verdict(m, allowRound) {
    if (m.fill <= FILL_MIN) return null;
    const g = geom(m);
    if (m.n < LO_A * g.A) return null;                                // 下限は緩めない
    if (m.n <= HI_A * g.A && g.dim <= 3 * g.d960) return 'ok';
    if (allowRound && g.asp <= ROUND_ASP && g.dim <= MAX_D960 && m.n <= MAX_N) return 'round';
    return 'carve';
  }
  // 彫る価値があるか（fill は問わない。融合CCは bbox が疎になって fill が落ちるため）
  function carvable(m) {
    const g = geom(m);
    if (m.n < LO_A * g.A) return false;
    if (!CARVE_LOWFILL && m.fill <= FILL_MIN) return false;
    return m.n > HI_A * g.A || g.dim > 3 * g.d960;
  }

  function scoreCore(m) {
    const g = geom(m);
    return m.fill
         + (1 - Math.min(1, (g.asp - 1) / 1.2))
         + (1 - Math.min(1, Math.abs(m.rg - 0.94) / 0.12));
  }

  // ---- 巨大CCから核を彫る ----
  // 収縮 → 2片以上に割れたら、その片だけ面積上限を外して判定 → 測地膨張で元の広がりに戻す
  function carveCores(c, data, prev) {
    if (c.n > CC_MAX_PX) return [];
    const ox = c.bx0 - 1, oy = c.by0 - 1, w = c.bw + 2, h = c.bh + 2;
    if (ox < 0 || oy < 0 || ox + w > W || oy + h > H) return [];
    const ref = new Uint8Array(w * h);
    for (const p of c.pts) { const py = (p / W) | 0, px = p - py * W; ref[(py - oy) * w + (px - ox)] = 1; }

    let cur = ref;
    for (let it = 1; it <= ERODE_MAX; it++) {
      cur = erode(cur, w, h);
      const parts = localCC(cur, w, h).filter(p => p.length >= 6);
      if (!parts.length) break;
      // ★2片以上に割れて初めて「くびれがあった＝融合していた」証拠になる。
      //   割れないうちはもう一段収縮する。最後まで割れなければ核は出さない（＝現行と同じ棄却）。
      //   実測: 割れていない片も通すと coverMean 16.3→16.4 とほぼ変わらず falseEvents が 28→32 に増える。
      if (parts.length < 2) continue;
      const got = [];
      for (const pts of parts) {
        const seed = new Uint8Array(w * h);
        for (const p of pts) seed[p] = 1;
        const back = dilateGeo(seed, ref, w, h, it);      // 収縮した分だけ戻す
        const idx = [];
        for (let i = 0; i < back.length; i++) if (back[i]) idx.push(i);
        const m = measure(idx, w, ox, oy, data, prev);
        const v = verdict(m, true);
        if ((v === 'ok' || v === 'round') && Math.abs(m.rg - 0.94) <= CORE_RG_TOL)
          got.push({ m, s: scoreCore(m) });
      }
      if (got.length) {
        got.sort((a, b) => b.s - a.s);
        return got.slice(0, CORES_MAX).map(g => g.m);
      }
    }
    return [];
  }

  // ---- candidates 差し替え ----
  function candidates(img, opts = {}) {
    const test = opts.loose ? B.isBallLoose : B.isBall;
    const d = img.data;
    const roi = opts.roi || { x0: 20, y0: 0, x1: 940, y1: 470 };
    const mask = new Uint8Array(W * H);
    for (let y = roi.y0; y < roi.y1; y++) {
      for (let x = roi.x0; x < roi.x1; x++) {
        const i = (y * W + x) * 4;
        if (test(d[i], d[i + 1], d[i + 2])) mask[y * W + x] = 1;
      }
    }
    const prev = opts.prevMask || null;
    const ccs = B.components(mask, roi);
    const out = [];
    for (const c of ccs) {
      const yF = c.cy * SC, d960 = expectDiam(yF) / SC, A = 0.785 * d960 * d960;
      let sr = 0, sg = 0, ovc = 0;
      for (const p of c.pts) { const i = p * 4; sr += d[i]; sg += d[i + 1]; if (prev && prev[p]) ovc++; }
      const rgMean = sg > 0 ? sr / sg : 0;
      const whole = { n: c.n, cx: c.cx, cy: c.cy, bw: c.bw, bh: c.bh, fill: c.fill,
                      rg: rgMean, overlap: c.n ? ovc / c.n : 0 };
      const v = verdict(whole, !!WHOLE_ROUND);

      if (v === 'ok') {
        // ---- 現行と完全に同じ道（融合CCの再重心づけを含む）----
        let cx = c.cx, cy = c.cy, fused = false;
        if (Math.max(c.bw, c.bh) > 2.2 * Math.min(c.bw, c.bh) || c.n > 1.8 * A) {
          fused = true;
          let wsum = 0, wx = 0, wy = 0;
          for (const p of c.pts) {
            const py = (p / W) | 0, pxx = p - py * W, i = p * 4;
            const g = d[i + 1] || 1, rg = d[i] / g;
            const wt = Math.max(0, 1 - Math.abs(rg - 0.95) / 0.12);
            if (wt > 0) { wsum += wt; wx += wt * pxx; wy += wt * py; }
          }
          if (wsum > 0) { cx = wx / wsum; cy = wy / wsum; }
        }
        out.push({ x: cx, y: cy, n: c.n, bw: c.bw, bh: c.bh, fill: c.fill, fused,
                   d: d960, rg: rgMean, overlap: whole.overlap });
        continue;
      }

      if (v === 'round') {
        // (B)型。既定では WHOLE_ROUND=0 なのでここには来ない
        out.push({ x: c.cx, y: c.cy, n: c.n, bw: c.bw, bh: c.bh, fill: c.fill, fused: false,
                   d: d960, rg: rgMean, overlap: whole.overlap, big: true });
        continue;
      }

      // ---- (A)型: トレイル融合。くびれで切って核を彫る ----
      if (!carvable(whole)) continue;
      for (const m of carveCores(c, d, prev)) {
        out.push({ x: m.cx, y: m.cy, n: m.n, bw: m.bw, bh: m.bh, fill: m.fill, fused: true,
                   d: expectDiam(m.cy * SC) / SC, rg: m.rg, overlap: m.overlap, carved: true });
      }
    }
    out.mask = mask;
    return out;
  }

  // 静止物フィルタ(overlap)は撤廃。ネット帯だけ現状どおり残す（= no-static 相当）
  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net;
    return cands.filter(c => !(net && c.y >= net.y0 && c.y <= net.y1));
  }

  window.BallTrack = Object.assign({}, B, { candidates, filterCandidates, carveCores, verdict });
})();
