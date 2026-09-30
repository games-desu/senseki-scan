// SENSEKI SCAN ラリー解析のヘッドレス実行（Node）。
// ブラウザ用の court.js / ball.js を**そのまま**読み込み、ffmpeg の生フレームを流し込む。
// 目的は再現可能な計測。ブラウザUIを開かずに1ラリーを解析して JSON を吐く。
//
//   node tools/rally-node.js <video> <t0> <t1> [--json out.json] [--fps 60] [--dump-frames]
//
// ffmpeg は CapCut 同梱の exe（環境に実 ffmpeg が無いため）。SENSEKI_FFMPEG で上書き可。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const FarBall = require('./farball.js');
const ShotColor = require('./shotcolor.js');
const Slide = require('./slide.js');

const W = 960, H = 540, FRAME_BYTES = W * H * 4;
// 実験場の tools コピー（samples/rally/exp-*/tools）から走らせても本体のリポジトリを指すように、samples/rally がある所まで上がる（rally-exp.js・rally-refuse.js と同じ）
const REPO = (() => { let d = path.resolve(__dirname, '..'); for (let k = 0; k < 6; k++) { if (fs.existsSync(path.join(d, 'samples', 'rally'))) return d; d = path.dirname(d); } return path.resolve(__dirname, '..'); })();

function findFfmpeg() {
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'ffmpeg.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return 'ffmpeg';
}

