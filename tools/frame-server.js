// フレーム保存用ミニサーバー: ブラウザから POST された PNG(dataURL) をファイルに書く
// 使い方: node frame-server.js → POST http://localhost:4761/save {name, dataUrl}
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'samples', 'frames');
fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name, dataUrl } = JSON.parse(body);
        const safe = String(name).replace(/[^\w.\-]/g, '_');
        const b64 = dataUrl.split(',')[1];
        fs.writeFileSync(path.join(OUT, safe), Buffer.from(b64, 'base64'));
        res.end(JSON.stringify({ ok: true, file: safe }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }
  res.statusCode = 404;
  res.end('not found');
}).listen(4761, () => console.log('frame-server on 4761, out=' + OUT));
