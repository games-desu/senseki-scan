// SENSEKI SCAN — ラリー解析の手直し画面（ポイント別タイムライン）
// 保存形式とCSVは rally-store.js。操作は tools/rally-edit.html（開発用の手直し道具）と同じキー＋要確認へ飛ぶ N。
'use strict';
const RS = window.RallyStore;
const $ = id => document.getElementById(id);
const v = $('v');
const COL = Object.fromEntries(RS.CLS.map(c => [c[0], c[2]]));
const NAME = Object.fromEntries(RS.CLS.map(c => [c[0], c[1]]));

// Electron の外（ブラウザで画面だけ確かめるとき）は ?store=<URL>&video=<URL> から読み、保存はしない
const API = window.api || {
  rallyList: async () => { const u = new URLSearchParams(location.search).get('store'); return u ? [{ id: 'demo', name: u, matches: 0, pts: 0, done: 0, shots: 0, flagged: 0 }] : []; },
  rallyLoad: async () => {
    const q = new URLSearchParams(location.search);
    return { ok: true, store: await (await fetch(q.get('store'))).json(), videoOk: !!q.get('video'), videoUrl: q.get('video') };
  },
  rallySave: async () => ({ ok: true }),
  rallyImport: async () => ({ ok: false, ids: [] }),
  rallyPickVideo: async () => ({ ok: false }),
  saveCsv: async (name, content) => { console.log(name + '\n' + content); return { ok: false }; },
};

let fileId = null, S = null;       // 開いている保存ファイル
let mi = 0, P = null, sel = -1;    // 試合の番号（matches の添字）・ポイント・選んだ打
let undo = [];                     // 今のポイントの手直し前の打（取り消し用）
let saveTimer = null;

const fps = () => S.video.fps || 60;
const snap = t => Math.round(t * fps()) / fps();
const M = () => S.matches[mi];
const fmtT = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setStatus(msg, bad) { $('status').textContent = msg; $('status').className = 'sub' + (bad ? ' bad' : ''); }

// ---- 保存ファイルの一覧と読み込み ----
// m / p: 開く試合（matches の添字）とポイント（idx）。レポートの棒から来たとき
async function refreshList(selectId, m, p) {
  const list = await API.rallyList();
  $('empty').style.display = list.length ? 'none' : 'block';
  $('app').style.display = list.length ? '' : 'none';
  $('fileSel').innerHTML = list.map(f => `<option value="${esc(f.id)}">${esc(f.name)}（確認済み ${f.done}/${f.pts}）</option>`).join('');
  $('fileSel').style.display = list.length ? '' : 'none';
  if (!list.length) return;
  const id = list.some(f => f.id === selectId) ? selectId : list[0].id;
  $('fileSel').value = id;
  await openFile(id, id === selectId ? m : null, id === selectId ? p : null);
}
async function openFile(id, m, p) {
  await flushSave();
  const r = await API.rallyLoad(id);
  if (!r.ok) { setStatus('保存ファイルを読めませんでした', true); return; }
  fileId = id; S = r.store;
  setVideo(r.videoOk ? r.videoUrl : null);
  // 最初の未確認ポイントから
  let first = null;
  S.matches.forEach((m, i) => m.points.forEach(p => { if (!first && !p.done) first = [i, p.idx]; }));
  first = first || [0, S.matches[0].points[0].idx];
  if (m != null && S.matches[m]) first = [m, p != null && S.matches[m].points.some(x => x.idx === p) ? p : null];
  openMatch(first[0], first[1]);
}
function setVideo(url) {
  $('noVideo').style.display = url ? 'none' : 'flex';
  $('noVideoMsg').innerHTML = url ? '' : `録画が見つかりません<br><span class="num">${esc(S.video.path || S.video.name)}</span>`;
  if (url) { v.src = url; v.playbackRate = +$('rate').value; } else v.removeAttribute('src');
}
$('fileSel').onchange = () => openFile($('fileSel').value);
$('bImport').onclick = async () => {
  const r = await API.rallyImport();
  if (r.ok && r.ids.length) { setStatus(`${r.ids.length} 件を取り込みました`); refreshList(r.ids[0]); }
  else if (r.ok) setStatus('ラリー解析の保存ファイルではありませんでした', true);
};
$('bPickVideo').onclick = async () => {
  const r = await API.rallyPickVideo(fileId);
  if (r.ok) { S.video.path = r.path; setVideo(r.videoOk ? r.videoUrl : null); if (P) seek(P.t0); }
};

