// SENSEKI SCAN ハイライト生成 — 認識ロジック（ブラウザ用・依存: Vision, Rally）
// 得点HUDの消灯区間からポイント境界を取り（Rally / Phase A）、各ポイントの
//   ① サーブ構え（HUD復帰）〜得点確定（HUD消灯）
//   ② 得点確定の直前N秒
// を切り抜き区間として返す。ポイント間の黒いスコアバナーには**プレイヤー名が載る**ため、
// 区間の終端は必ず HUD 消灯より手前に置く（deuce-pips.md: 消灯 +0.05秒でバナー出現）。
// 純粋関数（buildPoints / clipRanges）は tools/highlight-node.js からヘッドレスでも検証できる。
window.Highlight = (() => {
  const Vn = () => window.Vision;
  const Rl = () => window.Rally;

  // ポイント間バナーのピップ（deuce-pips.md 実測: バナー左ピル x667-848 / 右 x1071-1252, y977-1014）。
  // コーナーHUDのピル(x31-212)と同じ形なので Rally.readSide をそのまま使う（present 判定だけ使う）
  const BANNER = {
    pipL: { x: 655,  y: 975, w: 206, h: 42 },
    pipR: { x: 1059, y: 975, w: 206, h: 42 },
    numL: { x: 860,  y: 960, w: 60,  h: 60 },  // 使わない（present判定のみ）。小さくして安く済ませる
    numR: { x: 1000, y: 960, w: 60,  h: 60 },
  };

  // 1フレーム読む: コーナーHUD + シーン + ポイント間バナー
  function readFrame(video) {
    const hud = Rl().readHud(video);
    const cls = Vn().classify(Vn().frameToData(video, 192, 108));
    let banner = false;
    if (!hud.hudOn) {
      const bl = Rl().readSide(video, 'L', BANNER), br = Rl().readSide(video, 'R', BANNER);
      banner = bl.present && br.present;
    }
    return { hudOn: hud.hudOn, L: hud.L, R: hud.R, cls, banner };
  }

  // 数字まで描かれた（フェードイン完了の）HUD だけを得点状態として使う（rally.js と同じ NUM_MIN_W=30）
  const usable = s => !!s && s.hudOn && s.L.numW >= 30 && s.R.numW >= 30;
  // プレイヤー名が映るフレームか（ポイント間バナー / VS画面 / 勝敗パネル）
  const nameRisk = s => !!s && (s.banner || s.cls === 'vs' || s.cls === 'winner');

  // 得点の総数（試合の切り替わり = 総数が減る、で検知する）
  function total(s) {
    if (!usable(s)) return null;
    if (s.L.mode === 'deuce') return 12 + (s.L.adv || s.R.adv ? 1 : 0);
    return s.L.lit + s.R.lit;
  }
  // 試合最終ポイントの勝者: 得点した側は「7点目」なので、直前の状態から一意に決まる
  //   通常: 片側だけ6 → その側 / デュース: Adv.側 / それ以外 → 試合が終わっていない（回線切れ等）
  function finalWinner(s) {
    if (!usable(s)) return null;
    if (s.L.mode === 'deuce') return s.L.adv ? 'me' : (s.R.adv ? 'opp' : null);
    if (s.L.lit === 6 && s.R.lit < 6) return 'me';
    if (s.R.lit === 6 && s.L.lit < 6) return 'opp';
    return null;
  }

  // ---- 試合窓（シーン走査の結果から）----
  // vs → (winner) → rating で1試合。前試合が rating で閉じる前の vs は試合中UIの誤分類（groupMatches と同じ規則）。
  // COM戦などレートパネルが無い録画は1つの窓に複数試合が入るが、buildPoints が得点のリセットで試合を分ける。
  function matchWindows(events, duration) {
    const evs = events.filter(e => e.type === 'vs' || e.type === 'winner' || e.type === 'rating').sort((a, b) => a.t0 - b.t0);
    const wins = [];
    for (const e of evs) {
      const cur = wins[wins.length - 1];
      if (e.type === 'vs') {
        if (cur && !cur.closed) continue;
        wins.push({ vs: e, t0: e.t1 + 0.5, t1: null, closed: false });
      } else if (cur && !cur.closed) {
        if (e.type === 'winner') cur.winner = e;
        else { cur.rating = e; cur.t1 = e.t0; cur.closed = true; }
      }
    }
    for (const w of wins) if (w.t1 == null) w.t1 = duration;
    if (!wins.length) return [{ vs: null, t0: 0.2, t1: duration, closed: false, fallback: true }];
    return wins;
  }

  // ---- ポイント化（純粋関数）----
  // samples: [{t, hudOn, L, R, cls, banner}] 時刻順（等間隔でなくてよい）
  // 返り値: [{game, winner, scoreBefore, scoreAfter, final, hudOn, hudOnPrev, hudOff, hudOffNext, gapEnd}]
  //   hudOn/hudOff は「点灯が観測された最初/最後の時刻」、hudOnPrev/hudOffNext はその外側の消灯観測時刻
  //   （renderer 側で二分探索して精密化する）
  const GAP_MERGE = 4.5;   // 秒: 得点が動かない短い消灯（リプレイ・演出）は同じポイントの続きとみなす

  function buildPoints(samples) {
    const segs = [];
    let i = 0;
    while (i < samples.length) {
      if (!samples[i].hudOn) { i++; continue; }
      const s = i;
      while (i < samples.length && samples[i].hudOn) i++;
      const arr = samples.slice(s, i);
      segs.push({
        tOn: samples[s].t, tOff: samples[i - 1].t,
        tOnPrev: s > 0 ? samples[s - 1].t : null,
        tOffNext: i < samples.length ? samples[i].t : null,
        first: arr.find(usable) || null,
        last: [...arr].reverse().find(usable) || null,
        clsAfter: i < samples.length ? samples[i].cls : null,
      });
    }

    // 「直前の読める得点(lastState)」と「次に読めた得点」を比べる。数字が描かれていない一瞬のセグメント
    // （フェードイン・演出）が間に挟まっても比較が途切れないように、読めないセグメントは飛ばす。
    const points = [];
    let game = 1, start = null, lastState = null, lastSeg = null;
    const pushFinal = () => {
      const w = finalWinner(lastState);
      if (!w || !lastSeg) return;
      const st = start || lastSeg;
      points.push({
        game, winner: w, final: true,
        scoreBefore: Rl().scoreLabel(lastState), scoreAfter: w === 'me' ? '勝ち' : '負け',
        hudOn: st.tOn, hudOnPrev: st.tOnPrev, hudOff: lastSeg.tOff, hudOffNext: lastSeg.tOffNext,
        gapEnd: lastSeg.tOffNext != null ? lastSeg.tOffNext + 2.5 : lastSeg.tOff + 2.5,
      });
    };
    for (const sg of segs) {
      if (!start) start = sg;
      if (usable(sg.first) && lastState && lastSeg) {
        const sb = Rl().scoreLabel(lastState), sa = Rl().scoreLabel(sg.first);
        const winner = sb !== sa ? Rl().whoScored(lastState, sg.first) : null;
        const gapDur = sg.tOn - lastSeg.tOff;
        if (winner) {
          points.push({
            game, winner, final: false, scoreBefore: sb, scoreAfter: sa,
            hudOn: start.tOn, hudOnPrev: start.tOnPrev, hudOff: lastSeg.tOff, hudOffNext: lastSeg.tOffNext, gapEnd: sg.tOn,
          });
          start = sg;
        } else if (total(sg.first) < total(lastState)) {   // 6-4 → 0-0: 試合の切り替わり
          pushFinal();
          game++; start = sg;
        } else if (sb !== sa || gapDur > GAP_MERGE) {
          start = sg;                                         // 読み違い/長い消灯（イントロ・演出）→ 仕切り直し
        }
        // 同じ得点で短い消灯（リプレイ等）は同じポイントの続き: start を維持
      }
      if (usable(sg.last)) { lastState = sg.last; lastSeg = sg; }
      else if (usable(sg.first)) { lastState = sg.first; lastSeg = sg; }
    }
    pushFinal();
    return points;
  }

  // ---- 切り抜き区間 ----
  // 終端 = HUD消灯 + tail。名前入りバナーは消灯の **+0.117秒（60fpsで7フレーム）** 後に出る
  // （2026-09-02 実測40か所: 砂/フィーバー/ダブルス・1080p/720p すべて 0.116〜0.117 で一定）。
  // 消灯時刻は二分探索で 1/60秒精度（真の消灯〜+0.017）なので、tail=0.05 でも最悪 +0.067 ＝ バナーまで3フレーム残る。
  // 最終ポイントはバナーが出ず、勝敗パネル（名前入り）は消灯の +3.8秒（実測7件）。
  const BANNER_DELAY = 0.117;
  const WINNER_DELAY = 3.8;
  // そのポイントで「名前が映り始める」時刻（編集UIの赤い区間・警告の起点）
  const nameLimit = p => +(p.hudOff + (p.final ? WINNER_DELAY - 0.3 : BANNER_DELAY - 0.017)).toFixed(3);
  function clipRanges(p, { shortSec = 5, tail = 0.05, lead = 0 } = {}) {
    const e = +(p.hudOff + tail).toFixed(3);
    const s0 = +(p.hudOn + lead).toFixed(3);
    return {
      full:  { s: s0, e },
      short: { s: Math.max(s0, +(e - shortSec).toFixed(3)), e },
    };
  }

  // ---- 時間軸の走査（renderer 用・video要素をシークして読む）----
  async function bisect(seek, tFalse, tTrue, pred, prec = 0.034) {
    let lo = tFalse, hi = tTrue;
    while (hi - lo > prec) {
      const m = (lo + hi) / 2;
      await seek(m);
      if (pred()) hi = m; else lo = m;
    }
    return +hi.toFixed(3);
  }

  async function scanWindow(video, w, { step = 0.5, onProgress } = {}) {
    const seek = Vn().makeSeeker(video);
    const samples = [];
    const t1 = Math.min(w.t1, video.duration - 0.1);
    for (let t = w.t0; t <= t1; t += step) {
      await seek(t);
      samples.push({ t: +t.toFixed(3), ...readFrame(video) });
      if (onProgress) onProgress(t, w);
    }
    const points = buildPoints(samples);
    // 境界の精密化（消灯開始＝バナー出現の直前。ここの精度が「名前を映さない」の要）
    for (const p of points) {
      const hudOn = () => Rl().readHud(video).hudOn;
      if (p.hudOffNext != null) p.hudOff = await bisect(seek, p.hudOff, p.hudOffNext, () => !hudOn(), 0.017);
      if (p.hudOnPrev != null) p.hudOn = await bisect(seek, p.hudOnPrev, p.hudOn, hudOn);
    }
    return { samples, points };
  }

  // 書き出し前の安全確認: 区間内にプレイヤー名が映るフレームがあれば区間を詰める。
  // 末尾は手前へ、先頭は後ろへ逃がし、内部に出た場合はそこで打ち切る。
  async function guardRange(video, s, e, { step = 0.25, maxBack = 3.0 } = {}) {
    const seek = Vn().makeSeeker(video);
    const risky = async t => { await seek(t); return nameRisk(readFrame(video)); };
    let e2 = e, s2 = s;
    // 末尾は1/30秒刻みで詰める（終端はバナー出現の直前3フレームまで攻めているので、粗く戻すと損する）
    for (let k = 0; k * 0.034 < maxBack && e2 - s2 > 0.5; k++) { if (!(await risky(e2))) break; e2 = +(e2 - 0.034).toFixed(3); }
    for (let k = 0; k * 0.1 < maxBack && e2 - s2 > 0.5; k++) { if (!(await risky(s2))) break; s2 = +(s2 + 0.1).toFixed(3); }
    for (let t = s2 + step; t < e2 - 0.05; t += step) {
      if (await risky(t)) { e2 = +(t - 0.1).toFixed(3); break; }
    }
    return { s: s2, e: e2, changed: Math.abs(s2 - s) > 1e-6 || Math.abs(e2 - e) > 1e-6 };
  }

  return { BANNER, BANNER_DELAY, WINNER_DELAY, nameLimit, readFrame, usable, nameRisk, total, finalWinner, matchWindows, buildPoints, clipRanges, scanWindow, guardRange, bisect, GAP_MERGE };
})();
