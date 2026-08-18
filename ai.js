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
    this.launchT = 0; // >0 = launching off the grid, ignore the follow limiter
    // Off the line every car would otherwise snap straight onto the single
    // racing line, which bunches 22 cars into one lane and makes them all lift.
    // Hold the grid lane at first and blend onto the line over the opening
    // stretch, the way a real field fans out.
    this.gridLane = null;
    this.laneBlend = 1;
    this.laneOffset = (Math.random()*2-1) * 1.2;
    this.targetLane = this.laneOffset;
    this.avoidTimer = 0;
    this.noise = Math.random()*1000;
    this.buildCornerSpeeds();
  }

  // ---- racing line + corner speeds -------------------------------------
  // Both are properties of the LINE, not the centreline. The old version
  // smoothed the line so hard that its amplitude collapsed (mean lateral
  // position 0.9 m on a 5.5 m half-width road) and then took corner speeds
  // from centreline curvature — so the AI drove down the middle at the
  // middle's radius, and lapped ~7 s off the car's actual capability.
  buildCornerSpeeds() {
    const track = this.track;
    if (track._cornerSpeed && track._csKey === 'line') return;
    const N = track.n, hw = track.width / 2;
    // How close to the white line the racing line runs. With realistic high
    // downforce, a TIGHTER line (further from the edges) is faster than the
    // textbook wide line: the shorter path beats the wider radius, because the
    // car has the grip to take the tighter corner. Measured across COTA,
    // Barcelona, Monaco and Monza, hw-2.7 is worth ~2-3s a lap over the old
    // hw-1.6. Tight corners still push to the edge via the relaxation below;
    // this mainly straightens the medium and fast corners.
    const EDGE = Math.max(1.2, hw - 2.7);

    // Minimum-curvature relaxation. Repeatedly pull every point toward the
    // midpoint of its neighbours (which is what straightens a curve) while
    // clamping it inside the track edges. This is what actually turns a
    // corner into a wide-entry / apex / wide-exit line — the previous
    // "hug the inside then blur it" approach produced a wavy path that was
    // SLOWER than the centreline over 20% of the lap.
    const rl = new Float32Array(N);
    const K = 3;                       // neighbour span used for straightening
    for (let pass = 0; pass < 400; pass++) {
      for (let i = 0; i < N; i++) {
        const a = (i-K+N)%N, b = (i+K)%N;
        const ax = track.px[a] + track.nx[a]*rl[a], az = track.pz[a] + track.nz[a]*rl[a];
        const bx = track.px[b] + track.nx[b]*rl[b], bz = track.pz[b] + track.nz[b]*rl[b];
        // where the straight line between the neighbours crosses this normal
        const mx = (ax+bx)/2, mz = (az+bz)/2;
        const target = (mx - track.px[i])*track.nx[i] + (mz - track.pz[i])*track.nz[i];
        const clamped = Math.max(-EDGE, Math.min(EDGE, target));
        rl[i] += (clamped - rl[i]) * 0.35;
      }
    }
    track._raceLine = rl;

    // 4. Corner speeds from the curvature of THAT path. Taking a corner wide
    //    -> apex -> wide straightens it, so the usable radius is larger and
    //    the limit speed genuinely higher.
    const px = new Float64Array(N), pz = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      px[i] = track.px[i] + track.nx[i]*rl[i];
      pz[i] = track.pz[i] + track.nz[i]*rl[i];
    }
    const curv = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i-3+N)%N, b = (i+3)%N;
      const x1 = px[a], z1 = pz[a], x2 = px[i], z2 = pz[i], x3 = px[b], z3 = pz[b];
      // curvature through three points = 4*area / (product of side lengths)
      const area2 = (x2-x1)*(z3-z1) - (z2-z1)*(x3-x1);
      const d1 = Math.hypot(x2-x1, z2-z1), d2 = Math.hypot(x3-x2, z3-z2), d3 = Math.hypot(x3-x1, z3-z1);
      curv[i] = (d1*d2*d3 > 1e-6) ? Math.abs(2*area2 / (d1*d2*d3)) : 0;
    }
    // light smoothing so a noisy sample can't spike the plan
    const cSm = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let o = -4; o <= 4; o++) sum += curv[(i+o+N)%N];
      cSm[i] = sum / 9;
    }
    // Must mirror physics.js exactly: latMax = min(53, 17.6 + 0.0104 v²).
    // Solve v² · c = latMax(v) for v — the speed where the corner demands
    // precisely the grip available. Done by bisection because latMax itself
    // depends on v. If these constants drift from the physics the AI plans
    // corner speeds the car cannot actually hold, and scrubs all the way round.
    const LAT_CAP = 53, LAT_MECH = 17.6, LAT_AERO = 0.0104;
    const cs = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const c = cSm[i];
      if (c < 1e-4) { cs[i] = 999; continue; }
      let lo = 3, hi = 100;
      for (let k = 0; k < 26; k++) {
        const m = (lo + hi) / 2;
        const avail = Math.min(LAT_CAP, LAT_MECH + LAT_AERO * m * m);
        if (m * m * c <= avail) lo = m; else hi = m;
      }
      cs[i] = lo;
    }
    track._cornerSpeed = cs;
    track._csKey = 'line';
  }

  compute(dt, allCars) {
    const car = this.car, t = this.track;
    // stuck recovery
    this.stuck = (car.speed < 2.5) ? (this.stuck||0) + dt : 0;
    if (this.stuck > 2.5) { car.resetToTrack(); this.stuck = 0; }
    if (this.launchT > 0) this.launchT -= dt;
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
    // Braking is downforce-limited now, so the planner has to use the speed it
    // is actually travelling at rather than one flat figure. Skill and
    // difficulty decide how close to that limit a driver dares to run.
    const brakeCap = Math.min(58, 18 + 0.0105 * v * v);
    const decel = brakeCap * (0.62 + this.driver.skill * 0.20) *
                  Math.min(1.12, Math.pow(this.diff, 2)) * (0.42 + 0.58 * gripFac);
    let vAllow = 999;
    // Look ahead far enough to see a corner that keeps tightening. The old
    // window was braking distance + 30 m — about 1.2 s at racing speed — so at
    // China the AI arrived at a decreasing-radius spiral still doing 236 km/h,
    // ran wide, and then could not get back because grass grip is 0.45.
    const scanM = Math.max(60, v*v/(2*decel) + 30 + v*1.6);
    let d = 0, k = idx;
    const stepM = 5;
    while (d < scanM) {
      const k2 = (k + Math.ceil(stepM / (t.length/N))) % N;
      d += stepM;
      k = k2;
      const limit = Math.sqrt(cs[k]*cs[k]*pace*pace + 2*decel*d);
      if (limit < vAllow) vAllow = limit;
    }
    // Corner-exit release. This clamp stops the car exceeding the lateral
    // limit at its current radius — but read only at the CURRENT sample it
    // also pinned the car to the apex speed all the way out of the corner,
    // long after the road had opened up. Taking the better of here and where
    // the car will be in 0.2 s lets it get on the power at the exit while
    // still tightening on entry, where the sample ahead is slower.
    // Measured: COTA -1.2s, Barcelona -1.3s, Monaco -0.6s.
    const kSoon = (idx + Math.ceil(Math.max(2, v * 0.20) / (t.length/N))) % N;
    const hereLimit = Math.max(cs[idx], cs[kSoon]) * pace * 0.97;
    vAllow = Math.min(vAllow, hereLimit * 1.06);
    // AI top speed sits just below the player's (~308-312 vs 315 km/h). Wet
    // barely dents top speed (drag-limited); the corner-pace drop handles the rest.
    // DRS open raises the cap so the tow actually completes overtakes.
    // Top speed. DRS and the tow both raise the ceiling, otherwise the AI
    // would sit in another car's wake at its own still-air top speed and
    // never complete a pass the physics is already handing it.
    vAllow = Math.min(vAllow, (80 + this.driver.skill * 8 + (this.diff - 1) * 30)
      * (0.88 + 0.12 * gripFac) + (car.drsOpen ? 8 : 0) + (car.tow || 0) * 6);

    // ---- base lane = racing line (clean air) ----
    const lookM = Math.min(50, Math.max(9, v * 0.5));
    const kAhead = (idx + Math.ceil(lookM / (t.length/N))) % N;
    const edge = t.width/2 - 1.6;
    const rl = t._raceLine;
    let baseLane = rl ? rl[kAhead] : this.laneOffset;
    if (this.laneBlend < 1) {
      // 12 s to come fully onto the racing line
      this.laneBlend = Math.min(1, this.laneBlend + dt / 12);
      if (this.gridLane == null) this.gridLane = t.lateral(car.x, car.z, car.trackIdx);
      const b = this.laneBlend * this.laneBlend * (3 - 2*this.laneBlend); // smoothstep
      baseLane = this.gridLane * (1 - b) + baseLane * b;
    }

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
      // Hold station to avoid ramming. The old test fired whenever a car was
      // within 18 m and merely a touch slower, which on the run to turn 1 —
      // where the whole field is nose-to-tail by definition — made all 21 AI
      // cars lift at once and handed the player the lead. Now it only reacts
      // when we are actually closing, in the same lane, and close enough that
      // it matters.
      const closing = v - ahead.speed;
      const sameLane = Math.abs(otherLat - myLat) < 2.2;
      const range = this.launchT > 0 ? 8 : 13;
      if (sameLane && closing > 0.5 && aheadGap < range) {
        // match their speed by the time we're 5 m back, no earlier
        const follow = ahead.speed + Math.max(0, aheadGap - 5) * 2.6;
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

    // Running-wide guard. Higher difficulties plan closer to the limit, so any
    // pursuit error costs more road — which is why Elite was ending up SLOWER
    // than Pro at Monza and China: it ran wide, and an excursion costs far more
    // than the extra corner speed earns. Bleed speed as the car approaches the
    // white line so it self-corrects before it runs out of track.
    {
      const latNow = Math.abs(t.lateral(car.x, car.z, car.trackIdx));
      const warn = t.width/2 - 1.2;
      if (latNow > warn) {
        const over = Math.min(1, (latNow - warn) / 1.6);
        vAllow = Math.min(vAllow, Math.max(14, v * (1 - 0.30 * over)));
      }
    }

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

    // Off-track recovery. Previously this just eased the throttle, so a car
    // that ran wide kept travelling at speed across the grass — at China that
    // was 185 m of a single excursion and three track-limit strikes a lap.
    // Now it lifts properly and brakes in proportion to how far out it is,
    // which lets the steering pull it back onto the road.
    if (car.offTrack) {
      throttle = Math.min(throttle, 0.25);
      const myLatNow = t.lateral(car.x, car.z, car.trackIdx);
      const over = Math.abs(myLatNow) - t.width/2;
      if (over > 0.6 && v > 20) brake = Math.max(brake, Math.min(0.85, over * 0.22));
    }

    return { throttle, brake, steer };
  }
}
