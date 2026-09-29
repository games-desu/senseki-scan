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
// 時刻 a → b の間隔を ms の整数で（2026-09-24 exp-int3f・レビュー should-fix 2）。イベントの時刻はコマの格子（1/60 秒）に乗るので、閾値がコマ周期の倍数だと浮動小数の誤差で境界の出入りが変わる
const dms = (a, b) => Math.round((b - a) * 1000);

function findFfmpeg() {
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, 'ffmpeg.exe'); if (fs.existsSync(p)) return p; }
  return 'ffmpeg';
}
// 画素は rgb24（3 バイト）で受け取る。rgba より パイプを通る量が 3/4 になり、ffmpeg→Node の読み出しだけの時間が 砂 0911 p5 で 2.4→1.9〜2.2 秒。
// r,g,b の値は rgba で受けたときと同じ（2026-09-24 実測: 4 本の録画の 1 秒ずつ・計 2.6 億画素を rgba と rgb24 で読み比べて不一致 0）
const BPP = 3;
function spawnFfmpeg(video, t0, t1, fps, band) {
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-t', String(Math.max(1 / fps, t1 - t0)), '-i', video,
    '-vf', `fps=${fps},crop=${FW}:${band.h}:0:${band.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  ff.stderr.on('data', d => process.stderr.write(d));
  return ff;
}
async function* frames(video, t0, t1, fps, band) {
  const BYTES = FW * band.h * BPP;
  const ff = spawnFfmpeg(video, t0, t1, fps, band);
  // 1 コマ分の固定バッファにパイプの断片（Windows では 64KB）を書き写す。以前は断片ごとに Buffer.concat で「溜まった分＋断片」を作り直していて、
  // 1 コマ 1920×674×4=5.2MB（当時は rgba）に 80 断片 → 1 コマあたり約 200MB のコピーになり、砂 0911 p5（588 コマ）で 34.6 秒中 27 秒がこれだった（2026-09-24 speed レーン実測）。
  // raw は次のコマで上書きされるが、呼び手（track）は yield の間に candidates を終え、raw を持ち越さない（持ち越すのは mask だけ）
  const frame = Buffer.allocUnsafe(BYTES);
  let fill = 0, i = 0;
  for await (const c of ff.stdout) {
    let off = 0;
    while (off < c.length) {
      const k = Math.min(BYTES - fill, c.length - off);
      c.copy(frame, fill, off, off + k); fill += k; off += k;
      if (fill === BYTES) { yield { i, t: +(t0 + i / fps).toFixed(4), raw: frame }; i++; fill = 0; }
    }
  }
}

// ---- 帯: 奥ベースライン（960 空間の y）の −150〜+120px をフル解像度に直したもの。カメラのドリー分は全カメラの min/max で吸収 ----
function bandFor(cams, Court) {
  const ys = cams.map(c => Court.toScreen(0, Court.Z_BASE, c).y).filter(y => isFinite(y));
  if (!ys.length) return null;
  // y と高さは偶数にそろえる（2026-09-24・3 レーンが独立に発見）: 入力は yuv420p で、ffmpeg の crop は奇数の高さを偶数に切り下げて出す
  // （crop=1920:539 を頼むと 538 行が来る）。読み手は 1 コマ＝1920×h 画素で区切るので、奇数のままだと 1 コマごとに 1 行ずつ先を読み、
  // 画が縦に流れて「前後 2 コマの継ぎはぎ」を球の候補にしていた（砂 0911 p7 の帯 h 539: 189.2 のロブの球 (793,134) が開始時刻しだいで y 5〜394 に化ける／
  // 0908 p16 の h 459 も同じ）
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - 300)) & ~1, y1 = Math.min(FH, Math.ceil(Math.max(...ys) + 240));
  const h = (y1 - y0) & ~1;
  if (h < 100) return null;
  return { y: y0, h };
}

// 連結成分（8 近傍）。訪問済みは mask を 2 にして印を付ける（mask は 0/1/2 のまま呼び手に返り、prevMask としては真偽だけを見る）。
// 以前は毎コマ seen（W×H バイト）と stack（W×H×4 バイト）を確保していた＝帯 1920×674 で 1 コマ 6.5MB（speed レーン）。
// 種は seeds（マスクを作る段で集めた 1 の画素の添字・昇順）から拾うので、全画素の走査もしない。成分の順序は以前と同じ。
// 画素の添字の配列（pts）は作らず、塗りながら candidates が使う集計（個数・座標和・外接矩形・前コマとの重なり・r/g の和）を取る。
// どれも整数の和か最小/最大なので、足す順番が変わっても値は同じ
let STACK = new Int32Array(0);
function components(mask, W, H, minN, seeds, nSeeds, raw, prevMask) {
  if (STACK.length < W * H) STACK = new Int32Array(W * H);
  const stack = STACK, out = [];
  for (let s = 0; s < nSeeds; s++) {
    const idx = seeds[s];
    if (mask[idx] !== 1) continue;
    let sp = 0; stack[sp++] = idx; mask[idx] = 2;
    let n = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, ov = 0, sr = 0, sg = 0;
    while (sp) {
      const j = stack[--sp]; const jx = j % W, jy = (j / W) | 0;
      n++; sx += jx; sy += jy; if (jx < x0) x0 = jx; if (jx > x1) x1 = jx; if (jy < y0) y0 = jy; if (jy > y1) y1 = jy;
      if (prevMask && prevMask[j]) ov++; sr += raw[j * BPP]; sg += raw[j * BPP + 1];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const nx = jx + dx, ny = jy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const k = ny * W + nx;
        if (mask[k] === 1) { mask[k] = 2; stack[sp++] = k; }
      }
    }
    if (n >= minN) out.push({ n, sx, sy, x0, x1, y0, y1, ov, sr, sg });
  }
  return out;
}

// isBall を (g, r) と (g, b) の表引きにする。述語は r/g と b/g の条件の積なので分けて表にでき、表は isBall そのものの値で埋めるので結果は同じ
// （掛け算に直すと r/g > 0.84 と r > 0.84*g が丸めで食い違う組が出うるので、除算のまま表にした）
const RG_OK = new Uint8Array(256 * 256), BG_OK = new Uint8Array(256 * 256);
for (let g = 160; g < 256; g++) for (let v = 0; v < 256; v++) {
  const q = v / g;
  RG_OK[g * 256 + v] = q > 0.84 && q < 1.02 ? 1 : 0;
  BG_OK[g * 256 + v] = q > 0.28 && q < 0.68 ? 1 : 0;
}
// HUD を画素ごとに判定せず、行ごとの「見る x 区間」にする（HUD の矩形を 1 行ずつ引き算）
const SPANS = [];
function rowSpans(yF) {
  if (SPANS[yF]) return SPANS[yF];
  let spans = [[0, FW]];
  for (const r of HUD) {
    if (yF < r.y || yF >= r.y + r.h) continue;
    const nx = [];
    for (const [a, b] of spans) { if (r.x > a) nx.push([a, Math.min(b, r.x)]); if (r.x + r.w < b) nx.push([Math.max(a, r.x + r.w), b]); }
    spans = nx.filter(([a, b]) => b > a);
  }
  return (SPANS[yF] = spans);
}
let SEEDS = new Int32Array(0);

// ---- ①: 1 コマの球候補（フル解像度座標） ----
function candidates(raw, band, prevMask) {
  const W = FW, H = band.h, mask = new Uint8Array(W * H);
  if (SEEDS.length < W * H) SEEDS = new Int32Array(W * H);
  const seeds = SEEDS; let nSeeds = 0;
  for (let y = 0; y < H; y++) {
    for (const [xa, xb] of rowSpans(y + band.y)) {
      for (let x = xa, j = y * W + xa, i = j * BPP; x < xb; x++, j++, i += BPP) {
        const g = raw[i + 1];
        if (g < 160) continue;
        const gi = g << 8;
        if (RG_OK[gi | raw[i]] && BG_OK[gi | raw[i + 2]]) { mask[j] = 1; seeds[nSeeds++] = j; }
      }
    }
  }
  const out = [], weak = [];
  for (const { n, sx, sy, x0, x1, y0, y1, ov, sr, sg } of components(mask, W, H, 20, seeds, nSeeds, raw, prevMask)) {
    const cx = sx / n, cy = sy / n, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const dF = expectDiam(cy + band.y), A = 0.785 * dF * dF;
    const c = { x: cx, y: cy + band.y, n, bw, bh, ov: ov / n, rg: +(sr / sg).toFixed(3) };
    // 弱い候補（2026-09-24 oppsand）: スライスの淡い青の尾が球に重なり、述語に通る画素が減った球。砂 0911 p7 185.87〜186.2 の相手のスライスは毎コマ見えるが
    // n 27〜71（期待面積 A 140〜170 の 0.2〜0.4 倍）・充填 0.25〜0.42・r/g 0.87〜0.90 で下の篩に全部落ちる。
    // 弱い候補は別の連結（weakTracks）にだけ使い、滑らかに手前へ進む長い軌道の出だしだけを打点にする（下の smoothWeak・events の far-weak）
    const weakOk = c.rg >= 0.86 && n >= 0.15 * A && n <= 4.0 * A && n / (bw * bh) >= 0.25 && Math.max(bw, bh) <= 3.0 * dF && Math.max(bw, bh) <= 2.5 * Math.min(bw, bh);
    // 球の核は r/g 0.94 前後（砂 0.94〜0.99・クレイ 0.95〜0.98・芝のロブ 0.91〜0.93）。芝の明るい縞とライン縁は 0.84〜0.87 で述語の下端に張り付く
    // 上限は「空中の球」の分だけ緩める（2026-09-24 near）: expectDiam は画面 y を地面の位置として径を出すが、空中の球は地面の位置より画面上に見えるので実際はそれより大きい。
    // 砂 0911 p5 159.2〜159.48（ネット際の自分のロブの打ち上げ直後・フル解像度）: 球は n 614〜964・A の 4.0〜5.0 倍で上限 4A に落ち、
    // 軌道が 159.233 → 159.283（124px 跳び）で切れていた。打ち上げ直後の球は地面より最大 300px（フル解像度）上に見える（打点 y 590 → 0.25 秒後 y 275）ので、
    // 上限の径は y+300 の地面の径で取る（y 275 で 1.74 倍・y 463 で 1.6 倍）。下限（0.35A）は地面の径のまま（球が小さく見えることはない）。
    // 弱い候補の上限（weakOk の 4.0A・3.0dF）は緩めない（弱い層は淡いスライスの出だし用で、空中の大きい球は強い層で取れる）
    const dU = expectDiam(cy + band.y + 300), AU = 0.785 * dU * dU;
    let strong = sr / sg >= 0.90;
    if (n < 0.35 * A || n > 4.0 * AU) strong = false;         // 上限 4A: フル解像度では球に光沢と影が付いて 3A を超える（砂 157.2: n 287 / A 170）
    if (n / (bw * bh) < 0.45) strong = false;                   // 球は丸い。芝のライン縁（18x10 f0.4）を落とす
    if (Math.max(bw, bh) > 3.0 * dU || Math.max(bw, bh) > 2.0 * Math.min(bw, bh)) strong = false;
    // 空中の球の印（2026-09-24 farjunk）: 上限を y+300 の地面の径まで緩めたから強い候補になったもの（地面の径の上限 4A・3.0dF なら落ちていた）。
    // 地面の径の 4 倍を超えて写る球は、その画面位置の地面より高い所（カメラに近い所）に居る＝相手のラケットの高さには居ない。
    // 軌道の連結・折り返し（turn/stall）・手前の打ち出しにはそのまま使い、軌道のペアの相手（先行軌道の末尾）からだけ外す（events の isAir・出現の起点には使わない）
    if (strong && (n > 4.0 * A || Math.max(bw, bh) > 3.0 * dF)) c.air = true;
    if (strong) out.push(c); else if (weakOk) { c.weak = true; weak.push(c); }
  }
  out.mask = mask; out.weak = weak;
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
      if (best) { used.add(best); tr.pts.push({ t: f.t, x: best.x, y: best.y, u: best.u, v: best.v, n: best.n, weak: !!best.weak, air: !!best.air }); }
    }
    // 開いている軌道のうち欠測が長いものは閉じる
    for (let i = open.length - 1; i >= 0; i--) { const last = open[i].pts[open[i].pts.length - 1]; if (Math.round((f.t - last.t) * fps) > MAXGAP) { done.push(open[i]); open.splice(i, 1); } }
    // 残りの候補は新しい軌道（静止物は前コマとの重なりで捨てる）
    for (const c of f.cands) { if (used.has(c) || c.ov >= 0.85) continue; open.push({ pts: [{ t: f.t, x: c.x, y: c.y, u: c.u, v: c.v, n: c.n, weak: !!c.weak, air: !!c.air }] }); }
  }
  done.push(...open);
  return done.filter(tr => tr.pts.length >= 4).map(tr => { tr.t0 = tr.pts[0].t; tr.t1 = tr.pts[tr.pts.length - 1].t; return tr; }).sort((a, b) => a.t0 - b.t0);
}

// ---- ②': 弱い候補を含む軌道から、滑らかに一方向へ進む区間だけを切り出す（2026-09-24 oppsand） ----
// 砂の粒・テントの縁の弱い候補は最近傍連結で球の軌道にも紛れ込む（砂 p7: 185.77 (1074,172) の junk から 185.80 の球へ 86px 跳び、
// 186.02〜186.05 は球が 2 コマ見えない間に junk (997,180) へ乗り移ってから球へ戻る）。球の歩みは 1 コマごとの向きがほぼ揃い
// （185.80〜186.00 と 186.07〜186.37: 隣り合う歩みの向きの差 20° 未満・4〜10px/コマ）、速さも急には変わらないので、
// 「前の歩みと 40° 以上違う・速さが 2 倍以上変わる・1.5px/コマ未満か 35px/コマ超」の歩みで区間を切り、
// 8 点以上・半分以上が弱い候補（強い候補だけの軌道は通常の軌道で見る）・正味 60px 以上の区間だけ残す。
// 境界に敏感: ベンチで効く唯一の区間（砂 p7 185.82〜186.07・185.7 の相手のスライス）は正味 63px で、60px の閾値から 3px しか余裕が無い。
// また区間の切れ目は 1 コマの歩みで決まるので、保存済み軌道（座標は整数・時刻は 3 桁に丸め）から作り直す refar と、動画から取り直す refarball とで
// 区間・イベントが変わりうる（検証役の実測: 丸めで出だしの速さが閾値をまたいだ）。閾値を動かすときは両方で確かめること
function smoothWeak(trs) {
  const out = [];
  for (const tr of trs) {
    const p = tr.pts; let seg = [p[0]], prevV = null;
    const flush = () => {
      if (seg.length >= 8 && seg.filter(q => q.weak).length * 2 >= seg.length && Math.hypot(seg[seg.length - 1].u - seg[0].u, seg[seg.length - 1].v - seg[0].v) >= 60)
        out.push({ pts: seg, t0: seg[0].t, t1: seg[seg.length - 1].t });
    };
    for (let j = 1; j < p.length; j++) {
      const dk = Math.max(1, Math.round((p[j].t - p[j - 1].t) * 60)), v = { vx: (p[j].u - p[j - 1].u) / dk, vy: (p[j].v - p[j - 1].v) / dk }, s = speed(v);
      const bad = s < 1.5 || s > 35 || (prevV && (angle(prevV, v) >= 40 || s > 2 * speed(prevV) || s < speed(prevV) / 2));
      if (bad) { flush(); seg = [p[j]]; prevV = null; continue; }
      seg.push(p[j]); prevV = v;
    }
    flush();
  }
  return out;
}

// ---- ③: 折り返し・出現 ----
function velAt(pts, i, dir) {          // dir=-1: i の手前 3 点の平均速度（px/コマ）, +1: 後ろ 3 点
  const a = dir < 0 ? pts[Math.max(0, i - 3)] : pts[i], b = dir < 0 ? pts[i] : pts[Math.min(pts.length - 1, i + 3)];
  const dk = Math.max(1, Math.round((b.t - a.t) * 60));
  return { vx: (b.u - a.u) / dk, vy: (b.v - a.v) / dk };
}
const speed = v => Math.hypot(v.vx, v.vy);
const angle = (a, b) => { const d = speed(a) * speed(b); if (d < 1e-6) return 0; return Math.acos(Math.max(-1, Math.min(1, (a.vx * b.vx + a.vy * b.vy) / d))) * 180 / Math.PI; };

function events(tracks, band, Court, camAt, markers = [], weakTracks = []) {
  const out = [];
  // 打った後の球が手前のコートへ入ってくるか（2026-09-24 oppsand）: 打点から 0.35 秒以内に、カメラ補正の縦位置 v が 60px 以上増え、かつ Z 16 以下の点がある。
  // 砂 0911 のパックンはベースラインの後ろで高い打点で打つので、打点そのものは高さバイアスで Z 23〜26 に出る
  // （p1 サーブ 48.65: Z 24.2 → 0.27 秒後 Z 16.0・v +93 ／ p1 51.80: Z 23.1 → 0.32 秒後 Z 13.5・v +186 ／ p5 サーブ 155.36: Z 25.5）。
  // 観客席の候補（Z 23〜30）は静止物か横に流れるだけで、手前のコートへは入ってこない（p1 48.55〜49.70 の X −9・Z 28〜30 の軌道は v がほぼ一定）。
  // 逆に自分のロブが上端で頂点を越える所（p1 51.55: Z 25・0.25 秒で v +23）は手前へ来ないので通らない
  const goesNear = (pts, i) => {
    if (!pts) return false;
    const q0 = pts[i];
    for (let j = i + 1; j < pts.length && pts[j].t <= q0.t + 0.35; j++) {
      if (pts[j].v - q0.v < 60) continue;
      const cam = camAt ? camAt(pts[j].t) : null; if (!cam || !cam.ok) continue;
      const c = Court.toCourt(pts[j].x, pts[j].y, cam);
      if (isFinite(c.Z) && c.Z <= 16) return true;
    }
    return false;
  };
  const push = (t, x, y, qc, how, ctx = null) => {
    const cam = camAt ? camAt(t) : null;
    if (process.env.FARDBG) console.error('push', t.toFixed(3), Math.round(x), Math.round(y), how, cam ? (cam.ok + ' ' + cam.t) : 'nocam');
    if (!cam || !cam.ok || (cam.t != null && Math.abs(cam.t - t) > 0.5)) return;   // ラリーカメラが立っている時刻だけ（サーブ画・カット直後の候補は別の画の物）
    // 着弾の星マーカー（tools/star.js）の 0.25 秒・80px 以内の折り返しはバウンド（奥へ打った球が落ちて跳ね返る＝画面では下→上の折り返しになる）
    if (markers.some(m => Math.abs(m.t0 - t) <= 0.25 && Math.hypot(m.x - x / SC, m.y - y / SC) <= 80)) return;
    const c = Court.toCourt(x, y, cam);
    if (!isFinite(c.Z) || c.Z < 4 || Math.abs(c.X) > 9) return;
    // 相手の居場所だけ（Z 4〜22: 高さバイアスで実際より奥に出る。観客席は Z 23〜30）。Z 22〜30 は打球が手前のコートへ入ってくるときだけ（上の goesNear）
    if (c.Z > 22 && !(c.Z <= 30 && ctx && goesNear(ctx.pts, ctx.i))) return;
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
      // 入れなかった（2026-09-24 farjunk 案 C1・第 3 ラウンドの反証役が止めた）: 手前へ 1 コマ 20px 以上で速く降りてきた球が上へ折り返す（a.vy ≥ 20・b.vy < 0）turn を
      // 自分のネット際のボレー/スマッシュ（高さバイアスで見かけの Z が 4〜7）として捨てる案。0908b p3 156.683（34.7px/コマ）・砂 0911 p3 125.283（29.3）は消えるが、
      // 本物の相手の折り返し 砂 0911 p2 89.733 が 19.8 で閾値まで 0.2 しか余裕が無い（exp-farjunk/turnvel.js・exp-farjunk-verify）
      // やって戻した（2026-09-24 統合）: 0.1 秒先までで向きの変化が最大の点へ寄せる案（oppsand の turnRefine）。ベンチでの種別の改善は
      // 寄せ先が junk のイベントだった偶然で、打点の数には効かなかった
      push(p[i].t, p[i].x, p[i].y, b.vy > 0 ? 1.2 : 0.85, 'turn', { pts: p, i });
    }
    // 加速（far-accel・2026-09-24 oppsand）: 向きは同じまま、遅い球が急に速く手前へ出る＝サーブ（トスが落ちてくる所を打つ）。
    // 型を決めた実例は 1 例だけ（砂 0911 p5 155.4: トスの下降 1〜2px/コマ（155.30〜155.38）→ 5 コマ隠れて 155.47 から 8〜12px/コマで手前へ。向きの差は 8° で折り返しにならない）。
    // 型: 直前 2 歩が 3px/コマ未満（トスの下降）→ 1 コマ以上の欠測（ラケットと閃光で隠れる）→ 直後 3 歩がどれも 6px/コマ以上で手前向き。
    // 最初は「前 6 歩の正味の速さの 2.5 倍」で取ったが、手前へ飛ぶ球の遠近の加速や折り返し直後（正味の変位が小さい）にも立ち、
    // トレイル打点の直前に居座って時刻寄せを乱した（0908 p0 53.275・芝 0908 p5 140.20 はバウンド後の落下を加速と誤認）ので、歩みの型で決める
    const stepS = j => { const dk = Math.max(1, Math.round((p[j].t - p[j - 1].t) * 60)); return { s: Math.hypot(p[j].u - p[j - 1].u, p[j].v - p[j - 1].v) / dk, vy: (p[j].v - p[j - 1].v) / dk, dk }; };
    for (let i = 3; i < p.length - 3; i++) {
      if (stepS(i).dk < 2) continue;
      if (!(stepS(i - 1).s < 3 && stepS(i - 2).s < 3)) continue;
      if (![i + 1, i + 2, i + 3].every(j => { const q = stepS(j); return q.s >= 6 && q.vy > 0; })) continue;
      push((p[i - 1].t + p[i].t) / 2, (p[i - 1].x + p[i].x) / 2, (p[i - 1].y + p[i].y) / 2, 1.1, 'accel', { pts: p, i });
      i += 3;
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
        if (speed(a) >= 2.5 && speed(b) >= 2.5 && angle(a, b) >= (b.vy > 0 ? 45 : 60)) push(p[(i0 + i1) >> 1].t, p[(i0 + i1) >> 1].x, p[(i0 + i1) >> 1].y, b.vy > 0 ? 1.2 : 0.85, 'stall', { pts: p, i: i1 });
      }
      i = i1;
    }
    // 軌道のペア: 直前 0.35 秒以内・120px 以内で終わる軌道があり、その末尾の向きと この軌道の出だしの向きが 60° 以上違えば、間で折り返した（ラケットと閃光で球が隠れる）
    // 空中の球（candidates の air）で終わる先行軌道はペアの相手にしない（2026-09-24 farjunk）。ペアは「ラケットで球が隠れる間の折り返し」なので、
    // 先行軌道の末尾は相手の打点の高さの球のはず。末尾 0.25 秒に地面の径の 4 倍を超える球があれば、それは頭上を行き来する球（打ち上げたロブの頂点前後・降りてくるロブ）。
    // 実例: 砂 0911 p2 69.817（自分の打ち上げ 69.43〜69.70 が n/A 4.2〜5.8 で頂点の手前で切れ、降りてくる軌道とペア＝頂点を打点と読んだ）・98.083（末尾 97.70〜97.85 が 4.1〜4.8）／
    // 0908 p12 320.3（降りてくる大きい球 319.78〜320.20 が n/A 4.4〜7.4 で先行軌道になり、相手の打ち返しの出現 320.30 を消していた）。
    // 0.25 秒: 98.083 の末尾は空中の点 97.85 の後に小さい点が 2 つ（97.883・97.933）続いてから切れる
    const isAir = (pts, ta, tb) => pts.some(q => q.air && q.t >= ta - 1e-6 && q.t <= tb + 1e-6);
    const prevAll = tracks.filter(o => o !== tr && o.t1 <= tr.t0 && tr.t0 - o.t1 <= 0.35 && Math.hypot(o.pts[o.pts.length - 1].u - p[0].u, o.pts[o.pts.length - 1].v - p[0].v) <= 120);
    const prevTr = prevAll.filter(o => !isAir(o.pts, o.t1 - 0.25, o.t1));
    // 空中で終わる先行軌道を外しても、この軌道の出だしがその先行軌道の「続き」なら（末尾の速度で外挿した位置から 40px 以内）、同じ球が飛び続けているだけで
    // 出現（打点）ではない。外挿のずれの実測: 砂 0911 p3 130.233（頭上を越えていく自分のロブ・126.83〜130.13 の空中の軌道の続き）13px／
    // 0908 p12 271.45（降りてくるロブの続き）11px ／ 本物の打ち返しの 0908 p12 320.317（降りてくるロブ 320.20 (1087,231) の外挿 (1108,294) に対し (1107,186) から出る）108px
    const contAir = !prevTr.length && prevAll.some(o => {
      const q = o.pts[o.pts.length - 1], va = velAt(o.pts, o.pts.length - 1, -1), k = Math.max(1, Math.round((p[0].t - q.t) * 60));
      return Math.hypot(q.u + va.vx * k - p[0].u, q.v + va.vy * k - p[0].v) <= 40;
    });
    const v0 = velAt(p, 0, +1);
    let pairOk = false, prevSlow = false;
    if (prevTr.length) {
      const o = prevTr[prevTr.length - 1]; let va = velAt(o.pts, o.pts.length - 1, -1);
      // 先行軌道の末尾が停止していたら（ラケットに当たった瞬間）、停止の手前の速度を使う
      // 停止中の球はラケットの閃光と一体の blob になって育つので重心が 1 コマ 2〜3px 揺れる（芝 0908 p0 57.83〜57.88 (1210,272): n 530→790・
      // 補正座標の 1 歩 2.7/2.4/2.2px）。2px 未満で区切ると最後の 1 歩で止まり、停止そのものの速度（0.7px/コマ）で向きを比べて 58.0 の折り返しを落としていた。
      // 飛んでいる球は奥側でも 1 コマ 6px 以上（入射球 6〜30px/コマ）なので 4px 未満を停止とみなす（2026-09-24 opp0908）
      if (speed(va) < 2.5) { let j = o.pts.length - 1; while (j > 0 && Math.hypot(o.pts[j].u - o.pts[j - 1].u, o.pts[j].v - o.pts[j - 1].v) < 4 && o.t1 - o.pts[j - 1].t <= 0.15) j--; if (j >= 1) va = velAt(o.pts, j, -1); }
      if (process.env.FARDBG) console.error('pair?', tr.t0.toFixed(3), 'prev', o.t0.toFixed(3), 'va', va, 'v0', v0, 'ang', angle(va, v0).toFixed(1));
      // 時刻は出射の始まりの 1 コマ前（出現と同じ・2026-09-24 snap）。旧は入射の終わり q と出射の始まり p0 の中点で、ベンチの GT 7 本
      // （0908 p0 54.81/57.63・p8 227.53・p16 416.13/419.41/420.51・砂 0911 p5 156.99）で中点は GT より 0.09〜0.28 秒早く（中央 −0.12）、p0 は −0.13〜+0.07（中央 +0.02）。
      // 入射球は接触の前に相手の体・ラケット・閃光に隠れる区間が長く（隠れ 0.15〜0.32 秒）、打った球はすぐ見えるため（0908 p16 419.6: 419.60 白い輪・p0 419.55）
      const tOut = (q) => Math.max(q.t, p[0].t - 1 / 60);
      if (speed(va) >= 2.5 && speed(v0) >= 2.5 && angle(va, v0) >= (v0.vy > 0 ? 45 : 60)) { const q = o.pts[o.pts.length - 1]; push(tOut(q), (q.x + p[0].x) / 2, (q.y + p[0].y) / 2, v0.vy > 0 ? 1.1 : 0.85, 'pair', { pts: p, i: 0 }); pairOk = true; }
      // 奥側のロブ（far-lobpair・2026-09-24 opp0908）: 入射球も出射球も画面では「上」へ動くので向きが変わらない（入射＝奥へ遠ざかる／ロブ＝手前へ来るが高く上がる）。
      // 代わりに画面上の速さが急に落ちる。入射球が奥へ速く（8px/コマ以上・上向き 5 以上）動いて途切れ、0.35 秒以内・120px 以内に
      // 半分以下の速さで上へ動く軌道が始まれば、間で相手が打ち上げた（0908 砂 p16 416.1: 415.98 まで (−2.3,−13.1) s13.3 → 416.27 から (0.5,−5.6) s5.6・
      // 角度 15°。フル解像度の切り抜きでルイージのラケットの位置から球が頭上へ上がり、416.77〜417.35 に自分側へ降りてくる弧が続く）。
      // バウンドの判定: 奥のコートで跳ねた球も「速い入射→上へ遅く」になりうる。v36 で「バウンドは合わない（跳ねた球は上向きに速くなる）」と書いたが反例がある
      // （全体走 芝ランクマ 15-18-15 p10 228.58: 自分の打球が奥で跳ねた所で lobpair が立った。着弾の星 228.70 はイベント位置から 92px(960) で、
      //  下の push の「0.25 秒・80px 以内」の篩から漏れた）。上がる軌道（p）の最初の 0.3 秒の点かイベント位置から 150px(960) 以内・0.3 秒以内に星が出たら捨てる
      else if (va.vy <= -5 && speed(va) >= 8 && v0.vy < -1 && speed(v0) >= 2.5 && speed(va) >= 2 * speed(v0)) {
        const q = o.pts[o.pts.length - 1], tE = (q.t + p[0].t) / 2, xE = (q.x + p[0].x) / 2, yE = (q.y + p[0].y) / 2;
        const near = p.filter(r => r.t <= p[0].t + 0.3).map(r => [r.x / SC, r.y / SC]).concat([[xE / SC, yE / SC]]);
        const bounce = markers.some(m => Math.abs(m.t0 - tE) <= 0.3 && near.some(([x, y]) => Math.hypot(m.x - x, m.y - y) <= 150));
        if (process.env.FARDBG) console.error('lobpair?', tE.toFixed(3), 'bounce', bounce);
        if (!bounce) push(tOut(q), xE, yE, 0.85, 'lobpair', { pts: p, i: 0 });   // 時刻は出射の始まり（pair と同じ・0908 p16 416.25: 中点 416.125・p0 416.267）
      }
      // 先行軌道が遅い（静止した候補・落ちてくるトス）ときは折り返しの相手ではない。そのときは下の「出現」も見る（slowAppear・2026-09-24 oppsand）
      // （砂 0911 p1 50.667: 0.32 秒前に静止した候補 (873,376) があってペア不成立→出現も見ずに 0 本・p1 サーブ 48.65: 先行はトス）
      prevSlow = speed(va) < 2.5;
    }
    // 弱い層との軌道のペア（far-wpair・2026-09-25 farcontact）: 入射か出射の片方が淡い（スライスの青い尾が核に重なる）と、その側は弱い候補の層（weakTracks）でしか
    // 繋がらず、強い層どうしのペアが立たない。ここでは入射＝弱い層・出射＝強い層（下の weakTracks のループが逆向き）。条件はペアと同じ（0.35 秒・120px・向き 45°/60°）。
    // 実例: 芝ランクマ 15-18-15 p9 217.62 の相手の飛びつきロブ（GT・x151815）: 入射の淡い青スライスは弱い層 217.183〜217.400 だけ（(1004,448)→(824,314)・約 14px/コマで上へ）、
    // 出射は強い層 217.617〜217.700（上へ・向きの差 約 96°）。先行軌道に弱い層を見ないのでペアも出現も立たず、fillOne の窓に相手側の候補が 0 本だった
    if (!pairOk) {
      const pw = weakTracks.filter(o => dms(o.t1, tr.t0) >= -17 && dms(o.t1, tr.t0) <= 350 && dms(o.t0, tr.t0) > 0 && Math.hypot(o.pts[o.pts.length - 1].u - p[0].u, o.pts[o.pts.length - 1].v - p[0].v) <= 120);
      const o = pw[pw.length - 1];
      if (o) {
        const va = velAt(o.pts, o.pts.length - 1, -1);
        if (process.env.FARDBG) console.error('wpair-in?', tr.t0.toFixed(3), 'prev', o.t0.toFixed(3), 'va', va, 'v0', v0, 'ang', angle(va, v0).toFixed(1));
        if (speed(va) >= 2.5 && speed(v0) >= 2.5 && angle(va, v0) >= (v0.vy > 0 ? 45 : 60)) { const q = o.pts[o.pts.length - 1]; push(Math.max(q.t, p[0].t - 1 / 60), (q.x + p[0].x) / 2, (q.y + p[0].y) / 2, v0.vy > 0 ? 1.1 : 0.85, 'wpair', { pts: p, i: 0 }); pairOk = true; }
      }
    }
    // 出現: 直前に軌道が無く、手前へ向かって動き出す（入射球はラケット・閃光・相手の体に隠れて見えないことが多い＝砂 0911 p5 157.1）
    // 奥へ向かう出現（自分の打球が途中から見える）は打点ではないので採らない。ロブは上へ上がるので折り返し／ペアに任せる
    // やって戻した（2026-09-24 farjunk）: 出現の起点が空中の大きさ（最初の 0.1 秒に地面の径の 4 倍超）なら採らない案。0908b p4 196.017（降りてくるロブ）は消えたが、
    // 打った直後の球が光と一体で大きく写る本物の出現を 3 本失った（芝 0908 p6 155.08・160.97（接触 155.05・160.97 前後）／ハード 0908b p3 147.82（接触 147.80））。大きさでは区別できない
    // 弱い層の飛行の途中（2026-09-25 farcontact・WEAKCONT）: 淡いスライスは弱い候補の層（weakTracks）でだけ 1 本の飛行として繋がり、途中で核が明るくなった数コマだけが
    // 強い層の短い軌道になる。その先頭は出現ではない（同じ球が 0.1 秒以上前から飛んでいる）。弱い層の軌道が 0.1 秒以上前から続き、この軌道の先頭と
    // 同じコマ（±1 コマ）・30px 以内に点を持つなら出現にしない。実例: 芝ランクマ 15-18-15 p10 225.92 の相手のスライス（GT・x151815）: 弱い層 226.033〜226.567（31 点）の
    // 途中 226.300〜226.417 に強い層の断片 → far-appear 226.283（+0.36）が立ち、far 寄せ（同段なら遅い方）が far-weak 226.017（+0.10）より優先していた。
    // 30px: 弱い層の点と強い層の点は同じ候補（弱い連結は強い候補も含む）なので同じコマなら距離 0。±1 コマのずれでも球の速さ（奥側 6〜30px/コマ）程度
    const weakCont = weakTracks.some(o => dms(o.t0, p[0].t) >= 100 && o.pts.some(q => Math.abs(dms(q.t, p[0].t)) <= 17 && Math.hypot(q.u - p[0].u, q.v - p[0].v) <= 30));
    if ((!prevTr.length || (!pairOk && prevSlow)) && !contAir && !weakCont && speed(v0) >= 2.5 && v0.vy >= 1 && tr.t1 - tr.t0 >= 0.1) push(Math.max(0, p[0].t - 1 / 60), p[0].x, p[0].y, 0.9, 'appear', { pts: p, i: 0 });
    // 止まった球からの出現（far-holdappear・2026-09-25 farcontact）: 軌道が「ラケット上に止まった球」から始まると、出だし 3 点の速さが 2.5px/コマに届かず上の出現にならない。
    // 先頭 0.15 秒までの静止（1 コマの歩み 4px 未満＝上の pair の「停止」と同じ: 飛んでいる球は奥側でも 6px/コマ以上）を飛ばし、動き出した点から手前へ速く出る（その後 0.15 秒の平均の縦の速さ 4px/コマ以上）なら、動き出しの 1 コマ前を出現とする。
    // 実例: 芝 0908 p5 140.15 のルイージのスライス（GT・x0908）: 軌道 140.050〜 が (1181,97)→140.083〜140.150 に (1183〜1185,92) で止まり、140.183 から手前へ 5〜10px/コマ。
    // 4px/コマ: 奥側のサーブのトスの落下は 1〜2px/コマ（砂 0911 p5 155.30〜155.38・far-accel のコメント）で、トスの頂点から始まる軌道を出現にしないため
    if ((!prevTr.length || (!pairOk && prevSlow)) && !contAir && !weakCont && speed(v0) < 2.5) {
      const stepAt = j => Math.hypot(p[j].u - p[j - 1].u, p[j].v - p[j - 1].v) / Math.max(1, Math.round((p[j].t - p[j - 1].t) * 60));
      let k = 1; while (k < p.length && stepAt(k) < 4 && dms(p[0].t, p[k].t) <= 150) k++;
      k--;   // 静止の最後の点
      if (k >= 1 && k + 3 < p.length) {
        const vk = velAt(p, k, +1), far = p.filter(q => q.t > p[k].t && dms(p[k].t, q.t) <= 150).pop();
        const vyAvg = far ? (far.v - p[k].v) / Math.max(1, Math.round((far.t - p[k].t) * 60)) : 0;
        if (process.env.FARDBG) console.error('holdappear?', p[0].t.toFixed(3), 'k', p[k].t.toFixed(3), JSON.stringify(vk), vyAvg.toFixed(2));
        if (speed(vk) >= 2.5 && vk.vy >= 1 && vyAvg >= 4) push(p[k].t, p[k].x, p[k].y, 0.9, 'holdappear', { pts: p, i: k });
      }
    }
    // ロブの出現（far-lobappear・2026-09-25 farcontact）: 相手が飛びつきでロブを打ち上げると、入射球は体と閃光に隠れて先行軌道が無く、打ち上げた球は画面を上へ動くので
    // 上の出現（手前向き vy ≥ 1 だけ）にならない。出だしが上向きで、その後の上がり方が相手のロブの型（rally-fuse の farRise と同じ: 0.3 秒以内に 15px 以上降りない・
    // 頂点まで 0.25 秒以上・30px 以上上がる・見かけの大きさが縮まない grow ≥ 0.85）なら打ち上げとして出す。自分の打球が奥へ遠ざかる途中の出現は球が縮む（grow < 0.85）。
    // 実例: 砂 0908 p17 429.45 のルイージの飛びつきロブ（GT・x0908）: 軌道 429.467〜 が (770,218) から 0.35 秒上がって頂点 (774,154)→降下。
    if ((!prevTr.length || (!pairOk && prevSlow)) && !contAir && !weakCont && speed(v0) >= 2.5 && v0.vy <= -1) {
      const r = riseAfter([tr], { t: p[0].t, x: p[0].x / SC, y: p[0].y / SC });
      if (process.env.FARDBG) console.error('lobappear?', p[0].t.toFixed(3), JSON.stringify(r));
      // 自分側の星（スマッシュの着弾予告）が 0.1〜0.7 秒後に出ることも課す。自分の打球が相手コートで跳ねて上がる所（バウンドの上がり）も同じ上がり方をするが、
      // 星は出ない（目視: ハード 0908b p3 131.77（跳ね 131.73・接触 132.2）・142.12（跳ね 142.10・接触 ≈142.53）・157.13（跳ね ≈157.1・接触 157.55）／
      // 砂 0908 p19 505.72（跳ね 505.50〜505.53）の 4 本すべて星なし・exp-r4-farcontact/img/la_*.png）。
      // 本物の打ち上げは星が出る: 砂 0908 p17 429.45 → 星 429.70（+0.25）／0908b p5 225.87（接触 225.82〜225.85・黄の球が上へ）→ 226.47（+0.60）／
      // 0908b p7 288.37（接触 288.37〜288.40）→ 288.70（+0.33）／docs の 0908 p16 416.25 → 416.47（+0.22）。窓の上端 0.7 は最も遅い 0.60 に 0.1 の余裕
      const starSoon = markers.some(m => { const d = dms(p[0].t, m.t0); if (d < 100 || d > 700) return false; const cam = camAt ? camAt(m.t0) : null; if (!cam || !cam.ok) return false; const c = Court.toCourt(m.x * SC, m.y * SC, cam); return isFinite(c.Z) && c.Z < 0; });
      // 上がったまま軌道が切れた（頂点が最後の点・D が軌道の長さで打ち切られる）ものを「0.1 秒以上・30px 以上上がり続けた」で通す変種（farcontact レーンの censored）は
      // 統合（2026-09-25 exp-int4）では採らない: 実例が砂 0908 p17 435.32 の 1 件で、D と grow の篩を外した分だけバウンドの上がりとの境が薄い
      if (r && !r.down && r.D >= 0.25 && r.R >= 30 && r.grow != null && r.grow >= 0.85 && starSoon) push(Math.max(0, p[0].t - 1 / 60), p[0].x, p[0].y, 0.85, 'lobappear', { pts: p, i: 0 });
    }
  }
  // 弱い層との軌道のペア（逆向き・far-wpair）: 入射＝強い層・出射＝弱い層（淡いスライスの返球）。強い層の先行軌道が 0.35 秒・120px 以内で終わり、向きが変わる。
  // 実例: 全体走 0908 p14 372.2（入射の強い層 371.767〜372.217 が上へ遠ざかり、同じ所から弱い層 372.233〜372.900 が手前へ降りる）
  for (const wt of weakTracks) {
    const p = wt.pts, v0 = velAt(p, 0, +1);
    const prev = tracks.filter(o => dms(o.t1, p[0].t) >= -17 && dms(o.t1, p[0].t) <= 350 && dms(o.t0, p[0].t) > 0 && Math.hypot(o.pts[o.pts.length - 1].u - p[0].u, o.pts[o.pts.length - 1].v - p[0].v) <= 120);
    const o = prev[prev.length - 1]; if (!o) continue;
    const va = velAt(o.pts, o.pts.length - 1, -1);
    if (process.env.FARDBG) console.error('wpair-out?', p[0].t.toFixed(3), 'prev', o.t0.toFixed(3), 'va', va, 'v0', v0, 'ang', angle(va, v0).toFixed(1));
    if (!(speed(va) >= 2.5 && speed(v0) >= 2.5 && angle(va, v0) >= (v0.vy > 0 ? 45 : 60))) continue;
    const q = o.pts[o.pts.length - 1], t = Math.max(q.t, p[0].t - 1 / 60);
    if (out.some(e => (e.src === 'far-pair' || e.src === 'far-wpair' || e.src === 'far-turn' || e.src === 'far-stall') && Math.abs(dms(e.t, t)) <= 100)) continue;
    push(t, (q.x + p[0].x) / 2, (q.y + p[0].y) / 2, v0.vy > 0 ? 1.1 : 0.85, 'wpair', { pts: p, i: 0 });
  }
  // 弱い軌道の出だし（far-weak・2026-09-24 oppsand）: 手前へ滑らかに進み出す淡いスライスの返球（砂 0911 p7 185.7）。通常の軌道が同じ時刻・場所を覆っていれば見ない。
  // qc 0.75（空白補完の鎖 qc ≥ 0.8 には入れず、同側補完でだけ使う）。smoothWeak の境界・丸めへの敏感さに注意（上のコメント）
  for (const tr of weakTracks) {
    // 向きは区間全体の平均で見る（滑らかさの篩を通った区間なので出だし 3 歩より安定。砂 p7 185.82 の出だしは遠くて 2.5px/コマ前後・保存時の丸めで閾値をまたいだ）
    const p = tr.pts, dkAll = Math.max(1, Math.round((p[p.length - 1].t - p[0].t) * 60)), vAll = { vx: (p[p.length - 1].u - p[0].u) / dkAll, vy: (p[p.length - 1].v - p[0].v) / dkAll };
    if (!(speed(vAll) >= 2 && vAll.vy >= 1)) continue;
    const net = p[p.length - 1].v - p[0].v; if (net < 40) continue;
    const cover = tracks.some(o => o.t0 <= p[0].t + 0.05 && o.t1 >= p[0].t - 0.05 && o.pts.some(q => Math.abs(q.t - p[0].t) <= 0.05 && Math.hypot(q.u - p[0].u, q.v - p[0].v) <= 40));
    if (cover) continue;
    // 滑らかさの篩で切れた同じ球の続き（直前 0.1 秒・50px 以内で終わる弱い区間がある）は出だしではない
    // （砂 p7: 185.82〜186.07 と 186.08〜186.50 は 1 本の返球。後ろの出だし 186.07 が同側補完で選ばれ dt +0.37 になっていた）
    if (weakTracks.some(o => o !== tr && o.t1 < p[0].t && p[0].t - o.t1 <= 0.1 && Math.hypot(o.pts[o.pts.length - 1].u - p[0].u, o.pts[o.pts.length - 1].v - p[0].v) <= 50)) continue;
    push(Math.max(0, p[0].t - 1 / 60), p[0].x, p[0].y, 0.75, 'weak', { pts: p, i: 0 });
  }
  // バウンドの折り返しを捨てる（2026-09-24 farjunk）: 自分の打球が相手コートで跳ねると、画面では「落ちてくる（下へ）→跳ね上がる（上へ）」の折り返しになり、
  // 上へ向かう折り返し（turn/stall の qc 0.85）として出る。相手が打つのはその後で、跳ね上がった球が相手のラケットで手前へ折り返す＝強いイベント（qc ≥ 1.0）が
  // 0.1〜0.5 秒後・近くに出る。弱い折り返しの後にそれがあれば、弱い方はバウンド（球は 1 回しか打たれない）。
  // 実例（目視・exp-farjunk/img）: 芝 0908 p1 76.317 → 76.467 far-pair 1.1（接触 76.50〜76.55・白い輪 76.55）/ ハード 0908b p0 71.883 → 72.233 far-turn 1.2（接触 72.25〜72.30）/
  // 0908b p3 149.233 → 149.533 far-pair 1.1（接触 149.55〜149.60）。弱い方がトレイルの時刻寄せ（0.12〜1.0 秒前）に選ばれ −0.2〜−0.4 秒ずれていた
  // （強い方はトレイルの 0.12 秒以内で窓の外）。距離は 960 空間で 18〜91px（71.883→72.233 が 91: 跳ねた球が相手の頭上まで上がってから打たれる）→ 120px まで
  // snap（窓の上端を h.t に・far-pair の時刻を出射の始まりへ）と組んだ後（2026-09-24 統合 3）: 強い方が窓に入る所は snap だけで強い方が選ばれる（0908 p1 76.517・0908b p0 72.233）。
  // 強い方がトレイルより後に出て窓の外のままの所では、弱い方だけが候補に残る（0908b p3: far-pair 149.617・トレイル 149.57）→ ここで捨てないと 149.233 へ −0.34 秒寄る（exp-int3 段 2）
  // 0.1〜0.5 秒は ms の整数で比べる（2026-09-24 exp-int3f・should-fix 2: 0.1/0.5 秒は far のコマ 6/30 個で、76 ポイントの --refar で 3 回ちょうど同点になっていた
  //   ＝d0911/s0911 p5 158.683→159.183 が 0.5・s0908 p19 521.35→521.45 が 0.1・exp-int3-review/eps/ties.js）。100 < d ≤ 500
  const bounce = e => (e.src === 'far-turn' || e.src === 'far-stall') && (e.qc || 0) < 1.0
    && out.some(o => { if (o === e || (o.qc || 0) < 1.0) return false; const d = dms(e.t, o.t); return d > 100 && d <= 500 && Math.hypot(o.x - e.x, o.y - e.y) <= 120; });
  for (let i = out.length - 1; i >= 0; i--) if (bounce(out[i])) { if (process.env.FARDBG) console.error('bounce', out[i].t); out.splice(i, 1); }
  for (const e of out) { const r = riseAfter(tracks, e); if (r) e.rise = r; }
  return out.sort((a, b) => a.t - b.t);
}

// ---- 打点の後に球が「上がり続ける」か（相手のロブの判定用・2026-09-24 opplob） ----
// 奥側から手前へ打つ球は、奥行きで画面を下へ動くので打点直後から v（カメラ補正後の画面 y）が増える。ロブだけは高さの伸びが勝って
// 打点の後もしばらく v が減り続ける（上がる）。打点の位置（イベントの座標から 60px 以内）で始まる軌道の点を起点に、
// 0.6 秒以内の v の最小（頂点）までの時間 D と上がった量 R、起点から 0.3 秒以内に 15px 以上降りた点があるか（down）、見かけの大きさの伸び grow を返す。
// 実測（v36 の保存軌道）: クレイ 0908 p8 227.53 の相手のロブ（SMASH 表示で確認）は D 0.45・R 83・down 無し。
// 使い方は rally-fuse の farRise 規則（相手側の打点で !down・D ≥ 0.25・R ≥ 30・grow ≥ 0.85 なら lob）
function riseAfter(tracks, e) {
  const ex = e.x * SC, ey = e.y * SC;
  let best = null;
  for (const tr of tracks) {
    const p = tr.pts;
    for (let s = 0; s < p.length; s++) {
      const q = p[s];
      if (q.t < e.t - 0.1) continue; if (q.t > e.t + 0.3) break;
      if (Math.hypot(q.x - ex, q.y - ey) > 60) continue;
      // 起点は「上がり始め」（軌道の先頭か、直前の点から上がってきていない点）。上がっている途中の点を起点にすると、
      // 打点の前の入射球（奥へ遠ざかる＝画面を上がる）の上がりを打点後の上がりとして数えてしまう
      if (s > 0 && p[s - 1].t >= q.t - 5 / 60 && p[s - 1].v > q.v + 3) continue;
      let mn = q, down = false;
      // 上がりは 1 コマで 25px(縦) を超えて跳ばない（砂 0911 p7 189.12〜189.38 のロブで最大 20・クレイ 227.63〜 で 10）。それを超える上向きの跳びは
      // 別物への乗り移りとして頂点の探索を打ち切る（芝 0908p5 133.52→133.57: −37→−135 の 33px/コマの跳びが「0.28 秒の上がり」を作っていた）。
      // 下向きの跳び（ロブの光の縁に 1〜2 コマ乗る: 砂 189.27）では打ち切らない。手前へ降りる球は速い（砂 158.8 のトップスピンで 30〜35px/コマ）ので
      // 降りの判定（down）は跳びで飛ばさず全点で見る
      let last = q, stop = false;
      for (let j = s + 1; j < p.length && p[j].t <= q.t + 0.6; j++) {
        if (p[j].t <= q.t + 0.3 && p[j].v >= q.v + 15) down = true;
        if (stop) continue;
        const k = Math.max(1, Math.round((p[j].t - last.t) * 60));
        if ((last.v - p[j].v) / k > 25) { stop = true; continue; }
        last = p[j];
        if (p[j].v < mn.v) mn = p[j];
      }
      // 見かけの大きさ（画素数 n）の伸び: 上がっている区間の後半（起点 +0.15 秒〜頂点）と起点直後 0.1 秒の中央値の比。
      // 相手のロブは手前へ近づくので球が大きくなり、遠ざかる自分の球（奥で跳ねて上がる・奥へ飛んでいく途中）は小さくなる。
      // 実測: クレイ 0908 p8 227.53 のロブ 1.6・砂 0911 p7 189.18 のロブ 1.1（光の縁で n が 35〜80 と揺れる）／
      // 誤って打点に寄せられた far イベント: ハード 0908b p3 149.23（自分のスライスが奥で跳ねて上がる）0.73・砂 0911 p2 83.60（自分のロブが奥へ飛ぶ途中の far-stall）0.68
      const med = a => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
      const nA = med(p.filter(o => o.t >= q.t && o.t <= q.t + 0.1 && o.n).map(o => o.n)), nB = med(p.filter(o => o.t >= q.t + 0.15 && o.t <= mn.t && o.n).map(o => o.n));
      const r = { D: +(mn.t - q.t).toFixed(3), R: Math.round(q.v - mn.v), down, s: +(q.t - e.t).toFixed(3), grow: nA && nB ? +(nB / nA).toFixed(2) : null };
      if (!best || (!r.down && best.down) || (r.down === best.down && r.D > best.D)) best = r;
    }
  }
  return best;
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

// ---- ffmpeg の読み出しと candidates を重ねる: candidates（1 コマ 3〜5ms）の間は Node のイベントループが止まり、パイプ（64KB）が詰まって
// ffmpeg も止まる＝「ffmpeg 待ち」と「candidates」が足し算になっていた（砂 0911 p5: 待ち 2.6 秒＋candidates 2.7 秒・speed レーン実測）。
// candidates を worker_threads の 1 本に移し、主スレッドはパイプを読んでコマを渡すだけにする。コマは順番どおり 1 本の worker で処理し
// prevMask も worker の中で持ち越すので、結果は同じスレッドで回したときと同じ（11 ポイントで events/tracks の完全一致を確認）。
// コマのバッファは NBUF 枚を行き来させる（転送で所有権ごと渡す＝コピー無し）。worker が遅れたら ffmpeg の読み出しを止める
const NBUF = 6;
function framesViaWorker(video, t0, t1, fps, band, onFrame) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const BYTES = FW * band.h * BPP;
    const w = new Worker(__filename, { workerData: { farballCandWorker: true, band } });
    let ff = null, failed = false;
    const fail = e => { if (failed) return; failed = true; try { ff && ff.kill(); } catch (_) {} w.terminate(); reject(e); };
    const free = []; for (let k = 0; k < NBUF; k++) free.push(new ArrayBuffer(BYTES));
    let cur = null, fill = 0, sent = 0, done = 0, ended = false, paused = false;
    const finish = () => { if (ended && done === sent && !failed) { w.terminate(); resolve(); } };
    w.on('error', fail);
    w.on('exit', code => { if (!(ended && done === sent)) fail(new Error('farball worker exit ' + code)); });
    w.on('message', m => {
      // 失敗（fail）の後に届いた結果は捨てる: 呼び手は同じスレッドでの読み直しに切り替えて frameCands を空にしているので、混ぜると二重になる
      if (failed) return;
      onFrame(+(t0 + m.i / fps).toFixed(4), m.cs, m.weak);
      free.push(m.buf); done++;
      if (paused) { paused = false; ff.stdout.resume(); }
      finish();
    });
    w.once('online', () => {
      ff = spawnFfmpeg(video, t0, t1, fps, band);
      ff.on('error', fail);
      ff.stdout.on('data', c => {
        if (failed) return;
        let off = 0;
        while (off < c.length) {
          if (!cur) {
            // 断片がコマの境目をまたいだ直後に空きが無ければ 1 枚足す（足した後は下で読み出しを止めるので増えても数枚）
            cur = Buffer.from(free.length ? free.pop() : new ArrayBuffer(BYTES)); fill = 0;
          }
          const k = Math.min(BYTES - fill, c.length - off);
          c.copy(cur, fill, off, off + k); fill += k; off += k;
          if (fill === BYTES) {
            const ab = cur.buffer; cur = null;
            w.postMessage({ i: sent++, buf: ab }, [ab]);
          }
        }
        if (!free.length && !paused) { paused = true; ff.stdout.pause(); }
      });
      ff.stdout.on('end', () => { ended = true; finish(); });
    });
  });
}
function candWorkerMain() {
  const { parentPort, workerData } = require('worker_threads');
  const band = workerData.band; let prevMask = null;
  parentPort.on('message', ({ i, buf }) => {
    const cs = candidates(Buffer.from(buf), band, prevMask);
    prevMask = cs.mask;
    parentPort.postMessage({ i, cs: cs.slice(), weak: cs.weak, buf }, [buf]);
  });
}

// FHD 60fps 以外は追わない（2026-09-24 exp-int3f-review N5）: rally-node の analyze は掛ける前に同じ門で止めるが、rally-exp の refarball と下の CLI は track を直接呼ぶので
// ここでも止める（720p は crop=1920 が ffmpeg に拒まれるだけ・2560×1440 は crop が通って縮尺違いの far が出る・30fps は同じ絵が 2 回ずつ来てコマごとの規則が崩れる）
const warnedGate = new Set();
async function track({ video, t0, t1, fps = 60, cams, Court, camAt = null, markers = [] }) {
  const ShotColor = require('./shotcolor.js');
  const why = ShotColor.notFhd60(await ShotColor.videoSize(video));
  if (why) {
    if (!warnedGate.has(video)) { warnedGate.add(video); console.warn(`[farball] FHD 60fps 以外（${why}）なので奥側のボール追跡を掛けない: ${path.basename(video)}`); }
    return { skipped: why, events: [], tracks: [], weakTracks: [], band: null };
  }
  const camList = cams.map(c => c.cam ? Object.assign({ t: c.t }, c.cam) : c);
  const band = bandFor(camList, Court);
  if (!band) return { events: [], tracks: [], band: null };
  const ref = refFn(camList, Court);
  const frameCands = [], weakCands = [];
  let prevMask = null;
  const ring = [], cnt = new Map(), ringW = [], cntW = new Map();
  const perFrame = (t, cs, weak = []) => {
    const r = ref(t), cells = new Set(), keep = [];
    for (const c of cs) { c.u = c.x - r.x; c.v = c.y - r.y; const key = ((c.u / CELL) | 0) * 100000 + ((c.v / CELL) | 0); cells.add(key); if ((cnt.get(key) || 0) < PTHR) keep.push(c); else c.static = true; }
    for (const k of cells) cnt.set(k, (cnt.get(k) || 0) + 1);
    ring.push(cells); if (ring.length > PN) { for (const k of ring.shift()) cnt.set(k, cnt.get(k) - 1); }
    frameCands.push({ t, cands: keep });
    // 弱い連結用: 強い候補＋弱い候補。静止物の篩は別に数える（砂の粒の明るい所は弱い候補に多い）
    const cellsW = new Set(), keepW = [];
    for (const c of cs.concat(weak || [])) { if (c.u == null) { c.u = c.x - r.x; c.v = c.y - r.y; } const key = ((c.u / CELL) | 0) * 100000 + ((c.v / CELL) | 0); cellsW.add(key); if ((cntW.get(key) || 0) < PTHR && !c.static) keepW.push(c); }
    for (const k of cellsW) cntW.set(k, (cntW.get(k) || 0) + 1);
    ringW.push(cellsW); if (ringW.length > PN) { for (const k of ringW.shift()) cntW.set(k, cntW.get(k) - 1); }
    weakCands.push({ t, cands: keepW });
  };
  let viaWorker = false;
  if (!process.env.FARBALL_NO_WORKER) {
    try { await framesViaWorker(video, t0, t1, fps, band, perFrame); viaWorker = true; }
    catch (e) { if (process.env.FARDBG) console.error('farball: worker 不可→同じスレッドで', e && e.message); frameCands.length = 0; ring.length = 0; cnt.clear(); weakCands.length = 0; ringW.length = 0; cntW.clear(); }
  }
  if (!viaWorker) for await (const fr of frames(video, t0, t1, fps, band)) {
    const cs = candidates(fr.raw, band, prevMask);
    prevMask = cs.mask;
    perFrame(fr.t, cs, cs.weak);
  }
  const tracks = link(frameCands, fps);
  const weakTracks = smoothWeak(link(weakCands, fps));
  const at = camAt || (t => { let b = camList[0]; for (const c of camList) if (Math.abs((c.t || 0) - t) < Math.abs((b.t || 0) - t)) b = c; return b; });
  const evs = events(tracks, band, Court, at, markers, weakTracks);
  // 軌道の点: [t, x, y, n, weak(0/1), air(0/1)]（rally-refuse.js --refar が weakTracks も読み直す）
  const ser = trs => trs.map(tr => ({ t0: tr.t0, t1: tr.t1, n: tr.pts.length, pts: tr.pts.map(q => [+q.t.toFixed(3), Math.round(q.x), Math.round(q.y), q.n, q.weak ? 1 : 0, q.air ? 1 : 0]) }));
  return { events: evs, band, tracks: ser(tracks), weakTracks: ser(weakTracks) };
}

module.exports = { track, candidates, isBall, RG_OK, BG_OK, rowSpans, HUD, link, events, bandFor, refFn, FW, FH };

const WT = require('worker_threads');
if (!WT.isMainThread && WT.workerData && WT.workerData.farballCandWorker) candWorkerMain();

if (require.main === module && WT.isMainThread) {
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
