'use strict';
/* A small, single-instance account and public progress board. Data is kept on a
 * persistent volume, never under public/. Scores are computed here from
 * self-reported progress; they are not a measure of verified skill. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const MAX_BODY = 16 * 1024;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const score = s => s.minutes + s.lessons * 25 + s.badges * 10;
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const emptyStats = () => ({ minutes: 0, lessons: 0, badges: 0 });

function createLeaderboard(options = {}) {
  const dir = path.resolve(options.dir || process.env.TRILL_DATA_DIR || path.join(__dirname, 'data'));
  const file = path.join(dir, 'leaderboard.json');
  const limits = new Map();
  let db;
  function load() {
    if (db) return db;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.users) || !Array.isArray(parsed.sessions)) throw new Error('Invalid leaderboard data');
      db = parsed;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // never overwrite corrupt data with an empty database
      db = { version: 1, users: [], sessions: [] };
    }
    return db;
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, '.leaderboard-' + crypto.randomBytes(8).toString('hex') + '.tmp');
    try {
      fs.writeFileSync(temp, JSON.stringify(db), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch (_) {} }
  }
  function answer(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  }
  function fail(res, status, message) { answer(res, status, { ok: false, error: message }); }
  function isSecure(req) {
    if (req.socket.encrypted) return true;
    if (process.env.TRILL_TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
    const peer = req.socket.remoteAddress || '';
    const host = String(req.headers.host || '').replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');
    return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(peer) && /^(localhost|127\.0\.0\.1|::1)$/.test(host);
  }
  function allowed(req) {
    const now = Date.now();
    const key = req.socket.remoteAddress || 'unknown';
    let entry = limits.get(key);
    if (!entry || entry.until < now) entry = { count: 0, until: now + 10 * 60 * 1000 };
    entry.count++; limits.set(key, entry);
    if (limits.size > 2000) for (const [ip, value] of limits) if (value.until < now) limits.delete(ip);
    return entry.count <= 30;
  }
  async function body(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Send JSON.'), { status: 415 });
    let size = 0, parts = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 });
      parts.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; }
    catch (_) { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }
  function cleanName(value) { return typeof value === 'string' && /^[A-Za-z0-9_]{3,24}$/.test(value) ? value : null; }
  function validPassword(value) { return typeof value === 'string' && value.length >= 10 && Buffer.byteLength(value, 'utf8') <= 256; }
  function getSession(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const data = load();
    const session = data.sessions.find(s => s.hash === hashToken(m[1]) && s.expires > Date.now());
    if (!session) return null;
    const user = data.users.find(u => u.id === session.user);
    return user ? { user, session } : null;
  }
  function makeSession(user) {
    const data = load();
    const token = crypto.randomBytes(32).toString('hex');
    data.sessions = data.sessions.filter(s => s.expires > Date.now());
    const own = data.sessions.filter(s => s.user === user.id).sort((a, b) => b.expires - a.expires);
    if (own.length >= 5) { const oldest = new Set(own.slice(4).map(s => s.hash)); data.sessions = data.sessions.filter(s => !oldest.has(s.hash)); }
    data.sessions.push({ hash: hashToken(token), user: user.id, expires: Date.now() + SESSION_MS });
    return token;
  }
  async function derive(password, salt) { return await scrypt(password, Buffer.from(salt, 'hex'), 64); }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/leaderboard') && !url.pathname.startsWith('/api/account/')) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' }); res.end(); return true;
    }
    if (!isSecure(req)) { fail(res, 403, 'Accounts require HTTPS (localhost is allowed for development).'); return true; }
    try {
      const data = load();
      if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
        const entries = data.users.map(u => ({ username: u.name, ...u.stats, score: score(u.stats) }))
          .sort((a, b) => b.score - a.score || b.lessons - a.lessons || a.username.localeCompare(b.username))
          .slice(0, 50).map((u, i) => ({ rank: i + 1, ...u }));
        answer(res, 200, { ok: true, entries }); return true;
      }
      if (url.pathname === '/api/account/register' && req.method === 'POST') {
        if (!allowed(req)) { fail(res, 429, 'Too many attempts. Try again later.'); return true; }
        const { username, password } = await body(req);
        const name = cleanName(username);
        if (!name || !validPassword(password)) { fail(res, 400, 'Use a 3–24 character username (letters, numbers, underscore) and a password of at least 10 characters.'); return true; }
        if (data.users.some(u => u.key === name.toLowerCase())) { fail(res, 409, 'That username is already in use.'); return true; }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = (await derive(password, salt)).toString('hex');
        // Another signup could have completed while scrypt was running.
        if (data.users.some(u => u.key === name.toLowerCase())) { fail(res, 409, 'That username is already in use.'); return true; }
        const user = { id: crypto.randomBytes(16).toString('hex'), key: name.toLowerCase(), name, salt, hash, stats: emptyStats() };
        data.users.push(user); const token = makeSession(user); save();
        answer(res, 201, { ok: true, token, username: user.name }); return true;
      }
      if (url.pathname === '/api/account/login' && req.method === 'POST') {
        if (!allowed(req)) { fail(res, 429, 'Too many attempts. Try again later.'); return true; }
        const { username, password } = await body(req);
        const name = cleanName(username);
        const user = name && data.users.find(u => u.key === name.toLowerCase());
        // Do the same expensive KDF for nonexistent accounts to avoid a timing leak.
        const salt = user ? user.salt : '00000000000000000000000000000000';
        const derived = await derive(typeof password === 'string' && Buffer.byteLength(password) <= 256 ? password : '', salt);
        const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64);
        if (!user || !crypto.timingSafeEqual(derived, expected)) { fail(res, 401, 'Invalid username or password.'); return true; }
        const token = makeSession(user); save();
        answer(res, 200, { ok: true, token, username: user.name }); return true;
      }
      const auth = getSession(req);
      if (!auth) { fail(res, 401, 'Sign in to sync progress.'); return true; }
      if (url.pathname === '/api/account/me' && req.method === 'GET') {
        answer(res, 200, { ok: true, username: auth.user.name, stats: auth.user.stats }); return true;
      }
      if (url.pathname === '/api/account/sync' && req.method === 'POST') {
        const stats = await body(req);
        const keys = { minutes: 5256000, lessons: 1000, badges: 1000 };
        if (Object.keys(keys).some(k => !Number.isSafeInteger(stats[k]) || stats[k] < 0 || stats[k] > keys[k])) {
          fail(res, 400, 'Progress values must be non-negative whole numbers within the supported range.'); return true;
        }
        for (const k of Object.keys(keys)) auth.user.stats[k] = Math.max(auth.user.stats[k], stats[k]);
        save(); answer(res, 200, { ok: true, username: auth.user.name, stats: auth.user.stats, score: score(auth.user.stats) }); return true;
      }
      if (url.pathname === '/api/account/logout' && req.method === 'POST') {
        data.sessions = data.sessions.filter(s => s.hash !== auth.session.hash); save();
        answer(res, 200, { ok: true }); return true;
      }
      if (url.pathname === '/api/account/delete' && req.method === 'DELETE') {
        const { password } = await body(req);
        if (typeof password !== 'string' || Buffer.byteLength(password) > 256 || !crypto.timingSafeEqual(await derive(password, auth.user.salt), Buffer.from(auth.user.hash, 'hex'))) {
          fail(res, 401, 'Password is incorrect.'); return true;
        }
        data.users = data.users.filter(u => u.id !== auth.user.id);
        data.sessions = data.sessions.filter(s => s.user !== auth.user.id); save();
        answer(res, 200, { ok: true }); return true;
      }
      fail(res, 404, 'Account endpoint not found.'); return true;
    } catch (e) {
      console.error('[leaderboard]', e.status ? e.message : 'storage or service error');
      fail(res, e.status || 500, e.status ? e.message : 'Leaderboard is unavailable.'); return true;
    }
  }
  return { handle, score };
}
module.exports = { createLeaderboard, score };
