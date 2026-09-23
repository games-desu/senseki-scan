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
//   2026-09-24 color レーン: (1) 読む区間の線分の尾を打点の時刻 h.t より前へ伸ばさない（readPath の tFrom・入射球の筋を読まない）
//   (2) ネット際の自分の打点は pathOk の Z 上限を緩める (3) クレイでは暖色 42〜57 を色で決めない・暖色は帯の先端側 1/3 の色相で決める
//   (4) 頂点規則の lob も読み、色相の帯が 6 コマ以上非ロブなら書き換える（pathcolor-over-apex） (5) FHD 以外は読まない（clsNote に印）。
//   2026-09-24 exp-int3f: (5) を FHD 60fps 以外に広げた（30fps も読まない・理由は '1920x1080@30fps'）。門の判定 notFhd60 と videoSize は rally-node（farball の門・frames の fps）も使う。
//   readPath の dbg（{ frame(t, o) }）はコマごとの読み（飛ばした理由・断面のラベル）を返す調査用のフック（samples/rally/exp-color/sc-debug.js）。
//
//   ShotColor.apply({ video, rally, segPts, farBall, t1, toCourt, camOk }) → { changed, log, ms, skipped? }（rally の unknown と頂点規則の lob を書き換える）
//   clsBy: 'pathcolor'（色相の帯）／'pathcolor-sat'（同色の濃い帯→lob・低信頼）／'pathcolor-white'（白い帯→drop・低信頼）／'pathcolor-over-apex'（頂点規則の lob を色で覆した）
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
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-t', String(Math.max(1 / fps, t1 - t0)), '-i', video,
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
// G = 脇（コート）の色相。赤いクレイ（脇の色相 0〜27・0908 p8 の脇は 10〜13）では、半透明の筋がコートの赤に引かれて黄ロブが 42〜53 に読め（全体走 0908 p12 281.37 の
//   自分の黄ロブ: 先端側の断面 42〜53・far 軌道で topspin 19 票 / lob 10 票）、橙トップスピンも 51〜57 まで読める（0908 p8 224.4 の自分のトップスピン: 先端 49〜57）。
//   rally-fuse の頂点規則のコメントにもクレイの黄ロブ 42〜56 の実測がある。重なる 42〜57 は色では決めない（null）。42 未満（クレイのトップスピン 222.4 は 29〜33・226.9 は 33〜39）は topspin のまま
function hueCls(H, G = null) {
  if (H >= 250 && H < 345) return 'flat';
  if (H >= 140 && H < 250) return 'slice';
  if (G != null && hd(G, 13) <= 14 && H >= 42 && H < 57) return null;
  if (H >= 345 || H < 52) return 'topspin';
  if (H < 75) return 'lob';
  return null;        // 75〜140 は緑＝選手・芝・球そのもの（ショット色に緑は無い）
}

// 画素の組の「有彩色の色相」: 有彩色（S > sCut・V ≥ 0.2）が半数を超えれば色相の円周中央値、でなければ null
const chroma = (px, sCut) => { const c = px.filter(p => p.s > sCut && p.v >= 0.2); return c.length * 2 > px.length ? circMed(c.map(p => p.h)) : null; };

