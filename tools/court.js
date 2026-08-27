// SENSEKI SCAN コート座標変換（ブラウザ用・依存なし）
// 画面座標 (x,y) ⇔ コート座標 (X,Z) [m・原点=ネット中央・X=右・Z=奥]
//
// 実測で確定した事実（docs/rally-probe/camera-homography.md）:
//   カメラは**回転しない**（ロール0・ヨー0・画角固定）。動くのは位置だけ＝ドリー。
//   そのため消失点が画面上に固定され、ホモグラフィは8自由度でなく**3自由度**に縮退する。
//   XVP=960（画面中央・厳密）/ YVP=-651 / K=cosθ/f=2.796e-4 は**全コート・全解像度で共通**。
//   フレーム毎に解くのは c0, c1, Xc の3つだけ。横ライン2本＋縦ライン1本で足りる。
//
// 処理は 960x540 に縮小して行う（720p素材でも1440p素材でも同じ土俵に載る）。
// 閾値は FHD 基準の値を SC=2 で割った 960 空間の値で持つ。
window.Court = (() => {
  const XVP = 960, YVP = -651, K = 2.796e-4;

  // コート実寸（標準テニスコート・m）
  const X_DBL = 5.485, X_SGL = 4.115, Z_SVC = 6.40, Z_BASE = 11.885;
  const X_LINES = [-X_DBL, -X_SGL, 0, X_SGL, X_DBL];
  const Z_LINES = [Z_BASE, Z_SVC, -Z_SVC, -Z_BASE];   // ネット(Z=0)は接地線でないので校正に使わない

  const W = 960, H = 540, SC = 1920 / W;              // SC=2: 960空間 → FHD換算

  // 960空間での閾値（仕様のFHD値をSCで割ったもの）
  const TH = {
    lineMin: 170,        // 輝度の絶対下限。石畳の目地対策に必須
    lineSat: 46,         // max-min。これ未満を白線とみなす
    rowPeak: 130,        // 行プロファイルのピーク採用（FHD 260px 相当）
    rowSkip: 450,        // s投票で丸ごと飛ばす行（FHD 900px 相当）
    votePeak: 60,        // s投票のピーク採用（FHD 120 相当）
  };

  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  function frame(video) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H);
  }

  // ---- Step 1: 白線マスク（全コート共通） ----
  // CL はフレーム自身のコート面輝度中央値。コートが変わっても自動追従する。
  function lineMask(img) {
    const d = img.data;
    const vals = [];
    for (let y = (0.35 * H) | 0; y < 0.92 * H; y += 3) {
      for (let x = (0.15 * W) | 0; x < 0.85 * W; x += 3) {
        const i = (y * W + x) * 4;
        vals.push(lum(d[i], d[i + 1], d[i + 2]));
      }
    }
    vals.sort((a, b) => a - b);
    const CL = vals[vals.length >> 1] || 0;
    const thr = Math.max(CL * 1.06, TH.lineMin);

    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (lum(r, g, b) > thr && Math.max(r, g, b) - Math.min(r, g, b) < TH.lineSat) mask[y * W + x] = 1;
      }
    }
    return { mask, CL, thr };
  }

  // 横ラインは画面水平と分かっているので Hough は不要。行カウントの極大でよい。
  function rowProfile(mask) {
    const prof = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const yF = y * SC;
      if (yF < 130) continue;                       // 上部バナー帯
      let n = 0;
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        const xF = x * SC;
        if (yF > 860 && (xF < 250 || xF > 1670)) continue;  // 左右下のスコアUI
        n++;
      }
      prof[y] = n;
    }
    return prof;
  }

  function peaksOf(prof, minVal, mergePx) {
    const raw = [];
    for (let y = 2; y < H - 2; y++) {
      const v = prof[y];
      if (v < minVal) continue;
      if (v >= prof[y - 1] && v >= prof[y + 1] && v > prof[y - 2] && v > prof[y + 2]) raw.push({ y, v });
    }
    raw.sort((a, b) => b.v - a.v);
    const out = [];
    for (const p of raw) if (!out.some(q => Math.abs(q.y - p.y) < mergePx)) out.push(p);
    return out.sort((a, b) => a.y - b.y);
  }

  // ---- Step 2: 横ラインの同定 → c0, c1 ----
  // 「一番上のピーク＝ファーベースライン」と決め打ちしてはいけない（実測で外れる）。
  // 上位N本から2本を選ぶ総当たりで、残りのピークが実寸に当たる本数が最大の組を採る。
  function solveZ(peaks) {
    const top = peaks.slice(0, 8);
    let best = null;
    for (let a = 0; a < top.length; a++) {
      for (let b = a + 1; b < top.length; b++) {
        const ya = top[a].y * SC, yb = top[b].y * SC;   // ya < yb（画面上のほうが奥）
        const ua = ya - YVP, ub = yb - YVP;
        for (let i = 0; i < Z_LINES.length; i++) {
          for (let j = 0; j < Z_LINES.length; j++) {
            const Za = Z_LINES[i], Zb = Z_LINES[j];
            if (Za <= Zb) continue;                      // 奥のほうがZが大きい
            const c1 = (1 / ua - 1 / ub) / (Za - Zb);
            if (!(c1 >= 1.5e-5 && c1 <= 4.0e-5)) continue;
            const c0 = 1 / ua - c1 * Za;
            // 全ピークを見かけZに変換して実寸に当たる本数を数える
            let hits = 0, resid = 0;
            for (const p of peaks) {
              const Z = (1 / (p.y * SC - YVP) - c0) / c1;
              if (Z > 2.3 && Z < 3.8) { hits++; continue; }        // ネットテープ（校正には使わない）
              let bestD = 1e9;
              for (const Zt of [Z_BASE, Z_SVC, 0, -Z_SVC, -Z_BASE]) bestD = Math.min(bestD, Math.abs(Z - Zt));
              if (bestD <= 0.5) { hits++; resid += bestD; }
            }
            if (!best || hits > best.hits || (hits === best.hits && resid < best.resid)) {
              best = { c0, c1, hits, resid, pair: [top[a].y, top[b].y], Za, Zb };
            }
          }
        }
      }
    }
    return best;
  }

  // ---- Step 3: 縦ライン = s の1次元投票 ----
  // 消失点が固定なので、縦ラインは s=(x-XVP)/(y-YVP) の1パラメータで表せる。
  // 金網・観客席・落ち葉は消失点を通らないので票が積み上がらず自動的に落ちる。
  const SMIN = -1.2, SMAX = 1.2, DS = 0.002;
  function voteS(mask, prof) {
    const nb = Math.round((SMAX - SMIN) / DS);
    const vote = new Float64Array(nb);
    for (let y = 0; y < H; y++) {
      const yF = y * SC;
      if (yF < 300 || yF > 1050) continue;
      if (prof[y] > TH.rowSkip) continue;            // 横ラインの行は s 全域に票を撒くので除外
      const u = yF - YVP;
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        const xF = x * SC;
        if (yF > 860 && (xF < 250 || xF > 1670)) continue;
        const bi = (((xF - XVP) / u) - SMIN) / DS | 0;
        if (bi >= 0 && bi < nb) vote[bi]++;
      }
    }
    // ±2bin平滑 → 半径5binの非極大抑制 → 前後±4binの重心でサブbin精度に
    const sm = new Float64Array(nb);
    for (let i = 0; i < nb; i++) {
      let s = 0, c = 0;
      for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < nb) { s += vote[j]; c++; } }
      sm[i] = s / c;
    }
    const out = [];
    for (let i = 5; i < nb - 5; i++) {
      if (sm[i] < TH.votePeak) continue;
      let isMax = true;
      for (let k = -5; k <= 5; k++) if (sm[i + k] > sm[i]) { isMax = false; break; }
      if (!isMax) continue;
      let num = 0, den = 0;
      for (let k = -4; k <= 4; k++) { const j = i + k; num += sm[j] * j; den += sm[j]; }
      out.push({ s: SMIN + (num / den) * DS, v: sm[i] });
    }
    return out.sort((a, b) => a.s - b.s);
  }

  // Yc が既知なら、縦ラインは1本でも Xc が解ける。
  // 各ピークに5本のうちどのラインかを仮定し、他のピークが当たる本数が最大の仮説を採る。
  function solveX(sPeaks, Yc) {
    if (!sPeaks.length) return null;
    const tol = 0.30 / Yc;   // 30cm 相当の s 許容
    let best = null;
    for (const p of sPeaks) {
      for (const Xk of X_LINES) {
        const Xc = Xk - p.s * Yc;
        let hits = 0, resid = 0;
        for (const q of sPeaks) {
          const Xq = Xc + q.s * Yc;
          let d = 1e9;
          for (const Xt of X_LINES) d = Math.min(d, Math.abs(Xq - Xt));
          if (d <= 0.30) { hits++; resid += d; }
        }
        if (!best || hits > best.hits || (hits === best.hits && resid < best.resid)) best = { Xc, hits, resid, tol };
      }
    }
    return best;
  }

  // ---- まとめ: 1フレームからカメラを推定 ----
  // 交差検証: Step3 から独立に Yc=ΔX/Δs が出る。K/c1 と合わなければ横ラインの同定ミス。
  function estimate(video) {
    const img = frame(video);
    const { mask, CL, thr } = lineMask(img);
    const prof = rowProfile(mask);
    const hPeaks = peaksOf(prof, TH.rowPeak, 5);
    const z = solveZ(hPeaks);
    if (!z) return { ok: false, reason: 'no-horizontal-lines', CL, thr, hPeaks: hPeaks.length };

    const Yc = K / z.c1;
    const sPeaks = voteS(mask, prof);
    const xr = solveX(sPeaks, Yc);
    if (!xr) return { ok: false, reason: 'no-vertical-lines', CL, c0: z.c0, c1: z.c1, Yc, hPeaks: hPeaks.length };

    // 縦ラインのギャップから独立に Yc を求めて突き合わせる
    let YcCheck = null;
    const good = sPeaks.filter(q => {
      const Xq = xr.Xc + q.s * Yc;
      return X_LINES.some(Xt => Math.abs(Xq - Xt) <= 0.30);
    });
    if (good.length >= 2) {
      const ratios = [];
      for (let i = 0; i < good.length - 1; i++) {
        const Xa = nearestX(xr.Xc + good[i].s * Yc), Xb = nearestX(xr.Xc + good[i + 1].s * Yc);
        const ds = good[i + 1].s - good[i].s;
        if (Math.abs(ds) > 1e-6 && Xb !== Xa) ratios.push((Xb - Xa) / ds);
      }
      if (ratios.length) { ratios.sort((a, b) => a - b); YcCheck = ratios[ratios.length >> 1]; }
    }
    const agree = YcCheck ? Math.abs(YcCheck - Yc) / Yc : null;

    return {
      ok: true, c0: z.c0, c1: z.c1, Xc: xr.Xc, Yc, YcCheck, agree,
      CL, thr, hHits: z.hits, xHits: xr.hits,
      hPeaks: hPeaks.map(p => p.y * SC), sPeaks: sPeaks.map(p => +p.s.toFixed(4)),
      // 交差検証に通らない＝同定ミスの疑い。呼び出し側でフラグにする
      suspect: agree !== null && agree > 0.03,
    };
  }

  function nearestX(X) {
    let best = X_LINES[0];
    for (const Xt of X_LINES) if (Math.abs(X - Xt) < Math.abs(X - best)) best = Xt;
    return best;
  }

  // ---- 変換（座標はFHD基準） ----
  function toCourt(x, y, cam) {
    const u = y - YVP;
    return { X: cam.Xc + (x - XVP) * (K / cam.c1) / u, Z: (1 / u - cam.c0) / cam.c1 };
  }
  function toScreen(X, Z, cam) {
    const u = 1 / (cam.c0 + cam.c1 * Z);
    return { x: XVP + (X - cam.Xc) * u * cam.c1 / K, y: u + YVP };
  }
  // コート内か（ダブルスライン基準・少し余裕を持たせる）
  function inCourt(X, Z, margin = 0.3) {
    return Math.abs(X) <= X_DBL + margin && Math.abs(Z) <= Z_BASE + margin;
  }

  return {
    XVP, YVP, K, X_DBL, X_SGL, Z_SVC, Z_BASE, W, H, SC, TH,
    frame, lineMask, rowProfile, peaksOf, solveZ, voteS, solveX,
    estimate, toCourt, toScreen, inCourt,
  };
})();
