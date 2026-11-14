// ============================================================
// AI driver controller — pure-pursuit steering + curvature-
// based speed planning, simple overtaking offsets.
// ============================================================

// Steering controller tunables (BUILD 107): curvature feed-forward from the
// racing line + pure-pursuit feedback at a short look-ahead.
let AI_CTRL = { look: 0.22, lookMin: 6, lookMax: 30, gain: 3.0, preview: 0.10, ffOff: 0, warn: 0.9, brakePreview: 0.25, traffic: 1, sep: 3.9, guardRate: 6 };
// The car's limit relative to the planner's model, per circuit (BUILD 107).
// skill = 1 drives exactly at these: the corner speed the tyres hold and the
// braking the car (with ABS, like yours) can deliver. The physics would let a
// car carry ~4-6% more into a corner by overdriving and letting the steering
// assist scrub the excess — the AI deliberately doesn't (in traffic it made
// cars slide into each other, and it isn't how a real driver takes a corner).
// Hairpin-heavy circuits leave less room (calibrated offline: lineopt/calib.sh).
const AI_LIMIT = { corner: 1.0, brake: 1.0,
  tracks: { monaco: { corner: 0.96 }, japan: { corner: 0.96 }, china: { corner: 0.98 }, usa: { corner: 0.98 } } };
function aiLimitFor(id) { const o = (AI_LIMIT.tracks[id] || {}); return { corner: o.corner || AI_LIMIT.corner, brake: o.brake || AI_LIMIT.brake }; }
// Difficulty -> driving skill (BUILD 107). s = 0 is a beginner, 1 the best
// driver the car allows. Everything is HOW the car is driven; nothing changes
// the car itself.
function aiSkillFromLevel(s) {
  s = Math.max(0, Math.min(1, s));
  return {
    corner: 0.90 + 0.10 * s,          // share of the corner limit carried
    brake: 0.84 + 0.16 * s,           // how deep into the braking zone
    exit: 0.90 + 0.10 * s,            // how early/hard back on the power
    line: 0.80 + 0.20 * s,            // how much of the road the line uses
    sigma: 0.002 + 0.010 * (1 - s),   // lap-to-lap inconsistency
    mistake: 0.03 * (1 - s) * (1 - s),// chance per braking zone of misjudging it
  };
}
// extra fraction of planned pace the AI gives up per unit of wetness
let AI_WET_CAUTION = 0.16;
// fraction of the pace optimism removed in slow corners (tuned by gauntlet)
let SLOW_CUT = 0.0;

function aiLineSpeeds(track, rl, grip) {
  const N = track.n; grip = grip || 1;
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
  const adf = track.aeroDf || 1;
  const LAT_CAP = 53 * adf, LAT_MECH = 17.6, LAT_AERO = 0.0104 * adf;
  const cs = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const c = cSm[i];
    if (c < 1e-4) { cs[i] = 999; continue; }
    let lo = 3, hi = 150;
    for (let k = 0; k < 26; k++) {
      const m = (lo + hi) / 2;
      const avail = Math.min(LAT_CAP, LAT_MECH + LAT_AERO * m * m) * grip;
      // and the steering lock: the line's radius must be one the car can turn
      const geomOK = typeof steerLockAt !== 'function' || (1 / c) >= 3.2 / Math.tan(steerLockAt(m));
      if (m * m * c <= avail && geomOK) lo = m; else hi = m;
    }
    cs[i] = lo;
  }

  // signed curvature in HEADING terms (d heading / d distance along the line):
  // the steering feed-forward. + = heading increasing = steer +.
  const kap = new Float32Array(N);
  { const th = new Float64Array(N), sd = new Float64Array(N);
    for (let i = 0; i < N; i++) { const a = (i - 1 + N) % N, b = (i + 1) % N; th[i] = Math.atan2(px[b] - px[a], pz[b] - pz[a]); }
    for (let i = 0; i < N; i++) { const j = (i + 1) % N; sd[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i]); }
    for (let i = 0; i < N; i++) {
      let d = th[(i + 3) % N] - th[(i - 3 + N) % N]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      let len = 0; for (let o = -3; o < 3; o++) len += sd[(i + o + N) % N];
      kap[i] = len > 1e-3 ? d / len : 0;
    }
    const k2 = Float32Array.from(kap);
    for (let i = 0; i < N; i++) { let sum = 0; for (let o = -3; o <= 3; o++) sum += k2[(i + o + N) % N]; kap[i] = sum / 7; }
  }
  return { rl, cs, kap };
}
// Line variants by driving quality q (BUILD 107): 1 = the optimal line, lower =
// a narrower line that doesn't use all the road (early, tighter apexes — the
// way a less confident driver goes round). Corner speeds are planned for the
// line actually driven. Cached per track.
function aiLineData(track, q, grip) {
  q = Math.max(0.5, Math.min(1, Math.round((q || 1) * 20) / 20));
  // grip in 0.5% steps (BUILD 107): the corner speed is SOLVED for the car's
  // actual grip — a sqrt() scaling of a full-grip plan overstated what a
  // lower-grip car can carry through fast, downforce-heavy corners, and the
  // slower teams ran wide at Pouhon every lap
  const g = Math.max(0.6, Math.min(1.6, Math.round((grip || 1) * 200) / 200));
  const key = q + '|' + g;
  const V = track._lineVariants || (track._lineVariants = {});
  if (V[key]) return V[key];
  const base = track._raceLine, N = track.n, rl = new Float32Array(N);
  for (let i = 0; i < N; i++) rl[i] = base[i] * q;
  return (V[key] = aiLineSpeeds(track, rl, g));
}

