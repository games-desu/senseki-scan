// カメラ推定の寄せ直し（2026-11-11・samples/rally/cam-check.js で試作→本体へ）。
// Court.estimate は白線マスク（明るく彩度の低い画素）から 3 自由度（c0, c1, Xc）を解く。線がクリーム色のコートや
// 模様のある床では横線・縦線の同定がずれ、打点の座標が 1m ほど動く（docs/rally-analysis.md「カメラの寄せ直し」）。
// ここでは色に頼らず、コート線の模型を画面に写して「線らしい画素（左右か上下より明るい尾根）」に乗る割合を点数にし、
// 推定値を出発点に点数が最大の所へ寄せる。rally-node の analyze が Court.estimate の直後に呼ぶ。
//   ridge(rgba)            → { V, Hm }   1 コマ（960×540 RGBA）の尾根。V=縦線向け・Hm=横線向け
//   score(rd, cam, tol)    → 0〜1        模型の点が尾根に乗る割合（見える点が 40 未満なら 0）
//   refine(rd, cam)        → { cam, s }  座標ごとの山登り（幅を半分にしながら 5 段）
//   gridSearch(rd)         → { cam, s }  出発点が遠いときの総当たり（粗い格子の上位 4 つから refine）
//   improve(rd, e, prev)   → { cam, s, s0, src }  推定 e と直前の結果 prev から寄せ、低ければ総当たり。src: 'est' | 'prev' | 'grid'
//   rescue(rd, prev, grid) → { cam, s, src } | null  推定が落ちたコマ用。prev から寄せ、grid が真なら総当たりも
'use strict';
const W = 960, H = 540, XVP = 960, YVP = -651, K = 2.796e-4;   // court.js と同じ（座標は FHD 基準・画像は 1/2）
const XD = 5.485, XS = 4.115, ZS = 6.4, ZB = 11.885;
const toScreen = (X, Z, c) => { const u = 1 / (c.c0 + c.c1 * Z); return { x: XVP + (X - c.Xc) * u * c.c1 / K, y: u + YVP }; };

// 模型の点（0.25m おき）。[X, Z, 横線か]。ネットの奥 0〜3m はネットに隠れるので使わない
const MODEL = (() => {
  const pts = [], ok = Z => !(Z > -0.3 && Z < 3);
  for (let Z = -ZB; Z <= ZB + 1e-6; Z += 0.25) if (ok(Z)) { for (const X of [-XD, -XS, XS, XD]) pts.push([X, Z, 0]); if (Math.abs(Z) <= ZS) pts.push([0, Z, 0]); }
  for (let X = -XD; X <= XD + 1e-6; X += 0.25) { for (const Z of [-ZB, ZB]) pts.push([X, Z, 1]); if (Math.abs(X) <= XS) for (const Z of [-ZS, ZS]) pts.push([X, Z, 1]); }
  return pts;
})();

// 尾根: 左右 d 画素より g 明るい（縦線）/ 上下 d 画素より g 明るい（横線）
function ridge(rgba) {
  const L = new Float32Array(W * H);
  for (let i = 0, o = 0; i < W * H; i++, o += 4) L[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  const V = new Uint8Array(W * H), Hm = new Uint8Array(W * H), d = 5, g = 14;
  for (let y = d; y < H - d; y++) for (let x = d; x < W - d; x++) {
    const i = y * W + x, l = L[i];
    if (l - L[i - d] > g && l - L[i + d] > g) V[i] = 1;
    if (l - L[i - d * W] > g && l - L[i + d * W] > g) Hm[i] = 1;
  }
  return { V, Hm };
}

function score(rd, cam, tol = 2) {
  let n = 0, hit = 0;
  for (const [X, Z, kind] of MODEL) {
    const q = toScreen(X, Z, cam), x = Math.round(q.x / 2), y = Math.round(q.y / 2);
    if (!(x >= 8 && y >= 70 && x < W - 8 && y < H - 50)) continue;   // 上のバナーと下の得点表示は見ない
    n++;
    const m = kind ? rd.Hm : rd.V; let h = 0;
    if (kind) { for (let dy = -tol; dy <= tol && !h; dy++) if (m[(y + dy) * W + x]) h = 1; }
    else { for (let dx = -tol; dx <= tol && !h; dx++) if (m[y * W + x + dx]) h = 1; }
    hit += h;
  }
  return n >= 40 ? hit / n : 0;
}

function refine(rd, c, tol = 2) {
  let best = { c0: c.c0, c1: c.c1, Xc: c.Xc }, bs = score(rd, best, tol);
  let st = { c0: 0.03 * c.c0, c1: 0.06 * c.c1, Xc: 0.4 };
  for (let it = 0; it < 5; it++) {
    let moved = true, guard = 0;
    while (moved && guard++ < 12) {
      moved = false;
      for (const k of ['Xc', 'c0', 'c1']) for (const s of [-1, 1]) {
        const c2 = { ...best, [k]: best[k] + s * st[k] };
        if (!(c2.c0 > 0 && c2.c1 > 0)) continue;
        const sc = score(rd, c2, tol);
        if (sc > bs + 1e-9) { best = c2; bs = sc; moved = true; }
      }
    }
    st = { c0: st.c0 / 2, c1: st.c1 / 2, Xc: st.Xc / 2 };
  }
  return { cam: best, s: bs };
}

// 範囲は実測の cams から（c0 0.68〜1.10e-3・c1 0.014〜0.039e-3・Xc ±2.4m）
function gridSearch(rd) {
  const top = [];
  for (let i0 = 0; i0 <= 14; i0++) for (let i1 = 0; i1 <= 14; i1++) for (let ix = 0; ix <= 16; ix++) {
    const c = { c0: (0.68 + 0.03 * i0) * 1e-3, c1: (0.014 + 0.0018 * i1) * 1e-3, Xc: -2.4 + 0.3 * ix }, sc = score(rd, c, 4);
    if (top.length < 4 || sc > top[top.length - 1].s) { top.push({ c, s: sc }); top.sort((a, b) => b.s - a.s); if (top.length > 4) top.pop(); }
  }
  let best = null; for (const t of top) { const r = refine(rd, t.c); if (!best || r.s > best.s) best = r; }
  return best;
}

const LOW = 0.6, GRID_GAIN = 0.05;
function improve(rd, e, prev) {
  const s0 = score(rd, e);
  let r = refine(rd, e), src = 'est';
  if (prev) { const r2 = refine(rd, prev); if (r2.s > r.s) { r = r2; src = 'prev'; } }
  if (r.s < LOW) { const g = gridSearch(rd); if (g && g.s > r.s + GRID_GAIN) { r = g; src = 'grid'; } }
  return { cam: r.cam, s: r.s, s0, src };
}
function rescue(rd, prev, grid) {
  let r = prev ? refine(rd, prev) : null, src = 'prev';
  if (grid && (!r || r.s < LOW)) { const g = gridSearch(rd); if (g && (!r || g.s > r.s + GRID_GAIN)) { r = g; src = 'grid'; } }
  return r ? { cam: r.cam, s: r.s, src } : null;
}

module.exports = { ridge, score, refine, gridSearch, improve, rescue, toScreen, K, MODEL };
