// ============================================================
// Per-circuit scenery (BUILD 84): the signature surroundings of each
// real venue, built from simple shapes. Placement is relative to the
// real circuit centreline (TrackData), so landmarks sit where they are
// in reality: Monaco's harbour, yachts, Casino and the Rock; Spa's
// Raidillon; Silverstone's Wing and hangars; Monza's podium and old
// banking; Suzuka's funfair; Singapore's Marina Bay skyline.
//
// prepareScenery() runs BEFORE the terrain is built (it defines water,
// which the terrain is lowered under, and footprints that trees and
// buildings must avoid). buildScenery() adds the meshes.
// ============================================================

function _scAt(track, f, lat) {
  const k = track.idxAtDist(((f % 1) + 1) % 1 * track.length);
  const p = track.posAt(k, lat || 0);
  return { x: p.x, z: p.z, y: track.py[k], k, h: Math.atan2(track.tx[k], track.tz[k]) };
}
function _scDist(track, x, z) {
  let bd = Infinity;
  for (let q = 0; q < track.n; q += 3) { const dx = track.px[q] - x, dz = track.pz[q] - z; const d = dx*dx + dz*dz; if (d < bd) bd = d; }
  return Math.sqrt(bd);
}
function _scCentroid(track) {
  let x = 0, z = 0; for (let i = 0; i < track.n; i++) { x += track.px[i]; z += track.pz[i]; }
  return { x: x / track.n, z: z / track.n };
}
// +1 if the driver's right (positive lateral) at f points into the lap's loop
function _scInside(track, f) {
  const c = _scCentroid(track), p = _scAt(track, f, 0), r = _scAt(track, f, 40);
  return Math.hypot(r.x - c.x, r.z - c.z) < Math.hypot(p.x - c.x, p.z - c.z) ? 1 : -1;
}
// direction of the corner at f: +1 left-hander, -1 right-hander
function _scTurn(track, f) {
  const a = _scAt(track, f - 0.006), b = _scAt(track, f + 0.006);
  let dh = b.h - a.h; while (dh > Math.PI) dh -= 2*Math.PI; while (dh < -Math.PI) dh += 2*Math.PI;
  return dh >= 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Plans: where things go, per circuit. Pure data + geometry, no meshes —
// shared by prepare (footprints / water) and build.
// ---------------------------------------------------------------------------
function _scPlan(track) {
  const id = track.def.id, hw = track.width / 2;
  const P = { water: [], marks: [] };
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  const add = (o) => { P.marks.push(o); return o; };
  if (id === 'monaco') {
    // Port Hercule sits between the chicane–Tabac quay and the swimming-pool
    // section and opens to the Mediterranean; the Rock (Monaco-Ville, the
    // Palace) stands across it.
    const H = mid(_scAt(track, 0.64), _scAt(track, 0.80));
    const C = _scCentroid(track);
    let dx = H.x - C.x, dz = H.z - C.z; const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    P.water.push({ x: H.x, z: H.z, r: 140 });
    for (let i = 1; i <= 5; i++) P.water.push({ x: H.x + dx * 150 * i, z: H.z + dz * 150 * i, r: 150 + i * 70 });
    P.harbour = H;
    // the Rock: first spot across the water that is well clear of the circuit
    for (const [a, b] of [[300, 260], [300, -260], [420, 300], [420, -300], [550, 0], [600, 350]]) {
      const x = H.x + dx * a - dz * b, z = H.z + dz * a + dx * b;
      if (_scDist(track, x, z) > 150 + hw + 60) { add({ type: 'rock', x, z, r: 150 }); break; }
    }
    const cs = _scAt(track, 0.235, -(hw + 40));
    add({ type: 'casino', x: cs.x, z: cs.z, h: cs.h, y: cs.y, r: 28 });
  } else if (id === 'singapore') {
    // Marina Bay lies to the right of the Esplanade / Raffles Avenue return
    // leg; Marina Bay Sands stands across the water, the Flyer by the final
    // corners, the Esplanade's "durian" domes on the waterfront.
    for (let f = 0.74; f <= 0.94; f += 0.02) for (const lat of [150, 300, 470]) {
      const p = _scAt(track, f, lat); P.water.push({ x: p.x, z: p.z, r: 140 });
    }
    const mbs = _scAt(track, 0.84, 640);
    add({ type: 'mbs', x: mbs.x, z: mbs.z, h: mbs.h, y: mbs.y, r: 110 });
    const fl = _scAt(track, 0.965, 120);
    add({ type: 'flyer', x: fl.x, z: fl.z, h: fl.h, y: fl.y, r: 45 });
    const es = _scAt(track, 0.79, hw + 46);
    add({ type: 'durians', x: es.x, z: es.z, h: es.h, y: es.y, r: 45 });
  } else if (id === 'japan') {
    // the funfair by the start/finish straight: the big wheel and a coaster
    for (const side of [_scInside(track, 0.975), -_scInside(track, 0.975)]) {
      const p = _scAt(track, 0.975, side * 150);
      if (_scDist(track, p.x, p.z) > 75) { add({ type: 'ferris', x: p.x, z: p.z, h: p.h, y: p.y, r: 40 });
        const q = _scAt(track, 0.955, side * 175);
        if (_scDist(track, q.x, q.z) > 70) add({ type: 'coaster', x: q.x, z: q.z, h: q.h, y: q.y, r: 55 });
        break; }
    }
    add(_scStandAt(track, 0.995, 1, 130));
  } else if (id === 'italy') {
    // the podium that hangs over the main straight, the old Sopraelevata
    // banking in the park, and the big stands at Rettifilo and Parabolica
    const pd = _scAt(track, 0.012, -(hw + 14));
    add({ type: 'podium', x: pd.x, z: pd.z, h: pd.h, y: pd.y, r: 16 });
    const ins = _scInside(track, 0.06);
    const bk = _scAt(track, 0.07, ins * 95);
    if (_scDist(track, bk.x, bk.z) > 60) add({ type: 'banking', x: bk.x, z: bk.z, h: bk.h, y: bk.y, r: 140, side: ins });
    add(_scStandAt(track, 0.995, 1, 160));
    add(_scStandAt(track, 0.155, -_scTurn(track, 0.155), 90));
    add(_scStandAt(track, 0.88, -_scTurn(track, 0.88), 110));
  } else if (id === 'britain') {
    // the Wing over the pits, big stands at the classic corners, and the
    // wartime hangars along Hangar Straight (it was RAF Silverstone)
    P.wing = true;
    for (const f of [0.06, 0.16, 0.35, 0.53, 0.65, 0.85, 0.95]) add(_scStandAt(track, f, -_scTurn(track, f), 95));
    add(_scStandAt(track, 0.995, 1, 140));
    const hs = _scInside(track, 0.78);
    for (let i = 0; i < 3; i++) {
      const p = _scAt(track, 0.765 + i * 0.012, hs * 120);
      if (_scDist(track, p.x, p.z) > 60) add({ type: 'hangar', x: p.x, z: p.z, h: p.h, y: p.y, r: 35 });
    }
  } else if (id === 'belgium') {
    // Raidillon's hillside stand, La Source, the Bus Stop
    add(_scStandAt(track, 0.165, -_scTurn(track, 0.165), 110));
    add(_scStandAt(track, 0.05, -_scTurn(track, 0.05), 90));
    add(_scStandAt(track, 0.965, -_scTurn(track, 0.965), 80));
    add(_scStandAt(track, 0.995, 1, 120));
  }
  // drop anything that ended up on the circuit
  P.marks = P.marks.filter(m => m && _scDist(track, m.x, m.z) > hw + (m.type === 'stand' ? 10 : m.type === 'podium' ? 8 : m.type === 'banking' ? 40 : m.r * 0.8 + 10));
  return P;
}
// a covered grandstand facing the track at f, side +1 right / -1 left
function _scStandAt(track, f, side, len) {
  const hw = track.width / 2, off = (track.wallOff || hw + 8) + 14;
  const p = _scAt(track, f, side * off);
  return { type: 'stand', x: p.x, z: p.z, h: p.h, y: p.y, r: len / 2, len, side };
}

function prepareScenery(track, theme) {
  const P = _scPlan(track);
  track._scPlan = P;
  // Water mask on a 20 m grid. Flood-filled outward from the first water
  // zone (the harbour / the bay), limited to the zones, and never across the
  // circuit — so the sea can't leak round to the other side of a road and
  // leave the track on a causeway.
  if (P.water.length) {
    const C = 20, hw2 = track.width / 2 + 10;
    const key = (ix, iz) => ix + ',' + iz;
    // inside the first (seed) zone water may come up to the quay; elsewhere it
    // keeps 70 m from the circuit, so it can't creep into the gaps between
    // two nearby sections of road
    const w0 = (P.waterSeeds || [P.water[0]])[0];
    const allowed = (x, z) => {
      if (!P.water.some(w => (x - w.x) ** 2 + (z - w.z) ** 2 <= w.r * w.r)) return false;
      if ((x - w0.x) ** 2 + (z - w0.z) ** 2 <= w0.r * w0.r) return true;
      return _scDist(track, x, z) > 70;
    };
    // road occupancy (cells the road or its verge touches)
    const road = new Set();
    for (let i = 0; i < track.n; i++) {
      for (let lat = -hw2; lat <= hw2; lat += C / 2) {
        const p = track.posAt(i, lat); road.add(key(Math.round(p.x / C), Math.round(p.z / C)));
      }
    }
    if (typeof pitLaneGeom === 'function') {                 // and the pit complex
      const g = pitLaneGeom(track);
      for (let s2 = 0; s2 <= g.total; s2 += 8) {
        const k = track.idxAtDist((g.entryStart + s2) % track.length);
        for (let lat = 0; lat <= g.garageOff + 40; lat += 8) { const p = track.posAt(k, -lat); road.add(key(Math.round(p.x / C), Math.round(p.z / C))); }
      }
    }
    const cells = new Set(), seeds = P.waterSeeds || [P.water[0]];
    const queue = [];
    for (const sd of seeds) { const ix = Math.round(sd.x / C), iz = Math.round(sd.z / C); if (!road.has(key(ix, iz))) { cells.add(key(ix, iz)); queue.push([ix, iz]); } }
    while (queue.length) {
      const [ix, iz] = queue.pop();
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = ix + dx, nz = iz + dz, kk = key(nx, nz);
        if (cells.has(kk) || road.has(kk) || !allowed(nx * C, nz * C)) continue;
        cells.add(kk); queue.push([nx, nz]);
      }
    }
    track._water = (x, z) => cells.has(key(Math.round(x / C), Math.round(z / C)));
    let lo = Infinity; for (let i = 0; i < track.n; i++) lo = Math.min(lo, track.py[i]);
    track._seaY = lo - 2.4;
  } else { track._water = null; }
  track._sceneryClear = (x, z, rad) => {
    if (track._water) {
      // keep a clear waterfront: nothing big right on the water's edge
      const m = (rad || 0) + 25;
      if (track._water(x, z) || track._water(x + m, z) || track._water(x - m, z) || track._water(x, z + m) || track._water(x, z - m)) return false;
    }
    for (const m of P.marks) if (Math.hypot(x - m.x, z - m.z) < m.r + (rad || 0)) return false;
    return true;
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
function buildScenery(track, grp, theme, H) {
  const P = track._scPlan; if (!P) return;
  const night = !!theme.night, hw = track.width / 2;
  const parts = new THREE.Group();            // static solids, merged by material
  const M = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.75, metalness: 0.05 }, o || {}));
  const put = (geo, mat, x, y, z, ry, caster) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry || 0;
    if (caster) m.userData.caster = true; parts.add(m); return m;
  };
  // local frame helper: (along, out, up) relative to a mark facing heading h
  const loc = (m, a, o, u) => {
    const fx = Math.sin(m.h), fz = Math.cos(m.h), rx = -Math.cos(m.h), rz = Math.sin(m.h);
    return [m.x + fx * a + rx * o, u, m.z + fz * a + rz * o];
  };
  const groundAt = (x, z) => H.terrainY(x, z);

  // ---- water ----
  if (track._water) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const w of P.water) { x0 = Math.min(x0, w.x - w.r); x1 = Math.max(x1, w.x + w.r); z0 = Math.min(z0, w.z - w.r); z1 = Math.max(z1, w.z + w.r); }
    const g = new THREE.PlaneGeometry(x1 - x0 + 400, z1 - z0 + 400);
    const wm = new THREE.MeshStandardMaterial({ color: night ? 0x03070f : 0x1f6390, roughness: night ? 0.25 : 0.08, metalness: night ? 0.2 : 0.65 });
    const sea = new THREE.Mesh(g, wm);
    sea.rotation.x = -Math.PI / 2; sea.position.set((x0 + x1) / 2, track._seaY, (z0 + z1) / 2);
    sea.userData.ground = true; grp.add(sea);
  }

  // ---- Monaco: yachts in the harbour ----
  if (P.harbour) {
    const white = M(0xf4f4f2, { roughness: 0.35 }), navy = M(0x1b2b4a, { roughness: 0.4 }), glass = M(0x1a2633, { roughness: 0.1, metalness: 0.6 }), teak = M(0xa77a4b);
    let placed = 0, tries = 0, sd = 77;
    const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    while (placed < 34 && tries < 900) {
      tries++;
      const w = P.water[Math.floor(r() * Math.min(4, P.water.length))];
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * w.r;
      const x = w.x + Math.cos(a) * d, z = w.z + Math.sin(a) * d;
      if (!track._water(x, z) || _scDist(track, x, z) < hw + 34) continue;
      const L = 22 + r() * 48, B = L * 0.19, ry = (r() < 0.6 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.3, y = track._seaY;
      put(new THREE.BoxGeometry(B, 2.6, L), white, x, y + 1.2, z, ry, true);
      put(new THREE.BoxGeometry(B * 1.01, 0.5, L * 1.01), navy, x, y + 0.2, z, ry);
      put(new THREE.BoxGeometry(B * 0.8, 2.2, L * 0.55), white, x, y + 3.6, z, ry);
      put(new THREE.BoxGeometry(B * 0.82, 0.9, L * 0.5), glass, x, y + 3.6, z, ry);
      if (L > 45) put(new THREE.BoxGeometry(B * 0.6, 2.0, L * 0.3), white, x, y + 5.7, z, ry);
      put(new THREE.BoxGeometry(B * 0.9, 0.2, L * 0.25), teak, x - Math.sin(ry) * L * 0.33, y + 2.6, z - Math.cos(ry) * L * 0.33, ry);
      placed++;
    }
  }

  for (const m of P.marks) {
    const gy = groundAt(m.x, m.z);
    if (m.type === 'rock') {
      // Le Rocher: a steep limestone promontory crowned by the Palace
      const rock = M(0x6f6450, { roughness: 0.95, flatShading: true });
      const g = new THREE.IcosahedronGeometry(1, 2); g.scale(m.r, 55, m.r * 0.7);
      const y0 = track._seaY;
      const h = new THREE.Mesh(g, rock); h.position.set(m.x, y0, m.z); h.userData.caster = true; grp.add(h);
      const ochre = M(0xe0c48e), pink = M(0xe6b9a2), roofM = M(0xa2553a);
      put(new THREE.BoxGeometry(70, 14, 34), ochre, m.x, y0 + 60, m.z, 0.3, true);         // Palace
      put(new THREE.BoxGeometry(72, 1.5, 36), roofM, m.x, y0 + 67.7, m.z, 0.3);
      put(new THREE.CylinderGeometry(4, 4, 22, 8), ochre, m.x + 30, y0 + 64, m.z - 8, 0);
      for (let i = 0; i < 14; i++) {                                                      // old town
        const a = i * 0.9, d = 30 + (i % 4) * 18, bx = m.x + Math.cos(a) * d, bz = m.z + Math.sin(a) * d * 0.7;
        const bh = 10 + (i % 3) * 5;
        put(new THREE.BoxGeometry(16, bh, 14), i % 2 ? ochre : pink, bx, y0 + 48 + bh / 2, bz, a, false);
        put(new THREE.BoxGeometry(17, 1.2, 15), roofM, bx, y0 + 48 + bh + 0.6, bz, a);
      }
    } else if (m.type === 'casino') {
      // Casino de Monte-Carlo: Beaux-Arts front, twin towers, copper-green roofs
      const stone = M(0xeedfbf, { roughness: 0.6 }), copper = M(0x5f9d88, { roughness: 0.5, metalness: 0.3 }), gold = M(0xd6b25a, { roughness: 0.4, metalness: 0.6 });
      const y0 = gy;
      const c = loc(m, 0, 0, y0 + 9); put(new THREE.BoxGeometry(22, 18, 52), stone, c[0], c[1], c[2], m.h, true);
      const rf = loc(m, 0, 0, y0 + 20); put(new THREE.CylinderGeometry(9, 14, 6, 4), copper, rf[0], rf[1], rf[2], m.h + Math.PI / 4);
      for (const a of [-22, 22]) {
        const t = loc(m, a, -8, y0 + 14); put(new THREE.BoxGeometry(7, 28, 7), stone, t[0], t[1], t[2], m.h, true);
        const tr = loc(m, a, -8, y0 + 31); put(new THREE.ConeGeometry(5.5, 8, 4), copper, tr[0], tr[1], tr[2], m.h + Math.PI / 4);
        const tf = loc(m, a, -8, y0 + 36); put(new THREE.SphereGeometry(0.9, 8, 6), gold, tf[0], tf[1], tf[2]);
      }
      const gd = loc(m, 0, -20, y0 + 0.3); put(new THREE.BoxGeometry(14, 0.6, 40), M(0x3f7d34), gd[0], gd[1], gd[2], m.h);
      const fo = loc(m, 0, -20, y0 + 1.0); put(new THREE.CylinderGeometry(4, 4.5, 1.2, 16), stone, fo[0], fo[1], fo[2]);
    } else if (m.type === 'mbs') {
      // Marina Bay Sands: three leaning towers under the SkyPark "ship"
      const tower = new THREE.MeshStandardMaterial({ map: windowTex(true), emissive: 0xffffff, emissiveMap: windowTex(true), emissiveIntensity: 0.55, roughness: 0.3 });
      const deck = M(0xdfe6ee, { emissive: 0x5a6a88, emissiveIntensity: 0.5 });
      const y0 = Math.max(gy, track._seaY ? track._seaY + 2 : gy);
      // three towers in a row along the waterfront, each a pair of legs
      // leaning together; the SkyPark spans all three and overhangs one end
      for (const a of [-75, 0, 75]) {
        for (const lean of [-1, 1]) {
          const p = loc(m, a, lean * 11, y0 + 96);
          const t = new THREE.Mesh(new THREE.BoxGeometry(18, 194, 34), tower);
          t.position.set(p[0], p[1], p[2]); t.rotation.order = 'YXZ'; t.rotation.y = m.h + Math.PI / 2; t.rotation.z = -lean * 0.06; grp.add(t);
        }
      }
      const sk = loc(m, 25, 0, y0 + 197); put(new THREE.BoxGeometry(40, 6, 300), deck, sk[0], sk[1], sk[2], m.h);
    } else if (m.type === 'flyer') {
      // Singapore Flyer: a 150 m observation wheel, its rim lit at night
      _scWheel(grp, put, m, gy, 70, 28, night ? 0xbfe6ff : 0xdfe6ee, night);
    } else if (m.type === 'ferris') {
      // Suzuka's Ferris wheel (~50 m) — the symbol of the circuit
      _scWheel(grp, put, m, gy, 24, 32, 0xe8eef5, night);
    } else if (m.type === 'coaster') {
      // a roller coaster loop on lattice pylons
      const steel = M(0xd94a3a, { roughness: 0.4, metalness: 0.5 }), pylon = M(0xe6e9ee, { roughness: 0.5, metalness: 0.4 });
      const pts = [];
      for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * 45, 8 + 14 * (1 + Math.sin(a * 3)) , Math.sin(a) * 26)); }
      const curve = new THREE.CatmullRomCurve3(pts, true);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.8, 6, true), steel);
      tube.position.set(m.x, gy, m.z); tube.rotation.y = m.h; grp.add(tube);
      for (let i = 0; i < 64; i += 4) { const p = pts[i]; const hgt = p.y;
        const wx = m.x + p.x * Math.cos(m.h) + p.z * Math.sin(m.h), wz = m.z - p.x * Math.sin(m.h) + p.z * Math.cos(m.h);
        put(new THREE.CylinderGeometry(0.4, 0.5, hgt, 5), pylon, wx, gy + hgt / 2, wz); }
    } else if (m.type === 'durians') {
      // Esplanade theatres: two spiky shell domes
      const shell = M(0x7d6c4a, { roughness: 0.55, metalness: 0.45, flatShading: true, emissive: night ? 0x1c160c : 0 });
      for (const a of [-24, 24]) { const p = loc(m, a, 0, gy);
        const g = new THREE.IcosahedronGeometry(1, 2); g.scale(22, 16, 18);
        const d = new THREE.Mesh(g, shell); d.position.set(p[0], gy, p[2]); d.rotation.y = m.h; grp.add(d); }
    } else if (m.type === 'podium') {
      // Monza's podium: a platform cantilevered out over the main straight
      const steel = M(0x5b5f68, { roughness: 0.5, metalness: 0.5 }), red = M(0xc8102e, { roughness: 0.6 });
      const y0 = m.y;
      const base = loc(m, 0, 0, y0 + 9); put(new THREE.BoxGeometry(10, 18, 6), steel, base[0], base[1], base[2], m.h, true);
      // the arm reaches across the pit wall toward the middle of the track
      const arm = loc(m, 0, (hw + 14) * 0.65, y0 + 16); put(new THREE.BoxGeometry(14, 2, (hw + 14) * 1.3), red, arm[0], arm[1], arm[2], m.h + Math.PI / 2, true);
      const rail = loc(m, 0, (hw + 14) * 0.65, y0 + 17.6); put(new THREE.BoxGeometry(14.2, 1.2, (hw + 14) * 1.3), M(0xeeeeee), rail[0], rail[1], rail[2], m.h + Math.PI / 2);
    } else if (m.type === 'banking') {
      // the 1955 Sopraelevata: a steep (~38°) concrete banking on columns,
      // weathered and half-hidden in the park
      const conc = M(0x9e9a90, { roughness: 0.95 }), col = M(0x8a867c, { roughness: 0.95 });
      const R = 260, segs = 22, arc = 0.9, w = 14, rise = 9;
      // centre of the arc further into the infield, so the banking bows away
      // from the main straight and its high (outer) edge faces it
      const inx = -Math.cos(m.h) * m.side, inz = Math.sin(m.h) * m.side;
      const cx = m.x + inx * R, cz = m.z + inz * R;
      const a0 = Math.atan2(m.x - cx, m.z - cz);
      const v = [], ia = [];
      for (let i = 0; i <= segs; i++) {
        const a = a0 + (i / segs - 0.5) * arc;
        const ix = cx + Math.sin(a) * R, iz = cz + Math.cos(a) * R, ox = cx + Math.sin(a) * (R + w), oz = cz + Math.cos(a) * (R + w);
        v.push(ix, gy + 1.5, iz, ox, gy + 1.5 + rise, oz);
        if (i < segs) { const q = i * 2; ia.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
        if (i % 2 === 0) put(new THREE.BoxGeometry(0.9, rise, 0.9), col, ox, gy + rise / 2, oz);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3)); g.setIndex(ia); g.computeVertexNormals();
      const bank = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x77736a, roughness: 0.95, side: THREE.DoubleSide }));
      bank.userData.caster = true; grp.add(bank);
    } else if (m.type === 'hangar') {
      // WWII-era aircraft hangars along Hangar Straight
      const tin = M(0x7f8a86, { roughness: 0.55, metalness: 0.45 });
      const g = new THREE.CylinderGeometry(14, 14, 46, 18, 1, false, 0, Math.PI);
      const hgr = new THREE.Mesh(g, tin); hgr.rotation.z = Math.PI / 2; hgr.rotation.y = m.h;
      hgr.position.set(m.x, gy, m.z); hgr.userData.caster = true; grp.add(hgr);
    } else if (m.type === 'stand') {
      _scStand(grp, put, m, gy, M);
    }
  }

  // ---- Silverstone: the Wing's sweeping roof over the pit garages ----
  if (P.wing && typeof pitLaneGeom === 'function') {
    const g = pitLaneGeom(track), L = track.length;
    const roof = M(0xf1f3f5, { roughness: 0.35, metalness: 0.4 });
    const v = [], ia = []; let n = 0;
    for (let s = g.garageS0 - 20; s <= g.garageS1 + 20; s += 4) {
      const k = track.idxAtDist((g.entryStart + s) % L);
      const t = Math.min(1, Math.min(s - g.garageS0 + 20, g.garageS1 + 20 - s) / 30);   // tapered ends
      const a = track.posAt(k, -(g.garageOff - 3)), b = track.posAt(k, -(g.garageOff + 22));
      const y = track.py[k];
      // the wing profile: a raised leading edge over the pit lane, sloping back
      v.push(a.x, y + 13 + 5 * t, a.z, b.x, y + 15 + 2 * t, b.z);
      if (n > 0) { const q = (n - 1) * 2; ia.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      n++;
    }
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3)); gg.setIndex(ia); gg.computeVertexNormals();
    const wing = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ color: 0xf1f3f5, roughness: 0.35, metalness: 0.4, side: THREE.DoubleSide }));
    wing.userData.caster = true; grp.add(wing);
  }

  if (typeof _mergeStatic === 'function') _mergeStatic(parts, new Set());
  grp.add(parts);
}

