// ============================================================
// WebAudio: V6-hybrid style engine (periodic-wave harmonics),
// downshift barks, gear whine, screech, wind, crashes.
// ============================================================

const AUDIO = (() => {
  // ------------------------------------------------------------------
  // F1 power unit, 2026 spec: 1.6 V6 turbo, ~10.5-12.4k rpm at racing
  // speed, no MGU-H (a freer, slightly louder turbo), big MGU-K.
  // How the sound is built:
  //  * one oscillator per car at the HALF-ORDER of the crank (rpm/120);
  //    its custom waveform holds the engine orders — the 3rd order
  //    (6 cylinders firing every 2 revs: rpm/20, ~600 Hz at 12k) is the
  //    dominant note, its multiples give the scream, the 1.5 order and odd
  //    half-orders give the rasp/burble an even sine stack lacks
  //  * combustion noise: noise amplitude-modulated at the firing rate
  //  * exhaust resonances (parallel band-passes) + a load-dependent low-pass:
  //    bright and hard on throttle, dark on the overrun
  //  * turbo whistle that spools with load and lags; wastegate chuff on lift
  //  * MGU-K whine tied to road speed, loudest when harvesting under braking
  //  * 30ms ignition-cut "crack" on upshifts, blip + pops on downshifts,
  //    limiter bounce, overrun crackle
  //  * the 3 nearest rivals get their own voices: distance, air absorption,
  //    doppler and stereo pan so you HEAR which side a car is on
  // ------------------------------------------------------------------
  let ctx = null;
  let master, noiseBuf = null, engWave = null;
  let muted = false;
  let volume = 0.55;
  let player = null;               // player voice
  const opp = [];                  // rival voices
  let screechGain, windGain, kWhine, kGain;
  let lastGearN = null, cutT = 0, blipT = 0, lastThr = 0, boost = 0;
  const RPMX = 12400;

  function makeNoise() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0;i<len;i++) d[i] = Math.random()*2-1;
    return buf;
  }

  // engine-order spectrum, harmonic n of the half-order fundamental
  // = engine order n/2. Order 3 (n=6) is the firing note.
  function makeEngineWave() {
    const N = 64, re = new Float32Array(N), im = new Float32Array(N);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 1; n < N; n++) {
      let a = 0.05 / Math.pow(n, 0.35);                    // broadband rasp floor
      if (n % 6 === 0) a = 1.0 / Math.pow(n / 6, 0.78);     // firing order + multiples
      else if (n % 3 === 0) a = 0.32 / Math.pow(n / 3, 0.7);// 1.5-order family (V-bank pulses)
      else if (n % 2 === 0) a = 0.09 / Math.pow(n, 0.25);   // whole crank orders
      if (n === 2) a = 0.16;                                 // crank rotation burble
      const ph = rnd() * Math.PI * 2;                        // random phases: less buzzy
      re[n] = a * Math.cos(ph); im[n] = a * Math.sin(ph);
    }
    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }

  function shaperCurve(k) {
    const c = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  // one engine voice: [osc + detuned osc] → drive → (resonances + body) → lowpass → gain → pan
  function makeVoice(isPlayer) {
    const v = {};
    v.osc = ctx.createOscillator(); v.osc.setPeriodicWave(engWave);
    v.osc2 = ctx.createOscillator(); v.osc2.setPeriodicWave(engWave); v.osc2.detune.value = 7;
    const g1 = ctx.createGain(); g1.gain.value = 0.55;
    const g2 = ctx.createGain(); g2.gain.value = 0.28;
    v.drive = ctx.createGain(); v.drive.gain.value = 1;
    const sh = ctx.createWaveShaper(); sh.curve = shaperCurve(2.2); sh.oversample = '2x';
    v.osc.connect(g1); v.osc2.connect(g2); g1.connect(v.drive); g2.connect(v.drive); v.drive.connect(sh);
    // exhaust resonances
    const sum = ctx.createGain(); sum.gain.value = 1;
    const body = ctx.createGain(); body.gain.value = 0.55; sh.connect(body); body.connect(sum);
    for (const [f, q, gn] of [[620, 1.3, 0.5], [1450, 2.2, 0.55], [3300, 3.0, 0.35]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gn; sh.connect(bp); bp.connect(g); g.connect(sum);
    }
    // combustion noise, pulsed at the firing rate
    if (isPlayer) {
      const ns = ctx.createBufferSource(); ns.buffer = noiseBuf; ns.loop = true;
      const nbp = ctx.createBiquadFilter(); nbp.type = 'bandpass'; nbp.frequency.value = 2400; nbp.Q.value = 0.8;
      v.am = ctx.createGain(); v.am.gain.value = 0;
      v.fire = ctx.createOscillator(); v.fire.type = 'sawtooth';
      v.fireDepth = ctx.createGain(); v.fireDepth.gain.value = 0;
      v.fire.connect(v.fireDepth); v.fireDepth.connect(v.am.gain);
      ns.connect(nbp); nbp.connect(v.am); v.am.connect(sum);
      ns.start(); v.fire.start();
    }
    v.lp = ctx.createBiquadFilter(); v.lp.type = 'lowpass'; v.lp.frequency.value = 3000; v.lp.Q.value = 0.6;
    v.gain = ctx.createGain(); v.gain.gain.value = 0;
    sum.connect(v.lp); v.lp.connect(v.gain);
    if (ctx.createStereoPanner) { v.pan = ctx.createStereoPanner(); v.gain.connect(v.pan); v.pan.connect(master); }
    else v.gain.connect(master);
    v.osc.start(); v.osc2.start();
    // turbo whistle (player only)
    if (isPlayer) {
      v.turbo = ctx.createOscillator(); v.turbo.type = 'sine';
      v.turboG = ctx.createGain(); v.turboG.gain.value = 0;
      v.turbo.connect(v.turboG); v.turboG.connect(master); v.turbo.start();
    }
    v.car = null; v.lastD = null;
    return v;
  }

  function init() {
    if (ctx) return;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return; }
    noiseBuf = makeNoise();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);
    engWave = makeEngineWave();
    player = makeVoice(true);
    for (let i = 0; i < 3; i++) opp.push(makeVoice(false));

    // MGU-K whine
    kWhine = ctx.createOscillator(); kWhine.type = 'triangle';
    kGain = ctx.createGain(); kGain.gain.value = 0;
    kWhine.connect(kGain); kGain.connect(master); kWhine.start();

    // tyre screech
    const scrSrc = ctx.createBufferSource(); scrSrc.buffer = noiseBuf; scrSrc.loop = true;
    const scrBP = ctx.createBiquadFilter(); scrBP.type = 'bandpass'; scrBP.frequency.value = 950; scrBP.Q.value = 3.5;
    screechGain = ctx.createGain(); screechGain.gain.value = 0;
    scrSrc.connect(scrBP); scrBP.connect(screechGain); screechGain.connect(master); scrSrc.start();

    // wind
    const windSrc = ctx.createBufferSource(); windSrc.buffer = noiseBuf; windSrc.loop = true;
    const windLP = ctx.createBiquadFilter(); windLP.type = 'lowpass'; windLP.frequency.value = 400;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windLP); windLP.connect(windGain); windGain.connect(master); windSrc.start();
  }

  function ensureRunning() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

  // short filtered noise burst (pops, cracks, chuffs)
  function burst(t, gain, type, freq, q, dur, rate) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    if (rate) src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q || 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    const off = Math.random() * 1.5;
    src.start(t, off); src.stop(t + dur + 0.02);
  }

  function rpmOf(p) {
    if (p.rpm) return p.rpm;
    return 4200 + (p.rpmFrac || 0) * (RPMX - 4200);
  }

  function silence(t) {
    for (const v of [player, ...opp]) { v.gain.gain.setTargetAtTime(0, t, 0.1); if (v.turboG) v.turboG.gain.setTargetAtTime(0, t, 0.1); }
    screechGain.gain.setTargetAtTime(0, t, 0.1);
    windGain.gain.setTargetAtTime(0, t, 0.1);
    kGain.gain.setTargetAtTime(0, t, 0.1);
  }

  function update(p, dt, cars, driving) {
    if (!ctx) return;
    ensureRunning();
    const t = ctx.currentTime;
    if (!p || !driving) { silence(t); return; }
    dt = Math.min(0.1, dt || 0.016);

    const rpm = rpmOf(p);
    const rn = Math.max(0, Math.min(1, (rpm - 4200) / (RPMX - 4200)));
    const thr = p.throttle || 0, brk = p.brake || 0;
    const gN = p.gearN || (typeof p.gear === 'number' ? p.gear : 1);

    // shifts
    if (lastGearN !== null && gN !== lastGearN) {
      if (gN > lastGearN) {                       // upshift: ignition cut + crack
        cutT = 0.032;
        burst(t, 0.05 + rn * 0.05, 'bandpass', 1800, 1.1, 0.05);
      } else {                                    // downshift: blip + pops
        blipT = 0.09;
        burst(t, 0.07, 'bandpass', 900, 0.9, 0.09);
        if (Math.random() < 0.7) burst(t + 0.05 + Math.random() * 0.05, 0.05, 'lowpass', 1400, 0.7, 0.05, 0.7);
      }
    }
    lastGearN = gN;
    cutT = Math.max(0, cutT - dt); blipT = Math.max(0, blipT - dt);

    // limiter bounce
    const limiter = rpm >= RPMX - 30 && thr > 0.8;
    const bounce = limiter ? (Math.sin(t * 2 * Math.PI * 17) > 0 ? 1 : 0.45) : 1;

    // pitch: half-order fundamental (rpm/120); firing note = 6x that
    let f0 = rpm / 120;
    if (blipT > 0) f0 *= 1.06;
    const v = player;
    v.osc.frequency.setTargetAtTime(f0, t, 0.012);
    v.osc2.frequency.setTargetAtTime(f0, t, 0.012);
    v.fire.frequency.setTargetAtTime(f0 * 6, t, 0.012);

    // load: on throttle = hard and bright; overrun = darker
    const load = Math.max(thr, blipT > 0 ? 0.6 : 0);
    v.drive.gain.setTargetAtTime(0.7 + load * 1.4, t, 0.03);
    v.lp.frequency.setTargetAtTime(1500 + load * 2600 + rn * rn * 5200, t, 0.04);
    v.fireDepth.gain.setTargetAtTime(0.05 + load * 0.18, t, 0.04);
    const cut = cutT > 0 ? 0.12 : 1;
    const lvl = (0.09 + load * 0.11 + rn * 0.10) * cut * bounce;
    v.gain.gain.setTargetAtTime(lvl, t, cutT > 0 ? 0.004 : 0.025);
    if (v.pan) v.pan.pan.value = 0;

    // turbo: spools with load (lag), whistle 2.4-6 kHz
    const want = thr * (0.25 + 0.75 * rn);
    boost += (want - boost) * Math.min(1, dt * (want > boost ? 2.2 : 5));
    v.turbo.frequency.setTargetAtTime(2400 + boost * 3600, t, 0.08);
    v.turboG.gain.setTargetAtTime(boost * 0.012, t, 0.08);
    // wastegate / blow-off chuff on a sharp lift at high boost
    if (lastThr > 0.75 && thr < 0.25 && boost > 0.55) burst(t, 0.06, 'highpass', 3000, 0.6, 0.22);
    lastThr = thr;

    // MGU-K: motor speed follows road speed; harvest (braking) is the loud part
    const spd = Math.abs(p.speed || 0);
    kWhine.frequency.setTargetAtTime(180 + spd * 24, t, 0.05);
    kGain.gain.setTargetAtTime(spd > 5 ? (0.004 + brk * 0.016 + thr * 0.004) : 0, t, 0.08);

    // overrun crackle at high revs off throttle
    if (thr < 0.1 && rn > 0.45 && Math.random() < dt * 9) {
      burst(t, 0.03 + Math.random() * 0.05, 'lowpass', 1500, 0.7, 0.03 + Math.random() * 0.05, 0.6 + Math.random() * 0.8);
    }

    // screech + wind
    const scr = (p.wheelSpin > 0.25 ? Math.min(0.15, p.wheelSpin * 0.15) : 0)
      + (p.offTrack && spd > 8 ? 0.05 : 0);
    screechGain.gain.setTargetAtTime(Math.min(0.18, scr), t, 0.08);
    windGain.gain.setTargetAtTime((spd / 95) * 0.11, t, 0.15);

    updateRivals(p, cars, t, dt);
  }

  // the 3 nearest rivals within 140m, each on a sticky voice
  function updateRivals(p, cars, t, dt) {
    const near = [];
    if (cars) for (const c of cars) {
      const q = c.phys; if (!q || q === p || c.retired) continue;
      const dx = q.x - p.x, dz = q.z - p.z, d2 = dx*dx + dz*dz;
      if (d2 < 140*140) near.push({ c, q, dx, dz, d: Math.sqrt(d2) });
    }
    near.sort((a, b) => a.d - b.d); near.length = Math.min(near.length, opp.length);
    // keep voices on the same car while it stays near
    for (const v of opp) if (v.car && !near.find(n => n.c === v.car)) { v.car = null; v.lastD = null; }
    for (const n of near) if (!opp.find(v => v.car === n.c)) { const free = opp.find(v => !v.car); if (free) { free.car = n.c; free.lastD = null; } }
    // listener frame: forward (sin h, cos h); screen-right (-cos h, sin h)
    const h = p.heading || 0, fx = Math.sin(h), fz = Math.cos(h), rx = -Math.cos(h), rz = Math.sin(h);
    for (const v of opp) {
      const n = v.car && near.find(k => k.c === v.car);
      if (!n) { v.gain.gain.setTargetAtTime(0, t, 0.15); continue; }
      // doppler from the closing rate
      const closing = v.lastD == null ? 0 : (v.lastD - n.d) / Math.max(0.005, dt);
      v.lastD = n.d;
      const dop = 343 / (343 - Math.max(-60, Math.min(60, closing)));
      const f0 = rpmOf(n.q) / 120 * dop;
      v.osc.frequency.setTargetAtTime(f0, t, 0.03);
      v.osc2.frequency.setTargetAtTime(f0, t, 0.03);
      const ld = n.q.throttle || 0.5;
      v.drive.gain.setTargetAtTime(0.7 + ld * 1.2, t, 0.05);
      // air absorption: farther = duller; behind = exhaust pointing at you = brighter
      const ahead = (n.dx * fx + n.dz * fz) / (n.d + 0.01);
      v.lp.frequency.setTargetAtTime(Math.max(700, 5200 - n.d * 30) * (ahead > 0 ? 1.15 : 0.85), t, 0.06);
      v.gain.gain.setTargetAtTime(Math.min(0.13, 2.2 / (n.d + 9)), t, 0.06);
      if (v.pan) {
        const side = (n.dx * rx + n.dz * rz) / (n.d + 0.01);
        v.pan.pan.setTargetAtTime(Math.max(-0.95, Math.min(0.95, side * 1.1)), t, 0.05);
      }
    }
  }

  function beep(freq, dur, gain) {
    if (!ctx) return;
    ensureRunning();
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // doppler-style whoosh when passing close to another car
  function whoosh(vol) {
    if (!ctx) return;
    ensureRunning();
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.10);
    bp.frequency.exponentialRampToValueAtTime(300, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.3, vol || 0.2), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 0.33);
  }

  function crash(intensity) {
    if (!ctx) return;
    ensureRunning();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400 + intensity*600;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(Math.min(0.4, 0.1 + intensity*0.35), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(lp); lp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 0.3);
  }

  // ---------- background music ----------
  // Plays ./music.mp3 (drop your own track into the game folder) on loop.
  // Falls back to an original procedural driving loop if the file is absent.
  let musicEl = null, musicFailed = false, procTimer = null, procGain = null, procStep = 0;

  function startProcLoop() {
    if (!ctx || procTimer) return;
    procGain = ctx.createGain();
    procGain.gain.value = 0.10;
    procGain.connect(master);
    // original minor-key driving pattern (bass + fifth stabs)
    const bass = [110, 110, 130.8, 110, 98, 98, 146.8, 130.8];
    procTimer = setInterval(() => {
      if (!ctx || !procGain) return;
      const t = ctx.currentTime;
      const f = bass[procStep % bass.length];
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
      o.connect(g); g.connect(procGain);
      o.start(t); o.stop(t + 0.34);
      if (procStep % 4 === 2) { // sparse upper stab
        const o2 = ctx.createOscillator();
        o2.type = 'sine'; o2.frequency.value = f * 3;
        const g2 = ctx.createGain();
        g2.gain.setValueAtTime(0.0001, t);
        g2.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        o2.connect(g2); g2.connect(procGain);
        o2.start(t); o2.stop(t + 0.25);
      }
      procStep++;
    }, 240);
  }

  let musicDriving = false; // remembered across repeated musicStart() calls

  function musicStart() {
    // repeat calls (every click fires this) must NOT reset the volume —
    // just re-apply whatever the current on-track/menu state is.
    if (musicEl || musicFailed) { musicDuck(musicDriving); return; }
    try {
      musicEl = new Audio('music.mp3');
      musicEl.loop = true;
      musicEl.muted = muted;
      musicEl.addEventListener('error', () => { musicFailed = true; musicEl = null; startProcLoop(); });
      const pr = musicEl.play(); if (pr && pr.catch) pr.catch(() => {});
      musicDuck(musicDriving); // apply correct starting volume
    } catch(e) { musicFailed = true; startProcLoop(); }
  }

  // music keeps playing on track but sits well under the cars; fuller in menus
  function musicDuck(isDriving) {
    musicDriving = isDriving;
    if (musicEl) {
      musicEl.volume = isDriving ? 0.035 : 0.25; // very quiet while driving
      const pr = musicEl.play(); if (pr && pr.catch) pr.catch(() => {});
    }
    if (procGain && ctx) procGain.gain.setTargetAtTime(isDriving ? 0.012 : 0.10, ctx.currentTime, 0.4);
  }

  function toggleMute() {
    muted = !muted;
    if (ctx && master) master.gain.value = muted ? 0 : volume;
    if (musicEl) musicEl.muted = muted;
    return muted;
  }

  return { init, update, beep, crash, whoosh, toggleMute, musicStart, musicDuck, get muted(){return muted;} };
})();
