// 観点C の結論を1本にまとめた変種。
// 「静止物棄却を毎フレームの overlap でやる」のをやめ、次の2段に置き換える。
//
//  ① 候補の段階 = 幾何ROI。奥ベースライン(Z=+11.885)の画面yを基準に、
//     u比 = (yFar-YVP)/(y-YVP) が 1.15 を超える帯（＝ベースラインより十分上の空・観客席・
//     背景構造物）を捨てる。カメラ未確定の間は y<34@960 (FHD y<68) の固定値で代用。
//     実測: 永続静止ブロブの 98%/100% がこの帯にいて、ボール点は 0% しかいない。
//     overlap と違い「ゆっくり転がるボール」を一切殺さない。
//
//  ② 鎖の段階 = 渡り歩き鎖の棄却。静止物由来の鎖は「1つの物体を追う」のではなく
//     複数の静止ブロブを縫って進むので、自分が10コマ以上前にいた場所(半径6px)へ戻る。
//     実測: 背景鎖 len=170 は revisit率 0.66、ボール鎖は全11本が 0.00。
//     ①だけで実測ベンチは同点だが、背景が画面下方まで来るコート用の保険として残す。
//
// 検証（tools/rally-bench.js・人手ラベル12件）:
//   現行(overlap<0.6)  found 5  correct 5  covered 10  coverMean 10.8 nearMean 0.427 false 26
//   本変種             found 11 correct 9  covered 11  coverMean 14.3 nearMean 0.531 false 25
(() => {
  const B = window.BallTrack;
  const YVP = -651, SC = 2;
  const UREL = 1.15;        // これ以上「奥」の帯は捨てる。1.10/1.12 は correct が1件落ちた
  const YFALL = 34;         // カメラ未確定時の固定上端（960空間）

  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net, cam = ctx.cam;
    let yTop = YFALL;
    if (cam && cam.ok) {
      const yFar = Court.toScreen(0, Court.Z_BASE, cam).y;      // FHD
      yTop = (((yFar - YVP) / UREL) + YVP) / SC;                // 960空間へ
    }
    return cands.filter(c => {
      if (net && c.y >= net.y0 && c.y <= net.y1) return false;  // ネット帯は従来どおり幾何で除外
      return c.y >= yTop;
    });
  }

  // 10コマ以上前の自分の位置(半径6px)へ戻った点の割合。本物のボールは常に0。
  function revisitRatio(pts) {
    if (pts.length <= 10) return 0;
    let rev = 0;
    for (let i = 10; i < pts.length; i++)
      if (pts.slice(0, i - 9).some(q => Math.hypot(q.x - pts[i].x, q.y - pts[i].y) < 6)) rev++;
    return rev / (pts.length - 10);
  }

  function pickBall(chains, opts = {}) {
    return B.pickBall(chains, opts).filter(ch => revisitRatio(ch.pts) <= 0.1);
  }

  window.BallTrack = Object.assign({}, B, { filterCandidates, pickBall, revisitRatio });
})();
