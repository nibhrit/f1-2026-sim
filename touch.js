// ============================================================
// Touch & tilt controls (phones / tablets).
//  - first launch on a touch device asks: TILT (default) or TOUCH BUTTONS
//  - tilt: device orientation -> analog steering, with calibration, a
//    dead-zone, sensitivity, smoothing and an invert switch
//  - pedals: brake bottom-left, throttle bottom-right (or auto-throttle)
//  - buttons: pause, camera, racing line, pit, hold-to-look-back, and a big
//    TAP target for the pit-stop reaction game
// Discrete actions are sent as the same keyboard events the game already
// handles, so everything (pit calls, camera, pause...) behaves identically.
// Analog input is published on window.OUTLAP_TOUCH_INPUT for playerInput().
// ============================================================
(function () {
  const qs = new URLSearchParams(location.search);
  const isTouch = window.OUTLAP_FORCE_TOUCH || qs.get('touch') === '1' ||
    (qs.get('touch') !== '0' && ((window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window)));
  window.OUTLAP_TOUCH = isTouch;
  window.OUTLAP_LOWQ = qs.has('lowq') ? qs.get('lowq') !== '0' : isTouch;
  // iOS only unlocks Web Audio from touchend/click, not pointerdown
  const unlock = () => { try { if (typeof AUDIO !== 'undefined') { AUDIO.init(); AUDIO.musicStart && AUDIO.musicStart(); } } catch (e) {} };
  window.addEventListener('touchend', unlock, { passive: true });
  const LS = 'outlap_controls';
  const cfg = Object.assign({ mode: null, sens: 22, invert: false, autoThrottle: false }, (() => {
    try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; }
  })());
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} };
  const input = window.OUTLAP_TOUCH_INPUT = { active: false, steer: 0, throttle: 0, brake: 0 };
  const G = () => window.__G;
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type || 'keydown', { code, bubbles: true }));
  const tap = code => { key(code, 'keydown'); setTimeout(() => key(code, 'keyup'), 60); };

  // ---------- tilt ----------
  let tiltRaw = null, tiltCenter = null, tiltSm = 0, tiltOK = false;
  function screenAngle() {
    const a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    return ((a % 360) + 360) % 360;
  }
  // Steering angle = how far gravity has rotated within the screen plane,
  // i.e. the device turned like a wheel. Works however far back it's tilted,
  // and doesn't care that iOS and Android report gravity with opposite signs
  // (both flip together, so the change from the centre point is the same).
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    const a = screenAngle() * Math.PI / 180;
    const sx = g.x * Math.cos(a) - g.y * Math.sin(a);
    const sy = g.x * Math.sin(a) + g.y * Math.cos(a);
    if (Math.hypot(sx, sy) < 2.5) return;          // lying flat: angle is meaningless, hold the last value
    tiltOK = true;
    tiltRaw = Math.atan2(sx, sy) * 180 / Math.PI;
    if (tiltCenter == null) tiltCenter = tiltRaw;
  }
  function startTilt() {
    const add = () => window.addEventListener('devicemotion', onMotion);
    const DM = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
    if (DM && typeof DM.requestPermission === 'function') {
      // iOS 13+: must be asked from a tap
      return DM.requestPermission().then(r => { if (r === 'granted') add(); return r; }).catch(() => 'denied');
    }
    add(); return Promise.resolve(DM ? 'granted' : 'unsupported');
  }
  function recenter() { tiltCenter = tiltRaw; tiltSm = 0; }
  window.OUTLAP_RECENTER = recenter;

  // ---------- DOM ----------
  const css = `
  #tc-layer { position:fixed; inset:0; z-index:15; pointer-events:none; display:none; touch-action:none; }
  #tc-layer.on { display:block; }
  .tc-pedal, .tc-arrow { position:absolute; bottom:max(10px, env(safe-area-inset-bottom)); height:40vh; border-radius:18px; pointer-events:auto;
    display:flex; align-items:flex-end; justify-content:center; padding-bottom:12px; font:900 12px Arial; letter-spacing:2px;
    color:rgba(255,255,255,.75); border:2px solid rgba(255,255,255,.18); background:rgba(255,255,255,.08); }
  .tc-pedal { width:22vw; max-width:220px; }
  #tc-brake { left:max(10px, env(safe-area-inset-left)); background:rgba(225,6,0,.16); }
  #tc-gas { right:max(10px, env(safe-area-inset-right)); background:rgba(46,204,113,.16); }
  .tc-arrow { width:14vw; max-width:150px; align-items:center; padding-bottom:0; font-size:30px; display:none; }
  #tc-left { left:max(10px, env(safe-area-inset-left)); }
  #tc-right { left:calc(max(10px, env(safe-area-inset-left)) + min(14vw, 150px) + 10px); }
  /* buttons mode: steer with the left thumb, both pedals under the right */
  #tc-layer.mode-buttons .tc-arrow { display:flex; }
  #tc-layer.mode-buttons .tc-pedal { width:15vw; max-width:160px; }
  #tc-layer.mode-buttons #tc-brake { left:auto; right:calc(max(10px, env(safe-area-inset-right)) + min(15vw, 160px) + 10px); }
  .tc-pedal.down, .tc-arrow.down { background:rgba(255,255,255,.32); border-color:rgba(255,255,255,.65); }
  #tc-buttons { position:absolute; top:max(10px, env(safe-area-inset-top)); left:50%; transform:translateX(-50%); display:flex; gap:8px; pointer-events:auto; }
  .tc-btn { min-width:46px; height:40px; padding:0 10px; border-radius:10px; background:rgba(8,12,24,.72); border:1px solid rgba(255,255,255,.25);
    color:#fff; font:800 12px Arial; letter-spacing:1px; display:flex; align-items:center; justify-content:center; }
  .tc-btn.down { background:rgba(255,255,255,.3); }
  #tc-tap { position:absolute; left:50%; top:70%; transform:translate(-50%,-50%); width:38vw; height:24vh; border-radius:20px; display:none;
    background:rgba(255,209,46,.25); border:3px solid #ffd12e; color:#ffd12e; font:900 28px Arial; letter-spacing:3px; align-items:center; justify-content:center; pointer-events:auto; }
  #tc-rotate { position:fixed; inset:0; z-index:200; background:#05060a; color:#dfe8ff; display:none; flex-direction:column; align-items:center; justify-content:center; gap:14px; font:800 16px Arial; letter-spacing:2px; text-align:center; padding:20px; }
  #tc-rotate .ph { width:58px; height:96px; border:4px solid #dfe8ff; border-radius:12px; animation:tcrot 1.8s ease-in-out infinite; }
  @keyframes tcrot { 0%,25% { transform:rotate(0) } 60%,100% { transform:rotate(-90deg) } }
  @media (orientation: portrait) and (pointer: coarse) and (max-width: 900px) { #tc-rotate.need { display:flex; } }
  #tc-setup { position:fixed; inset:0; z-index:150; background:radial-gradient(ellipse at 50% 30%, #10182e 0%, #05060a 75%); display:none;
    flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:20px; text-align:center; }
  #tc-setup.on { display:flex; }
  #tc-setup h3 { font:900 24px Arial; letter-spacing:3px; color:#dfe8ff; }
  #tc-setup p { font:13px Arial; color:#8fa3c8; max-width:560px; line-height:1.5; }
  .tc-choice { display:flex; gap:14px; flex-wrap:wrap; justify-content:center; }
  .tc-opt { width:230px; padding:16px; border-radius:12px; border:2px solid #2c4270; background:#101a30; color:#fff; text-align:left; }
  .tc-opt.sel { border-color:#ffd12e; }
  .tc-opt b { display:block; font:900 16px Arial; letter-spacing:2px; margin-bottom:6px; }
  .tc-opt span { font:12px Arial; color:#8fa3c8; line-height:1.4; }
  .tc-row { display:flex; gap:12px; align-items:center; font:12px Arial; color:#cdd8f0; letter-spacing:1px; }
  .tc-row input[type=range] { width:200px; }
  .tc-go { margin-top:6px; padding:12px 28px; border-radius:8px; border:1px solid #6fa0ff; background:linear-gradient(90deg,#1a3a6b,#2f5ca8); color:#fff; font:900 15px Arial; letter-spacing:2px; }
  #tc-meter { width:220px; height:8px; background:#1a2440; border-radius:4px; position:relative; overflow:hidden; }
  #tc-meter div { position:absolute; top:0; bottom:0; width:6px; left:calc(50% - 3px); background:#ffd12e; border-radius:3px; }
  `;
  function el(tag, attrs, html) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (html != null) e.innerHTML = html; return e; }

  function build() {
    document.head.appendChild(el('style', {}, css));
    // rotate prompt
    const rot = el('div', { id: 'tc-rotate', className: isTouch ? 'need' : '' }, '<div class="ph"></div><div>ROTATE YOUR DEVICE</div><div style="font-weight:400;color:#8fa3c8;letter-spacing:1px">Outlap plays in landscape</div>');
    document.body.appendChild(rot);
    if (!isTouch) return;
    document.body.classList.add('touch');

    const layer = el('div', { id: 'tc-layer' });
    layer.innerHTML = `
      <div id="tc-buttons">
        <div class="tc-btn" data-k="Escape">II</div>
        <div class="tc-btn" data-k="KeyC">CAM</div>
        <div class="tc-btn" data-k="KeyL">LINE</div>
        <div class="tc-btn" data-k="KeyP">PIT</div>
        <div class="tc-btn" data-hold="KeyV">LOOK</div>
        <div class="tc-btn" id="tc-center">⟳ CENTRE</div>
      </div>
      <div class="tc-arrow" id="tc-left">◀</div><div class="tc-arrow" id="tc-right">▶</div>
      <div class="tc-pedal" id="tc-brake">BRAKE</div>
      <div class="tc-pedal" id="tc-gas">THROTTLE</div>
      <div id="tc-tap">TAP!</div>`;
    document.body.appendChild(layer);

    // pressable regions with multi-touch: track which pointers are down where
    const held = new Map();   // pointerId -> element
    const isDown = id => [...held.values()].some(e => e && e.id === id);
    const target = (x, y, fallback) => {
      const e = (document.elementFromPoint && document.elementFromPoint(x, y)) || fallback;
      return e && e.closest ? e.closest('.tc-pedal, .tc-arrow, .tc-btn, #tc-tap') : null;
    };
    layer.addEventListener('pointerdown', ev => {
      const t = target(ev.clientX, ev.clientY, ev.target); if (!t) return;
      ev.preventDefault();
      held.set(ev.pointerId, t); t.classList.add('down');
      if (t.dataset.k) tap(t.dataset.k);
      if (t.dataset.hold) key(t.dataset.hold, 'keydown');
      if (t.id === 'tc-center') recenter();
      if (t.id === 'tc-tap') tap('Space');
      // touch pointers are captured to where they started; release so a
      // thumb can slide from ◀ to ▶ (or brake to throttle) without lifting
      try { if (t.hasPointerCapture && t.hasPointerCapture(ev.pointerId)) t.releasePointerCapture(ev.pointerId); } catch (e) {}
    });
    const slidable = t => t && (t.classList.contains('tc-pedal') || t.classList.contains('tc-arrow'));
    window.addEventListener('pointermove', ev => {
      if (!held.has(ev.pointerId)) return;
      const cur = held.get(ev.pointerId); if (cur && !slidable(cur)) return;
      const t = target(ev.clientX, ev.clientY);
      if (t === cur || (t && !slidable(t))) return;
      held.delete(ev.pointerId);
      if (cur && ![...held.values()].includes(cur)) cur.classList.remove('down');
      if (t) { held.set(ev.pointerId, t); t.classList.add('down'); }
      else held.set(ev.pointerId, null);       // off the pad: nothing pressed until it comes back
    });
    const up = ev => {
      if (!held.has(ev.pointerId)) return;
      const t = held.get(ev.pointerId);
      held.delete(ev.pointerId);
      if (!t) return;
      if (![...held.values()].includes(t)) t.classList.remove('down');
      if (t.dataset.hold) key(t.dataset.hold, 'keyup');
    };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    // safety: app switch / notification shade drops every press
    window.addEventListener('blur', () => { held.forEach((t) => t && t.classList.remove('down')); held.clear(); key('KeyV', 'keyup'); });

    // box-call tyre chips become tappable (1-5)
    document.addEventListener('pointerdown', ev => {
      const chip = ev.target.closest && ev.target.closest('.bc-chip');
      if (!chip) return;
      const n = { soft: 1, medium: 2, hard: 3, inter: 4, wet: 5 }[chip.dataset.t];
      if (n) tap('Digit' + n);
    });

    // live input
    function loop() {
      const g = G();
      const driving = g && g.state === 'driving';
      layer.classList.toggle('on', !!driving && !!cfg.mode);
      input.active = !!driving && !!cfg.mode;
      if (input.active) {
        layer.classList.toggle('mode-buttons', cfg.mode === 'buttons');
        $id('tc-center').style.display = cfg.mode === 'tilt' ? 'flex' : 'none';
        let steer = 0;
        if (cfg.mode === 'tilt' && tiltRaw != null) {
          let d = tiltRaw - (tiltCenter || 0);
          while (d > 180) d -= 360; while (d < -180) d += 360;
          const dz = 2.0;                                       // dead-zone, degrees
          d = Math.sign(d) * Math.max(0, Math.abs(d) - dz);
          let s = Math.max(-1, Math.min(1, d / Math.max(8, cfg.sens)));
          s = Math.sign(s) * Math.pow(Math.abs(s), 1.35);       // finer near centre
          if (cfg.invert) s = -s;
          tiltSm += (s - tiltSm) * 0.35;                        // smoothing
          steer = tiltSm;
        } else if (cfg.mode === 'buttons') {
          steer = (isDown('tc-left') ? 1 : 0) - (isDown('tc-right') ? 1 : 0);
        }
        input.steer = steer;
        input.brake = isDown('tc-brake') ? 1 : 0;
        input.throttle = isDown('tc-gas') || (cfg.autoThrottle && !input.brake) ? 1 : 0;
        // pit-stop reaction game: a big TAP target
        const pg = g && g.player && g.player.pitState === 'stopped' && g.pitGame && !g.pitGame.done;
        $id('tc-tap').style.display = pg ? 'flex' : 'none';
      }
      // recentre automatically as the lights go out
      if (g && g.raceStarted && !loop._started) { loop._started = true; if (cfg.mode === 'tilt') recenter(); }
      if (g && !g.raceStarted) loop._started = false;
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    const firstRun = !cfg.mode;
    buildSetup();
    if (firstRun) openSetup(true);
    else if (cfg.mode === 'tilt') startTilt();
  }
  function $id(id) { return document.getElementById(id); }

  // ---------- control setup (first launch + CONTROLS button) ----------
  function buildSetup() {
    const s = el('div', { id: 'tc-setup' });
    s.innerHTML = `
      <h3>HOW DO YOU WANT TO STEER?</h3>
      <p>Hold the device in landscape like a steering wheel. Pedals: brake on the left, throttle on the right.</p>
      <div class="tc-choice">
        <div class="tc-opt" data-m="tilt"><b>TILT TO STEER</b><span>Turn the device like a wheel. Smooth, analog steering — recommended.</span></div>
        <div class="tc-opt" data-m="buttons"><b>TOUCH BUTTONS</b><span>◀ ▶ buttons on the left. Works anywhere, no motion sensor needed.</span></div>
      </div>
      <div class="tc-row" id="tc-tiltrow">TILT FOR FULL LOCK <input type="range" id="tc-sens" min="10" max="40" step="1"> <span><span id="tc-sensv"></span>°</span></div>
      <div class="tc-row" id="tc-meterrow">STEERING <div id="tc-meter"><div></div></div></div>
      <div class="tc-row"><label><input type="checkbox" id="tc-inv"> INVERT TILT</label> &nbsp; <label><input type="checkbox" id="tc-auto"> AUTO-THROTTLE</label></div>
      <button class="tc-go" id="tc-ok">LET'S RACE</button>`;
    document.body.appendChild(s);
    const sel = m => { cfg.mode = m; s.querySelectorAll('.tc-opt').forEach(o => o.classList.toggle('sel', o.dataset.m === m));
      $id('tc-tiltrow').style.display = $id('tc-meterrow').style.display = m === 'tilt' ? 'flex' : 'none'; };
    s.querySelectorAll('.tc-opt').forEach(o => o.addEventListener('click', () => {
      sel(o.dataset.m);
      if (o.dataset.m === 'tilt') startTilt().then(r => { if (r !== 'granted') { $id('tc-meterrow').innerHTML = 'Motion access was refused — use TOUCH BUTTONS, or allow it in Settings.'; } });
    }));
    $id('tc-sens').value = cfg.sens; $id('tc-sensv').textContent = cfg.sens;
    $id('tc-sens').addEventListener('input', e => { cfg.sens = +e.target.value; $id('tc-sensv').textContent = cfg.sens; });
    $id('tc-inv').checked = cfg.invert; $id('tc-inv').addEventListener('change', e => { cfg.invert = e.target.checked; });
    $id('tc-auto').checked = cfg.autoThrottle; $id('tc-auto').addEventListener('change', e => { cfg.autoThrottle = e.target.checked; });
    $id('tc-ok').addEventListener('click', () => { if (!cfg.mode) sel('tilt'); save(); recenter(); s.classList.remove('on'); goFullscreen(); });
    // live meter while choosing, so you can feel the tilt range
    (function meter() {
      if (s.classList.contains('on') && cfg.mode === 'tilt' && tiltRaw != null) {
        let d = tiltRaw - (tiltCenter || 0); if (cfg.invert) d = -d;
        const f = Math.max(-1, Math.min(1, d / cfg.sens));
        const bar = $id('tc-meter') && $id('tc-meter').firstChild;
        if (bar) bar.style.left = 'calc(' + (50 - f * 50) + '% - 3px)';
      }
      requestAnimationFrame(meter);
    })();
    sel(cfg.mode || 'tilt');
  }
  function openSetup(first) { const s = $id('tc-setup'); if (s) s.classList.add('on'); if (first) cfg.mode = cfg.mode || 'tilt'; }
  window.OUTLAP_OPEN_CONTROLS = () => openSetup(false);

  // Android: real fullscreen + landscape lock (iOS uses Add to Home Screen)
  function goFullscreen() {
    const d = document.documentElement;
    try {
      const p = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : null;
      if (p && p.then) p.then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch (e) {} }).catch(() => {});
    } catch (e) {}
  }
  window.OUTLAP_FULLSCREEN = goFullscreen;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
