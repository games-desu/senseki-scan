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
        if (y >= far - 175) { const z = Court.Z_BASE; x0 = Court.toScreen(-XM - 1.5, z, cam).x / SC; x1 = Court.toScreen(XM + 1.5, z, cam).x / SC; }
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
  function effectMask(img, ref, rows, lines) {
    const d = img.data, mask = new Uint8Array(W * H), wm = _wm;
    let yTop = H; for (let y = 0; y < H; y++) if (rows[y * 2] <= rows[y * 2 + 1]) { yTop = y; break; }
    wm.fill(0, Math.max(0, yTop) * W);
    const { S90, V90, L90, Hmed, whiteCap, useHue } = ref;
    for (let y = 0; y < H; y++) {
      const x0 = rows[y * 2], x1 = rows[y * 2 + 1];
      for (let x = x0; x <= x1; x++) {
        if (inHud(x, y)) continue;
        const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0, v = mx / 255;
        const l = lum(r, g, b);
        let hit = (s > S90 + 0.08 && v > V90 - 0.05);
        let h = -1;
        const hueOf = () => { if (h >= 0) return h; const dd = mx - mn; if (dd <= 0) return (h = 0); let t = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; t *= 60; if (t < 0) t += 360; return (h = t); };
        if (!hit && l > L90 + 25 && s > 0.30) {
          if (!useHue) hit = true;
          else { hit = hueDist(hueOf(), Hmed) > 12; }
        }
        // 分岐H（追加・2026-09-07）: 明るく彩度の高いコート（芝 L90=178 / S90=0.75）では
        // 青スライス(82,160,209: L=142 S=0.61)が分岐K/Bのどちらにも入らない。コート色相から
        // 30°以上離れた有彩色画素を通す。緑の芝(H≈85)に対し 青200/紫300/橙25 は十分離れ、
        // ボール本体(H≈60)と黄ロブ(H≈55)は 25〜30°で境界。赤クレイ(H≈358)では赤の尾は入らないが先端(28〜42)は入る
        if (!hit && useHue && s > 0.35 && v > 0.55) hit = hueDist(hueOf(), Hmed) > 30;
        if (hit) mask[y * W + x] = 1;
        else if (s < 0.22 && l > L90 + 25 && l < whiteCap && !(lines && lines[y * W + x])) wm[y * W + x] = 1;
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
      if (pts.length >= MIN_AREA) out.push(pts);
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
    const { Htip, Htail, Smed } = c;
    if (Smed == null) return 'unknown';
    if (Smed < 0.20) return 'drop';
    let Ht = Htail;
    // クレイ赤×赤: 尾の色相がコート色と同一になるので先端で判定（手順7）
    if (ref && ref.useHue && Ht != null && hueDist(Ht, ref.Hmed) < 15 && (Ht >= 340 || Ht < 20) && Htip != null) Ht = Htip;
    if (Ht == null) Ht = Htip;
    if (Ht == null) return 'unknown';
    if (Ht >= 250 && Ht < 345) return 'flat';
    if (Ht >= 185 && Ht < 250) return 'slice';
    if (Ht >= 345 || Ht < 15) return 'topspin';
    if (Ht >= 15 && Ht < 40) return (Htip != null && Htip >= 48) ? 'lob' : 'topspin';
    if (Ht >= 40 && Ht < 70) return 'lob';
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
      if (sh.elong < MIN_ELONG || sh.len < MIN_LEN) continue;
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
      const tz = Court.toCourt(tail.x * SC, tail.y * SC, cam);
      blobs.push({ n: sh.n, cx: +sh.cx.toFixed(1), cy: +sh.cy.toFixed(1), elong: +sh.elong.toFixed(2), len: +sh.len.toFixed(1),
                   tip: { x: tip.x, y: tip.y }, tail: { x: tail.x, y: tail.y }, ov: +ov.toFixed(2),
                   tailZ: +tz.Z.toFixed(2), tailX: +tz.X.toFixed(2), side: tz.Z > 0 ? 'opp' : 'me',
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
        let best = null, bd = Infinity;
        for (const r of open) {
          if (used.has(r)) continue;
          const last = r.frames[r.frames.length - 1];
          const k = Math.round((f.t - last.t) * fps);
          if (k > maxGap) continue;
          const dist = Math.hypot(b.cx - last.b.cx, b.cy - last.b.cy);
          if (dist > 50 + 30 * Math.max(1, k)) continue;   // トレイル重心の移動は最大でも 30px/コマ程度。緩いと選手のオーラと繋がる
          // 種別が違う blob は別のショット（同じ場所でも繋がない）。unknown はどちらにも付く
          const same = b.cls === last.b.cls || b.cls === 'unknown' || last.b.cls === 'unknown';
          const cost = dist + (same ? 0 : 1e6);
          if (cost < bd) { bd = cost; best = r; }
        }
        if (best && bd < 1e6) { best.frames.push({ t: f.t, b }); used.add(best); }
        else { const r = { t0: f.t, frames: [{ t: f.t, b }] }; open.push(r); used.add(r); }
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
    const fr = r.frames;
    const t0 = fr[0].t, t1 = fr[fr.length - 1].t;
    const win = fr.filter(f => f.t - t0 >= 3 / fps && f.t - t0 <= 10 / fps);
    const use = win.length >= 2 ? win : fr.slice(0, Math.min(fr.length, 6));
    const votes = {};
    for (const f of use) votes[f.b.cls] = (votes[f.b.cls] || 0) + 1;
    const cls = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
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
    return { t0, t1, n: fr.length, cls, votes, side, dir, dy: +dy.toFixed(1), disp: +disp.toFixed(1),
             tail: { x: first.tail.x, y: first.tail.y, X: first.tailX, Z: first.tailZ },
             Htip: median(use.map(f => f.b.Htip).filter(v => v != null)),
             Htail: median(use.map(f => f.b.Htail).filter(v => v != null)),
             Smed: median(use.map(f => f.b.Smed).filter(v => v != null)),
             nMax: Math.max(...fr.map(f => f.b.n)), frames: fr.map(f => ({ t: f.t, cx: f.b.cx, cy: f.b.cy, n: f.b.n, cls: f.b.cls, side: f.b.side })) };
  }

  // ---- ショット列の整形 ----
  //  1. 動かない run（チャージ中のキャラのオーラ・看板）を捨てる: 重心の最大変位 < MIN_DISP
  //  2. 短い run（< MIN_N コマ）を捨てる
  //  3. 同種別・同側で近接した run を1本に併合（ネットや選手で分断された同じトレイル）
  //  併合の種別は「色相の隣り合う族」まで許す（topspin/lob は先端の色相が流れて後半の断片が lob に化ける）。
  //  併合後の種別は最初の断片のもの（打点+4〜10コマの色が仕様上いちばん信用できる）。
  const FAMILY = { topspin: 'warm', lob: 'warm', slice: 'blue', flat: 'purple', drop: 'white', unknown: 'any' };
  function shots(runsIn, { minDisp = 40, minN = 5, mergeGap = 0.45, tStart = -Infinity } = {}) {
    const keep = runsIn.filter(r => r.disp >= minDisp && r.n >= minN && r.t0 >= tStart + 0.3).sort((a, b) => a.t0 - b.t0);
    const out = [];
    for (const r of keep) {
      const last = out[out.length - 1];
      const fam = (a, b) => FAMILY[a] === FAMILY[b] || FAMILY[a] === 'any' || FAMILY[b] === 'any';
      if (last && fam(last.cls, r.cls) && (last.dir === r.dir || !r.dir || !last.dir) && r.t0 - last.t1 <= mergeGap) {
        last.t1 = Math.max(last.t1, r.t1); last.n += r.n; last.nMax = Math.max(last.nMax, r.nMax); last.merged = (last.merged || 1) + 1;
        continue;
      }
      out.push(Object.assign({}, r));
    }
    return out;
  }

  return { W, H, SC, hsv, hueDist, courtRef, effectMask, detect, runs, shots, classify, HUD_EXCL };
})();
