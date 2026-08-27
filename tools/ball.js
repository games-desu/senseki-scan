// SENSEKI SCAN ボール追跡（ブラウザ用・依存なし / court.js に依存）
// Phase C: ボールを追い、軌道の反転から「バウンド（着弾位置）」と「打点」を取る。
//
// 実測で確定した方針（docs/rally-probe/ball-bounce.md）:
//   影は補助。**主判定は軌道の反転イベント列**。曇天の芝(23-19-09)は影が一切出ないため。
//   ボール本体の色検出は7コートで成立する。決め手は r/g が 0.84〜1.02 に入ること。
//   **どの色のトレイルも r/g がこの帯の外にある**（青0.67 / 紫2.34 / 赤1.58 / 黄1.06 / 白1.00±0.03）ので、
//   トレイルと融合したCCからでもボール本体だけを取り出せる。
//   処理は 960x540（K=0.5）。480x270 はボールが3.5pxになるので不可。
window.BallTrack = (() => {
  const W = 960, H = 540, SC = 2;            // 960空間 → FHD換算はすべて SC 倍
  const YVP = -651;

  // ---- 色述語 ----
  // g の下限は **160**。実測（砂コート・960空間）でボール核は g=215〜221 なのに対し、
  // ネットのメッシュは g=125〜141 で r/g=0.96〜0.98 とボールの帯にそのまま入ってしまう。
  // g=140 だとネットを大量に拾い、追跡がネットに乗り移る（実測で8点中6点がネット上だった）。
  // 砂コート面(r/g=1.07〜1.11)とキャラ(1.06〜1.30)は r/g で落ちる。
  const isBall = (r, g, b) => {
    if (g < 160) return false;
    const rg = r / g, bg = b / g;
    return rg > 0.84 && rg < 1.02 && bg > 0.28 && bg < 0.68;
  };
  // オーラで色が転んだ時の再探索用（予測位置の近傍でだけ使う）
  const isBallLoose = (r, g, b) => {
    if (g < 130) return false;
    const rg = r / g, bg = b / g;
    return rg > 0.78 && rg < 1.10 && bg > 0.22 && bg < 0.78;
  };
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // 画面yにおける期待直径（FHD px）。遠近で線形に効く
  const expectDiam = yF => 0.0155 * (yF - YVP);

  // ---- フラッシュ検出 ----
  // マックスチャージの白フラッシュは7〜10フレーム続き、その間ボールは見えない。
  // 打点フレームを直接見つけるのは諦め、フラッシュ区間として印だけ付ける。
  function frameStats(img) {
    const d = img.data;
    let sum = 0, bright = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) {          // 4px間引き
      const L = lum(d[i], d[i + 1], d[i + 2]);
      sum += L; if (L > 225) bright++; n++;
    }
    return { meanL: sum / n, brightRatio: bright / n };
  }

  // ---- 連結成分 ----
  function components(mask, roi) {
    const { x0, y0, x1, y1 } = roi;
    const seen = new Uint8Array(W * H);
    const out = [];
    const stack = new Int32Array(W * H);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = y * W + x;
        if (!mask[idx] || seen[idx]) continue;
        let sp = 0; stack[sp++] = idx; seen[idx] = 1;
        let n = 0, sx = 0, sy = 0, bx0 = x, bx1 = x, by0 = y, by1 = y;
        const pts = [];
        while (sp) {
          const p = stack[--sp], py = (p / W) | 0, pxx = p - py * W;
          n++; sx += pxx; sy += py; pts.push(p);
          if (pxx < bx0) bx0 = pxx; if (pxx > bx1) bx1 = pxx;
          if (py < by0) by0 = py; if (py > by1) by1 = py;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = pxx + dx, ny = py + dy;
            if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
            const ni = ny * W + nx;
            if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; }
          }
        }
        const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
        out.push({ n, cx: sx / n, cy: sy / n, bw, bh, bx0, by0, fill: n / (bw * bh), pts });
      }
    }
    return out;
  }

  // ---- ボール候補の抽出 ----
  function candidates(img, opts = {}) {
    const test = opts.loose ? isBallLoose : isBall;
    const d = img.data;
    const roi = opts.roi || { x0: 20, y0: 0, x1: 940, y1: 470 };   // FHD x40-1880 / y0-940
    const mask = new Uint8Array(W * H);
    for (let y = roi.y0; y < roi.y1; y++) {
      for (let x = roi.x0; x < roi.x1; x++) {
        const i = (y * W + x) * 4;
        if (test(d[i], d[i + 1], d[i + 2])) mask[y * W + x] = 1;
      }
    }
    // 静止物の除去に使う「前フレームの同じマスク」。観客席・パラソル・金網の小片は動かないので
    // 前フレームとほぼ完全に重なる。ボールは 10〜32px/frame(FHD) 動くので重ならない。
    const prev = opts.prevMask || null;
    const ccs = components(mask, roi);
    const out = [];
    for (const c of ccs) {
      const yF = c.cy * SC;
      const dF = expectDiam(yF), d960 = dF / SC;
      const A = 0.785 * d960 * d960;
      if (c.n < 0.35 * A || c.n > 3.0 * A) continue;
      if (c.fill <= 0.42) continue;
      if (Math.max(c.bw, c.bh) > 3.0 * d960) continue;
      // CC全体の平均 r/g（ボール核は 0.94 前後。トレイルはこの帯の外に出る）
      let sr = 0, sg = 0;
      for (const p of c.pts) { const i = p * 4; sr += d[i]; sg += d[i + 1]; }
      const rgMean = sg > 0 ? sr / sg : 0;
      // トレイルと融合しているCCは、最もボール色に近い画素の重心を先端として採る
      let cx = c.cx, cy = c.cy, fused = false;
      if (Math.max(c.bw, c.bh) > 2.2 * Math.min(c.bw, c.bh) || c.n > 1.8 * A) {
        fused = true;
        let wsum = 0, wx = 0, wy = 0;
        for (const p of c.pts) {
          const py = (p / W) | 0, pxx = p - py * W, i = p * 4;
          const g = d[i + 1] || 1, rg = d[i] / g;
          const w = Math.max(0, 1 - Math.abs(rg - 0.95) / 0.12);
          if (w > 0) { wsum += w; wx += w * pxx; wy += w * py; }
        }
        if (wsum > 0) { cx = wx / wsum; cy = wy / wsum; }
      }
      let overlap = 0;
      if (prev) { let o = 0; for (const p of c.pts) if (prev[p]) o++; overlap = o / c.n; }
      out.push({ x: cx, y: cy, n: c.n, bw: c.bw, bh: c.bh, fill: c.fill, fused, d: d960, rg: rgMean, overlap });
    }
    out.mask = mask;
    return out;
  }

  // ---- 毎フレームの候補フィルタ（駆動側から呼ばれる差し替え点） ----
  // **静止物の除去をここでやってはいけない場合がある。** 実測（10-44-35 t=387.23〜387.53）で、
  // 弱いバウンド後に転がるボールは 1.5〜2px/frame しか動かず前フレームと 0.61〜0.79 重なる。
  // 「overlap>=0.6 なら静止物」で落とすと、**完全に見えているボールを19コマ連続で捨てる**。
  // それが「打点直後の0.2〜0.4秒が欠測する」の正体だった（オクルージョンでも色汚染でもない）。
  // 既定はネット帯の除去のみ。静止物の棄却は鎖の段階（spanの小ささ）で行う。
  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net;
    const ov = ctx.overlapMax;
    return cands.filter(c => {
      if (ov != null && c.overlap >= ov) return false;
      if (net && c.y >= net.y0 && c.y <= net.y1) return false;
      return true;
    });
  }

  // ---- トラッカ ----
  // 予測位置のゲート内で最近傍を採る。外れたら予測近傍を loose で再探索。
  // 実測の飛行中移動量は 10〜32 px/frame(FHD)、最長欠測は4フレーム。
  class Tracker {
    constructor() { this.pts = []; this.miss = 0; this.last = null; this.vel = { x: 0, y: 0 }; this.hist = []; this.pending = null; this.prevMask = null; this.net = null; }

    // ネットのメッシュは黄緑で r/g・b/g がボールとほぼ同じ帯に入る（実測で6/8フレームがネットに乗った）。
    // カメラがドリーするので静止物判定でも落ちない。**幾何で除外するしかない。**
    // court.js のカメラが取れていれば、ネット(Z=0)の画面上の帯を計算して丸ごと外す。
    setCamera(cam) {
      if (!cam || !cam.ok) { this.net = null; return; }
      const base = Court.toScreen(0, 0, cam).y;             // ネット下端（接地線）FHD
      const u = 1 / cam.c0;                                  // Z=0 での u
      const hpx = 0.91 * u / cam.Yc;                         // ネット高0.91mの画面高(FHD)
      this.net = { y0: (base - hpx * 1.25) / SC, y1: (base + 12) / SC };   // 960空間
    }

    // フラッシュ判定は**絶対閾値では不可**。砂コートは L>225 の画素が常時3.5%あり、
    // 「brightRatio > 0.03」だと全フレームがフラッシュ扱いになって追跡が一度も走らない（実測でこれを踏んだ）。
    // 直近フレームの中央値に対する跳ね上がりで見る。
    isFlash(st) {
      this.hist.push(st);
      if (this.hist.length > 30) this.hist.shift();
      if (this.hist.length < 6) return false;
      const br = this.hist.map(h => h.brightRatio).sort((a, b) => a - b);
      const ml = this.hist.map(h => h.meanL).sort((a, b) => a - b);
      const brMed = br[br.length >> 1], mlMed = ml[ml.length >> 1];
      return (st.brightRatio > Math.max(3 * brMed, brMed + 0.06)) || (st.meanL > mlMed * 1.25);
    }
    predict() {
      if (!this.last) return null;
      const k = this.miss + 1;
      return { x: this.last.x + this.vel.x * k, y: this.last.y + this.vel.y * k };
    }
    // img: 960x540 ImageData / t: 秒
    step(img, t) {
      const st = frameStats(img);
      if (this.isFlash(st)) { this.miss++; this.pts.push({ t, x: null, y: null, flash: true }); return null; }

      let cands = candidates(img, { prevMask: this.prevMask });
      this.prevMask = cands.mask;
      // 静止物（観客席・パラソル・金網の小片）は前フレームと重なる。ボールは重ならない。
      cands = cands.filter(c => c.overlap < 0.6);
      // ネットの帯は丸ごと除外。ボールがネット前後を通る一瞬は欠測になるが、補間で埋まる。
      if (this.net) cands = cands.filter(c => c.y < this.net.y0 || c.y > this.net.y1);
      const p = this.predict();
      let pick = null;
      if (p) {
        const gate = 30 + 6 * this.miss;                       // FHD 60 + 12*miss
        let best = null;
        for (const c of cands) {
          const dd = Math.hypot(c.x - p.x, c.y - p.y);
          if (dd > gate) continue;
          if (!best || dd < best.dd) best = { c, dd };
        }
        if (!best) {
          // 予測近傍だけ loose で再探索（打球オーラでボール色が転ぶケース）
          const r = 30;
          const roi = { x0: Math.max(20, (p.x - r) | 0), y0: Math.max(0, (p.y - r) | 0),
                        x1: Math.min(940, (p.x + r) | 0), y1: Math.min(470, (p.y + r) | 0) };
          if (roi.x1 > roi.x0 + 2 && roi.y1 > roi.y0 + 2) {
            for (const c of candidates(img, { loose: true, roi })) {
              const dd = Math.hypot(c.x - p.x, c.y - p.y);
              if (!best || dd < best.dd) best = { c, dd, loose: true };
            }
          }
        }
        pick = best ? best.c : null;
      } else {
        // トラック未確立時。1フレームだけの候補で確定すると背景ノイズに乗り移る（実測で踏んだ）。
        // 「2フレーム連続で妥当な移動量(3〜40px@960)で繋がる」ことを確認してから確定する。
        const score = c => (1 - Math.min(1, Math.abs(c.rg - 0.94) / 0.10)) * 2
                         + c.fill
                         + (1 - Math.min(1, Math.abs(c.bw - c.bh) / Math.max(c.bw, c.bh)));
        const sorted = cands.filter(c => !c.fused).sort((a, b) => score(b) - score(a)).slice(0, 6);
        let seeded = null;
        if (this.pending) {
          for (const c of sorted) {
            // 飛行中の実測移動量は 10〜32px/frame(FHD) = 5〜16px@960。
            // 下限を緩くするとカメラのドリーで数px動く静止物を掴んでしまう。
            const dd = Math.hypot(c.x - this.pending.x, c.y - this.pending.y);
            if (dd >= 5 && dd <= 40) { seeded = c; this.vel = { x: c.x - this.pending.x, y: c.y - this.pending.y }; break; }
          }
        }
        this.pending = sorted[0] || null;
        pick = seeded;
      }

      if (!pick) {
        this.miss++;
        this.pts.push({ t, x: null, y: null, flash: false });
        if (this.miss > 6) { this.last = null; this.vel = { x: 0, y: 0 }; }   // トラック打ち切り
        return null;
      }
      if (this.last) {
        const k = this.miss + 1;
        this.vel = { x: (pick.x - this.last.x) / k, y: (pick.y - this.last.y) / k };
      }
      this.last = pick; this.miss = 0;
      this.pts.push({ t, x: pick.x, y: pick.y, d: pick.d, fused: pick.fused, flash: false });
      return pick;
    }
    // 欠測を線形補間で埋める（6フレームまで）
    filled() {
      const p = this.pts.slice();
      for (let i = 0; i < p.length; i++) {
        if (p[i].x != null) continue;
        let a = i - 1; while (a >= 0 && p[a].x == null) a--;
        let b = i + 1; while (b < p.length && p[b].x == null) b++;
        if (a < 0 || b >= p.length || b - a > 7) continue;
        const w = (i - a) / (b - a);
        p[i] = { ...p[i], x: p[a].x + (p[b].x - p[a].x) * w, y: p[a].y + (p[b].y - p[a].y) * w, interp: true };
      }
      return p;
    }
  }

  // ---- イベント抽出 ----
  // 画面yの極大＝下向きから上向きへの反転。バウンドか打点のどちらか。
  // 打点はフラッシュ／急な速度変化を伴うので、それで切り分ける。
  function events(pts, opts = {}) {
    const win = opts.median ?? 5;
    const seq = pts.filter(p => p.x != null);
    if (seq.length < win + 4) return [];
    // 中央値平滑
    const ys = seq.map((p, i) => {
      const a = Math.max(0, i - (win >> 1)), b = Math.min(seq.length, i + (win >> 1) + 1);
      const s = seq.slice(a, b).map(q => q.y).sort((m, n) => m - n);
      return s[s.length >> 1];
    });
    const out = [];
    for (let i = 2; i < seq.length - 2; i++) {
      if (!(ys[i] >= ys[i - 1] && ys[i] >= ys[i + 1] && ys[i] > ys[i - 2] && ys[i] > ys[i + 2])) continue;
      // 反転の鋭さ（前後の傾きの差）。緩い極大はノイズとして落とす
      const vIn = ys[i] - ys[i - 2], vOut = ys[i + 2] - ys[i];
      if (vIn < 1.5 || vOut > -1.5) continue;
      const t = seq[i].t;
      // 種別判定は classifyEvents（見かけZの離脱速度）で行う。ここでは反転点を返すだけ。
      // 旧実装は白フラッシュの有無で hit/bounce を分けていたが、**白フラッシュはマックスチャージ完了の
      // 合図であって打点マーカーではない**ことが実測で確定したので撤去した（7例すべてで打点より前に出る）。
      out.push({ t, x: seq[i].x, y: seq[i].y, kind: null, vIn, vOut });
    }
    return out;
  }

  // ---- 全体最適な軌跡抽出（貪欲追跡の置き換え） ----
  // 貪欲な単一仮説トラッカは、最初に食いついた対象を離せず破綻する。
  // 実測でハマったのは **ハナチャンの頭の白い花**（花芯の黄色が960縮小でボール色の帯に入り、
  // キャラと一緒に10px/frameで滑らかに動くのでボールと区別がつかない）。
  // → 全フレームの候補を集めてから、動的計画法で最も滑らかな鎖を作り、
  //    「コートを大きく横断したか」で本物のボールを選ぶ。花はキャラの周りから離れないので落ちる。
  //
  // frames: [{ t, c: [[x,y,n,fill,rg], ...] }, ...]
  function buildChains(frames, opts = {}) {
    const maxStep = opts.maxStep ?? 18;      // 960空間の1フレーム最大移動量（FHD 36px）
    const maxGap = opts.maxGap ?? 6;
    const minLen = opts.minLen ?? 5;

    const byFrame = frames.map(() => []);
    frames.forEach((fr, f) => (fr.c || []).forEach(c => {
      const nd = { f, t: fr.t, x: c[0], y: c[1], n: c[2], fill: c[3], rg: c[4],
                   best: 1, prev: null, vel: null, used: false };
      byFrame[f].push(nd);
    }));
    const nodes = byFrame.flat();

    for (const nd of nodes) {
      for (let k = 1; k <= maxGap; k++) {
        const pf = nd.f - k;
        if (pf < 0) break;
        for (const p of byFrame[pf]) {
          const d = Math.hypot(nd.x - p.x, nd.y - p.y);
          if (d > maxStep * k) continue;
          if (d < 1.2 * k) continue;                       // ほぼ静止＝背景
          let pen = 0;
          if (p.vel) {
            const vx = (nd.x - p.x) / k, vy = (nd.y - p.y) / k;
            pen = Math.min(1.2, Math.hypot(vx - p.vel.x, vy - p.vel.y) / 10);
          }
          const sc = p.best + 1 - pen - (k - 1) * 0.35;
          if (sc > nd.best) {
            nd.best = sc; nd.prev = p; nd.vel = { x: (nd.x - p.x) / k, y: (nd.y - p.y) / k };
          }
        }
      }
    }

    const chains = [];
    const sorted = nodes.slice().sort((a, b) => b.best - a.best);
    for (const end of sorted) {
      if (end.used) continue;
      const path = [];
      // 祖先が既に使われていたら**その場で打ち切る**。鎖ごと捨てると取りこぼす
      // （実測: 10-44-35 の 383.90〜384.22 の正しい軌跡20点が丸ごと消え、383.79の打点がUNKNOWNになった）
      for (let nd = end; nd; nd = nd.prev) { if (nd.used) break; path.push(nd); }
      if (path.length < minLen) continue;
      path.reverse();
      path.forEach(nd => { nd.used = true; });
      const xs = path.map(p => p.x), ys = path.map(p => p.y);
      chains.push({
        pts: path.map(p => ({ t: p.t, f: p.f, x: p.x, y: p.y, n: p.n })),
        len: path.length, score: end.best,
        spanX: Math.max(...xs) - Math.min(...xs),
        spanY: Math.max(...ys) - Math.min(...ys),
        y0: Math.min(...ys), y1: Math.max(...ys),
      });
    }
    return chains.sort((a, b) => b.score - a.score);
  }

  // ボールらしい鎖を選ぶ。決め手は「ネットをまたいで大きく移動しているか」。
  // キャラ由来の偽物（花・装飾）は自陣側の狭い範囲から出ない。
  // **鎖の長さで選んではいけない**（実測: 花の鎖28コマ vs ボールの鎖13コマ で花が勝ってしまう）。
  // 決め手は ①塊の大きさ（実測 ボール nAvg=67〜109 / 花 nAvg=36）
  //          ②縦方向の運動（ボールは放物線を描いて上下する。キャラ付属物はほぼ水平にしか動かない）
  function pickBall(chains, opts = {}) {
    const net = opts.net;
    const scored = chains.map(ch => {
      const nAvg = ch.pts.reduce((a, p) => a + p.n, 0) / ch.len;
      const vertRatio = ch.spanY / Math.max(20, ch.spanX + ch.spanY);
      let s = Math.min(20, nAvg / 5) + ch.spanY * 0.12 + ch.len * 0.25 + vertRatio * 20;
      if (net && ch.y0 < net.y0 && ch.y1 > net.y1) s += 25;   // ネットをまたいだ＝確実にボール
      if (ch.spanY < 25) s -= 25;                              // ほぼ水平＝キャラ付属物
      return { ...ch, rank: s, nAvg: +nAvg.toFixed(1), vertRatio: +vertRatio.toFixed(2) };
    }).sort((a, b) => b.rank - a.rank);
    return scored;
  }

  // ボールの鎖は打点・ネット通過・オクルージョンで分断される。
  // 上位の鎖のうち時間的に重ならないものを並べて、1ラリー分の軌跡列にする。
  function ballSegments(ranked, opts = {}) {
    const minRank = opts.minRank ?? 28;
    const out = [];
    for (const ch of ranked) {
      if (ch.rank < minRank) break;
      const t0 = ch.pts[0].t, t1 = ch.pts[ch.pts.length - 1].t;
      if (out.some(o => t0 <= o.t1 && t1 >= o.t0)) continue;   // 時間が重なる鎖は捨てる
      out.push({ ...ch, t0, t1 });
    }
    return out.sort((a, b) => a.t0 - b.t0);
  }

  // ---- 着弾点（バウンド）の抽出 ----
  // 実測で分かったこと: バウンドの瞬間にボールの見え方が変わる（砂埃・向きの反転・打ちに来た選手で隠れる）ため、
  // **降下セグメントは着地点でそのまま途切れる**。反転を待たず「降下したまま終わった終端」を着弾点として採る。
  // 検証: 砂コート t=387.23 で終端 → ball-bounce.md の実測バウンド t≈387.20 と2フレーム差。
  // ---- 打点／バウンドの判別（エフェクトを一切使わない） ----
  // 原理（docs/rally-probe/discriminator.md で12件の人手ラベルにより検証）:
  //   テニスでは「打点で奥行きZの進行が反転し、バウンドでは反転しない」。
  //   地面平面ホモグラフィが返す見かけZは、ボールが高さ h にあると
  //       Z_app = Z_true + h * B(Z),   B(Z) = (c0 + c1*Z) / K
  //   だけカメラから遠い側へずれる（実測とは0.05m以内で一致）。
  //   イベント直後は打点もバウンドも dh/dt>0 なので見かけZ速度に +B*ḣ のバイアスが乗り、
  //   手前側と奥側で符号規約が食い違う。側 s で揃えてバイアスを引くと分離する。
  //   実測: 打点 qc=0.252〜1.078 / バウンド qc=-0.222〜+0.008 → しきい値0.15で判定できた11件が11件正解。
  //   **とびつき（エフェクト無し）でも効く**（387.55 のとびつき打点が qc=0.349 で正しく打点判定）。
  const HDOT = 0.07;      // イベント直後の典型的な上昇速度 [m/frame] ≒ 4 m/s
  const QTHRESH = 0.15;   // qc のしきい値 [m/frame]

  function zBias(Z, cam) { return (cam.c0 + cam.c1 * Z) / 2.796e-4; }

  function mergeTrack(segments) {
    const pts = [];
    segments.forEach((s, si) => s.pts.forEach(p => pts.push({ ...p, seg: si })));
    return pts.sort((a, b) => a.t - b.t);
  }

  function slopeZ(seq) {
    const n = seq.length; if (n < 3) return null;
    let sf = 0, sz = 0, sff = 0, sfz = 0;
    for (const p of seq) { sf += p.f; sz += p.Z; sff += p.f * p.f; sfz += p.f * p.Z; }
    const d = n * sff - sf * sf;
    return Math.abs(d) < 1e-9 ? null : (n * sfz - sf * sz) / d;
  }

  // イベント候補。**画面yの極大だけでは足りない**（実測: 弱いバウンドは反転せず減速するだけ、
  // 地面のボールを掬うとびつきも反転しない、奥側の打点は画面yがほとんど動かない）。
  // 見かけZ速度の折れ（kink）を主候補にし、鎖の端は補助にする。
  function eventCandidates(segments, track) {
    const out = [];
    for (const s of segments) {
      const p = s.pts; if (p.length < 4) continue;
      out.push({ t: p[p.length - 1].t, x: p[p.length - 1].x, y: p[p.length - 1].y, src: 'seg-end' });
      out.push({ t: p[0].t, x: p[0].x, y: p[0].y, src: 'seg-start' });
    }
    const W = 6;
    const sl = (a, b) => {
      let n = 0, sf = 0, sz = 0, sff = 0, sfz = 0;
      for (let i = a; i <= b; i++) {
        const p = track[i]; if (!p || !isFinite(p.Z)) continue;
        n++; sf += p.f; sz += p.Z; sff += p.f * p.f; sfz += p.f * p.Z;
      }
      if (n < 4) return null;
      const d = n * sff - sf * sf; return Math.abs(d) < 1e-9 ? null : (n * sfz - sf * sz) / d;
    };
    const kink = new Array(track.length).fill(0);
    for (let i = W; i < track.length - W; i++) {
      if (track[i + W].f - track[i - W].f > 3 * W) continue;   // 欠測が多すぎる区間は使わない
      const A = sl(i - W, i - 1), B = sl(i + 1, i + W);
      if (A != null && B != null) kink[i] = Math.abs(B - A);
    }
    for (let i = W; i < track.length - W; i++) {
      if (kink[i] < 0.18) continue;
      let isMax = true;
      for (let k = -3; k <= 3; k++) if (kink[i + k] > kink[i]) { isMax = false; break; }
      if (isMax) out.push({ t: track[i].t, x: track[i].x, y: track[i].y, src: 'kink' });
    }
    out.sort((a, b) => a.t - b.t);
    const merged = [];
    for (const e of out) {
      const last = merged[merged.length - 1];
      if (last && e.t - last.t < 0.12) {                       // 二重計上を潰す。kink を優先
        if (last.src !== 'kink' && e.src === 'kink') merged[merged.length - 1] = e;
        continue;
      }
      merged.push(e);
    }
    return merged;
  }

  // 打点時刻の精密化。**向きの変化が大きい軸で解く**（強打は画面yがほぼ動かず画面xだけ反転する）
  function refineTime(track, e) {
    const before = track.filter(p => p.t < e.t && p.t >= e.t - 0.14);
    const after = track.filter(p => p.t > e.t && p.t <= e.t + 0.30);
    if (before.length < 3 || after.length < 3) return e.t;
    const lin = (seq, key) => {
      const n = seq.length; let st = 0, sv = 0, stt = 0, stv = 0;
      for (const p of seq) { st += p.t; sv += p[key]; stt += p.t * p.t; stv += p.t * p[key]; }
      const d = n * stt - st * st; if (Math.abs(d) < 1e-9) return null;
      const a = (n * stv - st * sv) / d;
      return { a, b: (sv - a * st) / n };
    };
    let best = null;
    for (const key of ['x', 'y']) {
      const A = lin(before, key), B = lin(after, key);
      if (!A || !B) continue;
      const dv = Math.abs(A.a - B.a);
      if (dv < 60) continue;                                   // 傾きが実質変わらない軸は使わない (px/s)
      const tX = (B.b - A.b) / (A.a - B.a);
      if (!best || dv > best.dv) best = { dv, t: tX };
    }
    if (!best) return e.t;
    return (best.t > e.t - 0.30 && best.t < e.t + 0.30) ? best.t : e.t;
  }

  function classifyEvents(segments, camAt, opts = {}) {
    const margin = opts.margin ?? 0.6;
    const qth = opts.qThresh ?? QTHRESH;
    const track = mergeTrack(segments).map(p => {
      const cam = typeof camAt === 'function' ? camAt(p.t) : camAt;
      const c = cam && cam.ok ? Court.toCourt(p.x * SC, p.y * SC, cam) : { X: NaN, Z: NaN };
      return { ...p, X: c.X, Z: c.Z, cam };
    });
    const cands = eventCandidates(segments, track);
    const out = [];
    for (let i = 0; i < cands.length; i++) {
      const e = cands[i];
      const tEvt = refineTime(track, e);
      const at = track.reduce((b, p) => (!b || Math.abs(p.t - tEvt) < Math.abs(b.t - tEvt) ? p : b), null);
      if (!at || !at.cam || !at.cam.ok) { out.push({ t: tEvt, x: e.x, y: e.y, kind: 'unknown' }); continue; }
      const s = at.Z >= 0 ? 1 : -1;
      // 次のイベントの手前で打ち切る（打ち切らないとバウンド直後の打点を拾って誤判定する）
      const tStop = Math.min(tEvt + 0.50, (cands[i + 1] ? cands[i + 1].t : Infinity) - 0.06);
      // 入射脚との連続性ゲート（打撃バーストの塊を掴まないため）
      const gate = p => {
        const df = Math.max(1, (p.t - tEvt) * 60);
        return Math.hypot((p.x - at.x) * SC, (p.y - at.y) * SC) <= 40 * df + 40;
      };
      let seq = track.filter(p => p.t >= tEvt + 0.03 && p.t <= tStop && gate(p));
      if (seq.length >= 3 && seq[seq.length - 1].t - seq[0].t < 0.08)
        seq = track.filter(p => p.t >= tEvt + 0.03 && p.t <= Math.min(tEvt + 0.7, tStop) && gate(p));
      const dZ = slopeZ(seq);
      let kind = 'unknown', qc = null;
      if (dZ != null && seq.length >= 3) {
        qc = (-s * dZ) + s * zBias(at.Z, at.cam) * HDOT;
        kind = qc > qth ? 'hit' : 'bounce';
      }
      // 幾何の常識で上書き: 見かけZが |12.5| を超える点は地面ではありえない
      if (kind === 'bounce' && Math.abs(at.Z) > 12.5) kind = 'hit';
      out.push({
        t: tEvt, x: at.x, y: at.y, kind, qc: qc == null ? null : +qc.toFixed(3),
        side: s > 0 ? 'opp' : 'me',
        X: +at.X.toFixed(2), Z: +at.Z.toFixed(2),
        inCourt: Court.inCourt(at.X, at.Z, margin),
      });
    }
    return applyRallyRules(out);
  }

  // 構造制約で後始末（12イベントすべてで成立を確認した規則）
  //  1.打点は側が交替する 2.バウンドは「次に打つ側」で起きる
  //  3.同じ側の連続2イベントは (バウンド,打点) の順 4.打点と打点の間のバウンドは0個か1個
  function applyRallyRules(evs) {
    for (let i = 0; i < evs.length; i++) {
      const a = evs[i], b = evs[i + 1];
      if (a.kind === 'unknown' && b && b.kind === 'hit' && b.side === a.side) a.kind = 'bounce';
      if (a.kind === 'unknown' && b && b.kind === 'bounce' && b.side !== a.side) a.kind = 'hit';
      if (a.kind === 'bounce' && b && b.kind === 'bounce' && a.side !== b.side) a.kind = 'hit';
    }
    let prevHit = null;
    for (const e of evs) {
      if (e.kind !== 'hit') continue;
      if (prevHit && prevHit.side === e.side) e.suspect = 'same-side-hits';
      prevHit = e;
    }
    return evs;
  }

  // 後方互換。着弾点だけ欲しい場合
  function bounces(segments, camAt, opts = {}) {
    return classifyEvents(segments, camAt, opts).filter(e => e.kind === 'bounce');
  }

  // イベントをコート座標へ。cam は Court.estimate の結果（FHD基準）
  function toCourtEvents(evs, camAt) {
    return evs.map(e => {
      const cam = typeof camAt === 'function' ? camAt(e.t) : camAt;
      if (!cam || !cam.ok) return { ...e, X: null, Z: null };
      const c = Court.toCourt(e.x * SC, e.y * SC, cam);
      return { ...e, X: +c.X.toFixed(2), Z: +c.Z.toFixed(2), inCourt: Court.inCourt(c.X, c.Z) };
    });
  }

  // 変種実験（tools/variants/*.js）から差し替え・再利用できるよう内部関数も出す。
  return { W, H, SC, isBall, isBallLoose, expectDiam, frameStats, candidates, components, Tracker,
           buildChains, pickBall, ballSegments, classifyEvents, bounces, events, toCourtEvents, filterCandidates,
           eventCandidates, refineTime, applyRallyRules, mergeTrack, slopeZ, zBias, HDOT, QTHRESH };
})();
