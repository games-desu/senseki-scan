// 1フレームの1点を突く診断ツール。「なぜこのボールが検出されないか」を段階ごとに答える。
//
//   node tools/rally-probe.js <video> <t> <xFHD> <yFHD> [--r 30]
//
// 出す情報:
//   patch    その周辺の代表RGBと r/g, b/g（960空間）
//   mask     isBall / isBallLoose を通る画素数
//   cc       その場所の連結成分と、candidates() のどのゲートで落ちたか
const path = require('path');
const { loadModules, frames } = require('./rally-node.js');

const W = 960, SC = 2;

async function main() {
  const a = process.argv.slice(2);
  const video = a[0], t = +a[1], xF = +a[2], yF = +a[3];
  const rI = a.indexOf('--r'), R = rI >= 0 ? +a[rI + 1] : 30;
  const { BallTrack } = loadModules();
  const x0 = Math.round(xF / SC), y0 = Math.round(yF / SC);

  let img = null;
  for await (const fr of frames(video, t, t + 0.02, 60)) { img = fr.img; break; }
  if (!img) { console.error('no frame'); process.exit(1); }
  const d = img.data;

  // --- 周辺の画素統計 ---
  const px = [];
  for (let y = y0 - R; y <= y0 + R; y++) for (let x = x0 - R; x <= x0 + R; x++) {
    if (x < 0 || y < 0 || x >= 960 || y >= 540) continue;
    const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    px.push({ x, y, r, g, b, rg: r / (g || 1), bg: b / (g || 1),
              ball: BallTrack.isBall(r, g, b), loose: BallTrack.isBallLoose(r, g, b) });
  }
  const bright = px.slice().sort((p, q) => q.g - p.g).slice(0, 12);
  const nBall = px.filter(p => p.ball).length, nLoose = px.filter(p => p.loose).length;

  // --- CC を素で取り直して、どのゲートで落ちたかを見る ---
  const roi = { x0: Math.max(0, x0 - R), y0: Math.max(0, y0 - R),
                x1: Math.min(960, x0 + R), y1: Math.min(540, y0 + R) };
  const report = [];
  for (const test of ['isBall', 'isBallLoose']) {
    const mask = new Uint8Array(960 * 540);
    for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
      const i = (y * W + x) * 4;
      if (BallTrack[test](d[i], d[i + 1], d[i + 2])) mask[y * W + x] = 1;
    }
    const ccs = BallTrack.components(mask, roi);
    const dF = BallTrack.expectDiam(yF), d960 = dF / SC, A = 0.785 * d960 * d960;
    report.push({
      test, expectDiam960: +d960.toFixed(2), expectArea: +A.toFixed(1),
      ccs: ccs.map(c => {
        const gates = [];
        if (c.n < 0.35 * A) gates.push(`n<0.35A (${c.n}<${(0.35 * A).toFixed(0)})`);
        if (c.n > 3.0 * A) gates.push(`n>3A (${c.n}>${(3 * A).toFixed(0)})`);
        if (c.fill <= 0.42) gates.push(`fill<=0.42 (${c.fill.toFixed(2)})`);
        if (Math.max(c.bw, c.bh) > 3.0 * d960) gates.push(`dim>3d (${Math.max(c.bw, c.bh)}>${(3 * d960).toFixed(1)})`);
        return { n: c.n, cx: +c.cx.toFixed(1), cy: +c.cy.toFixed(1), bw: c.bw, bh: c.bh,
                 fill: +c.fill.toFixed(2), dist: +Math.hypot(c.cx - x0, c.cy - y0).toFixed(1),
                 rejected: gates.length ? gates : null };
      }).sort((p, q) => p.dist - q.dist).slice(0, 6),
    });
  }
  // --- 実際に candidates() が返すもの ---
  const cands = BallTrack.candidates(img).filter(c => Math.hypot(c.x - x0, c.y - y0) < R * 1.6);

  console.log(JSON.stringify({
    t, target960: [x0, y0], targetFHD: [xF, yF],
    brightest: bright.map(p => `(${p.x},${p.y}) rgb=${p.r},${p.g},${p.b} rg=${p.rg.toFixed(3)} bg=${p.bg.toFixed(3)} ball=${p.ball} loose=${p.loose}`),
    maskCount: { isBall: nBall, isBallLoose: nLoose, ofPx: px.length },
    report,
    candidatesNearby: cands.map(c => ({ x: +c.x.toFixed(1), y: +c.y.toFixed(1), n: c.n, fill: +c.fill.toFixed(2), rg: +c.rg.toFixed(3), fused: c.fused })),
  }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
