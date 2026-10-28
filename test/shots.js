'use strict';
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs');
const shotDir = process.env.SHOT_DIR || __dirname;
fs.mkdirSync(shotDir, { recursive: true });
async function goToView(page, view) {
  await page.evaluate(id => window.TT.app.showView(id), view);
}
(async () => {
  const browser = await puppeteer.launch({ args: [
    '--no-sandbox','--disable-setuid-sandbox',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(__dirname,'e2_in_tune.wav')}`,
    '--autoplay-policy=no-user-gesture-required','--mute-audio'
  ]});
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#splash', { hidden: true, timeout: 10000 });
  await page.click('.feature-card[data-open-view="tune"]');
  await page.click('#tuner-mic');
  await page.waitForFunction(() => document.querySelector('#view-tune .wave-card').classList.contains('in-tune'), { timeout: 10000, polling: 150 });
  await new Promise(r => setTimeout(r, 1400)); // let a string lock + assistant populate
  await page.screenshot({ path: path.join(shotDir, 'shot-tuner.png') });

  // advanced tuner: strum check results over the wave card
  await page.click('#btn-strum');
  await page.waitForFunction(() => document.querySelectorAll('#strum-rows .strum-row:not(.wait)').length === 6, { timeout: 8000, polling: 100 });
  await page.screenshot({ path: path.join(shotDir, 'shot-strum.png') });
  await page.click('#strum-close');

  // strobe display
  await page.click('#seg-display [data-display="strobe"]');
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(shotDir, 'shot-strobe.png') });
  await page.click('#seg-display [data-display="wave"]');

  // tuning guide overlay
  await page.click('#btn-guide');
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(shotDir, 'shot-guide.png') });
  await page.click('#guide-close');

  // gig mode
  await page.click('#btn-gig');
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: path.join(shotDir, 'shot-gig.png') });
  await page.keyboard.press('Escape');

  await page.click('.seg-btn[data-mode="electric"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(shotDir, 'shot-tuner-electric.png') });
  await page.click('.seg-btn[data-mode="acoustic"]');

  // metronome with jam track playing
  await goToView(page, 'metronome');
  await page.click('#chk-jam');
  await page.click('#btn-metro-start');
  await new Promise(r => setTimeout(r, 2800));
  await page.screenshot({ path: path.join(shotDir, 'shot-metronome.png') });
  await page.click('#btn-metro-start');

  await goToView(page, 'record');
  await page.screenshot({ path: path.join(shotDir, 'shot-record.png') });

  // care view (with a string change logged + environment warning)
  await goToView(page, 'care');
  await page.click('#str-changed-btn');
  await page.type('#env-hum', '35');
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(shotDir, 'shot-care.png') });

  await goToView(page, 'learn');
  await page.screenshot({ path: path.join(shotDir, 'shot-learn.png') });
  await page.click('[data-tab="chords"]');
  await page.screenshot({ path: path.join(shotDir, 'shot-chords.png') });

  /* ---------- the newer views ---------- */
  // splash screen (clear the skip flag and reload so it shows)
  await page.evaluate(() => { try { localStorage.removeItem('tt.splashOff'); } catch (e) {} });
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 900));
  await page.screenshot({ path: path.join(shotDir, 'shot-splash.png') });
  await page.evaluate(() => window.TT.splash.dismiss());
  await new Promise(r => setTimeout(r, 700));

  // the rig: a famous rig loaded, board populated, knobs showing
  await goToView(page, 'rig');
  await page.evaluate(() => window.TT.rig.loadFamous(window.TT.wiring.CHAINS.find(c => c.id === 'gilmour')));
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: path.join(shotDir, 'shot-rig.png') });
  // a genre recipe + the wiring guide
  await page.evaluate(() => window.TT.rig.loadRecipe(window.TT.rig.recipes().find(g => g.id === 'doom')));
  await page.click('#rig-guide .tab[data-tab="recipes"]');
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(shotDir, 'shot-rig-recipes.png') });
  // pedal library / detail
  await page.click('#rig-guide .tab[data-tab="amps"]');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(shotDir, 'shot-rig-amps.png') });

  // practice studio
  await goToView(page, 'learn');
  await page.click('#learn-tabs .tab[data-tab="drills"]');
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(shotDir, 'shot-practice.png') });
  await page.click('#learn-tabs .tab[data-tab="tab"]');
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(shotDir, 'shot-riff.png') });

  // advanced tools
  await goToView(page, 'tools');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(shotDir, 'shot-tools.png') });
  await page.click('#tools-tabs .tab[data-tab="circle"]');
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(shotDir, 'shot-tools-circle.png') });
  await page.click('#tools-tabs .tab[data-tab="tension"]');
  await new Promise(r => setTimeout(r, 300));
  await page.screenshot({ path: path.join(shotDir, 'shot-tools-tension.png') });

  // progress, badges and the share card
  await goToView(page, 'progress');
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(shotDir, 'shot-progress.png') });

  await browser.close();
  console.log('screenshots done');
})().catch(e => { console.error(e); process.exit(1); });
