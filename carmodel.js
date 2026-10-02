// ============================================================
// Detailed low-poly F1 car (2026-style). Returns THREE.Group
// with .userData.wheels {fl,fr,rl,rr}. Car faces +Z.
// Built to 2025 proportions: 2000 mm wide on a 3400 mm wheelbase. The 2026
// rules actually narrow the car to 1900 mm, but the wider body is a deliberate
// choice — it makes the car harder to place on a street circuit, which is the
// point of driving one.
//
// Contract relied on by main.js and the test harnesses — do not change:
//   userData.wheels {fl,fr,rl,rr}   each wheel group's children[0] and [1]
//                                   are the spinning parts (tyre, rim group)
//   userData.drsFlap                mesh rotated open when DRS is active
//   userData.brakeLight             material tinted under braking
//   userData.blobShadow             fallback shadow, hidden when maps are on
//   userData.team                   team key
// ============================================================

// local canvas-texture helper (carmodel.js loads before trackbuilder.js)
function _carTex(w, h, draw) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
  return t;
}
const _hex = c => '#' + (c >>> 0).toString(16).padStart(6, '0');

// Canvas textures are expensive to build and expensive to keep on the GPU.
// Every car used to generate its own set, so a 22-car grid burned 132 of them
// even though there are only 11 liveries. They're cached per team here and
// flagged shared, so teardown leaves them alone and the next session reuses
// them instead of uploading a fresh copy.
const _texCache = new Map();
function _shared(key, make) {
  if (!_texCache.has(key)) {
    const t = make();
    t.__shared = true;      // disposeGroup skips these
    _texCache.set(key, t);
  }
  return _texCache.get(key);
}

// Sponsor wordmarks per team. Generic where a real one isn't obvious — this
// is a personal project, so these are hand-lettered approximations rather
// than reproductions of any brand's actual artwork.
const CAR_SPONSORS = {
  redbull:     ['ORACLE', 'TAG HEUER'],
  ferrari:     ['SANTANDER', 'SHELL'],
  mercedes:    ['PETRONAS', 'INEOS'],
  mclaren:     ['GOOGLE', 'OKX'],
  aston:       ['ARAMCO', 'COGNIZANT'],
  alpine:      ['BWT', 'CASTROL'],
  williams:    ['DURACELL', 'GULF'],
  audi:        ['REVOLUT', 'ADIDAS'],
  racingbulls: ['VISA', 'HUGO'],
  haas:        ['MONEYGRAM', 'CHARTER'],
  cadillac:    ['TOMMY', 'ARROW'],
};

// A charging-bull-and-disc motif, drawn as an original silhouette rather than
// traced from anyone's logo. Red Bull gets it; other teams get their initial.
function _drawBullMotif(ctx, cx, cy, s, accent) {
  ctx.save();
  ctx.translate(cx, cy);
  // sun disc behind
  ctx.fillStyle = '#f2c218';
  ctx.beginPath(); ctx.arc(0, 0, s * 0.52, 0, 7); ctx.fill();
  // two bulls charging at each other, reduced to blocky silhouettes
  ctx.fillStyle = accent;
  [-1, 1].forEach(dir => {
    ctx.save();
    ctx.scale(dir, 1);
    ctx.beginPath();
    ctx.moveTo(-s * 0.92, s * 0.10);      // hindquarters
    ctx.lineTo(-s * 0.60, -s * 0.22);     // back
    ctx.lineTo(-s * 0.18, -s * 0.30);     // shoulder
    ctx.lineTo(-s * 0.02, -s * 0.52);     // head up
    ctx.lineTo(s * 0.16, -s * 0.40);      // horn
    ctx.lineTo(s * 0.04, -s * 0.20);      // muzzle
    ctx.lineTo(-s * 0.06, -s * 0.02);     // chest
    ctx.lineTo(-s * 0.30, s * 0.30);      // foreleg
    ctx.lineTo(-s * 0.52, s * 0.12);
    ctx.lineTo(-s * 0.70, s * 0.34);      // hind leg
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  });
  ctx.restore();
}

