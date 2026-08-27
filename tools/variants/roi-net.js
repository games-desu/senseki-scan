// 候補フィルタの作り直し（担当3）。差し替えるのは filterCandidates だけ。
// candidates / buildChains / pickBall / ballSegments には一切触らない。
//
// 置き換えるのは2つ。
//
// ① 静止物の棄却を「1コマの重なり率(overlap>=0.6)」から「幾何ROI」へ。
//    overlap は本質的に `1 − 移動量/見かけ直径` でしかなく、ボールが
//    (a)打点/バウンド直後で減速している (b)山なりの頂点にいる (c)カメラ軸方向に飛ぶ
//    (d)手前で大きく写る のいずれでも 0.6 を超える。実測では12ラベル全件が被害を受け、
//    検証済みボール点 530コマ中 115コマ(21.7%) が「完全に見えているのに」消えていた。
//    代わりに、奥ベースライン(Z=+11.885)の画面yを基準にした u比
//        u比 = (yFar - YVP) / (y - YVP)
//    が UREL を超える帯（＝ベースラインより上の空・観客席・背景構造物）を捨てる。
//    カメラは現行の15フレームおきの推定で足りる（毎フレーム推定は 2.7倍遅くなるので不可）。
//    これは「動いていないこと」を一切見ないので、転がるボールもロブの頂点も殺さない。
//
// ② ネット帯の**丸ごと除外を撤廃**する。
//    現行は base-1.25*netH 〜 base+12 (FHD) の実測 136 FHD px を消しており、
//    ネット越え1回でボールが8〜13コマ連続で殺される。
//    そもそもネットのメッシュは g=125〜141 で isBall の g>=160 に届かないので候補にならない。
//    帯を全開にした状態のタイルを 4コート・3解像度で目視し、メッシュ上に候補が1つも
//    出ないことを確認した（砂/赤クレイ/茶ネット、1080p/1440p/720p）。帯は過剰防衛だった。
//    帯の中に残る非ボール候補の正体は「白いネットテープ」と「白線の細片」なので、
//    そこだけを形と色で落とす（下の BAND_RG / BAND_ELONG）。
//
// ③ 準重複フレーム(22-02-04 で 10.9%)とボール描画のスタッター(6.3秒で12回・overlap が
//    ちょうど1.00になる)は**構造的に踏まない**。本変種は overlap も「動いていない量」も
//    フレーム間距離も一切参照しないため。
//
// 検証（tools/rally-bench.js・人手ラベル12件・すべて実測）:
//   現行(overlap<0.6)  found  5 correct  5 covered 10 coverMean 10.8 nearMean 0.427 onBall  9 false 26
//   no-static(対照)    found 11 correct  9 covered 11 coverMean 13.4 nearMean 0.516 onBall 10 false 25
//   本変種             found 11 correct  9 covered 12 coverMean 17.4 nearMean 0.624 onBall 10 false 29
(() => {
  const B = window.BallTrack;
  const YVP = -651, SC = 2;

  // --- ① ROI ---
  // 奥ベースラインより「奥」をどこまで許すか。1.15 が下限。
  // 実測: 1.13/1.10 は correct が 9→8 に落ちる（ロブの頂点が削れる）。
  //       1.20/1.25 は coverMean が +0.1 しか増えず falseEvents が 29→31 に増える。
  const UREL = 1.15;
  // カメラが1度も解けていない間の固定上端（960空間）。実測の yTop は 21〜46 に収まる。
  const YFALL = 34;
  // 壊れたカメラ推定で ROI がコートを食い荒らさないための上限（960空間 = FHD 120）。
  // 正常時の yTop 最大は実測 46.2 なので通常は発火しない、純粋な保険。
  const YCAP = 60;
  // 直近何回分のカメラ解に対して yTop の最小値（＝最も緩い側）を採るか。
  // カメラは15フレームおきなので 3 で約0.75秒。実測で yTop は1回の再推定で 25.4→42.8 と
  // 17px 跳ねることがあり、その瞬間にロブ頂点のボールを落とす。最小値なら境界が跳ねない。
  const YT_KEEP = 3;

  // --- ② ネット帯に残す/落とすもの ---
  // 「白い（CC平均 r/g が 1.0 近辺）かつ細長い」＝ネットテープ・白線の細片だけを落とす。
  // 実測（帯内の候補を参照軌跡と突合・10-44-35 と 22-02-04 の 780コマ）:
  //   帯内のボール 51点の縦横比は最大 2.60（トレイルと融合した分）なので 3.0 なら巻き添えゼロ。
  //   非ボール 187点のうち 99点(53%)を除去できる。
  // **丸い白い塊は落とさない。** 落とすと数字上は coverMean 17.4→18.3 に上がるが、
  // 中身を追うと「本物のボール点(383.9167 rg=1.004 / 383.95 rg=0.993)を消したせいで
  // 悪い鎖が切れて良い鎖が勝った」だけで、22-02-04 では逆に炎エフェクトで白飛びした
  // 本物のボール区間(120.52〜120.67)を丸ごと落とす。過適合なので採らない（報告参照）。
  const BAND_RG = 0.99;
  const BAND_ELONG = 3.0;

  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net, cam = ctx.cam;
    const st = ctx.state || {};

    let yTop = YFALL;
    if (cam && cam.ok && typeof Court !== 'undefined') {
      const yFar = Court.toScreen(0, Court.Z_BASE, cam).y;          // FHD
      const y = (((yFar - YVP) / UREL) + YVP) / SC;                 // 960空間へ
      if (isFinite(y)) {
        if (!st.ytHist) st.ytHist = [];
        st.ytHist.push(y);
        if (st.ytHist.length > YT_KEEP) st.ytHist.shift();
      }
    }
    if (st.ytHist && st.ytHist.length) yTop = Math.min.apply(null, st.ytHist);
    if (yTop > YCAP) yTop = YCAP;

    return cands.filter(c => {
      // overlap（毎フレームの静止物フィルタ）は参照しない。ctx.overlapMax は意図的に無視する。
      if (c.y < yTop) return false;
      if (net && c.y >= net.y0 && c.y <= net.y1) {
        const lo = Math.max(1, Math.min(c.bw, c.bh));
        if (c.rg >= BAND_RG && Math.max(c.bw, c.bh) / lo >= BAND_ELONG) return false;
      }
      return true;
    });
  }

  window.BallTrack = Object.assign({}, B, { filterCandidates });
})();
