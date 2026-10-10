// ============================================================
// Arcade F1 car physics — used by player and AI alike.
// Units: meters, seconds, radians. Heading 0 = +Z.
// ============================================================

// ---- weather: shared track wetness (0 = dry .. 1 = flooded) ----
// main.js pushes G.weather.wetness here each sim step via setWetness().
let TRACK_WETNESS = 0;
function setWetness(w) { TRACK_WETNESS = Math.max(0, Math.min(1, w || 0)); }
// The AI's difficulty grip bonus fades as the track gets wet. In the dry the AI
// can't use all of it (power/execution-limited), but in the wet grip becomes
// THE limit, so a full +30% bonus let the AI lose only ~9% in heavy rain while
// the player's car lost ~20%. Fading it keeps the wet gap in line with the dry
// one. Shared by physics and the AI planner so they always agree.
function effGripBonus(b) {
  b = b || 1;
  if (b <= 1) return b;
  return 1 + (b - 1) * (1 - WET_BONUS_FADE * TRACK_WETNESS);
}
let WET_BONUS_FADE = 0.6;

// Driving aids. AI cars always run these (their controller drives inside the
// limit anyway); the player's come from the assists menu.
// circle 0.6: the AI's planner brakes into turn-in a little; at full circle
// strength it ran wide (Japan/Monaco/Qatar off-track, +2-8 s/lap). 0.6 costs
// it ~0.1-0.3 s and keeps every difficulty clean.
const AI_ASSISTS = { abs: true, steer: true, absEff: 1, circle: 0.6 };
const BRAKE_SYS = 60;        // m/s^2 the brake system asks for at 100% pedal
const LOCK_AT = 1.6;         // pedal demand / tyre grip ratio that locks a wheel
const UNLOCK_AT = 1.25;      // ...and the ratio you must ease back under to free it