// ---- 保存（変更のたびに 0.7 秒まとめて書く）----
function changed() {
  S.updatedAt = new Date().toISOString();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}
async function save() {
  clearTimeout(saveTimer); saveTimer = null;
  const r = await API.rallySave(fileId, S);
  if (r.ok) setStatus('保存しました ' + new Date().toLocaleTimeString());
  else setStatus('保存できませんでした: ' + (r.error || ''), true);
  return r.ok;
}
async function flushSave() { if (saveTimer) await save(); }
window.addEventListener('beforeunload', () => { if (saveTimer) API.rallySave(fileId, S); });

// ---- 試合とポイント ----
function openMatch(i, idx) {
  mi = i;
  updateReportLink();
  $('matchTabs').innerHTML = S.matches.map((m, k) =>
    `<button data-m="${k}" aria-pressed="${k === mi}">第${m.no}試合</button>`).join('');
  $('playedAt').value = M().playedAt || '';
  openPoint(idx ?? M().points[0].idx);
}
$('matchTabs').onclick = e => { const b = e.target.closest('[data-m]'); if (b) openMatch(+b.dataset.m); };
$('playedAt').onchange = () => {
  const s = $('playedAt').value.trim();
  if (s && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) { setStatus('日時は 2026-09-08 23:07:00 の形で入れてください', true); $('playedAt').value = M().playedAt; return; }
  M().playedAt = s && s.length === 16 ? s + ':00' : s; changed();
};

function openPoint(idx) {
  P = M().points.find(p => p.idx === idx) || M().points[0];
  undo = [];
  sel = P.shots.length ? 0 : -1;
  render();
  seek(P.shots.length ? P.shots[0].t : P.t0);
}
const ptNo = p => M().points.indexOf(p) + 1;
function renderSide() {
  const c = RS.counts(S);
  $('doneCount').textContent = `確認済み ${c.done} / ${c.pts} ポイント`;
  $('side').innerHTML = M().points.map((p, k) => {
    const nf = RS.flags(p.shots).filter(Boolean).length;
    const badge = p.done ? '<span class="badge done">確認済み</span>' : nf ? `<span class="badge warn">要確認 ${nf}</span>` : '<span class="badge">未確認</span>';
    const win = p.winner === 'me' ? '取った' : p.winner === 'opp' ? '取られた' : '';
    return `<button class="pt${p === P ? ' cur' : ''}" data-idx="${p.idx}"><span class="no num">P${k + 1}</span>` +
      `<span class="body"><span class="score num">${esc(p.before)} → ${esc(p.after)}</span><span class="sub">${p.shots.length}打・${win}</span></span>${badge}</button>`;
  }).join('');
}
$('side').onclick = async e => { const b = e.target.closest('.pt'); if (b) { await flushSave(); openPoint(+b.dataset.idx); } };

