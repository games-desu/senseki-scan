// 保存済みの p<idx>.json（rally-node の生結果）に対して RallyFuse.fuse だけを掛け直す（数秒）。
// fuse の規則を変えたときに、動画の再解析（1 ポイント 1〜3 分）なしでベンチを回すためのもの。
//   node tools/rally-refuse.js <dir> [--only 0,2] [--refar]   → <dir>/p*.json の rally を書き換える
//   --refar: 保存済みの奥側ボール軌道（farBall.tracks）から far-* イベントも作り直す（tools/farball.js の events を変えたとき）
//   --no-shotcolor: 後段の種別読み（tools/shotcolor.js）を掛けない
// 2026-09-24: fuse の後に shotcolor を掛け直す（rally-node と同じ順序）。fuse を掛け直すと rally が作り直されて shotcolor の種別が消えるため。
//   動画は samples/<r.video>（リポジトリの samples/ を上へたどって探す）。動画が無ければ掛けない。shotcolor は ffmpeg を呼ぶので refuse は Promise を返す
const fs = require('fs');
const path = require('path');
const { loadModules } = require('./rally-node.js');
const FarBall = require('./farball.js');
const ShotColor = require('./shotcolor.js');

// 実験場の tools コピー（samples/rally/exp-*/tools）から走らせても本体のリポジトリを指すように、samples/rally がある所まで上がる（rally-exp.js と同じ）
const REPO = (() => { let d = path.resolve(__dirname, '..'); for (let k = 0; k < 6; k++) { if (fs.existsSync(path.join(d, 'samples', 'rally'))) return d; d = path.dirname(d); } return path.resolve(__dirname, '..'); })();

