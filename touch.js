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
  const cfg = Object.assign({ mode: null, sens: 20, feel: 'balanced', invert: false, autoThrottle: false }, (() => {
    try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; }
  })());
  // BUILD 96: tilt got more direct; move anyone still on the old 22° default
  if (!cfg.v) { if (cfg.sens === 22) cfg.sens = 16; cfg.v = 2; }
  // BUILD 98: the tilt sign is now absolute; an old "invert" was a workaround
  if (cfg.v < 3) { cfg.invert = false; cfg.v = 3; }
  // BUILD 99: smoother steering — wider default range, curved response
  if (cfg.v < 4) { if (cfg.sens <= 16) cfg.sens = 20; cfg.feel = cfg.feel || 'balanced'; cfg.v = 4; }
  // steering feel: response curve (higher = gentler centre) and filter time
  const FEEL = {
    // BUILD 100: every preset a notch calmer (Balanced is the old Smooth+)
    smooth:   { curve: 2.0,  tau: 0.16 },
    balanced: { curve: 1.75, tau: 0.11 },
    direct:   { curve: 1.4,  tau: 0.07 },
  };
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} };
  const input = window.OUTLAP_TOUCH_INPUT = { active: false, steer: 0, throttle: 0, brake: 0 };
  const G = () => window.__G;
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type || 'keydown', { code, bubbles: true }));
  const tap = code => { key(code, 'keydown'); setTimeout(() => key(code, 'keyup'), 60); };

  // ---------- tilt ----------
  // BUILD 98: steering is measured against the HORIZON, not against wherever
  // the phone happened to be at the start. The old auto-centre grabbed the
  // phone's angle as the lights went out — usually while a thumb was pressing
  // the throttle, so "straight" was already a few degrees off and one
  // direction needed more tilt than the other. Level = straight, always;
  // CENTRE adds a small personal trim if wanted.
  // The angle is taken in the DEVICE's own frame (no screen-orientation maths),
  // so it doesn't care whether the page is landscape, portrait-locked or
  // mid-rotation, nor that iOS and Android report gravity with opposite signs.
  let tiltDegSm = 0, brakeT = 0, tiltRaw = null, tiltTrim = 0, tiltSm = 0, tiltOK = false, tiltAxis = null, gammaNow = null;
  // angle of gravity away from the device edge that points down (landscape →
  // the x edge), + = device turned clockwise. Works from either sensor.
  function angleFrom(gx, gy) {
    if (Math.hypot(gx, gy) < 2.5) return null;          // lying flat: meaningless
    // which edge is "down" — locked while driving so a big steer can't flip it
    const axis = (tiltAxis && input.active) ? tiltAxis : (Math.abs(gx) >= Math.abs(gy) ? 'x' : 'y');
    if (!input.active) tiltAxis = axis;
    const along = axis === 'x' ? gx : gy, perp = axis === 'x' ? gy : -gx;
    return Math.atan2(perp * Math.sign(along || 1), Math.abs(along)) * 180 / Math.PI;
  }
  // BUILD 99: prefer the phone's FUSED orientation (gyroscope + accelerometer).
  // Raw accelerometer gravity also contains hand shake, kerb bumps and the
  // jolt of pressing a pedal — that noise was a big part of the twitchiness.
  let lastOrientT = -1e9;
  function onOrient(e) {
    if (e.gamma == null || e.beta == null) return;
    gammaNow = e.gamma;
    const b = e.beta * Math.PI / 180, c = e.gamma * Math.PI / 180;
    // world "up" in the device frame, from the orientation angles
    const a = angleFrom(-Math.cos(b) * Math.sin(c) * 9.81, Math.sin(b) * 9.81);
    if (a == null) return;
    tiltOK = true; tiltRaw = a; lastOrientT = performance.now();
  }
  function onMotion(e) {
    if (performance.now() - lastOrientT < 500) return;   // fused sensor is live: use that
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null) return;
    const a = angleFrom(g.x, g.y);
    if (a == null) return;
    tiltOK = true; tiltRaw = a;
  }
  let listening = false;
  function listen() {
    if (listening) return; listening = true;
    window.addEventListener('devicemotion', onMotion);
  }
  window.addEventListener('deviceorientation', onOrient);   // free on Android; on iOS starts once motion access is granted
  const needsAsk = () => typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
  // must run INSIDE a tap on iOS
  function startTilt() {
    if (!needsAsk()) { listen(); return Promise.resolve(typeof DeviceMotionEvent !== 'undefined' ? 'granted' : 'unsupported'); }
    const asks = [DeviceMotionEvent.requestPermission()];
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function')
      asks.push(DeviceOrientationEvent.requestPermission().catch(() => 'denied'));
    return Promise.all(asks).then(r => { if (r[0] === 'granted') listen(); return r[0]; }).catch(() => 'denied');
  }
  // iOS forgets the grant between launches of a home-screen app and only lets
  // a page ask from a tap — so ask on the FIRST tap anywhere (usually a menu
  // button), instead of making you open CONTROLS every time.
  function armTiltOnFirstTap() {
    if (!needsAsk()) { listen(); return; }
    const once = () => { document.removeEventListener('touchend', once, true); document.removeEventListener('click', once, true); if (!tiltOK) startTilt(); };
    document.addEventListener('touchend', once, true); document.addEventListener('click', once, true);
  }
  function recenter() { if (tiltRaw != null) tiltTrim = Math.abs(tiltRaw) < 12 ? tiltRaw : 0; tiltSm = 0; }
  window.OUTLAP_RECENTER = recenter;

  // ---------- always landscape ----------
  // Phones can't lock orientation from a web page (iOS ignores the manifest).
  // A big steer used to make iOS spin the page to portrait mid-corner and
  // throw up the "rotate your device" screen. Now, whenever the PAGE is
  // portrait on a touch device, the game draws itself rotated 90° so it stays
  // landscape on the glass. With Portrait Orientation Lock on, the page never
  // rotates at all — the smoothest way to play.
  const view = { rot: 0, w: window.innerWidth, h: window.innerHeight };
  window.OUTLAP_VW = () => view.w; window.OUTLAP_VH = () => view.h;
  let saProbe = null;
  function safeAreas() {
    if (!saProbe) { saProbe = document.createElement('div'); saProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'; document.documentElement.appendChild(saProbe); }
    const cs = getComputedStyle(saProbe);
    return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => parseFloat(v) || 0);
  }
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    let rot = 0;
    if (isTouch && H > W) {
      // which way is the phone actually held? (gamma < 0: top of the phone to the left)
      const driving = input.active;
      if (driving && view.rot) rot = view.rot;
      else if (gammaNow != null && Math.abs(gammaNow) > 25) rot = gammaNow < 0 ? 90 : -90;
      else rot = view.rot || 90;
    }
    const lw = rot ? H : W, lh = rot ? W : H;
    const changed = rot !== view.rot || lw !== view.w || lh !== view.h;
    view.rot = rot; view.w = lw; view.h = lh;
    const b = document.body, r = document.documentElement.style;
    if (b) {
      b.classList.toggle('short', isTouch && lh <= 560);
      if (rot) {
        b.style.position = 'fixed'; b.style.left = '0'; b.style.top = '0';
        b.style.width = lw + 'px'; b.style.height = lh + 'px';
        b.style.transformOrigin = '0 0';
        b.style.transform = rot === 90 ? `translateX(${W}px) rotate(90deg)` : `translateY(${H}px) rotate(-90deg)`;
      } else { b.style.position = b.style.left = b.style.top = b.style.width = b.style.height = b.style.transform = ''; }
    }
    r.setProperty('--vh', (lh / 100) + 'px'); r.setProperty('--vw', (lw / 100) + 'px');
    // safe areas follow the rotation (the notch is on a SIDE in landscape)
    const [t, rt, bt, l] = safeAreas();
    const sa = rot === 90 ? [l, t, rt, bt] : rot === -90 ? [rt, bt, l, t] : [t, rt, bt, l];
    ['--sat', '--sar', '--sab', '--sal'].forEach((k, i) => r.setProperty(k, sa[i] + 'px'));
    return changed;
  }
  window.addEventListener('resize', layout);                 // registered before main.js's own resize handler
  window.addEventListener('orientationchange', () => setTimeout(() => { if (layout()) window.dispatchEvent(new Event('resize')); }, 250));
  setInterval(() => { if (layout()) window.dispatchEvent(new Event('resize')); }, 500);   // direction follows how it's held (menus)
  layout();

  // ---------- DOM ----------
  const css = `
  #tc-layer { position:fixed; inset:0; z-index:15; pointer-events:none; display:none; touch-action:none; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
  #tc-layer * { touch-action:none; -webkit-user-select:none; user-select:none; }
  #tc-layer.on { display:block; }
  .tc-pedal, .tc-arrow { position:absolute; bottom:max(10px, var(--sab)); height:calc(var(--vh) * 40); border-radius:18px; pointer-events:auto;
    display:flex; align-items:flex-end; justify-content:center; padding-bottom:12px; font:900 12px Arial; letter-spacing:2px;
    color:rgba(255,255,255,.75); border:2px solid rgba(255,255,255,.18); background:rgba(255,255,255,.08); }
  .tc-pedal { width:calc(var(--vw) * 22); max-width:220px; }
  #tc-brake { left:max(10px, var(--sal)); background:rgba(225,6,0,.16); }
  #tc-gas { right:max(10px, var(--sar)); background:rgba(46,204,113,.16); }
  .tc-arrow { width:calc(var(--vw) * 14); max-width:150px; align-items:center; padding-bottom:0; font-size:30px; display:none; }
  #tc-left { left:max(10px, var(--sal)); }
  #tc-right { left:calc(max(10px, var(--sal)) + min(calc(var(--vw) * 14), 150px) + 10px); }
  /* buttons mode: steer with the left thumb, both pedals under the right */
  #tc-layer.mode-buttons .tc-arrow { display:flex; }
  #tc-layer.mode-buttons .tc-pedal { width:calc(var(--vw) * 15); max-width:160px; }
  #tc-layer.mode-buttons #tc-brake { left:auto; right:calc(max(10px, var(--sar)) + min(calc(var(--vw) * 15), 160px) + 10px); }
  .tc-pedal.down, .tc-arrow.down { background:rgba(255,255,255,.32); border-color:rgba(255,255,255,.65); }
  #tc-buttons { position:absolute; top:max(10px, var(--sat)); left:50%; transform:translateX(-50%); display:flex; gap:8px; pointer-events:auto; }
  .tc-btn { min-width:46px; height:40px; padding:0 10px; border-radius:10px; background:rgba(8,12,24,.72); border:1px solid rgba(255,255,255,.25);
    color:#fff; font:800 12px Arial; letter-spacing:1px; display:flex; align-items:center; justify-content:center; }
  .tc-btn.down { background:rgba(255,255,255,.3); }
  #tc-tap { position:absolute; left:50%; top:70%; transform:translate(-50%,-50%); width:calc(var(--vw) * 38); height:calc(var(--vh) * 24); border-radius:20px; display:none;
    background:rgba(255,209,46,.25); border:3px solid #ffd12e; color:#ffd12e; font:900 28px Arial; letter-spacing:3px; align-items:center; justify-content:center; pointer-events:auto; }
  #tc-gauge { position:absolute; left:50%; top:calc(var(--sat) + 56px); transform:translateX(-50%); width:180px; height:6px; border-radius:3px; background:rgba(8,12,24,.6); display:none; }
  #tc-gauge div { position:absolute; top:0; bottom:0; background:#6fa0ff; border-radius:3px; }
  #tc-gauge i { position:absolute; left:50%; top:-3px; bottom:-3px; width:2px; background:rgba(255,255,255,.7); }
  #tc-gauge.full div { background:#ffd12e; }
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
  .tc-feel { padding:6px 10px; border-radius:6px; border:1px solid #2c4270; background:#101a30; font:800 11px Arial; letter-spacing:1px; }
  .tc-feel.sel { border-color:#ffd12e; color:#ffd12e; }
  #tc-meter { width:220px; height:8px; background:#1a2440; border-radius:4px; position:relative; overflow:hidden; }
  #tc-meter div { position:absolute; top:0; bottom:0; width:6px; left:calc(50% - 3px); background:#ffd12e; border-radius:3px; }
  `;
  function el(tag, attrs, html) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (html != null) e.innerHTML = html; return e; }

  function build() {
    document.head.appendChild(el('style', {}, css));
    // rotate prompt
    const rot = el('div', { id: 'tc-rotate', className: '' }, '<div class="ph"></div><div>ROTATE YOUR DEVICE</div><div style="font-weight:400;color:#8fa3c8;letter-spacing:1px">Outlap plays in landscape</div>');
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
      <div id="tc-tap">TAP!</div>
      <div id="tc-gauge"><div></div><i></i></div>`;
    document.body.appendChild(layer);
    const gauge = $id('tc-gauge'), gaugeBar = gauge.firstChild;

    // pressable regions with multi-touch: track which pointers are down where
    // What's pressed is RE-DERIVED from the full list of fingers on every touch
    // event (e.touches), not tracked press-by-release. iOS sometimes swallows
    // a touchend/pointerup (text-selection or zoom gestures grabbing the
    // touch), and the old press/release bookkeeping then left the brake "held"
    // forever: throttle fought a stuck brake (car wouldn't move) and lifting
    // left brake-at-standstill = reverse. A stale finger can't survive this.
    const held = new Map();   // touch id / pointer id -> element (or null = finger off any pad)
    const isDown = id => [...held.values()].some(e => e && e.id === id);
    const target = (x, y, fallback) => {
      const e = (document.elementFromPoint && document.elementFromPoint(x, y)) || fallback;
      return e && e.closest ? e.closest('.tc-pedal, .tc-arrow, .tc-btn, #tc-tap') : null;
    };
    const slidable = t => !!t && (t.classList.contains('tc-pedal') || t.classList.contains('tc-arrow'));
    function press(t) {
      if (t.dataset.k) tap(t.dataset.k);
      if (t.dataset.hold) key(t.dataset.hold, 'keydown');
      if (t.id === 'tc-center') recenter();
      if (t.id === 'tc-tap') tap('Space');
    }
    function release(t) { if (t && t.dataset.hold && !isDown(t.id)) key(t.dataset.hold, 'keyup'); }
    function paint() {
      layer.querySelectorAll('.down').forEach(e => { if (!isDown(e.id)) e.classList.remove('down'); });
      held.forEach(e => e && e.classList.add('down'));
    }
    function syncTouches(e) {
      const now = new Map();
      for (const tt of e.touches) {
        const id = 't' + tt.identifier, prev = held.get(id);
        let el = target(tt.clientX, tt.clientY, tt.target);
        if (prev === undefined) {                       // a new finger
          if (el) press(el);
        } else if (el !== prev && !(slidable(el) || el === null)) el = prev;   // buttons don't take over a sliding thumb
        else if (el !== prev && !slidable(prev) && prev) el = prev;            // a held button stays held
        now.set(id, el);
      }
      const gone = [];
      held.forEach((el, id) => { if (String(id)[0] === 't' && !now.has(id)) gone.push(el); });
      [...held.keys()].forEach(id => { if (String(id)[0] === 't') held.delete(id); });
      now.forEach((el, id) => held.set(id, el));
      gone.forEach(release);
      paint();
    }
    const inLayer = e => e.target && e.target.closest && e.target.closest('#tc-layer');
    const onTouch = e => {
      if (layer.classList.contains('on') && (inLayer(e) || e.type !== 'touchstart')) {
        if (e.cancelable) e.preventDefault();        // no text selection, magnifier, zoom or scroll
      }
      syncTouches(e);
    };
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(t => document.addEventListener(t, onTouch, { passive: false }));
    // mouse / pen (desktop testing with ?touch=1)
    layer.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'touch') return;
      const t = target(ev.clientX, ev.clientY, ev.target); if (!t) return;
      ev.preventDefault();
      held.set('p' + ev.pointerId, t); press(t); paint();
    });
    window.addEventListener('pointermove', ev => {
      if (ev.pointerType === 'touch') return;
      const id = 'p' + ev.pointerId; if (!held.has(id)) return;
      const cur = held.get(id); if (cur && !slidable(cur)) return;
      const t = target(ev.clientX, ev.clientY);
      if (t !== cur && (t === null || slidable(t))) { held.set(id, t); paint(); }
    });
    const up = ev => {
      if (ev.pointerType === 'touch') return;
      const id = 'p' + ev.pointerId; if (!held.has(id)) return;
      const t = held.get(id); held.delete(id); release(t); paint();
    };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    // safety: app switch / notification shade / tab hidden drops every press
    const dropAll = () => { held.clear(); paint(); key('KeyV', 'keyup'); };
    window.addEventListener('blur', dropAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) dropAll(); });

    // box-call tyre chips become tappable (1-5)
    document.addEventListener('pointerdown', ev => {
      const chip = ev.target.closest && ev.target.closest('.bc-chip');
      if (!chip) return;
      const n = { soft: 1, medium: 2, hard: 3, inter: 4, wet: 5 }[chip.dataset.t];
      if (n) tap('Digit' + n);
    });

    // live input
    function loop(ts) {
      const g = G();
      const driving = g && g.state === 'driving';
      layer.classList.toggle('on', !!driving && !!cfg.mode);
      input.active = !!driving && !!cfg.mode;
      if (!input.active && held.size) { held.clear(); paint(); }   // never carry a press out of a session
      if (input.active) {
        layer.classList.toggle('mode-buttons', cfg.mode === 'buttons');
        $id('tc-center').style.display = cfg.mode === 'tilt' ? 'flex' : 'none';
        let steer = 0;
        if (cfg.mode === 'tilt' && tiltRaw != null) {
          const F = FEEL[cfg.feel] || FEEL.balanced;
          let d = tiltRaw - tiltTrim;
          const dz = 0.6;                                       // dead-zone, degrees
          d = Math.sign(d) * Math.max(0, Math.abs(d) - dz);
          let x = Math.min(1, Math.abs(d) / Math.max(8, cfg.sens));
          // curved response: gentle around centre, full lock still at the
          // same angle. Gets a little gentler still at high speed (fast
          // corners need small, precise inputs; hairpins are slow anyway).
          const v = (g.player && g.player.phys && g.player.phys.speed) || 0;
          const hi = Math.max(0, Math.min(1, (v - 50) / 35));  // 180 → 306 km/h
          let s = Math.sign(d) * Math.pow(x, F.curve + 0.35 * hi);
          s = -s;                                               // clockwise = right = negative steer
          if (cfg.invert) s = -s;
          // time-based low-pass: removes jitter, not intent
          const now = ts || performance.now(), dtS = Math.min(0.1, Math.max(0, (now - (loop._t || now)) / 1000));
          const kf = 1 - Math.exp(-dtS / F.tau);
          tiltSm += (s - tiltSm) * kf;
          steer = tiltSm;
          // how far the phone is turned (deg, + clockwise), smoothed — the
          // camera uses it to keep the horizon level in the real world
          tiltDegSm += ((tiltRaw - tiltTrim) - tiltDegSm) * kf;
          input.tilt = cfg.invert ? -tiltDegSm : tiltDegSm;
        } else if (cfg.mode === 'buttons') {
          steer = (isDown('tc-left') ? 1 : 0) - (isDown('tc-right') ? 1 : 0);
        }
        input.steer = steer;
        input.analog = cfg.mode === 'tilt';
        if (cfg.mode !== 'tilt') input.tilt = 0;
        // progressive brake pedal: a press starts at 55% and builds to full
        // over ~0.4 s — a tap is a lift-and-dab, holding is a stop. An on/off
        // pedal slammed full braking every time, the "twitchy" feel.
        if (isDown('tc-brake')) { brakeT += (performance.now() - (loop._bt || performance.now())) / 1000; input.brake = Math.min(1, 0.55 + 0.45 * brakeT / 0.4); }
        else { brakeT = 0; input.brake = 0; }
        loop._bt = performance.now();
        input.throttle = isDown('tc-gas') || (cfg.autoThrottle && !input.brake) ? 1 : 0;
        // pit-stop reaction game: a big TAP target
        const pg = g && g.player && g.player.pitState === 'stopped' && g.pitGame && !g.pitGame.done;
        $id('tc-tap').style.display = pg ? 'flex' : 'none';
      }
      // steering gauge: shows how much lock you're asking for (fills = full lock)
      if (input.active && cfg.mode === 'tilt') {
        gauge.style.display = 'block';
        const f = Math.max(-1, Math.min(1, -input.steer));
        gaugeBar.style.left = (f < 0 ? 50 + f * 50 : 50) + '%'; gaugeBar.style.width = Math.abs(f) * 50 + '%';
        gauge.classList.toggle('full', Math.abs(f) > 0.97);
      } else gauge.style.display = 'none';
      loop._t = ts || performance.now();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    const firstRun = !cfg.mode;
    buildSetup();
    if (firstRun) openSetup(true);
    else if (cfg.mode === 'tilt') armTiltOnFirstTap();
    layout();
  }
  function $id(id) { return document.getElementById(id); }

  // ---------- control setup (first launch + CONTROLS button) ----------
  function buildSetup() {
    const s = el('div', { id: 'tc-setup' });
    s.innerHTML = `
      <h3>HOW DO YOU WANT TO STEER?</h3>
      <p>Hold the device in landscape like a steering wheel — level is straight ahead. Pedals: brake on the left, throttle on the right.<br>Tip: turn on Portrait Orientation Lock so the screen never spins mid-corner.</p>
      <div class="tc-choice">
        <div class="tc-opt" data-m="tilt"><b>TILT TO STEER</b><span>Turn the device like a wheel. Smooth, analog steering — recommended.</span></div>
        <div class="tc-opt" data-m="buttons"><b>TOUCH BUTTONS</b><span>◀ ▶ buttons on the left. Works anywhere, no motion sensor needed.</span></div>
      </div>
      <div class="tc-row" id="tc-feelrow">STEERING FEEL <span class="tc-feel" data-f="smooth">SMOOTH</span><span class="tc-feel" data-f="balanced">BALANCED</span><span class="tc-feel" data-f="direct">DIRECT</span></div>
      <div class="tc-row" id="tc-tiltrow">TILT FOR FULL LOCK <input type="range" id="tc-sens" min="10" max="40" step="1"> <span><span id="tc-sensv"></span>°</span></div>
      <div class="tc-row" id="tc-meterrow">STEERING <div id="tc-meter"><div></div></div></div>
      <div class="tc-row"><label><input type="checkbox" id="tc-inv"> INVERT TILT</label> &nbsp; <label><input type="checkbox" id="tc-auto"> AUTO-THROTTLE</label></div>
      <button class="tc-go" id="tc-ok">LET'S RACE</button>`;
    document.body.appendChild(s);
    const sel = m => { cfg.mode = m; s.querySelectorAll('.tc-opt').forEach(o => o.classList.toggle('sel', o.dataset.m === m));
      $id('tc-tiltrow').style.display = $id('tc-meterrow').style.display = $id('tc-feelrow').style.display = m === 'tilt' ? 'flex' : 'none'; };
    s.querySelectorAll('.tc-opt').forEach(o => o.addEventListener('click', () => {
      sel(o.dataset.m);
      if (o.dataset.m === 'tilt') startTilt().then(r => { if (r !== 'granted') { $id('tc-meterrow').innerHTML = 'Motion access was refused — use TOUCH BUTTONS, or allow it in Settings.'; } });
    }));
    const feelSel = () => s.querySelectorAll('.tc-feel').forEach(f => f.classList.toggle('sel', f.dataset.f === cfg.feel));
    s.querySelectorAll('.tc-feel').forEach(f => f.addEventListener('click', () => { cfg.feel = f.dataset.f; feelSel(); }));
    feelSel();
    $id('tc-sens').value = cfg.sens; $id('tc-sensv').textContent = cfg.sens;
    $id('tc-sens').addEventListener('input', e => { cfg.sens = +e.target.value; $id('tc-sensv').textContent = cfg.sens; });
    $id('tc-inv').checked = cfg.invert; $id('tc-inv').addEventListener('change', e => { cfg.invert = e.target.checked; });
    $id('tc-auto').checked = cfg.autoThrottle; $id('tc-auto').addEventListener('change', e => { cfg.autoThrottle = e.target.checked; });
    $id('tc-ok').addEventListener('click', () => { if (!cfg.mode) sel('tilt'); save(); s.classList.remove('on'); goFullscreen(); });
    // live meter while choosing, so you can feel the tilt range
    (function meter() {
      if (s.classList.contains('on') && cfg.mode === 'tilt' && tiltRaw != null) {
        let d = tiltRaw - tiltTrim; if (cfg.invert) d = -d;
        const f = Math.max(-1, Math.min(1, d / cfg.sens));
        const bar = $id('tc-meter') && $id('tc-meter').firstChild;
        if (bar) bar.style.left = 'calc(' + (50 + f * 50) + '% - 3px)';
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
