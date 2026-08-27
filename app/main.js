// SENSEKI SCAN — Electron メインプロセス
// 役割: ウィンドウ生成 / 辞書(テンプレート)の読み込み・ユーザー辞書のマージ / CSV保存ダイアログ / 自動更新
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
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
  // バックグラウンドでDL→アプリ終了時に自動適用。開発起動(未パッケージ)では何もしない。
  // 失敗（オフライン・リポジトリ未作成等）は無害なのでログに留める
  autoUpdater.on('update-downloaded', info => {
    if (win && !win.isDestroyed()) win.webContents.send('update-downloaded', info.version);
  });
  autoUpdater.on('error', e => console.error('autoUpdater:', e == null ? '' : (e.message || e)));
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
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

ipcMain.handle('app-version', () => app.getVersion());
