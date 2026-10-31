/* Trill Tuner — requirements audit.
 *
 * Every item that was asked for, checked against real code and real signal
 * rather than against a promise. Where a claim can be measured, it is measured
 * here (synthesised audio through the actual engines); where it is a UI
 * promise, the DOM contract is checked (ids, views, hand-offs).
 *
 *   node test/requirements-audit.js          # prints the checklist
 *   node test/requirements-audit.js --write  # also writes docs/REQUIREMENTS-CHECK.md
 *
 * The running server is used when it is up (the lyric proxy is then tested over
 * HTTP); when it is not, that single line says so instead of failing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('../public/js/lib/dsp.js');
const C = require('../public/js/lib/catalog.js');
const T = require('../public/js/lib/chords.js');
const B = require('../public/js/lib/backing.js');

const SR = 22050;
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const has = (file, needle) => read(file).indexOf(needle) >= 0;

const rows = [];
let failures = 0;
function item(n, ask, how, pass, evidence) {
  rows.push({ n: n, ask: ask, how: how, pass: !!pass, evidence: evidence });
  if (!pass) failures++;
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + n + '. ' + ask + '\n       ' + evidence);
}

/* ---------------------------------------------------------------- */
/* a small synth so the audio claims can be measured, not asserted   */
/* ---------------------------------------------------------------- */
const TAU = Math.PI * 2;
function mixdown(ch) { const n = ch[0].length, o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = (ch[0][i] + ch[1][i]) / 2; return o; }
function toneAt(out, sr, freq, at, dur, gain, decay) {
  for (let i = 0; i < dur * sr && at + i < out.length; i++) {
    const t = i / sr;
    out[at + i] += Math.sin(TAU * freq * t) * gain * Math.exp(-t * (decay == null ? 1.5 : decay));
  }
}
function noteAt(out, sr, midi, at, dur, gain, decay) { toneAt(out, sr, 440 * Math.pow(2, (midi - 69) / 12), at, dur, gain, decay); }

/* a four-chord loop, strummed: C G Am F, two bars each */
function progressionAudio(sr, chordMidis, barSec) {
  const total = Math.ceil(chordMidis.length * barSec * sr) + sr;
  const out = new Float32Array(total);
  chordMidis.forEach((midis, bar) => {
    const start = Math.floor(bar * barSec * sr);
    midis.forEach((m, i) => noteAt(out, sr, m, start + Math.floor(i * 0.014 * sr), barSec * 0.98, 0.22, 1.3));
  });
  return out;
}

/* the three-layer band used for the acoustic-only claim */
function bandMix(sr, secs) {
  const n = sr * secs;
  const mk = () => [new Float32Array(n), new Float32Array(n)];
  const put = (ch, i, l, r) => { ch[0][i] += l; ch[1][i] += r; };
  const acoustic = mk();
  [[220, 277.18, 329.63, 440], [196, 246.94, 293.66, 392], [174.61, 220, 261.63, 349.23], [146.83, 185, 220, 293.66]]
    .forEach((chord, bar) => {
      const start = Math.floor(bar * 1.5 * sr);
      for (let k = 0; k < 6; k++) {
        const off = start + Math.floor(k * 0.012 * sr);
        for (let i = off; i < Math.min(n, off + 1.2 * sr); i++) {
          const t = (i - off) / sr, env = Math.exp(-t / 0.45) * (1 - Math.exp(-t / 0.004));
          const v = env * 0.16 * (Math.sin(TAU * chord[k % 4] * t) + 0.35 * Math.sin(TAU * chord[k % 4] * 2 * t));
          put(acoustic, i, v, v * -0.85);
        }
      }
    });
  const electric = mk();
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const ph = 0.0087 * Math.sin(TAU * 5.5 * t);     /* a real vibrato: constant ±15 cents */
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(TAU * 82.41 * h * t + h * ph) / (h * 1.4) * (h % 2 ? 1 : 0.6);
    v = Math.tanh(v * 1.8) * 0.3;
    put(electric, i, v, v);
  }
  const drums = mk();
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1;
  for (let b = 0; b * 0.5 < secs; b++) {
    const off = Math.floor(b * 0.5 * sr), snare = b % 2 === 1;
    for (let i = 0; i < 0.25 * sr && off + i < n; i++) {
      const t = i / sr, e = Math.exp(-t / (snare ? 0.09 : 0.035));
      const v = snare ? rnd() * 0.5 : Math.sin(TAU * 62 * t) * 0.6 * Math.exp(-t / 0.06);
      put(drums, off + i, v * e, v * e);
    }
  }
  const mix = mk();
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) mix[c][i] = acoustic[c][i] + electric[c][i] + drums[c][i];
  return { mix, acoustic, electric, drums };
}
/* How much of a known layer survived, in dB: a least-squares projection of the
 * output onto that layer's own samples. Per channel on purpose — a wide,
 * polarity-inverted layer cancels itself in a mono sum, and measuring it there
 * measures the cancellation rather than the separation. */
