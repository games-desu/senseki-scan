# v0.4.0 リリースノート（下書き・2026-09-05）

GitHub Releases の説明欄にそのまま貼る用（1行=1項目。アプリの更新ダイアログにそのまま表示される）。

## 説明欄に貼る文

```
ハイライト生成を追加: 録画から得点シーンを自動で切り抜いてMP4に保存（得点前N秒／ラリー全体／試合ごと・区間の手直し・1本に繋げる・つなぎ目のトランジション・自分のキャラのバッジ表示）
プレイヤー名が映る画面（ポイント間のスコアバナー・VS・勝敗）はハイライトに映さない
キャラ辞書を全64種そろえた（VS画面・勝敗パネル・ダブルスの3種すべて）。ラケット30種・コート16種も収穫済み
VS画面のキャラ照合でカード外の背景を除外し、取り違えと要確認フラグを削減
トップ画面を整理: 「1. 戦績を抽出する」を主役に、ハイライト生成は「2.」として畳んだ
「使い方」を新機能込みで書き直した
ラケット発動バナーの白リボン（フィーバーショット・ビューゴーショット）に対応
```

## 補足（説明欄には貼らない・自分用）

- 同梱: ffmpeg-static（約80MB・GPL）。インストーラーは約30MB増。`npm run dist` の predist が exe の存在を確認する
  → 無ければ `node node_modules/ffmpeg-static/install.js`
- 辞書: vsIcons 307本／panelIcons 134本／dblIcons 99本（すべて64種）・racketBanners 99本／30種・courts 58本／16種
- 書き出し（保存）は2026-09-05にユーザーがダイジェストを実機で作成済み（バッジ位置の指摘あり→修正済み）
- 手順: `cd C:\Users\<user>\Documents\senseki-capture\app; npm run dist`（ユーザー・実ターミナル）→ `node tools/verify-release.js --local`
  → `gh release create v0.4.0 <exe> <blockmap> latest.yml --title "v0.4.0" --notes-file ...`（Claude代行・docs/release.md）
