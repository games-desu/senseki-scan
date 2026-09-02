// SENSEKI SCAN — Electron メインプロセス
// 役割: ウィンドウ生成 / 辞書(テンプレート)の読み込み・ユーザー辞書のマージ / CSV保存ダイアログ / 自動更新
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 940,
    title: 'SENSEKI SCAN',
    icon: path.join(__dirname, 'assets', 'icon.png'), // dev起動時のウィンドウアイコン（配布exeはbuild/icon.ico）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  // 自動更新: GitHub Releases (build.publish の repo) の latest.yml を確認し、新版があれば
  // ダイアログで「今すぐ更新 / あとで / このバージョンをスキップ」を選ばせる（更新内容=Releaseの説明文を表示）。
  // 開発起動(未パッケージ)では何もしない。失敗（オフライン等）は無害なのでログに留める
  autoUpdater.autoDownload = false;
  const updaterStatePath = () => path.join(app.getPath('userData'), 'updater.json');
  const loadUpdaterState = () => { try { return JSON.parse(fs.readFileSync(updaterStatePath(), 'utf8')); } catch { return {}; } };
  autoUpdater.on('update-available', async info => {
    if (loadUpdaterState().skipVersion === info.version) return;
    // Releaseの説明文（GitHubはHTML・手動時はmarkdownの可能性）→ ダイアログ向けに「・」箇条書き化
    let notes = info.releaseNotes || '';
    if (Array.isArray(notes)) notes = notes.map(n => n.note || '').join('\n');
    notes = String(notes)
      .replace(/<li[^>]*>/gi, '\n・')
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<\/(p|div|ul|ol|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/^[ \t]*[-*]\s+/gm, '・')
      .replace(/[#`]/g, '')
      .split('\n').map(s => s.trim()).join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (notes.length > 1200) notes = notes.slice(0, 1200) + '…';
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'アップデート',
      message: `新しいバージョン v${info.version} があります（現在 v${app.getVersion()}）`,
      detail: notes ? '更新内容:\n' + notes : undefined,
      buttons: ['今すぐ更新', 'あとで', 'このバージョンをスキップ'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      autoUpdater.downloadUpdate().catch(e => {
        dialog.showMessageBox(win, { type: 'error', title: 'アップデート', message: '更新のダウンロードに失敗しました', detail: String(e && e.message || e) });
      });
    } else if (response === 2) {
      fs.writeFileSync(updaterStatePath(), JSON.stringify({ skipVersion: info.version }));
    }
  });
  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'アップデート',
      message: `v${info.version} のダウンロードが完了しました`,
      buttons: ['再起動して更新', 'アプリ終了時に適用'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) { autoUpdater.quitAndInstall(); return; }
    if (win && !win.isDestroyed()) win.webContents.send('update-downloaded', info.version);
  });
  autoUpdater.on('error', e => console.error('autoUpdater:', e == null ? '' : (e.message || e)));
  autoUpdater.checkForUpdates().catch(() => {});
});
app.on('window-all-closed', () => app.quit());

// 辞書: 同梱(assets/templates.json) + ユーザー辞書(userData/templates-user.json)をセットごとに連結
ipcMain.handle('load-templates', async () => {
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'templates.json'), 'utf8'));
  const userPath = path.join(app.getPath('userData'), 'templates-user.json');
  if (fs.existsSync(userPath)) {
    try {
      const user = JSON.parse(fs.readFileSync(userPath, 'utf8'));
      for (const [k, arr] of Object.entries(user.sets ?? {})) {
        if (!bundled.sets[k]) bundled.sets[k] = [];
        bundled.sets[k].push(...arr);
      }
    } catch (e) { console.error('user templates load failed:', e); }
  }
  return bundled;
});

// 将来の「教える」機能用: レビューでユーザーが確定したテンプレートをユーザー辞書へ追記
ipcMain.handle('append-user-templates', async (ev, sets) => {
  const userPath = path.join(app.getPath('userData'), 'templates-user.json');
  let user = { sets: {} };
  if (fs.existsSync(userPath)) {
    try { user = JSON.parse(fs.readFileSync(userPath, 'utf8')); } catch {}
  }
  for (const [k, arr] of Object.entries(sets ?? {})) {
    if (!user.sets[k]) user.sets[k] = [];
    user.sets[k].push(...arr);
  }
  fs.writeFileSync(userPath, JSON.stringify(user));
  return { ok: true, path: userPath };
});

// 設定・相手名履歴などの小さなユーザーデータ(userData/<key>.json)
ipcMain.handle('load-user-data', async (ev, key) => {
  if (!/^[a-z0-9-]+$/.test(key)) return null;
  const p = path.join(app.getPath('userData'), key + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
});
ipcMain.handle('save-user-data', async (ev, key, data) => {
  if (!/^[a-z0-9-]+$/.test(key)) return { ok: false };
  const p = path.join(app.getPath('userData'), key + '.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return { ok: true, path: p };
});

ipcMain.handle('save-csv', async (ev, defaultName, content) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'CSVを保存',
    defaultPath: defaultName,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, '﻿' + content, 'utf8'); // Excel向けBOM付きUTF-8
  return { ok: true, path: filePath };
});

