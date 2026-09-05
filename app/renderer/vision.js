// SENSEKI SCAN 共有ビジョンライブラリ（ブラウザ用・依存なし）
// 座標はすべて 1920x1080 基準。cropRegion が「ゲーム画面の矩形」(setSourceRect・既定は全画面)に合わせて自動スケール。
window.Vision = (() => {
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // ---- 認識領域（FHD基準） ----
  const REGIONS = {
    // VS画面
    court:   { x: 35,   y: 28,  w: 460, h: 70 },
    myname:  { x: 280,  y: 895, w: 360, h: 85 },
    oppname: { x: 1255, y: 895, w: 410, h: 85 },
    myicon:  { x: 700,  y: 898, w: 90,  h: 88 },
    oppicon: { x: 1148, y: 898, w: 90,  h: 88 },
    // レートパネル
    mode1:   { x: 655,  y: 295, w: 205, h: 60 },  // シングルス/ダブルス
    mode2:   { x: 1000, y: 298, w: 285, h: 50 },  // フィーバーラケット あり/なし
    rating:  { x: 1040, y: 548, w: 235, h: 70 },
    ranking: { x: 1055, y: 448, w: 165, h: 75 }, // 「位」は含めない（漢字が2分割されるため）
    // Winner画面 スコアパネル（digit幅はパネル右端まで。広げると背景の砂を拾う）
    w1icon:  { x: 1480, y: 795, w: 75, h: 75 },
    w1digit: { x: 1598, y: 783, w: 100, h: 100 },
    w2icon:  { x: 1480, y: 890, w: 75, h: 75 },
    w2digit: { x: 1598, y: 882, w: 100, h: 98 },
    // ダブルスのWinnerパネル（行にアイコン2個・スコア枠が左寄り＆小さい。1440p実戦で実測:
    // 黄色枠 x1582-1661 / 行1 y818-876 / 行2 y910-967。シングルス領域とは半分しか重ならず
    // locateWinnerが取り逃す実例があった — docs/csv-accuracy-1440p-doubles.md）。
    // 領域は枠の「内側」に絞ること: 枠外の濃紺パネルが inkonyellow マスクに入ると数字と融合して読めない
    dw1digit: { x: 1585, y: 821, w: 73, h: 53 },
    dw2digit: { x: 1585, y: 913, w: 73, h: 52 },
    // ダブルスVS画面（左列=自分チーム2行・右列=相手2行。行の上下は試合ごとに変わる）
    dNameL1: { x: 277,  y: 852, w: 370, h: 64 },
    dNameL2: { x: 277,  y: 926, w: 370, h: 64 },
    dNameR1: { x: 1268, y: 852, w: 370, h: 64 },
    dNameR2: { x: 1268, y: 926, w: 370, h: 64 },
    dIconL1: { x: 690,  y: 852, w: 118, h: 64 },
    dIconL2: { x: 690,  y: 926, w: 118, h: 64 },
    dIconR1: { x: 1125, y: 852, w: 118, h: 64 },
    dIconR2: { x: 1125, y: 926, w: 118, h: 64 },
    // フィーバー: FVゲージ（発動で空になる→撃った側の判定に使う）と発動バナーの探索帯
    fvL: { x: 305,  y: 72, w: 160, h: 20 },
    fvR: { x: 1540, y: 72, w: 160, h: 20 },
    bannerBand: { x: 0, y: 690, w: 1920, h: 320 },
    // 回線品質アイコン（4本バー・対戦全体で1つ）。クラシック=画面左上／フィーバー=左上HPバーの右
    // （2026-08-28実測: クラシックはFHD x43-80,y25-70・フィーバーは x373-415,y30-75・やや斜め）
    connClassic: { x: 36, y: 16, w: 54, h: 60 },
    connFever:   { x: 366, y: 24, w: 56, h: 58 },
    // Switch(2)本体のアルバム再生バーの凡例帯（「+全画面表示 Y再生 X消去 Bもどる Aメニュー」）。
    // 録画中にホーム→アルバムで過去のスクショ/動画を見返すと、ゲーム映像がほぼ全面に再生され、
    // 中にVS/勝敗/レートパネルが写るとスキャンが誤爆する。凡例は固定UIなので白chテンプレ照合で判定できる
    // （実測: バー表示中 nccWh 0.995〜0.998 / ライブ全画面 ≤0.06・レート待機画面の誤爆候補でも ≤0.61）。
    albumBar: { x: 880, y: 1004, w: 900, h: 38 },
  };

  // シーク後に「新しいフレームが実際に取得できた」ことまで保証するシーカー。
  // seekedだけ待つと、長時間のシーク連打でフレームが更新されなくなる不具合を踏む。
  // 対策: rVFC(発火すれば即) + 短いフォールバック + フレームハッシュ監視。
  // 異なる時刻へのシークでハッシュが3回連続同一ならステイルと判断し、srcを再設定して復旧する。
  function makeSeeker(video) {
    let lastHash = null, sameCount = 0;
    const tiny = () => {
      const c = document.createElement('canvas'); c.width = 48; c.height = 27;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 48, 27);
      const d = ctx.getImageData(0, 0, 48, 27).data;
      let s = 0; for (let i = 0; i < d.length; i += 16) s = (s * 31 + d[i]) % 1000000007;
      return s;
    };
    // seeked直後のdrawImageは新フレームを返す（実測）。稀に起きる持続的なステイルは下のハッシュ監視で復旧
    const rawSeek = t => new Promise(res => {
      video.addEventListener('seeked', () => res(), { once: true });
      video.currentTime = t;
    });
    return async t => {
      await rawSeek(t);
      let h = tiny();
      if (h === lastHash) {
        if (++sameCount >= 3) {
          // 静止画面かステイルかを判別: 離れた時刻にプローブして絵が変わるか見る
          const probeT = Math.max(0.2, Math.min(video.duration - 1, t > video.duration / 2 ? t - 37 : t + 37));
          await rawSeek(probeT);
          if (tiny() === h) {
            // 別時刻でも同じ絵 → 本当にステイル → src再設定で復旧
            video.src = video.currentSrc;
            await new Promise(r => video.addEventListener('loadedmetadata', r, { once: true }));
          }
          await rawSeek(t);
          h = tiny();
          sameCount = 0;
        }
      } else sameCount = 0;
      lastHash = h;
    };
  }

  // ---- ゲーム画面の位置（配信レイアウト対応・2026-09-01） ----
  // 配信録画ではゲームが画面いっぱいとは限らない（枠・カメラ・チャットが同居する）。
  // 「フレームのどこがゲーム画面か」を割合(0〜1)で持ち、切り出しは全部ここを通す。
  // 割合で持つ理由: 同じOBSレイアウトなら1080p録画でも1440p録画でも同じ値が使える。
  // null = 全画面（既定・従来どおり）
  let SRC = null;
  function setSourceRect(r) {
    SRC = (r && r.rw > 0 && r.rh > 0 && (r.rx !== 0 || r.ry !== 0 || r.rw !== 1 || r.rh !== 1))
      ? { rx: r.rx, ry: r.ry, rw: r.rw, rh: r.rh } : null;
  }
  function getSourceRect() { return SRC; }
  // 実ピクセルのゲーム画面矩形
  function srcRect(video) {
    const W = video.videoWidth, H = video.videoHeight;
    if (!SRC) return { x: 0, y: 0, w: W, h: H };
    return { x: Math.round(SRC.rx * W), y: Math.round(SRC.ry * H), w: Math.round(SRC.rw * W), h: Math.round(SRC.rh * H) };
  }

  function frameToData(video, w, h) {
    const s = srcRect(video);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, s.x, s.y, s.w, s.h, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function cropRegion(video, r) {
    const s = srcRect(video);
    // 縦横は別係数（ゲーム画面が16:9ぴったりでない指定でも破綻させない）
    const kx = s.w / 1920, ky = s.h / 1080;
    const c = document.createElement('canvas');
    c.width = r.w; c.height = r.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, s.x + r.x * kx, s.y + r.y * ky, r.w * kx, r.h * ky, 0, 0, r.w, r.h);
    return ctx.getImageData(0, 0, r.w, r.h);
  }

  function frac(img, x0, y0, x1, y1, test) {
    const { data, width } = img;
    let n = 0, hit = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      n++;
      if (test(data[i], data[i + 1], data[i + 2])) hit++;
    }
    return n ? hit / n : 0;
  }

  const isDark = (r, g, b) => lum(r, g, b) < 55;
  const isWhite = (r, g, b) => lum(r, g, b) > 210;
  const isPanelPink = (r, g, b) => lum(r, g, b) > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 70;
  const isOlive = (r, g, b) => { const L = lum(r, g, b); return L > 35 && L < 115 && Math.max(r, g, b) - Math.min(r, g, b) < 60; };
  // 純度の高い黄色のみ（日陰の砂 (180,160,110) を誤検出しないよう b と彩度を絞る）
  const isYellow = (r, g, b) => r > 200 && g > 170 && b < 95;

  // 192x108 の縮小フレームでシーン分類
  // VS判定: 自分カードの青 + 相手カードのオレンジ + 中央の白いVSロゴ
  // （ゲーム間バナーも青+オレンジだが中央が白くないので除外される）
  const isBlue = (r, g, b) => b > r + 40 && b > 120;
  const isOrange = (r, g, b) => r > 160 && b < 100 && g > 40 && g < 170;
  function classify(img) {
    // orange閾値は0.10（キャラのドアップ演出が右カードに被り0.14まで下がった実例あり。負例は0付近）。
    // ただし茶色系キャラ（ドンキーコング等）のアイコンがカードを覆うと 0.043 まで下がる実例が出た
    // （720p クラシック実戦・docs/csv-accuracy-720p-classic.md）。
    // その救済として「左右の黒い名前帯」を補助条件にする。長い相手名は白文字で黒を薄めるため右帯の閾値は0.28。
    // 4動画（720p x2 / 1080p x2）で偽陽性ゼロを確認済み。
    if (frac(img, 67, 91, 78, 98, isBlue) > 0.15 && frac(img, 90, 89, 103, 100, isWhite) > 0.25) {
      const orange = frac(img, 111, 90, 124, 99, isOrange);
      const darkBand = (x0, x1) => frac(img, x0, 91, x1, 98, (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < 60);
      if (orange > 0.10 || (orange > 0.02 && darkBand(16, 60) > 0.45 && darkBand(132, 176) > 0.28)) return 'vs';
    }
    // winner: 黄色ハイライト(勝者行は上下どちらもありうるので両行域) + パネル色。
    // シングルスのパネルはオリーブ系半透明、ダブルスは濃紺(実測 fdark 0.74〜0.82・olive 0.09〜0.2)なので
    // 「オリーブ or 暗い」の複合条件にする。黄色条件が主弁別器（試合中の負例40フレームで黄色frac最大0）
    if (frac(img, 160, 78, 176, 98, isYellow) > 0.06) {
      if (frac(img, 148, 77, 173, 98, isOlive) > 0.25) return 'winner';
      if (frac(img, 148, 77, 173, 98, (r, g, b) => lum(r, g, b) < 90) > 0.5) return 'winner';
    }
    // レートパネルの色は「ランク」で変わる（S+=ピンク系・A+=金・B以下は未収穫）。
    // 色非依存の構造検出は砂コートのネット影が誤反応するためNG（検証済み）。
    // 新ランクのサンプルが来たらここに色ルールを1行追加する。
    // 取り逃しはanalyzer側の「VS数>試合数」警告で検知される。
    if (frac(img, 70, 32, 122, 62, isPanelPink) > 0.60) return 'rating';
    if (frac(img, 70, 32, 122, 62, (r, g, b) => r > 200 && g > 150 && b < 110) > 0.25) return 'rating';
    return 'other';
  }

  // ---- インクマスク ----
  // fillink: 縁取り文字の内側の白い塗り（レートパネル系。縁取り同士が接触しても塗りは孤立する）
  // darkink: 明るい背景に暗い縁取り文字
  // lightink: 暗い背景に明るい文字（Winnerパネル敗者側）
  // inkonyellow: 黄色ハイライト上の黒文字（Winnerパネル勝者側）
  const LOOSE = { p: 0.78, floor: 150, sat: 46 }; // fillink2 の緩和量(6.2Mbps実測でsat42以上が安全域)
  function mask(img, mode) {
    const { data, width, height } = img;
    const m = new Uint8Array(width * height);
    // fillink: 塗りの白は「クロップ内で最も明るい層」。暗い背景が透けるパネル（飛行船コート等）では
    // 全体が暗くなるため、固定215でなく輝度分布の上位から適応的に閾値を決める（180〜215にクランプ）
    // fillink2: ビットレートが低い録画では、塗りの白にコート色/パネル色がにじんで彩度が上がり、
    // 固定の彩度ガード(<15)と閾値では数字が丸ごと欠ける(6.2Mbps FHDで「3,271」の7が消え
    // 「321」=3桁になり棄却された実例・2026-08-31)。通常読みが失敗したときだけ使う緩和マスク
    let fillThr = 215, lightThr = 120;
    const loose = mode === 'fillink2';
    if (mode === 'fillink' || mode === 'fillink2' || mode === 'lightink') {
      const hist = new Uint32Array(256);
      for (let i = 0; i < width * height; i++) {
        hist[Math.min(255, lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) | 0)]++;
      }
      let acc = 0, p98 = 255;
      const cut = width * height * 0.02;
      for (let L = 255; L >= 0; L--) { acc += hist[L]; if (acc >= cut) { p98 = L; break; } }
      fillThr = loose ? Math.max(LOOSE.floor, Math.min(215, p98 * LOOSE.p))
                      : Math.max(180, Math.min(215, p98 * 0.92));
      // lightink: 数字(明るい層p98)と背景(中央値)の間に適応的に閾値を置く。
      // コート色が透けてパネル全体の明るさが変わる（クレイで数字上端が固定120を割る実例）
      let acc2 = 0, med = 128;
      const half = width * height * 0.5;
      for (let L = 0; L < 256; L++) { acc2 += hist[L]; if (acc2 >= half) { med = L; break; } }
      lightThr = Math.max(95, Math.min(150, med + (p98 - med) * 0.45));
    }
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const L = lum(r, g, b);
      if (mode === 'fillink' || mode === 'fillink2') m[i] = (L > fillThr && Math.max(r, g, b) - Math.min(r, g, b) < (loose ? LOOSE.sat : 15)) ? 1 : 0;
      else if (mode === 'darkink') m[i] = L < 150 ? 1 : 0;
      else if (mode === 'lightink') m[i] = L > lightThr ? 1 : 0;
      else if (mode === 'inkonyellow') m[i] = L < 110 ? 1 : 0;
    }
    return { m, w: width, h: height };
  }

  // レート/順位数字の分割パラメータ（fillinkマスク前提）
  // numeric: 数字/コンマの幾何条件に合わないグリフ（演出のキラキラ等）を捨てる
  const NUM_SEG = { minCol: 3, gapTol: 1, minW: 4, minH: 6, numeric: true };

  // 縦射影でグリフ分割
  function segment(mk, opts = {}) {
    const { m, w, h } = mk;
    const minCol = opts.minCol ?? Math.max(2, Math.round(h * 0.07)), gapTol = opts.gapTol ?? 0,
          minW = opts.minW ?? 3, minH = opts.minH ?? 8;
    const colInk = new Array(w).fill(0);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (m[y * w + x]) colInk[x]++;
    const boxes = [];
    let x = 0;
    while (x < w) {
      if (colInk[x] >= minCol) {
        let x1 = x, gap = 0, xe = x;
        while (xe < w && gap <= gapTol) {
          if (colInk[xe] >= minCol) { x1 = xe; gap = 0; } else gap++;
          xe++;
        }
        let y0 = h, y1 = 0;
        for (let yy = 0; yy < h; yy++) for (let xx = x; xx <= x1; xx++)
          if (m[yy * w + xx]) { if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
        if (x1 - x + 1 >= minW && y1 - y0 + 1 >= minH) boxes.push({ x0: x, x1, y0, y1 });
        x = x1 + 2;
      } else x++;
    }
    return boxes;
  }

  // 連結成分ベースの分割（数字読み用）。コンマが数字の懐に横位置で重なるケースは
  // 列射影では分離不能だが、塗り同士は連結していないのでCCなら分離できる
  function segmentCC(mk, opts = {}) {
    const { w, h } = mk;
    // 縦3px未満の薄い画素（パネル縁の細い水平線など）を除去してから連結成分を取る。
    // 細線がグリフ同士を橋渡しして1成分に融合するのを防ぐ
    const src = mk.m;
    const m = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (src[p] && src[p - w] && src[p + w]) m[p] = 1;
    }
    const seen = new Uint8Array(w * h);
    const boxes = [];
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!m[i] || seen[i]) continue;
      let area = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack.push(i); seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        const px = p % w, py = (p / w) | 0;
        area++;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const np = ny * w + nx;
          if (m[np] && !seen[np]) { seen[np] = 1; stack.push(np); }
        }
      }
      if (area >= (opts.minArea ?? 14)) boxes.push({ x0, x1, y0, y1 });
    }
    boxes.sort((a, b) => a.x0 - b.x0);
    // アンチエイリアスで千切れた同一グリフの断片をx重なりでマージ
    // （背の高い箱同士・小箱同士のみ。コンマが数字の懐にいても混ぜない）
    const merged = [];
    for (const b of boxes) {
      const last = merged[merged.length - 1];
      if (last) {
        const ov = Math.min(last.x1, b.x1) - Math.max(last.x0, b.x0) + 1;
        const minw = Math.min(last.x1 - last.x0, b.x1 - b.x0) + 1;
        const tallA = (last.y1 - last.y0 + 1) >= h * 0.5, tallB = (b.y1 - b.y0 + 1) >= h * 0.5;
        if (ov > minw * 0.55 && tallA === tallB) {
          last.x0 = Math.min(last.x0, b.x0); last.x1 = Math.max(last.x1, b.x1);
          last.y0 = Math.min(last.y0, b.y0); last.y1 = Math.max(last.y1, b.y1);
          continue;
        }
      }
      merged.push({ ...b });
    }
    return merged;
  }

  // 融合グリフ（例: 1と7の塗りが接触）を、中央付近のインク最小列で2つに割る
  function splitBoxAtValley(mk, box) {
    const { m, w } = mk;
    const col = [];
    for (let x = box.x0; x <= box.x1; x++) {
      let c = 0;
      for (let y = box.y0; y <= box.y1; y++) if (m[y * w + x]) c++;
      col.push(c);
    }
    const bw = col.length;
    if (bw < 12) return null;
    const lo = Math.floor(bw * 0.25), hi = Math.ceil(bw * 0.75);
    let best = -1, bestV = Infinity;
    for (let i = lo; i <= hi; i++) if (col[i] < bestV) { bestV = col[i]; best = i; }
    if (best < 0) return null;
    const cut = box.x0 + best;
    const sub = (x0, x1) => {
      let y0 = 1e9, y1 = -1;
      for (let y = box.y0; y <= box.y1; y++) for (let x = x0; x <= x1; x++) if (m[y * w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return y1 >= y0 ? { x0, x1, y0, y1 } : null;
    };
    const a = sub(box.x0, cut - 1), b = sub(cut + 1, box.x1);
    return a && b ? [a, b] : null;
  }

  const TW = 16, TH = 22;
  function normalize(mk, box) {
    const { m, w } = mk;
    const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    const out = new Float32Array(TW * TH);
    for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
      const sx0 = box.x0 + tx / TW * bw, sx1 = box.x0 + (tx + 1) / TW * bw;
      const sy0 = box.y0 + ty / TH * bh, sy1 = box.y0 + (ty + 1) / TH * bh;
      let s = 0, n = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++)
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) { s += m[sy * w + sx] ? 1 : 0; n++; }
      out[ty * TW + tx] = n ? s / n : 0;
    }
    out.aspect = bw / bh;
    return out;
  }

  function ncc(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const xa = a[i] - ma, xb = b[i] - mb;
      num += xa * xb; da += xa * xa; db += xb * xb;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  // ラベルごとの最高スコアを候補リストとして保持する（スコア降順）。
  // 1位の解釈が妥当性検証（例: 最終スコアは7対0〜5/8対6のみ）に反したとき、
  // 2位以下から制約を満たす読みを選び直すために使う
  function matchGlyph(g, templates) {
    const byLabel = new Map();
    for (const t of templates) {
      let s = ncc(g, t.v);
      const ar = Math.min(g.aspect, t.aspect) / Math.max(g.aspect, t.aspect);
      s *= 0.7 + 0.3 * ar;
      const cur = byLabel.get(t.label);
      if (cur == null || s > cur) byLabel.set(t.label, s);
    }
    const candidates = [...byLabel.entries()].map(([label, score]) => ({ label, score }))
      .sort((a, b) => b.score - a.score);
    return candidates.length ? { label: candidates[0].label, score: candidates[0].score, candidates } : null;
  }

  // 領域→グリフ列を読む。templates 省略時は分割のみ（収穫用）
  function readGlyphs(img, mode, templates, opts) {
    const mk = mask(img, mode);
    let boxes = (opts && opts.numeric) ? segmentCC(mk, opts) : segment(mk, opts);
    if (opts && opts.numeric) {
      // 数字の塗りの実高はクロップ高の25〜85%（エロージョン後は約36%）。
      // コンマ＝下半分の小さい塊。細い縦光・右端の細片はノイズ
      boxes = boxes.filter(b => {
        const bh = b.y1 - b.y0 + 1, bw = b.x1 - b.x0 + 1;
        if (b.x1 >= mk.w - 3 && bw < 20) return false; // 右端に張り付く細片（「位」の偏など）
        if (bw < 12 && bh > 4 * bw) return false;       // 縦長の細い光（パネル縁のシャイン。数字の1はw8×h25程度なので4倍で線引き）
        const isDigit = bh >= mk.h * 0.25 && bh <= mk.h * 0.85;
        const isComma = bh <= mk.h * 0.3 && b.y0 >= mk.h * 0.5 && bw <= mk.w * 0.15;
        return isDigit || isComma;
      });
    }
    // 期待ラベル列が既知（収穫時）: 1個足りなければ「どの箱を割れば形状パターンが合うか」で決める。
    // 融合箱は幅が普通の数字と変わらないことがある（コンマが数字の懐に入る等）ため、幅では選ばない
    if (opts && opts.labels && boxes.length === opts.labels.length - 1) {
      const fits = bs => bs.length === opts.labels.length && bs.every((b, i) => {
        const bh = b.y1 - b.y0 + 1;
        return opts.labels[i] === ','
          ? (bh <= mk.h * 0.3 && b.y0 >= mk.h * 0.5)
          : bh >= mk.h * 0.25;
      });
      for (let i = 0; i < boxes.length; i++) {
        const sp = splitBoxAtValley(mk, boxes[i]);
        if (!sp) continue;
        const cand = [...boxes.slice(0, i), ...sp, ...boxes.slice(i + 1)].sort((a, b) => a.x0 - b.x0);
        if (fits(cand)) { boxes = cand; break; }
      }
    }
    let glyphs = boxes.map(b => {
      const g = normalize(mk, b);
      const m2 = templates && templates.length ? matchGlyph(g, templates) : null;
      return { box: b, glyph: g, label: m2 ? m2.label : null, score: m2 ? m2.score : 0, candidates: m2 ? m2.candidates : [] };
    });
    // テンプレ照合時: 融合疑いグリフ（横長 or 低スコア）は試し割り。
    // 融合ペアは単体テンプレに0.75超で誤マッチすることがある（例:「17」→7、「,4」→コンマ）ため、
    // スコアだけでなくアスペクト比でも必ず試し、両半分が十分良ければ置き換える
    if (templates && templates.length && (!opts || !opts.expected)) {
      glyphs = glyphs.flatMap(g => {
        const bw = g.box.x1 - g.box.x0 + 1, bh = g.box.y1 - g.box.y0 + 1;
        // 塗りのみの数字は bw/bh ≈ 0.9 が上限。それを超える横長は融合疑い
        const suspicious = bw > bh * 1.1 || g.score < 0.8;
        if (!suspicious || bw < 12) return [g];
        const sp = splitBoxAtValley(mk, g.box);
        if (!sp) return [g];
        const two = sp.map(b => {
          const gg = normalize(mk, b);
          const m2 = matchGlyph(gg, templates);
          return { box: b, glyph: gg, label: m2.label, score: m2.score, candidates: m2.candidates };
        });
        const ok = Math.min(two[0].score, two[1].score) > Math.max(g.score + 0.03, 0.72);
        return ok ? two : [g];
      });
    }
    return glyphs;
  }

  // 数値として解釈（コンマ・位は読み飛ばし）。全グリフの最低スコアも返す
  function parseNumber(glyphs) {
    if (!glyphs.length) return { value: null, conf: 0, text: '' };
    // 桁区切りカンマ等の背の低いグリフは値にもconfにも算入しない
    // （ランク付きレートパネルの「3,291」表記でカンマがconfを潰していた対策）
    const maxH = Math.max(...glyphs.map(g => g.box ? g.box.y1 - g.box.y0 : 0));
    const main = glyphs.filter(g => !g.box || (g.box.y1 - g.box.y0) >= maxH * 0.55);
    let text = '', conf = 1;
    for (const g of main) {
      text += g.label ?? '?';
      conf = Math.min(conf, g.score);
    }
    const digits = text.replace(/[^0-9]/g, '');
    return { value: digits ? parseInt(digits, 10) : null, conf, text };
  }

  // アイコン/画像領域の特徴ベクトル（RGB縮小）
  function iconVec(img, W = 16, H = 16) {
    const { data, width, height } = img;
    const v = new Float32Array(W * H * 3);
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const sx0 = Math.floor(tx / W * width), sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) / W * width));
      const sy0 = Math.floor(ty / H * height), sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) / H * height));
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * width + sx) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      const o = (ty * W + tx) * 3;
      v[o] = r / n / 255; v[o + 1] = g / n / 255; v[o + 2] = b / n / 255;
    }
    return v;
  }

  // 白文字（＋黒縁取り）テキスト用の特徴ベクトル。背景（空・木・コート）に不変
  function textVec(img, W = 32, H = 8) {
    const { data, width, height } = img;
    const v = new Float32Array(W * H * 2);
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      let wh = 0, dk = 0, n = 0;
      const sx0 = Math.floor(tx / W * width), sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) / W * width));
      const sy0 = Math.floor(ty / H * height), sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) / H * height));
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * width + sx) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const L = lum(r, g, b), ch = Math.max(r, g, b) - Math.min(r, g, b);
        if (L > 210 && ch < 45) wh++;
        if (L < 80) dk++;
        n++;
      }
      const o = (ty * W + tx) * 2;
      v[o] = wh / n; v[o + 1] = dk / n;
    }
    return v;
  }

  // ---- 名前プレートの照合シグネチャ（2026-08-31 刷新） ----
  // 旧方式は名前欄(410x85)全体を32x8マスにして白塗り量を比べていた。2〜3文字の名前だと
  // 32列のうち10列ほどしか文字が無く、残りの「空白」が一致するため、文字の形ではなく
  // 「文字数と配置」を見ている状態になる。同一動画23プレートの実測で
  // 同一人物 0.656〜0.670 / 別人 最大0.835 と逆転しており、ユーザー辞書でも
  // 別人の2文字名が0.97に達していた（ぱぱ↔りな=0.969・かみ↔りな=0.961）。
  // → 白文字のインク枠を切り出して正規化してから比べる。ダブルスは左列が右寄せ・
  // 右列が左寄せで欄サイズも違うため、枠正規化は同一人物の一致率にも効く。
  // 刷新後の同素材実測: 同一人物 0.984〜0.986 / 別人 最大0.325（完全分離）
  const NAME_SIG = { W: 48, H: 12, AR_TOL: 1.12 };
  // 1文字は16x16 + セル重ね0.25。24x24だと1セル≒1pxで平滑化が効かず、枠が1px違うだけで
  // 同じ字のNCCが0.98→0.77に落ちる（「り」の実例）。重ねを入れると同字1位正解45/45・
  // 辞書に無い字の最良スコアは0.897までに収まる（しきい値0.90で誤読ゼロ）
  const GLYPH = { W: 16, H: 16, OV: 0.25 };
  // 名前プレート → 白文字マスク・文字帯(y0..y1)・文字列の枠(x0..x1)・列インク
  function nameBand(img) {
    const { data, width: w, height: h } = img;
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      if (lum(r, g, b) > 210 && Math.max(r, g, b) - Math.min(r, g, b) < 45) m[i] = 1;
    }
    // 行プロファイル: ベタ塗りの明るい帯(コート/UIの横線)は文字ではないので捨てる
    const rows = new Int32Array(h);
    let rmax = 0;
    for (let y = 0; y < h; y++) {
      let c = 0, run = 0, maxRun = 0;
      for (let x = 0; x < w; x++) { if (m[y * w + x]) { c++; run++; if (run > maxRun) maxRun = run; } else run = 0; }
      rows[y] = (c / w > 0.8 || maxRun > w * 0.35) ? 0 : c;
      if (rows[y] > rmax) rmax = rows[y];
    }
    if (rmax < 3) return null;
    // 文字帯 = インク行の連続塊のうち最も背の高いもの
    // （上端〜下端で取ると、下の明るい帯まで枠に含まれる。ワルイージピンボールで枠が
    //   118px→388pxに伸びた実例）
    const bands = [];
    for (let y = 0; y < h; y++) {
      if (rows[y] < rmax * 0.12) continue;
      const last = bands[bands.length - 1];
      if (last && y - last[1] <= 2) last[1] = y; else bands.push([y, y]);
    }
    if (!bands.length) return null;
    let bd = bands[0];
    for (const b2 of bands) if (b2[1] - b2[0] > bd[1] - bd[0]) bd = b2;
    const y0 = bd[0], y1 = bd[1];
    if (y1 - y0 < 4 || y1 - y0 + 1 > h * 0.6) return null;
    // 列プロファイル: 文字列の塊のうち最も幅の広いものを採る（プレート右端の細い光を除く）
    const cols = new Int32Array(w);
    let cmax = 0;
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (let y = y0; y <= y1; y++) if (m[y * w + x]) c++;
      cols[x] = c; if (c > cmax) cmax = c;
    }
    if (cmax < 2) return null;
    const thr = Math.max(1, cmax * 0.10), gapTol = Math.max(6, Math.round((y1 - y0 + 1) * 0.9));
    const gs = [];
    for (let x = 0; x < w; x++) {
      if (cols[x] < thr) continue;
      const last = gs[gs.length - 1];
      if (last && x - last[1] <= gapTol) last[1] = x; else gs.push([x, x]);
    }
    if (!gs.length) return null;
    let g0 = gs[0];
    for (const gg of gs) if (gg[1] - gg[0] > g0[1] - g0[0]) g0 = gg;
    const x0 = g0[0], x1 = g0[1];
    if (x1 - x0 < 4) return null;
    return { m, w, h, x0, x1, y0, y1, cols };
  }
  // 枠を W x H に面積平均でリサンプル（位置・欄サイズ・寄せ方向に不変になる）
  function resample(b, x0, x1, y0, y1, W, H, ov = 0) {
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const v = new Float32Array(W * H);
    for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
      let sx0, sx1, sy0, sy1;
      if (ov) { // 隣のセルと少し重ねて平滑化する（1pxのずれで別字に化けるのを防ぐ）
        sx0 = Math.max(0, Math.round(x0 + (tx - ov) / W * bw));
        sx1 = Math.min(b.w, Math.max(sx0 + 1, Math.round(x0 + (tx + 1 + ov) / W * bw)));
        sy0 = Math.max(0, Math.round(y0 + (ty - ov) / H * bh));
        sy1 = Math.min(b.h, Math.max(sy0 + 1, Math.round(y0 + (ty + 1 + ov) / H * bh)));
      } else {
        sx0 = x0 + Math.floor(tx / W * bw); sx1 = Math.max(sx0 + 1, x0 + Math.floor((tx + 1) / W * bw));
        sy0 = y0 + Math.floor(ty / H * bh); sy1 = Math.max(sy0 + 1, y0 + Math.floor((ty + 1) / H * bh));
      }
      let c = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) { c += b.m[sy * b.w + sx]; n++; }
      v[ty * W + tx] = n ? c / n : 0;
    }
    return v;
  }
  function sigFromBand(b) {
    if (!b) return null;
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    return { v: resample(b, b.x0, b.x1, b.y0, b.y1, NAME_SIG.W, NAME_SIG.H), ar: bw / bh, w: bw, h: bh };
  }
  function nameSig(img) { return sigFromBand(nameBand(img)); }

  // ---- 文字分割とOCR（2026-08-31追加・ユーザーが入力した名前を教師に文字辞書を育てる） ----
  // ストローク塊。1文字=1塊とは限らない（「け」「は」「ぬ」は縦棒が離れて2塊・濁点も別塊）。
  // 文字への束ね方は用途で変える: 学習時は入力文字数に合わせて隙間の狭い順に併合し、
  // 読み取り時はテンプレ照合スコアが最大になる区切りをDPで選ぶ
  function nameStrokes(b) {
    const groups = [];
    for (let x = b.x0; x <= b.x1; x++) {
      if (b.cols[x] < 1) continue;
      const last = groups[groups.length - 1];
      if (last && x - last.x1 <= 1) last.x1 = x; else groups.push({ x0: x, x1: x });
    }
    return groups;
  }
  // 文字箱 → 24x24（縦は文字帯全体を基準にする＝上付き/下付きの違いも形として残る）
  function glyphVec(b, x0, x1) { return resample(b, x0, x1, b.y0, b.y1, GLYPH.W, GLYPH.H, GLYPH.OV); }

  // 学習用: 期待文字数に合わせて塊を併合する。併合だけでは届かない（塊が足りない＝
  // 文字同士がくっついている）場合は null を返して収穫を見送る
  function nameGlyphs(b, count) {
    if (!b || !count) return null;
    let gs = nameStrokes(b);
    if (gs.length < count) return null;
    while (gs.length > count) {
      let bi = -1, bg = Infinity;
      for (let i = 0; i + 1 < gs.length; i++) {
        const gap = gs[i + 1].x0 - gs[i].x1 - 1;
        if (gap < bg) { bg = gap; bi = i; }
      }
      if (bi < 0) return null;
      gs[bi] = { x0: gs[bi].x0, x1: gs[bi + 1].x1 };
      gs.splice(bi + 1, 1);
    }
    return gs.map(g => ({ v: glyphVec(b, g.x0, g.x1), x0: g.x0, x1: g.x1 }));
  }

  // 読み取り用: 1文字=1〜3塊としてDPで最良の区切りを選ぶ。
  // 誤った区切り（「け」の縦棒だけ等）はどのテンプレにも当たらないので自然に選ばれない
  function readName(b, lib, minScore = 0.90) {
    if (!b || !lib || !lib.length) return null;
    const gs = nameStrokes(b);
    if (!gs.length || gs.length > 24) return null;
    const n = gs.length;
    const best = new Array(n + 1).fill(null);
    best[0] = { sum: 0, cnt: 0, text: '', min: 1 };
    for (let i = 0; i < n; i++) {
      if (!best[i]) continue;
      for (let k = 1; k <= 3 && i + k <= n; k++) {
        const v = glyphVec(b, gs[i].x0, gs[i + k - 1].x1);
        let hit = null;
        for (const t of lib) { const s = ncc(v, t.v); if (!hit || s > hit.s) hit = { c: t.c, s }; }
        if (!hit || hit.s < minScore) continue;
        const cand = { sum: best[i].sum + hit.s, cnt: best[i].cnt + 1, text: best[i].text + hit.c, min: Math.min(best[i].min, hit.s) };
        const cur = best[i + k];
        if (!cur || cand.sum / cand.cnt > cur.sum / cur.cnt) best[i + k] = cand;
      }
    }
    const r = best[n];
    return r ? { text: r.text, conf: r.min, avg: r.sum / r.cnt } : null;
  }
  // シグネチャ同士のスコア。文字列の縦横比が違えば別人（同一人物は実測で比1.00）
  function nameSigScore(a, b) {
    if (!a || !b || !a.v || !b.v || a.v.length !== b.v.length) return 0;
    const r = a.ar > b.ar ? a.ar / b.ar : b.ar / a.ar;
    if (!(r <= NAME_SIG.AR_TOL)) return 0;
    return ncc(a.v, b.v);
  }

  // len: 比較に使うベクトル先頭の要素数（省略時は全体）。
  // シングルスVSのアイコン領域(myicon/oppicon 90x88)は下側約30%がカードの外＝コート背景なので、
  // vsIcons は上11行(16x16x3の先頭 11*48=528 要素)だけで照合する(VS_ICON_LEN)。
  // 辞書のベクトルは全体のまま保存しているので再収穫は不要。
  // 実測(2026-09-05・辞書305本の総当たり): 自分自身を除いたtop1正解 248→278/298・別キャラ間の最大一致 0.873→0.849。
  // 実フレーム160アイコン: 正解 149→155・score<0.8 のフラグ 1→0。外れは全部色違い同士(構造的に区別不能)
  function matchIcon(v, lib, len) {
    let best = null;
    for (const t of lib) {
      const s = len ? nccLen(v, t.v, len) : ncc(v, t.v);
      if (!best || s > best.score) best = { name: t.name, score: s };
    }
    return best;
  }
  const VS_ICON_LEN = 11 * 16 * 3;
  function nccLen(a, b, n) {
    n = Math.min(n, a.length, b.length);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let s = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; da += x * x; db += y * y; }
    return da && db ? s / Math.sqrt(da * db) : 0;
  }

  // コート名照合用: textVec の白チャンネルだけでNCCを取る。
  // 暗チャンネルは背景（夜空・観客席・青空）に支配され、グリフが完全一致していても
  // 「背景の明暗が近い別コート」が勝ってしまう実例が出た（ギャラクシーコート 0.41 vs グラス 0.75）。
  // 白のみに変えると 720p 実戦 8/8 正解・旧3動画10フレームもすべて維持（docs/csv-accuracy-720p-classic.md）。
  function nccWh(a, b) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const n = a.length >> 1;
    for (let i = 0; i < n; i++) {
      const x = a[i * 2], y = b[i * 2];
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    const d = Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n));
    return d < 1e-9 ? 0 : (sab - sa * sb / n) / d;
  }
  function matchIconWh(v, lib) {
    let best = null, second = 0;
    for (const t of lib) {
      const s = nccWh(v, t.v);
      if (!best || s > best.score) {
        if (best && best.name !== t.name) second = Math.max(second, best.score);
        best = { name: t.name, score: s };
      } else if (t.name !== best.name && s > second) second = s;
    }
    if (best) best.second = second; // 異ラベル2位(僅差判定用)
    return best;
  }

  // 1秒間隔で全編を分類し、同種の連続フレームをイベント窓にまとめる
  // （ステイルフレーム対策は makeSeeker 内で実施）
  async function scan(video, { step = 1.0, onProgress, albumTpl } = {}) {
    const seekTo = makeSeeker(video);
    const events = [];
    let cur = null;
    for (let t = 0.2; t < video.duration; t += step) {
      await seekTo(t);
      let cls = classify(frameToData(video, 192, 108));
      // サンボショット等の黄色リボンバナーはwinnerパネルと配色が同じ → バナー検出が勝ったら棄却。
      // ただしスコア枠(x1582〜)に届かない左側のバナーは無関係（ダブルス勝敗画面の左側に
      // 演出テキストが出てfindBannerが反応し、本物のパネルを弾いた実例がある）
      if (cls === 'winner' && bannerOverlapsPanel(video)) cls = 'other';
      // アルバム再生バーが出ていたら、何が写っていても解析対象外（'album' として窓にする）。
      // バーは操作していない間は消えることがあり、全画面再生では最初から出ない。
      // その場合は検出できない（残存リスク）が、孤児rating警告とレート連鎖検証が後段の網になる。
      if (cls !== 'other' && albumTpl && albumTpl.length) {
        const av = textVec(cropRegion(video, REGIONS.albumBar), 48, 4);
        let best = 0;
        for (const tp of albumTpl) { const sc = nccWh(av, tp.v); if (sc > best) best = sc; }
        if (best >= 0.8) cls = 'album';
      }
      if (cur && cur.type === cls) cur.t1 = t;
      else {
        // winnerパネルは表示が2〜3秒と短いので1ヒットでも採用する
        if (cur && cur.type !== 'other' && (cur.t1 > cur.t0 || cur.type === 'winner')) events.push(cur);
        cur = { type: cls, t0: t, t1: t };
      }
      if (onProgress) onProgress(t, video.duration, cls);
    }
    if (cur && cur.type !== 'other' && (cur.t1 > cur.t0 || cur.type === 'winner')) events.push(cur);
    return events;
  }

  // Winnerパネルはスライドインするため、黄色ハイライトが最大のフレームを選ぶ
  // 「片方の行だけが黄色」の安定フレームを選ぶ（出現アニメ中は両行が黄色く光る瞬間がある）
  async function findWinnerFrame(video, win) {
    const seekTo = makeSeeker(video);
    let best = { t: (win.t0 + win.t1) / 2, y: -1 };
    for (let t = Math.max(0, win.t0 - 0.5); t <= win.t1 + 0.5; t += 0.25) {
      await seekTo(t);
      const y1 = frac(cropRegion(video, REGIONS.w1digit), 0, 0, REGIONS.w1digit.w, REGIONS.w1digit.h, isYellow);
      const y2 = frac(cropRegion(video, REGIONS.w2digit), 0, 0, REGIONS.w2digit.w, REGIONS.w2digit.h, isYellow);
      const score = Math.min(y1, y2) < 0.1 ? Math.max(y1, y2) : 0;
      if (score > 0.05 && bannerOverlapsPanel(video)) continue; // 黄色リボンバナーの誤検出除け
      if (score > best.y) best = { t, y: score };
    }
    await seekTo(best.t);
    return best;
  }

  // 勝敗パネルを直接探す（シーン分類非依存）: 指定範囲を後ろから0.25秒刻みで走査し、
  // 「片方のスコア枠だけが黄色い」フレームを返す。両枠とも黄色=日向の砂などの偽物。
  // panelFont があれば黄色枠の数字が実際に読めることまで確認する。
  // isDoubles: ダブルスはスコア枠の位置/大きさが違う(dw1digit/dw2digit)ため専用領域で探す
  async function locateWinner(video, t0, t1, panelFont, isDoubles) {
    const seekTo = makeSeeker(video);
    const r1 = isDoubles ? REGIONS.dw1digit : REGIONS.w1digit;
    const r2 = isDoubles ? REGIONS.dw2digit : REGIONS.w2digit;
    for (let t = t1; t >= Math.max(0.2, t0); t -= 0.25) {
      await seekTo(t);
      const y1 = frac(cropRegion(video, r1), 0, 0, r1.w, r1.h, isYellow);
      const y2 = frac(cropRegion(video, r2), 0, 0, r2.w, r2.h, isYellow);
      if (Math.max(y1, y2) > 0.15 && Math.min(y1, y2) < 0.08) {
        if (bannerOverlapsPanel(video)) continue; // 黄色リボンバナー(サンボショット等)の誤検出除け
        if (panelFont && panelFont.length) {
          const winRegion = y1 >= y2 ? r1 : r2;
          const p = parseNumber(readGlyphs(cropRegion(video, winRegion), 'inkonyellow', panelFont));
          if (p.value == null || p.conf < 0.6) continue;
        }
        return { t, y1, y2, row: y1 >= y2 ? 1 : 2 };
      }
    }
    return null;
  }

  // レートパネルの変動前/後の値を一括で読む。
  // ランク付きパネルは1枚の中で「前の値で静止→カウントアニメ→後の値で静止」と遷移し、
  // 静止時間はプレイヤーのボタン操作次第でバラバラ。固定オフセット読みは桁欠け/中間値を拾うため、
  // 表示中を0.4s刻みで全走査し「最初の安定ラン(同値2回以上)=変動前」「最後の安定ラン=変動後」を採る。
  // レートは4桁なので value>=1000 で桁欠け読みを排除
  // パネル表示中を走査して「最初/最後の安定ラン」を拾う。maskモードと受理confは呼び出し側指定
  async function ratingRuns(video, t0, t1, templates, modes, minConf) {
    const seekTo = makeSeeker(video);
    const seq = [];
    for (let t = t0 + 0.2; t <= t1 + 4.0; t += 0.4) {
      await seekTo(t);
      if (classify(frameToData(video, 192, 108)) !== 'rating') {
        if (t > t0 + 1.5) break; // パネル消滅
        continue; // 出現前
      }
      const img = cropRegion(video, REGIONS.rating);
      let best = null;
      for (const mode of modes) {
        const p = parseNumber(readGlyphs(img, mode, templates, NUM_SEG));
        if (p.value == null || p.value < 1000 || p.value > 9999) continue; // レートは必ず4桁
        if (!best || p.conf > best.conf) best = p;
      }
      if (best && best.conf >= minConf) seq.push({ value: best.value, conf: best.conf });
    }
    const runs = [];
    for (const r of seq) {
      const last = runs[runs.length - 1];
      if (last && last.value === r.value) { last.n++; last.conf = Math.max(last.conf, r.conf); }
      else runs.push({ value: r.value, n: 1, conf: r.conf });
    }
    const stable = runs.filter(r => r.n >= 2);
    const none = { value: null, conf: 0, stable: false };
    if (!stable.length) return { before: none, after: none };
    const first = stable[0], last = stable[stable.length - 1];
    if (first === last) {
      // 安定ランが1つ = カウント演出を映さずスキップされた等。最終表示が確定値(変動後)。変動前は不明
      return { before: none, after: { value: last.value, conf: last.conf, stable: true } };
    }
    return { before: { value: first.value, conf: first.conf, stable: true },
             after: { value: last.value, conf: last.conf, stable: true } };
  }

  async function readRatingPair(video, t0, t1, templates) {
    // 通常読み: fillink + 受理conf 0.75。0.75は「劣化フレームの誤読（3,389→3189@0.71が
    // 安定ラン化しレート連鎖を汚染した実例・2026-08-28）」を遮断するための値なので下げない
    const strict = await ratingRuns(video, t0, t1, templates, ['fillink'], 0.75);
    if (strict.before.value != null && strict.after.value != null) return strict;
    // 読めなかった側だけ、緩和マスクでもう一度走査する。ビットレートの低い録画では
    // 塗りに色がにじんで数字が丸ごと欠ける（「3,271」→「321」＝3桁で棄却）／確信度が
    // 0.75に届かない（「3,278」を0.69で8フレーム安定読み）という取りこぼしが出る（6.2Mbps実測）。
    // 緩和読みの値は weak=true で返し、呼び出し側で必ず要確認にする＝無警告の誤りは増やさない
    const loose = await ratingRuns(video, t0, t1, templates, ['fillink2', 'lightink'], 0.60);
    // 緩和読みで前後がそろったら、そちらを丸ごと採用する。通常読みが安定ランを1つしか
    // 拾えないと「変動前の値を変動後として返す」ため（m10: 画面は3422→3446なのにカウント後の
    // 3446が0.71で棄却され、変動後=3422が無警告で入っていた・2026-08-31）
    if (loose.before.value != null && loose.after.value != null) {
      return { before: { ...loose.before, weak: true }, after: { ...loose.after, weak: true } };
    }
    const pick = (s, l) => (s.value != null ? s : (l.value != null ? { ...l, weak: true } : s));
    return { before: pick(strict.before, loose.before), after: pick(strict.after, loose.after) };
  }

  // 現在フレームのバナーが勝敗パネルの「スコア数字の帯」に実際に重なっているか。
  // winner棄却ガード用: ダブルス勝敗画面は左側に演出テキストが出てfindBannerが反応するが、
  // スコア枠に届かないバナーは黄色枠の誤検出源にならないので弾いてはいけない。
  // x条件だけだと、パネル下端〜コートの白い横帯(帯下端 y976-1009)がfindBannerに拾われて
  // x1=1919となり、本物の勝敗パネルを3試合分スキップした実例(2026-08-29・クレイ/ワンダー)
  // → 数字行の縦帯(dw1digit上端〜dw2digit下端)に重なる場合のみ真のオーバーラップとする
  function bannerOverlapsPanel(video) {
    const b = findBanner(video);
    if (!b) return false;
    const y0 = REGIONS.bannerBand.y + b.box.y0, y1 = REGIONS.bannerBand.y + b.box.y1;
    const top = REGIONS.dw1digit.y, bot = REGIONS.dw2digit.y + REGIONS.dw2digit.h;
    return b.box.x1 >= 1400 && y1 >= top && y0 <= bot;
  }

  // ダブルス勝敗パネルの「最後の表示フレーム」を探す。
  // スコアはカウントアップ演出つきで最終値の表示は一瞬（8-6が7-2→8-6と増えて即消滅する実例）。
  // 勝者枠の黄色が持続する最後の時刻を返す＝カウントアップ完了後の最終値フレーム
  async function findPanelEnd(video, wloc, maxAhead = 2.5) {
    const seekTo = makeSeeker(video);
    const winR = wloc.row === 1 ? REGIONS.dw1digit : REGIONS.dw2digit;
    let tLast = wloc.t;
    for (let t = wloc.t + 0.1; t <= wloc.t + maxAhead; t += 0.1) {
      await seekTo(t);
      const img = cropRegion(video, winR);
      if (frac(img, 0, 0, winR.w, winR.h, isYellow) > 0.5) tLast = t; else break;
    }
    return tLast;
  }

  // FVゲージの充填率（0=空〜1=満タン。バーの非黒ピクセル割合）
  function gaugeFill(video, region) {
    const img = cropRegion(video, region);
    return frac(img, 0, 0, region.w, region.h, (r, g, b) => lum(r, g, b) > 90);
  }

  // 回線品質アイコン（4本バー）の点灯本数を読む。黄色い縦バーの「列ラン」を数える方式
  // （バーは黒縁で区切られるため、黄色列の連続ランの本数=点灯本数。斜め表示にも頑健）。
  // 戻り値 {level, ok}: ok=false はアイコン不在（HUD非表示・リプレイ・カメラ演出中）か判定不能
  // HUD可視性プロキシ: 回線アイコンの「存在」だけを判定(本数の構造検証はしない)。
  // readConnectionの厳格化に伴い、ゲージ時系列のHUDゲートが過剰にサンプルを落として
  // side帰属のエッジを取りこぼした実例(2026-08-29第3実戦)への対応
  function connIconPresent(video) {
    const R0 = REGIONS.connFever;
    const img = cropRegion(video, R0);
    const { data, width, height } = img;
    const isYellow = i => { const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      return r > 180 && g > 160 && b < 100 && r - b > 90 && g - b > 90; };
    let total = 0; const colHas = new Uint8Array(width);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      if (isYellow(y * width + x)) { total++; colHas[x] = 1; }
    let yellowCols = 0; for (let x = 0; x < width; x++) yellowCols += colHas[x];
    if (yellowCols / width > 0.85) return false; // 黄色背景フラッド(アイコン判別不能)
    return total >= 40;
  }

  function readConnection(video, mode) {
    const R0 = (mode && String(mode).indexOf('fever') === 0) ? REGIONS.connFever : REGIONS.connClassic;
    const img = cropRegion(video, R0);
    const { data, width, height } = img;
    // アイコンの黄色は(≈230,230,40)。芝(緑)やテント(赤)を弾くため彩度条件を強めに取る
    const isYellow = i => { const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
      return r > 180 && g > 160 && b < 100 && r - b > 90 && g - b > 90; };
    const colCnt = new Uint16Array(width);
    let total = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      if (isYellow(y * width + x)) { colCnt[x]++; total++; }
    // ラン抽出(幅と峰高さつき)。単純なラン数だけだと黄色背景(クレイの観客テント等)が
    // 領域を覆ったとき全列が黄色となり4本が1ランに融合して「1」と誤読した実例(2026-08-29)
    const runsArr = [];
    let len = 0, peak = 0, yellowCols = 0;
    for (let x = 0; x <= width; x++) {
      const cnt = x < width ? colCnt[x] : 0;
      if (cnt >= 4) { len++; peak = Math.max(peak, cnt); yellowCols++; }
      else { if (len >= 3) runsArr.push({ w: len, peak }); len = 0; peak = 0; }
    }
    if (yellowCols / width > 0.72) return { level: 0, ok: false }; // 黄色背景が領域を覆っている
    const runs = runsArr.length;
    if (!(runs >= 1 && runs <= 4 && total >= 50)) return { level: 0, ok: false };
    if (runsArr.some(r => r.w > 14)) return { level: 0, ok: false }; // バー幅を超える塊は別物
    // バーは左→右へ高くなる階段状(アンチエイリアス誤差の許容-2px)
    for (let i = 1; i < runs; i++) if (runsArr[i].peak < runsArr[i - 1].peak - 2) return { level: 0, ok: false };
    // 1本のみ=最短バーのはず。背の高い単独の塊は黄色い別物
    if (runs === 1 && runsArr[0].peak > height * 0.55) return { level: 0, ok: false };
    return { level: runs, ok: true };
  }

  // フィーバー発動バナー（「〇〇ショット/ブースト」巨大白文字）を現在フレームから探す。
  // 見つかれば 純白グリフのバウンディングボックスと textVec を返す
  function findBanner(video, region, opts = {}) {
    const R = region || REGIONS.bannerBand;
    const minTotal = opts.minTotal ?? 2500, minW = opts.minW ?? 280,
          minH = opts.minH ?? 32, maxH = opts.maxH ?? 110,
          minRowCnt = opts.minRowCnt ?? 25, minColCnt = opts.minColCnt ?? 4;
    const img = cropRegion(video, R);
    const { data, width, height } = img;
    const isTextPx = i => {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      return lum(r, g, b) > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
    };
    const isDarkPx = i => lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) < 80;
    // 密度の高い行・列のスパン（ギャップ許容つき）をバナー本体とみなす。閾値は最大密度に比例
    const span = (cnt, n, min, gapTol) => {
      let best = null, s = -1, gap = 0, last = -1;
      for (let i = 0; i <= n; i++) {
        const on = i < n && cnt[i] >= min;
        if (on) { if (s < 0) s = i; last = i; gap = 0; }
        else if (s >= 0 && ++gap > gapTol) {
          if (!best || last - s > best[1] - best[0]) best = [s, last];
          s = -1;
        }
      }
      if (s >= 0 && (!best || last - s > best[1] - best[0])) best = [s, last];
      return best;
    };
    // マスク(1=文字画素)から文字ボックスを求める
    const locate = (mask) => {
      const colCnt = new Uint16Array(width), rowCnt = new Uint16Array(height);
      let total = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (mask[y * width + x]) { colCnt[x]++; rowCnt[y]++; total++; }
      }
      if (total < minTotal) return null;
      let maxRow = 0; for (let y = 0; y < height; y++) maxRow = Math.max(maxRow, rowCnt[y]);
      const ys = span(rowCnt, height, Math.max(minRowCnt, maxRow * 0.25), 8);
      if (!ys) return null;
      const xs = span(colCnt, width, minColCnt, 30);
      if (!xs) return null;
      return { box: { x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] }, mask };
    };
    const plain = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) if (isTextPx(i)) plain[i] = 1;
    let loc = locate(plain);
    if (!loc) return null;
    // 白リボン対応(2026-09-05): フィーバーショット(白×灰の縞)とビューゴーショット(白×水色の縞)は
    // リボン自体が「明るい無彩色」なので文字画素と区別がつかず、文字ボックスが帯いっぱい
    // (実測 幅1790・底まで到達)に膨らんでプロファイルがリボンで汚染されていた。
    // その場合だけ「黒縁に両側を挟まれた白ラン」に絞った厳格マスクで取り直す
    // (文字には黒縁取りがある／リボンの白は灰・水色に接するだけ)。
    // 色リボンのバナーはこの分岐に入らないので、従来の検出結果は1画素も変わらない。
    let whiteRibbon = false;
    if (loc.box.x1 - loc.box.x0 > width * 0.75) {
      const strict = new Uint8Array(width * height);
      const D = 4;
      for (let y = 0; y < height; y++) {
        const row = y * width;
        let x = 0;
        while (x < width) {
          if (!plain[row + x]) { x++; continue; }
          let e = x; while (e < width && plain[row + e]) e++;
          let dl = false, dr = false;
          for (let k = 1; k <= D && !dl; k++) if (x - k >= 0 && isDarkPx(row + x - k)) dl = true;
          for (let k = 0; k < D && !dr; k++) if (e + k < width && isDarkPx(row + e + k)) dr = true;
          if (dl && dr) for (let i = x; i < e; i++) strict[row + i] = 1;
          x = e;
        }
      }
      loc = locate(strict);
      if (!loc) return null;
      // 白リボン扱いは幅でも裏取り(実測 フィーバーショット906／ビューゴーショット1034。ランクマ素材の帯左下HUDが幅294で通った実例あり)
      if (loc.box.x1 - loc.box.x0 < 660) return null;
      whiteRibbon = true;
    }
    const box = loc.box, mask = loc.mask;
    if (box.y1 - box.y0 < minH || box.y1 - box.y0 > maxH) return null;
    if (box.x1 - box.x0 < minW) return null;
    if (!whiteRibbon) {
      // バナーのリボン（斜めストライプの帯）がテキストの下にあること（白い雲や観客の誤検出除け）。
      // リボンの色はショットごとに違う（ファイアバー=橙／マジック=青紫／ドッスン=灰）ので、
      // 高彩度だけを条件にすると **灰色リボンのラケットが丸ごと検出できない**
      // （2026-08-31実測: ドッスンショットは ribbonSat=0.000 で棄却されていた。
      //  「画面端で見切れて収穫失敗」と記録していた現象の正体もこれ）。
      // 彩度が無くてもストライプの明暗差は残るので「高彩度 or 帯の輝度分散が大きい」で通す。
      // 実測: 色リボン sat 0.44〜0.77 / sd 57〜91、灰リボン sat 0.000 / sd 47.3、
      //       誤検出（テキストの下がコート面なだけ）sd 21.9〜28.6
      // 白リボン(上の厳格マスク経路)は「帯いっぱいの白が文字の下にある」こと自体がリボンの証拠なので免除
      const pad = 12;
      const rx0 = Math.max(0, box.x0 - pad), rx1 = Math.min(width, box.x1 + pad);
      const ry0 = Math.min(height - 1, box.y1), ry1 = Math.min(height, box.y1 + 26);
      const ribbon = frac(img, rx0, ry0, rx1, ry1,
                          (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 80);
      if (ribbon < 0.15) {
        // 無彩色リボン扱いにする条件は厳しめに: 帯の輝度分散 + 文字幅。
        // 実測の低彩度誤検出はワルイージピンボールの得点演出メダル「Mario Tennis Fever」で
        // 幅475〜558（本物のバナーは最短の7文字名でも701）。幅660で切れば両立する
        let n = 0, s = 0, s2 = 0;
        for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
          const i = (y * width + x) * 4;
          const L = lum(data[i], data[i + 1], data[i + 2]);
          n++; s += L; s2 += L * L;
        }
        const sd = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n))) : 0;
        if (sd < 35 || box.x1 - box.x0 < 660) return null;
      }
    }
    // バナー文字には黒縁取りがある（実測0.32）。コートの白線+砂の誤検出は0.02〜0.03
    const darkIn = frac(img, box.x0, box.y0, box.x1 + 1, box.y1 + 1, (r, g, b) => lum(r, g, b) < 80);
    if (darkIn < 0.10) return null;
    // 文字ボックスを切り出して textVec 化 + 列プロファイル（平行移動に強い照合用）
    const c = document.createElement('canvas');
    const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
    c.width = bw; c.height = bh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.putImageData(img, -box.x0, -box.y0);
    const sub = ctx.getImageData(0, 0, bw, bh);
    const profile = new Array(bw).fill(0);
    for (let x = box.x0; x <= box.x1; x++) {
      let cnt = 0;
      for (let y = box.y0; y <= box.y1; y++) if (mask[y * width + x]) cnt++;
      profile[x - box.x0] = cnt;
    }
    return { box, v: textVec(sub, 48, 10), profile, whiteRibbon };
  }

  // バナー列プロファイル同士の照合: オフセット走査つき1次元正規化相互相関（重なり70%以上）。
  // バナーは横スライドし続けることがあるため、平行移動・部分クリップに強いこの方式で照合する
  function profileXcorr(a, b) {
    if (a.length < b.length) { const t = a; a = b; b = t; }
    let best = 0;
    const minOverlap = Math.floor(b.length * 0.7);
    for (let off = -Math.floor(b.length * 0.3); off <= a.length - minOverlap; off++) {
      let sa = 0, sb = 0, n = 0;
      for (let i = 0; i < b.length; i++) {
        const j = i + off;
        if (j < 0 || j >= a.length) continue;
        sa += a[j]; sb += b[i]; n++;
      }
      if (n < minOverlap) continue;
      const ma = sa / n, mb = sb / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < b.length; i++) {
        const j = i + off;
        if (j < 0 || j >= a.length) continue;
        const xa = a[j] - ma, xb = b[i] - mb;
        num += xa * xb; da += xa * xa; db += xb * xb;
      }
      if (da && db) best = Math.max(best, num / Math.sqrt(da * db));
    }
    return best;
  }

  // バナーはスライドイン→短い静止→スライドアウトする。静止した瞬間（bboxが連続2サンプルで不動）を掴む。
  // 静止が見つからなければ全文が画面内に収まる最大幅フレームで妥協（stable:false）
  async function captureStableBanner(video, tHit, region, opts) {
    const seekTo = makeSeeker(video);
    const samples = [];
    for (let dt = -0.5; dt <= 0.6; dt += 0.1) {
      await seekTo(tHit + dt);
      const b = findBanner(video, region, opts);
      if (b) samples.push({ t: tHit + dt, ...b });
    }
    const W = (region || REGIONS.bannerBand).w;
    const inside = s => s.box.x0 > 8 && s.box.x1 < W - 8;
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i], b = samples[i + 1];
      if (Math.abs(a.box.x0 - b.box.x0) <= 6 &&
          Math.abs((a.box.x1 - a.box.x0) - (b.box.x1 - b.box.x0)) <= 6 &&
          inside(a) && inside(b)) {
        return { t: b.t, v: b.v, box: b.box, stable: true };
      }
    }
    const cand = samples.filter(inside).sort((a, b) => (b.box.x1 - b.box.x0) - (a.box.x1 - a.box.x0))[0];
    return cand ? { t: cand.t, v: cand.v, box: cand.box, stable: false } : null;
  }

  // フィーバー発動バナーを試合区間から収集し、FVゲージの減少で「どちらが撃ったか」を判定する
  // side: 'me'（左ゲージが減った）/ 'opp' / null（判定不能→要確認）
  async function collectBanners(video, t0, t1, { step = 0.7, onProgress } = {}) {
    const seekTo = makeSeeker(video);
    const events = [];
    let t = t0;
    // maxH緩和: メタルブースト等の斜め表示バナーは文字ボックス高が110pxを超える(FHD実測131px)。
    // 他の呼び出し箇所(勝敗パネル棄却ガード等)は既定のまま、バナー収集だけ広げる
    const bOpts = { maxH: 160 };
    const gauges = []; // {t, L, R} 時系列(side帰属のエッジ検出に使う)
    // HUD可視性ゲート: フィーバーショット発動中はHUD全体が非表示になり、ゲージ領域には
    // 背景(ピンボールの市松床等)が写る。輝度率ベースの読みが汚染され偽エッジになるため、
    // 回線アイコン(HUDと同時に消える)が成立するフレームのサンプルだけを時系列に採用する
    const hudOk = () => connIconPresent(video);
    while (t < t1) {
      await seekTo(t);
      if (hudOk()) gauges.push({ t, L: gaugeFill(video, REGIONS.fvL), R: gaugeFill(video, REGIONS.fvR) });
      const b = findBanner(video, null, bOpts);
      if (b) {
        // 見切れガード: 帯の端に接触したバナーはスライド途中で文字が欠けており、
        // 共通サフィックス「ブースト」だけで別ラケットに高相関する実例(0.92誤マッチ)がある
        // → 全文が画面内のフレームのプロファイルだけを照合に使う
        const bandW = REGIONS.bannerBand.w;
        const inside = bb => bb.box.x0 > 8 && bb.box.x1 < bandW - 8;
        const profiles = [];
        if (inside(b)) profiles.push(b.profile);
        await seekTo(t + 0.25);
        const b2 = findBanner(video, null, bOpts);
        if (b2 && inside(b2)) profiles.push(b2.profile);
        if (!profiles.length) {
          // 端接触しか取れない場合は前後を少し探す(それでも無ければ照合不能=未照合イベント扱い)
          for (const dt of [-0.4, -0.2, 0.45, 0.6]) {
            await seekTo(t + dt);
            const b3 = findBanner(video, null, bOpts);
            if (b3 && inside(b3)) { profiles.push(b3.profile); break; }
          }
        }
        events.push({ t, profiles, side: null });
        // バナー表示中(スキップ区間)もゲージのエッジを見逃さないよう追加サンプル
        for (const dt of [1.3, 2.6]) {
          await seekTo(t + dt);
          if (hudOk()) gauges.push({ t: t + dt, L: gaugeFill(video, REGIONS.fvL), R: gaugeFill(video, REGIONS.fvR) });
        }
        t += 4.0; // 同一バナーの再ヒット回避
      } else t += step;
      if (onProgress) onProgress(t, t1);
    }
    // ---- side帰属: ゲージ時系列の「充填→空」エッジ検出方式(2026-08-29刷新) ----
    // 旧方式(バナー窓ごとの減少量比較)は、両者がほぼ同時に発動すると必ず誤る
    // (自分の発動でゲージが空→直後の相手バナーの窓で「自分側が減った」と誤読。
    //  実測: 5+件の誤帰属は全て同時発動が絡んでいた)。
    // 新方式: 各ゲージ独立に「2点以上>=0.25 → <=0.15 → 次点も<=0.18」の遷移をエッジ=発動とみなし、
    // 各バナーを最も時刻の近い未消費エッジに割り当てる(基準はバナー出現の0.3s前後)。
    // 両ゲージが同時(<=0.8s差)にエッジ = リプレイ等のHUD非表示アーティファクト → 双方破棄
    // エッジ=「直前2点の最小値から0.22以上の急落・落下先は0.45以下・次点も低いまま」。
    // 絶対閾値だと不成立: ゲージ読みは明るい画素率のため「空」の基準値が左右で違う
    // (実測: 自分側=0.08・相手側=0.29前後。相手側領域に常時明るい表示が混入している)。
    // 相対ドロップなら両側で成立し、発動時のグロー→暗転(1.0→0.37)も正しくエッジになる
    const edges = { L: [], R: [] };
    gauges.sort((a, b) => a.t - b.t);
    for (const k of ['L', 'R']) {
      for (let i = 2; i < gauges.length - 1; i++) {
        const prevMin = Math.min(gauges[i - 2][k], gauges[i - 1][k]);
        if (prevMin - gauges[i][k] >= 0.22 && gauges[i][k] <= 0.45 &&
            gauges[i + 1][k] <= gauges[i][k] + 0.08) {
          edges[k].push((gauges[i - 1].t + gauges[i].t) / 2);
        }
      }
    }
    for (const eL of [...edges.L]) for (const eR of [...edges.R]) {
      if (Math.abs(eL - eR) <= 0.8) {
        edges.L = edges.L.filter(x => x !== eL);
        edges.R = edges.R.filter(x => x !== eR);
      }
    }
    for (const e of events) {
      let best = null;
      for (const k of ['L', 'R']) for (const te of edges[k]) {
        const d = Math.abs(te - (e.t + 0.3));
        if (d <= 3.5 && (!best || d < best.d)) best = { k, te, d };
      }
      if (best) {
        e.side = best.k === 'L' ? 'me' : 'opp';
        edges[best.k] = edges[best.k].filter(x => x !== best.te);
      }
    }
    return events;
  }

  // イベント列を試合単位にまとめる（vs → winner → rating）
  function groupMatches(events) {
    const matches = [];
    for (const e of events) {
      if (e.type === 'vs') {
        // 直前の試合のratingがまだ来ていない間のvsは「試合中のゲームカウントUI」等の誤分類
        // （VSバナーと同構造でclassifyが反応する実例あり）→ 無視。試合の起点は
        // 「前のratingの後、最初のvs窓」（アルバム再生の偽vsはalbum除外が既に担当）
        const last = matches[matches.length - 1];
        if (last && !last.rating) continue;
        matches.push({ vs: e });
      }
      // winnerはratingが来るまで最後のもので上書きする。本物の勝敗パネルは必ずレートパネル直前に出る。
      // （砂コートで試合中の黄色が偽winnerになり、先勝ちだと本物t458でなく偽t367を掴んだ実例・2026-08-28）
      else if (e.type === 'winner') { const m = matches[matches.length - 1]; if (m && !m.rating) m.winner = e; }
      else if (e.type === 'rating') { const m = matches[matches.length - 1]; if (m && !m.rating) m.rating = e; }
    }
    return matches.filter(m => m.rating); // レートパネルまで揃った試合のみ
  }

  return { REGIONS, NUM_SEG, LOOSE, NAME_SIG, GLYPH, nameSig, nameSigScore, nameBand, sigFromBand, nameStrokes, glyphVec, nameGlyphs, readName, lum, makeSeeker, setSourceRect, getSourceRect, srcRect, frameToData, cropRegion, frac, classify, mask, segment, normalize, ncc,
           matchGlyph, readGlyphs, parseNumber, iconVec, textVec, matchIcon, VS_ICON_LEN, matchIconWh, nccWh, scan, groupMatches, findWinnerFrame, locateWinner,
           bannerOverlapsPanel, findPanelEnd, readRatingPair, readConnection,
           gaugeFill, findBanner, captureStableBanner, profileXcorr, collectBanners, TW, TH };
})();
