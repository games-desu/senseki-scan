# SENSEKI SCAN — デスクトップアプリ (Phase 2)

対戦録画（MP4）をドラッグ&ドロップ → 全部門自動識別で解析 → 確認・修正 → SENSEKI FEVER「CSV一括登録」形式で保存。

## 起動方法（開発版）

`起動_SENSEKI_SCAN.bat` をダブルクリック。
（初回のみElectron本体のダウンロードが走ります。Node.jsが必要）

または:

```bash
cd app
npm install
npm start
```

## 構成

- `main.js` — メインプロセス。辞書の読み込み（同梱`assets/templates.json`＋ユーザー辞書`%APPDATA%/senseki-capture/templates-user.json`のマージ）、CSV保存ダイアログ
- `preload.js` — IPCブリッジ（loadTemplates / saveCsv / appendUserTemplates / appVersion）
- `renderer/` — 画面＋認識エンジン（`tools/analyzer.html`由来。**window.api が無いブラウザではdevフォールバックで動く**ので、`http://localhost:4760/app/renderer/index.html` でそのまま開発・検証できる）
- `assets/templates.json` — 同梱辞書（tools/harvest.htmlで育てたスナップショット）
- `renderer/rally.js` / `renderer/highlight.js` / `renderer/hl-ui.js` — ハイライト生成（得点シーンの切り抜き・docs/highlight.md）。切り抜きは `ffmpeg-static`（同梱・GPL・asarUnpack）を main.js が子プロセスで呼ぶ。`npm install` 後に exe が無ければ `node node_modules/ffmpeg-static/install.js`

## 辞書の更新フロー

1. `tools/harvest.html` で新しい動画から収穫（samples/frames/templates.json が更新される）
2. `cp samples/frames/templates.json app/assets/templates.json` で同梱辞書を更新
3. 将来: アプリ内の確認画面でユーザーが正解を教えたらユーザー辞書（templates-user.json）へ自動追記（IPCは実装済み・UI未実装）

## インストーラー（Phase 3・ビルド可能）

`npm run dist` で NSIS インストーラーを生成できる（2026-08-26 に v0.2.0 をビルド済み → `dist/SENSEKI-SCAN-Setup-0.2.0.exe`）:
- `oneClick: false`（インストール先選択可）
- アンインストール時は**ユーザー辞書を消すかどうかを本人に確認**（installer.nsh。既定は「残す」＝再インストールで引き継がれる）
- アプリアイコンは未設定（Electron既定アイコン）
- 自動アップデート（electron-updater + GitHub Releases）は未実装（配布方法が決まったら）

## 注意

- Claude(開発環境)のサンドボックスは実行ファイルの書き込みをブロックするため、`npm install`によるElectronバイナリ展開は**ユーザーの実ターミナルで行う**必要がある（zipのDLまでは成功し、展開のみ失敗する）