// ---- 描画 ----
function render() {
  P.shots.sort((a, b) => a.t - b.t);
  renderSide();
  const fl = RS.flags(P.shots);
  $('ptTitle').textContent = `P${ptNo(P)}　${P.before} → ${P.after}`;
  $('ptWin').textContent = P.winner === 'me' ? '自分が取ったポイント' : P.winner === 'opp' ? '相手が取ったポイント' : '';
  $('ptWin').style.color = P.winner === 'me' ? 'var(--accent)' : '';
  $('ptInfo').textContent = `${P.shots.length}打・${(P.t1 - P.t0).toFixed(1)}秒` + (P.missing ? '・[警告] このポイントは解析結果がありません' : '');
  $('axL').textContent = fmtT(P.t0); $('axR').textContent = fmtT(P.t1);
  drawTracks(fl);
  renderEdit(fl);
  renderTable(fl);
  $('bDone').textContent = ''; $('bDone').append(P.done ? '確認済み（次へ）' : '確認済みにして次へ');
  $('bDone').insertAdjacentHTML('beforeend', '<kbd>Enter</kbd>');
}
const xp = t => ((t - P.t0) / (P.t1 - P.t0) * 100).toFixed(3) + '%';
function drawTracks(fl) {
  for (const trk of document.querySelectorAll('.trk')) {
    const side = trk.dataset.side;
    let h = '';
    for (const d of P.det) if (d.side === side) h += `<span class="ghost" style="left:${xp(d.t)};background:${COL[d.cls] || '#888'}"></span>`;
    P.shots.forEach((s, i) => {
      if (s.side !== side) return;
      const cls = ['mk', i === sel ? 'sel' : '', fl[i] ? 'flag' : s.e ? 'edit' : '', s.serve ? 'serve' : ''].join(' ');
      h += `<button class="${cls}" data-i="${i}" style="left:${xp(s.t)}" title="${i + 1}打目 ${NAME[s.cls] || s.cls}${fl[i] ? '（' + fl[i] + '）' : ''}"><span class="dot" style="background:${COL[s.cls] || '#888'}"></span></button>`;
    });
    h += '<span class="ph"></span>';
    trk.innerHTML = h;
  }
  const types = RS.CLS;
  $('legend').innerHTML = types.map(c => `<span><span class="dot" style="background:${c[2]}"></span>${c[1]}</span>`).join('') +
    '<span><span class="dot" style="box-shadow:0 0 0 2px var(--warn)"></span>要確認</span>' +
    '<span><span class="dot" style="box-shadow:0 0 0 2px var(--edited)"></span>直した打</span>';
  movePh();
}
function renderEdit(fl) {
  const s = P.shots[sel];
  if (!s) {
    $('edit').innerHTML = `<h2>打がありません</h2><div class="row"><button id="eAdd">今の時刻に打を足す<kbd>A</kbd></button></div>`;
    $('eAdd').onclick = addShot; return;
  }
  const types = RS.CLS;
  $('edit').innerHTML =
    `<div class="row" style="align-items:baseline; gap:6px 14px"><h2>選んだ打　${sel + 1}打目</h2>` +
    `<span class="sub num">${fmtT(s.t)}（ポイント開始から ${(s.t - P.t0).toFixed(2)}秒）</span>` +
    (fl[sel] ? `<span class="warnTxt">[警告] ${fl[sel]}</span>` : '') + (s.e ? '<span class="sub" style="color:var(--edited)">直した打</span>' : '') + '</div>' +
    `<div class="row"><span class="k">打った側</span>` +
    `<button data-side="me" aria-pressed="${s.side === 'me'}">自分</button><button data-side="opp" aria-pressed="${s.side === 'opp'}">相手</button>` +
    `<span class="sub">入れ替え<kbd>S</kbd></span>` +
    `<button data-serve aria-pressed="${!!s.serve}" style="margin-left:12px">サーブ<kbd>V</kbd></button></div>` +
    `<div class="row"><span class="k">球種</span>` +
    types.map((c, i) => `<button data-cls="${c[0]}" aria-pressed="${s.cls === c[0]}" style="display:inline-flex; align-items:center; gap:6px"><span class="dot" style="background:${c[2]}"></span>${c[1]}<kbd>${(i + 1) % 10}</kbd></button>`).join('') + '</div>' +
    `<div class="row" style="border-top:1px solid var(--border); padding-top:10px">` +
    `<button id="ePrev">前の打<kbd>[</kbd></button><button id="eNext">次の打<kbd>]</kbd></button><button id="eFlag">次の要確認<kbd>N</kbd></button>` +
    `<button id="eAdd">今の時刻に打を足す<kbd>A</kbd></button><button id="eMove">この打を今の時刻へ<kbd>T</kbd></button>` +
    `<button id="eUndo"${undo.length ? '' : ' disabled'}>取り消し<kbd>Ctrl+Z</kbd></button>` +
    `<button id="eDel" class="danger" style="margin-left:auto">この打を消す<kbd>Del</kbd></button></div>`;
  $('edit').querySelectorAll('[data-side]').forEach(b => b.onclick = () => edit(s => { s.side = b.dataset.side; }));
  $('edit').querySelector('[data-serve]').onclick = () => edit(s => { s.serve = !s.serve; });
  $('edit').querySelectorAll('[data-cls]').forEach(b => b.onclick = () => edit(s => { s.cls = b.dataset.cls; }));
  $('ePrev').onclick = () => jumpShot(-1); $('eNext').onclick = () => jumpShot(1); $('eFlag').onclick = nextFlag;
  $('eAdd').onclick = addShot; $('eMove').onclick = () => edit(s => { s.t = snap(v.currentTime); });
  $('eUndo').onclick = doUndo; $('eDel').onclick = delShot;
}
function renderTable(fl) {
  $('tb').innerHTML = P.shots.map((s, i) => {
    const d = RS.nearestDet(P.det, s);
    const diff = d ? s.t - d.t : null;
    const dtxt = diff == null ? '（足した打）' : (Math.abs(diff) < 1e-3 && d.cls === s.cls) ? '' :
      (Math.abs(diff) >= 1e-3 ? (diff > 0 ? '+' : '') + diff.toFixed(2) + '秒 ' : '') + (d.cls !== s.cls ? NAME[d.cls] + '→' + NAME[s.cls] : '');
    return `<tr data-i="${i}" class="${i === sel ? 'sel' : ''}"><td class="num">${i + 1}</td><td class="num">${(s.t - P.t0).toFixed(2)}秒</td>` +
      `<td>${s.side === 'me' ? '自分' : '相手'}${s.serve ? '（サーブ）' : ''}</td>` +
      `<td><span style="display:inline-flex; align-items:center; gap:6px"><span class="dot" style="background:${COL[s.cls] || '#888'}"></span>${NAME[s.cls] || s.cls}</span></td>` +
      `<td class="sub num">${dtxt}</td><td style="color:${fl[i] ? '#ff8a7d' : 'var(--sub)'}">${fl[i] || (s.e ? '直した' : '')}</td></tr>`;
  }).join('');
  const tr = $('tb').querySelector('tr.sel');
  // 一覧の枠の中だけ動かす（scrollIntoView はページごと動いてしまう）
  const w = $('tblWrap');
  if (tr && (tr.offsetTop < w.scrollTop + 30 || tr.offsetTop + tr.offsetHeight > w.scrollTop + w.clientHeight)) w.scrollTop = tr.offsetTop - w.clientHeight / 2;
}
$('tb').onclick = e => { const tr = e.target.closest('tr'); if (tr) pick(+tr.dataset.i); };
for (const trk of document.querySelectorAll('.trk')) {
  trk.addEventListener('mousedown', e => {
    const mk = e.target.closest('.mk');
    if (mk) { pick(+mk.dataset.i); return; }
    const r = trk.getBoundingClientRect();
    v.pause(); seek(P.t0 + (e.clientX - r.left) / r.width * (P.t1 - P.t0));
  });
}

