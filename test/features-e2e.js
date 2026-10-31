'use strict';
/* Browser coverage for automatic listening, sequential splash, privacy and
 * two real leaderboard accounts. Isolated temporary server data, no fakes. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trill-features-'));
process.env.TRILL_DATA_DIR = dir;
const { server } = require('../server');
let browser;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-file-for-fake-audio-capture=' + path.join(__dirname, 'e2_in_tune.wav')] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.TT && TT.app && TT.app.currentView === 'home');
  assert.strictEqual(await page.$eval('#splash-title', e => e.textContent), 'Trill Tuner');
  assert.strictEqual(await page.$eval('#splash-title', e => e.hidden), false);
  assert.strictEqual(await page.$eval('#splash-credit', e => e.hidden), true);
  assert.strictEqual(await page.$eval('#splash-title', e => getComputedStyle(e).animationName), 'splash-fade');
  await page.waitForFunction(() => !document.getElementById('splash-credit').hidden, { timeout: 4000 });
  assert.strictEqual(await page.$eval('#splash-credit', e => e.textContent), 'by Brian Cross');
  assert.strictEqual(await page.$eval('#splash-title', e => e.hidden), true);
  await page.waitForFunction(() => TT.splash.done && document.getElementById('splash').hidden, { timeout: 4000 });
  console.log('PASS two sequential fading splashes');

  await page.waitForFunction(() => TT.audio.micState === 'on' && TT.tuner.state.freq > 0, { timeout: 15000 });
  assert.strictEqual(await page.evaluate(() => TT.app.currentView), 'home', 'the mic starts without a tuner button');
  await page.evaluate(() => TT.app.showView('stems'));
  await page.waitForFunction(() => TT.tuner.state.freq > 0);
  assert.match(await page.$eval('#global-mic-status', e => e.textContent), /Mic live/);
  await page.click('#global-mic-status');
  assert.strictEqual(await page.evaluate(() => TT.audio.micState), 'off');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(await page.evaluate(() => TT.audio.micState), 'off', 'manual stop stays stopped after foregrounding');
  await page.click('#global-mic-status');
  await page.waitForFunction(() => TT.audio.micState === 'on');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  assert.strictEqual(await page.evaluate(() => TT.audio.micState), 'off', 'background releases the mic');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => TT.audio.micState === 'on');
  // Pending permission must never reopen the mic after the user stops it.
  await page.evaluate(() => {
    TT.tuner.stopMic();
    window.originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.finishMic = resolve; });
    window.lateStopped = false;
    TT.tuner.startMic();
  });
  await page.waitForFunction(() => TT.audio.micState === 'requesting' && window.finishMic);
  await page.evaluate(() => {
    TT.tuner.stopMic();
    window.finishMic({ getTracks: () => [{ stop: () => { window.lateStopped = true; } }] });
  });
  await page.waitForFunction(() => window.lateStopped);
  assert.strictEqual(await page.evaluate(() => TT.audio.micState), 'off');
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.originalGetUserMedia; TT.tuner.startMic(); });
  await page.waitForFunction(() => TT.audio.micState === 'on');
  console.log('PASS automatic foreground mic, explicit stop, background privacy and pending-request cancellation');

  await page.evaluate(() => { TT.store.set('practice', { '2026-01-01': 120 }); TT.store.set('lessonsDone', ['a', 'b']); TT.app.showView('progress'); });
  await page.waitForSelector('#lb-username', { visible: true });
  await page.type('#lb-username', 'Alice'); await page.type('#lb-password', 'long-password-one');
  await page.click('#lb-register');
  await page.waitForFunction(() => /Synced as Alice/.test(document.getElementById('lb-status').textContent), { timeout: 10000 });
  assert.match(await page.$eval('#lb-list', e => e.textContent), /Alice/);
  assert.strictEqual(await page.evaluate(() => JSON.stringify(TT.store.exportAll()).includes('trill.leaderboard.session')), false, 'session not included in backups');
  const context = await browser.createBrowserContext();
  const second = await context.newPage();
  await second.evaluateOnNewDocument(() => { localStorage.setItem('tt.splashOff', 'true'); localStorage.setItem('tt.demoDone', 'true'); });
  await second.goto(base, { waitUntil: 'domcontentloaded' });
  await second.waitForFunction(() => window.TT && TT.app);
  await second.evaluate(() => { TT.store.set('practice', { '2026-01-01': 300 }); TT.app.showView('progress'); });
  await second.type('#lb-username', 'Bob'); await second.type('#lb-password', 'long-password-two'); await second.click('#lb-register');
  await second.waitForFunction(() => /Synced as Bob/.test(document.getElementById('lb-status').textContent), { timeout: 10000 });
  await page.click('#lb-refresh');
  await page.waitForFunction(() => document.querySelectorAll('#lb-list li').length === 2);
  const names = await page.$$eval('#lb-list li strong', els => els.map(e => e.textContent));
  assert.deepStrictEqual(names, ['Bob', 'Alice']);
  console.log('PASS real browser signup, sync, public rankings and session privacy');
  assert.deepStrictEqual(errors, []);
  await context.close();
})().then(async () => { if (browser) await browser.close(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }).catch(async e => { console.error(e); if (browser) await browser.close(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); process.exitCode = 1; });
