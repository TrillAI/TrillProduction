'use strict';
/* Actual, unmocked SCNet ONNX inference in Chromium. Synthetic fixture validates
 * the pipeline, not separation quality on songs or instrument-level SDR. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { server } = require('../server');
let browser;
(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, '../public/models/scnet-compact/scnet-f120.int8.onnx'));
  assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), '3a926ef9710754f8bc04b3ded790ac6a0ac10465ca06a50e367382deed53d180');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [], externalRequests = []; page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { const url = request.url(); if (/^https?:/.test(url) && !url.startsWith(base + '/')) externalRequests.push(url); });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('tt.splashOff', 'true'); localStorage.setItem('tt.demoDone', 'true'); });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    TT.app.showView('stems');
    const sr = 44100, n = sr * 3, left = new Float32Array(n), right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = .18 * Math.sin(2 * Math.PI * 220 * i / sr) + .08 * Math.sin(2 * Math.PI * 440 * i / sr);
      right[i] = .16 * Math.sin(2 * Math.PI * 220 * i / sr) + .07 * Math.sin(2 * Math.PI * 440 * i / sr);
    }
    TT.stems.loadBuffer({ numberOfChannels: 2, sampleRate: sr, length: n, duration: 3, getChannelData: c => c ? right : left }, 'AI fixture', sr);
    TT.stems.run();
  });
  await page.waitForFunction(() => !TT.stems.state.busy, { timeout: 150000 });
  const output = await page.evaluate(() => {
    const s = TT.stems.state, summary = {};
    for (const [name, pair] of Object.entries(s.aiStems || {})) {
      let energy = 0;
      for (const value of pair[0]) energy += value * value;
      summary[name] = { frames: pair[0].length, channels: pair.length, energy };
    }
    return { status: document.getElementById('st-status').textContent, percent: document.getElementById('st-pct').textContent, result: !!s.result, summary };
  });
  assert(output.result, output.status);
  assert.strictEqual(output.percent, '100%');
  assert.deepStrictEqual(Object.keys(output.summary).sort(), ['bass', 'drums', 'other', 'vocals']);
  for (const stem of Object.values(output.summary)) { assert.strictEqual(stem.frames, 132300); assert.strictEqual(stem.channels, 2); assert(Number.isFinite(stem.energy)); }
  assert(Object.values(output.summary).filter(s => s.energy > 0).length >= 2, 'model produced non-silent, distinct estimates');
  assert(new Set(Object.values(output.summary).map(s => Math.round(s.energy))).size > 1);
  await page.click('[data-stem="bass"]');
  assert.deepStrictEqual(await page.evaluate(() => [TT.stems.state.result.mode, TT.stems.state.result.remove]), ['bass', false]);
  await page.click('[data-stem="drums"]');
  assert.deepStrictEqual(await page.evaluate(() => [TT.stems.state.result.mode, TT.stems.state.result.remove]), ['drums', false]);
  // Runtime cache is written asynchronously; it must really be available offline.
  await page.waitForFunction(async () => !!await caches.match('/vendor/ort/ort-wasm-simd-threaded.wasm'), { timeout: 10000 });
  await page.setOfflineMode(true);
  const offline = await page.evaluate(async () => {
    const [model, runtime] = await Promise.all([fetch('/models/scnet-compact/scnet-f120.int8.onnx'), fetch('/vendor/ort/ort-wasm-simd-threaded.wasm')]);
    return { model: model.ok, runtime: runtime.ok, modelBytes: (await model.arrayBuffer()).byteLength };
  });
  assert.deepStrictEqual(offline, { model: true, runtime: true, modelBytes: 11197164 });
  // Reload the worker and run inference again with the network disabled, rather
  // than only checking that the model and runtime can be fetched from cache.
  await page.evaluate(() => { TT.stems.state.aiStems = null; TT.stems.run(); });
  await page.waitForFunction(() => !TT.stems.state.busy, { timeout: 150000 });
  const offlineRun = await page.evaluate(() => ({ stems: Object.keys(TT.stems.state.aiStems || {}).sort(), status: document.getElementById('st-status').textContent }));
  assert.deepStrictEqual(offlineRun.stems, ['bass', 'drums', 'other', 'vocals'], offlineRun.status);
  assert.deepStrictEqual(externalRequests, [], 'AI processing should not request external services');
  assert.deepStrictEqual(errors, []);
  console.log('PASS real SCNet/WASM inference, four selectable stems, integrity pin, and a second fully offline inference');
})().then(async () => { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }).catch(async e => { console.error(e); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); process.exitCode = 1; });
