// フィーバーショットのラケット名バナーを区間走査で拾う（Node・ヘッドレス）。
// ラリー解析でフィーバーショット（6種目）を「バナー直後の打点」に結び付けるための時刻列を作る。
//   node tools/fever-banners-node.js <video> <t0> <t1> [--fps 5] [--json out.json]
// 出力: [{t0, t1, name, score, n}]（同じバナーは 4 秒以内の連続検出を 1 件にまとめる・name は照合 0.93 以上のときだけ）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const HL = require('./highlight-node.js');

function findFfmpeg() {
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) for (const d of fs.readdirSync(base).sort().reverse()) { const p = path.join(base, d, 'ffmpeg.exe'); if (fs.existsSync(p)) return p; }
  return 'ffmpeg';
}
async function* frames(video, t0, t1, fps, W, H) {
  const BYTES = W * H * 4;
  const ff = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-t', String(Math.max(0.001, t1 - t0)), '-i', video,
                                  '-vf', `fps=${fps}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  let buf = Buffer.alloc(0), i = 0;
  for await (const c of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    while (buf.length >= BYTES) { yield { t: +(t0 + i / fps).toFixed(3), i: i++, img: { data: new Uint8ClampedArray(buf.subarray(0, BYTES)), width: W, height: H } }; buf = buf.subarray(BYTES); }
  }
}
function probe(video) {
  return new Promise(resolve => {
    const p = spawn(findFfmpeg(), ['-hide_banner', '-i', video]); let s = '';
    p.stderr.on('data', d => s += d); p.on('close', () => {
      const m = s.match(/(\d{2,4})x(\d{2,4})[,\s]/), d = s.match(/Duration: (\d+):(\d+):([\d.]+)/);
      resolve({ w: m ? +m[1] : 1920, h: m ? +m[2] : 1080, duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0 });
    });
  });
}

async function scan({ video, t0, t1, fps = 5, templates }) {
  const S = HL.loadModules();
  const V = S.Vision || Object.values(S).find(x => x && typeof x === "object" && x.findBanner);
  // findBanner は putImageData(img,-x0,-y0) → getImageData(0,0,w,h) で文字ボックスを切り出す。highlight-node の canvas モックに無いので足す
  const origCreate = S.document.createElement;
  S.document.createElement = tag => {
    const el = origCreate(tag), ctx = el.getContext();
    const origGet = ctx.getImageData; let put = null;
    ctx.putImageData = (img, dx, dy) => { put = { img, dx, dy }; };
    ctx.getImageData = (x = 0, y = 0, w, h) => {
      if (!put) return origGet.call(ctx, x, y, w, h);
      const { img, dx, dy } = put, W = w != null ? w : el.width, H = h != null ? h : el.height, out = new Uint8ClampedArray(W * H * 4);
      for (let yy = 0; yy < H; yy++) { const sy = yy + y - dy; if (sy < 0 || sy >= img.height) continue;
        for (let xx = 0; xx < W; xx++) { const sx = xx + x - dx; if (sx < 0 || sx >= img.width) continue;
          const si = (sy * img.width + sx) * 4, oi = (yy * W + xx) * 4; out[oi] = img.data[si]; out[oi + 1] = img.data[si + 1]; out[oi + 2] = img.data[si + 2]; out[oi + 3] = 255; } }
      return { data: out, width: W, height: H };
    };
    return el;
  };
  const info = await probe(video);
  const vid = { videoWidth: info.w, videoHeight: info.h, duration: info.duration, _img: null };
  const TPL = templates || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'templates.json'), 'utf8'));
  const rb = (TPL.sets && TPL.sets.racketBanners) || TPL.racketBanners || [];
  const bandW = V.REGIONS.bannerBand.w;
  const inside = b => b.box.x0 > 8 && b.box.x1 < bandW - 8;
  const events = [];
  for await (const fr of frames(video, t0, t1 == null ? info.duration : t1, fps, info.w, info.h)) {
    vid._img = fr.img;
    const b = V.findBanner(vid, null, { maxH: 160 });
    if (!b) continue;
    let name = null, score = 0;
    if (inside(b)) for (const tref of rb) { const s = V.profileXcorr(b.profile, tref.profile); if (s > score) { score = s; name = tref.name; } }
    const last = events[events.length - 1];
    if (last && fr.t - last.t1 <= 4.0) { last.t1 = fr.t; last.n++; if (score > last.score) { last.score = score; last.name = name; } }
    else events.push({ t0: fr.t, t1: fr.t, n: 1, score, name });
  }
  return events.map(e => ({ t0: e.t0, t1: e.t1, n: e.n, score: +e.score.toFixed(3), name: e.score >= 0.93 ? e.name : null, best: e.name }));
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const video = a[0];
  if (!video) { console.error('usage: node tools/fever-banners-node.js <video> <t0> <t1> [--fps 5] [--json out.json]'); process.exit(2); }
  scan({ video, t0: +(a[1] || 0), t1: a[2] != null && !a[2].startsWith('--') ? +a[2] : null, fps: +get('--fps', 5) }).then(ev => {
    for (const e of ev) console.log(`${e.t0.toFixed(2)}-${e.t1.toFixed(2)} n=${e.n} ${e.name || '(未照合)'} ${e.score}${e.name ? '' : ' best=' + e.best}`);
    if (get('--json')) fs.writeFileSync(get('--json'), JSON.stringify(ev, null, 1));
  }).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { scan };
