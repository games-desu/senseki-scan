// 軌道当てはめ（2026-11-17・試作 samples/rally/traj/ から移植）。1 ポイントの打を 1 打ずつ、全キャラ共通の軌道の式（等加速度＋バウンド）に当てはめて、
// 打点の XYZ・着弾・ネット上の高さを出す。rally-node の analyze が GapFill の後に呼ぶ。**既定は切（TRAJ=1 で有効）**。
// 既存の land・from は置き換えず、打ごとに traj を足すだけ（s.traj = { th, H, E, tb, B, Bx, netY, g, v0, conf, ... }）。
//   conf: high / mid / low。low は球がほぼ見えておらず、事前分布と前後のつながりだけで決まった打（座標は信用しない）
// 入力は FHD 60fps の録画だけ。録画をフル解像度で 1 回読む（球の黄色・影・ロブの薄い黄色のトレイル）ので、1 ポイント数十秒〜数分かかる。
// 試作の環境変数（STAR・STARY・FRONT・SEED など）は頭に TRAJ_ を付けると効く（例: TRAJ_NOSTAR=1）。経緯と数字は docs/rally-analysis.md「軌道当てはめ」
//
//   node tools/traj.js --data <試作の data フォルダ> <idx> [--json out.json]   … 試作の入力（p<idx>-*.json）で当てはめだけ回す（移植の検算用）
const fs = require('fs'), path = require('path'), { spawn, spawnSync } = require('child_process');
const CamRefine = require('./camrefine.js');
const ShotColor = require('./shotcolor.js');

const E = new Proxy({}, { get: (_, k) => process.env['TRAJ_' + String(k)] });

// ---- カメラ模型・投影・軌道の式（試作 lib.js） ----
const K = 2.796e-4, XVP = 960, YVP = -651;
const sinT = 1191 * K, cosT = Math.sqrt(1 - sinT * sinT), F = cosT / K;
const YB = 0.2; // 着弾の瞬間に、影の真上で読める球の高さ(手の表と同じ値)

function makeCam(cams) {
  return function cam(t) {
    let i = cams.findIndex(x => x.t > t); if (i < 0) i = cams.length - 1; if (i === 0) i = 1;
    const a = cams[i - 1], b = cams[i], w = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))), m = k => a[k] + (b[k] - a[k]) * w;
    const c = { c0: m('c0'), c1: m('c1'), Xc: m('Xc') };
    if (a.fill === 'hold') c.bad = true; // この区間はカメラが合わせられていない(サーブ直後の別の画角)
    c.Hc = K / c.c1 * cosT; c.Zc = (K * sinT - c.c0) / c.c1;
    return c;
  };
}
// コート座標(X 横, Y 高さ, Z 奥行き。自分側が Z<0) → 画面(1920x1080)
function project(X, Y, Z, c) {
  const h = c.Hc - Y, d = Z - c.Zc, depth = d * cosT + h * sinT;
  if (depth < 1) return null;
  return { x: XVP + F * (X - c.Xc) / depth, y: YVP + F * h / (cosT * depth) };
}
function toCourt(x, y, c) { const u = y - YVP; return { X: c.Xc + (x - XVP) * (K / c.c1) / u, Z: (1 / u - c.c0) / c.c1 }; }
function heightAt(Z, yBall, c) { const A = yBall - YVP; return c.Hc - A * cosT * cosT * (Z - c.Zc) / (F - A * cosT * sinT); }

// 1打の軌道。q = { tr, P:[X,Y,Z], V:[vX,vY,vZ], aX, aZ, g, kh, e }
//   飛んでいる間: 横・奥行きは等加速度(aX, aZ)、縦は -g(重力＋回転の効き)
//   高さ YB でバウンド: 水平の速さ×kh、縦の速さは e 倍で上向き。バウンド後は水平の加速度なし
function bounceOf(q) {
  const [PX, PY, PZ] = q.P, [VX, VY, VZ] = q.V;
  const disc = VY * VY + 2 * q.g * (PY - YB);
  if (disc < 0 || q.g <= 0) return null;
  const dt = (VY + Math.sqrt(disc)) / q.g;
  return { t: q.tr + dt, X: PX + VX * dt + .5 * q.aX * dt * dt, Z: PZ + VZ * dt + .5 * q.aZ * dt * dt, vX: VX + q.aX * dt, vZ: VZ + q.aZ * dt, vY: VY - q.g * dt };
}
function pos(q, t, b) {
  if (b === undefined) b = bounceOf(q);
  if (!b || t <= b.t) {
    const dt = t - q.tr;
    return { X: q.P[0] + q.V[0] * dt + .5 * q.aX * dt * dt, Y: q.P[1] + q.V[1] * dt - .5 * q.g * dt * dt, Z: q.P[2] + q.V[2] * dt + .5 * q.aZ * dt * dt, nb: 0 };
  }
  // バウンド後(最大3回)
  let t0 = b.t, X = b.X, Z = b.Z, vX = b.vX * q.kh, vZ = b.vZ * q.kh, vY = Math.abs(b.vY) * q.e, nb = 1;
  for (; nb < 4; nb++) {
    const T = 2 * vY / q.g;
    if (t <= t0 + T || T < .03) break;
    X += vX * T; Z += vZ * T; t0 += T; vX *= q.kh; vZ *= q.kh; vY *= q.e;
  }
  const dt = Math.min(t - t0, 2 * vY / q.g);
  return { X: X + vX * (t - t0), Y: YB + Math.max(0, vY * dt - .5 * q.g * dt * dt), Z: Z + vZ * (t - t0), nb };
}
// ネット(Z=0)を越える瞬間の高さ。バウンド前に越えなければ null
function netCross(q, b) {
  const [, , PZ] = q.P, VZ = q.V[2], a = .5 * q.aZ;
  let dt = null;
  if (Math.abs(a) < 1e-9) { if (Math.abs(VZ) > 1e-9) dt = -PZ / VZ; }
  else { const D = VZ * VZ - 4 * a * PZ; if (D >= 0) { const r1 = (-VZ + Math.sqrt(D)) / (2 * a), r2 = (-VZ - Math.sqrt(D)) / (2 * a); const c = [r1, r2].filter(r => r > -.6).sort((x, y) => x - y); if (c.length) dt = c[0]; } }
  if (dt == null) return null;
  const t = q.tr + dt;
  if (b && t > b.t) return null;
  return { t, Y: q.P[1] + q.V[1] * dt - .5 * q.g * dt * dt };
}

// Nelder-Mead
function nelderMead(f, x0, step, maxIter = 1500, tol = 1e-5) {
  const n = x0.length; let S = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step[i]; S.push(x); }
  let V = S.map(f);
  for (let it = 0; it < maxIter; it++) {
    const idx = V.map((v, i) => i).sort((a, b) => V[a] - V[b]); S = idx.map(i => S[i]); V = idx.map(i => V[i]);
    if (V[n] - V[0] < tol && it > 50) break;
    const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
    const at = k => c.map((v, j) => v + k * (S[n][j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < V[0]) { const xe = at(-2), fe = f(xe); if (fe < fr) { S[n] = xe; V[n] = fe; } else { S[n] = xr; V[n] = fr; } }
    else if (fr < V[n - 1]) { S[n] = xr; V[n] = fr; }
    else {
      const xc = fr < V[n] ? at(-.5) : at(.5), fc = f(xc);
      if (fc < Math.min(fr, V[n])) { S[n] = xc; V[n] = fc; }
      else { for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + .5 * (v - S[0][j])); V[i] = f(S[i]); } }
    }
  }
  let bi = 0; for (let i = 1; i <= n; i++) if (V[i] < V[bi]) bi = i;
  return { x: S[bi], f: V[bi] };
}

// ---- 打の一覧とトレイルの先端列（試作 prep.js の前半） ----
// shots: [{t, side, cls, serve, land:{X,Z}|null}]（時刻順）、trailLog: analyze の trailLog（960x540 の座標）
function tracksOf(shots, trailLog) {
  return shots.map((s, k) => {
    const end = k + 1 < shots.length ? shots[k + 1].t : s.t + 1.2, sgn = s.side === 'me' ? -1 : 1, pts = [];
    for (const l of trailLog) {
      if (l.t < s.t - .02 || l.t > end + .05) continue;
      for (const b of l.blobs || []) { if (!b.tip || b.len < 25 || b.n < 250) continue; pts.push({ t: l.t, x: b.tip.x * 2, y: b.tip.y * 2, tx: b.tail.x * 2, ty: b.tail.y * 2, n: b.n }); }
    }
    pts.sort((a, b) => a.t - b.t);
    const best = pts.map(() => 1), prev = pts.map(() => -1); let bi = -1, bv = 0;
    pts.forEach((p, i) => {
      for (let j = 0; j < i; j++) { const q = pts[j], dt = p.t - q.t; if (dt <= 0 || dt > .14) continue; const dy = (p.y - q.y) * sgn / (dt * 60), dx = Math.abs(p.x - q.x) / (dt * 60); if (dy < 1.5 || dy > 60 || dx > 30) continue; if (best[j] + 1 > best[i]) { best[i] = best[j] + 1; prev[i] = j; } }
      if (best[i] > bv) { bv = best[i]; bi = i; }
    });
    const chain = []; for (let i = bi; i >= 0; i = prev[i]) chain.unshift(pts[i]);
    const land = Array.isArray(s.land) ? s.land : s.land && s.land.X != null ? [s.land.X, s.land.Z] : null;
    return { k, t: s.t, end, side: s.side, cls: s.cls || 'unknown', serve: !!s.serve, land, chain: chain.map(p => [+p.t.toFixed(3), p.x, p.y, p.tx, p.ty, p.n]) };
  });
}

