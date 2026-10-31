/* Optional, account-backed community leaderboard. Only aggregate counts are
 * sent. The bearer session is in sessionStorage, never in backups or URLs. */
(function () {
  'use strict';
  const L = {};
  const SESSION_KEY = 'trill.leaderboard.session';
  let el = {}, session = null, timer = 0, syncing = false, syncAgain = false;
  function savedSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; } }
  function keepSession(value) { session = value; try { if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); else sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
  function status(text) { if (el.status) el.status.textContent = text; }
  function base() {
    const raw = (TT.store.get('leaderboardServer', '') || '').trim();
    if (!raw) {
      if (/^https?:$/.test(location.protocol) && location.hostname !== 'appassets.androidplatform.net') return location.origin;
      throw new Error('Set a deployed HTTPS leaderboard server in Leaderboard server above.');
    }
    let u;
    try { u = new URL(raw); } catch (_) { throw new Error('Enter a valid HTTPS server URL.'); }
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('Enter the server origin only, without a path or credentials.');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('Use HTTPS for leaderboard accounts.');
    return u.origin;
  }
  async function api(path, options = {}) {
    const url = base();
    const headers = { 'Accept': 'application/json' };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (session && session.server === url) headers.Authorization = 'Bearer ' + session.token;
    let response;
    try { response = await fetch(url + path, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined, credentials: 'omit', cache: 'no-store' }); }
    catch (_) { throw new Error('Cannot reach the leaderboard. Check your connection and server URL.'); }
    let data; try { data = await response.json(); } catch (_) { throw new Error('This server does not provide the leaderboard API.'); }
    if (!response.ok || !data.ok) {
      if (response.status === 401 && session && path !== '/api/account/login' && path !== '/api/account/delete') { keepSession(null); renderAccount(); }
      throw new Error(data.error || 'Leaderboard request failed.');
    }
    return data;
  }
  function renderAccount() {
    if (el.auth) el.auth.hidden = !!session;
    if (el.signed) el.signed.hidden = !session;
    if (el.account) el.account.textContent = session ? 'Signed in as ' + session.username + '. Progress syncs while this session is open.' : '';
  }
  function renderEntries(entries) {
    el.list.replaceChildren();
    if (!entries.length) { const li = document.createElement('li'); li.className = 'leaderboard-empty'; li.textContent = 'No players yet. Be the first to join.'; el.list.appendChild(li); return; }
    entries.forEach(entry => {
      const li = document.createElement('li');
      const rank = document.createElement('b'), name = document.createElement('strong'), details = document.createElement('span'), points = document.createElement('b');
      rank.className = 'lb-rank'; rank.textContent = '#' + entry.rank;
      name.textContent = entry.username; details.textContent = entry.minutes + ' min · ' + entry.lessons + ' lessons · ' + entry.badges + ' achievements';
      points.className = 'lb-points'; points.textContent = entry.score + ' pts';
      const who = document.createElement('div'); who.append(name, details); li.append(rank, who, points); el.list.appendChild(li);
    });
  }
  L.refresh = async function () {
    try { const data = await api('/api/leaderboard'); renderEntries(data.entries); status(session ? 'Leaderboard updated.' : 'Leaderboard updated. Sign in to share your progress.'); }
    catch (e) { el.list.replaceChildren(); status(e.message); }
  };
  async function authenticate(action) {
    if (!el.auth.reportValidity()) return;
    const username = el.username.value.trim(), password = el.password.value;
    status(action === 'register' ? 'Creating account…' : 'Signing in…');
    try {
      const server = base();
      const data = await api('/api/account/' + action, { method: 'POST', body: { username, password } });
      el.password.value = '';
      keepSession({ token: data.token, username: data.username, server }); renderAccount();
      await L.sync();
    } catch (e) { status(e.message); }
  }
  L.sync = async function () {
    if (!session || syncing) { if (session) syncAgain = true; return; }
    syncing = true;
    try {
      if (TT.share) TT.share.checkBadges(true);
      const stats = TT.share.stats();
      const counts = { minutes: Math.max(0, Math.floor(Number(stats.totalMins) || 0)), lessons: stats.lessons, badges: (TT.store.get('badges', []) || []).length };
      const data = await api('/api/account/sync', { method: 'POST', body: counts });
      await L.refresh();
      status('Synced as ' + data.username + ' · ' + data.score + ' points.');
    } catch (e) { status(e.message); }
    finally { syncing = false; if (syncAgain) { syncAgain = false; clearTimeout(timer); timer = setTimeout(L.sync, 1000); } }
  };
  L.init = function () {
    el = { server: document.getElementById('lb-server'), auth: document.getElementById('lb-auth'), username: document.getElementById('lb-username'), password: document.getElementById('lb-password'), signed: document.getElementById('lb-signed-in'), account: document.getElementById('lb-account'), status: document.getElementById('lb-status'), list: document.getElementById('lb-list') };
    if (!el.auth || !el.list) return;
    el.server.value = TT.store.get('leaderboardServer', '');
    session = savedSession();
    try { if (session && session.server !== base()) keepSession(null); } catch (_) { keepSession(null); }
    renderAccount();
    el.auth.addEventListener('submit', e => { e.preventDefault(); authenticate('login'); });
    document.getElementById('lb-register').addEventListener('click', () => authenticate('register'));
    document.getElementById('lb-sync').addEventListener('click', () => L.sync());
    document.getElementById('lb-refresh').addEventListener('click', () => L.refresh());
    document.getElementById('lb-save-server').addEventListener('click', () => {
      const old = TT.store.get('leaderboardServer', '');
      TT.store.set('leaderboardServer', el.server.value.trim());
      try { base(); } catch (e) { TT.store.set('leaderboardServer', old); status(e.message); return; }
      keepSession(null); renderAccount(); L.refresh();
    });
    document.getElementById('lb-logout').addEventListener('click', async () => {
      try { await api('/api/account/logout', { method: 'POST' }); } catch (_) { /* local sign-out still works offline */ }
      keepSession(null); renderAccount(); status('Signed out on this device.');
    });
    document.getElementById('lb-delete').addEventListener('click', async () => {
      const password = prompt('Enter your password to permanently delete your leaderboard account and public score.');
      if (password == null || !confirm('Delete this account and its leaderboard entry permanently?')) return;
      try { await api('/api/account/delete', { method: 'DELETE', body: { password } }); keepSession(null); renderAccount(); await L.refresh(); status('Account and leaderboard entry deleted.'); }
      catch (e) { status(e.message); }
    });
    window.addEventListener('tt:store-change', event => {
      if (session && ['practice', 'lessonsDone', 'badges'].includes(event.detail && event.detail.key)) { clearTimeout(timer); timer = setTimeout(L.sync, 5000); }
    });
    if (session) L.sync();
  };
  window.TT = window.TT || {}; window.TT.leaderboard = L;
})();