class AIDriver {
  constructor(car, track, driver) {
    this.car = car;
    this.track = track;
    this.driver = driver;
    // pace: skill 0.85→0.99 maps to ~96%→98.5% of the car's physical limit,
    // (× G.difficulty in main.js). Still leaves a clean, precise player room to win.
    // fraction of the car's true limit this driver runs at, before difficulty.
    // Base leaves headroom so difficulty ×0.94..×1.06 spans ~87%..~98.5%.
    this.paceMul = 0.80 + driver.skill * 0.13;   // legacy (pre-BUILD 107); unused by compute()
    this.diff = 1; // difficulty multiplier (main.js sets it from G.difficulty)
    // BUILD 107: the AI runs the SAME car as you. How fast it goes is purely
    // how well it drives — these are the skills difficulty turns up or down:
    //  corner  fraction of the car's corner-speed limit it dares to carry
    //  brake   fraction of the car's braking capability it plans with (how late)
    //  exit    how early/hard it gets on the power out of a corner (traction use)
    //  line    1 = the full optimal line; lower = narrower, earlier apexes
    //  sigma   lap-to-lap inconsistency (sd of the corner fraction)
    //  mistake chance per braking zone of getting it wrong (too late / too early)
    this.skill = { corner: 0.96, brake: 0.92, exit: 1, line: 1, sigma: 0, mistake: 0 };
    this._lapVar = 1;
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

  setSkill(o) { Object.assign(this.skill, o || {}); this._prof = null; }

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
    // Barcelona, Monaco and Monza, hw-2.0 is worth ~1.5s a lap over the old
    // hw-1.6. Tight corners still push to the edge via the relaxation below;
    // this mainly straightens the medium and fast corners.
    const EDGE = Math.max(1.2, hw - 2.0);

    // Minimum-curvature relaxation. Repeatedly pull every point toward the
    // midpoint of its neighbours (which is what straightens a curve) while
    // clamping it inside the track edges. This is what actually turns a
    // corner into a wide-entry / apex / wide-exit line — the previous
    // "hug the inside then blur it" approach produced a wavy path that was
    // SLOWER than the centreline over 20% of the lap.
    // BUILD 107: the pre-computed global line (racelines.js) when there is one;
    // the old local relaxation below only as a fallback for unknown geometry
    const pre = (typeof racelineFor === 'function') ? racelineFor(track) : null;
    const rl = pre || new Float32Array(N);
    const K = 3;                       // neighbour span used for straightening
    if (!pre) for (let pass = 0; pass < 400; pass++) {
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
    const LS = aiLineSpeeds(track, rl);
    const cs = LS.cs;
    track._lineKappa = LS.kap;
    track._lineVariants = { '1|1': LS };
    track._cornerSpeed = cs;
    track._csKey = 'line';
  }

  // ---- velocity profile (forward-backward pass) ------------------------
  // The established racing-AI approach: precompute the target speed at every
  // point of the lap in one shot, respecting the corner limit, then braking
  // (backward), then acceleration (forward). Replaces the old per-frame
  // braking scan — cleaner, and the base the friction-circle step builds on.
  // Cached per (pace, decel, traction); recomputed only when grip shifts.
  speedProfile(pace, brakeFac, tractionMul) {
    const t = this.track, N = t.n, seg = t.length / N;
    const cs = this._cs || t._cornerSpeed;
    // Quantise the inputs into coarse buckets so the O(N) rebuild fires only
    // when grip really shifts (a few times a lap at most), not every frame.
    // brakeFac / tractionMul / pace all move slowly (grip, tyre temp, wetness);
    // the profile itself is a global plan, so nothing here may depend on the
    // car's instantaneous speed or the key would churn every frame.
    const key = (Math.round(pace * 400) * 1e7) + (Math.round(brakeFac * 200) * 1e4) + Math.round(tractionMul * 40) * 10 + (this._csQ || 0) * 1e-6;
    if (this._prof && this._profKey === key) return this._prof;
    this._profKey = key;
    const v = this._prof && this._prof.length === N ? this._prof : new Float64Array(N);
    // corner cap (grip-scaled via pace), clamped to a sane top end
    // Slow-corner realism: the pace factor carries some optimism (the 1.05
    // late-braking lift) and the AI's steering only ever asks for 88% of grip.
    // Fast corners absorb that; a 6m-radius hairpin doesn't — the car needed
    // ~60% more grip than it had and slid across to the outside wall (China
    // T14, Monaco). Below ~40 m/s the optimism is taken back out, fully by 20.
    for (let i = 0; i < N; i++) {
      const slow = Math.max(0, Math.min(1, (40 - cs[i]) / 20));
      v[i] = Math.min(115, cs[i] * pace * (1 - SLOW_CUT * slow));
    }
    // backward pass: never carry more speed than we can brake off for what's
    // ahead. Braking capability is downforce-limited, so it rises with speed at
    // each point (18 m/s^2 low, up to 58 flat out) — computed per segment from
    // the profile's own speed, then scaled by the slow grip/skill/diff factor.
    const bDf = 0.005 * (t.aeroDf || 1), cDrag = 0.0006 * (t.aeroDrag || 1);
    for (let s = 0; s < 2; s++)
      for (let i = N - 1; i >= 0; i--) {
        const j = (i + 1) % N;
        // + aero drag and rolling resistance, which slow the car on top of the
        // brakes (BUILD 107: the plan used to ignore them — ~5 m/s^2 at 300 km/h)
        // evaluated at the speed the car would actually have here (from the
        // point ahead) — not at v[i], which before this pass is still the raw
        // corner limit (on a straight: 150 m/s) and overstated both the
        // downforce braking and the drag (BUILD 107)
        // (inlined brakeGripAt + drag: this loop runs N×2 per re-plan)
        const vj = v[j], vj2 = vj * vj;
        const d0 = Math.min(58, 15 + bDf * vj2) * brakeFac + cDrag * vj2 + 0.4;
        const u2 = vj2 + 2 * d0 * seg;
        const dec = Math.min(58, 15 + bDf * u2) * brakeFac + cDrag * u2 + 0.4;
        const cap = Math.sqrt(vj2 + 2 * dec * seg);
        if (cap < v[i]) v[i] = cap;
      }
    // forward pass: never demand more speed than the engine can build from the
    // point behind (traction-limited low down, power-limited up top, minus drag).
    // Friction circle: while a tyre is spending grip on cornering it has less to
    // spare for driving forward, so tractive effort is scaled by how much
    // lateral grip is already in use ((u/cornerSpeed)^2 = fraction of the budget
    // spent turning). Near a corner's limit this cuts acceleration to ~0, which
    // stops the AI getting on the power mid-corner and washing wide on exit —
    // exactly what was pitching cars off at Austria's fast Turn 6/7.
    for (let s = 0; s < 2; s++)
      for (let i = 0; i < N; i++) {
        const j = (i - 1 + N) % N, u = v[j];
        // limit at this point is the grip-scaled corner speed (cs × pace), not
        // the raw one — in the wet pace drops, and comparing against raw cs
        // made the circle think the tyres had grip to spare on corner exit
        // (only ever tightens: in the dry pace sits above 1, and loosening the
        // circle there brought back the Austria exit run-wide BUILD 64 fixed)
        const lim = cs[j] * Math.min(1, pace);
        const latFrac = lim > 1 ? Math.min(1, (u / lim) * (u / lim)) : 0;
        // physically-correct circle: drive available falls as cornering grip is
        // spent, reaching ~0 at the limit. Kills the exit-understeer that pitched
        // cars off at Austria's fast corners, at every difficulty.
        const circle = Math.sqrt(Math.max(0, 1 - latFrac * latFrac));
        const tractive = Math.min((8.6 + 0.22 * Math.min(u, 25)) * tractionMul, 470 / Math.max(u, 10));
        const acc = tractive * circle - (cDrag * u * u + 0.4);
        const cap = Math.sqrt(Math.max(1, u * u + 2 * Math.max(0.3, acc) * seg));
        if (cap < v[i]) v[i] = cap;
      }
    this._prof = v; this._profPace = pace; this._profBrake = brakeFac; this._profTr = tractionMul;
    return v;
  }

  compute(dt, allCars) {
    const car = this.car, t = this.track;
    // stuck recovery — but never teleport onto another car. resetToTrack snaps
    // to the centreline at the current index; in a bunched pack that used to
    // drop several stuck cars onto the same point, spawning instant overlaps
    // that fed the collision/damage cascade. Only reset if the landing spot is
    // clear; otherwise wait it out (collision resolution will nudge us free).
    this.stuck = (car.speed < 2.5) ? (this.stuck||0) + dt : 0;
    if (this.stuck > 2.5) {
      const ti = car.trackIdx, rx = t.px[ti], rz = t.pz[ti];
      let clear = true;
      for (const o of allCars) {
        if (o === car) continue;
        if (Math.hypot(o.x - rx, o.z - rz) < 4.5) { clear = false; break; }
      }
      if (clear) { car.resetToTrack(); this.stuck = 0; }
      else this.stuck = 1.5; // re-check shortly rather than reset into traffic
    }
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
    const caution = 1 - AI_WET_CAUTION * wetness;
    // 1.05: the global velocity profile plans a hair more conservatively than
    // the old per-frame scan (it never carries speed it can't justify), so a
    // small corner-cap lift restores hotlap pace without any off-track cost.
    const sk = this.skill;
    // the line this driver drives (and corner speeds planned for it)
    const dmgMul = (1 - Math.min(0.55, (car.dmgWing || 0) * 0.30 + (car.dmgFloor || 0) * 0.28)) * (1 - (car.puncture || 0) * 0.45);
    const gripNow = dmgMul * gripFac * (car.tempMul || 1) * (car.tyreMul || 1) * (typeof effGripBonus === 'function' ? effGripBonus(car.gripBonus) : (car.gripBonus || 1));
    // plan for falling grip at once, rising grip only once it has really moved
    if (this._planGrip == null || gripNow < this._planGrip * 0.997 || gripNow > this._planGrip * 1.01) this._planGrip = gripNow;
    const LD = (typeof aiLineData === 'function' && t._raceLine) ? aiLineData(t, sk.line, this._planGrip) : null;
    if (LD) { this._cs = LD.cs; this._csQ = Math.round(sk.line * 20) * 1000 + Math.round(this._planGrip * 200); }
    // corner speed = the car's real limit (its actual grip right now: tyres,
    // temperature, wet) x how much of it this driver dares to use
    const LIM = this._lim || (this._lim = aiLimitFor(t.def && t.def.id));
    // (corner speeds above are already solved for the grip; pace is how much of
    // that the driver carries. Without a pre-built line, fall back to scaling.)
    const pace = sk.corner * LIM.corner * (AI_CTRL.limScale || 1) * (this._lapVar || 1) * caution * (LD ? 1 : Math.sqrt(gripNow));

    // ---- speed planning: scan braking distance ahead ----
    // Braking is the AI's main pace limiter. The car can physically brake at
    // ~34 m/s²; low difficulty brakes early and safely, Elite brakes deep.
    // (diff³ spreads the presets: Rookie ~23, Casual ~26, Pro ~30, Elite ~33.)
    // braking is grip-limited too: in the wet they must brake much earlier
    // Braking is downforce-limited now, so the planner has to use the speed it
    // is actually travelling at rather than one flat figure. Skill and
    // difficulty decide how close to that limit a driver dares to run.
    // How deep a driver dares to brake, as a fraction of the car's downforce-
    // limited capability. Skill and difficulty push it toward the limit; grip
    // (wet) pulls it back. Speed-independent so the profile cache stays stable —
    // the actual per-segment m/s^2 is derived inside speedProfile from downforce.
    // wet term matches physics' own longitudinal grip (0.35 + 0.65·wetGrip), and
    // in the wet the planner never assumes more than 95% of it — otherwise it
    // plans braking the car can't deliver and overshoots corners in the rain.
    const wetLong = 0.35 + 0.65 * gripFac;
    // braking: the car's real capability (ABS on, like yours) x how deep this
    // driver dares to brake
    const ABS_EFF = (car.assists && car.assists.absEff) || 0.94;
    let brakeFac = sk.brake * LIM.brake * (AI_CTRL.brakeLimScale || 1) * ABS_EFF * wetLong;
    if (wetness > 0.05) brakeFac = Math.min(brakeFac, wetLong * 0.95 * ABS_EFF);
    // Precomputed velocity profile: the target speed at every point of the lap,
    // solved once (corner cap -> braking -> acceleration) instead of scanned
    // every frame. tractionMul feeds the wet traction drop into the forward pass.
    const tractionMul = (0.55 + 0.45 * gripFac) * sk.exit;
    // Plan with a STEADY grip estimate. Tyre temperature moves all the time;
    // re-planning the whole lap at every flicker made the braking plan jump
    // mid-braking-zone (a corner suddenly 2% slower = brake NOW), asking for
    // more deceleration than the car has — the China T14 / Canada hairpin
    // overshoots. Re-plan only when the grip has really moved (>1.2%).
    // (asymmetric: grip falling — worn or cooling tyres — is planned for at
    // once; only rises wait for a real change. Planning on stale, higher grip
    // ran worn-tyre cars wide at Pouhon lap after lap.)
    if (this._planPace == null || pace < this._planPace * 0.996 || pace > this._planPace * 1.012) this._planPace = pace;
    if (this._planBrake == null || brakeFac < this._planBrake * 0.996 || brakeFac > this._planBrake * 1.012) this._planBrake = brakeFac;
    if (this._planTr == null || Math.abs(tractionMul - this._planTr) > 0.02 * this._planTr) this._planTr = tractionMul;
    // consistency: a new lap, a slightly different commitment (sigma)
    if (car.lap !== this._lvLap) {
      this._lvLap = car.lap;
      let g = 0; for (let q = 0; q < 6; q++) g += Math.random(); g = (g - 3) / 0.7071;   // ~N(0,1)
      // one-sided: an off lap is SLOWER than the driver's best, never beyond
      // the car's limit (a +1.5% lap at Pouhon put cars on the grass)
      this._lapVar = 1 - Math.min(2.5, Math.abs(g)) * (sk.sigma || 0);
    }
    // mistakes: arriving at a braking zone, a less skilled driver sometimes
    // gets it wrong — brakes too late (runs wide, locks up) or too early
    let pm = 1, bm = 1;
    if (this._mist && this._mist.t > 0) { this._mist.t -= dt; pm = this._mist.pm; bm = this._mist.bm; }
    else if (sk.mistake > 0 && !AI_CTRL.noMistake && this.laneBlend >= 1 && this._prof) {
      const ahead = this._prof[(idx + Math.ceil(Math.max(30, v * 1.2) / (t.length / N))) % N];
      const braking = ahead < v - 8;
      if (braking && !this._inBz) {
        this._inBz = true;
        // (BUILD 108: rarer for the best but never zero, twice as likely with a
        // car filling the mirrors; a late one now really goes PAST the limit —
        // it was relative to the driver's own margin, so a rookie's "mistake"
        // was a better corner than usual)
        if (Math.random() < (sk.mistake + 0.0003) * (this._pressured ? 2 : 1)) {
          this._mist = Math.random() < 0.6
            ? { t: 3.5, pm: 1.015 / (sk.corner || 1), bm: 1.06 / (sk.brake || 1), kind: 'late' }
            : { t: 3.0, pm: 0.96, bm: 0.85, kind: 'early' };
          pm = this._mist.pm; bm = this._mist.bm; this.mistakes = (this.mistakes || 0) + 1;
        }
      } else if (!braking) this._inBz = false;
    }
    const prof = this.speedProfile(this._planPace * pm, this._planBrake * bm, this._planTr);
    // aim a touch ahead so the car reacts to the corner it's arriving at, not
    // the one under its wheels — the equivalent of the old exit-release logic.
    // The backward pass already guarantees prof[idx] is a speed we can brake off
    // for every corner ahead, so we can target it directly. A tiny 1-sample peek
    // ahead only guards against discrete-step overshoot at the actual turn-in.
    const kSoon = (idx + 1) % N;
    let vAllow = Math.min(prof[idx], prof[kSoon] + 0.5);
    // Brake-onset lag: the pedal takes ~0.17s to reach full pressure, so a car
    // that starts braking exactly on the profile arrives ~15m late and, already
    // at the physical braking limit, never claws it back. Into a normal corner
    // that overshoot is absorbed; into a slow hairpin after a long straight it
    // meant arriving at twice the planned speed (China T14, Monaco). So
    // anticipate the ramp — but only when the corner ahead is genuinely slow,
    // keeping the late braking that makes the AI quick everywhere else.
    {
      const segM = t.length / N;
      const kLag = (idx + Math.ceil(v * 0.18 / segM)) % N;
      let minAhead = 1e9;
      const span = Math.ceil(Math.max(60, v * 2.2) / segM);
      for (let s = 0; s < span; s += 2) { const q = prof[(idx + s) % N]; if (q < minAhead) minAhead = q; }
      const wSlow = Math.max(0, Math.min(1, (24 - minAhead) / 8));    // hairpins only: 0 above ~86 km/h, 1 below ~58
      // ...and only for a HUGE stop (shedding 45+ m/s into it, like the end of
      // China's back straight) — ordinary slow corners keep the late braking
      const wBig = Math.max(0, Math.min(1, (v - minAhead - 45) / 15));
      const w = wSlow * wBig;
      if (w > 0 && prof[kLag] < vAllow) vAllow = vAllow + (prof[kLag] - vAllow) * w;
    }
    // AI top speed sits just below the player's (~308-312 vs 315 km/h). Wet
    // barely dents top speed (drag-limited); the corner-pace drop handles the rest.
    // DRS open raises the cap so the tow actually completes overtakes.
    // Top speed. DRS and the tow both raise the ceiling, otherwise the AI
    // would sit in another car's wake at its own still-air top speed and
    // never complete a pass the physics is already handing it.
    // (BUILD 107: no separate AI top-speed figure any more — the physics' power
    // and drag decide top speed for the AI exactly as for you)

    // ---- base lane = racing line (clean air) ----
    // Look-ahead distance for the pursuit target. A long peek made the car cut
    // corners and run wide through fast flowing sequences (Qatar, Suzuka),
    // tripping the running-wide speed-cut and bleeding ~10 s/lap there. A
    // shorter peek tracks the line tightly; going below ~0.4 gets twitchy in the
    // slow stuff (Monaco), so this is the sweet spot across the calendar.
    const lookM = Math.min(40, Math.max(9, v * 0.40));
    const kAhead = (idx + Math.ceil(lookM / (t.length/N))) % N;
    const edge = t.width/2 - 1.6;
    const lineEdge0 = t.width / 2 - 0.5;
    const rl = (LD && LD.rl) || t._raceLine;
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
    if (this.attackCool > 0) this.attackCool -= dt;
    const carLen = 5;
    let combatLane = null;
    // inside of the corner coming up (for dives / defensive cover)
    const kCorner = (idx + Math.ceil(35 / (t.length/N))) % N;
    const insideSign = Math.sign(t.curv[kCorner]) || (baseLane >= 0 ? 1 : -1);

    // nearest car ahead and behind. Ahead is scanned further now (a car at
    // 90 m/s needs ~35 m of buffer) so following can start easing early instead
    // of only waking up at 13 m and rear-ending the car in front.
    let ahead=null, aheadGap=1e9, behind=null, behindGap=1e9;
    // ...and, separately, the nearest car ahead IN OUR LANE. Following used to
    // key off the nearest car ahead by distance only — off the grid that is the
    // car in the other column, 6 m to the side, so nobody followed the car
    // actually in front of them and the whole field piled into turn 1 at full
    // speed while the front rows braked.
    let laneAhead=null, laneGap=1e9;
    const myLatF = t.lateral(car.x, car.z, car.trackIdx);
    // BUILD 103: gaps are measured along the ROAD (modulo a lap). They used
    // to be raw race distance, so a car that had just lapped us — physically
    // a few metres ahead, but a whole lap ahead in race distance — was
    // invisible: no following, no side guard. A lapped car that had just
    // moved over for blue flags would swing straight back onto the racing
    // line into it. aheadLaps / behindLaps record a lap difference.
    const L = t.length;
    const roadGap = o => { const raw = o.totalDist - car.totalDist; const g = ((raw % L) + L + L / 2) % L - L / 2; return g; };
    let aheadLaps = 0, behindLaps = 0;
    for (const other of allCars) {
      if (other === car || other.finished || other.dead) continue;  // finished/retired cars aren't racing
      const gap = roadGap(other);
      const dd = Math.hypot(other.x-car.x, other.z-car.z);
      if (gap > 0 && gap < 55 && dd < 58 && gap < aheadGap) { aheadGap = gap; ahead = other; aheadLaps = Math.round((other.totalDist - car.totalDist - gap) / L); }
      if (gap > 0 && gap < 70 && dd < 72 && gap < laneGap && !other.inPit
          && Math.abs(t.lateral(other.x, other.z, other.trackIdx) - myLatF) < 3.0) { laneGap = gap; laneAhead = other; }
      if (gap < 0 && gap > -15 && dd < 22 && -gap < behindGap) { behindGap = -gap; behind = other; behindLaps = Math.round((other.totalDist - car.totalDist - gap) / L); }
    }
    // car-following against the car in our lane (the obstacle we'd hit). The
    // second rule is for braking zones: the car ahead may be braking far harder
    // than 17 m/s^2 (5-6 g into turn 1), so plan to be able to stop in the room
    // it leaves — our stopping distance <= its stopping distance + the gap.
    // going round a slow car (BUILD 109): once our centre is a car's width to
    // its side we're past its bodywork — stop following it; while still moving
    // out, follow closer so the car keeps the rolling speed it needs to steer out
    const dodgeCar = this._dodge ? this._dodge.car : null;
    const dodgeClear = o => o === dodgeCar && Math.abs(t.lateral(o.x, o.z, o.trackIdx) - myLatF) > 2.7;
    if (laneAhead && !dodgeClear(laneAhead)) {
      const minGap = laneAhead === dodgeCar ? 5.8 : 7;
      const eff = Math.max(0, laneGap - minGap);
      vAllow = Math.min(vAllow, Math.sqrt(laneAhead.speed * laneAhead.speed + 2 * 17 * eff));
      const aL = laneAhead.decelNow || 0;
      if (aL > 8) {
        const aF = 0.8 * brakeGripAt(v, t.aeroDf);
        const room = laneAhead.speed * laneAhead.speed / (2 * aL) + eff;
        vAllow = Math.min(vAllow, Math.sqrt(2 * aF * room));
      }
    }

    // ---- a much slower car in our lane: go round it (BUILD 109) ----
    // Someone bogs down off the line, or a car is crawling (damage, a spin):
    // that's an obstacle, not a duel. A real driver jinks out from behind it
    // straight away — the attack logic below waits for a straight and a
    // braking zone (and is off for the grid fan-out), so the car directly
    // behind a bad starter used to sit there while the other column streamed by.
    // the lane with the most room round car `oc` (on side `side` if given):
    // a three-wide gap between the grid columns counts — that's where real
    // drivers go. null = no gap a car fits through.
    const dodgeLane = (oc, gapAhead, side) => {
      const oLat = t.lateral(oc.x, oc.z, oc.trackIdx);
      const nearLat = [oLat];
      for (const o of allCars) {
        if (o === car || o === oc || o.finished || o.dead || o.inPit) continue;
        const g = roadGap(o);
        if (g > -10 && g < gapAhead + 15) nearLat.push(t.lateral(o.x, o.z, o.trackIdx));
      }
      let best = null, bestScore = -1e9;
      for (let cand = -edge - 0.4; cand <= edge + 0.4; cand += 0.25) {
        if (side && Math.sign(cand - oLat) !== side) continue;
        let clear = 1e9;
        for (const l of nearLat) clear = Math.min(clear, Math.abs(l - cand));
        if (clear < 2.9) continue;
        const score = Math.min(clear, 5) - 0.35 * Math.abs(cand - myLatF);
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      return best;
    };
    if (this._dodge) {
      const d = this._dodge; d.t -= dt;
      const g = roadGap(d.car);
      // (held until we're past it — dropping it alongside swung the car back
      // onto its line and into the slow car)
      if ((d.t <= 0 && (g > 12 || g < -6)) || g < -6 || g > 70 || d.car.finished || d.car.dead) this._dodge = null;
      else {
        // keep to a gap that's really there as the cars around move: same
        // side, re-picked every frame; none left = tuck back in behind it
        const oL = t.lateral(d.car.x, d.car.z, d.car.trackIdx);
        const lane = dodgeLane(d.car, Math.max(0, g), Math.sign(d.lane - oL) || 1);
        if (lane != null) d.lane = lane;
        else if (g > 6) this._dodge = null;   // (alongside already: hold the lane we have)
      }
    }
    if (!AI_CTRL.noDodge && !this._dodge && laneAhead && this.laneOverride == null && laneGap < Math.max(30, v * 1.6)) {
      // "much slower" = well below the pace of the cars around it (off the
      // grid everyone is slow at first; a bad starter is slow RELATIVE to the
      // field), or, with nobody else near, well below what the road allows
      let sum = 0, n = 0;
      for (const o of allCars) {
        if (o === car || o === laneAhead || o.finished || o.dead || o.inPit) continue;
        const g = roadGap(o);
        if (g > -30 && g < 40) { sum += o.speed; n++; }
      }
      const ref = n >= 2 ? sum / n : prof[laneAhead.trackIdx];
      const vs = laneAhead.speed;
      // (off the grid — the fan-out — a car clearly down on the cars around
      // it is already one to go round: everyone else is accelerating)
      const launch = this.laneBlend < 1;
      // (and always well below what the road allows where IT is — a car
      // slowing for a hairpin in a lap-1 queue is racing, not an obstacle)
      const roadOK = vs < 0.7 * prof[laneAhead.trackIdx] - 1;
      if (roadOK && (vs < 0.7 * ref - 1 || (launch && vs < 0.8 * ref - 0.5 && v > vs - 1)) && (laneAhead.decelNow || 0) < 8) {
        const best = dodgeLane(laneAhead, laneGap, 0);
        if (best != null) this._dodge = { lane: best, car: laneAhead, t: 4 };
      }
    }
    if (this._dodge) combatLane = Math.max(-edge, Math.min(edge, this._dodge.lane));

    if (ahead) {
      const otherLat = t.lateral(ahead.x, ahead.z, ahead.trackIdx);
      const myLat = t.lateral(car.x, car.z, car.trackIdx);
      const latOff = Math.abs(otherLat - myLat);
      const closing = v - ahead.speed;
      // Adaptive car-following. Maintain a speed-scaled safe bubble behind the
      // car in front whenever we are still lined up behind it (not clearly
      // alongside/passing). Inside the bubble the target speed drops below the
      // car ahead, proportional to how far in we are, so we settle at the bubble
      // edge instead of closing to a hit. This is what stops the field
      // rear-ending itself into a damage cascade over a full race. The launch
      // phase uses a tighter bubble so the pack doesn't all lift at once on the
      // run to turn 1 (the old over-eager version handed the player the lead).
      // Treat the car ahead as a moving obstacle and cap our speed to what we
      // can physically brake down to ITS speed before we reach it — the same
      // backward-pass maths the velocity profile uses for corners. This makes a
      // rear-end impossible while we're lined up behind it, whatever it does
      // (brakes for a corner, is damaged and crawling, etc). It naturally eases
      // off early on a straight and only bites hard when we're genuinely closing
      // too fast. Using the 3-D distance (not just along-track progress) so it
      // holds through corners where the two differ.
      const blocked = latOff < (ahead === dodgeCar ? 2.7 : 3.0);
      if (blocked) {
        const minGap = ahead === dodgeCar ? 5.8 : 7;   // ~1.5 car lengths of buffer
        const eff = Math.max(0, aheadGap - minGap);
        const DEC = 17;                          // firm, comfortably achievable
        const maxApproach = Math.sqrt(ahead.speed * ahead.speed + 2 * DEC * eff);
        vAllow = Math.min(vAllow, maxApproach);

      }
      // ---- attacking: pick the moment, then commit or back out ----
      // BUILD 103. It used to dive for the inside whenever it was roughly as
      // fast and within 24 m — anywhere on the lap, every lap — and the dive
      // dropped the following brake (it was "not lined up" any more), so it
      // arrived at the turn-in point on top of the car ahead. Now:
      //  * never race a car that is LAPPING us (it was just let by on blue
      //    flags) — and a lapped car is only "attacked" to pass it cleanly
      //  * a move starts on a straight, needs real pace (closing, DRS or the
      //    tow), and only into a braking zone close enough to get there
      //  * if it isn't at least a third alongside by the time braking starts,
      //    it aborts, tucks back in and keeps the following brake
      const huntingRival = this.rivalTarget && ahead === this.rivalTarget;
      const lappingUs = aheadLaps > 0;
      const segM = t.length / N;
      // distance to the next braking zone (where the plan sheds 8+ m/s)
      let dBrake = 1e9;
      for (let q = 1; q * segM < 220; q += 2) { if (prof[(idx + q) % N] < v - 8) { dBrake = q * segM; break; } }
      const cornering = cs[idx] < 90 || (this._latDem || 0) > 10;
      const backmarker = aheadLaps < 0;                          // a car we're lapping
      const pace = backmarker || closing > 0.7 || car.drsOpen || (car.tow || 0) > 0.4 || (huntingRival && closing > 0.3);
      const overlapAhead = aheadGap < carLen * 0.67;            // our nose past its rear third
      if (lappingUs || this.laneBlend < 1) this.attack = null;
      else {
        const a = this.attack;
        if (a && a.target !== ahead) this.attack = null;
        if (!this.attack && !(this.attackCool > 0) && !cornering && pace && aheadGap < (huntingRival ? 30 : 22)) {
          if (backmarker || dBrake < 190 || aheadGap < 9) this.attack = { target: ahead, side: null, t: 0 };
        }
        if (this.attack) {
          const at = this.attack;
          at.t += dt;
          if (at.side == null) {
            // inside of the coming corner, unless the defender already covers
            // it — then the outside / switchback
            const insideLat = insideSign * edge;
            // a backmarker moves over for blue flags: go by on the other side
            if (backmarker) at.side = -(Math.sign(otherLat) || insideSign);
            else at.side = Math.abs(otherLat - insideLat) < 2.6 ? -insideSign : insideSign;
          }
          // abort: not alongside by the time braking starts, the move is over
          const late = !backmarker && dBrake < Math.max(18, v * 0.35) && !overlapAhead;
          if (late || at.t > (backmarker ? 20 : 8) || closing < -3) { this.attack = null; this.attackCool = backmarker ? 0.5 : 2.5; }
          else if (!((this._latDem || 0) > 10 && !overlapAhead)) combatLane = at.side * edge * (at.side === insideSign ? 1 : 0.85);
        }
      }
      // until we're properly alongside, keep the right to stop behind it:
      // the following brake applies even while offset for a move
      if (!blocked && !overlapAhead && !(backmarker && latOff > 3.6) && (dBrake < 60 || cornering) && !(this._dodge && this._dodge.car === ahead)) {
        const eff = Math.max(0, aheadGap - 4);
        vAllow = Math.min(vAllow, Math.sqrt(ahead.speed * ahead.speed + 2 * 15 * eff));
      }
    } else this.attack = null;

    // Title rival defending: watches the player in the mirrors from further
    // back and covers the inside before they're alongside (still one move,
    // and never squeezes a car that's already >=50% alongside — FIA rule below).
    if (this.rivalTarget && !behind) {
      const rg = car.totalDist - this.rivalTarget.totalDist;
      if (rg > 0 && rg < 30 && this.rivalTarget.speed > v - 1) combatLane = insideSign * edge * 0.6;
    }
    // never defend against a car that is lapping us — that's what blue
    // flags are for (and it has usually just been waved through)
    if (behind && behindLaps > 0) behind = null;
    this._pressured = !!(behind && behindGap < 15);
    if (behind) {
      const attLat = t.lateral(behind.x, behind.z, behind.trackIdx);
      const overlap = 1 - Math.min(1, behindGap / carLen); // 1 = fully alongside
      // (BUILD 108: his side of ME — was his side of the road, so with both
      // cars on the same half "leaving room" could steer into him)
      const attSide = Math.sign(attLat - myLatF) || 1;
      if (overlap >= 0.5) {
        // FIA: a car >=50% alongside is entitled to room — do not squeeze it off
        if (combatLane == null) combatLane = baseLane;
        combatLane -= attSide * 0.7; // yield a little space on the attacker's side
      } else if (!this._dodge && this.laneBlend >= 1 && overlap > (this.rivalTarget && behind === this.rivalTarget ? 0.05 : 0.2)) {
        combatLane = insideSign * edge * 0.6; // one move: cover the inside (earlier vs the rival)
      }
    }

    // Blue flags (set by main.js): a car is about to lap us. Stop fighting,
    // get off the racing line on the side away from it, and lift a little so
    // it's past within a few hundred metres.
    if (this.blueFor) {
      const lp = this.blueFor;
      const myLat = t.lateral(car.x, car.z, car.trackIdx);
      const hisLat = t.lateral(lp.x, lp.z, lp.trackIdx);
      const lineHere = rl ? rl[kAhead] : 0;
      // give it the racing line: move to the side of the road away from the line
      // (or away from the lapping car if it has already picked a side)
      const away = Math.abs(hisLat - myLat) > 1.2 ? Math.sign(myLat - hisLat) : -(Math.sign(lineHere) || 1);
      combatLane = away * edge * 0.85;
      const gapB = Math.hypot(lp.x - car.x, lp.z - car.z);
      if (gapB < 45) vAllow *= 0.92;          // lift and let it by
      this.blueSide = away; this.blueBy = lp; this.blueHold = 3;
    } else if (this.blueHold > 0 && this.blueBy) {
      // just been lapped: stay on our side until the lapping car is clear
      // ahead (2+ car lengths), THEN rejoin the line — no swinging back
      // across its rear wheels
      const g = roadGap(this.blueBy);
      if (g > 0 && g < 12) { combatLane = this.blueSide * edge * 0.75; vAllow = Math.min(vAllow, Math.max(10, this.blueBy.speed - 0.5)); }
      else if (g >= 12 || g < -20) this.blueHold -= dt;
      if (g >= 12) this.blueHold = Math.min(this.blueHold, 0.6);
      if (this.blueHold <= 0) this.blueBy = null;
    }
    let targetLane = combatLane != null ? combatLane : baseLane;
    this._dbgCombat = combatLane;
    // pit approach (set by main.js): hold the pit-lane side of the track
    if (this.laneOverride != null) targetLane = this.laneOverride;
    targetLane = Math.max(-edge, Math.min(edge, targetLane));
    // Don't cut back across the nose of a much slower car ahead (BUILD 109): a
    // car beside a bad starter's lane, heading back to its line, swung right
    // into it. Stay on our side of it until we're past.
    if (this.laneOverride == null && !AI_CTRL.noCutBack) {
      for (const o of allCars) {
        if (o === car || o.finished || o.dead || o.inPit) continue;
        const g = roadGap(o);
        if (g <= 4 || g > 40) continue;
        if (!((this.laneBlend < 1 && o.speed < v - 3) || o.speed < 0.7 * prof[o.trackIdx] - 1)) continue;
        const oLat = t.lateral(o.x, o.z, o.trackIdx), dMe = myLatF - oLat;
        if (Math.abs(dMe) < 2.0) continue;          // behind it: following / going round handle that
        if (Math.abs(targetLane - oLat) < 2.9 || Math.sign(targetLane - oLat) !== Math.sign(dMe))
          targetLane = Math.max(-edge - 0.4, Math.min(edge + 0.4, oLat + Math.sign(dMe) * 2.9));
      }
    }
    // Side guard. Whatever line it wants (racing line, a dive, the fan-out off
    // the grid), a car must not move across into one that is alongside it —
    // that is how a three-wide turn 1 became a train of contacts. Hold at least
    // a car's width (+margin) from anything overlapping, and if there's no room
    // on the road, back out of it instead of squeezing.
    if (this.laneOverride == null) {
      const myLat = t.lateral(car.x, car.z, car.trackIdx);
      // (three-wide past a bad starter: real drivers squeeze to ~1 m apart)
      const SEP = this._dodge ? Math.min(3.0, AI_CTRL.sep || 3.4) : (AI_CTRL.sep || 3.4);
      // (BUILD 109: every car alongside bounds the lane at once — one at a
      // time, the last car checked won, and a car three-wide between two
      // others was pushed into one of them)
      let lo = -edge - 0.4, hi = edge + 0.4, loT = lo, hiT = hi, anyNear = false;
      const near = [];
      for (const o of allCars) {
        if (o === car || o.finished || o.dead || o.inPit) continue;
        const g = roadGap(o);
        if (Math.abs(g) > 6.5) continue;
        if (Math.hypot(o.x - car.x, o.z - car.z) > 12) continue;
        const oLat = t.lateral(o.x, o.z, o.trackIdx);
        // a car alongside: steer by the absolute lane until it's clear (the
        // line's own swing across the road must not carry us into it)
        if (Math.abs(g) < 5.5 && Math.abs(myLat - oLat) < SEP + 1.2) this._guard = 0.6;
        if (Math.abs(targetLane - oLat) < SEP) anyNear = true;
        const side = (this._dodge && this._dodge.car === o ? Math.sign(this._dodge.lane - oLat) : 0) || Math.sign(myLat - oLat) || (myLat >= 0 ? 1 : -1);
        if (side > 0) { lo = Math.max(lo, oLat + SEP); loT = Math.max(loT, oLat + 2.9); }
        else { hi = Math.min(hi, oLat - SEP); hiT = Math.min(hiT, oLat - 2.9); }
        near.push({ o, g });
      }
      if (anyNear || targetLane < lo || targetLane > hi) {
        this._guard = 0.6;
        if (lo <= hi) targetLane = Math.max(lo, Math.min(hi, targetLane));
        else if ((this._dodge || this.laneBlend < 1) && loT <= hiT) targetLane = (loT + hiT) / 2;   // three-wide, tight
        else {
          // boxed in: stay put and drop back rather than squeeze through
          targetLane = myLat;
          for (const n of near) if (n.g > -1) vAllow = Math.min(vAllow, Math.max(10, n.o.speed - 1.5));
        }
      }
    }
    this.laneOffsetNow = this.laneOffsetNow == null ? targetLane : this.laneOffsetNow;
    // (moving across for the pit entry at speed: gently — with the AI on the
    // same grip as you, a 6 m dart at 220 km/h slid it off at Parabolica)
    const laneRate = this.laneOverride != null && v > 40 ? 1.4 : (this._guard > 0 ? (AI_CTRL.guardRate || 3) : 3);
    this.laneOffsetNow += (targetLane - this.laneOffsetNow) * Math.min(1, laneRate * dt);
    // the deliberate offset from the racing line (a move, a defence, room for a
    // car alongside), smoothed on its own — so it carries along the line's
    // shape without picking up the lag of following the line itself
    // (bounded: holding a lane while the line swings 7 m across the road for
    // the next corner stretched it to the far side, and the car followed it
    // off — Les Combes on lap 1. Without a car alongside, rejoin the line briskly.)
    { // through corners keep close to the line (a car alongside is given room
      // by the speed plan below, not by leaving the line for the far side);
      // the big lane changes for a move happen on the straights
      // a "bend" by how hard the line is turning at this speed — flat-out
      // sweepers (Eau Rouge, Pouhon, 130R) count, not just slow corners
      const kapL = (LD && LD.kap) || t._lineKappa;
      let latDem = 0;
      if (kapL) for (let q = 0; q <= 3; q++) { const kk = (idx + Math.round(q * (kAhead - idx + N) % N / 3)) % N; latDem = Math.max(latDem, v * v * Math.abs(kapL[kk])); }
      this._latDem = latDem;
      const maxRel = latDem > 14 ? 1.2 : latDem > 6 ? 2.2 : 3.5;
      const want = Math.max(-maxRel, Math.min(maxRel, rl ? targetLane - rl[kAhead] : 0));
      const rr = this._guard > 0 ? (AI_CTRL.guardRate || 3) : (combatLane != null ? 3 : 5);
      this._relOff = this._relOff == null ? want : this._relOff + (want - this._relOff) * Math.min(1, rr * dt); }
    // Off the racing line in a corner (alongside another car, a move, a
    // defence) the car is on a different radius — on the inside of a hairpin a
    // much TIGHTER one. Plan the speed for the lane actually being driven, a
    // second or so ahead, with the braking to get there (BUILD 107: a car
    // squeezed onto the inside used to carry racing-line speed, run wide and
    // lean on the car outside it).
    if (rl && Math.abs(this._relOff || 0) > 0.6) {
      const segQ = t.length / N, span = Math.ceil(Math.max(40, v * 1.4) / segQ);
      const latK = 17.6, aeroK = 0.0104 * (t.aeroDf || 1), capL = 53 * (t.aeroDf || 1);
      const gScale = (this._planGrip || 1) * caution * caution;               // the car's grip right now
      const dec = brakeGripAt(Math.max(v, 1), t.aeroDf) * 0.85 * (car.assists && car.assists.absEff || 0.94);
      for (let q = 0; q < span; q += 3) {
        const k = (idx + q) % N, kc = t.curv[k];
        if (Math.abs(kc) < 2e-3) continue;
        const laneK = Math.max(-lineEdge0, Math.min(lineEdge0, rl[k] + this._relOff));
        const R = 1 / Math.abs(kc) - laneK * Math.sign(kc);
        const Rl = 1 / Math.abs(kc) - rl[k] * Math.sign(kc);
        if (R >= Rl - 0.3) continue;                      // not tighter than the line there
        // closed form of v²/R = min(capL, latK + aeroK·v²)·g (bisection only
        // when the steering lock, not grip, is the limit — hairpins)
        const g2 = gScale * sk.corner * sk.corner, Rm = Math.max(1, R);
        const den = 1 / Rm - aeroK * g2;
        let lo = Math.min(100, Math.sqrt(capL * g2 * Rm), den > 1e-9 ? Math.sqrt(latK * g2 / den) : 100);
        if (typeof steerLockAt === 'function' && R < 3.2 / Math.tan(steerLockAt(lo))) {
          let a = 3, b = lo;
          for (let it = 0; it < 12; it++) { const m = (a + b) / 2; if (R >= 3.2 / Math.tan(steerLockAt(m))) a = m; else b = m; }
          lo = a;
        }
        const cap = Math.sqrt(lo * lo + 2 * dec * q * segQ);
        if (cap < vAllow) vAllow = cap;
      }
    }
    // Off-line penalty: the velocity profile's corner speeds assume the racing
    // line. A car diving down the inside or running a defensive line through a
    // corner is on a tighter radius and must carry less speed, or it runs wide
    // and collects track-limit strikes (the Austria traffic penalties).
    {
      const rlNow = rl ? rl[idx] : 0;
      const offLine = Math.abs(this.laneOffsetNow - rlNow);
      const inCorner = cs[idx] < 90;
      if (inCorner && offLine > 0.8) {
        vAllow *= 1 - 0.05 * Math.min(1, (offLine - 0.8) / 4);
      }
    }

    // Running-wide guard. Higher difficulties plan closer to the limit, so any
    // pursuit error costs more road — which is why Elite was ending up SLOWER
    // than Pro at Monza and China: it ran wide, and an excursion costs far more
    // than the extra corner speed earns. Bleed speed as the car approaches the
    // white line so it self-corrects before it runs out of track.
    {
      const latNow = Math.abs(t.lateral(car.x, car.z, car.trackIdx));
      // (BUILD 107: the line now uses the full width — the outside wheels on
      // the kerb — so the guard starts just past the white line, not 1.2 m inside it)
      const warn = t.width/2 + AI_CTRL.warn;
      if (latNow > warn) {
        const over = Math.min(1, (latNow - warn) / 1.6);
        vAllow = Math.min(vAllow, Math.max(14, v * (1 - 0.30 * over)));
      }
    }

    // Racing the title rival: a touch more commitment (~0.8% more speed) while
    // within ~150m of the player on the road.
    if (this.rivalTarget && Math.abs(this.rivalTarget.totalDist - car.totalDist) < 150) vAllow *= 1.008;

    // pit approach speed cap (set by main.js): arrive at the pit entry slowly
    if (this.speedCap != null) vAllow = Math.min(vAllow, this.speedCap);

    // ---- steering ----
    // BUILD 107: curvature FEED-FORWARD from the racing line (turn the wheel as
    // much as the line bends, scaled by what full lock gives right now — the
    // grip the driver feels) plus pure-pursuit FEEDBACK at a short look-ahead
    // to correct the error. The old pure pursuit alone needed a long look-ahead
    // to be stable, which cut every corner (early apex, 1-2 m wide on exit), and
    // its 88% steer cap meant it could never use the car's full grip.
    // the racing line may use the road out to the kerbs; the pit approach keeps
    // the old margin (the pit-entry wall is right there)
    const lineEdge = this.laneOverride != null ? edge : t.width / 2 - 0.5;
    const lane = Math.max(-lineEdge, Math.min(lineEdge, this.laneOffsetNow));
    const segL = t.length / N;
    const onLine = combatLane == null && this.laneOverride == null && this.laneBlend >= 1;
    const lookFB = Math.min(AI_CTRL.lookMax, Math.max(AI_CTRL.lookMin, v * AI_CTRL.look));
    const kFB = (idx + Math.ceil(lookFB / segL)) % N;
    // aim at the chosen lane, carried along the SHAPE of the line: the offset
    // from the racing line we want (zero on the line; the side guard, a move,
    // a defence or the pit approach shift it) applied at the feedback point
    const relOff = this._relOff || 0;
    if (this._guard > 0) this._guard -= dt;
    const guarded = this._guard > 0;
    const laneFB = rl && this.laneOverride == null && !guarded ? Math.max(-lineEdge, Math.min(lineEdge, rl[kFB] + relOff)) : lane;
    const target = t.posAt(kFB, laneFB);
    const dx = target.x - car.x, dz = target.z - car.z;
    const targetAng = Math.atan2(dx, dz);
    let da = targetAng - car.heading;
    while (da > Math.PI) da -= 2*Math.PI;
    while (da < -Math.PI) da += 2*Math.PI;
    let ff = 0;
    const kap = LD ? LD.kap : t._lineKappa;
    if (kap && car._yawCap > 1e-3 && v > 3) {
      const kFF = (idx + Math.ceil(Math.max(1, v * AI_CTRL.preview) / segL)) % N;
      ff = (v * kap[kFF]) / car._yawCap * (this.laneOverride == null && !guarded ? 1 : AI_CTRL.ffOff);
    }
    let steer = Math.max(-1, Math.min(1, ff + da * AI_CTRL.gain));
    // In traffic — a car alongside, racing for position, the grid fan-out or
    // the pit approach — steer the calm way: aim at the chosen lane a long way
    // ahead (pure pursuit, no line feed-forward) so the car holds its lane and
    // gives room instead of following the racing line's swing across the road.
    if (AI_CTRL.traffic && (AI_CTRL.forceTraffic || guarded || combatLane != null || this.laneBlend < 1 || this.laneOverride != null)) {
      // (jinking out from behind a slow car: a short look, a sharp turn)
      const lookT = Math.min(40, Math.max(this._dodge && v < 25 ? 4 : 9, v * 0.40));
      const kT = (idx + Math.ceil(lookT / segL)) % N;
      const tgt = t.posAt(kT, lane);
      let d2 = Math.atan2(tgt.x - car.x, tgt.z - car.z) - car.heading;
      while (d2 > Math.PI) d2 -= 2*Math.PI;
      while (d2 < -Math.PI) d2 += 2*Math.PI;
      let cap = 0.92 + 0.08 * Math.max(0, Math.min(1, (25 - v) / 10));
      // BUILD 107: in a fast sweeper add the turn the lane itself needs
      // (feed-forward from the centreline's curvature at this offset). Pursuit
      // alone steered about half what Pouhon or Eau Rouge needs at 270 km/h and
      // ran the car wide off the road. Slow corners and straights: unchanged.
      const w = Math.max(0, Math.min(1, ((this._latDem || 0) - 6) / 8)) * (AI_CTRL.ffT != null ? AI_CTRL.ffT : 1);
      if (w > 0 && t.curv && car._yawCap > 1e-3 && v > 3) {
        const kM = (idx + Math.ceil(lookT * 0.5 / segL)) % N;
        const kc = t.curv[kM], den = 1 - lane * kc;
        if (den > 0.2) {
          const kapLane = -kc / den;
          d2 -= w * lookT * kapLane * 0.5;              // the angle pursuit sees when ON the lane
          steer = w * (v * kapLane) / car._yawCap + d2 * 3.4;
          cap += (1 - cap) * w;
        } else steer = d2 * 3.4;
      } else steer = d2 * 3.4;
      steer = Math.max(-cap, Math.min(cap, steer));
    }
    if (AI_CTRL.debug) this._dbg = { ff, da, vAllow, kapNow: kap ? kap[idx] : 0 };

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
    // BUILD 107: brake FEED-FORWARD. Braking only in proportion to the speed
    // error meant the car needed ~2 m/s too much speed before the pedal was
    // fully in, so it trailed its own braking plan by 20-30 km/h all the way
    // into a hairpin and ran wide (the old AI hid that by planning 15% more
    // braking than the car had). Now the pedal goes in for the deceleration the
    // plan asks for a moment ahead (the pedal takes ~0.17 s to build).
    {
      const segB = t.length / N;
      const look = Math.max(2, v * AI_CTRL.brakePreview);
      const kB = (idx + Math.ceil(look / segB)) % N;
      const vB = Math.min(prof[kB], vAllow);
      const need = (v * v - vB * vB) / (2 * look);                 // m/s^2 the plan wants
      const drag = 0.0006 * (t.aeroDrag || 1) * v * v + 0.4;          // what lifting alone gives
      if (need > drag + 0.5 && !AI_CTRL.noBrakeFF) {
        const cap = brakeGripAt(Math.max(v, 1), t.aeroDf) * (car.gripBonus || 1) * ((car.assists && car.assists.absEff) || 0.94);
        let b = Math.min(1, (need - drag) / Math.max(1, cap) + Math.max(0, -margin) * 0.6);
        // friction circle: mid-corner the tyres are busy turning — brake only
        // with what's left (a driver modulates; slamming the pedal on a corner
        // exit for the pit-lane limit sent cars off at Parabolica)
        const latU = Math.min(1, car._latUse || 0);
        b = Math.min(b, Math.max(0.15, Math.sqrt(Math.max(0, 1 - latU * latU))));
        if (b > brake) { brake = b; throttle = 0; }
      }
    }

    // Off-track recovery. Previously this just eased the throttle, so a car
    // that ran wide kept travelling at speed across the grass — at China that
    // was 185 m of a single excursion and three track-limit strikes a lap.
    // Now it lifts properly and brakes in proportion to how far out it is,
    // which lets the steering pull it back onto the road.
    if (car.offTrack) {
      throttle = Math.min(throttle, 0.25);
      const myLatNow = t.lateral(car.x, car.z, car.trackIdx);
      const over = Math.abs(myLatNow) - t.width/2;
      // brake harder the further out we are, which lets the existing pursuit
      // steering reel the car back without an explicit steer override (those
      // oscillate against the racing line at tight/street circuits).
      if (over > 0.6 && v > 20) brake = Math.max(brake, Math.min(0.9, over * 0.28));
    }

    return { throttle, brake, steer };
  }
}
