// SENSEKI SCAN ラリー解析ライブラリ（ブラウザ用・依存なし）
// Phase A: 得点HUDからポイント境界とスコアを取る。
// 座標はすべて 1920x1080 基準。Vision.cropRegion が videoWidth に応じて自動スケールする。
//
// 実測の根拠（2026-08-24・docs/rally-probe/deuce-pips.md ＋ 本ファイル作成時の再実測）:
//   ピップ中心x = 左 46.5+25k / 右 1722.5+25k（k=0..6・ピッチ25px・径約16px）
//   → 砂コート(1080p60 OBS) と ピンククレイ(1080p30 スマホ録画) の別コート・別fpsで完全一致。
//   デュース時は7スロットが「中央寄せ2スロット」に変わる（残りは斜めストライプ塗り）。
//   ポイント間はHUDが約2.58秒まるごと消灯し、画面下中央にスコアバナーが出る。
window.Rally = (() => {
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // ---- 認識領域（FHD基準） ----
  const REGIONS = {
    // 得点ピップのカプセル（外枠の黒縁を少し含む余裕をつけた矩形）
    pipL: { x: 19,   y: 991, w: 206, h: 42 },
    pipR: { x: 1695, y: 991, w: 206, h: 42 },
    // 大きな得点数字。「Adv.」は幅が桁違い（数字55-76px / Adv. 194-225px）なのでOCR不要
    numL: { x: 10,   y: 866, w: 330, h: 104 },
    numR: { x: 1580, y: 866, w: 330, h: 104 },
  };

  // カプセル原点からの相対座標（左右で共通になるよう REGIONS を取ってある）
  const PIP_REL_X0 = 27.5;   // 7スロットの1個目の中心
  const PIP_PITCH  = 25;
  const PIP_DUECE  = [90, 115]; // デュース時の2スロット中心（中央寄せ）
  const PIP_REL_CY = 20;
  const PIP_HW = 5, PIP_HH = 6;  // 判定窓の半幅・半高

  // ---- 色述語（HUD専用。コート面用の Vision.isYellow 等とは別物にすること）----
  // 砂コートの地面は Vision.isYellow を通ってしまうが、ここではカプセル内しか見ないので実害はない。
  const isPipYellow = (r, g, b) => r > 190 && g > 180 && b < 130;
  const isPipBlack  = (r, g, b) => lum(r, g, b) < 55;
  const isTintBlue  = (r, g, b) => b > 140 && b > r + 60 && g < 200;   // 自分側のピル/数字
  const isTintOrange= (r, g, b) => r > 180 && r > b + 90 && g < 160;   // 相手側のピル/数字

  // ---- 小物 ----
  function px(img, x, y) {
    const i = ((y | 0) * img.width + (x | 0)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  }

  // 判定窓の多数決。'Y'（点灯）/'K'（消灯）/null（ピップが無い＝ピル地かHUD消灯）
  function pipStateAt(img, cx, cy) {
    let y = 0, k = 0, n = 0;
    for (let dy = -PIP_HH; dy <= PIP_HH; dy++) {
      for (let dx = -PIP_HW; dx <= PIP_HW; dx++) {
        const x = Math.round(cx + dx), yy = Math.round(cy + dy);
        if (x < 0 || yy < 0 || x >= img.width || yy >= img.height) continue;
        const [r, g, b] = px(img, x, yy);
        n++;
        if (isPipYellow(r, g, b)) y++;
        else if (isPipBlack(r, g, b)) k++;
      }
    }
    if (!n) return null;
    // テニスボールの縫い目で黄が欠けるので閾値は緩め。黒は縁取りに食われないので厳しめ。
    if (y / n >= 0.40) return 'Y';
    if (k / n >= 0.55) return 'K';
    return null;
  }

  // カプセル内のピル地色（青/橙）の占有率。HUDの在否とデュース判定の裏取りに使う。
  function tintFill(img, side) {
    const test = side === 'L' ? isTintBlue : isTintOrange;
    let hit = 0, n = 0;
    for (let y = 4; y < img.height - 4; y++) {
      for (let x = 4; x < img.width - 4; x++) {
        const [r, g, b] = px(img, x, y);
        n++; if (test(r, g, b)) hit++;
      }
    }
    return n ? hit / n : 0;
  }

  // 大きな数字の横幅。「Adv.」は幅が桁違いなのでこれだけで判別できる（OCR不要）。
  function numberWidth(img, side) {
    const test = side === 'L' ? isTintBlue : isTintOrange;
    let lo = 1e9, hi = -1;
    for (let x = 0; x < img.width; x++) {
      let c = 0;
      for (let y = 0; y < img.height; y++) {
        const [r, g, b] = px(img, x, y);
        if (test(r, g, b)) c++;
      }
      if (c >= 6) { if (x < lo) lo = x; if (x > hi) hi = x; }
    }
    return hi < 0 ? 0 : hi - lo + 1;
  }

  // ---- 片側の得点HUDを読む ----
  // 返り値 { present, mode:'normal'|'deuce', lit, adv, fill, numW }
  function readSide(video, side) {
    const cap = Vision.cropRegion(video, side === 'L' ? REGIONS.pipL : REGIONS.pipR);
    const fill = tintFill(cap, side);

    const s7 = [];
    for (let k = 0; k < 7; k++) s7.push(pipStateAt(cap, PIP_REL_X0 + PIP_PITCH * k, PIP_REL_CY));
    const s2 = PIP_DUECE.map(x => pipStateAt(cap, x, PIP_REL_CY));

    const n7 = s7.filter(Boolean).length;
    const n2 = s2.filter(Boolean).length;

    // 7スロットが揃っていれば通常。揃わず2スロットだけ立つならデュース。
    // 「0点」と「デュース0点」はどちらも黄0個なので、点灯数ではなくスロット構成で先に決める。
    let mode = null;
    if (n7 === 7) mode = 'normal';
    else if (n2 === 2 && n7 <= 4) mode = 'deuce';

    if (!mode) return { present: false, mode: null, lit: 0, adv: false, fill, numW: 0, slots: s7 };

    const num = Vision.cropRegion(video, side === 'L' ? REGIONS.numL : REGIONS.numR);
    const numW = numberWidth(num, side);

    if (mode === 'normal') {
      return { present: true, mode, lit: s7.filter(v => v === 'Y').length, adv: false, fill, numW, slots: s7 };
    }
    // デュース: 左のピップだけ黄ならその側がアドバンテージ
    return { present: true, mode, lit: 0, adv: s2[0] === 'Y', fill, numW, slots: s2 };
  }

  // ---- 1フレーム分のHUD ----
  function readHud(video) {
    const L = readSide(video, 'L'), R = readSide(video, 'R');
    return { hudOn: L.present && R.present, L, R };
  }

  // 2つのHUD状態が「同じ得点状況」か
  function sameScore(a, b) {
    if (!a || !b) return false;
    return a.L.mode === b.L.mode && a.L.lit === b.L.lit && a.L.adv === b.L.adv
        && a.R.mode === b.R.mode && a.R.lit === b.R.lit && a.R.adv === b.R.adv;
  }

  function scoreLabel(h) {
    if (!h || !h.hudOn) return '—';
    if (h.L.mode === 'deuce') {
      if (h.L.adv) return 'Adv.(自分)';
      if (h.R.adv) return 'Adv.(相手)';
      return 'デュース';
    }
    return `${h.L.lit} - ${h.R.lit}`;
  }

  // ---- 時間軸の走査 ----
  // 指定区間を step 秒刻みで舐めて、HUDの在否と得点の系列を作る。
  async function sampleTimeline(video, { t0, t1, step = 0.2, onProgress } = {}) {
    const seek = Vision.makeSeeker(video);
    const out = [];
    for (let t = t0; t <= t1; t += step) {
      await seek(t);
      const h = readHud(video);
      out.push({ t: +t.toFixed(3), hudOn: h.hudOn, L: h.L, R: h.R });
      if (onProgress) onProgress(t, t1);
    }
    return out;
  }

  // HUD消灯区間の端を、細かい刻みで詰める（境界時刻の精度を上げる）
  async function refineEdge(video, tOn, tOff, step) {
    const seek = Vision.makeSeeker(video);
    let lo = tOn, hi = tOff;                 // lo=点いている / hi=消えている
    while (hi - lo > step) {
      const m = (lo + hi) / 2;
      await seek(m);
      if (readHud(video).hudOn) lo = m; else hi = m;
    }
    return hi;
  }

  // ---- ポイント境界の抽出 ----
  // 「点灯ピップ数の増加」で数えてはいけない。デュースで数が減り、Adv.で数字が消え、
  // コイン演出で黄色が湧く。代わりに HUD の消灯区間そのものをポイント境界とする。
  const GAP_MIN = 1.2, GAP_MAX = 4.5;   // 秒。これを外れるものは演出/ゲーム間/試合終了として別扱い

  function buildPoints(timeline, { gapMin = GAP_MIN, gapMax = GAP_MAX } = {}) {
    const gaps = [];
    let i = 0;
    while (i < timeline.length) {
      if (timeline[i].hudOn) { i++; continue; }
      const s = i;
      while (i < timeline.length && !timeline[i].hudOn) i++;
      gaps.push({ i0: s, i1: i - 1, t0: timeline[s].t, t1: timeline[i - 1].t });
    }

    const boundaries = gaps.map(g => ({ ...g, dur: +(g.t1 - g.t0).toFixed(3) }))
                           .map(g => ({ ...g, kind: (g.dur >= gapMin && g.dur <= gapMax) ? 'point' : 'other' }));

    // 各境界の直後で得点を読み、直前の得点と比べて「どちらが取ったか」を決める。
    // HUDの復帰はフェードインなので、ピップが立っていても数字がまだ描かれていないフレームがある
    // （実測: 次の試合の開始直後に numW=0 のまま 0-0 と読めてしまい偽のポイントになった）。
    // → 数字が読める幅になっているフレームまで進めてから採用する。
    const NUM_MIN_W = 30;
    const usable = x => x.hudOn && x.L.numW >= NUM_MIN_W && x.R.numW >= NUM_MIN_W;
    const stateAt = idx => {
      for (let k = idx; k < timeline.length; k++) if (usable(timeline[k])) return timeline[k];
      return null;
    };
    const stateBefore = idx => {
      for (let k = idx; k >= 0; k--) if (usable(timeline[k])) return timeline[k];
      return null;
    };

    const points = [];
    let prevGapEnd = null;
    for (const b of boundaries) {
      if (b.kind !== 'point') { prevGapEnd = b.t1; continue; }
      const before = stateBefore(b.i0 - 1);
      const after = stateAt(b.i1 + 1);
      const winner = whoScored(before, after);
      const sb = before ? scoreLabel(before) : '—';
      const sa = after ? scoreLabel(after) : '—';
      // 得点が動いていない境界はポイントではない（試合の切り替わり・ウォームアップ・演出）
      let flag = null;
      if (!before || !after) flag = 'unreadable';
      else if (sb === sa) flag = 'no-score-change';
      else if (!winner) flag = 'winner-unknown';
      if (flag) { b.kind = 'other'; b.reason = flag; prevGapEnd = b.t1; continue; }
      points.push({
        // ラリーの始まり = 前の境界でHUDが戻った時刻（サーブ構えの分だけ後ろにずれる）
        rallyStart: prevGapEnd,
        rallyEnd: b.t0,   // HUDが消えた＝ポイント確定
        gapEnd: b.t1,
        before, after, scoreBefore: sb, scoreAfter: sa, winner,
      });
      prevGapEnd = b.t1;
    }
    return { points, boundaries };
  }

  // 得点した側を、前後の状態の差分から決める
  function whoScored(a, b) {
    if (!a || !b || !a.hudOn || !b.hudOn) return null;
    const A = a.L.mode, B = b.L.mode;
    if (A === 'normal' && B === 'normal') {
      if (b.L.lit > a.L.lit) return 'me';
      if (b.R.lit > a.R.lit) return 'opp';
      return null;
    }
    if (A === 'normal' && B === 'deuce') {
      // 5-6 → 6-6 など。増えた側が取った
      if (a.L.lit < 6) return 'me';
      if (a.R.lit < 6) return 'opp';
      return null;
    }
    if (A === 'deuce' && B === 'deuce') {
      if (!a.L.adv && !a.R.adv) return b.L.adv ? 'me' : (b.R.adv ? 'opp' : null);  // デュース→アド
      if (a.L.adv && !b.L.adv && !b.R.adv) return 'opp';                            // 自分のアドが消えた
      if (a.R.adv && !b.L.adv && !b.R.adv) return 'me';
      return null;
    }
    return null;
  }

  // 決め球（そのポイントを終わらせたショット）のおおよその時刻。
  // 実測: 決め球 t=295.8 → HUD消灯 t=297.20（1.4秒前）。球の飛行時間ぶん変動する。
  function winnerShotWindow(point) {
    return { from: point.rallyEnd - 2.5, to: point.rallyEnd - 0.4 };
  }

  // ---- まとめ: 区間を渡すとポイント一覧を返す ----
  async function scanPoints(video, opts = {}) {
    const timeline = await sampleTimeline(video, opts);
    const { points, boundaries } = buildPoints(timeline, opts);
    return { timeline, points, boundaries };
  }

  return {
    REGIONS, readHud, readSide, scanPoints, sampleTimeline, buildPoints,
    refineEdge, scoreLabel, whoScored, winnerShotWindow,
    _px: { isPipYellow, isPipBlack, isTintBlue, isTintOrange },
  };
})();
