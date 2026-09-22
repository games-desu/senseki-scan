// SENSEKI SCAN ラリー解析: 奥側（相手コート）のボール追跡をフル解像度 1920×1080・60fps で行う（Node 専用・2026-09-23）。
//
// 背景（docs/rally-analysis.md 2026-09-23 深夜）: 相手側の打点はトレイル（彗星の頭が小さく丸い）でも 960 のボール追跡（球が 9〜11px）でも
// 取れず、0908 ベンチの取りこぼし 7 本中 6 本・砂の奥側の全てがこれ。フル解像度なら球は 12〜30px で、ball.js の色述語だけで
// 砂・クレイは球が一本の軌道として追え、芝も動く球は追える（samples/rally/far-ball-probe.js）。
//
// 方針: 奥ベースラインの前後だけ（カメラ推定から帯を決める）を ffmpeg の crop で 60fps で流し、
//   ① ball.js と同じ色述語 → 連結成分 → 期待直径で篩う（静止物は前コマとの重なりで捨てる）
//   ② 最近傍で軌道に繋ぐ（跳び 45px/コマ・欠測 4 コマまで）
//   ③ 打点＝軌道の「折り返し」（進行方向が 70° 以上変わる／止まって別方向へ動き出す）と、
//      軌道の「出現」（直前 0.3 秒に軌道が無く、相手の近くから動き出す＝サーブ画のパックンのように入射球が隠れる砂の場面）
//   ③' 折り返し後に手前へ向かう球は qc 1.2、上へ向かう球（ロブかバウンド）は 0.85。星マーカー（着弾）の近くの折り返しはバウンドとして捨てる
//   ④ 960 空間の 'hit' イベント（kind/side/qc/X/Z）として返し、rally-fuse の同側補完・空白補完に流す（種別は付けない）
//
//   FarBall.track({ video, t0, t1, fps, cams, Court, yFarAt }) → { events, tracks, band }
//   node tools/farball.js <video> <t0> <t1> --json p.json   （p.json の cams を使って単体で走らせる）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FW = 1920, FH = 1080, SC = 2, YVP = -651;
const expectDiam = yF => 0.0155 * (yF - YVP);
const isBall = (r, g, b) => { if (g < 160) return false; const rg = r / g, bg = b / g; return rg > 0.84 && rg < 1.02 && bg > 0.28 && bg < 0.68; };
// HUD（FHD）: 左上の実況吹き出し＋名札・右上のスコア
const HUD = [{ x: 0, y: 0, w: 480, h: 460 }, { x: 1340, y: 0, w: 580, h: 160 }];

