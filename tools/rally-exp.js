// ラリー解析の実験場（2026-09-24）: tools/ のコピーと保存済み結果のコピーを 1 つのディレクトリに置き、
// 規則を試して「0908 ベンチ＋砂 4 ポイント＋芝ランクマ 15-18-15 p8＋ロブの退行チェック（0908b p4・芝 0908 p5）」を 1 コマンドで採点する。
// 本体の tools/ を触らずに並行して試せる（loadModules は __dirname から読むので、コピー側の rally-fuse.js / farball.js が使われる）。
//
//   node tools/rally-exp.js init <root> [--from <root0>]   tools/ と基準の結果（既定: v36）を <root> にコピー（--from なら別の実験場から）
//   node tools/rally-exp.js refuse <root> [--refar] [--sets 0908,0911]   <root>/tools で fuse だけ掛け直す（--refar: 保存済み軌道から far イベントも）
//   node tools/rally-exp.js refarball <root> [--sets 0908,0911] [--only 2,16]   <root>/tools/farball.js で奥側のボール追跡を動画から取り直す→fuse
//   node tools/rally-exp.js rerun <root> [--sets ...] [--only ...]   <root>/tools で rally-node を丸ごと走らせ直す（トレイル・追跡を変えたとき・1 ポイント 1〜3 分）
//   node tools/rally-exp.js score <root> [--json out.json] [--base <root0>]   採点（--base: 基準との差分だけ短く出す）
//   node tools/rally-exp.js copyin <root> --src <dir> --as <name> [--only 4,9]   任意の p*.json 群（全体走など）を <root>/<name> にコピー
//   score の T は「GT と 0.15 秒以内に当たった打点の数」（|dt|med は当たった打点の時刻誤差の中央値）
//   node tools/rally-exp.js diff <rootA> <rootB> [--dirs d0908,s0911]   打点単位の差分（+ 増えた / - 消えた / ~ 時刻・種別・由来が変わった）
//   refuse/refarball/rerun は --dirs s0908,s0911 で基準セット以外のディレクトリにも掛けられる（既定は d+基準セット）
const fs = require('fs');
const path = require('path');

// 実験場の tools コピー（samples/rally/exp-*/tools）から走らせても本体のリポジトリを指すように、samples/rally がある所まで上がる
const REPO = (() => { let d = path.resolve(__dirname, '..'); for (let k = 0; k < 6; k++) { if (fs.existsSync(path.join(d, 'samples', 'rally'))) return d; d = path.dirname(d); } return path.resolve(__dirname, '..'); })();
const SR = path.join(REPO, 'samples', 'rally');
// 基準の結果（2026-09-24 v37）。d* = ベンチ（0908・0911 は GT ファイル・151815 は下の GT_151815・0908b/0908p5 はロブチェック）、
// x* = 全体走から目視 GT を足したポイント（gt-x*.json・2 人が独立にラベル付け→突き合わせ）。GT ファイルが無いセットは採点しない。
// v36 の基準は samples/rally/exp-base（init --from samples/rally/exp-base、score --base samples/rally/exp-base で比べられる）
const SETS = {
  '0908':    { dir: 'd0908',    base: 'exp-v37/d0908',    gt: 'gt-0908.json' },
  '0911':    { dir: 'd0911',    base: 'exp-v37/d0911',    gt: 'gt-0911.json' },
  '151815':  { dir: 'd151815',  base: 'exp-v37/d151815',  gt: null },
  '0908b':   { dir: 'd0908b',   base: 'exp-v37/d0908b',   gt: null },
  '0908p5':  { dir: 'd0908p5',  base: 'exp-v37/d0908p5',  gt: null },
  'x0908':   { dir: 'x0908',    base: 'exp-v37/x0908',    gt: 'gt-x0908.json' },     // 芝 p5・砂 p17
  'x0908b':  { dir: 'x0908b',   base: 'exp-v37/x0908b',   gt: 'gt-x0908b.json' },    // ハード p0（1 試合目・ドロップ）・p4（2 試合目・相手ロブ）
  'x0911':   { dir: 'x0911',    base: 'exp-v37/x0911',    gt: 'gt-x0911.json' },     // 砂 p4・p6
  'x151815': { dir: 'x151815',  base: 'exp-v37/x151815',  gt: 'gt-x151815.json' },   // 芝ランクマ p9・p10・p12
};
const GTSETS = () => ['0908', '0911', '151815', ...Object.keys(SETS).filter(k => k.startsWith('x') && fs.existsSync(path.join(SR, SETS[k].gt)))];
// 芝ランクマ 15-18-15 p8（docs「実測（15-18-15 p8）」の目視 GT 6 打）
const GT_151815 = { video: 'samples/2026-09-06 15-18-15.mp4', points: [{ idx: 8, t0: 204, t1: 209.8, hits: [
  { t: 204.65, side: 'opp', cls: 'slice', serve: true }, { t: 205.6, side: 'me', cls: 'topspin' }, { t: 206.45, side: 'opp', cls: 'topspin' },
  { t: 206.9, side: 'me', cls: 'slice' }, { t: 207.85, side: 'opp', cls: 'flat' }, { t: 208.7, side: 'me', cls: 'flat' } ] }] };
