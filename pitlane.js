// ============================================================
// Pit complex: paved fast lane + working lane, pit wall with
// debris fence, pit entry / exit lines, speed-limit lines, one
// box per team (painted bay, crew, tyre stacks) in front of its
// garage, garages with team-coloured walls and name boards,
// speed-limit boards and the pit exit light.
// Geometry comes from pitLaneGeom() in trackbuilder.js — the same
// numbers the cars drive — so what you see is where cars go.
// ============================================================

function buildPitComplex(track, grp, theme, terrainY) {
  const g = pitLaneGeom(track), L = track.length, N = track.n, hw = track.width / 2;
  const H = (k, lat) => track.heightAt(k, lat);
  const night = !!theme.night;

  // ---- corridor sampling helpers ----
  const i0 = track.idxAtDist(g.entryStart), i1 = track.idxAtDist(g.exitEnd);
  const idxs = [];
  for (let k = i0; ; k = (k + 1) % N) { idxs.push(k); if (k === i1 || idxs.length > N) break; }
  const sOf = k => pitS(track, track.dist[k]);
  const magOf = k => { const o = pitLaneOffset(track, track.dist[k]); return o == null ? g.edgeOff : -o; };
  // 0 on the entry/exit roads, 1 along the straight with the garages
  const straightW = s => _ss(g.sEntryEnd - 6, g.sEntryEnd + 6, s) * (1 - _ss(g.sExitStart - 6, g.sExitStart + 6, s));
  // interpolated point at corridor position s, lateral magnitude lat (pit side)
  function pointAt(s, lat) {
    const d = ((g.entryStart + s) % L + L) % L;
    let k = track.idxAtDist(d);
    let kd = track.dist[k];
    let diff = ((d - kd) % L + L) % L; if (diff > L / 2) diff -= L;
    if (diff < 0) { k = (k - 1 + N) % N; kd = track.dist[k]; diff = ((d - kd) % L + L) % L; }
    const k2 = (k + 1) % N;
    let seg = ((track.dist[k2] - kd) % L + L) % L || 1;
    const t = Math.max(0, Math.min(1, diff / seg));
    const a = track.posAt(k, -lat), b = track.posAt(k2, -lat);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
             y: H(k, -lat) + (H(k2, -lat) - H(k, -lat)) * t, k };
  }
  // local frame at s: X = outward (away from the track), Y = up, Z = along
  function frameAt(s, lat) {
    const p = pointAt(s, lat), k = p.k;
    const c = track.posAt(k, 0), q = track.posAt(k, -1);
    let ox = q.x - c.x, oz = q.z - c.z; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    let fx = track.tx[k], fz = track.tz[k];
    if (-oz * fx + ox * fz < 0) { fx = -fx; fz = -fz; }      // keep the basis right-handed
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(ox, 0, oz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(fx, 0, fz));
    const quat = new THREE.Quaternion().setFromRotationMatrix(m);
    return { p, ox, oz, fx, fz, quat };
  }

  // ---- paved surfaces: fast lane + working lane/apron, with a skirt ----
  const laneMat = new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const workMat = new THREE.MeshStandardMaterial({ color: night ? 0x33363d : 0x3d4047, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const skirtM = new THREE.MeshStandardMaterial({ color: night ? 0x1b1d24 : 0x3f4048, roughness: 0.95, side: THREE.DoubleSide });
  function ribbon(innerFn, outerFn, mat, lift) {
    const v = [], uv = [], ia = [];
    idxs.forEach((k, i) => {
      const a = innerFn(k), b = outerFn(k);
      const pa = track.posAt(k, -a), pb = track.posAt(k, -b);
      v.push(pa.x, H(k, -a) + lift, pa.z, pb.x, H(k, -b) + lift, pb.z);
      uv.push(0, i * 0.1, 1, i * 0.1);
      if (i < idxs.length - 1) { const q = i * 2; ia.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    });
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
    gg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    gg.setIndex(ia); gg.computeVertexNormals();
    const m = new THREE.Mesh(gg, mat); m.userData.ground = true; grp.add(m);
  }
  const fastIn = k => {                       // never paint over the circuit itself
    const s = sOf(k), w = straightW(s);
    const raw = Math.max(hw + 0.02, magOf(k) - g.laneHalf);
    return raw + ((hw + 0.3) - raw) * w;      // along the straight: pave up to the track edge
  };
  const fastOut = k => magOf(k) + g.laneHalf;
  const outerEdge = k => { const s = sOf(k); const w = straightW(s); return fastOut(k) + (g.garageOff - fastOut(k)) * w; };
  ribbon(fastIn, fastOut, laneMat, 0.06);
  ribbon(fastOut, k => Math.max(fastOut(k) + 0.001, outerEdge(k)), workMat, 0.06);
  {                                           // skirt down to the ground on the outer edge
    const v = [], ia = [];
    idxs.forEach((k, i) => {
      const o = outerEdge(k), p = track.posAt(k, -o);
      v.push(p.x, H(k, -o) + 0.06, p.z, p.x, terrainY(p.x, p.z) - 1.5, p.z);
      if (i < idxs.length - 1) { const q = i * 2; ia.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    });
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
    gg.setIndex(ia); gg.computeVertexNormals();
    const m = new THREE.Mesh(gg, skirtM); m.userData.ground = true; grp.add(m);
  }

  // ---- painted markings (one vertex-coloured mesh) ----
  const mv = [], mc = [], mi = [];
  const col = new THREE.Color();
  function quad(p1, p2, p3, p4, hex) {          // corners in order around the quad
    col.setHex(hex);
    const b = mv.length / 3;
    [p1, p2, p3, p4].forEach(p => { mv.push(p.x, p.y + 0.085, p.z); mc.push(col.r, col.g, col.b); });
    mi.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // rectangle in (s, lat) space
  const rect = (s1, s2, l1, l2, hex) => quad(pointAt(s1, l1), pointAt(s2, l1), pointAt(s2, l2), pointAt(s1, l2), hex);
  // a line following latFn(s) from sA to sB
  function lineAlong(sA, sB, latFn, w, hex, dash) {
    const step = 1.5;
    for (let s = sA; s < sB - 0.01; s += step) {
      const s2 = Math.min(sB, s + step);
      if (dash && Math.floor(s / 3) % 2) continue;
      const a = latFn(s), b = latFn(s2);
      quad(pointAt(s, a - w / 2), pointAt(s2, b - w / 2), pointAt(s2, b + w / 2), pointAt(s, a + w / 2), hex);
    }
  }
  const magAtS = s => { const o = pitLaneOffset(track, (g.entryStart + s) % L); return o == null ? g.edgeOff : -o; };
  const WHITE = 0xf2f2f2, YEL = 0xffd12e;
  // pit entry line: splits from the track edge and runs to the pit wall —
  // cross it and you're in the pits
  lineAlong(0, g.sEntryEnd + 2, s => Math.max(hw + 0.12, magAtS(s) - g.laneHalf - 0.15), 0.3, WHITE);
  // pit exit line: from the end of the pit wall back to the track edge
  lineAlong(g.sExitStart - 2, g.total, s => Math.max(hw + 0.12, magAtS(s) - g.laneHalf - 0.15), 0.3, WHITE);
  // outer edge of the fast lane on the entry/exit roads
  lineAlong(0, g.sEntryEnd, s => magAtS(s) + g.laneHalf - 0.2, 0.2, WHITE);
  lineAlong(g.sExitStart, g.total, s => magAtS(s) + g.laneHalf - 0.2, 0.2, WHITE);
  // fast lane / working lane divider (dashed)
  lineAlong(g.sEntryEnd + 2, g.sExitStart - 2, () => g.laneOff + g.laneHalf, 0.18, WHITE, true);
  // speed-limit lines across the lane (limiter on / off)
  const limIn = g.sEntryEnd - 6, limOut = g.sExitStart + 6;
  [limIn, limOut].forEach(s => {
    const m = magAtS(s);
    rect(s - 0.25, s + 0.25, Math.max(hw + 0.1, m - g.laneHalf), m + g.laneHalf, WHITE);
  });
  // team boxes: bay outline in team colour, white stop T, yellow lane edge
  const bayL = 6.2, bayW = 3.6;
  PIT_TEAM_ORDER.forEach(tm => {
    const s = g.boxS[tm]; if (s == null) return;
    const tc = TEAMS[tm] ? TEAMS[tm].color : 0xffffff;
    const lo = g.workOff - bayW / 2, hi = g.workOff + bayW / 2, a = s - bayL / 2, b = s + bayL / 2;
    rect(a, b, lo, lo + 0.22, tc); rect(a, b, hi - 0.22, hi, tc);
    rect(a, a + 0.22, lo, hi, tc); rect(b - 0.22, b, lo, hi, tc);
    rect(s + 2.2, s + 2.5, g.workOff - 0.9, g.workOff + 0.9, WHITE);      // front-wing stop bar
    rect(s - 0.15, s + 2.5, g.workOff - 0.12, g.workOff + 0.12, WHITE);   // centre line
  });
  rect(g.sEntryEnd + 2, g.sExitStart - 2, g.garageOff - 0.35, g.garageOff - 0.15, YEL); // garage line
  {
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mv), 3));
    gg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(mc), 3));
    gg.setIndex(mi); gg.computeVertexNormals();
    const m = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    m.userData.ground = true; grp.add(m);
  }

  // ---- static solids, merged by material at the end ----
  const parts = new THREE.Group();
  const v3 = new THREE.Vector3();
  function put(geo, mat, fr, lx, ly, lz, caster) {
    const m = new THREE.Mesh(geo, mat);
    // local (lx outward, ly up, lz along) → world
    m.position.set(fr.p.x + fr.ox * lx + fr.fx * lz, fr.p.y + ly, fr.p.z + fr.oz * lx + fr.fz * lz);
    m.quaternion.copy(fr.quat);
    if (caster) m.userData.caster = true;
    parts.add(m); return m;
  }

  // pit wall: concrete with a debris fence on top, along the straight
  const concrete = new THREE.MeshStandardMaterial({ color: night ? 0x3a3f50 : 0xc4c8d0, roughness: 0.7, metalness: 0.05 });
  const fenceTex = canvasTex(64, 64, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h); ctx.strokeStyle = 'rgba(150,158,175,0.55)'; ctx.lineWidth = 2;
    for (let x = 0; x <= w; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 16) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  });
  fenceTex.wrapS = fenceTex.wrapT = THREE.RepeatWrapping;
  {
    const wv = [], wi = [], fv = [], fu = [], fi = [];
    let n = 0;
    const sA = g.sEntryEnd - 8, sB = g.sExitStart + 8;
    for (let s = sA; s <= sB + 0.01; s += 2) {
      const pIn = pointAt(s, g.wallOff - 0.2), pOut = pointAt(s, g.wallOff + 0.2);
      const y = Math.max(pIn.y, pOut.y);
      // track-side face, top, lane-side face (6 verts per station)
      wv.push(pIn.x, y - 0.6, pIn.z, pIn.x, y + 1.05, pIn.z, pOut.x, y + 1.05, pOut.z, pOut.x, y - 0.6, pOut.z);
      fv.push(pIn.x * 0.5 + pOut.x * 0.5, y + 1.05, pIn.z * 0.5 + pOut.z * 0.5,
              pIn.x * 0.5 + pOut.x * 0.5, y + 3.9, pIn.z * 0.5 + pOut.z * 0.5);
      fu.push(s / 4, 0, s / 4, 0.75);
      if (n > 0) {
        const a = (n - 1) * 4, b = n * 4;
        wi.push(a, b, a + 1, b, b + 1, a + 1,  a + 1, b + 1, a + 2, b + 1, b + 2, a + 2,  a + 2, b + 2, a + 3, b + 2, b + 3, a + 3);
        const c = (n - 1) * 2, d = n * 2;
        fi.push(c, d, c + 1, d, d + 1, c + 1);
      }
      n++;
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wv), 3));
    wg.setIndex(wi); wg.computeVertexNormals();
    const wall = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ color: concrete.color, roughness: 0.7, side: THREE.DoubleSide }));
    wall.userData.caster = true; grp.add(wall);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fv), 3));
    fg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(fu), 2));
    fg.setIndex(fi);
    grp.add(new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ map: fenceTex, transparent: true, side: THREE.DoubleSide, depthWrite: false })));
  }

  // garages, one per team, with crew and tyres at its box
  const bldg = new THREE.MeshStandardMaterial({ color: night ? 0x2c3348 : 0xd3d6dc, roughness: 0.6, metalness: 0.1 });
  const floorM = new THREE.MeshStandardMaterial({ color: 0xb9bcc3, roughness: 0.35, metalness: 0.05 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1d2a44, roughness: 0.15, metalness: 0.6,
    emissive: night ? 0x22324f : 0x000000 });
  const lightM = new THREE.MeshBasicMaterial({ color: 0xfafcff });
  const tyreM = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85 });
  const helmetM = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.4, metalness: 0.1 });
  const D = 16, Hg = 7.2, W = g.boxSpacing;
  const gFloor = new THREE.BoxGeometry(D, 1.3, W), gBack = new THREE.BoxGeometry(0.3, Hg, W);
  const gDiv = new THREE.BoxGeometry(D, Hg + 0.4, 0.35), gRoof = new THREE.BoxGeometry(D + 2.5, 0.7, W + 0.02);
  const gUpper = new THREE.BoxGeometry(D, 5.2, W + 0.02), gBand = new THREE.BoxGeometry(0.2, 2.4, W * 0.96);
  const gLight = new THREE.BoxGeometry(D * 0.6, 0.08, 0.45);
  const gTyre = new THREE.CylinderGeometry(0.36, 0.36, 0.37, 14);
  const gBody = new THREE.BoxGeometry(0.42, 1.15, 0.34), gHead = new THREE.SphereGeometry(0.17, 10, 8);
  const gSign = new THREE.PlaneGeometry(W * 0.86, 1.25);
  PIT_TEAM_ORDER.forEach(tm => {
    const s = g.boxS[tm]; if (s == null) return;
    const team = TEAMS[tm] || { name: tm, color: 0x888888, accent: 0xffffff };
    const fr = frameAt(s, g.garageOff);
    const teamM = new THREE.MeshStandardMaterial({ color: team.color, roughness: 0.55, metalness: 0.15 });
    put(gFloor, floorM, fr, D / 2, -0.55, 0);
    put(gBack, teamM, fr, D - 0.15, Hg / 2, 0);
    put(gDiv, bldg, fr, D / 2, Hg / 2, W / 2 - 0.17, true);
    put(gDiv, bldg, fr, D / 2, Hg / 2, -W / 2 + 0.17, true);
    put(gRoof, bldg, fr, D / 2 - 1.25, Hg + 0.35, 0, true);
    put(gUpper, bldg, fr, D / 2, Hg + 3.3, 0, true);
    put(gBand, glass, fr, -0.02, Hg + 3.4, 0);
    put(gLight, lightM, fr, D / 2, Hg - 0.1, W * 0.22);
    put(gLight, lightM, fr, D / 2, Hg - 0.1, -W * 0.22);
    // team name board over the garage door, facing the lane
    const hex = '#' + team.color.toString(16).padStart(6, '0'), acc = '#' + team.accent.toString(16).padStart(6, '0');
    const sign = new THREE.Mesh(gSign, new THREE.MeshBasicMaterial({ map: boardTex(team.name.toUpperCase(), hex, acc) }));
    const sfr = frameAt(s, g.garageOff);
    sign.position.set(sfr.p.x - sfr.ox * 1.3, sfr.p.y + Hg - 0.75, sfr.p.z - sfr.oz * 1.3);
    sign.quaternion.copy(sfr.quat).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
    grp.add(sign);
    // tyre stacks just inside the garage
    [-1, 1].forEach(side => {
      for (let j = 0; j < 4; j++) put(gTyre, tyreM, fr, 1.6, 0.2 + j * 0.38, side * (W / 2 - 1.3));
    });
    // pit crew waiting at the box: four wheel crews and front/rear jack men
    const bx = g.workOff - g.garageOff;            // box centre, local x (negative = toward the track)
    const crewM = new THREE.MeshStandardMaterial({ color: team.color, roughness: 0.7 });
    [[bx - 1.75, 1.6], [bx + 1.75, 1.6], [bx - 1.75, -1.6], [bx + 1.75, -1.6], [bx, 3.9], [bx, -3.9]].forEach(([lx, lz]) => {
      const f2 = frameAt(s + lz, g.garageOff);       // follow the lane if it curves
      put(gBody, crewM, f2, lx, 0.62, 0);
      put(gHead, helmetM, f2, lx, 1.36, 0);
    });
  });
  // speed-limit boards and the pit exit light
  {
    const boardM = new THREE.MeshBasicMaterial({ map: boardTex('PIT LANE  80', '#ffffff', '#c00000') });
    const gB = new THREE.PlaneGeometry(4.2, 0.6), gPole = new THREE.CylinderGeometry(0.07, 0.07, 3, 8);
    const poleM = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.5, metalness: 0.6 });
    [limIn, limOut].forEach(s => {
      const lat = magAtS(s) + g.laneHalf + 1.0, fr = frameAt(s, lat);
      put(gPole, poleM, fr, 0, 1.5, -1.8); put(gPole, poleM, fr, 0, 1.5, 1.8);
      const b = new THREE.Mesh(gB, boardM);
      b.position.set(fr.p.x, fr.p.y + 2.7, fr.p.z);
      b.quaternion.copy(fr.quat).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2));
      b.material.side = THREE.DoubleSide;
      grp.add(b);
    });
    // pit exit light: green = clear to rejoin
    const s = Math.min(g.total - 6, g.sExitStart + 14), lat = magAtS(s) + g.laneHalf + 0.9, fr = frameAt(s, lat);
    put(new THREE.CylinderGeometry(0.1, 0.1, 3.2, 8), poleM, fr, 0, 1.6, 0);
    put(new THREE.BoxGeometry(0.5, 0.9, 0.5), new THREE.MeshStandardMaterial({ color: 0x111111 }), fr, 0, 3.5, 0);
    put(new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshBasicMaterial({ color: 0x2bff6a }), fr, -0.26, 3.5, 0);
  }
  if (typeof _mergeStatic === 'function') _mergeStatic(parts, new Set());
  grp.add(parts);
}

// Which side-barrier offset to use on the pit side at sample k (signed,
// negative = pit side), or null where the garages themselves are the wall.
function pitSideBarrierOff(track, k, boff) {
  const g = pitLaneGeom(track), s = pitS(track, track.dist[k]);
  if (s > g.total) return -boff;
  if (s >= g.sEntryEnd && s <= g.sExitStart) {
    if (s >= g.garageS0 - 0.5 && s <= g.garageS1 + 0.5) return null;
    return -(g.garageOff + 0.6);
  }
  const o = pitLaneOffset(track, track.dist[k]);
  const out = (o == null ? g.edgeOff : -o) + g.laneHalf + 0.9;
  return -Math.max(boff, out);
}

// true where scenery on the pit side would land in the pit complex
function inPitComplex(track, k, lat) {
  if (lat > 0) return false;
  const g = pitLaneGeom(track), s = pitS(track, track.dist[k]), L = track.length;
  return (s <= g.total + 40 || s >= L - 40) && -lat < g.garageOff + 40;
}
