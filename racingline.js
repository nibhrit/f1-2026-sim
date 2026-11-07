// ============================================================
// Racing line assist (F1-game style) + braking assist.
// A ribbon painted on the road along the ideal line:
//   green  = flat out / accelerate
//   yellow = lift / light braking coming
//   red    = brake (turns red EARLIER if you arrive faster than the ideal)
// Modes: 'off' | 'corners' (only the braking + corner sections) | 'full'.
// The ideal line and speeds come from the same planner the AI uses, run for a
// car with YOUR grip (no AI difficulty bonus) and a slightly cautious margin,
// so it's a line a beginner can actually follow.
// ============================================================

// The game state lives inside main.js's closure; the page exposes it as
// window.__G. (Referencing a bare `G` here worked in the test harness, which
// unwraps main.js, but threw in the real page — the BUILD 92/93 "race won't
// start" bug.)
function _G() { return (typeof G !== 'undefined') ? G : window.__G; }

const RL = { mesh: null, colors: null, prof: null, idx: null, mode: 'off', key: '', t: 0, track: null };

function _rlPlanner(track) {
  // a throwaway AI planner for a "your-grip" car
  const c = new CarPhysics(track);
  c.gripBonus = 1;
  const ai = new AIDriver(c, track, { id: 'LINE', skill: 0.9, team: 'redbull' });
  ai.buildCornerSpeeds();
  return ai;
}

// ideal speed at every track sample for the current conditions
function _rlProfile(track) {
  const wet = (typeof TRACK_WETNESS !== 'undefined') ? TRACK_WETNESS : 0;
  const comp = (_G().player && _G().player.phys.compound) || 'medium';
  const wg = wetGrip(comp, wet);
  const key = track.def.id + ':' + Math.round(wg * 40);
  if (RL.prof && RL.key === key && RL.track === track) return RL.prof;
  const ai = _rlPlanner(track);
  // cautious: a touch below the limit, and brakes a little early
  const pace = 0.95 * Math.sqrt(wg) * 1.05;
  const brakeFac = 0.82 * (0.35 + 0.65 * wg);
  RL.prof = Float64Array.from(ai.speedProfile(pace, brakeFac, 0.55 + 0.45 * wg));
  RL.key = key; RL.track = track;
  return RL.prof;
}

function racingLineBuild(track, parent, mode) {
  racingLineClear();
  RL.mode = mode || 'off';
  if (RL.mode === 'off' || !track) return;
  const prof = _rlProfile(track);
  const rl = track._raceLine; if (!rl) return;
  const N = track.n, seg = track.length / N, STEP = 2, W = 0.55;
  // which samples are "corner business": from where braking starts (or the
  // speed is well below top) until the car is back up to speed
  const show = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const j = (i + 6) % N;
    const decel = (prof[i] * prof[i] - prof[j] * prof[j]) / (2 * 6 * seg);   // m/s^2 the line asks for
    if (RL.mode === 'full' || decel > 3 || prof[i] < 70) show[i] = 1;
  }
  // widen the corner zones a little so they don't start abruptly
  if (RL.mode === 'corners') { const s2 = show.slice(); for (let i = 0; i < N; i++) if (s2[i]) for (let o = -20; o <= 10; o++) show[(i + o + N) % N] = 1; }
  const v = [], col = [], ia = [], idx = [];
  let n = 0, prevShown = false;
  for (let i = 0; i <= N; i += STEP) {
    const k = i % N;
    const lat = rl[k];
    const a = track.posAt(k, lat - W / 2), b = track.posAt(k, lat + W / 2);
    v.push(a.x, track.heightAt(k, lat - W / 2) + 0.09, a.z, b.x, track.heightAt(k, lat + W / 2) + 0.09, b.z);
    col.push(0, 1, 0, 0, 1, 0);
    idx.push(k);
    if (n > 0 && show[k] && prevShown) { const q = (n - 1) * 2; ia.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    prevShown = !!show[k]; n++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  RL.colors = new THREE.BufferAttribute(new Float32Array(col), 3);
  g.setAttribute('color', RL.colors);
  g.setIndex(ia);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.78,
    depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: true }));
  m.renderOrder = 2;
  RL.mesh = m; RL.idx = idx; RL.parent = parent;
  parent.add(m);
  racingLineUpdate(true);
}

function racingLineClear() {
  if (RL.mesh) { RL.mesh.parent && RL.mesh.parent.remove(RL.mesh); RL.mesh.geometry.dispose(); RL.mesh.material.dispose(); }
  RL.mesh = null; RL.colors = null; RL.idx = null;
}

