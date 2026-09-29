// 保存済みの trailLog（コマごとの blob の統計と courtRef）から Trail.runs → Trail.shots を作り直し、そのあと fuse＋shotcolor（rally-refuse.js の refuse）を掛け直す。
// 動画は読まない（shotcolor の色読みだけは動画を使う: refuse と同じ）。1 ポイント数秒。trail.js の runs/summarize/shots・rally-fuse.js・shotcolor.js を変えたときに
// rerun（動画から丸ごと・1 ポイント 1〜3 分）の代わりに使う。blob の検出（detect・effectMask・netTapeBlob の印）は焼き込まれているので、そこを変えたら rerun が要る。
//   node <root>/tools/rally-retrail.js <dir> [--only 0,2] [--check] [--refar] [--no-shotcolor]
//     <dir>/p*.json の shots・rally・shotColor（と trailRuns）を書き換える。道具は同じ tools/（__dirname）の trail.js・rally-fuse.js・shotcolor.js
//     --check: 書き込まず、作り直した shots が保存値と一致するかだけ見る（コードを変えていない状態での再現確認）
//     --refar: 保存済みの奥側軌道から far-* イベントも作り直す（farball.js を変えたとき・refuse --refar と同じ）
// 由来: 第 4 ラウンドの regress レーン scr/retrail.js（nearjunk の retrail.js・color の RETRAIL=1 refuse も同じ作り）。統合（2026-09-25 exp-int4）で tools に置いた。
//   一致の確認: rerun と retrail の打点単位の一致は exp-int4/LOG.txt（retrail の項）
const fs = require('fs');
const path = require('path');
const { loadModules } = require('./rally-node.js');
const { refuse, scText } = require('./rally-refuse.js');

// 1 ファイル分: trailLog → runs → shots。戻り値は { before, after, changed }（shots の並びの文字列）。write=false なら書かない
function retrailFile(file, mods, opts = {}) {
  const { Trail, Court } = mods;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!r.trailLog) return { noLog: true };
  const cams = (r.cams || []).map(c => ({ t: c.t, cam: { ok: true, t: c.t, c0: c.c0, c1: c.c1, Xc: c.Xc, Yc: c.Yc } }));
  const camAt = t => { if (!cams.length) return null; let b = cams[0]; for (const c of cams) if (Math.abs(c.t - t) < Math.abs(b.t - t)) b = c; return b.cam; };
  const yFarAt = t => { const c = camAt(t); return c && c.ok ? Court.toScreen(0, Court.Z_BASE, c).y / Trail.SC : null; };
  const trailRuns = Trail.runs(r.trailLog, { fps: (r.fps || 60) / 2, yFarAt });
  const shots = Trail.shots(trailRuns, { tStart: r.t0 });
  const key = s => `${s.t0.toFixed(3)}${s.side[0]}${s.cls}`;
  const before = (r.shots || []).map(key).join(' '), after = shots.map(key).join(' ');
  if (opts.write !== false) { r.trailRuns = trailRuns; r.shots = shots; fs.writeFileSync(file, JSON.stringify(r, null, 1)); }
  return { before, after, changed: before !== after };
}

if (require.main === module) (async () => {
  const a = process.argv.slice(2);
  // 先頭の「--」で始まらない引数を全部 dir として扱う（以前は先頭 1 つだけだった）
  const dirs = []; for (const x of a) { if (x.startsWith('--')) break; dirs.push(x); }
  if (!dirs.length) { console.error('usage: node rally-retrail.js <dir...> [--only 0,2] [--check] [--refar] [--no-shotcolor]'); process.exit(2); }
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const only = get('--only') ? new Set(get('--only').split(',').map(Number)) : null;
  const check = a.includes('--check');
  const mods = loadModules(null);
  let nSame = 0, nDiff = 0;
  for (const dir of dirs) for (const f of fs.readdirSync(dir).filter(f => /^p\d+\.json$/.test(f)).sort((x, y) => +x.slice(1) - +y.slice(1))) {
    const idx = parseInt(f.slice(1), 10);
    if (only && !only.has(idx)) continue;
    const file = path.join(dir, f), tag = dirs.length > 1 ? `${path.basename(dir)}/${f}` : f;
    const s = retrailFile(file, mods, { write: !check });
    if (s.noLog) { console.log(`${tag}: no trailLog`); continue; }
    if (s.changed) { nDiff++; console.log(`${tag}: shots changed`); console.log('  -', s.before); console.log('  +', s.after); } else nSame++;
    if (check) continue;
    const { before, after, sc } = await refuse(file, mods, { refar: a.includes('--refar'), shotColor: !a.includes('--no-shotcolor') });
    console.log(`${tag}: rally ${before === after ? 'unchanged' : 'changed'}${scText(sc)}`);
    if (before !== after) { console.log('  -', before); console.log('  +', after); }
  }
  console.log(`shots same ${nSame} diff ${nDiff}`);
})().catch(e => { console.error(e); process.exit(1); });
module.exports = { retrailFile };