// ---- 球・影・ロブのトレイルの候補（録画をフル解像度で 1 回だけ読む。試作 prep.js の後半と lobtrail.js） ----
const FW = 1920, FH = 1080, FS3 = FW * FH * 3;
const isBall = (r, g, b) => r > 195 && g > 185 && b < 170 && r - b > 70 && g - b > 50 && Math.abs(r - g) < 55;
const isDark = (r, g, b) => r < 78 && g < 128 && g > 45 && g - r > 28 && g - b > 40;
const isYel = (r, g, b) => r > 170 && g > 140 && b < 150 && r > g - 15 && g > .68 * r && r - b > 60;
function blobs(b, test, mark, stamp, xa, xb, keep) {
  const cs = [];
  for (let y = 10; y < 1000; y++) for (let x = xa; x < xb; x++) {
    const i = (y * FW + x) * 3;
    if (!test(b[i], b[i + 1], b[i + 2]) || mark[y * FW + x] === stamp) continue;
    const stk = [y * FW + x]; let n = 0, sx = 0, sy = 0, x0 = x, x1 = x, y0 = y, y1 = y; mark[y * FW + x] = stamp;
    while (stk.length) {
      const q = stk.pop(), qx = q % FW, qy = (q / FW) | 0; n++; sx += qx; sy += qy;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      for (const d of [1, -1, FW, -FW]) { const o = q + d; if (o < 0 || o >= FW * FH || mark[o] === stamp) continue; const m = o * 3; if (test(b[m], b[m + 1], b[m + 2])) { mark[o] = stamp; stk.push(o); } }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (keep(n, w, h)) cs.push([Math.round(sx / n), Math.round(sy / n), n, w, h]);
  }
  return cs;
}
// ロブの球は薄い黄色の細長いトレイルの先端。1 コマぶんの細長いかたまり（両端つき）
function lobBlobs(b) {
  const mark = new Uint8Array(FW * FH), out = [];
  for (let y = 0; y < 1000; y += 2) for (let x = 150; x < 1770; x += 2) {
    const i = (y * FW + x) * 3; if (mark[y * FW + x] || !isYel(b[i], b[i + 1], b[i + 2])) continue;
    const px = [], stk = [y * FW + x]; mark[y * FW + x] = 1;
    while (stk.length) { const q = stk.pop(), qx = q % FW; px.push(q);
      for (const d of [1, -1, FW, -FW]) { const o = q + d; if (o < 0 || o >= FW * 1000 || mark[o] || Math.abs((o % FW) - qx) > 1) continue; if (isYel(b[o * 3], b[o * 3 + 1], b[o * 3 + 2])) { mark[o] = 1; stk.push(o); } } }
    const n = px.length; if (n < 1500) continue;
    let sx = 0, sy = 0, y0 = FH; for (const q of px) { const qy = (q / FW) | 0; sx += q % FW; sy += qy; if (qy < y0) y0 = qy; } sx /= n; sy /= n;
    let a = 0, bb = 0, c = 0; for (const q of px) { const dx = q % FW - sx, dy = ((q / FW) | 0) - sy; a += dx * dx; bb += dx * dy; c += dy * dy; }
    const th = .5 * Math.atan2(2 * bb, a - c), ux = Math.cos(th), uy = Math.sin(th);
    const l1 = (a + c) / 2 + Math.hypot((a - c) / 2, bb), l2 = (a + c) / 2 - Math.hypot((a - c) / 2, bb);
    const len = 4 * Math.sqrt(l1 / n), wid = 4 * Math.sqrt(Math.max(l2, 0) / n);
    if (len < 60 || len / Math.max(wid, 1) < 1.6) continue;              // 細長いものだけ（マーカーや観客は丸い）
    let lo = Infinity, hi = -Infinity; const pr = new Float32Array(n);
    for (let j = 0; j < n; j++) { const q = px[j], v = (q % FW - sx) * ux + (((q / FW) | 0) - sy) * uy; pr[j] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const m = .1 * (hi - lo);
    const end = s => { let ex = 0, ey = 0, k = 0; for (let j = 0; j < n; j++) if (s > 0 ? pr[j] > hi - m : pr[j] < lo + m) { ex += px[j] % FW; ey += (px[j] / FW) | 0; k++; } return { x: ex / k, y: ey / k, k }; };
    out.push({ n, len, wid, cut: y0 <= 2, e: [end(1), end(-1)], cx: sx, cy: sy });
  }
  return out;
}
// ta〜tb を 1/60 秒の格子で読む。lobWins = [[t0, t1], ...] の間だけロブのかたまりも拾う
async function collect({ video, ta, tb, lobWins, ffmpeg }) {
  const t0 = Math.max(0, Math.floor(ta * 60) / 60);
  const seen = new Int32Array(FW * FH), seen2 = new Int32Array(FW * FH);
  const cands = [], shad = [], lobFr = []; const buf = Buffer.alloc(FS3); let fill = 0, fi = 0;
  const p = spawn(ffmpeg, ['-v', 'error', '-ss', Math.max(0, t0 - .004).toFixed(4), '-t', String(tb - t0), '-i', video, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  p.stderr.on('data', d => process.stderr.write(d));
  for await (const d of p.stdout) {
    let o = 0;
    while (o < d.length) {
      const k = Math.min(d.length - o, FS3 - fill); d.copy(buf, fill, o, o + k); fill += k; o += k;
      if (fill < FS3) continue;
      const t = +(t0 + fi / 60).toFixed(3);
      cands.push({ t, c: blobs(buf, isBall, seen, fi + 1, 200, 1720, (n, w, h) => n >= 12 && n <= 1500 && Math.max(w, h) / Math.min(w, h) <= 3.5) });
      shad.push({ t, c: blobs(buf, isDark, seen2, fi + 1, 150, 1770, (n, w, h) => n >= 8 && n <= 1200 && !(w < 4 || h > 26 || w / h > 7 || h / w > 1.6)) });
      if (lobWins.some(w => t >= w[0] - 1e-6 && t < w[1] - 1e-6)) lobFr.push({ t, b: lobBlobs(buf) });
      fi++; fill = 0;
    }
  }
  return { cands, shad, lobFr };
}
// ロブ 1 打ぶんの先端列。着弾マーカーも同じ色だが動かないので、「先端が進む向きに動いている並び」のうちいちばん長いものだけを残す
//   → [[t, 先端x, 先端y, n, 幅, 上で切れている?, 尾x, 尾y], ...]（8 コマ未満なら空）
const lobWin = s => { const t0 = Math.floor((s.t - .25) * 60) / 60; return [t0, s.end + .15]; };
function lobChain(s, lobFr) {
  const [w0, w1] = lobWin(s), fr = lobFr.filter(f => f.t >= w0 - 1e-6 && f.t < w1 - 1e-6).map(f => ({ t: f.t, b: f.b, b0: f.b }));
  // 動かないもの（着弾マーカー・演出）を外す: 0.3 秒以上離れたコマに、重心が 30px 以内のかたまりがある
  fr.forEach((f, i) => { f.b = f.b.filter(b => !fr.some((g, j) => Math.abs(j - i) >= 18 && g.b0.some(c => Math.hypot(c.cx - b.cx, c.cy - b.cy) < 30))); });
  const N = []; fr.forEach((f, i) => f.b.forEach(b => [0, 1].forEach(j => N.push({ i, t: f.t, b, h: b.e[j], tl: b.e[1 - j], best: 1, prev: -1 }))));
  let bi = -1;
  N.forEach((p, a) => {
    for (let c = a - 1; c >= 0; c--) { const q = N[c], di = p.i - q.i; if (di <= 0) continue; if (di > 20) break;
      const dx = p.h.x - q.h.x, dy = p.h.y - q.h.y, d = Math.hypot(dx, dy); if (d < .7 * di || d > 55 * di || d > 400) continue;
      const ax = p.h.x - p.tl.x, ay = p.h.y - p.tl.y; if ((dx * ax + dy * ay) / (d * Math.hypot(ax, ay)) < .3) continue;
      if (q.best + 1 > p.best) { p.best = q.best + 1; p.prev = c; } }
    if (bi < 0 || p.best > N[bi].best) bi = a;
  });
  const ch = []; for (let a = bi; a >= 0; a = N[a].prev) ch.unshift(N[a]);
  return ch.length >= 8 ? ch.map(p => [p.t, Math.round(p.h.x), Math.round(p.h.y), p.b.n, Math.round(p.b.wid), p.b.cut && p.h.y < 25 ? 1 : 0, Math.round(p.tl.x), Math.round(p.tl.y)]) : [];
}

// ---- カメラの抜けを埋める（試作 camfill.js）。サーブ直後の約 1 秒は Court.estimate が通らないので、抜けの後ろ側の良いカメラからコマをさかのぼって追う ----
function camFill({ video, shots, cams, ffmpeg }) {
  const W = 960, H = 540, FS = W * H * 4, GAP = .3, OK = .45, STEP = 2 / 60, MAXGAP = 8;
  const ta = shots[0].t - .1, tb = shots[shots.length - 1].end;
  const base = cams.filter(c => c.t >= ta - 2 && c.t <= tb + .5);
  const frames = (t0, t1) => {
    const t0g = Math.round(t0 * 60) / 60;
    const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', Math.max(0, t0g - .004).toFixed(4), '-t', (t1 - t0g + .02).toFixed(3), '-i', video, '-vf', 'fps=30,scale=960:540', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
    const out = [], so = r.stdout || Buffer.alloc(0);
    for (let i = 0; (i + 1) * FS <= so.length; i++) out.push({ t: +(t0g + i * STEP).toFixed(3), rd: CamRefine.ridge(so.subarray(i * FS, (i + 1) * FS)) });
    return out;
  };
  // 追うのをやめる条件: 線に乗る割合が低い、または前のコマから飛ぶ
  const bad = (r, c) => r.s < OK || Math.abs(r.cam.Xc - c.Xc) > .35 || Math.abs(r.cam.c1 / c.c1 - 1) > .06 || Math.abs(r.cam.c0 / c.c0 - 1) > .04;
  const added = [], edges = [{ t: ta, edge: true }, ...base.filter(c => c.t > ta), { t: tb, edge: true }];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1];
    if (b.t - a.t < GAP || b.t - a.t > MAXGAP || (a.edge && b.edge)) continue;   // 長すぎる抜け（演出・リプレイ）は埋めない
    const fr = frames(a.t, b.t), res = new Map();
    // 後ろから前へ
    if (!b.edge) { let c = b; for (let j = fr.length - 1; j >= 0; j--) { if (fr[j].t >= b.t - .01) continue; const r = CamRefine.refine(fr[j].rd, c); if (bad(r, c)) break; c = r.cam; res.set(fr[j].t, { t: fr[j].t, ...r.cam, s: r.s, src: 'back' }); } }
    // 前から後ろへ（まだ埋まっていないコマ）
    if (!a.edge) { let c = a; for (let j = 0; j < fr.length; j++) { if (fr[j].t <= a.t + .01) continue; const r = CamRefine.refine(fr[j].rd, c); if (bad(r, c)) break; c = r.cam; const o = res.get(fr[j].t); if (!o || o.s < r.s) res.set(fr[j].t, { t: fr[j].t, ...r.cam, s: r.s, src: 'fwd' }); } }
    // 後ろから追い切れなかった手前の区間は、いちばん手前の埋めたカメラをそのまま使う（前のカメラはサーブ前の別の画角）
    const bk = [...res.values()].filter(c => c.src === 'back').sort((x, y) => x.t - y.t)[0];
    if (bk && bk.t - a.t > .05 && ![...res.values()].some(c => c.t < bk.t)) res.set(a.t + .002, { ...bk, t: +(a.t + .002).toFixed(3), src: 'hold' });
    added.push(...res.values());
  }
  return [...cams.map(c => ({ t: c.t, c0: c.c0, c1: c.c1, Xc: c.Xc })), ...added.map(c => ({ t: c.t, c0: c.c0, c1: c.c1, Xc: c.Xc, fill: c.src, s: +c.s.toFixed(2) }))].sort((x, y) => x.t - y.t);
}

// ---- 当てはめ（試作 fit.js）。inp = { balls, shad, shots（tracksOf の形）, cams, lob: {k: 列}, stars: [{t0,t1,x,y}（FHD の画素）], verbose } ----
function fitPoint(inp) {
  const { balls, shad, shots, cams } = inp, LOBT = inp.lob || {}, QUIET = !inp.verbose;
  const cam = makeCam(cams);
// ---- 球種ごとの典型値(弱い事前分布)。将来は `${キャラ}/${球種}` の表に差し替える ----
const LOBTRK = !E.NOLOBTRK && !E.NOLOB, W_LOBTRK = +(E.WLOBTRK || 3);
const PRIOR = {
  topspin: { g: [20, 8] }, flat: { g: [13, 6] }, slice: { g: [10, 5] }, slide: { g: [9, 4] },
  lob: { g: [16, 6], along: LOBTRK ? [-14, 10] : undefined }, drop: { g: [8, 4] }, dive: { g: [9, 5] }, unknown: { g: [12, 8] },
};
function priorOf(s) {
  const p = PRIOR[`${s.char || ''}/${s.cls}`] || PRIOR[s.cls] || PRIOR.unknown;
  return { g: p.g, y0: s.serve ? [2.4, .6] : (p.y0 || [.7, .7]), along: p.along || [-6, 8], cross: p.cross || [0, s.side === 'opp' && E.CROSSOPP ? +E.CROSSOPP : 6], /* CROSSOPP: 相手(ゲッソーなど強く曲がるキャラ)の打だけ横の曲がりの幅を広げる実験。既定は切 */ kh: [.7, .2], e: [.6, .25] };
}
// 乱数は固定(同じ入力なら同じ結果になるように)
const SEED0 = +(E.SEED || 12345); let _seed = SEED0; const rnd = () => { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; };
const K_TIP = +(E.KTIP || 4), W_SH1 = +(E.WSH1 || 0); // 影だけの項は既定で切る(入れると球が画面の外へ逃げる解が選ばれ、p29 で 8m の外れ)
const W_LOBDEEP = +(E.WLOBDEEP || 20), LOBZ = [9.3, 11.9], W_LOBTIP = +(E.WLOBTIP || 4), LOB = !E.NOLOB, W_LAND = +(E.WLAND || 6);
const JLO = +(E.JLO || .3), JHI = +(E.JHI || .3); // 打の時刻が検出から動ける幅
const W_PRIOR = .5, W_SHADOW = 1.5, C_PX = 18, W_CONT = 2, S_CONT = .3, W_JDATA = .3, C_OFF = .7;
// 打点の高さの上限: ふつう 2.5m。サーブと、前の球が高いところにある打(スマッシュ)は 3.2m まで
const Y0_MAX = (s, st) => s.serve || !st || !st.cont || (st.prevEnd && st.prevEnd.Y > 2.2) ? 3.2 : 2.5;

// ---- 観測の準備 ----
const tips = new Map();
// 列の「先端」は球の側とは限らない(半分ほどの打で逆の端)。進む向きの前側の端を球の側とする。NOFRONT=1 で前の動き、FRONT=1 でサーブの先端列には使わない
const FRONT = E.NOFRONT ? 0 : +(E.FRONT || 2);
const frontOf = (s, p) => !FRONT || (p[2] - p[4]) * (s.side === 'me' ? -1 : 1) >= 0 ? p : [p[0], p[3], p[4], p[1], p[2], p[5]];
for (const s of shots) for (const p0 of s.chain || []) { const p = frontOf(s, p0), k = (+p[0]).toFixed(3); if (!tips.has(k)) tips.set(k, []); tips.get(k).push([p[1], p[2]]); }
// サーブだけ(ほかの打では先端列が別のものを拾うことがあり、p29 で 8m の外れが出た)。先端列が続いている間は、球は先端のすぐ後ろ(実測で 10〜20px)にある。先端から離れた黄色(相手キャラの服など)は候補から外す
const TIPGATE = +(E.TIPGATE || 90), gate = new Map();
const TIP_BACK = 12, tipBall = p => { const dx = p[3] - p[1], dy = p[4] - p[2], l = Math.hypot(dx, dy) || 1; return [p[1] + dx / l * TIP_BACK, p[2] + dy / l * TIP_BACK]; };
const tipsG = new Map(); if (FRONT >= 2) for (const s of shots) if (s.serve) s.chain = (s.chain || []).map(p => frontOf(s, p));
for (const s of shots) if (s.serve) for (const p of s.chain || []) tipsG.set((+p[0]).toFixed(3), tipBall(p));
for (const s of shots) { const ch = s.serve ? s.chain || [] : []; for (let i = 0; i + 1 < ch.length; i++) { const a = ch[i], b = ch[i + 1]; if (b[0] - a[0] > .14) continue;
  for (let t = Math.round(a[0] * 60); t <= Math.round(b[0] * 60); t++) { const w = (t / 60 - a[0]) / (b[0] - a[0]), k = (t / 60).toFixed(3); if (!gate.has(k)) gate.set(k, []); gate.get(k).push([a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]); } } }
const byT = new Map(balls.map(f => [f.t.toFixed(3), f]));
const shadByT = new Map(shad.map(f => [f.t.toFixed(3), f]));
const frames = balls.map(f => {
  const c = cam(f.t);
  // 動かない黄色(HUD など)は落とす: 0.3秒前と0.3秒後の両方で同じ場所にあるもの
  const twin = (b, dt) => { const g = byT.get((f.t + dt).toFixed(3)); return g && g.c.some(q => Math.abs(q[0] - b[0]) < 5 && Math.abs(q[1] - b[1]) < 5); };
  // 黄色い文字(GOOD / NICE など)も落とす: 同じ高さに横並びの大きめの塊が3つ以上
  const big = f.c.filter(b => b[2] >= 150);
  const text = b => b[2] >= 150 && big.filter(o => o !== b && Math.abs(o[1] - b[1]) < 14 && Math.abs(o[0] - b[0]) < 130).length >= 2
    || b[2] >= 150 && big.some(o => o !== b && Math.abs(o[1] - b[1]) < 8 && Math.abs(o[0] - b[0]) < 40); // 2文字だけ残った場合(同じ高さのすぐ隣に同じくらいの塊)
  const bs = f.c.filter(b => b[2] >= 20 && b[2] <= 1300 && !(twin(b, -.3) && twin(b, .3)) && !text(b)).map(b => [b[0], b[1]]);
  for (const p of tips.get(f.t.toFixed(3)) || []) bs.push([p[0], p[1], K_TIP]); // トレイルの先端は球の中心から数十px ずれるので、ゆるく効かせる
  const pairs = [], sh = [];
  const sf = shadByT.get(f.t.toFixed(3));
  if (sf) for (const b of sf.c) {
    if (b[2] < 14 || b[2] > 700 || b[3] < 7 || b[3] > 62) continue;
    const g = toCourt(b[0], b[1], c);
    if (Math.abs(g.X) > 7.5 || Math.abs(g.Z) > 14.5) continue;
    if (g.Z > -0.5 && g.Z < 3.6) continue; // ネットの網が映る帯
    sh.push([b[0], b[1]]);
    for (const q of bs) {
      const dx = q[0] - b[0], dy = b[1] - q[1];
      if (Math.abs(dx) > 14 + dy * .04 || dy < 4 || dy > 330) continue;
      const Y = heightAt(g.Z, q[1], c);
      if (Y < -.2 || Y > 5.5) continue;
      pairs.push({ sx: b[0], sy: b[1], bx: q[0], by: q[1], X: g.X, Z: g.Z, Y, t: f.t });
    }
  }
  const g = TIPGATE > 0 && gate.get(f.t.toFixed(3)), inG = (x, y) => g.some(p => Math.hypot(p[0] - x, p[1] - y) < TIPGATE);
  return { t: f.t, c, bs, pairs, sh, bsU: bs, pairsU: pairs, bsG: g ? bs.filter(q => !q[2] && inG(q[0], q[1])).concat(tipsG.has(f.t.toFixed(3)) ? [tipsG.get(f.t.toFixed(3))] : []) : bs, pairsG: g ? pairs.filter(q => inG(q.bx, q.by)) : pairs };
});
const C2 = C_PX * C_PX;
function frameCost(q, b, f) {
  const p = pos(q, f.t, b);
  const pb = project(p.X, p.Y, p.Z, f.c), ps = project(p.X, 0, p.Z, f.c);
  if (!pb || !ps) return 1 + W_SHADOW;
  let cb = pb.y < 10 ? C_OFF : 1; // 画面の上へ出ている間は、球が見えなくて当然
  for (const s of f.bs) { const dx = s[0] - pb.x, dy = s[1] - pb.y, d2 = dx * dx + dy * dy; if (d2 < 4 * C2 * 9 || s[5] === 'wide') { const r = d2 / (d2 + C2 * (s[2] || 1)); if (r < cb) cb = r; } }
  // 球が画面の上へ出ている間(ロブ)は、地面の影だけで追う
  if (W_SH1 > 0 && pb.y < 10 && f.sh.length) { let c1 = 1; for (const s of f.sh) { const d2 = (s[0] - ps.x) ** 2 + (s[1] - ps.y) ** 2, r = d2 / (d2 + C2); if (r < c1) c1 = r; } cb += W_SH1 * (c1 - 1); }
  let cs = 0;
  if (f.pairs.length) {
    cs = 1;
    for (const s of f.pairs) { const d2 = ((s.sx - ps.x) ** 2 + (s.sy - ps.y) ** 2 + (s.bx - pb.x) ** 2 + (s.by - pb.y) ** 2) / 2; const r = d2 / (d2 + C2); if (r < cs) cs = r; }
  }
  return cb + W_SHADOW * cs;
}
const hinge = (v, lo, hi) => v < lo ? lo - v : v > hi ? v - hi : 0;
const toQ = (s, x) => ({ tr: s.t, P: [x[0], x[1], x[2]], V: [x[3], x[4], x[5]], aX: x[6], aZ: x[7], g: x[8], kh: x[9], e: x[10] });
const toX = q => [...q.P, ...q.V, q.aX, q.aZ, q.g, q.kh, q.e];
const STEP = [.3, .2, .5, 1.5, 1, 2, 3, 3, 3, .1, .1];

// ---- 参考文献から足した項(どれも既定は切。環境変数で入れる) ----
// PLY: 手前の自分の打点を選手の足元の近くへ(MonoTrack)。実測で球は足元から横に最大 2m、ネット側へ -0.3〜+1.1m 離れるので、その幅は罰しない
// OUTW: 延長した着弾がシングルスコートの外へ出た距離の罰則(MonoTrack)。DIRW: 打った瞬間の速度は相手の方向(MonoTrack)
// STAR(既定で入。NOSTAR=1 で切): ☆が取れた打は、球が下りながら高さ STAR_Y でその真上を通るように寄せる(TT3D の「基準点を先に決める」の応用)。STARLAND=1 は着弾点として寄せる旧案(奥側で 3〜4m ずれるので不採用)
const W_PLY = +(E.PLY || 0), W_OUT = +(E.OUTW || 0), W_DIR = +(E.DIRW || 0), W_STAR = E.NOSTAR ? 0 : +(E.STAR || 10);
const PLYT = W_PLY ? (inp.player || []).filter(o => o.ok) : [];
// 追跡が信用できるときだけ使う: 前後 0.1 秒で 1m 以上動いていない(サーブの演出・とびつきでは足元が飛ぶ)、コートの手前側にいる
const plyAt = t => { const a = PLYT.filter(o => Math.abs(o.t - t) <= .1); if (a.length < 6) return null; const b = a.reduce((x, o) => Math.abs(o.t - t) < Math.abs(x.t - t) ? o : x);
  if (E.PLYRAW) return b; if (b.Z > -.3 || b.Z < -13.5 || a.some(o => Math.hypot(o.X - b.X, o.Z - b.Z) > 1)) return null; return b; };
const STARS = W_STAR ? (inp.stars || []).filter(m => m.t1 - m.t0 >= +(E.STARDUR || .15)).map(m => ({ ...m, G: toCourt(m.x, m.y, cam(E.STARLAND ? m.t0 : E.STARCAM === 'mid' ? (m.t0 + m.t1) / 2 : Math.max(m.t0, m.t1 - .1))) })) : [];
// 2026-11-13 深夜5: 4つを既定に(NOSTARX=1 でまとめて切。個別は STARDT=0 / NOSTAREND=1 / NOSTARINIT=1 / WEAKNEXT=0)
const NOSTARX = !!E.NOSTARX, STAREND = !NOSTARX && !E.NOSTAREND, STARINIT = !NOSTARX && !E.NOSTARINIT, WEAKNEXT = +(E.WEAKNEXT ?? (NOSTARX ? 0 : .15));
// 深夜6: 二段(既定)。1回目は足した縛りなしで当てはめ、☆が消える 0.06 秒前に☆から STARMISS m 以上離れている奥側の打にだけ縛りを掛けてやり直す(ONESTAGE=1 で全部の打に掛ける)。NOLOBX=1 でロブを対象から外す
const STARFREE = !E.NOSTARFREE; // 印の付いた打は、次の打の出来によらず次の打点へ寄せない
const TWO = !E.ONESTAGE, STARMISS = +(E.STARMISS || .5);
const ex = s => !TWO ? !(E.NOLOBX && s.cls === 'lob') : !!s.starX;
const W_STARDT = +(E.STARDT ?? (NOSTARX ? 0 : 10)), STAR_LAG = +(E.STARLAG || .06);
const STAR_Y = +(E.STARY || (E.STARCAM === 'mid' ? 2.4 : 2.2)); // 2026-11-13 深夜2: ☆は消える直前(t1-0.1秒)のカメラで測る(star.js が座標を移動平均で持つ)。その場合の通過高さは 10打で 1.6〜2.5m・中央値 2.2m。STARCAM=mid で前の測り方(2.4m) // ☆は着弾点ではなく、球が下りながら高さ約2.4mを通る場所(=スマッシュできる場所)。実測 4打で 2.2〜2.7m
const starOf = s => { if (s._star === undefined) { const sg = s.side === 'me' ? 1 : -1; s._star = STARS.find(m => m.t0 >= s.t + .15 && m.t0 <= (s.end ?? s.t + 2) + .1 && sg * m.G.Z > 0) || null; } return s._star; };
const huber = (d, k) => d < k ? d * d / (2 * k) : d - k / 2;
// 物理の縛りと事前分布
function penalty(s, q, b, st) {
  const pr = s.pr, sgn = s.side === 'me' ? -1 : 1;
  let c = 0;
  if (!b) return 1e3;
  const H = pos(q, st.th, b);
  c += 60 * hinge(H.Y, .15, Y0_MAX(s, st)) ** 2;               // 打点の高さ
  c += 5 * hinge(sgn * H.Z, s.serve ? 11.3 : .3, s.serve ? 12.8 : 14.5) ** 2;                 // 打つ側のコートにいる
  c += 5 * hinge(H.X, s.serve ? -4.5 : -7.5, s.serve ? 4.5 : 7.5) ** 2;
  c += .5 * hinge(q.g, 3, 45) ** 2;
  c += 100 * (hinge(q.kh, .3, 1.05) ** 2 + hinge(q.e, .1, 1.1) ** 2);
  const apex = q.V[1] > 0 ? q.P[1] + q.V[1] * q.V[1] / (2 * q.g) : q.P[1];
  c += 5 * hinge(apex, 0, 8) ** 2;
  c += hinge(Math.hypot(q.V[0], q.V[2]), 2, 50) ** 2;
  const n = netCross(q, b);
  // ネットを越える。越えない球(ネットにかけるミス)は定額の罰で許す。ポイント最後の打は罰を軽くする
  if (!n) c += s.last ? .5 : 3; else c += 40 * hinge(n.Y, 1.0, 9) ** 2 + 5 * hinge(-sgn * b.Z, -1, 14.5) ** 2;
  c += 5 * hinge(b.X, -7, 7) ** 2; // 着弾はコートの周り
  if (s.serve) c += 5 * hinge(-sgn * b.Z, 1, 7.4) ** 2 + 60 * hinge(b.t - st.th, .2, .7) ** 2; // サーブはサービスコート(6.4m)の中かその少し先に、打ってから 0.7 秒以内に落ちる(影が無いと奥行きが決まらず、遅くて手前に落ちる解に逃げるため)
  c += 20 * hinge(b.t - st.th, .12, 4) ** 2;
  if (LOB && s.cls === 'lob') {
    c += 200 * hinge(Math.min(b.t, st.te) - st.th, 1.0, 4) ** 2; // ロブは滞空が長い(返球までが短ければそちらに合わせる)
    const E = pos(q, st.te, b), air = b.t > st.te; if (hasTrk(s)) c += 60 * hinge(-sgn * E.Z, -1, 13.5) ** 2; /* 返球する人が届く奥行きまで */ // 落ちる前に返球されるなら、その時刻には手の届く高さまで下りている
    if (air && !s.last) c += 60 * hinge(E.Y, .15, 3.2) ** 2;
    if (!E.NOLOBDEEP) c += W_LOBDEEP * hinge(-sgn * b.Z, LOBZ[0], LOBZ[1]) ** 2; // ロブは必ずエンドラインの手前付近に落ちる(返球が先でも、そのまま飛べば落ちる場所)
    if (s.land) { const G = air ? E : b, d2 = (G.X - s.land[0]) ** 2 + (G.Z - s.land[1]) ** 2; c += W_LAND * d2 / (d2 + 9); }
  } // ロブは地面に着弾マーカーが出る。既存の検出が拾っていれば、そこへ落ちるようにゆるく寄せる
  if (W_PLY && s.side === 'me' && (!s.serve || E.PLYRAW)) { const p = plyAt(st.th), dx = +(E.PLYDX || 2); if (p) c += W_PLY * (hinge(H.X - p.X, -dx, dx) ** 2 + hinge(H.Z - p.Z, -.5, 1.3) ** 2); }
  if (W_OUT && n && !s.last) c += W_OUT * (hinge(b.X, -4.4, 4.4) ** 2 + hinge(-sgn * b.Z, 0, 12.2) ** 2);
  if (W_DIR) c += W_DIR * hinge(-sgn * (q.V[2] + q.aZ * (st.th - q.tr)), 3, 80) ** 2;
  if (W_STAR) { const m = starOf(s); if (m) {
    if (E.STARLAND) c += W_STAR * huber(Math.hypot(b.X - m.G.X, b.Z - m.G.Z), 1);
    else { const D = q.V[1] * q.V[1] + 2 * q.g * (q.P[1] - STAR_Y);
      if (D < 0) c += W_STAR * (3 + Math.sqrt(-D)); // 高さ 2.4m に届かない
      else { const w = pos(q, q.tr + (q.V[1] + Math.sqrt(D)) / q.g, b); const tp = q.tr + (q.V[1] + Math.sqrt(D)) / q.g; c += W_STAR * huber(Math.hypot(w.X - m.G.X, w.Z - m.G.Z), .5);
        if (STAREND && ex(s) && st.te > tp) { const E = pos(q, st.te, b); c += W_STAR * Math.max(0, -sgn * m.G.Z - .5 + sgn * E.Z); } /* STAREND: ☆を過ぎた球は、次の打までネット側へ戻らない */
        if (W_STARDT && ex(s) && s.side === 'me') c += W_STARDT * huber((tp - (m.t1 - STAR_LAG)) * 10, .5); } } } } // STARDT: 球が☆の真上を通った約0.06秒後に☆が消える(奥側6打で 0.05〜0.07秒)。手前側は自分のキャラに隠れて早く消えるので使わない
  // 弱い事前分布
  const z = (v, p) => ((v - p[0]) / p[1]) ** 2;
  const vh = Math.hypot(q.V[0], q.V[2]) || 1, ux = q.V[0] / vh, uz = q.V[2] / vh;
  c += W_PRIOR * (z(q.g, pr.g) + z(H.Y, pr.y0) + z(q.aX * ux + q.aZ * uz, pr.along) + z(-q.aX * uz + q.aZ * ux, pr.cross) + z(q.kh, pr.kh) + z(q.e, pr.e));
  // 前後の打とつながる
  if (STAREND && st.prevStar) c += W_STAR * Math.max(0, sgn * st.prevStar.Z - .5 - sgn * H.Z); // 前の打(奥側)に☆があれば、この打の打点は☆より奥(スマッシュなら☆の上、弾んだ後ならその先)
  if (st.prevEnd) c += (st.wPrev ?? 1) * W_CONT * ((H.X - st.prevEnd.X) ** 2 + (H.Y - st.prevEnd.Y) ** 2 + (H.Z - st.prevEnd.Z) ** 2) / S_CONT ** 2;
  if (st.nextH) { const E = pos(q, st.te, b); c += (st.wNext ?? 1) * W_CONT * ((E.X - st.nextH.X) ** 2 + (E.Y - st.nextH.Y) ** 2 + (E.Z - st.nextH.Z) ** 2) / S_CONT ** 2; }
  return c;
}
function dataCost(q, b, fr) { let c = 0; for (const f of fr) c += (f.w || 1) * frameCost(q, b, f); return c; }
const framesIn = (a, b) => frames.filter(f => f.t >= a + .02 && f.t <= b - .02 && !f.c.bad); // カメラが合わない区間のコマは使わない

// ---- 初期値(a): 影と球の組から、地上の直線 → 2次式 ----
function initPairs(s, st) {
  const dir = s.side === 'me' ? 1 : -1;
  const pts = []; for (const f of frames) if (f.t >= st.th - .05 && f.t <= st.te + .03) pts.push(...f.pairs);
  if (pts.length < 3) return [];
  const cands = [];
  // 組が少なければ総当たり(結果が乱数に左右されないように)
  const all = pts.length * pts.length <= 60000, N = all ? pts.length * pts.length : 30000;
  for (let it = 0; it < N; it++) {
    const a = pts[all ? (it / pts.length) | 0 : rnd() * pts.length | 0], b = pts[all ? it % pts.length : rnd() * pts.length | 0], dt = b.t - a.t;
    if (dt < .08) continue;
    const vX = (b.X - a.X) / dt, vZ = (b.Z - a.Z) / dt;
    if (vZ * dir < 3 || Math.abs(vZ) > 48 || Math.abs(vX) > 20) continue;
    const seen = new Set();
    for (const p of pts) if (!seen.has(p.t) && Math.hypot(a.X + vX * (p.t - a.t) - p.X, a.Z + vZ * (p.t - a.t) - p.Z) < .45) seen.add(p.t);
    cands.push({ sc: seen.size, a, vX, vZ });
  }
  cands.sort((x, y) => y.sc - x.sc);
  const out = [], used = [];
  for (const best of cands) {
    if (out.length >= 3 || best.sc < 3) break;
    if (used.some(u => Math.abs(u.vZ - best.vZ) < 3 && Math.abs(u.vX - best.vX) < 2)) continue;
    used.push(best);
    const m = new Map();
    for (const p of pts) { const e = Math.hypot(best.a.X + best.vX * (p.t - best.a.t) - p.X, best.a.Z + best.vZ * (p.t - best.a.t) - p.Z); if (e < .45 && (!m.has(p.t) || e < m.get(p.t).e)) m.set(p.t, { ...p, e }); }
    let Ls = [...m.values()].sort((a, b) => a.t - b.t);
    // 高さは最も低い点まで(バウンド後を混ぜない)
    let mi = 0; Ls.forEach((p, i) => { if (p.Y < Ls[mi].Y) mi = i; });
    const Lh = mi >= 3 ? Ls.slice(0, mi + 1) : Ls;
    const g0 = s.pr.g[0];
    // 最小二乗: v(t) = a + b*dt (+ 既知の2次項)
    const lin = (arr, key, quad) => { const n = arr.length; let st1 = 0, sy = 0, stt = 0, sty = 0; for (const p of arr) { const d = p.t - s.t, y = p[key] - quad * d * d; st1 += d; sy += y; stt += d * d; sty += d * y; } const den = n * stt - st1 * st1; if (Math.abs(den) < 1e-9) return [sy / n, 0]; const b = (n * sty - st1 * sy) / den; return [(sy - b * st1) / n, b]; };
    const [X0, VX] = lin(Ls, 'X', 0), [Z0, VZ] = lin(Ls, 'Z', 0), [Y0, VY] = lin(Lh, 'Y', -.5 * g0);
    out.push([X0, Math.max(YB + .05, Y0), Z0, VX, VY, VZ, 0, 0, g0, s.pr.kh[0], s.pr.e[0]]);
  }
  return out;
}
// ---- 初期値(b): 打点・着弾・滞空時間の格子(影が無くても使える) ----
function initGrid(s, st, fr, wide) {
  const sgn = s.side === 'me' ? -1 : 1, sub = fr.length <= 70 ? fr : fr.filter((_, i) => i % 2 === 0), th = st.th; // 間引くとトレイルの先端(30fps)が全部落ちることがあるので、短い打は全コマ
  const res = [];
  const lob = s.cls === 'lob' && !E.NOLOB, APEX = 8;
  const Y0s = s.serve ? [2, 2.6, 3.1] : lob ? [.5, 1.2, 2] : [.5, 1.1, 2, 2.8];
  for (const Z0a of s.serve ? [11.6, 12.4] : lob ? [3, 5, 7, 9, 11] : wide ? [4, 6.5, 9, 11.5, 13.5] : [4, 6.5, 9, 11.5]) for (let X0 = -5; X0 <= 5; X0 += 1.25) for (const Y0 of Y0s)
    for (const Zla of lob ? [9.3, 10, 10.7, 11.3, 11.8] : [2, 4.5, 7, 9.5, 11.5]) for (const Xl of [-4, -2, 0, 2, 4]) for (const T of lob ? [1, 1.25, 1.5, 1.75, 2, 2.3, 2.7] : [.35, .5, .65, .8, 1, 1.2, 1.5, 1.9]) for (const gm of lob ? [.5, .75, 1, 1.4, 2] : [.6, 1, 1.5]) {
      const g = s.pr.g[0] * gm, Z0 = sgn * Z0a, Zl = -sgn * Zla;
      const VX = (Xl - X0) / T, VZ = (Zl - Z0) / T, VY = (YB - Y0 + .5 * g * T * T) / T;
      if (Math.abs(VZ) > 48) continue;
      const tn = T * (0 - Z0) / (Zl - Z0), yn = Y0 + VY * tn - .5 * g * tn * tn;
      if (yn < 1.0 || Y0 + VY * VY / (2 * g) > APEX) continue;
      const d = s.t - th; // tr での状態に直す
      const q = { tr: s.t, P: [X0 + VX * d, Y0 + VY * d - .5 * g * d * d, Z0 + VZ * d], V: [VX, VY - g * d, VZ], aX: 0, aZ: 0, g, kh: s.pr.kh[0], e: s.pr.e[0] };
      const b = bounceOf(q); if (!b) continue;
      let c = 0; for (const f of sub) c += frameCost(q, b, f);
      if (st.prevEnd) c += ((X0 - st.prevEnd.X) ** 2 + (Z0 - st.prevEnd.Z) ** 2) / 4;
      res.push({ c, x: toX(q) });
    }
  res.sort((a, b) => a.c - b.c);
  const out = [];
  for (const r of res) { if (out.length >= 3) break; if (out.some(o => Math.abs(o[0] - r.x[0]) < 1.3 && Math.abs(o[2] - r.x[2]) < 2.6 && Math.abs(o[5] - r.x[5]) < 4)) continue; out.push(r.x); }
  return out;
}

// ---- 初期値(d): ☆つきの打(奥側)。打点を前の打の延長に置き、☆が消える STAR_LAG 秒前に☆の真上を高さ STAR_Y で通る軌道を、重力を振って作る。STARINIT=1 で入 ----
function initStar(s, st, fr) {
  const m = starOf(s); if (!m || !ex(s) || s.side !== 'me' || !st.prevEnd) return [];
  const th = st.th, res = [];
  for (const dt of [-.05, 0, .05]) { const T = m.t1 - STAR_LAG + dt - th; if (T < .3) continue;
    for (const Y0 of [.4, .8, 1.3, 1.9]) for (let g = 5; g <= 30; g += 1.5) {
      const P0 = [st.prevEnd.X, Y0, st.prevEnd.Z], V = [(m.G.X - P0[0]) / T, (STAR_Y - Y0 + .5 * g * T * T) / T, (m.G.Z - P0[2]) / T];
      if (Y0 + V[1] * V[1] / (2 * g) > 12) continue;
      const d = s.t - th, q = { tr: s.t, P: [P0[0] + V[0] * d, Y0 + V[1] * d - .5 * g * d * d, P0[2] + V[2] * d], V: [V[0], V[1] - g * d, V[2]], aX: 0, aZ: 0, g, kh: s.pr.kh[0], e: s.pr.e[0] }, b = bounceOf(q); if (!b) continue;
      let c = 0; for (const f of fr) c += frameCost(q, b, f); res.push({ c, x: toX(q) }); } }
  res.sort((a, b) => a.c - b.c);
  const out = []; for (const r of res) { if (out.length >= 3) break; if (out.some(o => Math.abs(o[8] - r.x[8]) < 3 && Math.abs(o[1] - r.x[1]) < .5)) continue; out.push(r.x); }
  if (E.DBG) console.log('   initStar#' + (s.k + 1), 'best', res.slice(0, 3).map(r => r.c.toFixed(1)).join(' '), 'n', res.length);
  return out;
}

// ---- 初期値(c): ロブ。打点を前の打の延長(その時刻の位置)に置き、終点か着弾・重力を格子で振る ----
function initLob(s, st, fr) {
  if (!st.prevEnd) return [];
  const sgn = s.side === 'me' ? -1 : 1, th = st.th, T = st.te - th, res = [];
  const P0 = [st.prevEnd.X, Math.max(.3, Math.min(2.5, st.prevEnd.Y)), st.prevEnd.Z];
  if (sgn * P0[2] < .3) return [];
  const push = (VX, VY, VZ, g) => {
    if (P0[1] + VY * VY / (2 * g) > 9 || VY < 2) return;
    const d = s.t - th, q = { tr: s.t, P: [P0[0] + VX * d, P0[1] + VY * d - .5 * g * d * d, P0[2] + VZ * d], V: [VX, VY - g * d, VZ], aX: 0, aZ: 0, g, kh: s.pr.kh[0], e: s.pr.e[0] };
    const b = bounceOf(q); if (!b) return;
    let c = 0; for (const f of fr) c += frameCost(q, b, f);
    res.push({ c, x: toX(q) });
  };
  for (const g of [8, 11, 14, 17, 20, 24, 28, 33]) for (let X1 = -5; X1 <= 5; X1 += 1.25) for (const Za of [3, 5, 7, 9.5, 10.3, 11, 11.7]) {
    const Z1 = -sgn * Za;
    for (const Y1 of [1, 2, 3]) push((X1 - P0[0]) / T, (Y1 - P0[1] + .5 * g * T * T) / T, (Z1 - P0[2]) / T, g); // 落ちる前に返球
    for (let Tb = .9; Tb < 2.8; Tb += .15) if (Za > 9) push((X1 - P0[0]) / Tb, (YB - P0[1] + .5 * g * Tb * Tb) / Tb, (Z1 - P0[2]) / Tb, g); // 着弾してから返球
  }
  // 列に弾んだ瞬間(画面でいちばん下がって、また上がる所)が見えていれば、そこを着弾の時刻と位置にする
  if (st.trkB) { const G = toCourt(st.trkB.x, st.trkB.y, cam(st.trkB.t)), Tb = st.trkB.t - th; for (let g = 6; g <= 40; g += 2) for (const dx of [-.6, 0, .6]) for (const dz of [-.6, 0, .6]) push((G.X + dx - P0[0]) / Tb, (YB - P0[1] + .5 * g * Tb * Tb) / Tb, (G.Z + dz - P0[2]) / Tb, g); }
  // 列の最初の点(打った直後)を通り、弾んだ点へ落ちる初期値。打った奥行きは分からないので振る
  if (st.trkB && st.trk0) { const G = toCourt(st.trkB.x, st.trkB.y, cam(st.trkB.t)), [t1, x1, y1] = st.trk0, c1 = cam(t1), T = st.trkB.t - t1;
    for (const Za of [4, 6, 8, 9.5, 11, 12.5]) { const Z0 = sgn * Za, Y0 = heightAt(Z0, y1, c1); if (!(Y0 > .3 && Y0 < 6)) continue; const X0 = c1.Xc + (x1 - XVP) * ((Z0 - c1.Zc) * cosT + (c1.Hc - Y0) * sinT) / F;
      for (let g = 6; g <= 40; g += 2) for (const az of [0, 8, 16, 24]) { const aZ = sgn * az, V = [(G.X - X0) / T, (YB - Y0 + .5 * g * T * T) / T, (G.Z - Z0 - .5 * aZ * T * T) / T], d = s.t - t1, q = { tr: s.t, P: [X0 + V[0] * d, Y0 + V[1] * d - .5 * g * d * d, Z0 + V[2] * d + .5 * aZ * d * d], V: [V[0], V[1] - g * d, V[2] + aZ * d], aX: 0, aZ, g, kh: s.pr.kh[0], e: s.pr.e[0] }, b = bounceOf(q); if (!b) continue; let c = 0; for (const f of fr) c += frameCost(q, b, f); res.push({ c, x: toX(q) }); } } }
  res.sort((a, b) => a.c - b.c);
  const out = [];
  for (const r of res) { if (out.length >= 3) break; if (out.some(o => Math.abs(o[3] - r.x[3]) < 1 && Math.abs(o[5] - r.x[5]) < 2 && Math.abs(o[8] - r.x[8]) < 4)) continue; out.push(r.x); }
  if (E.DBG) console.log('   initLob#' + (s.k + 1), 'th', th.toFixed(2), 'best', res.slice(0, 3).map(r => r.c.toFixed(1)).join(' '), 'n', res.length);
  return out;
}
// ---- 当てはめ ----
const S = shots.map((s, k) => ({ ...s, k, pr: null, th: k === 0 ? s.t : s.t - .08, te: 0, x: null, cost: 0 }));
S.forEach((s, k) => { s.last = k === S.length - 1; s.pr = priorOf(s); s.te = k + 1 < S.length ? S[k + 1].th : s.end; });
// つなぎの重み: 影つきの球でよく決まっている打(anc が大きい)は、決まっていない隣の打に引っぱられない。決まっていない打は隣へ寄る
const ANC = E.NOANC ? 0 : 1, ancW = (self, nb) => ANC ? Math.min(1, ((nb.anc || 0) + .1) / ((self.anc || 0) + .1)) : 1;
// 着弾マーカーが取れているロブは、終点を次の打に合わせない(次の打はスマッシュで球が拾えないことが多い)。次の打のほうがロブに合わせる
const lobLand = s => LOB && !E.NOLOBLAND && s.cls === 'lob' && !!s.land;
// 専用の列が取れているロブも同じ扱い(列で軌道が決まるので、隣の打のほうが合わせる)
const hasTrk = s => LOBTRK && s.cls === 'lob' && !!LOBT[s.k] && LOBT[s.k].filter(p => p[0] >= s.t && p[0] <= s.end && !p[5]).length >= 10;
const lobSure = s => lobLand(s) || hasTrk(s);
// WEAKNEXT(試し・既定は切): 次の打が球にほとんど乗っていない(観測なし)なら、その打点へ寄せない。観測のない打のでたらめな打点に前の打が引かれるのを防ぐ
const ballRatio = k => { const s = S[k]; if (!s.x) return 1; const q = toQ(s, s.x), b = bounceOf(q), fr = framesIn(s.th, s.te); if (fr.length < 6) return 1; let n = 0; for (const f of fr) { const p = pos(q, f.t, b), pb = project(p.X, p.Y, p.Z, f.c); if (pb && f.bs.some(c => Math.hypot(c[0] - pb.x, c[1] - pb.y) < 15)) n++; } return n / fr.length; };
function stateOf(k, cont) {
  const s = S[k], st = { th: s.th, te: s.te, cont };
  if (k > 0 && S[k - 1].side === 'me' && W_STAR) { const pm = ex(S[k - 1]) && starOf(S[k - 1]); if (pm) st.prevStar = pm.G; }
  if (cont && k > 0 && S[k - 1].x) { st.prevEnd = pos(toQ(S[k - 1], S[k - 1].x), s.th); st.wPrev = S[k - 1].trkBounced ? 0 : hasTrk(s) ? 1 : lobSure(S[k - 1]) ? 1 : lobRel(k) ? ancW(s, S[k - 1]) : 1; }
  if (cont && k + 1 < S.length && S[k + 1].x) { st.nextH = pos(toQ(S[k + 1], S[k + 1].x), S[k + 1].th); st.wNext = STARFREE && TWO && s.starX ? 0 : WEAKNEXT && (ex(s) || TWO && (k > 0 && S[k - 1].starX || k + 1 < S.length && S[k + 1].starX)) && ballRatio(k + 1) < WEAKNEXT ? 0 : hasTrk(S[k + 1]) ? 0 : lobSure(s) ? 0 : lobRel(k + 1) ? ancW(s, S[k + 1]) : 1; }
  if (s.sliceX && SLICEW !== 1) { if (st.wPrev != null) st.wPrev *= SLICEW; if (st.wNext != null) st.wNext *= SLICEW; } // 列を使うスライスは、前後の打とのつなぎより列を信じる
  return st;
}
function fitShot(k, cont, fresh) {
  const s = S[k], st = stateOf(k, cont); let fr = framesIn(st.th, st.te);
  // 前の打が影でよく決まっているとき、その延長で説明できる候補は前の打の球(まだ打たれていない)。この打の観測から外す
  if (cont && k > 0 && S[k - 1].x && S[k - 1].anc >= .5 && !E.NOEXPL) {
    const P = S[k - 1], qp = toQ(P, P.x), bp = bounceOf(qp);
    fr = fr.map(f => { if (f.t > st.th + .35) return f; const w = pos(qp, f.t, bp), v = project(w.X, w.Y, w.Z, f.c); if (!v) return f;
      const near = (x, y) => Math.hypot(x - v.x, y - v.y) < 15; if (!f.bs.some(c => near(c[0], c[1]))) return f;
      return { ...f, bs: f.bs.filter(c => !near(c[0], c[1])), pairs: f.pairs.filter(c => !near(c.bx, c.by)) }; });
  }
  // ロブは落ちてくる球にトレイルが付き、先端列が球そのものを追っている。先端列があるコマはそれだけを球の候補にして重く効かせる
  // スライスは球が黄色の候補に入らない(青いトレイルの前側の端にある)。列が長いとき、列のあるコマは前側の端だけを球の候補にする。遠い初期値からは寄れないので、遠くまで効く損失で先に粗く合わせた初期値も足す。既定で入(NOSLICETIP=1 で切)
  if (s.sliceX) { const tp = new Map(s.chain.map(p0 => { const p = frontOf(s, p0); return [(+p[0]).toFixed(3), tipBall(p)]; })); fr = fr.map(f => { const p = tp.get(f.t.toFixed(3)); return p ? { ...f, bs: [p], pairs: f.pairs.filter(c => Math.hypot(c.bx - p[0], c.by - p[1]) < 40), w: +(E.WSLICETIP || 2), tipW: 1 } : f; }); }
  if (LOB && s.cls === 'lob' && E.LOBTIP) { const tp = new Map((s.chain || []).map(p => [(+p[0]).toFixed(3), tipBall(p)])); fr = fr.map(f => { const p = tp.get(f.t.toFixed(3)); return p ? { ...f, bs: [p], pairs: f.pairs.filter(c => Math.hypot(c.bx - p[0], c.by - p[1]) < 40), w: W_LOBTIP } : f; }); }
  // ロブ専用の列(lobtrail.js: 薄い黄色のトレイルの先端)があるコマは、それだけを球の候補にして重く効かせる。マーカーの周りを外す処理は要らなくなる
  const trk = LOBTRK && s.cls === 'lob' && LOBT[k] && LOBT[k].filter(p => p[0] >= st.th && p[0] <= st.te && !p[5]).length >= 10 ? new Map(LOBT[k].filter(p => !p[5]).map(p => [(+p[0]).toFixed(3), [p[1], p[2], 100, 10, 10]])) : null;
  if (trk) { const P = LOBT[k].filter(p => !p[5] && p[0] > st.th + .3 && p[0] < st.te - .02), at = (t, d) => P.filter(p => p[0] >= t + Math.min(0, d) && p[0] <= t + Math.max(0, d));
    const i = P.findIndex(p => at(p[0], -.1).concat(at(p[0], .1)).every(o => o[2] <= p[2]) && at(p[0], .35).some(o => o[2] <= p[2] - 40) && at(p[0], -.3).some(o => o[2] <= p[2] - 100));
    if (i >= 0) st.trkB = { t: P[i][0], x: P[i][1], y: P[i][2] }; if (E.DBG) console.log("   trkB#" + (k + 1), JSON.stringify(st.trkB), P.length); }
  s.trkBounced = !!st.trkB; if (trk) st.trk0 = LOBT[k].find(p => !p[5] && p[0] >= st.th + .03);
  // 弾んだ後は向きが変わることがある(曲がるロブ)。模型では表せないので、弾んで 0.1 秒より後のコマは見ない
  if (trk) fr = fr.map(f => { if (st.trkB && f.t > st.trkB.t + .1) return { ...f, bs: [], pairs: [], w: 1e-6 }; const p = trk.get(f.t.toFixed(3)); return p ? { ...f, bs: [p], pairs: f.pairs.filter(c => Math.hypot(c.bx - p[0], c.by - p[1]) < 40), w: W_LOBTRK } : f; });
  // ロブの着弾マーカー(地面の黄色い印)は球ではない。その周りの候補は外す
  if (!trk && lobLand(s) && !E.NOMARK) fr = fr.map(f => { const v = project(s.land[0], 0, s.land[1], f.c); if (!v) return f; const near = (x, y) => Math.abs(x - v.x) < +(E.MKX || 170) && Math.abs(y - v.y) < +(E.MKY || 60); if (!f.bs.some(c => near(c[0], c[1]))) return f; return { ...f, bs: f.bs.filter(c => !near(c[0], c[1])), pairs: f.pairs.filter(c => !near(c.bx, c.by)) }; });
  const f = x => { const q = toQ(s, x), b = bounceOf(q); return b ? dataCost(q, b, fr) + penalty(s, q, b, st) : 1e3; };
  const inits = [];
  if (s.x) inits.push(s.x);
  if (fresh) { inits.push(...initPairs(s, st)); inits.push(...initGrid(s, st, fr)); if (fr.some(f => f.tipW) && !E.NOSLICEINIT) { const frW = fr.map(f => f.tipW ? { ...f, bs: [[f.bs[0][0], f.bs[0][1], 100, 0, 0, 'wide']] } : f), fW = x => { const q = toQ(s, x), b = bounceOf(q); return b ? dataCost(q, b, frW) + penalty(s, q, b, st) : 1e3; }; /* 相手のスライスは強く曲がる(横の加速度 30m/s² 前後)。曲がりの無い格子では列に寄れないので、列だけに合う曲がる軌道を乱数で探して初期値に足す。SLICECURVE=1 で入。前後の打とのつなぎは SLICEW 倍に弱める(試し: SLICECURVE=1 SLICEW=.05 SLICENOSERVE=1) */ if (SLICECURVE) { const tips = frW.filter(f => f.tipW), sgn = s.side === 'me' ? -1 : 1, T0 = tips[0].t - .03, T1 = tips[tips.length - 1].t, T = T1 - T0; let sd = 777 + k; const R = (a, b) => { sd = (sd * 1664525 + 1013904223) >>> 0; return a + (b - a) * sd / 4294967296; };
  const cst = x => { const q = toQ(s, x), b = bounceOf(q); if (!b) return 1e6; let c = 0; for (const f of tips) { const w = pos(q, f.t, b), v = project(w.X, w.Y, w.Z, f.c), d2 = v ? (v.x - f.bs[0][0]) ** 2 + (v.y - f.bs[0][1]) ** 2 : 1e8; c += d2 / (d2 + 3600); } return c; };
  if (tips.length >= 6 && T > .15) { const cand = []; for (let i = 0; i < SLICECURVE_N; i++) { const H = [R(-9, 9), R(.3, 3), sgn * R(2, 15)], E = [R(-7, 7), R(.2, 3.5), -sgn * R(-1, 13)], g = R(5, 30), ac = R(-45, 45);
    const dx = E[0] - H[0], dz = E[2] - H[2], L = Math.hypot(dx, dz), aX = -dz / L * ac, aZ = dx / L * ac, V0 = [dx / T - .5 * aX * T, (E[1] - H[1] + .5 * g * T * T) / T, dz / T - .5 * aZ * T], d = s.t - T0;
    const x = toX({ tr: s.t, P: [H[0] + V0[0] * d + .5 * aX * d * d, H[1] + V0[1] * d - .5 * g * d * d, H[2] + V0[2] * d + .5 * aZ * d * d], V: [V0[0] + aX * d, V0[1] - g * d, V0[2] + aZ * d], aX, aZ, g, kh: s.pr.kh[0], e: s.pr.e[0] }); cand.push({ c: cst(x), x }); }
    cand.sort((a, b) => a.c - b.c); for (const c0 of cand.slice(0, 4)) { const r = nelderMead(fW, c0.x, STEP, 2500); if (bounceOf(toQ(s, r.x))) inits.push(r.x); } } }
  for (const x0 of initGrid(s, st, frW, 1)) { const r = nelderMead(fW, x0, STEP, 2500); if (bounceOf(toQ(s, r.x))) inits.push(r.x); } } if (LOB && s.cls === 'lob' && cont) inits.push(...initLob(s, st, fr)); if (W_STAR && STARINIT) inits.push(...initStar(s, st, fr)); }
  let best = null;
  for (const x0 of inits) {
    let r = nelderMead(f, x0, STEP, 2500);
    r = nelderMead(f, r.x, STEP.map(v => v * .4), 2500);
    if (!best || r.f < best.f) best = r;
  }
  s.x = best.x; s.cost = best.f; s.nFr = fr.length;
  { const q = toQ(s, s.x), b = bounceOf(q); let n = 0; for (const f of fr) { if (!f.pairs.length) continue; const p = pos(q, f.t, b), pb = project(p.X, p.Y, p.Z, f.c), ps = project(p.X, 0, p.Z, f.c); if (pb && ps && f.pairs.some(c => Math.hypot(c.sx - ps.x, c.sy - ps.y) < 15 && Math.hypot(c.bx - pb.x, c.by - pb.y) < 15)) n++; } s.anc = Math.min(1, n / 8); }
  if (+E.DBGFIT === k + 1 || E.DBGFIT === 'solo' && !cont) { const q = toQ(s, s.x), b = bounceOf(q), H = pos(q, st.th, b); console.log('  fit#' + (k + 1), cont ? 'cont' : 'solo', 'th', st.th.toFixed(3), 'te', st.te.toFixed(3), 'inits', inits.length, 'data', dataCost(q, b, fr).toFixed(2), 'pen', penalty(s, q, b, st).toFixed(2), 'H', [H.X, H.Y, H.Z].map(v => v.toFixed(1)).join(','), 'B', b.t.toFixed(2), b.X.toFixed(1), b.Z.toFixed(1), 'g', q.g.toFixed(1), 'nFr', fr.length, 'E', (e => [e.X, e.Y, e.Z].map(v => v.toFixed(1)).join(','))(pos(q, st.te, b))); }
}
// 列(トレイル)はその打の球にしか付かない: 打つ時刻は自分の列の始まりより後にならず、前の打の列の終わりより前にならない。CHAINT=1 で有効。スライド・とびつきはキャラのトレイルを拾うので使わない
const SLICECURVE = +(E.SLICECURVE || 0), SLICECURVE_N = +(E.SLICECURVEN || 20000), SLICEW = +(E.SLICEW || 1);
const CHAINT = +(E.CHAINT || 0), CHAIN_N = +(E.CHAINN || 6), CHAIN_M = +(E.CHAINM || .03);
const chOk = s => CHAINT && s.cls !== 'slide' && s.cls !== 'dive' && s.cls !== 'lob' && (s.chain || []).length >= CHAIN_N;
const thLo = k => k > 0 && chOk(S[k - 1]) ? S[k - 1].chain[S[k - 1].chain.length - 1][0] - CHAIN_M : -1e9;
const thHi = k => chOk(S[k]) ? S[k].chain[0][0] + CHAIN_M : 1e9;
function junctions() {
  for (let k = 1; k < S.length; k++) {
    if (S[k].thLock) continue; // ロブとその次の打は scanTh で決める
    const a = S[k - 1], b = S[k], qa = toQ(a, a.x), qb = toQ(b, b.x), ba = bounceOf(qa);
    const pref = b.t - .08; let best = null;
    // 切り替えの時刻は観測でも決める: t より前のコマは前の打、後のコマは次の打で説明できるか
    const bb = bounceOf(qb), jf = frames.filter(f => f.t >= b.t - .32 && f.t <= b.t + .32).map(f => ({ t: f.t, ca: frameCost(qa, ba, f), cb: frameCost(qb, bb, f) }));
    for (let t = b.t - JLO; t <= b.t + JHI + .0001; t += 1 / 120) {
      if (t < S[k - 1].th + .15) continue;
      if (thLo(k) <= thHi(k) && (t < thLo(k) || t > thHi(k))) continue;
      const p = pos(qa, t, ba), d = t - qb.tr;
      const X = qb.P[0] + qb.V[0] * d + .5 * qb.aX * d * d, Y = qb.P[1] + qb.V[1] * d - .5 * qb.g * d * d, Z = qb.P[2] + qb.V[2] * d + .5 * qb.aZ * d * d;
      let dc = 0; for (const f of jf) dc += f.t < t ? f.ca : f.cb;
      const c = Math.hypot(p.X - X, p.Y - Y, p.Z - Z) + .6 * Math.abs(t - pref) + 3 * hinge(Y, .15, Y0_MAX(b, { cont: true, prevEnd: p })) + W_JDATA * dc;
      if (!best || c < best.c) best = { c, t };
    }
    if (best) b.th = best.t;
  }
  S.forEach((s, k) => { s.te = k + 1 < S.length ? S[k + 1].th : s.end; });
}
const log = (...a) => { if (!QUIET) console.log(...a); };
const t0 = Date.now();
// サーブの先端列を信じるかどうか: 絞った観測で当てはめ、モデルが先端列の半分以上に乗れば採用(乗らなければ先端列は球ではない)
const setGate = on => frames.forEach(f => { f.bs = on ? f.bsG : f.bsU; f.pairs = on ? f.pairsG : f.pairsU; });
let gateUsed = false, gateHit = null, gateNote = null;
const snap0 = S.map(s => ({ th: s.th, te: s.te }));
if (TIPGATE > 0 && S[0].serve && (S[0].chain || []).length >= 6) {
  // サーブは検出時刻より後に打たれていることがある(トスを拾う)。打点の時刻を 0.05 秒きざみでずらして、先端列にいちばん乗るものを採る
  setGate(true); let bestG = null;
  for (let d = 0; d <= .3001; d += .05) {
    S[0].th = S[0].t + d; S[0].x = null; fitShot(0, false, true);
    const q = toQ(S[0], S[0].x), bq = bounceOf(q); let n = 0, m = 0;
    for (const p of S[0].chain) { const c = cam(p[0]); if (c.bad || p[0] < S[0].th || p[0] > S[0].te) continue; const w = pos(q, p[0], bq), v = project(w.X, w.Y, w.Z, c); n++; const tb = tipBall(p); if (v && Math.hypot(v.x - tb[0], v.y - tb[1]) < 40) m++; }
    if (E.DBG) console.log('gate d', d.toFixed(2), m + '/' + n, 'cost', S[0].cost.toFixed(1), S[0].x.slice(0, 3).map(v => v.toFixed(2)).join(','));
    if (n >= 5 && (!bestG || m / n > bestG.hit + 1e-9)) bestG = { hit: m / n, d };
  }
  gateHit = bestG ? bestG.hit : 0; gateUsed = gateHit >= .5;
  S[0].th = S[0].t + (gateUsed ? bestG.d : 0);
  if (!gateUsed) setGate(false);
  S[0].x = null;
}
// ロブは打つ時刻と打点が一緒に動かないと合わない(交互に解くと検出時刻の近くで止まる)。打つ時刻を振って当てはめ直し、
// 「それより前のコマは前の打、後のコマはこの打」で説明したときの合計がいちばん小さい時刻を採る
var lobRel = k => LOB && k > 0 && (S[k].cls === 'lob' || S[k - 1].cls === 'lob');
function scanTh(k) {
  const s = S[k], P = S[k - 1], qp = toQ(P, P.x), bp = bounceOf(qp), lo = s.t - .15, cand = [];
  for (let d = -.15; d <= .2001; d += .05) {
    const th = s.t + d; if (th < P.th + .2 || th > s.te - .2) continue;
    s.th = th; P.te = th; s.x = null; fitShot(k, true, true);
    let pre = 0; for (const f of frames) if (f.t >= lo && f.t < th + .02 && !f.c.bad) pre += frameCost(qp, bp, f);
    cand.push({ th, c: s.cost + pre, x: s.x });
    if (E.DBG) console.log('  scanTh', k + 1, 'd', d.toFixed(2), 'fit', s.cost.toFixed(2), 'pre', pre.toFixed(2));
  }
  if (!cand.length) return;
  cand.sort((a, b) => a.c - b.c); s.th = cand[0].th; P.te = s.th; s.x = cand[0].x; fitShot(k, true, false);
}
let seedLast = 0;
const fitAll = () => {
  seedLast = _seed;
  S.forEach((s, k) => { s.thLock = lobRel(k); });
  for (let k = 0; k < S.length; k++) fitShot(k, false, true);
  junctions();
  for (let sweep = 0; sweep < 3; sweep++) { for (let k = 0; k < S.length; k++) { if (sweep < 2 && LOB && S[k].cls === 'lob' && k > 0) scanTh(k); else fitShot(k, true, sweep < 2); } junctions(); }
  for (let k = 0; k < S.length; k++) fitShot(k, true, false);
};
const snap1 = S.map(s => ({ th: s.th, te: s.te }));
fitAll();
// 先端列を信じた結果の検算: サーブは返球の前に相手のサービスエリア付近で弾み、返球の時刻は検出から大きくずれないはず。
// 外れたら先端列は球ではなかったとみなし、絞りを外してやり直す
if (gateUsed && S.length > 1) {
  const q = toQ(S[0], S[0].x), b = bounceOf(q), sg = S[0].side === 'me' ? 1 : -1;
  const ok = b && b.t < S[1].th - .005 && sg * b.Z > .5 && sg * b.Z < 7.6 && Math.abs(S[1].th - S[1].t) <= .15;
  if (!ok) {
    gateNote = 'rejected'; gateUsed = false; setGate(false);
    S.forEach((s, k) => { s.th = snap0[k].th; s.te = snap0[k].te; s.x = null; });
    fitAll();
  }
}
if (TWO && !NOSTARX && W_STAR) {
  let n = 0; S.forEach(s => { const m = s.side === 'me' && !(E.NOLOBX && s.cls === 'lob') && s.x && starOf(s); if (!m) return; const p = pos(toQ(s, s.x), m.t1 - STAR_LAG); if (Math.hypot(p.X - m.G.X, p.Z - m.G.Z) > STARMISS) { s.starX = true; n++; } });
  // スライス: 1回目で球(黄色の候補)をほとんど拾えていない相手のスライスだけ、2回目で列の前側の端を球として使う(球が黄色で見えている打には掛けない)
  if (!E.NOSLICETIP) S.forEach((s, k) => { if (s.cls === 'slice' && !(s.serve && E.SLICENOSERVE) && (s.side !== 'me' || E.SLICETIPME) && (s.chain || []).length >= +(E.SLICEN || 8) && s.x && ballRatio(k) < +(E.SLICEMISS || .3)) { s.sliceX = true; n++; } });
  if (n) { log('二段目: ☆から外れた打', S.map((s, k) => s.starX ? k + 1 : 0).filter(Boolean).join(','), '/ 列を使うスライス', S.map((s, k) => s.sliceX ? k + 1 : 0).filter(Boolean).join(',')); S.forEach((s, k) => { const sn = gateNote === 'rejected' ? snap0 : snap1; s.th = sn[k].th; s.te = sn[k].te; s.x = null; }); _seed = seedLast; fitAll();
    // 列に乗らなかったスライス(列が球でない、または寄れなかった)は隣の打を崩すので、対象から外してやり直す
    const offCh = s => { const q = toQ(s, s.x), b = bounceOf(q), d = []; for (const p0 of s.chain) { const c = cam(p0[0]); if (c.bad || p0[0] < s.th || p0[0] > s.te) continue; const w = pos(q, p0[0], b), v = project(w.X, w.Y, w.Z, c), tb = tipBall(frontOf(s, p0)); d.push(v ? Math.hypot(v.x - tb[0], v.y - tb[1]) : 1e4); } d.sort((x, y) => x - y); return d.length >= 4 ? d[d.length >> 1] : 1e4; };
    const bad = S.filter(s => s.sliceX && offCh(s) > +(E.SLICEOFF || 60));
    if (bad.length) { log('列に乗らなかったスライスを外す', bad.map(s => S.indexOf(s) + 1).join(',')); bad.forEach(s => { s.sliceX = false; }); S.forEach((s, k) => { const sn = gateNote === 'rejected' ? snap0 : snap1; s.th = sn[k].th; s.te = sn[k].te; s.x = null; }); _seed = seedLast; fitAll(); }
  }
}
log('fit ms', Date.now() - t0);

// ---- 出力 ----
const r2 = v => +v.toFixed(2), r3 = v => +v.toFixed(3);
const out = S.map((s, k) => {
  const q = toQ(s, s.x), b = bounceOf(q), H = pos(q, s.th, b), E = pos(q, s.te, b), n = netCross(q, b);
  const fr = framesIn(s.th, s.te); let nBall = 0, nPair = 0, nPairFr = 0;
  for (const f of fr) {
    const p = pos(q, f.t, b), pb = project(p.X, p.Y, p.Z, f.c), ps = project(p.X, 0, p.Z, f.c);
    if (f.bs.some(c => Math.hypot(c[0] - pb.x, c[1] - pb.y) < 15)) nBall++;
    if (f.pairs.length) nPairFr++;
    if (f.pairs.some(c => Math.hypot(c.sx - ps.x, c.sy - ps.y) < 15 && Math.hypot(c.bx - pb.x, c.by - pb.y) < 15)) nPair++;
  }
  const landed = b.t < s.te - .005;
  const o = {
    k, side: s.side, cls: s.cls, det: s.t, th: r3(s.th), te: r3(s.te), H: [r2(H.X), r2(H.Y), r2(H.Z)], E: [r2(E.X), r2(E.Y), r2(E.Z)],
    tb: landed ? r3(b.t) : null, B: landed ? [r2(b.X), r2(b.Z)] : null, Bx: [r3(b.t), r2(b.X), r2(b.Z)],
    netY: n ? r2(n.Y) : null, g: r2(q.g), aX: r2(q.aX), aZ: r2(q.aZ), kh: r2(q.kh), e: r2(q.e),
    v0: r2(Math.hypot(q.V[0] + q.aX * (s.th - q.tr), q.V[2] + q.aZ * (s.th - q.tr))), q: { tr: q.tr, P: q.P.map(r3), V: q.V.map(r3), aX: r3(q.aX), aZ: r3(q.aZ), g: r3(q.g), kh: r3(q.kh), e: r3(q.e) },
    nFr: fr.length, nBall, nPair, nPairFr, cost: r2(s.cost),
  };
  if (k === 0 && gateHit != null) { o.tipGate = gateUsed; o.tipHit = r2(gateHit); if (gateNote) o.tipNote = gateNote; }
  // 信頼度: 球か影つきの球にどれだけ乗ったか。low は観測がほぼ無く、事前分布とつながりだけで決まった打
  const rb = fr.length ? nBall / fr.length : 0;
  o.conf = fr.length >= 10 && (rb >= .5 && nBall >= 10 || nPair >= 10) ? 'high' : fr.length >= 6 && (rb >= .25 && nBall >= 6 || nPair >= 5) ? 'mid' : 'low';
  if (k + 1 < S.length) { const N = S[k + 1], Hn = pos(toQ(N, N.x), N.th); o.gap = r2(Math.hypot(E.X - Hn.X, E.Y - Hn.Y, E.Z - Hn.Z)); }
  return o;
});
  return out;
}

// ---- 入口: 1 ポイントの rally（打の配列）に traj を足す ----
// cams は analyze の出力の形（{t, c0, c1, Xc}）、markers は Star.track の結果、trailLog は analyze の trailLog
async function apply({ video, rally, cams, trailLog, markers, verbose }) {
  const started = Date.now();
  const src = rally.filter(s => s && isFinite(s.t)).slice().sort((a, b) => a.t - b.t);
  if (!src.length || cams.length < 2) return { n: 0, skipped: !src.length ? 'no-shots' : 'no-cams' };
  const ffmpeg = ShotColor.findFfmpeg();
  const shots = tracksOf(src, trailLog || []);
  const camsF = E.NOCAMFILL ? cams.map(c => ({ t: c.t, c0: c.c0, c1: c.c1, Xc: c.Xc })) : camFill({ video, shots, cams, ffmpeg });
  const lobs = shots.filter(s => s.cls === 'lob');
  const { cands, shad, lobFr } = await collect({ video, ta: shots[0].t - .25, tb: shots[shots.length - 1].t + 1.4, lobWins: lobs.map(lobWin), ffmpeg });
  const lob = {}; for (const s of lobs) lob[s.k] = lobChain(s, lobFr);
  const stars = (markers || []).map(m => ({ t0: m.t0, t1: m.t1, x: m.x * 2, y: m.y * 2, n: m.nMax, w: m.w * 2, h: m.h * 2 }));
  const prepMs = Date.now() - started;
  const out = fitPoint({ balls: cands, shad, shots, cams: camsF, lob, stars, verbose });
  const cnt = { high: 0, mid: 0, low: 0 };
  out.forEach((o, k) => {
    cnt[o.conf]++;
    src[k].traj = { th: o.th, H: o.H, E: o.E, tb: o.tb, B: o.B, Bx: o.Bx, netY: o.netY, g: o.g, v0: o.v0, conf: o.conf, nFr: o.nFr, nBall: o.nBall, nPair: o.nPair, q: o.q };
  });
  return { n: out.length, ...cnt, camsAdded: camsF.length - cams.length, frames: cands.length, prepMs, ms: Date.now() - started };
}

if (require.main === module) {
  const a = process.argv.slice(2), di = a.indexOf('--data'), ji = a.indexOf('--json');
  if (di < 0 || !a[di + 2]) { console.error('usage: node tools/traj.js --data <試作の data フォルダ> <idx> [--json out.json]'); process.exit(2); }
  const D = a[di + 1], idx = a[di + 2], rd = n => { try { return JSON.parse(fs.readFileSync(path.join(D, `p${idx}-${n}.json`), 'utf8')); } catch (e) { return null; } };
  const tr = rd('tracks'), out = fitPoint({ balls: rd('cands'), shad: rd('shad'), shots: tr.shots, cams: (!E.NOCAMFILL && rd('cams')) || tr.cams, lob: rd('lob') || {}, stars: rd('star') || [], verbose: !a.includes('--quiet') });
  if (ji >= 0) fs.writeFileSync(a[ji + 1], JSON.stringify(out));
}

module.exports = { apply, fitPoint, tracksOf, camFill, collect, lobChain, makeCam, project, toCourt, heightAt, bounceOf, pos, netCross };