async function refuse(file, mods, opts = {}) {
  const { Court, RallyFuse } = mods;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cams = (r.cams || []).map(c => ({ t: c.t, cam: { ok: true, t: c.t, c0: c.c0, c1: c.c1, Xc: c.Xc, Yc: c.Yc } }));
  const camAt = t => { if (!cams.length) return null; let b = cams[0]; for (const c of cams) if (Math.abs(c.t - t) < Math.abs(b.t - t)) b = c; return b.cam; };
  if (opts.refar && r.farBall && r.farBall.tracks) {
    const ref = FarBall.refFn(cams.map(c => c.cam), Court);
    // 点は [t, x, y, n, weak, air]（weak は 2026-09-24 から・弱い候補の層 weakTracks も読み直す。air は farjunk から）
    const conv = trs => (trs || []).map(tr => ({ t0: tr.t0, t1: tr.t1, pts: tr.pts.map(q => { const rr = ref(q[0]); return { t: q[0], x: q[1], y: q[2], n: q[3], weak: !!q[4], air: !!q[5], u: q[1] - rr.x, v: q[2] - rr.y }; }) }));
    r.farBall.events = FarBall.events(conv(r.farBall.tracks), r.farBall.band, Court, camAt, r.markers || [], conv(r.farBall.weakTracks));
    r.events = (r.events || []).filter(e => !(e.src && e.src.startsWith('far-'))).concat(r.farBall.events).sort((a, b) => a.t - b.t);
  }
  const track = []; (r.segPts || []).forEach(s => s.pts.forEach(p => track.push(p))); track.sort((a, b) => a.t - b.t);
  const before = (r.rally || []).map(h => `${h.t.toFixed(2)}${h.side[0]}`).join(' ');
  r.rally = RallyFuse.fuse({ shots: r.shots || [], events: r.events || [], track, camAt, t0: r.t0, t1: r.t1, markers: r.markers || [], farTracks: (r.farBall && r.farBall.tracks) || [] }).shots;
  const after = r.rally.map(h => `${h.t.toFixed(2)}${h.side[0]}`).join(' ');
  let sc = null;
  const video = opts.video || (r.video ? path.join(REPO, 'samples', r.video) : null);
  // 動画が無いと shotcolor を掛けられず、fuse の作り直しで前回の追跡由来の種別（clsPath）が消える（2026-09-24 color レーン: 黙って消えていた）→ 警告して印を残す
  // 頂点規則の lob を色で覆していた打点（pathcolor-over-apex）も fuse の作り直しで頂点規則の lob（isApexLob: cls lob・clsColor が lob 以外）に戻るので、同じ印を付ける
  //   （2026-09-24 exp-int3f・レビューの note: 以前は黙って lob に戻っていた。印を付ける打点は shotcolor が読む対象と同じ）
  if (opts.shotColor !== false && !(video && fs.existsSync(video))) {
    console.warn(`[refuse] 動画が無いので shotcolor を掛けない（追跡由来の種別は unknown・頂点規則の lob は lob のまま）: ${video || '(r.video なし)'} ← ${path.basename(file)}`);
    let n = 0; for (const h of r.rally) if ((h.cls === 'unknown' && h.src !== 'trail') || ShotColor.isApexLob(h)) { h.clsNote = 'shotcolor-skip:no-video'; n++; }
    r.shotColor = { changed: 0, n, ms: 0, skipped: 'no-video', log: [] };   // 前回の読みの記録を残さない（2026-09-24 統合 3: fuse を作り直したので前回の log は今の rally と合わない）
    sc = r.shotColor;
  }
  // --no-shotcolor（掛けない）でも前回の読みの記録は今の rally と合わないので消す（exp-int3f-review N8）
  if (opts.shotColor === false) r.shotColor = { changed: 0, n: 0, ms: 0, skipped: 'off', log: [] };
  if (opts.shotColor !== false && video && fs.existsSync(video)) {
    sc = await ShotColor.apply({ video, rally: r.rally, segPts: (r.segPts || []).map(s => ({ pts: s.pts })), farBall: r.farBall, t1: r.t1,
                                  toCourt: (t, x, y) => { const c = camAt(t); return c && c.ok ? Court.toCourt(x, y, c) : null; },
                                  camOk: ShotColor.makeCamOk(cams, Court) });
    // 読んだ記録（打点ごとの票・読んだ軌道）を残す（rally-node と同じ形）
    r.shotColor = { changed: sc.changed, n: sc.skipped ? sc.n : sc.log.length, ms: sc.ms, skipped: sc.skipped, log: sc.log };
  }
  fs.writeFileSync(file, JSON.stringify(r, null, 1));
  // 読まなかったとき（FHD 60fps 以外・動画なし）は skipped と印を付けた打点の数 n を返す（2026-09-24 exp-int3f・レビューの note: 以前は「shotcolor 0/0」と出ていた）
  return { before, after, sc: sc ? { changed: sc.changed, n: sc.skipped ? sc.n : sc.log.length, ms: sc.ms, log: sc.log, skipped: sc.skipped } : null };
}
// refuse の戻り値 sc の 1 行表示（rally-refuse の CLI と rally-exp の refuse/refarball で共用）
const scText = sc => !sc ? '' : sc.skipped ? ` shotcolor skipped (${sc.skipped}) n ${sc.n}` : ` shotcolor ${sc.changed}/${sc.n} ${(sc.ms / 1000).toFixed(1)}s`;

if (require.main === module) (async () => {
  const a = process.argv.slice(2);
  const dir = a[0];
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const only = get('--only') ? new Set(get('--only').split(',').map(Number)) : null;
  const mods = loadModules(null);
  for (const f of fs.readdirSync(dir).filter(f => /^p\d+\.json$/.test(f)).sort((x, y) => +x.slice(1) - +y.slice(1))) {
    const idx = parseInt(f.slice(1), 10);
    if (only && !only.has(idx)) continue;
    const { before, after, sc } = await refuse(path.join(dir, f), mods, { refar: a.includes('--refar'), shotColor: !a.includes('--no-shotcolor') });
    console.log(`${f}: ${before === after ? 'unchanged' : 'changed'}${scText(sc)}`);
    if (before !== after) { console.log('  -', before); console.log('  +', after); }
  }
})().catch(e => { console.error(e); process.exit(1); });
module.exports = { refuse, scText };
