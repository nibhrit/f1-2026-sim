// ============================================================
// Arcade F1 car physics — used by player and AI alike.
// Units: meters, seconds, radians. Heading 0 = +Z.
// ============================================================

// ---- weather: shared track wetness (0 = dry .. 1 = flooded) ----
// main.js pushes G.weather.wetness here each sim step via setWetness().
let TRACK_WETNESS = 0;
function setWetness(w) { TRACK_WETNESS = Math.max(0, Math.min(1, w || 0)); }

// Effective grip multiplier (~0.5..1.05) for a compound at a given wetness.
// Slicks (wetOptimal 0) are perfect dry and fall off steeply in the wet; the
// wet-weather tyres are bell-curves centred on their optimal wetness, with the
// dry side falling faster (overheating when there's no water to cool them).
// Two independent factors, multiplied:
//  1. SURFACE — wet asphalt simply has less grip, no matter what you fit. Even
//     on perfect wets a soaked track is ~30% down, so wet races are much slower.
//  2. SUITABILITY — how well the compound matches the conditions.
function wetGrip(compound, wetness) {
  const cw = (typeof COMPOUNDS !== 'undefined' && COMPOUNDS[compound]) || { wetOptimal:0 };
  const opt = cw.wetOptimal || 0;
  const w = Math.max(0, Math.min(1, wetness || 0));
  const surface = 1 - 0.34 * w;              // 1.00 dry → 0.66 flooded
  let suit;
  if (opt === 0) {
    // slicks: perfect dry, close to undriveable in standing water
    suit = Math.max(0.42, 1 - w*1.15 + w*w*0.45);
  } else {
    const d = w - opt;
    const k = d < 0 ? 1.35 : 0.55;           // worse too dry than too wet
    suit = Math.max(0.55, 1 - k * d * d);
  }
  return Math.max(0.30, Math.min(1.02, surface * suit));
}

class CarPhysics {
  constructor(track) {
    this.track = track;
    this.x = 0; this.z = 0;
    this.heading = 0;
    this.speed = 0;          // forward speed m/s
    this.vLatDrift = 0;      // small lateral drift component
    this.steer = 0;          // smoothed steer -1..1
    this.throttle = 0;
    this.brake = 0;
    this.trackIdx = 0;       // nearest sample hint
    this.lapDist = 0;        // continuous progress in meters
    this.totalDist = 0;
    this.lap = 1;
    this.offTrack = false;
    this.wheelSpin = 0;
    this.finished = false;
    this.compound = 'medium'; // tyre compound (see COMPOUNDS in tracks.js)
    this.tyreWearKm = 0;      // km driven on the current set
    this.tyreMul = 1;         // last computed tyre grip multiplier
    this.tyreTemp = 0.35;     // 0..1+ — fresh set is cold; working window ~0.6-0.92
    this.tempMul = 0.9;       // grip multiplier from temperature
    this.drsOpen = false;     // rear wing open (set by the game each step)
    this.tow = 0;             // 0..1 slipstream from the car ahead (set by the game)
    this.gripBonus = 1;       // AI car performance handicap (difficulty)
  }

  setTyre(name) { this.compound = name; this.tyreWearKm = 0; this.tyreTemp = 0.35; }

  // 0..1 remaining tyre performance (drives the HUD wear bar)
  get tyreLife() {
    const cw = COMPOUNDS[this.compound];
    const mul = this.tyreMul != null ? this.tyreMul : cw.grip;
    return Math.max(0, Math.min(1, 1 - (cw.grip - mul) / 0.12));
  }

  placeAt(x, z, angle) {
    this.x = x; this.z = z; this.heading = angle;
    this.speed = 0; this.vLatDrift = 0;
    const t = this.track;
    this.trackIdx = t.nearest(x, z, null);
    // if the pick looks like a parallel section (implausible lateral), rescan strictly
    if (Math.abs(t.lateral(x, z, this.trackIdx)) > t.width * 0.8) {
      let best = this.trackIdx, bd = Infinity;
      for (let i = 0; i < t.n; i += 2) {
        const dx = t.px[i]-x, dz = t.pz[i]-z, dd = dx*dx+dz*dz;
        if (dd < bd && Math.abs(t.lateral(x, z, i)) < t.width * 0.8) { bd = dd; best = i; }
      }
      this.trackIdx = best;
    }
    this._syncProgress(true);
  }

