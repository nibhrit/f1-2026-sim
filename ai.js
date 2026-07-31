// ============================================================
// AI driver controller — pure-pursuit steering + curvature-
// based speed planning, simple overtaking offsets.
// ============================================================

class AIDriver {
  constructor(car, track, driver) {
    this.car = car;
    this.track = track;
    this.driver = driver;
    // pace: skill 0.85→0.99 maps to ~96%→98.5% of the car's physical limit,
    // (× G.difficulty in main.js). Still leaves a clean, precise player room to win.
    // fraction of the car's true limit this driver runs at, before difficulty.
    // Base leaves headroom so difficulty ×0.94..×1.06 spans ~87%..~98.5%.
    this.paceMul = 0.80 + driver.skill * 0.13;
    this.diff = 1; // difficulty multiplier (main.js sets it from G.difficulty)
    this.laneOffset = (Math.random()*2-1) * 1.2;
    this.targetLane = this.laneOffset;
    this.avoidTimer = 0;
    this.noise = Math.random()*1000;
    this.buildCornerSpeeds();
  }

  // Corner-speed plan = the car's TRUE physical limit (player physics uses
  // min(55, 28 + 0.0068 v²)). paceMul is then the single dial that decides how
  // close to that limit each driver runs — so difficulty never overdrives.
  buildCornerSpeeds() {
    const track = this.track;
    if (track._cornerSpeed && track._csKey === 'limit') return;
    const gAero = 55, gMech = 28;
    const cs = new Float32Array(track.n);
    for (let i = 0; i < track.n; i++) {
      const c = Math.abs(track.curv[i]);
      if (c < 1e-4) { cs[i] = 999; continue; }
      const vCap = Math.sqrt(gAero / c);
      const vMech = c > 0.0075 ? Math.sqrt(gMech / (c - 0.0066)) : Infinity;
      cs[i] = Math.min(vCap, vMech);
    }
    track._cornerSpeed = cs;
    track._csKey = 'limit';
    // precompute the racing line (lateral offset per sample): hug the apex
    // (inside of the corner), ease back to centre on straights, then smooth so
    // turn-in/exit use the road width. Cached once per track.
    if (!track._raceLine) {
      const N = track.n, hw = track.width/2;
      const rl = new Float32Array(N);
      for (let i=0;i<N;i++) {
        const c = track.curv[i];
        const mag = Math.min(1, Math.abs(c) / 0.018); // 0..1 corner sharpness
        // inside edge sign matches the kerb side (sign of curvature)
        rl[i] = Math.sign(c) * mag * (hw - 2.4) * 0.72;
      }
      // heavy wrap-around smoothing spreads the apex into wide entry/exit
      for (let pass=0; pass<70; pass++) {
        const tmp = new Float32Array(N);
        for (let i=0;i<N;i++)
          tmp[i] = (rl[(i-2+N)%N] + rl[(i-1+N)%N] + rl[i]*2 + rl[(i+1)%N] + rl[(i+2)%N]) / 6;
        rl.set(tmp);
      }
      track._raceLine = rl;
    }
  }

