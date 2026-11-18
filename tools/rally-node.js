// SENSEKI SCAN ラリー解析のヘッドレス実行（Node）。
// ブラウザ用の court.js / ball.js を**そのまま**読み込み、ffmpeg の生フレームを流し込む。
// 目的は再現可能な計測。ブラウザUIを開かずに1ラリーを解析して JSON を吐く。
//
//   node tools/rally-node.js <video> <t0> <t1> [--json out.json] [--fps 60] [--dump-frames]
//
// ffmpeg は CapCut 同梱の exe（環境に実 ffmpeg が無いため）。SENSEKI_FFMPEG で上書き可。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const FarBall = require('./farball.js');
const ShotColor = require('./shotcolor.js');
const Slide = require('./slide.js');
const GapFill = require('./gapfill.js');
const Flash = require('./flash.js');
const DupFix = require('./dupfix.js');
const CamRefine = require('./camrefine.js');
const Traj = require('./traj.js');

const W = 960, H = 540, FRAME_BYTES = W * H * 4;
// 実験場の tools コピー（samples/rally/exp-*/tools）から走らせても本体のリポジトリを指すように、samples/rally がある所まで上がる（rally-exp.js・rally-refuse.js と同じ）
const REPO = (() => { let d = path.resolve(__dirname, '..'); for (let k = 0; k < 6; k++) { if (fs.existsSync(path.join(d, 'samples', 'rally'))) return d; d = path.dirname(d); } return path.resolve(__dirname, '..'); })();

function findFfmpeg() {
  if (process.env.SENSEKI_FFMPEG) return process.env.SENSEKI_FFMPEG;
  const base = 'C:/Program Files/CapCut/Apps';
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'ffmpeg.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return 'ffmpeg';
}