// 外部リンク（バグ報告先・SENSEKI FEVERの一括登録ページ）
ipcMain.handle('open-external', (ev, url) => {
  if (/^https:[/][/]/.test(String(url))) shell.openExternal(String(url));
  return { ok: true };
});

// バグレポート等のテキスト保存
ipcMain.handle('save-text', async (ev, defaultName, content) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'レポートを保存',
    defaultPath: defaultName,
    filters: [{ name: 'テキスト', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, '﻿' + content, 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('app-version', () => app.getVersion());

// ---- ハイライト生成: 同梱ffmpeg（ffmpeg-static）で切り抜き・連結 ----
// バイナリは asar に入れると exec できないため build.asarUnpack で外に出す（パスを app.asar.unpacked に読み替える）。
// 入力の動画パスは renderer が webUtils.getPathForFile で得たもの。出力先はユーザーがダイアログで選んだフォルダ配下。
function ffmpegPath() {
  let p = null;
  try { p = require('ffmpeg-static'); } catch (e) { return null; }
  if (!p) return null;
  p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return fs.existsSync(p) ? p : null;
}
const ffJobs = new Map(); // jobId → ChildProcess

function runFfmpeg(jobId, args, onProgress) {
  return new Promise((resolve) => {
    const bin = ffmpegPath();
    if (!bin) { resolve({ ok: false, error: 'ffmpeg が見つかりません（同梱に失敗しています）' }); return; }
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true });
    ffJobs.set(jobId, p);
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
    p.on('error', e => { ffJobs.delete(jobId); resolve({ ok: false, error: String(e && e.message || e) }); });
    p.on('close', code => { ffJobs.delete(jobId); resolve({ ok: code === 0, code, error: code === 0 ? '' : (err.trim() || 'ffmpeg exit ' + code) }); });
  });
}

ipcMain.handle('hl-ffmpeg-available', () => !!ffmpegPath());

ipcMain.handle('hl-pick-dir', async (ev, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'ハイライトの保存先フォルダ',
    defaultPath: defaultPath || app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths || !filePaths[0]) return null;
  return filePaths[0];
});

// 1本切り抜く: {jobId, input, start, duration, out, crop:{x,y,w,h}|null, maxH, preset, crf}
// -ss を -i の前に置き再エンコードするので、キーフレーム位置に関係なくフレーム単位で正確に切れる
ipcMain.handle('hl-cut', async (ev, job) => {
  const vf = [];
  if (job.crop) vf.push(`crop=${job.crop.w}:${job.crop.h}:${job.crop.x}:${job.crop.y}`);
  if (job.maxH) vf.push(`scale=-2:'min(ih,${job.maxH})'`);
  const args = [
    '-ss', String(job.start), '-i', job.input, '-t', String(job.duration),
    '-map', '0:v:0', '-map', '0:a:0?',
    ...(vf.length ? ['-vf', vf.join(',')] : []),
    '-c:v', 'libx264', '-preset', job.preset || 'veryfast', '-crf', String(job.crf ?? 18), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', job.out,
  ];
  const r = await runFfmpeg(job.jobId, args, t => { if (win && !win.isDestroyed()) win.webContents.send('hl-progress', { jobId: job.jobId, t, duration: job.duration }); });
  return { ...r, path: job.out };
});

// 同一設定で切った複数クリップを再エンコードなしで連結: {jobId, files:[...], out}
ipcMain.handle('hl-concat', async (ev, job) => {
  const listPath = path.join(app.getPath('temp'), `senseki-hl-${process.pid}-${Date.now()}.txt`);
  const esc = f => "file '" + String(f).replace(/'/g, "'\''") + "'";
  fs.writeFileSync(listPath, job.files.map(esc).join('\n') + '\n', 'utf8');
  try {
    const r = await runFfmpeg(job.jobId, ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', '-y', job.out]);
    return { ...r, path: job.out };
  } finally { try { fs.unlinkSync(listPath); } catch {} }
});

ipcMain.handle('hl-cancel', (ev, jobId) => {
  const p = ffJobs.get(jobId);
  if (p) { try { p.kill(); } catch {} }
  return { ok: !!p };
});

// 一時クリップ置き場（ダイジェストだけ欲しいときの中間ファイル）
ipcMain.handle('hl-temp-dir', () => {
  const d = path.join(app.getPath('temp'), 'senseki-scan-highlight');
  fs.mkdirSync(d, { recursive: true });
  return d;
});
ipcMain.handle('hl-remove', (ev, files) => {
  for (const f of files || []) { try { fs.unlinkSync(f); } catch {} }
  return { ok: true };
});
ipcMain.handle('hl-exists', (ev, p) => fs.existsSync(String(p)));
ipcMain.handle('hl-open-path', (ev, p) => { shell.openPath(String(p)); return { ok: true }; });