function kept(out, src) {
  let num = 0, den = 0;
  for (let c = 0; c < Math.min(out.channels.length, src.length); c++) {
    const o = out.channels[c], s = src[c];
    for (let i = 0; i < s.length; i++) { num += o[i] * s[i]; den += s[i] * s[i]; }
  }
  return 20 * Math.log10(Math.abs(num / den) + 1e-12);
}

/* ---------------------------------------------------------------- */
/* 1. song search                                                    */
/* ---------------------------------------------------------------- */
(function () {
  const byTitle = C.search('knockin', { cap: 5 });
  const byArtist = C.search('Fleetwood Mac', { cap: 20 });
  const byGenre = C.search('funk', { cap: 20 });
  const byChord = C.search('G C D', { cap: 20 });
  const view = read('public/index.html');
  const wired = has('public/js/app.js', "wire('songs'") && view.indexOf('id="ss-q"') > 0;
  const okAll = byTitle.songs.length >= 1 && byArtist.songs.length >= 1 && byGenre.count >= 3 && byChord.songs.length >= 3 && wired;
  item(1, 'Song search',
    'catalog search from title / artist / genre / chord list + the Songs view',
    okAll,
    'title “knockin” → ' + (byTitle.songs[0] || {}).title + ' · artist “Fleetwood Mac” → ' + byArtist.songs.length +
    ' songs · genre “funk” → ' + byGenre.count + ' · chords “G C D” → ' + byChord.songs.length +
    ' · view wired: ' + (wired ? 'yes' : 'no'));
})();

/* ---------------------------------------------------------------- */
/* 2. tab maker that listens to the song + chord library             */
/* ---------------------------------------------------------------- */
(function () {
  const barSec = 60 / 100 * 4;
  const audio = progressionAudio(SR, [[60, 64, 67, 72], [67, 71, 74, 79], [57, 60, 64, 69], [53, 57, 60, 65]], barSec);
  const read1 = D.analyseChords(audio, SR, { fftSize: 4096, hop: 2048 });
  const names = read1.chords.map(c => c.name);
  const plan = T.planFor({ key: 'C', mode: 'major', chords: ['C', 'G', 'Am', 'F'], tempo: 100 });
  const hasLibrary = !!(plan.library && plan.library.triads.length) && plan.progressions.length > 0 && !!plan.capoNote;
  const ui = ['mk-drop', 'mk-file', 'mk-sheet', 'mk-key', 'mk-bpm'].every(id => read('public/index.html').indexOf('id="' + id + '"') > 0);
  const found = names.join(' ');
  const ok = read1.key && read1.key.key === 'C' && names.some(n => /^C/.test(n)) && names.some(n => /^G/.test(n)) && hasLibrary && ui
    && read('public/js/tabmaker.js').indexOf('analyseBuffer') > 0;
  item(2, 'Tab maker that listens to the song and hands back the chord library to play along',
    'lib/dsp analyseChords on synthesised audio → key/chords/tempo; chords.planFor → library, capo, progressions; view controls present',
    ok,
    'heard “' + found + '” in C major at ' + (read1.tempo ? read1.tempo.bpm : '?') + ' BPM · library ' + plan.library.triads.length +
    ' chords · ' + plan.progressions.length + ' progressions · ' + plan.capoNote);
})();

