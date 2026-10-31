/* Browser coverage for the responsive studio shell and the live neon tuner.
 * Run with `npm run test:ui`; Puppeteer needs its usual Chrome installation.
 * A synthetic microphone is used, so this never requests a real device. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { server } = require('../server');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.join(__dirname, '..');
let browser;
let chromaticBrowser;
let tempDir;

function toneWav(file, frequency) {
  const rate = 44100;
  const samples = rate * 6;
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples * 2, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    let value = 0;
    for (let harmonic = 1; harmonic <= 8; harmonic++) {
      value += Math.sin(2 * Math.PI * frequency * harmonic * i / rate) / (harmonic * harmonic);
    }
    out.writeInt16LE(Math.round(value * 0.32 * 32000), 44 + i * 2);
  }
  fs.writeFileSync(file, out);
}

async function launch(wav) {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-audio-capture=' + wav,
      '--autoplay-policy=no-user-gesture-required', '--mute-audio'
    ]
  });
}

async function prepare(page, base, width, height) {
  await page.setViewport({ width, height });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('tt.splashOff', 'true');
    localStorage.setItem('tt.demoDone', 'true');
  });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.TT && TT.app && TT.app.currentView === 'home');
}

async function noOverflow(page, label) {
  const sizes = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(sizes.scroll <= sizes.inner + 1, `${label} overflow: ${sizes.scroll} > ${sizes.inner}`);
}

async function uniqueHomeTools(page, label) {
  const shown = await page.evaluate(() => {
    const visible = el => el.getClientRects().length > 0;
    return {
      targets: [...document.querySelectorAll('#view-home .feature-card, #view-home .more-scroll button')]
        .filter(visible).map(el => el.dataset.openView),
      privacyNotices: [...document.querySelectorAll('#view-home .feature-banner, #view-home .home-device-pill')]
        .filter(visible).length
    };
  });
  const expected = ['tune', 'metronome', 'record', 'listening', 'lyrics', 'songs', 'styles',
    'maker', 'stems', 'backing', 'learn', 'tools', 'rig', 'hookup', 'mine', 'progress', 'care', 'settings'];
  assert.deepStrictEqual(shown.targets.slice().sort(), expected.sort(), `${label}: each tool appears once`);
  assert.strictEqual(shown.privacyNotices, 1, `${label}: privacy message appears once`);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trill-ui-'));
  browser = await launch(path.join(root, 'test', 'e2_in_tune.wav'));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await prepare(page, base, 1440, 900);

  assert.strictEqual(await page.$eval('#view-home', el => el.classList.contains('active')), true);
  assert.strictEqual(await page.$$eval('.feature-card', els => els.length), 18);
  await uniqueHomeTools(page, 'desktop home');
  assert.strictEqual(await page.$eval('img.logo', el => el.complete && el.naturalWidth === 192), true,
    'the supplied icon is used in the app header');
  assert.strictEqual(await page.$eval('.brand', el => el.getAttribute('aria-label')), 'Trill Tuner home');
  assert.strictEqual(await page.$eval('.brand', el => el.textContent.trim()), '',
    'the header does not repeat the name already in the icon');
  assert.strictEqual(await page.$eval('#splash-title', el => el.textContent), 'Trill Tuner');
  assert.strictEqual(await page.$eval('#splash-credit', el => el.textContent), 'by Brian Cross');
  assert.strictEqual(await page.$('#nav .nav-foot'), null, 'no repeated drawer branding');
  const badLinks = await page.$$eval('[data-open-view]', els => els.map(el => el.dataset.openView)
    .filter(id => !document.getElementById('view-' + id)));
  assert.deepStrictEqual(badLinks, [], 'every home and dock destination must exist');
  await noOverflow(page, 'desktop home');
  console.log('PASS desktop home, all tool destinations, and no overflow');

  await page.click('.feature-card[data-open-view="metronome"]');
  assert.strictEqual(await page.evaluate(() => TT.app.currentView), 'metronome');
  await page.click('#btn-metro-start');
  assert.match(await page.$eval('#btn-metro-start', el => el.textContent), /stop/i);
  await page.click('#btn-metro-start');
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => TT.app.showView('progress'));
  assert(await page.$eval('#lb-password', el => el.getBoundingClientRect().width >= 200), 'leaderboard password input fits the themed form');
  await page.click('[data-open-view="home"].brand');
  await page.click('#btn-menu');
  await sleep(300);
  assert.strictEqual(await page.$eval('#btn-menu', el => el.getAttribute('aria-expanded')), 'true');
  assert.strictEqual(await page.$eval('#nav', el => el.hasAttribute('inert')), false);
  await page.click('.sidenav [data-view="settings"]');
  assert.strictEqual(await page.evaluate(() => TT.app.currentView), 'settings');
  assert.strictEqual(await page.$eval('#btn-menu', el => el.getAttribute('aria-expanded')), 'false');
  assert.strictEqual(await page.$eval('#nav', el => el.hasAttribute('inert')), true);
  await page.focus('#btn-menu');
  await page.keyboard.press('Enter');
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'nav-close');
  await page.keyboard.press('Escape');
  assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'btn-menu');
  assert.strictEqual(await page.$eval('#nav', el => el.getAttribute('aria-hidden')), 'true');
  await page.click('[data-open-view="home"].brand');
  console.log('PASS feature cards, metronome, and accessible drawer navigation');

  // Existing notices disappear on entry, and no new popups can cover the tuner.
  await page.evaluate(() => TT.app.toast('A notice from another tool'));
  assert.strictEqual(await page.$$eval('#toasts .toast', els => els.length), 1);
  await page.click('.feature-card[data-open-view="tune"]');
  assert.strictEqual(await page.$eval('.tuner-heading h2', el => el.textContent), 'Tuner',
    'the tuner has a useful page heading without repeating the app name');
  assert.strictEqual(await page.$$eval('#toasts .toast', els => els.length), 0);
  const earned = await page.evaluate(() => {
    TT.app.toast('A tuning notification');
    TT.app.assist('Assistant message remains in the log', { toast: true });
    TT.store.set('lessonsDone', ['ui-test']);
    return TT.share.checkBadges(false).map(badge => badge.id);
  });
  assert(earned.includes('lesson-1'), 'achievements still unlock without covering the tuner');
  assert.strictEqual(await page.$$eval('#toasts .toast', els => els.length), 0);
  assert.match(await page.$eval('#assistant-log', el => el.textContent), /Assistant message remains/);
  assert.strictEqual(await page.evaluate(() => {
    const wave = document.querySelector('.wave-wrap');
    return !wave.contains(document.getElementById('mic-controls')) && !wave.contains(document.getElementById('strum-panel'));
  }), true, 'mic and strum panels do not cover the waveform');
  await page.evaluate(() => TT.tuner.stopMic());
  await page.click('#btn-strum');
  assert.match(await page.$eval('#strum-feedback', el => el.textContent), /needs the mic/i);
  assert.strictEqual(await page.$$eval('#toasts .toast', els => els.length), 0);
  await page.evaluate(() => TT.app.showView('tune'));
  console.log('PASS tuner stays clear of popups and retains inline feedback');
  assert.strictEqual(await page.evaluate(() => TT.tuner.state.tuningMode), 'guitar');
  assert.deepStrictEqual(await page.$$eval('#tuner-strings button', els => els.map(el => el.textContent)), ['E', 'A', 'D', 'G', 'B', 'E']);
  assert.strictEqual(await page.$eval('#tuner-gauge-note', el => el.textContent), '–');
  await page.click('#tuner-mic');
  await page.waitForFunction(() => document.getElementById('tuner-gauge-note').textContent === 'E'
    && document.getElementById('tuner-gauge-status').textContent === 'IN TUNE', { timeout: 12000 });
  const live = await page.evaluate(() => ({
    freq: TT.tuner.state.freq,
    mic: TT.audio.micState,
    label: document.getElementById('tuner-mic-label').textContent,
    needle: document.getElementById('tuner-needle').style.transform
  }));
  assert(Math.abs(live.freq - 82.407) < 1, `real E2 frequency: ${live.freq}`);
  assert.strictEqual(live.mic, 'on');
  assert.match(live.label, /LISTENING/);
  assert.match(live.needle, /rotate/);
  await page.click('#btn-strum');
  await page.waitForFunction(() => document.querySelectorAll('#strum-rows .strum-row:not(.wait)').length === 6, { timeout: 10000 });
  assert.strictEqual(await page.evaluate(() => {
    const wave = document.querySelector('.wave-wrap').getBoundingClientRect();
    const panel = document.getElementById('strum-panel').getBoundingClientRect();
    return !document.getElementById('strum-panel').hidden && panel.top >= wave.bottom;
  }), true, 'strum results appear below the waveform, not over it');
  assert.strictEqual(await page.$$eval('#toasts .toast', els => els.length), 0);
  await page.click('#strum-close');
  await page.evaluate(() => TT.app.showView('tune'));
  await page.click('#tuner-mic');
  assert.strictEqual(await page.$eval('#tuner-gauge-note', el => el.textContent), '–');
  assert.strictEqual(await page.evaluate(() => TT.audio.micState), 'off');
  await page.click('[data-tuner-mode="chromatic"]');
  assert.strictEqual(await page.evaluate(() => TT.tuner.state.tuningMode), 'chromatic');
  await page.click('#tuner-strings [data-i="2"]');
  assert.strictEqual(await page.evaluate(() => TT.tuner.state.tuningMode), 'guitar');
  assert.strictEqual(await page.$eval('#tuner-strings [data-i="2"]', el => el.getAttribute('aria-pressed')), 'true');
  console.log('PASS real guitar pitch, mic start/stop, mode switching, and string selection');

  await page.evaluate(() => { document.body.scrollTop = 600; });
  await page.evaluate(() => TT.app.showView('home'));
  assert.strictEqual(await page.evaluate(() => document.body.scrollTop), 0, 'navigating resets the body scroll');
  for (const width of [320, 390, 768]) {
    await page.setViewport({ width, height: 844 });
    await page.evaluate(() => TT.app.showView('home'));
    await uniqueHomeTools(page, `${width}px home`);
    await noOverflow(page, `${width}px home`);
    if (width <= 700) {
      const menu = await page.$eval('#btn-menu', el => ({ width: el.getBoundingClientRect().width, icon: el.querySelector('svg').getBoundingClientRect().width }));
      assert(menu.width >= 35 && menu.icon >= 18, `${width}px: menu and icon retain their tap target`);
      assert.strictEqual(await page.$$eval('.more-scroll button', els => els.every(el => {
        const box = el.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      })), true, `${width}px: every extra tool is visible without horizontal scrolling`);
    }
    await page.evaluate(() => TT.app.showView('tune'));
    await noOverflow(page, `${width}px tuner`);
    const dock = await page.$eval('.studio-dock', el => {
      const box = el.getBoundingClientRect();
      return box.left >= -1 && box.right <= innerWidth + 1 && box.height > 40;
    });
    assert(dock, `${width}px navigation dock should fit`);
  }
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => TT.app.showView('progress'));
  assert(await page.$eval('#lb-password', el => el.getBoundingClientRect().width >= 200), 'leaderboard password input fits the themed form');
  await page.click('[data-open-view="home"].brand');
  await page.click('#btn-menu');
  await sleep(300);
  await page.click('.sidenav [data-view="stems"]');
  assert.strictEqual(await page.evaluate(() => TT.app.currentView), 'stems');
  console.log('PASS 320px, 390px, and tablet layouts, plus mobile drawer navigation');
  assert.deepStrictEqual(errors, [], 'no client-side JavaScript errors');

  // A fresh launch has one logo and one helpful tuning message, not two welcomes.
  const freshContext = await browser.createBrowserContext();
  const fresh = await freshContext.newPage();
  await fresh.setViewport({ width: 390, height: 844 });
  await fresh.evaluateOnNewDocument(() => {
    localStorage.setItem('tt.lyricsFavs', JSON.stringify([{
      title: 'Saved Song', artist: 'Saved Artist', source: 'Trill Tuner library',
      lyrics: 'Saved Song\nSaved Artist\n\nPlay-along chart from the Trill Tuner library\n\nKey C · 100 BPM'
    }]));
  });
  await fresh.goto(base, { waitUntil: 'domcontentloaded' });
  await fresh.waitForSelector('#splash:not([hidden])');
  assert.strictEqual(await fresh.$eval('#splash-title', el => el.textContent), 'Trill Tuner');
  assert.strictEqual(await fresh.$eval('#splash-credit', el => el.textContent), 'by Brian Cross');
  await fresh.waitForFunction(() => document.getElementById('splash').hidden, { timeout: 5000 });
  assert.strictEqual(await fresh.$eval('#assistant-log', el =>
    (el.textContent.match(/Standard tuning is loaded/g) || []).length), 1);
  await fresh.evaluate(() => TT.app.showView('lyrics'));
  await fresh.click('#lyr-favs button');
  const legacy = await fresh.evaluate(() => {
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText(text) { copied = text; return Promise.resolve(); }
    } });
    document.getElementById('btn-lyr-copy').click();
    return {
      body: document.getElementById('lyr-body').textContent,
      source: document.getElementById('lyr-src').textContent,
      stored: TT.store.get('lyricsFavs', [])[0].lyrics,
      copied
    };
  });
  assert.strictEqual(legacy.body, 'Play-along chart\n\nKey C · 100 BPM');
  assert.strictEqual(legacy.source, 'Play-along chart · Built-in library');
  assert.match(legacy.stored, /^Saved Song\nSaved Artist/,
    'cleaning the display must not mutate saved favorites');
  assert.strictEqual(legacy.copied, 'Saved Song — Saved Artist\n\nPlay-along chart\n\nKey C · 100 BPM');
  await freshContext.close();
  console.log('PASS single splash identity, welcome, and saved-chart display');

  // C-sharp is not an open standard-guitar string. This exercises the actual
  // chromatic detection path, not a hard-coded or decorative readout.
  const cSharp = path.join(tempDir, 'csharp-sharp.wav');
  toneWav(cSharp, 277.1826 * Math.pow(2, 20 / 1200));
  chromaticBrowser = await launch(cSharp);
  const chromatic = await chromaticBrowser.newPage();
  await prepare(chromatic, base, 390, 844);
  await chromatic.click('.feature-card[data-open-view="tune"]');
  await chromatic.click('[data-tuner-mode="chromatic"]');
  if (await chromatic.evaluate(() => TT.audio.micState !== 'on')) await chromatic.click('#tuner-mic');
  await chromatic.waitForFunction(() => document.getElementById('tuner-gauge-note').textContent === 'C♯'
    && document.getElementById('tuner-gauge-status').textContent.includes('SHARP'), { timeout: 12000 });
  const pitch = await chromatic.evaluate(() => ({ cents: TT.tuner.state.cents, active: TT.tuner.state.active,
    needle: document.getElementById('tuner-needle').style.transform }));
  assert(pitch.cents > 15 && pitch.cents < 25, `chromatic cents: ${pitch.cents}`);
  assert.strictEqual(pitch.active, -1, 'a non-string chromatic note must not lock a guitar string');
  assert(parseFloat(pitch.needle.replace('rotate(', '')) > 0, 'a sharp note moves the needle right');
  await chromatic.click('#tuner-mic');
  await chromatic.evaluate(() => TT.app.showView('settings'));
  await chromatic.click('[data-appearance="sun"]');
  assert.strictEqual(await chromatic.evaluate(() => TT.store.get('settings', {}).tuningMode), 'chromatic');
  await chromatic.click('[data-appearance="night"]');
  console.log('PASS live non-guitar chromatic note, needle direction, and settings persistence');

  const deniedContext = await chromaticBrowser.createBrowserContext();
  const denied = await deniedContext.newPage();
  await denied.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) });
  });
  await prepare(denied, base, 390, 844);
  await denied.click('.feature-card[data-open-view="tune"]');
  await denied.click('#tuner-mic');
  await denied.waitForFunction(() => document.getElementById('tuner-mic-label').textContent === 'MIC UNAVAILABLE');
  assert.match(await denied.$eval('#tuner-mic-hint', el => el.textContent), /permission was denied/i);
  assert.strictEqual(await denied.$eval('#tuner-newtab', el => el.hidden), false);
  console.log('PASS microphone permission error and recovery guidance');
  await deniedContext.close();

  const unsupportedContext = await chromaticBrowser.createBrowserContext();
  const unsupported = await unsupportedContext.newPage();
  await unsupported.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
  });
  await prepare(unsupported, base, 390, 844);
  await unsupported.click('.feature-card[data-open-view="tune"]');
  await unsupported.click('#tuner-mic');
  await unsupported.waitForFunction(() => document.getElementById('tuner-mic-label').textContent === 'MIC UNAVAILABLE');
  assert.match(await unsupported.$eval('#tuner-mic-hint', el => el.textContent), /Web Audio not supported/i);
  await unsupportedContext.close();
  console.log('PASS unsupported Web Audio error handling');

  console.log('\n✅ Neon studio UI tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (chromaticBrowser) await chromaticBrowser.close();
  await new Promise(resolve => server.close(resolve));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});
