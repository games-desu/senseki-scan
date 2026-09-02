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
    // fresh: そのポイントの始点が「得点直後のHUD復帰」ではなく、イントロ/長い演出のあとの復帰であることを示す。
    // イントロ直後はVS画面（名前入り）がHUD復帰後も0.25〜0.5秒うっすら残る（実測3素材・intro_*.jpg）ので始点を遅らせる
    let game = 1, start = null, fresh = true, lastState = null, lastSeg = null;
    const pushFinal = () => {
      const w = finalWinner(lastState);
      if (!w || !lastSeg) return;
      const st = start || lastSeg;
      points.push({
        game, winner: w, final: true, fresh,
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
            game, winner, final: false, fresh, scoreBefore: sb, scoreAfter: sa,
            hudOn: start.tOn, hudOnPrev: start.tOnPrev, hudOff: lastSeg.tOff, hudOffNext: lastSeg.tOffNext, gapEnd: sg.tOn,
          });
          start = sg; fresh = false;
        } else if (total(sg.first) < total(lastState)) {   // 6-4 → 0-0: 試合の切り替わり
          pushFinal();
          game++; start = sg; fresh = true;
        } else if (sb !== sa || gapDur > GAP_MERGE) {
          start = sg; fresh = true;                           // 読み違い/長い消灯（イントロ・演出）→ 仕切り直し
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
  // 消灯時刻は二分探索 → 後ろから手前へ1コマずつ読む確認パス（confirmOff）で決める。
  // 実機（フィーバーダブルス・草）で tail=+0.05 にしたら終端に名前バナーが映った（2026-09-02）: 二分探索は
  // シーク直後に前のフレームが残る（ステイル）と「まだ点灯」と誤読して遅れる側に外れる。確認パスで安全側に寄せた上で
  // 終端は消灯の2コマ手前（tail=-0.033）にする ＝ バナーまで9コマの余裕。
  // 最終ポイントはバナーが出ず、勝敗パネル（名前入り）は消灯の +3.8秒（実測7件）。
  const BANNER_DELAY = 0.117;
  const WINNER_DELAY = 3.8;
  // そのポイントで「名前が映り始める」時刻（編集UIの赤い区間・警告の起点）
  const nameLimit = p => +(p.hudOff + (p.final ? WINNER_DELAY - 0.3 : BANNER_DELAY - 0.017)).toFixed(3);
  // introLead: イントロ直後（fresh）の始点をずらす秒数。VS画面の残像は復帰後 ≤0.5秒（実測）
  const INTRO_LEAD = 1.0;
  function clipRanges(p, { shortSec = 5, tail = -0.033, lead = 0, introLead = INTRO_LEAD } = {}) {
    const e = +(p.hudOff + tail).toFixed(3);
    const s0 = Math.min(+(p.hudOn + lead + (p.fresh ? introLead : 0)).toFixed(3), e - 0.5);
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

  // 消灯時刻の確認: 後ろ（消灯側）から 1/60秒ずつ手前へ読み、最初に点灯が見えた次のコマを消灯とする。
  // ステイルフレームが起きても「後の（消灯）フレームが残る」＝点灯を見落として手前に寄る ＝ 安全側にしか外れない。
  // 推定より後ろでもまだ点灯していた（推定が早すぎた）場合だけ前へ進めて消灯を探し、見つけた所からもう一度手前確認する。
  async function confirmOff(seek, video, est, { step = 1 / 60, maxSteps = 40, depth = 0 } = {}) {
    const hudOn = () => Rl().readHud(video).hudOn;
    let t = est + 2 * step;
    await seek(t);
    if (hudOn()) {
      for (let k = 0; k < maxSteps; k++) { t += step; await seek(t); if (!hudOn()) break; }
      return depth === 0 ? confirmOff(seek, video, t, { step, maxSteps, depth: 1 }) : +t.toFixed(3);
    }
    for (let k = 0; k < maxSteps; k++) {
      t -= step; await seek(t);
      if (hudOn()) return +(t + step).toFixed(3);
    }
    return +t.toFixed(3);   // maxSteps 戻っても点灯が見えない → その時刻を消灯扱い（安全側）
  }

  // step: HUD消灯は2.4秒以上・ポイントは2秒以上なので 1.0秒刻みで取りこぼさない（0.5→1.0で走査時間が半分）。
  // 境界は二分探索＋確認パスで 1/60秒まで詰めるので粗さは精度に影響しない
  async function scanWindow(video, w, { step = 1.0, onProgress } = {}) {
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
      p.hudOff = await confirmOff(seek, video, p.hudOff);
      if (p.hudOnPrev != null) p.hudOn = await bisect(seek, p.hudOnPrev, p.hudOn, hudOn);
    }
    return { samples, points };
  }

  // 書き出し前の安全確認: 区間内にプレイヤー名が映るフレームがあれば区間を詰める。
  // 末尾は手前へ、先頭は後ろへ逃がし、内部に出た場合はそこで打ち切る。
  // interior=false なら区間の内部は見ない（自動区間はHUD点灯区間の内側なので末尾/先頭の確認だけで足りる。
  // 手修正で延ばした区間だけ内部も 0.5秒刻みで見る＝名前が映る画面はどれも1.5秒以上続くので取りこぼさない）
  async function guardRange(video, s, e, { step = 0.5, maxBack = 3.0, interior = true } = {}) {
    const seek = Vn().makeSeeker(video);
    const risky = async t => { await seek(t); return nameRisk(readFrame(video)); };
    let e2 = e, s2 = s;
    // 末尾は1/30秒刻みで詰める（終端はバナー出現の直前3フレームまで攻めているので、粗く戻すと損する）
    for (let k = 0; k * 0.034 < maxBack && e2 - s2 > 0.5; k++) { if (!(await risky(e2))) break; e2 = +(e2 - 0.034).toFixed(3); }
    for (let k = 0; k * 0.1 < maxBack && e2 - s2 > 0.5; k++) { if (!(await risky(s2))) break; s2 = +(s2 + 0.1).toFixed(3); }
    if (interior) {
      for (let t = s2 + step; t < e2 - 0.05; t += step) {
        if (await risky(t)) { e2 = +(t - 0.1).toFixed(3); break; }
      }
    }
    return { s: s2, e: e2, changed: Math.abs(s2 - s) > 1e-6 || Math.abs(e2 - e) > 1e-6 };
  }

  return { BANNER, BANNER_DELAY, WINNER_DELAY, INTRO_LEAD, nameLimit, readFrame, usable, nameRisk, total, finalWinner, matchWindows, buildPoints, clipRanges, scanWindow, guardRange, bisect, confirmOff, GAP_MERGE };
})();
