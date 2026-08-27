// 参照用の最小変種: 静止物フィルタ(overlap)を外し、ネット帯の除去だけ残す。
// 「毎フレームの静止物棄却がボールを殺している」ことの下限を示すための対照実験。
(() => {
  const B = window.BallTrack;
  window.BallTrack = Object.assign({}, B, {
    filterCandidates(cands, ctx = {}) {
      const net = ctx.net;
      return cands.filter(c => !(net && c.y >= net.y0 && c.y <= net.y1));
    },
  });
})();
