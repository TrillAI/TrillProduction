/* Stem Lab: on-device SCNet neural source separation. The four outputs are
 * estimates, not the original multitrack recordings; audio is never uploaded. */
(function () {
  'use strict';

  const S = {};
  const state = {
    file: null,
    buffer: null,
    channels: null,
    sr: 44100,
    mode: 'vocals',
    remove: true,
    amount: 0.92,
    result: null,
    aiStems: null,       /* four sample-aligned Int16 stereo estimates */
    generation: 0,       /* invalidate in-flight file decodes */
    node: null,
    gain: null,
    playing: false,
    pos: 0,               /* playhead, in seconds into the result */
    a: null, b: null,     /* the A–B loop points: null = not set */
    busy: false,          /* a separation or a recording is running */
    recording: false,     /* and if it is the room recording, which can be cancelled by loading something */
    recordSeconds: 20,    /* how long the room recording runs (the tests shorten it) */
    cancel: false,        /* the user asked to stop */
    sourceName: '',
    sourceDesc: ''
  };
  let els = {};
  let worker = null;      /* background separation worker, when the page can have one */

  const PROFILE_LABEL = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other instruments' };
  const PRESETS = [
    { id: 'instrumental', label: '🎤 Reduce vocals', mode: 'vocals', remove: true, amount: 1, desc: 'A practice mix with the estimated vocal stem reduced.' },
    { id: 'acapella', label: '🎙️ Vocals', mode: 'vocals', remove: false, amount: 1, desc: 'Listen to the estimated vocal stem.' },
    { id: 'drumless', label: '🥁 Reduce drums', mode: 'drums', remove: true, amount: 1, desc: 'Make room to play along with the beat.' },
    { id: 'drumsonly', label: '🥁 Drums', mode: 'drums', remove: false, amount: 1, desc: 'Study the estimated drum stem.' },
    { id: 'bassless', label: '🎸 Reduce bass', mode: 'bass', remove: true, amount: 1, desc: 'Practice over a mix with the estimated bass reduced.' },
    { id: 'bassonly', label: '🎸 Bass', mode: 'bass', remove: false, amount: 1, desc: 'Follow the estimated bass line.' },
    { id: 'other-off', label: '🎹 Reduce other instruments', mode: 'other', remove: true, amount: 1, desc: 'Reduce the combined guitar, keys and other-instrument stem.' },
    { id: 'other-only', label: '🎸 Other instruments', mode: 'other', remove: false, amount: 1, desc: 'Guitars, keys and other sounds together, not separately.' }
  ];

  /* ---------------------------------------------------------------- */
  function decodeFile(file) {
    const ctx = TT.audio.ensure();
    return file.arrayBuffer().then(buf => new Promise((resolve, reject) => {
      const done = b => resolve(b);
      const fail = e => reject(e || new Error('Could not decode that file'));
      const p = ctx.decodeAudioData(buf, done, fail);
      if (p && typeof p.then === 'function') p.then(done, fail);
    }));
  }

  function setStatus(msg, cls) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.className = 'st-status' + (cls ? ' ' + cls : '');
  }
  function setProgress(frac) {
    if (els.bar) els.bar.style.width = Math.round(frac * 100) + '%';
    if (els.pct) els.pct.textContent = Math.round(frac * 100) + '%';
  }

  /* the little card that says what is loaded, and where it came from */
  function setSource(name, desc) {
    state.sourceName = name || '';
    state.sourceDesc = desc || '';
    if (!els.source) return;
    els.source.hidden = false;
    els.source.replaceChildren();
    const title = document.createElement('b'), detail = document.createElement('span');
    title.textContent = name; detail.textContent = desc;
    els.source.append(title, detail);
  }

  /* every new take throws the old result away — playing or exporting a previous
   * song's separation while a new one is loaded is how people get confused */
  function clearResult() {
    resetPlayer();
    state.result = null;
    state.aiStems = null;
    if (els.stemPicks) els.stemPicks.hidden = true;
    if (els.result) els.result.hidden = true;
    if (els.effect) els.effect.innerHTML = '';
    if (els.btnWav) els.btnWav.disabled = true;
    if (els.btnTab) els.btnTab.disabled = true;
    if (els.resultH) els.resultH.textContent = 'The song';
  }

  /* What the player draws and plays: the separated result if there is one,
   * otherwise the song that was just loaded. The wave, the clock, skip and
   * A–B all work on the original too — you can loop a verse *before* you
   * take it apart. */
  function playable() {
    if (state.result && state.result.channels && state.result.channels[0] && state.result.channels[0].length) {
      return state.result;
    }
    if (state.channels && state.channels[0] && state.channels[0].length) {
      return { channels: state.channels, sr: state.sr || 44100, preview: true };
    }
    return null;
  }

  /* Show the player as soon as there is audio (the original, then the result). */
  function armPlayer() {
    const src = playable();
    if (!src) { clearResult(); return; }
    if (els.result) els.result.hidden = false;
    const preview = !!src.preview;
    if (els.resultH) els.resultH.textContent = preview ? 'The song' : 'Result';
    if (els.btnWav) els.btnWav.disabled = preview;
    if (els.btnTab) els.btnTab.disabled = preview;
    if (preview && els.effect) {
      els.effect.innerHTML = '<b>The song.</b> Press play, skip anywhere on the wave, or drop A and B to loop a section. Pick a recipe and press Separate it to take it apart.';
    }
    wave.key = '';
    resetPlayer();
  }

  S.loadFile = async function (file) {
    if (!file) return;
    if (state.busy && !state.recording) cancel();
    const generation = ++state.generation;
    if (state.recording) state.recording = false;   /* the take in flight is now unwanted */
    clearResult();
    state.file = file;
    state.channels = null;
    if (els.btnRun) els.btnRun.disabled = true;
    setStatus('Decoding ' + file.name + '…');
    try {
      const buf = await decodeFile(file);
      if (generation !== state.generation) return;
      state.buffer = buf;
      state.sr = buf.sampleRate;
      state.channels = [];
      for (let c = 0; c < buf.numberOfChannels; c++) state.channels.push(buf.getChannelData(c));
      setSource(file.name, `${buf.numberOfChannels === 1 ? 'mono' : 'stereo'} · ${(buf.sampleRate / 1000).toFixed(1)} kHz · ${mmss(buf.duration)}`);
      setStatus('Loaded. Press play, skip, or set A and B — or pick a recipe to take it apart.');
      setProgress(0);
      if (els.btnRun) els.btnRun.disabled = false;
      armPlayer();
    } catch (e) {
      if (generation !== state.generation) return;
      setStatus('Could not decode that file. Try WAV, MP3 or M4A. (' + (e && e.message ? e.message : 'unknown error') + ')', 'err');
    }
  };

  /* An AudioBuffer — or a bare Float32Array of samples, which is what the mic
   * capture returns — becomes the new source. Used by the room recording, by the
   * Backing studio hand-off and by any other part of the app that already has
   * samples in memory. */
  S.loadBuffer = function (buffer, name, sampleRate) {
    if (!buffer) return false;
    if (state.busy && !state.recording) cancel();
    state.generation++;
    if (state.recording) state.recording = false;
    let buf = buffer;
    if (typeof buf.getChannelData !== 'function') {
      /* a plain mono take as returned by TT.audio.captureBuffer */
      if (typeof buf.length !== 'number' || !buf.length) return false;
      const samples = buf;
      const sr = sampleRate || (TT.audio.ctx && TT.audio.ctx.sampleRate) || state.sr;
      buf = {
        numberOfChannels: 1, sampleRate: sr, length: samples.length,
        duration: samples.length / sr, getChannelData: () => samples
      };
    }
    S.init();
    clearResult();
    state.file = null;
    state.buffer = buf;
    state.sr = buf.sampleRate || sampleRate || state.sr;
    state.channels = [];
    for (let c = 0; c < (buf.numberOfChannels || 1); c++) state.channels.push(buf.getChannelData(c));
    setSource(name || 'Audio take', `${buf.numberOfChannels === 1 ? 'mono' : 'stereo'} · ${(state.sr / 1000).toFixed(1)} kHz · ${mmss(buf.duration || state.channels[0].length / state.sr)}`);
    setProgress(0);
    if (els.btnRun) els.btnRun.disabled = false;
    armPlayer();
    return true;
  };

  /* Hand-off from another view: the Backing studio sends { channels, sr, … } and
   * a title describing the render. Nothing is uploaded and nothing is written to
   * disk — the samples go straight into this tab, ready to be taken apart. */
  S.adopt = function (res, meta) {
    if (!res) return false;
    if (state.busy && !state.recording) cancel();
    state.generation++;
    let channels = res.channels;
    if (!channels && res.getChannelData) {
      channels = [];
      for (let c = 0; c < (res.numberOfChannels || 1); c++) channels.push(res.getChannelData(c));
    }
    if (!channels || !channels.length || !channels[0] || !channels[0].length) return false;
    const sr = res.sr || res.sampleRate || state.sr;
    const seconds = res.seconds || channels[0].length / sr;
    const name = (meta && meta.title) || res.title || 'Handed-over audio';
    const detail = (meta && meta.detail) || describe(res) || 'from another part of the app';
    S.init();
    clearResult();
    state.file = null;
    state.buffer = { numberOfChannels: channels.length, sampleRate: sr, length: channels[0].length, duration: seconds };
    state.sr = sr;
    state.channels = channels;
    setSource(name, `${channels.length === 1 ? 'mono' : 'stereo'} · ${(sr / 1000).toFixed(1)} kHz · ${mmss(seconds)} · ${detail}`);
    setProgress(0);
    if (els.btnRun) els.btnRun.disabled = false;
    setStatus(name + ' loaded — press play, or pick a recipe and separate it.', 'ok');
    armPlayer();
    return true;
  };

  function describe(obj) {
    const bits = [];
    if (obj.key) bits.push('key ' + obj.key + (obj.modeName ? ' ' + obj.modeName : ''));
    if (obj.styleName) bits.push(obj.styleName);
    if (obj.bpm) bits.push(obj.bpm + ' BPM');
    if (obj.bars) bits.push(obj.bars + ' bars');
    return bits.join(' · ');
  }

  function micErrorText(e) {
    const name = (e && e.name) || '';
    const msg = (e && e.message) || 'no audio';
    if (name === 'NotAllowedError' || /permission|denied/i.test(msg)) {
      return 'Microphone permission was denied. Allow the mic for this page (the padlock in the address bar), then press the button again.';
    }
    if (name === 'NotFoundError') return 'No microphone found — plug one in, or drop a song file instead.';
    if (/Microphone is off/.test(msg)) return 'The microphone could not be started. If you are inside a preview frame, open the app in its own tab (or use the Android app) and try again.';
    return 'Microphone capture failed: ' + msg + '.';
  }

  /* 20 seconds from the room or the desk: start the mic, count down, hand the
   * take to the same pipeline the file path uses. The tab may not assume the
   * tuner already opened the mic — pressing this button is the user's gesture. */
  async function fromMic() {
    if (state.busy) return;
    state.busy = true;
    state.recording = true;
    if (els.btnMic) els.btnMic.disabled = true;
    /* nothing else can be started while the take is running, so say so rather
     * than leave a button that looks live and does nothing */
    if (els.btnRun) els.btnRun.disabled = true;
    if (els.runNote) els.runNote.textContent = 'Recording from the microphone…';
    const alreadyOn = TT.audio.micState === 'on' && !!TT.audio.micSource;
    try {
      if (!alreadyOn) {
        setStatus('Asking for the microphone — allow the browser prompt…');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('This browser blocks microphone capture here (a page opened from a file:// path or a plain-HTTP address is not allowed to use the mic). Open the app over http://localhost or install the Android app.');
        }
        await TT.audio.startMic();
      }
      setProgress(0);
      const secs = Math.max(1, Math.round(state.recordSeconds || 20));
      setStatus('Recording ' + secs + ' seconds — play the song out loud, close to the microphone…');
      const buf = await TT.audio.captureBuffer(secs, f => setProgress(f));
      const sr = (TT.audio.ctx && TT.audio.ctx.sampleRate) || state.sr;
      /* if a song was opened (or dropped) while the microphone was recording,
       * that song is what the user wants — do not overwrite it with the take */
      if (state.recording === false) {
        setStatus('The take was discarded — something else was loaded while it was recording.', '');
        setProgress(0);
        return;
      }
      if (!S.loadBuffer(buf, 'Microphone take', sr)) throw new Error('the take came back empty');
      setStatus('Recorded ' + secs + ' seconds. Pick a recipe — or record again.', 'ok');
      setProgress(1);
    } catch (e) {
      setProgress(0);
      setStatus(micErrorText(e), 'err');
    } finally {
      state.busy = false;
      state.recording = false;
      if (els.btnMic) els.btnMic.disabled = false;
      if (els.btnRun) els.btnRun.disabled = !state.channels;
      if (els.runNote) els.runNote.textContent = '';
      /* release the microphone if this button opened it */
      if (!alreadyOn && TT.audio.micState === 'on') {
        try { TT.audio.stopMic(); } catch (e) {}
      }
    }
  }

  function mmss(sec) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }

  /* ---------------- separation, on a worker when the page can have one ---------------- */
  function workerAvailable() {
    try {
      if (typeof Worker !== 'function') return false;
      if (typeof location !== 'undefined' && location.protocol === 'file:') return false;   /* module workers require an HTTP(S) origin */
      return true;
    } catch (e) { return false; }
  }

  let workerReject = null;      /* the in-flight worker request's reject, so Stop can end it */

  function cancel() {
    state.cancel = true;
    const reject = workerReject;
    workerReject = null;
    if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
    if (reject) {
      const err = new Error('separation stopped');
      err.aborted = true;
      reject(err);                       /* a terminated worker never answers */
    }
    setStatus('Stopping…');
  }

  /* Only a real trained model is used here. A failure is reported, not silently
   * replaced with spectral masking. The worker is killed on stop and on finish. */
  function runNeural() {
    return new Promise((resolve, reject) => {
      if (!workerAvailable()) { reject(new Error('This browser cannot start the AI worker. Use a current browser or update the app.')); return; }
      let w;
      try { w = new Worker(new URL('js/ai-stem-worker.mjs', document.baseURI), { type: 'module' }); }
      catch (e) { reject(new Error('Could not start the AI worker: ' + e.message)); return; }
      worker = w; workerReject = reject;
      let settled = false;
      const finish = () => { settled = true; if (worker === w) worker = null; if (workerReject === reject) workerReject = null; w.terminate(); };
      const labels = { library: 'Loading separator…', model: 'Loading and checking the AI model…', runtime: 'Preparing the on-device AI engine…', separating: 'Separating on your device; this may take several minutes…' };
      w.onmessage = event => {
        const msg = event.data || {};
        if (settled) return;
        if (msg.type === 'stage') { setStatus(labels[msg.stage] || 'Preparing…'); return; }
        if (msg.type === 'progress') { setProgress(Math.max(0, Math.min(0.99, msg.value || 0))); return; }
        finish();
        if (msg.type === 'done') resolve(msg.stems);
        else reject(new Error(msg.message || 'AI separation failed'));
      };
      w.onerror = event => { if (!settled) { finish(); reject(new Error((event && event.message) || 'AI worker could not load')); } };
      const convert = data => {
        const result = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) result[i] = Math.round(Math.max(-1, Math.min(1, data[i] || 0)) * 32767);
        return result;
      };
      const left = convert(state.channels[0]);
      const right = state.channels[1] ? convert(state.channels[1]) : left;
      w.postMessage({ left, right, sampleRate: state.sr }, right === left ? [left.buffer] : [left.buffer, right.buffer]);
    });
  }

  function mixSelected() {
    const target = state.aiStems && state.aiStems[state.mode];
    if (!target) throw new Error('The model did not return the requested stem.');
    const n = target[0].length;
    const channels = [new Float32Array(n), new Float32Array(n)];
    let peak = 0;
    for (let c = 0; c < 2; c++) {
      const source = state.channels[c] || state.channels[0], stem = target[c] || target[0];
      for (let i = 0; i < n; i++) {
        const estimated = stem[i] / 32768;
        const value = state.remove ? (source[i] || 0) - state.amount * estimated : state.amount * estimated;
        channels[c][i] = value;
        peak = Math.max(peak, Math.abs(value));
      }
    }
    const gain = peak > 1 ? 1 / peak : 1;
    if (gain < 1) channels.forEach(channel => { for (let i = 0; i < n; i++) channel[i] *= gain; });
    state.result = { channels, sr: state.sr, mode: state.mode, remove: state.remove, amount: state.amount, peak, gain, worker: true, engine: 'SCNet AI' };
    setProgress(1);
    if (els.effect) els.effect.textContent = (state.remove ? 'Reduced: ' : 'Estimated stem: ') + PROFILE_LABEL[state.mode] + '. The four stems are AI estimates and may contain bleed or artifacts.' + (gain < 1 ? ' Output was reduced to prevent clipping.' : '');
    setStatus('Ready. Choose any stem or recipe without running the model again; play, loop or save this mix as WAV.', 'ok');
    armPlayer();
    if (els.stemPicks) els.stemPicks.hidden = false;
  }

  S.run = async function () {
    if (!state.channels || !state.channels.length) { setStatus('Load a song first.', 'err'); return; }
    if (state.busy) return;
    state.busy = true; state.cancel = false;
    const generation = state.generation;
    if (els.btnRun) els.btnRun.disabled = true;
    if (els.btnCancel) els.btnCancel.hidden = false;
    try {
      if (!state.aiStems) {
        setStatus('Preparing on-device AI separation…'); setProgress(0);
        const stems = await runNeural();
        if (state.cancel || generation !== state.generation) return;
        for (const name of Object.keys(PROFILE_LABEL)) {
          if (!stems[name] || !stems[name][0] || stems[name][0].length !== state.channels[0].length) throw new Error('The model returned an incomplete ' + name + ' stem.');
        }
        state.aiStems = stems;
        if (TT.store) {
          const log = TT.store.get('stemHistory', []);
          log.unshift({ mode: state.mode, remove: state.remove, amount: state.amount, name: state.sourceName || 'audio', at: Date.now() });
          TT.store.set('stemHistory', log.slice(0, 20)); renderHistory();
        }
      }
      mixSelected();
    } catch (e) {
      if (state.cancel || (e && e.aborted)) { setStatus('Stopped. Your song is still loaded.', ''); setProgress(0); }
      else setStatus('AI separation failed: ' + (e && e.message ? e.message : 'unknown error') + '. Try a shorter file or a device with more memory.', 'err');
    } finally {
      state.busy = false; worker = null; workerReject = null;
      if (els.btnRun) els.btnRun.disabled = !state.channels;
      if (els.btnCancel) els.btnCancel.hidden = true;
    }
  };

  S.cancel = cancel;
  S.running = () => state.busy;
  /* the transport, for the tests, the keyboard and anything else that wants it */
  S.play = play;
  S.stop = stopNode;
  S.togglePlay = togglePlay;
  S.seek = seek;
  S.markA = markA;
  S.markB = markB;
  S.clearAB = clearAB;
  S.transport = resultClock;
  S.refreshTransport = () => { wave.key = ''; drawStatic(); };

  /* ---------------- playback + export ---------------- */
  function toAudioBuffer(res) {
    const ctx = TT.audio.ensure();
    const frames = res.channels[0].length;
    const buf = ctx.createBuffer(res.channels.length, frames, res.sr);
    res.channels.forEach((c, i) => buf.copyToChannel ? buf.copyToChannel(c, i) : buf.getChannelData(i).set(c));
    return buf;
  }
  function stopNode() {
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = 0;
    if (state.node) { try { state.node.stop(); } catch (e) {} state.node.disconnect(); state.node = null; }
    state.playing = false;
    if (els.btnPlay) els.btnPlay.textContent = '▶ Play';
    paint();
  }
  function resetPlayer() {
    stopNode();
    state.pos = 0;
    if (state.a != null && state.a > resultDuration()) state.a = null;
    if (state.b != null && state.b > resultDuration()) state.b = null;
    wave.key = '';
    drawStatic();
  }

  /* Play from `at`, or from the playhead. With A–B (or either end of it) set,
   * the loop runs over that section: ticked on, it loops there; ticked off, it
   * plays the section once and returns the playhead to A. */
  function play(at) {
    const src = playable();
    if (!src) return;
    const ctx = TT.audio.ensure();
    const dur = resultDuration();
    if (!dur) return;
    stopNode();
    const sp = loopSpan();
    const looping = !!(els.loop && els.loop.checked);
    let start = at == null ? state.pos : at;
    /* inside the section → carry on from where the playhead is; outside it (or
     * sitting right on B) → come in at A, which is what “play this bit” means */
    if (sp.set && (start < sp.a || start >= sp.b - 0.02)) start = sp.a;
    if (start >= dur) start = 0;
    const node = ctx.createBufferSource();
    node.buffer = toAudioBuffer(src);
    if (looping) {
      node.loop = true;
      if (sp.set) { node.loopStart = sp.a; node.loopEnd = Math.max(sp.a + 0.05, sp.b); }
    }
    const gain = ctx.createGain();
    gain.gain.value = els.vol ? +els.vol.value : 0.9;
    node.connect(gain); gain.connect(ctx.destination);
    const secs = sp.set && !looping ? Math.max(0.05, sp.b - start) : null;
    node.onended = () => {
      if (node.loop || !state.playing) return;
      state.playing = false;
      state.pos = sp.set ? sp.a : 0;
      if (els.btnPlay) els.btnPlay.textContent = '▶ Play';
      paint();
    };
    if (secs != null) node.start(0, start, secs); else node.start(0, start);
    state.node = node; state.gain = gain; state.playing = true;
    state.playStartCtx = ctx.currentTime; state.playStartPos = start; state.pos = start;
    if (els.btnPlay) els.btnPlay.textContent = '■ Stop';
    paint();
    startClock();
  }

  function togglePlay() {
    if (state.playing) stopNode(); else play(state.pos);
  }

  function downloadWav() {
    if (!state.result) return;
    const raw = TT.dsp.encodeWav(state.result.channels, state.result.sr);
    const blob = new Blob([raw], { type: 'audio/wav' });
    const a = document.createElement('a');
    const base = ((state.file && state.file.name) || 'trill-tuner').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.href = URL.createObjectURL(blob);
    a.download = base + '-' + (state.remove ? 'no-' : 'only-') + state.mode + '.wav';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function analyseStem() {
    if (!state.result) return;
    const buf = toAudioBuffer(state.result);
    const res = TT.tablab.analyseBuffer(buf, { maxSeconds: 240 });
    TT.tablab.adopt(res, {
      title: (state.file ? state.file.name.replace(/\.[a-z0-9]+$/i, '') : 'Stem') + ' — ' + (state.remove ? 'no ' : '') + (PROFILE_LABEL[state.mode] || state.mode),
      artist: 'Stem lab'
    });
    TT.app.showView('maker');
  }

  /* =================================================================== */
  /* the transport: waveform, clock, skip, and an A–B loop                */
  /* =================================================================== */
  /* Everything below draws on one canvas and drives the one AudioBufferSource
   * that is playing the result. The static picture (waveform + the A–B band)
   * is cached on an offscreen canvas and stamped once per change; the playhead
   * is a line on top, so a running clock costs one blit and one stroke. */

  const wave = { key: '', canvas: null, w: 0, h: 0, dpr: 1 };
  let raf = 0;
  let drag = null;              /* 'a' | 'b' | 'seek' | 'range' while the pointer is down */
  let dragOrigin = null;        /* { x, sec } where a seek/range drag began */

  /* a clock truncates: at 4.9 s a player reads 0:04, not 0:05 */
  function clockText(sec) {
    const v = Math.max(0, sec || 0);
    const m = Math.floor(v / 60), r = Math.floor(v % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function resultDuration() {
    const r = playable();
    return r && r.channels[0] && r.sr ? r.channels[0].length / r.sr : 0;
  }

  /* the section the loop runs over: whatever of A and B is set */
  function loopSpan() {
    const dur = resultDuration();
    const a = state.a == null ? 0 : Math.max(0, Math.min(state.a, dur));
    const b = state.b == null ? dur : Math.max(0, Math.min(state.b, dur));
    return { a: a, b: b, set: state.a != null || state.b != null, dur: dur, len: Math.max(0, b - a) };
  }

  function abText() {
    const sp = loopSpan();
    if (!sp.dur) return 'nothing loaded';
    if (!sp.set) return 'whole take';
    const head = state.a != null ? 'A ' + clockText(sp.a) : 'from the start';
    const tail = state.b != null ? 'B ' + clockText(sp.b) : 'to the end';
    return head + ' – ' + tail + ' · loop ' + clockText(sp.len);
  }

  function syncTransport() {
    const dur = resultDuration();
    if (state.pos > dur) state.pos = dur;
    if (state.a != null && state.a > dur) state.a = null;
    if (state.b != null && state.b > dur) state.b = null;
    if (state.a != null && state.b != null && state.b <= state.a) state.b = null;
    if (els.pos) els.pos.textContent = clockText(state.pos);
    if (els.dur) els.dur.textContent = clockText(dur);
    if (els.abLabel) els.abLabel.textContent = abText();
    [els.btnASet, els.btnBSet, els.btnABClear].forEach(b => { if (b) b.disabled = !dur; });
    if (els.btnPlay) els.btnPlay.disabled = !dur;
  }

  /* a 2-D context may not exist at all (jsdom, an old browser): never throw */
  function waveContext(node) {
    if (!node || typeof node.getContext !== 'function') return null;
    try { return node.getContext('2d'); } catch (e) { return null; }
  }

  function waveSize() {
    const cssW = Math.max(240, Math.round((els.wave && els.wave.clientWidth) || (els.wave && els.wave.width) || 600));
    const cssH = Math.max(48, Math.round((els.wave && els.wave.clientHeight) || 96));
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    return { cssW: cssW, cssH: cssH, dpr: dpr, w: Math.round(cssW * dpr), h: Math.round(cssH * dpr) };
  }

  function xOf(sec, size) {
    const dur = resultDuration();
    return dur ? Math.round((sec / dur) * size.w) : 0;
  }
  function secOf(x, size) {
    const dur = resultDuration();
    return dur ? Math.max(0, Math.min(dur, (x / size.w) * dur)) : 0;
  }

  function drawStatic() {
    const g0 = waveContext(els.wave);
    if (!g0 || !playable()) return;
    const size = waveSize();
    if (!wave.canvas) {
      wave.canvas = document.createElement('canvas');
    }
    const off = waveContext(wave.canvas);
    if (!off) return;
    const r = playable();
    const key = [r.channels[0].length, r.sr, r.mode, r.remove ? 1 : 0, r.preview ? 1 : 0, state.a, state.b, size.w, size.h].join('|');
    if (key === wave.key && wave.w === size.w && wave.h === size.h) return;
    wave.key = key; wave.w = size.w; wave.h = size.h; wave.dpr = size.dpr;
    wave.canvas.width = size.w; wave.canvas.height = size.h;
    els.wave.width = size.w; els.wave.height = size.h;

    const n = r.channels[0].length;
    const chans = r.channels;
    off.clearRect(0, 0, size.w, size.h);
    /* the loop band behind the wave */
    const sp = loopSpan();
    if (sp.set && sp.dur) {
      const x0 = xOf(sp.a, size), x1 = xOf(sp.b, size);
      off.fillStyle = 'rgba(56, 189, 248, .13)';
      off.fillRect(x0, 0, Math.max(1, x1 - x0), size.h);
    }
    /* a centre line to read quiet passages against */
    off.strokeStyle = 'rgba(255,255,255,.07)';
    off.beginPath(); off.moveTo(0, size.h / 2); off.lineTo(size.w, size.h / 2); off.stroke();
    /* the waveform: min/max of every channel per column, at least 2 px tall */
    const mid = size.h / 2;
    const per = n / size.w;
    off.fillStyle = sp.set ? '#4a5f86' : '#5b76a8';
    for (let x = 0; x < size.w; x++) {
      const from = Math.floor(x * per), to = Math.min(n, Math.max(from + 1, Math.floor((x + 1) * per)));
      let lo = 0, hi = 0;
      for (let c = 0; c < chans.length; c++) {
        const a = chans[c];
        for (let i = from; i < to; i++) {
          const v = a[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      const y0 = mid - hi * mid * 0.94, y1 = mid - lo * mid * 0.94;
      off.fillRect(x, y0, 1, Math.max(size.dpr, y1 - y0));
    }
    /* the two loop handles */
    const handle = (x, label) => {
      off.fillStyle = '#38bdf8';
      off.fillRect(x - size.dpr, 0, size.dpr * 2, size.h);
      off.beginPath();
      off.moveTo(x - 6 * size.dpr, 0); off.lineTo(x + 6 * size.dpr, 0); off.lineTo(x, 9 * size.dpr);
      off.closePath(); off.fill();
      if (size.w > 420) {
        off.fillStyle = '#0b0f18';
        off.font = (7 * size.dpr) + 'px sans-serif';
        off.fillText(label, x - 2 * size.dpr, 7.5 * size.dpr);
      }
    };
    if (sp.set) {
      if (state.a != null) handle(xOf(sp.a, size), 'A');
      if (state.b != null) handle(xOf(sp.b, size), 'B');
    }
    paint();
  }

  function paint() {
    const g = waveContext(els.wave);
    if (!g) { syncTransport(); return; }
    const size = { w: els.wave.width, h: els.wave.height };
    if (wave.canvas && (size.w !== wave.w || size.h !== wave.h)) { wave.key = ''; drawStatic(); return; }
    g.clearRect(0, 0, size.w, size.h);
    if (wave.canvas) g.drawImage(wave.canvas, 0, 0);
    if (playable()) {
      const x = xOf(state.pos, size);
      g.fillStyle = '#ffd28a';
      g.fillRect(Math.max(0, x - Math.max(1, wave.dpr)), 0, Math.max(2, wave.dpr * 1.5), size.h);
      g.beginPath();
      g.arc(x, size.h - 5 * wave.dpr, 3.2 * wave.dpr, 0, Math.PI * 2);
      g.fill();
    }
    syncTransport();
  }

  /* the clock: follows the AudioContext, not a wall timer, so the playhead and
   * the sound cannot drift apart */
  function tick() {
    raf = 0;
    if (!state.playing) return;
    const ctx = TT.audio.ctx;
    const dur = resultDuration();
    if (!ctx || !dur) { paint(); return; }
    const sp = loopSpan();
    const looping = sp.set && els.loop && els.loop.checked;
    let pos = state.playStartPos + (ctx.currentTime - state.playStartCtx);
    if (looping && sp.len > 0.02) pos = sp.a + ((pos - sp.a) % sp.len + sp.len) % sp.len;
    else if (pos > dur) pos = dur;
    state.pos = Math.max(0, Math.min(dur, pos));
    paint();
    raf = requestAnimationFrame(tick);
  }

  function startClock() {
    if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);
  }

  /* ---------------- actions ---------------- */
  function seek(sec) {
    const dur = resultDuration();
    if (!dur) return 0;
    state.pos = Math.max(0, Math.min(dur, sec));
    if (state.playing) play(state.pos);      /* restart the sound where the playhead went */
    else paint();
    return state.pos;
  }

  function markA() {
    if (!resultDuration()) return null;
    state.a = state.pos;
    if (state.b != null && state.b <= state.a + 0.05) state.b = null;
    wave.key = '';
    setStatus('Loop point A at ' + mmss(state.a) + ' — press play and it loops from here' + (state.b != null ? ' to B' : ' to the end') + '.');
    drawStatic();
    return state.a;
  }

  function markB() {
    if (!resultDuration()) return null;
    state.b = state.pos;
    if (state.a != null && state.a >= state.b - 0.05) state.a = null;
    wave.key = '';
    setStatus('Loop point B at ' + mmss(state.b) + ' — press play and it loops ' + (state.a != null ? 'from A to here' : 'from the start to here') + '.');
    drawStatic();
    return state.b;
  }

  function clearAB() {
    const had = state.a != null || state.b != null;
    state.a = null; state.b = null;
    wave.key = '';
    if (had) setStatus('Loop points cleared — the loop runs over the whole take again.');
    drawStatic();
    return true;
  }

  function nudge(delta, big) {
    return seek(state.pos + (delta == null ? (big ? 5 : 1) : delta));
  }

  function resultClock() {
    return { pos: state.pos, dur: resultDuration(), a: state.a, b: state.b, playing: !!state.playing };
  }

  function renderHistory() {
    if (!els.history) return;
    els.history.innerHTML = '';
    const log = (TT.store && TT.store.get('stemHistory', [])) || [];
    if (!log.length) { els.history.innerHTML = '<span class="dim">Nothing separated yet.</span>'; return; }
    log.forEach(h => {
      const b = document.createElement('button');
      b.className = 'chip-s';
      b.type = 'button';
      b.textContent = (h.remove ? 'no ' : 'only ') + (PROFILE_LABEL[h.mode] || h.mode) + ' · ' + Math.round((h.amount || 0) * 100) + '%';
      b.title = (h.name || '') + ' — click to load this recipe';
      b.addEventListener('click', () => {
        state.mode = h.mode; state.remove = !!h.remove; state.amount = h.amount || 0.9;
        if (els.mode) els.mode.value = h.mode;
        if (els.amount) els.amount.value = String(Math.round(state.amount * 100));
        if (els.amountShow) els.amountShow.textContent = Math.round(state.amount * 100) + '%';
        syncActionSeg();
        setStatus('Recipe loaded: ' + (h.remove ? 'remove ' : 'isolate ') + (PROFILE_LABEL[h.mode] || h.mode) + ' at ' + Math.round(state.amount * 100) + '%.');
      });
      els.history.appendChild(b);
    });
  }

  function syncActionSeg() {
    if (!els.actionSeg) return;
    els.actionSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', (b.dataset.action === 'remove') === state.remove));
  }

  S.init = function () {
    if (S._ready) return;
    S._ready = true;
    els = {
      file: document.getElementById('st-file'),
      drop: document.getElementById('st-drop'),
      btnMic: document.getElementById('st-btn-mic'),
      status: document.getElementById('st-status'),
      source: document.getElementById('st-source'),
      presets: document.getElementById('st-presets'),
      mode: document.getElementById('st-mode'),
      actionSeg: document.getElementById('st-action'),
      amount: document.getElementById('st-amount'),
      amountShow: document.getElementById('st-amount-show'),
      btnRun: document.getElementById('st-btn-run'),
      btnCancel: document.getElementById('st-btn-cancel'),
      runNote: document.getElementById('st-run-note'),
      bar: document.getElementById('st-bar'),
      pct: document.getElementById('st-pct'),
      result: document.getElementById('st-result'),
      resultH: document.getElementById('st-result-h'),
      effect: document.getElementById('st-effect'),
      btnPlay: document.getElementById('st-btn-play'),
      btnWav: document.getElementById('st-btn-wav'),
      btnTab: document.getElementById('st-btn-tab'),
      wave: document.getElementById('st-wave'),
      pos: document.getElementById('st-pos'),
      dur: document.getElementById('st-dur'),
      abLabel: document.getElementById('st-ab-label'),
      btnASet: document.getElementById('st-btn-aset'),
      btnBSet: document.getElementById('st-btn-bset'),
      btnABClear: document.getElementById('st-btn-abclear'),
      vol: document.getElementById('st-vol'),
      loop: document.getElementById('st-loop'),
      history: document.getElementById('st-history'),
      notes: document.getElementById('st-notes'),
      stemPicks: document.getElementById('st-stem-picks')
    };
    if (els.file) els.file.addEventListener('change', e => { if (e.target.files && e.target.files[0]) S.loadFile(e.target.files[0]); });
    if (els.drop) {
      ['dragenter', 'dragover'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); els.drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => els.drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); els.drop.classList.remove('over'); }));
      els.drop.addEventListener('drop', e => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) S.loadFile(f);
      });
      els.drop.addEventListener('click', () => { if (els.file) els.file.click(); });
    }
    if (els.btnMic) els.btnMic.addEventListener('click', fromMic);

    /* ---- the waveform: click anywhere to skip, drag the A/B handles ---- */
    if (els.btnASet) els.btnASet.addEventListener('click', () => markA());
    if (els.btnBSet) els.btnBSet.addEventListener('click', () => markB());
    if (els.btnABClear) els.btnABClear.addEventListener('click', () => clearAB());
    if (els.wave) {
      /* Pointer events are the clean path, but an old Android WebView (the APK
       * loads the app from file://, and Android 7 shipped WebView 51) has no
       * PointerEvent at all — so the same three handlers are driven by mouse or
       * touch events when that is all the browser has. */
      const at = e => {
        const pt = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e);
        const r = els.wave.getBoundingClientRect();
        const cssW = Math.max(1, r.width || 1);
        const w = els.wave.width || 600;
        return { x: (pt.clientX - r.left) * (w / cssW), size: { w: w } };
      };
      const near = (x, sec, size) => sec != null && Math.abs(x - xOf(sec, size)) <= 11;
      const onDown = e => {
        const p = at(e);
        dragOrigin = { x: p.x, sec: secOf(p.x, p.size) };
        if (near(p.x, state.b, p.size)) drag = 'b';
        else if (near(p.x, state.a, p.size)) drag = 'a';
        else { drag = 'seek'; seek(dragOrigin.sec); }
        if (drag !== 'seek') wave.key = '';
        if (els.wave.setPointerCapture && e.pointerId != null) { try { els.wave.setPointerCapture(e.pointerId); } catch (err) {} }
        if (els.wave.focus) els.wave.focus();
        if (e.cancelable) e.preventDefault();
      };
      const onMove = e => {
        if (!drag) return;
        const p = at(e);
        const sec = secOf(p.x, p.size);
        if (drag === 'seek' || drag === 'range') {
          /* a tap is a skip; dragging across the wave paints the A–B loop
           * (point A where the drag started, point B where it ended) */
          if (dragOrigin && (Math.abs(p.x - dragOrigin.x) > 12 || Math.abs(sec - dragOrigin.sec) > 0.2)) {
            drag = 'range';
            state.a = Math.min(dragOrigin.sec, sec);
            state.b = Math.max(dragOrigin.sec, sec);
            if (state.b - state.a < 0.05) state.b = Math.min(resultDuration(), state.a + 0.05);
            wave.key = '';
            drawStatic();
          } else if (drag === 'seek') {
            seek(sec);
          }
        } else {
          if (drag === 'a') { state.a = sec; if (state.b != null && state.b <= state.a + 0.05) state.b = null; }
          else { state.b = sec; if (state.a != null && state.a >= state.b - 0.05) state.a = null; }
          wave.key = '';
          drawStatic();
        }
        if (e.cancelable) e.preventDefault();
      };
      const onUp = () => {
        if (drag === 'range' && state.a != null && state.b != null) {
          if (els.loop) els.loop.checked = true;
          setStatus('Loop A ' + mmss(state.a) + ' → B ' + mmss(state.b) + ' — press play and it loops that section.');
          if (state.playing) play(state.pos);
        } else if (drag === 'a' || drag === 'b') {
          setStatus('Loop point ' + (drag === 'a' ? 'A' : 'B') + ' at ' + mmss(drag === 'a' ? state.a : state.b) + '.');
        }
        drag = null;
        dragOrigin = null;
      };
      if (typeof window.PointerEvent === 'function') {
        els.wave.addEventListener('pointerdown', onDown);
        els.wave.addEventListener('pointermove', onMove);
        els.wave.addEventListener('pointerup', onUp);
        els.wave.addEventListener('pointercancel', onUp);
      } else {
        const grab = e => {
          onDown(e);
          const move = ev => onMove(ev);
          const up = () => { onUp(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        };
        els.wave.addEventListener('mousedown', grab);
        els.wave.addEventListener('touchstart', e => {
          onDown(e);
          const move = ev => onMove(ev);
          const up = () => { onUp(); window.removeEventListener('touchmove', move); window.removeEventListener('touchend', up); };
          window.addEventListener('touchmove', move, { passive: false });
          window.addEventListener('touchend', up);
        }, { passive: false });
        els.wave.addEventListener('touchmove', onMove, { passive: false });
        els.wave.addEventListener('touchend', onUp);
      }
      els.wave.addEventListener('keydown', e => {
        const big = e.shiftKey;
        if (e.key === 'ArrowRight') { seek(state.pos + (big ? 1 : 5)); e.preventDefault(); }
        else if (e.key === 'ArrowLeft') { seek(state.pos - (big ? 1 : 5)); e.preventDefault(); }
        else if (e.key === 'Home') { seek(0); e.preventDefault(); }
        else if (e.key === 'End') { seek(resultDuration()); e.preventDefault(); }
        else if (e.key === '[') { markA(); e.preventDefault(); }
        else if (e.key === ']') { markB(); e.preventDefault(); }
        else if (e.key === ' ') { togglePlay(); e.preventDefault(); }
      });
    }
    if (els.btnPlay) els.btnPlay.addEventListener('click', togglePlay);
    window.addEventListener('resize', () => { wave.key = ''; drawStatic(); });
    syncTransport();
    if (els.mode) {
      Object.keys(PROFILE_LABEL).forEach(k => {
        const o = document.createElement('option'); o.value = k; o.textContent = PROFILE_LABEL[k]; els.mode.appendChild(o);
      });
      els.mode.value = state.mode;
      els.mode.addEventListener('change', () => { state.mode = els.mode.value; if (state.aiStems && !state.busy) mixSelected(); });
    }
    if (els.actionSeg) {
      els.actionSeg.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
        state.remove = b.dataset.action === 'remove';
        syncActionSeg();
        if (state.aiStems && !state.busy) mixSelected();
      }));
      syncActionSeg();
    }
    if (els.amount) {
      els.amount.value = String(Math.round(state.amount * 100));
      els.amountShow.textContent = Math.round(state.amount * 100) + '%';
      els.amount.addEventListener('input', () => {
        state.amount = Math.max(0, Math.min(1, (+els.amount.value) / 100));
        els.amountShow.textContent = Math.round(state.amount * 100) + '%';
      });
      els.amount.addEventListener('change', () => { if (state.aiStems && !state.busy) mixSelected(); });
    }
    if (els.btnRun) els.btnRun.addEventListener('click', S.run);
    if (els.btnCancel) els.btnCancel.addEventListener('click', cancel);
    if (els.runNote) els.runNote.textContent = 'First web run downloads the AI engine and model (~23 MB); processing can take minutes and substantial memory.';
    if (els.btnWav) els.btnWav.addEventListener('click', downloadWav);
    if (els.btnTab) els.btnTab.addEventListener('click', analyseStem);
    if (els.vol) els.vol.addEventListener('input', () => { if (state.gain) state.gain.gain.value = +els.vol.value; });
    if (els.loop) els.loop.addEventListener('change', () => {
      /* re-arm the loop (or drop it) without losing where we are */
      if (state.playing) play(state.pos); else paint();
    });
    if (els.presets) {
      PRESETS.forEach(p => {
        const b = document.createElement('button');
        b.className = 'st-preset';
        b.type = 'button';
        b.innerHTML = `<b>${p.label}</b><span>${p.desc}</span>`;
        b.addEventListener('click', () => {
          state.mode = p.mode; state.remove = p.remove; state.amount = p.amount;
          if (els.mode) els.mode.value = p.mode;
          if (els.amount) els.amount.value = String(Math.round(p.amount * 100));
          if (els.amountShow) els.amountShow.textContent = Math.round(p.amount * 100) + '%';
          syncActionSeg();
          if (state.channels) S.run();
          else setStatus(p.label + ' — load a song (or grab 20 seconds from the microphone) and it will separate straight away.');
        });
        els.presets.appendChild(b);
      });
    }
    if (els.stemPicks) els.stemPicks.querySelectorAll('[data-stem]').forEach(button => button.addEventListener('click', () => {
      state.mode = button.dataset.stem; state.remove = false; state.amount = 1;
      if (els.mode) els.mode.value = state.mode;
      if (els.amount) els.amount.value = '100';
      if (els.amountShow) els.amountShow.textContent = '100%';
      syncActionSeg(); mixSelected();
    }));
    if (els.notes) {
      els.notes.innerHTML = `
        <li><b>Four real AI estimates.</b> SCNet predicts vocals, drums, bass and other instruments from the mix on this device. No song audio is uploaded.</li>
        <li><b>Not the original tracks.</b> Stems can contain bleed and artifacts. Guitar and keys share “other”; acoustic and electric guitars cannot be reliably isolated from each other.</li>
        <li><b>Model and memory.</b> The web version downloads about 23 MB once, then can use the cached files offline. The compact model can still require substantial memory and minutes of processing. The Android package includes the files.</li>
        <li><b>Reduce or isolate.</b> Reducing subtracts a scaled estimate from the original mix. Isolating plays the estimate. Each result can be previewed, looped and exported as WAV.</li>
        <li><b>Room recording and loops.</b> Record 20 seconds, or load a file; drag on the waveform or set A and B to repeat a section. The backing studio can also send a render here.</li>`;
    }
    renderHistory();
  };

  S.state = state;
  window.TT = window.TT || {};
  window.TT.stems = S;
})();
