'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createLeaderboard, score } = require('../leaderboard-server');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trill-leaderboard-'));
  let service = createLeaderboard({ dir });
  const server = http.createServer(async (req, res) => { if (!await service.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(route, method = 'GET', body, token) {
    const response = await fetch(origin + route, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }
  try {
    assert.deepStrictEqual((await api('/api/leaderboard')).data.entries, [], 'no fabricated players');
    assert.strictEqual((await api('/api/account/register', 'POST', { username: '<script>', password: 'test-password-1' })).status, 400);
    assert.strictEqual((await api('/api/account/register', 'POST', { username: 'bob', password: 'short' })).status, 400);
    const first = await api('/api/account/register', 'POST', { username: 'Alice', password: 'long-password-1' });
    const second = await api('/api/account/register', 'POST', { username: 'Bob', password: 'long-password-2' });
    assert.strictEqual(first.status, 201); assert.strictEqual(second.status, 201);
    assert.strictEqual((await api('/api/account/register', 'POST', { username: 'alice', password: 'long-password-1' })).status, 409);
    assert.strictEqual((await api('/api/account/login', 'POST', { username: 'Alice', password: 'incorrect-password' })).status, 401);
    assert.strictEqual((await api('/api/account/sync', 'POST', { minutes: 1, lessons: 1, badges: 1 })).status, 401);
    assert.strictEqual((await api('/api/account/sync', 'POST', { minutes: -1, lessons: 1, badges: 1 }, first.data.token)).status, 400);
    assert.strictEqual((await api('/api/account/sync', 'POST', { minutes: 60, lessons: 2, badges: 3 }, first.data.token)).data.score, 140);
    assert.strictEqual((await api('/api/account/sync', 'POST', { minutes: 2, lessons: 6, badges: 1 }, second.data.token)).data.score, 162);
    // A second device cannot erase a player's best published totals.
    const smaller = await api('/api/account/sync', 'POST', { minutes: 1, lessons: 0, badges: 0 }, first.data.token);
    assert.strictEqual(smaller.data.score, 140);
    let entries = (await api('/api/leaderboard')).data.entries;
    assert.deepStrictEqual(entries.map(x => x.username), ['Bob', 'Alice']);
    assert.strictEqual(entries[0].rank, 1); assert.strictEqual(score({ minutes: 2, lessons: 6, badges: 1 }), 162);
    const disk = fs.readFileSync(path.join(dir, 'leaderboard.json'), 'utf8');
    assert(!disk.includes('long-password-1') && !disk.includes(first.data.token), 'passwords and bearer tokens are not stored in plaintext');
    assert.strictEqual(fs.statSync(path.join(dir, 'leaderboard.json')).mode & 0o777, 0o600, 'private database permissions');
    // Simulate server restart; scores and hashed sessions survive.
    service = createLeaderboard({ dir });
    assert.strictEqual((await api('/api/account/me', 'GET', null, first.data.token)).data.username, 'Alice');
    assert.strictEqual((await api('/api/leaderboard')).data.entries.length, 2);
    assert.strictEqual((await api('/api/account/delete', 'DELETE', { password: 'wrong-password' }, first.data.token)).status, 401);
    assert.strictEqual((await api('/api/account/delete', 'DELETE', { password: 'long-password-1' }, first.data.token)).status, 200);
    assert.strictEqual((await api('/api/account/me', 'GET', null, first.data.token)).status, 401);
    assert.deepStrictEqual((await api('/api/leaderboard')).data.entries.map(x => x.username), ['Bob']);
    assert.strictEqual((await api('/api/account/logout', 'POST', {}, second.data.token)).status, 200);
    assert.strictEqual((await api('/api/account/me', 'GET', null, second.data.token)).status, 401);
    const login = await api('/api/account/login', 'POST', { username: 'bob', password: 'long-password-2' });
    assert.strictEqual(login.status, 200);
    console.log('PASS leaderboard: real accounts, hashing, ranking, validation, persistence, deletion and sign-out');
  } finally {
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
