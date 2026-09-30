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
  const netNear = new Uint8Array(W * H);   // ネットの白帯だけ（色相分岐の淡い画素を落とす・effectMask）
  function stamp(x, y, r, dst = lineNear) {
    const x0 = Math.max(0, (x - r) | 0), x1 = Math.min(W - 1, (x + r) | 0), y0 = Math.max(0, (y - r) | 0), y1 = Math.min(H - 1, (y + r) | 0);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) dst[yy * W + xx] = 1;
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
    lineNear.fill(0); netNear.fill(0);
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
    // 芝では白帯が淡い水色（s 0.13〜0.23）に写って色相分岐 H に入り、白帯（elong 35〜50・ネット全幅の blob）がネットを越える色のトレイルと 1 個の blob に繋がって
    // 両端の色相ビンが白帯になり drop に化けていた（芝ランクマ 15-18-15 p9 217.23〜217.40: 自分の青スライスの筋 n 2926・S 0.43 が白帯と繋がって n 5770・S 0.16・Htip/Htail null／
    // p10 230.87〜231.07: 自分のピンクのフラットが同じく drop）。白帯の帯 netNear を別に持ち、effectMask で帯の中の淡い画素を色相分岐からも外す。
    // 帯は垂れを入れる（中央 0.914m・ポスト 1.07m）: 実測（samples/rally/exp-misses/scr/netpos.js・217.216）で上の一直線は y960 203.6、白帯の画素は中央で y 206〜212＝高さ 0.86〜0.95m。帯の厚み分（−0.04m）も押さえる
    for (let i = 0; i <= n; i++) {
      const X = -(XD + 0.9) + 2 * (XD + 0.9) * i / n, q = X / (XD + 0.9), hX = 0.914 + 0.156 * q * q;
      const p = Court.toScreen(X, 0, cam);
      for (const dh of [0, -0.04]) stamp(p.x / SC, (p.y - (hX + dh) * u / cam.Yc) / SC, 5, netNear);   // netNear だけ（白分岐の lineNear に足すと、ネットを越える白いドロップの筋（ハード 0908b p0 85.63 自分のドロップ）が痩せて run が消えた）
    }
    return lineNear;
  }
  // 白帯の彩度（帯の明るい画素の中央値）。筋が帯を横切っていても帯全体（ダブルスの幅を 200 分割×4 段）の中央値なので動かない。
  // 値（2026-09-24 第 3 ラウンドの反証役がパイプラインの中で毎コマ測った値・exp-misses-verify/nets.js）: 芝ランクマ 15-18-15 は中央値 0.33〜0.35、砂 0911 は 11 ポイント中 9 で 0.27〜0.44
  //   → effectMask の上限 0.25 がほぼ毎コマ効いている。0908（砂・クレイ・芝）は 0.06〜0.08、ハード 0908b は ≈0.065 だが、0908 はカメラ推定（15 コマごと）の間に帯の位置がずれて
  //   1 つの窓の中で最大 0.6 まで鋸歯状に上がる（そのコマは上限 0.25 で切る）。
  //   （レーンが別スクリプト samples/rally/exp-misses/scr/tapecolor.js で 1 コマずつ測った「芝 0.18・砂/クレイ/ハード 0.06〜0.07」はパイプラインの値と合わなかった）
  //   上限の感度（x151815＋151815 を rerun）: 0.21 → 22/30 T15（p9 218.5 のロブを失う）・0.25 → 23/30 T16・0.30 → 22/30 C17 T15（p9 217.05 をまた失う）
  // 根拠の無い値（2026-09-24 exp-int3f・レビューの note）: 帯の画素が 50 点未満（帯が画面外・HUD の下・暗い）なら 0.15 とする所の「50 点」と「0.15」は実測の根拠が無い暫定値
  //   （exp-misses/scr/patch-net2.js で入ったまま・どのコマで効いているかも数えていない）。0.15 のとき effectMask の切りは 0.21
  let netS = 0.25;
  function measureNet(img, cam, ref) {
    const d = img.data, XD = Court.X_DBL, u = 1 / cam.c0, ss = [];
    for (let i = 0; i <= 200; i++) {
      const X = -XD + 2 * XD * i / 200, q = X / (XD + 0.9), hX = 0.914 + 0.156 * q * q, p = Court.toScreen(X, 0, cam), x = Math.round(p.x / SC);
      if (x < 0 || x >= W) continue;
      for (const dh of [0.02, 0, -0.02, -0.04]) {
        const y = Math.round((p.y - (hX + dh) * u / cam.Yc) / SC); if (y < 0 || y >= H || inHud(x, y)) continue;
        const j = (y * W + x) * 4, r = d[j], g = d[j + 1], b = d[j + 2];
        if (lum(r, g, b) < ref.L90 - 20) continue;
        ss.push(hsv(r, g, b).s);
      }
    }
    netS = ss.length >= 50 ? median(ss) : 0.15;
  }

  // ネットの白帯そのものの blob: 白（drop＝両端に色相が無い）・横長（elong ≥ 15・先端と尾の傾き < 0.15）・白帯の高さ（中央 0.914m）の ±30px。
  // 帯の除外（netNear）はカメラ推定（15 コマごと）の位置で掛けるので、サーブ画→ラリー画のズーム中は白帯が 1 コマ 1〜2px ずつ動いて帯から外れる
  // （芝ランクマ 15-18-15 p8 204.47〜204.73: 白帯 y 215→240・推定の帯 218／240・elong 20〜28・n 1000〜1600。7 コマの run が相手のドロップの打点 204.44 になった）。
  // 本物の白いドロップの筋は幅のある円錐（elong 2〜5）で、白帯と繋がった色のトレイルは両端に色相が出て drop にならない。
  // blob は捨てずに印（tape）だけ付け、run の 8 割以上が白帯の白い run を shots で捨てる（detect で捨てると run の繋ぎ方が変わり、
  // 芝ランクマ p9 218.43 の自分の黄ロブの run の先頭が別の切れ端に取られて側の整合で落ちた・実験場の再計算で確認）
  function netTapeBlob(b, cam) {
    if (b.cls !== 'drop' || !(b.elong >= 15) || !cam) return false;
    const dx = Math.abs(b.tip.x - b.tail.x), dy = Math.abs(b.tip.y - b.tail.y);
    if (!(dx > 0 && dy / dx < 0.15)) return false;
    const base = Court.toScreen(0, 0, cam), yT = (base.y - 0.914 / cam.c0 / cam.Yc) / SC;
    return Math.abs(b.cy - yT) <= 30;
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
    const netCut = Math.min(0.25, netS + 0.06);
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
          // ネットの白帯は芝の上で淡い水色（色相 130〜187°・s 0.13〜0.23、帯の下縁で網と混ざる所は 0.29〜0.40）に写り、分岐 H（s≥0.12・色相 30°超）に入る
          // （芝ランクマ 15-18-15 217.216 の y 202〜214・samples/rally/exp-misses/scr/tapepix.js）。白分岐のライン除外（lines）では止まらないので、帯の中の淡い画素は色相分岐でも取らない。
          // 切るのは白帯の彩度（measureNet）＋0.06 未満・上限 0.25。芝ランクマと砂 0911 ではほぼ毎コマ上限 0.25 で切っている。0908 の砂/クレイ/芝とハードは多くのコマで 0.12〜0.14
          // （分岐 H の下限 0.12 に近く、ほとんど切らない）だが、カメラ推定の間に帯がずれたコマは上限まで上がる（measureNet のコメント）。
          // ＋0.06 の出所（2026-09-24 exp-int3f・レビューの note）: misses レーンが別スクリプト（scr/tapecolor.js）で測った白帯の彩度（芝 0.18・砂/クレイ/ハード 0.06）に足して
          //   「芝 0.24・その他 0.12＝分岐 H の下限と同じで実質切らない」になるように置いた値（exp-misses/LOG）。その測り値はパイプラインの値と合わなかった（上の measureNet）ので、
          //   ＋0.06 自体は振って確かめていない暫定値（効いているのは主に上限 0.25 の方）
          // 注意（2026-09-24 exp-int3f・レビューの note）: ここで色相分岐から外した画素（hit=false）は下の else if に落ち、s < 0.22・明るい（l > lB・whiteCap 未満）・lines の外なら
          //   白分岐（wm）に入る（lines＝lineNear にはネットの一直線の stamp だけがあり、垂れを入れた netNear の帯は入れていない）。芝ランクマの白帯は輝度 170〜181 で lB（204）に
          //   届かず白分岐には落ちない（exp-misses/LOG）が、他のコートは測っていない。落ちた画素は白帯の白い blob になりうる＝変更 2（白帯の blob の印 tape と shots の除外）と組にする理由の一つ。
          //   コードを読んだだけで、白分岐へ落ちる画素の数・効きは測っていない
          // 色のトレイルの芯は s 0.4 以上なので帯の所が細く削れるだけ。一律 0.45 で切ると、砂の淡い水色のスライス（s 0.16〜0.30・0908 砂 420.9）の筋が帯の所で 1357→397 に痩せ、
          // summarize の再アンカー（次のコマで 2.5 倍）に掛かって run が 3 コマに縮み相手の打点 420.6 を失った
          if (hit && s < netCut && netNear[j]) hit = false;
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

  // 尾が赤く流れた紫のフラット（2026-09-23 第 4 ラウンド color レーン）: 紫のフラットは先端・核（彩度最大のビン）がマゼンタ〜紫（270〜345）のまま尾が赤（345〜15）に流れ、
  //   classify は尾で決めるので topspin になる（芝ランクマ 15-18-15 p12 248.93〜249.23 の自分のピンク紫のフラット: 先端 285〜313・核 302〜308・尾 346〜360 で run が topspin 3 票／
  //   GT 248.8 flat）。GT のある 6 セット（d0908 d0911 x*）で「尾が赤・先端 250〜345」の blob は GT の種別で flat 48・topspin 5（redtail.js）。
  //   先端だけで見ると、砂 0908 p17 のマリオの赤い体・赤いトップスピンの blob（先端 265〜344 だが核は赤 354〜12・S 0.6〜0.9）まで拾うので核も紫を課す。
  //   紫のフラットの核: 芝ランクマ 299〜308・砂 0911 313〜323・クレイ 0908 p8 305〜325・芝 0908 p5 282〜294（redtail.js -v）。先端のビンが読めない（null）ときは核だけで見る
  //   （同じ p12 249.20〜249.30 のピンクの球: 先端 null・核 307・尾 360）。
  //   blob の種別（classify）そのものは変えず、run の種別の票（summarize）でだけ flat と数える: blob を flat にすると runs の同族の繋ぎが変わり、
  //   v38 で偶然繋がっていた run が割れて全体走で偽の打点が 4 本出た（砂 0911 p1 49.47o・p2 59.64o・ハード 0908b p5 228.37o・p12 のフィーバーの自分の打点が消える: exp-r4-color/LOG [4]）
  function flatTail(b) {
    const purple = h => h != null && h >= 270 && h < 345;
    // 2026-09-29 第5ラウンド color: 先端はマゼンタ（345〜360）も紫の側に入れる。砂の上の紫のフラットは先端が赤へ寄る
    //   （x0911 p4 142.50〜142.67 の自分の紫のフラット: 核 313〜325 のまま先端 346・353 のコマがあり、flat 2／topspin 2 の同数で clsAlt にならず topspin・GT 142.3 flat）。
    //   GT のある 6 セットで「topspin・尾が赤・核が紫・先端 345〜360」の blob は 3 個（上の 142.6/142.633 が GT flat・d0911 152.733 は GT 打点の外）で topspin は 0（magtip.js）。
    //   先端が 0〜15（赤〜橙）は入れない（x0908 p5 140.467 は核 328 だが GT slice）
    //   全体走 47 ポイントでは新たに条件に入る blob が 3 個あり、うち 2 個は得点板・チャージ光のゴミだが、打点の種別には届いていない（exp-r5-color-verify）
    return b.cls === 'topspin' && b.Htail != null && (b.Htail >= 345 || b.Htail < 15) && (purple(b.Htip) || b.Htip == null || b.Htip >= 345) && purple(b.Hcore);
  }

  // クレイの青スライス（2026-09-23 第 4 ラウンド color レーン）: 半透明の青い筋の尾が赤いクレイ（コートの色相 11）と混ざって紫（尾 288〜322）に寄り、尾で決めると flat になる
  //   （全体走 0908 p12 278.5〜278.9 のルイージの青スライス: 先端 191〜228・尾 288〜322 で run が slice 5 票と flat 4 票の 2 本に割れ、打点は flat／
  //   同 286.8〜287.5 の青スライス: 先端 205〜246・尾 260〜304 で blob の半分が flat。img/s0908-278.png・s0908-287.png で両方とも青い筋）。
  //   混ざって紫になるのは赤いコートの上だけ（芝・砂の上では青緑になる: shots の tealSlice）。紫のフラットは先端（球の側）も紫（270〜345: flatTail の実測）なので先端が青なら slice
  //   blob の種別（classify）で slice にすると、同じ筋の blob が slice と flat/topspin に交互に割れて run が切れ、筋の途中から偽の打点が立った
  //   （全体走 0908 p11 +261.14o flat・p14 +361.64o topspin: img/s0908-260.png・s0908-361.png）ので、run の票（summarize）でだけ slice と数える。cH は run のコマのコートの色相
  //   GT の裏付けは無い（2026-09-25 統合の注記）: ベンチ・x セットにクレイの該当が無く score は不変。根拠は全体走 0908 の目視 3 本だけ（278.13o flat→slice・361.08o flat→slice は青い筋、
  //   321.14o は元から偽の打点で種別だけ変わる）。クレイの GT 付き素材が増えたら見直す
  function clayBlue(b, cH) {
    return cH != null && hueDist(cH, 13) <= 20 && b.Htip != null && b.Htip >= 140 && b.Htip < 250 && b.Htail != null && b.Htail >= 250 && b.Htail < 345;
  }

  // 静止直線の除去: 3フレーム前の生マスクと 80% 以上重なる blob は捨てる
  function overlapWith(pts, mask) {
    if (!mask) return 0;
    let c = 0; for (const j of pts) if (mask[j]) c++;
    return c / pts.length;
  }

  // ---- 居座り画素の除外（選手・チャージ中のオーラ・看板）----
  // 同じ画素が直近 PN コマのうち PTHR コマ以上エフェクト判定されていたら、その画素は今のコマのマスクから外す。
  // トレイルは一か所に 0.35 秒（≈10 コマ）しか残らず、ロブの頂点の漂いも 12 コマなので消えない。
  // 選手（0908b ヨッシーの赤い甲羅が topspin の run になって自分側の偽打点を作った）は毎コマ同じ場所にいるので消える。
  // 数えるのは除外前の生マスク（除外後を数えると PN コマ後に選手が復活して振動する）
  const PN = 20, PTHR = 14;
  const _ring = [], _cnt = new Uint16Array(W * H); let _ringI = 0;
  function persistFilter(raw, yTop) {
    const start = Math.max(0, yTop) * W, copy = raw.slice();
    let removed = 0;
    if (_ring.length >= PTHR) for (let j = start; j < W * H; j++) if (raw[j] && _cnt[j] >= PTHR) { raw[j] = 0; removed++; }
    if (_ring.length < PN) { _ring.push(copy); for (let j = start; j < W * H; j++) _cnt[j] += copy[j]; }
    else { const old = _ring[_ringI]; for (let j = 0; j < W * H; j++) _cnt[j] += copy[j] - old[j]; _ring[_ringI] = copy; _ringI = (_ringI + 1) % PN; }
    return removed;
  }

  let _refCam = null, _ref = null, _lastCam = null;
  function detect(img, { cam, hist = [], ball = null } = {}) {
    if (!cam || !cam.ok) return { blobs: [], ref: null, mask: null };
    let ref;
    if (_refCam === cam && _ref) ref = _ref; else { ref = courtRef(img, cam); _refCam = cam; _ref = ref; }
    if (!ref) return { blobs: [], ref: null, mask: null };
    const rows = region(cam);
    let yTop = H; for (let y = 0; y < H; y++) if (rows[y * 2] <= rows[y * 2 + 1]) { yTop = y; break; }
    const lines = buildLineNear(cam);
    measureNet(img, cam, ref);
    const raw = effectMask(img, ref, rows, lines);
    // カメラが大きく変わった（サーブ画→ラリー画のカット）ら居座りの履歴を捨てる。前の画の選手の位置が"居座り"として残り、
    // そこを通るサーブのトレイルが消えた（0908b p4 185.6: c0 0.00074→0.00091・Yc 16.7→12.7）
    if (_lastCam && (Math.abs(cam.c0 - _lastCam.c0) / _lastCam.c0 > 0.12 || Math.abs(cam.Yc - _lastCam.Yc) > 1.5)) { _ring.length = 0; _ringI = 0; _cnt.fill(0); }
    _lastCam = cam;
    const persisted = persistFilter(raw, yTop);
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
      const tape = netTapeBlob({ cls, elong: sh.elong, tip, tail, cy: sh.cy }, cam);
      const tz = Court.toCourt(tail.x * SC, tail.y * SC, cam), cz = Court.toCourt(sh.cx * SC, sh.cy * SC, cam);
      blobs.push({ n: sh.n, cx: +sh.cx.toFixed(1), cy: +sh.cy.toFixed(1), elong: +sh.elong.toFixed(2), len: +sh.len.toFixed(1),
                   tip: { x: tip.x, y: tip.y }, tail: { x: tail.x, y: tail.y }, ov: +ov.toFixed(2),
                   tailZ: +tz.Z.toFixed(2), tailX: +tz.X.toFixed(2), cZ: +cz.Z.toFixed(2), side: tz.Z > 0 ? 'opp' : 'me',
                   Htip: col.Htip == null ? null : Math.round(col.Htip), Hcore: col.Hcore == null ? null : Math.round(col.Hcore),
                   Htail: col.Htail == null ? null : Math.round(col.Htail), Smed: col.Smed == null ? null : +col.Smed.toFixed(2),
                   cls, tape: tape || undefined });
    }
    blobs.sort((a, b) => b.n - a.n);
    return { blobs, ref, mask: raw, persisted };
  }

  // ---- ショット（トレイルの時間的な連なり）----
  // frames: [{t, blobs:[...]}] 時刻順。同色・同側・近接（コマ間の移動 <= 150px×コマ差）で繋ぐ。
  function runs(frames, { fps = 60, maxGap = 6, minFrames = 4, yFarAt = null } = {}) {
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
          if (r.frames.length >= 4 && b.n > 4 * r.nMax) continue;   // 3 倍にすると 0908 芝 101.7 のチャージ付きフラット（1280→4087=3.2 倍）が割れて topspin に化ける。静止物への乗り移りは summarize の前置き/後置き切りで対処
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
          best.frames.push({ t: f.t, b, cH: f.ref ? f.ref.Hmed : null }); used.add(best); if (b.n > best.nMax) best.nMax = b.n;
          if (!best.dirSign && best.frames.length >= 3) { const d0 = b.cy - best.frames[0].b.cy; if (Math.abs(d0) >= 6) best.dirSign = Math.sign(d0); }
        }
        else { const r = { t0: f.t, frames: [{ t: f.t, b, cH: f.ref ? f.ref.Hmed : null }], nMax: b.n }; open.push(r); used.add(r); }
      }
      for (let i = open.length - 1; i >= 0; i--) {
        const r = open[i], last = r.frames[r.frames.length - 1];
        if (Math.round((f.t - last.t) * fps) > maxGap) { open.splice(i, 1); close(r); }
      }
    }
    open.forEach(close);
    done.sort((a, b) => a.t0 - b.t0);
    // 入ってくる run の尾の「上がり始め」を次の出球 run の頭へ移す（2026-09-24 第 4 ラウンド nearstart・work/reruns.js で保存済み trailLog から確かめた）。
    // 入ってくる球の筋（相手の打球）と自分の出球の出だしはラケットの所で 1 つの blob の連なりになる。上の rev（1 コマ 8px を超える逆向き）は、出だしの数コマが
    // ラケットの所で育つだけで 1 コマあたりはほとんど動かないので掛からず、出球の最初の 0.1 秒が入ってくる run に吸われる
    // （芝ランクマ x151815 p12 246.5: 入ってくる run の y 303→325→369（最下点 246.567）→362→359→352 のあと 246.700 から自分の run・打点 +0.17）。
    // 自分の上向き run B（先頭 5 コマで 20px 以上上がる）の 1〜2 コマ（トレイルの 30fps）前・40px 以内で終わる run A が、最下点まで 20px 以上降りてから 8px 以上上がって終わるなら、
    // 最下点より後のコマを B の頭へ移す。
    //  - A は B の開始より前のコマで見る（summarize の末尾の飛び値切り（trimSuf）で落ちる 1 コマが 246.5 では後ろに付いていた）。
    //  - 移すのは 4 コマ（0.13 秒）まで: 吸われるのは出だしの 0.1 秒ほど（246.5 は 3 コマ）。長い尾はロブ・静止物の漂い（x0911 p4 147.63 で 22 コマの静止物が付きかけた）。
    //  - B の最初のコマが A の終わりより下なら移さない: 出球は上へ続くはず（全体走 0908 p12 275.24: 移した 2 コマの後に B が 24px 下から始まり、直進度 0.43 で run ごと落ちて
    //    本物（接触 ≈275.00）を失った）。
    //  - A の最下点の見かけの Z < 8: 最下点が自分の打点（手前・ネット際のボレーでも球の高さで Z 5 前後: x0911 p4 142.47 の 5.4）。奥の高いロブ（全体走 0908 p19 479.7: cZ 12.5）の
    //    尾を移すと相手のロブの run（479.34o・接触 ≈479.22）を短くして失った。8 は 5.4 と 12.5 の間（暫定）。
    // 効き: x151815 246.67→246.57・x0911 p4 に自分のボレー 142.47m（接触 142.27〜.30・img/TM_142.png）が立ち、連鎖で 140.78o・142.65o が入る（141.95o drop は MIN_GAP で落ちる）。
    // A が短くなって minFrames を割ったら捨てる（close と同じ下限）
    for (const B of done) {
      const b0 = B.frames[0], bk = B.frames[Math.min(B.frames.length - 1, 4)];
      if (!(bk.b.cy - b0.b.cy <= -20)) continue;
      for (const A of done) {
        if (A === B || A.frames.length < 3) continue;
        let e = A.frames.length - 1; while (e >= 0 && A.frames[e].t >= b0.t) e--;
        if (e < 2) continue;
        const aL = A.frames[e];
        const k = Math.round((b0.t - aL.t) * fps);
        if (k < 1 || k > 2 || Math.hypot(b0.b.cx - aL.b.cx, b0.b.cy - aL.b.cy) > 40) continue;
        let m = 0; for (let i = 1; i <= e; i++) if (A.frames[i].b.cy >= A.frames[m].b.cy) m = i;
        if (m === e || e - m > 4 || A.frames[m].b.cy - A.frames[0].b.cy < 20 || A.frames[m].b.cy - aL.b.cy < 8 || b0.b.cy > aL.b.cy || !(A.frames[m].b.cZ < 8)) continue;
        const tail = A.frames.splice(m + 1, e - m);
        B.frames = tail.concat(B.frames); B.t0 = B.frames[0].t; B.nMax = Math.max(...B.frames.map(q => q.b.n)); A.nMax = Math.max(...A.frames.map(q => q.b.n)); B.tailMoved = tail.length;
        break;
      }
    }
    const kept = done.filter(r => r.frames.length >= minFrames).sort((a, b) => a.t0 - b.t0);
    return kept.map(r => summarize(r, fps, yFarAt));
  }

  // 赤い体の blob: 芯の色相が赤（345〜15°）・彩度 0.85 以上・小さい（n < 1000）。マリオの赤いシャツ（S 0.84〜0.93・n 150〜1100）・ヨッシーの赤い甲羅/靴（H 12〜16）。
  // 本物の橙〜赤の筋は手前では大きい（芯が赤い 0908 p8 221.90 のトップスピンも n 1818〜2039）
  // （2026-09-24 第 4 ラウンド nearjunk・exp-r4-nearjunk/redscan.js: v38 の全 shot で半分以上のコマが該当する run は 6 本、映像で全部 junk
  //   x0908 p17 442.93・s0908 p19 471.60/477.54・p3 115.37・p7 176.50（マリオ）・s0911 p9 224.87（ヨッシー）。GT セットの本物の打点は 0 本）
  const redBody = b => b.Hcore != null && (b.Hcore >= 345 || b.Hcore <= 15) && b.Smed != null && b.Smed >= 0.85 && b.n < 1000;
  // 横に細長い白い blob（白・elong ≥ 15・先端と尾の傾き < 0.15）＝ネットの白帯・ベースライン・サービスラインの一部。netTapeBlob から「白帯の高さ ±30px」を外したもの。
  // カメラの縦振り・ズーム中はカメラ推定（15 コマごと）の線の位置（lineNear・netNear・白帯の高さ）が追いつかず、線が白い blob として残って縦に流れる
  // （2026-09-24 第 4 ラウンド nearjunk: 芝ランクマ 15-18-15 p12 244.93〜245.57 の白帯がサーブ後の縦振りで下へ流れて相手の drop 打点 244.90o・p9 218.80／219.47 も同じ・exp-r4-nearjunk/flatscan.js）。
  // 本物の白いドロップの筋は幅のある円錐（elong 2〜6.5・GT セットの drop 打点 9 本で横長の白は 0 コマ）
  const flatWhite = b => b.cls === 'drop' && b.elong >= 15 && b.tip && b.tail && Math.abs(b.tip.y - b.tail.y) < 0.15 * Math.abs(b.tip.x - b.tail.x);

  // 色は打点から 4〜10 コマ後の中央値で決める（固定点で色相が流れるため・shot-color H項）
  function summarize(r, fps, yFarAt = null) {
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
    // 静止した前置き／後置きを切り落とす: 看板・テントの縁など静止した同色の blob に、通りがかったトレイルが前後で繋がる
    // （0908b ハード p4: 上端の橙 17 コマ → 相手のロブ → 下端の橙 17 コマ、で dir=null・2.8 秒になり捨てられた）。
    // 「先頭から 5 コマ以上が先頭の位置の 12px 以内」なら、そこまでを捨てる（末尾も同様）。トレイルは 1 コマ 5px 以上動くので該当しない
    // ただしロブの頂点付近も画面上ではほとんど動かない（奥へ進むだけ）ので、「面積が run の最大の半分未満」の blob だけを静止物とみなす
    // （静止物は 1300〜1800 のまま・ロブの頂点は 5000〜6650 で最大 8150）
    const nMaxAll = Math.max(...fr.map(f => f.b.n));
    // 隣接 16px（上端のテントの縁は 12.04px で 12 を超えて切れなかった）。末尾に 1〜2 コマだけ付いた飛び値（40px 超・小さい）は先に落とす
    // （0908b p4 185.6 のサーブ: 末尾に 177px 先の別物が 1 コマ付き、末尾の静止 6 コマが切れず dur 1.67 で捨てられた）
    const near = (a, b) => Math.hypot(a.b.cx - b.b.cx, a.b.cy - b.b.cy) <= 16 && a.b.n < 0.5 * nMaxAll && b.b.n < 0.5 * nMaxAll;
    for (let k = 0; k < 2 && fr.length >= 5; k++) {
      const L = fr[fr.length - 1], P = fr[fr.length - 2];
      if (Math.hypot(L.b.cx - P.b.cx, L.b.cy - P.b.cy) > 40 && L.b.n < 0.5 * nMaxAll) { fr = fr.slice(0, -1); r.trimSuf = (r.trimSuf || 0) + 1; } else break;
    }
    // 隣り合うコマ同士で見る（静止物はドリーでゆっくり流れるので、端のコマ基準だと 90 コマの静止が 5 コマで止まる）
    let pre = 0; while (pre + 1 < fr.length && near(fr[pre + 1], fr[pre])) pre++;
    // 隣り合うコマの 16px 以内は「遅い」だけで「静止」とは限らない: 奥の筋（サーブ・奥からの返球）は 1 歩（30fps）7〜12px で一方向に進み、ネットを越えて
    // 手前で大きく育つと先頭が nMaxAll の半分未満になって静止物として切られた（2026-09-24 第 4 ラウンド regress・芝ランクマ 15-18-15 p12 のサーブ 245.70〜246.13:
    // 14 コマ・正味 106px・直進 0.96 を切って打点を失い、帯の白い run 244.90o が残った）。前置きの区間がまっすぐ（直進度 0.9 以上）で、画面上の正味の動きと
    // カメラの縦移動を引いた重心 y（yFarAt・camTrim と同じ物差し）の動きがどちらも 1 歩平均 6px 以上なら、動く物として切らない（r.preMover）。
    // 6px の根拠（v38 の 67 ポイントで前置き切りが掛かった 394 件・scr/pretrim.js → var/pretrim-v38.txt。直進 0.9 以上の補正後の 1 歩）:
    //   奥の筋は 6.75〜12.1（最小 6.75 は 0908 p2 98.40・x0908 p5 140.37 の相手スライス 9.7・0911 p5 155.63 8.8・0908b p1 97.90 12.1（相手の黄の返球 97.4・img/v_b97.png）・151815 p12 8.5 ほか）、
    //   その下は 5.8 以下（最大 5.8 は 0908 p12 330.13・0908b p5 228.67）で 5.8〜6.75 の間に例が無い。5.5 の 0908 p13 339.97（青スライスの先頭 5 コマ・27px）を 5 で通すと同じ筋が flat と slice の 2 本の run に割れた。
    //   画面上の動き（net）も見るのは、画面の同じ所に居る物がカメラの縦移動だけで補正後に動いて見える組（0908b p3 140.80 正味 8px・0908 p12 306.77 9px・0911 p2 66.03 16px）を除くため。
    //   カメラのドリーは補正後ほぼ 0（camTrim の前提）
    // 残る誤り: 自分側へ落ちてくる相手のロブの筋（0908 p12 293.70・325.97・1 歩 12px）も動く物として残り、run の先頭が早まる（どちらも偽の相手打点で、前後で偽のまま・img/v_293.png・v_325.png）
    if (pre + 1 >= 5 && yFarAt) {
      const a = fr[0], b = fr[pre], ya = yFarAt(a.t), yb = yFarAt(b.t);
      let path = 0; for (let i = 1; i <= pre; i++) path += Math.hypot(fr[i].b.cx - fr[i - 1].b.cx, fr[i].b.cy - fr[i - 1].b.cy);
      const net = Math.hypot(b.b.cx - a.b.cx, b.b.cy - a.b.cy);
      if (ya != null && yb != null && path > 0 && net / path >= 0.9 && net >= 6 * pre && Math.abs((b.b.cy - yb) - (a.b.cy - ya)) >= 6 * pre) { r.preMover = pre + 1; pre = 0; }
    }
    if (pre + 1 >= 5 && fr.length - (pre + 1) >= 3) { r.trimPre = pre + 1; fr = fr.slice(pre + 1); }
    // 先頭に 3 コマ以上続く「ごく小さい blob（run 最大の 15% 未満）」は別物の切れ端（0908b p4 相手ロブの前の 769/217/884/499/224/139）。
    // 本物のトレイルは 1〜2 コマで育つ（279→1224→4696）ので 3 コマ以上の条件で当たらない
    // カメラ補正した静止（砂 0911 p1 51.37: テントの縁 7 コマ（y 29→49・ドリーで流れる）→ 本物の橙トレイル、が 1 本の run になり打点が 0.5 秒早く出た上に
    // 併合で背景断片に吸われた）。奥ベースラインの y の変化（カメラの縦移動）を引いた重心 y が先頭の 16px 以内に留まる先頭部分は静止物として切る。
    // 大きさの条件は near と同じ（ロブの頂点は補正後もほぼ動かないが blob が大きい）。run 全体が静止でカメラが 20px 以上動いていれば背景（shots で捨てる）
    if (yFarAt && fr.length >= 5) {
      const comp = f => { const y = yFarAt(f.t); return y == null ? null : f.b.cy - y; };
      const c0 = comp(fr[0]);
      if (c0 != null) {
        let k = 0;
        while (k + 1 < fr.length) { const c = comp(fr[k + 1]); if (c == null || Math.abs(c - c0) > 16 || fr[k + 1].b.n >= 0.8 * nMaxAll) break; k++; }   // 0.8: テントの縁は 1479/2874=0.51 で 0.5 だと切れなかった（0911 p1 51.37）。ロブの頂点は 0.6〜0.8
        const dcam = (yFarAt(fr[fr.length - 1].t) || 0) - (yFarAt(fr[0].t) || 0);
        if (k + 1 >= fr.length && Math.abs(dcam) >= 20) r.camStatic = +dcam.toFixed(0);
        else if (k + 1 >= 5 && fr.length - (k + 1) >= 3) { r.trimPre = (r.trimPre || 0) + k + 1; r.camTrim = k + 1; fr = fr.slice(k + 1); }
      }
      // 上の静止判定は大きさ保護（0.8）で止まるので、大きい静止物（砂 0911 の観客席テント: 157.23〜158.50 の 27 コマ・n 81〜1421・x が 338〜448 で揺れる）は素通りした。
      // run 全体（12 コマ以上＝0.4 秒超）で補正後の重心 y の幅が 20px 以内なら大きさ・カメラ移動量を問わず静止物（farStay・shots で捨てる）。
      // トレイルは消えるまで動き続ける。相手のロブの頂点の漂いは 0.4 秒で、その run は続けて降りてくる（0908b p4 192.20: 28 コマで幅 200 超）ので当たらない。
      // 根拠: samples/rally/far-probe.js（0908 GT 一致 run で 12 コマ以上のものは全て幅 50 超・砂の 50.63/157.23 は幅 8/10）
      if (fr.length >= 12) {
        const cs = fr.map(comp).filter(c => c != null);
        // 幅は 10〜90 パーセンタイルで測る（テント run の最後のコマが別物へ 55px 跳ぶ: 157.23 の 158.50 (428,103)）
        if (cs.length >= 12) { const rng = pct(cs, 0.9) - pct(cs, 0.1); if (rng <= 20) r.farStay = +rng.toFixed(0); }
      }
    }
    let tiny = 0; while (tiny < fr.length && fr[tiny].b.n < 0.15 * nMaxAll) tiny++;
    if (tiny >= 3 && fr.length - tiny >= 3) { r.trimPre = (r.trimPre || 0) + tiny; fr = fr.slice(tiny); }
    // 同じ切れ端が先頭でなく「大きい静止物 → ごく小さい切れ端 3 コマ以上 → 本物」の並びで来ることがある（砂 0911 p1 51.37: テントの縁 1479/1378/1446 →
    // 63/165/159/193/257 → 51.87 から本物の橙トレイル。打点が 0.5 秒早く出て GT 52.0 に届かなかった）。先頭 10 コマ以内で終わる 3 コマ以上の切れ端の直後を出現とみなす
    {
      let cut = 0, run = 0;
      for (let i = 0; i < Math.min(fr.length, 10); i++) { if (fr[i].b.n < 0.15 * nMaxAll) { run++; if (run >= 3) cut = i + 1; } else run = 0; }
      if (cut > 0 && fr.length - cut >= 3) { r.trimPre = (r.trimPre || 0) + cut; r.tinyCut = cut; fr = fr.slice(cut); }
    }
    // 画面の上端（y 30px 以内＝奥の壁・フェンス・テントの帯）に居座る先頭（第 5 ラウンド nearjunk）。上の静止切りは大きさ保護（0.5/0.8）で止まり、
    // 壁の帯が run 最大と同じ大きさのコマを含むと素通りした（砂 x0911 p4 147.60〜148.23: y 17〜22 の 19 コマ・n 1059 が run の最大 → 本物の橙トレイルは
    // 148.367 (441,78) から。打点が 147.57 と GT 147.85 より 0.28 早かった・img/x0911_1476.png。同じ形: x0911 p4 144.90〜145.20 の 8 コマ（y 23）→ 145.233 (581,100)、
    // ハード x0908b p0 80.53〜81.83 の 40 コマ（y 16〜28・img/x0908b_804.png で球は上端に無い）→ 82.000 (492,91)）。
    // 上端が 5 コマ以上（静止切りと同じ 5）続いた後に 40px 以上跳んで次が来るなら、上端の部分は別物とみなし、本物が現れたコマの時刻と尾を topHead/topTail に残す。
    // run は切らない（切ると後ろの切れ端が別の run として先頭に立ち、併合と種別が変わった: x0908b p0 が 81.54o topspin に・work/LOG 段 1）。使うのは fuse の相手側の打点時刻だけ。
    // ロブの頂点が上端に掛かっても、降りてくる球はふつう 1 コマ 12px 以下で繋がる（跳ばない）ので当たらない。ただし自分のロブが画面の上から外へ出て戻ると跳ぶ
    // （s0911 p0 20.717 の自分のロブ → 21.037 に topHead・全体走で見つけた）。これは fuse 側で「自分の打点の 370ms 以内の topHead 相手打点は捨てる」で止めている。3 コマ（x0908b p0 85.83: 決め球の後の上端 3 コマ）は数えない
    {
      r.topHead = null; r.topTail = null; r.topCut = 0;
      let k = 0; while (k < fr.length && fr[k].b.cy <= 30) k++;
      if (k >= 5 && fr.length - k >= 3 && Math.hypot(fr[k].b.cx - fr[k - 1].b.cx, fr[k].b.cy - fr[k - 1].b.cy) >= 40) { r.topHead = fr[k].t; r.topCut = k; r.topTail = { x: fr[k].b.tail.x, y: fr[k].b.tail.y, X: fr[k].b.tailX, Z: fr[k].b.tailZ }; }
    }
    let suf = 0; while (suf + 1 < fr.length && near(fr[fr.length - 2 - suf], fr[fr.length - 1 - suf])) suf++;
    if (suf + 1 >= 5 && fr.length - (suf + 1) >= 3) { r.trimSuf = (r.trimSuf || 0) + suf + 1; fr = fr.slice(0, fr.length - (suf + 1)); }
    // 「速く動いた後にその場で止まる」末尾（1 コマ 6px 以下が 4 コマ以上・大きさ不問）は走って止まった選手（0908b ヨッシーの赤い甲羅: 413→384 と動いて 319 付近で静止）。
    // トレイルは消えるまで動き続ける。ロブの頂点の漂いは run の先頭側（相手）か、自分側なら反転で run が切れた後なので末尾には来ない
    {
      const st = i => Math.hypot(fr[i].b.cx - fr[i - 1].b.cx, fr[i].b.cy - fr[i - 1].b.cy);
      let k = 0; while (k + 1 < fr.length && st(fr.length - 1 - k) <= 6) k++;
      if (k >= 4 && fr.length - k >= 3) {
        const steps = []; for (let i = 1; i < fr.length - k; i++) steps.push(st(i));
        if (median(steps) >= 8) { r.trimSuf = (r.trimSuf || 0) + k; fr = fr.slice(0, fr.length - k); }
      }
    }
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
    // 同数なら既知の種別を優先（砂 413.5: unknown 2 / slice 2 で unknown が先頭になり、頂点判定で lob に化けた）
    let cls = Object.entries(votes).sort((a, b) => b[1] - a[1] || (a[0] === 'unknown') - (b[0] === 'unknown'))[0][0];
    // 'drop' は run の前半で彩度が一度も 0.25 を超えないときだけ（マックスチャージの白い閃光で色が飛ぶ数コマを弾く）
    const sMax = Math.max(...fr.slice(0, Math.min(fr.length, 10)).map(f => f.b.Smed == null ? 0 : f.b.Smed));
    if (cls === 'drop' && sMax >= 0.25) {
      const alt = Object.entries(votes).filter(e => e[0] !== 'drop').sort((a, b) => b[1] - a[1])[0];
      cls = alt ? alt[0] : 'unknown';
    }
    // 色の混ざりを直した票（2026-09-23 第 4 ラウンド color レーン）: 尾が赤く流れた紫のフラット（flatTail）は flat、クレイで尾が紫に寄った青スライス（clayBlue）は slice と数え直し、
    //   その 1 位が今の種別（topspin/flat）より多ければ clsAlt。cls への反映は shots の併合が済んでから（併合の族・runs の繋ぎは v38 のまま。先に変えると筋が割れて偽の打点が立つ）
    let clsAlt = null;
    if (cls === 'topspin' || cls === 'flat') {
      const av = {}; for (const f of use) { const c = flatTail(f.b) ? 'flat' : clayBlue(f.b, f.cH) ? 'slice' : f.b.cls; av[c] = (av[c] || 0) + 1; }
      const top = Object.entries(av).sort((a, b) => b[1] - a[1] || (a[0] === 'unknown') - (b[0] === 'unknown'))[0];
      if (top && top[0] !== cls && (top[0] === 'flat' || top[0] === 'slice') && top[1] > (av[cls] || 0)) clsAlt = top[0];
    }
    // 重心の1ステップあたりの移動量の中央値（トレイルはボールと一緒に動く: 10〜60px/2コマ。選手・ラベル・看板は数px）
    const steps = []; for (let i = 1; i < fr.length; i++) steps.push(Math.hypot(fr[i].b.cx - fr[i - 1].b.cx, fr[i].b.cy - fr[i - 1].b.cy) / Math.max(1, Math.round((fr[i].t - fr[i - 1].t) * fps)));
    const spd = median(steps) || 0;
    // 出現直後の速さ（先頭 4 ステップの中央値）。砂 0911 p5 156.67 の自分のトップスピン（橙）は、トレイルが自分→相手コートの縦一本の筋として
    // 0.3 秒残るため重心が筋の中央で静止し、全期間の中央値 4.8 でゲート（6.5）に落ちた。出現直後の 3 ステップは 5.4/13.6/25 と速い。
    // 看板・テントの run は出現直後も数 px なので当たらない
    const spdEarly = median(steps.slice(0, 4)) || 0;
    // 動きと形の揃い（align）: コマ間の重心の移動（3px 以上）と、前のコマの blob の主軸（尾→先端）の |cos| の中央値。nAlign は数えた歩数。
    // トレイルは動きの筋なので筋は球の進む向きに伸び、重心も筋に沿って動く（手前の本物は 0.95〜1.00）。選手の体・SMASH 表示の文字は形の向きと動きが無関係
    // （2026-09-24 第 4 ラウンド nearjunk・samples/rally/exp-r4-nearjunk/feat2.txt: x0908 p17 435.17m マリオの赤い体 0.71・442.73o 0.65・429.47o SMASH 表示 0.22／
    //   x0911 p6 177.04m ヨッシーの靴 0.66／x151815 p9 216.24m デイジーの橙の体 0.55。手前（cZ0<0）の本物で 4 歩以上のものの最小は GT セットでは 0.85（x151815 p9 218.40・x0911 p6 178.40 0.89）、全体走まで含めると 0.77（shots の nearMisaligned の注記））
    const aligns = [];
    for (let i = 1; i < fr.length; i++) {
      const A = fr[i - 1].b, B = fr[i].b, dx = B.cx - A.cx, dy = B.cy - A.cy, d = Math.hypot(dx, dy);
      const ax = A.tip.x - A.tail.x, ay = A.tip.y - A.tail.y, L = Math.hypot(ax, ay);
      if (d < 3 || !L) continue;
      aligns.push(Math.abs(dx * ax + dy * ay) / (d * L));
    }
    const align = aligns.length ? median(aligns) : null;
    // 側は打点＝出現直後の尾の位置で決める（尾はボールと一緒に動くので全期間の多数決は駄目）
    // 側は「トレイルがどちらへ進むか」で決める（尾の位置は出現が遅れると動いてしまう）。
    // 重心の y が減る（画面上へ進む）＝自分の打球、増える＝相手の打球。動きが小さいときだけ尾の Z で補う
    const early = fr.slice(0, Math.min(fr.length, 4));
    const zEarly = median(early.map(f => f.b.tailZ));
    const first = fr[0].b, lastB = fr[fr.length - 1].b;
    let disp = 0; for (const f of fr) disp = Math.max(disp, Math.hypot(f.b.cx - first.cx, f.b.cy - first.cy));
    const k = Math.min(fr.length - 1, 8);
    const dy = fr[k].b.cy - first.cy;
    let dir = Math.abs(dy) >= 6 ? (dy < 0 ? 'up' : 'down') : null;
    // 先頭 8 コマの動きが弱い（|dy|<20）ときは run 全体の優勢方向（上向き移動量 vs 下向き移動量）で決める。
    // 相手のロブは頂点付近で 12 コマ漂って（dy=-6 で 'up'→自分側扱い）から 390px 降りてくる（0908b p4 192.2）
    let upSum = 0, downSum = 0;
    for (let i = 1; i < fr.length; i++) { const d = fr[i].b.cy - fr[i - 1].b.cy; if (d < 0) upSum -= d; else downSum += d; }
    if (Math.abs(dy) < 20 && Math.max(upSum, downSum) >= 20 && Math.max(upSum, downSum) >= 3 * Math.min(upSum, downSum)) dir = downSum > upSum ? 'down' : 'up';
    const side = dir ? (dir === 'up' ? 'me' : 'opp') : (zEarly > 0 ? 'opp' : 'me');
    return { t0, t1, n: fr.length, cls, clsAlt, votes, side, dir, dy: +dy.toFixed(1), disp: +disp.toFixed(1), spd: +spd.toFixed(1), spdEarly: +spdEarly.toFixed(1), dur: +(t1 - t0).toFixed(2), sMax: +sMax.toFixed(2), reanchored: r.reanchored || 0,
             provFrac: +provFrac.toFixed(2), straight: +yStraight.toFixed(2), cZpre,
             tail: { x: first.tail.x, y: first.tail.y, X: first.tailX, Z: first.tailZ },
             Htip: median(use.map(f => f.b.Htip).filter(v => v != null)),
             Htail: median(use.map(f => f.b.Htail).filter(v => v != null)),
             Smed: median(use.map(f => f.b.Smed).filter(v => v != null)),
             align: align == null ? null : +align.toFixed(3), nAlign: aligns.length,
             topHead: r.topHead != null ? r.topHead : null, topTail: r.topTail || null, topCut: r.topCut || 0, tailMoved: r.tailMoved || 0, trimPre: r.trimPre || 0, trimSuf: r.trimSuf || 0, camStatic: r.camStatic || 0, camTrim: r.camTrim || 0, farStay: r.farStay || 0,
             // nTape: 白帯の blob（netTapeBlob）のコマ数。shots の除外は nTape / n（丸める前の比）で比べる。tapeFrac は 2 桁に丸めた記録用（2026-09-24 exp-int3f・レビューの note:
             //   丸めてから ≥ 0.8 と比べると実質 0.795 で 39/49 も通っていた。76 ポイントでは丸め前 < 0.8・丸め後 ≥ 0.8 の run は 0 本＝出力は変わらない: exp-int3f/work/precheck.js）
             // courtH: コートの色相（courtRef の Hmed・run のコマの中央値）。芝 84〜86・砂 51〜55・クレイ 11・ハード 188〜205（v38 の全体走の trailLog）。shots の緑ガードの例外（淡い青スライス）に使う
             courtH: (() => { const hs = fr.map(f => f.cH).filter(v => v != null); return hs.length ? median(hs) : null; })(),
             // cZ0p: 先頭のコマが仮カメラ（prov）のときだけ、先頭 3 コマの cZ の中央値。サーブ画→ラリー画のズーム中は仮カメラの縮尺が合わず、先頭 1 コマの cZ だけが
             //   跳ぶことがある（芝ランクマ 15-18-15 p9 214.30 の自分のサーブ: cZ 16.79 → −0.71 → 0.97。shots の sideOk に落ちて、続く 214.95o・215.72m まで消えていた）
             nMax: Math.max(...fr.map(f => f.b.n)), cZ0: first.cZ, cZ0p: first.prov && fr.length >= 3 ? +median(fr.slice(0, 3).map(f => f.b.cZ)).toFixed(2) : null, nTape: fr.filter(f => f.b.tape).length, nTapeArea: fr.filter(f => f.b.tape).reduce((a, f) => a + f.b.n, 0), nArea: fr.reduce((a, f) => a + f.b.n, 0), nFlatW: fr.filter(f => flatWhite(f.b)).length, zMinAll: +Math.min(...fr.map(f => f.b.cZ)).toFixed(2), nRedBody: fr.filter(f => redBody(f.b)).length, tapeFrac: +(fr.filter(f => f.b.tape).length / fr.length).toFixed(2),
             frames: fr.map(f => ({ t: f.t, cx: f.b.cx, cy: f.b.cy, ty: f.b.tip.y, n: f.b.n, cls: f.b.cls, side: f.b.side })) };
  }

  // ---- ショット列の整形 ----
  //  1. 動かない run（チャージ中のキャラのオーラ・看板）を捨てる: 重心の最大変位 < MIN_DISP
  //  2. 短い run（< MIN_N コマ）を捨てる
  //  3. 同種別・同側で近接した run を1本に併合（ネットや選手で分断された同じトレイル）
  //  併合の種別は「色相の隣り合う族」まで許す（topspin/lob は先端の色相が流れて後半の断片が lob に化ける）。
  //  併合後の種別は最初の断片のもの（打点+4〜10コマの色が仕様上いちばん信用できる）。
  //  4. 進行方向が無い（|dy|<6）・重心速度が遅い（spd<6px/ステップ）・1秒を超えて続く run は選手／ラベル／看板
  // maxDur 1.3: 0908b ハード p0 の自分のサーブのトレイルが 1.07 秒続いて落ちた（選手・看板は直進度/速度/緑で別途落ちる）
  function shots(runsIn, { minDisp = 40, minN = 5, mergeGap = 0.45, tStart = -Infinity, minSpd = 6, maxDur = 2.0 } = {}) {   // 2.0: 相手のロブは頂点で 0.4 秒漂ってから 0.5 秒降りる（0908b p4 で 1.1〜1.5 秒）。選手・看板は居座り除外/直進度/速度で落ちる
    // 遠近: 奥コート(y≈100)のトレイルは手前の 0.7 倍ほど小さく遅い。しきい値を y でスケールする
    const scOf = r => Math.min(1.3, Math.max(0.5, (r.frames[0].cy + 325) / 625));
    // 側の整合: 自分の打球は手前(Z<0)から上へ、相手の打球は奥(Z>0)から下へ進む。尾の Z と進行方向が食い違う run は
    // トレイルではない（チャージ中のキャラのオーラが下へ伸びる等・0908 芝 58.5 で自分の打点を潰した）。ネット際(|Z|<2)は不問
    // 判定は出現時の重心の Z（尾は最初のコマで先端と取り違えることがある）。緩めに: 自分は Z<3・相手は Z>-3
    // 再アンカーした run は出現時の重心が先へ進んでいる（クレイ 327.27: Z=3.68 で本物のロブが落ちた）ので、切り離す前の先頭（cZpre）でも可
    // 閾値 5: 自分のトレイルはネット手前 Z=3.2 で出現することがある（15-18-15 p8 デイジーのスライス/フラット・3 だと落ちた）。オーラは選手の位置（|Z|≈8〜10）なので余裕がある
    // 先頭が仮カメラの run は先頭 3 コマの中央値（cZ0p）でも可（2026-09-30: 全 76 ポイントで効くのは 15-18-15 p9 の 1 本だけ・ベンチ/x/y/全体走の他は不変）
    const sideOk = r => r.cZ0 == null || (r.side === 'me' ? (r.cZ0 < 5 || r.cZpre < 5 || (r.cZ0p != null && r.cZ0p < 5)) : (r.cZ0 > -5 || r.cZpre > -5 || (r.cZ0p != null && r.cZ0p > -5)));
    // 速さは全期間の中央値か出現直後の中央値の速い方（縦一本の筋として残るトレイルは重心が途中で止まる・summarize の spdEarly 参照）
    const spdOf = r => Math.max(r.spd, r.spdEarly || 0);
    // コマ数の下限 5 は、速く（ゲートの 2 倍以上）まっすぐ（0.95 以上）大きく（nMax 1000 以上）動く 4 コマの断片だけ 4 に緩める
    // （砂 0911 p5 158.8 相手のトップスピンは 0.3 秒で自分側へ届き、追跡の途切れで 4 コマ×2 本に割れた: nMax 1303/2758・spd 12.5/20.3・直進度 1）
    // 相手側だけ（自分側の 4 コマ断片はチャージの閃光: 芝 15-18-15 p8 208.47 nMax 5539・直進度 1・spd 16.8 が 0.3 秒早い偽打点になり同側補完まで誘発した）
    const minNOf = (r, sc) => (r.side === 'opp' && spdOf(r) >= 2 * minSpd * sc && r.straight >= 0.95 && r.nMax >= 1000) ? Math.min(minN, 4) : minN;
    // 入れなかった（2026-09-24 misses の変更 3・第 3 ラウンドの反証役が止めた）: 自分側で遠く（150px×遠近）までまっすぐ（直進度 0.9 以上）速く（ゲートの 2 倍以上）・nMax 1500 以上・
    // elong の中央値 2.6 以上の run を緑ガード（下）の例外にする案（ハード 0908b p4 190.03 のボレーの橙・p5 234.37 のサーブの紫はヨッシーの緑が筋の端に入って落ちる）。
    // 変更 1 と組んだときの効き（exp-misses-verify のアブレーション）はベンチで x0908b 22→23 T12→14・x151815 22→23、全体走で 104.58m→104.30m・191.30m→190.00m＋190.55o・
    // +234.34m・+297.63o・+225.24m（sfno3）。例外の閾値（直進度・速さ・nMax・elong）が手置きで、ネット際を奥へ走るヨッシー（直進 0.94・速さ 14）との境が近い
    // 緑ガードの例外（2026-09-23 第 4 ラウンド color レーン・x セット診断の GREENSLICE を絞ったもの）: 半透明の青いスライスの筋は、緑の芝・黄の砂の上では
    //   コートの色と混ざって片端が青緑（色相 130〜139）に寄り、緑ガードに掛かって打点ごと消えていた（芝ランクマ 15-18-15 p10 225.27 の自分のサーブ H 195/133・
    //   p12 246.27 の相手のサーブ H 137/162／砂 0908 p17 441.57 の自分のスライス H 217/138）。混ざって青緑になるのはコートが黄〜緑（courtH 40〜100:
    //   芝 84〜86・砂 51〜55）のときだけで、青いハード（188〜205）・赤いクレイ（11）の上では起きない。
    //   選手の緑は色相 95〜123（v38 の全体走で緑ガードだけに落ちる run: 砂 0911 のヨッシー 99〜112・砂 0908 p19 のルイージ 102〜114・ハード 0908b p3 133.13 のヨッシー 123）なので、
    //   緑側の端が 125 以上（青緑）で、もう一方の端が青（155〜250）の slice だけを通す。ヨッシーの緑と青スライスが混ざった blob（ハード 0908b p3: H 123/212）は通らない
    //   青側の下限は 155（2026-09-25 統合 exp-int4 で 140 から上げた）: 通したい実例の青側の端は 162〜217（15-18-15 p10 225.27m 195・p12 246.27o 162・砂 0908 p17 441.57m 217・
    //   全体走 0908 p1 77.63m 169）で、140〜154 の端を持つ実例は無い。140 だと両端とも青緑の blob（全体走 15-18-15 p13 262.27o H 139/140: 片端 140 が青の門・もう片端 139 が緑側の門を通る）が
    //   例外に入る。青緑の端（133〜140）と青の端（162〜）の間を切る値で、境の実例は 140（通さない）と 162（通す）
    const tealSlice = r => r.cls === 'slice' && r.courtH != null && r.courtH >= 40 && r.courtH < 100
      && ((r.Htail != null && r.Htail >= 155 && r.Htail < 250) || (r.Htip != null && r.Htip >= 155 && r.Htip < 250))
      && [r.Htail, r.Htip].every(h => h == null || h < 80 || h >= 125);
    // 手前（出現の重心が自分のコート cZ0<0）で、動きが形の向きに沿わない run は選手の体・SMASH 表示（summarize の align）。側は問わない（手前に出る相手側の run も同じ物: x0908 p17 442.73o）。
    // 4 歩以上のときだけ（3 歩の本物 0908 p8 225.90 が 0.63）。閾値 0.75 の両側（2026-09-25 統合 exp-int4 の検証で測り直した値・レーンの LOG の「本物の最小 0.85」は GT セットだけの値）:
    //   本物（4 歩以上・手前）の最小は全体走まで含めると 0.77（ハード 0908b p7 291.50m 0.772・クレイ 0908 p13 343.62o 0.794・次が x151815 p9 218.40 0.85）、
    //   junk の最大は 0.737（全体走 0908b 187.80o の体）・0.725（全体走 0908 520.033o）・0.71（x0908 435.17m）。余裕は 0.75 の上下に 0.02〜0.035 しか無い（例が増えたら真っ先に崩れる境）
    // 効き（第 4 ラウンドの全体走 47 ポイント・+12 −33 の内訳）: align 25・redBody 9・flatWhite 6・奥の上端（zMinAll）6。レーンの LOG が x0908b の T+1（187.77→187.87）を flatWhite の効きと書いているのは誤りで、
    //   187.80o の体の run（align 0.737）が落ちたことによる（align の効き）
    // cZ0 ≤ −14.5 は外す: 手前の柵の run は fuse がカメラの引き（isPull: c0.y ≥ 490・cZ0 ≤ −14.5）＝ポイント終了の印に使う（x0911 p4 148.90 の柵を捨てると tPull が消えて 148.17m の偽打点が戻った）
    // 副作用（第 4 ラウンドの全体走の目視・exp-r4-nearjunk/VERIFY.txt）: junk の run が同側の対を作って空白補完で入っていた本物に近い打点を失うことがある
    //   （全体走 0908 p7 185.87m・x0908 p17 431.28o・0911 p6 176.85o・p9 225.74o・全体走 0908 519.70o）
    const nearMisaligned = r => r.align != null && r.nAlign >= 4 && r.cZ0 != null && r.cZ0 < 0 && r.cZ0 > -14.5 && r.align < 0.75;
    const keep = runsIn.filter(r => { const sc = scOf(r); return r.disp >= minDisp * sc && r.n >= minNOf(r, sc) && r.t0 >= tStart + 0.3 && r.dir && spdOf(r) >= minSpd * sc && r.dur <= maxDur
                                       && sideOk(r)
                                       && !r.camStatic                    // カメラと一緒に動くだけの静止物（砂の観客席・テント）
                                       && !r.farStay                      // run 全体で補正後の重心 y が動かない大きい静止物（砂のテント・summarize 参照）
                                       && !(r.cls === 'drop' && (r.nTape != null ? r.nTape / r.n : r.tapeFrac) >= 0.8)   // 8 割以上のコマが白帯の blob（netTapeBlob）の白い run（芝ランクマ 15-18-15 p8 204.47: 7/7）。丸める前の比（nTape が無い古い run だけ tapeFrac）
                                       // 面積でも見る（2026-09-24 第 4 ラウンド regress）: サーブ画→ラリー画のズーム中は白帯が帯（netNear）の切りで欠けて小さな切れ端（elong 3.5・n 220〜530）に割れ、
                                       // 白帯の形（netTapeBlob）に当たらないコマが混ざる。芝ランクマ 15-18-15 p12 244.93〜245.57 の run はコマ数で 8/13＝0.62 だが面積で 0.85 が白帯
                                       // （白帯の blob 1014〜1353 に対して切れ端 239/532/463/261/220）で、偽の相手の打点 244.90o になり、サーブ 245.67o と同じ側に並んで間に自分の track 245.24m を呼んだ。
                                       // 閾値はコマ数と同じ 0.8。v38＋段 3 の 67 ポイントで白帯の blob を含む shots（23 本・scr なし・LOG の表）のうち面積 0.8 以上は 244.93 と 151815 p9 216.53（打点にならない）の 2 本、
                                       // 打点になっている本物の白い筋（0908 p7 185.90m 0.68・マリオの白い返球 186.10）は 0.8 未満
                                       && !(r.cls === 'drop' && r.nArea > 0 && r.nTapeArea / r.nArea >= 0.8)
                                       && !nearMisaligned(r)
                                       && !(r.nRedBody != null && 2 * r.nRedBody >= r.n && r.cZ0 != null && r.cZ0 < 2)   // 半分以上のコマが赤い体（redBody）の手前の run。奥は blob が小さく n<1000 が「小さい」の意味を持たない（奥の本物の筋は n 250〜1000）ので手前（cZ0<2）だけ
                                       // 奥の上端の淡い背景（砂のテント・柵・観客席）: 相手側の白い（drop）run が全コマ Z ≥ 19（奥ベースライン 11.9m の 7m 後ろ）から出てこない。
                                       // 白い球の筋は低い（ロブの黄と違って高さで Z が膨らまない）ので、打った相手（ベースラインの 3m 後ろまで）より奥には居ない
                                       // （2026-09-24 第 4 ラウンド nearjunk・exp-r4-nearjunk/tiltscan.js: 全セットで該当 5 本、rally に入っていた 3 本は映像で全部 junk:
                                       //   x0911 p6 171.24o・174.00o（自分のロブを追ってカメラが上へ振れ、上端の背景が流れ込む）・s0911 p9 205.94o（MATCH POINT 表示中のサーブ前・img/v_11_205.png）。
                                       //   相手の本物の白い打点は 172.24o の zMin 4.1 など Z<16 に入る）
                                       && !(r.side === 'opp' && r.cls === 'drop' && r.zMinAll != null && r.zMinAll >= 19)
                                       && !(r.cls === 'drop' && r.nFlatW != null && 2 * r.nFlatW >= r.n)   // 半分以上のコマが横に細長い白（flatWhite）の白い run は線（白帯の高さに限らない）
                                       && !(r.provFrac >= 0.8)          // 仮カメラのズーム中だけの run（0908 芝 52.37: サーブ画の blob が"相手の打点"になった）
                                       && !(r.side === 'me' && r.nMax < 500)   // 手前（自分側）のトレイルは大きく映る（GT の自分の打点は全部 600 以上・本物のドロップ 1024〜4383）。ヨッシーの白い切れ端 319 を落とす
                                       && !(r.straight != null && r.straight < 0.6)   // y が往復する run は走る選手（0908 クレイ 227.93 マリオ 0.14・本物は 0.85 以上）
                                       // 尾か先端が緑（80〜140°）＝選手が混ざった blob（0908b ヨッシー: 赤い甲羅で topspin 判定・先端 101°）。ショット色に緑は無い（ロブの先端は 66° まで）
                                       && !(((r.Htail != null && r.Htail >= 80 && r.Htail < 140) || (r.Htip != null && r.Htip >= 80 && r.Htip < 140)) && !tealSlice(r))
                                       && !(r.cls === 'unknown' && r.Smed != null && r.Smed >= 0.4); }).sort((a, b) => a.t0 - b.t0);   // 有彩色なのに種別が無い＝選手（緑のルイージ等）
    const out = [];
    for (const r of keep) {
      const last = out[out.length - 1];
      const fam = (a, b) => FAMILY[a] === FAMILY[b] || FAMILY[a] === 'any' || FAMILY[b] === 'any';
      // 併合の空間的な連続性（診断用に記録・先行断片の最後の重心と後続断片の最初の重心の距離）
      const endF = last && last._end, stF = r.frames[0];
      const jump = endF ? +Math.hypot(stF.cx - endF.cx, stF.cy - endF.cy).toFixed(0) : null;
      // 併合の鎖が次の打球を呑まない（2026-09-24 第 4 ラウンド regress）: 先行 shot の nMax の半分未満の小さい断片を併合しても t1 は延びるが「本体」の終わり（coreT1）は延ばさない。
      // 後続が本体より大きい（nMax 2 倍以上＝新しい筋）のに本体の終わりから mergeGap より離れているなら、小さい断片の鎖で繋がっているだけなので併合しない
      // （砂 0911 p9: 相手の run 212.37〜213.23（nMax 851）に 212.9〜213.70 の断片 4 本（118〜367）が繋がり、0.03 秒後に始まる次の打球 213.73（nMax 2526）まで 1 本になって、
      //  打点 213.68o が消え 213.85o に遅れた。v37 では白帯の drop の run が間に挟まって鎖が切れていた（変更 2 がそれを除いた）。
      //  大きさの条件なしで本体から測ると、切れ端が独立の打点になって全体走で +11 本増えた（LOG 段 7））
      //  この条件（nMax 2 倍以上・本体から mergeGap 超）で切れる併合は全データで 1 例（0911 p9 213.73・比 3。exp-r4-regress-verify/VERIFY.txt）
      const coreT1 = last ? (last.coreT1 != null ? last.coreT1 : last.t1) : null;
      // 同じ大きさの条件で場所も見る（2026-09-25 統合 exp-int4・段 6 の相殺を直す）: 後続が本体より大きい（nMax 2 倍以上）のに、先行の最後の重心から 250px 以上離れた所で始まるなら別の物
      //   （x0908 p17: 自分の slice の run 441.567〜443.400 が画面上端 (645,19) に張り付いたまま、その同じコマに次の打球の筋 443.400（nMax 6362・GT 443.17m）が (399,241) に立った＝331px。
      //    段 5 までは間に 442.933 の体の run が挟まって鎖が切れていたが、nearjunk の redBody/align がそれを落として 1 本に呑まれた）。
      //   後続が大きい併合は 9 セットで 6 本しか無く、飛びは 331（この本物）・305（x0911 p6 173.87o: 奥の背景の切れ端どうし・GT 無し）・202（x151815 p12 248.27o: 同じコマで始まる白い切れ端 174→1272）、残り 3 本は 40 以下。
      //   250 は 202 と 305 の間。トレイルの筋そのものは 200px を超えない（後続が小さい併合の中央値 160・それは切れ端や体の吸収で場所の意味が薄い）
      //   副作用（2026-09-29 exp-int4-survey/VERIFY.txt）: GT の無い全体走で 7 回発火し、悪くなったのが 2 回（s0908b p11 373.47 の必殺ショットの演出で側が反転 など）。暫定の値
      if (last && fam(last.cls, r.cls) && (last.dir === r.dir || !r.dir || !last.dir) && r.t0 - last.t1 <= mergeGap
          && !(r.nMax >= 2 * last.nMax && r.t0 - coreT1 > mergeGap)
          && !(r.nMax >= 2 * last.nMax && jump != null && jump >= 250)) {
        (last.mergeLog = last.mergeLog || []).push({ t0: r.t0, gap: +(r.t0 - last.t1).toFixed(2), jump, nMax: r.nMax, cls: r.cls });
        last._end = r.frames[r.frames.length - 1];
        // 先行断片が「4コマ以上あるのに後続の 1/5 未満」ならチャージ中のオーラ（0908 クレイ 225.4: nMax 834 → 本物 13343、
        // 砂 413.7: 723 → 7688）。時刻・種別・側などは後続（本物のトレイル）のものにする。本物が途中で切れた断片は 1〜2 コマ目で
        // 育ちきっているので 5 倍差にはならない（芝 56.267 で最大 4.6 倍）
        const t1 = Math.max(last.t1, r.t1), n = last.n + r.n, merged = (last.merged || 1) + 1;
        const small = r.nMax < 0.5 * last.nMax;
        if (last.n >= 4 && r.nMax >= 5 * last.nMax) Object.assign(last, r, { t1, n, merged, auraT0: last.auraT0 != null ? last.auraT0 : last.t0, coreT1: r.t1 });
        else { last.t1 = t1; last.n = n; last.nMax = Math.max(last.nMax, r.nMax); last.merged = merged; last.coreT1 = small ? coreT1 : Math.max(coreT1, r.t1); }
        continue;
      }
      out.push(Object.assign({}, r, { _end: r.frames[r.frames.length - 1] }));
    }
    for (const s of out) { delete s._end; delete s.coreT1; }
    // 色の混ざりを直した種別（summarize の clsAlt: flatTail・clayBlue）は併合の後で付ける: 併合の族（topspin と同族で繋ぐ）は v38 のまま。先に flat にすると、赤い尾の run が
    //   吸っていた小さい junk の run（砂 0911 p1 49.50: 画面上端のパックンの頭）が取り残されて偽の打点になった（exp-r4-color/LOG [4]）
    for (const s of out) if (s.clsAlt && s.clsAlt !== s.cls) { s.clsRaw = s.cls; s.cls = s.clsAlt; }
    return out;
  }

  return { W, H, SC, hsv, hueDist, courtRef, effectMask, detect, runs, shots, classify, HUD_EXCL, netTapeBlob, _region: region, _closing: closing, _components: components, _buildLineNear: buildLineNear };
})();
