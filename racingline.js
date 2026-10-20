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
  const comp = (G.player && G.player.phys.compound) || 'medium';
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
  if (!RL.mesh || !G.player || !G.track) return;
  const now = performance.now();
  if (!force && now - RL.t < 90) return;
  RL.t = now;
  const track = G.track, prof = _rlProfile(track), N = track.n, seg = track.length / N;
  const p = G.player.phys, v = Math.max(0, p.speed);
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
  if (!G.player || !G.track || !G.assists || !G.assists.brakeAssist) return inp;
  const track = G.track, prof = _rlProfile(track), N = track.n, seg = track.length / N;
  const p = G.player.phys, v = p.speed;
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
    return { throttle: 0, brake: Math.max(inp.brake, amt), steer: inp.steer };
  }
  p._brakeAssist = 0;
  return inp;
}
