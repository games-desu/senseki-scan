# リリース手順（自動アップデート対応・v0.3.0〜）

アプリは起動時に GitHub Releases の `latest.yml` を確認し、新版があればバックグラウンドでDL→
**アプリを閉じたときに自動適用**する（electron-updater / `app/main.js`）。
配信元は `app/package.json` の `build.publish` = `games-desu/senseki-scan`。

## 初回だけの準備

1. ~~GitHub に公開リポジトリ senseki-scan を作る~~ → **作成済み(2026-08-27)** https://github.com/games-desu/senseki-scan
   - **public 必須**。electron-updater はトークンなしで latest.yml を読むため、私有リポだと全ユーザーが更新確認に失敗する。
   - ソースを置きたくなければ**空のままでよい**（Releases だけ使う）。README 1枚でも可。
2. Personal Access Token を作る（Settings → Developer settings → Tokens (classic) → `repo` スコープ）。
   ビルド時の `GH_TOKEN` に使う。アプリには埋め込まれない（アップロード専用）。

## 毎回のリリース手順（実ターミナルで）

```powershell
cd C:\Users\<user>\Documents\senseki-capture\app
# 1. package.json の "version" を上げる（例 0.3.0 → 0.3.1）
# 2. ビルド＋GitHub Releases へアップロード（draftとして作られる）
$env:GH_TOKEN='ghp_xxxxxxxxxxxxxxxx'   # PowerShellでは set は不可（$env: 必須）
npx electron-builder --win --publish always
# 3. GitHub の Releases ページで draft を確認して「Publish release」
```

publish される3点セット（すべて必要）:
- `SENSEKI-SCAN-Setup-<version>.exe` — インストーラー本体
- `SENSEKI-SCAN-Setup-<version>.exe.blockmap` — 差分DL用
- `latest.yml` — 更新チェックの起点（これが無いと更新が検出されない）

手動アップロードでも可（`app/dist/` の上記3ファイルを Release に添付）。v0.3.0 はこの方法で公開済み(2026-08-28)。
注意: cmd式 `set GH_TOKEN=...` をPowerShellで実行すると環境変数が設定されず、publishが黙ってスキップされる。
タグ名は `v<version>`（例 `v0.3.1`）にすること。

### 3点セットは「同じビルド」で揃える（最重要）

**exe だけを後から差し替えてはいけない。** `latest.yml` には exe の sha512 とバイト数が
焼き込まれており、electron-updater はDL後に必ずそれを照合する。ビルドし直した exe だけを
上げ直すと、`latest.yml` と `blockmap` は前のビルドのままになり、全ユーザーの更新が

```
更新のダウンロードに失敗しました
sha512 checksum mismatch, expected <latest.ymlの値> got <実ファイルの値>
```

で100%失敗する。exe は正常でも latest.yml がズレているだけでこうなる。
再ビルドしたら **exe / blockmap / latest.yml の3つとも** 同じ `app/dist/` から上げ直すこと。

実例: v0.3.11 で exe のみ約8時間後に差し替え（latest.yml と blockmap は前ビルドのまま）→
全ユーザーが更新不能になった(2026-08-30)。

### 公開前・公開後のチェック

```powershell
node tools/verify-release.js --local     # アップロード前: app/dist/ の3点セットを照合
node tools/verify-release.js             # 公開後: 実際のReleaseをDLして照合
node tools/verify-release.js 0.3.11      # バージョン指定
```

3点セットが同一ビルドなら `OK` / 終了コード0。ズレていれば不一致の内訳と
**本来あるべき latest.yml の中身**を出力するので、それを Release に添付し直せば復旧できる
（ずれた blockmap は削除してよい。差分DLが効かず全体DLになるだけで無害）。

## 動作の流れ（ユーザー側）

1. アプリ起動 → 数秒後に裏で更新確認（失敗しても無害・オフラインOK）
2. 新版があれば自動DL → 完了時に通知＋アプリ内ログに
   「[更新] 新しいバージョン vX.Y.Z をダウンロードしました。アプリを閉じると自動で更新されます」
3. アプリ終了時にインストーラーがサイレント実行され、次回起動から新版

## 注意

- 未署名exeのため、初回インストール時と同様 SmartScreen 警告は出続ける（自動更新の適用自体は出ない）
- `package.json` の `name: "senseki-capture"` と `appId` は**据え置き厳守**
  （ユーザー辞書 `%APPDATA%/senseki-capture/` が孤立するため）。GitHub リポジトリ名とは無関係。
- 開発起動（`npm start`）では更新チェックは走らない（未パッケージ時は electron-updater が自動スキップ）
