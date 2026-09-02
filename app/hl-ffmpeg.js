// SENSEKI SCAN ハイライト生成 — 同梱 ffmpeg の呼び出し（メインプロセス用・Electron 非依存なので node 単体でテストできる）
// 役割: 切り抜き（再エンコード・フレーム正確）／連結（copy）／トランジション付き連結（xfade + acrossfade）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// バイナリは asar に入れると exec できないため build.asarUnpack で外に出す（パスを app.asar.unpacked に読み替える）
function ffmpegPath() {
  let p = null;
  try { p = require('ffmpeg-static'); } catch (e) { return null; }
  if (!p) return null;
  p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return fs.existsSync(p) ? p : null;
}

const jobs = new Map(); // jobId → ChildProcess

// 共通の映像/音声エンコード設定（切り抜きと連結で同じにする＝copy連結の前提）
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
             '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart'];

function run(jobId, args, onProgress) {
  return new Promise((resolve) => {
    const bin = ffmpegPath();
    if (!bin) { resolve({ ok: false, error: 'ffmpeg が見つかりません（同梱に失敗しています）' }); return; }
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true });
    jobs.set(jobId, p);
    let err = '', outBuf = '';
    p.stdout.on('data', d => {
      outBuf += d.toString();
      let i;
      while ((i = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, i).trim(); outBuf = outBuf.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onProgress) onProgress(+m[1] / 1e6);
      }
    });
    p.stderr.on('data', d => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', e => { jobs.delete(jobId); resolve({ ok: false, error: String(e && e.message || e) }); });
    p.on('close', code => { jobs.delete(jobId); resolve({ ok: code === 0, code, error: code === 0 ? '' : (err.trim() || 'ffmpeg exit ' + code) }); });
  });
}
function cancel(jobId) {
  // 階層連結の子ジョブ（jobId-0, jobId-1 …）もまとめて止める
  let n = 0;
  for (const [id, p] of jobs) if (id === jobId || id.startsWith(jobId + '-')) { try { p.kill(); n++; } catch {} }
  return n > 0;
}

// 長さと音声の有無（ffprobe は同梱していないので ffmpeg -i の出力から読む。長さの精度は 0.01秒）
function probe(file) {
  return new Promise(res => {
    const bin = ffmpegPath();
    if (!bin) { res({ duration: 0, hasAudio: false }); return; }
    const p = spawn(bin, ['-hide_banner', '-i', file], { windowsHide: true });
    let s = '';
    p.stderr.on('data', d => s += d);
    p.on('close', () => {
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
      res({ duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : 0, hasAudio: /Stream #\d+:\d+.*Audio:/.test(s) });
    });
  });
}

// 1本切り抜く: {jobId, input, start, duration, out, crop:{x,y,w,h}|null, maxH}
// -ss を -i の前に置き再エンコードするので、キーフレーム位置に関係なくフレーム単位で正確に切れる
function cut(job, onProgress) {
  const vf = [];
  if (job.crop) vf.push(`crop=${job.crop.w}:${job.crop.h}:${job.crop.x}:${job.crop.y}`);
  if (job.maxH) vf.push(`scale=-2:'min(ih,${job.maxH})'`);
  const args = [
    '-ss', String(job.start), '-i', job.input, '-t', String(job.duration),
    '-map', '0:v:0', '-map', '0:a:0?',
    ...(vf.length ? ['-vf', vf.join(',')] : []),
    ...ENC, '-avoid_negative_ts', 'make_zero', '-y', job.out,
  ];
  return run(job.jobId, args, onProgress);
}

// 同一設定で切ったクリップを再エンコードなしで連結（つなぎ目はカット）
async function concatCopy(jobId, files, out, tmpDir) {
  const listPath = path.join(tmpDir, `senseki-hl-${process.pid}-${Date.now()}.txt`);
  const esc = f => "file '" + String(f).replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(listPath, files.map(esc).join('\n') + '\n', 'utf8');
  try {
    return await run(jobId, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', '-y', out]);
  } finally { try { fs.unlinkSync(listPath); } catch {} }
}

// トランジション付き連結（xfade / acrossfade）。全入力を同時に開くので、多いときは CHUNK 本ずつ中間ファイルに
// まとめてから段階的に繋ぐ（つなぎ目のトランジションは上の段で付くので抜けない）。
// transition: {type:'fade'|'fadeblack'|'wipeleft'|'slideleft'|..., duration: 秒}
const CHUNK = 10;
async function joinTransition(jobId, files, out, transition, onProgress, tmpDir, depth = 0) {
  if (files.length === 1) return concatCopy(jobId, files, out, tmpDir);
  if (files.length > CHUNK) {
    const parts = [];
    try {
      for (let i = 0; i < files.length; i += CHUNK) {
        const tmp = path.join(tmpDir, `senseki-join-${process.pid}-${jobId}-${depth}-${i}.mp4`);
        const r = await joinTransition(`${jobId}-${depth}-${i}`, files.slice(i, i + CHUNK), tmp, transition, null, tmpDir, depth + 1);
        if (!r.ok) return r;
        parts.push(tmp);
        if (onProgress) onProgress(-1, `${Math.min(i + CHUNK, files.length)}/${files.length}`); // 進捗（本数）
      }
      return await joinTransition(jobId, parts, out, transition, onProgress, tmpDir, depth + 1);
    } finally { for (const p of parts) { try { fs.unlinkSync(p); } catch {} } }
  }
  const infos = [];
  for (const f of files) infos.push(await probe(f));
  const D = Math.max(0.1, Math.min(2, +transition.duration || 0.5));
  const type = /^[a-z]+$/.test(transition.type || '') ? transition.type : 'fade';
  const hasAudio = infos.every(i => i.hasAudio);
  // xfade の offset は「ここまでの出力の長さ − D」。長さは 0.01秒精度なので少し手前に置いて超過を避ける
  let fc = '', vprev = '[0:v]', aprev = '[0:a]', acc = 0, total = 0;
  for (let k = 1; k < files.length; k++) {
    acc += Math.max(D + 0.05, infos[k - 1].duration - 0.02);
    const off = +(acc - k * D).toFixed(3);
    fc += `${vprev}[${k}:v]xfade=transition=${type}:duration=${D}:offset=${off}[v${k}];`;
    if (hasAudio) fc += `${aprev}[${k}:a]acrossfade=d=${D}:c1=tri:c2=tri[a${k}];`;
    vprev = `[v${k}]`; aprev = `[a${k}]`;
  }
  total = infos.reduce((a, i) => a + i.duration, 0) - (files.length - 1) * D;
  const args = [];
  for (const f of files) args.push('-i', f);
  args.push('-filter_complex', fc.replace(/;$/, ''), '-map', vprev);
  if (hasAudio) args.push('-map', aprev);
  args.push(...ENC, '-y', out);
  return run(jobId, args, t => { if (onProgress) onProgress(t / Math.max(1, total)); });
}

module.exports = { ffmpegPath, run, cancel, probe, cut, concatCopy, joinTransition, ENC, CHUNK };