function findFfmpeg() {
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, 'ffmpeg.exe'); if (fs.existsSync(p)) return p; }
  return 'ffmpeg';
}
async function* frames(video, t0, t1, fps, band) {
  const BYTES = FW * band.h * 4;
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-t', String(Math.max(0.001, t1 - t0)), '-i', video,
    '-vf', `fps=${fps},crop=${FW}:${band.h}:0:${band.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  ff.stderr.on('data', d => process.stderr.write(d));
  let buf = Buffer.alloc(0), i = 0;
  for await (const c of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= BYTES) { yield { i, t: +(t0 + i / fps).toFixed(4), raw: buf.subarray(0, BYTES) }; i++; buf = buf.subarray(BYTES); }
  }
}

// ---- 帯: 奥ベースライン（960 空間の y）の −150〜+120px をフル解像度に直したもの。カメラのドリー分は全カメラの min/max で吸収 ----
function bandFor(cams, Court) {
  const ys = cams.map(c => Court.toScreen(0, Court.Z_BASE, c).y).filter(y => isFinite(y));
  if (!ys.length) return null;
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - 300)), y1 = Math.min(FH, Math.ceil(Math.max(...ys) + 240));
  if (y1 - y0 < 100) return null;
  return { y: y0, h: y1 - y0 };
}

function components(mask, W, H, minN) {
  const seen = new Uint8Array(W * H), stack = new Int32Array(W * H), out = [];
  for (let idx = 0; idx < W * H; idx++) {
    if (!mask[idx] || seen[idx]) continue;
    let sp = 0; stack[sp++] = idx; seen[idx] = 1; const pts = [];
    while (sp) {
      const j = stack[--sp]; pts.push(j); const jx = j % W, jy = (j / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const nx = jx + dx, ny = jy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const k = ny * W + nx;
        if (mask[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
      }
    }
    if (pts.length >= minN) out.push(pts);
  }
  return out;
}

// ---- ①: 1 コマの球候補（フル解像度座標） ----
function candidates(raw, band, prevMask) {
  const W = FW, H = band.h, mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const yF = y + band.y;
    for (let x = 0; x < W; x++) {
      let hud = false;
      for (const r of HUD) if (x >= r.x && x < r.x + r.w && yF >= r.y && yF < r.y + r.h) { hud = true; break; }
      if (hud) continue;
      const i = (y * W + x) * 4;
      if (isBall(raw[i], raw[i + 1], raw[i + 2])) mask[y * W + x] = 1;
    }
  }
  const out = [];
  for (const pts of components(mask, W, H, 20)) {
    let sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, ov = 0, sr = 0, sg = 0;
    for (const j of pts) { const x = j % W, y = (j / W) | 0; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (prevMask && prevMask[j]) ov++; const i = j * 4; sr += raw[i]; sg += raw[i + 1]; }
    // 球の核は r/g 0.94 前後（砂 0.94〜0.99・クレイ 0.95〜0.98・芝のロブ 0.91〜0.93）。芝の明るい縞とライン縁は 0.84〜0.87 で述語の下端に張り付く
    if (sr / sg < 0.90) continue;
    const n = pts.length, cx = sx / n, cy = sy / n, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const dF = expectDiam(cy + band.y), A = 0.785 * dF * dF;
    if (n < 0.35 * A || n > 4.0 * A) continue;          // 上限 4A: フル解像度では球に光沢と影が付いて 3A を超える（砂 157.2: n 287 / A 170）
    if (n / (bw * bh) < 0.45) continue;                   // 球は丸い。芝のライン縁（18x10 f0.4）を落とす
    if (Math.max(bw, bh) > 3.0 * dF || Math.max(bw, bh) > 2.0 * Math.min(bw, bh)) continue;
    out.push({ x: cx, y: cy + band.y, n, bw, bh, ov: ov / n, rg: +(sr / sg).toFixed(3) });
  }
  out.mask = mask;
  return out;
}

// ---- ②: 最近傍で軌道に繋ぐ ----
function link(frameCands, fps) {
  const open = [], done = [];
  const MAXJ = 45, MAXGAP = 4;
  for (const f of frameCands) {
    const used = new Set();
    for (const tr of open) {
      const last = tr.pts[tr.pts.length - 1];
      const k = Math.round((f.t - last.t) * fps);
      if (k > MAXGAP + 1) continue;
      // 予測位置（直近 2 点の速度）
      let px = last.u, py = last.v;
      if (tr.pts.length >= 2) { const p2 = tr.pts[tr.pts.length - 2]; const dk = Math.max(1, Math.round((last.t - p2.t) * fps)); px += (last.u - p2.u) / dk * k; py += (last.v - p2.v) / dk * k; }
      let best = null, bd = Infinity;
      for (const c of f.cands) {
        if (used.has(c)) continue;
        const d = Math.hypot(c.u - px, c.v - py), d0 = Math.hypot(c.u - last.u, c.v - last.v);
        // 欠測をまたぐ跳びは 120px まで（球は最速 25〜30px/コマ・4 コマで 100〜120px）。45×k のままだと 5 コマ空きで 225px 跳べて、
        // 別物へ乗り移った末尾が「軌道のペア」の偽の折り返しを作る（芝ランクマ 15-18-15 p8 205.98: 405→197 の 208px 跳び）
        const lim = Math.min(MAXJ * k, 120);
        if (Math.min(d, d0) > lim) continue;
        if (d < bd) { bd = d; best = c; }
      }
      if (best) { used.add(best); tr.pts.push({ t: f.t, x: best.x, y: best.y, u: best.u, v: best.v, n: best.n }); }
    }
    // 開いている軌道のうち欠測が長いものは閉じる
    for (let i = open.length - 1; i >= 0; i--) { const last = open[i].pts[open[i].pts.length - 1]; if (Math.round((f.t - last.t) * fps) > MAXGAP) { done.push(open[i]); open.splice(i, 1); } }
    // 残りの候補は新しい軌道（静止物は前コマとの重なりで捨てる）
    for (const c of f.cands) { if (used.has(c) || c.ov >= 0.85) continue; open.push({ pts: [{ t: f.t, x: c.x, y: c.y, u: c.u, v: c.v, n: c.n }] }); }
  }
  done.push(...open);
  return done.filter(tr => tr.pts.length >= 4).map(tr => { tr.t0 = tr.pts[0].t; tr.t1 = tr.pts[tr.pts.length - 1].t; return tr; }).sort((a, b) => a.t0 - b.t0);
}

// ---- ③: 折り返し・出現 ----
function velAt(pts, i, dir) {          // dir=-1: i の手前 3 点の平均速度（px/コマ）, +1: 後ろ 3 点
  const a = dir < 0 ? pts[Math.max(0, i - 3)] : pts[i], b = dir < 0 ? pts[i] : pts[Math.min(pts.length - 1, i + 3)];
  const dk = Math.max(1, Math.round((b.t - a.t) * 60));
  return { vx: (b.u - a.u) / dk, vy: (b.v - a.v) / dk };
}
const speed = v => Math.hypot(v.vx, v.vy);
const angle = (a, b) => { const d = speed(a) * speed(b); if (d < 1e-6) return 0; return Math.acos(Math.max(-1, Math.min(1, (a.vx * b.vx + a.vy * b.vy) / d))) * 180 / Math.PI; };

function events(tracks, band, Court, camAt, markers = []) {
  const out = [];
  const push = (t, x, y, qc, how) => {
    const cam = camAt ? camAt(t) : null;
    if (process.env.FARDBG) console.error('push', t.toFixed(3), Math.round(x), Math.round(y), how, cam ? (cam.ok + ' ' + cam.t) : 'nocam');
    if (!cam || !cam.ok || (cam.t != null && Math.abs(cam.t - t) > 0.5)) return;   // ラリーカメラが立っている時刻だけ（サーブ画・カット直後の候補は別の画の物）
    // 着弾の星マーカー（tools/star.js）の 0.25 秒・80px 以内の折り返しはバウンド（奥へ打った球が落ちて跳ね返る＝画面では下→上の折り返しになる）
    if (markers.some(m => Math.abs(m.t0 - t) <= 0.25 && Math.hypot(m.x - x / SC, m.y - y / SC) <= 80)) return;
    const c = Court.toCourt(x, y, cam);
    if (!isFinite(c.Z) || c.Z < 4 || c.Z > 22 || Math.abs(c.X) > 9) return;   // 相手の居場所だけ（Z 4〜22: 高さバイアスで実際より奥に出る。観客席は Z 23〜30）
    out.push({ t: +t.toFixed(3), x: +(x / SC).toFixed(1), y: +(y / SC).toFixed(1), kind: 'hit', qc, side: 'opp', src: 'far-' + how,
               X: isFinite(c.X) ? +c.X.toFixed(2) : null, Z: isFinite(c.Z) ? +c.Z.toFixed(2) : null, inCourt: isFinite(c.X) ? Court.inCourt(c.X, c.Z, 0.6) : null });
  };
  for (const tr of tracks) {
    const p = tr.pts;
    // 折り返し: 手前 3 点と後ろ 3 点の速度が 70° 以上違い、どちらも 2px/コマ以上
    let lastAt = -1;
    for (let i = 3; i < p.length - 3; i++) {
      const a = velAt(p, i, -1), b = velAt(p, i, +1);
      if (speed(a) < 2.5 || speed(b) < 2.5) continue;
      // 折り返し後に手前へ向かう（vy>0）なら 45° で足りる: 奥コートで手前へ曲がるのは相手が打ったときだけ（バウンドは上へ＝vy<0）。芝 0908 p0 58.0 は 59°
      if (angle(a, b) < (b.vy > 0 ? 45 : 60)) continue;
      if (lastAt >= 0 && p[i].t - p[lastAt].t < 0.25) continue;
      lastAt = i;
      push(p[i].t, p[i].x, p[i].y, b.vy > 0 ? 1.2 : 0.85, 'turn');
    }
    // 停止を挟む折り返し: 球はラケットに当たる瞬間 2〜4 コマ止まる（芝 0908 p0 58.0: 57.83〜57.88 で (1210,272) に静止→58.03 から手前へ）。
    // 3 点窓の速度が両側とも 2.5 未満になるので上の折り返しでは取れない。停止区間（1 コマの移動 2px 未満が 2 歩以上）の前後の速度で判定する
    for (let i = 1; i < p.length; i++) {
      const step = (j) => Math.hypot(p[j].u - p[j - 1].u, p[j].v - p[j - 1].v) / Math.max(1, Math.round((p[j].t - p[j - 1].t) * 60));
      if (step(i) >= 2) continue;
      let i1 = i; while (i1 + 1 < p.length && step(i1 + 1) < 2) i1++;
      const i0 = i - 1;
      if (i1 - i0 >= 2 && i0 >= 3 && i1 + 3 < p.length) {
        const a = velAt(p, i0, -1), b = velAt(p, i1, +1);
        if (speed(a) >= 2.5 && speed(b) >= 2.5 && angle(a, b) >= (b.vy > 0 ? 45 : 60)) push(p[(i0 + i1) >> 1].t, p[(i0 + i1) >> 1].x, p[(i0 + i1) >> 1].y, b.vy > 0 ? 1.2 : 0.85, 'stall');
      }
      i = i1;
    }
    // 軌道のペア: 直前 0.35 秒以内・120px 以内で終わる軌道があり、その末尾の向きと この軌道の出だしの向きが 60° 以上違えば、間で折り返した（ラケットと閃光で球が隠れる）
    const prevTr = tracks.filter(o => o !== tr && o.t1 <= tr.t0 && tr.t0 - o.t1 <= 0.35 && Math.hypot(o.pts[o.pts.length - 1].u - p[0].u, o.pts[o.pts.length - 1].v - p[0].v) <= 120);
    const v0 = velAt(p, 0, +1);
    if (prevTr.length) {
      const o = prevTr[prevTr.length - 1]; let va = velAt(o.pts, o.pts.length - 1, -1);
      // 先行軌道の末尾が停止していたら（ラケットに当たった瞬間）、停止の手前の速度を使う
      if (speed(va) < 2.5) { let j = o.pts.length - 1; while (j > 0 && Math.hypot(o.pts[j].u - o.pts[j - 1].u, o.pts[j].v - o.pts[j - 1].v) < 2 && o.t1 - o.pts[j - 1].t <= 0.15) j--; if (j >= 1) va = velAt(o.pts, j, -1); }
      if (process.env.FARDBG) console.error('pair?', tr.t0.toFixed(3), 'prev', o.t0.toFixed(3), 'va', va, 'v0', v0, 'ang', angle(va, v0).toFixed(1));
      if (speed(va) >= 2.5 && speed(v0) >= 2.5 && angle(va, v0) >= (v0.vy > 0 ? 45 : 60)) { const q = o.pts[o.pts.length - 1]; push((q.t + p[0].t) / 2, (q.x + p[0].x) / 2, (q.y + p[0].y) / 2, v0.vy > 0 ? 1.1 : 0.85, 'pair'); }
    }
    // 出現: 直前に軌道が無く、手前へ向かって動き出す（入射球はラケット・閃光・相手の体に隠れて見えないことが多い＝砂 0911 p5 157.1）
    // 奥へ向かう出現（自分の打球が途中から見える）は打点ではないので採らない。ロブは上へ上がるので折り返し／ペアに任せる
    else if (speed(v0) >= 2.5 && v0.vy >= 1 && tr.t1 - tr.t0 >= 0.1) push(Math.max(0, p[0].t - 1 / 60), p[0].x, p[0].y, 0.9, 'appear');
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---- カメラ補正: 奥ベースライン中央の画面位置（フル解像度）を時刻で線形補間し、候補座標から引く（u,v）。
// ドリー中は静止物（芝の縞・ライン縁・観客席）も画面上を動くので、補正しないと「折り返し」に化ける（芝 0908 p2 で 60 本超の偽イベント）
function refFn(camList, Court) {
  const pts = camList.filter(c => c.ok !== false).map(c => { const p = Court.toScreen(0, Court.Z_BASE, c); return { t: c.t || 0, x: p.x, y: p.y }; }).sort((a, b) => a.t - b.t);
  if (!pts.length) return () => ({ x: 0, y: 0 });
  return t => {
    if (t <= pts[0].t) return pts[0]; if (t >= pts[pts.length - 1].t) return pts[pts.length - 1];
    let i = 0; while (i + 1 < pts.length && pts[i + 1].t < t) i++;
    const a = pts[i], b = pts[i + 1], w = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
}
// 静止物: 補正座標の 20px セルに直近 30 コマ中 18 コマ以上候補が居たら捨てる（球は 2px/コマ以上動くので同じセルに 10 コマ以上居ない）
const CELL = 20, PN = 30, PTHR = 18;

async function track({ video, t0, t1, fps = 60, cams, Court, camAt = null, markers = [] }) {
  const camList = cams.map(c => c.cam ? Object.assign({ t: c.t }, c.cam) : c);
  const band = bandFor(camList, Court);
  if (!band) return { events: [], tracks: [], band: null };
  const ref = refFn(camList, Court);
  const frameCands = [];
  let prevMask = null;
  const ring = [], cnt = new Map();
  for await (const fr of frames(video, t0, t1, fps, band)) {
    const cs = candidates(fr.raw, band, prevMask);
    prevMask = cs.mask;
    const r = ref(fr.t), cells = new Set(), keep = [];
    for (const c of cs) { c.u = c.x - r.x; c.v = c.y - r.y; const key = ((c.u / CELL) | 0) * 100000 + ((c.v / CELL) | 0); cells.add(key); if ((cnt.get(key) || 0) < PTHR) keep.push(c); else c.static = true; }
    for (const k of cells) cnt.set(k, (cnt.get(k) || 0) + 1);
    ring.push(cells); if (ring.length > PN) { for (const k of ring.shift()) cnt.set(k, cnt.get(k) - 1); }
    frameCands.push({ t: fr.t, cands: keep });
  }
  const tracks = link(frameCands, fps);
  const at = camAt || (t => { let b = camList[0]; for (const c of camList) if (Math.abs((c.t || 0) - t) < Math.abs((b.t || 0) - t)) b = c; return b; });
  const evs = events(tracks, band, Court, at, markers);
  return { events: evs, band, tracks: tracks.map(tr => ({ t0: tr.t0, t1: tr.t1, n: tr.pts.length, pts: tr.pts.map(q => [+q.t.toFixed(3), Math.round(q.x), Math.round(q.y), q.n]) })) };
}

module.exports = { track, candidates, link, events, bandFor, refFn, FW, FH };

if (require.main === module) {
  const a = process.argv.slice(2);
  const video = a[0], t0 = +a[1], t1 = +a[2];
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const { loadModules } = require('./rally-node.js');
  const { Court } = loadModules(null);
  const r = JSON.parse(fs.readFileSync(get('--json'), 'utf8'));
  const cams = r.cams.map(c => ({ t: c.t, c0: c.c0, c1: c.c1, Xc: c.Xc, Yc: c.Yc, ok: true }));
  track({ video, t0, t1, cams, Court }).then(res => {
    console.log('band', JSON.stringify(res.band));
    for (const tr of res.tracks) if (tr.t1 >= t0 && tr.t0 <= t1) console.log(`track ${tr.t0.toFixed(2)}-${tr.t1.toFixed(2)} n${tr.n} ${tr.pts[0].slice(1, 3)} → ${tr.pts[tr.pts.length - 1].slice(1, 3)}`);
    for (const e of res.events) console.log(`event ${e.t.toFixed(2)} ${e.src} qc${e.qc} (${e.x},${e.y}) X${e.X} Z${e.Z}`);
  }).catch(e => { console.error(e); process.exit(1); });
}