// Main bodywork livery: base colour, swept accent flash, sponsor wordmark.
// BoxGeometry gives every face the full 0..1 UV square, so the composition is
// built to read on any panel it lands on.
function liveryTex(teamKey, kind) {
  const team = TEAMS[teamKey];
  const base = _hex(team.color), acc = _hex(team.accent);
  const sponsors = CAR_SPONSORS[teamKey] || ['F1', '2026'];
  return _carTex(256, 128, (ctx, w, h) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
    // subtle top-lit sheen so flat panels don't look like cardboard
    const sheen = ctx.createLinearGradient(0, 0, 0, h);
    sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
    sheen.addColorStop(0.45, 'rgba(255,255,255,0.02)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.20)');
    ctx.fillStyle = sheen; ctx.fillRect(0, 0, w, h);

    if (kind === 'pod') {
      // sidepod: big graphic panel
      _drawBullMotif(ctx, w * 0.34, h * 0.5, h * 0.42, acc);
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 26px Arial';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(sponsors[0], w * 0.56, h * 0.44);
      ctx.fillStyle = '#f2c218';
      ctx.font = '900 15px Arial';
      ctx.fillText(sponsors[1] || '', w * 0.56, h * 0.68);
    } else if (kind === 'cover') {
      // engine cover: diagonal accent flash running back off the airbox
      ctx.fillStyle = acc;
      ctx.beginPath();
      ctx.moveTo(0, h * 0.20); ctx.lineTo(w * 0.62, h * 0.02);
      ctx.lineTo(w * 0.86, h * 0.30); ctx.lineTo(0, h * 0.52);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f2c218';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.54); ctx.lineTo(w * 0.86, h * 0.32);
      ctx.lineTo(w * 0.90, h * 0.42); ctx.lineTo(0, h * 0.64);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 22px Arial';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sponsors[0], w * 0.5, h * 0.82);
    } else {
      // tub / general panels: thin accent chevron + small marks
      ctx.fillStyle = acc;
      ctx.beginPath();
      ctx.moveTo(w * 0.10, h); ctx.lineTo(w * 0.42, h * 0.30);
      ctx.lineTo(w * 0.56, h * 0.30); ctx.lineTo(w * 0.24, h);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '900 14px Arial';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sponsors[1] || sponsors[0], w * 0.72, h * 0.5);
    }
  });
}

// Wheel cover face. Modern F1 runs solid aero covers over the rim, so a
// drawn disc is closer to the real car than modelled spokes would be —
// and it costs one mesh per wheel instead of a dozen.
function wheelCoverTex(teamKey) {
  const team = TEAMS[teamKey];
  return _carTex(128, 128, (ctx, w, h) => {
    const c = w / 2;
    ctx.fillStyle = _hex(team.color);
    ctx.beginPath(); ctx.arc(c, c, c, 0, 7); ctx.fill();
    // recessed vent slots
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 5;
    for (let i = 0; i < 7; i++) {
      const a = i / 7 * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c, c, c * 0.62, a, a + 0.55);
      ctx.stroke();
    }
    // accent ring and centre nut
    ctx.strokeStyle = _hex(team.accent); ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(c, c, c * 0.84, 0, 7); ctx.stroke();
    ctx.fillStyle = '#2a2a30';
    ctx.beginPath(); ctx.arc(c, c, c * 0.20, 0, 7); ctx.fill();
    ctx.fillStyle = '#c8c8d0';
    ctx.beginPath(); ctx.arc(c, c, c * 0.11, 0, 7); ctx.fill();
  });
}

// Tyre: circumferential tread grooves plus rubber grain. Cylinder side UVs
// run u around the circumference and v across the tread, so horizontal bands
// here become grooves running around the tyre.
function tyreTex() {
  return _carTex(64, 128, (ctx, w, h) => {
    ctx.fillStyle = '#17171a'; ctx.fillRect(0, 0, w, h);
    [0.28, 0.5, 0.72].forEach(v => {
      ctx.fillStyle = '#0a0a0c';
      ctx.fillRect(0, h * v - 3, w, 6);
    });
    for (let i = 0; i < 900; i++) {
      const g = 20 + Math.random() * 26;
      ctx.fillStyle = 'rgba(' + (g | 0) + ',' + (g | 0) + ',' + ((g + 3) | 0) + ',0.6)';
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    // shoulder shading at both edges
    const sh = ctx.createLinearGradient(0, 0, 0, h);
    sh.addColorStop(0, 'rgba(0,0,0,0.55)');
    sh.addColorStop(0.16, 'rgba(0,0,0,0)');
    sh.addColorStop(0.84, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = sh; ctx.fillRect(0, 0, w, h);
  });
}

// Steering wheel face: rev-light strip, small display, and the button/rotary
// cluster painted on rather than modelled, which keeps the part count down.
function wheelFaceTex(teamKey) {
  const team = TEAMS[teamKey];
  return _carTex(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#131317'; ctx.fillRect(0, 0, w, h);
    // carbon weave suggestion
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = 'rgba(255,255,255,' + (0.02 + Math.random() * 0.05) + ')';
      ctx.fillRect(Math.random() * w, Math.random() * h, 3, 1);
    }
    // rev-light strip across the top
    const cols = ['#2ecc71','#2ecc71','#2ecc71','#2ecc71','#ffd12e','#ffd12e','#ffd12e','#e10600','#e10600','#8a2be2'];
    cols.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(14 + i * 23, 10, 16, 10);
    });
    // display panel
    ctx.fillStyle = '#04140a'; ctx.fillRect(66, 32, 124, 46);
    ctx.strokeStyle = '#3a4250'; ctx.lineWidth = 2; ctx.strokeRect(66, 32, 124, 46);
    ctx.fillStyle = '#7dffb0';
    ctx.font = '900 30px Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('6', 78, 56);
    ctx.font = '900 15px Arial';
    ctx.fillText('1:18.4', 108, 50);
    ctx.fillStyle = '#ffd12e';
    ctx.font = '900 12px Arial';
    ctx.fillText('SOC 84%', 108, 68);
    // button cluster
    const btn = (x, y, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2; ctx.stroke(); };
    btn(30, 46, '#e10600'); btn(30, 74, '#2b7fe0');
    btn(226, 46, '#ffd12e'); btn(226, 74, '#2ecc71');
    btn(96, 100, '#c8ccd4'); btn(160, 100, '#c8ccd4');
    // team accent bar along the bottom
    ctx.fillStyle = _hex(team.accent);
    ctx.fillRect(0, h - 8, w, 8);
  });
}

