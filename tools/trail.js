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
    return done.map(r => summarize(r, fps, yFarAt));
  }

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
    // 重心の1ステップあたりの移動量の中央値（トレイルはボールと一緒に動く: 10〜60px/2コマ。選手・ラベル・看板は数px）
    const steps = []; for (let i = 1; i < fr.length; i++) steps.push(Math.hypot(fr[i].b.cx - fr[i - 1].b.cx, fr[i].b.cy - fr[i - 1].b.cy) / Math.max(1, Math.round((fr[i].t - fr[i - 1].t) * fps)));
    const spd = median(steps) || 0;
    // 出現直後の速さ（先頭 4 ステップの中央値）。砂 0911 p5 156.67 の自分のトップスピン（橙）は、トレイルが自分→相手コートの縦一本の筋として
    // 0.3 秒残るため重心が筋の中央で静止し、全期間の中央値 4.8 でゲート（6.5）に落ちた。出現直後の 3 ステップは 5.4/13.6/25 と速い。
    // 看板・テントの run は出現直後も数 px なので当たらない
    const spdEarly = median(steps.slice(0, 4)) || 0;
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
    return { t0, t1, n: fr.length, cls, votes, side, dir, dy: +dy.toFixed(1), disp: +disp.toFixed(1), spd: +spd.toFixed(1), spdEarly: +spdEarly.toFixed(1), dur: +(t1 - t0).toFixed(2), sMax: +sMax.toFixed(2), reanchored: r.reanchored || 0,
             provFrac: +provFrac.toFixed(2), straight: +yStraight.toFixed(2), cZpre,
             tail: { x: first.tail.x, y: first.tail.y, X: first.tailX, Z: first.tailZ },
             Htip: median(use.map(f => f.b.Htip).filter(v => v != null)),
             Htail: median(use.map(f => f.b.Htail).filter(v => v != null)),
             Smed: median(use.map(f => f.b.Smed).filter(v => v != null)),
             trimPre: r.trimPre || 0, trimSuf: r.trimSuf || 0, camStatic: r.camStatic || 0, camTrim: r.camTrim || 0, farStay: r.farStay || 0,
             // nTape: 白帯の blob（netTapeBlob）のコマ数。shots の除外は nTape / n（丸める前の比）で比べる。tapeFrac は 2 桁に丸めた記録用（2026-09-24 exp-int3f・レビューの note:
             //   丸めてから ≥ 0.8 と比べると実質 0.795 で 39/49 も通っていた。76 ポイントでは丸め前 < 0.8・丸め後 ≥ 0.8 の run は 0 本＝出力は変わらない: exp-int3f/work/precheck.js）
             nMax: Math.max(...fr.map(f => f.b.n)), cZ0: first.cZ, nTape: fr.filter(f => f.b.tape).length, tapeFrac: +(fr.filter(f => f.b.tape).length / fr.length).toFixed(2),
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
    const sideOk = r => r.cZ0 == null || (r.side === 'me' ? (r.cZ0 < 5 || r.cZpre < 5) : (r.cZ0 > -5 || r.cZpre > -5));
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
    const keep = runsIn.filter(r => { const sc = scOf(r); return r.disp >= minDisp * sc && r.n >= minNOf(r, sc) && r.t0 >= tStart + 0.3 && r.dir && spdOf(r) >= minSpd * sc && r.dur <= maxDur
                                       && sideOk(r)
                                       && !r.camStatic                    // カメラと一緒に動くだけの静止物（砂の観客席・テント）
                                       && !r.farStay                      // run 全体で補正後の重心 y が動かない大きい静止物（砂のテント・summarize 参照）
                                       && !(r.cls === 'drop' && (r.nTape != null ? r.nTape / r.n : r.tapeFrac) >= 0.8)   // 8 割以上のコマが白帯の blob（netTapeBlob）の白い run（芝ランクマ 15-18-15 p8 204.47: 7/7）。丸める前の比（nTape が無い古い run だけ tapeFrac）
                                       && !(r.provFrac >= 0.8)          // 仮カメラのズーム中だけの run（0908 芝 52.37: サーブ画の blob が"相手の打点"になった）
                                       && !(r.side === 'me' && r.nMax < 500)   // 手前（自分側）のトレイルは大きく映る（GT の自分の打点は全部 600 以上・本物のドロップ 1024〜4383）。ヨッシーの白い切れ端 319 を落とす
                                       && !(r.straight != null && r.straight < 0.6)   // y が往復する run は走る選手（0908 クレイ 227.93 マリオ 0.14・本物は 0.85 以上）
                                       // 尾か先端が緑（80〜140°）＝選手が混ざった blob（0908b ヨッシー: 赤い甲羅で topspin 判定・先端 101°）。ショット色に緑は無い（ロブの先端は 66° まで）
                                       && !((r.Htail != null && r.Htail >= 80 && r.Htail < 140) || (r.Htip != null && r.Htip >= 80 && r.Htip < 140))
                                       && !(r.cls === 'unknown' && r.Smed != null && r.Smed >= 0.4); }).sort((a, b) => a.t0 - b.t0);   // 有彩色なのに種別が無い＝選手（緑のルイージ等）
    const out = [];
    for (const r of keep) {
      const last = out[out.length - 1];
      const fam = (a, b) => FAMILY[a] === FAMILY[b] || FAMILY[a] === 'any' || FAMILY[b] === 'any';
      // 併合の空間的な連続性（診断用に記録・先行断片の最後の重心と後続断片の最初の重心の距離）
      const endF = last && last._end, stF = r.frames[0];
      const jump = endF ? +Math.hypot(stF.cx - endF.cx, stF.cy - endF.cy).toFixed(0) : null;
      if (last && fam(last.cls, r.cls) && (last.dir === r.dir || !r.dir || !last.dir) && r.t0 - last.t1 <= mergeGap) {
        (last.mergeLog = last.mergeLog || []).push({ t0: r.t0, gap: +(r.t0 - last.t1).toFixed(2), jump, nMax: r.nMax, cls: r.cls });
        last._end = r.frames[r.frames.length - 1];
        // 先行断片が「4コマ以上あるのに後続の 1/5 未満」ならチャージ中のオーラ（0908 クレイ 225.4: nMax 834 → 本物 13343、
        // 砂 413.7: 723 → 7688）。時刻・種別・側などは後続（本物のトレイル）のものにする。本物が途中で切れた断片は 1〜2 コマ目で
        // 育ちきっているので 5 倍差にはならない（芝 56.267 で最大 4.6 倍）
        const t1 = Math.max(last.t1, r.t1), n = last.n + r.n, merged = (last.merged || 1) + 1;
        if (last.n >= 4 && r.nMax >= 5 * last.nMax) Object.assign(last, r, { t1, n, merged, auraT0: last.auraT0 != null ? last.auraT0 : last.t0 });
        else { last.t1 = t1; last.n = n; last.nMax = Math.max(last.nMax, r.nMax); last.merged = merged; }
        continue;
      }
      out.push(Object.assign({}, r, { _end: r.frames[r.frames.length - 1] }));
    }
    for (const s of out) delete s._end;
    return out;
  }

  return { W, H, SC, hsv, hueDist, courtRef, effectMask, detect, runs, shots, classify, HUD_EXCL, netTapeBlob, _region: region, _closing: closing, _components: components, _buildLineNear: buildLineNear };
})();
