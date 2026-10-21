// 흥행판 앱 연결 스크립트 — 뷰어(흥행판_보기.html)는 그대로 두고, 앱에서만 덧붙는 기능.
// (폴더 자동 읽기/저장, 스냅샷 받기, 크랙 로그인, 링크 열기)
(function () {
  'use strict';
  try { localStorage.removeItem('hh_snaps'); } catch (e) {} // 앱에서는 폴더가 원본이라 브라우저 저장소는 쓰지 않음

  const T = () => window.__TAURI__ && window.__TAURI__.core;
  const call = (cmd, args) => T().invoke(cmd, args || {});
  const API = 'https://crack-api.wrtn.ai/crack-api';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = n => String(n).padStart(2, '0');

  let loading = true;
  const MIN_GAP_MIN = 30;   // 스냅샷 최소 간격(분)
  const BLOCK_HOURS = 3;    // 크랙이 요청을 막았을 때 쉬는 시간
  let lastTaken = 0;        // 가장 최근 스냅샷 시각(ms)
  const seen = t => { if (t && t > lastTaken && t <= Date.now() + 60000) lastTaken = t; };
  const stampOf = o => { const c = Date.parse(o.captured_at || ''); if (c) return c; const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(o.snapshot_id || o.snapshot_date || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime() : 0; };
  const blockedUntil = () => { try { return +localStorage.getItem('hh_block_until') || 0; } catch (e) { return 0; } };
  const diskKeys = {}; // 기록 이름(key) → 이 기록을 담은 파일 이름들

  const keyOf = o => o.snapshot_id || o.snapshot_date || (o.captured_at && o.captured_at.slice(0, 10)) || null;
  const nameOf = k => '흥행판_스냅샷_' + k.replace(/ /g, '_').replace(/:/g, '-').replace(/[\\/*?"<>|]/g, '_') + '.json';

  // 자체 검사 모드: 알림창이 검사를 막지 않게 로그로 바꾸고, 오류도 기록
  (async function () {
    try {
      if (!T() || !(await call('selftest_enabled'))) return;
      window.alert = m => call('selftest_log', { text: 'ALERT ' + m });
      window.addEventListener('error', e => call('selftest_log', { text: 'ERROR ' + e.message + ' @' + e.lineno }));
      window.addEventListener('unhandledrejection', e => call('selftest_log', { text: 'REJECT ' + (e.reason && e.reason.message || e.reason) }));
      call('selftest_log', { text: 'bridge start' });
    } catch (e) {}
  })();

  function init() {
    if (!T()) return; // 앱이 아니면(브라우저) 아무것도 하지 않음
    const orig = {
      addSnap: window.addSnap, save: window.save, doExport: window.doExport, doClear: window.doClear,
    };
    if (typeof orig.addSnap !== 'function') return;

    // 1) 기록이 추가되면 파일로도 저장 (같은 기록이 이미 파일로 있으면 그 파일을 덮어씀)
    window.addSnap = function (obj) {
      if (Array.isArray(obj.snapshots)) { orig.addSnap(obj); return; } // 묶음 파일은 안쪽에서 하나씩 다시 들어옴
      orig.addSnap(obj);
      if (loading) return;
      const k = keyOf(obj);
      if (!k) return;
      const names = diskKeys[k];
      const name = names && names.length ? names[0] : nameOf(k);
      call('save_snapshot', { name, text: JSON.stringify(obj), overwrite: true })
        .then(() => { diskKeys[k] = [name]; })
        .catch(e => alert('파일로 저장하지 못했어요: ' + e));
    };

    // 2) 브라우저 저장소 대신, 화면에서 지워진 기록의 파일을 '삭제됨' 폴더로 옮김
    window.save = function () {
      if (loading) return;
      Object.keys(diskKeys).forEach(k => {
        if (SNAPS.some(s => s.date === k)) return;
        diskKeys[k].forEach(n => call('move_aside', { name: n, sub: '삭제됨' }).catch(() => {}));
        delete diskKeys[k];
      });
    };
    window.doClear = function () {
      const before = SNAPS.length;
      orig.doClear();
      if (before > 0 && SNAPS.length === 0) window.save();
    };

    // 3) 전체 기록 내보내기는 앱 폴더의 '내보내기' 하위 폴더에 저장
    window.doExport = async function () {
      if (!SNAPS.length) { alert('내보낼 기록이 없어요.'); return; }
      const out = { format: 'heunghengpan-all', exported_at: new Date().toISOString(), snapshots: SNAPS.map(s => { const o = { snapshot_date: s.date, works: Object.values(s.map) }; if (s.account && !(typeof NOACCT !== 'undefined' && NOACCT)) o.account = s.account; return o; }) };
      try {
        const p = await call('save_export', { name: '흥행판_전체기록_' + SNAPS[SNAPS.length - 1].date.replace(/[ :]/g, '_') + '.json', text: JSON.stringify(out) });
        alert('내보냈어요:\n' + p);
      } catch (e) { alert('내보내기 실패: ' + e); }
    };

    // 4) 작품 링크는 기본 브라우저로 열기
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[target=_blank]');
      if (a) { e.preventDefault(); call('open_url', { url: a.href }).catch(() => {}); }
    }, true);

    addBar();
    loadFolder(orig).catch(e => { loading = false; alert('저장 폴더를 읽지 못했어요: ' + e); });
  }

  async function loadFolder(orig) {
    const files = await call('list_snapshots');
    // 빠르게 읽으려고 화면 그리기를 잠시 멈췄다가 마지막에 한 번만 그림
    const R = { render: window.render, drawMgr: window.drawMgr, rebuildBase: window.rebuildBase };
    window.render = window.drawMgr = window.rebuildBase = function () {};
    let bad = 0;
    const bundles = [];
    for (const f of files) {
      let o;
      try { o = JSON.parse(f.text); } catch (e) { bad++; continue; }
      if (Array.isArray(o.snapshots)) { bundles.push({ f, o }); continue; }
      const k = keyOf(o);
      if (!k || !Array.isArray(o.works)) { bad++; continue; }
      orig.addSnap(o); seen(stampOf(o));
      (diskKeys[k] = diskKeys[k] || []).push(f.name);
    }
    // 묶음(전체 기록) 파일은 하나씩 풀어서 파일로 저장하고, 원본은 '가져옴' 폴더로 옮김
    for (const { f, o } of bundles) {
      for (const s of o.snapshots) {
        const k = keyOf(s);
        if (!k) continue;
        orig.addSnap(s); seen(stampOf(s));
        if (!diskKeys[k]) {
          const name = nameOf(k);
          try { await call('save_snapshot', { name, text: JSON.stringify(s), overwrite: false }); diskKeys[k] = [name]; } catch (e) {}
        }
      }
      try { await call('move_aside', { name: f.name, sub: '가져옴' }); } catch (e) {}
    }
    window.render = R.render; window.drawMgr = R.drawMgr; window.rebuildBase = R.rebuildBase;
    loading = false;
    R.rebuildBase(); R.render(); R.drawMgr();
    refreshLock();
    setStatus(files.length ? `폴더에서 기록 ${SNAPS.length}개를 읽었어요${bad ? ` (읽지 못한 파일 ${bad}개)` : ''}` : '저장 폴더가 비어 있어요. 스냅샷을 받거나 파일을 올려 주세요.');
    selftest();
  }

  // ---------- 화면: 앱 버튼 ----------
  let statusEl;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function addBar() {
    const h = document.querySelector('header');
    if (!h) return;
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 6px';
    const mk = (t, f, primary) => {
      const b = document.createElement('button'); b.textContent = t; b.onclick = f;
      if (primary) { b.style.background = 'var(--acc)'; b.style.borderColor = 'var(--acc)'; b.style.color = '#fff'; }
      bar.appendChild(b); return b;
    };
    const snapBtn = mk('스냅샷 받기', () => takeSnapshotUI(snapBtn), true);
    snapBtnRef = snapBtn; refreshLock(); setInterval(refreshLock, 20000);
    mk('크랙 로그인', () => call('crack_login').catch(e => alert(String(e))));
    mk('저장 폴더 열기', () => call('open_folder').catch(e => alert(String(e))));
    statusEl = document.createElement('span');
    statusEl.style.cssText = 'color:var(--sub);font-size:13px';
    bar.appendChild(statusEl);
    const c = h.querySelector('h1');
    c.insertAdjacentElement('afterend', bar);
    const by = document.createElement('div');
    by.style.cssText = 'color:var(--sub);font-size:12px;margin:2px 0 0';
    by.textContent = '넉넉한 취향이 클로드와 함께 만들었어요 · v개발.000003 (Tauri 시험판)';
    h.appendChild(by);
  }

  // ---------- 스냅샷 간격 락 ----------
  let snapBtnRef = null;
  const leftMin = ms => Math.max(1, Math.ceil(ms / 60000));
  function lockInfo() {
    const bu = blockedUntil();
    if (bu > Date.now()) return { hard: true, ms: bu - Date.now() };
    const wait = lastTaken + MIN_GAP_MIN * 60000 - Date.now();
    if (wait > 0) return { hard: false, ms: wait };
    return null;
  }
  function refreshLock() {
    if (!snapBtnRef || busy) return;
    const L = lockInfo();
    snapBtnRef.textContent = L ? (L.hard ? `스냅샷 쉬는 중 (${leftMin(L.ms)}분)` : `스냅샷 받기 (${leftMin(L.ms)}분 후)`) : '스냅샷 받기';
    snapBtnRef.style.opacity = L ? '.65' : '';
  }

  // ---------- 스냅샷 받기 ----------
  let blockedStatus = null;
  async function getJson(url, token) {
    const r = await call('http_get', { url, token });
    if (r.status === 403 || r.status === 429) { blockedStatus = r.status; throw new Error('BLOCKED ' + r.status); }
    let json = null;
    try { json = JSON.parse(r.body); } catch (e) {}
    return { status: r.status, json };
  }
  const pick = j => { const d = (j && (j.data || j)) || {}; return { list: d.contents || d.items || d.list || d.stories || [], next: d.nextCursor || d.cursor || null, d }; };

  async function takeSnapshot(token, progress) {
    blockedStatus = null;
    const items = []; let cur = null, guard = 0;
    while (guard++ < 80) {
      const r = await getJson(`${API}/content/me?limit=20&sort=createdAt` + (cur ? '&cursor=' + encodeURIComponent(cur) : ''), token);
      if (r.status === 401) throw new Error('LOGIN_REQUIRED');
      if (r.status !== 200) throw new Error('내 작품 목록 불러오기 실패: ' + r.status);
      const p = pick(r.json);
      if (!p.list.length) break;
      items.push(...p.list); progress(`내 작품 ${items.length}개 읽음…`);
      cur = p.next; if (!cur) break;
      await sleep(400);
    }
    const extra = {};
    try {
      const uid = items[0] && items[0].creator && items[0].creator.wrtnUid;
      if (uid) {
        progress('대화방 수 읽는 중…');
        let c2 = null, g2 = 0;
        while (g2++ < 40) {
          const r = await getJson(`${API}/stories?creatorWrtnUid=${encodeURIComponent(uid)}&limit=50` + (c2 ? '&cursor=' + encodeURIComponent(c2) : ''), token);
          if (r.status !== 200) break;
          const p = pick(r.json);
          (p.d.stories || []).forEach(x => { extra[x._id] = x; });
          c2 = p.d.nextCursor; if (!c2) break;
          await sleep(400);
        }
      }
    } catch (e) {}
    if (blockedStatus) throw new Error('BLOCKED ' + blockedStatus);
    const listed = Object.keys(extra).length;
    let filled = 0, tried = 0;
    const todo = items.filter(x => x.sourceId && !extra[x.sourceId]);
    for (const x of todo) {
      tried++; progress(`상세 ${tried}/${todo.length}`);
      try {
        const r = await getJson(`${API}/${x.type === 'character' ? 'characters' : 'stories'}/${x.sourceId}`, token);
        if (r.status === 200) {
          let d = (r.json && (r.json.data || r.json)) || {}; d = d.story || d.character || d;
          if (d && (d.chatCount != null || d.createdAt)) { extra[x.sourceId] = d; filled++; }
        }
      } catch (e) {}
      await sleep(200);
    }
    if (blockedStatus) throw new Error('BLOCKED ' + blockedStatus);
    // 계정 정산 예상 정보 (실패해도 작품 스냅샷은 그대로 저장)
    let account = null;
    try {
      progress('정산 정보 읽는 중…');
      const rv = await getJson(`${API}/creators/me/revenue`, token);
      if (rv.status === 200) {
        const d = (rv.json && rv.json.data) || {};
        const n = v => (typeof v === 'number' && isFinite(v)) ? v : null;
        account = { expectedCash: n(d.expectedCash), expectedMoney: n(d.expectedMoney), monthlySuperChat: n(d.monthlySuperChat) };
        if (Object.values(account).every(v => v === null)) account = null;
      }
    } catch (e) { account = null; }
    if (blockedStatus) throw new Error('BLOCKED ' + blockedStatus);
    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const sid = `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const works = items.map(x => {
      const e = extra[x.sourceId];
      return {
        id: x._id, sourceId: x.sourceId || null, name: x.name, type: x.type || 'story', visibility: x.visibility, adult: !!x.isAdult, original: !!(x.original && x.original.isOriginal), only: !!(x.onlyContent && x.onlyContent.isOnlyContent),
        msg: x.totalMessageCount || 0, like: x.likeCount || 0, comment: x.commentCount || 0,
        chat: e ? e.chatCount : null, chatUsers: e ? e.chatUserCount : null,
        created: ((e && e.createdAt) || x.createdAt || '').slice(0, 10),
      };
    });
    return { snap: { snapshot_date: date, snapshot_id: sid, captured_at: now.toISOString(), count: works.length, account, works }, listed, filled, failed: tried - filled };
  }

  let busy = false;
  async function takeSnapshotUI(btn) {
    if (busy) return;
    const L = lockInfo();
    if (L && L.hard) { alert(`크랙이 요청을 막은 것 같아서 ${leftMin(L.ms)}분 더 쉬어요.\n(과하게 받으면 막힐 수 있어요. 시간이 지나면 다시 받을 수 있어요.)`); return; }
    if (L && !confirm(`마지막 스냅샷에서 ${MIN_GAP_MIN}분이 안 지났어요 (${leftMin(L.ms)}분 남음).\n자주 받으면 크랙이 요청을 막을 수 있어요.\n그래도 지금 받을까요?`)) return;
    busy = true; btn.disabled = true;
    try {
      btn.textContent = '로그인 확인 중…';
      let token = await call('crack_token');
      if (!token) {
        await call('crack_login');
        alert('크랙 창이 열렸어요.\n로그인한 뒤 그 창을 닫고, 다시 \'스냅샷 받기\'를 눌러 주세요.');
        return;
      }
      const res = await takeSnapshot(token, t => { btn.textContent = t; });
      window.addSnap(res.snap); // 화면에 넣으면서 폴더에도 저장됨
      seen(Date.parse(res.snap.captured_at));
      setStatus(`스냅샷 ${res.snap.count}개 저장 (${res.snap.snapshot_id})`);
      alert(`스냅샷 ${res.snap.count}개 저장 완료! (${res.snap.snapshot_id})\n대화방 수/생성일: 목록 ${res.listed}개 + 상세 ${res.filled}개 확인` + `\n정산 정보: ${res.snap.account ? '저장됨' : '받지 못함'}` + (res.failed ? `\n상세 보충 실패 ${res.failed}개` : '') + '\n\n⚠ 스냅샷은 하루 1~3번 정도로 받아주세요. 몇 분마다 반복해서 받으면 크랙이 요청을 막을 수 있어요. (비공식 API 사용)');
    } catch (e) {
      if (/^BLOCKED/.test(String(e.message || e))) {
        try { localStorage.setItem('hh_block_until', String(Date.now() + BLOCK_HOURS * 3600000)); } catch (x) {}
        alert(`크랙이 요청을 막은 것 같아요 (응답 ${blockedStatus}).\n안전하게 ${BLOCK_HOURS}시간 동안 스냅샷 받기를 쉬어요.`);
      } else if (String(e.message || e) === 'LOGIN_REQUIRED') {
        await call('crack_login').catch(() => {});
        alert('로그인이 만료됐어요. 크랙 창에서 다시 로그인한 뒤 그 창을 닫고 시도해 주세요.');
      } else alert('오류: ' + (e.message || e));
    } finally {
      btn.disabled = false; busy = false; refreshLock();
    }
  }

  // ---------- 자체 검사 (환경변수가 있을 때만) ----------
  async function selftest() {
    try {
      if (!(await call('selftest_enabled'))) return;
      const rows = document.querySelectorAll('#tbl tbody tr').length;
      const rep = { snaps: SNAPS.length, rows, count: (document.querySelector('#count') || {}).textContent, status: statusEl && statusEl.textContent, diskKeys: Object.keys(diskKeys).length, buttons: [...document.querySelectorAll('header button')].map(b => b.textContent) };
      // 추가 검사: 새 기록 → 파일 저장, 화면에서 삭제 → '삭제됨' 이동, 토큰/네트워크 호출이 죽지 않는지
      const t = { works: [{ id: '1', name: 'x', msg: 1, like: 1, comment: 1, type: 'story', visibility: 'public' }], snapshot_id: '2026-10-22 12:34' };
      window.addSnap(t); await sleep(400);
      rep.afterAdd = (await call('list_snapshots')).map(f => f.name).filter(n => n.includes('12-34'));
      window.SNAPS_BEFORE = SNAPS.length;
      SNAPS = SNAPS.filter(s => s.date !== '2026-10-22 12:34'); window.save(); await sleep(400);
      rep.afterDelete = (await call('list_snapshots')).map(f => f.name).filter(n => n.includes('12-34'));
      try { rep.token = (await call('crack_token')).length; } catch (e) { rep.tokenErr = String(e); }
      try { await call('http_get', { url: 'https://example.com/', token: '' }); rep.badUrl = 'allowed?!'; } catch (e) { rep.badUrl = 'blocked'; }
      try { const r = await call('http_get', { url: API + '/content/me?limit=1', token: '' }); rep.api = r.status; } catch (e) { rep.apiErr = String(e).slice(0, 60); }
      await call('selftest_report', { text: JSON.stringify(rep) });
    } catch (e) {}
  }

  // 뷰어 스크립트가 다 만들어진 뒤(DOMContentLoaded 이후)에 덧씌움
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
