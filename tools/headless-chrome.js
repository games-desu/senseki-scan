// headless-analyze.js / headless-eval.js 共通: 一時プロファイル（--user-data-dir）で headless Chrome を起こし、
// 終了時（正常終了・例外・Ctrl+C）に Chrome を落としてからプロファイルを消す。
// 以前は消しておらず、動画のメディアキャッシュ込みで 1 回 5〜9GB が %TEMP% に残っていた（2026-10-15 に約55GB）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// prefix: 'senseki-headless-' など（後ろに pid を付ける）。args は Chrome の追加引数（URL を最後に）
function launchChrome(chrome, prefix, args, spawnOpts) {
  const udd = path.join(os.tmpdir(), prefix + process.pid);
  const proc = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1500,1000', `--user-data-dir=${udd}`,
    // 動画は localhost から読むだけなのでキャッシュは要らない（プロファイルが膨らむ主因）
    '--disk-cache-size=1', '--media-cache-size=1', ...args], spawnOpts);
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    // renderer/GPU の子プロセスがプロファイルを掴んだままだと消せないので、ツリーごと落とす
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { proc.kill('SIGKILL'); } catch {} }
    for (let i = 0; i < 20; i++) { // ロック解除待ち（最大約5秒）
      try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
      if (!fs.existsSync(udd)) return;
      sleepSync(250);
    }
    console.error('warn: 一時プロファイルを消せませんでした: ' + udd);
  }
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });
  process.on('uncaughtException', e => { console.error(e); cleanup(); process.exit(1); });
  return { proc, udd, cleanup };
}

module.exports = { launchChrome };