// ロブの退行チェック（GT は無い。台本・前回確認済みのロブが lob のまま残るか）。watch は COM の球で正解未確認（表示だけ）
const LOBS = {
  '0908b':  { idx: 4, must: [[188.80, 'me'], [192.17, 'opp'], [194.34, 'me']], watch: [] },
  '0908p5': { idx: 5, must: [[134.34, 'me'], [138.50, 'me'], [139.37, 'opp'], [141.10, 'me']], watch: [[135.87, 'opp']] },
};
const TOL = 0.4;

function argv() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  return { a, get, has: k => a.includes(k) };
}
const cp = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };
const pfiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^p\d+\.json$/.test(f)).sort((x, y) => parseInt(x.slice(1)) - parseInt(y.slice(1))) : [];

function init(root, from) {
  fs.mkdirSync(root, { recursive: true });
  const tsrc = from ? path.join(from, 'tools') : __dirname;
  for (const f of fs.readdirSync(tsrc)) { const s = path.join(tsrc, f); if (fs.statSync(s).isFile() && f.endsWith('.js')) cp(s, path.join(root, 'tools', f)); }
  const vs = path.join(tsrc, 'variants');
  if (fs.existsSync(vs)) for (const f of fs.readdirSync(vs)) cp(path.join(vs, f), path.join(root, 'tools', 'variants', f));
  for (const s of Object.values(SETS)) {
    const src = from ? path.join(from, s.dir) : path.join(SR, s.base);
    for (const f of pfiles(src)) cp(path.join(src, f), path.join(root, s.dir, f));
  }
  console.log('init', root, 'tools ←', tsrc);
}

// 対象ディレクトリ名（<root> 直下）。--dirs で任意の名前（例: s0908,s0911 = 全体走のコピー）、--sets は基準セット名（d を付けて読む）
function setsOf(get) { const s = get('--sets'); return s ? s.split(',') : Object.keys(SETS); }
function dirsOf(get) { const d = get('--dirs'); return d ? d.split(',') : setsOf(get).map(k => SETS[k] ? SETS[k].dir : k); }
function onlyOf(get) { const s = get('--only'); return s ? new Set(s.split(',').map(x => parseInt(x, 10))) : null; }
function camsOf(r) {
  const cams = (r.cams || []).map(c => ({ t: c.t, cam: { ok: true, t: c.t, c0: c.c0, c1: c.c1, Xc: c.Xc, Yc: c.Yc } }));
  const camAt = t => { if (!cams.length) return null; let b = cams[0]; for (const c of cams) if (Math.abs(c.t - t) < Math.abs(b.t - t)) b = c; return b.cam; };
  return { cams, camAt };
}

// refuse は Promise を返す（2026-09-24: fuse の後に shotcolor を掛け直す・ffmpeg を呼ぶ）。--no-shotcolor で掛けない
async function refuseAll(root, get, refar, has) {
  const T = path.resolve(root, 'tools');
  const { refuse } = require(path.join(T, 'rally-refuse.js'));
  const { loadModules } = require(path.join(T, 'rally-node.js'));
  const mods = loadModules(null), only = onlyOf(get);
  for (const k of dirsOf(get)) for (const f of pfiles(path.join(root, k))) {
    if (only && !only.has(parseInt(f.slice(1), 10))) continue;
    const { before, after, sc } = await refuse(path.join(root, k, f), mods, { refar, shotColor: !has('--no-shotcolor') });
    console.log(`${k}/${f}: ${before === after ? 'unchanged' : 'changed'}${sc ? ` shotcolor ${sc.changed}/${sc.n} ${(sc.ms / 1000).toFixed(1)}s` : ''}`);
  }
}

