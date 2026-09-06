// SENSEKI SCAN のフル解析を headless Chrome で再現する（本番の index.html をそのまま動かす）。
// 利用者から届いた「検出できない」録画の切り分け用。ブラウザのタブを見なくても解析ログ・CSV・試合結果が取れる。
//
//   node tools/headless-analyze.js <video> [--rect x,y,w,h] [--out result.json] [--port 4763] [--timeout 900]
//     --rect は実ピクセル（アプリの「ゲーム画面の位置」で出る X/Y/幅/高）。省略=全画面
//     --chrome で chrome.exe を指定（既定: Program Files の Google Chrome）
//
// 仕組み: このスクリプトがリポジトリ直下を配信する小さな HTTP サーバーを立て、/__video で動画を Range 対応で返し、
// tools/headless-analyze.html を headless Chrome で開く。駆動ページが iframe の analyzeFile() を呼び、結果を /__result へ POST する。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const opt = { port: 4763, timeout: 900, out: null, rect: null, chrome: null, debug: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--rect') opt.rect = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--port') opt.port = +args[++i];
  else if (a === '--timeout') opt.timeout = +args[++i];
  else if (a === '--chrome') opt.chrome = args[++i];
  else if (a === '--debug') opt.debug = true; // Chrome のコンソール出力を表示
  else positional.push(a);
}
const video = positional[0];
if (!video || !fs.existsSync(video)) {
  console.error('usage: node tools/headless-analyze.js <video> [--rect x,y,w,h] [--out result.json]');
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
  console.log(result.log || '');
  if (result.ok) {
    const rows = result.csv.split(/\r?\n/).filter(Boolean).length - 1;
    console.log(`\n== ${rows}試合 / ${result.sec}s ==\n` + result.csv);
    if (result.flags && result.flags.length) console.log("flags: " + result.flags.join(" | "));
  } else {
    console.error('ERROR: ' + result.error);
  }
  process.exit(result.ok ? 0 : 1);
}

server.listen(opt.port, () => {
  const st = fs.statSync(video);
  const q = new URLSearchParams({ name: path.basename(video), lm: String(Math.round(st.mtimeMs)) });
  if (opt.rect) {
    // 実ピクセル → 割合。動画の実サイズは ffmpeg 無しでは取れないので、割合そのものも受け付ける（1以下ならそのまま）
    const [x, y, w, h] = opt.rect.split(',').map(Number);
    if (w <= 1 && h <= 1) q.set('rect', [x, y, w, h].join(','));
    else {
      const base = opt.base ? opt.base.split('x').map(Number) : null;
      // 既定の基準は 1280x720 / 1920x1080 のどちらか: 幅と高さが収まる小さい方
      const [BW, BH] = base || (x + w <= 1280 && y + h <= 720 ? [1280, 720] : [1920, 1080]);
      q.set('rect', [x / BW, y / BH, w / BW, h / BH].join(','));
    }
  }
  const url = `http://localhost:${opt.port}/tools/headless-analyze.html?${q}`;
  const udd = path.join(require('os').tmpdir(), 'senseki-headless-' + process.pid);
  chromeProc = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1500,1000', `--user-data-dir=${udd}`,
    ...(opt.debug ? ['--enable-logging=stderr', '--v=0'] : []), url], { stdio: ['ignore', 'ignore', opt.debug ? 'pipe' : 'ignore'] });
  if (opt.debug) chromeProc.stderr.on('data', d => { for (const l of String(d).split('\n')) if (/CONSOLE|ERROR/.test(l) && !/HKLM|registry/.test(l)) console.error('[chrome] ' + l.trim()); });
  chromeProc.on('exit', () => { if (!result) setTimeout(() => finish(), 500); });
  setTimeout(() => finish(), opt.timeout * 1000);
  console.error('headless: ' + url);
});
