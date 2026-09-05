# SENSEKI SCAN

Mario Tennis Fever の対戦録画（キャプチャーボード等の長尺MP4）から対戦情報を自動抽出し、
SENSEKI FEVER の CSV 一括登録フォーマットで出力する Windows ローカルアプリ。

## ダウンロード（利用者向け）

- **[最新版をダウンロード](https://github.com/games-desu/senseki-scan/releases/latest)**（`SENSEKI-SCAN-Setup-<バージョン>.exe`）
- インストール手順・使い方 → **[利用マニュアル](docs/manual.md)**
- 以下は開発者向けの情報です

**現在の実装ステータスと残タスクは → [docs/STATUS.md](docs/STATUS.md)**（下のロードマップ表より新しい）

## ハイライト生成（v1.0.0〜）

録画から得点シーンを自動で切り抜いてMP4に保存（得点直前N秒／ラリー全体／試合ごとのダイジェスト）。
ポイント間のスコアバナーなどプレイヤー名が映る画面は自動で除外する。詳細は `docs/highlight.md`、使い方は `docs/manual.md`。

## 推奨録画設定

- 解像度 **1080p以上**（1080p/1440p実証済み）・フレームレート **30fps以上**・ビットレート **6〜12Mbps推奨**（それ以上でも解析できますが、時間が長くかかります）
- **OBS等の元録画をそのまま使う**こと。編集ソフトで再エンコードした動画は桁落ち・カット欠損の実例あり
  （→ docs/csv-accuracy-*.md）

## ロードマップ

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | サンプル録画の収集・画面仕様化（→ docs/screens.md） | **完了 2026-08-20** |
| 1 | 認識エンジン試作（analyzer.html・クラシックシングルス） | **完了 2026-08-20** — サンプル3試合でDB登録値と全項目一致 |
| 2 | Electron アプリ化（D&D・一括処理・確認画面・CSV出力） | **完了 2026-08-21** — app/ 参照。複数動画バッチ・辞書マージ(同梱+ユーザー)・ネイティブ保存 |
| 3 | インストーラー / 自動アプデ(electron-updater) / クリーンアンインストール | 進行中 — インストーラーv0.2.2ビルド済み・**v0.3.0でアプリアイコン(app/build/icon.ico)＋教えるUI(修正→ユーザー辞書学習)追加**。残=electron-updater |

対応順: クラシックシングルス → クラシックダブルス → フィーバー（ラケット認識を後回しにして検証を軽くする）

## フォルダ構成

- `tools/vision.js` — 認識コア（シーン分類・fillinkグリフ分割・テンプレ照合・ステイルフレーム対策シーカー）
- `tools/analyzer.html` — 動画→CSV試作機（要 http-server。launch.json `senseki-capture-static` ポート4760 + `?src=`）
- `tools/harvest.html` — DB正解ラベルからテンプレートを収穫（動画が増えたら育てる）
- `tools/frame-server.js` — 開発用保存サーバー（ポート4761・ブラウザからPNG/JSON書き出し）
- `tools/frame-lab.html` — フレーム観察・切り出しツール（ブラウザ完結）
- `samples/frames/templates.json` — 収穫済みテンプレート（数字0-9※2なし・アイコン・コート・mode）
- `docs/screens.md` — 画面仕様・抽出座標・実装知見の正
- `docs/release.md` — リリース手順（GitHub Releases + electron-updater 自動更新）

## frame-lab の使い方

1. `frame-lab.html` を Chrome で開く（ダブルクリックでOK・アップロードなしのローカル完結）
2. 録画ファイルを D&D → 「全体をサムネイル走査」で全体像を把握
3. 気になる画面へジャンプ → ←/→ でコマ送り → C キーでフレーム記録
4. ラベル（例: キャラ選択 / リザルト / レート表示）を付けて「PNG一括保存」
5. 保存した PNG + JSON を `samples/` に置いて Claude と共有

## 出力先CSVの仕様（SENSEKI FEVER 側）

`mario-tennis-records/app/matches/import/page.tsx` の `CSV_HEADERS` が正。
必須: played_at / mode / my_character / opponent1_character / court / result / rating_before / rating_after
（クラシックではラケット列は不使用。played_at は録画ファイルの日時から自動化予定）