// Recolour the line around the player a few times a second.
function racingLineUpdate(force) {
  if (!RL.mesh || !_G().player || !_G().track) return;
  const now = performance.now();
  if (!force && now - RL.t < 90) return;
  RL.t = now;
  const track = _G().track, prof = _rlProfile(track), N = track.n, seg = track.length / N;
  const p = _G().player.phys, v = Math.max(0, p.speed);
  const dec = brakeGripAt(v, track.aeroDf) * 0.8 * (0.35 + 0.65 * (p.wetGripMul || 1));
  const arr = RL.colors.array, idx = RL.idx;
  const me = p.trackIdx;
  for (let n = 0; n < idx.length; n++) {
    const k = idx[n];
    // static phase from the ideal profile
    const j = (k + 6) % N;
    const decel = (prof[k] * prof[k] - prof[j] * prof[j]) / (2 * 6 * seg);   // m/s^2
    let r = 0.1, g = 0.95, b = 0.25;                        // green
    if (decel > 10) { r = 1; g = 0.15; b = 0.1; }           // red: brake
    else if (decel > 2.5) { r = 1; g = 0.82; b = 0.1; }     // yellow: lift / light brake
    // personal: if YOU are carrying more speed than the line wants just ahead,
    // the stretch between you and that point turns red (brake now) or yellow
    let ahead = (k - me + N) % N;
    if (ahead < N / 3) {
      const dist = ahead * seg;
      // the slowest point you must make within the next ~300 m
      let need = 1e9;
      for (let q = 0; q < 160; q += 4) { const kk = (k + q) % N; need = Math.min(need, Math.sqrt(prof[kk] * prof[kk] + 2 * dec * q * seg)); }
      if (v > need + 1.5 && dist < 300) { r = 1; g = 0.15; b = 0.1; }
      else if (v > need - 4 && dist < 300 && decel > 0) { r = 1; g = 0.82; b = 0.1; }
    }
    arr[n * 6] = arr[n * 6 + 3] = r; arr[n * 6 + 1] = arr[n * 6 + 4] = g; arr[n * 6 + 2] = arr[n * 6 + 5] = b;
  }
  RL.colors.needsUpdate = true;
}

// Braking assist: if you're far too fast for what's coming, it brakes for you
// (you can still brake harder yourself). Returns the adjusted input.
function brakeAssistInput(inp) {
  if (!_G().player || !_G().track || !_G().assists || !_G().assists.brakeAssist) return inp;
  const track = _G().track, prof = _rlProfile(track), N = track.n, seg = track.length / N;
  const p = _G().player.phys, v = p.speed;
  if (v < 8) return inp;
  const dec = brakeGripAt(v, track.aeroDf) * 0.85 * (0.35 + 0.65 * (p.wetGripMul || 1));
  // allow for the ~0.2 s it takes the brake to bite
  const lag = v * 0.2;
  let need = 1e9;
  for (let q = 1; q < 260; q += 2) { const k = (p.trackIdx + q) % N; need = Math.min(need, Math.sqrt(prof[k] * prof[k] + 2 * dec * Math.max(0, q * seg - lag))); }
  need *= 0.98;
  if (v > need) {
    const amt = Math.min(1, 0.4 + (v - need) / 3);
    p._brakeAssist = amt;
    return { throttle: 0, brake: Math.max(inp.brake, amt), steer: inp.steer, analog: inp.analog };
  }
  p._brakeAssist = 0;
  return inp;
}

