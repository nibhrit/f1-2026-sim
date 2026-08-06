// ============================================================
// Detailed low-poly F1 car (2026-style). Returns THREE.Group
// with .userData.wheels {fl,fr,rl,rr}. Car faces +Z, ~5.6m long.
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
  const mFace = new THREE.MeshStandardMaterial({ map: wheelFaceTex(teamKey), metalness: 0.3, roughness: 0.45 });
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

function buildF1Car(teamKey, opts) {
  opts = opts || {};
  const team = TEAMS[teamKey];
  const g = new THREE.Group();

  // PBR paint + carbon: picks up sky reflections via scene.environment (IBL)
  const liveryMain  = liveryTex(teamKey, 'main');
  const liveryPod   = liveryTex(teamKey, 'pod');
  const liveryCover = liveryTex(teamKey, 'cover');
  const mBody = new THREE.MeshStandardMaterial({ color: team.color, metalness: 0.38, roughness: 0.32 });
  const mLivery = new THREE.MeshStandardMaterial({ map: liveryMain, metalness: 0.32, roughness: 0.34 });
  const mPod  = new THREE.MeshStandardMaterial({ map: liveryPod, metalness: 0.32, roughness: 0.34 });
  const mCover= new THREE.MeshStandardMaterial({ map: liveryCover, metalness: 0.32, roughness: 0.34 });
  const mAcc  = new THREE.MeshStandardMaterial({ color: team.accent, metalness: 0.30, roughness: 0.36 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x131318, metalness: 0.2, roughness: 0.7 });
  const mCarb = new THREE.MeshStandardMaterial({ color: 0x1d1d24, metalness: 0.5, roughness: 0.38 });
  const mTyre = new THREE.MeshStandardMaterial({ map: tyreTex(), color: 0xffffff, metalness: 0.0, roughness: 0.92 });
  const mRim  = new THREE.MeshStandardMaterial({ color: 0x9a9aa4, metalness: 0.9, roughness: 0.25 });
  const mCover2 = new THREE.MeshStandardMaterial({ map: wheelCoverTex(teamKey), metalness: 0.65, roughness: 0.35, side: THREE.DoubleSide });
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

  // ---------- monocoque / tub (tapers toward nose) ----------
  box(0.92, 0.30, 1.5, mLivery, 0, 0.44, -0.35).userData.caster = true;   // rear tub
  box(0.74, 0.28, 1.3, mLivery, 0, 0.45, 0.75).userData.caster = true;    // mid tub
  box(0.66, 0.20, 0.7, mBody, 0, 0.43, 1.55);           // tub taper into the nose
  // cockpit surround
  box(0.62, 0.14, 0.9, mCarb, 0, 0.62, 0.35);

  // ---------- nose cone ----------
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.24, 1.75, 10), mBody);
  nose.rotation.x = Math.PI/2;
  nose.position.set(0, 0.44, 2.05);
  nose.userData.caster = true;
  g.add(nose);
  // red tip band (accent)
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, 0.34, 10), mAcc);
  tip.rotation.x = Math.PI/2;
  tip.position.set(0, 0.44, 2.78);
  g.add(tip);

  // ---------- front wing (4 elements + endplates) ----------
  box(1.96, 0.035, 0.62, mCarb, 0, 0.13, 2.78).userData.caster = true;  // front wing plane
  box(1.96, 0.03, 0.34, mCarb, 0, 0.21, 2.92, -0.28);
  box(1.96, 0.028, 0.24, mBody, 0, 0.30, 3.0, -0.42);
  box(1.90, 0.024, 0.16, mAcc,  0, 0.37, 3.06, -0.52);  // top flap, accent trim
  // endplates with accent stripe + turning vanes under the nose
  [[-0.99],[0.99]].forEach(([x]) => {
    box(0.05, 0.24, 0.72, mCarb, x, 0.24, 2.82);
    box(0.052, 0.05, 0.72, mAcc, x, 0.375, 2.82);
    box(0.04, 0.14, 0.42, mCarb, x*0.42, 0.24, 2.36, 0, 0, x>0 ? -0.2 : 0.2);
  });

  // ---------- suspension ----------
  [[-0.55,1.62,0.02],[0.55,1.62,0.02],[-0.58,-1.42,-0.05],[0.58,-1.42,-0.05]].forEach(p => {
    box(0.72, 0.03, 0.05, mCarb, p[0], 0.52, p[1], 0, 0, p[0]>0?-0.12:0.12);
    box(0.72, 0.03, 0.05, mCarb, p[0], 0.32, p[1]+0.18, 0, 0, p[0]>0?-0.08:0.08);
  });

  // ---------- sidepods (undercut, with inlet) ----------
  [[-1],[1]].forEach(([s]) => {
    const pod = box(0.46, 0.30, 1.55, mPod, s*0.62, 0.52, -0.35);
    pod.rotation.x = -0.06;
    pod.userData.caster = true;
    box(0.40, 0.12, 1.1, mDark, s*0.60, 0.30, -0.30);       // undercut shadow
    box(0.30, 0.20, 0.10, mDark, s*0.62, 0.52, 0.44);       // radiator inlet mouth
    box(0.34, 0.05, 0.06, mCarb, s*0.62, 0.63, 0.47);       // inlet lip
    box(0.44, 0.05, 0.85, mAcc, s*0.63, 0.685, -0.55);      // accent top stripe
    box(0.08, 0.16, 0.5, mCarb, s*0.86, 0.42, 0.55);        // bargeboard
    box(0.10, 0.04, 1.9, mCarb, s*0.93, 0.16, 0.10);        // floor edge wing
  });

  // ---------- floor + diffuser ----------
  box(1.9, 0.05, 3.3, mCarb, 0, 0.12, 0.0).userData.caster = true;      // floor
  const diff = box(1.15, 0.22, 0.55, mCarb, 0, 0.24, -1.78, 0.45);
  box(1.05, 0.03, 0.5, mDark, 0, 0.15, -1.72);              // diffuser ceiling

  // ---------- engine cover + shark fin ----------
  const spine = box(0.36, 0.42, 1.75, mCover, 0, 0.72, -0.95);
  spine.rotation.x = 0.05;
  spine.userData.caster = true;
  box(0.24, 0.26, 0.6, mCover, 0, 0.62, -1.86);             // cover taper to the rear
  box(0.05, 0.42, 1.05, mBody, 0, 1.02, -1.35);             // shark fin
  box(0.05, 0.08, 1.05, mAcc, 0, 1.25, -1.35);              // fin top accent
  // airbox above driver
  box(0.30, 0.26, 0.55, mCarb, 0, 1.02, -0.15);
  box(0.20, 0.16, 0.06, mDark, 0, 1.03, 0.11);              // airbox intake mouth

  // ---------- halo ----------
  const haloRing = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.045, 6, 14, Math.PI), mCarb);
  haloRing.position.set(0, 0.90, 0.42);
  haloRing.rotation.x = Math.PI/2;
  g.add(haloRing);
  box(0.06, 0.38, 0.09, mCarb, 0, 0.84, 0.82);              // centre strut
  box(0.05, 0.12, 0.10, mCarb, -0.40, 0.86, 0.42);          // side mounts
  box(0.05, 0.12, 0.10, mCarb,  0.40, 0.86, 0.42);

  // ---------- driver ----------
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.160, 12, 10), mHelm);
  helmet.position.set(0, 0.80, 0.28);
  g.add(helmet);
  box(0.20, 0.07, 0.05, mDark, 0, 0.80, 0.44);              // visor

  // ---------- mirrors ----------
  box(0.16, 0.07, 0.05, mCarb, -0.52, 0.78, 0.62);
  box(0.16, 0.07, 0.05, mCarb,  0.52, 0.78, 0.62);

  // ---------- rear wing (2 elements, DRS gap, swan-neck) ----------
  const drsFlap = box(1.02, 0.04, 0.40, mCarb, 0, 1.02, -1.92, -0.18);
  drsFlap.userData.caster = true;
  g.userData.drsFlap = drsFlap; // rotates open when DRS is active
  box(1.02, 0.035, 0.26, mBody, 0, 0.90, -2.02, -0.30).userData.caster = true; // rear wing
  box(0.05, 0.46, 0.55, mCarb, -0.50, 0.86, -1.94);
  box(0.05, 0.46, 0.55, mCarb,  0.50, 0.86, -1.94);
  box(0.052, 0.06, 0.55, mAcc, -0.50, 1.06, -1.94);
  box(0.052, 0.06, 0.55, mAcc,  0.50, 1.06, -1.94);
  box(0.05, 0.30, 0.35, mCarb, 0, 0.72, -1.72, 0.35);       // swan-neck pillar
  // beam wing
  box(0.95, 0.03, 0.20, mCarb, 0, 0.58, -2.0, -0.35);
  // rain/brake light (brightens under braking)
  const brakeLightMat = new THREE.MeshBasicMaterial({ color: 0x661111 });
  box(0.09, 0.22, 0.05, brakeLightMat, 0, 0.42, -2.12);
  g.userData.brakeLight = brakeLightMat;

  // ---------- wheels ----------
  // children[0] = tyre, children[1] = rim assembly. main.js spins exactly
  // those two, so anything that should turn with the wheel goes inside the
  // rim group and anything static goes after index 1.
  function wheel(x, z, front) {
    const w = new THREE.Group();
    const r = front ? 0.345 : 0.36;
    const tw = front ? 0.30 : 0.40;
    const outer = (x > 0 ? 1 : -1);

    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, tw, 20), mTyre);
    tyre.rotation.z = Math.PI/2;
    tyre.userData.caster = true;
    w.add(tyre);                                   // child 0 — spins

    const rimGrp = new THREE.Group();
    rimGrp.rotation.z = Math.PI/2;                 // child 1 — spins
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r*0.60, r*0.60, tw+0.02, 14), mRim);
    rimGrp.add(rim);
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
    const ring = new THREE.Mesh(new THREE.RingGeometry(r*0.84, r*0.96, 20),
      new THREE.MeshBasicMaterial({ color: 0xd02020, side: THREE.DoubleSide }));
    ring.rotation.y = Math.PI/2;
    ring.position.x = outer * (tw/2 + 0.012);
    w.add(ring);                                   // child 2 — static

    w.position.set(x, r, z);
    g.add(w);
    return w;
  }
  const wheels = {
    fl: wheel(-0.84, 1.62, true),
    fr: wheel( 0.84, 1.62, true),
    rl: wheel(-0.86, -1.42, false),
    rr: wheel( 0.86, -1.42, false),
  };

  // ---------- soft blob shadow ----------
  {
    const stex = _carTex(128, 64, (ctx) => {
      const grd = ctx.createRadialGradient(64,32,4, 64,32,60);
      grd.addColorStop(0, 'rgba(0,0,0,0.55)');
      grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(0,0,128,64);
    });
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 6.0),
      new THREE.MeshBasicMaterial({ map: stex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI/2;
    shadow.position.y = 0.07;
    shadow.userData.noShadow = true;
    g.add(shadow);
    // kept as a fallback: main.js hides it whenever real shadow maps are on,
    // otherwise the car sits in two shadows at once
    g.userData.blobShadow = shadow;
  }

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

  g.userData.wheels = wheels;
  g.userData.team = teamKey;
  return g;
}