// ---- 映像 ----
function seek(t) { if (!P || !v.src) return; v.currentTime = Math.max(P.t0, Math.min(P.t1, t)); movePh(); }
function movePh() {
  if (!P) return;
  const t = v.currentTime || P.t0;
  for (const ph of document.querySelectorAll('.ph')) ph.style.left = xp(Math.max(P.t0, Math.min(P.t1, t)));
  $('progBar').style.width = xp(Math.max(P.t0, Math.min(P.t1, t)));
  $('hud').textContent = `${fmtT(t)}　+${(t - P.t0).toFixed(2)}秒`;
}
v.addEventListener('timeupdate', movePh);
v.addEventListener('seeked', movePh);
(function loop() { if (P && !v.paused) { movePh(); if (v.currentTime >= P.t1) v.pause(); } requestAnimationFrame(loop); })();
$('prog').onmousedown = e => { const r = $('prog').getBoundingClientRect(); seek(P.t0 + (e.clientX - r.left) / r.width * (P.t1 - P.t0)); };
$('bPlay').onclick = () => { if (v.paused) { if (v.currentTime >= P.t1 - 0.02) seek(P.t0); v.play(); } else v.pause(); };
$('bPre').onclick = () => { const s = P.shots[sel]; if (!s) return; seek(s.t - 0.5); v.play(); };
$('rate').onchange = () => { v.playbackRate = +$('rate').value; };
document.querySelectorAll('[data-step]').forEach(b => b.onclick = () => step(+b.dataset.step));
$('zoom').onchange = () => $('vwrap').classList.toggle('zoom', $('zoom').checked);
// 多数のシークのあと、デコードは生きているのに画面が黒くなることがある。ソースを張り直して同じ時刻へ戻す
$('bReload').onclick = () => {
  if (!v.src) return;
  const t = v.currentTime, src = v.src.split('#')[0];
  v.src = src + '#r' + Date.now();
  v.addEventListener('loadedmetadata', () => { v.currentTime = t; }, { once: true });
};
function step(n) { v.pause(); seek(snap(v.currentTime + n / fps())); }

