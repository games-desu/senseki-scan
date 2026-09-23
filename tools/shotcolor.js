// SENSEKI SCAN ラリー解析: 追跡由来（トレイルの run が無い）打点の種別を、打点直後の「球の通り道」の色で読む後段（Node 専用・2026-09-24）。
//
// 背景: rally-fuse は種別をトレイル（trail.js の run）の色で付けるので、同側補完・空白補完・打ち出しで入る追跡由来の打点（src track / far-* / launch*）は unknown になる。
//   トレイル自体は画面に出ているのに run にならない理由は 2 つ:
//   (1) 砂の黄トレイルは砂と同じ色相（H 52）で、1 画素ずつの色ゲートでは原理的に分けられない。フル解像度で見ると筋は
//       砂より彩度が 0.1〜0.15 高い（0911 p7 188.35: 筋 (218,200,78) S0.64 / 脇の砂 (209,191,94) S0.55・B が 20〜30 低い）。
//       → 同じ断面の両脇の砂と比べれば「彩度だけが高い帯」として見える。
//   (2) 奥側の彗星・自分側の短い筋は小さく／断片的で run にならないが、球の位置（追跡点）が分かっていれば、その後ろの帯だけ見れば足りる。
//
// 方法: 打点 +0.03〜+0.6 秒（次の打点の 0.05 秒前まで）の追跡点（960 の segPts の区間ごと・奥側は farBall.tracks も）を折れ線にし、
//   フル解像度・60fps で、各コマの「LAG 秒前の球の位置 → 今の球の位置」の線分を 2px 刻みの断面に切り、
//   線分上（半幅 HW）と両脇 ±OFF の画素を比べる（同じ断面どうしなのでコートの縞・影は相殺される）。
//   断面ごとに:
//     - 両脇の食い違い: 片脇だけが有彩色・または両脇の色相が 12° を超えて違う断面は捨てる（網・審判台の影・コートの縁・観客席を横切る断面。下の「ハードコート」）
//     - 色相の帯: 帯の有彩色（S > 0.25・V ≥ 0.2）の色相が脇と 12° を超えて違う（脇が無彩色なら帯の色相そのもの）。かつ帯が明るい（明度の中央値 0.4 以上）
//     - 同色の濃い帯: 色相が脇と同じで彩度が脇より 0.05 以上高く暗くない（黄コートの黄トレイル）→ 低信頼
//     - 白い帯: 彩度が 0.25 未満で脇より 0.15 以上低く明るい → 低信頼
//   コマごとに断面の多数決（40% 以上）、コマの多数決（4 コマ以上かつ 2 位の 2 倍以上）で種別を決める。色相の境界は trail.js classify と同じ。
//   ハードコート（2026-09-24 統合）: 0908b のコートは青灰 H 220・S 0.22〜0.48 で、彩度が「有彩色」の切り 0.25 をまたぐ。網・審判台の影は同じ青系で暗く彩度が上がる
//   （帯 H 190〜200・S 0.4〜0.57・V 0.21〜0.27／両脇はコートの S 0.21〜0.28 で無彩色側に落ちる）ので、影を横切る断面が「無彩色の脇の上の青い帯」＝slice になっていた
//   （全体走 0908b p1 104.58 の自分の黄ロブが slice。2026-09-24 に断面ごとの帯・両脇の HSV を書き出して確認）。ショットのトレイルは光る筋で明るい（ベンチの本物の色相の帯は明度の中央値 0.42 以上・
//   p10 0.80〜0.90）ので、色相の帯は帯の明度 0.4 以上に限った（影の帯は 134 断面中 93 が 0.35 未満）。これだけで 104.58 は slice でなくなる（lob 1 票・種別なし）。
//   あわせて両脇の食い違い（片脇だけ有彩色・両脇の色相差 12° 超）の断面を捨て、有彩色に V ≥ 0.2 を課した（影の芯 V 0.11・S 0.6〜0.9 を有彩色に数えない）。
//   やって戻した: コートが有彩色のとき帯の有彩色の切りを脇の彩度＋0.1 に上げる案。クレイ 0908 p8 226.83 の橙トップスピン（24 票）が 0 票になった
//   カメラ: ラリーカメラの推定が 0.3 秒以内に無いコマ（サーブ画→ラリー画のズーム・カット）と、奥ベースラインの画面位置が 1 コマ 4px（フル解像度）を超えて動くコマ（パン・チルト）は読まない
//   （全体走 0911 p0 14.07: ラリーカメラが立つ 14.58 より前のサーブのズーム中に、観客席の縁を lob と読んだ）。
//
//   ShotColor.apply({ video, rally, segPts, farBall, t1, toCourt, camOk }) → { changed, log, ms }（rally の unknown を書き換える）
//   clsBy: 'pathcolor'（色相の帯）／'pathcolor-sat'（同色の濃い帯→lob・低信頼）／'pathcolor-white'（白い帯→drop・低信頼）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LAG = 0.1, HW = 8, EXCL = 24, OFF = 60;
const CAM_MAX_STEP = 4;   // 奥ベースライン中央の画面位置の 1 コマの移動（フル解像度 px）。ラリー中のドリーは 0.4〜2.7（0908・0911 実測）