// ---- ブラウザ用モジュールを Node に載せる ----
// court.js の frame() だけが document を触る。ImageData をそのまま返す canvas を差し込めば通る。
function loadModules(variant) {
  const dir = __dirname;
  const sandbox = {
    console, Math, Date, isFinite, isNaN, parseInt, parseFloat, Number, String, Set, Map, Infinity,
    Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float32Array, Array, Object, JSON,
  };
  sandbox.window = sandbox;
  sandbox.document = {
    createElement() {
      const ctx = {
        _img: null,
        drawImage(src) { ctx._img = src; },
        getImageData() { return ctx._img; },
      };
      return { getContext: () => ctx, set width(v) {}, set height(v) {} };
    },
  };
  vm.createContext(sandbox);
  for (const f of ['court.js', 'ball.js', 'trail.js', 'star.js', 'rally-fuse.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  }
  // 変種: 同じサンドボックスで走らせ、window.BallTrack のエクスポートを差し替えさせる。
  // 変種側は素の実装を window.BallTrack から取れるので、必要な関数だけ上書きすればよい。
  if (variant) {
    let vp = path.isAbsolute(variant) ? variant : path.join(dir, 'variants', variant.endsWith('.js') ? variant : variant + '.js');
    // variants/ を写していない実験場の tools コピー（exp-int3f など）は本体の tools/variants を使う（本体の tools から走らせるときは同じ場所なので変わらない）
    if (!path.isAbsolute(variant) && !fs.existsSync(vp)) {
      const alt = path.join(REPO, 'tools', 'variants', path.basename(vp));
      if (fs.existsSync(alt)) { if (!warnedVariant.has(alt)) { warnedVariant.add(alt); console.warn(`[rally-node] ${path.join(dir, 'variants')} に ${path.basename(vp)} が無いので本体の ${alt} を使う`); } vp = alt; }
    }
    vm.runInContext(fs.readFileSync(vp, 'utf8'), sandbox, { filename: path.basename(vp) });
  }
  return { Court: sandbox.Court, BallTrack: sandbox.BallTrack, Trail: sandbox.Trail, Star: sandbox.Star, RallyFuse: sandbox.RallyFuse };
}

const warnedVariant = new Set();   // 本体の variants を借りたことを 1 回だけ知らせる（exp-int3f-review N7: 実験場が本体の後の変更を黙って拾わないように）

// ---- ffmpeg から RGBA フレームを1枚ずつ ----
// 時刻は t0 + i/fps と振る。srcFps（動画のコマ数・ShotColor.videoSize で調べたもの）が fps と違うときだけ fps フィルタで fps に揃える
// （2026-09-24 exp-int3f・レビューの note: 以前はフィルタが無く、30fps の動画を 1/60 秒刻みで数えて時刻が半分に縮んでいた＝窓 60〜72 秒の最後のトレイルのコマが 65.97）。
// srcFps が fps と同じ（FHD 60fps の録画）か不明なら従来どおりフィルタを掛けない（出力を変えない）
async function* frames(video, t0, t1, fps, srcFps = null) {
  const resample = srcFps != null && Math.abs(srcFps - fps) > 0.5;
  const ff = spawn(findFfmpeg(), [
    '-hide_banner', '-loglevel', 'error',
    // -t は 1 コマ分を下限に（exp-int3f-review S2: OBS の録画は時間の単位が 1/60 秒なので 0.001 は 0 に丸まり、ffmpeg が制限なしで動画の最後まで読んでいた）
    '-ss', String(t0), '-t', String(Math.max(1 / fps, t1 - t0)),
    '-i', video,
    '-vf', `${resample ? `fps=${fps},` : ''}scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ]);
  ff.stderr.on('data', d => process.stderr.write(d));
  let buf = Buffer.alloc(0), i = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= FRAME_BYTES) {
      const raw = buf.subarray(0, FRAME_BYTES);
      buf = buf.subarray(FRAME_BYTES);
      yield { t: +(t0 + i / fps).toFixed(4), i: i++,
              img: { data: new Uint8ClampedArray(raw), width: W, height: H } };
    }
  }
}

const warnedFps = new Set(), warnedFar = new Set();   // 動画ごとに 1 回だけ警告する

// ---- 1ラリーを解析 ----
// camEvery: カメラ推定の間引き。ラリー中もドリーするので粗すぎると座標がずれる。
async function analyze(opts) {
  const { Court, BallTrack, Trail, Star, RallyFuse } = loadModules(opts.variant);
  const { video, t1, fps = 60, camEvery = 15, trailEvery = 2 } = opts;
  const t0 = Math.max(0, opts.t0);   // 負の t0 は 0 から（exp-int3f-review N9: -ss が負だと窓より長く読み、時刻もずれた）   // トレイルは2コマに1回で足りる（仕様: 4コマ間隔で可）
  // overlapMax=null で静止物フィルタを無効化できる（実験用）
  const overlapMax = opts.overlapMax === undefined ? 0.6 : opts.overlapMax;

  const frameLog = [];
  let prevMask = null, cam = null, net = null, prev = [], state = {}, camAt_i = -1e9, camProv = null, camProvAt_i = -1e9;
  const cams = [];                                     // {t, cam} 時刻ごとのカメラ
  const started = Date.now();
  // Phase D: ショット色トレイル（opts.trail のとき毎フレーム）
  const trailLog = [], hist = [], starLog = [];
  // 入力の解像度とコマ数（2026-09-24 exp-int3f）: FHD 60fps 以外（720p・30fps）は FHD 60fps 専用の段（farball・shotcolor）を掛けず、理由を残す。
  // コマ数が fps と違えば frames で fps に揃える（時刻を正しく）。fps が読めなければ揃えない（従来どおり）。
  // 動画そのものを調べられなければ（null）notFhd は 'size?' で、farball・shotcolor は掛けない（安全側・exp-int3f-review N4）
  const vi = await ShotColor.videoSize(video);
  const notFhd = ShotColor.notFhd60(vi);
  const srcFps = vi ? vi.fps : null;
  const resample = srcFps != null && Math.abs(srcFps - fps) > 0.5;
  if (resample && !warnedFps.has(video)) { warnedFps.add(video); console.warn(`[rally-node] 入力が ${srcFps}fps なので fps=${fps} に揃えて読む（時刻 t0 + i/${fps}）: ${path.basename(video)}`); }

  for await (const fr of frames(video, t0, t1, fps, srcFps)) {
    // カメラが古い（カット直後）ときは 5 コマごとに推定し直して復帰を早める（サーブ画→ラリー画の切替で打点を落とさない）
    if (fr.i % camEvery === 0 || (fr.i - camAt_i > 30 && fr.i % 5 === 0)) {
      const e = Court.estimate(fr.img);
      // サーブ画（別カメラ・ロール付き）は横1本＋縦1本で "ok・suspect=false・agree=null" が通ってしまう。
      // 横2本以上・縦2本以上・交差検証あり、を「ラリーカメラ」の条件にする（2026-09-08 実測: 0908 p3 110.5〜111.75）
      if (e.ok && !e.suspect && e.hHits >= 2 && e.xHits >= 2 && e.agree != null) {
        cam = e; camAt_i = fr.i; camProv = null;
        e.t = fr.t;   // 標本の時刻（rally-refuse の camAt と同じ形・2026-09-29 fartime: fuse の自分のサーブの寄せが「直前に標本が無い」を見る。farball は自前で t を足すので変わらない）
        cams.push({ t: fr.t, cam: e });
        const base = Court.toScreen(0, 0, cam).y, u = 1 / cam.c0, hpx = 0.91 * u / cam.Yc;
        net = { y0: (base - hpx * 1.25) / 2, y1: (base + 12) / 2 };
      } else if (e.ok && e.xHits >= 2 && e.hHits >= 1.5) {   // 緩めすぎるとサーブ画(1/1)でも通ってしまう（砂 412.1 の偽打点）
        // 仮カメラ: サーブ画→ラリー画へのズーム中（0.4秒ほど）は横ラインが揃わない。座標には使わないがトレイル検出には使う
        camProv = e; camProvAt_i = fr.i;
      }
    }
    if (opts.trail && fr.i % trailEvery === 0) {
      // カメラが 0.5 秒以上更新されていない（サーブ画・リプレイ・演出カット）ならトレイルは見ない
      const fresh = fr.i - camAt_i <= 30, prov = !fresh && fr.i - camProvAt_i <= 10;
      const tr = fresh ? Trail.detect(fr.img, { cam, hist }) : prov ? Trail.detect(fr.img, { cam: camProv, hist }) : { blobs: [], ref: null, mask: null };
      if (prov) tr.blobs.forEach(b => { b.prov = true; });
      hist.unshift({ mask: tr.mask, blobs: tr.blobs }); if (hist.length > 3) hist.pop();
      // 着弾の星マーカー（ラリーカメラのときだけ・砂コートは star.js 側で除外）
      if (fresh) starLog.push({ t: fr.t, stars: Star.detect(fr.img, { cam, ref: tr.ref }) });
      trailLog.push({ t: fr.t, f: fr.i, blobs: tr.blobs,
                      ref: tr.ref ? { S90: +tr.ref.S90.toFixed(2), V90: +tr.ref.V90.toFixed(2), L90: Math.round(tr.ref.L90), Hmed: tr.ref.Hmed == null ? null : Math.round(tr.ref.Hmed), lineL: Math.round(tr.ref.lineL), useHue: tr.ref.useHue } : null });
    }
    const cs = BallTrack.candidates(fr.img, { prevMask });
    prevMask = cs.mask;
    // フィルタは ball.js 側の差し替え点に委ねる（変種が丸ごと置き換えられるように）
    const keep = BallTrack.filterCandidates(cs, { net, overlapMax, t: fr.t, f: fr.i, state, prev, cam });
    prev = keep;
    frameLog.push({
      t: fr.t, f: fr.i,
      c: keep.map(c => [+c.x.toFixed(2), +c.y.toFixed(2), c.n, +c.fill.toFixed(3), +c.rg.toFixed(3)]),
      nRaw: cs.length, nKeep: keep.length,
    });
  }

  const camAt = t => {
    if (!cams.length) return null;
    let b = cams[0];
    for (const c of cams) if (Math.abs(c.t - t) < Math.abs(b.t - t)) b = c;
    return b.cam;
  };

  const chains = BallTrack.buildChains(frameLog);
  const ranked = BallTrack.pickBall(chains, { net });
  const segs = BallTrack.ballSegments(ranked);
  const events = segs.length ? BallTrack.classifyEvents(segs, camAt) : [];
  const yFarAt = t => { const c = camAt(t); return c && c.ok ? Court.toScreen(0, Court.Z_BASE, c).y / Trail.SC : null; };   // 奥ベースラインの画面 y（カメラの縦移動の物差し）
  const trailRuns = opts.trail ? Trail.runs(trailLog, { fps: fps / trailEvery, yFarAt }) : null;
  const shots = trailRuns ? Trail.shots(trailRuns, { tStart: t0 }) : null;
  const track = []; segs.forEach(s => s.pts.forEach(p => track.push(p))); track.sort((a, b) => a.t - b.t);
  const markers = opts.trail ? Star.track(starLog) : [];
  // 奥側（相手コート）のボール追跡（フル解像度・tools/farball.js）: 折り返し/出現を 'hit' イベントとして追跡イベントに混ぜ、fuse の同側補完・空白補完に効かせる
  let farBall = null;
  if (opts.trail && opts.farBall !== false && cams.length) {
    if (notFhd) {
      // FHD 60fps 以外は掛けない（2026-09-24 exp-int3f・レビューの note）: 帯の crop（1920 幅）・期待直径・px の閾値は FHD、速さの閾値は 60fps のコマ。以前は ffmpeg が
      // crop を拒否するのに頼っていた（720p は毎ポイント stderr にエラー・2560×1440 なら crop が通って縮尺違いの far が出る）。30fps の FHD は fps=60 で読むと同じ絵が 2 コマずつ続き、
      // 前コマとの重なり（ov ≥ 0.85 は軌道の起点にしない）と同じ升目に居るコマ数（静止物の篩）の数え方が 60fps の前提から外れる。空の結果に理由を付けて残す（warn は動画ごとに 1 回）
      if (!warnedFar.has(video)) { warnedFar.add(video); console.warn(`[farball] FHD 60fps 以外（${notFhd}）なので奥側のボール追跡を掛けない: ${path.basename(video)}`); }
      farBall = { skipped: notFhd, events: [], tracks: [], weakTracks: [], band: null };
    } else {
      farBall = await FarBall.track({ video, t0, t1, fps, cams, Court, markers });
      events.push(...farBall.events); events.sort((a, b) => a.t - b.t);
    }
  }
  const rally = shots ? RallyFuse.fuse({ shots, events, track, camAt, t0, t1, markers, farTracks: farBall ? farBall.tracks : [], segs }).shots : null;
  // 追跡由来の打点（src track / far-* / launch*・種別 unknown）の種別を、打点直後の球の通り道の色（フル解像度）で読む後段（tools/shotcolor.js・1 打 0.3〜0.6 秒）。
  // fuse の後に掛ける（rally-refuse.js も fuse の後に掛け直す）
  let shotColor = null;
  if (rally && opts.trail && opts.shotColor !== false) {
    const sc = await ShotColor.apply({ video, rally, segPts: segs.map(s => ({ pts: s.pts })), farBall, t1,
                                       toCourt: (t, x, y) => { const c = camAt(t); return c && c.ok ? Court.toCourt(x, y, c) : null; },
                                       camOk: ShotColor.makeCamOk(cams, Court) });
    shotColor = { changed: sc.changed, n: sc.skipped ? sc.n : sc.log.length, ms: sc.ms, skipped: sc.skipped, log: sc.log };   // skipped: FHD 以外で読まなかった（2026-09-24）
  }
  if (rally) Slide.apply(rally);   // 2026-09-30: shotcolor の後にスライドの種別（tools/slide.js）

  return {
    rally, shots, trailRuns, markers, farBall, shotColor, trailLog: opts.trail ? trailLog : undefined,
    video: path.basename(video), t0, t1, fps, variant: opts.variant || null,
    input: vi ? { w: vi.w, h: vi.h, fps: vi.fps, resampled: resample, notFhd60: notFhd } : null,   // 入力の解像度・コマ数と FHD 60fps でない理由（2026-09-24 exp-int3f）
    ms: Date.now() - started,
    nFrames: frameLog.length,
    nCands: frameLog.reduce((s, f) => s + f.c.length, 0),
    camOk: cams.length, net,
    cams: cams.map(c => ({ t: c.t, c0: c.cam.c0, c1: c.cam.c1, Xc: c.cam.Xc, Yc: c.cam.Yc })),
    chains: chains.length,
    ranked: ranked.slice(0, 12).map(c => ({
      t0: c.pts[0].t, t1: c.pts[c.pts.length - 1].t, len: c.len,
      rank: +c.rank.toFixed(1), nAvg: c.nAvg, vertRatio: c.vertRatio,
      spanX: +c.spanX.toFixed(1), spanY: +c.spanY.toFixed(1),
    })),
    segments: segs.map(s => ({ t0: s.t0, t1: s.t1, len: s.len, rank: +s.rank.toFixed(1) })),
    segPts: segs.map(s => ({ t0: s.t0, t1: s.t1, pts: s.pts })),
    events,
    frameLog,
  };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const video = a[0], t0 = +a[1], t1 = +a[2];
  const jsonAt = a.indexOf('--json');
  const fpsAt = a.indexOf('--fps');
  const varAt = a.indexOf('--variant');
  const trail = a.includes('--trail');
  if (!video || !isFinite(t0) || !isFinite(t1)) {
    console.error('usage: node rally-node.js <video> <t0> <t1> [--json out.json] [--fps 60]');
    process.exit(2);
  }
  analyze({ video, t0, t1, fps: fpsAt >= 0 ? +a[fpsAt + 1] : 60, variant: varAt >= 0 ? a[varAt + 1] : null, trail }).then(r => {
    if (jsonAt >= 0) fs.writeFileSync(a[jsonAt + 1], JSON.stringify(r, null, 1));
    const { frameLog, trailLog, ...brief } = r;
    if (brief.shots) brief.shots = brief.shots.map(({ frames, ...s }) => s);
    console.log(JSON.stringify(brief, null, 1));
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { analyze, loadModules, frames, W, H };
