// SENSEKI SCAN — 試合レポート（ラリー解析の保存ファイル1本の1試合ぶんを集計して見せる）
// 保存形式は rally-store.js。手直し画面（rally-edit.html）とは ?id=&m=（&p=）で行き来する。保存ファイルは開くたびに読み直す。
'use strict';
const RS = window.RallyStore;
const $ = id => document.getElementById(id);
const NAME = Object.fromEntries(RS.CLS.map(c => [c[0], c[1]]));
const COL = Object.fromEntries(RS.CLS.map(c => [c[0], c[2]]));
const ORDER = RS.CLS.map(c => c[0]);
const ME_COL = '#2ecc71', OPP_COL = '#c9d3ce';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dot = c => `<span class="dot" style="background:${c}"></span>`;
const pct = (n, t) => n && t ? Math.round(n / t * 100) + '%' : '-';

// Electron の外（ブラウザで画面だけ確かめるとき）は ?store=<URL> から読む（rally-edit.js と同じ）
const Q = new URLSearchParams(location.search);
const API = window.api || {
  rallyList: async () => Q.get('store') ? [{ id: 'demo', name: Q.get('store'), pts: 0, done: 0 }] : [],
  rallyLoad: async () => ({ ok: true, store: await (await fetch(Q.get('store'))).json() }),
};

let fileId = null, S = null, mi = 0;

function setStatus(msg, bad) { $('status').textContent = msg; $('status').className = 'sub' + (bad ? ' bad' : ''); }

async function refreshList(selectId, m) {
  const list = await API.rallyList();
  $('empty').style.display = list.length ? 'none' : 'block';
  $('wrap').style.display = list.length ? '' : 'none';
  $('fileSel').innerHTML = list.map(f => `<option value="${esc(f.id)}">${esc(f.name)}（確認済み ${f.done}/${f.pts}）</option>`).join('');
  $('fileSel').style.display = list.length ? '' : 'none';
  if (!list.length) return;
  const id = list.some(f => f.id === selectId) ? selectId : list[0].id;
  $('fileSel').value = id;
  await openFile(id, id === selectId ? m : 0);
}
async function openFile(id, m) {
  const r = await API.rallyLoad(id);
  if (!r.ok) { setStatus('保存ファイルを読めませんでした', true); return; }
  fileId = id; S = r.store;
  mi = m != null && S.matches[m] ? m : 0;
  render();
}
$('fileSel').onchange = () => openFile($('fileSel').value, 0);
$('matchBar').onclick = e => { const b = e.target.closest('[data-m]'); if (b) { mi = +b.dataset.m; render(); } };

// 手直し画面へのURL（p を付けるとそのポイントを開く）
function editUrl(p) {
  const o = new URLSearchParams();
  if (fileId) o.set('id', fileId);
  o.set('m', mi);
  if (p != null) o.set('p', p);
  if (!window.api && Q.get('store')) { o.set('store', Q.get('store')); if (Q.get('video')) o.set('video', Q.get('video')); }
  return 'rally-edit.html?' + o;
}

// ---- 集計 ----
function summarize(match) {
  const pts = match.points;
  const won = { me: 0, opp: 0 };
  const cls = { me: {}, opp: {} }, tot = { me: 0, opp: 0 };
  const flag = { unknown: 0, same: 0, all: 0 };
  // 終わり方: 自分の決め球 / 相手のミス（＝自分の得点）/ 相手の決め球 / 自分のミス（＝失点）
  const ends = { meWin: {}, oppMiss: {}, oppWin: {}, meMiss: {} };
  let noEnd = 0;
  const land = [];
  let longest = null;
  pts.forEach((p, i) => {
    if (p.winner) won[p.winner]++;
    for (const s of p.shots) {
      tot[s.side]++;
      cls[s.side][s.cls] = (cls[s.side][s.cls] || 0) + 1;
      if (s.land) land.push({ s, p });
    }
    RS.flags(p.shots).forEach((f, k) => {
      if (!f) return;
      flag.all++;
      if (f.includes('種別不明')) flag.unknown++;
      if (f.includes('同じ側が連続')) flag.same++;
    });
    const last = p.shots[p.shots.length - 1];
    if (!last || !p.winner) noEnd++;
    else {
      const key = p.winner === 'me' ? (last.side === 'me' ? 'meWin' : 'oppMiss') : (last.side === 'opp' ? 'oppWin' : 'meMiss');
      ends[key][last.cls] = (ends[key][last.cls] || 0) + 1;
    }
    if (!longest || p.shots.length > longest.p.shots.length) longest = { p, no: i + 1 };
  });
  const finalPt = pts.find(p => p.final && p.winner);
  const result = finalPt ? (finalPt.winner === 'me' ? 'win' : 'lose') : null;
  return { pts, won, cls, tot, flag, ends, noEnd, land, longest, result };
}

