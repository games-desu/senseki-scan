// SENSEKI SCAN ラリー解析 Phase D: ショット色トレイル（ブラウザ用・依存: Court）
// 仕様は docs/rally-probe/shot-color.md「推奨アルゴリズム」。ここに書いた数値はすべてそこからの写し。
//
//   Trail.detect(img, { cam, hist, ball }) → { blobs, ref, mask }
//     img   960x540 RGBA（ball.js と同じ土俵）
//     cam   Court.estimate の結果（コート台形・基準帯の位置に使う）
//     hist  直前フレームの detect 結果の配列（静止直線の除去と尾/先端の判定に使う・新しい順）
//     ball  そのフレームのボール位置 {x,y}（960空間・任意）。あれば先端の決定に使う
//   Trail.runs(frames, { fps }) → ショット（トレイルの時間的な連なり）の一覧
//
// 処理は 960x540。閾値のうち面積・長さは画面比率で持つ（720p/1440p 混在対策）。
window.Trail = (() => {
  const W = 960, H = 540, SC = 2;
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  function hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return { h, s: mx ? d / mx : 0, v: mx / 255 };
  }
  function circMean(hs, ws) {
    let sx = 0, sy = 0;
    for (let i = 0; i < hs.length; i++) { const a = hs[i] * Math.PI / 180, w = ws ? ws[i] : 1; sx += Math.cos(a) * w; sy += Math.sin(a) * w; }
    if (!sx && !sy) return null;
    let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360; return h;
  }
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const FAMILY = { topspin: 'warm', lob: 'warm', slice: 'blue', flat: 'purple', drop: 'white', unknown: 'any' };
  const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

  // ---- HUD 除外矩形（FHD 仕様値 / SC）----
  const HUD_EXCL = [
    { x: 0, y: 425, w: 235, h: 115 }, { x: 725, y: 425, w: 235, h: 115 },
    { x: 0, y: 0, w: 240, h: 230 }, { x: 670, y: 0, w: 290, h: 80 },   // 左上は実況の吹き出し＋黄色い名札(y〜215)まで
  ];
  const inHud = (x, y) => HUD_EXCL.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

  // ---- 走査領域: コート台形（横に 2.5m・手前に 4m・奥に 2m の余裕）＋ 上方向 175px（ロブは空を通る）----
  function region(cam) {
    const rows = new Int16Array(H * 2);       // [x0,x1] per row。x0>x1 なら対象外
    const far = Court.toScreen(0, Court.Z_BASE, cam).y / SC;
    const XM = Court.X_DBL + 2.5;
    for (let y = 0; y < H; y++) {
      let Z = Court.toCourt(960, y * SC, cam).Z;
      let x0 = 1, x1 = 0;
      if (y < far) {
        // ロブは奥ベースラインより上の空間を通るので 120px だけ許す（175 だと砂コートのテントの縞が入る）。最上段 15px は常に除外
        if (y >= far - 120 && y >= 15) { const z = Court.Z_BASE; x0 = Court.toScreen(-XM - 1.5, z, cam).x / SC; x1 = Court.toScreen(XM + 1.5, z, cam).x / SC; }
      } else if (Z >= -Court.Z_BASE - 4) {
        x0 = Court.toScreen(-XM, Z, cam).x / SC; x1 = Court.toScreen(XM, Z, cam).x / SC;
      }
      rows[y * 2] = Math.max(0, Math.round(x0)); rows[y * 2 + 1] = Math.min(W - 1, Math.round(x1));
    }
    return rows;
  }

  // ---- 既知のコートライン＋ネット帯の近傍マスク（白分岐の誤検出源を幾何で消す）----
  // 仕様の「3フレーム差分で静止直線を消す」はドリー（最大5px/frame）で破綻し、サイドラインの縁が
  // 幅5〜7px・長さ200px超の"白トレイル"として毎フレーム残った（2026-09-07 芝コート実測）。
  // カメラモデルでライン位置は分かるので、そこを白分岐から外す。
  const lineNear = new Uint8Array(W * H);
  function stamp(x, y, r) {
    const x0 = Math.max(0, (x - r) | 0), x1 = Math.min(W - 1, (x + r) | 0), y0 = Math.max(0, (y - r) | 0), y1 = Math.min(H - 1, (y + r) | 0);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) lineNear[yy * W + xx] = 1;
  }
  function segment(X0, Z0, X1, Z1, cam, extra = 0) {
    const a = Court.toScreen(X0, Z0, cam), b = Court.toScreen(X1, Z1, cam);
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / SC));
    for (let i = 0; i <= n; i++) {
      const X = X0 + (X1 - X0) * i / n, Z = Z0 + (Z1 - Z0) * i / n;
      const p = Court.toScreen(X, Z, cam), y = p.y / SC;
      if (y < -20 || y > H + 20) continue;
      stamp(p.x / SC, y, 4 + 6 * Math.max(0, y) / H + extra);      // 手前ほど太い（遠近）・カメラ推定のずれ数pxを吸収
    }
  }
  function buildLineNear(cam) {
    lineNear.fill(0);
    const XD = Court.X_DBL, XS = Court.X_SGL, ZS = Court.Z_SVC, ZB = Court.Z_BASE;
    for (const X of [-XD, -XS, XS, XD]) segment(X, -ZB - 4, X, ZB + 2, cam);   // サイドラインはベースラインの外へ延びて描かれている
    segment(0, -ZS, 0, ZS, cam);
    for (const Z of [-ZB, ZB]) segment(-XD, Z, XD, Z, cam);
    for (const Z of [-ZS, ZS]) segment(-XS, Z, XS, Z, cam);
    // ネットの白帯（高さ 0.91〜1.07m）: 地面のネット線から上へ持ち上げる
    const base = Court.toScreen(0, 0, cam), u = 1 / cam.c0, hpx = 0.91 * u / cam.Yc;
    const nl = Court.toScreen(-(XD + 0.9), 0, cam), nr = Court.toScreen(XD + 0.9, 0, cam);
    const n = Math.ceil((nr.x - nl.x) / SC);
    for (let i = 0; i <= n; i++) stamp((nl.x + (nr.x - nl.x) * i / n) / SC, (base.y - hpx * 1.1) / SC, 5);
    return lineNear;
  }

  // ---- 手順1: コート基準（台形の内側・ライン画素を除く）----
  function courtRef(img, cam) {
    const d = img.data;
    const S = [], V = [], L = [], Hs = [], lineLs = [];
    const yFar = Court.toScreen(0, Court.Z_BASE, cam).y / SC, yNear = Math.min(H - 1, Court.toScreen(0, -Court.Z_BASE, cam).y / SC);
    for (let y = Math.max(0, yFar | 0); y < yNear; y += 4) {
      const Z = Court.toCourt(960, y * SC, cam).Z;
      const x0 = Court.toScreen(-Court.X_DBL, Z, cam).x / SC, x1 = Court.toScreen(Court.X_DBL, Z, cam).x / SC;
      for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1); x += 4) {
        if (inHud(x, y)) continue;
        const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        const { h, s, v } = hsv(r, g, b), l = lum(r, g, b);
        if (l > 175 && s < 0.20) { lineLs.push(l); continue; }
        S.push(s); V.push(v); L.push(l); if (s > 0.15) Hs.push(h);
      }
    }
    if (S.length < 200) return null;
    const S90 = pct(S, 0.9), V90 = pct(V, 0.9), L90 = pct(L, 0.9), L50 = pct(L, 0.5);
    const Hmed = Hs.length > 50 ? circMean(Hs) : null;
    const lineL = lineLs.length >= 50 ? median(lineLs) : 255;
    const whiteCap = (lineL < L90 + 60) ? 255 : lineL - 10;
    const useHue = S90 >= 0.25 && Hmed != null;
    return { S90, V90, L90, L50, Hmed, lineL, whiteCap, useHue, n: S.length };
  }

  // ---- 手順2: 3分岐マスク ----
  // 白分岐は別マスクに取り、9x9 のオープニング（細い構造の除去）を掛けてから合流させる。
  // コートライン（960空間で 2〜6px）はこれで消え、白トレイル（幅広のぼやけた円錐）は残る。
  // カメラ推定は15コマに1回なのでライン位置の stamp だけでは追従しきれない（ドリー最大2.5px/コマ@960）。
  const _wm = new Uint8Array(W * H), _tmp = new Uint8Array(W * H);
  function openWhite(wm, yTop, r) {
    // 横方向の収縮→縦方向の収縮→縦膨張→横膨張（分離可能な矩形カーネル）
    const t = _tmp; t.fill(0, Math.max(0, yTop) * W);
    for (let y = Math.max(0, yTop); y < H; y++) { const o = y * W; let run = 0; for (let x = 0; x < W; x++) { run = wm[o + x] ? run + 1 : 0; if (run >= 2 * r + 1) t[o + x - r] = 1; } }
    const t2 = wm; t2.fill(0, Math.max(0, yTop) * W);
    for (let x = 0; x < W; x++) { let run = 0; for (let y = Math.max(0, yTop); y < H; y++) { run = t[y * W + x] ? run + 1 : 0; if (run >= 2 * r + 1) t2[(y - r) * W + x] = 1; } }
    t.fill(0, Math.max(0, yTop) * W);
    for (let x = 0; x < W; x++) { for (let y = Math.max(0, yTop); y < H; y++) if (t2[y * W + x]) { for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) t[yy * W + x] = 1; } } }
    t2.fill(0, Math.max(0, yTop) * W);
    for (let y = Math.max(0, yTop); y < H; y++) { const o = y * W; for (let x = 0; x < W; x++) if (t[o + x]) { for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) t2[o + xx] = 1; } } }
    return t2;
  }
  // HUD 除外は画素ごとの配列走査でなく事前に焼いたマスクで見る（effectMask が 85ms/コマだった主因のひとつ）
  const _hud = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inHud(x, y)) _hud[y * W + x] = 1;
  function effectMask(img, ref, rows, lines) {
    const d = img.data, mask = new Uint8Array(W * H), wm = _wm, hud = _hud;
    let yTop = H; for (let y = 0; y < H; y++) if (rows[y * 2] <= rows[y * 2 + 1]) { yTop = y; break; }
    wm.fill(0, Math.max(0, yTop) * W);
    const S90 = ref.S90, V90 = ref.V90, L90 = ref.L90, Hmed = ref.Hmed, whiteCap = ref.whiteCap, useHue = ref.useHue;
    const sK = S90 + 0.08, vK = V90 - 0.05, lB = L90 + 25;
    for (let y = 0; y < H; y++) {
      const x0 = rows[y * 2], x1 = rows[y * 2 + 1];
      let j = y * W + x0, i = j * 4;
      for (let x = x0; x <= x1; x++, j++, i += 4) {
        if (hud[j]) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let mx = r, mn = r;
        if (g > mx) mx = g; else if (g < mn) mn = g;
        if (b > mx) mx = b; else if (b < mn) mn = b;
        const dd = mx - mn, s = mx ? dd / mx : 0, v = mx * (1 / 255);
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        let hit = (s > sK && v > vK);
        if (!hit && useHue && ((l > lB && s > 0.30) || (s > 0.35 && v > 0.55) || (s >= 0.12 && v > 0.6))) {
          // 色相（必要なときだけ・オブジェクトもクロージャも作らない）
          let h = 0;
          if (dd > 0) { h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h *= 60; if (h < 0) h += 360; }
          let hd = Math.abs(h - Hmed); if (hd > 180) hd = 360 - hd;
          // 分岐B（輝度）は 12°、分岐H（追加・2026-09-07: 芝 L90=178/S90=0.75 で青スライス L=142 S=0.61 が K/B に入らない）は 30°
          hit = (l > lB && s > 0.30) ? hd > 12 : hd > 30;
          // 分岐P（追加・2026-09-08 砂コート実測）: 淡い水色のスライス (172,193,215) は S=0.20・L=189 で
          // コートの L90(194) より暗く、K/B/H/白のどれにも入らない。色相が 60°以上離れていれば低彩度でも通す
          if (!hit && s >= 0.12 && v > 0.6) hit = hd > 60;
        } else if (!hit && !useHue && l > lB && s > 0.30) hit = true;
        if (hit) mask[j] = 1;
        else if (s < 0.22 && l > lB && l < whiteCap && !(lines && lines[j])) wm[j] = 1;
      }
    }
    const op = openWhite(wm, yTop, 4);
    for (let i = Math.max(0, yTop) * W; i < W * H; i++) if (op[i]) mask[i] = 1;
    return mask;
  }

  // 3x3 膨張→収縮（closing）。rows の範囲だけ処理する
  const _dil = new Uint8Array(W * H);
  function closing(mask, yTop) {
    const a = _dil; a.fill(0, Math.max(0, yTop - 1) * W);
    const out = new Uint8Array(W * H);
    for (let y = Math.max(1, yTop); y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - W] || mask[i + W] || mask[i - W - 1] || mask[i - W + 1] || mask[i + W - 1] || mask[i + W + 1]) a[i] = 1;
    }
    for (let y = Math.max(1, yTop); y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (a[i] && a[i - 1] && a[i + 1] && a[i - W] && a[i + W] && a[i - W - 1] && a[i - W + 1] && a[i + W - 1] && a[i + W + 1]) out[i] = 1;
    }
    return out;
  }

  // ---- 手順3: 連結成分（8近傍）＋形状フィルタ ----
  const MIN_AREA = 0.0003 * W * H;     // 155px
  const MIN_ELONG = 2.2;
  const MIN_LEN = 0.04 * H;            // 21.6px
  const MAX_AREA = 0.06 * W * H;       // 画面の6%を超える塊は演出（フラッシュ等）

  const _seen = new Uint8Array(W * H), _stack = new Int32Array(W * H);
  function components(mask, yTop) {
    const seen = _seen, stack = _stack, out = [];
    seen.fill(0, Math.max(0, yTop) * W);
    for (let y = Math.max(0, yTop); y < H; y++) for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!mask[idx] || seen[idx]) continue;
      let sp = 0; stack[sp++] = idx; seen[idx] = 1;
      const pts = [];
      while (sp) {
        const j = stack[--sp]; pts.push(j);
        const jx = j % W, jy = (j / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = jx + dx, ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = ny * W + nx;
          if (mask[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
        }
      }
      if (pts.length >= MIN_AREA * 0.4) out.push(pts);   // 奥コートの小さなトレイル用に床を下げ、遠近スケール後の面積で shape 側が篩う
    }
    return out;
  }

  function shape(pts) {
    let sx = 0, sy = 0;
    for (const j of pts) { sx += j % W; sy += (j / W) | 0; }
    const n = pts.length, cx = sx / n, cy = sy / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const j of pts) { const dx = j % W - cx, dy = ((j / W) | 0) - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    sxx /= n; syy /= n; sxy /= n;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    // 主軸方向
    let ax, ay;
    if (Math.abs(sxy) > 1e-9) { ax = l1 - syy; ay = sxy; } else if (sxx >= syy) { ax = 1; ay = 0; } else { ax = 0; ay = 1; }
    const nrm = Math.hypot(ax, ay) || 1; ax /= nrm; ay /= nrm;
    let pmin = Infinity, pmax = -Infinity, jmin = -1, jmax = -1;
    for (const j of pts) {
      const p = (j % W - cx) * ax + (((j / W) | 0) - cy) * ay;
      if (p < pmin) { pmin = p; jmin = j; }
      if (p > pmax) { pmax = p; jmax = j; }
    }
    return { n, cx, cy, ax, ay, elong: Math.sqrt(l1 / l2), len: pmax - pmin,
             p1: { x: jmin % W, y: (jmin / W) | 0, p: pmin }, p2: { x: jmax % W, y: (jmax / W) | 0, p: pmax } };
  }

  // ---- 手順4〜6: 先端/尾・色相サンプリング・分類 ----
  function sampleColors(img, pts, sh, tipIsP2) {
    const d = img.data;
    const bins = Array.from({ length: 10 }, () => ({ h: [], s: [] }));
    const span = sh.p2.p - sh.p1.p || 1;
    const tipP = tipIsP2 ? sh.p2.p : sh.p1.p;
    for (const j of pts) {
      const x = j % W, y = (j / W) | 0;
      const p = (x - sh.cx) * sh.ax + (y - sh.cy) * sh.ay;
      if (Math.abs(p - tipP) < 15 / SC) continue;                    // 最先端15px(FHD)はボール本体
      let u = (p - sh.p1.p) / span; if (!tipIsP2) u = 1 - u;          // u: 0=尾 … 1=先端
      const b = Math.min(9, Math.max(0, (u * 10) | 0));
      const i = j * 4, { h, s } = hsv(d[i], d[i + 1], d[i + 2]);
      bins[b].s.push(s); if (s > 0.25) bins[b].h.push(h);
    }
    const Hi = bins.map(b => b.h.length >= 3 ? circMean(b.h) : null);
    const Si = bins.map(b => b.s.length ? median(b.s) : null);
    const pick = idx => { const hs = []; for (const k of idx) if (Hi[k] != null) hs.push(Hi[k]); return hs.length ? circMean(hs) : null; };
    const Htip = pick([8, 9]), Htail = pick([0, 1]);
    let core = -1, best = -1;
    Si.forEach((s, k) => { if (s != null && s > best) { best = s; core = k; } });
    const Hcore = core >= 0 ? Hi[core] : null;
    const Smed = median(Si.filter(s => s != null));
    return { Htip, Hcore, Htail, Smed, Hi: Hi.map(h => h == null ? null : Math.round(h)), Si: Si.map(s => s == null ? null : +s.toFixed(2)) };
  }

  function classify(c, ref) {
    const { Htip, Htail, Hcore, Smed } = c;
    if (Smed == null) return 'unknown';
    if (Smed < 0.20) {
      // 淡い水色（砂コートのスライス S≈0.16〜0.20）はドロップ(白)ではない。色相が青なら slice
      const hb = Htail != null ? Htail : Htip;
      if (hb != null && hb >= 140 && hb < 250 && Smed >= 0.10) return 'slice';
      // 淡い紫（15-18-15 デイジーの溜めフラット S=0.16・先端 315°）も同じ。色相ビンは s>0.25 の画素からしか作られないので、
      // 色相が読めている＝芯に有彩色がある。真っ白なドロップは Htip/Htail が null のまま drop に落ちる
      const hp = Htip != null ? Htip : Htail;
      if (hp != null && hp >= 250 && hp < 345 && Smed >= 0.10) return 'flat';
      return 'drop';
    }
    let Ht = Htail;
    // クレイ赤×赤: 尾の色相がコート色と同一になるので先端で判定（手順7）
    if (ref && ref.useHue && Ht != null && hueDist(Ht, ref.Hmed) < 15 && (Ht >= 340 || Ht < 20) && Htip != null) Ht = Htip;
    if (Ht == null) Ht = Htip;
    // 尾と核（彩度最大のビン）の色相が 60° 以上離れている blob は2本のトレイルが結合したもの
    // （0908 芝: ピンクのチャージ付きフラットの尾に来球の青スライスが繋がり尾=179〜228・核=284〜300）。核で決める。
    // オフライン評価（samples/rally/cls-eval-0908.js）で 27/34 → 29/34・退行なし
    if (Ht != null && Hcore != null && hueDist(Ht, Hcore) > 60) Ht = Hcore;
    if (Ht == null) return 'unknown';
    if (Ht >= 250 && Ht < 345) return 'flat';
    if (Ht >= 140 && Ht < 250) return 'slice';      // 仕様 197-207。芝で先端 150〜195 の水色が実測されたので広げた（2026-09-08）
    if (Ht >= 345 || Ht < 75) {
      // 暖色族: トップスピンとロブは先端の色相で分ける（仕様: topspin 先端 28-42 / lob 54-55）。
      // 0908 芝 p0（全打トップスピン）で先端 44〜51 が出たので境界は 52
      // 尾が橙〜赤(<45)ならトップスピン（ロブは尾まで黄色い）。クレイでは橙トレイルの先端が 59 まで黄に寄る（2026-09-08 実測）
      if (Ht >= 345 || Ht < 45) return 'topspin';
      const tip = Htip != null ? Htip : Ht;
      if (tip >= 52 && tip < 75) return 'lob';
      return 'topspin';
    }
    return 'unknown';
  }

  // 静止直線の除去: 3フレーム前の生マスクと 80% 以上重なる blob は捨てる
  function overlapWith(pts, mask) {
    if (!mask) return 0;
    let c = 0; for (const j of pts) if (mask[j]) c++;
    return c / pts.length;
  }

  let _refCam = null, _ref = null;
  function detect(img, { cam, hist = [], ball = null } = {}) {
    if (!cam || !cam.ok) return { blobs: [], ref: null, mask: null };
    let ref;
    if (_refCam === cam && _ref) ref = _ref; else { ref = courtRef(img, cam); _refCam = cam; _ref = ref; }
    if (!ref) return { blobs: [], ref: null, mask: null };
    const rows = region(cam);
    let yTop = H; for (let y = 0; y < H; y++) if (rows[y * 2] <= rows[y * 2 + 1]) { yTop = y; break; }
    const lines = buildLineNear(cam);
    const raw = effectMask(img, ref, rows, lines);
    const mask = closing(raw, yTop);
    const old = hist[2] && hist[2].mask;              // 3フレーム前
    const prev = hist[0] && hist[0].blobs || [];
    const blobs = [];
    for (const pts of components(mask, yTop)) {
      if (pts.length > MAX_AREA) continue;
      const sh = shape(pts);
      const psc = Math.min(1.3, Math.max(0.45, (sh.cy + 325) / 625));           // 遠近: 奥(y≈100)は 0.68倍
      if (sh.n < MIN_AREA * psc * psc || sh.elong < MIN_ELONG || sh.len < MIN_LEN * psc) continue;
      const ov = overlapWith(pts, old);
      if (ov >= 0.97) continue;   // 仕様の0.8は本物のトレイル(0.3秒残る)まで落とす。ラインは幾何で除外済み
      // 先端の決定: ボール位置 → 直前blobの端点との一致（尾は動かない）→ 明るい側
      let tipIsP2 = null;
      if (ball) tipIsP2 = Math.hypot(sh.p2.x - ball.x, sh.p2.y - ball.y) < Math.hypot(sh.p1.x - ball.x, sh.p1.y - ball.y);
      else if (prev.length) {
        let d1 = Infinity, d2 = Infinity;
        for (const b of prev) {
          d1 = Math.min(d1, Math.hypot(sh.p1.x - b.tail.x, sh.p1.y - b.tail.y));
          d2 = Math.min(d2, Math.hypot(sh.p2.x - b.tail.x, sh.p2.y - b.tail.y));
        }
        if (Math.min(d1, d2) < 40) tipIsP2 = d1 < d2;   // p1 が尾に一致 → 先端は p2
      }
      if (tipIsP2 == null) {
        const d = img.data, at = p => { const i = (p.y * W + p.x) * 4; return lum(d[i], d[i + 1], d[i + 2]); };
        tipIsP2 = at(sh.p2) >= at(sh.p1);
      }
      const tip = tipIsP2 ? sh.p2 : sh.p1, tail = tipIsP2 ? sh.p1 : sh.p2;
      const col = sampleColors(img, pts, sh, tipIsP2);
      const cls = classify(col, ref);
      const tz = Court.toCourt(tail.x * SC, tail.y * SC, cam), cz = Court.toCourt(sh.cx * SC, sh.cy * SC, cam);
      blobs.push({ n: sh.n, cx: +sh.cx.toFixed(1), cy: +sh.cy.toFixed(1), elong: +sh.elong.toFixed(2), len: +sh.len.toFixed(1),
                   tip: { x: tip.x, y: tip.y }, tail: { x: tail.x, y: tail.y }, ov: +ov.toFixed(2),
                   tailZ: +tz.Z.toFixed(2), tailX: +tz.X.toFixed(2), cZ: +cz.Z.toFixed(2), side: tz.Z > 0 ? 'opp' : 'me',
                   Htip: col.Htip == null ? null : Math.round(col.Htip), Hcore: col.Hcore == null ? null : Math.round(col.Hcore),
                   Htail: col.Htail == null ? null : Math.round(col.Htail), Smed: col.Smed == null ? null : +col.Smed.toFixed(2),
                   cls });
    }
    blobs.sort((a, b) => b.n - a.n);
    return { blobs, ref, mask: raw };
  }

  // ---- ショット（トレイルの時間的な連なり）----
  // frames: [{t, blobs:[...]}] 時刻順。同色・同側・近接（コマ間の移動 <= 150px×コマ差）で繋ぐ。
  function runs(frames, { fps = 60, maxGap = 6, minFrames = 4 } = {}) {
    const open = [], done = [];
    const close = r => { if (r.frames.length >= minFrames) done.push(r); };
    for (const f of frames) {
      const used = new Set();
      for (const b of f.blobs) {
        // 有彩色なのに種別が無い blob（緑のルイージ等の選手）は run に入れない。run の先頭に混ざると t0/側/cZ0 を汚す
        // （0908 砂 417.9: ルイージの緑 blob → 小 blob → 自分のトレイルの大 blob と繋がって"相手の打点"になった）
        if (b.cls === 'unknown' && b.Smed != null && b.Smed >= 0.4) continue;
        let best = null, bd = Infinity;
        for (const r of open) {
          if (used.has(r)) continue;
          const last = r.frames[r.frames.length - 1];
          const k = Math.round((f.t - last.t) * fps);
          if (k > maxGap) continue;
          // 小さい blob の連なり（看板・静止物）が、通りがかった大きなトレイルに乗り移るのを防ぐ。
          // 本物のトレイルは最初の1〜2コマで急に育つ（279→4696 等）ので、4コマ以上続いた run にだけ掛ける
          if (r.frames.length >= 4 && b.n > 4 * r.nMax) continue;
          const dist = Math.hypot(b.cx - last.b.cx, b.cy - last.b.cy);
          if (dist > 50 + 30 * Math.max(1, k)) continue;   // トレイル重心の移動は最大でも 30px/コマ程度。緩いと選手のオーラと繋がる
          // 種別が違う blob は別のショット（同じ場所でも繋がない）。unknown はどちらにも付く
          const same = b.cls === last.b.cls || b.cls === 'unknown' || last.b.cls === 'unknown' || FAMILY[b.cls] === FAMILY[last.b.cls];   // topspin↔lob は同族
          // 進行方向が反転したら別のショット（同じ橙色でも、自分の打球と相手の返球は逆向きに進む）
          const ddy = b.cy - last.b.cy;
          const rev = r.dirSign && Math.abs(ddy) > 8 && Math.sign(ddy) !== r.dirSign;
          const cost = dist + (same && !rev ? 0 : 1e6);
          if (cost < bd) { bd = cost; best = r; }
        }
        if (best && bd < 1e6) {
          best.frames.push({ t: f.t, b }); used.add(best); if (b.n > best.nMax) best.nMax = b.n;
          if (!best.dirSign && best.frames.length >= 3) { const d0 = b.cy - best.frames[0].b.cy; if (Math.abs(d0) >= 6) best.dirSign = Math.sign(d0); }
        }
        else { const r = { t0: f.t, frames: [{ t: f.t, b }], nMax: b.n }; open.push(r); used.add(r); }
      }
      for (let i = open.length - 1; i >= 0; i--) {
        const r = open[i], last = r.frames[r.frames.length - 1];
        if (Math.round((f.t - last.t) * fps) > maxGap) { open.splice(i, 1); close(r); }
      }
    }
    open.forEach(close);
    done.sort((a, b) => a.t0 - b.t0);
    return done.map(r => summarize(r, fps));
  }

  // 色は打点から 4〜10 コマ後の中央値で決める（固定点で色相が流れるため・shot-color H項）
  function summarize(r, fps) {
    let fr = r.frames;
    // 打点の再アンカー: run の先頭にチャージ中のオーラ（小さく、その場でゆらぐ blob）が繋がっていることがある
    // （0908 芝 55.85: オーラ6コマ→トレイル。votes の窓がオーラに掛かり 'unknown' で選手扱いに落ちた）。
    // 「面積がそれまでの中央値の 2.5 倍以上に跳ね、かつ重心が 40px 以上動いた」コマをトレイルの出現とみなし、そこから後ろだけを使う。
    // 本物のトレイルは先頭 1〜2 コマで育ちきる（279→1224→4696）ので i>=3 に限れば誤爆しない（実測: 0908 の本物 run で該当 0）
    // 位置の跳びは面積の跳びの 1 コマ前に来ることがある（出現コマは小さく、次のコマで育つ）ので i と i-1 の大きい方を見る
    const stepAt = i => i <= 0 ? 0 : Math.hypot(fr[i].b.cx - fr[i - 1].b.cx, fr[i].b.cy - fr[i - 1].b.cy);
    // 先頭 10 コマ（0.33 秒）以内に限る: 奥から迫るロブは近づくほど blob が育ち、降下で 40px 跳ぶので run の途中（0908b p4: 31 コマ目）が"出現"に見えてしまう。
    // オーラは打つ直前 0.2〜0.4 秒だけなので 10 で足りる（実測 birth=4〜6）
    let birth = 0;
    for (let i = 3; i < Math.min(fr.length, 11); i++) {
      const prev = median(fr.slice(0, i).map(f => f.b.n));
      if (fr[i].b.n >= 2.5 * prev && Math.max(stepAt(i), stepAt(i - 1)) >= 40) birth = i;
    }
    const cZpre = fr[0].b.cZ;   // 再アンカー前の先頭（オーラなら選手の位置）。側の整合の判定に使う
    if (birth > 0 && fr.length - birth >= 3) { r.reanchored = birth; fr = fr.slice(birth); }
    const t0 = fr[0].t, t1 = fr[fr.length - 1].t;
    // 仮カメラ（サーブ画→ラリー画のズーム中）で見つけた blob の割合。ズーム中は座標も進行方向も意味を持たない
    const provFrac = fr.filter(f => f.b.prov).length / fr.length;
    // 縦の直進度 = |y の正味の変位| / Σ|Δy|。トレイルは y が単調（0.9〜1.0・反転で run が切れるのでロブでも片道）。
    // 走る選手（赤いマリオ・0908 クレイ 227.93）は y が 394→351→389 と往復して 0.14。x は分断された断片の交互出現で揺れるので見ない（芝 274.77 の本物のロブが x 揺れで 0.56 だった）
    let yPath = 0; for (let i = 1; i < fr.length; i++) yPath += Math.abs(fr[i].b.cy - fr[i - 1].b.cy);
    const yStraight = yPath >= 1 ? Math.abs(fr[fr.length - 1].b.cy - fr[0].b.cy) / yPath : 1;
    const win = fr.filter(f => f.t - t0 >= 3 / fps && f.t - t0 <= 10 / fps);
    const use = win.length >= 2 ? win : fr.slice(0, Math.min(fr.length, 6));
    const votes = {};
    for (const f of use) votes[f.b.cls] = (votes[f.b.cls] || 0) + 1;
    let cls = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
    // 'drop' は run の前半で彩度が一度も 0.25 を超えないときだけ（マックスチャージの白い閃光で色が飛ぶ数コマを弾く）
    const sMax = Math.max(...fr.slice(0, Math.min(fr.length, 10)).map(f => f.b.Smed == null ? 0 : f.b.Smed));
    if (cls === 'drop' && sMax >= 0.25) {
      const alt = Object.entries(votes).filter(e => e[0] !== 'drop').sort((a, b) => b[1] - a[1])[0];
      cls = alt ? alt[0] : 'unknown';
    }
    // 重心の1ステップあたりの移動量の中央値（トレイルはボールと一緒に動く: 10〜60px/2コマ。選手・ラベル・看板は数px）
    const steps = []; for (let i = 1; i < fr.length; i++) steps.push(Math.hypot(fr[i].b.cx - fr[i - 1].b.cx, fr[i].b.cy - fr[i - 1].b.cy) / Math.max(1, Math.round((fr[i].t - fr[i - 1].t) * fps)));
    const spd = median(steps) || 0;
    // 側は打点＝出現直後の尾の位置で決める（尾はボールと一緒に動くので全期間の多数決は駄目）
    // 側は「トレイルがどちらへ進むか」で決める（尾の位置は出現が遅れると動いてしまう）。
    // 重心の y が減る（画面上へ進む）＝自分の打球、増える＝相手の打球。動きが小さいときだけ尾の Z で補う
    const early = fr.slice(0, Math.min(fr.length, 4));
    const zEarly = median(early.map(f => f.b.tailZ));
    const first = fr[0].b, lastB = fr[fr.length - 1].b;
    let disp = 0; for (const f of fr) disp = Math.max(disp, Math.hypot(f.b.cx - first.cx, f.b.cy - first.cy));
    const k = Math.min(fr.length - 1, 8);
    const dy = fr[k].b.cy - first.cy;
    const dir = Math.abs(dy) >= 6 ? (dy < 0 ? 'up' : 'down') : null;
    const side = dir ? (dir === 'up' ? 'me' : 'opp') : (zEarly > 0 ? 'opp' : 'me');
    return { t0, t1, n: fr.length, cls, votes, side, dir, dy: +dy.toFixed(1), disp: +disp.toFixed(1), spd: +spd.toFixed(1), dur: +(t1 - t0).toFixed(2), sMax: +sMax.toFixed(2), reanchored: r.reanchored || 0,
             provFrac: +provFrac.toFixed(2), straight: +yStraight.toFixed(2), cZpre,
             tail: { x: first.tail.x, y: first.tail.y, X: first.tailX, Z: first.tailZ },
             Htip: median(use.map(f => f.b.Htip).filter(v => v != null)),
             Htail: median(use.map(f => f.b.Htail).filter(v => v != null)),
             Smed: median(use.map(f => f.b.Smed).filter(v => v != null)),
             nMax: Math.max(...fr.map(f => f.b.n)), cZ0: first.cZ, frames: fr.map(f => ({ t: f.t, cx: f.b.cx, cy: f.b.cy, n: f.b.n, cls: f.b.cls, side: f.b.side })) };
  }

  // ---- ショット列の整形 ----
  //  1. 動かない run（チャージ中のキャラのオーラ・看板）を捨てる: 重心の最大変位 < MIN_DISP
  //  2. 短い run（< MIN_N コマ）を捨てる
  //  3. 同種別・同側で近接した run を1本に併合（ネットや選手で分断された同じトレイル）
  //  併合の種別は「色相の隣り合う族」まで許す（topspin/lob は先端の色相が流れて後半の断片が lob に化ける）。
  //  併合後の種別は最初の断片のもの（打点+4〜10コマの色が仕様上いちばん信用できる）。
  //  4. 進行方向が無い（|dy|<6）・重心速度が遅い（spd<6px/ステップ）・1秒を超えて続く run は選手／ラベル／看板
  // maxDur 1.3: 0908b ハード p0 の自分のサーブのトレイルが 1.07 秒続いて落ちた（選手・看板は直進度/速度/緑で別途落ちる）
  function shots(runsIn, { minDisp = 40, minN = 5, mergeGap = 0.45, tStart = -Infinity, minSpd = 6, maxDur = 1.3 } = {}) {
    // 遠近: 奥コート(y≈100)のトレイルは手前の 0.7 倍ほど小さく遅い。しきい値を y でスケールする
    const scOf = r => Math.min(1.3, Math.max(0.5, (r.frames[0].cy + 325) / 625));
    // 側の整合: 自分の打球は手前(Z<0)から上へ、相手の打球は奥(Z>0)から下へ進む。尾の Z と進行方向が食い違う run は
    // トレイルではない（チャージ中のキャラのオーラが下へ伸びる等・0908 芝 58.5 で自分の打点を潰した）。ネット際(|Z|<2)は不問
    // 判定は出現時の重心の Z（尾は最初のコマで先端と取り違えることがある）。緩めに: 自分は Z<3・相手は Z>-3
    // 再アンカーした run は出現時の重心が先へ進んでいる（クレイ 327.27: Z=3.68 で本物のロブが落ちた）ので、切り離す前の先頭（cZpre）でも可
    // 閾値 5: 自分のトレイルはネット手前 Z=3.2 で出現することがある（15-18-15 p8 デイジーのスライス/フラット・3 だと落ちた）。オーラは選手の位置（|Z|≈8〜10）なので余裕がある
    const sideOk = r => r.cZ0 == null || (r.side === 'me' ? (r.cZ0 < 5 || r.cZpre < 5) : (r.cZ0 > -5 || r.cZpre > -5));
    const keep = runsIn.filter(r => { const sc = scOf(r); return r.disp >= minDisp * sc && r.n >= minN && r.t0 >= tStart + 0.3 && r.dir && r.spd >= minSpd * sc && r.dur <= maxDur
                                       && sideOk(r)
                                       && !(r.provFrac >= 0.8)          // 仮カメラのズーム中だけの run（0908 芝 52.37: サーブ画の blob が"相手の打点"になった）
                                       && !(r.straight != null && r.straight < 0.6)   // y が往復する run は走る選手（0908 クレイ 227.93 マリオ 0.14・本物は 0.85 以上）
                                       // 尾か先端が緑（80〜140°）＝選手が混ざった blob（0908b ヨッシー: 赤い甲羅で topspin 判定・先端 101°）。ショット色に緑は無い（ロブの先端は 66° まで）
                                       && !((r.Htail != null && r.Htail >= 80 && r.Htail < 140) || (r.Htip != null && r.Htip >= 80 && r.Htip < 140))
                                       && !(r.cls === 'unknown' && r.Smed != null && r.Smed >= 0.4); }).sort((a, b) => a.t0 - b.t0);   // 有彩色なのに種別が無い＝選手（緑のルイージ等）
    const out = [];
    for (const r of keep) {
      const last = out[out.length - 1];
      const fam = (a, b) => FAMILY[a] === FAMILY[b] || FAMILY[a] === 'any' || FAMILY[b] === 'any';
      if (last && fam(last.cls, r.cls) && (last.dir === r.dir || !r.dir || !last.dir) && r.t0 - last.t1 <= mergeGap) {
        // 先行断片が「4コマ以上あるのに後続の 1/5 未満」ならチャージ中のオーラ（0908 クレイ 225.4: nMax 834 → 本物 13343、
        // 砂 413.7: 723 → 7688）。時刻・種別・側などは後続（本物のトレイル）のものにする。本物が途中で切れた断片は 1〜2 コマ目で
        // 育ちきっているので 5 倍差にはならない（芝 56.267 で最大 4.6 倍）
        const t1 = Math.max(last.t1, r.t1), n = last.n + r.n, merged = (last.merged || 1) + 1;
        if (last.n >= 4 && r.nMax >= 5 * last.nMax) Object.assign(last, r, { t1, n, merged, auraT0: last.auraT0 != null ? last.auraT0 : last.t0 });
        else { last.t1 = t1; last.n = n; last.nMax = Math.max(last.nMax, r.nMax); last.merged = merged; }
        continue;
      }
      out.push(Object.assign({}, r));
    }
    return out;
  }

  return { W, H, SC, hsv, hueDist, courtRef, effectMask, detect, runs, shots, classify, HUD_EXCL, _region: region, _closing: closing, _components: components, _buildLineNear: buildLineNear };
})();