async function pool(items, n, fn) { const q = items.slice(); await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }

async function refarball(root, get, has) {
  const T = path.resolve(root, 'tools');
  const FarBall = require(path.join(T, 'farball.js'));
  const { loadModules } = require(path.join(T, 'rally-node.js'));
  const { refuse } = require(path.join(T, 'rally-refuse.js'));
  const mods = loadModules(null), only = onlyOf(get);
  const jobs = [];
  for (const k of dirsOf(get)) for (const f of pfiles(path.join(root, k))) { if (!only || only.has(parseInt(f.slice(1), 10))) jobs.push(path.join(root, k, f)); }
  await pool(jobs, +get('--jobs', 4), async file => {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { cams, camAt } = camsOf(r);
    const t = Date.now();
    const fb = await FarBall.track({ video: path.join(REPO, 'samples', r.video), t0: r.t0, t1: r.t1, fps: r.fps || 60, cams, Court: mods.Court, camAt, markers: r.markers || [] });
    r.farBall = fb;
    r.events = (r.events || []).filter(e => !(e.src && e.src.startsWith('far-'))).concat(fb.events).sort((a, b) => a.t - b.t);
    fs.writeFileSync(file, JSON.stringify(r, null, 1));
    const t2 = Date.now();
    const { before, after, sc } = await refuse(file, mods, { shotColor: !has('--no-shotcolor') });
    console.log(`${path.basename(path.dirname(file))}/${path.basename(file)}: far ${fb.events.length} ev ${fb.tracks.length} tr ${((t2 - t) / 1000).toFixed(1)}s ${before === after ? 'unchanged' : 'changed'}${sc ? ` shotcolor ${sc.changed}/${sc.n} ${(sc.ms / 1000).toFixed(1)}s` : ''}`);
  });
}

async function rerun(root, get) {
  const T = path.resolve(root, 'tools');
  const { analyze } = require(path.join(T, 'rally-node.js'));
  const only = onlyOf(get), jobs = [];
  for (const k of dirsOf(get)) for (const f of pfiles(path.join(root, k))) { if (!only || only.has(parseInt(f.slice(1), 10))) jobs.push(path.join(root, k, f)); }
  await pool(jobs, +get('--jobs', 4), async file => {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = Date.now();
    const r = await analyze({ video: path.join(REPO, 'samples', old.video), t0: old.t0, t1: old.t1, variant: old.variant || 'merged2', trail: true });
    fs.writeFileSync(file, JSON.stringify(r, null, 1));
    console.log(`${path.basename(path.dirname(file))}/${path.basename(file)}: ${((Date.now() - t) / 1000).toFixed(0)}s ${r.rally.length} hits`);
  });
}

