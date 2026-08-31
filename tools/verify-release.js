// リリース成果物の整合性チェック（sha512 checksum mismatch の再発防止）
//   node tools/verify-release.js            … app/package.json の version を公開リリースと照合
//   node tools/verify-release.js 0.3.11     … バージョン指定で公開リリースを照合
//   node tools/verify-release.js --local    … アップロード前に app/dist/ の3点セットを照合
//
// electron-updater は latest.yml に書かれた sha512/size と実ファイルを突き合わせる。
// exe だけ差し替えて latest.yml / blockmap を上げ直さないと、ユーザーの更新が
// 「sha512 checksum mismatch」で必ず失敗する（v0.3.11 で実際に発生）。
// 不一致なら「本来あるべき latest.yml」を出力するので、それを Release に添付し直せば直る。
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const REPO = 'games-desu/senseki-scan';
const APP_DIR = path.join(__dirname, '..', 'app');
const DIST_DIR = path.join(APP_DIR, 'dist');
const sha512b64 = buf => crypto.createHash('sha512').update(buf).digest('base64');
const exeName = v => `SENSEKI-SCAN-Setup-${v}.exe`;

// latest.yml のうち検証に要る3項目だけ拾う（YAMLパーサを足さないための割り切り）
function parseLatestYml(text) {
  const pick = re => (text.match(re) || [])[1];
  return {
    version: pick(/^version:\s*(\S+)/m),
    path: pick(/^path:\s*(.+?)\s*$/m),
    sha512: pick(/^sha512:\s*(\S+)/m),
    size: Number(pick(/^\s+size:\s*(\d+)/m)),
  };
}

function buildLatestYml({ version, file, sha512, size, releaseDate }) {
  return `version: ${version}\n`
    + `files:\n`
    + `  - url: ${file}\n`
    + `    sha512: ${sha512}\n`
    + `    size: ${size}\n`
    + `path: ${file}\n`
    + `sha512: ${sha512}\n`
    + `releaseDate: '${releaseDate || new Date().toISOString()}'\n`;
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('リダイレクトが多すぎます: ' + url));
    https.get(url, { headers: { 'user-agent': 'senseki-scan-verify' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// blockmap は差分DL用。中身は gzip された JSON で、sizes の総和 = 対象exeのバイト数。
// これが exe と食い違うと差分DLが無駄撃ちになるので同時に見る。
function blockmapTotal(buf) {
  try {
    const j = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    return (j.files || []).reduce((t, f) => t + (f.sizes || []).reduce((a, b) => a + b, 0), 0);
  } catch {
    return null;
  }
}

function report({ version, yml, exeBuf, blockmapBuf, releaseDate, source }) {
  const file = exeName(version);
  const realSha = sha512b64(exeBuf);
  const realSize = exeBuf.length;
  const problems = [];

  console.log(`[${source}] v${version}`);
  console.log(`  exe 実測      : size=${realSize} sha512=${realSha}`);
  console.log(`  latest.yml 記載: size=${yml.size} sha512=${yml.sha512}`);

  if (yml.version !== version) problems.push(`latest.yml の version が ${yml.version}（期待 ${version}）`);
  if (yml.path !== file) problems.push(`latest.yml の path が ${yml.path}（期待 ${file}）`);
  if (yml.size !== realSize) problems.push(`size 不一致: 記載 ${yml.size} / 実測 ${realSize}`);
  if (yml.sha512 !== realSha) problems.push(`sha512 不一致 ← これが「sha512 checksum mismatch」の正体`);

  if (blockmapBuf) {
    const total = blockmapTotal(blockmapBuf);
    if (total == null) problems.push('blockmap を解析できません（壊れている可能性）');
    else {
      console.log(`  blockmap 対象 : size=${total}`);
      if (total !== realSize) problems.push(`blockmap が別ビルド由来: 対象 ${total} / 実測 ${realSize}`);
    }
  } else {
    console.log('  blockmap      : なし（差分DLは使われず全体DLになるだけで無害）');
  }

  if (!problems.length) {
    console.log('  => OK: 3点セットは同一ビルドで整合しています');
    return true;
  }
  console.log('  => NG:');
  for (const p of problems) console.log('     - ' + p);
  console.log('\n  正しい latest.yml は以下の内容です。これを latest.yml として Release に添付し直し、');
  console.log('  ずれている blockmap は削除するか同じビルドのものに差し替えてください。\n');
  console.log(buildLatestYml({ version, file, sha512: realSha, size: realSize, releaseDate }).replace(/^/gm, '    '));
  return false;
}

async function verifyLocal(version) {
  const exePath = path.join(DIST_DIR, exeName(version));
  const ymlPath = path.join(DIST_DIR, 'latest.yml');
  for (const p of [exePath, ymlPath]) {
    if (!fs.existsSync(p)) throw new Error(`見つかりません: ${p}（先に npm run dist を実行してください）`);
  }
  const bmPath = exePath + '.blockmap';
  return report({
    version,
    yml: parseLatestYml(fs.readFileSync(ymlPath, 'utf8')),
    exeBuf: fs.readFileSync(exePath),
    blockmapBuf: fs.existsSync(bmPath) ? fs.readFileSync(bmPath) : null,
    source: 'local app/dist',
  });
}

async function verifyRelease(version) {
  const base = `https://github.com/${REPO}/releases/download/v${version}`;
  const ymlText = (await get(`${base}/latest.yml`)).toString('utf8');
  const yml = parseLatestYml(ymlText);
  console.log(`  ${exeName(version)} を取得中（約95MB・少し時間がかかります）…`);
  const exeBuf = await get(`${base}/${encodeURIComponent(exeName(version))}`);
  let blockmapBuf = null;
  try {
    blockmapBuf = await get(`${base}/${encodeURIComponent(exeName(version))}.blockmap`);
  } catch { /* blockmap は任意 */ }
  return report({
    version,
    yml,
    exeBuf,
    blockmapBuf,
    releaseDate: (ymlText.match(/^releaseDate:\s*'(.+)'/m) || [])[1],
    source: 'GitHub Release',
  });
}

(async () => {
  const args = process.argv.slice(2);
  const local = args.includes('--local');
  const version = args.find(a => /^\d+\.\d+\.\d+$/.test(a))
    || JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const ok = local ? await verifyLocal(version) : await verifyRelease(version);
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error('エラー:', e.message);
  process.exit(2);
});