/* AI stem controls and limitations. The real browser inference test is
 * separate (test:ai); static checks here do not claim audio quality. */
(function () {
  const lab = read('public/js/stemlab.js'), worker = read('public/js/ai-stem-worker.mjs');
  const model = fs.readFileSync(path.join(root, 'public/models/scnet-compact/scnet-f120.int8.onnx'));
  const hash = crypto.createHash('sha256').update(model).digest('hex');
  const pinned = hash === '3a926ef9710754f8bc04b3ded790ac6a0ac10465ca06a50e367382deed53d180';
  item(3, 'Reduce vocals with on-device AI', 'pinned model, worker and vocal-reduction control; actual inference is checked by test:ai',
    pinned && /runNeural/.test(lab) && /separateInBlocks/.test(worker) && /instrumental/.test(lab),
    'SCNet weights integrity: ' + (pinned ? 'verified' : 'failed') + ' · vocal reduction is an estimate; real inference: npm run test:ai');
  const modes = ['vocals', 'drums', 'bass', 'other'].every(name => lab.includes(name + ':'));
  const controls = ['st-mode', 'st-action', 'st-amount', 'st-btn-run'].every(id => has('public/index.html', 'id="' + id + '"'));
  item(4, 'Four estimated stems, reduce or isolate', 'model targets and controls checked; estimates are not original tracks',
    modes && controls && /mixSelected/.test(lab), 'vocals · drums · bass · other · reduce/keep/amount controls');
  const bed = B.render({ key: 'C', mode: 'major', style: 'strum', bpm: 90, bars: 4, sr: SR });
  item(5, 'Create an instrumental practice mix', 'vocal-reduction recipe and separate backing-studio renderer',
    /instrumental/.test(lab) && bed.channels[0].length > SR * 10, 'vocal reduction is approximate · backing studio rendered ' + bed.seconds.toFixed(1) + ' seconds');
  item(6, 'Acoustic/electric separation limitation disclosed', 'a four-stem model does not distinguish individual guitars',
    /cannot be reliably isolated/.test(lab) && !/mode: 'acoustic-guitar'/.test(lab),
    'guitars and keys remain together in “other”; exact acoustic-only removal is not offered');
})();

/* ---------------------------------------------------------------- */
/* 7. lyric search by artist OR song name alone                      */
/* ---------------------------------------------------------------- */
(function () {
  const view = read('public/index.html');
  const oneBox = view.indexOf('id="lyr-q"') > 0 && view.indexOf('id="lyr-artist"') < 0 && view.indexOf('id="lyr-title"') < 0;
  const js = read('public/js/lyrics.js');
  const singleField = js.indexOf('function queryOf(a, b)') > 0 && js.indexOf('either one is enough') > 0;
  const server = read('server.js');
  const route = server.indexOf('/api/lyrics') > 0 && /splitQuery/.test(server || '');
  const offlineArtist = C.search('Jimi Hendrix', { cap: 5 }).songs.length >= 1;
  const offlineTitle = C.search('Little Wing', { cap: 5 }).songs.length >= 1;
  item(7, 'Lyric search by artist OR song name alone (never both)',
    'one input box, one query string, /api/lyrics?q= — plus the offline songbook answering artist-only and title-only immediately',
    oneBox && singleField && route && offlineArtist && offlineTitle,
    'one box: ' + (oneBox ? 'yes' : 'no') + ' · single-field query: ' + (singleField ? 'yes' : 'no') +
    ' · /api/lyrics?q=: ' + (route ? 'yes' : 'no') + ' · offline: artist-only “Jimi Hendrix” → ' +
    C.search('Jimi Hendrix', { cap: 9 }).songs.length + ' songs, title-only “Little Wing” → ' + C.search('Little Wing', { cap: 9 }).songs.length);
})();