// ---- 手直し ----
function pick(i) { sel = i; render(); seek(P.shots[i].t); }
function remember() { undo.push(JSON.stringify(P.shots)); if (undo.length > 100) undo.shift(); }
function after(keep) {
  P.shots.sort((a, b) => a.t - b.t);
  sel = keep ? P.shots.indexOf(keep) : Math.min(sel, P.shots.length - 1);
  P.done = false;
  render(); changed();
}
function edit(f) {
  const s = P.shots[sel]; if (!s) return;
  remember(); f(s); s.e = 1; after(s);
}
function addShot() {
  const t = snap(v.currentTime);
  const prev = [...P.shots].reverse().find(s => s.t < t);
  const s = { t, side: prev ? (prev.side === 'me' ? 'opp' : 'me') : 'me', cls: 'unknown', src: 'manual', e: 1 };
  if (!prev) s.serve = true;
  remember(); P.shots.push(s); after(s);
}
function delShot() { if (!P.shots[sel]) return; remember(); P.shots.splice(sel, 1); after(null); }
function doUndo() {
  if (!undo.length) return;
  P.shots = JSON.parse(undo.pop());
  sel = Math.min(Math.max(sel, 0), P.shots.length - 1);
  P.done = false; render(); changed();
}
function jumpShot(d) {
  if (!P.shots.length) return;
  const t = v.currentTime;
  const i = d > 0 ? P.shots.findIndex(s => s.t > t + 1e-3) : P.shots.map(s => s.t < t - 1e-3).lastIndexOf(true);
  if (i >= 0) pick(i);
}
// 次の要確認の打。今のポイントで選んだ打より後 → 以降の未確認ポイント（試合をまたぐ）→ 先頭から一周
async function nextFlag() {
  const order = [];
  S.matches.forEach((m, k) => m.points.forEach(p => order.push([k, p])));
  const here = order.findIndex(([, p]) => p === P);
  for (let n = 0; n <= order.length; n++) {
    const [k, p] = order[(here + n) % order.length];
    if (p.done && p !== P) continue;
    const fl = RS.flags(p.shots);
    const i = fl.findIndex((f, j) => f && (n > 0 || p !== P || j > sel));
    if (i < 0) continue;
    if (p !== P) { await flushSave(); if (k !== mi) openMatch(k, p.idx); else openPoint(p.idx); }
    pick(i); return;
  }
  setStatus('要確認の打は残っていません');
}
$('bReset').onclick = () => {
  if (!confirm(`P${ptNo(P)} の手直しを捨てて検出結果に戻しますか？`)) return;
  remember(); P.shots = P.det.map(s => ({ ...s })); sel = P.shots.length ? 0 : -1; P.done = false; render(); changed();
};
async function movePoint(d) {
  const pts = M().points, i = pts.indexOf(P) + d;
  await flushSave();
  if (i >= 0 && i < pts.length) openPoint(pts[i].idx);
  else if (mi + d >= 0 && mi + d < S.matches.length) { const m = S.matches[mi + d]; openMatch(mi + d, d > 0 ? m.points[0].idx : m.points[m.points.length - 1].idx); }
}
$('bPrevPt').onclick = () => movePoint(-1);
$('bNextPt').onclick = () => movePoint(1);
$('bDone').onclick = async () => {
  P.done = true; changed(); await flushSave();
  // 次の未確認ポイントへ（試合をまたぐ）
  const order = [];
  S.matches.forEach((m, k) => m.points.forEach(p => order.push([k, p])));
  const here = order.findIndex(([, p]) => p === P);
  const next = order.slice(here + 1).find(([, p]) => !p.done);
  if (next) { if (next[0] !== mi) openMatch(next[0], next[1].idx); else openPoint(next[1].idx); }
  else { render(); setStatus('全部のポイントが確認済みになりました'); }
};

// ---- CSV（SENSEKI FEVER 向け・1打1行）----
$('bCsv').onclick = async () => {
  await flushSave();
  const onlyDone = $('onlyDone').checked;
  const csv = RS.toCsv(S, { onlyDone });
  const n = csv.trim().split('\n').length - 1;
  if (!n) { setStatus(onlyDone ? '確認済みのポイントがまだありません' : '書き出す打がありません', true); return; }
  const r = await API.saveCsv(S.video.name.replace(/\.[^.]+$/, '') + '_rally.csv', csv);
  if (r.ok) setStatus(`${n} 打を書き出しました`);
};