// Driver's steering wheel + gloves, built only for the player's car (see the
// cockpit flag) since nobody ever sees anyone else's. Returns the mount group
// with .userData.spin — the child that rotates with steering input.
function buildCockpitRig(teamKey) {
  const mount = new THREE.Group();
  // sits in front of and below the driver's eye line; the mount is tilted so
  // the top of the wheel leans back toward the driver like the real thing
  mount.position.set(0, 0.72, 0.44);
  mount.rotation.x = -0.45;

  const spin = new THREE.Group();
  mount.add(spin);
  mount.userData.spin = spin;

  const mGrip = new THREE.MeshStandardMaterial({ color: 0x17171b, metalness: 0.25, roughness: 0.62 });
  const mFace = new THREE.MeshStandardMaterial({ map: _shared(teamKey+':face', () => wheelFaceTex(teamKey)), metalness: 0.3, roughness: 0.45 });
  const mMetal= new THREE.MeshStandardMaterial({ color: 0x8d919c, metalness: 0.85, roughness: 0.3 });
  const mGlove= new THREE.MeshStandardMaterial({ color: 0x1b1b22, metalness: 0.1, roughness: 0.78 });
  const mSuit = new THREE.MeshStandardMaterial({ color: TEAMS[teamKey].color, metalness: 0.1, roughness: 0.72 });

  const part = (w,h,d,mat,x,y,z,rz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
    m.position.set(x,y,z);
    if (rz) m.rotation.z = rz;
    spin.add(m);
    return m;
  };

  // butterfly rim: flat top bar, two vertical grips, open at the bottom
  part(0.34, 0.048, 0.040, mGrip, 0, 0.104, 0);
  part(0.066, 0.180, 0.055, mGrip, -0.163, -0.012, 0, 0.10);
  part(0.066, 0.180, 0.055, mGrip,  0.163, -0.012, 0, -0.10);
  // hub carrying the display/button face (texture faces the driver, -z)
  part(0.245, 0.150, 0.030, mFace, 0, 0.010, -0.018);
  part(0.250, 0.160, 0.026, mGrip, 0, 0.010, 0.004);
  // rotary dials
  [[-0.082,-0.058],[0.082,-0.058]].forEach(([x,y]) => {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.022, 10), mMetal);
    d.rotation.x = Math.PI/2;
    d.position.set(x, y, -0.026);
    spin.add(d);
  });
  // shift paddles behind the wheel
  part(0.055, 0.085, 0.010, mMetal, -0.118, -0.010, 0.046, 0.22);
  part(0.055, 0.085, 0.010, mMetal,  0.118, -0.010, 0.046, -0.22);

  // gloves gripping the rim, with forearms running back out of frame
  [[-1],[1]].forEach(([s]) => {
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.115, 0.078), mGlove);
    hand.position.set(s*0.170, -0.012, -0.030);
    hand.rotation.z = s * -0.10;
    spin.add(hand);
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.052, 0.030), mGlove);
    thumb.position.set(s*0.140, 0.050, -0.040);
    spin.add(thumb);
    // forearm hangs off the mount, not the spinning part — it shouldn't
    // cartwheel with the wheel
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.052, 0.30, 8), mSuit);
    arm.rotation.x = Math.PI/2 - 0.35;
    arm.rotation.z = s * 0.18;
    arm.position.set(s*0.172, -0.075, 0.14);
    mount.add(arm);
  });

  mount.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return mount;
}