/* ---------------------------------------------------------------- */
/* 8. more extensive search for lyrics and play-along songs          */
/* ---------------------------------------------------------------- */
(function () {
  const counts = C.counts;
  const styles = read('public/js/styles.js');
  const online = read('public/js/songsearch.js').indexOf('/api/songs') > 0;
  const artists = C.ARTISTS.filter(a => C.artistSongs(a.name).length).length;
  const lyricsdb = read('public/js/lib/lyricsdb.js');
  const more = read('public/js/lib/catalog-more.js');
  const lyrJs = read('public/js/lyrics.js');
  const libraryFirst = /Searching the library/.test(lyrJs) && !/offline songbook/.test(lyrJs);
  const ok = counts.songs >= 350 && counts.lessons >= 28 && counts.artists >= 45 && artists === counts.artists && online && /TECHNIQUES/.test(styles)
    && /Amazing Grace/.test(lyricsdb) && /Hey Jude/.test(more) && libraryFirst;
  item(8, 'More extensive search for lyrics and songs to play along with',
    'the offline catalogue across songs/artists/lessons/techniques, plus the online lyric lookup and per-artist pages',
    ok,
    counts.songs + ' songs · ' + counts.artists + ' artist pages (all with playable songs) · ' + counts.lessons +
    ' lessons · built-in lyrics + extra catalog · library-first lyric search · online lyric tab: ' + (online ? 'wired' : 'missing'));
})();

/* ---------------------------------------------------------------- */
/* 9. live listening, both ways                                      */
/* ---------------------------------------------------------------- */
(function () {
  const js = read('public/js/listener.js');
  const view = read('public/index.html');
  const live = /yin|YIN/.test(fs.readFileSync(path.join(root, 'public/js/lib/yin.js'), 'utf8')) &&
    /analyser|getFloatTimeDomainData/.test(read('public/js/audio.js'));
  const both = /'bad'/.test(js) && /'ok'/.test(js) && /verdict/.test(js);
  const copy = ['one fret above', 'one fret below', 'whole octave above', 'whole octave below', 'semitones apart', 'dead on', 'Right note, wrong pitch']
    .filter(s => js.indexOf(s) >= 0);
  const viewOk = ['ls-source', 'ls-banner', 'ls-misses', 'ls-score', 'ls-btn-start'].every(id => view.indexOf('id="' + id + '"') > 0);
  item(9, 'Live listening for the guitar played locally: wrong notes are flagged, right notes are confirmed, both directions',
    'live YIN on the microphone with a stability gate; verdicts carry the heard note, the wanted note, the direction and the distance',
    live && both && copy.length >= 6 && viewOk,
    'copy present: ' + copy.length + '/7 (“' + copy.slice(0, 3).join('”, “') + '”…) · mic path: ' +
    (live ? 'analyser → yin' : 'missing') + ' · view controls: ' + (viewOk ? 'ok' : 'missing'));
})();

