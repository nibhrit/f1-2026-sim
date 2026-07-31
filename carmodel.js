// ============================================================
// Detailed low-poly F1 car (2026-style). Returns THREE.Group
// with .userData.wheels {fl,fr,rl,rr}. Car faces +Z, ~5.6m long.
// ============================================================

function buildF1Car(teamKey, opts) {
  opts = opts || {};
  const team = TEAMS[teamKey];
  const g = new THREE.Group();

  // PBR paint + carbon: picks up sky reflections via scene.environment (IBL)
  const mBody = new THREE.MeshStandardMaterial({ color: team.color, metalness: 0.55, roughness: 0.30 });
  const mAcc  = new THREE.MeshStandardMaterial({ color: team.accent, metalness: 0.45, roughness: 0.35 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x131318, metalness: 0.2, roughness: 0.7 });
  const mCarb = new THREE.MeshStandardMaterial({ color: 0x1d1d24, metalness: 0.5, roughness: 0.38 });
  const mTyre = new THREE.MeshStandardMaterial({ color: 0x141416, metalness: 0.0, roughness: 0.92 });
  const mRim  = new THREE.MeshStandardMaterial({ color: 0x9a9aa4, metalness: 0.9, roughness: 0.25 });
  const mHelm = new THREE.MeshStandardMaterial({ color: opts.helmet || 0xffffff, metalness: 0.3, roughness: 0.25 });
  [mBody, mAcc, mCarb, mRim, mHelm].forEach(m => { m.envMapIntensity = 0.6; });

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
  box(0.92, 0.30, 1.5, mBody, 0, 0.44, -0.35);          // rear tub
  box(0.74, 0.28, 1.3, mBody, 0, 0.45, 0.75);           // mid tub
  // cockpit surround
  box(0.62, 0.14, 0.9, mCarb, 0, 0.62, 0.35);

  // ---------- nose cone ----------
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.24, 1.75, 10), mBody);
  nose.rotation.x = Math.PI/2;
  nose.position.set(0, 0.44, 2.05);
  g.add(nose);
  // red tip band (accent)
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, 0.34, 10), mAcc);
  tip.rotation.x = Math.PI/2;
  tip.position.set(0, 0.44, 2.78);
  g.add(tip);

  // ---------- front wing (3 elements + endplates) ----------
  box(1.96, 0.035, 0.62, mCarb, 0, 0.13, 2.78);
  box(1.96, 0.03, 0.34, mCarb, 0, 0.21, 2.92, -0.28);
  box(1.96, 0.028, 0.24, mBody, 0, 0.30, 3.0, -0.42);
  // endplates with accent stripe
  [[-0.99],[0.99]].forEach(([x]) => {
    box(0.05, 0.24, 0.72, mCarb, x, 0.24, 2.82);
    box(0.052, 0.05, 0.72, mAcc, x, 0.375, 2.82);
  });

  // ---------- suspension ----------
  [[-0.55,1.62,0.02],[0.55,1.62,0.02],[-0.58,-1.42,-0.05],[0.58,-1.42,-0.05]].forEach(p => {
    box(0.72, 0.03, 0.05, mCarb, p[0], 0.52, p[1], 0, 0, p[0]>0?-0.12:0.12);
    box(0.72, 0.03, 0.05, mCarb, p[0], 0.32, p[1]+0.18, 0, 0, p[0]>0?-0.08:0.08);
  });

  // ---------- sidepods (undercut style) ----------
  [[-1],[1]].forEach(([s]) => {
    const pod = box(0.46, 0.30, 1.55, mBody, s*0.62, 0.52, -0.35);
    pod.rotation.x = -0.06;
    box(0.40, 0.12, 1.1, mDark, s*0.60, 0.30, -0.30);       // undercut shadow
    box(0.44, 0.05, 0.85, mAcc, s*0.63, 0.685, -0.55);      // accent top stripe
    box(0.08, 0.16, 0.5, mCarb, s*0.86, 0.42, 0.55);        // bargeboard
  });

  // ---------- floor + diffuser ----------
  box(1.9, 0.05, 3.3, mCarb, 0, 0.12, 0.0);
  const diff = box(1.15, 0.22, 0.55, mCarb, 0, 0.24, -1.78, 0.45);

  // ---------- engine cover + shark fin ----------
  const spine = box(0.36, 0.42, 1.75, mBody, 0, 0.72, -0.95);
  spine.rotation.x = 0.05;
  box(0.05, 0.42, 1.05, mBody, 0, 1.02, -1.35);             // shark fin
  box(0.05, 0.08, 1.05, mAcc, 0, 1.25, -1.35);              // fin top accent
  // airbox above driver
  box(0.30, 0.26, 0.55, mCarb, 0, 1.02, -0.15);

  // ---------- halo ----------
  const haloRing = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.045, 6, 14, Math.PI), mCarb);
  haloRing.position.set(0, 0.90, 0.42);
  haloRing.rotation.x = Math.PI/2;
  g.add(haloRing);
  box(0.06, 0.38, 0.09, mCarb, 0, 0.84, 0.82);

  // ---------- driver ----------
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.175, 12, 10), mHelm);
  helmet.position.set(0, 0.80, 0.28);
  g.add(helmet);
  box(0.20, 0.07, 0.05, mDark, 0, 0.80, 0.44);              // visor

  // ---------- mirrors ----------
  box(0.16, 0.07, 0.05, mCarb, -0.52, 0.78, 0.62);
  box(0.16, 0.07, 0.05, mCarb,  0.52, 0.78, 0.62);

  // ---------- rear wing (2 elements, DRS gap, swan-neck) ----------
  const drsFlap = box(1.02, 0.04, 0.40, mCarb, 0, 1.02, -1.92, -0.18);
  g.userData.drsFlap = drsFlap; // rotates open when DRS is active
  box(1.02, 0.035, 0.26, mBody, 0, 0.90, -2.02, -0.30);
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
  function wheel(x, z, front) {
    const w = new THREE.Group();
    const r = front ? 0.345 : 0.36;
    const tw = front ? 0.30 : 0.40;
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, tw, 16), mTyre);
    tyre.rotation.z = Math.PI/2;
    w.add(tyre);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r*0.58, r*0.58, tw+0.02, 10), mRim);
    rim.rotation.z = Math.PI/2;
    w.add(rim);
    // red compound ring on outer sidewall
    const ring = new THREE.Mesh(new THREE.RingGeometry(r*0.82, r*0.95, 16),
      new THREE.MeshBasicMaterial({ color: 0xd02020, side: THREE.DoubleSide }));
    ring.rotation.y = Math.PI/2;
    ring.position.x = (x > 0 ? 1 : -1) * (tw/2 + 0.012);
    w.add(ring);
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
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    const ctx = cv.getContext('2d');
    const grd = ctx.createRadialGradient(64,32,4, 64,32,60);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0,0,128,64);
    const stex = new THREE.CanvasTexture(cv);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 6.0),
      new THREE.MeshBasicMaterial({ map: stex, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI/2;
    shadow.position.y = 0.07;
    g.add(shadow);
  }

  g.userData.wheels = wheels;
  g.userData.team = teamKey;
  return g;
}