  compute(dt, allCars) {
    const car = this.car, t = this.track;
    // stuck recovery
    this.stuck = (car.speed < 2.5) ? (this.stuck||0) + dt : 0;
    if (this.stuck > 2.5) { car.resetToTrack(); this.stuck = 0; }
    const cs = t._cornerSpeed;
    const N = t.n;
    const idx = car.trackIdx;
    const v = car.speed;

    // wet weather: everyone plans slower & brakes earlier. Scale planned pace by
    // sqrt(grip) so corner speeds drop with the available grip. Dry+slick → 1.
    const wetness = (typeof TRACK_WETNESS !== 'undefined') ? TRACK_WETNESS : 0;
    const gripFac = (typeof wetGrip === 'function') ? wetGrip(car.compound, wetness) : 1;
    // plan with the grip that's actually available: wet AND tyre temperature
    // (latMax scales linearly, so corner speed scales with the square root)
    // wet also makes drivers tentative beyond the raw grip loss
    const caution = 1 - 0.11 * wetness;
    const pace = this.paceMul * caution * Math.sqrt(gripFac * (car.tempMul || 1) * (car.gripBonus || 1));

    // ---- speed planning: scan braking distance ahead ----
    // Braking is the AI's main pace limiter. The car can physically brake at
    // ~34 m/s²; low difficulty brakes early and safely, Elite brakes deep.
    // (diff³ spreads the presets: Rookie ~23, Casual ~26, Pro ~30, Elite ~33.)
    // braking is grip-limited too: in the wet they must brake much earlier
    const decel = (22 + this.driver.skill * 6) * Math.pow(this.diff, 3) * (0.42 + 0.58 * gripFac);
    let vAllow = 999;
    const scanM = Math.max(40, v*v/(2*decel) + 30);
    let d = 0, k = idx;
    const stepM = 5;
    while (d < scanM) {
      const k2 = (k + Math.ceil(stepM / (t.length/N))) % N;
      d += stepM;
      k = k2;
      const limit = Math.sqrt(cs[k]*cs[k]*pace*pace + 2*decel*d);
      if (limit < vAllow) vAllow = limit;
    }
    const hereLimit = cs[idx] * pace;
    vAllow = Math.min(vAllow, hereLimit * 1.06);
    // AI top speed sits just below the player's (~308-312 vs 315 km/h). Wet
    // barely dents top speed (drag-limited); the corner-pace drop handles the rest.
    // DRS open raises the cap so the tow actually completes overtakes.
    vAllow = Math.min(vAllow, (80 + this.driver.skill * 8 + (this.diff - 1) * 30)
      * (0.88 + 0.12 * gripFac) + (car.drsOpen ? 7 : 0));

    // ---- base lane = racing line (clean air) ----
    const lookM = Math.min(50, Math.max(9, v * 0.5));
    const kAhead = (idx + Math.ceil(lookM / (t.length/N))) % N;
    const edge = t.width/2 - 1.6;
    const rl = t._raceLine;
    const baseLane = rl ? rl[kAhead] : this.laneOffset;

    // ---- wheel-to-wheel combat ----
    this.avoidTimer -= dt;
    const carLen = 5;
    let combatLane = null;
    // inside of the corner coming up (for dives / defensive cover)
    const kCorner = (idx + Math.ceil(35 / (t.length/N))) % N;
    const insideSign = Math.sign(t.curv[kCorner]) || (baseLane >= 0 ? 1 : -1);

    // nearest car ahead (progress-wise, <30m) and behind (<15m)
    let ahead=null, aheadGap=1e9, behind=null, behindGap=1e9;
    for (const other of allCars) {
      if (other === car) continue;
      const gap = other.totalDist - car.totalDist;
      const dd = Math.hypot(other.x-car.x, other.z-car.z);
      if (gap > 0 && gap < 30 && dd < 34 && gap < aheadGap) { aheadGap = gap; ahead = other; }
      if (gap < 0 && gap > -15 && dd < 22 && -gap < behindGap) { behindGap = -gap; behind = other; }
    }

    if (ahead) {
      const otherLat = t.lateral(ahead.x, ahead.z, ahead.trackIdx);
      const myLat = t.lateral(car.x, car.z, car.trackIdx);
      // hold station to avoid ramming when directly behind
      if (aheadGap < 18 && ahead.speed < v + 6 && Math.abs(otherLat - myLat) < 2.6) {
        const follow = Math.max(0, ahead.speed + (aheadGap - 4.5) * 2.2);
        vAllow = Math.min(vAllow, follow);
      }
      // attacker: faster and close → make a move
      if (v > ahead.speed - 3 && aheadGap < 24) {
        const insideLat = insideSign * edge;
        const defenderCoversInside = Math.abs(otherLat - insideLat) < 2.6;
        if (defenderCoversInside) combatLane = -insideSign * edge * 0.85; // switchback for the exit
        else combatLane = insideLat; // dive down the inside
      }
    }

    if (behind) {
      const attLat = t.lateral(behind.x, behind.z, behind.trackIdx);
      const overlap = 1 - Math.min(1, behindGap / carLen); // 1 = fully alongside
      const attSide = Math.sign(attLat) || 1;
      if (overlap >= 0.5) {
        // FIA: a car >=50% alongside is entitled to room — do not squeeze it off
        if (combatLane == null) combatLane = baseLane;
        combatLane -= attSide * 0.7; // yield a little space on the attacker's side
      } else if (overlap > 0.2) {
        combatLane = insideSign * edge * 0.6; // one move: cover the inside
      }
    }

    let targetLane = combatLane != null ? combatLane : baseLane;
    targetLane = Math.max(-edge, Math.min(edge, targetLane));
    this.laneOffsetNow = this.laneOffsetNow == null ? targetLane : this.laneOffsetNow;
    this.laneOffsetNow += (targetLane - this.laneOffsetNow) * Math.min(1, 3*dt);

    // ---- steering: pure pursuit toward the chosen lane ----
    const lane = Math.max(-edge, Math.min(edge, this.laneOffsetNow));
    const target = t.posAt(kAhead, lane);
    const dx = target.x - car.x, dz = target.z - car.z;
    const targetAng = Math.atan2(dx, dz);
    let da = targetAng - car.heading;
    while (da > Math.PI) da -= 2*Math.PI;
    while (da < -Math.PI) da += 2*Math.PI;
    // steer maps to a FRACTION of available grip, so anything past ~0.91
    // makes the physics scrub speed. Cap below that: the AI now rides the
    // limit instead of constantly over-demanding it and bleeding speed.
    const STEER_CAP = 0.88;
    let steer = Math.max(-STEER_CAP, Math.min(STEER_CAP, da * 3.4));

    // small human wobble
    this.noise += dt;
    steer += Math.sin(this.noise*1.3) * 0.01 * (1-this.driver.skill);

    // ---- throttle/brake ----
    // crisp pedal work: hold full throttle right up to the limit, then brake
    // hard. (The old half-throttle band and soft braking cost several s/lap.)
    let throttle = 0, brake = 0;
    const margin = vAllow - v;
    if (margin > 0.6) throttle = 1;
    else if (margin > 0) throttle = 0.65;   // feathering at the limit
    else if (margin > -0.6) throttle = 0.2; // hold speed through the corner
    else brake = Math.min(1, -margin * 0.45);

    // off-track recovery
    if (car.offTrack) { throttle = Math.min(throttle, 0.5); }

    return { throttle, brake, steer };
  }
}
