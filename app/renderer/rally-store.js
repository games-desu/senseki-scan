// SENSEKI SCAN — ラリー解析の保存形式（録画1本 = 1ファイル）と CSV 書き出し
// ブラウザ（手直し画面）と Node（tools/rally-to-store.js・rally-store-gt.js）の両方から使う。
//
// 保存形式 v1:
// { v:1, kind:'senseki-rally',
//   video:{ name, path, size, fps, w, h, duration, start },        // start = 録画の開始日時（ファイル名から。不明なら null）
//   engine:{ variant, at },  createdAt, updatedAt,
//   matches:[{ no, playedAt,                                        // playedAt = 'YYYY-MM-DD HH:MM:00'（SENSEKI FEVER の played_at と同じ形）
//     points:[{ idx, t0, t1, before, after, winner:'me'|'opp'|null, final, done,
//       det:[ 打 ],                                                 // 解析が出したままの打（「検出結果に戻す」とGT作りに使う。触らない）
//       shots:[ 打 ] }] }] }                                        // 手直し後の打（未確認なら det の写し）
// 打 = { t, side:'me'|'opp', cls, serve?, land?:[X,Z,inCourt], src?, e?:1 }   t は録画の先頭からの秒。e = 手で直した印
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RallyStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 球種。先頭7つが通常の表示、残り3つは調整用GTのときだけ出す（トレイルに色が付かない打球）
  const CLS = [
    ['topspin', 'トップスピン', '#ef5b6e'], ['slice', 'スライス', '#4ea3f5'], ['flat', 'フラット', '#b088f5'],
    ['lob', 'ロブ', '#f2c230'], ['drop', 'ドロップ', '#e8ecea'], ['fever', 'フィーバー', '#ff8f40'], ['unknown', '不明', '#56665e'],
    ['slide', 'スライドフットワーク', '#7fc8b4'], ['dive', 'とびつき', '#c9a27a'], ['feverback', 'フィーバー返し', '#f0a0d0'],
  ];
  const MAIN_CLS = 7;

  const r3 = x => Math.round(x * 1000) / 1000;
  const r1 = x => Math.round(x * 10) / 10;

  // 解析結果（rally-node の rally[] の1打）→ 保存形式の打
  function shotFromAnalysis(s) {
    const o = { t: r3(s.t), side: s.side, cls: s.cls || 'unknown' };
    if (s.serve) o.serve = true;
    if (s.land) o.land = [r1(s.land.X), r1(s.land.Z), s.land.inCourt ? 1 : 0];
    if (s.src) o.src = s.src;
    return o;
  }

  const pad = n => String(n).padStart(2, '0');
  const fmtDT = d => (!d || isNaN(d.getTime())) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  // OBS 形式のファイル名（2026-09-08 23-03-03.mp4）から録画の開始日時。index.html の parseStartTime の先頭と同じ規則
  function startFromName(name) {
    const m = /(?<!\d)(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:](\d{2})(?:[-:](\d{2}))?(?!\d)/.exec(name || '');
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return isNaN(d.getTime()) ? null : d;
  }

  // pts.json（rally.js のポイント境界）＋ ポイントごとの解析結果 → 保存形式
  //   ptsJson: { info:{w,h,duration}, points:[{game, winner, final, scoreBefore, scoreAfter, hudOn, hudOff}] }
  //   details: idx → { t0, t1, fps, variant, rally:[...] }（無いポイントは打0で載せる）
  function fromAnalysis(ptsJson, details, video) {
    const start = video.start ? new Date(video.start) : startFromName(video.name);
    const byGame = new Map();
    ptsJson.points.forEach((p, idx) => {
      const d = details[idx];
      const det = d ? (d.rally || []).map(shotFromAnalysis) : [];
      const pt = {
        idx, t0: r3(d ? d.t0 : p.hudOn), t1: r3(d ? d.t1 : p.hudOff + 0.3),
        before: p.scoreBefore || '', after: p.scoreAfter || '', winner: p.winner || null, final: !!p.final,
        done: false, det, shots: det.map(s => ({ ...s })),
      };
      if (!d) pt.missing = true;
      if (!byGame.has(p.game)) byGame.set(p.game, []);
      byGame.get(p.game).push(pt);
    });
    const anyD = Object.values(details)[0] || {};
    const now = new Date().toISOString();
    return {
      v: 1, kind: 'senseki-rally',
      video: {
        name: video.name, path: video.path || null, size: video.size || null, fps: anyD.fps || video.fps || 60,
        w: ptsJson.info?.w || null, h: ptsJson.info?.h || null, duration: ptsJson.info?.duration || null,
        start: start ? start.toISOString() : null,
      },
      engine: { variant: anyD.variant || null, at: now },
      createdAt: now, updatedAt: now,
      matches: [...byGame.entries()].map(([no, points]) => ({
        no, playedAt: start ? fmtDT(new Date(start.getTime() + points[0].t0 * 1000)) : '', points,
      })),
    };
  }

  // 要確認の印。返り値は打ごとの理由（無ければ null）
  function flags(shots) {
    return shots.map((s, i) => {
      const why = [];
      if (s.cls === 'unknown') why.push('種別不明');
      if (i > 0 && shots[i - 1].side === s.side) why.push('同じ側が連続');
      return why.length ? why.join('・') : null;
    });
  }

  // 打 h に対応する元の検出（同じ側・±0.6秒以内で最も近いもの）
  function nearestDet(det, h) {
    let best = null;
    for (const d of det) if (d.side === h.side && (best == null || Math.abs(d.t - h.t) < Math.abs(best.t - h.t))) best = d;
    return best && Math.abs(best.t - h.t) <= 0.6 ? best : null;
  }

  // ---- SENSEKI FEVER 向け CSV（1打1行）----
  // played_at で SENSEKI FEVER の対戦に結び付ける（SCAN の戦績CSVと同じ played_at になる。分の境目で1分ずれることがあるので、取り込み側は±数分で照合）
  const CSV_HEADERS = ['played_at', 'match_no', 'point_no', 'score_before', 'score_after', 'point_winner',
    'shot_no', 'time_sec', 'video_sec', 'side', 'shot_type', 'serve', 'land_x', 'land_z', 'land_in', 'checked', 'edited'];
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // opt.onlyDone: 確認済みのポイントだけ書く
  function toCsv(store, opt = {}) {
    const rows = [CSV_HEADERS.join(',')];
    for (const m of store.matches) {
      m.points.forEach((p, pi) => {
        if (opt.onlyDone && !p.done) return;
        p.shots.forEach((s, si) => {
          rows.push([
            m.playedAt, m.no, pi + 1, p.before, p.after, p.winner || '',
            si + 1, (s.t - p.t0).toFixed(3), s.t.toFixed(3), s.side, s.cls, s.serve ? 1 : 0,
            s.land ? s.land[0] : '', s.land ? s.land[1] : '', s.land ? s.land[2] : '',
            p.done ? 1 : 0, s.e ? 1 : 0,
          ].map(cell).join(','));
        });
      });
    }
    return rows.join('\r\n') + '\r\n';
  }

  // ---- 調整用GT（tools/rally-bench2.js が読む gt-edit 形式）----
  // 確認済みのポイントだけ。idx は pts.json の並び（= 解析結果 p<idx>.json の番号）
  function toGt(store) {
    const points = [];
    for (const m of store.matches) for (const p of m.points) {
      if (!p.done) continue;
      points.push({
        idx: p.idx, t0: p.t0, t1: p.t1, edited: store.updatedAt,
        hits: p.shots.map(s => ({ t: s.t, side: s.side, cls: s.cls, ...(s.serve ? { serve: true } : {}) })),
      });
    }
    return { video: store.video.name, note: 'SENSEKI SCAN の手直し画面から', points };
  }

  function counts(store) {
    let pts = 0, done = 0, shots = 0, flagged = 0;
    for (const m of store.matches) for (const p of m.points) {
      pts++; if (p.done) done++;
      shots += p.shots.length; flagged += flags(p.shots).filter(Boolean).length;
    }
    return { pts, done, shots, flagged };
  }

  return { CLS, MAIN_CLS, fromAnalysis, shotFromAnalysis, startFromName, fmtDT, flags, nearestDet, CSV_HEADERS, toCsv, toGt, counts };
});