// ---------- shaped-geometry helpers (replace the old all-box bodywork) ----------
// Side profile [[z,y],...] extruded across the car's width, edges rounded by a
// bevel. Centred on x=0; returns the geometry.
function _sideProfileGeo(pts, width, bevel) {
  const sh = new THREE.Shape();
  pts.forEach((p, i) => i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]));
  const b = bevel || 0, depth = Math.max(0.002, width - 2 * b);
  const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: b > 0, bevelThickness: b,
    bevelSize: b * 0.85, bevelSegments: 3, curveSegments: 6 });
  geo.rotateY(-Math.PI / 2);          // shape x → car z, extrusion → car −x
  geo.translate(depth / 2, 0, 0);     // centre across the width
  return geo;
}
// Plan-view outline [[x,z],...] extruded downward by `thick` (floors, plates).
function _planGeo(pts, thick) {
  const sh = new THREE.Shape();
  pts.forEach((p, i) => i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]));
  const geo = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);           // shape y → car z, extrusion → car −y
  return geo;
}
// Cambered airfoil (NACA-style thickness) spanning the car's width. Leading
// edge toward +z, centred on the mid-chord so it pivots naturally. Negative
// camber = inverted wing (downforce), which is how every F1 wing is shaped.
function _airfoilGeo(span, chord, thick, camber) {
  const n = 14, up = [], lo = [];
  for (let i = 0; i <= n; i++) {
    const t = (1 - Math.cos(Math.PI * i / n)) / 2;          // cosine spacing
    const yt = 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4);
    const yc = camber * 4 * t * (1 - t);
    const a = (0.5 - t) * chord;
    up.push([a, (yc + yt) * chord]); lo.push([a, (yc - yt) * chord]);
  }
  const pts = up.concat(lo.reverse().slice(1, -1));
  const sh = new THREE.Shape();
  pts.forEach((p, i) => i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]));
  const geo = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: false });
  geo.rotateY(-Math.PI / 2);
  geo.translate(span / 2, 0, 0);
  return geo;
}
// Thin round tube between two points (wishbones, pushrods, stalks).
function _tubeGeo(a, b, r) {
  const A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
  const len = A.distanceTo(B);
  const geo = new THREE.CylinderGeometry(r, r, len, 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  geo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));   // r128 has no geometry.applyQuaternion
  const m = A.clone().add(B).multiplyScalar(0.5);
  geo.translate(m.x, m.y, m.z);
  return geo;
}
// Remap a geometry's UVs to 0..1 across its extent so a livery texture laid
// out for one panel covers a shaped panel once, instead of tiling per metre.
function _normUV(geo) {
  const uv = geo.attributes.uv; if (!uv) return geo;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (let i = 0; i < uv.count; i++) { const u = uv.getX(i), v = uv.getY(i);
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
  const du = (u1 - u0) || 1, dv = (v1 - v0) || 1;
  // Side panels are flat caps whose u runs along car +z. Seen from the car's
  // left (+x) that runs right-to-left, so sponsor text read mirrored on that
  // side. Flip u on +x-facing faces so both sides read correctly.
  const nrm = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    let u = (uv.getX(i) - u0) / du;
    if (nrm && nrm.getX(i) > 0.5) u = 1 - u;
    uv.setXY(i, u, (uv.getY(i) - v0) / dv);
  }
  uv.needsUpdate = true;
  return geo;
}
// Merge the static parts of a car by material (and shadow role) into one mesh
// each. A detailed car is ~120 parts; 22 of them unmerged would be ~2,600
// draw calls. Merged it's ~25 per car — fewer than the old box model.
function _mergeStatic(g, keep) {
  const buckets = new Map(), victims = [];
  g.children.forEach(o => {
    if (!o.isMesh || keep.has(o) || Array.isArray(o.material)) return;
    const key = o.material.uuid + (o.userData.caster ? ':c' : ':n');
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, caster: !!o.userData.caster, parts: [] });
    buckets.get(key).parts.push(o);
  });
  buckets.forEach(bk => {
    if (bk.parts.length < 2) return;
    let total = 0; const geos = bk.parts.map(o => {
      o.updateMatrix();
      const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      src.applyMatrix4(o.matrix); total += src.attributes.position.count; return src;
    });
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uvs = new Float32Array(total * 2);
    let off = 0;
    geos.forEach(ge => {
      const c = ge.attributes.position.count;
      pos.set(ge.attributes.position.array, off * 3);
      if (ge.attributes.normal) nor.set(ge.attributes.normal.array, off * 3);
      if (ge.attributes.uv) uvs.set(ge.attributes.uv.array, off * 2);
      off += c; ge.dispose();
    });
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    mg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    mg.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    mg.computeBoundingSphere();
    const mm = new THREE.Mesh(mg, bk.mat);
    mm.userData.caster = bk.caster;
    bk.parts.forEach(o => { victims.push(o); });
    g.add(mm);
  });
  victims.forEach(o => { g.remove(o); o.geometry.dispose(); });
}

