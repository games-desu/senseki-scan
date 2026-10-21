// 交互が崩れた二重の打点を捨てる（2026-10-21・実験場 samples/rally/exp-dup から採用）
//   ゲーム仕様（docs/game-mechanics.md「打つ順番」）: シングルスのラリーは必ず自分→相手と交互。同じ側が続くのは余分か側の取り違え。
//   apply(rally, opts) → 捨てた打点の配列（規則 D）。applySame(rally, opts) → 同（規則 E）。
//   どちらも Flash.apply の後・shotcolor の前に掛ける（閃光で足した打点も前後の並びに入れて見る）。DUPFIX=0 / DUPSAME=0 で外せる。
// 規則 D の根拠: 手直し GT 8 組＋a151815（2026-09-06 15-18-15 の 17 ポイント）で、検出が反対側どうし 0.25 秒以内に並ぶ組は 16 組。
//   両方とも本物なのは 3 組だけ（a151815 123.73o/123.87m・401.32o/401.51m・n0908b 265.70o/265.80m）。
//   片方が余分の組では、余分な方は「その先（後ろの打点なら次・前の打点なら前）の打点と同じ側」になる（打った球の続きを反対側として拾った）。
//   本物どうしの 3 組は前後とも交互に並ぶ。
// 規則 D: 反対側どうしで間が W 以内の a→b について、p＝a の前・n＝b の次として
//   b だけが崩れている（n が b と同じ側・p は a と反対側か無い）→ b を捨てる
//   a だけが崩れている（p が a と同じ側・n は b と反対側か無い）→ a を捨てる
//   どちらとも言えない（両方崩れる・両方交互）は残す。サーブは捨てない。
const P = { W: 0.25, NB: Infinity };   // NB: 同じ側の隣との間隔の上限（秒）
function apply(rally, opts = {}) {
  const W = opts.W ?? P.W, NB = opts.NB ?? P.NB;
  const out = [];
  if (!rally || rally.length < 2) return out;
  let i = 0;
  while (i < rally.length - 1) {
    const a = rally[i], b = rally[i + 1];
    if (a.side === b.side || b.t - a.t > W) { i++; continue; }
    const p = rally[i - 1], n = rally[i + 2];
    const bBad = !!n && n.side === b.side && n.t - b.t <= NB && (!p || p.side !== a.side);
    const aBad = !!p && p.side === a.side && a.t - p.t <= NB && (!n || n.side !== b.side);
    let k = -1;
    if (bBad && !aBad && !b.serve) k = i + 1;
    else if (aBad && !bBad && !a.serve) k = i;
    if (k < 0) { i++; continue; }
    const [x] = rally.splice(k, 1);
    out.push({ t: x.t, side: x.side, cls: x.cls, src: x.src, by: 'dupOpp', vs: +(k === i ? b.t : a.t).toFixed(3) });
    if (i > 0) i--;
  }
  return out;
}

// 規則 E（様子見つき）: 相手側で同じ側が 0.9 秒以内に続く a→b のうち、a が「奥の浅い拾い」なら a を捨てる
//   根拠: 手直し GT 8 組＋a151815 の 0.9 秒以内の同じ側の対（49 対・両方本物で間に見逃しを挟むものは 0）のうち、閃光・launch・far 単独を除く 26 対では、
//   相手側どうしで前が余分の例が多く、余分の方は奥（Z ≥ 19）で nMax が小さく far 寄せが無い。本物の方は nMax が大きく far-turn/appear や suspect が付きやすい。
//   条件: 両方 trail・a.side=b.side=opp・b.t-a.t ≤ G・a.from.Z ≥ ZA・a.nMax < NA・a に farFix 無し・b.nMax ≥ R×a.nMax・a はサーブでない
//   注意: 効いた 6 件中 5 件が n0908b。閾値は 26 対からの目分量。
const PS = { G: 0.9, ZA: 19, NA: 2000, R: 2 };
function applySame(rally, opts = {}) {
  const G = opts.G ?? PS.G, ZA = opts.ZA ?? PS.ZA, NA = opts.NA ?? PS.NA, R = opts.R ?? PS.R;
  const out = [];
  if (!rally || rally.length < 2) return out;
  for (let i = 0; i < rally.length - 1; i++) {
    const a = rally[i], b = rally[i + 1];
    if (a.side !== 'opp' || b.side !== 'opp' || b.t - a.t > G) continue;
    if (a.src !== 'trail' || b.src !== 'trail' || a.serve || a.farFix) continue;
    const Z = a.from && a.from.Z;
    if (!(Z >= ZA) || !(a.nMax < NA) || !(b.nMax >= R * a.nMax)) continue;
    const [x] = rally.splice(i, 1);
    out.push({ t: x.t, side: x.side, cls: x.cls, src: x.src, by: 'dupSame', vs: +b.t.toFixed(3) });
    i--;
  }
  return out;
}
module.exports = { apply, P, applySame, PS };