  resetToTrack() {
    const t = this.track;
    const i = this.trackIdx;
    this.x = t.px[i]; this.z = t.pz[i];
    this.heading = Math.atan2(t.tx[i], t.tz[i]);
    this.speed = Math.min(this.speed, 15);
    this.vLatDrift = 0;
  }

  // inputs: {throttle:0..1, brake:0..1, steer:-1..1}
  step(dt, inp) {
    const t = this.track;
    // smooth steering (faster return to center)
    const steerSpeed = (Math.abs(inp.steer) > Math.abs(this.steer)) ? 7 : 11;
    this.steer += Math.max(-steerSpeed*dt, Math.min(steerSpeed*dt, inp.steer - this.steer));
    this.throttle = inp.throttle;
    this.brake = inp.brake;

    const v = this.speed;

    // surface (narrow sticky window: car moves <1 sample per step,
    // wide windows can flip to parallel track sections e.g. Monaco pit straight)
    this.trackIdx = t.nearest(this.x, this.z, this.trackIdx, 8);
    const lat = t.lateral(this.x, this.z, this.trackIdx);
    const hw = t.width/2;
    const onKerb = Math.abs(lat) > hw && Math.abs(lat) < hw + 1.6;
    const onGrass = Math.abs(lat) >= hw + 1.6;
    this.offTrack = onGrass;
    this.onKerb = onKerb;

    // kerbs are nearly free; grass costs grip but isn't a wall
    const gripMul = onGrass ? 0.62 : (onKerb ? 0.96 : 1.0);

    // --- tyre temperature: cold tyres grip less, must be worked up to the
    // window; sustained abuse overheats softs. Softs warm fastest.
    const cw = COMPOUNDS[this.compound];
    {
      const push = Math.min(1.3,
        Math.abs(this._lastYaw || 0) * Math.abs(this.speed) / 38 +
        this.throttle * (Math.abs(this.speed) / 200) +
        this.brake * (Math.abs(this.speed) / 120));
      const target = 0.22 + 0.58 * push - TRACK_WETNESS * 0.12; // rain cools the track
      const tau = this.compound === 'soft' ? 16 : this.compound === 'medium' ? 24 :
                  this.compound === 'hard' ? 34 : 18; // inters/wets warm quickly
      this.tyreTemp += (target - this.tyreTemp) * (dt / tau);
      this.tyreTemp = Math.max(0.1, Math.min(1.15, this.tyreTemp));
      const T = this.tyreTemp;
      // window: full grip ~0.55-0.92; cold floor 0.90; overheat dips to ~0.96
      const warm = Math.max(0, Math.min(1, (T - 0.28) / 0.30));
      const hotThresh = this.compound === 'soft' ? 0.92 : 0.98;
      const hot = Math.max(0, Math.min(1, (T - hotThresh) / 0.15));
      this.tempMul = 0.90 + 0.10 * warm * (3 - 2 * warm) * warm - 0.04 * hot;
      // overheating chews the rubber
      var wearMul = hot > 0.3 ? 2.5 : 1;
    }

    // tyre compound grip fades with wear (softs fastest, hards slowest)
    this.tyreWearKm += Math.abs(this.speed) * dt / 1000 * (wearMul || 1);
    this.tyreMul = Math.max(0.90, cw.grip - cw.wearPerKm * this.tyreWearKm);

    // wet-weather grip: compound vs current track wetness (1.0 when dry+slick).
    // Longitudinal (accel/braking) suffers a milder version than lateral grip.
    const wg = wetGrip(this.compound, TRACK_WETNESS);
    this.wetGripMul = wg;
    const longMul = 0.35 + 0.65 * wg; // braking/traction suffer more in the wet

    // --- longitudinal ---
    const REVERSE_MAX = 8; // m/s reverse cap (~29 km/h)
    let accel = 0;
    if (this.throttle > 0) {
      if (this.speed < -0.2) {
        // throttle brakes the car out of reverse
        accel += 26 * this.throttle;
      } else {
        // wet cuts mechanical traction (wheelspin off slow corners) but NOT the
        // aero-drag-limited top end — straights stay fast in the rain, like real F1
        const wetTraction = 0.55 + 0.45 * wg;
        let engine = Math.min(14 * wetTraction, 380 / Math.max(v, 10)) * this.throttle;
        // traction limit: only heavy steering at very low speed costs drive
        if (v < 16 && Math.abs(this.steer) > 0.5) engine *= 0.85;
        accel += engine * (onGrass ? 0.55 : 1);
      }
    }
    if (this.brake > 0) {
      if (this.speed > 0.5) {
        accel -= (30 + v*0.12) * this.brake * gripMul * longMul; // normal braking
      } else if (this.throttle === 0 && this.speed > -REVERSE_MAX) {
        accel -= 9 * this.brake; // reverse gear: back up slowly
      }
    }
    // Drag + rolling resistance always oppose the direction of travel.
    // Two things cut drag on a straight:
    //   DRS open  — sheds ~25% of drag when the wing is stalled
    //   tow (0..1)— running in another car's wake sheds up to a further 16%
    // Measured over a 900 m straight from 250 km/h: DRS is worth +18.8 km/h
    // at the end of it (build 38 was +16.1), a full tow +11.7, and the two
    // together +28.6. Real F1 DRS is around +10-15 km/h, so this is already
    // generous — worth remembering before turning it up again.
    // They stack, which is what makes a DRS-plus-slipstream run down the
    // straight decisive, exactly as it is in the real thing.
    if (Math.abs(v) > 0.3) {
      const dir = Math.sign(v);
      let cd = this.drsOpen ? 0.00045 : 0.0006;
      cd *= (1 - 0.16 * (this.tow || 0));
      accel -= dir * (cd * v * v + 0.4);
      if (onGrass) accel -= dir * 0.018 * Math.abs(v);
    }
    this.speed = v + accel * dt;
    if (this.speed < -REVERSE_MAX) this.speed = -REVERSE_MAX;
    // settle to a clean stop when coasting near zero
    if (Math.abs(this.speed) < 0.06 && this.throttle === 0 && this.brake === 0) this.speed = 0;

    // --- lateral / steering ---
    // mechanical grip + quadratic aero downforce (F ∝ v²), capped ~5.5g
    // trail-braking load transfer gives a little extra front bite
    const latMax = Math.min(55, 28 + 0.0068 * v * v) * gripMul * this.tyreMul * this.tempMul * wg * this.gripBonus * (1 + this.brake * 0.10);
    // grip-aware steering (modern racing-game keyboard assist):
    // steer input commands a FRACTION of available grip, capped by the
    // physical wheel angle. Partial steering can never exceed the limit,
    // so flat-out curved corners cost nothing — like reality.
    let yawRate = 0;
    if (this.speed > 0.3) {
      const maxYawGrip = latMax / Math.max(this.speed, 1);
      const maxYawGeom = this.speed * Math.tan(0.28 / (1 + v * 0.012)) / 3.2; // full-lock geometry, wheelbase 3.2
      const yawCap = Math.min(maxYawGrip * 1.1, maxYawGeom);
      yawRate = this.steer * yawCap;
      const use = Math.abs(yawRate) / maxYawGrip; // fraction of grip in use
      if (use > 1) {
        // only reachable near full lock: clamp + mild scrub
        yawRate = Math.sign(yawRate) * maxYawGrip;
        this.speed = Math.max(0, this.speed - Math.min(3, (use - 1) * 12) * dt);
      }
      // tyres sing when leaning on >92% of grip
      if (use > 0.92) this.wheelSpin = Math.min(1, this.wheelSpin + dt*2.5);
      else this.wheelSpin = Math.max(0, this.wheelSpin - dt*4);
    } else if (this.speed < -0.2) {
      // reversing: gentle geometry-based yaw (steer turns the car the natural way)
      yawRate = this.speed * Math.tan(this.steer * 0.28) / 3.2;
      this.wheelSpin = Math.max(0, this.wheelSpin - dt*4);
    }
    this.heading += yawRate * dt;
    this._lastYaw = yawRate; // used by the tyre-temperature model next step

    // aquaplaning: standing water at high speed → occasional twitch / grip loss
    if (TRACK_WETNESS > 0.6 && this.speed > 75 && Math.random() < (TRACK_WETNESS - 0.6) * 0.12) {
      this.vLatDrift += (Math.random() - 0.5) * 3.2 * TRACK_WETNESS;
      this.heading += (Math.random() - 0.5) * 0.02 * TRACK_WETNESS;
      this.speed *= 0.995;
      this.aquaplaning = true;
    } else this.aquaplaning = false;

    // --- integrate position ---
    const sx = Math.sin(this.heading), cz = Math.cos(this.heading);
    this.x += sx * this.speed * dt + Math.cos(this.heading) * this.vLatDrift * dt;
    this.z += cz * this.speed * dt - Math.sin(this.heading) * this.vLatDrift * dt;
    this.vLatDrift *= Math.max(0, 1 - 6*dt);

    // --- barrier clamp ---
    this.trackIdx = t.nearest(this.x, this.z, this.trackIdx, 8);
    const lat2 = t.lateral(this.x, this.z, this.trackIdx);
    const wall = t.wallOff || (hw + 8.2);
    this.wallHit = 0;
    if (Math.abs(lat2) > wall) {
      const p = t.posAt(this.trackIdx, Math.sign(lat2) * (wall - 0.2));
      this.x = p.x; this.z = p.z;
      // align to wall and scrub speed based on impact angle (wall-ride)
      const ta = Math.atan2(t.tx[this.trackIdx], t.tz[this.trackIdx]);
      let dh = ta - this.heading;
      while (dh > Math.PI) dh -= 2*Math.PI;
      while (dh < -Math.PI) dh += 2*Math.PI;
      const sev = Math.abs(Math.sin(dh));
      this.speed *= Math.max(0.35, 1 - sev * 0.09);
      this.heading += dh * 0.35;
      this.wallHit = sev;
    }

    this._syncProgress(false);
  }