function buildF1Car(teamKey, opts) {
  opts = opts || {};
  const team = TEAMS[teamKey];
  const g = new THREE.Group();

  // PBR paint + carbon: picks up sky reflections via scene.environment (IBL)
  const liveryMain  = _shared(teamKey+':main',  () => liveryTex(teamKey, 'main'));
  const liveryPod   = _shared(teamKey+':pod',   () => liveryTex(teamKey, 'pod'));
  const liveryCover = _shared(teamKey+':cover', () => liveryTex(teamKey, 'cover'));
  const mBody = new THREE.MeshStandardMaterial({ color: team.color, metalness: 0.38, roughness: 0.32 });
  const mLivery = new THREE.MeshStandardMaterial({ map: liveryMain, metalness: 0.32, roughness: 0.34 });
  const mPod  = new THREE.MeshStandardMaterial({ map: liveryPod, metalness: 0.32, roughness: 0.34 });
  const mCover= new THREE.MeshStandardMaterial({ map: liveryCover, metalness: 0.32, roughness: 0.34 });
  const mAcc  = new THREE.MeshStandardMaterial({ color: team.accent, metalness: 0.30, roughness: 0.36 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x131318, metalness: 0.2, roughness: 0.7 });
  const mCarb = new THREE.MeshStandardMaterial({ color: 0x1d1d24, metalness: 0.5, roughness: 0.38 });
  const mTyre = new THREE.MeshStandardMaterial({ map: _shared('tyre', tyreTex), color: 0xffffff, metalness: 0.0, roughness: 0.92 });
  const mRim  = new THREE.MeshStandardMaterial({ color: 0x9a9aa4, metalness: 0.9, roughness: 0.25 });
  const mCover2 = new THREE.MeshStandardMaterial({ map: _shared(teamKey+':wheel', () => wheelCoverTex(teamKey)), metalness: 0.65, roughness: 0.35, side: THREE.DoubleSide });
  const mDisc = new THREE.MeshStandardMaterial({ color: 0x2b2b2f, metalness: 0.35, roughness: 0.65 });
  const mHelm = new THREE.MeshStandardMaterial({ color: opts.helmet || 0xffffff, metalness: 0.3, roughness: 0.25 });
  [mBody, mLivery, mPod, mCover, mAcc, mCarb, mRim, mCover2, mHelm].forEach(m => { m.envMapIntensity = 0.85; });

  function box(w,h,d,mat,x,y,z,rx,ry,rz) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
    m.position.set(x,y,z);
    if (rx) m.rotation.x = rx;
    if (ry) m.rotation.y = ry;
    if (rz) m.rotation.z = rz;
    g.add(m);
    return m;
  }

  // shaped part helper: add a prebuilt geometry at a position
  function part(geo, mat, x, y, z, rx, ry, rz) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    if (rx) m.rotation.x = rx; if (ry) m.rotation.y = ry; if (rz) m.rotation.z = rz;
    g.add(m);
    return m;
  }
  const tube = (a, b, r, mat) => part(_tubeGeo(a, b, r || 0.018), mat || mCarb);

  // ---------- survival cell: nose → tub → engine cover ----------
  // Rounded extruded side profiles instead of stacked boxes. The nose is a
  // flat, tapering 2026-style nose; the tub carries the livery; the engine
  // cover rises into the airbox and sweeps down to the gearbox.
  part(_sideProfileGeo([[3.02,0.30],[3.04,0.37],[2.70,0.44],[2.20,0.50],[1.60,0.58],[1.30,0.60],
                        [1.30,0.24],[1.80,0.25],[2.40,0.27],[2.85,0.28]], 0.30, 0.06), mBody).userData.caster = true;
  part(_sideProfileGeo([[3.06,0.31],[3.08,0.36],[2.92,0.39],[2.86,0.29]], 0.26, 0.03), mAcc);   // nose tip
  part(_normUV(_sideProfileGeo([[1.45,0.22],[1.45,0.60],[1.10,0.64],[0.70,0.65],[0.20,0.64],
                                [-0.40,0.62],[-0.40,0.20],[0.30,0.18],[1.00,0.19]], 0.74, 0.09)), mLivery).userData.caster = true;
  // cockpit rim
  part(_sideProfileGeo([[0.78,0.62],[0.78,0.70],[0.10,0.72],[-0.18,0.74],[-0.18,0.62]], 0.60, 0.04), mCarb);
  part(_normUV(_sideProfileGeo([[0.02,0.58],[0.02,1.10],[-0.18,1.17],[-0.45,1.14],[-0.85,1.02],
                                [-1.30,0.86],[-1.70,0.70],[-1.98,0.58],[-2.04,0.46],[-2.04,0.30],
                                [-1.00,0.30],[-0.30,0.40]], 0.40, 0.10)), mCover).userData.caster = true;
  // airbox intake mouth + roll-hoop T-cam and antenna
  part(_sideProfileGeo([[0.05,0.96],[0.07,1.10],[0.00,1.12],[-0.02,0.97]], 0.20, 0.03), mDark);
  box(0.10, 0.05, 0.14, mDark, 0, 1.20, -0.20);                                 // T-cam pod
  box(0.10, 0.012, 0.14, mAcc, 0, 1.228, -0.20);
  tube([0, 1.10, -0.55], [0, 1.30, -0.62], 0.006, mDark);                        // antenna
  // shark fin (thin, trailing into the rear wing)
  part(_sideProfileGeo([[-0.45,1.10],[-0.62,1.22],[-1.60,1.13],[-1.78,0.92],[-1.60,0.80],[-0.90,0.98]], 0.03, 0), mBody);
  part(_sideProfileGeo([[-0.62,1.22],[-1.60,1.13],[-1.62,1.08],[-0.66,1.17]], 0.034, 0), mAcc);

  // ---------- front wing: airfoil elements + shaped endplates ----------
  // Built as one group so damage can droop it and then drop it off whole.
  const fwGrp = new THREE.Group();
  const fwPart = (geo, mat, x, y, z, rx) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (rx) m.rotation.x = rx; m.userData.caster = true; fwGrp.add(m); return m; };
  fwPart(_airfoilGeo(1.92, 0.52, 0.09, -0.05), mCarb, 0, 0.12, 2.86, 0.05);       // main plane
  fwPart(_airfoilGeo(1.90, 0.30, 0.10, -0.06), mCarb, 0, 0.20, 2.64, 0.30);       // flap 1
  fwPart(_airfoilGeo(1.88, 0.22, 0.10, -0.06), mBody, 0, 0.28, 2.52, 0.55);       // flap 2
  fwPart(_airfoilGeo(1.86, 0.15, 0.10, -0.05), mAcc,  0, 0.35, 2.44, 0.75);       // top flap
  [-1, 1].forEach(s => {
    fwPart(_sideProfileGeo([[3.14,0.06],[3.12,0.20],[2.96,0.30],[2.62,0.42],[2.40,0.43],
                            [2.36,0.34],[2.50,0.10],[2.70,0.06]], 0.035, 0), mCarb, s * 0.965, 0, 0);
    fwPart(_sideProfileGeo([[2.96,0.30],[2.62,0.42],[2.40,0.43],[2.42,0.395],[2.62,0.385],[2.95,0.275]], 0.04, 0), mAcc, s * 0.965, 0, 0);
    fwPart(_sideProfileGeo([[2.90,0.12],[2.86,0.30],[2.70,0.31],[2.74,0.12]], 0.02, 0), mCarb, s * 0.14, 0, 0); // nose pylons
  });
  g.add(fwGrp);

  // ---------- suspension: tube wishbones + pushrods ----------
  [[1.80, 0.85], [-1.60, 0.80]].forEach(([z, wx]) => {
    [-1, 1].forEach(s => {
      const ux = s * (wx - 0.10);
      tube([s * 0.30, 0.54, z + 0.22], [ux, 0.50, z]);        // upper wishbone, front leg
      tube([s * 0.30, 0.54, z - 0.20], [ux, 0.50, z]);        // upper wishbone, rear leg
      tube([s * 0.28, 0.30, z + 0.26], [ux, 0.24, z]);        // lower wishbone
      tube([s * 0.28, 0.30, z - 0.24], [ux, 0.24, z]);
      tube([s * 0.32, 0.58, z - 0.05], [ux, 0.26, z + 0.02], 0.014);   // pushrod
      tube([s * 0.30, 0.44, z + 0.10], [ux, 0.40, z + 0.12], 0.012);   // track rod
    });
  });

  // ---------- sidepods: undercut inlet + downwash ramp ----------
  [-1, 1].forEach(s => {
    part(_normUV(_sideProfileGeo([[0.66,0.42],[0.70,0.70],[0.40,0.75],[-0.10,0.69],[-0.70,0.54],
                                  [-1.25,0.38],[-1.45,0.28],[-1.20,0.20],[-0.20,0.20],[0.30,0.30]], 0.44, 0.10)),
         mPod, s * 0.60, 0, 0).userData.caster = true;
    part(_sideProfileGeo([[0.73,0.46],[0.75,0.66],[0.70,0.67],[0.68,0.47]], 0.32, 0.02), mDark, s * 0.60, 0, 0); // inlet
    part(_sideProfileGeo([[0.40,0.75],[-0.10,0.69],[-0.70,0.54],[-0.70,0.515],[-0.10,0.665],[0.40,0.725]], 0.40, 0), mAcc, s * 0.60, 0.01, 0);
    // floor-edge wing and bargeboard-style vanes ahead of the pod
    box(0.09, 0.03, 1.9, mCarb, s * 0.92, 0.15, 0.10);
    part(_sideProfileGeo([[1.10,0.14],[1.05,0.40],[0.80,0.44],[0.78,0.14]], 0.03, 0), mCarb, s * 0.80, 0, 0);
    part(_sideProfileGeo([[0.95,0.14],[0.92,0.34],[0.72,0.36],[0.70,0.14]], 0.03, 0), mCarb, s * 0.70, 0, 0);
    // mirrors: stalk + shaped housing + glass
    tube([s * 0.34, 0.66, 0.70], [s * 0.52, 0.76, 0.66], 0.012);
    part(_sideProfileGeo([[0.70,0.73],[0.70,0.81],[0.62,0.82],[0.60,0.74]], 0.18, 0.02), mCarb, s * 0.55, 0, 0);
    box(0.15, 0.06, 0.005, mDark, s * 0.55, 0.775, 0.595);
  });

  // ---------- floor, edge fences, diffuser ----------
  part(_planGeo([[-0.34,1.40],[0.34,1.40],[0.78,1.00],[0.96,0.60],[0.96,-1.25],[0.64,-1.78],
                 [-0.64,-1.78],[-0.96,-1.25],[-0.96,0.60],[-0.78,1.00]], 0.035), mCarb, 0, 0.12, 0).userData.caster = true;
  [-1, 1].forEach(s => {
    box(0.02, 0.10, 0.9, mCarb, s * 0.55, 0.13, 1.05, 0, s * 0.10);      // floor fences
    box(0.02, 0.10, 0.9, mCarb, s * 0.40, 0.13, 1.10, 0, s * 0.06);
  });
  box(1.20, 0.025, 0.60, mCarb, 0, 0.22, -1.86, 0.45).userData.caster = true;   // diffuser ramp
  [-0.45, -0.15, 0.15, 0.45].forEach(x => box(0.018, 0.26, 0.55, mCarb, x, 0.22, -1.86)); // strakes
  // gearbox / crash structure + rain light + exhaust
  box(0.26, 0.20, 0.30, mCarb, 0, 0.40, -2.00);
  const exh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.14, 12, 1, true), mDisc);
  exh.rotation.x = Math.PI / 2; exh.position.set(0, 0.58, -2.02); g.add(exh);

  // ---------- halo ----------
  const haloRing = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.04, 8, 24, Math.PI), mCarb);
  haloRing.position.set(0, 0.90, 0.42);
  haloRing.rotation.x = Math.PI/2;
  g.add(haloRing);
  g.userData.haloStrut = box(0.06, 0.38, 0.09, mCarb, 0, 0.84, 0.82); // centre strut
  box(0.05, 0.12, 0.10, mCarb, -0.40, 0.86, 0.42);          // side mounts
  box(0.05, 0.12, 0.10, mCarb,  0.40, 0.86, 0.42);

  // ---------- driver ----------
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.160, 16, 12), mHelm);
  helmet.position.set(0, 0.80, 0.28);
  g.add(helmet);
  box(0.21, 0.06, 0.06, mDark, 0, 0.81, 0.43);              // visor
  box(0.44, 0.10, 0.24, mDark, 0, 0.66, 0.20);              // shoulders / HANS

  // ---------- rear wing: shaped endplates, airfoil planes, beam wing ----------
  [-1, 1].forEach(s => {
    part(_sideProfileGeo([[-1.74,0.62],[-1.72,1.10],[-1.82,1.18],[-2.20,1.14],[-2.24,0.94],[-2.12,0.62]], 0.03, 0), mCarb, s * 0.52, 0, 0);
    part(_sideProfileGeo([[-1.72,1.10],[-1.82,1.18],[-2.20,1.14],[-2.21,1.09],[-1.83,1.13],[-1.74,1.06]], 0.034, 0), mAcc, s * 0.52, 0, 0);
    part(_sideProfileGeo([[-1.78,0.62],[-1.86,0.92],[-1.96,0.92],[-1.90,0.62]], 0.03, 0), mCarb, s * 0.10, 0, 0); // swan necks
  });
  part(_airfoilGeo(1.02, 0.30, 0.10, -0.07), mBody, 0, 0.90, -2.00, 0.28).userData.caster = true;   // main plane
  // DRS flap: pivot group (main.js swings pivot.rotation.x); the airfoil sits
  // inside at its closed angle of attack
  const drsFlap = new THREE.Group();
  drsFlap.position.set(0, 1.03, -1.95);
  const flapFoil = new THREE.Mesh(_airfoilGeo(1.00, 0.22, 0.10, -0.06), mCarb);
  flapFoil.rotation.x = 0.55; flapFoil.userData.caster = true;
  drsFlap.add(flapFoil);
  g.add(drsFlap);
  g.userData.drsFlap = drsFlap;
  part(_airfoilGeo(0.95, 0.20, 0.10, -0.05), mCarb, 0, 0.58, -2.02, 0.35);        // beam wing
  // rain/brake light (brightens under braking)
  const brakeLightMat = new THREE.MeshBasicMaterial({ color: 0x661111 });
  box(0.09, 0.14, 0.03, brakeLightMat, 0, 0.44, -2.16);
  g.userData.brakeLight = brakeLightMat;

  // ---------- wheels ----------
  // children[0] = tyre, children[1] = rim assembly. main.js spins exactly
  // those two, so anything that should turn with the wheel goes inside the
  // rim group and anything static goes after index 1.
  const tyreRings = [];
  function wheel(x, z, front) {
    const w = new THREE.Group();
    const r = front ? 0.345 : 0.36;
    const tw = front ? 0.30 : 0.40;
    const outer = (x > 0 ? 1 : -1);

    // tyre with rounded shoulders and a sidewall (lathe profile) instead of a
    // sharp-edged cylinder — the single most visible "boxy" cue at speed
    const prof = [[r*0.62,-tw/2],[r-0.055,-tw/2],[r-0.018,-tw/2+0.025],[r-0.002,-tw/2+0.065],
                  [r,-tw/2+0.09],[r,tw/2-0.09],[r-0.002,tw/2-0.065],[r-0.018,tw/2-0.025],[r-0.055,tw/2],[r*0.62,tw/2]]
                 .map(q => new THREE.Vector2(q[0], q[1]));
    const tyre = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), mTyre);
    tyre.rotation.z = Math.PI/2;
    tyre.userData.caster = true;
    w.add(tyre);                                   // child 0 — spins

    const rimGrp = new THREE.Group();
    rimGrp.rotation.z = Math.PI/2;                 // child 1 — spins
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r*0.60, r*0.60, tw+0.02, 18), mRim);
    rimGrp.add(rim);
    // polished rim lip on the outer face
    const lip = new THREE.Mesh(new THREE.TorusGeometry(r*0.60, 0.012, 6, 24), mRim);
    lip.rotation.x = Math.PI/2; lip.position.y = outer * (tw/2 + 0.004);
    rimGrp.add(lip);
    // aero wheel cover on the outboard face (real 2022+ cars run these)
    const cover = new THREE.Mesh(new THREE.CircleGeometry(r*0.60, 20), mCover2);
    cover.rotation.x = -Math.PI/2 * outer;
    cover.position.y = outer * (tw/2 + 0.014);
    rimGrp.add(cover);
    // brake disc visible on the inboard side
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r*0.50, r*0.50, 0.035, 16), mDisc);
    disc.position.y = -outer * (tw/2 - 0.03);
    rimGrp.add(disc);
    w.add(rimGrp);

    // coloured compound band on the outer sidewall (static, reads at speed)
    // compound band on the sidewall — main.js tints it to the fitted compound
    // (it used to be fixed red on every car, whatever tyre was on)
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xd02020, side: THREE.DoubleSide });
    tyreRings.push(ringMat);
    const ring = new THREE.Mesh(new THREE.RingGeometry(r*0.84, r*0.96, 20), ringMat);
    ring.rotation.y = Math.PI/2;
    ring.position.x = outer * (tw/2 + 0.012);
    w.add(ring);                                   // child 2 — static

    w.position.set(x, r, z);
    g.add(w);
    return w;
  }
  const wheels = {
    fl: wheel(-0.85, 1.80, true),
    fr: wheel( 0.85, 1.80, true),
    rl: wheel(-0.80, -1.60, false),
    rr: wheel( 0.80, -1.60, false),
  };

  // ---------- soft blob shadow ----------
  {
    const stex = _shared('blob', () => _carTex(128, 64, (ctx) => {
      const grd = ctx.createRadialGradient(64,32,4, 64,32,60);
      grd.addColorStop(0, 'rgba(0,0,0,0.55)');
      grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0,0,128,64);
    }));
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 5.6),
      new THREE.MeshBasicMaterial({ map: stex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI/2;
    shadow.position.y = 0.07;
    shadow.userData.noShadow = true;
    g.add(shadow);
    // kept as a fallback: main.js hides it whenever real shadow maps are on,
    // otherwise the car sits in two shadows at once
    g.userData.blobShadow = shadow;
  }

  // Collapse the static parts into one mesh per material (see _mergeStatic).
  // Animated parts stay separate: wheels/front wing/DRS flap are groups (never
  // merged), and the halo strut is rescaled by the cockpit camera.
  _mergeStatic(g, new Set([g.userData.haloStrut]));
  _mergeStatic(fwGrp, new Set());

  // Shadow flags. Everything solid RECEIVES, but only the dozen parts that
  // define the car's silhouette from the sun CAST. A 22-car grid at ~85 parts
  // each would push ~1,800 meshes through the shadow pass every frame, and a
  // wing mirror's shadow is invisible anyway. Tagged parts: tub, nose, floor,
  // sidepods, engine cover, both wings and the four tyres.
  g.traverse(o => {
    if (!o.isMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    o.castShadow = !!o.userData.caster && !o.userData.noShadow;
    o.receiveShadow = !(o.userData.noShadow || (m && m.isMeshBasicMaterial));
  });

  // ---------- cockpit rig (player car only) ----------
  // Added after the shadow pass above so it stays out of the shadow maps —
  // it lives inside the car and would only ever cast onto the driver.
  if (opts.cockpit) {
    const rig = buildCockpitRig(teamKey);
    rig.visible = false; // main.js shows it in the cockpit camera only
    g.add(rig);
    g.userData.cockpitRig = rig;
    g.userData.steeringWheel = rig.userData.spin;
  }

  // front-wing assembly, so damage can bend it and then tear it off
  g.userData.frontWing = [fwGrp];
  g.userData.wheels = wheels;
  g.userData.tyreRings = tyreRings;
  g.userData.team = teamKey;
  return g;
}
