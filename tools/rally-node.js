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

const W = 960, H = 540, FRAME_BYTES = W * H * 4;

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
    console, Math, Date, isFinite, isNaN, parseInt, parseFloat,
    Uint8Array, Uint8ClampedArray, Int32Array, Float32Array, Array, Object, JSON,
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
  for (const f of ['court.js', 'ball.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  }
  // 変種: 同じサンドボックスで走らせ、window.BallTrack のエクスポートを差し替えさせる。
  // 変種側は素の実装を window.BallTrack から取れるので、必要な関数だけ上書きすればよい。
  if (variant) {
    const vp = path.isAbsolute(variant) ? variant : path.join(dir, 'variants', variant.endsWith('.js') ? variant : variant + '.js');
    vm.runInContext(fs.readFileSync(vp, 'utf8'), sandbox, { filename: path.basename(vp) });
  }
  return { Court: sandbox.Court, BallTrack: sandbox.BallTrack };
}

// ---- ffmpeg から RGBA フレームを1枚ずつ ----
async function* frames(video, t0, t1, fps) {
  const ff = spawn(findFfmpeg(), [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(t0), '-t', String(Math.max(0.001, t1 - t0)),
    '-i', video,
    '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
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

// ---- 1ラリーを解析 ----
// camEvery: カメラ推定の間引き。ラリー中もドリーするので粗すぎると座標がずれる。
async function analyze(opts) {
  const { Court, BallTrack } = loadModules(opts.variant);
  const { video, t0, t1, fps = 60, camEvery = 15 } = opts;
  // overlapMax=null で静止物フィルタを無効化できる（実験用）
  const overlapMax = opts.overlapMax === undefined ? 0.6 : opts.overlapMax;

  const frameLog = [];
  let prevMask = null, cam = null, net = null, prev = [], state = {};
  const cams = [];                                     // {t, cam} 時刻ごとのカメラ
  const started = Date.now();

  for await (const fr of frames(video, t0, t1, fps)) {
    if (fr.i % camEvery === 0) {
      const e = Court.estimate(fr.img);
      if (e.ok && !e.suspect) {
        cam = e;
        cams.push({ t: fr.t, cam: e });
        const base = Court.toScreen(0, 0, cam).y, u = 1 / cam.c0, hpx = 0.91 * u / cam.Yc;
        net = { y0: (base - hpx * 1.25) / 2, y1: (base + 12) / 2 };
      }
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

  return {
    video: path.basename(video), t0, t1, fps, variant: opts.variant || null,
    ms: Date.now() - started,
    nFrames: frameLog.length,
    nCands: frameLog.reduce((s, f) => s + f.c.length, 0),
    camOk: cams.length, net,
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
  if (!video || !isFinite(t0) || !isFinite(t1)) {
    console.error('usage: node rally-node.js <video> <t0> <t1> [--json out.json] [--fps 60]');
    process.exit(2);
  }
  analyze({ video, t0, t1, fps: fpsAt >= 0 ? +a[fpsAt + 1] : 60, variant: varAt >= 0 ? a[varAt + 1] : null }).then(r => {
    if (jsonAt >= 0) fs.writeFileSync(a[jsonAt + 1], JSON.stringify(r, null, 1));
    const { frameLog, ...brief } = r;
    console.log(JSON.stringify(brief, null, 1));
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { analyze, loadModules, frames, W, H };