// 1 本の折れ線（フル解像度 {t,x,y}）について、コマごとのラベルを返す
async function readPath(video, pts, t0, t1, camOk = null, dbg = null, tFrom = -Infinity) {
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
    const skip = why => { if (dbg && dbg.frame) dbg.frame(fr.t, { skip: why }); };
    if (camOk && !camOk(fr.t)) { skip('cam'); continue; }
    const p = at(fr.t), q = at(Math.max(fr.t - LAG, tFrom));   // 線分の尾は打点の時刻（tFrom = h.t）より前へ伸ばさない（入射球の筋を読まない）
    if (!p || !q) { skip(!p ? 'gap-p' : 'gap-q'); continue; }
    const dx = p.x - q.x, dy = p.y - q.y, L = Math.hypot(dx, dy);
    if (L < EXCL + 8) { skip('short'); continue; }                // 球がほとんど動いていない（静止物・打点の瞬間）
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
      if ((hA == null) !== (hB == null) || (hA != null && hd(hA, hB) > 12)) { if (dbg) dbg.mis = (dbg.mis || 0) + 1; continue; }
      nS++;
      const bS = med(band.map(c => c.s)), gS = med(bg.map(c => c.s)), bV = med(band.map(c => c.v)), gV = med(bg.map(c => c.v));
      const gH = hA == null ? null : circMed(bg.filter(c => c.s > 0.25 && c.v >= 0.2).map(c => c.h));
      const bH = chroma(band, 0.25);
      // 色相の帯は明るい帯だけ（トレイルは光る筋。暗い帯は影: 上のハードコートの説明）
      if (dbg && dbg.sec) dbg.sec.push({ s, bH: bH == null ? null : Math.round(bH), bS: +bS.toFixed(2), bV: +bV.toFixed(2), gH: gH == null ? null : Math.round(gH), gS: +gS.toFixed(2), gV: +gV.toFixed(2) });
      if (bH != null && bV >= 0.4 && (gH == null || hd(bH, gH) > 12)) labs.push({ k: 'hue', h: bH, s, g: gH });
      else if (bH != null && gH != null && hd(bH, gH) <= 12 && bS - gS >= 0.05 && bV - gV >= -0.02) labs.push({ k: 'sat', h: gH, dh: ((bH - gH + 540) % 360) - 180, s, bh: bH });
      else if (bS < 0.25 && gS - bS >= 0.15 && bV - gV >= 0.03) labs.push({ k: 'white', s });
    }
    if (dbg) { dbg.frame && dbg.frame(fr.t, { q, p, L: Math.round(L), nS, mis: dbg.mis || 0, labs: labs.map(l => l.k + (l.h != null ? Math.round(l.h) : '')).join(' '), raw: labs, Ls: L - EXCL, sec: dbg.sec }); dbg.mis = 0; dbg.sec = dbg.wantSec ? [] : null; }
    if (nS < 6) continue;
    // コマのラベル: 断面の 40% 以上が同じ種類
    const byK = {}; for (const l of labs) (byK[l.k] = byK[l.k] || []).push(l);
    const top = Object.entries(byK).sort((a, b) => b[1].length - a[1].length)[0];
    if (!top || top[1].length < 0.4 * nS) { out.push({ t: fr.t, k: null }); continue; }
    const k = top[0], H = k === 'white' ? null : circMed(top[1].map(l => l.h));
    const gHs = top[1].filter(l => l.g != null).map(l => l.g);
    // 先端側 1/3（球に近い側）の色相。筋は尾へ行くほど薄れてコートの色に引かれる（クレイ 全体走 0908 p12 304.30 の相手の黄ロブ: 尾 22〜27 → 先端 47〜53・
    //   全体の中央値は 35 前後で topspin 30 票になっていた）。trail.js classify もトップスピン/ロブを先端の色相で分ける（仕様: 先端 topspin 28〜42 / lob 54〜55）
    const tipL = k === 'hue' ? top[1].filter(l => l.s >= (L - EXCL) * 2 / 3) : [];
    const Htip = tipL.length >= 3 ? Math.round(circMed(tipL.map(l => l.h))) : null;
    out.push({ t: fr.t, k, H: H == null ? null : Math.round(H), Htip, G: gHs.length ? Math.round(circMed(gHs)) : null, dh: k === 'sat' ? Math.round(med(top[1].map(l => l.dh))) : null, frac: +(top[1].length / nS).toFixed(2) });
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
    else { const warm = H => H >= 345 || H < 75; c = hueCls(warm(r.H) && r.Htip != null && warm(r.Htip) ? r.Htip : r.H, r.G); }   // 暖色（トップスピン/ロブ）は先端の色相で決める
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
// 2026-09-24 color レーン: 自分がネット際（打点の地面位置 Z 1.8〜2.3）で打つと、+0.03 秒の始点はもう宙にあり地面換算で奥へずれて Z 3.8〜4.2 になる
//   （全体走 0908 p12 281.37・p19 478.93 の自分の黄ロブ: 打点 Z 1.77→始点 4.2・2.33→3.8）。Z の上限を「打点の Z＋3」まで緩める。
//   打点の位置 h.from は別物に乗っていることがある（上の 187.58）ので、緩めるのは h.from が自分側のコート内（|X| ≤ 10・Z ≤ 3）のときだけ
function pathOk(h, win, toCourt) {
  const a = win[0], b = win[win.length - 1], dy = b.y - a.y;
  if (h.side === 'me' ? dy > -40 : dy < 40) return false;
  if (toCourt) {
    const c = toCourt(a.t, a.x, a.y);
    const f = h.from, zMax = h.side === 'me' && f && Math.abs(f.X) <= 10 && f.Z <= 3 ? Math.max(3, f.Z + 3) : 3;
    if (c && (h.side === 'me' ? c.Z > zMax : c.Z < -3)) return false; if (c && Math.abs(c.X) > 10) return false;
  }
  return true;
}