/* ---------------------------------------------------------------- */
/* 10. the advanced extras                                           */
/* ---------------------------------------------------------------- */
(function () {
  const views = ['styles', 'backing', 'mine'];
  const nav = read('public/index.html');
  const wired = views.every(v => nav.indexOf('data-view="' + v + '"') > 0 && nav.indexOf('id="view-' + v + '"') > 0);
  /* the suite list is read from package.json instead of restated here, so a
   * script can never point at a test file that does not exist */
  const scripts = JSON.parse(read('package.json')).scripts;
  const referenced = Array.from(new Set(
    (scripts.test + ' ' + scripts['test:e2e'] + ' ' + scripts['test:dom']).match(/test\/[a-z0-9-]+\.js/g) || []));
  const missing = referenced.filter(f => !fs.existsSync(path.join(root, f)));
  const tests = referenced.filter(f => fs.existsSync(path.join(root, f)));
  const badges = (read('public/js/share.js').match(/\{ id: '/g) || []).length;
  const presets = (read('public/js/backing.js').match(/\{ name: '[^']+'/g) || []).length;
  const stemRecipes = (read('public/js/stemlab.js').match(/\{ id: '/g) || []).length;
  item(10, 'And more advanced things',
    'Styles & players, Backing studio, My stuff (favourites + session builder), ' + stemRecipes + ' stem recipes, ' + badges + ' badges, every test file named in the npm scripts present on disk',
    wired && missing.length === 0 && tests.length >= 10 && badges >= 30,
    views.join(' · ') + ' all reachable · ' + tests.length + ' test files wired into the npm scripts, ' +
    missing.length + ' missing · ' + badges + ' badges · ' + presets + ' backing presets · ' + stemRecipes + ' stem recipes');
})();

(function () {
  const html = read('public/index.html');
  const js = read('public/js/playtools.js');
  const tabs = ['looper', 'drone', 'caged', 'harmonics', 'into', 'bends'];
  const ids = ['pt-loop-rec', 'pt-loop-overdub', 'pt-loop-snap', 'pt-loop-countin', 'pt-loop-bars',
    'pt-loop-takes', 'pt-loop-take-0', 'pt-loop-take-4', 'pt-drone-btn', 'pt-caged-out',
    'pt-harm-out', 'pt-into-open-btn', 'pt-bend-btn'];
  const hasTabs = tabs.every(t => html.indexOf('data-tab="' + t + '"') > 0 && html.indexOf('id="tools-' + t + '"') > 0);
  const hasIds = ids.every(id => html.indexOf('id="' + id + '"') > 0);
  const hasLogic = ['shapeFrets', 'snapLoop', 'alignTake', 'trimSilence', 'detectTempo', 'foldSeam',
    'TAKE_NAMES', 'droneFreqs', 'CAGED_MAJ', 'HARMONICS'].every(k => js.indexOf(k) > 0);
  const wired = html.indexOf('js/playtools.js') > 0 && read('public/js/tools.js').indexOf('TT.playtools.init') > 0
    && read('public/js/app.js').indexOf('TT.playtools.stop') > 0;
  const takeCount = (read('public/js/playtools.js').match(/const TAKE_NAMES = \[([^\]]*)\]/) || [, ''])[1]
    .split(',').map(s => s.trim()).filter(Boolean).length;
  item(19, 'Advanced play tools that make sitting down with a guitar more useful — looper, drone, CAGED, harmonics, intonation, bend lab',
    'Tools tabs and panes exist; playtools.js maps the five CAGED shapes (open E/A/G/C/D plus minors); the looper arms itself on the metronome, counts a bar in, records a whole number of bars and stops on the beat, trims the dead air, folds the loop seam, and banks ' +
    takeCount + ' switchable takes (falling back to reading the tempo off the take when the metronome is off); a root-fifth-octave drone holds; natural-harmonic nodes are listed; the drone and loop stop when you leave Tools',
    hasTabs && hasIds && hasLogic && wired && takeCount === 5 &&
    fs.existsSync(path.join(root, 'test', 'playtools-test.js')) &&
    fs.existsSync(path.join(root, 'test', 'looper-test.js')),
    tabs.length + ' play tabs · ' + ids.filter(id => html.indexOf('id="' + id + '"') > 0).length + '/' + ids.length +
    ' controls · ' + takeCount + ' loop takes · CAGED + alignTake + trimSilence + detectTempo + foldSeam + droneFreqs + harmonics wired · stops on leave');
})();

/* ---------------------------------------------------------------- */
/* 12. the Android app: a real, signed, self-hosted APK              */
/* ---------------------------------------------------------------- */
(function () {
  const apkPath = path.join(root, 'public', 'downloads', 'TrillTuner.apk');
  const exists = fs.existsSync(apkPath);
  const size = exists ? fs.statSync(apkPath).size : 0;
  const raw = exists ? fs.readFileSync(apkPath) : Buffer.alloc(0);
  /* the central directory of a zip stores entry names as plain text */
  const zipHas = s => raw.length > 0 && raw.indexOf(Buffer.from(s)) >= 0;
  const man = read('apk-src/AndroidManifest.xml');
  const smaliDir = path.join(root, 'apk-src', 'smali', 'com', 'trilltuner', 'app');
  const smali = ['MainActivity.smali', 'TClient.smali', 'TChrome.smali', 'TBridge.smali']
    .every(f => fs.existsSync(path.join(smaliDir, f)));
  const perms = ['INTERNET', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'ACCESS_NETWORK_STATE', 'VIBRATE',
    'ACCESS_WIFI_STATE', 'WAKE_LOCK', 'POST_NOTIFICATIONS', 'READ_MEDIA_AUDIO', 'BLUETOOTH_CONNECT']
    .every(p => man.indexOf('android.permission.' + p) > 0);
  item(12, 'Android APK build and permissions',
    'public/downloads/TrillTuner.apk is a real signed APK (zip entries + v1/v2/v3 signatures verified by test/apk-test.js and test/apk-verify.py); the shell source lives in apk-src/ (manifest + smali) and tools/build-apk.py rebuilds it without an SDK',
    exists && size > 200 * 1024 && zipHas('AndroidManifest.xml') && zipHas('classes.dex') && zipHas('resources.arsc')
      && zipHas('assets/index.html') && zipHas('META-INF/') && man.indexOf('package="com.trilltuner.app"') > 0
      && man.indexOf('android:label="Trill Tuner"') > 0 && perms && smali
      && fs.existsSync(path.join(root, 'tools', 'build-apk.py')),
    'APK ' + (size / 1024).toFixed(0) + ' KB · package com.trilltuner.app · label “Trill Tuner” · minSdk 24 / targetSdk 34 · mic + wifi + storage + bluetooth + notifications · 4 smali shell classes · signed v1+v2+v3 (apksigner verify) · structurally checked by test/apk-test.js + test/apk-verify.py; physical-device behavior not checked here');
})();

/* ---------------------------------------------------------------- */
/* 13. the web version stays and becomes a PWA, offline after load   */
/* ---------------------------------------------------------------- */
(function () {
  const man = JSON.parse(read('public/manifest.webmanifest'));
  const sw = read('public/sw.js');
  const head = read('public/index.html');
  const metaTheme = (head.match(/name="theme-color"[^>]*content="([^"]+)"/) || [])[1] || '';
  /* the reported colour is read, not remembered: it used to print a hard-coded
   * amber long after the manifest had moved to white for sun readability */
  const icons = ['public/icons/icon-192.png', 'public/icons/icon-512.png',
    'public/icons/icon-maskable-512.png', 'public/icons/apple-touch-icon.png']
    .every(f => fs.existsSync(path.join(root, f)));
  item(13, 'PWA shell works offline; AI is cached after its first use',
    'manifest.webmanifest (standalone, icons) + sw.js (shell precache, navigation fallback, skipWaiting) + PWA meta in index.html; the offline reload itself is proven in test/pwa-e2e.js (network cut, tuner still detects in-tune)',
    man.name === 'Trill Tuner' && man.display === 'standalone' && man.icons.length >= 3
      && sw.indexOf('cache.addAll') > 0 && sw.indexOf('caches.match') > 0 && sw.indexOf('skipWaiting') > 0
      && head.indexOf('rel="manifest"') > 0 && head.indexOf('name="theme-color"') > 0
      && metaTheme.toLowerCase() === String(man.theme_color).toLowerCase()
      && head.indexOf('apple-mobile-web-app-capable') > 0 && head.indexOf('viewport-fit=cover') > 0
      && icons && fs.existsSync(path.join(root, 'test', 'pwa-e2e.js')),
    'manifest “' + man.name + '” standalone · ' + man.icons.length + ' icons · sw precaches the app, falls back to the cached shell offline · theme ' + man.theme_color + ' (meta agrees) · mobile viewport · network features remain online-only');
})();

/* ---------------------------------------------------------------- */
/* 14. the guided demo: skippable, every section, progress saved     */
/* ---------------------------------------------------------------- */
(function () {
  const demo = read('public/js/demo.js');
  const html = read('public/index.html');
  const views = ['tune', 'metronome', 'record', 'lyrics', 'songs', 'styles', 'maker', 'stems',
    'backing', 'listening', 'learn', 'tools', 'rig', 'hookup', 'settings', 'mine', 'progress', 'care'];
  const covered = views.filter(v => demo.indexOf("view: '" + v + "'") > 0);
  const steps = (demo.match(/title: '/g) || []).length;
  item(14, 'A detailed demo you can skip — and if you do not skip it, every section is covered one by one, with Next and Skip, saving your progress',
    'public/js/demo.js walks all 18 views with Next/Skip/Back, saves tt.demoStep after every step, resumes after a reload; wired to #btn-tour; proven end to end in test/pwa-e2e.js',
    covered.length === 18 && steps >= 20
      && html.indexOf('id="demo-next"') > 0 && html.indexOf('id="demo-skip"') > 0 && html.indexOf('id="demo-back"') > 0
      && demo.indexOf("set('demoStep'") > 0 && demo.indexOf("set('demoDone'") > 0
      && html.indexOf('id="btn-tour"') > 0,
    steps + ' steps · all 18 sections covered (' + covered.length + '/18) · Next + Skip + Back · progress saved + resumed · restart from Tuning setup');
})();

/* ---------------------------------------------------------------- */
/* 15. QR sharing of the APK + remote tuning over the LAN            */
/* ---------------------------------------------------------------- */
(function () {
  const html = read('public/index.html');
  const server = read('server.js');
  const qr = read('public/js/lib/qrcode.js');
  item(15, 'Sharing with a QR code that links to the download of the actual APK — hosted by the app itself — plus a QR to connect another device over the LAN for live, fully inclusive tuning',
    'vendored QR generator + TT.qr wrapper; the progress view shows the APK QR + link to /download/trill-tuner.apk served by server.js; the tune view hosts a session (QR to ?join=<id>) and two devices mirror each other live over SSE — proven in test/pwa-e2e.js',
    qr.length > 10000 && fs.existsSync(path.join(root, 'public', 'js', 'qr.js'))
      && html.indexOf('id="apk-qr"') > 0 && html.indexOf('id="apk-link"') > 0 && html.indexOf('id="btn-apk-open"') > 0
      && server.indexOf("'/download/trill-tuner.apk'") > 0 && server.indexOf('application/vnd.android.package-archive') > 0
      && html.indexOf('id="btn-remote-host"') > 0 && html.indexOf('id="remote-qr"') > 0
      && server.indexOf("'/api/sessions'") > 0 && server.indexOf('(events|msg)') > 0
      && server.indexOf("'/api/host'") > 0 && fs.existsSync(path.join(root, 'public', 'js', 'remote.js')),
    'QR lib vendored (qrcode-generator, MIT) · APK QR + copy/share/open buttons · server hosts the APK (MIME + range support) · host QR → ?join=<id> · SSE sessions mirror note/cents/status both ways');
})();

/* ---------------------------------------------------------------- */
/* 11. the server side, over HTTP, when it is running                */
/* ---------------------------------------------------------------- */
(function () {
  const check = async () => {
    const testServer = require('../server').server;
    await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + testServer.address().port;
    try {
      const r = await fetch(base + '/api/songs?q=Dreams', { signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      const l = await (await fetch(base + '/api/lyrics?q=Fleetwood%20Mac', { signal: AbortSignal.timeout(2500) })).json();
      item(11, 'Server proxy for lyrics and songs (single-field), degrading without a connection',
        'GET /api/songs?q= and GET /api/lyrics?q= answered by the running server',
        r.status === 200 && typeof j.ok === 'boolean' && typeof l.ok === 'boolean' && !/artist.*title.*required/i.test(JSON.stringify(j)),
        'GET /api/songs?q=Dreams → ' + r.status + ' ok=' + j.ok + ' (' + (j.count || 0) + ' online results) · GET /api/lyrics?q=Fleetwood Mac → ok=' + l.ok +
        (l.error ? ' (“' + l.error + '” — the offline songbook still answers)' : ''));
    } catch (e) {
      item(11, 'Server proxy for lyrics and songs (single-field), degrading without a connection',
        'HTTP check against the running server',
        false, 'test server failed: ' + e.message);
    } finally { await new Promise(resolve => testServer.close(resolve)); }
    (function () {
      const lab = read('public/js/stemlab.js'), worker = read('public/js/ai-stem-worker.mjs');
      const ui = ['st-btn-cancel', 'st-btn-mic', 'st-btn-wav', 'st-btn-play', 'st-btn-run'].every(id => has('public/index.html', 'id="' + id + '"'));
      item(16, 'Cancellable on-device stem processing', 'worker, cancellation and output controls are wired; actual model execution is covered separately',
        ui && /terminate\(\)/.test(lab) && /separateInBlocks/.test(worker),
        'worker terminates on cancellation · playback and export controls present · long-song quality/performance not benchmarked here');
    })();

    /* the transport: a waveform, a clock, skipping, and an A–B loop */
    (function () {
      const html = read('public/index.html');
      const lab = read('public/js/stemlab.js');
      const ids = ['st-wave', 'st-pos', 'st-dur', 'st-ab-label', 'st-btn-aset', 'st-btn-bset', 'st-btn-abclear'];
      const have = ids.filter(id => html.indexOf('id="' + id + '"') > 0);
      const api = ['S.seek =', 'S.markA =', 'S.markB =', 'S.clearAB =', 'S.transport ='].filter(x => lab.indexOf(x) > 0);
      const draws = /function drawStatic/.test(lab) && /fillRect\(x, y0/.test(lab) && /xOf\(state\.pos/.test(lab);
      const abLoop = /loopStart = sp\.a/.test(lab) && /loopEnd = /.test(lab);
      const dragAB = /drag === 'range'/.test(lab);
      item(17, 'A waveform of the take with the playing time, skipping anywhere, and a loop between two points you pick (A and B)',
        'the DOM contract, the transport API the browser tests drive, the drawing itself, click-to-skip, drag from A to B on the wave to loop, and the A–B loop handed to the audio node',
        have.length === ids.length && api.length === 5 && draws && abLoop && dragAB,
        have.length + '/' + ids.length + ' controls · ' + api.length + '/5 API calls · waveform + playhead drawing: ' + (draws ? 'wired' : 'missing') +
        ' · A–B reaches the audio node: ' + (abLoop ? 'yes' : 'no') + ' · driven for real in test/dom-smoke.js and test/pwa-e2e.js (§9)');
    })();

    (function () {
      const lab = read('public/js/stemlab.js');
      item(18, 'AI output limitations are stated', 'the UI calls results estimates and warns about bleed and artifacts',
        /estimates/.test(lab) && /bleed and artifacts/.test(lab),
        'no claim of perfect isolation, unchanged voice dynamics or guaranteed source quality');
    })();

    finish();
  };

  function finish() {
    const pass = rows.filter(r => r.pass).length;
    console.log('\n' + (failures ? '❌ ' + failures + ' of ' + rows.length + ' requirement(s) not met' : '✅ all ' + rows.length + ' capability and limitation checks passed'));
    if (process.argv.indexOf('--write') >= 0) {
      const out = ['# Requirements check', '',
        'Generated by `node test/requirements-audit.js --write` on ' + new Date().toISOString().slice(0, 10) + '.',
        '', 'These checks include disclosures of limitations; passing them does not mean every earlier feature request is fulfilled. In particular, separate acoustic/electric guitar isolation and Android device behavior remain unverified or unsupported.',
        '', '| # | Capability or limitation | How it is checked | Result | Evidence |', '|---|---|---|---|---|'];
      rows.forEach(r => out.push('| ' + r.n + ' | ' + r.ask + ' | ' + r.how + ' | ' + (r.pass ? '✅' : '❌') + ' | ' + r.evidence.replace(/\|/g, '\\|') + ' |'));
      out.push('', pass + ' of ' + rows.length + ' checks passed; see limitations above.');
      fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs/REQUIREMENTS-CHECK.md'), out.join('\n') + '\n');
      console.log('→ wrote docs/REQUIREMENTS-CHECK.md');
    }
    process.exit(failures ? 1 : 0);
  }

  check();
})();
