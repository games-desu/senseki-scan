// SENSEKI SCAN ハイライト生成 — UI
// index.html のメインスクリプトの後に読み込む（$ / V / TPL / SETTINGS / loadTemplates / userDataReady /
// SCENE_CACHE / gateRatings / LAST_FILE / processing を共有）。認識は highlight.js、切り抜きは main.js の ffmpeg。
(() => {
  const H = window.Highlight;
  const hv = $('hlVideo');
  const HL = { file: null, path: null, url: null, key: null, windows: [], points: [], busy: false, cancel: false, curJob: null, edit: null, lastOut: null };
  const fmtT = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + s.toFixed(1).padStart(4, '0'); };
  const fileKey = f => f.name + '|' + f.size + '|' + f.lastModified;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const safeName = s => String(s).replace(/\s+/g, '').replace(/[\\/:*?"<>|]/g, '');

  function hlProg(msg, ratio) {
    $('hlProg').textContent = msg;
    $('hlProgWrap').style.display = msg ? 'block' : 'none';
    if (ratio != null) $('hlBar').firstElementChild.style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%';
  }
  function hlLog(m) { const el = $('hlLog'); el.textContent += (el.textContent ? '\n' : '') + m; el.style.display = 'block'; el.scrollTop = 1e9; if (typeof log === 'function') log('[ハイライト] ' + m); }

  // 切り抜き区間（手修正があればそれを優先）
  function ranges(p) {
    const auto = H.clipRanges(p, { shortSec: Math.max(2, Math.min(20, +$('hlSec').value || 5)) });
    return { full: (p.edit && p.edit.full) || auto.full, short: (p.edit && p.edit.short) || auto.short };
  }
  function hlJpeg(width) {
    const s = V.srcRect(hv);
    const c = document.createElement('canvas');
    c.width = width; c.height = Math.round(width * s.h / s.w);
    c.getContext('2d').drawImage(hv, s.x, s.y, s.w, s.h, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  // ---- 読み込み → 試合窓 → ポイント検出 ----
  async function hlLoad(file) {
    if (HL.busy) return;
    if (typeof processing !== 'undefined' && processing) { hlProg('戦績CSVの解析が終わってからハイライトを作ってください', null); return; }
    HL.busy = true; HL.cancel = false;
    $('hlCancel').style.display = 'inline-block';
    try {
      HL.file = file; HL.key = fileKey(file);
      HL.path = window.api.pathForFile ? window.api.pathForFile(file) : null;
      if (HL.url) { try { URL.revokeObjectURL(HL.url); } catch {} }
      HL.url = URL.createObjectURL(file);
      hv.muted = true; hv.src = HL.url;
      await new Promise((res, rej) => {
        hv.addEventListener('loadedmetadata', res, { once: true });
        hv.addEventListener('error', () => rej(new Error('動画を読み込めませんでした')), { once: true });
      });
      $('hlBody').style.display = 'block';
      $('hlFileName').textContent = file.name;
      $('hlList').innerHTML = ''; $('hlSummary').textContent = ''; $('hlExportBox').style.display = 'none'; $('hlLog').textContent = ''; $('hlLog').style.display = 'none';
      HL.points = []; HL.windows = [];
      if (!TPL) await loadTemplates();
      await userDataReady;
      if (!HL.path) hlLog('[警告] 動画のファイルパスを取得できないため、書き出しはできません（区間の確認のみ）');

      let events = SCENE_CACHE.get(HL.key);
      if (!events) {
        events = await V.scan(hv, { albumTpl: TPL.albumBar || [], onProgress: (t, dur) => hlProg(`試合の位置を探しています… ${t.toFixed(0)}/${dur.toFixed(0)}秒`, t / dur * 0.3) });
        await gateRatings(hv, events, () => {});
        SCENE_CACHE.set(HL.key, events);
      } else hlLog('試合の位置は戦績CSVの解析結果を再利用しました');
      if (HL.cancel) return;
      const wins = H.matchWindows(events, hv.duration);
      HL.windows = wins;
      if (wins[0].fallback) hlLog('VS画面を検出できなかったため、動画全体から得点シーンを探します（時間がかかります。配信レイアウトの録画は「ゲーム画面の位置」を先に指定してください）');
      const totalSpan = wins.reduce((a, w) => a + Math.max(0, w.t1 - w.t0), 0) || 1;
      let done = 0;
      for (let wi = 0; wi < wins.length; wi++) {
        const w = wins[wi];
        const { points } = await H.scanWindow(hv, w, { step: 0.5, onProgress: t =>
          hlProg(`得点シーンを探しています… 試合 ${wi + 1}/${wins.length}（${fmtT(t)}）`, 0.3 + 0.6 * (done + (t - w.t0)) / totalSpan) });
        done += Math.max(0, w.t1 - w.t0);
        for (const p of points) { p.win = wi; HL.points.push(p); }
        if (HL.cancel) break;
      }
      // 試合番号（窓 × 得点リセットで分かれたゲーム）と、試合内の通し番号・サムネ
      let mno = 0, lastKey = null, k = 0;
      for (const p of HL.points) {
        const key = p.win + ':' + p.game;
        if (key !== lastKey) { mno++; lastKey = key; k = 0; }
        p.match = mno; p.k = ++k; p.idx = HL.points.indexOf(p); p.edit = null;
      }
      const seek = V.makeSeeker(hv);
      for (let i = 0; i < HL.points.length; i++) {
        const p = HL.points[i];
        hlProg(`サムネイルを作成中… ${i + 1}/${HL.points.length}`, 0.9 + 0.1 * (i + 1) / HL.points.length);
        await seek(Math.max(p.hudOn, p.hudOff - 0.7));
        p.thumb = hlJpeg(320);
      }
      applyIncludeFilter();
      hlRender();
      hlProg('', null);
      const me = HL.points.filter(p => p.winner === 'me').length;
      hlLog(`${mno}試合・${HL.points.length}ポイントを検出（自分の得点 ${me}・相手の得点 ${HL.points.length - me}）`);
      if (!HL.points.length) hlLog('[警告] 得点シーンが見つかりませんでした。ゲーム画面が画面いっぱいに映っているか（配信レイアウトなら「ゲーム画面の位置」）を確認してください');
      $('hlExportBox').style.display = HL.points.length ? 'block' : 'none';
    } catch (e) {
      hlProg('', null);
      hlLog('ERROR: ' + (e && e.stack || e));
    } finally {
      HL.busy = false; $('hlCancel').style.display = 'none';
    }
  }

  function applyIncludeFilter() {
    const onlyMe = $('hlOnlyMe').checked;
    for (const p of HL.points) p.include = onlyMe ? p.winner === 'me' : true;
  }

  // ---- 一覧 ----
  function hlRender() {
    const groups = new Map();
    for (const p of HL.points) { if (!groups.has(p.match)) groups.set(p.match, []); groups.get(p.match).push(p); }
    const sel = HL.points.filter(p => p.include).length;
    $('hlSummary').textContent = HL.points.length ? `${groups.size}試合・${HL.points.length}ポイント（選択中 ${sel}）` : '';
    $('hlList').innerHTML = [...groups].map(([m, arr]) => `
      <div class="hlm">
        <div class="hlmh"><b>試合 ${m}</b><span class="sub">${fmtT(arr[0].hudOn)} 〜 ${fmtT(arr[arr.length - 1].hudOff)} ・ ${arr.length}ポイント</span>
          <button data-act="mall" data-m="${m}">この試合を全部選ぶ</button><button data-act="mnone" data-m="${m}">選択解除</button></div>
        <div class="hlrows">${arr.map(row).join('')}</div>
      </div>`).join('');
  }
  function row(p) {
    const r = ranges(p);
    const ed = w => (p.edit && p.edit[w]) ? ' <span class="hledited">手修正</span>' : '';
    return `<div class="hlp${p.include ? ' on' : ''}" data-i="${p.idx}">
      <label class="hlchk"><input type="checkbox" data-act="inc" ${p.include ? 'checked' : ''}></label>
      <img src="${p.thumb || ''}" data-act="edit" title="クリックで区間を調整">
      <div class="hlpinfo">
        <div><b>P${p.k}</b> <span class="${p.winner === 'me' ? 'hlme' : 'hlopp'}">${p.winner === 'me' ? '自分の得点' : '相手の得点'}</span>${p.final ? ' <span class="hlfin">マッチ決定</span>' : ''}
          <span class="sub">${esc(p.scoreBefore)} → ${esc(p.scoreAfter)}</span></div>
        <div class="sub">ラリー ${(p.hudOff - p.hudOn).toFixed(1)}秒（${fmtT(p.hudOn)} 〜 ${fmtT(p.hudOff)}）</div>
        <div class="sub">得点前: ${fmtT(r.short.s)} 〜 ${fmtT(r.short.e)}${ed('short')} ／ ラリー全体: ${fmtT(r.full.s)} 〜 ${fmtT(r.full.e)}${ed('full')}</div>
      </div>
      <button data-act="edit">区間を調整</button>
    </div>`;
  }
  $('hlList').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'mall' || act === 'mnone') {
      for (const p of HL.points) if (p.match === +b.dataset.m) p.include = act === 'mall';
      hlRender(); return;
    }
    const rowEl = e.target.closest('.hlp'); if (!rowEl) return;
    const p = HL.points[+rowEl.dataset.i];
    if (act === 'inc') { p.include = b.checked; rowEl.classList.toggle('on', p.include); const sel = HL.points.filter(q => q.include).length; $('hlSummary').textContent = $('hlSummary').textContent.replace(/選択中 \d+/, '選択中 ' + sel); return; }
    if (act === 'edit') hlOpenEditor(p, 'short');
  });
  $('hlOnlyMe').addEventListener('change', () => { applyIncludeFilter(); hlRender(); });
  $('hlSec').addEventListener('change', () => hlRender());

  // ---- 区間の調整（モーダル）----
  const tl = $('hlTl');
  const E = () => HL.edit;
  const xOf = t => ((t - E().T0) / (E().T1 - E().T0) * 100).toFixed(2) + '%';
  const tOfX = x => E().T0 + Math.max(0, Math.min(1, x / tl.clientWidth)) * (E().T1 - E().T0);

  function hlLayoutCrop() {
    const stage = $('hlStage');
    const W = stage.clientWidth || 860;
    const gr = V.getSourceRect() || { rx: 0, ry: 0, rw: 1, rh: 1 };
    const vw = hv.videoWidth || 1920, vh = hv.videoHeight || 1080;
    const dw = W / gr.rw, dh = dw * vh / vw;
    stage.style.height = Math.round(dh * gr.rh) + 'px';
    hv.style.width = Math.round(dw) + 'px'; hv.style.height = Math.round(dh) + 'px';
    hv.style.left = (-gr.rx * dw).toFixed(0) + 'px'; hv.style.top = (-gr.ry * dh).toFixed(0) + 'px';
  }
  function hlOpenEditor(p, which) {
    const r = ranges(p);
    HL.edit = {
      p, which,
      full: { ...r.full }, short: { ...r.short },
      T0: Math.max(0, p.hudOn - 3), T1: Math.min(Number.isFinite(hv.duration) ? hv.duration : Infinity, (p.gapEnd ?? p.hudOff + 3) + 0.5),
    };
    $('hlEdTitle').textContent = `試合 ${p.match} P${p.k}（${p.scoreBefore} → ${p.scoreAfter}・${p.winner === 'me' ? '自分の得点' : '相手の得点'}）`;
    $('hlmodal').style.display = 'flex';
    hv.muted = false; hv.volume = 0.6;
    $('hlWhichShort').checked = which === 'short'; $('hlWhichFull').checked = which === 'full';
    hlLayoutCrop();
    tlStatic();
    tlUpdate();
    hlSeek(E()[which].s);
  }
  function hlCloseEditor(save) {
    hv.pause(); hv.muted = true;
    if (save && E()) {
      const p = E().p, auto = H.clipRanges(p, { shortSec: Math.max(2, Math.min(20, +$('hlSec').value || 5)) });
      p.edit = p.edit || {};
      for (const w of ['short', 'full']) {
        const v = E()[w];
        const same = Math.abs(v.s - auto[w].s) < 0.02 && Math.abs(v.e - auto[w].e) < 0.02;
        if (same) delete p.edit[w]; else p.edit[w] = { s: +v.s.toFixed(3), e: +v.e.toFixed(3) };
      }
      if (!Object.keys(p.edit).length) p.edit = null;
      hlRender();
    }
    HL.edit = null;
    $('hlmodal').style.display = 'none';
  }
  function tlStatic() {
    const p = E().p;
    $('hlTlOn').style.left = xOf(p.hudOn); $('hlTlOn').style.width = ((p.hudOff - p.hudOn) / (E().T1 - E().T0) * 100).toFixed(2) + '%';
    const lim = H.nameLimit(p);
    $('hlTlDanger').style.left = xOf(lim); $('hlTlDanger').style.width = (Math.max(0, E().T1 - lim) / (E().T1 - E().T0) * 100).toFixed(2) + '%';
    $('hlTlT0').textContent = fmtT(E().T0); $('hlTlT1').textContent = fmtT(E().T1);
  }
  function cur() { return E()[E().which]; }
  function tlUpdate() {
    const c = cur();
    $('hlTlSel').style.left = xOf(c.s); $('hlTlSel').style.width = ((c.e - c.s) / (E().T1 - E().T0) * 100).toFixed(2) + '%';
    $('hlHS').style.left = xOf(c.s); $('hlHE').style.left = xOf(c.e);
    $('hlS').value = c.s.toFixed(2); $('hlE').value = c.e.toFixed(2);
    $('hlLen').textContent = (c.e - c.s).toFixed(1) + '秒';
    const late = c.e > H.nameLimit(E().p);
    $('hlEdWarn').style.display = late ? 'block' : 'none';
    $('hlEdWarn').textContent = late ? '[警告] 終了が赤い区間に入っています。' + (E().p.final ? '勝敗画面' : 'ポイント間のスコアバナー') + 'にプレイヤー名が映ります。「名前が映る区間を自動で除外」がONなら書き出し時に手前へ詰めます' : '';
  }
  function setRange(s, e) {
    const c = cur();
    s = Math.max(E().T0, Math.min(E().T1, s)); e = Math.max(E().T0, Math.min(E().T1, e));
    if (e - s < 0.3) { if (c.s !== s) e = s + 0.3; else s = e - 0.3; }
    c.s = +s.toFixed(3); c.e = +e.toFixed(3);
    tlUpdate();
  }
  function hlSeek(t) {
    hv.pause();
    hv.currentTime = Math.max(0, Math.min(hv.duration - 0.05, t));
  }
  function updatePlayhead() {
    if (!E()) return;
    $('hlPlayhead').style.left = xOf(hv.currentTime);
    $('hlCur').textContent = fmtT(hv.currentTime);
    if (HL.rangePlay && hv.currentTime >= cur().e - 0.02) { hv.pause(); HL.rangePlay = false; }
    if (!hv.paused) requestAnimationFrame(updatePlayhead);
  }
  hv.addEventListener('timeupdate', updatePlayhead);
  hv.addEventListener('seeked', updatePlayhead);
  hv.addEventListener('play', () => requestAnimationFrame(updatePlayhead));

  // タイムライン操作: ハンドルのドラッグ / バーのクリックでシーク
  let drag = null;
  tl.addEventListener('pointerdown', e => {
    const h = e.target.closest('.hlh');
    const rect = tl.getBoundingClientRect();
    if (h) { drag = h.id === 'hlHS' ? 's' : 'e'; tl.setPointerCapture(e.pointerId); }
    else hlSeek(tOfX(e.clientX - rect.left));
    e.preventDefault();
  });
  tl.addEventListener('pointermove', e => {
    if (!drag) return;
    const rect = tl.getBoundingClientRect();
    const t = tOfX(e.clientX - rect.left);
    if (drag === 's') setRange(t, cur().e); else setRange(cur().s, t);
    hlSeek(t);
  });
  const endDrag = () => { drag = null; };
  tl.addEventListener('pointerup', endDrag); tl.addEventListener('pointercancel', endDrag);

  $('hlWhichShort').addEventListener('change', () => { E().which = 'short'; tlUpdate(); hlSeek(cur().s); });
  $('hlWhichFull').addEventListener('change', () => { E().which = 'full'; tlUpdate(); hlSeek(cur().s); });
  $('hlS').addEventListener('change', () => setRange(+$('hlS').value, cur().e));
  $('hlE').addEventListener('change', () => setRange(cur().s, +$('hlE').value));
  for (const [id, d] of [['hlM1', -1], ['hlM01', -0.1], ['hlP01', 0.1], ['hlP1', 1]]) {
    $(id).addEventListener('click', () => hlSeek(hv.currentTime + d));
  }
  $('hlPlayRange').addEventListener('click', () => {
    if (!hv.paused) { hv.pause(); HL.rangePlay = false; return; }
    HL.rangePlay = true; hv.currentTime = cur().s; hv.play();
  });
  $('hlSetS').addEventListener('click', () => setRange(hv.currentTime, cur().e));
  $('hlSetE').addEventListener('click', () => setRange(cur().s, hv.currentTime));
  $('hlAuto').addEventListener('click', () => {
    const auto = H.clipRanges(E().p, { shortSec: Math.max(2, Math.min(20, +$('hlSec').value || 5)) });
    E().short = { ...auto.short }; E().full = { ...auto.full }; tlUpdate(); hlSeek(cur().s);
  });
  $('hlEdOk').addEventListener('click', () => hlCloseEditor(true));
  $('hlEdCancel').addEventListener('click', () => hlCloseEditor(false));
  document.addEventListener('keydown', e => {
    if (!E() || $('hlmodal').style.display === 'none') return;
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') hlCloseEditor(false);
    else if (e.key === ' ') { e.preventDefault(); $('hlPlayRange').click(); }
    else if (e.key === 'ArrowLeft') hlSeek(hv.currentTime - (e.shiftKey ? 1 : 0.1));
    else if (e.key === 'ArrowRight') hlSeek(hv.currentTime + (e.shiftKey ? 1 : 0.1));
  });
  window.addEventListener('resize', () => { if (E()) hlLayoutCrop(); });

  // ---- 書き出し ----
  function cropParam() {
    if (!V.getSourceRect()) return null;
    const s = V.srcRect(hv);
    return { x: s.x & ~1, y: s.y & ~1, w: Math.max(2, s.w & ~1), h: Math.max(2, s.h & ~1) };
  }
  async function ensureOutDir() {
    if (HL.outDir) return HL.outDir;
    const d = await window.api.hlPickDir(SETTINGS.hlOutDir || null);
    if (!d) return null;
    HL.outDir = d; SETTINGS.hlOutDir = d; window.api.saveUserData('settings', SETTINGS);
    $('hlOutDir').textContent = d;
    return d;
  }
  $('hlOutPick').addEventListener('click', async () => {
    const d = await window.api.hlPickDir(HL.outDir || SETTINGS.hlOutDir || null);
    if (d) { HL.outDir = d; SETTINGS.hlOutDir = d; window.api.saveUserData('settings', SETTINGS); $('hlOutDir').textContent = d; }
  });
  $('hlOpenDir').addEventListener('click', () => { if (HL.outDir) window.api.hlOpenPath(HL.outDir); });
  $('hlCancel').addEventListener('click', () => { HL.cancel = true; if (HL.curJob) window.api.hlCancel(HL.curJob); hlProg('中止しています…', null); });
  if (window.api.onHlProgress) {
    window.api.onHlProgress(info => {
      if (!HL.busy || info.jobId !== HL.curJob || !HL.jobTotal) return;
      const r = Math.min(1, info.t / (info.duration || 1));
      hlProg(`書き出し中… ${HL.jobDone + 1}/${HL.jobTotal}（${(r * 100).toFixed(0)}%）`, (HL.jobDone + r) / HL.jobTotal);
    });
  }

  async function hlExport(kind) {  // 'short' | 'full' | 'digest'
    if (HL.busy) return;
    if (!HL.path) { hlLog('[警告] 動画のファイルパスが取得できないため書き出せません'); return; }
    const ok = await window.api.hlFfmpegAvailable();
    if (!ok) { hlLog('[警告] 同梱の ffmpeg が見つかりません。アプリを再インストールしてください'); return; }
    const sel = HL.points.filter(p => p.include);
    if (!sel.length) { hlLog('ポイントが1つも選ばれていません'); return; }
    if (!(await ensureOutDir())) return;
    HL.busy = true; HL.cancel = false; HL.jobDone = 0; HL.jobTotal = 0;
    $('hlCancel').style.display = 'inline-block';
    const guard = $('hlGuard').checked, maxH = $('hlScale').checked ? 1080 : null;
    const crop = cropParam();
    const base = HL.file.name.replace(/\.[^.]+$/, '');
    const which = kind === 'full' ? 'full' : 'short';
    const tmp = kind === 'digest' ? await window.api.hlTempDir() : null;
    const outputs = [];
    try {
      // 1) 区間確定（名前が映るフレームの除外）
      const jobs = [];
      for (let i = 0; i < sel.length; i++) {
        const p = sel[i];
        let { s, e } = ranges(p)[which];
        hlProg(`区間を確認中… ${i + 1}/${sel.length}`, null);
        if (guard) {
          const g = await H.guardRange(hv, s, e);
          if (g.changed) { hlLog(`試合${p.match} P${p.k}: 名前が映るフレームを避けて ${fmtT(s)}〜${fmtT(e)} → ${fmtT(g.s)}〜${fmtT(g.e)} に詰めました`); s = g.s; e = g.e; }
        }
        if (e - s < 0.5) { hlLog(`試合${p.match} P${p.k}: 区間が短すぎるため飛ばしました`); continue; }
        const name = `${base}_試合${p.match}_P${String(p.k).padStart(2, '0')}_${safeName(p.scoreAfter)}_${p.winner === 'me' ? '自分' : '相手'}${which === 'full' ? '_ラリー全体' : ''}.mp4`;
        jobs.push({ p, s, e, out: (tmp || HL.outDir) + '\\' + name });
        if (HL.cancel) break;
      }
      // 2) 切り抜き（再エンコード・フレーム単位で正確）
      HL.jobTotal = jobs.length + (kind === 'digest' ? 1 : 0);
      for (const j of jobs) {
        if (HL.cancel) break;
        HL.curJob = 'hl' + Date.now() + Math.random().toString(36).slice(2, 6);
        hlProg(`書き出し中… ${HL.jobDone + 1}/${HL.jobTotal}`, HL.jobDone / HL.jobTotal);
        const r = await window.api.hlCut({ jobId: HL.curJob, input: HL.path, start: j.s, duration: +(j.e - j.s).toFixed(3), out: j.out, crop, maxH });
        HL.jobDone++;
        if (r.ok) { j.ok = true; if (!tmp) outputs.push(j.out); }
        else hlLog(`[警告] 書き出しに失敗: ${j.out}\n  ${r.error}`);
      }
      // 3) ダイジェスト: 試合ごとに連結（再エンコードなし）
      if (kind === 'digest' && !HL.cancel) {
        const byMatch = new Map();
        for (const j of jobs) if (j.ok) { if (!byMatch.has(j.p.match)) byMatch.set(j.p.match, []); byMatch.get(j.p.match).push(j.out); }
        for (const [m, files] of byMatch) {
          if (HL.cancel) break;
          HL.curJob = 'hl' + Date.now();
          hlProg(`ダイジェストを連結中… 試合 ${m}`, (HL.jobTotal - 1) / HL.jobTotal);
          const out = `${HL.outDir}\\${base}_試合${m}_ダイジェスト.mp4`;
          const r = await window.api.hlConcat({ jobId: HL.curJob, files, out });
          if (r.ok) outputs.push(out); else hlLog(`[警告] 連結に失敗: ${out}\n  ${r.error}`);
        }
        await window.api.hlRemove(jobs.filter(j => j.ok).map(j => j.out));
      }
      hlProg('', null);
      if (HL.cancel) hlLog('書き出しを中止しました');
      hlLog(outputs.length ? `保存しました（${outputs.length}本）:\n  ` + outputs.join('\n  ') : '保存されたファイルはありません');
      if (outputs.length) $('hlOpenDir').style.display = 'inline-block';
    } catch (e) {
      hlProg('', null);
      hlLog('ERROR: ' + (e && e.stack || e));
    } finally {
      HL.busy = false; HL.curJob = null; $('hlCancel').style.display = 'none';
    }
  }
  $('hlExportShort').addEventListener('click', () => hlExport('short'));
  $('hlExportFull').addEventListener('click', () => hlExport('full'));
  $('hlExportDigest').addEventListener('click', () => hlExport('digest'));

  // ---- ファイル選択（ボタン / ドロップ / 直近の解析ファイル）----
  $('hlPick').addEventListener('click', () => $('hlFile').click());
  $('hlFile').addEventListener('change', e => { if (e.target.files[0]) hlLoad(e.target.files[0]); e.target.value = ''; });
  $('hlUseLast').addEventListener('click', () => { if (LAST_FILE) hlLoad(LAST_FILE); });
  const panel = $('hlPanel');
  panel.addEventListener('dragover', e => { e.preventDefault(); panel.classList.add('over'); });
  panel.addEventListener('dragleave', () => panel.classList.remove('over'));
  panel.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); panel.classList.remove('over');
    const f = [...e.dataTransfer.files].find(x => /\.(mp4|mov|mkv|webm)$/i.test(x.name));
    if (f) hlLoad(f);
  });
  // 戦績CSV側で読み込んだファイルをそのまま使えるように
  setInterval(() => { $('hlUseLast').style.display = (LAST_FILE && !HL.busy) ? 'inline-block' : 'none'; if (LAST_FILE) $('hlUseLast').textContent = '直近の録画で作る（' + LAST_FILE.name + '）'; }, 1000);
  userDataReady.then(() => { if (SETTINGS.hlOutDir) { HL.outDir = SETTINGS.hlOutDir; $('hlOutDir').textContent = SETTINGS.hlOutDir; } });

  window.HL = HL;
  HL._render = hlRender; HL._open = hlOpenEditor; // 表示確認用（ヘッドレスChromeでのスクショ）
})();
