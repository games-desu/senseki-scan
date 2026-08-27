// merged2 — merged.js ＋ 静止物棄却の再設計（敵対検証で指摘された退行への回答）
//   検証で判明: 幾何ROIは「ゴミが画面上部帯にあるコート」でしか効かず、新コートでは
//   観客席・パラソル・かご・速度板・芝の刈りムラが素通しになる（merged の唯一の退行）。
//   再設計: overlap>=OV_TH の静止棄却を pass1 でフル復活させ、棄却した候補は捨てずに reserve へ退避。
//   区間採用後、**採用済み軌跡の端と内部欠測の近傍だけ** reserve から復活させる。
//   これで「静止物棄却は全力・ボールは予測位置近傍で免除」が同時に成立する。
//   準重複フレームやスタッター（ov=1.00の実ボール）は内部欠測の復活が拾う。
// ============================================================================================
// merged.js — 3方針（候補抽出 / 候補フィルタ / 鎖と区間の門）の統合。自己完結の1ファイル。
//
//   node tools/rally-bench.js --variant merged
//
// 出典（コードは require せずコピーしてある）:
//   candidates()        … tools/variants/fused-core.js（トレイル融合CCからの核彫り出し）
//   filterCandidates()  … tools/variants/roi-net.js（幾何ROI＋ネット帯の開放）＋統合で足した帯ガード
//   buildChains()       … tools/variants/chain-gates.js ＋統合で足した「隙間つき連結の速度ゲート」
//   pickBall()          … tools/variants/chain-gates.js（そのまま）
//   ballSegments()      … tools/variants/chain-gates.js（そのまま）
//   eventCandidates() / classifyEvents()
//                       … tools/ball.js からの写し ＋ 統合フェーズで見つけた2つの直し（下の (4)(5)）。
//                          ball.js の classifyEvents は自前クロージャの eventCandidates を呼ぶので、
//                          候補側だけ差し替えても効かない。両方まとめて写してある。
//
// --------------------------------------------------------------------------------------------
// 統合で分かったこと（すべて tools/rally-bench.js の実測）
//
// (1) 幾何ROI と 核彫り出し は素直に足し合わさる。
//     fused-core + chain-gates            found 12 correct 11 covered 12 cm 17.3 nm 0.621 onBall 9 false 22
//     ＋幾何ROI（ネット帯は閉じたまま）   found 12 correct 12 covered 12 cm 17.5 nm 0.624 onBall 9 false 22
//
// (2) **ネット帯を開けると、彫り出した核が帯の中で暴発して全部を壊す。**
//     ＋ネット帯を開ける（roi-net 素）    found 10 correct  7 covered 11 cm 12.8 nm 0.453 onBall 6 false 31
//     ＋帯の中の carved を落とす          found 11 correct 11 covered 12 cm 20.2 nm 0.718 onBall 9 false 32
//     ＋帯の中の fused も落とす           found 12 correct 12 covered 12 cm 19.3 nm 0.671 onBall 9 false 29
//     roi-net 単体（素の candidates）では帯を開けても壊れない（correct 9・onBall 10）ので、
//     これは roi-net の欠陥ではなく **彫り出し × 帯開放の相互作用**。
//     ネットのメッシュ自体は g<160 で候補にならないが、メッシュに重なった打球トレイルは
//     巨大な低fillのCCになるため carve の対象になり、くびれで割った片が
//     「丸くて期待面積の数倍」の核として帯の中に大量に湧く。ネット帯は遠近的に
//     期待直径が小さい帯なので、上限を外した核はほぼ無条件に通ってしまう。
//     → 帯の中だけは彫り出し／再重心づけの結果を採らない（＝素のCCしか信じない）。
//
//     ★★ (4)(5)(6) を入れた後に測り直したら、**この guard はもう要らない**（BAND_NO_CARVE=0）。
//        崩壊の正体は「帯の中の核が暴発する」ことではなく、**増えた区間境界が classifyEvents の
//        tStop を潰して種別が総崩れになる**ことだった。(5) で打ち切りを外せるようにしたら消えた。
//        実測: BAND_NO_CARVE 1→0 で found 12 correct 12 のまま
//              coverMean 20.7→**21.7** / nearMean 0.732→**0.752** / onBall 10 / false 31→32。
//        増えた点は目視で確認済み（V_band.png）: 387.667/387.683 と 387.883/387.900 の4点は
//        **ネットのメッシュを透かして見えているボールそのもの**で、前後の点の間を
//        dx≈10 dy≈-32 px/frame で正確に補間する。guard は本物を捨てていた。
//        ＝「相互作用で壊れた」ように見えたものが、実は下流の別の欠陥だったという例。
//        他コートでも悪化しない（11-02-43 区間 29→22・イベント 28→26・採用点 317→327 /
//        01-57-16 不変 / 23-19-09 採用点 191→198 / 22-18-37 149→152）。
//
// (3) 打点直後の3コマが消える件（id7=387.55 のとびつき打点・dpx 127）は
//     **速度ゲートが「長い隙間ほど通りやすい」ために起きていた。**
//     実測: 387.4833(233,425) → 387.5833(261,368) は k=6 で平均速度差 dv=9.1 ≤ 13 なので通るが、
//     その途中の 387.500/387.5167/387.5333（実在するボール候補）から 387.5833 への
//     k=5/4/3 の連結は dv=13.7/14.9/20.2 でいずれも 13 に阻まれる。
//     結果、鎖は打点を丸ごと飛び越して繋がり、飛び越された3コマは
//     「祖先が used」で長さ3の孤児になり minLen=5 に届かず捨てられる。
//     隙間 k コマの連結は「その間ボールは弾道飛行していた」という主張なので、
//     1コマ連結の測定ノイズと同じ許容を与えてはいけない。k とともに**締める**のが正しい。
//         dv <= VEL_GATE / (1 + VEL_K*(k-1))
//     VEL_K=0.35 で id7 の dpx が 127→6 に戻る（k=6 の許容 6.6 < 9.1 で飛び越しが止まり、
//     鎖が 387.5333 で正しく切れて区間側で縫われる）。
//
// (4) ★イベント候補の密度ゲートが、**検出したいイベントそのもの**を検閲していた。
//     eventCandidates の kink 判定には `track[i+W].f - track[i-W].f > 3*W` という
//     「この付近の追跡が疎すぎるなら使わない」ゲートがある（W=6）。
//     ところが打点では、まさにその瞬間にボールが数コマ欠測する。id5(386.42 の相手の打点)の実測:
//         386.400 (391,118) Z=7.70  ← ラベル座標そのもの(dpx 0)
//         [f193..f197 の5コマが欠測 = 打点の瞬間]
//         386.500 (370,130) Z=6.60
//     この欠測のせいで i=142/143 の全体スパンが 19 コマとなり 18 をわずかに超え、
//     **近傍で最大の kink 0.472（次点の 0.286 の1.6倍）が捨てられていた。**
//     静止物フィルタと同じ構図で、品質を守るための機構が守るべき対象を殺している。
//     直し方: 全体スパンでなく**左右の脚を別々に**見る。中央の隙間＝イベントそのものは数えない。
//         track[i-1].f - track[i-W].f <= LEG_SPAN*W  かつ  track[i+W].f - track[i+1].f <= LEG_SPAN*W
//     LEG_SPAN は 2.0〜99 のどこでも correct 12（実測）。1.5 だけ id1 が bounce に落ちる。
//     ＝閾値のチューニングで稼いだ改善ではない。既定 5.0（6点の脚が 30コマ=0.5秒 以内）。
//
// (5) ★tStop の打ち切りが slopeZ の最小点数を割ると、必ず 'unknown' になる。
//     classifyEvents は「次の候補の 0.06 秒前」で測定窓を打ち切る。(4) で 386.500 の候補が
//     復活しても、0.133 秒後の候補 386.633 が窓を 386.573 までに切り、
//     残る点が2個（slopeZ は3個必要）になって unknown → applyRallyRules が bounce と当て推量していた。
//     直し方: 打ち切りの結果が3点未満なら、その回だけ打ち切りを外して tEvt+0.50 まで測る。
//     **代替は必ず 'unknown'（＝当て推量）なので、測る方が悪くなることはない。**
//     これで id5 が hit と正しく判定され correct 11→12。
//     なお候補側の重複統合幅(0.12)を広げて 386.633 を潰す案も試したが、
//     id2(384.55) と id9(117.28) を巻き添えにする（実測 0.14 で correct 11→10）。**広げないこと。**
//
// (6) refineTime は候補を最大±0.30秒動かすので、生候補で 0.12 秒離れていた2件が
//     結果として同じ時刻に重なる（実測 386.915/386.905 と 122.787/122.835）。
//     ball.js は refineTime 後に重複を潰しておらず、出力の時刻順ソートもしていない
//     （＝時刻逆転した配列を applyRallyRules が舐めている）。
//     ソートしてから 0.12 秒で潰す。falseEvents 32→31。他の6指標は完全に不変。
//
// --------------------------------------------------------------------------------------------
// 目視で確認した残る欠陥（数字だけでは見えない。統合担当が rally-tile.js で確認した）
//
// (A) id12(122.30) の cover 16 点のうち **11 点は静止物の上**。22-02-04 のロブ頂点で、
//     採用トラックが奥のフェンスに掛かった**黄色い用具かご**に乗る（目視確定・V_id12b.png）。
//     カメラのドリーでかごが画面上を 3px/frame 動くので「動いていない」判定では捕まらない。
//     機構: 本物の鎖(seg6)は n が 30→11 と痩せながら上昇 → かごの鎖(n≈48)とは
//     linkCost の nRatio(4.7>3) で繋がらない。だが **rank 67.4 が SEED_RANK=40 を超えるので
//     「独立した種」として採用されてしまう**。STRICT_ADJ / SEG_NRATIO=2 / MIN_LEN_SEG を
//     試したがどれも7指標が1つも動かない（種の経路には効かないため）。**未解決。**
//     → この 11 点を引いた「正味の coverMean」は 20.8（21.7 − 11/12）。b0 の 13.4 は大きく上回る。
//        **報告に載せる数字は 21.7 だが、そのうち約 0.9 は静止物由来である。**
//     他11ラベルは cover 窓が1〜2区間に収まり、目視でもボールに乗っていた（下の確認記録）。
//
// (B) ボールが1コマも写っていない場面で区間が乱立する（docs 未解決#5・シーン判定が無い）。
//     11-02-43 の 240.5-247.5 は 242.9 以降がポイント終了の演出カット（星マーカー・
//     「ふかいボール！」の吹き出し・MATCH POINT 表示）で、画面上部の草むらに候補が数十個湧く。
//     実測 区間数: 現行 2 / b0 1 / +彫り出し 1 / +幾何ROI 2 / **+鎖と区間の門 16 / 統合 29**。
//     ＝ 増やしているのは鎖・区間の層（minRank 撤廃と種の採用）であって候補側ではない。
//     イベント数は本ファイルの (4)(5)(6) で 34→28 に下がる。
//     緩和レバー（すべて実測・既定は変えていない）:
//       MIN_LEN_SEG 5→6  ラベル: f12 c12 cov12 cm20.9 nm0.736 ob10 fe32
//                        他コート: 11-02-43 区間 29→15 ／ 23-19-09 採用点 191→176(-8%)
//       MIN_LEN_SEG 5→8  ラベル: f12 c12 cov12 cm20.9 nm0.728 ob10 fe31
//                        他コート: 11-02-43 区間 29→11 ／ 23-19-09 採用点 191→176・01-57-16 242→235
//       POOL_RANK 45→55  ラベル同点(cm20.7 fe31)／11-02-43 区間 29→13・採用点 317→292
//     **既定を 5 のままにしたのは、短い区間の切り捨てが「打点直後の数コマ」を捨てる方向で、
//     本課題（再捕捉率）と逆を向くため。** シーン判定が入ったら 6〜8 に上げてよい。
//     YCAP(60→100/140/∞) は7指標も他コートもまったく動かない＝この件の原因ではない。
//
// (C) 目視で「本物」を確認した箇所（Read で実際に画像を見た）
//     V_id5.png    386.32-386.63 id5 の打点。**最大チャージの白い閃光が5コマ ボールを覆う**のを
//                  目視確認。(4) の欠測の正体はこれ。閃光の前後は緑枠がボールに乗っている。
//     V_id10.png   118.58-118.87 id10。18コマ全部でマゼンタ枠がボールに乗り、ネット帯を
//                  横切って追跡が続く（b0 では cover 0 だった区間）。ネット帯開放の効果の実物。
//     V_id1.png    383.83-384.12 id1。ハナチャンの頭の**白い花には毎コマ緑枠(候補)が付くが、
//                  採用トラックは一度も乗らない**。V_flower.png で 5倍に拡大して色を確認済み。
//     V_id12b.png  122.63-122.93 id12。上記 (A) の用具かご。
//     V_cut.png    11-02-43 t=245.0。上記 (B) の演出カット。
//     id7(387.55 とびつき) は数値で確認: 387.217-387.533 の間ボールは 1〜2px/frame で**転がって**
//     おり（＝この課題の出発点だった「静止物フィルタが殺していた」当のケース）、
//     387.517 にラベル座標 (475,854) を通過。打点後 seg3 は (523,737)→(790,264) と
//     0.52秒で単調に移動する。静止物ではありえない。dpx 6。
//
// --------------------------------------------------------------------------------------------
// 実測（tools/rally-bench.js・人手ラベル12件・すべて自分で実行）
//   現行(overlap<0.6)  found  5 correct  5 covered 10 cm 10.8 nm 0.427 onBall  9 false 26
//   b0 = no-static     found 11 correct  9 covered 11 cm 13.4 nm 0.516 onBall 10 false 25
//   fused-core         found 10 correct  9 covered 11 cm 16.3 nm 0.581 onBall 10 false 28
//   chain-gates        found 12 correct 11 covered 12 cm 16.5 nm 0.609 onBall 10 false 25
//   roi-net            found 11 correct  9 covered 12 cm 17.4 nm 0.624 onBall 10 false 29
//
//   統合の段階（すべて同じ部品のオン/オフで実測。A=核彫り出し B=幾何ROI+ネット帯 C=鎖と区間の門）
//                                   found correct covered  cm    nm   onBall false
//   なし（= b0 の再現）               11     9      11    13.4  0.516   10    25
//   A のみ                            10     9      11    16.3  0.581   10    28
//   B のみ                            11     9      12    17.4  0.624   10    29
//   C のみ                            11     9      12    16.6  0.603   10    29
//   A+B（★C が無いと崩れる）          10     9      12    19.4  0.672    9    34
//   A+C                               11    11      12    18.5  0.637    9    22
//   B+C                               11    11      12    19.7  0.711   10    31
//   A+B+C（イベント層は ball.js のまま）11    11      12    20.7  0.732   10    32
//   ＋(4) 脚ごとの密度ゲート           12    11      12    20.7  0.732   10    31
//   ＋(5) tStop の打ち切り解除         12    12      12    20.7  0.732   10    32
//   ＋(6) refineTime 後の重複統合      12    12      12    20.7  0.732   10    31
//   ＋帯の carve guard を外す（既定）   12    12      12  **21.7  0.752** 10    32
// ============================================================================================
(() => {
  const B = window.BallTrack;
  let RESERVE = null;   // filterCandidates が書き、resurrect が読む（1解析=1本前提）
  let LASTKEPT = null;  // 直前フレームで生き残った候補（candidates の近傍loose再探索が読む）
  const W = 960, H = 540, SC = 2, YVP = -651;
  const expectDiam = yF => 0.0155 * (yF - YVP);
  const d960At = y960 => expectDiam(y960 * SC) / SC;

  // 掃引用の外部上書き（本番では未定義）。tools/variants/ の外から window.MERGED_CFG を置くと効く。
  const CFG = Object.assign({
    // ---- candidates（fused-core） ----
    FILL_MIN: 0.42,     // 現行と同じ。緩めない
    LO_A: 0.35,         // 現行と同じ。緩めない
    HI_A: 3.0,          // 現行の「枠内」上限
    ROUND_ASP: 1.6,     // 割れた片に上振れを許すときの丸さ
    MAX_D960: 26,       // 見かけ直径の絶対上限（FHD 52px）
    MAX_N: 560,         // 0.785 * 26^2
    ERODE_MAX: 3,       // くびれ切りの収縮回数
    CORES_MAX: 2,       // 1CCから出す核の数（3にすると correct が落ちる）
    CORE_RG_TOL: 0.07,
    CC_MAX_PX: 20000,
    WHOLE_ROUND: 0,     // 「丸くて大きい単独CC」を丸ごと通すか（既定オフ）
    CARVE_LOWFILL: 1,

    // ---- filterCandidates（roi-net ＋ 統合の帯ガード） ----
    UREL: 1.15,         // 奥ベースラインより奥をどこまで許すか。1.13以下/1.20以上は悪化
    YFALL: 34,          // カメラ未確定時の上端（960空間）
    YCAP: 60,           // 壊れたカメラ推定への保険
    YT_KEEP: 3,         // yTop の跳ね止め（直近3回の最小値）
    BAND_OPEN: 1,       // 1=ネット帯を開ける / 0=従来どおり帯を丸ごと除去
    BAND_RG: 0.99,      // 帯の中で「白い」とみなす CC平均 r/g
    BAND_ELONG: 3.0,    // 帯の中で落とす細長さ（帯内ボールの実測上限 2.60）
    // ★0 に変更した。上の (2) を参照——この guard は「旧イベント層の脆さ」への対症療法で、
    //   (4)(5)(6) が入った今は不要どころか**本物のボール点を捨てている**。
    //   1 に戻すと coverMean 21.7→20.7 / nearMean 0.752→0.732（correct 12 は変わらず、false 32→31）。
    //   false に余裕が欲しいときだけ 1 に戻す価値がある。
    BAND_NO_CARVE: 0,
    BAND_NO_FUSED: 0,   // 帯の中で再重心づけしたCCも落とすか。1 にすると correct 12→11・cm 19.8。
                        // 落とすべきものは無い（実測）。

    // ---- buildChains（chain-gates ＋ 統合の隙間つき速度ゲート） ----
    STEP_K: 2.5, STEP_FLOOR: 12, MIN_LEN: 5,
    // ★MAX_GAP は chain-gates の 6 から 5 に下げた。理由は上の (3)。
    //   飛行中の最長欠測は実測4コマなので、6コマの隙間を鎖の層で繋ぐ必要はない。
    //   それより長い分断は区間側の縫い合わせ（GMAX=15・VMAX・SEG_NRATIO つき）に任せる方が安全。
    //   実測 MAX_GAP: 3→cm20.3/correct10  4→20.3/10  **5→20.7/11**  6→20.2/11(onBall 9)  7→20.3/11(onBall 9)  8→19.7/11
    //   ★BAND_NO_CARVE=0 にした後は 6 で**崩壊**する（実測 f9 c8 cov10 cm12.3 nm0.424 ob6）。
    //     帯の中の核まで候補にあるとき、6コマの飛び越しが別物へ乗り移る余地を一気に広げる。
    //     5 から動かさないこと。
    MAX_GAP: 5,
    N_RATIO: 3, VEL_GATE: 13,
    // ★隙間 k コマの連結は VEL_GATE/(1+VEL_K*(k-1)) まで（上の (3) の機構的な直し方）。
    //   既定 0（無効）。MAX_GAP=5 が同じ飛び越しを既に止めているので二重にかけると
    //   id12(122.30) の打点が unknown に落ちる（実測 correct 11→10）。
    //   **MAX_GAP を 6 以上に戻すなら 0.15 にすること**（それで id7 の dpx 127→6 が直る。実測済み）。
    VEL_K: 0,

    // ---- pickBall（chain-gates そのまま） ----
    W_SIZE: 25, N_REL_LO: 0.6, N_REL_HI: 3.5,
    W_SPAN: 3, SPAN_CAP: 20, W_LEN: 0.25, LEN_CAP: 8,
    W_VERT: 20, W_NET: 25, FLAT_PEN: 25, FLAT_TH: 2.5,

    // ---- ballSegments（chain-gates ＋ 統合の「ボールが写っていない場面」対策） ----
    SEED_RANK: 40,
    // ★POOL_RANK 25→45 / MIN_LEN_SEG 3→5。**人手ラベル12件では 25〜60 / 3〜5 のどれでも
    //   7指標が完全に同点**（found11 correct11 covered12 cm20.7 nm0.732 onBall10 false32）。
    //   効くのは「ボールが写っていない場面」。11-02-43 の 243〜247 秒は草むらとキノコの
    //   演出カットでボールが1コマも無いが、そこで区間が 42本・イベント36個も立っていた
    //   （目視確認済み。追跡点は葉・キノコ・速度表示板の上）。5/45 にすると 21本/33個 に半減する。
    //   MIN_LEN_SEG=5 は buildChains の MIN_LEN=5 と揃えただけ（trim後の3点の切れ端を区間にしない）。
    //   POOL_RANK は 55 以上にしてはいけない: 23-19-09（曇天の芝・影が出ない最難コート）の
    //   採用点が 60 で 342→220 に落ちる崖がある。45 は崖から十分離れている。
    POOL_RANK: 45, MIN_LEN_SEG: 5, Y_MIN: 20,
    STATIC_SPAN: 1.5, REV_MAX: 0.1, REV_NEAR: 6, REV_LEAVE: 20,
    AMBIG: 2, GMAX: 15, VMAX: 26, SEG_NRATIO: 3,
    GPEN: 0.4, NPEN: 2, BOTH_BONUS: 0.6,
    VEL_WIN: 4, VEL_BONUS: 6, VEL_SCALE: 12,
    MERGE_GAP: 24, MERGE_TOL: 12, MERGE_TOL_D: 5, MERGE_TOL_F: 1.5,
    MERGE_VX: 4, MERGE_VUP: 1.5, G_ACC: 3,

    // ---- eventCandidates / classifyEvents（統合フェーズで新規。上の (4)(5)(6)） ----
    KINK_W: 6, KINK_TH: 0.18, KINK_LOCMAX: 3,   // ball.js と同値。触っていない
    // ★脚ごとの密度ゲート（0 にすると ball.js の全体ゲート `>3*W` に戻る）。
    //   実測: 1.5→correct 11 / **2.0〜99 はすべて correct 12**。平坦域が極端に広い。
    //   false は 2.0〜3.0 で 32、4.0 以上で 31。既定 5.0（6点の脚が 30コマ=0.5秒 以内）。
    LEG_SPAN: 5.0,
    // ★候補側の重複統合幅。**広げてはいけない**（0.14 で id2 と id9 を失い correct 12→10。実測）
    CAND_DEDUP: 0.12,
    POST_DEDUP: 0.12,   // refineTime 後の重複統合。0 にすると false 31→32、他6指標は不変
    RELAX_TSTOP: 1,     // 打ち切りで3点未満になったら打ち切りを外す。0 にすると id5 が bounce（correct 12→11）

    // ---- 静止物棄却の再設計（merged2 新規） ----
    OV_TH: 0.6,         // pass1 の静止棄却（現行 ball.js と同じ強さ。null で無効=旧mergedと同じ）
    RES_ENABLE: 1,      // 採用区間の近傍で reserve から復活させる
    RES_R0: 8,          // 復活の探索半径の基本値（960px）
    RES_RK: 4,          // 欠測1コマごとの半径の伸び
    RES_RMAX: 24,       // 半径上限
    RES_MISS: 4,        // 連続これだけ見つからなければ延長を打ち切る
    RES_NRATIO: 3,      // 復活候補の n が直前採用点の何倍まで許されるか（identity）
    // ---- 近傍loose再探索（merged2 新規・オーラ色汚染対策） ----
    // 打球オーラ/ビームがボール色を汚すと strict 色域から外れて点が消える（実測: id12 の離脱脚）。
    // Tracker には「予測近傍だけ loose で再探索」があるのに DP 経路には無かった。
    // **グローバルに緩めるのは禁止**（b-color: nearMean 0.893 でも onBall 0/12）。
    // 前フレームで生き残った候補の近傍 ±LOOSE_R だけで loose 検出し、strict が無いときのみ足す。
    // 実測: 1 で cm 20.7→22.9 / nm +0.057 だが onBall 10→9・false 28→34（ゴミ候補まで延命する）。
    // R15+発動元n>=25 に絞っても false 31・id12 は直らず。既定オフ。id12 の根治は別设计が要る。
    LOOSE_NEAR: 0,
    LOOSE_R: 25,        // 探索半径（960px）
    LOOSE_MISS_N: 2,    // 前フレーム候補の近くに strict 候補がこの距離内に無いときだけ発動
  }, (typeof window !== 'undefined' && window.MERGED_CFG) || {});

  // ==========================================================================================
  // 1. candidates — トレイル融合CCから「くびれ」で核を彫り出す（出典 fused-core.js）
  // ==========================================================================================
  function erode(src, w, h) {
    const dst = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!src[i]) continue;
        if (src[i - 1] && src[i + 1] && src[i - w] && src[i + w] &&
            src[i - w - 1] && src[i - w + 1] && src[i + w - 1] && src[i + w + 1]) dst[i] = 1;
      }
    }
    return dst;
  }
  function dilateGeo(seed, ref, w, h, times) {
    let cur = seed;
    for (let t = 0; t < times; t++) {
      const nx = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!ref[i]) continue;
          if (cur[i]) { nx[i] = 1; continue; }
          let on = 0;
          for (let dy = -1; dy <= 1 && !on; dy++) {
            const ny = y + dy; if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const ax = x + dx; if (ax < 0 || ax >= w) continue;
              if (cur[ny * w + ax]) { on = 1; break; }
            }
          }
          nx[i] = on;
        }
      }
      cur = nx;
    }
    return cur;
  }
  function localCC(m, w, h) {
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), out = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i0 = y * w + x;
        if (!m[i0] || seen[i0]) continue;
        let sp = 0; stack[sp++] = i0; seen[i0] = 1;
        const pts = [];
        while (sp) {
          const p = stack[--sp], py = (p / w) | 0, px = p - py * w;
          pts.push(p);
          for (let dy = -1; dy <= 1; dy++) {
            const ny = py + dy; if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const ax = px + dx; if (ax < 0 || ax >= w) continue;
              const ni = ny * w + ax;
              if (m[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; }
            }
          }
        }
        out.push(pts);
      }
    }
    return out;
  }
  function measure(pts, w, ox, oy, data, prev) {
    const n = pts.length;
    let sx = 0, sy = 0, bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9, sr = 0, sg = 0, ov = 0;
    for (const p of pts) {
      const ly = (p / w) | 0, lx = p - ly * w, x = ox + lx, y = oy + ly;
      sx += x; sy += y;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      const gi = y * W + x, i = gi * 4;
      sr += data[i]; sg += data[i + 1];
      if (prev && prev[gi]) ov++;
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    return { n, cx: sx / n, cy: sy / n, bw, bh, fill: n / (bw * bh),
             rg: sg > 0 ? sr / sg : 0, overlap: n ? ov / n : 0 };
  }
  function geom(m) {
    const yF = m.cy * SC, d960 = expectDiam(yF) / SC;
    return { d960, A: 0.785 * d960 * d960,
             dim: Math.max(m.bw, m.bh),
             asp: Math.max(m.bw, m.bh) / Math.max(1, Math.min(m.bw, m.bh)) };
  }
  // 'ok' 現行の枠内 / 'round' 上振れだが丸い / 'carve' 上振れ・核を彫る / null 捨てる
  function verdict(m, allowRound) {
    if (m.fill <= CFG.FILL_MIN) return null;
    const g = geom(m);
    if (m.n < CFG.LO_A * g.A) return null;                      // 下限は緩めない
    if (m.n <= CFG.HI_A * g.A && g.dim <= 3 * g.d960) return 'ok';
    if (allowRound && g.asp <= CFG.ROUND_ASP && g.dim <= CFG.MAX_D960 && m.n <= CFG.MAX_N) return 'round';
    return 'carve';
  }
  function carvable(m) {
    const g = geom(m);
    if (m.n < CFG.LO_A * g.A) return false;
    if (!CFG.CARVE_LOWFILL && m.fill <= CFG.FILL_MIN) return false;
    return m.n > CFG.HI_A * g.A || g.dim > 3 * g.d960;
  }
  function scoreCore(m) {
    const g = geom(m);
    return m.fill
         + (1 - Math.min(1, (g.asp - 1) / 1.2))
         + (1 - Math.min(1, Math.abs(m.rg - 0.94) / 0.12));
  }
  // 収縮 → 2片以上に割れたら（＝くびれがあった証拠）その片だけ面積上限を外して判定 →
  // 測地膨張で収縮した分だけ元の広がりに戻す
  function carveCores(c, data, prev) {
    if (c.n > CFG.CC_MAX_PX) return [];
    const ox = c.bx0 - 1, oy = c.by0 - 1, w = c.bw + 2, h = c.bh + 2;
    if (ox < 0 || oy < 0 || ox + w > W || oy + h > H) return [];
    const ref = new Uint8Array(w * h);
    for (const p of c.pts) { const py = (p / W) | 0, px = p - py * W; ref[(py - oy) * w + (px - ox)] = 1; }
    let cur = ref;
    for (let it = 1; it <= CFG.ERODE_MAX; it++) {
      cur = erode(cur, w, h);
      const parts = localCC(cur, w, h).filter(p => p.length >= 6);
      if (!parts.length) break;
      if (parts.length < 2) continue;         // 割れていない＝くびれの証拠が無い
      const got = [];
      for (const pts of parts) {
        const seed = new Uint8Array(w * h);
        for (const p of pts) seed[p] = 1;
        const back = dilateGeo(seed, ref, w, h, it);
        const idx = [];
        for (let i = 0; i < back.length; i++) if (back[i]) idx.push(i);
        const m = measure(idx, w, ox, oy, data, prev);
        const v = verdict(m, true);
        if ((v === 'ok' || v === 'round') && Math.abs(m.rg - 0.94) <= CFG.CORE_RG_TOL)
          got.push({ m, s: scoreCore(m) });
      }
      if (got.length) {
        got.sort((a, b) => b.s - a.s);
        return got.slice(0, CFG.CORES_MAX).map(g => g.m);
      }
    }
    return [];
  }

  function candidates(img, opts = {}) {
    const test = opts.loose ? B.isBallLoose : B.isBall;
    const d = img.data;
    const roi = opts.roi || { x0: 20, y0: 0, x1: 940, y1: 470 };
    const mask = new Uint8Array(W * H);
    for (let y = roi.y0; y < roi.y1; y++) {
      for (let x = roi.x0; x < roi.x1; x++) {
        const i = (y * W + x) * 4;
        if (test(d[i], d[i + 1], d[i + 2])) mask[y * W + x] = 1;
      }
    }
    const prev = opts.prevMask || null;
    const ccs = B.components(mask, roi);
    const out = [];
    for (const c of ccs) {
      const yF = c.cy * SC, d960 = expectDiam(yF) / SC, A = 0.785 * d960 * d960;
      let sr = 0, sg = 0, ovc = 0;
      for (const p of c.pts) { const i = p * 4; sr += d[i]; sg += d[i + 1]; if (prev && prev[p]) ovc++; }
      const rgMean = sg > 0 ? sr / sg : 0;
      const whole = { n: c.n, cx: c.cx, cy: c.cy, bw: c.bw, bh: c.bh, fill: c.fill,
                      rg: rgMean, overlap: c.n ? ovc / c.n : 0 };
      const v = verdict(whole, !!CFG.WHOLE_ROUND);

      if (v === 'ok') {
        // 現行と完全に同じ道（融合CCの再重心づけを含む）
        let cx = c.cx, cy = c.cy, fused = false;
        if (Math.max(c.bw, c.bh) > 2.2 * Math.min(c.bw, c.bh) || c.n > 1.8 * A) {
          fused = true;
          let wsum = 0, wx = 0, wy = 0;
          for (const p of c.pts) {
            const py = (p / W) | 0, pxx = p - py * W, i = p * 4;
            const g = d[i + 1] || 1, rg = d[i] / g;
            const wt = Math.max(0, 1 - Math.abs(rg - 0.95) / 0.12);
            if (wt > 0) { wsum += wt; wx += wt * pxx; wy += wt * py; }
          }
          if (wsum > 0) { cx = wx / wsum; cy = wy / wsum; }
        }
        out.push({ x: cx, y: cy, n: c.n, bw: c.bw, bh: c.bh, fill: c.fill, fused,
                   d: d960, rg: rgMean, overlap: whole.overlap,
                   rawX: c.cx, rawY: c.cy });
        continue;
      }
      if (v === 'round') {
        out.push({ x: c.cx, y: c.cy, n: c.n, bw: c.bw, bh: c.bh, fill: c.fill, fused: false,
                   d: d960, rg: rgMean, overlap: whole.overlap, big: true,
                   rawX: c.cx, rawY: c.cy });
        continue;
      }
      if (!carvable(whole)) continue;
      for (const m of carveCores(c, d, prev)) {
        out.push({ x: m.cx, y: m.cy, n: m.n, bw: m.bw, bh: m.bh, fill: m.fill, fused: true,
                   d: expectDiam(m.cy * SC) / SC, rg: m.rg, overlap: m.overlap, carved: true,
                   rawX: m.cx, rawY: m.cy });
      }
    }
    // ---- 近傍loose再探索（オーラ色汚染でstrictから消えた本体を、前フレーム候補の近傍だけで拾う） ----
    if (CFG.LOOSE_NEAR && LASTKEPT && LASTKEPT.length) {
      for (const lp of LASTKEPT) {
        // その近傍に strict 候補が既にあるなら不要
        if (out.some(c => Math.hypot(c.x - lp.x, c.y - lp.y) < CFG.LOOSE_R)) continue;
        const r = CFG.LOOSE_R;
        const lroi = { x0: Math.max(20, (lp.x - r) | 0), y0: Math.max(0, (lp.y - r) | 0),
                       x1: Math.min(940, (lp.x + r) | 0), y1: Math.min(470, (lp.y + r) | 0) };
        if (lroi.x1 <= lroi.x0 + 2 || lroi.y1 <= lroi.y0 + 2) continue;
        const lmask = new Uint8Array(W * H);
        for (let y = lroi.y0; y < lroi.y1; y++) for (let x = lroi.x0; x < lroi.x1; x++) {
          const i = (y * W + x) * 4;
          if (B.isBallLoose(d[i], d[i + 1], d[i + 2])) lmask[y * W + x] = 1;
        }
        const lccs = B.components(lmask, lroi);
        let best = null;
        for (const c of lccs) {
          const d960 = expectDiam(c.cy * SC) / SC, A = 0.785 * d960 * d960;
          if (c.n < 0.35 * A || c.n > 3.0 * A) continue;      // サイズは現行ゲートのまま緩めない
          if (c.fill <= CFG.FILL_MIN) continue;
          const dd = Math.hypot(c.cx - lp.x, c.cy - lp.y);
          if (!best || dd < best.dd) best = { c, dd, d960 };
        }
        if (best) {
          let ovc = 0;
          if (prev) { /* looseマスク由来なので前フレームstrictマスクとの重なりで代用 */ }
          out.push({ x: best.c.cx, y: best.c.cy, n: best.c.n, bw: best.c.bw, bh: best.c.bh,
                     fill: best.c.fill, fused: false, d: best.d960, rg: 0.95, overlap: 0,
                     loose: true, rawX: best.c.cx, rawY: best.c.cy });
        }
      }
    }
    out.mask = mask;
    return out;
  }

  // ==========================================================================================
  // 2. filterCandidates — 幾何ROI（出典 roi-net.js）＋ 統合で足したネット帯ガード
  //    overlap（1コマの重なり率）は一切参照しない。ctx.overlapMax は意図的に無視する。
  // ==========================================================================================
  function filterCandidates(cands, ctx = {}) {
    const net = ctx.net, cam = ctx.cam;
    const st = ctx.state || {};
    let yTop = CFG.YFALL;
    if (cam && cam.ok && typeof Court !== 'undefined') {
      const yFar = Court.toScreen(0, Court.Z_BASE, cam).y;      // FHD
      const y = (((yFar - YVP) / CFG.UREL) + YVP) / SC;          // 960空間へ
      if (isFinite(y)) {
        if (!st.ytHist) st.ytHist = [];
        st.ytHist.push(y);
        if (st.ytHist.length > CFG.YT_KEEP) st.ytHist.shift();
      }
    }
    if (st.ytHist && st.ytHist.length) yTop = Math.min.apply(null, st.ytHist);
    if (yTop > CFG.YCAP) yTop = CFG.YCAP;

    // 静止棄却で落とした候補の退避先（フレーム番号→候補列）。ballSegments の復活パスが読む
    if (ctx.f === 0 || st.resLastF == null || ctx.f < st.resLastF) { st.reserve = {}; }
    st.resLastF = ctx.f;
    RESERVE = st.reserve;
    const statics = [];
    const kept = cands.filter(c => {
      if (c.y < yTop) return false;                              // 奥ベースラインより上＝背景
      if (net && c.y >= net.y0 && c.y <= net.y1) {
        if (!CFG.BAND_OPEN) return false;                        // 従来どおり帯を丸ごと落とす
        // ★帯の中では「素のCCそのまま」しか信じない。彫り出した核も再重心づけも採らない。
        //   帯はネットのメッシュに打球トレイルが重なって巨大CCができる場所で、
        //   遠近的に期待直径が小さいので、上限を外した核がほぼ無条件に通ってしまう（実測 correct 12→7）。
        if (CFG.BAND_NO_CARVE && c.carved) return false;
        if (CFG.BAND_NO_FUSED && c.fused) return false;
        // ネットテープと白線の細片だけ形と色で落とす（帯内ボールの縦横比は実測 最大2.60）
        const lo = Math.max(1, Math.min(c.bw, c.bh));
        if (c.rg >= CFG.BAND_RG && Math.max(c.bw, c.bh) / lo >= CFG.BAND_ELONG) return false;
      }
      // ★静止棄却の復活: 幾何を通った候補だけが対象。ROI落ち＝背景は reserve に入れない
      if (CFG.OV_TH != null && c.overlap >= CFG.OV_TH) { statics.push(c); return false; }
      return true;
    });
    if (statics.length) {
      st.reserve[ctx.f] = statics.map(c => ({ t: ctx.t, f: ctx.f, x: c.x, y: c.y, n: c.n, ov: c.overlap }));
    }
    LASTKEPT = kept.map(c => ({ x: c.x, y: c.y, n: c.n }));
    return kept;
  }

  // ==========================================================================================
  // 3. buildChains — 遠近スケール上限＋identityゲート（出典 chain-gates.js）
  //    ＋ 統合で足した「隙間つき連結ほど速度ゲートを締める」
  // ==========================================================================================
  function buildChains(frames, opts = {}) {
    const maxGap = opts.maxGap ?? CFG.MAX_GAP;
    const minLen = opts.minLen ?? CFG.MIN_LEN;
    const byFrame = frames.map(() => []);
    frames.forEach((fr, f) => (fr.c || []).forEach(c => {
      byFrame[f].push({ f, t: fr.t, x: c[0], y: c[1], n: c[2], fill: c[3], rg: c[4],
                        best: 1, prev: null, vel: null, used: false });
    }));
    const nodes = byFrame.flat();

    for (const nd of nodes) {
      for (let k = 1; k <= maxGap; k++) {
        const pf = nd.f - k;
        if (pf < 0) break;
        for (const p of byFrame[pf]) {
          const d = Math.hypot(nd.x - p.x, nd.y - p.y);
          // 上限は遠近スケール。下限（静止＝背景）はここでは持たない
          const cap = Math.max(CFG.STEP_FLOOR, CFG.STEP_K * d960At((nd.y + p.y) / 2));
          if (d > cap * k) continue;
          // identity ゲート①: 見え方（塊の大きさ）が急に変わる連結は別物
          const na = Math.max(1, p.n), nb = Math.max(1, nd.n);
          const nr = Math.max(na, nb) / Math.min(na, nb);
          if (nr > CFG.N_RATIO) continue;
          const vx = (nd.x - p.x) / k, vy = (nd.y - p.y) / k;
          let pen = 0;
          if (p.vel) {
            // identity ゲート②: 速度が飛ぶ連結は別物（打点での反転は鎖を切ってよい。区間側で縫う）
            // ★隙間 k の連結は「その間ずっと弾道飛行していた」という主張なので、
            //   1コマ連結の測定ノイズと同じ許容を与えない。k とともに締める。
            const dv = Math.hypot(vx - p.vel.x, vy - p.vel.y);
            if (dv > CFG.VEL_GATE / (1 + CFG.VEL_K * (k - 1))) continue;
            pen = Math.min(1.2, dv / 10);
          }
          const sc = p.best + 1 - pen - (k - 1) * 0.35;
          if (sc > nd.best) { nd.best = sc; nd.prev = p; nd.vel = { x: vx, y: vy }; }
        }
      }
    }

    const chains = [];
    const sorted = nodes.slice().sort((a, b) => b.best - a.best);
    for (const end of sorted) {
      if (end.used) continue;
      const path = [];
      for (let nd = end; nd; nd = nd.prev) { if (nd.used) break; path.push(nd); }
      if (path.length < minLen) continue;
      path.reverse();
      path.forEach(nd => { nd.used = true; });
      const xs = path.map(p => p.x), ys = path.map(p => p.y);
      chains.push({
        pts: path.map(p => ({ t: p.t, f: p.f, x: p.x, y: p.y, n: p.n })),
        len: path.length, score: end.best,
        spanX: Math.max(...xs) - Math.min(...xs),
        spanY: Math.max(...ys) - Math.min(...ys),
        y0: Math.min(...ys), y1: Math.max(...ys),
      });
    }
    return chains.sort((a, b) => b.score - a.score);
  }

  // ==========================================================================================
  // 4. pickBall — 遠近正規化＋長さ加点の上限（出典 chain-gates.js・変更なし）
  // ==========================================================================================
  function yMedOf(ch) {
    const ys = ch.pts.map(p => p.y).slice().sort((a, b) => a - b);
    return ys[ys.length >> 1];
  }
  function stats(ch) {
    const nAvg = ch.pts.reduce((a, p) => a + p.n, 0) / ch.len;
    const d = Math.max(2, d960At(yMedOf(ch)));
    return {
      nAvg, d, nRel: nAvg / (0.785 * d * d),
      spanRel: ch.spanY / d, moveRel: (ch.spanX + ch.spanY) / d,
      vertRatio: ch.spanY / Math.max(20, ch.spanX + ch.spanY),
    };
  }
  function pickBall(chains, opts = {}) {
    const net = opts.net;
    return chains.map(ch => {
      const st = stats(ch);
      // 小さすぎ（ノイズ）は減点、大きすぎ（トレイル融合）は減点しない
      const sizeScore = st.nRel >= CFG.N_REL_LO
        ? Math.max(0, Math.min(1, 1 - (st.nRel - CFG.N_REL_HI) / CFG.N_REL_HI))
        : Math.max(0, st.nRel / CFG.N_REL_LO);
      let s = CFG.W_SIZE * sizeScore
            + Math.min(CFG.SPAN_CAP, st.spanRel * CFG.W_SPAN)
            + Math.min(CFG.LEN_CAP, ch.len * CFG.W_LEN)   // 上限が無いと静止物の長大な鎖が全部を締め出す
            + st.vertRatio * CFG.W_VERT;
      if (net && ch.y0 < net.y0 && ch.y1 > net.y1) s += CFG.W_NET;
      if (st.spanRel < CFG.FLAT_TH) s -= CFG.FLAT_PEN;
      return { ...ch, rank: s, nAvg: +st.nAvg.toFixed(1), nRel: +st.nRel.toFixed(2),
               spanRel: +st.spanRel.toFixed(2), moveRel: +st.moveRel.toFixed(2),
               vertRatio: +st.vertRatio.toFixed(2) };
    }).sort((a, b) => b.rank - a.rank);
  }

  // ==========================================================================================
  // 5. ballSegments — minRank 撤廃・縫い合わせ・trim・融合（出典 chain-gates.js・変更なし）
  // ==========================================================================================
  const first = ch => ch.pts[0];
  const last  = ch => ch.pts[ch.pts.length - 1];

  // 「一度 REV_LEAVE px 以上離れてから REV_NEAR px 以内に戻ってきた」点の割合。
  // 静止ブロブを渡り歩く背景鎖だけが正になる。漂うだけのボールは 0 のまま。
  function revisitRatio(pts) {
    if (pts.length <= 10) return 0;
    let rev = 0;
    for (let i = 10; i < pts.length; i++) {
      let back = false;
      for (let j = i - 10; j >= 0 && !back; j--) {
        if (Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) >= CFG.REV_NEAR) continue;
        for (let m = j + 1; m < i; m++)
          if (Math.hypot(pts[m].x - pts[i].x, pts[m].y - pts[i].y) > CFG.REV_LEAVE) { back = true; break; }
      }
      if (back) rev++;
    }
    return rev / (pts.length - 10);
  }
  function edgeVel(pts, atEnd) {
    const m = Math.min(CFG.VEL_WIN, pts.length);
    const seq = atEnd ? pts.slice(pts.length - m) : pts.slice(0, m);
    if (seq.length < 2) return null;
    const a = seq[0], b = seq[seq.length - 1], df = b.f - a.f;
    return df > 0 ? { x: (b.x - a.x) / df, y: (b.y - a.y) / df } : null;
  }
  function linkCost(A, C) {
    const p = last(A), q = first(C);
    const g = Math.round((q.t - p.t) * 60);
    if (g < 1 || g > CFG.GMAX) return null;
    const v = Math.hypot(q.x - p.x, q.y - p.y) / g;
    if (v > CFG.VMAX) return null;
    const na = Math.max(1, p.n), nb = Math.max(1, q.n);
    const nr = Math.max(na, nb) / Math.min(na, nb);
    if (nr > CFG.SEG_NRATIO) return null;
    let c = v + g * CFG.GPEN + (nr - 1) * CFG.NPEN;
    const va = edgeVel(A.pts, true), vc = edgeVel(C.pts, false);
    if (va && vc) {
      const dv = Math.hypot(va.x - vc.x, va.y - vc.y);
      c -= Math.max(0, CFG.VEL_BONUS * (1 - dv / CFG.VEL_SCALE));
    }
    return c;
  }
  function bestLink(ch, acc) {
    const t0 = first(ch).t, t1 = last(ch).t;
    let A = null, D = null;
    for (const s of acc) {
      if (s.t1 <= t0 && (!A || s.t1 > A.t1)) A = s;
      if (s.t0 >= t1 && (!D || s.t0 < D.t0)) D = s;
    }
    const cA = A ? linkCost(A, ch) : null;
    const cD = D ? linkCost(ch, D) : null;
    if (cA == null && cD == null) return null;
    if (cA != null && cD != null) return Math.min(cA, cD) * CFG.BOTH_BONUS;
    return cA != null ? cA : cD;
  }
  // 隙間の間ボールが自由飛行を続けていたと考えて矛盾しないか（＝事象の無い分断か）
  function freeFlight(A, D) {
    const p = last(A), q = first(D);
    const g = Math.round((q.t - p.t) * 60);
    if (g < 1 || g > CFG.MERGE_GAP) return false;
    const va = edgeVel(A.pts, true), vd = edgeVel(D.pts, false);
    if (!va || !vd) return false;
    if (Math.abs(va.x - vd.x) > CFG.MERGE_VX) return false;   // 横速度が変わった＝打点
    const dvy = vd.y - va.y;
    if (dvy < -CFG.MERGE_VUP) return false;                    // 上向きに転じた＝バウンド/打点
    if (dvy > CFG.G_ACC * g) return false;
    const ay = dvy / g;
    const ex = p.x + va.x * g;
    const ey = p.y + va.y * g + 0.5 * ay * g * g;
    const tol = Math.max(CFG.MERGE_TOL, CFG.MERGE_TOL_D * d960At((p.y + q.y) / 2)) + CFG.MERGE_TOL_F * g;
    return Math.hypot(q.x - ex, q.y - ey) <= tol;
  }

  function ballSegments(ranked, opts = {}) {
    const pool = ranked.filter(ch =>
      ch.len >= CFG.MIN_LEN_SEG && yMedOf(ch) >= CFG.Y_MIN && ch.rank >= CFG.POOL_RANK &&
      stats(ch).moveRel >= CFG.STATIC_SPAN && revisitRatio(ch.pts) <= CFG.REV_MAX);

    const acc = [], taken = new Set(), rejected = new Set();
    const push = (ch, src) => { taken.add(src); acc.push({ ...ch, t0: first(ch).t, t1: last(ch).t }); };

    // 採用済み区間と時間が重なる部分を削り、残った最長の連続部分を返す
    const trimFree = ch => {
      const free = ch.pts.filter(p => !acc.some(o => p.t >= o.t0 - 1e-9 && p.t <= o.t1 + 1e-9));
      if (!free.length) return null;
      let best = null, run = [free[0]];
      for (let i = 1; i < free.length; i++) {
        if (free[i].f - free[i - 1].f <= CFG.MAX_GAP) run.push(free[i]);
        else { if (!best || run.length > best.length) best = run; run = [free[i]]; }
      }
      if (!best || run.length > best.length) best = run;
      if (best.length < CFG.MIN_LEN_SEG) return null;
      if (best.length === ch.pts.length) return ch;
      const xs = best.map(p => p.x), ys = best.map(p => p.y);
      return { ...ch, pts: best, len: best.length,
               spanX: Math.max(...xs) - Math.min(...xs), spanY: Math.max(...ys) - Math.min(...ys),
               y0: Math.min(...ys), y1: Math.max(...ys) };
    };

    for (let guard = 0; guard < 500; guard++) {
      const linked = [];
      let bestSeed = null, bestSeedSrc = null;
      for (const src of pool) {
        if (taken.has(src) || rejected.has(src)) continue;
        const ch = trimFree(src);
        if (!ch) continue;
        const c = acc.length ? bestLink(ch, acc) : null;
        if (c != null) linked.push({ ch, c, src });
        else if (ch.rank >= CFG.SEED_RANK && (!bestSeed || ch.rank > bestSeed.rank)) { bestSeed = ch; bestSeedSrc = src; }
      }
      linked.sort((a, b) => a.c - b.c);
      if (linked.length) {
        const b = linked[0];
        const rival = linked.find(o => o.src !== b.src && o.c - b.c < CFG.AMBIG &&
          first(o.ch).t <= last(b.ch).t && last(o.ch).t >= first(b.ch).t);
        if (rival) { rejected.add(b.src); rejected.add(rival.src); continue; }
        push(b.ch, b.src);
      } else if (bestSeed) push(bestSeed, bestSeedSrc);
      else break;
    }
    acc.sort((a, b) => a.t0 - b.t0);

    // 融合パス。事象の無い分断だけを1本にまとめ、境界候補の乱立を抑える。
    const out = [];
    for (const s of acc) {
      const prev = out[out.length - 1];
      if (prev && freeFlight(prev, s)) {
        prev.pts = prev.pts.concat(s.pts);
        prev.len = prev.pts.length;
        prev.t1 = s.t1;
        prev.rank = Math.max(prev.rank, s.rank);
      } else {
        out.push({ ...s, pts: s.pts.slice() });
      }
    }
    return resurrect(out);
  }

  // ==========================================================================================
  // 5.5 resurrect — 静止棄却で reserve に退避した候補を、採用済み軌跡の近傍だけ復活させる
  //   対象は (a) 区間内部の欠測コマ（補間点の近く） (b) 区間の前後の延長（直前採用点の近く）。
  //   延長は速度予測を使わない: 復活対象は本質的に低速（転がり・頂点・スタッター）で、
  //   高速の玉はそもそも overlap が低く pass1 を通る。位置ベースの近傍探索で足りる。
  // ==========================================================================================
  function nearestRes(list, x, y, r) {
    if (!list) return null;
    let best = null, bd = r;
    for (const c of list) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d <= bd) { bd = d; best = c; }
    }
    return best;
  }
  function resurrect(segs) {
    if (!CFG.RES_ENABLE || !RESERVE) return segs;
    const sorted = segs.slice().sort((a, b) => a.t0 - b.t0);
    const nOK = (a, b) => {
      const na = Math.max(1, a), nb = Math.max(1, b);
      return Math.max(na, nb) / Math.min(na, nb) <= CFG.RES_NRATIO;
    };
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const byF = new Map(s.pts.map(p => [p.f, p]));
      const f0 = s.pts[0].f, f1 = s.pts[s.pts.length - 1].f;
      // (a) 内部の欠測（準重複フレーム・スタッターの実ボールはここで戻る）
      for (let f = f0 + 1; f < f1; f++) {
        if (byF.has(f)) continue;
        let a = f - 1; while (a > f0 && !byF.has(a)) a--;
        let b = f + 1; while (b < f1 && !byF.has(b)) b++;
        if (!byF.has(a) || !byF.has(b)) continue;
        const pa = byF.get(a), pb = byF.get(b);
        const w = (f - a) / (b - a);
        const cand = nearestRes(RESERVE[f], pa.x + (pb.x - pa.x) * w, pa.y + (pb.y - pa.y) * w, CFG.RES_R0 + CFG.RES_RK);
        if (cand && nOK(cand.n, pa.n)) byF.set(f, { t: cand.t, f, x: cand.x, y: cand.y, n: cand.n, res: 1 });
      }
      // (b) 前後の延長。隣の区間には踏み込まない
      const fPrev = i > 0 ? sorted[i - 1].pts[sorted[i - 1].pts.length - 1].f + 1 : -Infinity;
      const fNext = i + 1 < sorted.length ? sorted[i + 1].pts[0].f - 1 : Infinity;
      for (const dir of [1, -1]) {
        let lastF = dir > 0 ? f1 : f0;
        let lastP = byF.get(lastF);
        let miss = 0;
        for (let f = lastF + dir; miss < CFG.RES_MISS; f += dir) {
          if (dir > 0 ? f > fNext : f < fPrev) break;
          if (f < 0) break;
          const gap = Math.abs(f - lastF);
          const r = Math.min(CFG.RES_RMAX, CFG.RES_R0 + CFG.RES_RK * gap);
          const cand = nearestRes(RESERVE[f], lastP.x, lastP.y, r);
          if (cand && nOK(cand.n, lastP.n)) {
            const np = { t: cand.t, f, x: cand.x, y: cand.y, n: cand.n, res: 1 };
            byF.set(f, np); lastF = f; lastP = np; miss = 0;
          } else miss++;
        }
      }
      const pts = [...byF.values()].sort((a, b) => a.f - b.f);
      s.pts = pts; s.len = pts.length;
      s.t0 = pts[0].t; s.t1 = pts[pts.length - 1].t;
    }
    return sorted;
  }

  // ==========================================================================================
  // 6. eventCandidates / classifyEvents — ball.js からの写し ＋ (4)(5)(6) の直し
  //    ここを写しているのは、ball.js の classifyEvents が**自前クロージャの** eventCandidates を
  //    呼んでいて、window.BallTrack.eventCandidates を差し替えても効かないため。
  //    判別式そのもの（qc = -s*dZ + s*zBias*HDOT、QTHRESH=0.15）は1文字も変えていない。
  // ==========================================================================================
  function eventCandidates(segments, track) {
    const out = [];
    for (const s of segments) {
      const p = s.pts; if (p.length < 4) continue;
      out.push({ t: p[p.length - 1].t, x: p[p.length - 1].x, y: p[p.length - 1].y, src: 'seg-end' });
      out.push({ t: p[0].t, x: p[0].x, y: p[0].y, src: 'seg-start' });
    }
    const KW = CFG.KINK_W;
    const sl = (a, b) => {
      let n = 0, sf = 0, sz = 0, sff = 0, sfz = 0;
      for (let i = a; i <= b; i++) {
        const p = track[i]; if (!p || !isFinite(p.Z)) continue;
        n++; sf += p.f; sz += p.Z; sff += p.f * p.f; sfz += p.f * p.Z;
      }
      if (n < 4) return null;
      const d = n * sff - sf * sf;
      return Math.abs(d) < 1e-9 ? null : (n * sfz - sf * sz) / d;
    };
    const kink = new Array(track.length).fill(0);
    for (let i = KW; i < track.length - KW; i++) {
      if (CFG.LEG_SPAN > 0) {
        // ★左右の脚を別々に見る。中央の隙間（＝打点そのもの）は数えない。上の (4)
        if (track[i - 1].f - track[i - KW].f > CFG.LEG_SPAN * KW) continue;
        if (track[i + KW].f - track[i + 1].f > CFG.LEG_SPAN * KW) continue;
      } else {
        if (track[i + KW].f - track[i - KW].f > 3 * KW) continue;   // ball.js の従来ゲート
      }
      const A = sl(i - KW, i - 1), Bb = sl(i + 1, i + KW);
      if (A != null && Bb != null) kink[i] = Math.abs(Bb - A);
    }
    for (let i = KW; i < track.length - KW; i++) {
      if (kink[i] < CFG.KINK_TH) continue;
      let isMax = true;
      for (let k = -CFG.KINK_LOCMAX; k <= CFG.KINK_LOCMAX; k++)
        if (kink[i + k] > kink[i]) { isMax = false; break; }
      if (isMax) out.push({ t: track[i].t, x: track[i].x, y: track[i].y, src: 'kink' });
    }
    out.sort((a, b) => a.t - b.t);
    const merged = [];
    for (const e of out) {
      const last = merged[merged.length - 1];
      if (last && e.t - last.t < CFG.CAND_DEDUP) {              // 幅を広げないこと（上の (5)）
        if (last.src !== 'kink' && e.src === 'kink') merged[merged.length - 1] = e;
        continue;
      }
      merged.push(e);
    }
    return merged;
  }

  function classifyEvents(segments, camAt, opts = {}) {
    const margin = opts.margin ?? 0.6;
    const qth = opts.qThresh ?? B.QTHRESH;
    const track = B.mergeTrack(segments).map(p => {
      const cam = typeof camAt === 'function' ? camAt(p.t) : camAt;
      const c = cam && cam.ok ? Court.toCourt(p.x * SC, p.y * SC, cam) : { X: NaN, Z: NaN };
      return Object.assign({}, p, { X: c.X, Z: c.Z, cam });
    });
    const cands = eventCandidates(segments, track);
    const out = [];
    for (let i = 0; i < cands.length; i++) {
      const e = cands[i];
      const tEvt = B.refineTime(track, e);
      const at = track.reduce((b, p) => (!b || Math.abs(p.t - tEvt) < Math.abs(b.t - tEvt) ? p : b), null);
      if (!at || !at.cam || !at.cam.ok) { out.push({ t: tEvt, x: e.x, y: e.y, kind: 'unknown', src: e.src }); continue; }
      const s = at.Z >= 0 ? 1 : -1;
      const tStop = Math.min(tEvt + 0.50, (cands[i + 1] ? cands[i + 1].t : Infinity) - 0.06);
      const gate = p => {
        const df = Math.max(1, (p.t - tEvt) * 60);
        return Math.hypot((p.x - at.x) * SC, (p.y - at.y) * SC) <= 40 * df + 40;
      };
      let seq = track.filter(p => p.t >= tEvt + 0.03 && p.t <= tStop && gate(p));
      if (seq.length >= 3 && seq[seq.length - 1].t - seq[0].t < 0.08)
        seq = track.filter(p => p.t >= tEvt + 0.03 && p.t <= Math.min(tEvt + 0.7, tStop) && gate(p));
      // ★打ち切りの結果が slopeZ の最小点数(3)を割るなら、この回だけ打ち切りを外す。上の (5)
      //   代替は必ず 'unknown'（applyRallyRules の当て推量）なので、測る方が悪くならない。
      if (CFG.RELAX_TSTOP && seq.length < 3)
        seq = track.filter(p => p.t >= tEvt + 0.03 && p.t <= tEvt + 0.50 && gate(p));
      const dZ = B.slopeZ(seq);
      let kind = 'unknown', qc = null;
      if (dZ != null && seq.length >= 3) {
        qc = (-s * dZ) + s * B.zBias(at.Z, at.cam) * B.HDOT;     // 判別式は ball.js のまま
        kind = qc > qth ? 'hit' : 'bounce';
      }
      if (kind === 'bounce' && Math.abs(at.Z) > 12.5) kind = 'hit';
      out.push({ t: tEvt, x: at.x, y: at.y, kind, qc: qc == null ? null : +qc.toFixed(3),
                 side: s > 0 ? 'opp' : 'me',
                 X: +at.X.toFixed(2), Z: +at.Z.toFixed(2),
                 inCourt: Court.inCourt(at.X, at.Z, margin), src: e.src });
    }
    // ★refineTime 後の重複を潰す。ball.js は時刻順ソートすらしていない。上の (6)
    let res = out;
    if (CFG.POST_DEDUP > 0) {
      const sorted = out.slice().sort((a, b) => a.t - b.t);
      const keep = [];
      for (const e of sorted) {
        const last = keep[keep.length - 1];
        if (last && e.t - last.t < CFG.POST_DEDUP) {
          const score = x => (x.kind === 'unknown' ? 0 : 1) + (x.src === 'kink' ? 0.5 : 0);
          if (score(e) > score(last)) keep[keep.length - 1] = e;
          continue;
        }
        keep.push(e);
      }
      res = keep;
    }
    return B.applyRallyRules(res);
  }

  window.BallTrack = Object.assign({}, B, {
    candidates, filterCandidates, buildChains, pickBall, ballSegments,
    eventCandidates, classifyEvents,
    carveCores, verdict, revisitRatio, linkCost, freeFlight, chainStats: stats,
    MERGED_CFG: CFG,
  });
})();
