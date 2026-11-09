// 交互の穴埋め（2026-11-06・方針B 2 サイクル目）。ラリーは必ず交互（ユーザー直伝）。スライド・とびつきの返球はトレイルに色が付かない（docs/game-mechanics.md）が、
// 飛んでくる球の色つきトレイルは自分の体のところで切れるので（目視: a151815 618.27・643.73）、その切れ目を自分の打点として足す（src 'gap-trail'・種別 slide）。
//   flipNext: 相手→自分で、自分の打点が切れ目より遅く、0.6 秒超あり、しかも自分の奥の定位置でない所（cZ0 > -4.5）から出ているとき（位置の無い打点は戻さない: s0908 p6 154.22 は本当に自分）。
//     自分のスライドを見逃すと、次の相手の打点が交互の整合で「自分」に押される（a151815 627.10・679.23）ので、足した上でその打点を相手に戻す（種別は unknown・clsGap に元の種別）。
//   fillOppOpp: 相手→相手のとき。切れ目に自分の打点を足すだけ。
// 結果: a151815 314/97/229 → 323/95/236（見つけた/余分/種別）。閾値は同じ GT を見て決めたので伸びは割り引く。発火は 7 本とも第 4 試合で、他の GT・ホールドアウト・全体走 exp-sv42 では 0。別の試合での当たりは確かめられていない（docs「方針Bの2サイクル目」）。
// 足す打点の種別は slide（ユーザー判断 2026-11-06）。切れ目には色なしの返球の根拠があるので、見送り中の他のスライド規則とは別扱い。GAPFILL=0 で外せる。
const COLORED = new Set(['topspin', 'slice', 'flat', 'fever']);
const P = { minDisp: 100, minN: 8, minAfterO: 0.35, maxAfterO: 1.15, minTailZ: 10, maxZMin: 3, minBeforeOpp: 0.5, minBeforeMe: 0.6, flipCZ0: -4.5 };

// O の後で N より前に切れた、自分の半面まで伸びた長い色つき run の切れ目。無ければ null
function cut(runs, O, N, margin) {
  const between = runs.filter(u => u.t1 > O.t + 0.15 && u.t1 < O.t + 1.8 && u.t1 < N.t - margin);
  if (!between.length) return null;
  const last = between.reduce((a, b) => (a.t1 > b.t1 ? a : b));
  const afterO = last.t1 - O.t;
  if (afterO < P.minAfterO || afterO > P.maxAfterO || last.disp < P.minDisp || last.n < P.minN) return null;
  if (!last.tail || last.tail.Z == null || last.tail.Z < P.minTailZ || last.zMinAll == null || last.zMinAll > P.maxZMin) return null;
  return last;
}
const hit = u => ({ t: u.t1, side: 'me', cls: 'slide', src: 'gap-trail', gap: { disp: u.disp, n: u.n, zMin: u.zMinAll } });

function apply(rally, trailRuns) {
  if (!rally || !trailRuns) return [];
  const runs = trailRuns.filter(u => u.side === 'opp' && COLORED.has(u.cls) && u.dir === 'down' && u.disp >= 20 && u.straight >= 0.7 && u.sMax >= 0.3 && u.n >= 4);
  const log = [];
  // flipNext を先に: 戻した相手打点の後に相手→相手の穴ができることがある
  for (const pass of ['flip', 'fill']) {
    const R = rally.slice().sort((a, b) => a.t - b.t), add = [];
    for (let i = 0; i + 1 < R.length; i++) {
      const O = R[i], N = R[i + 1];
      if (O.side !== 'opp') continue;
      if (pass === 'flip' && N.side === 'me' && N.cZ0 != null && N.cZ0 > P.flipCZ0) {
        const u = cut(runs, O, N, 0);
        if (!u || N.t - u.t1 <= P.minBeforeMe) continue;
        add.push(hit(u)); N.clsGap = N.cls; N.side = 'opp'; N.cls = 'unknown'; N.sideGap = 'me';
        log.push({ t: u.t1, flip: N.t });
      } else if (pass === 'fill' && N.side === 'opp') {
        const u = cut(runs, O, N, 0.15);
        if (!u || N.t - u.t1 < P.minBeforeOpp) continue;
        add.push(hit(u)); log.push({ t: u.t1 });
      }
    }
    rally.push(...add);
    rally.sort((a, b) => a.t - b.t);
  }
  return log;
}
module.exports = { apply };