// 入れなかった（2026-09-24 color レーンの departure()・第 3 ラウンドの反証役が止めた）: 打点の前後で「入射（打った側へ 6px/コマ以上）→ 40px 以上離れる」折り返しと
//   ラケット上の静止（最初の点から 6px 以内に 4 点）を探し、その終わりを読む区間の始点にする案（全体走 0908 p7 172.40 の launch・0908 p0 57.625 の far-pair は入射中に立つ）。
//   反証役のアブレーションで、折り返し・静止の検出を外して線分の尾を h.t で切るだけの版がベンチ・全体走とも出力完全一致（手置きの閾値 5 個が結果に効いていない）。
//   効いているのは尾の切り詰め（tFrom = h.t）の方で、外すと全体走 0908b 368.23m topspin・151815 288.25o drop が読めなくなる（exp-color-verify/abl）

async function classifyHit(video, h, tNext, paths, toCourt = null, camOk = null) {
  const t0 = h.t + 0.03, t1 = Math.min(h.t + 0.6, tNext - 0.05);
  if (t1 - t0 < 0.1) return { cls: null, why: 'short' };
  let best = null;
  for (const P of paths) {
    const inWin = P.pts.filter(p => p.t >= t0 && p.t <= t1);
    if (inWin.length < 4) continue;
    if (!pathOk(h, inWin, toCourt)) continue;
    const rows = await readPath(video, P.pts, t0, t1, camOk, null, h.t);   // 線分の尾は打点の時刻より前へ伸ばさない（tFrom）
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
// 弾道の規則（rally-fuse の頂点規則 apex／トレイル先端の apexTrail／奥側の上がり farRise）が色（clsColor）を lob に書き換えた打点。
//   色の側が lob でない（topspin/unknown/drop）ときだけ。2026-09-24 color レーン: 全体走で頂点規則の lob のうち shotcolor が色相の帯で非ロブと読む 13 件を目視すると
//   12 件は本当に非ロブ（橙/赤のトップスピン 9・青のスライス 1・紫のフラット 1 など。多くは「入射がロブで高く上がった直後に相手が打つ球」を相手のロブと見ていた・
//   img: samples/rally/exp-color/img/ap-*.png）。GT でも x0911 144.8/172.25 の相手・x0908b 188.55 の自分は topspin。誤りの 1 件はクレイの相手の黄ロブ 304.30（topspin 4 票）。
//   → 色相の帯（低信頼の sat/white は除く）が 6 コマ（60fps で 0.1 秒）以上そろって非ロブを示すときだけ色を採る（弾道の規則を覆すので decide の 4 コマより厳しく）
//   票数（これと decide の 4）は 60fps のコマ数。grab は fps=60 で取り出すので 30fps の動画では同じ絵が 2 回ずつ数えられ実質半分になる → apply は 60fps 以外を読まない（下の門）
function isApexLob(h) { return h.cls === 'lob' && h.clsColor != null && h.clsColor !== 'lob'; }
const APEX_OVERRIDE_VOTES = 6;

// 動画の解像度とコマ数（ffmpeg -i の Video 行）→ { w, h, fps }（fps は "NN fps"、無ければ "NN tbr"。読めなければ fps: null）。動画ごとに 1 回だけ調べる
//   2026-09-24 exp-int3f: fps も読む（レビュー should-fix 3）。rally-node も使う（export）
const sizeCache = new Map();
function videoSize(video) {
  if (sizeCache.has(video)) return sizeCache.get(video);
  const p = new Promise(resolve => {
    const ff = spawn(findFfmpeg(), ['-hide_banner', '-i', video]);
    let err = ''; ff.stderr.on('data', d => { err += d; });
    ff.on('error', () => resolve(null));
    ff.on('close', () => {
      const m = /Video:.*?\b(\d{3,5})x(\d{3,5})\b/.exec(err);
      const f = /Video:.*?\b(\d+(?:\.\d+)?) fps\b/.exec(err) || /Video:.*?\b(\d+(?:\.\d+)?) tbr\b/.exec(err);
      resolve(m ? { w: +m[1], h: +m[2], fps: f ? +f[1] : null } : null);
    });
  });
  sizeCache.set(video, p);
  return p;
}
// FHD 60fps でなければ理由（'1280x720'・'1920x1080@30fps'・'1280x720@30fps'・'size?'）、FHD 60fps なら null。
//   59.5fps 未満を 60fps でないとみなす（59.94 は 60 扱い・120 は fps=60 で間引くだけなので通す）。fps が読めないときは解像度だけで決める（従来どおり）
//   rally-node が fps フィルタを掛けるのは |fps−60| > 0.5 のときなので、50fps のように「揃え直した（同じ絵が混じる）のに読む」隙間は無い（exp-int3f-review S1）。
//   fps は平均（"NN fps"）を採るので、コマ落ちの多い VFR（例 "40.02 fps, 60 tbr"）も 60fps でないとして読まない（同じ絵が混じるのは同じ・安全側）
function notFhd60(sz) {
  if (!sz) return 'size?';
  const lowFps = sz.fps != null && sz.fps < 59.5;
  if (sz.w === 1920 && sz.h === 1080 && !lowFps) return null;
  return `${sz.w}x${sz.h}` + (lowFps ? `@${sz.fps}fps` : '');
}
const warned = new Set();

// FHD 以外は読まない（2026-09-24 color レーン・ユーザー方針「ラリー解析は FHD 前提」）。grab の crop・HW/OFF/EXCL・追跡点の ×2 は 1920×1080 の座標で、
//   720p（samples の user-0906-1159・user-0921-auntstarr-en/en2 は 1280×720）では帯が球から外れた所を読む。読まずに対象の打点へ clsNote を残す
// 60fps 以外も読まない（2026-09-24 exp-int3f・レビュー should-fix 3）: 票数（APEX_OVERRIDE_VOTES 6・decide の 4）は 60fps のコマ数で、30fps だと同じ絵を 2 回数える。
//   印を残す打点は読む対象と同じにした（unknown の追跡由来＋頂点規則の lob＝isApexLob。頂点規則の lob は色で確かめられないまま lob になる）
async function apply({ video, rally, segPts = [], farBall = null, t1 = Infinity, only = null, toCourt = null, camOk = null }) {
  const started = Date.now();
  const sz = await videoSize(video);
  const why = notFhd60(sz);
  if (why) {
    if (!warned.has(video)) { warned.add(video); console.warn(`[shotcolor] FHD 60fps 以外（${why}）なので種別を読まない: ${path.basename(video)}`); }
    let n = 0;
    for (const h of rally) if (only ? only(h) : ((h.cls === 'unknown' && h.src !== 'trail') || isApexLob(h))) { if (!only) h.clsNote = 'shotcolor-skip:' + why; n++; }
    return { changed: 0, log: [], ms: Date.now() - started, skipped: why, n };
  }
  const paths = [];
  for (const s of segPts) paths.push({ src: '960', pts: s.pts.map(p => ({ t: p.t, x: p.x * 2, y: p.y * 2 })) });
  if (farBall && farBall.tracks) for (const tr of farBall.tracks) paths.push({ src: 'far', pts: tr.pts.map(q => ({ t: q[0], x: q[1], y: q[2] })) });
  const log = []; let changed = 0;
  for (let i = 0; i < rally.length; i++) {
    const h = rally[i];
    const apexLob = isApexLob(h);
    if (only ? !only(h) : !((h.cls === 'unknown' && h.src !== 'trail') || apexLob)) continue;
    const tNext = i + 1 < rally.length ? rally[i + 1].t : t1;
    const r = await classifyHit(video, h, tNext, paths, toCourt, camOk);
    log.push({ t: h.t, side: h.side, src: h.src, was: h.cls, got: r.cls, clsBy: r.clsBy, vote: r.vote, via: r.src, apexLob: apexLob || undefined });
    if (only) continue;
    if (apexLob) {
      if (r.cls && r.cls !== 'lob' && r.clsBy === 'pathcolor' && r.vote[r.cls] >= APEX_OVERRIDE_VOTES) { h.clsPath = r.cls; h.cls = r.cls; h.clsBy = 'pathcolor-over-apex'; changed++; }
    } else if (r.cls) { h.clsPath = r.cls; h.cls = r.cls; h.clsBy = r.clsBy; changed++; }
  }
  return { changed, log, ms: Date.now() - started };
}

module.exports = { apply, classifyHit, readPath, decide, hueCls, pathOk, makeCamOk, videoSize, notFhd60, isApexLob };