// ---- キー操作 ----
document.addEventListener('keydown', e => {
  if (!P || e.target.matches?.('input[type=text], select')) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) { e.preventDefault(); doUndo(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (k === ' ') { e.preventDefault(); $('bPlay').click(); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); step((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 6 : 1)); }
  else if (k === '[' || k === ']') jumpShot(k === ']' ? 1 : -1);
  else if (k === 'n' || k === 'N') nextFlag();
  else if (k === 'q' || k === 'Q') $('bPre').click();
  else if (k === 'a' || k === 'A') addShot();
  else if (k === 't' || k === 'T') edit(s => { s.t = snap(v.currentTime); });
  else if (k === 's' || k === 'S') edit(s => { s.side = s.side === 'me' ? 'opp' : 'me'; });
  else if (k === 'v' || k === 'V') edit(s => { s.serve = !s.serve; });
  else if (k === 'z' || k === 'Z') { $('zoom').checked = !$('zoom').checked; $('zoom').onchange(); }
  else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); delShot(); }
  else if (k === 'r' || k === 'R') $('bReload').click();
  else if (k === 'Enter') { e.preventDefault(); $('bDone').click(); }
  else if (/^[0-9]$/.test(k)) {
    const c = RS.CLS[(+k + 9) % 10];
    if (c) edit(s => { s.cls = c[0]; });
  }
});
// ボタンを押したあとに Space/Enter がそのボタンを押し直さないよう、フォーカスを外す
document.addEventListener('click', e => { if (e.target.closest('button')) e.target.closest('button').blur(); });

// ---- 試合レポートへ（同じ保存ファイル・同じ試合）----
function updateReportLink() {
  const q = new URLSearchParams(location.search);
  const o = new URLSearchParams();
  if (fileId) o.set('id', fileId);
  o.set('m', mi);
  if (!window.api && q.get('store')) { o.set('store', q.get('store')); if (q.get('video')) o.set('video', q.get('video')); }
  $('toReport').href = 'rally-report.html?' + o;
}
$('toReport').onclick = async e => { e.preventDefault(); await flushSave(); location.href = $('toReport').href; };

// ---- 録画を解析（子プロセスで回り、終わったらその保存ファイルを開く）----
let anaId = null;
function anaShow(name, ratio, text, state) {
  $('anaPanel').style.display = 'block';
  $('anaPanel').classList.toggle('bad', state === 'bad');
  $('anaName').textContent = name;
  $('anaBar').style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
  $('anaPct').textContent = Math.round(ratio * 100) + '%';
  $('anaText').textContent = text;
  $('bAnaCancel').style.display = state ? 'none' : '';
  $('bAnaClose').style.display = state ? '' : 'none';
  $('bAnalyze').disabled = !state;
}
$('bAnalyze').onclick = async () => {
  const r = await API.rallyAnalyzePick();
  if (!r.ok) return;
  if (r.exists && r.done > 0 && !confirm(`[警告] 「${r.id}」の保存ファイルは ${r.done} ポイントを手直し済みです。解析し直すと手直しは消えます。続けますか？`)) return;
  await flushSave();
  const s = await API.rallyAnalyzeStart(r.video);
  if (!s.ok) { setStatus(s.error || '解析を始められませんでした', true); return; }
  anaId = s.id;
  anaShow(s.id, 0, '準備しています');
};
$('bAnaCancel').onclick = () => API.rallyAnalyzeCancel();
$('bAnaClose').onclick = () => { $('anaPanel').style.display = 'none'; };
if (API.onRallyProgress) API.onRallyProgress(m => {
  if (m.id !== anaId) return;
  if (m.type === 'progress') anaShow(m.id, m.ratio, m.text);
  else if (m.type === 'done') {
    anaShow(m.id, 1, `できました（${m.counts.pts} ポイント・${m.counts.shots} 打・要確認 ${m.counts.flagged} 打）`, 'ok');
    refreshList(m.id);
  } else if (m.type === 'canceled') anaShow(m.id, 0, '中止しました', 'bad');
  else if (m.type === 'error') { anaShow(m.id, 0, '[警告] 解析できませんでした: ' + m.error, 'bad'); if (m.detail) console.error(m.detail); }
});
if (API.rallyCanAnalyze) API.rallyCanAnalyze().then(ok => { if (ok) { $('bAnalyze').style.display = ''; $('emptyAna').style.display = ''; } });

{
  const q = new URLSearchParams(location.search);
  const num = k => q.get(k) != null && q.get(k) !== '' ? +q.get(k) : null;
  refreshList(q.get('id'), num('m'), num('p'));
}