// Standing water. Fixed places on the lap (seeded by track length) so a
// puddle is always in the same spot and can be learned, mainly on straights
// where water pools, strength 0..1. Replaces the old per-frame random kicks
// (3-4 unpredictable twitches a second at 270 km/h in heavy rain).
// drivetrain: top speed (km/h) of each gear at the limiter
const RPM_MAX = 12400, RPM_IDLE = 4200;
const GEAR_TOP_KMH = [0, 92, 132, 168, 203, 238, 272, 307, 348];
function puddleAt(track, lapDist, idx) {
  const s = track.length * 0.0137;
  const a = Math.sin(lapDist * 0.019 + s) * Math.sin(lapDist * 0.0067 + s * 1.7);
  const pud = Math.max(0, (a - 0.45) / 0.55);
  const straight = Math.max(0, 1 - Math.abs(track.curv[idx] || 0) * 150);
  return pud * straight;
}

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
    // ---- damage ----
    // 0 = pristine, 1 = destroyed. Each has its own consequence:
    //   wing  — front downforce loss, so the car understeers progressively
    //   floor — overall downforce loss, worst in fast corners
    //   punct — one tyre deflating: heavy grip loss, must pit
    //   dead  — suspension/chassis failure, race over
    this.dmgWing = 0;
    this.dmgFloor = 0;
    this.puncture = 0;
    this.dead = false;
    this.inPit = false;
    this.lastImpact = 0;      // severity of the most recent hit, for effects
    this.gripBonus = 1;       // AI car performance handicap (difficulty)
  }

  setTyre(name) { this.compound = name; this.tyreWearKm = 0; this.tyreTemp = 0.35; this.flatSpot = 0; }

  // 0..1 remaining tyre performance (drives the HUD wear bar)
  get tyreLife() {
    const cw = COMPOUNDS[this.compound];
    const mul = this.tyreMul != null ? this.tyreMul : cw.grip;
    return Math.max(0, Math.min(1, 1 - (cw.grip - mul) / 0.12));
  }

  placeAt(x, z, angle) {
    this.x = x; this.z = z; this.heading = angle;
    this.speed = 0; this.vLatDrift = 0; this.locked = false;
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
    this.vLatDrift = 0; this.locked = false;
  }

  // inputs: {throttle:0..1, brake:0..1, steer:-1..1}
  step(dt, inp) {
    const t = this.track;
    // smooth steering (faster return to center)
    // Slower than before (was 7/11). With realistic grip, instant lock-to-lock
    // on a keyboard just spins the car; real steering isn't instant either.
    const steerSpeed = (Math.abs(inp.steer) > Math.abs(this.steer)) ? 4.5 : 8;
    this.steer += Math.max(-steerSpeed*dt, Math.min(steerSpeed*dt, inp.steer - this.steer));
    // Pedal travel. A keyboard gives instant 0->100%, which is a big part of
    // why the car felt weightless: real brake pressure builds over ~0.2s and
    // throttle is fed in, not switched on. Release is quicker than application,
    // as it is in a real car.
    const rate = (cur, want, up, down) => {
      const r = (want > cur ? up : down) * dt;
      return cur + Math.max(-r, Math.min(r, want - cur));
    };
    if (this.dead) { inp = { throttle: 0, brake: 1, steer: 0 }; }
    this.throttle = rate(this.throttle, inp.throttle, 4.5, 9);
    this.brake    = rate(this.brake,    inp.brake,    6.0, 11);

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
    const gripMul = onGrass ? 0.45 : (onKerb ? 0.94 : 1.0);

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
    const A = this.assists || AI_ASSISTS;

    // ---- the grip budget ----
    // Lateral limit = mechanical grip + downforce (F ∝ v²), capped ~5.4g.
    //   54 km/h 2.0g · 90 km/h 2.5g · 144 km/h 3.5g · 216+ km/h 5.4g
    // Damage bites the aero term hardest (crippling in fast corners, barely felt
    // in slow ones); a flat-spotted tyre costs a little everywhere.
    const aeroLoss = 1 - Math.min(0.55, this.dmgWing * 0.30 + this.dmgFloor * 0.28);
    const punctLoss = 1 - this.puncture * 0.45;
    let aq = 0;
    if (TRACK_WETNESS > 0.6 && v > 65) {
      aq = ((TRACK_WETNESS - 0.6) / 0.4) * Math.min(1, (v - 65) / 25) * puddleAt(t, this.lapDist, this.trackIdx);
    }
    this.aquaplane = aq;
    this.aquaplaning = aq > 0.2;
    const latMax = (1 - 0.30 * aq) * Math.min(53 * aeroLoss, 17.6 + 0.0104 * v * v * aeroLoss) * punctLoss
      * gripMul * this.tyreMul * this.tempMul * wg * effGripBonus(this.gripBonus) * (1 - 0.04 * (this.flatSpot || 0));
    // Braking and cornering share ONE budget (friction circle). How much of the
    // lateral grip the tyres used last step limits what is left for braking and
    // traction this step, and vice versa. Floors keep it sim-cade: you can still
    // trail a little brake into a corner, but full brake + full lock = run wide.
    // how hard the circle bites. The AI's is softened, and fades further in the
    // wet, where its planner's braking points have the least margin
    const circ = A.circle != null ? A.circle * Math.max(0, 1 - 1.15 * TRACK_WETNESS) : 1;   // same for you and the AI
    const uLat = Math.min(1, this._latUse || 0) * circ;
    const uLatB = uLat * 0.7;                       // BUILD 82: softened with the turn side (was 1.0)
    const circleBrake = Math.sqrt(Math.max(0.2, 1 - uLatB * uLatB));
    const circleDrive = Math.sqrt(Math.max(0.3, 1 - uLat * uLat));

    // --- longitudinal ---
    const REVERSE_MAX = 8; // m/s reverse cap (~29 km/h)
    let accel = 0;
    this.tcActive = false;
    if (this.throttle > 0) {
      if (this.speed < -0.2) {
        // throttle brakes the car out of reverse
        accel += 26 * this.throttle;
      } else {
        // wet cuts mechanical traction (wheelspin off slow corners) but NOT the
        // aero-drag-limited top end — straights stay fast in the rain, like real F1
        const wetTraction = 0.55 + 0.45 * wg;
        // Traction-limited at low speed, then power-limited up top.
        const tractionCap = (8.6 + 0.22 * Math.min(v, 25)) * wetTraction;   // 0.88g at rest -> 1.43g by 90 km/h
        const power = 470 / Math.max(v, 10);
        let engine;
        if (tractionCap < power) {
          // traction-limited: the rear tyres share their grip with cornering
          const avail = tractionCap * circleDrive;
          const demand = tractionCap * this.throttle;
          const over = demand / Math.max(0.1, avail) - 1;      // >0 = asking for more than the tyres have
          if (over > 0) {
            // traction control (always on): cuts power cleanly instead of
            // letting the rear spin — no slides on a keyboard
            engine = avail * 0.97; this.tcActive = over > 0.05;
          } else engine = demand;
        } else {
          engine = Math.min(power, tractionCap) * this.throttle;
        }
        // traction limit: only heavy steering at very low speed costs drive
        if (v < 16 && Math.abs(this.steer) > 0.5) engine *= 0.85;
        accel += engine * (onGrass ? 0.40 : 1) * (1 - this.puncture * 0.35);
      }
    }
    // Brakes. Downforce-limited grip: savage at speed, much weaker once slow.
    //   72 km/h 2.3g · 144 km/h 3.6g · 216 km/h 5.7g · 288 km/h 5.9g
    // The pedal asks for a brake force; the tyres can only deliver what the
    // circle leaves them. Without ABS, asking for far more than that locks the
    // fronts — which is what happens if you stay on full brake as the car slows
    // and the downforce bleeds away, or brake hard while still turning.
    const brakeGrip = Math.min(58, 18 + 0.0105 * v * v) * gripMul * longMul;
    let decel = 0;
    if (this.brake > 0) {
      if (this.speed > 0.5) {
        const avail = brakeGrip * circleBrake;
        const demand = this.brake * BRAKE_SYS;
        this.absActive = false;
        if (A.abs) { decel = Math.min(demand, avail * (A.absEff || 1)); this.locked = false; this.absActive = demand > avail * LOCK_AT; }
        else {
          if (!this.locked && demand > avail * LOCK_AT && v > 7) this.locked = true;
          else if (this.locked && (demand < avail * UNLOCK_AT || v < 4)) this.locked = false;
          decel = this.locked ? avail * 0.85 : Math.min(demand, avail);
        }
        accel -= decel;
      } else if (this.throttle === 0 && this.speed > -REVERSE_MAX) {
        accel -= 9 * this.brake; // reverse gear: back up slowly
        this.locked = false;
      }
    } else this.locked = false;
    // locking up flat-spots the tyre (vibration, wear, a little grip)
    if (this.locked) {
      this.flatSpot = Math.min(1, (this.flatSpot || 0) + dt * 0.3 * Math.min(1, v / 40));
      this.tyreWearKm += Math.abs(v) * dt / 1000 * 3;
    }
    // Drag + rolling resistance always oppose the direction of travel.
    //   DRS open  — sheds ~25% of drag when the wing is stalled
    //   tow (0..1)— running in another car's wake sheds up to a further 16%
    if (Math.abs(v) > 0.3) {
      const dir = Math.sign(v);
      let cd = this.drsOpen ? 0.00045 : 0.0006;
      cd *= (1 - 0.16 * (this.tow || 0));
      accel -= dir * (cd * v * v + 0.4);
      if (onGrass) accel -= dir * 0.030 * Math.abs(v);   // cutting must not pay
    }
    this.speed = v + accel * dt;
    // how hard this car is slowing right now (the AI behind reads it)
    this.decelNow = Math.max(0, -accel);
    if (this.speed < -REVERSE_MAX) this.speed = -REVERSE_MAX;
    // settle to a clean stop when coasting near zero
    if (Math.abs(this.speed) < 0.06 && this.throttle === 0 && this.brake === 0) this.speed = 0;

    // --- lateral / steering ---
    // What's left of the lateral budget after braking. A light brake actually
    // helps the turn-in (weight on the nose: "trail braking"); heavy braking
    // eats the grip you need to turn. A locked front can't steer at all.
    const uLong = (brakeGrip > 0 ? Math.min(1, decel / brakeGrip) : 0) * circ;
    // BUILD 82: softened — full braking used to leave ~45% of the turning grip
    // and the car felt like it wouldn't turn; now ~85% (and turning costs the
    // brakes less too), so trail-braking into a corner works again.
    const uTurn = uLong * 0.55;
    let latAvail = latMax * Math.sqrt(Math.max(0.2, 1 - uTurn * uTurn)) * (1 + 0.12 * Math.sin(Math.PI * uLong));
    if (this.locked) latAvail *= 0.22;
    let yawRate = 0;
    if (this.speed > 0.3) {
      const maxYawGrip = latAvail / Math.max(this.speed, 1);
      const maxYawGeom = this.speed * Math.tan(0.28 / (1 + v * 0.012)) / 3.2; // full-lock geometry, wheelbase 3.2
      if (A.steer) {
        // steering assist: the key asks for a FRACTION of the grip available,
        // so you can't over-drive the fronts — but braking still shrinks it
        // Full key = exactly the grip limit for the player, so a flat-out
        // corner costs no speed: the car turns as hard as the tyres allow and
        // that's it. (It used to ask for 110%, scrubbing speed and making the
        // engine note dip every time you steered.) The AI's controller was
        // tuned against the 110% ceiling, so it keeps it.
        const ask = A === AI_ASSISTS ? 1.1 : 1.0;
        const yawCap = Math.min(maxYawGrip * ask, maxYawGeom);
        yawRate = this.steer * yawCap;
        const use = Math.abs(yawRate) / maxYawGrip;
        if (use > 1) {
          yawRate = Math.sign(yawRate) * maxYawGrip;
          this.speed = Math.max(0, this.speed - Math.min(3, (use - 1) * 12) * dt);
        }
        // tyres squeal only when actually over the limit
        if (use > 1.02) this.wheelSpin = Math.min(1, this.wheelSpin + dt*2.5);
        else this.wheelSpin = Math.max(0, this.wheelSpin - dt*4);
      } else {
        // raw steering: the key turns the wheels. Ask for more than the fronts
        // can give and they slide — the car pushes wide and scrubs speed.
        const want = this.steer * maxYawGeom;
        const over = Math.abs(want) / Math.max(1e-3, maxYawGrip);
        if (over > 1) {
          yawRate = Math.sign(want) * maxYawGrip * Math.max(0.82, 1 - (over - 1) * 0.15);
          this.speed = Math.max(0, this.speed - Math.min(6, (over - 1) * 14) * dt);
          this.wheelSpin = Math.min(1, this.wheelSpin + dt * 4);
          this.understeer = Math.min(1, over - 1);
        } else {
          yawRate = want;
          this.wheelSpin = Math.max(0, this.wheelSpin - dt*4);
          this.understeer = 0;
        }
      }
      if (this.locked) this.wheelSpin = Math.min(1, this.wheelSpin + dt * 6);
    } else if (this.speed < -0.2) {
      // reversing: gentle geometry-based yaw (steer turns the car the natural way)
      yawRate = this.speed * Math.tan(this.steer * 0.28) / 3.2;
      this.wheelSpin = Math.max(0, this.wheelSpin - dt*4);
    }
    // a deflating tyre pulls the car steadily to one side
    if (this.puncture > 0 && Math.abs(v) > 3) {
      if (this._punctSide == null) this._punctSide = Math.random() < 0.5 ? -1 : 1;
      yawRate += this._punctSide * this.puncture * 0.05 * Math.min(1, Math.abs(v)/30);
      this.speed = Math.max(0, this.speed - this.puncture * 1.4 * dt);
    }
    this.heading += yawRate * dt;
    this._lastYaw = yawRate; // used by the tyre-temperature model next step
    // fraction of the BASE lateral grip in use — feeds next step's circle
    this._latUse = latMax > 0 ? Math.abs(yawRate) * Math.max(0, this.speed) / latMax : 0;

    // aquaplaning: standing water at high speed → occasional twitch / grip loss
    // in a puddle the car floats a little toward the water's pull (the same
    // side for the same puddle, so it's learnable) and the water drags it back
    if (this.aquaplane > 0) {
      const side = Math.sin(this.lapDist * 0.0131 + t.length) >= 0 ? 1 : -1;
      this.vLatDrift += side * this.aquaplane * 2.2 * dt;
      this.speed -= this.speed * 0.12 * this.aquaplane * dt;
    }

    // --- integrate position ---
    const sx = Math.sin(this.heading), cz = Math.cos(this.heading);
    this.x += sx * this.speed * dt + Math.cos(this.heading) * this.vLatDrift * dt;
    this.z += cz * this.speed * dt - Math.sin(this.heading) * this.vLatDrift * dt;
    this.vLatDrift *= Math.max(0, 1 - 6*dt);

    // --- barrier clamp ---
    this.trackIdx = t.nearest(this.x, this.z, this.trackIdx, 8);
    const lat2 = t.lateral(this.x, this.z, this.trackIdx);
    // In the pit lane the car sits beyond the normal track barrier, so push the
    // clamp out to hold the lane (and don't let a street circuit's tight wall
    // shove the car back onto the track).
    const wall = this.inPit ? Math.max(t.wallOff || (hw + 8.2), hw + 13.6)   // working lane edge
                            : (t.wallOff || (hw + 8.2));
    // The pit wall is a real barrier. Along the walled stretch of the pit lane
    // a car that is NOT in the pits is held on the track side of it (it used
    // to be drawn only, so you could drive down the lane at full speed).
    // Only the entry and exit are open; crossing into the entry = boxing
    // (main.js commits the car to the stop).
    let limNeg = wall, limPos = wall;      // barrier distance on each side
    if (!this.inPit && typeof pitLaneGeom === 'function' && this.lapDist != null) {
      const g = pitLaneGeom(t), s = pitS(t, this.lapDist);
      if (s >= g.sEntryEnd - 6 && s <= g.sExitStart + 6) limNeg = Math.min(limNeg, g.wallOff - 0.45);
    }
    const lim = lat2 < 0 ? limNeg : limPos;
    this.wallHit = 0;
    if (Math.abs(lat2) <= lim) this._wallTouch = false;
    if (Math.abs(lat2) > lim) {
      const p = t.posAt(this.trackIdx, Math.sign(lat2) * (lim - 0.2));
      this.x = p.x; this.z = p.z;
      // align to wall and scrub speed based on impact angle (wall-ride)
      const ta = Math.atan2(t.tx[this.trackIdx], t.tz[this.trackIdx]);
      let dh = ta - this.heading;
      while (dh > Math.PI) dh -= 2*Math.PI;
      while (dh < -Math.PI) dh += 2*Math.PI;
      // Impact severity is the component of velocity going INTO the wall, in
      // m/s — a glancing scrape at 300 km/h is far less destructive than a
      // square hit at 150, and the old model couldn't tell them apart.
      const sev = Math.abs(Math.sin(dh));
      const normalSpeed = Math.abs(v) * sev;
      this.speed *= Math.max(0.15, 1 - sev * 0.30);
      this.heading += dh * 0.35;
      this.wallHit = sev;
      this.lastImpact = Math.max(this.lastImpact, normalSpeed);
      // Damage lands on the IMPACT, not every frame we remain against the
      // wall — otherwise a 120 Hz loop wrote off the car in a tenth of a
      // second. Sliding along the barrier still costs a slow scrape rate.
      const firstTouch = !this._wallTouch;
      this._wallTouch = true;
      if (firstTouch) {
        if (normalSpeed > 4)  this.dmgWing  = Math.min(1, this.dmgWing  + (normalSpeed - 4) * 0.055);
        // floor only takes damage from a real impact, not a light brush
        if (normalSpeed > 18) this.dmgFloor = Math.min(1, this.dmgFloor + (normalSpeed - 18) * 0.045);
        if (normalSpeed > 17 && Math.random() < (normalSpeed - 17) * 0.09) this.puncture = 1;
        if (normalSpeed > 26) this.dead = true;
      } else {
        // grinding along the barrier: slow, cumulative, survivable
        this.dmgWing = Math.min(1, this.dmgWing + Math.abs(v) * 0.00025);
      }
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
    // A backward crossing (reversing over the line, or a one-frame jitter at pit
    // exit / in a shove) no longer decrements the lap — it's remembered as
    // pending, and the forward re-cross simply cancels it. The old
    // decrement-then-guard dropped a lap outright: +1, -1, then the re-cross was
    // rejected as a "double count", leaving a car a lap short of the distance it
    // had driven (the "+0.000 (2 Laps)" results bug).
    if (delta < -t.length * 0.5) {
      delta += t.length;
      if (this._backPending > 0) { this._backPending--; this.crossedLine = false; }
      else if (this.totalDist - this._lastCrossDist > t.length * 0.5) {
        this.lap++; this.crossedLine = true;
        this._lastCrossDist = this.totalDist;
      } else this.crossedLine = false;
    }
    else if (delta > t.length * 0.5) {
      delta -= t.length;
      this._backPending = (this._backPending || 0) + 1;
      this.crossedLine = false;
    }
    else this.crossedLine = false;
    if (Math.abs(delta) < t.length * 0.5) this.totalDist += delta;
    this.lapDist = newDist;
    this._drivetrain();
  }

  // 8-speed seamless box with F1-like ratios: the engine lives between
  // ~10,500 and 12,400 rpm at racing speed (each upshift drops only
  // ~1,200-1,800 rpm), and it downshifts early under braking so the revs stay
  // high — which is also how the 2026 cars harvest energy in the braking zones.
  // Used by the HUD (gear, rev bar) and the engine sound.
  _drivetrain() {
    const v = Math.abs(this.speed) * 3.6, T = GEAR_TOP_KMH;
    let g = this.gearN || 1;
    this.shiftUp = 0; this.shiftDown = 0;
    if (g < 8 && v > T[g] * 0.985 && this.throttle > 0.05) { g++; this.shiftUp = 1; }
    while (g < 8 && v > T[g]) { g++; this.shiftUp = 1; }
    const keep = this.throttle > 0.5 ? 0.80 : 0.92;
    while (g > 1 && v < T[g - 1] * keep) { g--; this.shiftDown = 1; }
    this.gearN = g;
    let rpm = RPM_MAX * v / T[g];
    if (g === 1) rpm = Math.max(rpm, RPM_IDLE + this.throttle * 4200 * Math.max(0, 1 - v / 60));
    // (no rpm flare from cornering squeal: through a flat-out corner the note
    // holds steady, like the real car)
    this.rpm = Math.max(RPM_IDLE, Math.min(RPM_MAX + 60, rpm));
  }

  get progress() { // total race progress for ordering
    return this.totalDist;
  }

  get kmh() { return Math.round(Math.abs(this.speed) * 3.6); }

  get gear() {
    if (this.speed < -0.5) return 'R';
    if (this.kmh < 3 && this.throttle < 0.05) return 'N';
    return this.gearN || 1;
  }

  // rev bar: the useful band, 6,000 rpm → limiter
  get rpmFrac() {
    return Math.max(0, Math.min(1, ((this.rpm || RPM_IDLE) - 6000) / (RPM_MAX - 6000)));
  }
}
