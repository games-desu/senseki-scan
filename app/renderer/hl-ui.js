// SENSEKI SCAN ハイライト生成 — UI
// index.html のメインスクリプトの後に読み込む（$ / V / TPL / SETTINGS / loadTemplates / userDataReady /
// SCENE_CACHE / gateRatings / LAST_FILE / processing を共有）。認識は highlight.js、切り抜きは main.js の ffmpeg。
//
// 流れ: 1. 切り抜く区間の種類（得点前N秒 / ラリー全体 / 試合ごと）→ 2. 録画 → 解析 →
//       3. 保存する区間にチェック（既定＝自分の得点）→ 4. 保存形式（区間ごとに1本ずつ / 1本に繋げる）
(() => {
  const H = window.Highlight;
  const hv = $('hlVideo');
  const HL = { file: null, path: null, url: null, key: null, windows: [], points: [], busy: false, cancel: false, curJob: null, edit: null };
  const fmtT = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + s.toFixed(1).padStart(4, '0'); };
  const fileKey = f => f.name + '|' + f.size + '|' + f.lastModified;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const safeName = s => String(s).replace(/\s+/g, '').replace(/[\\/:*?"<>|]/g, '');

  // 区間の種類: 'short'（得点前N秒）/ 'full'（ラリー全体）/ 'match'（試合ごと＝全ラリーをつなぐ）
  const hlType = () => (document.querySelector('input[name=hlType]:checked') || {}).value || 'short';
  const rangeKey = () => hlType() === 'short' ? 'short' : 'full';
  const shortSec = () => Math.max(2, Math.min(20, +$('hlSec').value || 5));

  // 進捗は一覧の上と保存ボタンの横の2か所に出す（ポイントが多いと一覧が長く、上の進捗が見えない）
  function hlProg(msg, ratio) {
    $('hlProg').textContent = msg;
    $('hlProgWrap').style.display = msg ? 'block' : 'none';
    $('hlProg2').textContent = msg;
    $('hlProg2').style.display = msg ? 'inline' : 'none';
    if (ratio != null) $('hlBar').firstElementChild.style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(1) + '%';
  }
  function setBusy(b) {
    for (const id of ['hlExportEach', 'hlExportJoined', 'hlPick', 'hlUseLast']) $(id).disabled = b;
  }
  function hlLog(m) { const el = $('hlLog'); el.textContent += (el.textContent ? '\n' : '') + m; el.style.display = 'block'; el.scrollTop = 1e9; if (typeof log === 'function') log('[ハイライト] ' + m); }

  // 切り抜き区間（手修正があればそれを優先）
  function ranges(p) {
    const auto = H.clipRanges(p, { shortSec: shortSec() });
    return { full: (p.edit && p.edit.full) || auto.full, short: (p.edit && p.edit.short) || auto.short };
  }
  function hlJpeg(width) {
    const s = V.srcRect(hv);
    const c = document.createElement('canvas');
    c.width = width; c.height = Math.round(width * s.h / s.w);
    c.getContext('2d').drawImage(hv, s.x, s.y, s.w, s.h, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  // ---- 自分のキャラ（試合窓の VS 画面から・戦績CSV解析と同じ照合）----
  function hlCropCanvas(r, outW) {
    const s = V.srcRect(hv), kx = s.w / 1920, ky = s.h / 1080;
    const c = document.createElement('canvas');
    c.width = outW; c.height = Math.round(outW * r.h / r.w);
    c.getContext('2d').drawImage(hv, s.x + r.x * kx, s.y + r.y * ky, r.w * kx, r.h * ky, 0, 0, c.width, c.height);
    return c;
  }
  async function detectMyChar(w) {
    w.my = { name: '', conf: 0, icon: null, isDoubles: false, row: 1, partner: null };
    if (!w.vs) return;
    const R = V.REGIONS, seek = V.makeSeeker(hv);
    await seek((w.vs.t0 + w.vs.t1) / 2);
    const l1img = V.cropRegion(hv, R.dIconL1), r1img = V.cropRegion(hv, R.dIconR1), midimg = V.cropRegion(hv, { x: 300, y: 852, w: 320, h: 30 });
    const blueL = V.frac(l1img, 0, 0, R.dIconL1.w, 30, (r, g, b) => b > r + 40 && b > 120);
    const orgR = V.frac(r1img, 0, 0, R.dIconR1.w, 30, (r, g, b) => r > 160 && b < 100 && g > 40 && g < 170);
    const darkM = V.frac(midimg, 0, 0, 320, 30, (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < 60);
    w.my.isDoubles = blueL > 0.2 && orgR > 0.15 && darkM > 0.5;
    const canon = n => (window.Characters ? Characters.canon(n) : n);
    if (!w.my.isDoubles) {
      const mc = V.matchIcon(V.iconVec(V.cropRegion(hv, R.myicon), 16, 16), TPL.vsIcons || []);
      w.my.name = mc.score >= 0.8 ? canon(mc.name) : ''; w.my.conf = mc.score;
      w.my.icon = hlCropCanvas(R.myicon, 96).toDataURL('image/png');
    } else {
      const ic = k => V.matchIcon(V.iconVec(V.cropRegion(hv, R[k]), 16, 12), TPL.dblIcons || []);
      const l1 = ic('dIconL1'), l2 = ic('dIconL2');
      // 自分の行: シングルスのVS画面から自動学習した自分の名前シグネチャ（index.html の myRowFromSigs）
      const mr = (typeof myRowFromSigs === 'function') ? myRowFromSigs(V.nameSig(V.cropRegion(hv, R.dNameL1)), V.nameSig(V.cropRegion(hv, R.dNameL2))) : null;
      w.my.row = mr ? mr.row : 0;   // 0 = 判定できず（両方を出す）
      const pick = w.my.row === 2 ? l2 : l1;
      w.my.name = pick.score >= 0.8 ? canon(pick.name) : ''; w.my.conf = pick.score;
      w.my.icon = hlCropCanvas(w.my.row === 2 ? R.dIconL2 : R.dIconL1, 96).toDataURL('image/png');
      if (!w.my.row) w.my.partner = { name: l2.score >= 0.8 ? canon(l2.name) : '', icon: hlCropCanvas(R.dIconL2, 96).toDataURL('image/png') };
    }
  }
  const loadImg = src => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  // バッジ（透過PNG）: [アイコン] 自分：キャラ名。outH（出力の高さ）に合わせた大きさで描く
  async function makeBadge(my, outH) {
    if (!my || (!my.name && !my.icon)) return null;
    const k = outH / 1080, h = Math.round(74 * k), pad = Math.round(18 * k), iconH = Math.round(54 * k);
    const c = document.createElement('canvas'); let ctx = c.getContext('2d');
    const font = `bold ${Math.round(32 * k)}px "Yu Gothic UI","Meiryo","Segoe UI",sans-serif`;
    ctx.font = font;
    const both = my.row === 0 && my.partner;
    const parts = both ? [my, my.partner] : [my];
    const label = both ? '自分たち：' + parts.map(p => p.name || '？').join('／') : '自分：' + (my.name || '？');
    const icons = []; for (const p of parts) if (p.icon) icons.push(await loadImg(p.icon));
    const iconWs = icons.map(im => im ? Math.round(iconH * im.width / im.height) : 0);
    const tw = ctx.measureText(label).width;
    c.width = Math.round(pad * 2 + iconWs.reduce((a, b) => a + b + (b ? pad * 0.5 : 0), 0) + tw); c.height = h;
    ctx = c.getContext('2d'); ctx.font = font; ctx.textBaseline = 'middle';
    const rr = (x, y, w, hh, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
    rr(1, 1, c.width - 2, h - 2, Math.round(h / 2)); ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fill();
    ctx.lineWidth = Math.max(1, 2 * k); ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.stroke();
    let x = pad;
    icons.forEach((im, i) => { if (!im) return; const w = iconWs[i]; ctx.save(); rr(x, (h - iconH) / 2, w, iconH, Math.round(8 * k)); ctx.clip(); ctx.drawImage(im, x, (h - iconH) / 2, w, iconH); ctx.restore(); x += w + pad * 0.5; });
    ctx.lineWidth = Math.max(2, 5 * k); ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineJoin = 'round';
    ctx.strokeText(label, x, h / 2 + 1); ctx.fillStyle = '#fff'; ctx.fillText(label, x, h / 2 + 1);
    return c.toDataURL('image/png');
  }

  // ---- 読み込み → 試合窓 → ポイント検出 ----
  async function hlLoad(file) {
    if (HL.busy) return;
    if (typeof processing !== 'undefined' && processing) { hlProg('戦績CSVの解析が終わってからハイライトを作ってください', null); return; }
    HL.busy = true; HL.cancel = false; setBusy(true);
    $('hlCancel').style.display = 'inline-block';
    const t0 = performance.now();
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
      $('hlList').innerHTML = ''; $('hlSummary').textContent = ''; $('hlExportBox').style.display = 'none'; $('hlFilterRow').style.display = 'none';
      $('hlLog').textContent = ''; $('hlLog').style.display = 'none';
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
        const { points } = await H.scanWindow(hv, w, { onProgress: t =>
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
      hlProg('自分のキャラを確認中…', 0.99);
      for (const w of wins) { try { await detectMyChar(w); } catch (e) { w.my = { name: '', icon: null }; } }
      applyIncludeFilter();
      hlRender();
      hlProg('', null);
      const me = HL.points.filter(p => p.winner === 'me').length;
      hlLog(`${mno}試合・${HL.points.length}ポイントを検出（自分の得点 ${me}・相手の得点 ${HL.points.length - me}）… ${((performance.now() - t0) / 1000).toFixed(0)}秒`);
      if (!HL.points.length) hlLog('[警告] 得点シーンが見つかりませんでした。ゲーム画面が画面いっぱいに映っているか（配信レイアウトなら「ゲーム画面の位置」）を確認してください');
      $('hlFilterRow').style.display = HL.points.length ? 'flex' : 'none';
      $('hlExportBox').style.display = HL.points.length ? 'block' : 'none';
    } catch (e) {
      hlProg('', null);
      hlLog('ERROR: ' + (e && e.stack || e));
    } finally {
      HL.busy = false; setBusy(false); $('hlCancel').style.display = 'none';
    }
  }

  function applyIncludeFilter() {
    const onlyMe = $('hlOnlyMe').checked;
    for (const p of HL.points) p.include = onlyMe ? p.winner === 'me' : true;
  }

  // 得点の表示: 「得点後のスコア」だけを出し、動いた側の数字を太く色付き（自分=緑/相手=橙）。
  // 旧スコア→新スコアの併記はぱっと見で混乱する（ユーザー指摘 2026-09-02）ので title 属性に退避
  function scoreHtml(p) {
    const cls = p.winner === 'me' ? 'hlme' : 'hlopp';
    const m = /^(d+) - (d+)$/.exec(p.scoreAfter || '');
    let body;
    if (m) body = p.winner === 'me' ? `<b class="${cls} hlbig">${m[1]}</b> - ${m[2]}` : `${m[1]} - <b class="${cls} hlbig">${m[2]}</b>`;
    else if (p.final) body = `<b class="${cls} hlbig">${p.winner === 'me' ? '勝ち' : '負け'}</b>（マッチ決定）`;
    else body = `<b class="${cls} hlbig">${esc(p.scoreAfter)}</b>`;
    return `<span class="hlscore" title="${esc(p.scoreBefore)} → ${esc(p.scoreAfter)}">${body}</span>`;
  }
  const whoHtml = p => `<span class="${p.winner === 'me' ? 'hlme' : 'hlopp'}">${p.winner === 'me' ? '自分の得点' : '相手の得点'}</span>`;

  // ---- 一覧 ----
  const TYPE_LABEL = { short: '得点前', full: 'ラリー全体', match: '試合ごと' };
  function hlRender() {
    const type = hlType();
    const groups = new Map();
    for (const p of HL.points) { if (!groups.has(p.match)) groups.set(p.match, []); groups.get(p.match).push(p); }
    const sel = HL.points.filter(p => p.include).length;
    $('hlSummary').textContent = HL.points.length ? `${groups.size}試合・${HL.points.length}ポイント（選択中 ${sel}）` : '';
    $('hlList').innerHTML = [...groups].map(([m, arr]) => {
      const n = arr.filter(p => p.include).length;
      const secs = arr.filter(p => p.include).reduce((a, p) => { const r = ranges(p)[rangeKey()]; return a + (r.e - r.s); }, 0);
      return `
      <div class="hlm">
        <div class="hlmh"><b>試合 ${m}</b><span class="sub">${fmtT(arr[0].hudOn)} 〜 ${fmtT(arr[arr.length - 1].hudOff)} ・ ${arr.length}ポイント${type === 'match' ? `（この試合のクリップ: ${n}ラリー・約${secs.toFixed(0)}秒）` : ''}</span>
          ${myCharHtml(arr[0])}
          <button data-act="mall" data-m="${m}">この試合を全部選ぶ</button><button data-act="mnone" data-m="${m}">選択解除</button></div>
        <div class="hlrows">${arr.map(row).join('')}</div>
      </div>`; }).join('');
    // 保存形式の文言（区間の種類で変わる）
    if (type === 'match') {
      $('hlExportEach').textContent = '試合ごとに保存（1試合1本）';
      $('hlExportJoined').textContent = '全試合を1本に繋げて保存';
      $('hlPerMatchWrap').style.display = 'none';
      $('hlNameHint').textContent = 'チェックしたラリーをつなぎ、ポイント間のスコアバナーは抜きます。ファイル名: 録画名_試合n.mp4 ／ 録画名_全試合.mp4';
    } else {
      $('hlExportEach').textContent = '区間ごとに保存（1本ずつ）';
      $('hlExportJoined').textContent = '1本に繋げて保存';
      $('hlPerMatchWrap').style.display = '';
      $('hlNameHint').textContent = 'ファイル名: 録画名_試合n_Pk_スコア_自分/相手.mp4 ／ 繋げたもの: 録画名_試合n_ダイジェスト.mp4（試合ごと）または 録画名_ダイジェスト.mp4。つなぎ目あり＝重ねるぶん各区間が少し短くなり、再エンコードで時間がかかります';
    }
  }
  function myCharHtml(p) {
    const w = HL.windows[p.win]; const my = w && w.my;
    const opts = ['<option value="">（表示しない）</option>', ...((window.Characters ? Characters.ALL : []).map(n => `<option value="${esc(n)}"${my && my.name === n ? ' selected' : ''}>${esc(n)}</option>`))];
    const note = my && my.isDoubles && my.row === 0 ? '<span style="color:#f2a65a">ダブルス: 自分の行を判定できず（両方表示・選ぶと1人に）</span>' : (my && !my.name ? '<span style="color:#f2a65a">未判定</span>' : '');
    return `<span class="hlmy">自分のキャラ:${my && my.icon ? `<img src="${my.icon}">` : ''}${my && my.partner && my.partner.icon ? `<img src="${my.partner.icon}">` : ''}<select data-act="mychar" data-w="${p.win}">${opts.join('')}</select>${note}</span>`;
  }
  function row(p) {
    const type = hlType();
    const r = ranges(p)[rangeKey()];
    const edited = (p.edit && p.edit[rangeKey()]) ? ' <span class="hledited">手修正</span>' : '';
    return `<div class="hlp${p.include ? ' on' : ''}" data-i="${p.idx}">
      <label class="hlchk"><input type="checkbox" data-act="inc" ${p.include ? 'checked' : ''}></label>
      <img src="${p.thumb || ''}" data-act="edit" title="クリックで区間を調整">
      <div class="hlpinfo">
        <div><b>P${p.k}</b> ${whoHtml(p)} <span class="sub">→</span> ${scoreHtml(p)}</div>
        <div class="sub">ラリー ${(p.hudOff - p.hudOn).toFixed(1)}秒（${fmtT(p.hudOn)} 〜 ${fmtT(p.hudOff)}）</div>
        <div class="sub">${type === 'match' ? 'このラリー' : TYPE_LABEL[type]}: ${fmtT(r.s)} 〜 ${fmtT(r.e)}（${(r.e - r.s).toFixed(1)}秒）${edited}</div>
      </div>
      <button data-act="edit">区間を調整</button>
    </div>`;
  }
  $('hlList').addEventListener('change', e => {
    const sel = e.target.closest('select[data-act=mychar]'); if (!sel) return;
    const w = HL.windows[+sel.dataset.w]; if (!w) return;
    w.my = w.my || { icon: null };
    w.my.name = sel.value; w.my.manual = true;
    if (w.my.row === 0 && sel.value) { w.my.row = 1; w.my.partner = null; }  // 手で選んだら1人に確定
    hlRender();
  });
  $('hlList').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'mychar') return;
    if (act === 'mall' || act === 'mnone') {
      for (const p of HL.points) if (p.match === +b.dataset.m) p.include = act === 'mall';
      hlRender(); return;
    }
    const rowEl = e.target.closest('.hlp'); if (!rowEl) return;
    const p = HL.points[+rowEl.dataset.i];
    if (act === 'inc') { p.include = b.checked; rowEl.classList.toggle('on', p.include); const sel = HL.points.filter(q => q.include).length; $('hlSummary').textContent = $('hlSummary').textContent.replace(/選択中 \d+/, '選択中 ' + sel); return; }
    if (act === 'edit') hlOpenEditor(p, rangeKey());
  });
  $('hlOnlyMe').addEventListener('change', () => { applyIncludeFilter(); hlRender(); });
  $('hlSec').addEventListener('change', () => hlRender());
  for (const r of document.querySelectorAll('input[name=hlType]')) {
    r.addEventListener('change', () => {
      // 試合ごと＝両者のラリーをつなぐので、切り替え時は全ポイント選択に寄せる
      if (hlType() === 'match' && $('hlOnlyMe').checked) { $('hlOnlyMe').checked = false; applyIncludeFilter(); }
      hlRender();
    });
  }

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
    $('hlEdTitle').innerHTML = `<span class="hledt">試合 ${p.match}・P${p.k}</span> ${whoHtml(p)} <span class="sub">→</span> ${scoreHtml(p)} <span class="sub" style="margin-left:14px">${p.idx + 1} / ${HL.points.length}</span>`;
    $('hlEdPrev').disabled = p.idx <= 0; $('hlEdNext').disabled = p.idx >= HL.points.length - 1;
    $('hlEdInc').checked = !!p.include;
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
      const p = E().p, auto = H.clipRanges(p, { shortSec: shortSec() });
      p.edit = p.edit || {};
      for (const w of ['short', 'full']) {
        const v = E()[w];
        const same = Math.abs(v.s - auto[w].s) < 0.02 && Math.abs(v.e - auto[w].e) < 0.02;
        if (same) delete p.edit[w]; else p.edit[w] = { s: +v.s.toFixed(3), e: +v.e.toFixed(3) };
      }
      if (!Object.keys(p.edit).length) p.edit = null;
    }
    hlRender();   // 「この区間を保存する」の変更も一覧へ反映
    HL.edit = null;
    $('hlmodal').style.display = 'none';
  }
  function tlStatic() {
    const p = E().p;
    $('hlTlOn').style.left = xOf(p.hudOn); $('hlTlOn').style.width = ((p.hudOff - p.hudOn) / (E().T1 - E().T0) * 100).toFixed(2) + '%';
    const lim = H.nameLimit(p);
    $('hlTlDanger').style.left = xOf(lim); $('hlTlDanger').style.width = (Math.max(0, E().T1 - lim) / (E().T1 - E().T0) * 100).toFixed(2) + '%';
    // イントロ直後はVS画面の残像（名前入り）が復帰後も残るので、そこも赤にする
    const intro = $('hlTlIntro');
    if (p.fresh) { intro.style.display = 'block'; intro.style.left = xOf(p.hudOn); intro.style.width = (Math.min(H.INTRO_LEAD, p.hudOff - p.hudOn) / (E().T1 - E().T0) * 100).toFixed(2) + '%'; }
    else intro.style.display = 'none';
    $('hlTlT0').textContent = fmtT(E().T0); $('hlTlT1').textContent = fmtT(E().T1);
  }
  function cur() { return E()[E().which]; }
  function tlUpdate() {
    const c = cur();
    $('hlTlSel').style.left = xOf(c.s); $('hlTlSel').style.width = ((c.e - c.s) / (E().T1 - E().T0) * 100).toFixed(2) + '%';
    $('hlHS').style.left = xOf(c.s); $('hlHE').style.left = xOf(c.e);
    $('hlS').value = c.s.toFixed(2); $('hlE').value = c.e.toFixed(2);
    $('hlLen').textContent = (c.e - c.s).toFixed(1) + '秒';
    const p = E().p;
    const late = c.e > H.nameLimit(p);
    const early = p.fresh && c.s < p.hudOn + H.INTRO_LEAD - 0.05;
    $('hlEdWarn').style.display = (late || early) ? 'block' : 'none';
    $('hlEdWarn').textContent = late
      ? '[警告] 終了が赤い区間に入っています。' + (p.final ? '勝敗画面' : 'ポイント間のスコアバナー') + 'にプレイヤー名が映ります。「名前が映る区間を自動で除外」がONなら書き出し時に手前へ詰めます'
      : (early ? '[警告] 開始が試合開始直後の赤い区間に入っています。VS画面の残像にプレイヤー名がうっすら映ることがあります' : '');
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
    hv.currentTime = Math.max(0, Math.min((Number.isFinite(hv.duration) ? hv.duration : 1e9) - 0.05, t));
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
    const auto = H.clipRanges(E().p, { shortSec: shortSec() });
    E().short = { ...auto.short }; E().full = { ...auto.full }; tlUpdate(); hlSeek(cur().s);
  });
  $('hlEdOk').addEventListener('click', () => hlCloseEditor(true));
  // 前後のポイントへ（いまの区間は決定扱いで保存してから移る）
  function hlEdStep(d) {
    if (!E()) return;
    const next = HL.points[E().p.idx + d];
    if (!next) return;
    const which = E().which;
    hlCloseEditor(true);
    hlOpenEditor(next, which);
  }
  $('hlEdPrev').addEventListener('click', () => hlEdStep(-1));
  $('hlEdNext').addEventListener('click', () => hlEdStep(1));
  $('hlEdInc').addEventListener('change', () => { if (E()) { E().p.include = $('hlEdInc').checked; } });
  $('hlEdCancel').addEventListener('click', () => hlCloseEditor(false));
  document.addEventListener('keydown', e => {
    if (!E() || $('hlmodal').style.display === 'none') return;
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') hlCloseEditor(false);
    else if (e.key === 'PageUp') { e.preventDefault(); hlEdStep(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); hlEdStep(1); }
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
      const label = HL.joining ? `繋げています… ${HL.joining}${info.note ? '（' + info.note + '本）' : '（' + (r * 100).toFixed(0) + '%）'}` : `書き出し中… ${HL.jobDone + 1}/${HL.jobTotal}（${(r * 100).toFixed(0)}%）`;
      hlProg(label, (HL.jobDone + r) / HL.jobTotal);
    });
  }
  // つなぎ目の設定（記憶する）
  function transitionOpt() {
    const type = $('hlTrans').value, duration = Math.max(0.2, Math.min(2, +$('hlTransSec').value || 0.5));
    return type === 'none' ? null : { type, duration };
  }
  for (const id of ['hlTrans', 'hlTransSec', 'hlBadge', 'hlBadgeMode']) $(id).addEventListener('change', () => {
    SETTINGS.hlTrans = { type: $('hlTrans').value, duration: +$('hlTransSec').value || 0.5 };
    SETTINGS.hlBadge = { on: $('hlBadge').checked, mode: $('hlBadgeMode').value };
    window.api.saveUserData('settings', SETTINGS);
  });

  // fmt: 'each'（区間ごとに1本ずつ）/ 'joined'（1本に繋げる）。区間の種類が 'match' のときは「区間＝試合」
  async function hlExport(fmt) {
    if (HL.busy) return;
    if (!HL.path) { hlLog('[警告] 動画のファイルパスが取得できないため書き出せません'); return; }
    if (!(await window.api.hlFfmpegAvailable())) { hlLog('[警告] 同梱の ffmpeg が見つかりません。アプリを再インストールしてください'); return; }
    const sel = HL.points.filter(p => p.include);
    if (!sel.length) { hlLog('区間が1つも選ばれていません'); return; }
    if (!(await ensureOutDir())) return;
    HL.busy = true; HL.cancel = false; HL.jobDone = 0; HL.jobTotal = 0; setBusy(true);
    $('hlCancel').style.display = 'inline-block';
    hlProg(`区間を確認中… 0/${sel.length}`, 0);
    const type = hlType(), key = rangeKey();
    const guard = $('hlGuard').checked, maxH = $('hlScale').checked ? 1080 : null;
    const perMatch = type === 'match' ? (fmt === 'each') : $('hlPerMatch').checked;
    const crop = cropParam();
    const base = HL.file.name.replace(/\.[^.]+$/, '');
    // 自分のキャラのバッジ（試合窓ごとに1枚・出力の高さに合わせて描く）
    const badgeOn = $('hlBadge').checked, badgeMode = $('hlBadgeMode').value;
    const badgeSec = badgeMode === 'always' ? null : (+badgeMode || 3);
    const outH = Math.min(crop ? crop.h : hv.videoHeight, maxH || 1e9);
    const badges = new Map();
    if (badgeOn && window.api.hlSavePng) {
      for (let wi = 0; wi < HL.windows.length; wi++) {
        const my = HL.windows[wi].my;
        if (!my || (!my.name && !my.icon)) continue;
        try {
          const png = await makeBadge(my, outH);
          const p = png ? await window.api.hlSavePng(`badge-${Date.now()}-${wi}`, png) : null;
          if (p) badges.set(wi, { path: p, seconds: badgeSec });
        } catch (e) { hlLog('[警告] キャラ表示の画像を作れませんでした: ' + (e && e.message || e)); }
      }
    }
    // 区間ごとにそのままファイルにするか（each かつ match 以外）、一時フォルダに切ってから繋げるか
    const direct = fmt === 'each' && type !== 'match';
    const tmp = direct ? null : await window.api.hlTempDir();
    const outputs = [];
    try {
      // 1) 区間確定（名前が映るフレームの除外）
      const cuts = [];
      for (let i = 0; i < sel.length; i++) {
        const p = sel[i];
        let { s, e } = ranges(p)[key];
        hlProg(`区間を確認中… ${i + 1}/${sel.length}`, null);
        if (guard) {
          const g = await H.guardRange(hv, s, e, { interior: !!(p.edit && p.edit[key]) });
          if (g.changed) { hlLog(`試合${p.match} P${p.k}: 名前が映るフレームを避けて ${fmtT(s)}〜${fmtT(e)} → ${fmtT(g.s)}〜${fmtT(g.e)} に詰めました`); s = g.s; e = g.e; }
        }
        if (e - s < 0.5) { hlLog(`試合${p.match} P${p.k}: 区間が短すぎるため飛ばしました`); continue; }
        const name = `${base}_試合${p.match}_P${String(p.k).padStart(2, '0')}_${safeName(p.scoreAfter)}_${p.winner === 'me' ? '自分' : '相手'}${type === 'full' ? '_ラリー全体' : ''}.mp4`;
        cuts.push({ p, s, e, out: (tmp || HL.outDir) + '\\' + name });
        if (HL.cancel) break;
      }
      // 2) まとめ方
      const groups = [];   // {out, cuts}
      if (!direct) {
        if (perMatch) {
          const by = new Map();
          for (const c of cuts) { if (!by.has(c.p.match)) by.set(c.p.match, []); by.get(c.p.match).push(c); }
          for (const [m, arr] of by) groups.push({ out: `${HL.outDir}\\${base}_試合${m}${type === 'match' ? '' : '_ダイジェスト'}.mp4`, cuts: arr });
        } else {
          groups.push({ out: `${HL.outDir}\\${base}_${type === 'match' ? '全試合' : 'ダイジェスト'}.mp4`, cuts });
        }
      }
      // 3) 切り抜き（再エンコード・フレーム単位で正確）
      HL.jobTotal = cuts.length + groups.length;
      for (const c of cuts) {
        if (HL.cancel) break;
        HL.curJob = 'hl' + Date.now() + Math.random().toString(36).slice(2, 6);
        hlProg(`書き出し中… ${HL.jobDone + 1}/${HL.jobTotal}`, HL.jobDone / HL.jobTotal);
        const r = await window.api.hlCut({ jobId: HL.curJob, input: HL.path, start: c.s, duration: +(c.e - c.s).toFixed(3), out: c.out, crop, maxH, badge: badges.get(c.p.win) || null });
        HL.jobDone++;
        if (r.ok) { c.ok = true; if (direct) outputs.push(c.out); }
        else hlLog(`[警告] 書き出しに失敗: ${c.out}\n  ${r.error}`);
      }
      // 4) 連結（再エンコードなし）
      for (const g of groups) {
        if (HL.cancel) break;
        const files = g.cuts.filter(c => c.ok).map(c => c.out);
        if (!files.length) continue;
        HL.curJob = 'hl' + Date.now();
        HL.joining = g.out.split('\\').pop();
        hlProg(`繋げています… ${HL.joining}`, HL.jobDone / HL.jobTotal);
        const r = await window.api.hlConcat({ jobId: HL.curJob, files, out: g.out, transition: transitionOpt() });
        HL.joining = null;
        HL.jobDone++;
        if (r.ok) outputs.push(g.out); else hlLog(`[警告] 連結に失敗: ${g.out}\n  ${r.error}`);
      }
      if (tmp) await window.api.hlRemove(cuts.filter(c => c.ok).map(c => c.out));
      hlProg('', null);
      if (HL.cancel) hlLog('書き出しを中止しました');
      hlLog(outputs.length ? `保存しました（${outputs.length}本）:\n  ` + outputs.join('\n  ') : '保存されたファイルはありません');
      if (outputs.length) $('hlOpenDir').style.display = 'inline-block';
    } catch (e) {
      hlProg('', null);
      hlLog('ERROR: ' + (e && e.stack || e));
    } finally {
      HL.busy = false; HL.curJob = null; setBusy(false); $('hlCancel').style.display = 'none';
    }
  }
  $('hlExportEach').addEventListener('click', () => hlExport('each'));
  $('hlExportJoined').addEventListener('click', () => hlExport('joined'));

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
  setInterval(() => { $('hlUseLast').style.display = (LAST_FILE && !HL.busy) ? 'inline-block' : 'none'; if (LAST_FILE) $('hlUseLast').textContent = '直近の録画で作る（' + LAST_FILE.name + '）'; }, 1000);
  userDataReady.then(() => {
    if (SETTINGS.hlOutDir) { HL.outDir = SETTINGS.hlOutDir; $('hlOutDir').textContent = SETTINGS.hlOutDir; }
    if (SETTINGS.hlTrans) { $('hlTrans').value = SETTINGS.hlTrans.type || 'fade'; $('hlTransSec').value = SETTINGS.hlTrans.duration || 0.5; }
    if (SETTINGS.hlBadge) { $('hlBadge').checked = SETTINGS.hlBadge.on !== false; $('hlBadgeMode').value = SETTINGS.hlBadge.mode || '3'; }
  });

  window.HL = HL;
  HL._render = hlRender; HL._open = hlOpenEditor; HL._badge = makeBadge; // 表示確認用（ヘッドレスChromeでのスクショ）
})();
