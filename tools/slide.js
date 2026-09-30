// スライドフットワークの種別（2026-09-30・exp-slide で試作→本体へ）。shotcolor の後に掛ける（rally-node・rally-refuse）。
// far-lobappear（奥側の打ち上げの出現: 相手の入射球が体・光に隠れた後、球が画面の上へ上がって現れ、0.1〜0.7 秒後に自分側に☆）で lob にした打点を slide にする。
//   全セットで 6 本すべてスライド／とびつきだった（x0908 435.35・441.98、x151815 217.6 ほか）。手直し GT（gt-edit-*）で種別 +7 −0 の試作のうち、この規則の分。
//   本物のロブは立ったまま打って球が見えたまま上がるので、この出現にはならない。
// 入れなかったもの（exp-slide の試作にはある）:
//   - track の unknown → slide: 本物のロブ（y0911 238.78m・ユーザー確認）や青い光の返球（0908b 138.43）も slide にするので外した。
//   - farFix が far-lobappear の trail 打点（x0908 429.45・0908b 225.87・288.37）: GT で確かめたのは 429.45 だけ。
// 拾えていないスライド（trail の lob・far-flat の lob・far-turn の unknown）は体勢（低く横に伸びる／体が水平）で見分けるしかなく、選手の切り出しが要るので保留。
// clsSlide に元の種別を残す。
function apply(rally) {
  let n = 0;
  for (const h of rally || []) {
    if (h.src === 'far-lobappear' && h.cls === 'lob') { h.clsSlide = h.cls; h.cls = 'slide'; n++; }
  }
  return n;
}
module.exports = { apply };
