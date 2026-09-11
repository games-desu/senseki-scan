// SENSEKI SCAN ラリー解析: 着弾の星マーカー（ブラウザ用・依存: Court）
//   Star.detect(img, { cam, ref }) → そのコマの星候補 [{cx,cy,n,w,h}]（960 空間）
//   Star.track(frames)            → マーカー [{t0,t1,k,x,y,nMax,w,h}]（同じ場所に 3 コマ以上）
//
// 実測（docs/rally-analysis.md 2026-09-08 夕方の続き・芝 p5 131.5 のロブ）:
//   着弾の瞬間に白緑の閃光 → 直後から地面に橙黄の平たい星（960 空間で 60〜70×18〜20px・H 55〜70・S 0.6〜0.7・V 190〜225）が 0.5 秒以上残る。
//   重心は出現時の成長とドリーで毎コマ 6〜9px 流れる。**着弾の予告ではなく着弾後の印**。ロブ・高い球で出やすく、常に出るわけではない。
//   砂コート（Hmed 50〜53・V90 217）: 星は H 55・S 0.43・V 231 で砂（H 48〜53・S 0.50〜0.57・V 213〜219）に近いが、
//   V ≥ 224（V90+7）・S 0.28〜0.50・H 52〜62 の三つを同時に課すと星だけが残る（2026-09-12 砂 p5 158.0〜158.4 で 83×29→44×12・
//   きれいな砂のコマでは塊ゼロ）。**着弾の閃光（白〜淡黄の輪・V 240+）は使わない**: 打点の閃光（チャージ解放・SMASH）と見分けが付かず、
//   砂では側の帰属が崩れるので側の条件で落とせない（2026-09-12 p0 で 11 本中 8 本が打点の閃光だった）。
window.Star = (() => {
  const W = 960, H = 540, SC = 2;
  const _mask = new Uint8Array(W * H), _seen = new Uint8Array(W * H), _stack = new Int32Array(W * H);

  function detect(img, { cam, ref = null } = {}) {
    if (!cam || !cam.ok) return [];
    const sand = !!(ref && ref.Hmed != null && ref.Hmed >= 40 && ref.Hmed <= 75);   // 砂コート: 星は砂より少し明るく・薄く・緑寄り
    const vTh = sand ? Math.max(224, Math.round((ref.V90 || 0) * 255) + 7) : 0;
    const d = img.data, m = _mask; m.fill(0);
    // 走査領域: コート台形（横 1.5m・前後 1.5m の余裕）。空や観客席の黄色を見ない
    const yFar = Math.max(0, Math.floor(Court.toScreen(0, Court.Z_BASE + 1.5, cam).y / SC));
    const yNear = Math.min(H - 1, Math.ceil(Court.toScreen(0, -Court.Z_BASE - 1.5, cam).y / SC));
    for (let y = yFar; y <= yNear; y++) {
      const Z = Court.toCourt(960, y * SC, cam).Z;
      const x0 = Math.max(0, Math.round(Court.toScreen(-Court.X_DBL - 1.5, Z, cam).x / SC)), x1 = Math.min(W - 1, Math.round(Court.toScreen(Court.X_DBL + 1.5, Z, cam).x / SC));
      let j = y * W + x0, i = j * 4;
      for (let x = x0; x <= x1; x++, j++, i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let mx = r, mn = r; if (g > mx) mx = g; else if (g < mn) mn = g; if (b > mx) mx = b; else if (b < mn) mn = b;
        const dd = mx - mn;
        if (sand) {
          if (mx < vTh || !dd) continue;
          const sat = dd / mx; if (sat < 0.28 || sat > 0.50) continue;
          let h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h *= 60; if (h < 0) h += 360;
          if (h >= 52 && h <= 62) m[j] = 1;
          continue;
        }
        if (mx < 140 || !dd) continue;
        if (dd / mx < 0.45) continue;
        let h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h *= 60; if (h < 0) h += 360;
        if (h >= 45 && h <= 68) m[j] = 1;
      }
    }
    // 連結成分（4近傍）→ 平たい塊だけ
    const seen = _seen, st = _stack, out = []; seen.fill(0);
    for (let y = yFar; y <= yNear; y++) for (let x = 0; x < W; x++) {
      const j0 = y * W + x; if (!m[j0] || seen[j0]) continue;
      let sp = 0, n = 0, sx = 0, sy = 0, bx0 = W, bx1 = 0, by0 = H, by1 = 0; st[sp++] = j0; seen[j0] = 1;
      while (sp) {
        const k = st[--sp], kx = k % W, ky = (k / W) | 0; n++; sx += kx; sy += ky;
        if (kx < bx0) bx0 = kx; if (kx > bx1) bx1 = kx; if (ky < by0) by0 = ky; if (ky > by1) by1 = ky;
        if (kx > 0 && m[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; st[sp++] = k - 1; }
        if (kx < W - 1 && m[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; st[sp++] = k + 1; }
        if (ky > 0 && m[k - W] && !seen[k - W]) { seen[k - W] = 1; st[sp++] = k - W; }
        if (ky < H - 1 && m[k + W] && !seen[k + W]) { seen[k + W] = 1; st[sp++] = k + W; }
      }
      const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
      // 遠近: 手前ほど大きい。面積 120〜4000・幅 30 以上・幅/高さ 2.2 以上（平たい）・塗り率（n / (w*h)）0.3 以上（線状の縁を除く）
      // 実測（芝 p5）: 本物 62〜82×15〜23（n 354〜1018）。黄色いロブのトレイルが 32×11（n 271）で紛れたので幅 40・高さ 13 以上
      // 砂: 星は奥で小さく映る（44×12）。砂のさざ波の明るい所は塊にならない（k≥4 で更に落とす）
      if (sand) { if (n < 120 || n > 3000 || w < 36 || h < 9 || w / h < 1.8 || n / (w * h) < 0.3) continue; }
      else if (n < 200 || n > 4000 || w < 40 || h < 13 || w / h < 2.2 || n / (w * h) < 0.3) continue;
      out.push(sand ? { cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), n, w, h, sand: true } : { cx: +(sx / n).toFixed(1), cy: +(sy / n).toFixed(1), n, w, h });
    }
    return out;
  }

  // frames: [{t, stars:[...]}] 時刻順（トレイルと同じ 2 コマ間隔）。±14px で繋ぎ、2 コマ抜けまで許す。3 コマ以上をマーカーとする
  // link 20: 0908b ハード p4 の自分側コートの星はドリーで 0.2 秒に 15px 流れ、14 だと 4 つの断片に割れた
  function track(frames, { link = 20, minK = 3, maxGapFrames = 2 } = {}) {
    const open = [], done = [];
    for (let fi = 0; fi < frames.length; fi++) {
      const f = frames[fi], used = new Set();
      for (const s of f.stars) {
        let best = null, bd = link;
        for (const o of open) { if (used.has(o)) continue; const d = Math.hypot(o.x - s.cx, o.y - s.cy); if (d < bd) { bd = d; best = o; } }
        if (best) { best.t1 = f.t; best.k++; best.nMax = Math.max(best.nMax, s.n); best.w = Math.max(best.w, s.w); best.h = Math.max(best.h, s.h);
                    best.x = +((best.x * 3 + s.cx) / 4).toFixed(1); best.y = +((best.y * 3 + s.cy) / 4).toFixed(1); best.fi = fi; used.add(best); }
        else { const o = { t0: f.t, t1: f.t, k: 1, x: s.cx, y: s.cy, nMax: s.n, w: s.w, h: s.h, fi, sand: !!s.sand }; open.push(o); used.add(o); }
      }
      for (let i = open.length - 1; i >= 0; i--) if (fi - open[i].fi > maxGapFrames) { const o = open.splice(i, 1)[0]; if (o.k >= (o.sand ? 4 : minK)) done.push(o); }
    }
    open.forEach(o => { if (o.k >= (o.sand ? 4 : minK)) done.push(o); });
    done.sort((a, b) => a.t0 - b.t0);
    return done.map(o => o.sand ? { t0: o.t0, t1: o.t1, k: o.k, x: o.x, y: o.y, nMax: o.nMax, w: o.w, h: o.h, sand: true }
                                 : { t0: o.t0, t1: o.t1, k: o.k, x: o.x, y: o.y, nMax: o.nMax, w: o.w, h: o.h });
  }

  return { detect, track };
})();
