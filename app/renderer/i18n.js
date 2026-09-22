// SENSEKI SCAN の画面文言の英語化（2026-09-22・v1.0.12）
//
// 方針
// - 日本語の文そのものを辞書のキーにする（gettext 方式）。コード側は t('日本語') / t('m{0}: …', m.n) と書き、
//   日本語モードではキーがそのまま出る＝日本語の表示は従来と一字一句同じ。英語モードだけ辞書を引く
// - 静的な HTML は applyDom() が起動時にテキストノード単位で置き換える（見出し・ボタン・説明文）。
//   <b> を挟む長い段落は要素の innerHTML 単位で置き換える（英語は語順が変わるので断片では訳せない）
// - CSV に書く値（キャラ名・コート名・ラケット名・mode・result）は SENSEKI FEVER の取り込みに合わせて日本語の正準値のまま。
//   画面に出すときだけ disp() で英語名にし、入力されたら canon() で正準値に戻す（名前の対応表は SENSEKI FEVER の
//   characters/courts/rackets の name_en と同じもの・2026-09-22 取得）
// - 言語は settings.lang（'ja'|'en'）。無ければ OS の言語（日本語以外は英語）。切替は右上のボタン。
//   起動直後のちらつきを避けるため localStorage の sc_lang にも写しておき、設定の読み込み前に使う
window.I18N = (() => {
  const JA = /[　-ヿ一-鿿！-｠]/; // かな・漢字に加えて全角の記号（「」（）。、）も＝訳の付いた括弧を置き換えるため

  // ---- 固有名の英語表記（表示専用・正準値は日本語） ----
  const CHAR_EN = {
    'マリオ': 'Mario', 'ルイージ': 'Luigi', 'ピーチ': 'Peach', 'デイジー': 'Daisy', 'ロゼッタ': 'Rosalina', 'ポリーン': 'Pauline',
    'ワリオ': 'Wario', 'ワルイージ': 'Waluigi', 'キノピオ': 'Toad', 'キノピコ': 'Toadette', 'チコ': 'Luma', 'ヨッシー': 'Yoshi',
    'クッパ': 'Bowser', 'クッパJr.': 'Bowser Jr.', 'ドンキーコング': 'Donkey Kong', 'テレサ': 'Boo', 'ヘイホー': 'Shy Guy',
    'ノコノコ': 'Koopa Troopa', 'カメック': 'Kamek', 'ガボン': 'Spike', 'ディディーコング': 'Diddy Kong', 'ワンワン': 'Chain Chomp',
    'キャサリン': 'Birdo', 'パタパタ': 'Koopa Paratroopa', 'ボスパックン': 'Petey Piranha', 'パックンフラワー': 'Piranha Plant',
    'ブンブン': 'Boom Boom', 'ゲッソー': 'Blooper', 'ほねクッパ': 'Dry Bowser', 'カロン': 'Dry Bones', 'ベビィマリオ': 'Baby Mario',
    'ベビィルイージ': 'Baby Luigi', 'ベビィピーチ': 'Baby Peach', 'ベビィワリオ': 'Baby Wario', 'ベビィワルイージ': 'Baby Waluigi',
    'ハナチャン': 'Wiggler', 'トッテン': 'Nabbit', 'クリボー': 'Goomba',
  };
  const COLOR_EN = { '青': 'Blue', '緑': 'Green', '水色': 'Light Blue', '赤': 'Red', 'オレンジ': 'Orange', '黄': 'Yellow', 'ピンク': 'Pink', '紫': 'Purple', '黒': 'Black', 'オーバーオール': 'Overalls' };
  const COURT_EN = {
    'アカデミー アイス': 'Academy Court (Ice)', 'アカデミー ウッド': 'Academy Court (Wood)', 'アカデミー カーペット': 'Academy Court (Carpet)',
    'アカデミー キノコ': 'Academy Court (Mushroom)', 'アカデミー グラス': 'Academy Court (Grass)', 'アカデミー クレイ': 'Academy Court (Clay)',
    'アカデミー サンド': 'Academy Court (Sand)', 'アカデミー ハード': 'Academy Court (Hard)', 'アカデミー ブロック': 'Academy Court (Brick)',
    'ギャラクシーコート': 'Galaxy Court', 'スタジアム グラス': 'Stadium Court (Grass)', 'スタジアム クレイ': 'Stadium Court (Clay)',
    'スタジアム ハード': 'Stadium Court (Hard)', 'フォレストコート': 'Forest Court', 'ラケットファクトリー': 'Racket Factory',
    'ワルイージピンボール': "Waluigi's Pinball Arcade", 'ワンダーコート': 'Wonder Court', '飛行船 コート': 'Airship Court',
  };
  const RACKET_EN = {
    'アイスフラワーラケット': 'Ice Flower Racket', 'アイスラケット': 'Ice Racket', 'インクラケット': 'Inky Racket', 'オシダシーラケット': 'Shova Racket',
    'おばけラケット': 'Ghost Racket', 'カーブラケット': 'Swerve Racket', 'かざんラケット': 'Volcano Racket', 'キラーラケット': 'Bullet Bill Racket',
    'サンダーラケット': 'Lightning Racket', 'サンボラケット': 'Pokey Racket', 'シャドウラケット': 'Shadow Racket', 'スターラケット': 'Star Racket',
    'ダッシュラケット': 'Golden Dash Racket', 'たつまきラケット': 'Tornado Racket', 'トゲゾーラケット': 'Spiny Racket', 'ドッスンラケット': 'Thwomp Racket',
    'ドロドロラケット': 'Mud Racket', 'ハテナラケット': '? Block Racket', 'バナナラケット': 'Banana Racket', 'ビューゴーラケット': 'Ty-foo Racket',
    'ビリキューラケット': 'Amp Racket', 'ファイアバーラケット': 'Fire Bar Racket', 'ファイアフラワーラケット': 'Fire Flower Racket',
    'ファイアラケット': 'Flame Racket', 'ブラックホールラケット': 'Black Hole Racket', 'フリーズラケット': 'Freezing Racket',
    'ブルラケット': "Chargin' Chuck Racket", 'マイラケット': 'Personal Racket', 'マジックラケット': 'Magic Racket',
    'マメキノコラケット': 'Mini Mushroom Racket', 'メタルラケット': 'Metal Racket',
  };
  const invert = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
  const CHAR_JA = invert(CHAR_EN), COLOR_JA = invert(COLOR_EN), COURT_JA = invert(COURT_EN), RACKET_JA = invert(RACKET_EN);

  // ---- 画面文言（日本語 → 英語）。{0} {1} … は差し込み ----
  const EN = {
    // ヘッダー・共通
    '）': ')', '（': '(',
    '使い方': 'How to use', 'バグ報告': 'Report a bug', '閉じる': 'Close', 'キャンセル': 'Cancel', '適用': 'Apply', '反映': 'Apply',
    '要確認': 'needs review', '任意': 'optional', '秒': 's', '中止': 'Cancel', 'ログ': 'Log', 'クリア': 'Clear', '表示': 'Show',
    'マリオテニスフィーバーの対戦録画から戦績を読み取り、SENSEKI FEVER「CSV一括登録」に渡せるCSVを作ります。解析はすべてこのPC内で完結し、動画は送信されません。':
      'Reads match results from your Mario Tennis Fever recordings and builds a CSV for SENSEKI FEVER "Bulk CSV import". Everything runs on this PC; no video is uploaded.',
    // 1. 戦績を抽出する
    '戦績を抽出する': 'Extract match results',
    '録画を入れるだけ。解析が終わったら内容を確認してCSVを保存します（全部門を自動識別・複数ファイルまとめてOK）':
      'Just drop a recording. When the analysis finishes, review the results and save the CSV (all modes are detected automatically; multiple files are fine)',
    '録画ファイル（MP4）をここにドラッグ&ドロップ': 'Drag & drop recording files (MP4) here',
    'またはクリックしてファイルを選ぶ': 'or click to choose files',
    '録画ファイルを選ぶ…': 'Choose recordings…',
    '相手名の自動入力': 'Auto-fill opponent names',
    '（過去にCSV保存で確定した名前の画像と照合して補完する）': ' (matches name images against names confirmed in earlier CSV saves)',
    'ゲーム画面の位置:': 'Game area:', 'ゲーム画面の位置': 'Game area',
    '全画面（既定）': 'Full frame (default)', '全画面': 'Full frame', '変更…': 'Change…',
    '配信レイアウトなどでゲームが画面いっぱいでない録画のとき': 'for recordings where the game does not fill the frame (stream layouts etc.)',
    '準備中…': 'Preparing…',
    // 2. ハイライト生成（パネル）
    'ハイライト生成': 'Highlights',
    '任意・得点シーンを自動で切り抜いてMP4に保存。プレイヤー名が載る画面（ポイント間のスコアバナー・VS・勝敗）は映しません':
      'Optional. Cuts point-winning scenes automatically and saves them as MP4. Screens that show player names (score banners between points, VS, results) are left out',
    '1. 切り抜く区間:': '1. What to cut:', '得点前': 'Before the point', 'サーブから得点まで（ラリー全体）': 'Serve to point (whole rally)',
    '試合ごと（全ラリーをつなぐ）': 'Per match (all rallies joined)',
    '2. 録画:': '2. Recording:', '録画を選ぶ…': 'Choose a recording…',
    '（このパネルへドロップでも可。区間の種類はあとから変えられます）': '(or drop it on this panel; you can change the clip type later)',
    '3. 保存する区間にチェック:': '3. Check the clips to save:', '自分の得点だけを選ぶ': 'Select only my points',
    'サムネイルか「区間を調整」で1つずつ始点・終点を直せます': 'Click a thumbnail or "Adjust clip" to fix the start/end of each one',
    '4. 保存形式:': '4. Output:', '区間ごとに保存（1本ずつ）': 'Save each clip (one file each)', '1本に繋げて保存': 'Join into one file',
    '繋げるときは試合ごとに分ける': 'Split joined files per match', 'つなぎ目:': 'Transition:',
    'ディゾルブ（重ねて溶かす）': 'Dissolve (crossfade)', '黒フェード': 'Fade through black', 'ワイプ': 'Wipe', 'スライド': 'Slide', 'なし（カット）': 'None (cut)',
    '保存先:': 'Save to:', '未設定（最初の保存時に選びます）': 'not set (chosen at the first save)', 'フォルダを開く': 'Open folder',
    '名前が映る区間を自動で除外（推奨）': 'Auto-exclude parts that show names (recommended)', '1440p以上は1080pに縮小': 'Downscale 1440p+ to 1080p',
    'ファイル名に相手の名前を入れる': "Put the opponent's name in the file name",
    '読めた相手の名前を「_vs相手名」としてファイル名に入れます（動画そのものには入りません）': 'Adds "_vsName" to the file name when the opponent\'s name could be read (never drawn into the video)',
    '自分のキャラを表示': 'Show my character', '最初の3秒': 'first 3 s', '最初の5秒': 'first 5 s', 'ずっと': 'always',
    // 進捗・確認バー
    '解析ログの表示/非表示': 'Show/hide the analysis log', '1件ずつ確認': 'Review one by one', '一覧表示': 'List view',
    '1件ずつ確認: Enter / → で次の試合へ・← で前へ': 'Review: Enter / → next match, ← previous',
    'CSVを保存': 'Save CSV', 'CSVをコピー': 'Copy CSV',
    'CSVをクリップボードにコピーします。SENSEKI FEVERの一括登録ページの「クリップボードから読み込む」でそのまま登録できます':
      'Copies the CSV to the clipboard. Use "Load from clipboard" on the SENSEKI FEVER bulk-import page',
    '読み込んだ解析結果をすべて消します': 'Clears all loaded results',
    '一括登録ページを開く': 'Open the bulk-import page',
    'ファイルを作らずクリップボード経由でSENSEKI FEVERへ渡せます': 'Hands the CSV to SENSEKI FEVER via the clipboard, no file needed',
    '「CSVをコピー」→一括登録ページの「クリップボードから読み込む」が最短です。赤枠＝要確認・青枠＝手修正済み':
      '"Copy CSV" → "Load from clipboard" on the bulk-import page is the quickest. Red = needs review, blue = edited',
    '解析ログ': 'Analysis log',
    // 拡大表示
    '自動再生 (Space)': 'Auto-play (Space)', '停止 (Space)': 'Stop (Space)', '前の画像 (←)': 'Previous image (←)', '次の画像 (→)': 'Next image (→)',
    '←/→ で画像送り ／ Esc・背景クリックで閉じる': '←/→ to step through images. Esc or click outside to close',
    // ゲーム画面の位置モーダル
    '配信レイアウトなどでゲームが画面いっぱいに映っていない録画のために、フレームの中で<b>ゲーム画面が占める範囲</b>を指定します。プレビュー上をドラッグしてください。設定は全ファイル共通で保存されます。':
      'For recordings where the game does not fill the frame (stream layouts etc.), mark <b>the area the game screen occupies</b>. Drag on the preview. The setting is saved and used for all files.',
    '見本にする録画ファイルを選んでください：': 'Choose a recording to use as the sample:',
    '切り出し結果（この絵が解析にかかります）': 'Cropped result (this is what gets analyzed)',
    'フレーム': 'Frame', '16:9に合わせる': 'Snap to 16:9', '数値で指定(px)': 'Enter numbers (px)', '幅': 'W', '高': 'H',
    'OBSのゲームソースの位置・サイズをそのまま入れられます（一番正確）': 'You can type the position/size of your OBS game source (most accurate)',
    '自動検出': 'Auto-detect', '全画面に戻す': 'Reset to full frame', 'この範囲で保存': 'Save this area',
    '切り出すぶん解像度は下がります。ゲーム画面が横1280px相当を切ると認識精度が落ちます。': 'Cropping lowers the effective resolution. Below about 1280px of game width, recognition accuracy drops.',
    '左{0}% / 上{1}% / 幅{2}% / 高{3}%': 'left {0}% / top {1}% / width {2}% / height {3}%',
    'ゲーム画面が横{0}px＝1280px未満です。文字が小さくなるぶん認識精度が落ちます': 'The game area is {0}px wide (under 1280px). Smaller text lowers recognition accuracy',
    '16:9から外れています（ゲーム画面は必ず16:9です）': 'Not 16:9 (the game screen is always 16:9)',
    '{0}<br>実ピクセル {1} x {2}（縦横比 {3} / 16:9=1.778）': '{0}<br>Actual pixels {1} x {2} (aspect {3} / 16:9 = 1.778)',
    '読み込めませんでした': 'Could not load it', 'この動画を読み込めませんでした': 'Could not load this video',
    '検出できませんでした。手動で範囲を指定してください': 'Could not detect it. Please set the area by hand',
    '検出: {0},{1} {2}x{3}': 'Detected: {0},{1} {2}x{3}', '（16:9から外れています。数値欄で直してください）': ' (not 16:9; fix it in the number fields)',
    '位置指定: ': 'Game area: ', '検出中…': 'Detecting…', '検出に失敗しました': 'Detection failed',
    'ゲーム画面の位置: {0}（次に読み込むファイルから反映されます）': 'Game area: {0} (used from the next file you load)',
    // 区間の調整モーダル
    '区間の調整': 'Adjust clip',
    '緑＝HUDが出ている区間（ラリー）・赤＝プレイヤー名が映る区間（ポイント間のスコアバナー／勝敗画面／試合開始直後のVS画面の残像）。青いハンドルをドラッグするか、再生しながら「開始をここに／終了をここに」で決めます。':
      'Green = HUD visible (rally), red = player names visible (score banner between points / result screen / VS screen fading right after the match starts). Drag the blue handles, or play and press "Start here" / "End here".',
    '開始': 'Start', '終了': 'End', '現在': 'Now', '得点前の数秒': 'A few seconds before the point', 'ラリー全体': 'Whole rally',
    '秒（長さ': 's (length', '区間を再生 / 停止': 'Play / stop clip', '区間を再生 (Space)': 'Play the clip (Space)',
    '1秒戻す (Shift+←)': 'Back 1 s (Shift+←)', '0.1秒戻す (←)': 'Back 0.1 s (←)', '0.1秒進める (→)': 'Forward 0.1 s (→)', '1秒進める (Shift+→)': 'Forward 1 s (Shift+→)',
    '開始をここに': 'Start here', '終了をここに': 'End here', '自動に戻す': 'Reset to auto', 'この区間で決定': 'Use this clip', 'キャンセル (Esc)': 'Cancel (Esc)',
    'この区間を保存する': 'Save this clip', '‹ 前のポイント': '‹ Previous point', '次のポイント ›': 'Next point ›',
    '前のポイント (PageUp)・いまの区間は決定して移ります': 'Previous point (PageUp). The current clip is kept', '次のポイント (PageDown)・いまの区間は決定して移ります': 'Next point (PageDown). The current clip is kept',
    // バグ報告モーダル
    '読み取りの誤り・未対応の画面などを見つけたら、以下の手順で報告をお願いします。': 'If you find a misread or an unsupported screen, please report it like this.',
    'レポートを保存': 'Save a report',
    'アプリのバージョンと解析ログをテキストファイルに保存します（動画・個人情報は含まれません）。': 'Saves the app version and the analysis log as a text file (no video or personal data).',
    'レポートを添えて連絡': 'Send it with your report',
    '症状の説明とあわせて、どちらかへ送ってください。該当区間の録画も共有できると原因特定が早くなります。': 'Describe what went wrong and send it to either of these. Sharing the recording of that part makes it much easier to find the cause.',
    'GitHubで報告': 'Report on GitHub', '作者への連絡先': 'Contact the author',
    // 使い方（オンボーディング）
    'SENSEKI SCAN の使い方': 'How to use SENSEKI SCAN',
    '対戦録画から戦績CSVを自動抽出します（メイン機能）。おまけで得点シーンのハイライト動画も作れます。解析はすべてこのPC内で完結し、動画がアップロードされることはありません。':
      'Extracts a match-results CSV from your recordings (main feature). As a bonus it can also make highlight videos of your points. Everything runs on this PC; nothing is uploaded.',
    '1. 戦績を抽出する（録画 → CSV → SENSEKI FEVER）': '1. Extract match results (recording → CSV → SENSEKI FEVER)',
    '録画ファイル（MP4）を「1. 戦績を抽出する」の枠にドラッグ&ドロップ': 'Drag & drop recording files (MP4) onto "1. Extract match results"',
    'OBS等の元録画をそのまま使ってください（編集ソフトで再エンコードした動画は精度が落ちます）。推奨: 1080p以上・30fps以上・ビットレート6〜12Mbps。複数ファイルまとめてOK。シングルス/ダブルス・クラシック/フィーバーは自動で見分けます。':
      'Use the original recording from OBS etc. (videos re-encoded by editing software lose accuracy). Recommended: 1080p or higher, 30 fps or higher, 6–12 Mbps. Multiple files are fine. Singles/doubles and classic/fever are detected automatically.',
    'ダブルスは左列の上下どちらが自分かを、シングルスのVS画面で覚えた自分の名前で見分けます。まだ覚えていないとき（ダブルスだけ解析したとき等）は「自分の行」が要確認になるので、名前画像を見て「上の行が自分／下の行が自分」を選んでください。1回選べば学習して、以降は自動で見分けます。':
      'In doubles, which row of the left column is you is decided from your name, learned from singles VS screens. Until it is learned (e.g. you only analyzed doubles), "My row" needs review: look at the name image and choose "Top row is me" or "Bottom row is me". Once chosen it is learned and applied automatically.',
    '配信レイアウトなどで<b>ゲームが画面いっぱいに映っていない</b>録画は、先に「ゲーム画面の位置」→「変更…」でゲーム画面の範囲を指定してください（自動検出あり）。指定しないと何も検出できません。':
      'If <b>the game does not fill the frame</b> (stream layouts etc.), first set the game area with "Game area" → "Change…" (auto-detect available). Nothing is detected without it.',
    '解析を待つ': 'Wait for the analysis',
    '動画1本あたり数分かかります（録画時間や試合数で前後）。待っている間に次のファイルをドロップして追加できます。': 'It takes a few minutes per video (depending on length and number of matches). You can drop more files while waiting.',
    '「1件ずつ確認」で内容をチェック': 'Check the results in "Review one by one"',
    '証拠画像と入力欄が並んで表示されます。<b>赤枠＝要確認</b>なので画像を見て直してください。Enter または → で次の試合へ、← で前へ。相手名は過去にCSV保存した名前から自動で入ります（「相手名の自動入力」で切替可）。手で直したキャラ・コート・名前は次回から自動で学習されます。':
      'Evidence images and input fields are shown side by side. <b>Red = needs review</b>: look at the image and fix it. Enter or → for the next match, ← for the previous. Opponent names are filled from names you saved in earlier CSVs ("Auto-fill opponent names"). Characters, courts and names you correct are learned for next time.',
    '試合の日時は<b>ファイル名の日時</b>（OBS標準の「2026-09-05 21-24-23.mp4」形式）から決めます。ファイル名に日時が無い動画（YouTubeからダウンロードしたアーカイブなど）は更新日時から推定するので合いません。結果の上の「録画の開始日時」に配信開始の日時を入れて「適用」すると、その動画の全試合の日時を作り直します。':
      'Match times come from <b>the date/time in the file name</b> (OBS style "2026-09-05 21-24-23.mp4"). For files without it (e.g. archives downloaded from YouTube) the modified time is used, which will be wrong. Enter the stream start time in "Recording start time" above the results and press Apply to rebuild the times of every match in that video.',
    '「CSVをコピー」→ SENSEKI FEVER の一括登録ページで「クリップボードから読み込む」': '"Copy CSV" → "Load from clipboard" on the SENSEKI FEVER bulk-import page',
    'ファイルを作らずに登録できる最短ルートです。「CSVを保存」でファイルにしてから「CSV一括登録」に読み込ませてもOK。': 'The quickest route, no file needed. You can also "Save CSV" to a file and load it in "Bulk CSV import".',
    '2. ハイライト生成（任意）': '2. Highlights (optional)',
    '「2. ハイライト生成」を開いて区間の種類を選ぶ': 'Open "2. Highlights" and pick the clip type',
    '「得点前N秒」「サーブから得点まで」「試合ごと（全ラリーをつなぐ）」の3種類。あとから変えられます。': 'Three types: "N seconds before the point", "Serve to point", "Per match (all rallies joined)". You can change it later.',
    '録画を選ぶ': 'Choose a recording',
    '「録画を選ぶ…」かパネルへのドロップ。戦績を抽出したばかりの録画は「直近の録画で作る」ボタンで再利用できます。': '"Choose a recording…" or drop it on the panel. A recording you just analyzed can be reused with "Use the latest recording".',
    '保存する区間にチェック → 必要なら「区間を調整」': 'Check the clips to save → "Adjust clip" if needed',
    '「自分の得点だけを選ぶ」が既定。サムネイルをクリックすると始点・終点をタイムラインで直せます（緑＝プレー中・赤＝プレイヤー名が映る区間）。': '"Select only my points" is the default. Click a thumbnail to fix the start/end on a timeline (green = in play, red = player names visible).',
    '保存形式を選んで書き出し': 'Pick the output and export',
    '「区間ごとに保存」か「1本に繋げて保存」（つなぎ目のトランジションを選べます）。プレイヤー名が映る画面は自動で除外し、自分のキャラのバッジを最初の数秒に重ねられます。保存先は最初の保存時に選びます。': '"Save each clip" or "Join into one file" (with a transition of your choice). Screens with player names are excluded automatically, and a badge of your character can be shown for the first few seconds. The folder is chosen at the first save.',
    'こまったとき': 'Troubleshooting',
    '何も検出されない': 'Nothing is detected',
    'ゲームが画面いっぱいに映っていない録画は「ゲーム画面の位置」を指定してください。再エンコードした動画や低ビットレートの録画も検出が落ちます。': 'If the game does not fill the frame, set "Game area". Re-encoded or low-bitrate videos also detect worse.',
    '読み取りが間違っている・落ちる': 'Misreads or crashes',
    '右上の「バグ報告」の手順でレポート（バージョンと解析ログ）を保存し、症状とあわせてGitHubか作者へ送ってください。レポートに動画や個人情報は含まれません。': 'Use "Report a bug" (top right) to save a report (version and analysis log) and send it with a description to GitHub or the author. The report contains no video or personal data.',
    'はじめる': 'Get started', 'この画面は右上の「使い方」からいつでも開けます': 'You can reopen this from "How to use" at the top right',
    // 解析中の進捗・ログ
    '全編スキャン中… {0}/{1}秒': 'Scanning… {0}/{1} s',
    '{0}: 試合 {1}/{2} を解析中…': '{0}: analyzing match {1}/{2}…',
    '試合 {0}: フィーバーラケットを解析中…': 'Match {0}: reading Fever Rackets…',
    '試合 {0}: 回線を確認中…': 'Match {0}: checking the connection…', '試合 {0}: 回線を確認中… {1}/{2}': 'Match {0}: checking the connection… {1}/{2}',
    '勝敗画面を再探索中… (試合 {0})': 'Searching again for the result screen… (match {0})',
    '完了: 全{0}試合を検出しました。内容を確認してCSVを保存してください': 'Done: {0} match(es) found. Review them and save the CSV',
    '解析済み: {0}試合（追加の録画はここへドロップ・「クリア」で最初から）': 'Analyzed: {0} match(es). Drop more recordings here, or "Clear" to start over',
    '解析中: {0}（追加のファイルはここへドロップ）': 'Analyzing: {0} (drop more files here)',
    '待機中: {0}': 'Queued: {0}', '動画を読み込めませんでした': 'Could not load the video',
    'ゲーム画面の位置: {0} → 実ピクセル {1}x{2}': 'Game area: {0} → actual pixels {1}x{2}',
    '[警告] ゲーム画面の横幅が {0}px です（1280px未満）。文字が小さく、認識精度が落ちます。': '[Warning] The game area is {0}px wide (under 1280px). Text is small and recognition accuracy drops.',
    '[注意] ゲーム画面の横幅が {0}px で、フルHD(1920px)の8割未満です。レートの数字が小さくなり、読み取りの確信度が下がります（要確認が増えます）。配信レイアウトごと録るより、ゲーム画面を大きく録るほうが安定します。':
      '[Note] The game area is {0}px wide, under 80% of Full HD (1920px). Rating digits are small, so reading confidence drops (more fields will need review). Recording the game screen larger (rather than a whole stream layout) is more reliable. This is not an error.',
    '[警告] VS画面を1件も検出できませんでした。配信レイアウトなどでゲームが画面いっぱいに映っていない録画は、「ゲーム画面の位置」で範囲を指定してから読み込み直してください{0}':
      '[Warning] No VS screen was detected. If the game does not fill the frame (stream layouts etc.), set the area in "Game area" and load the file again{0}',
    '（現在の指定: {0}。この指定が合っているかも確認してください）': ' (current setting: {0}; please check that it is right)',
    'アルバム/ホーム画面の再生を検出し解析対象から除外: {0}': 'Album/Home screen playback detected and excluded: {0}', '{0}〜{1}秒': '{0}–{1} s',
    '[警告] 部門ボード照合が低いレート窓を{0}件棄却しました({1}秒)。メニュー/試合中の誤検出なら正常ですが、未対応の新パネル様式の場合は試合が消えます。直後の試合が欠けていたら録画を添えて報告してください':
      '[Warning] Rejected {0} rating window(s) whose mode board did not match ({1} s). That is normal for false detections in menus or play, but a match disappears if the panel style is unsupported (for example a game language that is not in the dictionary yet). If the match right after is missing, please report it with the recording',
    '[警告] VS画面{0}回に対し成立した試合が{1}件です。レート画面を検出できなかった試合がある可能性があります（未対応のランク色など）。該当区間の録画を添えて報告してください。':
      '[Warning] {0} VS screen(s) but {1} complete match(es). The rating screen may not have been recognized for some matches (unsupported rank color or game language, etc.). Please report it with the recording of that part.',
    '[警告] {0}秒のレート画面がどの試合にも紐づきません。直前のVS画面を検出できず試合を1件取り逃した可能性が高いです。該当区間の録画を添えて報告してください。':
      '[Warning] The rating screen at {0} s does not belong to any match. Most likely the VS screen before it was missed and one match was lost. Please report it with the recording of that part.',
    '[警告] 勝敗画面らしきものを{0}回検出しました（試合{1}件）。編集カット等で画面が欠けた試合がある可能性があります。': '[Warning] Detected {0} possible result screens for {1} match(es). Some match may have missing screens (editing cuts etc.).',
    '[警告] 録画の開始日時をファイル名から読めず、{0}。YouTube等からダウンロードした動画は合わないので、結果の上の「録画の開始日時」で直してください（試合の日時は要確認にしています）':
      '[Warning] Could not read the recording start time from the file name; {0}. Downloaded videos (YouTube etc.) will be wrong, so fix it in "Recording start time" above the results (match times are marked needs-review)',
    'ファイルの更新日時から推定しました': 'estimated it from the file\'s modified time', '決められませんでした': 'could not determine it',
    'm{0}: VS画面は{1}に見えますが部門ボードは{2}です。ボードを優先します': 'm{0}: the VS screen looks like {1} but the mode board says {2}. Using the board',
    'シングルス': 'Singles', 'ダブルス': 'Doubles',
    'm{0}: ダブルスの自分の行を判定できません（自分の名前が未学習）。カードの「自分の行」で上か下かを選んでください（選ぶと学習して他の試合にも当てはめます）':
      'm{0}: cannot tell which doubles row is mine (my name is not learned yet). Choose top or bottom in "My row" on the card (it is learned and applied to the other matches)',
    'm{0}: レートパネルはカウント前({1})しか読めていません。変動前として扱い、変動後は要確認にします': 'm{0}: only the pre-count value ({1}) could be read on the rating panel. Using it as the rating before; the rating after needs review',
    'm{0}: ラケット 自分={1} 味方={2} 相手1={3} 相手2={4} (バナー{5}件・自分の行={6})': 'm{0}: rackets me={1} partner={2} opp1={3} opp2={4} ({5} banners, my row={6})',
    'm{0}: ラケット 自分={1} 相手={2} (バナー{3}件)': 'm{0}: rackets me={1} opp={2} ({3} banners)',
    'm{0}: 回線アイコンの位置(HUDの{1}の行)から自分の行を{1}と判定し、自分の名前として学習しました': 'm{0}: judged my row as {1} from the connection icon (the {1} HUD row) and learned it as my name',
    'm{0}: 自分の行を{1}に設定（自分の名前として学習）{2}': 'm{0}: my row set to {1} (learned as my name){2}', '。他の{0}試合にも当てはめました': '. Applied to {0} other match(es)',
    '上': 'top', '下': 'bottom',
    'm{0}: 再探索で勝敗を取得 {1}-{2} {3}': 'm{0}: result found on the second search {1}-{2} {3}', 'm{0}: 再探索でも勝敗画面が見つかりませんでした': 'm{0}: result screen still not found',
    'm{0}: レート後を次試合のbefore({1})で補完': 'm{0}: rating after filled from the next match\'s before ({1})',
    'm{0}: 画面のレート前({1})と前試合のafter({2})が違います。画面の値を残しました（連続した試合でないか、どちらかの読み違いです）':
      'm{0}: the rating before on screen ({1}) differs from the previous match\'s after ({2}). Kept the on-screen value (the matches may not be consecutive, or one of them was misread)',
    'm{0}: レート前を前試合のafter({1})で補完': 'm{0}: rating before filled from the previous match\'s after ({1})',
    '文字辞書: +{0}枚 → 計{1}枚 / {2}文字（次回から初対戦の相手名も読めます）': 'Glyph dictionary: +{0} → {1} total / {2} characters (new opponents\' names can be read next time)',
    '修正内容をユーザー辞書に追加: {0} → 次回から自動認識に使われます': 'Added your corrections to your dictionary: {0} → used for recognition from next time',
    '[更新] 新しいバージョン v{0} をダウンロードしました。アプリを閉じると自動で更新されます': '[Update] Version v{0} has been downloaded. It is installed automatically when you close the app',
    '[ハイライト] ': '[Highlights] ',
    // 録画の開始日時
    '録画の開始日時（各試合の日時はここに試合開始位置を足したもの。違っていたら直して「適用」）': 'Recording start time (each match time = this + its position in the video. If it is wrong, fix it and press Apply)',
    'ファイル名の日時から': 'from the file name', 'ファイルの更新日時から推定（ダウンロードした動画だと合いません）': 'estimated from the file\'s modified time (wrong for downloaded videos)', '手入力': 'entered by hand', '不明': 'unknown',
    '日時を入力してください': 'Please enter a date and time',
    '{0}: 録画の開始日時を {1} に変更（この動画の全試合の日時を作り直しました）': '{0}: recording start time changed to {1} (rebuilt the time of every match in this video)',
    // 確認画面
    '試合 {0}': 'Match {0}', '試合 {0} / {1}': 'Match {0} / {1}',
    '｜ {0} ｜ 赤枠＝要確認・青枠＝手修正済み・画像クリックで拡大': '| {0} | red = needs review, blue = edited, click an image to enlarge',
    '← 前へ (←)': '← Back (←)', '最後の試合です': 'This is the last match', '確認OK・次へ (Enter / →)': 'Looks good, next (Enter / →)',
    '要確認 {0}件: {1}': 'Needs review ({0}): {1}', ' ／ ': ' / ', '要確認なし': 'Nothing needs review', '手修正 {0}件': 'Edited: {0}',
    '赤枠=要確認 ／ 青枠=手修正 ／ 画像クリックで拡大': 'red = needs review / blue = edited / click an image to enlarge',
    '[自動補正]': '[auto-fixed]', '[自動入力]': '[auto-filled]', '[未判定]': '[undecided]',
    '対戦カード（コート/キャラ/名前）': 'VS card (court / characters / names)', '回線 {0}': 'Connection {0}', '最終スコア': 'Final score',
    'レート変動前': 'Rating before', 'レート変動後': 'Rating after', '発動バナー(帰属不明)': 'Activation banner (side unknown)',
    'ラケット発動 ({0})': 'Racket activation ({0})', '・種類{0}': ', type {0}',
    '自分': 'Me', '味方': 'Partner', '相手': 'Opponent', '相手1': 'Opponent 1', '相手2': 'Opponent 2',
    '日時 (played_at)': 'Date/time (played_at)', '部門 (mode)': 'Mode (mode)', 'コート': 'Court', '回線 (0〜4)': 'Connection (0–4)',
    '自分キャラ': 'My character', '味方キャラ': 'Partner character', '相手1キャラ': 'Opponent 1 character', '相手2キャラ': 'Opponent 2 character',
    '味方の名前（画像を見て入力）': 'Partner name (type what the image shows)', '相手1の名前（画像を見て入力）': 'Opponent 1 name (type what the image shows)', '相手2の名前（画像を見て入力）': 'Opponent 2 name (type what the image shows)',
    '味方の名前（任意）': 'Partner name (optional)', '相手1の名前（任意）': 'Opponent 1 name (optional)', '相手2の名前（任意）': 'Opponent 2 name (optional)',
    '{0}ラケット': '{0} racket', '例: トゲゾーラケット': 'e.g. Spiny Racket', '{0}（画像は帰属不明バナー）': '{0} (image: banner with unknown side)',
    '自分スコア': 'My score', '相手スコア': 'Opponent score', 'レート前': 'Rating before', 'レート後': 'Rating after',
    '日時': 'Date/time', '自分の行': 'My row', '味方の名前': 'Partner name', '相手1の名前': 'Opponent 1 name', '相手2の名前': 'Opponent 2 name',
    '自分ラケット': 'My racket', '味方ラケット': 'Partner racket', '相手ラケット': 'Opponent racket', '相手2ラケット': 'Opponent 2 racket', '回線': 'Connection',
    '自分の行（左列のどちらが自分か）': 'My row (which row of the left column is me)', '上の行が自分': 'Top row is me', '下の行が自分': 'Bottom row is me',
    '発動前後の様子(自動再生・クリックで拡大)': 'Around the activation (auto-play; click to enlarge)', ' (発動{0}秒)': ' (activation {0} s)', '発動前後のコマ': 'Frames around the activation',
    '候補なし（手入力もできます）': 'No matches (you can type freely)',
    // CSV
    'CSVを保存しました: {0}': 'CSV saved: {0}', 'クリップボードに書き込めませんでした': 'Could not write to the clipboard', 'コピーに失敗しました: ': 'Copy failed: ',
    '<b>{0}</b>代わりに「CSVを保存」でファイルにしてください': '<b>{0}</b>Use "Save CSV" to write a file instead', 'コピーしました': 'Copied',
    '<b>CSVをコピーしました（{0}試合）</b>SENSEKI FEVERの一括登録ページで「クリップボードから読み込む」を押してください': '<b>CSV copied ({0} matches)</b>Press "Load from clipboard" on the SENSEKI FEVER bulk-import page',
    'CSVをコピーしました。SENSEKI FEVERの一括登録ページで「クリップボードから読み込む」を押してください': 'CSV copied. Press "Load from clipboard" on the SENSEKI FEVER bulk-import page',
    '読み込んだ解析結果をすべてクリアします。よろしいですか？（CSV未保存の内容は失われます）': 'Clear all loaded results? (Anything not saved as CSV will be lost)',
    // バグレポート
    'SENSEKI SCAN バグレポート': 'SENSEKI SCAN bug report', '日時: ': 'Time: ', '環境: ': 'Environment: ', '== 試合サマリー ==': '== Match summary ==', '== 解析ログ ==': '== Analysis log ==',
    'レポートを保存しました: {0}': 'Report saved: {0}',
    // ハイライト生成（hl-ui.js）
    '直近の録画で作る（{0}）': 'Use the latest recording ({0})', '直近の録画（{0}）で作れます': 'You can use the latest recording ({0})',
    '[警告] 対戦相手を読めませんでした: {0}': '[Warning] Could not read the opponents: {0}', '自分：': 'Me: ',
    '戦績CSVの解析が終わってからハイライトを作ってください': 'Please wait for the CSV analysis to finish before making highlights',
    '[警告] 動画のファイルパスを取得できないため、書き出しはできません（区間の確認のみ）': '[Warning] The video\'s file path is not available, so exporting is disabled (you can still review the clips)',
    '試合の位置を探しています… {0}/{1}秒': 'Locating the matches… {0}/{1} s', '試合の位置は戦績CSVの解析結果を再利用しました': 'Reused the match positions from the CSV analysis',
    'VS画面を検出できなかったため、動画全体から得点シーンを探します（時間がかかります。配信レイアウトの録画は「ゲーム画面の位置」を先に指定してください）':
      'No VS screen was detected, so the whole video is searched for points (slow; for stream-layout recordings set "Game area" first)',
    '得点シーンを探しています… 試合 {0}/{1}（{2}）': 'Finding points… match {0}/{1} ({2})', 'サムネイルを作成中… {0}/{1}': 'Making thumbnails… {0}/{1}', '自分のキャラを確認中…': 'Checking my character…',
    '{0}試合・{1}ポイントを検出（自分の得点 {2}・相手の得点 {3}）… {4}秒': 'Found {0} match(es), {1} points (mine {2}, opponent\'s {3})… {4} s',
    '[警告] 得点シーンが見つかりませんでした。ゲーム画面が画面いっぱいに映っているか（配信レイアウトなら「ゲーム画面の位置」）を確認してください': '[Warning] No points were found. Check that the game fills the frame (for stream layouts, set "Game area")',
    '勝ち': 'Win', '負け': 'Loss', '（マッチ決定）': ' (match decided)', '自分の得点': 'My point', '相手の得点': 'Opponent\'s point',
    '試合ごと': 'Per match', '{0}試合・{1}ポイント（選択中 {2}）': '{0} match(es), {1} points ({2} selected)', '選択中 {0}': '{0} selected',
    '{0} 〜 {1} ・ {2}ポイント': '{0} – {1}, {2} points', '（この試合のクリップ: {0}ラリー・約{1}秒）': ' (this match\'s clip: {0} rallies, about {1} s)',
    'この試合を全部選ぶ': 'Select all in this match', '選択解除': 'Deselect all',
    '試合ごとに保存（1試合1本）': 'Save per match (one file each)', '全試合を1本に繋げて保存': 'Join all matches into one file',
    'チェックしたラリーをつなぎ、ポイント間のスコアバナーは抜きます。ファイル名: 録画名_試合n_vs相手名.mp4 ／ 録画名_全試合.mp4（相手名は読めたときだけ・ファイル名にだけ入り、動画には入りません）':
      'Joins the checked rallies and drops the score banners between points. File names: recording_matchN_vsOpponent.mp4 / recording_all.mp4 (the opponent\'s name only when it could be read; it goes in the file name only, never into the video)',
    'ファイル名: 録画名_試合n_vs相手名_Pk_スコア_自分/相手.mp4 ／ 繋げたもの: 録画名_試合n_vs相手名_ダイジェスト.mp4（試合ごと）または 録画名_ダイジェスト.mp4（相手名は読めたときだけ・ファイル名にだけ入り、動画には入りません）。つなぎ目あり＝重ねるぶん各区間が少し短くなり、再エンコードで時間がかかります':
      'File names: recording_matchN_vsOpponent_Pk_score_me/opp.mp4; joined: recording_matchN_vsOpponent_digest.mp4 (per match) or recording_digest.mp4 (the opponent\'s name only when it could be read; file name only, never into the video). With a transition, each clip gets slightly shorter where they overlap, and re-encoding takes longer',
    '自分のキャラ: ': 'My character: ', 'VS画面が見つからず未取得': 'not available (no VS screen found)', '自分はこちら': 'This one is me',
    'ダブルス: 自分の行を判定できず。自分のキャラを選んでください': 'Doubles: could not tell my row. Please pick my character',
    '名前は未読み取り（戦績CSVで確定した名前は次回から読めます）': 'Name not read (names confirmed in the CSV can be read next time)', '(キャラ)': ' (character)',
    '相手: ': 'Opponent: ', '　味方: ': '  Partner: ', 'VS画面（この試合の対戦相手）': 'VS screen (this match\'s opponents)',
    '手修正': 'edited', 'クリックで区間を調整': 'Click to adjust the clip', 'ラリー {0}秒（{1} 〜 {2}）': 'Rally {0} s ({1} – {2})', 'このラリー': 'This rally',
    '{0}: {1} 〜 {2}（{3}秒）{4}': '{0}: {1} – {2} ({3} s){4}', '区間を調整': 'Adjust clip', '試合 {0}・P{1}': 'Match {0} · P{1}', '{0}秒': '{0} s',
    '[警告] 終了が赤い区間に入っています。{0}にプレイヤー名が映ります。「名前が映る区間を自動で除外」がONなら書き出し時に手前へ詰めます':
      '[Warning] The end is inside a red zone: player names are visible on the {0}. With "Auto-exclude parts that show names" on, the end is pulled earlier when exporting',
    '勝敗画面': 'result screen', 'ポイント間のスコアバナー': 'score banner between points',
    '[警告] 開始が試合開始直後の赤い区間に入っています。VS画面の残像にプレイヤー名がうっすら映ることがあります': '[Warning] The start is inside the red zone right after the match start; player names may faintly remain from the VS screen',
    '中止しています…': 'Cancelling…', '繋げています… {0}{1}': 'Joining… {0}{1}', '（{0}本）': ' ({0} files)', '（{0}%）': ' ({0}%)',
    '書き出し中… {0}/{1}（{2}%）': 'Exporting… {0}/{1} ({2}%)', '書き出し中… {0}/{1}': 'Exporting… {0}/{1}',
    '[警告] 動画のファイルパスが取得できないため書き出せません': '[Warning] Cannot export: the video\'s file path is not available',
    '[警告] 同梱の ffmpeg が見つかりません。アプリを再インストールしてください': '[Warning] The bundled ffmpeg was not found. Please reinstall the app',
    '区間が1つも選ばれていません': 'No clips are selected', '区間を確認中… {0}/{1}': 'Checking the clips… {0}/{1}',
    '[警告] キャラ表示の画像を作れませんでした: {0}': '[Warning] Could not make the character badge image: {0}',
    '試合{0} P{1}: 名前が映るフレームを避けて {2}〜{3} → {4}〜{5} に詰めました': 'Match {0} P{1}: trimmed {2}–{3} → {4}–{5} to avoid frames that show names',
    '試合{0} P{1}: 区間が短すぎるため飛ばしました': 'Match {0} P{1}: skipped (too short)',
    '_試合{0}': '_match{0}', '_自分': '_me', '_相手': '_opp', '_ラリー全体': '_fullrally', '_ダイジェスト': '_digest', '_全試合': '_all',
    '[警告] 書き出しに失敗: {0}\n  {1}': '[Warning] Export failed: {0}\n  {1}', '繋げています… {0}': 'Joining… {0}', '[警告] 連結に失敗: {0}\n  {1}': '[Warning] Join failed: {0}\n  {1}',
    '書き出しを中止しました': 'Export cancelled', '保存しました（{0}本）:\n  ': 'Saved ({0} files):\n  ', '保存されたファイルはありません': 'No files were saved',
  };

  const fmt = (s, args) => args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i]))) : s;
  const autoLang = () => (String(navigator.language || 'ja').toLowerCase().startsWith('ja') ? 'ja' : 'en');
  let lang = 'ja';
  try { lang = localStorage.getItem('sc_lang') || autoLang(); } catch { lang = autoLang(); }
  if (lang !== 'en') lang = 'ja';

  function t(key, ...args) {
    const s = lang === 'en' && EN[key] != null ? EN[key] : key;
    return fmt(s, args);
  }
  const has = key => lang === 'en' && EN[key] != null;

  // ---- 固有名の表示/正準化 ----
  // kind: 'char'（"ヨッシー:オレンジ" → "Yoshi (Orange)"）/ 'court' / 'racket' / 'mode' / 'result'
  const MODE_EN = { classic_singles: 'Classic Singles', classic_doubles: 'Classic Doubles', fever_singles: 'Fever Singles', fever_doubles: 'Fever Doubles' };
  function disp(kind, v) {
    if (lang !== 'en' || v == null || v === '') return v ?? '';
    const s = String(v);
    if (kind === 'char') {
      const [base, color] = s.split(':');
      const b = CHAR_EN[base]; if (!b) return s;
      return color ? `${b} (${COLOR_EN[color] || color})` : b;
    }
    if (kind === 'court') return COURT_EN[s] || s;
    if (kind === 'racket') return RACKET_EN[s] || s;
    if (kind === 'mode') return MODE_EN[s] || s;
    return s;
  }
  // 入力値 → 正準値。英語表記でも日本語の正準値でも受ける（大文字小文字は無視）。知らない文字列はそのまま返す
  function canon(kind, v) {
    if (v == null) return v;
    const s = String(v).trim();
    if (!s) return s;
    const lc = s.toLowerCase();
    if (kind === 'char') {
      if (CHAR_EN[s.split(':')[0]]) return s; // すでに正準値
      const m = /^(.*?)\s*\((.+)\)$/.exec(s);
      const baseEn = (m ? m[1] : s).trim(), colorEn = m ? m[2].trim() : '';
      const base = CHAR_JA[baseEn] || Object.keys(CHAR_EN).find(k => CHAR_EN[k].toLowerCase() === baseEn.toLowerCase());
      if (!base) return s;
      if (!colorEn) return base;
      const color = COLOR_JA[colorEn] || Object.keys(COLOR_EN).find(k => COLOR_EN[k].toLowerCase() === colorEn.toLowerCase());
      return color ? `${base}:${color}` : s;
    }
    const table = kind === 'court' ? COURT_JA : kind === 'racket' ? RACKET_JA : null;
    if (!table) return s;
    if (table[s]) return table[s];
    const hit = Object.keys(table).find(k => k.toLowerCase() === lc);
    return hit ? table[hit] : s;
  }
  // 候補リストの英語表記（プルダウン用）
  const dispList = (kind, arr) => arr.map(v => disp(kind, v));

  // ---- 静的DOMの置き換え ----
  // テキストノードは trim した文字列をキーに引く。<b> を挟む段落は innerHTML 単位（キーは空白を1つに潰した innerHTML）。
  // 一度訳した要素は元の日本語を __ja / __jaHtml に控え、言語を切り替えても元に戻せる
  const SKIP = new Set(['SCRIPT', 'STYLE', 'VIDEO', 'CANVAS', 'IMG', 'INPUT', 'SELECT', 'TEXTAREA']);
  const INLINE = new Set(['B', 'I', 'SPAN', 'SMALL', 'CODE', 'BR', 'KBD', 'STRONG', 'EM', 'A']);
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function applyEl(el) {
    if (SKIP.has(el.tagName)) { applyAttrs(el); return; }
    if (el.__jaHtml != null) { el.innerHTML = has(el.__jaHtml) ? EN[el.__jaHtml] : el.__jaHtml; applyAttrs(el); return; }
    let pending = false;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const src = n.__ja != null ? n.__ja : n.nodeValue;
      const key = src.trim();
      if (!key || !JA.test(key)) continue;
      if (n.__ja == null) n.__ja = src;
      if (has(key)) n.nodeValue = src.replace(key, EN[key]);
      else if (lang !== 'en') n.nodeValue = src;
      else pending = true;
    }
    if (pending && el.children.length && [...el.children].every(c => INLINE.has(c.tagName) && !c.id)) {
      const html = el.innerHTML.replace(/\s+/g, ' ').trim();
      if (has(html)) { el.__jaHtml = html; el.innerHTML = EN[html]; applyAttrs(el); return; }
    }
    applyAttrs(el);
    for (const c of [...el.children]) applyEl(c);
  }
  function applyAttrs(el) {
    for (const a of ATTRS) {
      const store = el.__jaAttr || (el.__jaAttr = {});
      const src = store[a] != null ? store[a] : el.getAttribute(a);
      if (!src || !JA.test(src)) continue;
      store[a] = src;
      el.setAttribute(a, t(src));
    }
  }
  function applyDom(root) {
    applyEl(root || document.body);
    document.documentElement.lang = lang;
  }

  const listeners = [];
  function setLang(l) {
    lang = l === 'en' ? 'en' : 'ja';
    try { localStorage.setItem('sc_lang', lang); } catch {}
    applyDom();
    for (const f of listeners) { try { f(lang); } catch (e) { console.error(e); } }
  }
  // 開発用: 訳が無くて日本語のまま残っているテキストノードを列挙する（英語モードのみ）
  function untranslated() {
    const out = [];
    const walk = el => {
      if (SKIP.has(el.tagName)) return;
      for (const n of el.childNodes) if (n.nodeType === 3 && JA.test(n.nodeValue)) out.push(n.nodeValue.trim());
      for (const c of el.children) walk(c);
    };
    walk(document.body);
    return [...new Set(out)];
  }

  // このスクリプトは body の末尾で読まれる（静的DOMは出来ている）ので、英語ならここで置き換える＝日本語が一瞬見えることはない
  if (lang === 'en') applyDom();
  return { t, has, disp, canon, dispList, applyDom, setLang, onChange: f => listeners.push(f), get lang() { return lang; }, untranslated, EN };
})();
window.t = window.I18N.t;