// observation wheel: rim, spokes, gondolas, A-frame legs. The wheel's plane
// runs along the track, so you see its face as you drive past.
function _scWheel(grp, put, m, gy, R, cabins, rimCol, night) {
  const rimM = night ? new THREE.MeshBasicMaterial({ color: rimCol }) : new THREE.MeshStandardMaterial({ color: rimCol, roughness: 0.4, metalness: 0.5 });
  const legM = new THREE.MeshStandardMaterial({ color: 0xcfd6de, roughness: 0.5, metalness: 0.5 });
  const cy = gy + R + 6, yaw = m.h + Math.PI / 2;
  const dx = -Math.sin(m.h), dz = -Math.cos(m.h);          // local +x of the wheel plane (along the track)
  const nx = Math.cos(m.h), nz = -Math.sin(m.h);           // wheel axle direction (across)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.9, 6, 72), rimM);
  ring.position.set(m.x, cy, m.z); ring.rotation.y = yaw; grp.add(ring);
  for (let i = 0; i < 12; i++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.35, R * 2, 0.35), legM);
    sp.position.set(m.x, cy, m.z); sp.rotation.order = 'YXZ'; sp.rotation.y = yaw; sp.rotation.z = i / 12 * Math.PI; grp.add(sp);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 6, 12), legM);
  hub.position.set(m.x, cy, m.z); hub.rotation.order = 'YXZ'; hub.rotation.y = yaw; hub.rotation.x = Math.PI / 2; grp.add(hub);
  const pal = [0xe63946, 0xf4a261, 0x2a9d8f, 0x457b9d, 0xe9c46a];
  for (let i = 0; i < cabins; i++) {
    const a = i / cabins * Math.PI * 2, ux = Math.cos(a) * R, uy = Math.sin(a) * R;
    const mat = night ? new THREE.MeshBasicMaterial({ color: 0xcfeaff }) : new THREE.MeshStandardMaterial({ color: pal[i % pal.length], roughness: 0.5 });
    const c = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.6, 2.4), mat);
    c.position.set(m.x + dx * ux, cy + uy - 1.8, m.z + dz * ux); c.rotation.y = yaw; grp.add(c);
  }
  // two A-frames, one each side of the wheel
  for (const s of [-1, 1]) for (const lean of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.0, (R + 8) / Math.cos(0.42), 1.0), legM);
    leg.position.set(m.x + nx * s * 4 + dx * lean * (R + 6) * 0.22, gy + (R + 6) / 2, m.z + nz * s * 4 + dz * lean * (R + 6) * 0.22);
    leg.rotation.order = 'YXZ'; leg.rotation.y = yaw; leg.rotation.z = lean * 0.42; grp.add(leg);
  }
}

