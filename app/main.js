// SENSEKI SCAN — Electron メインプロセス
// 役割: ウィンドウ生成 / 辞書(テンプレート)の読み込み・ユーザー辞書のマージ / CSV保存ダイアログ / 自動更新
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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
