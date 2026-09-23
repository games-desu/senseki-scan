// SENSEKI SCAN ラリー解析: トレイル（Phase D）とボール追跡（Phase C）の融合（ブラウザ用・依存: Court があれば座標も出す）
//   RallyFuse.fuse({ shots, events, track, camAt, t0, t1 }) → { shots: [...] }
//
//  方針（2026-09-07）:
//   - 打点（誰が・いつ・何を打ったか）は **トレイルの出現** を正とする。トレイルは打点の +0.02〜0.05秒で立ち上がり
//     0.32秒以上残るので取りこぼしにくく、色がそのまま種別になる。
//   - 追跡イベント（kink/seg-end）の 'hit' は、トレイルが無い打点（とびつき・低い返球＝色エフェクトが出ない 27%）の補完にだけ使う。
//     ラリーは側が交替するので、同じ側の連続打点の間に反対側の追跡 'hit' があればそれを採る。
//   - 着弾（バウンド）は qc 判別器ではなく **追跡点の画面 y の極大**、または追跡の切れ目をまたぐ直線外挿の交点で取る。
//     無ければ null（ボレーか取りこぼし。当て推量はしない）。
window.RallyFuse = (() => {
  const LEAD = 0.03;   // トレイル出現 → 打点は少し前
  const JUNK_DX = 4;   // 規則 1 で側を反転した run の尾と打ち出し位置の横のずれ（m）の上限。超えたら junk の run（fuse の規則 1 のコメント）
  // 時刻 a → b の間隔を ms の整数で（2026-09-24 exp-int3f・レビュー should-fix 2）。トレイル・far の打点の時刻はコマの格子（1/60 秒・トレイルは 1/30 秒）に乗り 3 桁に丸めてあるので、
  // 閾値がコマ周期のちょうど倍数だと浮動小数の誤差（0.5999… など）で境界の出入りが変わる。格子に乗る比較（gapOver・prePull・extras 2b・fillOne fix5）はこれで比べる。
  // 960 の追跡の events（kink など）は補間した時刻（52.49397… や 4 桁）なので格子には乗らず、dms は 0.5ms の丸めになるだけ（exp-int3f-review N3）
  const dms = (a, b) => Math.round((b - a) * 1000);

  // 追跡が静止物（ネットポスト・看板・雲）に乗り移った区間を捨てる。
  // 静止物はカメラのドリーで最大 2.5px/コマ(960) 流れるので「動かない」では取れない。
  // 「毎コマ 2.5px 未満のゆっくりした動きが 12 コマ以上続く」を静止物とみなす（実測: 右ネットポスト 894→914 / 0.27秒）。
  // 窓で切る前に全体に掛けること（窓で切ると静止区間が短く見えて残る）。
  function purgeStatic(pts) {
    const out = [];
    let i = 0;
    while (i < pts.length) {
      let j = i;
      while (j + 1 < pts.length) {
        const dt = pts[j + 1].t - pts[j].t;
        if (dt > 0.07) break;                                   // 欠測が 4 コマを超えたら別の連なり
        if (Math.hypot(pts[j + 1].x - pts[j].x, pts[j + 1].y - pts[j].y) / Math.max(1, Math.round(dt * 60)) >= 2.5) break;
        j++;
      }
      if (j - i + 1 >= 12) { i = j + 1; continue; }
      out.push(pts[i]); i++;
    }
    return out;
  }
  function slope(pts) {           // dy/dt（px/秒）
    const n = pts.length; if (n < 2) return null;
    let st = 0, sy = 0, stt = 0, sty = 0;
    for (const p of pts) { st += p.t; sy += p.y; stt += p.t * p.t; sty += p.t * p.y; }
    const d = n * stt - st * st; if (Math.abs(d) < 1e-9) return null;
    return (n * sty - st * sy) / d;
  }

  // 着弾＝打点と打点の間で **画面 y が極大** になる追跡点（落ちてきて跳ね返る瞬間）。
  // 手前へ来る球も奥へ行く球も、地面で y の増加→減少に転じる。前後 0.25 秒で 4px(960) 以上の落差を要求し、
  // 最初に立つ極大を採る（跳ねた後にラケットへ落ちていく2つ目の最下点は後ろに来る）。
  // 追跡がバウンド前後で切れているときは、切れ目の前が下降・後が上昇なら直線外挿の交点で補う（bridged）。
  // 着弾点は地面に接しているので、地面ホモグラフィの見かけZに高さバイアスが乗らない＝座標が正確。
  function landingFromTrack(track, tA, tB, camAt, side = null) {
    const pts = track.filter(p => p.t > tA + 0.15 && p.t < tB - 0.05);
    if (pts.length < 5) return null;
    // 打った側のコートに落ちることはない（ネットに掛かる場合を除く）。座標が出せる候補は側で篩う
    const okSide = p => {
      if (!side || !camAt || typeof Court === 'undefined') return true;
      const cam = camAt(p.t); if (!cam || !cam.ok) return true;
      const Z = Court.toCourt(p.x * 2, p.y * 2, cam).Z;
      return side === 'me' ? Z > -0.5 : Z < 0.5;
    };
    let best = null;
    // (a) 切れ目をまたぐ推定
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t < 0.08) continue;
      const before = pts.slice(Math.max(0, i - 6), i), after = pts.slice(i, Math.min(pts.length, i + 6));
      const sa = slope(before), sb = slope(after);
      if (sa == null || sb == null || !(sa > 60) || !(sb < -60)) continue;   // px/秒（60fps で ±1px/コマ以上）
      const pa = before[before.length - 1], pb = after[0];
      const ts = (pb.y - pa.y + sa * pa.t - sb * pb.t) / (sa - sb);
      if (!(ts >= pa.t && ts <= pb.t)) continue;
      const y = pa.y + sa * (ts - pa.t), x = pa.x + (pb.x - pa.x) * (ts - pa.t) / (pb.t - pa.t);
      const p = { t: +ts.toFixed(3), x: +x.toFixed(1), y: +y.toFixed(1) };
      if (!okSide(p)) continue;
      best = { p, drop: +Math.min(y - pa.y, y - pb.y).toFixed(1), bridged: true };
      break;
    }
    // (b) 連続追跡の中の極大
    // 次の打点の直前 0.2 秒は除く（ラケットに入る直前の最下点を着弾と取り違える）
    for (let i = 2; !best && i < pts.length - 2; i++) {
      const p = pts[i];
      if (p.t >= tB - 0.2) break;
      if (!(p.y >= pts[i - 1].y && p.y >= pts[i + 1].y && p.y > pts[i - 2].y && p.y > pts[i + 2].y)) continue;
      if (!okSide(p)) continue;
      const before = pts.filter(q => q.t >= p.t - 0.25 && q.t < p.t), after = pts.filter(q => q.t > p.t && q.t <= p.t + 0.25);
      if (before.length < 2 || after.length < 2) continue;
      const drop = Math.min(p.y - Math.min(...before.map(q => q.y)), p.y - Math.min(...after.map(q => q.y)));
      if (drop >= 4) { best = { p, drop, bridged: false }; break; }
    }
    if (!best) return null;
    const base = { t: best.p.t, x: best.p.x, y: best.p.y, drop: +best.drop.toFixed(1), bridged: best.bridged };
    const cam = camAt ? camAt(best.p.t) : null;
    if (!cam || !cam.ok || typeof Court === 'undefined') return base;
    const c = Court.toCourt(best.p.x * 2, best.p.y * 2, cam);
    return Object.assign(base, { X: +c.X.toFixed(2), Z: +c.Z.toFixed(2), inCourt: Court.inCourt(c.X, c.Z, 0.3) });
  }

  // 着弾＝星マーカー（tools/star.js）。打点の 0.15 秒後〜次の打点の 0.1 秒後までに現れた最初のマーカーで、打った側の反対のコートにあるもの。
  // 星は着弾後に地面に出る印なので、位置は地面ホモグラフィでそのまま座標にできる（高さバイアス無し）
  function landingFromStar(markers, tA, tB, camAt, side) {
    for (const m of markers) {
      if (m.t0 < tA + 0.15 || m.t0 > tB + 0.1) continue;
      const cam = camAt ? camAt(m.t0) : null;
      if (!cam || !cam.ok || typeof Court === 'undefined') return { t: m.t0, x: m.x, y: m.y, src: 'star', k: m.k };
      const c = Court.toCourt(m.x * 2, m.y * 2, cam);
      if (side === 'me' ? c.Z < -0.5 : c.Z > 0.5) continue;
      return { t: m.t0, x: m.x, y: m.y, X: +c.X.toFixed(2), Z: +c.Z.toFixed(2), inCourt: Court.inCourt(c.X, c.Z, 0.3), src: 'star', k: m.k };
    }
    return null;
  }

  // 手前（自分側）の打ち出し（2026-09-24 near）: 960 の追跡球が「手前で速く上がり始める」点。自分が打った球は奥へ飛ぶので画面 y が一気に減る。
  // 実測（0908 ベンチ＋砂 4 ポイント＋15-18-15 p8）: 0.2 秒で 60px 以上・傾き 480px/秒（8px/コマ）以上で上がり始める点は 26 個で、Z<0（手前）のものは 1 個を除いて全部 GT の自分の打点と ±0.35 秒以内
  // （中央値 −0.02 秒・トレイルより時刻が正確）。手前でのバウンドは球が手前へ来ながら跳ねるので画面上の上昇が遅く（砂 0911 p5 161.01 は 4px/コマ）当たらない。
  // 例外の 1 個は打ち合いが終わった後の 15-18-15 p8 209.57（ネット際の白い印に乗った追跡・Z −0.3）で、挿入は側の交替を課して落とす。
  // 時刻は速い上昇が始まる直前の点（下の k）。GT との差は −0.33〜+0.15 秒（中央値 −0.02・57.5 の −0.33 は GT 側の読みが怪しい）。
  // 返す pj は窓の先頭の点へ直前の追跡点から何 px/コマで跳んできたか（規則 3 のジャンプ・ガード用）
  function nearLaunches(track, camAt, zMax = 0) {
    const out = []; if (!camAt || typeof Court === 'undefined') return out;
    const lin = seq => { const n = seq.length; let st = 0, sy = 0, stt = 0, sty = 0; for (const p of seq) { st += p.t; sy += p.y; stt += p.t * p.t; sty += p.t * p.y; } const d = n * stt - st * st; return Math.abs(d) < 1e-9 ? null : (n * sty - st * sy) / d; };
    let lastT = -Infinity;
    for (let i = 0; i < track.length; i++) {
      const p = track[i];
      if (p.t < lastT + 0.3) continue;
      const w = track.filter(q => q.t > p.t && q.t <= p.t + 0.2);
      if (w.length < 5) continue;
      const seq = [p, ...w];
      let ok = true;
      for (let j = 1; j < seq.length; j++) { const df = Math.max(1, Math.round((seq[j].t - seq[j - 1].t) * 60)); if (Math.hypot(seq[j].x - seq[j - 1].x, seq[j].y - seq[j - 1].y) / df > 45) { ok = false; break; } }
      if (!ok) continue;
      const vy = lin(seq), dy = seq[seq.length - 1].y - p.y;
      if (vy == null || vy > -480 || dy > -60) continue;
      const pre = track.filter(q => q.t < p.t && q.t >= p.t - 0.15);
      if (pre.length >= 2 && lin([...pre, p]) < -240) continue;       // もう上がっている途中（始点ではない）
      lastT = p.t;
      // 打点＝速い上昇（1 コマ 8px 以上）が始まる直前の点。窓の先頭は手前へ降りてくる途中（砂 0911 p1 50.93→51.00）や、
      // バウンド後にラケットの前で球が止まっている区間（0908b p7 285.08〜285.20: 最大 y を採ると 0.25 秒早い）のことがある
      const rate = (a, b) => (b.y - a.y) / Math.max(1, Math.round((b.t - a.t) * 60));
      let k = i;
      while (k + 1 < track.length && track[k + 1].t <= p.t + 0.15 && rate(track[k], track[k + 1]) > -8) k++;
      const pk = track[k];
      const pv = i > 0 ? track[i - 1] : null;
      const pj = pv ? Math.hypot(p.x - pv.x, p.y - pv.y) / Math.max(1, Math.round((p.t - pv.t) * 60)) : 0;
      // 打ち出し後の上昇が追えていること（0.2 秒に 4 点以上・欠測 6 コマ以下）。まばらな点の飛び移りを打ち出しと取り違えない。
      // GT 一致の打ち出し 18 個は 0.2 秒に 4〜12 点・最大欠測 1〜6 コマ（960 の追跡は欠測が多い）
      // （15-18-15 p9 219.52: 地面をゆっくり動く物 (637,390) から 5 コマ空けて空の高い球 (639,263) へ乗り移り、0.2 秒に 3 点だけ）
      const post = track.filter(q => q.t > pk.t && q.t <= pk.t + 0.2);
      let gapMax = 0; for (let j = 0, pr = pk; j < post.length; pr = post[j], j++) gapMax = Math.max(gapMax, post[j].t - pr.t);
      if (post.length < 4 || gapMax > 6.5 / 60) continue;
      const cam = camAt(pk.t); if (!cam || !cam.ok) continue;
      const c = Court.toCourt(pk.x * 2, pk.y * 2, cam);
      // 手前ベースライン（Z −11.9）の 3m 後ろまで。それより後ろは観客席・画面下端の物（芝 0908 p7 189.62: Z −19.6・打点なし）
      if (!(c.Z < zMax) || !(c.Z > -15)) continue;
      const pe = seq[seq.length - 1], dl = Math.hypot(pe.x - pk.x, pe.y - pk.y) || 1;
      out.push({ t: +pk.t.toFixed(3), x: pk.x, y: pk.y, X: +c.X.toFixed(2), Z: +c.Z.toFixed(2), vy: +vy.toFixed(0), dy: +dy.toFixed(0), pj: +pj.toFixed(1),
                 ux: +((pe.x - pk.x) / dl).toFixed(3), uy: +((pe.y - pk.y) / dl).toFixed(3) });
    }
    return out;
  }

  function fuse({ shots = [], events = [], track = [], camAt = null, t0 = -Infinity, t1 = Infinity, markers = [], farTracks = [] } = {}) {
    track = purgeStatic(track);
    const launches = nearLaunches(track, camAt);
    // フル解像度のボール軌道（tools/farball.js・帯は奥ベースライン −300〜+240px で、ネット際の打ち上げまで入る）でも打ち出しを探す。
    // 960 の追跡は打ち上げ直後の球（黄トレイルと重なる）を失うことがある（砂 0911 p5 159.2: 960 は 159.32 で途切れ、フル解像度の軌道は 159.25→159.45 で y 463→127）。
    // ネット際で高い打点を打つと見かけの Z が高さバイアスで正に出る（159.13: Z 3.6・0911 p7 188.38: 1.1）ので Z<5 まで。
    // 実測: Z<5 の 7 個は 0908 p16 412.30（自分のサーブ・トス）を除き全部自分の打点の直後、Z≥10 はサーブのトス（0908b 185.3〜185.4・0911 p5 152.57・0908 412.55）。
    // フル解像度の帯は球が途中から入るので時刻は 960 より遅れがち（0908b 194.60 vs 194.34）→ 挿入（規則 3）にだけ使う
    const farLaunches = [];
    for (const tr of farTracks || []) for (const L of nearLaunches(purgeStatic((tr.pts || []).map(q => ({ t: q[0], x: q[1] / 2, y: q[2] / 2 }))), camAt, 5)) farLaunches.push(Object.assign(L, { far: true }));
    const allLaunches = launches.concat(farLaunches).sort((a, b) => a.t - b.t);
    let hits = shots.map(s => ({ t: +(s.t0 - LEAD).toFixed(3), side: s.side, cls: s.cls, src: 'trail',
                                 from: s.tail ? { X: s.tail.X, Z: s.tail.Z } : null, cZ0: s.cZ0, n: s.n, nMax: s.nMax, disp: s.disp, S: s.Smed,
                                 // 先端 y の 2 番目に小さい値（先頭に紛れた外れ blob 1 個に引っ張られない。砂 413.5: テントの縞 ty=16 で lob に化けた）
                                 tyMin: s.frames && s.frames.length ? (ys => ys.length >= 2 ? ys[1] : ys[0])(s.frames.map(f => f.ty != null ? f.ty : f.cy).sort((a, b) => a - b)) : null,
                                 _tys: s.frames ? s.frames.map(f => ({ t: f.t, y: f.ty != null ? f.ty : f.cy })) : null,
                                 c0: s.frames && s.frames.length && s.frames[0].cx != null ? { x: s.frames[0].cx, y: s.frames[0].cy } : null }))
                    .sort((a, b) => a.t - b.t);
    // 画面の下端から入ってくる run（2026-09-24 extras）: ポイントが終わってカメラが引くと、手前の柵・看板が画面の下端から上へせり上がり、
    // 自分側の dir up の run（多くは slice）になる。本物の自分のトレイルはラケット（画面の中）から始まるので、最初のコマが下端にあり、
    // しかもベースラインの 3m 以上後ろ（Z ≤ −14.5）にあるのは画面外から入ってきた物。
    // 実測（v37 ベンチ＋全体走 56 ポイントの自分側トレイル全部）: 柵 = 砂 0911 p1 53.14（y0 534・cZ0 −15.3）・p5 161.64（527・−15.3）・
    // p4 148.87（532・−15.2）・p10 243.07（499・−15.9）の 4 本（img/s0911_148.png・s0911_243.png で下端から柵がせり上がるのを確認）／
    // 本物は最初のコマ y ≤ 461（0911 p9 224.87 のロブ）・cZ0 ≥ −13.7（0911 p4 137.57）。下端 50px（540 の 490 以上）と Z −14.5 はその間
    // 捨てた柵の run の時刻は「カメラが引き始めた＝ポイントが終わった」印として残し、下の空白補完の終端に使う（tPull）
    const isPull = h => h.side === 'me' && h.c0 && h.c0.y >= 490 && h.cZ0 != null && h.cZ0 <= -14.5;
    const pulls = hits.filter(isPull);
    hits = hits.filter(h => !isPull(h));
    // tPull は最初の引き。「引きの後にトレイル打点が立つなら試合中の誤検出として終端にしない」門を試したが入れない（2026-09-24 exp-int3f-review N1）:
    // 本物の引きの後に junk の run が 1 本立つだけで tPull が消え、prePull が狙った偽物（0911 p5 161.14m）が戻る。76 ポイントの柵 7 本（全部 0911 砂・窓の終わりの約 0.7 秒前）は
    // 後ろのトレイル打点が 0 本で、試合中の誤検出は未観測。柵の例が 1 素材だけなのは残りの課題（docs 第 3 ラウンドの節）
    const tPull = pulls.length ? pulls[0].t : null;
    // カメラの引きの直前 0.8 秒の自分側のトレイル打点も捨てる: 最後の打点（決め球）の後、球が相手の脇を抜けて跳ね、ポイントが決まってからカメラが引く。
    // 実測（柵 4 本・最後の本物の打点→引き）: 52.0→53.14（1.14）・160.45→161.64（1.19）・147.85→148.87（1.02）・241.8→243.07（1.27）。
    // 引きの 0.8 秒以内に立っていたトレイル打点は 2 本とも決め球を見送った自分側の偽物: 0911 p5 161.14m（引きの 0.50 秒前・ネット際のヨッシーの背中・img/s5_161.png）・
    // p4 148.17m（0.70 秒前・パックンのチャージ球が抜ける所の光の輪・img/s4_148a.png）。0.8 は 0.70 と 1.02 の間。
    // 自分側だけ（2026-09-24 exp-int3f・レビュー should-fix 1）: 根拠の 2 本は自分側で、相手側のトレイルは接触の 0.25〜0.95 秒後に立つので、相手の決め球の本物が
    // 引きの 0.8 秒以内に入りうる（exp-int3-review の 720p 版 d0911 p5: 相手の最後の本物 160.94o（GT 160.40o）が引き 161.64 の 0.70 秒前で消えていた）。
    // FHD の 76 ポイントの出力は変わらない（exp-int3-review/eps/v-preme・exp-int3f の refuse）。間隔は ms の整数で比べる（dms・0.8 秒はトレイル 24 歩）
    // 注意: 自分がネットに掛けて終わるポイント（引きまでが短いかもしれない）の実例は無い
    // ここでは印（prePull）だけ付け、捨てるのは補完の後（下）。この run は決め球が自分の側へ届いた所に立つので、直前の自分の打点との間の同側補完
    // （相手の決め球を入れる）の根拠としては正しい（x0911 p4: 147.38m → 148.17m の間に 147.867 の far-appear＝パックンのパッシング 147.85 が入る。先に捨てるとこれが消える）
    if (tPull != null) for (const h of hits) if (h.src === 'trail' && h.side === 'me' && h.t < tPull && dms(h.t, tPull) < 800) h.prePull = true;
    // 背景 run（カメラと一緒に動く静止物）の除去と先頭の切り落としは trail.js summarize（yFarAt）へ移した（2026-09-21）
    const FAM = { topspin: 'warm', lob: 'warm', slice: 'blue', flat: 'purple', drop: 'white', unknown: 'any' };
    // 打点と打点は 0.3 秒以上離れる（ネットを越える時間）。近すぎる2本は blob の大きい方だけ残す
    // 近すぎる2本の解決: (1) 直前に採った打点と同じ側の方を落とす（側は交替する） (2) 種別が unknown の方を落とす (3) blob の小さい方を落とす
    const MIN_GAP = 0.3;
    for (let i = 1; i < hits.length; i++) {
      if (hits[i].t - hits[i - 1].t >= MIN_GAP) continue;
      // 「側は交替する」は直前の打点が近い（1.5秒以内）ときだけ信じる。前の打点を取りこぼしていると逆の方を落とす
      // （0908 砂 417.8: 直前が 2.1 秒前の 415.6 で、自分の打点を捨てて相手側の偽打点を採っていた）
      const a = hits[i - 1], b = hits[i], prev = i >= 2 && a.t - hits[i - 2].t <= 1.5 ? hits[i - 2] : null;
      // 側が違い・色族も違い・どちらも大きく有彩色なら、別々の本物のトレイル（相手のスライスの検出が遅れて自分の返球と
      // 0.1 秒差になった 0908 砂 420.6/421.05）。両方残す。白（ドロップ）は閃光と紛らわしいので対象外
      if (a.side !== b.side && FAM[a.cls] !== FAM[b.cls] && FAM[a.cls] !== 'any' && FAM[b.cls] !== 'any' && FAM[a.cls] !== 'white' && FAM[b.cls] !== 'white'
          && a.nMax >= 1000 && b.nMax >= 1000 && (a.S == null || a.S >= 0.25) && (b.S == null || b.S >= 0.25)) { a.tight = b.tight = true; continue; }
      let drop;
      // 白（ドロップ）か不明で、相手方の 1/4 未満の blob は閃光・網の白帯（クレイ 313.2: ネット際の白 923 が本物のロブ 18523 を側の交替で押し出した）
      const small = (x, y) => (FAM[x.cls] === 'white' || FAM[x.cls] === 'any') && x.nMax * 4 < y.nMax;
      if (small(a, b)) drop = i - 1;
      else if (small(b, a)) drop = i;
      else if (prev && a.side === prev.side && b.side !== prev.side) drop = i - 1;
      else if (prev && b.side === prev.side && a.side !== prev.side) drop = i;
      else if (a.cls === 'unknown' && b.cls !== 'unknown') drop = i - 1;
      else if (b.cls === 'unknown' && a.cls !== 'unknown') drop = i;
      else drop = b.nMax >= a.nMax ? i - 1 : i;
      hits.splice(drop, 1); i = Math.max(0, i - 2);
    }
    // 手前の打ち出し（nearLaunches・960 のみ）で自分側の打点を直す（2026-09-24 near）。far 寄せ（下）より先に掛ける:
    // 先に寄せると、側を取り違えた自分のトレイル（0908 p16 417.87 opp）が far-pair 417.08 へ逃げてから打ち出しと突き合わされる
    // 落ちてくる球（2026-09-24 snap）: 奥側で「ゆっくり落ちている球」の折り返し（far-turn）は打点ではない（自分のロブが頂点を越えて相手の上へ落ちてくる所）。
    // 球の速さと向きはフル解像度の軌道（farTracks・FHD px/コマ・60fps）の前後 0.12 秒の正味の変位で見る。
    // 前 0.12 秒がすでに下向き（vy > 0）で遅く（< 3.5）、後も下向き＝上下の向きは変わらず、落ちながら横の流れが曲がっただけ。
    //   実測（誤り）: 砂 0911 p1 51.80（自分のロブ 51.05 の落下・前 2.6 vy +2.7・後 vy +5.7・接触は 51.93 の橙の輪＝トレイル 51.90 の方が正しい）・
    //   p5 158.567（自分のロブ 157.7 の落下・前 2.8 vy +2.3・後 vy +8.5・158.70〜158.75 に白い輪＝接触。除くと次の far-turn 158.683）。
    //   本物の接触: 0908 p16 419.633（前 4.6 vy +4.6＝跳ねた後に落ちてくる球を打つ）・砂 160.40（5.3）・0908 p0 53.2（2.8 だが vy −1.8＝上がってくる球）・
    //   p8 225.2 stall（3.0 vy −3.0）・全体走 0908 p12 278.317（前 1.0 だが後 vy −3.7＝打った球が上がる）はどれも当たらない。遅さの境は 2.8 と 4.6 の間（例が少ない）
    // 後の速さが 12 以上なら打たれた球（重力だけでは 0.12 秒でそこまで速くならない: 落下の誤り 2 本は後 6.8・8.6）。落ちてくるロブをスマッシュした接触
    //   （全体走 15-18-15 p16 289.600: 前 2.2 vy +・後 21.0・289.60 に白い閃光・289.65 に球がラケット上）を残すため。
    // 取りこぼす本物（トレードオフ）: 全体走 0908b p3 151.517（跳ねて落ちてくる球をふつうに打つ・前 3.1・後 6.3・接触 ≈151.51）は除かれ、0.08 秒後の far-appear 151.60 に寄る
    // far-appear（出現直後が遅い）には掛けない: 落ちてくるロブ（全体走 0908b p4 196.017・後 2.5・スマッシュの接触 ≈196.37）と、ドロップ・ネット際で拾った低い球の
    // 本物の接触（0908b p7 302.267 後 2.8・302.30〜302.35 白い輪／0908 p14 364.25 後 4.6）が速さで分けられない（試して戻した）。
    // サーブ（直前の打点が無い＝hits の先頭）には掛けない: トスがゆっくり落ちてくる所がそのまま接触になりうる（全体走 0908 p1 72.767 far-appear: 72.65〜72.70 に球がラケットに届き 72.75〜72.80 に橙のバースト）
    // farjunk（奥側の空中の球の印 air・バウンドの折り返しの除去）は farball.js の中でイベントを減らす側、こちらは fuse で寄せ先から外す側。重なる例は 0911 p1 51.80（下の段 2 の記録）
    // 照合と窓の出所（2026-09-24 exp-int3f・レビューの note）: イベントと軌道の点の照合 ±0.02 秒・60px（FHD）と前後の窓 0.12 秒は、上の遅さ・速さの境（3.5・12）を
    //   測ったスクリプト（exp-snap/gtspeed.js・evspeed.js）の測り方をそのまま使ったもの。境はこの窓で測った値なので窓とは組だが、照合の ±0.02 秒・60px と窓の 0.12 秒そのものは
    //   振って確かめていない（根拠となる実測なし・暫定）
    const farPts = (farTracks || []).map(tr => (tr.pts || []).map(q => Array.isArray(q) ? { t: q[0], x: q[1], y: q[2] } : q));
    const fallingBall = (e) => {
      if (e.src !== 'far-turn') return false;
      const ex = e.x * 2, ey = e.y * 2;   // イベントの座標は 960、軌道は FHD
      for (const p of farPts) {
        const near = p.find(q => Math.abs(q.t - e.t) <= 0.02 && Math.hypot(q.x - ex, q.y - ey) <= 60); if (!near) continue;
        const net = (a, b) => { if (!a || !b || a === b) return null; const dk = Math.max(1, Math.round((b.t - a.t) * 60)); return { s: Math.hypot(b.x - a.x, b.y - a.y) / dk, vy: (b.y - a.y) / dk }; };
        const pre = p.filter(q => q.t >= e.t - 0.12 && q.t <= e.t + 0.001), post = p.filter(q => q.t >= e.t - 0.001 && q.t <= e.t + 0.12);
        const vb = net(pre[0], pre[pre.length - 1]), va = net(post[0], post[post.length - 1]);
        return !!(vb && va && vb.s < 3.5 && vb.vy > 0 && va.vy > 0 && va.s < 12);
      }
      return false;
    };
    // 相手側トレイル打点 h を時刻寄せする far イベントの候補（下の far 寄せの条件・2026-09-24 farjunk で関数にした: 規則 1 の反転の前にも使う）。
    //  窓: トレイルの時刻の 1.0 秒前〜トレイルの時刻そのもの（2026-09-24 snap で上端を h.t − 0.12 → h.t）。旧 h.t − 0.12 は「トレイルは 0.25 秒以上遅れる」前提だったが、
    //   GT の相手打点 14 本でトレイル（t0 − 0.03）の遅れは −0.10〜+0.50 秒・半数が 0.15 秒未満（0908 p16 419.6 は +0.14）。上端 0.12 だと接触の far-turn
    //   （0908 p16 419.633・トレイル 419.737 の 0.104 秒前・接触 ≈419.58）が落ちて早い far-pair 419.41 に寄っていた／0908b p12 384.10 も同じ（0.103 秒前）。
    //   トレイルは打った後の球の筋なので、その出だしより後に接触は無い（上端は h.t）。
    //  下限: 直前の打点（自分）からボールが相手に届くまでの時間。ネット際（Z > −5）からは 0.3 秒、ベースラインからは 0.4 秒
    //   （下限の理由: 芝ランクマ 15-18-15 p8 は 205.54 の MAX 溜めの直後 205.98 に出た far-pair が 206.40 の相手の打点を 0.42 秒早く引いていた）。
    //   ベースラインの 0.5 → 0.4（2026-09-24 snap）: GT の「自分→相手」の間隔は最短 0.42〜0.45 秒（x0911 142.3→142.72・147.4→147.85・0908 414.65→415.1）、全体走 0908b p7 は自分 299.88（白い輪）→
    //   相手のネット際のボレー 300.28（白い輪）で 0.40 秒。直前の打点はトレイル時刻（299.937）で遅れるので、0.5 だと接触直後の far-turn 300.417（直前の打点から 0.48 秒）が落ちて、
    //   落ちてくるロブの far-appear 300.90 に寄っていた
    //  場所: トレイルの尾（打点側の端）の X と 4m 以内。砂 0911 p5 160.47 が右端の junk（X 7.99）に 159.53 まで引かれた
    //  時刻は 3 桁（ミリ秒）に丸めて比べる（farjunk・浮動小数の端で窓の出入りが変わらないように）。snap も同じ丸めを入れていた（0908b p11 372.083 は 372.203 − 0.12 と浮動小数で当たっていた）が、
    //   上端を h.t にしてからはその端は無い（下限と 1.0 秒の端のために残す）
    const r3 = x => Math.round(x * 1000) / 1000;
    const farCands = (h, prevH) => {
      const prevT = prevH ? prevH.t : -Infinity;
      const minGap = prevH && prevH.from && prevH.from.Z != null && prevH.from.Z > -5 ? 0.3 : 0.4;
      // やって戻した（2026-09-24 farjunk）: 直前の打点が同じ相手側なら弱い far（qc < 1.0）の下限を直前 +0.8 秒にする案（同じ側の 2 打は最短 0.95 秒）。
      // 0908b p3 157.537 は直す（156.65 far-weak＝直前の相手打球の続き→トレイルの時刻 157.54・接触 157.55〜157.60）が、直前の「相手側」が自分のトレイルの側の取り違えである所
      // （0908b p1 94.37・p7 293.50・p9 338.17）で本物の出現・折り返しを締め出し +0.17〜+0.55 秒悪化した（目視 exp-farjunk/img/t95・u294・v339）
      return events.filter(e => e.kind === 'hit' && e.src && e.src.startsWith('far-') && r3(e.t) >= r3(h.t - 1.0) && r3(e.t) <= r3(h.t) && r3(e.t) > r3(prevT + minGap)
                               && (e.X == null || !h.from || h.from.X == null || Math.abs(e.X - h.from.X) <= 4) && !(prevH && fallingBall(e)));
    };
    for (const L of launches) {
      // (1) 同時刻（±0.1 秒）の相手側トレイル打点は、球が手前から奥へ上がり始めた瞬間なので相手の打点ではありえない＝自分の打点の側の取り違え
      //     （0908 p16 417.87: 自分のトップスピンが opp と出ていた・960 の kink も 417.78 me／砂 0911 p7 191.34: 右端の観客席の run が自分の返球と同時刻）。
      //     下の sideFix（opp0908）も同じ 417.87 を直す。こちらが先に掛かり sideTrail を付けるので、sideFix は sideTrail の付いた打点を見ない（二重に反転しない）
      let same = hits.filter(h => h.side === 'opp' && Math.abs(h.t - L.t) <= 0.1);
      // 反転しない場合（2026-09-24 farjunk）: そのトレイルを far 寄せする候補（farCands）に強い far イベント（qc ≥ 1.0＝奥で折り返して手前へ向かう球）があれば、
      // トレイルは「相手が打って手前へ入ってくる球」の遅れた検出で、自分の打ち出しと時刻が重なっただけ。反転すると相手の本物の打点を失う。
      // 実例: 砂 0911 p2 64.07 opp（橙・tail Z 6.1）: 63.483 far-turn 1.2 → 目視（exp-farjunk/img/p2-633.png）で 63.60〜63.65 にパックンの打点の橙の閃光、
      // 63.80〜64.05 に橙トレイルが手前へ伸びる。ヨッシーのネット際の打ち出し 64.05 と重なって me に反転され、63.6 の相手の打点が消えていた。
      // 正しい反転の 0908 p16 417.87 は 1.0 秒前までに qc ≥ 1.0 の far が無い（416.75 far-appear 0.9 は 1.12 秒前）ので変わらない。
      // farjunk は旧窓（0.12〜1.0 秒前・minGap 0.5）で作ったが、snap の窓（〜トレイルの時刻・minGap 0.4・落ちてくる球を除く）に揃えてもベンチ＋全体走 56 ポイントで
      // 打点の時刻・有無は 1 本も変わらない（exp-int3/v-e1old で確認・2026-09-24 統合 3）
      same = same.filter(h => { const prevH = hits.filter(o => o !== h && o.t < h.t).pop(); return !farCands(h, prevH).some(e => (e.qc || 0) >= 1.0); });
      if (same.length && !hits.some(h => h.side === 'me' && Math.abs(h.t - L.t) <= 0.25)) {
        const h = same[0]; h.sideTrail = h.side; h.side = 'me'; h.tTrail = h.tTrail != null ? h.tTrail : h.t; h.t = L.t; h.launch = true;
        // 反転元の run が junk か（必須の修正 a）: 本物の自分のトレイルなら、run の尾（相手側と読んだので「打った側の端」＝奥の端）は打ち出し位置から
        // 奥へまっすぐ伸びた先にあるので、横（X）のずれが小さくコートの中にある。実測: 0908 p16 417.87（自分の橙トレイル・本物）は尾 X −0.35 Z 8.91／打ち出し X −1.23（横のずれ 0.88m）・
        // 砂 0911 p7 191.34（観客席の run）は尾 X 8.52 Z 12.61（コートの外）／打ち出し X −2.68（横のずれ 11.2m）。尾の X がコートの横幅（|X| ≤ 5.5・ダブルスのサイドライン）の外か、
        // 打ち出しとの横のずれが JUNK_DX m を超えるなら junk として、種別は unknown・打点の位置（from）は打ち出し位置にする
        const tail = h.from;
        const junk = !tail || tail.X == null || Math.abs(tail.X) > 5.5 || Math.abs(tail.X - L.X) > JUNK_DX;
        h.launchJunk = junk;
        // junk の run の形（先端 y・頂点に居るコマ数）もロブの判定に使わない（砂 191.34 は観客席の run の tyMin で lob に化けていた）
        if (junk) { h.clsTrail = h.cls; h.cls = 'unknown'; h.from = { X: L.X, Z: L.Z }; h.tyMin = null; h._tys = null; }
        continue;
      }
      // (2) 自分側のトレイル打点が打ち出しの 0.25〜0.6 秒後に立つ＝トレイルの検出遅れ（15-18-15 p8 206.9: 打ち出し 206.90・スライスの run は 207.37 から）。
      //     間に他の打点が無いときだけ時刻を打ち出しへ寄せる（種別はトレイルのまま）。
      //     トレイルが同じ打球の遅れた検出なら、最初のコマの重心は打ち出しから打球の向きへ進んだ所にある（トレイルは球の後ろに伸びる筋で、0.25 秒以上飛んだ後）。
      //     打ち出しの位置に留まっている（進みが 60px(960) 未満）なら、そのトレイルは打ち出しとは別の、後の打点のもの（打ち出しの方が偽物）。
      //     実測: 真 15-18-15 p8 207.34→206.90 は進み 192px（打ち出し (459,370)・向き (34,−178)・重心 (539,190)）／ハード 0908b p4 188.80→188.53 は 150px
      //     （追跡が 188.533 の最下点から滑らかに上がり続ける＝打点は 188.53）／偽 全体走 0908 p1 74.14→73.88 は −6px（重心 (352,347) が打ち出し (391,336) の真横。
      //     打ち出しの前 0.3 秒は 3px/コマで地面を這う物・後は画面上端 (373,90) で止まる物で、球ではない）。例が 3 本だけなので閾値は粗い
      const progress = (h) => h.c0 && L.ux != null ? (h.c0.x - L.x) * L.ux + (h.c0.y - L.y) * L.uy : null;
      const late = hits.find(h => h.side === 'me' && h.t - L.t >= 0.25 && h.t - L.t <= 0.6);
      if (late && !(progress(late) != null && progress(late) < 60) && !hits.some(h => h !== late && h.t > L.t - 0.25 && h.t < late.t) && !hits.some(h => h.side === 'me' && Math.abs(h.t - L.t) < 0.25)) {
        late.tTrail = late.tTrail != null ? late.tTrail : late.t; late.t = L.t; late.launch = true; late.launchShift = true; continue;
      }
    }
    hits.sort((a, b) => a.t - b.t);
    // 奥側（相手側）のトレイル打点は、彗星の頭が小さく run が自分側に届いてから立つので 0.25〜0.95 秒遅れる（0908 の取りこぼし 7 本中 4 本がこれ）。
    // フル解像度のボール追跡（tools/farball.js）が相手の位置で「折り返し」「軌道のペア」「出現」を 'hit'（src far-*）として出すので、
    // 近すぎる 2 本の解決（MIN_GAP）の後に掛ける: 先に寄せると、本来落ちるはずの小さい断片（砂 0911 p5 160.20 n432）が別の時刻へ逃げて残る
    // 相手側のトレイル打点の直前（窓は上の farCands: 1.0 秒前〜トレイルの時刻）にそれがあれば時刻をそちらへ寄せる（種別はトレイルのまま）。直前の打点より minGap 以上後のものだけ。
    // qc 1.0 以上（折り返し後に手前へ向かう球）を優先し、同じ段なら最も遅いもの（バウンドの折り返しは打点より前に出る）
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.side !== 'opp') continue;
      // 条件（窓・直前の打点からの minGap・尾の X・落ちてくる球の far-turn を除く）は上の farCands
      const prevH = i > 0 ? hits[i - 1] : null;
      const cands = farCands(h, prevH);
      // 窓に far が無いとき 960 の追跡 hit（相手側・qc ≥ 1.0）へ寄せる案は入れない（2026-09-24 snap で試して戻した）: 芝ランクマ 15-18-15 p10 230.60→230.27
      // （接触 230.30〜0.35）は直るが、ベンチ 0908 p0 56.54→56.16（GT 56.45・トレイルの方が正しい）が悪化。GT の相手打点のまわりの 960 の qc ≥ 1.0 は
      // GT ±0.15 秒に入るのが 6 本中 1 本（−0.65〜+0.60 に散る）で、トレイルより良いと言える根拠が無い
      if (!cands.length) continue;
      const strong = cands.filter(e => (e.qc || 0) >= 1.0);
      const pick = (strong.length ? strong : cands).sort((x, y) => y.t - x.t)[0];
      h.tTrail = h.t; h.t = +pick.t.toFixed(3); h.farFix = pick.src; h.farQc = pick.qc; if (pick.rise) h.farRise = pick.rise;
    }
    hits.sort((a, b) => a.t - b.t);
    // コートの横の外（観客席・柵）から始まる run（2026-09-24 extras）: run の尾（打った側の端）の X が ±7.5m 以上（ダブルスのサイドライン 5.5m の 2m 外）。
    // 実測: GT に当たったトレイル打点の尾は |X| ≤ 5.97（15-18-15 p9 218.44）。|X| ≥ 7.5 の GT 素材の 4 本は全部偽物
    // （砂 0911 p7 192.70・193.67＝右端の観客席・柵（img/p7_193.png）・x0911 p6 177.80・p4 148.60＝パッシングの橙が左端へ抜ける所）。
    // ただし時刻だけは本物と重なることがある（全体走 0911 p9 210.24: パックンが 210.2 に橙を打った瞬間、右の観客席に run が立つ・img/s9_210.png）ので、
    // 位置だけでは捨てず、打点としてあり得ないときだけ捨てる:
    //  (a) 同じ側の打点が 0.6 秒以内にある（同じ側の 2 打の間隔は GT 3 素材で最短 0.95 秒・sideFix と同じ根拠）→ 外の方が偽物（192.70 は 0.37 秒後に 193.07 の本物の紫）。
    //      間隔は ms の整数で比べ 0.600 ちょうども含める（2026-09-24 統合 3・反証役の指摘: 193.67 と 193.07 の差は浮動小数で 0.5999… になり「< 0.6」にたまたま入っていた）
    //  (b) 直前の反対側の打点から、球が届く時間（ベースラインから 0.5 秒・ネット際（|Z| < 5）から 0.3 秒）が経っていない。
    //      far 寄せの minGap は snap でベースライン 0.4 に下げたが、こちらは 0.5 のまま（捨てる側の規則なので保守的に。0.4 にしてもベンチ・全体走の出力は同じ: exp-int3/v-ocb04）
    //      （193.67: 自分の 193.20（Z −6.9）の 0.47 秒後。球はパックンの脇を抜けて打たれていない＝GT 194.0 削除）
    // far 寄せ（上）の後に掛ける。先に捨てると、192.70 が消えて 193.07（本物の紫・トレイルの時刻は GT 193.0 に +0.07）の far 寄せの下限（直前の打点）が
    // 191.35 まで下がり、192.50 の far-turn（ヨッシーの低い球がパックンの前で跳ねた所・Z 6.96）へ −0.57 秒引かれて GT を外す（far 寄せの窓の問題・別レーン）。
    // far で寄せられた run は奥側の裏付けがあるので対象外
    {
      const offCourt = h => h.src === 'trail' && !h.launch && h.sideTrail == null && !h.farFix && h.from && h.from.X != null && Math.abs(h.from.X) >= 7.5;
      const drop = new Set();
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i]; if (!offCourt(h)) continue;
        const sameNear = hits.some(o => o !== h && !drop.has(o) && o.side === h.side && Math.round(Math.abs(o.t - h.t) * 1000) <= 600);
        let p = null; for (let j = i - 1; j >= 0; j--) if (!drop.has(hits[j])) { p = hits[j]; break; }
        // (b) の間隔も ms の整数で比べる（2026-09-24 exp-int3f・should-fix 2: p がトレイルなら 0.3/0.5 秒はトレイル 9/15 歩で格子に乗る）
        const gapMinMs = p && p.side !== h.side ? (p.from && p.from.Z != null && Math.abs(p.from.Z) < 5 ? 300 : 500) : 0;
        if (sameNear || (p && p.side !== h.side && dms(p.t, h.t) < gapMinMs)) { h.offCourtDrop = true; drop.add(h); }
      }
      if (drop.size) hits = hits.filter(h => !drop.has(h));
    }
    // sideFix（2026-09-24 opp0908）: 同じ側のトレイル打点が 0.6 秒以内に並ぶことは無い（反対側で打ち返されて戻るまでの 2 打の間隔は GT 3 素材で最短 0.95 秒）。
    // 前の 1 本の直前 0.15 秒以内に反対側の 960 追跡 hit があれば、前の 1 本は反対側の打点のトレイルの側を取り違えたもの
    // （0908 砂 p16 417.87 opp topspin n5 nMax 253: 実際は 417.8 の自分のチャージ打点の橙の筋。筋が奥へ伸びる途中から run になり
    //  重心が下がって dir down・side opp になった。直前 417.78 に me の kink qc 0.69）。
    // 全セットで同側 0.6 秒以内の組は 4 組・反対側の hit が近いのはこの 1 組だけ（他の 3 組は側を変えない）
    // 両方が本物ではあり得ないので、疑うのは blob の小さい方。前の 1 本が後ろの半分未満のときだけ前の側を変える
    // （芝ランクマ 15-18-15 p10 232.57 me flat nMax 13703 → 232.87 me drop 1135 は後ろが junk。232.43 に opp の kink qc 1.13 があるが
    //  目視で 232.45 に自分が紫のフラットを打っているのを確認。大きさの条件が無いと本物の側を変えていた）
    for (let i = 1; i < hits.length; i++) {
      const a = hits[i - 1], b = hits[i];
      if (a.side !== b.side || b.t - a.t >= 0.6 || a.src !== 'trail' || a.sideTrail != null || !(a.nMax * 2 < b.nMax)) continue;
      const other = a.side === 'me' ? 'opp' : 'me';
      const ev = events.filter(e => e.kind === 'hit' && e.side === other && !(e.src && e.src.startsWith('far-')) && e.t >= a.t - 0.15 && e.t <= a.t).sort((x, y) => y.t - x.t)[0];
      if (ev) { a.sideFix = a.side; a.side = other; }
    }
    // 規則 (3)（2026-09-24 near）は far 寄せの後（相手側トレイルの遅れ 0.25〜0.95 秒を寄せてから「±0.3 秒に打点が無い」を見る: 砂 0911 p5 158.87 opp → 158.57 のあとに 159.13 の打ち出しが空く）
    for (const L of allLaunches) {
      // (3) 近くに打点が無い（±0.3 秒）打ち出しは、直前の打点が相手なら自分の打点として補う（黄トレイルが砂に溶ける 0911 p1 51.05 のロブ）。
      //     直前が自分なら入れない（打ち合いの後の追跡の乗り移り: 15-18-15 p8 209.57）。
      //     ジャンプ・ガード（検証役）: 960 の打ち出しで、窓の先頭の点へ直前の追跡点から 45px/コマ（軌道の連結の上限と同じ）を超えて跳んできたものは、
      //     別物から球へ乗り移った所を「上がり始め」と読んでいるので入れない（規則 1・2 は既存の打点を直すだけなので掛けない）
      if (!L.far && L.pj > 45) continue;
      if (hits.some(h => Math.abs(h.t - L.t) <= 0.3)) continue;
      const prev = hits.filter(h => h.t < L.t).pop();
      if (!prev || prev.side !== 'opp') continue;
      // 2026-09-24 chain: フル解像度の打ち出しは帯に球が入ってから立つので遅れることがある（上の「時刻は 960 より遅れがち」）。直前 0.3 秒以内に自分側の 960 の追跡 hit が
      // 強く（qc ≥ 0.8＝空白補完の鎖の候補と同じ基準）出ていれば、その時刻（複数なら最も遅いもの）を打点にする。
      // 実測（全体走の launch-far 25 本のうち該当 3 本・目視の接触）: 芝 151815 p15 278.983 → 278.837 kink 0.94（接触 278.80・+0.18→+0.04・v36 の fillOne もこの kink）／
      // 砂 0911 p2 61.05 → 60.950 kink 0.90（接触 ≈61.00・+0.05→−0.05 で互角）／0908 p19 482.567 → 482.502 kink 1.56。
      // 弱い kink は採らない: 砂 0911 p3 112.483 kink 0.58（接触 112.55〜112.60・launch-far 112.633 の方が近い）・0911 p10 240.685 kink −0.08
      // 寄せた先が既存の打点と 0.3 秒以内になるときは寄せない（砂 0911 p2: 60.950 は 60.67 opp の 0.28 秒後。寄せると 61.05 の挿入ごと消えていた）
      const pre = L.far ? events.filter(e => e.kind === 'hit' && e.side === 'me' && !(e.src && e.src.startsWith('far-')) && (e.qc || 0) >= 0.8 && e.t >= L.t - 0.3 && e.t < L.t
                                          && !hits.some(h => Math.abs(h.t - e.t) <= 0.3)).sort((x, y) => y.t - x.t)[0] : null;
      hits.push({ t: pre ? +pre.t.toFixed(3) : L.t, side: 'me', cls: 'unknown', src: L.far ? 'launch-far' : 'launch', from: { X: L.X, Z: L.Z }, launch: true, tLaunch: pre ? L.t : undefined });
      hits.sort((a, b) => a.t - b.t);
    }
    // 同側連続の間の 1 本補完（prev と h は同じ側）。反対側の追跡 hit を 1 本選んで返す（無ければ null）
    const farRank = e => (e.src && e.src.startsWith('far-') ? ((e.qc || 0) >= 1.0 ? 10 : 5) : 0) + (e.qc || 0);   // 同側補完の順位（下の fillOne）
    const fillOne = (prev, h) => {
      {
        // 相手側の補完は、フル解像度のボール追跡（far-*・qc ≥ 1.0）を 960 の追跡 hit より優先する。960 の追跡は奥側で 0.5 秒遅れる
        // （芝 0908 p0 58.0: 960 の hit は 58.50 qc 2.5、far-pair は 57.96）。qc の尺度が違うので並べ替えでなく段で分ける
        // 2026-09-24 chain: qc < 1.0 の far（far-appear 0.9・far-pair/turn 0.85）も 960 の追跡 hit より上の段にする。960 の奥側の hit は球が相手に届く前後の
        // 軌道の切れ目で、qc が高くても接触から 0.25〜0.5 秒ずれる。目視（fillOne で far が 960 に負けていた全体走の全 5 件）:
        // 芝 151815 p9 216.800 far-appear（接触 216.72〜216.75）vs 217.244 kink 0.935（自分のスライス 217.07 の後の球）／151815 p16 288.017 far-appear（白い輪 287.95〜288.00）vs 288.254 kink 0.988／
        // 芝 0908 p6 159.05 far-appear（接触 158.95〜159.00）vs 158.483 kink 0.907（自分の球の飛行中）＝ far が正 3・互角 2（砂 0911 p9 225.375 vs 225.745 は接触 225.40〜225.70 の両端、0908 p12 328.35/328.55 はどちらもロブの降下中）
        const rank = farRank;
        let pool = events.filter(e => e.kind === 'hit' && e.side !== h.side && e.t > prev.t + 0.15 && e.t < h.t - 0.1);
        // starFill（2026-09-24 opp0908）: 間の打点は、h の側のコートに出た最初の星（着弾・スマッシュの着弾予告）より 0.3 秒以上前（打ってから相手コートに落ちるまで 0.3 秒以上）。
        // 星より後の追跡 hit は、ロブが画面の上から降りてくるところで追跡が始まった切れ目（0908 芝 p2: 99.44 me → 101.80 me の間で
        // 960 の hit は 99.60 qc 0.34／100.21 0.47／100.53 0.79。相手のロブは 99.7 前後（フル解像度でラケットに紫の頭が届く）で、
        // 球は画面の上へ消え 100.5 から降りてくる。自分側の星 100.23（k 24・スマッシュの着弾予告）より後の 100.53 を採っていた）。
        // 注意（検証役の目視）: この制約で採られる 99.60 は球がラケットに触れた瞬間ではなく、0.12 秒早い非接触のイベント（入射球の軌道の切れ目）で、GT 99.6 に「当たる」のは時刻が近いから。
        // 条件を満たす候補が無いときは従来どおり（星の誤検出で本物を消さない）
        const star = h.side && camAt && typeof Court !== 'undefined' ? markers.find(m => {
          if (m.t0 <= prev.t + 0.3 || m.t0 >= h.t) return false;
          const cam = camAt(m.t0); if (!cam || !cam.ok) return false;
          const Z = Court.toCourt(m.x * 2, m.y * 2, cam).Z;
          return h.side === 'me' ? Z < -0.5 : Z > 0.5;
        }) : null;
        // 相手のロブ（far-lobpair）は星の直前まで許す（2026-09-24 snap）: ロブを打ち上げた瞬間に自分側へスマッシュの着弾予告の星が出るので、「着弾まで 0.3 秒」が成り立たない
        // （0908 p16: ロブの接触 416.25（GT・far-lobpair の出射の始まり 416.25）・自分側の星 416.47 は 0.22 秒後。lobpair の時刻を中点 416.125 から出射へ直したら 0.3 秒の篩で落ち、416.75 の far-appear が入った）
        if (star) { const before = pool.filter(e => e.src === 'far-lobpair' ? e.t < star.t0 : e.t <= star.t0 - 0.3); if (before.length) pool = before; }
        let cand = pool.sort((a, b) => rank(b) - rank(a) || b.t - a.t)[0];   // 同段なら遅い方（入射中の軌道の切れ目で出る偽のペアは打点より前に出る: 0908 p0 57.63 と 57.96）
        // 2026-09-24 chain: 採った候補より 0.25 秒以上後に、相手コートの中（Z > 5）で球の向きが変わる far-turn があれば、採った候補の時点で球はまだ相手に届いていない
        // （相手が打った球は手前へ飛び、次に跳ねるのは自分のコート。相手コートで向きが変わるのは入ってくる球の着弾か相手の接触）。その far-turn 以降の候補から採り直す。
        // 砂 0911 p2: 自分のロブの降下中に far-pair 1.1（69.817 Z 26.5・98.083 Z 26.1＝空中の球が奥へ投影された所）が立ち、真の接触の far-turn 0.85（70.283 Z 13.4・98.467 Z 9.9）を押しのけていた
        // 採った候補が far-appear（出現）なら 0.1 秒後から見る（2026-09-24 統合 3）: farjunk の air（空中で終わる先行軌道をペアの相手にしない）で上の far-pair 69.817/98.083 が
        // 消えると、降りてくるロブが出現として 70.133/98.317 に立ち（far-appear 0.9 は farRank で far-turn 0.85 より上）、接触の far-turn 70.283/98.467 はその 0.15 秒後で 0.25 に届かず、
        // chain 単独の 70.28/98.47 が 70.13/98.32 に戻っていた（接触は 70.30〜70.35・98.45〜98.50: exp-farjunk/img/f70・g98 と exp-chain-verify の目視が一致）。
        // 出現の直後に相手コートで向きが変わるなら、出現したのは入ってくる球（本物の打ち返しの出現なら、その球は手前へ飛んで相手コートでは曲がらない）。
        // 一律に 0.1 秒にすると芝ランクマ 15-18-15 p12 の far-turn 247.13（GT 247.17）が 247.38 の far-appear に替わって外れる（exp-int3/v-f5-0.1）ので出現のときだけ。例はこの 2 本だけ
        // 間隔は ms の整数で比べる（2026-09-24 exp-int3f・should-fix 2: 0.25/0.1 秒は far のコマ 15/6 個・0.05 秒は 3 個で格子に乗る）
        // 根拠の無い値（2026-09-24 exp-int3f・レビューの note）: 採り直しのさかのぼり 0.05 秒（far-turn の少し前から採り直す）と繰り返しの上限 3 回（guard）は実測の根拠が無い暫定値。
        //   fix5 が発火するのは 76 ポイントで 2 件（全体走 0911 p2 の far-turn 70.283・98.467）だけで、どちらも 1 回目で止まり（2 回目は後ろに far-turn が無い）、
        //   さかのぼりの 0.05 秒に入る候補も無い（exp-int3f/work/fix5probe.js）＝値の感度は測れていない
        for (let guard = 0; cand && guard < 3; guard++) {
          const turn = pool.filter(e => e.src === 'far-turn' && e.Z != null && e.Z > 5 && dms(cand.t, e.t) > (cand.src === 'far-appear' ? 100 : 250)).sort((a, b) => b.t - a.t)[0];
          if (!turn) break;
          const later = pool.filter(e => dms(e.t, turn.t) <= 50);
          const c2 = later.sort((a, b) => rank(b) - rank(a) || b.t - a.t)[0];
          cand = c2;
        }
        // far-lobpair（奥側で速い入射球が途切れ、半分以下の速さで上へ上がる球が出る）は打ち上げた球＝ロブとして種別を付ける。
        // src は far-* のまま残す（2026-09-24 統合: 以前は 'track' にしていて、後段（shotcolor）や集計で far 由来が見えなかった）。960 の追跡 hit は 'track'
        return cand ? { t: cand.t, side: cand.side, cls: cand.src === 'far-lobpair' ? 'lob' : 'unknown', src: cand.src && cand.src.startsWith('far-') ? cand.src : 'track', from: { X: cand.X, Z: cand.Z }, qc: cand.qc, farRise: cand.rise } : null;
      }
    };
    // 同側連続 → 間に反対側の追跡 hit があれば補完
    // 間隔は 1ms に丸めて比べる（時刻は 3 桁に丸めた値の差で、浮動小数の誤差で境界を越える: 芝 151815 p9 の 216.237→218.437 は 2.2000000000000171 で 2.2 超と判定されていた）
    const gapOver = (a, b) => dms(a.t, b.t) > 2200;
    const out = [];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i], prev = out[out.length - 1];
      // 同側連続でも間が 2.2 秒を超えるなら 1 本では埋まらない（間に往復がある）ので、下の空白補完（側を交互に繋ぐ鎖）に任せる。
      // 鎖が組めないときは空白補完の中でこの 1 本補完に戻す（sameSideGap・2026-09-24 near）。砂 0911 p7 は 191.34 が自分の打点に直って
      // 187.20 me → 191.35 me の同側 4.1 秒になり、1 本補完が 189.17 だけを入れて鎖の 187.58/188.13（GT 187.65/188.15）を失っていた
      if (prev && prev.side === h.side && gapOver(prev, h)) { h.sameSideGap = true; out.push(h); continue; }
      if (prev && prev.side === h.side) {
        const ins = fillOne(prev, h);
        if (ins) out.push(ins); else h.suspect = 'same-side';
      }
      out.push(h);
    }
    // 打点の間隔が 2.2 秒を超える＝ボールが空中に居られる時間（深いロブでも 2 秒）を超えているので、間に打点を取りこぼしている。
    // 反対側の追跡 hit（qc ≥ 0.8）があれば 1 本補う（砂 0911 p5: 157.65 me → 160.47 opp の間に相手のロブ 158.78 opp qc 1.30 が埋もれていた。
    // 黄トレイルは砂に溶けて run にならないので track だけが手掛かり）。同側補完の後に見る（157.65 me 自体が同側補完で入るため、ループ内では空白が見えない）
    // 2026-09-23: 1 本（qc 最大）でなく **側を交互に繋ぐ鎖**で埋める。砂 0911 p7 の 187.20 me → 191.34 opp（4.1 秒）には追跡 hit が
    // 187.58 opp 1.14 → 188.13 me 0.92 → 190.05 opp 1.88 と並んでいて、qc 最大の 190.05（junk）だけが入り本物の 2 本が落ちていた。
    // 鎖は prev の反対側から始めて時刻順に側を交互に取り（間隔 0.3 秒以上・qc ≥ 0.8）、鎖の最後が次の打点 h と同じ側なら
    // 交替が崩れるので最後を捨てる（ラリーは必ず側が交替する）
    // 終端（2026-09-24 extras）: 柵の run（カメラの引き）を捨てると、最後の打点〜カメラの引きの空白が補完されなくなる（全体走 0911 p10: 240.80 の自分のロブ → 243.07 の柵の間に
    // 鎖が 241.70 の far-turn（パックンのスマッシュ・目視 241.8・img/s10_241.png）を入れていた）。カメラの引きは最後の打点の 1.0〜1.3 秒後に始まる
    // （0911 の柵 4 本: 52.0→53.14・160.45→161.64・147.85→148.87・241.8→243.07）ので、引きまで 2.2 秒を超えて空くなら間に打点がある。
    // 引きは打点ではないので側を持たせない（鎖の最後を捨てる規則・同側 1 本補完は掛けない）
    const endMark = tPull != null ? { t: tPull, side: null, pullEnd: true } : null;
    for (let i = 1; i < out.length + (endMark ? 1 : 0); i++) {
      const prev = out[i - 1], h = i < out.length ? out[i] : endMark;
      if (!gapOver(prev, h)) continue;
      if (prev.side === h.side && !h.sameSideGap) continue;
      const cands = events.filter(e => e.kind === "hit" && (e.qc || 0) >= 0.8 && e.t > prev.t + 0.3 && e.t < h.t - 0.3).sort((a, b) => a.t - b.t);
      const chain = []; let side = prev.side === 'me' ? 'opp' : 'me', tLast = prev.t;
      // 鎖の各段にも星（着弾）の制約を掛ける（2026-09-24 統合）: side の打球が落ちる相手のコートに、tLast の 0.3 秒後より後で星が出ていれば、
      // side の打点はその星の 0.3 秒前まで（同側補完の starFill と同じ考え）。sameSideGap で同側 2.2 秒超を鎖に回すと、0908 芝 p2 の 99.44 me → 101.80 me（2.36 秒）が
      // starFill の無い鎖で 100.58 の far-appear（自分側の星 100.23 の後・ロブが画面の上から降りてくる所）を採り、99.60 を落としていた。
      // 鎖が組めなければ下の fallback で starFill 付きの 1 本補完に戻る。砂は星が出ない（star.js で除外）ので砂の鎖には効かない
      const cutFor = (sd, tFrom) => {
        if (!camAt || typeof Court === 'undefined') return Infinity;
        const m = markers.find(m => { if (m.t0 <= tFrom + 0.3 || m.t0 >= h.t) return false; const cam = camAt(m.t0); if (!cam || !cam.ok) return false; const Z = Court.toCourt(m.x * 2, m.y * 2, cam).Z; return sd === 'opp' ? Z < -0.5 : Z > 0.5; });
        return m ? m.t0 - 0.3 : Infinity;
      };
      for (let k = 0; k < cands.length; k++) {
        const e = cands[k]; if (e.side !== side || e.t < tLast + 0.3) continue;
        const cut = cutFor(side, tLast); if (e.t > cut) continue;
        // 同じ側の候補が 0.3 秒以内に並ぶときは qc 最大を採る（奥側のボール追跡: far-appear 0.9 の 0.1 秒後に far-turn 1.2 が出る）
        let best = e; for (let m = k + 1; m < cands.length && cands[m].t <= e.t + 0.3; m++) if (cands[m].side === side && cands[m].t <= cut && (cands[m].qc || 0) > (best.qc || 0)) best = cands[m];
        // 入れなかった（2026-09-24 chain の fix3・第 3 ラウンドの反証役が止めた）: 同じ側の候補が続く区間に奥側のフル解像度の hit があれば、fillOne と同じ段（far qc≥1.0 ＞ far ＞ 960）の
        // 最上段を 0.2 秒の切れ目で塊に分け、最後の塊の先頭から採る案（ハード 0908b p4 189.283 far-turn 0.85 → 190.55 far-turn 1.2・砂 0911 p2 101.933 → 102.217）。
        // ベンチの改善は 0 で、0911 p7 187.58（GT 187.65）を 187.80 far-appear（+0.15・T の境界ちょうど）に悪化させた。0908b p4 の 189.28 と 190.55 はどちらも本物の入れ替え（中立）
        chain.push(best); tLast = best.t; side = side === 'me' ? 'opp' : 'me';
      }
      if (chain.length && chain[chain.length - 1].side === h.side) {
        // 交替が崩れる最後の 1 本でも、強い奥側イベント（qc ≥ 1.0 の far-turn/pair）なら残す（suspect same-side を付ける）。次の打点の側が誤っている場合がある
        // （砂 0911 p7: 191.34 の自分のロブが opp と出て、189.15 の相手のロブ far-turn 1.2 が捨てられていた）
        const last = chain[chain.length - 1];
        if (!((last.qc || 0) >= 1.0 && last.src && last.src.startsWith('far-'))) chain.pop(); else last.keptSameSide = true;
      }
      if (!chain.length && h.sameSideGap) {
        // 鎖が組めない同側の長い空白は、上の同側補完（1 本）に戻す
        const one = fillOne(prev, h);
        if (one) { out.splice(i, 0, one); i++; } else h.suspect = 'same-side';
        continue;
      }
      const ins = chain.map(c => ({ t: c.t, side: c.side, cls: "unknown", src: c.src && c.src.startsWith('far-') ? c.src : "track", from: { X: c.X, Z: c.Z }, qc: c.qc, gapFill: true, suspect: c.keptSameSide ? 'same-side' : undefined, farRise: c.rise }));
      out.splice(i, 0, ...ins); i += ins.length;
    }
    // tailFill（2026-09-24 opp0908）: 最後の打点の後に、打った側の自分のコートに星（着弾・スマッシュの着弾予告）が出たら、間で相手が打ち返している（自分の打球は自分のコートに落ちない）。
    // 反対側の追跡 hit を 1 本補う（星の 0.3 秒前まで）。0908 芝 p2: 103.77 me のあと 104.15 の相手のロブ（ルイージが飛びついて打ち上げ・104.1 に SMASH 表示）が
    // 最後の打点の後なので同側補完・空白補完のどちらにも掛からず落ちていた。自分側の星 104.90（k 16）。
    // 注意（検証役の目視）: 採られる 104.10 も接触の瞬間ではなく 0.12 秒早い非接触イベント（qc 0.22＝ルイージの位置に球が届いた所）で、しかも
    // 「最後の打点 +0.3 秒より後」の下限（103.77+0.3=104.07）を 0.03 秒で越えた境界の 1 本。下限を動かすと消える
    if (out.length && camAt && typeof Court !== 'undefined') {
      const last = out[out.length - 1];
      const star = markers.find(m => {
        if (m.t0 <= last.t + 0.6) return false;
        const cam = camAt(m.t0); if (!cam || !cam.ok) return false;
        const Z = Court.toCourt(m.x * 2, m.y * 2, cam).Z;
        return last.side === 'me' ? Z < -0.5 : Z > 0.5;
      });
      if (star) {
        const pool = events.filter(e => e.kind === 'hit' && e.side && e.side !== last.side && e.t > last.t + 0.3 && e.t <= star.t0 - 0.3);
        // qc 最大でなく**最も早い**もの: 星の前に相手が触れるのは 1 回だけで、それより後の hit は相手の体への乗り移り・ロブが画面上から
        // 降りてくる所の切れ目（p2 は 104.10 qc 0.22／104.50 qc 0.69・104.93 0.73＝その後の体の上の揺れ。
        // qc 最大だと 104.50 を採り GT 104.15 に +0.35 で「当たる」が中身は junk）
        const cand = pool.sort((a, b) => a.t - b.t)[0];
        if (cand) out.push({ t: cand.t, side: cand.side, cls: cand.src === 'far-lobpair' ? 'lob' : 'unknown', src: cand.src && cand.src.startsWith('far-') ? cand.src : 'track', from: { X: cand.X, Z: cand.Z }, qc: cand.qc, tailFill: true, farRise: cand.rise });
      }
    }
    // カメラの引きの直前の偽打点（prePull・上）を捨てる。種別の規則（頂点・tNext）より前
    for (let i = out.length - 1; i >= 0; i--) if (out[i].prePull) out.splice(i, 1);
    for (let i = 0; i < out.length; i++) {
      const h = out[i], tNext = i + 1 < out.length ? out[i + 1].t : t1;
      // ロブは色だけでは決まらない（クレイの黄ロブ 42〜56° と芝の橙トップスピン 33〜49° が重なる・2026-09-08 実測）。
      // 弾道の頂点で決める: 打点〜次の打点の追跡点の画面 y 最小が奥ベースライン行より 50px(960) 以上「上」なら高い球＝ロブ。
      // 実測: 芝/クレイの自分のロブ 13/15 が rel≤-50、トップスピンは -41〜+121。0.7 秒未満の飛行は判定しない
      // 起点はトレイルの時刻（far で寄せる前・2026-09-24 opplob）。apexAt ≥ 0.2 の閾値はトレイル由来の時刻で決めたもので、far で 0.12〜1.0 秒前へ寄せた時刻を起点にすると
      // 打点直後のラケットの高さの球（高さバイアス）が 0.2 秒後の「頂点」に見える（砂 0911 p5 158.8 の相手のトップスピン: far-turn 158.567 に寄って
      // 158.85 の −124 が apexAt 0.22 の頂点になり lob に化けた・v32 のトレイル起点では 0.10 で非ロブ。far-turn 自体は 157.65 の自分のロブが奥へ落ちてくる途中の曲がり）。
      // 寄せた時刻から球が上がり続けるロブは下の奥側の上がり方（farRise）で取る
      const tA = h.tTrail != null ? h.tTrail : h.t;
      const seg = track.filter(p => p.t > tA + 0.1 && p.t < tNext - 0.1);
      // サーブはロブにならない。最後の打点（次の打点が無い）は場外へ飛ぶ球まで含むので色が lob のときだけ
      const last = i + 1 >= out.length;
      if (i > 0 && !last && seg.length >= 4 && tNext - tA >= 0.7 && camAt && typeof Court !== 'undefined') {
        const mn = seg.reduce((a, p) => p.y < a.y ? p : a);
        const cam = camAt(mn.t);
        if (cam && cam.ok) {
          const yFar = Court.toScreen(0, Court.Z_BASE, cam).y / 2;
          h.apex = +(mn.y - yFar).toFixed(0);
          // 頂点の時刻が打点からどれだけ後か。ロブは 0.4 秒以上上がってから頂点、奥側の速い球はラケットの高さ分だけ上から出るので
          // 「頂点」が打点直後の最初の追跡点になる（砂 0911 p5 158.87: 追跡 158.97 で −83・0.10 秒後→ lob に化けた）。0.2 秒未満は頂点と見なさない（芝 0908 p5 138.50 の自分のロブは track 由来の打点が遅く 0.24）
          h.apexAt = +(mn.t - tA).toFixed(2);
          // drop も含める: 砂では黄ロブが淡く読めて 'drop' になる。ドロップは高く上がらないので頂点で否定できる
          if (h.apex <= -50 && h.apexAt >= 0.2 && (h.cls === 'topspin' || h.cls === 'lob' || h.cls === 'unknown' || h.cls === 'drop')) { if (h.cls !== 'lob') h.clsColor = h.cls; h.cls = 'lob'; }
        }
      }
      // トレイル自身の先端 y の最小（＝ボールが画面上でいちばん高く見えた位置）と奥ベースライン行の差。追跡が無いロブ（相手のロブ）の頂点判定に使う
      if (h.tyMin != null && camAt && typeof Court !== 'undefined') {
        const cam = camAt(h.t);
        if (cam && cam.ok) h.apexTrail = +(h.tyMin - Court.toScreen(0, Court.Z_BASE, cam).y / 2).toFixed(0);
        // 実測（0908 GT + 0908b p4/p5）: 相手のロブ −73〜−114／相手のトップスピン・フラット・スライス −19 以上／
        // 自分のロブ −65〜−68／自分のトップスピン −33 以上（1 本だけ −52）。サーブと最後の打点は除く
        const th = h.side === 'me' ? -60 : -50;
        // 頂点に「居る」コマ数。ロブは頂点で 0.4 秒漂う（0908b p4 192.20: 先端 y が閾値より上に 13 コマ）が、奥側の速い球はラケットの高さ分だけ
        // ベースラインより上（砂 0911 p5 158.90: −130）から出てすぐ降りる（併合後 8 コマ中 4 コマ・160.50 は 1 コマ）。6 コマ以上（0.2 秒）のときだけロブ
        // （0908b p4: 相手ロブ 192.17 は 13・自分のロブ 188.80 は 10・相手のトップスピン 191.20 は 4）
        if (h._tys && cam && cam.ok) {
          let dwell = 0;
          for (const f of h._tys) { const c = camAt(f.t) || cam; if (!c || !c.ok) continue; if (f.y - Court.toScreen(0, Court.Z_BASE, c).y / 2 <= th) dwell++; }
          h.apexDwell = dwell;
        }
        if (i > 0 && !last && h.apexTrail != null && h.apexTrail <= th && (h.apexDwell == null || h.apexDwell >= 6) && (h.cls === 'topspin' || h.cls === 'lob' || h.cls === 'unknown' || h.cls === 'drop')) {
          if (h.cls !== 'lob') h.clsColor = h.cls;
          h.cls = 'lob'; h.lobBy = 'trail';
        }
      }
      // 奥側の上がり方（tools/farball.js riseAfter・2026-09-24 opplob）: 相手の打点から球が 0.25 秒以上上がり続け（0.3 秒以内に 15px 以上降りない）30px 以上上がればロブ。
      // 奥から手前へ打つ球は奥行きで画面を下へ動くので、ロブ以外は打点直後から v が増える。高さ（ベースラインより何 px 上か）を使わないので、
      // 浅いロブ（クレイ 0908 p8 227.5: 頂点がベースラインより下・apex +11 で頂点規則に掛からない）も取れる。
      // 実測（v36 の奥側軌道・全 far イベント）: ロブ 227.53 D 0.42 R 73／砂 0911 p7 189.18 D 0.27 R 175（球が画面上端へ抜けて打ち切り）、
      // ロブでない打点に使われたイベントは D ≤ 0.17（0908 p0 56.19 のトップスピン 0.17・砂 158.68 0.17）。打点に使われていない
      // 上がる球が手前へ近づいているか（grow＝見かけの大きさの伸び ≥ 0.85）も課す: far の時刻寄せが入射球（奥へ遠ざかる自分の球）の上に乗ると、
      // その上がりがロブに見える（GT の無い全体走で 0908b p3 149.23 と 0911 p2 83.60 がこれ・grow 0.73/0.68。ロブは 1.6/1.1）。
      // 上がりの終わり（頂点）付近に強い far イベント（qc ≥ 1.0＝折り返して手前へ）があれば、その上がりは入射球（奥で跳ねた球・相手へ上がっていく球）で、
      // 本当の打点はその折り返し＝ロブではない（ハード 0908b p0 71.88: 跳ねた入射球が 72.25 まで上がり 72.233 far-turn 1.2 でクッパJr. が橙で打つ・grow 1.26 で grow では落ちない／
      // 砂 0911 p0 26.67: 26.917 far-turn 1.2 がパックンの打点）。本物のロブ（クレイ 227.53・芝 0908 p13 344.90）は上がりの途中に強いイベントが無い。
      // 砂 189.18 の後の 189.233/189.283（+0.05/+0.10・ロブの光の縁）を拾わないよう +0.15 秒から見る（2026-09-24 opplob 検証役のガード）
      const fr0 = h.farRise;
      const fr = fr0 && !events.some(e => e.kind === 'hit' && e.src && e.src.startsWith('far-') && (e.qc || 0) >= 1.0 && e.t > h.t + 0.15 && e.t <= h.t + fr0.s + fr0.D + 0.1) ? fr0 : null;
      if (i > 0 && h.side === 'opp' && fr && !fr.down && fr.D >= 0.25 && fr.R >= 30 && fr.grow != null && fr.grow >= 0.85 && (h.cls === 'topspin' || h.cls === 'lob' || h.cls === 'unknown' || h.cls === 'drop')) {
        if (h.cls !== 'lob') h.clsColor = h.cls;
        h.cls = 'lob'; h.lobBy = 'far';
      }
      delete h._tys;
      h.land = landingFromStar(markers, h.t, tNext, camAt, h.side) || landingFromTrack(track, h.t, tNext, camAt, h.side);
      if (h.land && h.land.Z != null) h.land.wrongSide = h.side === 'me' ? h.land.Z < -0.5 : h.land.Z > 0.5;
      h.serve = i === 0;
    }
    return { shots: out };
  }
  return { fuse, landingFromTrack, landingFromStar, purgeStatic };
})();
