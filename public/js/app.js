/* Trill Tuner — app shell: navigation, theme, toasts, assistant feed,
 * keyboard shortcuts, module boot, splash and progress bookkeeping. */
(function () {
  'use strict';

  const app = { VERSION: '2.1.0' };
  const feed = [];

  function toast(msg, opts) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    if (opts && opts.actionLabel) {
      const b = document.createElement('button');
      b.textContent = opts.actionLabel;
      b.addEventListener('click', () => { opts.action && opts.action(); t.remove(); });
      t.appendChild(b);
    }
    box.appendChild(t);
    setTimeout(() => { t.classList.add('fade'); }, 3600);
    setTimeout(() => { t.remove(); }, 4200);
  }

  function assist(msg, opts) {
    const now = new Date();
    feed.unshift({ t: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), msg: msg });
    if (feed.length > 25) feed.pop();
    const list = document.getElementById('assistant-log');
    if (list) {
      list.innerHTML = '';
      feed.slice(0, 8).forEach(f => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="a-time">${f.t}</span> ${f.msg}`;
        list.appendChild(li);
      });
    }
    if (opts && opts.toast) toast(msg);
  }

  function closeMenu(restoreFocus) {
    const nav = document.getElementById('nav');
    const backdrop = document.getElementById('nav-backdrop');
    const btn = document.getElementById('btn-menu');
    const wasOpen = nav && nav.classList.contains('open');
    if (nav) {
      nav.classList.remove('open');
      nav.setAttribute('inert', '');
      nav.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) backdrop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-open');
    if (restoreFocus && wasOpen && btn) btn.focus();
  }
  function openMenu() {
    const nav = document.getElementById('nav');
    const backdrop = document.getElementById('nav-backdrop');
    const btn = document.getElementById('btn-menu');
    const keyboardOpened = document.activeElement === btn;
    if (nav) {
      nav.scrollTop = 0;
      nav.removeAttribute('inert');
      nav.setAttribute('aria-hidden', 'false');
      nav.classList.add('open');
    }
    if (backdrop) backdrop.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('nav-open');
    if (keyboardOpened) {
      const close = document.getElementById('nav-close');
      if (close) close.focus();
    }
  }
  app.closeMenu = closeMenu;
  app.openMenu = openMenu;

  const viewCopy = {
    metronome: ['PLAY', 'Metronome', 'Find your rhythm and keep it moving.'],
    record: ['PLAY', 'Record', 'Capture the ideas worth keeping.'],
    listening: ['PLAY', 'Listener', 'Listen closer and improve your playing.'],
    lyrics: ['SONGS', 'Lyrics', 'Find the words and make them yours.'],
    songs: ['SONGS', 'Songs', 'A little inspiration for your next session.'],
    styles: ['SONGS', 'Styles', 'Explore sounds, players, and genres.'],
    maker: ['SONGS', 'Tab maker', 'Find the chords and make a song your own.'],
    stems: ['STUDIO', 'Stems', 'Take your music apart and play it your way.'],
    backing: ['STUDIO', 'Backing Studio', 'Make a practice track that feels like you.'],
    learn: ['STUDIO', 'Learn', 'A little progress every time you play.'],
    tools: ['STUDIO', 'Tools', 'A toolkit for wherever the music takes you.'],
    rig: ['STUDIO', 'Rig', 'Find the sound in your head.'],
    hookup: ['STUDIO', 'Hookup Guitar', 'Get connected and start playing.'],
    mine: ['YOU', 'My stuff', 'Your favorites and sessions, all in one place.'],
    progress: ['YOU', 'Progress', 'Look how far you have come.'],
    care: ['YOU', 'Care', 'A little care goes a long way.'],
    settings: ['YOU', 'Settings', 'Make your studio feel like yours.']
  };

  app.showView = function (id) {
    if (!document.getElementById('view-' + id)) return;
    app.currentView = id;
    const shell = document.querySelector('.app');
    if (shell) shell.dataset.currentView = id;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === id));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + id));
    const heading = document.getElementById('view-heading');
    if (heading) {
      const copy = viewCopy[id];
      heading.hidden = !copy;
      if (copy) {
        document.getElementById('view-heading-kicker').textContent = copy[0];
        document.getElementById('view-heading-title').textContent = copy[1];
        document.getElementById('view-heading-description').textContent = copy[2];
      }
    }
    const dockView = id === 'home' ? 'home'
      : ['songs', 'lyrics', 'styles', 'maker', 'stems'].includes(id) ? 'songs'
      : id === 'learn' ? 'learn'
      : ['mine', 'progress', 'care', 'settings'].includes(id) ? 'mine' : 'tune';
    document.querySelectorAll('.dock-btn').forEach(b => {
      const selected = b.closest('.dock-set--tuner') ? b.dataset.openView === id : b.dataset.openView === dockView;
      b.classList.toggle('active', selected);
      if (selected) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    closeMenu();
    // On mobile Safari and in our shell the body can be the scrolling element.
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
    window.scrollTo(0, 0);
    if (id === 'tune') TT.tuner.resume(); else TT.tuner.pause();
    if (id === 'learn') TT.learn.renderPractice();
    if (id !== 'listening' && TT.listener && TT.listener.state && TT.listener.state.running) TT.listener.stop();
    if (id === 'care' && TT.care) TT.care.render();
    if (id === 'rig' && TT.rig) TT.rig.rebuild();
    if (id !== 'backing' && TT.backing && TT.backing.stop) TT.backing.stop();
    if (id === 'mine' && TT.mine && TT.mine.render) TT.mine.render();
    if (id === 'styles' && TT.styles) TT.styles.init();
    if (id === 'progress' && TT.share) TT.share.render();
    if (id === 'progress' && TT.apkshare) TT.apkshare.render();
    if (id === 'tools' && TT.tools) TT.tools.setTab(document.querySelector('#tools-tabs .tab.active').dataset.tab);
    if (id !== 'tools' && TT.playtools && TT.playtools.stop) TT.playtools.stop();
    if (id === 'settings' && TT.settings && TT.settings.refreshInputs) TT.settings.refreshInputs();
  };

  function bindNav() {
    document.querySelectorAll('.nav-btn').forEach(b =>
      b.addEventListener('click', () => app.showView(b.dataset.view)));
    document.querySelectorAll('[data-open-view]').forEach(b => b.addEventListener('click', () => {
      app.showView(b.dataset.openView);
      if (b.dataset.tunerModeTarget && TT.tuner.setTuningMode) TT.tuner.setTuningMode(b.dataset.tunerModeTarget);
      if (b.dataset.openTab && b.dataset.openView === 'tools' && TT.tools) TT.tools.setTab(b.dataset.openTab);
    }));
    const close = document.getElementById('nav-close');
    if (close) close.addEventListener('click', () => closeMenu(true));
    const btn = document.getElementById('btn-menu');
    const backdrop = document.getElementById('nav-backdrop');
    if (btn) btn.addEventListener('click', () => {
      const nav = document.getElementById('nav');
      if (nav && nav.classList.contains('open')) closeMenu(true); else openMenu();
    });
    if (backdrop) backdrop.addEventListener('click', () => closeMenu(true));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(true); });
  }

  function bindMode() {
    const seg = document.getElementById('seg-mode');
    if (!seg) return;
    const sync = mode => seg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    sync(TT.tuner.state.mode);
    seg.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
      const mode = b.dataset.mode;
      if (mode === TT.tuner.state.mode) return;
      TT.tuner.setMode(mode);
      sync(mode);
    }));
  }

  function bindMicPill() {
    const pill = document.getElementById('mic-pill');
    if (!pill) return;
    pill.addEventListener('click', async () => {
      if (TT.audio.micState === 'on') {
        TT.audio.stopMic();
        toast('Mic stopped. Reference tones still work for tuning by ear.');
      } else if (TT.audio.micState === 'error') {
        toast(TT.audio.micError + ' — try "Open in a new tab" from the tuner panel.');
      } else {
        app.showView('tune');
        document.getElementById('btn-mic-start').click();
      }
    });
  }

  function bindKeys() {
    window.addEventListener('keydown', e => {
      const tag = (e.target && e.target.tagName) || '';
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        TT.metronome.toggle();
      } else if (/^Digit[1-7]$/.test(e.code)) {
        const n = +e.code.slice(5);
        const strings = TT.tunings.byId(TT.tuner.state.presetId).strings;
        if (n <= strings.length) TT.tuner.manualSelect(strings.length - n);
      } else if (e.key === 'g' || e.key === 'G') {
        TT.tuner.toggleGig();
      } else if (e.key === 'v' || e.key === 'V') {
        TT.metronome.toggle && null; /* reserved */
      }
    });
  }

  /* first time each user-visible view is opened, run its render hook */
  app.init = function () {
    const wire = (name, fn) => {
      try { fn(); } catch (e) { console.error('Trill Tuner: ' + name + ' failed to start', e); }
    };
    wire('tuner', () => TT.tuner.init());
    wire('metronome', () => TT.metronome.init());
    wire('jam', () => TT.jam.init());
    wire('recorder', () => TT.recorder.init());
    wire('lyrics', () => TT.lyrics.init());
    wire('songs', () => TT.songs.init());
    wire('styles', () => TT.styles.init());
    wire('backing', () => TT.backing.init());
    wire('mine', () => TT.mine.init());
    wire('tabmaker', () => TT.tablab.init());
    wire('stems', () => TT.stems.init());
    wire('listener', () => TT.listener.init());
    wire('learn', () => TT.learn.init());
    wire('care', () => TT.care.init());
    wire('tools', () => TT.tools.init());
    wire('practice', () => TT.practiceTools.init());
    wire('rig', () => TT.rig.init());
    wire('hookup', () => TT.hookup && TT.hookup.init());
    wire('settings', () => TT.settings && TT.settings.init());
    wire('share', () => TT.share.init());
    wire('pwa', () => TT.pwa.init());
    wire('remote', () => TT.remote.init());
    wire('apkshare', () => TT.apkshare.init());
    wire('demo', () => TT.demo.init());
    bindNav();
    bindMode();
    bindMicPill();
    bindKeys();
    app.showView('home');

    /* storage health: an automatic snapshot means a corrupted write never
     * costs more than an hour of progress. */
    try { TT.store.autoSnapshot(); } catch (e) {}

    const firstRun = !TT.store.get('visited', false);
    TT.store.set('visited', true);
    if (firstRun) {
      assist('Welcome to Trill Tuner 🎸 Standard tuning is loaded. Hit “Start listening” and play your low E. There are 94 tunings, a full amp & pedal studio in the Rig tab, plus the songbook, tab maker, stem lab, listener, backing studio and My stuff.');
    } else {
      assist('Welcome back 🎸 Your settings, rig and practice history were restored.');
    }
    TT.share.checkBadges(true);

    /* splash last, so it can report the real module status */
    wire('splash', () => TT.splash.show());
  };

  app.assist = assist;
  app.toast = toast;

  window.TT = window.TT || {};
  window.TT.app = app;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', app.init);
  } else {
    app.init();
  }
})();