// ---- ブラウザ用モジュールを Node に載せる ----
// court.js の frame() だけが document を触る。ImageData をそのまま返す canvas を差し込めば通る。
function loadModules(variant) {
  const dir = __dirname;
  const sandbox = {
    console, Math, Date, isFinite, isNaN, parseInt, parseFloat, Number, String, Set, Map, Infinity,
    Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Float32Array, Array, Object, JSON,
  };
  sandbox.window = sandbox;
  sandbox.document = {
    createElement() {
      const ctx = {
        _img: null,
        drawImage(src) { ctx._img = src; },
        getImageData() { return ctx._img; },
      };
      return { getContext: () => ctx, set width(v) {}, set height(v) {} };
    },
  };
  vm.createContext(sandbox);
  for (const f of ['court.js', 'ball.js', 'trail.js', 'star.js', 'rally-fuse.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  }
  // 変種: 同じサンドボックスで走らせ、window.BallTrack のエクスポートを差し替えさせる。
  // 変種側は素の実装を window.BallTrack から取れるので、必要な関数だけ上書きすればよい。
  if (variant) {
    let vp = path.isAbsolute(variant) ? variant : path.join(dir, 'variants', variant.endsWith('.js') ? variant : variant + '.js');
    // variants/ を写していない実験場の tools コピー（exp-int3f など）は本体の tools/variants を使う（本体の tools から走らせるときは同じ場所なので変わらない）
    if (!path.isAbsolute(variant) && !fs.existsSync(vp)) {
      const alt = path.join(REPO, 'tools', 'variants', path.basename(vp));
      if (fs.existsSync(alt)) { if (!warnedVariant.has(alt)) { warnedVariant.add(alt); console.warn(`[rally-node] ${path.join(dir, 'variants')} に ${path.basename(vp)} が無いので本体の ${alt} を使う`); } vp = alt; }
    }
    vm.runInContext(fs.readFileSync(vp, 'utf8'), sandbox, { filename: path.basename(vp) });
  }
  return { Court: sandbox.Court, BallTrack: sandbox.BallTrack, Trail: sandbox.Trail, Star: sandbox.Star, RallyFuse: sandbox.RallyFuse };
}

const warnedVariant = new Set();   // 本体の variants を借りたことを 1 回だけ知らせる（exp-int3f-review N7: 実験場が本体の後の変更を黙って拾わないように）

// ---- ffmpeg から RGBA フレームを1枚ずつ ----
// 時刻は t0 + i/fps と振る。srcFps（動画のコマ数・ShotColor.videoSize で調べたもの）が fps と違うときだけ fps フィルタで fps に揃える
// （2026-09-24 exp-int3f・レビューの note: 以前はフィルタが無く、30fps の動画を 1/60 秒刻みで数えて時刻が半分に縮んでいた＝窓 60〜72 秒の最後のトレイルのコマが 65.97）。
// srcFps が fps と同じ（FHD 60fps の録画）か不明なら従来どおりフィルタを掛けない（出力を変えない）
async function* frames(video, t0, t1, fps, srcFps = null) {
  const resample = srcFps != null && Math.abs(srcFps - fps) > 0.5;
  const ff = spawn(findFfmpeg(), [
    '-hide_banner', '-loglevel', 'error',
    // -t は 1 コマ分を下限に（exp-int3f-review S2: OBS の録画は時間の単位が 1/60 秒なので 0.001 は 0 に丸まり、ffmpeg が制限なしで動画の最後まで読んでいた）
    '-ss', String(t0), '-t', String(Math.max(1 / fps, t1 - t0)),
    '-i', video,
    '-vf', `${resample ? `fps=${fps},` : ''}scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ]);
  ff.stderr.on('data', d => process.stderr.write(d));
  let buf = Buffer.alloc(0), i = 0;
  for await (const chunk of ff.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= FRAME_BYTES) {
      const raw = buf.subarray(0, FRAME_BYTES);
      buf = buf.subarray(FRAME_BYTES);
      yield { t: +(t0 + i / fps).toFixed(4), i: i++,
              img: { data: new Uint8ClampedArray(raw), width: W, height: H } };
    }
  }
}

const warnedFps = new Set(), warnedFar = new Set();   // 動画ごとに 1 回だけ警告する

// 地面の色の地図を作る（GMAP=1 のときだけ analyze が呼ぶ）。ポイントを約 30 コマに間引いて読み、Court.estimate が通り（本解析の pass と同じ条件）、
// CamRefine.refine で寄せたカメラの線の点数が GMAP_S（既定 0.6）以上のコマだけを地面に投影する。寄せたカメラは地図作りにだけ使い、本解析のカメラは変えない
async function buildGroundMap({ Court, Trail, video, t0, t1, srcFps }) {
  const s0 = Date.now(), minS = +(process.env.GMAP_S || 0.6), T = +(process.env.GMAP_T || 30), R = +(process.env.GMAP_R || 3);
  const gf = Math.max(0.5, Math.min(6, 30 / Math.max(1, t1 - t0)));
  Trail.gmapBegin();
  let seen = 0, used = 0;
  for await (const fr of frames(video, t0, t1, gf, srcFps || 60)) {
    seen++;
    const e = Court.estimate(fr.img);
    if (!(e.ok && !e.suspect && e.hHits >= 2 && e.xHits >= 2 && e.agree != null)) continue;
    const r = CamRefine.refine(CamRefine.ridge(fr.img.data), e);
    if (r.s < minS) continue;
    if (Trail.gmapAdd(fr.img, { ok: true, c0: r.cam.c0, c1: r.cam.c1, Xc: r.cam.Xc, Yc: Court.K / r.cam.c1 })) used++;
  }
  const st = Trail.gmapFinish({ T, R, minN: +(process.env.GMAP_N || 4) });
  return { seen, used, cells: st ? st.cells : 0, T, R, ms: Date.now() - s0 };
}

// ---- 1ラリーを解析 ----
// camEvery: カメラ推定の間引き。ラリー中もドリーするので粗すぎると座標がずれる。
async function analyze(opts) {
  const { Court, BallTrack, Trail, Star, RallyFuse } = loadModules(opts.variant);
  const { video, t1, fps = 60, camEvery = 15, trailEvery = 2 } = opts;
  const t0 = Math.max(0, opts.t0);   // 負の t0 は 0 から（exp-int3f-review N9: -ss が負だと窓より長く読み、時刻もずれた）   // トレイルは2コマに1回で足りる（仕様: 4コマ間隔で可）
  // overlapMax=null で静止物フィルタを無効化できる（実験用）
  const overlapMax = opts.overlapMax === undefined ? 0.6 : opts.overlapMax;

  const frameLog = [];
  let prevMask = null, cam = null, net = null, prev = [], state = {}, camAt_i = -1e9, camProv = null, camProvAt_i = -1e9;
  const cams = [];                                     // {t, cam} 時刻ごとのカメラ
  // カメラの寄せ直し（tools/camrefine.js・2026-11-11）。CAMREFINE=0 で外す・1 は推定が通ったコマを寄せるだけ・2 は推定が落ちたコマも直前のカメラから拾う・3 はさらに camTrack コマおきに直前のカメラから追う（カメラの動きが速いコート用）
  const camMode = +(process.env.CAMREFINE || 0);
  const CAM_RESCUE = +(process.env.CAMRESCUE || 0.7), CAM_GRID = +(process.env.CAMGRID || 0.75);
  const CAM_S0 = +(process.env.CAMS0 || 1);              // 推定の点数がこれ未満のときだけ寄せた値に置き換える
  const camTrack = +(process.env.CAMTRACK || 3);
  let camRef = null; const camLog = [];                // 直前に採ったカメラ（寄せ直しの出発点）・採否の記録
  const started = Date.now();
  // 地面の色の地図（GMAP=1・2026-11-17 試作・既定は切）: 本解析の前にポイントを粗く読み直し、カメラが線に合うコマだけで地図を作る（tools/trail.js の gmap*）
  let gmap = null;
  // 外周の塊を塊の段で落とす（OUTERDROP=1・2026-11-17 試作・既定は切。tools/trail.js の setOuterDrop）。OUTER_PAD: 色相の帯の余白（度・既定 4）・OUTER_TAILX: 尾の横位置の上限（m・既定 6）・OUTER_GAP: コートの色相と外周の帯の離れがこれ未満のポイントでは何も捨てない（度・既定 30）
  const outerOn = opts.trail && process.env.OUTERDROP === '1';
  if (outerOn) Trail.setOuterDrop({ pad: +(process.env.OUTER_PAD || 4), tailX: +(process.env.OUTER_TAILX || 6), minGap: +(process.env.OUTER_GAP || 30) });
  if (process.env.NEARHUE === '1') Trail.setNearHue({ s: +(process.env.NH_S || 0.12), min: +(process.env.NH_MIN || 8), pad: +(process.env.NH_PAD || 3) });
  if (opts.trail && process.env.GMAP === '1') gmap = await buildGroundMap({ Court, Trail, video, t0, t1, srcFps: ((await ShotColor.videoSize(video)) || {}).fps || null });
  // Phase D: ショット色トレイル（opts.trail のとき毎フレーム）
  const trailLog = [], hist = [], starLog = [];
  // 打点の閃光（tools/flash.js・2026-10-15）: 毎コマの白い塊の記録
  const flashLog = []; let flashMask = null;
  // 入力の解像度とコマ数（2026-09-24 exp-int3f）: FHD 60fps 以外（720p・30fps）は FHD 60fps 専用の段（farball・shotcolor）を掛けず、理由を残す。
  // コマ数が fps と違えば frames で fps に揃える（時刻を正しく）。fps が読めなければ揃えない（従来どおり）。
  // 動画そのものを調べられなければ（null）notFhd は 'size?' で、farball・shotcolor は掛けない（安全側・exp-int3f-review N4）
  const vi = await ShotColor.videoSize(video);
  const notFhd = ShotColor.notFhd60(vi);
  const srcFps = vi ? vi.fps : null;
  const resample = srcFps != null && Math.abs(srcFps - fps) > 0.5;
  if (resample && !warnedFps.has(video)) { warnedFps.add(video); console.warn(`[rally-node] 入力が ${srcFps}fps なので fps=${fps} に揃えて読む（時刻 t0 + i/${fps}）: ${path.basename(video)}`); }

  for await (const fr of frames(video, t0, t1, fps, srcFps)) {
    // カメラが古い（カット直後）ときは 5 コマごとに推定し直して復帰を早める（サーブ画→ラリー画の切替で打点を落とさない）
    if (fr.i % camEvery === 0 || (fr.i - camAt_i > 30 && fr.i % 5 === 0)) {
      const e = Court.estimate(fr.img);
      // サーブ画（別カメラ・ロール付き）は横1本＋縦1本で "ok・suspect=false・agree=null" が通ってしまう。
      // 横2本以上・縦2本以上・交差検証あり、を「ラリーカメラ」の条件にする（2026-09-08 実測: 0908 p3 110.5〜111.75）
      let pass = e.ok && !e.suspect && e.hHits >= 2 && e.xHits >= 2 && e.agree != null, ce = e;
      if (camMode > 0) {
        const rd = CamRefine.ridge(fr.img.data);
        if (pass) {
          // 推定が通ったコマ: 線の模型が尾根に乗る割合が上がる所へ寄せる（下がることは無い）
          const r = CamRefine.improve(rd, e, camRef);
          if (r.s >= r.s0 + 0.02 && r.s0 < CAM_S0) { e.c0 = r.cam.c0; e.c1 = r.cam.c1; e.Xc = r.cam.Xc; e.Yc = Court.K / r.cam.c1; e.rsrc = r.src; }
          e.rs = +Math.max(r.s, r.s0).toFixed(3); e.rs0 = +r.s0.toFixed(3);
        } else if (camMode > 1) {
          // 推定が落ちたコマ: 直前のカメラから寄せて点数が高ければ標本にする。総当たりは camEvery の刻みだけ・閾値も高く（サーブ画・演出カットを通さない）
          const r = CamRefine.rescue(rd, camRef, fr.i % camEvery === 0);
          if (r) {
            const okR = r.s >= (r.src === 'grid' ? CAM_GRID : CAM_RESCUE);
            camLog.push({ t: fr.t, src: r.src, s: +r.s.toFixed(3), ok: okR });
            if (okR) { ce = { ok: true, c0: r.cam.c0, c1: r.cam.c1, Xc: r.cam.Xc, Yc: Court.K / r.cam.c1, rs: +r.s.toFixed(3), rsrc: 'rescue-' + r.src }; pass = true; }
          }
        }
      }
      if (pass) {
        const e = ce; camRef = { c0: e.c0, c1: e.c1, Xc: e.Xc };
        cam = e; camAt_i = fr.i; camProv = null;
        e.t = fr.t;   // 標本の時刻（rally-refuse の camAt と同じ形・2026-09-29 fartime: fuse の自分のサーブの寄せが「直前に標本が無い」を見る。farball は自前で t を足すので変わらない）
        cams.push({ t: fr.t, cam: e });
        const base = Court.toScreen(0, 0, cam).y, u = 1 / cam.c0, hpx = 0.91 * u / cam.Yc;
        net = { y0: (base - hpx * 1.25) / 2, y1: (base + 12) / 2 };
      } else if (e.ok && e.xHits >= 2 && e.hHits >= 1.5) {   // 緩めすぎるとサーブ画(1/1)でも通ってしまう（砂 412.1 の偽打点）
        // 仮カメラ: サーブ画→ラリー画へのズーム中（0.4秒ほど）は横ラインが揃わない。座標には使わないがトレイル検出には使う
        camProv = e; camProvAt_i = fr.i;
      }
    }
    else if (camMode > 2 && camRef && fr.i % camTrack === 0 && fr.i - camAt_i <= 15) {
      // 推定の合間: 直前のカメラ（0.25 秒以内）から寄せるだけ（Court.estimate は呼ばない）。点数が高いときだけ標本にする
      const r = CamRefine.refine(CamRefine.ridge(fr.img.data), camRef);
      if (r.s >= CAM_RESCUE) {
        camRef = r.cam;
        cam = { ok: true, t: fr.t, c0: r.cam.c0, c1: r.cam.c1, Xc: r.cam.Xc, Yc: Court.K / r.cam.c1, rs: +r.s.toFixed(3), rsrc: 'track' }; camAt_i = fr.i; camProv = null;
        cams.push({ t: fr.t, cam });
        const base = Court.toScreen(0, 0, cam).y, u = 1 / cam.c0, hpx = 0.91 * u / cam.Yc;
        net = { y0: (base - hpx * 1.25) / 2, y1: (base + 12) / 2 };
      }
    }
    if (opts.trail && fr.i % trailEvery === 0) {
      // カメラが 0.5 秒以上更新されていない（サーブ画・リプレイ・演出カット）ならトレイルは見ない
      const fresh = fr.i - camAt_i <= 30, prov = !fresh && fr.i - camProvAt_i <= 10;
      const tr = fresh ? Trail.detect(fr.img, { cam, hist }) : prov ? Trail.detect(fr.img, { cam: camProv, hist }) : { blobs: [], ref: null, mask: null };
      if (prov) tr.blobs.forEach(b => { b.prov = true; });
      hist.unshift({ mask: tr.mask, blobs: tr.blobs }); if (hist.length > 3) hist.pop();
      // 着弾の星マーカー（ラリーカメラのときだけ・砂コートは star.js 側で除外）
      if (fresh) starLog.push({ t: fr.t, stars: Star.detect(fr.img, { cam, ref: tr.ref }) });
      trailLog.push({ t: fr.t, f: fr.i, blobs: tr.blobs,
                      ref: tr.ref ? { S90: +tr.ref.S90.toFixed(2), V90: +tr.ref.V90.toFixed(2), L90: Math.round(tr.ref.L90), Hmed: tr.ref.Hmed == null ? null : Math.round(tr.ref.Hmed), lineL: Math.round(tr.ref.lineL), useHue: tr.ref.useHue, Hd98: tr.ref.Hd98 == null ? null : +tr.ref.Hd98.toFixed(1), S50b: tr.ref.S50b == null ? null : +tr.ref.S50b.toFixed(2) } : null });
    }
    if (opts.trail) { const fl = Flash.detect(fr.img, flashMask); flashMask = fl.mask; if (fl.comps.length) flashLog.push({ t: +fr.t.toFixed(3), comps: fl.comps }); }
    const cs = BallTrack.candidates(fr.img, { prevMask });
    prevMask = cs.mask;
    // フィルタは ball.js 側の差し替え点に委ねる（変種が丸ごと置き換えられるように）
    const keep = BallTrack.filterCandidates(cs, { net, overlapMax, t: fr.t, f: fr.i, state, prev, cam });
    prev = keep;
    frameLog.push({
      t: fr.t, f: fr.i,
      c: keep.map(c => [+c.x.toFixed(2), +c.y.toFixed(2), c.n, +c.fill.toFixed(3), +c.rg.toFixed(3)]),
      nRaw: cs.length, nKeep: keep.length,
    });
  }

  const camAt = t => {
    if (!cams.length) return null;
    let b = cams[0];
    for (const c of cams) if (Math.abs(c.t - t) < Math.abs(b.t - t)) b = c;
    return b.cam;
  };

  const chains = BallTrack.buildChains(frameLog);
  const ranked = BallTrack.pickBall(chains, { net });
  const segs = BallTrack.ballSegments(ranked);
  const events = segs.length ? BallTrack.classifyEvents(segs, camAt) : [];
  const yFarAt = t => { const c = camAt(t); return c && c.ok ? Court.toScreen(0, Court.Z_BASE, c).y / Trail.SC : null; };   // 奥ベースラインの画面 y（カメラの縦移動の物差し）
  // OUTERDROP: ポイント全体の外周の帯とコートの色相で離れを1回だけ出し、開いていれば trailLog の塊をふるってから runs に渡す（trail.js の outerFilter）
  const outerRes = outerOn ? Trail.outerFilter(trailLog) : null;
  const trailRuns = opts.trail ? Trail.runs(trailLog, { fps: fps / trailEvery, yFarAt }) : null;
  const shots = trailRuns ? Trail.shots(trailRuns, { tStart: t0 }) : null;
  const track = []; segs.forEach(s => s.pts.forEach(p => track.push(p))); track.sort((a, b) => a.t - b.t);
  const markers = opts.trail ? Star.track(starLog) : [];
  // 奥側（相手コート）のボール追跡（フル解像度・tools/farball.js）: 折り返し/出現を 'hit' イベントとして追跡イベントに混ぜ、fuse の同側補完・空白補完に効かせる
  let farBall = null;
  if (opts.trail && opts.farBall !== false && cams.length) {
    if (notFhd) {
      // FHD 60fps 以外は掛けない（2026-09-24 exp-int3f・レビューの note）: 帯の crop（1920 幅）・期待直径・px の閾値は FHD、速さの閾値は 60fps のコマ。以前は ffmpeg が
      // crop を拒否するのに頼っていた（720p は毎ポイント stderr にエラー・2560×1440 なら crop が通って縮尺違いの far が出る）。30fps の FHD は fps=60 で読むと同じ絵が 2 コマずつ続き、
      // 前コマとの重なり（ov ≥ 0.85 は軌道の起点にしない）と同じ升目に居るコマ数（静止物の篩）の数え方が 60fps の前提から外れる。空の結果に理由を付けて残す（warn は動画ごとに 1 回）
      if (!warnedFar.has(video)) { warnedFar.add(video); console.warn(`[farball] FHD 60fps 以外（${notFhd}）なので奥側のボール追跡を掛けない: ${path.basename(video)}`); }
      farBall = { skipped: notFhd, events: [], tracks: [], weakTracks: [], band: null };
    } else {
      farBall = await FarBall.track({ video, t0, t1, fps, cams, Court, markers });
      events.push(...farBall.events); events.sort((a, b) => a.t - b.t);
    }
  }
  const rally = shots ? RallyFuse.fuse({ shots, events, track, camAt, t0, t1, markers, farTracks: farBall ? farBall.tracks : [], segs }).shots : null;
  // 閃光から取りこぼしの打点を足す（fuse の後・shotcolor の前・rally-refuse も同じ順序）。閾値は FHD 60fps で測ったので、それ以外は掛けない
  const flash = opts.trail && !notFhd ? Flash.events(flashLog, net) : [];
  if (rally) Flash.apply(rally, flash);
  // 2026-10-21: 交互が崩れた二重の打点を捨てる（tools/dupfix.js・閃光の後・shotcolor の前・rally-refuse も同じ順序）。DUPFIX=0 / DUPSAME=0 で外せる
  const dupOpp = rally && process.env.DUPFIX !== '0' ? DupFix.apply(rally) : [];
  const dupSame = rally && process.env.DUPSAME !== '0' ? DupFix.applySame(rally) : [];
  // 追跡由来の打点（src track / far-* / launch*・種別 unknown）の種別を、打点直後の球の通り道の色（フル解像度）で読む後段（tools/shotcolor.js・1 打 0.3〜0.6 秒）。
  // fuse の後に掛ける（rally-refuse.js も fuse の後に掛け直す）
  let shotColor = null;
  if (rally && opts.trail && opts.shotColor !== false) {
    const sc = await ShotColor.apply({ video, rally, segPts: segs.map(s => ({ pts: s.pts })), farBall, t1,
                                       toCourt: (t, x, y) => { const c = camAt(t); return c && c.ok ? Court.toCourt(x, y, c) : null; },
                                       camOk: ShotColor.makeCamOk(cams, Court) });
    shotColor = { changed: sc.changed, n: sc.skipped ? sc.n : sc.log.length, ms: sc.ms, skipped: sc.skipped, log: sc.log };   // skipped: FHD 以外で読まなかった（2026-09-24）
  }
  // 2026-10-15: 閃光で足した自分の打点の青いトレイルからスライスを読む（tools/flash.js readSlice・shotcolor の後・slide の前）
  const flashSlice = rally && opts.trail && !notFhd ? await Flash.readSlice({ video, rally, ffmpeg: ShotColor.findFfmpeg() }) : null;
  if (rally) Slide.apply(rally);   // 2026-09-30: shotcolor の後にスライドの種別（tools/slide.js）
  if (rally && process.env.GAPFILL !== '0') GapFill.apply(rally, trailRuns);   // 2026-11-06: 相手→相手の穴に色つき run の切れ目を足す（tools/gapfill.js・rally-refuse も同じ順序）
  // 2026-11-17: 軌道当てはめ（tools/traj.js）。打ごとに traj（打点の XYZ・着弾・ネット上の高さ）を足す。既定は切（TRAJ=1 で有効）。録画をフル解像度でもう 1 回読むので遅い
  let traj = null;
  if (rally && rally.length && opts.trail && process.env.TRAJ === '1' && !notFhd && cams.length > 1) traj = await Traj.apply({ video, rally, cams: cams.map(c => ({ t: c.t, c0: c.cam.c0, c1: c.cam.c1, Xc: c.cam.Xc })), trailLog, markers });

  return {
    rally, shots, trailRuns, markers, farBall, shotColor, flash, flashSlice, dupOpp, dupSame, traj, ...(gmap ? { gmap } : {}), ...(outerOn ? { outerDrop: { ...Trail.outerStats(), ...outerRes } } : {}), trailLog: opts.trail ? trailLog : undefined,
    video: path.basename(video), t0, t1, fps, variant: opts.variant || null,
    input: vi ? { w: vi.w, h: vi.h, fps: vi.fps, resampled: resample, notFhd60: notFhd } : null,   // 入力の解像度・コマ数と FHD 60fps でない理由（2026-09-24 exp-int3f）
    ms: Date.now() - started,
    nFrames: frameLog.length,
    nCands: frameLog.reduce((s, f) => s + f.c.length, 0),
    camOk: cams.length, net,
    cams: cams.map(c => ({ t: c.t, c0: c.cam.c0, c1: c.cam.c1, Xc: c.cam.Xc, Yc: c.cam.Yc, ...(c.cam.rs != null ? { s: c.cam.rs, s0: c.cam.rs0, src: c.cam.rsrc } : {}) })),
    camLog: camMode > 1 ? camLog : undefined,
    chains: chains.length,
    ranked: ranked.slice(0, 12).map(c => ({
      t0: c.pts[0].t, t1: c.pts[c.pts.length - 1].t, len: c.len,
      rank: +c.rank.toFixed(1), nAvg: c.nAvg, vertRatio: c.vertRatio,
      spanX: +c.spanX.toFixed(1), spanY: +c.spanY.toFixed(1),
    })),
    segments: segs.map(s => ({ t0: s.t0, t1: s.t1, len: s.len, rank: +s.rank.toFixed(1) })),
    segPts: segs.map(s => ({ t0: s.t0, t1: s.t1, pts: s.pts })),
    events,
    frameLog,
  };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const video = a[0], t0 = +a[1], t1 = +a[2];
  const jsonAt = a.indexOf('--json');
  const fpsAt = a.indexOf('--fps');
  const varAt = a.indexOf('--variant');
  const trail = a.includes('--trail');
  if (!video || !isFinite(t0) || !isFinite(t1)) {
    console.error('usage: node rally-node.js <video> <t0> <t1> [--json out.json] [--fps 60]');
    process.exit(2);
  }
  analyze({ video, t0, t1, fps: fpsAt >= 0 ? +a[fpsAt + 1] : 60, variant: varAt >= 0 ? a[varAt + 1] : null, trail }).then(r => {
    if (jsonAt >= 0) fs.writeFileSync(a[jsonAt + 1], JSON.stringify(r, null, 1));
    const { frameLog, trailLog, ...brief } = r;
    if (brief.shots) brief.shots = brief.shots.map(({ frames, ...s }) => s);
    console.log(JSON.stringify(brief, null, 1));
  }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { analyze, loadModules, frames, W, H };
