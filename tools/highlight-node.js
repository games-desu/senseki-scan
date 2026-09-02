// SENSEKI SCAN ハイライト生成のヘッドレス検証（Node）。
// app/renderer の vision.js / rally.js / highlight.js を**そのまま**読み込み、ffmpeg の生フレームを
// 一定fpsで流し込んで readFrame → buildPoints を走らせる。ブラウザを開かずにポイント検出を検証するため。
//
//   node tools/highlight-node.js <video> [t0] [t1] [--fps 2] [--json out.json] [--ffmpeg path]
//
// ffmpeg は app/node_modules/ffmpeg-static（同梱予定の実物）を既定にする。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

function findFfmpeg(override) {
  if (override) return override;
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const p = path.join(__dirname, '..', 'app', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  if (fs.existsSync(p)) return p;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const q = path.join(base, d, 'ffmpeg.exe');
      if (fs.existsSync(q)) return q;
    }
  }
  return 'ffmpeg';
}

// ---- canvas の最小モック: drawImage(src, sx,sy,sw,sh, dx,dy,dw,dh) を箱平均/最近傍で再標本化 ----
function resample(src, sx, sy, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const S = src.data, W = src.width, H = src.height;
  const fx = sw / dw, fy = sh / dh;
  for (let oy = 0; oy < dh; oy++) {
    const y0 = Math.max(0, Math.floor(sy + oy * fy)), y1 = Math.min(H, Math.max(y0 + 1, Math.floor(sy + (oy + 1) * fy)));
    for (let ox = 0; ox < dw; ox++) {
      const x0 = Math.max(0, Math.floor(sx + ox * fx)), x1 = Math.min(W, Math.max(x0 + 1, Math.floor(sx + (ox + 1) * fx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4; r += S[i]; g += S[i + 1]; b += S[i + 2]; n++;
      }
      const o = (oy * dw + ox) * 4;
      if (n) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

function loadModules() {
  const dir = path.join(__dirname, '..', 'app', 'renderer');
  const sandbox = {
    console, Math, Date, isFinite, isNaN, parseInt, parseFloat, Number, String, Boolean, Promise, Set, Map,
    Uint8Array, Uint8ClampedArray, Int32Array, Float32Array, Float64Array, Array, Object, JSON, Error, Symbol,
    setTimeout, clearTimeout, performance: { now: () => Date.now() },
  };
  sandbox.window = sandbox;
  sandbox.document = {
    createElement(tag) {
      let w = 0, h = 0, img = null;
      const ctx = {
        drawImage(src, ...a) {
          let sx, sy, sw, sh, dw, dh;
          if (a.length >= 8) { [sx, sy, sw, sh, , , dw, dh] = a; }
          else { sx = 0; sy = 0; sw = src.videoWidth; sh = src.videoHeight; dw = a[2] ?? w; dh = a[3] ?? h; }
          img = resample(src._img, sx, sy, sw, sh, dw, dh);
        },
        getImageData() { return img; },
      };
      return { tagName: tag, getContext: () => ctx, get width() { return w; }, set width(v) { w = v; }, get height() { return h; }, set height(v) { h = v; } };
    },
  };
  vm.createContext(sandbox);
  for (const f of ['vision.js', 'rally.js', 'highlight.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

function probe(ffmpeg, video) {
  return new Promise(res => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', video]);
    let s = '';
    p.stderr.on('data', d => s += d);
    p.on('close', () => {
      const m = /Video:.*?(\d{3,5})x(\d{3,5})/.exec(s);
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
      res({ w: m ? +m[1] : 1920, h: m ? +m[2] : 1080, duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0 });
    });
  });
}

async function* frames(ffmpeg, video, t0, t1, fps, W, H) {
  const BYTES = W * H * 4;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (t0 > 0) args.push('-ss', String(t0));
  if (t1 != null) args.push('-t', String(Math.max(0.001, t1 - t0)));
  args.push('-i', video, '-vf', `fps=${fps}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-');
  const ff = spawn(ffmpeg, args);
  ff.stderr.on('data', d => process.stderr.write(d));
  let buf = Buffer.alloc(0), i = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= BYTES) {
      const raw = buf.subarray(0, BYTES);
      buf = buf.subarray(BYTES);
      yield { t: +(t0 + i / fps).toFixed(3), i: i++, img: { data: new Uint8ClampedArray(raw), width: W, height: H } };
    }
  }
}

async function run(opts) {
  const ffmpeg = findFfmpeg(opts.ffmpeg);
  const S = loadModules();
  const info = await probe(ffmpeg, opts.video);
  const t0 = opts.t0 ?? 0, t1 = opts.t1 ?? info.duration;
  const video = { videoWidth: info.w, videoHeight: info.h, duration: info.duration, _img: null };
  const samples = [];
  const started = Date.now();
  for await (const fr of frames(ffmpeg, opts.video, t0, t1, opts.fps, info.w, info.h)) {
    video._img = fr.img;
    const s = S.Highlight.readFrame(video);
    samples.push({ t: fr.t, ...s });
    if (fr.i % 200 === 0) process.stderr.write(`  ${fr.t.toFixed(0)}s / ${t1.toFixed(0)}s\n`);
  }
  const points = S.Highlight.buildPoints(samples);
  // シーン走査相当（cls のラン）
  const scenes = [];
  for (const s of samples) {
    const last = scenes[scenes.length - 1];
    if (last && last.type === s.cls) last.t1 = s.t; else scenes.push({ type: s.cls, t0: s.t, t1: s.t });
  }
  const windows = S.Highlight.matchWindows(scenes.filter(e => e.type !== 'other'), info.duration);
  return { info, ms: Date.now() - started, n: samples.length, samples, points, scenes: scenes.filter(e => e.type !== 'other'), windows };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const pos = a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
  const video = pos[0];
  if (!video) { console.error('usage: node tools/highlight-node.js <video> [t0] [t1] [--fps 2] [--json out.json]'); process.exit(2); }
  run({ video, t0: pos[1] != null ? +pos[1] : undefined, t1: pos[2] != null ? +pos[2] : undefined, fps: +get('--fps', 2), ffmpeg: get('--ffmpeg') }).then(r => {
    const json = get('--json');
    if (json) fs.writeFileSync(json, JSON.stringify(r, null, 1));
    const S = loadModules();
    console.log(`video ${r.info.w}x${r.info.h} ${r.info.duration.toFixed(1)}s  samples=${r.n}  ${(r.ms / 1000).toFixed(1)}s`);
    console.log('scenes: ' + r.scenes.map(e => `${e.type}@${e.t0.toFixed(0)}-${e.t1.toFixed(0)}`).join(' '));
    console.log('windows: ' + r.windows.map(w => `${w.t0.toFixed(1)}-${w.t1.toFixed(1)}`).join(' '));
    // セグメント表（消灯区間つき）
    let i = 0; const segs = [];
    while (i < r.samples.length) {
      if (!r.samples[i].hudOn) { i++; continue; }
      const s = i; while (i < r.samples.length && r.samples[i].hudOn) i++;
      const arr = r.samples.slice(s, i);
      const f = arr.find(S.Highlight.usable), l = [...arr].reverse().find(S.Highlight.usable);
      const gap = r.samples.slice(i, r.samples.findIndex((x, k) => k >= i && x.hudOn) < 0 ? r.samples.length : r.samples.findIndex((x, k) => k >= i && x.hudOn));
      segs.push(`${arr[0].t.toFixed(1)}-${arr[arr.length - 1].t.toFixed(1)} ${f ? S.Rally.scoreLabel(f) : '?'}→${l ? S.Rally.scoreLabel(l) : '?'} | off ${gap.length ? (gap[gap.length - 1].t - gap[0].t + 1 / 2).toFixed(1) + 's' : 'end'} banner=${gap.filter(x => x.banner).length} cls=${[...new Set(gap.map(x => x.cls))].join('/')}`);
    }
    console.log('segments:\n  ' + segs.join('\n  '));
    console.log('points:');
    for (const p of r.points) {
      const c = S.Highlight.clipRanges(p);
      console.log(`  g${p.game} ${p.final ? 'FINAL' : '     '} ${p.winner.padEnd(3)} ${p.scoreBefore} → ${p.scoreAfter}  on ${p.hudOn.toFixed(1)} off ${p.hudOff.toFixed(1)} (${(p.hudOff - p.hudOn).toFixed(1)}s)  short ${c.short.s.toFixed(1)}-${c.short.e.toFixed(1)}`);
    }
    const byGame = {};
    for (const p of r.points) { byGame[p.game] ??= { me: 0, opp: 0 }; byGame[p.game][p.winner]++; }
    const fills = r.samples.filter(x => x.hudOn).map(x => Math.min(x.L.fill, x.R.fill)).sort((a, b) => a - b);
    const offFills = r.samples.filter(x => !x.hudOn).map(x => Math.max(x.L.fill, x.R.fill)).sort((a, b) => a - b);
    const q = (a, p) => a.length ? a[Math.floor((a.length - 1) * p)].toFixed(3) : '-';
    console.log(`fill on(min) p0/p1/p5/p50=${q(fills,0)}/${q(fills,0.01)}/${q(fills,0.05)}/${q(fills,0.5)}  off(max) p50/p95/p99/p100=${q(offFills,0.5)}/${q(offFills,0.95)}/${q(offFills,0.99)}/${q(offFills,1)}`);
    console.log('per game: ' + Object.entries(byGame).map(([g, v]) => `g${g} me=${v.me} opp=${v.opp}`).join('  '));
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { run, loadModules };