const tag = d => `${d.t.toFixed(2)}${d.side === 'me' ? 'm' : 'o'} ${d.cls}${d.src && d.src !== 'trail' ? '(' + d.src + ')' : ''}`;
function benchSet(dir, gt) {
  let N = 0, F = 0, C = 0, X = 0; const miss = [], extra = [], cls = [], hit = [];
  for (const p of gt.points) {
    const file = path.join(dir, `p${p.idx}.json`);
    if (!fs.existsSync(file)) continue;
    const det = (JSON.parse(fs.readFileSync(file, 'utf8')).rally || []).slice(), used = new Set();
    for (const h of p.hits) {
      N++; let best = null; const tol = h.serve ? 0.6 : TOL;
      det.forEach((d, i) => { if (!used.has(i) && Math.abs(d.t - h.t) <= tol && d.side === h.side && (best == null || Math.abs(d.t - h.t) < Math.abs(det[best].t - h.t))) best = i; });
      if (best == null) { miss.push(`p${p.idx} ${h.t}${h.side === 'me' ? 'm' : 'o'} ${h.cls}`); continue; }
      const d = det[best]; used.add(best); F++;
      hit.push({ p: p.idx, t: h.t, side: h.side, want: h.cls, got: d.cls, dt: +(d.t - h.t).toFixed(2), src: d.src });
      if (d.cls === h.cls) C++; else cls.push(`p${p.idx} ${h.t}${h.side === 'me' ? 'm' : 'o'} ${h.cls}←${d.cls}${d.src !== 'trail' ? '(' + d.src + ')' : ''}`);
    }
    det.forEach((d, i) => { if (!used.has(i)) { X++; extra.push(`p${p.idx} ${tag(d)}`); } });
  }
  const ad = hit.map(h => Math.abs(h.dt)).sort((a, b) => a - b);
  const dtMed = ad.length ? +ad[(ad.length - 1) >> 1].toFixed(2) : null, dt15 = ad.filter(v => v <= 0.15 + 1e-9).length;
  return { N, F, C, X, recall: +(F / Math.max(1, N)).toFixed(3), precision: +(F / Math.max(1, F + X)).toFixed(3), clsAcc: +(C / Math.max(1, F)).toFixed(3), dtMed, dt15, miss, extra, cls, hit };
}
function lobCheck(dir, spec) {
  const file = path.join(dir, `p${spec.idx}.json`);
  if (!fs.existsSync(file)) return null;
  const det = JSON.parse(fs.readFileSync(file, 'utf8')).rally || [];
  const look = ([t, side]) => { const d = det.filter(x => x.side === side && Math.abs(x.t - t) <= TOL).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0]; return d ? d : null; };
  const must = spec.must.map(m => { const d = look(m); return { t: m[0], side: m[1], got: d ? tag(d) : '—', ok: !!(d && d.cls === 'lob') }; });
  const watch = spec.watch.map(m => { const d = look(m); return { t: m[0], side: m[1], got: d ? tag(d) : '—' }; });
  return { lobsOk: must.filter(m => m.ok).length, lobsN: must.length, must, watch, rally: det.map(tag).join(' | ') };
}
function score(root) {
  const out = {};
  for (const k of GTSETS()) out[k] = benchSet(path.join(root, SETS[k].dir), k === '151815' ? GT_151815 : JSON.parse(fs.readFileSync(path.join(SR, SETS[k].gt), 'utf8')));
  for (const k of Object.keys(LOBS)) out[k] = lobCheck(path.join(root, SETS[k].dir), LOBS[k]);
  return out;
}
function printScore(s, base) {
  for (const k of GTSETS()) {
    const r = s[k], b = base && base[k]; if (!r) continue;
    const d = b ? ` (base ${b.F}/${b.N} X${b.X} C${b.C} |dt|${b.dtMed} ≤.15:${b.dt15})` : '';
    console.log(`[${k}] ${r.F}/${r.N} R${r.recall} P${r.precision} C${r.C}/${r.F}=${r.clsAcc} X${r.X} |dt|med ${r.dtMed} ≤0.15s ${r.dt15}/${r.F}${d}`);
    const diff = (arr, barr) => b ? arr.filter(x => !barr.includes(x)).map(x => '+' + x).concat(barr.filter(x => !arr.includes(x)).map(x => '-' + x)) : arr;
    const m = diff(r.miss, b ? b.miss : []), e = diff(r.extra, b ? b.extra : []), c = diff(r.cls, b ? b.cls : []);
    if (m.length) console.log('   miss :', m.join(' ; '));
    if (e.length) console.log('   extra:', e.join(' ; '));
    if (c.length) console.log('   cls  :', c.join(' ; '));
  }
  for (const k of Object.keys(LOBS)) {
    const r = s[k]; if (!r) continue;
    const b = base && base[k];
    console.log(`[${k} lobs] ${r.lobsOk}/${r.lobsN}${b ? ` (base ${b.lobsOk}/${b.lobsN})` : ''}  ` + r.must.map(m => `${m.t}${m.side[0]}→${m.got}${m.ok ? '' : ' ✗'}`).join(' ; ') + (r.watch.length ? '  watch: ' + r.watch.map(m => `${m.t}${m.side[0]}→${m.got}`).join(' ; ') : ''));
    if (!b || b.rally !== r.rally) console.log(`   rally: ${r.rally}`);
  }
  const sum = {}; for (const k of GTSETS()) if (s[k]) sum[k] = `${s[k].F}/${s[k].N} X${s[k].X} C${s[k].C} T${s[k].dt15}`; for (const k of Object.keys(LOBS)) if (s[k]) sum[k + 'Lob'] = `${s[k].lobsOk}/${s[k].lobsN}`;
  console.log('SUMMARY', JSON.stringify(sum));
}

