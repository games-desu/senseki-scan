// ラリー解析の手直しツール（自分用・方針 B の第 1 段）
//   node tools/rally-edit-server.js <runDir> [--gt out.json] [--video path] [--port 4762]
//   → http://localhost:4762/ をブラウザで開く
// <runDir> の p*.json（rally-match / rally-exp の出力）の打点を初期値にして、時刻・側・種別を直し、
// 目視 GT と同じ形（{video, note, points:[{idx, t0, t1, hits:[{t, side, cls, serve?}]}]}）で保存する。
// 保存先の既定は samples/rally/gt-edit-<runDir の名前>.json。「確認済み」にしていないポイントは draft: true で残し、
// rally-bench2 / rally-exp の採点は draft を読み飛ばす。
// 採点: node tools/rally-bench2.js samples/rally/gt-edit-<名前>.json --dir <runDir>
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const a = process.argv.slice(2);
const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const runDir = a[0] && !a[0].startsWith('--') ? path.resolve(a[0]) : null;
if (!runDir || !fs.existsSync(runDir)) {
  console.error('usage: node tools/rally-edit-server.js <runDir> [--gt out.json] [--video path] [--port 4762]');
  process.exit(1);
}
const PORT = +get('--port', 4762);
const gtFile = path.resolve(get('--gt', path.join(ROOT, 'samples', 'rally', `gt-edit-${path.basename(runDir)}.json`)));

// ポイントを読む（p*.json の大きい配列は捨てて rally と区間だけ持つ）
const files = fs.readdirSync(runDir).filter(f => /^p\d+\.json$/.test(f))
  .sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1)));
let summary = null;
try { summary = JSON.parse(fs.readFileSync(path.join(runDir, 'points.json'), 'utf8')); } catch { /* 無くてよい */ }
const sumByIdx = new Map((summary?.points || []).map(p => [p.idx, p]));
let videoName = get('--video', summary?.video || null);
const points = files.map(f => {
  const j = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8'));
  const idx = parseInt(f.slice(1));
  if (!videoName && j.video) videoName = j.video;
  const s = sumByIdx.get(idx);
  return {
    idx, t0: j.t0, t1: j.t1, fps: j.fps, score: s?.score ?? null, winner: s?.winner ?? null,
    rally: (s?.rally || j.rally || []).map(h => ({ t: h.t, side: h.side, cls: h.cls, serve: !!h.serve, src: h.src })),
  };
});
if (!points.length) { console.error(`p*.json がありません: ${runDir}`); process.exit(1); }

// 動画の場所: そのまま → リポ直下から → samples/ の中
function resolveVideo(v) {
  if (!v) return null;
  for (const c of [path.resolve(v), path.join(ROOT, v), path.join(ROOT, 'samples', path.basename(v))]) if (fs.existsSync(c)) return c;
  return null;
}
const videoPath = resolveVideo(videoName);
if (!videoPath) { console.error(`動画が見つかりません: ${videoName}（--video で指定）`); process.exit(1); }
const videoRel = path.relative(ROOT, videoPath).split(path.sep).join('/');

function loadGt() {
  try { return JSON.parse(fs.readFileSync(gtFile, 'utf8')); } catch { return null; }
}

function send(res, code, type, body) { res.writeHead(code, { 'content-type': type }); res.end(body); }

function streamVideo(req, res) {
  const size = fs.statSync(videoPath).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(videoPath).pipe(res);
    return;
  }
  const start = m[1] ? +m[1] : 0, end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
  res.writeHead(206, {
    'content-type': 'video/mp4', 'accept-ranges': 'bytes',
    'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1,
  });
  fs.createReadStream(videoPath, { start, end }).pipe(res);
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'rally-edit.html')));
  }
  if (req.method === 'GET' && url === '/video') return streamVideo(req, res);
  if (req.method === 'GET' && url === '/api/load') {
    const gt = loadGt();
    return send(res, 200, 'application/json', JSON.stringify({
      runDir: path.relative(ROOT, runDir), gtFile: path.relative(ROOT, gtFile), video: videoRel, points,
      edited: gt ? gt.points : [],
    }));
  }
  if (req.method === 'POST' && url === '/api/save') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const p = JSON.parse(body);
        if (!Number.isInteger(p.idx) || !Array.isArray(p.hits)) throw new Error('idx と hits が要る');
        const gt = loadGt() || {
          video: videoRel,
          note: `rally-edit で ${path.relative(ROOT, runDir).split(path.sep).join('/')} の検出を手直し。t は打点（トレイル出現の直前）。draft: true は未確認`,
          points: [],
        };
        const hits = p.hits.map(h => {
          const o = { t: +(+h.t).toFixed(3), side: h.side === 'opp' ? 'opp' : 'me', cls: String(h.cls) };
          if (h.serve) o.serve = true;
          if (h.note) o.note = String(h.note);
          return o;
        }).sort((x, y) => x.t - y.t);
        const pt = { idx: p.idx, t0: p.t0, t1: p.t1, hits };
        if (!p.done) pt.draft = true;
        if (p.note) pt.note = String(p.note);
        pt.edited = new Date().toISOString();
        const i = gt.points.findIndex(q => q.idx === p.idx);
        if (i >= 0) gt.points[i] = pt; else gt.points.push(pt);
        gt.points.sort((x, y) => x.idx - y.idx);
        fs.writeFileSync(gtFile, JSON.stringify(gt, null, 1));
        send(res, 200, 'application/json', JSON.stringify({ ok: true }));
      } catch (e) {
        send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, () => {
  console.log(`rally-edit: http://localhost:${PORT}/`);
  console.log(`  run   ${runDir}（${points.length} ポイント）`);
  console.log(`  video ${videoPath}`);
  console.log(`  gt    ${gtFile}`);
});
