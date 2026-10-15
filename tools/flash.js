// 打点の閃光（白い光の塊）から、追跡が取りこぼした打点を足す（2026-10-15）。
// ネット際のドロップ応酬などで球の軌道が切れ、トレイルも追跡も打点を出さないところを補う。
//   detect(img, prevMask)  → { comps, mask }   1 コマ（960×540 RGBA）の白い塊。rally-node のフレームループで毎コマ呼ぶ
//   events(log, net)       → [{ t, side, cx, cy, w, h, n }]   コマごとの塊の記録から閃光イベントを作る
//   apply(rally, events)   → 足した数   ラリーの打点の間に src 'flash' の打点（種別 unknown）を差し込む。fuse の後・shotcolor の前に掛ける
// 実測（手直し済み GT 8 組・scratchpad の flashprobe/flashins）:
//   自分の打点の閃光は画面中央寄りの丸い光（縦横比 0.6〜1.45）、相手の打点はネットの帯か下に出る横長の光（1.6〜2.8・幅 70px 以下）。
//   光は GT の打点より 0.03 秒ほど前に出る。静止した白いボール（前コマにもある画素が半分以上）・左上の UI・同時に 3 つ以上の塊（UI の行）・
//   大きく疎な塊（n>2500・充填率<0.35）・細い線（縦か横が 18px 未満）は閃光ではない。
//   手直し済み GT 8 組: 見つけた打点 449→486・取り違え 95→103・種別一致 329→336。ホールドアウト y 4 組: 見つけた打点 +2・取り違え ±0・種別一致 +1
//   （注意: 位置の絞り込み（TIGHT）はホールドアウトの偽の閃光を見てから足した）
const W = 960, H = 540;
const P = { V: 235, CHROMA: 40, Y0: 60, Y1: H - 40, NMIN: 150, MINN: 400, NF: 0.5, FMIN: 0.35, NMAX: 2500, MULTI: 3, MERGE_T: 0.25, MERGE_D: 120, LEAD: 0.03, AW: 0.4, TAIL: 0.8 };

// 明るく無彩色の画素（max ≥ 235・max−min ≤ 40）の 4 近傍の連結成分。nNew は前コマの mask に無かった画素の数
function detect(img, prevMask) {
  const d = img.data;
  const m = new Uint8Array(W * H);
  for (let y = P.Y0; y < P.Y1; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mx >= P.V && mx - mn <= P.CHROMA) m[y * W + x] = 1;
  }
  const lab = new Uint8Array(W * H), comps = [], st = [];
  for (let p = 0; p < W * H; p++) {
    if (!m[p] || lab[p]) continue;
    lab[p] = 1; st.push(p);
    let n = 0, sx = 0, sy = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, nNew = 0;
    while (st.length) {
      const q = st.pop(), x = q % W, y = (q / W) | 0;
      n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (!prevMask || !prevMask[q]) nNew++;
      if (x > 0 && m[q - 1] && !lab[q - 1]) { lab[q - 1] = 1; st.push(q - 1); }
      if (x < W - 1 && m[q + 1] && !lab[q + 1]) { lab[q + 1] = 1; st.push(q + 1); }
      if (q >= W && m[q - W] && !lab[q - W]) { lab[q - W] = 1; st.push(q - W); }
      if (q + W < W * H && m[q + W] && !lab[q + W]) { lab[q + W] = 1; st.push(q + W); }
    }
    if (n >= P.NMIN) comps.push({ n, cx: Math.round(sx / n), cy: Math.round(sy / n), w: x1 - x0 + 1, h: y1 - y0 + 1, fill: +(n / ((x1 - x0 + 1) * (y1 - y0 + 1))).toFixed(2), nNew });
  }
  return { comps, mask: m };
}

const isUi = c => c.cx < 260 && c.cy < 160;

// log: [{ t, comps }]（塊のあるコマだけ）・net: { y0, y1 }（rally-node の net）
function events(log, net) {
  const ev = [];
  if (!net) return ev;
  const mid = (net.y0 + net.y1) / 2;
  for (const r of log) {
    const fresh = r.comps.filter(c => !isUi(c) && c.n >= P.MINN && c.nNew / c.n >= P.NF);
    if (fresh.length >= P.MULTI) continue;
    for (const c of fresh) {
      if (c.n > P.NMAX || c.fill < P.FMIN || c.h < 18 || c.w < 18) continue;
      if (ev.some(e => r.t - e.t <= P.MERGE_T && Math.hypot(c.cx - e.cx, c.cy - e.cy) < P.MERGE_D)) continue;
      const asp = c.w / c.h, dy = c.cy - mid;
      let side = null;
      if (asp >= 0.6 && asp <= 1.45 && c.cx >= 300 && c.cx <= 700 && dy >= -130) side = 'me';
      else if (asp >= 1.6 && asp <= 2.8 && dy >= -10 && c.w <= 70) side = 'opp';
      if (side) ev.push({ t: +(r.t + P.LEAD).toFixed(3), side, cx: c.cx, cy: c.cy, w: c.w, h: c.h, n: c.n });
    }
  }
  return ev;
}

// ラリーの最初の打点〜最後の打点 +0.8 秒の間で、どの打点からも 0.4 秒以上離れた閃光だけを足す
function apply(rally, evs) {
  if (!rally || !rally.length || !evs || !evs.length) return 0;
  const lo = rally[0].t, hi = rally[rally.length - 1].t + P.TAIL;
  const add = [];
  for (const e of evs) {
    if (e.t < lo || e.t > hi) continue;
    if (rally.some(h => Math.abs(h.t - e.t) < P.AW) || add.some(h => Math.abs(h.t - e.t) < P.AW)) continue;
    add.push({ t: e.t, side: e.side, cls: 'unknown', src: 'flash', flash: { x: e.cx, y: e.cy, w: e.w, h: e.h, n: e.n } });
  }
  rally.push(...add); rally.sort((a, b) => a.t - b.t);
  return add.length;
}

module.exports = { detect, events, apply, P };
