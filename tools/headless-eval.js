// SENSEKI SCAN の本番 index.html を headless Chrome で開き、任意のスクリプトを「アプリ自身の関数・辞書・フレーム」で走らせる。
// headless-analyze.js の姉妹ツール。フル解析ではなく「この時刻のこの領域は辞書とどれだけ一致するか」
// 「このフレームのベクトルを吸い出したい」といった切り分け・収穫に使う。
//
//   node tools/headless-eval.js <video> <snippet.js> [--rect x,y,w,h] [--out result.json] [--port 4764] [--timeout 600]
//     snippet.js は async 関数の本体。引数 (w, V, TPL, video, seekTo, log) が使え、return した値が JSON で出力される。
//       w      = index.html を読み込んだ iframe の window（w.eval('...') で index.html のトップレベル変数にも触れる）
//       V      = window.Vision（vision.js）
//       TPL    = 復元済みの辞書（templates.json ＋ ユーザー辞書は無し）
//       video  = index.html のメイン video 要素（動画は読み込み済み）
//       seekTo = V.makeSeeker(video)（ステイルフレーム対策込み）
//       log(s) = 進捗をコンソールへ（stderr）
//     --rect は headless-analyze.js と同じ（実ピクセル or 割合）。省略=全画面
//
// 例（部門ボードの照合スコアを 0.5 秒刻みで見る）:
//   node tools/headless-eval.js samples/x.mp4 probe.js
//   probe.js: const out=[]; for(let t=100;t<105;t+=0.5){ await seekTo(t);
//             const m=V.matchIcon(V.iconVec(V.cropRegion(video,V.REGIONS.mode1),24,8),TPL.mode1); out.push([t,m.name,m.score]); } return out;
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = { port: 4764, timeout: 600, out: null, rect: null, chrome: null, debug: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--rect') opt.rect = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--port') opt.port = +args[++i];
  else if (a === '--timeout') opt.timeout = +args[++i];
  else if (a === '--chrome') opt.chrome = args[++i];
  else if (a === '--debug') opt.debug = true;
  else positional.push(a);
}
const [video, snippet] = positional;
if (!video || !fs.existsSync(video) || !snippet || !fs.existsSync(snippet)) {
  console.error('usage: node tools/headless-eval.js <video> <snippet.js> [--rect x,y,w,h] [--out result.json]');
  process.exit(2);
}
const ROOT = path.join(__dirname, '..');
const chrome = opt.chrome || process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
               '.png': 'image/png', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveFile(req, res, file, mime) {
  const st = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    res.writeHead(206, { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
                         'content-range': `bytes ${start}-${end}/${st.size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': st.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}

let result = null, chromeProc = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__video') return serveFile(req, res, video, 'video/mp4');
  if (u.pathname === '/__snippet') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(snippet, 'utf8')); }
  if (u.pathname === '/__progress' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { console.error('[progress] ' + body); res.end('ok'); });
    return;
  }
  if (u.pathname === '/__result' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { result = JSON.parse(body); res.end('ok'); finish(); });
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
  serveFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
});

function finish() {
  if (chromeProc) { try { chromeProc.kill(); } catch {} }
  server.close();
  if (!result) { console.error('timeout: no result'); process.exit(1); }
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(result, null, 1));
  if (result.ok) {
    console.log(JSON.stringify(result.value, null, 1));
  } else {
    console.error('ERROR: ' + result.error);
  }
  process.exit(result.ok ? 0 : 1);
}

server.listen(opt.port, () => {
  const q = new URLSearchParams({ name: path.basename(video) });
  if (opt.rect) {
    const [x, y, w, h] = opt.rect.split(',').map(Number);
    if (w <= 1 && h <= 1) q.set('rect', [x, y, w, h].join(','));
    else {
      const [BW, BH] = x + w <= 1280 && y + h <= 720 ? [1280, 720] : [1920, 1080];
      q.set('rect', [x / BW, y / BH, w / BW, h / BH].join(','));
    }
  }
  const url = `http://localhost:${opt.port}/tools/headless-eval.html?${q}`;
  const udd = path.join(require('os').tmpdir(), 'senseki-headless-eval-' + process.pid);
  chromeProc = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1500,1000', `--user-data-dir=${udd}`,
    ...(opt.debug ? ['--enable-logging=stderr', '--v=0'] : []), url], { stdio: ['ignore', 'ignore', opt.debug ? 'pipe' : 'ignore'] });
  if (opt.debug) chromeProc.stderr.on('data', d => { for (const l of String(d).split('\n')) if (/CONSOLE|ERROR/.test(l) && !/HKLM|registry/.test(l)) console.error('[chrome] ' + l.trim()); });
  chromeProc.on('exit', () => { if (!result) setTimeout(() => finish(), 500); });
  setTimeout(() => finish(), opt.timeout * 1000);
  console.error('headless-eval: ' + url);
});