// 任意のディレクトリの p*.json を <root>/<name> へコピー（全体走 samples/rally/exp-survey/b0908 などを規則の試行に使う）
function copyin(root, src, name, only) {
  const fl = pfiles(src).filter(f => !only || only.has(parseInt(f.slice(1), 10)));
  for (const f of fl) cp(path.join(src, f), path.join(root, name, f));
  console.log('copyin', src, '→', path.join(root, name), fl.length, 'files');
}

// 2 つの実験場の打点列を打点単位で比べる（同じ側・0.15 秒以内を同じ打点とみなす）。変わった打点だけ出す
function diffRoots(rootA, rootB, dirs) {
  let nAdd = 0, nDel = 0, nMod = 0;
  const lines = [];
  for (const k of dirs) {
    for (const f of pfiles(path.join(rootA, k))) {
      const fb = path.join(rootB, k, f); if (!fs.existsSync(fb)) continue;
      const A = JSON.parse(fs.readFileSync(path.join(rootA, k, f), 'utf8')), B = JSON.parse(fs.readFileSync(fb, 'utf8'));
      const ra = A.rally || [], rb = B.rally || [], used = new Set(), out = [];
      for (const h of ra) {
        let bi = -1; rb.forEach((d, i) => { if (!used.has(i) && d.side === h.side && Math.abs(d.t - h.t) <= 0.15 && (bi < 0 || Math.abs(d.t - h.t) < Math.abs(rb[bi].t - h.t))) bi = i; });
        if (bi < 0) { out.push(`  - ${tag(h)}`); nDel++; continue; }
        used.add(bi); const d = rb[bi];
        if (d.cls !== h.cls || (d.src || '') !== (h.src || '') || Math.abs(d.t - h.t) >= 0.02) { out.push(`  ~ ${tag(h)}  →  ${tag(d)}`); nMod++; }
      }
      rb.forEach((d, i) => { if (!used.has(i)) { out.push(`  + ${tag(d)}`); nAdd++; } });
      if (out.length) lines.push(`${k}/${f} (${A.video} ${A.t0}-${A.t1})`, ...out.sort((x, y) => parseFloat(x.slice(4)) - parseFloat(y.slice(4))));
    }
  }
  console.log(lines.join('\n'));
  console.log(`DIFF +${nAdd} -${nDel} ~${nMod}`);
}

async function main() {
  const { a, get, has } = argv();
  const cmd = a[0], root = a[1] && path.resolve(a[1]);
  if (!cmd || !root) { console.error('usage: node tools/rally-exp.js init|refuse|refarball|rerun|score <root> [...]'); process.exit(2); }
  if (cmd === 'init') return init(root, get('--from') && path.resolve(get('--from')));
  if (cmd === 'copyin') return copyin(root, path.resolve(get('--src')), get('--as'), onlyOf(get));
  if (cmd === 'diff') {
    const rootB = path.resolve(a[2]);
    const dirs = get('--dirs') ? get('--dirs').split(',') : fs.readdirSync(root).filter(n => /^[dsx]/.test(n) && fs.statSync(path.join(root, n)).isDirectory() && pfiles(path.join(root, n)).length);
    return diffRoots(root, rootB, dirs);
  }
  if (cmd === 'refuse') return refuseAll(root, get, has('--refar'), has);
  if (cmd === 'refarball') return refarball(root, get, has);
  if (cmd === 'rerun') return rerun(root, get);
  if (cmd === 'score') {
    const s = score(root);
    const base = get('--base') ? score(path.resolve(get('--base'))) : null;
    printScore(s, base);
    if (get('--json')) fs.writeFileSync(get('--json'), JSON.stringify(s, null, 1));
    return;
  }
  console.error('unknown command', cmd); process.exit(2);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { score, benchSet, SETS, GT_151815, LOBS };