  _syncProgress(force) {
    const t = this.track;
    const newDist = t.dist[this.trackIdx];
    if (force) { this.lapDist = newDist; return; }
    let delta = newDist - this.lapDist;
    // wrap detection (guard against jitter double-crossings)
    if (this._lastCrossDist == null) this._lastCrossDist = -1e9;
    if (delta < -t.length * 0.5) {
      delta += t.length;
      if (this.totalDist - this._lastCrossDist > t.length * 0.5) {
        this.lap++; this.crossedLine = true;
        this._lastCrossDist = this.totalDist;
      } else this.crossedLine = false;
    }
    else if (delta > t.length * 0.5) { delta -= t.length; this.lap = Math.max(1, this.lap-1); }
    else this.crossedLine = false;
    if (Math.abs(delta) < t.length * 0.5) this.totalDist += delta;
    this.lapDist = newDist;
  }

  get progress() { // total race progress for ordering
    return this.totalDist;
  }

  get kmh() { return Math.round(Math.abs(this.speed) * 3.6); }

  get gear() {
    if (this.speed < -0.5) return 'R';
    const v = this.kmh;
    if (v < 3) return 'N';
    const gears = [0, 45, 85, 125, 165, 205, 250, 300];
    for (let g = gears.length-1; g >= 1; g--) if (v >= gears[g-1]) return g;
    return 1;
  }

  get rpmFrac() {
    const v = this.kmh;
    const gears = [0, 45, 85, 125, 165, 205, 250, 300, 360];
    let g = 1;
    for (let i = gears.length-2; i >= 1; i--) if (v >= gears[i-1]) { g = i; break; }
    const lo = gears[g-1], hi = gears[g];
    return Math.min(1, 0.35 + 0.65 * (v - lo) / (hi - lo));
  }
}