function findFfmpeg() {
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, 'ffmpeg.exe'); if (fs.existsSync(p)) return p; }
  return 'ffmpeg';
}
async function grab(video, t0, t1, crop, fps = 60) {
  const BYTES = crop.w * crop.h * 3, out = [];
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-t', String(Math.max(0.001, t1 - t0)), '-i', video,
    '-vf', `fps=${fps},crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  let buf = Buffer.alloc(0), i = 0;
  for await (const c of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= BYTES) { out.push({ t: +(t0 + i / fps).toFixed(4), d: Buffer.from(buf.subarray(0, BYTES)) }); i++; buf = buf.subarray(BYTES); }
  }
  return out;
}
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dd = mx - mn; let h = 0;
  if (dd > 0) { h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: mx ? dd / mx : 0, v: mx / 255 };
}
const hd = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const circMed = hs => { let sx = 0, sy = 0; for (const h of hs) { sx += Math.cos(h * Math.PI / 180); sy += Math.sin(h * Math.PI / 180); } let h = Math.atan2(sy, sx) * 180 / Math.PI; return h < 0 ? h + 360 : h; };

// 色相 → 種別（trail.js classify と同じ境界。暖色の 45〜52 は topspin・52〜75 は lob）
function hueCls(H) {
  if (H >= 250 && H < 345) return 'flat';
  if (H >= 140 && H < 250) return 'slice';
  if (H >= 345 || H < 52) return 'topspin';
  if (H < 75) return 'lob';
  return null;        // 75〜140 は緑＝選手・芝・球そのもの（ショット色に緑は無い）
}

// 画素の組の「有彩色の色相」: 有彩色（S > sCut・V ≥ 0.2）が半数を超えれば色相の円周中央値、でなければ null
const chroma = (px, sCut) => { const c = px.filter(p => p.s > sCut && p.v >= 0.2); return c.length * 2 > px.length ? circMed(c.map(p => p.h)) : null; };

// 1 本の折れ線（フル解像度 {t,x,y}）について、コマごとのラベルを返す
async function readPath(video, pts, t0, t1, camOk = null) {
  pts = pts.filter(p => p.t >= t0 - LAG - 0.02 && p.t <= t1 + 0.02).sort((a, b) => a.t - b.t);
  if (pts.length < 4) return [];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y), pad = OFF + HW + 10;
  const crop = { x: Math.max(0, Math.floor(Math.min(...xs) - pad)), y: Math.max(0, Math.floor(Math.min(...ys) - pad)) };
  crop.w = Math.min(1920 - crop.x, Math.ceil(Math.max(...xs) + pad) - crop.x); crop.h = Math.min(1080 - crop.y, Math.ceil(Math.max(...ys) + pad) - crop.y);
  crop.w -= crop.w % 2; crop.h -= crop.h % 2;
  if (crop.w < 16 || crop.h < 16) return [];
  const frames = await grab(video, t0, t1, crop);
  // 追跡点の線形補間（欠測 0.07 秒まで。それ以上は球を見失っている）
  const at = t => { for (let k = 1; k < pts.length; k++) if (pts[k - 1].t <= t && pts[k].t >= t) { const a = pts[k - 1], b = pts[k]; if (b.t - a.t > 0.07) return null; const w = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0; return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w }; } return null; };
  const out = [];
  for (const fr of frames) {
    if (camOk && !camOk(fr.t)) continue;
    const p = at(fr.t), q = at(fr.t - LAG);
    if (!p || !q) continue;
    const dx = p.x - q.x, dy = p.y - q.y, L = Math.hypot(dx, dy);
    if (L < EXCL + 8) continue;                 // 球がほとんど動いていない（静止物・打点の瞬間）
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const px = (x, y) => { x = Math.round(x - crop.x); y = Math.round(y - crop.y); if (x < 0 || y < 0 || x >= crop.w || y >= crop.h) return null; const i = (y * crop.w + x) * 3; return hsv(fr.d[i], fr.d[i + 1], fr.d[i + 2]); };
    const labs = []; let nS = 0;
    for (let s = 0; s <= L - EXCL; s += 2) {        // 球そのもの（先端 EXCL px）は除く
      const cx = q.x + ux * s, cy = q.y + uy * s, band = [], sA = [], sB = [];
      for (let w = -HW; w <= HW; w += 2) { const c = px(cx + nx * w, cy + ny * w); if (c) band.push(c); }
      for (let w = -HW; w <= HW; w += 2) { const c = px(cx + nx * (w + OFF), cy + ny * (w + OFF)); if (c) sA.push(c); }
      for (let w = -HW; w <= HW; w += 2) { const c = px(cx + nx * (w - OFF), cy + ny * (w - OFF)); if (c) sB.push(c); }
      const bg = sA.concat(sB);
      if (band.length < 4 || sA.length < 2 || sB.length < 2) continue;
      // 両脇の食い違い（網・影・コートの縁・観客席を横切る断面）は捨てる。数えない（nS にも入れない）
      const hA = chroma(sA, 0.25), hB = chroma(sB, 0.25);
      if ((hA == null) !== (hB == null) || (hA != null && hd(hA, hB) > 12)) continue;
      nS++;
      const bS = med(band.map(c => c.s)), gS = med(bg.map(c => c.s)), bV = med(band.map(c => c.v)), gV = med(bg.map(c => c.v));
      const gH = hA == null ? null : circMed(bg.filter(c => c.s > 0.25 && c.v >= 0.2).map(c => c.h));
      const bH = chroma(band, 0.25);
      // 色相の帯は明るい帯だけ（トレイルは光る筋。暗い帯は影: 上のハードコートの説明）
      if (bH != null && bV >= 0.4 && (gH == null || hd(bH, gH) > 12)) labs.push({ k: 'hue', h: bH });
      else if (bH != null && gH != null && hd(bH, gH) <= 12 && bS - gS >= 0.05 && bV - gV >= -0.02) labs.push({ k: 'sat', h: gH, dh: ((bH - gH + 540) % 360) - 180 });
      else if (bS < 0.25 && gS - bS >= 0.15 && bV - gV >= 0.03) labs.push({ k: 'white' });
    }
    if (nS < 6) continue;
    // コマのラベル: 断面の 40% 以上が同じ種類
    const byK = {}; for (const l of labs) (byK[l.k] = byK[l.k] || []).push(l);
    const top = Object.entries(byK).sort((a, b) => b[1].length - a[1].length)[0];
    if (!top || top[1].length < 0.4 * nS) { out.push({ t: fr.t, k: null }); continue; }
    const k = top[0], H = k === 'white' ? null : circMed(top[1].map(l => l.h));
    out.push({ t: fr.t, k, H: H == null ? null : Math.round(H), dh: k === 'sat' ? Math.round(med(top[1].map(l => l.dh))) : null, frac: +(top[1].length / nS).toFixed(2) });
  }
  return out;
}

// フレームラベル列 → 種別。色相の帯は hueCls、同色の濃い帯は黄コート（脇の色相 40〜75）で帯の色相が脇と ±2° 以内なら lob、白は drop
// やって戻した（2026-09-24 統合）: 同色の濃い帯で「脇より 3° 以上赤く帯が 45° 未満」を topspin とする分岐（ベンチで効きなし）
function decide(rows) {
  const vote = {}, by = {};
  for (const r of rows) {
    if (!r.k) continue;
    let c = null;
    if (r.k === 'white') c = 'drop';
    else if (r.k === 'sat') c = r.H >= 40 && r.H < 75 && Math.abs(r.dh) <= 2 ? 'lob' : null;
    else c = hueCls(r.H);
    if (!c) continue;
    vote[c] = (vote[c] || 0) + 1;
    (by[c] = by[c] || {})[r.k] = (by[c][r.k] || 0) + 1;
  }
  const ranked = Object.entries(vote).sort((a, b) => b[1] - a[1]);
  const best = ranked[0], second = ranked[1];
  // 4 コマ以上（60fps で 0.07 秒）かつ 2 位の 2 倍以上
  if (!best || best[1] < 4 || (second && second[1] * 2 > best[1])) return { cls: null, vote, n: rows.length };
  // 決め手の種類（票の多い方）: hue → pathcolor・sat → pathcolor-sat（低信頼）・white → pathcolor-white（低信頼）
  const kind = Object.entries(by[best[0]]).sort((a, b) => b[1] - a[1])[0][0];
  return { cls: best[0], vote, n: rows.length, clsBy: kind === 'hue' ? 'pathcolor' : 'pathcolor-' + kind };
}

// 折れ線がこの打点の打球か: 打った側から相手側へ向かって動いていること（向き）と、始点が打った側のコートにあること（Z/X）の両方。
//   me の打球は画面の上へ（y 減少）・始点は自分側（地面換算 Z < 3）、opp の打球は下へ（y 増加）・始点は相手側（Z > −3）・|X| ≤ 10。
//   砂 0911 p7 184.97（自分のサーブ）で奥の観客席の黄色い軌道（(1373,104)→(1409,70)）が、188.13 で画面上端の観客席の白い軌道（y 15〜25）が拾われて誤った
//   やって戻した: 始点を打点の位置（h.from を画面へ戻したもの）から 300px 以内に限る。追跡由来の打点の from は 960 の追跡イベントの位置で、
//   それ自体が別物に乗っていることがある（砂 0911 p7 187.58: イベントは観客席の (131,56)・本物の球は (543,121)→ 本物の橙を読めなくなった）
function pathOk(h, win, toCourt) {
  const a = win[0], b = win[win.length - 1], dy = b.y - a.y;
  if (h.side === 'me' ? dy > -40 : dy < 40) return false;
  if (toCourt) { const c = toCourt(a.t, a.x, a.y); if (c && (h.side === 'me' ? c.Z > 3 : c.Z < -3)) return false; if (c && Math.abs(c.X) > 10) return false; }
  return true;
}

async function classifyHit(video, h, tNext, paths, toCourt = null, camOk = null) {
  const t0 = h.t + 0.03, t1 = Math.min(h.t + 0.6, tNext - 0.05);
  if (t1 - t0 < 0.1) return { cls: null, why: 'short' };
  let best = null;
  for (const P of paths) {
    const inWin = P.pts.filter(p => p.t >= t0 && p.t <= t1);
    if (inWin.length < 4) continue;
    if (!pathOk(h, inWin, toCourt)) continue;
    const rows = await readPath(video, P.pts, t0, t1, camOk);
    const d = decide(rows);
    d.src = P.src;
    if (d.cls && (!best || !best.cls || (d.vote[d.cls] > best.vote[best.cls]))) best = d;
    else if (!best) best = d;
  }
  return best || { cls: null, why: 'no-path' };
}

// 読めるコマか（camOk の作り方）: ラリーカメラの推定（cams: [{t, cam}] か cam 本体に t）が 0.3 秒以内にあり、奥ベースライン中央の画面位置の 1 コマの移動が CAM_MAX_STEP 以下
function makeCamOk(camList, Court) {
  const cs = camList.map(c => c.cam ? Object.assign({ t: c.t }, c.cam) : c).filter(c => c.ok !== false).sort((a, b) => a.t - b.t);
  if (!cs.length) return () => false;
  const pts = cs.map(c => { const p = Court.toScreen(0, Court.Z_BASE, c); return { t: c.t, x: p.x, y: p.y }; });
  const ref = t => {
    if (t <= pts[0].t) return pts[0]; if (t >= pts[pts.length - 1].t) return pts[pts.length - 1];
    let i = 0; while (i + 1 < pts.length && pts[i + 1].t < t) i++;
    const a = pts[i], b = pts[i + 1], w = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  return t => {
    let near = Infinity; for (const c of cs) near = Math.min(near, Math.abs(c.t - t));
    if (near > 0.3) return false;
    const a = ref(t - 1 / 60), b = ref(t);
    return Math.hypot(b.x - a.x, b.y - a.y) <= CAM_MAX_STEP;
  };
}

// rally の unknown（トレイル以外の由来）を書き換える。トレイル由来の打点は触らない
// toCourt(t, xFull, yFull) → {X, Z}（地面ホモグラフィ）。無ければ位置の篩いは掛けない
async function apply({ video, rally, segPts = [], farBall = null, t1 = Infinity, only = null, toCourt = null, camOk = null }) {
  const started = Date.now();
  const paths = [];
  for (const s of segPts) paths.push({ src: '960', pts: s.pts.map(p => ({ t: p.t, x: p.x * 2, y: p.y * 2 })) });
  if (farBall && farBall.tracks) for (const tr of farBall.tracks) paths.push({ src: 'far', pts: tr.pts.map(q => ({ t: q[0], x: q[1], y: q[2] })) });
  const log = []; let changed = 0;
  for (let i = 0; i < rally.length; i++) {
    const h = rally[i];
    if (only ? !only(h) : (h.cls !== 'unknown' || h.src === 'trail')) continue;
    const tNext = i + 1 < rally.length ? rally[i + 1].t : t1;
    const r = await classifyHit(video, h, tNext, paths, toCourt, camOk);
    log.push({ t: h.t, side: h.side, src: h.src, was: h.cls, got: r.cls, clsBy: r.clsBy, vote: r.vote, via: r.src });
    if (!only && r.cls) { h.clsPath = r.cls; h.cls = r.cls; h.clsBy = r.clsBy; changed++; }
  }
  return { changed, log, ms: Date.now() - started };
}

module.exports = { apply, classifyHit, readPath, decide, hueCls, pathOk, makeCamOk };