// ---------- steering assist (touch / tilt) ----------
// BUILD 104. Tilt is position control: hold the phone at an angle and the
// wheel stays there. That is hard for anyone who has not driven with it —
// they steer, overshoot, correct, and weave off the road — while a keyboard
// player's taps are smoothed into a sensible arc. Steering assist turns the
// tilt into "where on the road do I want to be": level = follow the racing
// line, tilt left / right = move across to that side (full tilt = the edge).
// The game does the steering to get there. LOW blends half-and-half with the
// raw tilt; OFF is the raw tilt.
// level: 0 off, 0.5 low, 1 high. Returns the adjusted input.
// Tilt meaning (HIGH): level = follow the racing line; tilting moves the target
// toward that EDGE of the road (full tilt = the edge itself), whatever the line
// is doing — so a steady tilt holds a side for an overtake or a defence.
// Traffic: if a car ahead is in the way, the target slides to the side you are
// tilting toward, or to the side with more room.
function steerAssistInput(inp, level) {
  const G_ = _G();
  if (!level || !G_ || !G_.player || !G_.track) return inp;
  const t = G_.track, p = G_.player.phys, rl = t._raceLine;
  if (!rl || p.speed < 3 || p.inPit) return inp;
  const N = t.n, segM = t.length / N, v = p.speed, L = t.length;
  const edge = t.width / 2 - 1.6;
  const u = Math.max(-1, Math.min(1, inp.steer));          // + = left = negative lateral
  const lookM = Math.min(40, Math.max(9, v * 0.42));
  const kA = (p.trackIdx + Math.ceil(lookM / segM)) % N;
  const tSide = -Math.sign(u) * edge * 0.85;
  let lane = rl[kA] + (tSide - rl[kA]) * Math.min(1, Math.abs(u) * 1.1);
  // ---- traffic: keep out of the car ahead ----
  const myLat = t.lateral(p.x, p.z, p.trackIdx);
  let block = null, bGap = 1e9, fGap = 1e9, fV = 0;
  for (const c of (G_.cars || [])) {
    const o = c.phys || c;
    if (o === p || c.retired || c.finished || o.dead || o.inPit || c.pitState) continue;
    const raw = o.totalDist - p.totalDist, g = ((raw % L) + L + L / 2) % L - L / 2;
    if (g < 2 || g > Math.max(25, v * 1.5)) continue;
    const oLat = t.lateral(o.x, o.z, o.trackIdx);
    if (Math.abs(oLat - lane) < 3.2 && g < bGap) { bGap = g; block = oLat; }
    // the car actually in front of us right now (for the following brake)
    if (Math.abs(oLat - myLat) < 3.0 && g < fGap) { fGap = g; fV = o.speed; }
  }
  if (block != null) {
    const room = s => s > 0 ? edge - block : block + edge;          // free road on that side of it
    let side = Math.abs(u) > 0.15 ? -Math.sign(u) : (room(1) >= room(-1) ? 1 : -1);
    if (room(side) < 3.4) side = -side;
    if (room(side) >= 3.4) lane = Math.max(-edge, Math.min(edge, block + side * 3.6));
    else lane = myLat;                                              // no room: stay in line behind it
  }
  lane = Math.max(-edge, Math.min(edge, lane));
  if (inp.pitLane != null) lane = inp.pitLane;                     // heading for the pit entry
  // pursuit steering toward that point (the same law the AI drives with)
  const tgt = t.posAt(kA, lane);
  let da = Math.atan2(tgt.x - p.x, tgt.z - p.z) - p.heading;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const cap = 0.9 + 0.08 * Math.max(0, Math.min(1, (25 - v) / 10));
  const auto = Math.max(-cap, Math.min(cap, da * 3.2));
  // LOW: the assist still does most of the steering, the raw tilt is layered
  // on top (35%) so you can feel the wheel and push past the line's limits
  const steer = level >= 1 ? auto : Math.max(-1, Math.min(1, auto * 0.8 + inp.steer * 0.35));
  // running wide: if the car is drifting out past the edge of the road, the
  // assist lifts off the throttle (like the AI's own running-wide guard)
  let throttle = inp.throttle, brake = inp.brake;
  // following brake: the assist won't drive you into the car in front. If
  // we're closing on it faster than ~14 m/s^2 could stop us in the room
  // left (keeping 6 m), lift and brake as much as that needs.
  if (fGap < 1e9 && v > fV) {
    const room = Math.max(0.5, fGap - 6);
    const need = (v * v - fV * fV) / (2 * room);              // m/s^2 to match its speed in time
    if (need > 4) {
      throttle = 0;
      brake = Math.max(brake, Math.min(1, (need - 4) / 14));
    } else if (need > 2) throttle = Math.min(throttle, 0.4);
  }
  if (inp.pitLane == null) {
    const hw = t.width / 2, latNow = myLat;
    const k2 = (p.trackIdx + Math.ceil(Math.max(8, v * 0.5) / segM)) % N;
    const ahead = t.posAt(k2, 0), hx = Math.sin(p.heading), hz = Math.cos(p.heading);
    // where we'll be in ~0.5 s if we hold this heading, relative to the road there
    const fx = p.x + hx * v * 0.5, fz = p.z + hz * v * 0.5;
    const latF = t.lateral(fx, fz, k2);
    const over = Math.max(Math.abs(latNow), Math.abs(latF)) - (hw - 0.8);
    if (over > 0 && v > 12) {
      throttle = Math.min(throttle, Math.max(0, 1 - over / 1.5));
      // heading well off the road: scrub speed too, or it's a wall
      if (over > 0.8) brake = Math.max(brake, Math.min(0.8, (over - 0.8) / 2.5));
    }
  }
  return Object.assign({}, inp, { steer, throttle, brake, assisted: true, analog: level >= 1 ? false : inp.analog });
}
