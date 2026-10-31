/* Two calm, skippable intro screens; reduced motion removes the animation. */
(function () {
  'use strict';
  const S = { done: false };
  S.show = function () {
    const overlay = document.getElementById('splash');
    const title = document.getElementById('splash-title');
    const credit = document.getElementById('splash-credit');
    const skip = document.getElementById('splash-enter');
    if (!overlay || !title || !credit || !skip) return;
    if (TT.store && TT.store.get('splashOff', false)) { overlay.hidden = true; S.done = true; return; }
    S.done = false;
    overlay.classList.remove('splash-out'); overlay.hidden = false;
    title.hidden = false; credit.hidden = true;
    document.body.classList.add('splash-on');
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const duration = reduced ? 220 : 1600;
    let timer = 0, endTimer = 0;
    function dismiss() {
      if (S.done) return;
      S.done = true;
      clearTimeout(timer); clearTimeout(endTimer);
      overlay.classList.add('splash-out');
      document.body.classList.remove('splash-on');
      window.removeEventListener('keydown', onKey);
      setTimeout(() => { overlay.hidden = true; }, reduced ? 0 : 450);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } }
    S.dismiss = dismiss;
    skip.onclick = dismiss;
    window.addEventListener('keydown', onKey);
    timer = setTimeout(() => {
      if (S.done) return;
      title.hidden = true; credit.hidden = false;
      endTimer = setTimeout(dismiss, duration);
    }, duration);
  };
  S.dismiss = function () {};
  S.toggleForever = function (on) { if (TT.store) TT.store.set('splashOff', !on); };
  window.TT = window.TT || {}; window.TT.splash = S;
})();
