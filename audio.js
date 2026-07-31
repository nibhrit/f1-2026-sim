// ============================================================
// WebAudio: V6-hybrid style engine (periodic-wave harmonics),
// downshift barks, gear whine, screech, wind, crashes.
// ============================================================

const AUDIO = (() => {
  let ctx = null;
  let master, engGain, engFilter, osc1, osc2, subOsc, whine, whineGain, vibrato, vibGain;
  let screechGain, windGain, oppGain, oppOsc;
  let noiseBuf = null;
  let muted = false;
  let volume = 0.55;
  let lastGear = null;
  let gearBlip = 0, barkTimer = 0;

  function makeNoise() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0;i<len;i++) d[i] = Math.random()*2-1;
    return buf;
  }

  function init() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) { return; }
    noiseBuf = makeNoise();

    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);

    // ---- engine: harmonic-rich periodic wave, gently saturated ----
    // spectrum approximating a screaming V6 exhaust
    const H = [0, 1.0, 0.62, 0.78, 0.40, 0.26, 0.32, 0.16, 0.10, 0.07, 0.05, 0.035, 0.025];
    const real = new Float32Array(H.length);
    const imag = new Float32Array(H);
    const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });

    const shaper = ctx.createWaveShaper();
    {
      const curve = new Float32Array(1024);
      for (let i=0;i<1024;i++) {
        const x = i/512 - 1;
        curve[i] = Math.tanh(1.9 * x);
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
    }
    engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 1500;
    engFilter.Q.value = 0.7;
    engGain = ctx.createGain();
    engGain.gain.value = 0;
    shaper.connect(engFilter); engFilter.connect(engGain); engGain.connect(master);

    const mix = ctx.createGain(); mix.gain.value = 0.6;
    mix.connect(shaper);

    osc1 = ctx.createOscillator(); osc1.setPeriodicWave(wave);
    osc2 = ctx.createOscillator(); osc2.setPeriodicWave(wave); osc2.detune.value = 9;
    subOsc = ctx.createOscillator(); subOsc.type = 'square';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.34;
    const g3 = ctx.createGain(); g3.gain.value = 0.15;
    osc1.connect(g1); g1.connect(mix);
    osc2.connect(g2); g2.connect(mix);
    subOsc.connect(g3); g3.connect(mix);
    osc1.start(); osc2.start(); subOsc.start();

    // organic vibrato on fundamental
    vibrato = ctx.createOscillator(); vibrato.frequency.value = 31;
    vibGain = ctx.createGain(); vibGain.gain.value = 1.2;
    vibrato.connect(vibGain);
    vibGain.connect(osc1.frequency);
    vibGain.connect(osc2.frequency);
    vibrato.start();

    // high gearbox/turbo whine
    whine = ctx.createOscillator(); whine.type = 'sine';
    whineGain = ctx.createGain(); whineGain.gain.value = 0;
    whine.connect(whineGain); whineGain.connect(master);
    whine.start();

    // ---- tire screech ----
    const scrSrc = ctx.createBufferSource();
    scrSrc.buffer = noiseBuf; scrSrc.loop = true;
    const scrBP = ctx.createBiquadFilter();
    scrBP.type = 'bandpass'; scrBP.frequency.value = 950; scrBP.Q.value = 3.5;
    screechGain = ctx.createGain(); screechGain.gain.value = 0;
    scrSrc.connect(scrBP); scrBP.connect(screechGain); screechGain.connect(master);
    scrSrc.start();

    // ---- wind ----
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuf; windSrc.loop = true;
    const windLP = ctx.createBiquadFilter();
    windLP.type = 'lowpass'; windLP.frequency.value = 400;
    windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windLP); windLP.connect(windGain); windGain.connect(master);
    windSrc.start();

    // ---- nearest opponent ----
    oppOsc = ctx.createOscillator(); oppOsc.setPeriodicWave(wave);
    const oppLP = ctx.createBiquadFilter();
    oppLP.type = 'lowpass'; oppLP.frequency.value = 1600;
    oppGain = ctx.createGain(); oppGain.gain.value = 0;
    oppOsc.connect(oppLP); oppLP.connect(oppGain); oppGain.connect(master);
    oppOsc.start();
  }

  function ensureRunning() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // V6 firing frequency: ~195Hz at low revs → ~590Hz at the limiter
  function engineFreq(rpmFrac) {
    const rn = Math.max(0, (rpmFrac - 0.35) / 0.65);
    return 190 + Math.pow(rn, 1.1) * 395;
  }

  function update(player, dt, cars, driving) {
    if (!ctx) return;
    ensureRunning();
    const t = ctx.currentTime;

    if (!player || !driving) {
      engGain.gain.setTargetAtTime(0, t, 0.1);
      screechGain.gain.setTargetAtTime(0, t, 0.1);
      windGain.gain.setTargetAtTime(0, t, 0.1);
      whineGain.gain.setTargetAtTime(0, t, 0.1);
      if (oppGain) oppGain.gain.setTargetAtTime(0, t, 0.1);
      return;
    }

    const rpm = player.rpmFrac;
    const rn = Math.max(0, (rpm - 0.35) / 0.65);

    // gear changes
    const gear = player.gear;
    if (lastGear !== null && gear !== lastGear) {
      if (typeof gear === 'number' && typeof lastGear === 'number' && gear < lastGear) {
        // downshift bark: rev-match blip
        barkTimer = 0.12;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.9;
        const gg = ctx.createGain();
        gg.gain.setValueAtTime(0.14, t);
        gg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        src.connect(bp); bp.connect(gg); gg.connect(master);
        src.start(t); src.stop(t + 0.15);
      } else {
        // upshift: 40ms ignition cut
        gearBlip = 0.04;
      }
    }
    lastGear = gear;
    gearBlip = Math.max(0, gearBlip - dt);
    barkTimer = Math.max(0, barkTimer - dt);

    let f = engineFreq(rpm);
    if (barkTimer > 0) f *= 1.16;             // downshift blip
    const cutMul = gearBlip > 0 ? 0.25 : 1;   // upshift cut

    osc1.frequency.setTargetAtTime(f, t, 0.02);
    osc2.frequency.setTargetAtTime(f, t, 0.02);
    subOsc.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    whine.frequency.setTargetAtTime(f * 6.04, t, 0.03);
    engFilter.frequency.setTargetAtTime(900 + rn * rn * 7800, t, 0.04);

    const idle = 0.12;
    const load = 0.12 + player.throttle * 0.18 + rn * 0.14 + (barkTimer > 0 ? 0.08 : 0);
    engGain.gain.setTargetAtTime(Math.max(idle, load) * cutMul, t, 0.035);
    whineGain.gain.setTargetAtTime((0.012 + rn * 0.022) * (player.throttle > 0.2 ? 1 : 0.4), t, 0.06);

    // off-throttle crackle at high revs
    if (player.throttle < 0.1 && rn > 0.4 && Math.random() < dt * 8) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.playbackRate.value = 0.6 + Math.random()*0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1600;
      const gg = ctx.createGain();
      gg.gain.setValueAtTime(0.04 + Math.random()*0.05, t);
      gg.gain.exponentialRampToValueAtTime(0.001, t + 0.04 + Math.random()*0.05);
      src.connect(lp); lp.connect(gg); gg.connect(master);
      src.start(t); src.stop(t + 0.12);
    }

    // screech
    const scr = (player.wheelSpin > 0.25 ? Math.min(0.15, player.wheelSpin * 0.15) : 0)
      + (player.offTrack && player.speed > 8 ? 0.05 : 0);
    screechGain.gain.setTargetAtTime(Math.min(0.18, scr), t, 0.08);

    // wind
    windGain.gain.setTargetAtTime((player.speed / 95) * 0.13, t, 0.15);

    // nearest opponent
    let best = null, bd = 1e9;
    if (cars) for (const c of cars) {
      if (!c.phys || c.phys === player) continue;
      const dx = c.phys.x - player.x, dz = c.phys.z - player.z;
      const dd = dx*dx + dz*dz;
      if (dd < bd) { bd = dd; best = c.phys; }
    }
    if (best && bd < 3600) {
      const d = Math.sqrt(bd);
      oppOsc.frequency.setTargetAtTime(engineFreq(best.rpmFrac) * 1.02, t, 0.05);
      oppGain.gain.setTargetAtTime(Math.min(0.12, 3/(d+8)), t, 0.1);
    } else if (oppGain) {
      oppGain.gain.setTargetAtTime(0, t, 0.15);
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