// covered grandstand: raked seating with crowd, back wall and roof, facing
// the track. Built in a local frame: +z toward the track, x along it.
function _scStand(grp, put, m, gy, M) {
  const len = m.len || 80;
  const frame = M(0xa0a7b4, { roughness: 0.5, metalness: 0.35 }), roofM = M(0xe9ecef, { roughness: 0.4, metalness: 0.3 });
  const crowd = new THREE.MeshStandardMaterial({ map: crowdTex(), roughness: 0.9 });
  crowd.map.wrapS = THREE.RepeatWrapping; crowd.map.repeat.set(len / 12, 1);
  const g = new THREE.Group();
  // toward the track = opposite of the side we're on
  const tx = (m.side > 0 ? 1 : -1) * Math.cos(m.h), tz = -(m.side > 0 ? 1 : -1) * Math.sin(m.h);
  g.position.set(m.x, gy, m.z); g.rotation.y = Math.atan2(tx, tz);
  const box = (w, h, d, mat, x, y, z, cast) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); o.position.set(x, y, z); if (cast) o.userData.caster = true; g.add(o); return o; };
  box(len, 2.5, 16, frame, 0, 1.25, 0);
  const seats = new THREE.Mesh(new THREE.PlaneGeometry(len, 16), crowd);
  seats.position.set(0, 8.5, -1); seats.rotation.x = -0.86; g.add(seats);
  box(len, 15, 1, frame, 0, 9, -7.5, true);
  box(len + 2, 0.6, 19, roofM, 0, 17.5, -1, true);
  for (const x of [-len * 0.45, 0, len * 0.45]) box(0.7, 16, 0.7, frame, x, 9.5, -7);
  grp.add(g);
}