const fmtDur = sec => { const m = Math.floor(sec / 60), s = Math.round(sec - m * 60); return m ? `${m}分${s}秒` : `${s}秒`; };

// ---- 描画 ----
function render() {
  const match = S.matches[mi];
  const st = summarize(match);
  const total = st.tot.me + st.tot.opp;

  $('matchBar').innerHTML = S.matches.length > 1
    ? S.matches.map((m, k) => `<button data-m="${k}" aria-pressed="${k === mi}">第${m.no}試合</button>`).join('')
    : '';
  $('toEdit').href = editUrl();
  document.title = `SENSEKI SCAN — 試合レポート（${S.video.name}${S.matches.length > 1 ? ' 第' + match.no + '試合' : ''}）`;

  // 結果
  $('score').innerHTML = `${st.won.me} <i>-</i> ${st.won.opp}`;
  $('pill').className = 'pill ' + (st.result || 'open');
  $('pill').textContent = st.result === 'win' ? '勝ち' : st.result === 'lose' ? '負け' : '途中まで';
  $('meNote').textContent = `${st.tot.me}打`;
  $('oppNote').textContent = `${st.tot.opp}打`;
  const pts = match.points;
  const dur = pts.length ? pts[pts.length - 1].t1 - pts[0].t0 : 0;
  const done = pts.filter(p => p.done).length;
  $('chips').innerHTML = [
    S.video.name,
    match.playedAt ? match.playedAt.slice(0, 16) : null,
    `${pts.length}ポイント・${fmtDur(dur)}`,
    `確認済み ${done}/${pts.length}`,
  ].filter(Boolean).map(t => `<span class="chip num">${esc(t)}</span>`).join('');

  // 数字のタイル
  const lp = st.longest && st.longest.p;
  const avg = pts.length ? total / pts.length : 0;
  const tiles = [
    { label: '総打数', v: total, unit: '打', note: `自分${st.tot.me}・相手${st.tot.opp}` },
    { label: '平均ラリー', v: avg.toFixed(1), unit: '打', note: '1ポイントあたり' },
    { label: '最長ラリー', v: lp ? lp.shots.length : 0, unit: '打', note: lp ? `P${st.longest.no}（${lp.before || '-'} から・${lp.winner === 'me' ? '自分の得点' : lp.winner === 'opp' ? '相手の得点' : '得点不明'}）` : '-' },
    { label: '要確認', v: st.flag.all, unit: '打', note: `不明${st.flag.unknown}・同じ側の連続${st.flag.same}`, flag: st.flag.all > 0 },
  ];
  $('tiles').innerHTML = tiles.map(t => `<div class="tile${t.flag ? ' flag' : ''}">
    <span class="sub">${t.label}</span>
    <span class="v num">${t.v}<small>${t.unit}</small></span>
    <span class="sub">${esc(t.note)}</span>
    ${t.flag ? `<a href="${esc(editUrl(firstFlagged(match)))}">タイムラインで直す</a>` : ''}
  </div>`).join('');

  // ショット配分（調整用の球種は出てきたときだけ行にする）
  const used = ORDER.filter((k, i) => i < RS.MAIN_CLS || st.cls.me[k] || st.cls.opp[k]);
  $('mix').innerHTML = [['me', '自分'], ['opp', '相手']].map(([s, label]) => `<div class="mixrow">
    <div class="hd"><b>${label}</b><span class="sub num">${st.tot[s]}打</span></div>
    <div class="stack">${used.filter(k => st.cls[s][k]).map(k =>
      `<div style="flex:${st.cls[s][k]} 1 0; background:${COL[k]}" title="${NAME[k]} ${st.cls[s][k]}打"></div>`).join('')}</div>
  </div>`).join('');
  $('typeRows').innerHTML = used.map(k => `<tr>
    <th scope="row"><span style="display:inline-flex; align-items:center; gap:8px">${dot(COL[k])}${NAME[k]}</span></th>
    <td>${st.cls.me[k] || 0}<span class="sub">${pct(st.cls.me[k], st.tot.me)}</span></td>
    <td>${st.cls.opp[k] || 0}<span class="sub">${pct(st.cls.opp[k], st.tot.opp)}</span></td>
  </tr>`).join('');

  // ポイントの終わり方
  const n = o => Object.values(o).reduce((a, b) => a + b, 0);
  const by = o => ORDER.filter(k => o[k]).map(k => `<span class="tag">${dot(COL[k])}${NAME[k]} ${o[k]}</span>`).join('');
  const endBox = (group, label, o, win) => `<div class="end${win ? ' win' : ''}">
    <span class="sub">${group}</span><b style="font-size:14px">${label}</b>
    <span class="n num">${n(o)}</span><div class="tags">${by(o)}</div></div>`;
  $('endings').innerHTML =
    endBox(`得点 ${st.won.me}`, '自分の決め球', st.ends.meWin, true) +
    endBox(`得点 ${st.won.me}`, '相手のミス', st.ends.oppMiss, true) +
    endBox(`失点 ${st.won.opp}`, '相手の決め球', st.ends.oppWin, false) +
    endBox(`失点 ${st.won.opp}`, '自分のミス', st.ends.meMiss, false);
  $('endNote').textContent = '決め球＝得点した側が最後に打った球。ミス＝最後に打った側が失点した球（ネット・アウト・届かずの区別はまだ付きません）。'
    + (st.noEnd ? `打点か得点の取れていない ${st.noEnd} ポイントは数えていません。` : '');

  // ラリーの長さ
  const maxN = Math.max(1, ...pts.map(p => p.shots.length));
  $('bars').innerHTML = pts.map((p, i) => {
    const flagged = RS.flags(p.shots).some(Boolean);
    const who = p.winner === 'me' ? '自分の得点' : p.winner === 'opp' ? '相手の得点' : '得点不明';
    return `<a href="${esc(editUrl(p.idx))}" class="${flagged ? 'flag' : ''}" aria-label="P${i + 1} ${esc(p.after)} ${p.shots.length}打 ${who}${flagged ? ' 要確認あり' : ''}" title="P${i + 1}（${esc(p.before)} → ${esc(p.after)}）${p.shots.length}打・${who}${flagged ? '・要確認あり' : ''}${p.done ? '・確認済み' : ''}">
      <span class="c num" style="font-size:12px; font-weight:700">${p.shots.length}</span>
      <span class="b" style="height:${Math.round(p.shots.length / maxN * 170)}px; background:${p.winner === 'me' ? ME_COL : OPP_COL}"></span>
    </a>`;
  }).join('');
  $('barLbl').innerHTML = pts.map((p, i) => `<span class="num">P${i + 1}<br>${esc(p.after)}</span>`).join('');
  const minW = pts.length * 42 + 'px';
  $('bars').style.minWidth = minW; $('barLbl').style.minWidth = minW;

  // 着弾マップ（精度が低いので参考表示）
  $('dots').innerHTML = st.land.map(({ s }) => {
    const cx = 20 + (s.land[0] + 5.485) * 18, cy = 20 + (11.885 - s.land[1]) * 18;
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${COL[s.cls] || COL.unknown}" stroke="#0f1613" stroke-width="1.5"><title>${s.side === 'me' ? '自分' : '相手'}の${NAME[s.cls] || s.cls}</title></circle>`;
  }).join('');
  $('court').setAttribute('aria-label', `着弾が取れた${st.land.length}打の位置。下が自分のコート`);
  const lc = {}, ls = { me: 0, opp: 0 };
  st.land.forEach(({ s }) => { lc[s.cls] = (lc[s.cls] || 0) + 1; ls[s.side]++; });
  const whose = !st.land.length ? '' : ls.opp > ls.me * 2 ? 'ほとんどが相手の球です。' : ls.me > ls.opp * 2 ? 'ほとんどが自分の球です。' : `自分${ls.me}・相手${ls.opp}。`;
  $('landTxt').innerHTML = `
    <p>着弾が取れたのは <b class="num">${total}打中${st.land.length}打</b>（${pct(st.land.length, total)}）。${whose}</p>
    <p class="sub">着弾の精度が上がるまでは、配球の傾向を読む材料にはせず「どこに落ちたか見てみる」程度の扱いにします。</p>
    <div style="display:flex; flex-wrap:wrap; gap:6px 12px">${ORDER.filter(k => lc[k]).map(k =>
      `<span style="display:inline-flex; align-items:center; gap:6px; color:#c4d3cb">${dot(COL[k])}${NAME[k]} ${lc[k]}</span>`).join('')}</div>`;

  setStatus(`更新 ${S.updatedAt ? new Date(S.updatedAt).toLocaleString() : ''}`);
}

// 要確認の打がある最初のポイント
function firstFlagged(match) {
  const p = match.points.find(x => RS.flags(x.shots).some(Boolean));
  return p ? p.idx : null;
}

// ほかの窓から戻ったときに読み直す（手直し画面からはページごと移るので開くたびに最新）
window.addEventListener('focus', () => { if (fileId && window.api) openFile(fileId, mi); });

{
  const m = Q.get('m');
  refreshList(Q.get('id'), m != null && m !== '' ? +m : 0);
}
