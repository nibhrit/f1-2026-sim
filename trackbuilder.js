// ============================================================
// Track sampling (with elevation + camber) + scene generation
// ============================================================

class TrackData {
  constructor(def) {
    this.def = def;
    this.width = def.width;
    // street circuits: walls hug the track; permanent circuits have run-off
    // Street circuits are lined with barriers, not run-off. At +5 m you could
    // straight-line a Monaco chicane across "grass" that costs almost nothing
    // and come out 6 s under the theoretical ideal lap. Real Monaco barriers
    // sit a metre or two off the white line, so the road is the only option.
    this.wallOff = (def.theme && def.theme.indexOf('street') === 0)
      ? this.width/2 + 2.0
      : this.width/2 + 8.2;
    this._sample(def.points);
  }

  _sample(pts) {
    const n = pts.length;
    let est = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i+1)%n];
      est += Math.hypot(b.x-a.x, b.z-a.z);
    }
    // ~1.6 m between samples, not 3 m. At 3 m a Monaco chicane was only a
    // handful of points long and could not survive the smoothing below.
    const SAMPLES = Math.max(900, Math.min(4200, Math.floor(est / 1.6)));
    this.n = SAMPLES;
    this.px = new Float32Array(SAMPLES);
    this.pz = new Float32Array(SAMPLES);
    this.py = new Float32Array(SAMPLES);
    this.tx = new Float32Array(SAMPLES);
    this.tz = new Float32Array(SAMPLES);
    this.nx = new Float32Array(SAMPLES);
    this.nz = new Float32Array(SAMPLES);
    this.curv = new Float32Array(SAMPLES);
    this.bank = new Float32Array(SAMPLES);
    this.dist = new Float32Array(SAMPLES);

    const cr = (p0,p1,p2,p3,t) => {
      const t2=t*t, t3=t2*t;
      return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t2+(-p0+3*p1-3*p2+p3)*t3);
    };
    for (let i = 0; i < SAMPLES; i++) {
      const u = i / SAMPLES * n;
      const seg = Math.floor(u) % n;
      const t = u - Math.floor(u);
      const p0 = pts[(seg-1+n)%n], p1 = pts[seg], p2 = pts[(seg+1)%n], p3 = pts[(seg+2)%n];
      this.px[i] = cr(p0.x,p1.x,p2.x,p3.x,t);
      this.pz[i] = cr(p0.z,p1.z,p2.z,p3.z,t);
    }
    // Kink smoothing. This exists to kill unphysical spikes in the source
    // centreline data, but it was capping curvature at a 9 m radius and
    // blending 60% toward the midpoint on every one of 120 passes — which
    // doesn't just clean up noise, it erases real corners. Monaco came out
    // 3032 m instead of 3337 m with only ONE corner under 30 m radius,
    // because the hairpin, Rascasse and both chicanes had been rounded off.
    // The path smoothing itself is kept as it was: the source centrelines are
    // polylines with points ~30 m apart, and interpolating them finely exposes
    // kinks that aren't real corners. What changed is the SAMPLING above and
    // the curvature window below, which is where the lost corners actually
    // went. Measured over ten circuits with known pole times, relaxing this
    // as well made every lap ~10% too slow for no extra braking zones.
    const MIN_R = 9.0;
    for (let pass = 0; pass < 120; pass++) {
      let worst = 0;
      const npx = new Float32Array(this.px), npz = new Float32Array(this.pz);
      for (let i = 0; i < SAMPLES; i++) {
        const a=(i-2+SAMPLES)%SAMPLES, b=(i+2)%SAMPLES;
        const mx=(this.px[a]+this.px[b])/2, mz=(this.pz[a]+this.pz[b])/2;
        const dev=Math.hypot(this.px[i]-mx, this.pz[i]-mz);
        const hc=Math.hypot(this.px[b]-this.px[a], this.pz[b]-this.pz[a])/2 || 1;
        const c = 2*dev/(hc*hc+dev*dev);
        if (c > worst) worst = c;
        if (c > 1/MIN_R) {
          npx[i]=this.px[i]*0.4+mx*0.6;
          npz[i]=this.pz[i]*0.4+mz*0.6;
        }
      }
      this.px=npx; this.pz=npz;
      if (worst <= 1/MIN_R) break;
    }
    // tangents, normals, distances
    let d = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const j = (i+1)%SAMPLES, k = (i-1+SAMPLES)%SAMPLES;
      let dx = this.px[j]-this.px[k], dz = this.pz[j]-this.pz[k];
      const L = Math.hypot(dx,dz) || 1;
      dx/=L; dz/=L;
      this.tx[i]=dx; this.tz[i]=dz;
      this.nx[i]=-dz; this.nz[i]=dx;
      this.dist[i]=d;
      d += Math.hypot(this.px[j]-this.px[i], this.pz[j]-this.pz[i]);
    }
    this.length = d;
    const rawC = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) {
      const j=(i+1)%SAMPLES;
      const a1 = Math.atan2(this.tz[i], this.tx[i]);
      const a2 = Math.atan2(this.tz[j], this.tx[j]);
      let da = a2-a1;
      while (da>Math.PI) da-=2*Math.PI;
      while (da<-Math.PI) da+=2*Math.PI;
      const ds = Math.hypot(this.px[j]-this.px[i], this.pz[j]-this.pz[i]) || 1;
      rawC[i] = da/ds;
    }
    // Smooth the curvature over a fixed LENGTH of road, not a fixed number of
    // samples. At the old ±6 samples and 3 m spacing this averaged over ±18 m
    // — longer than a Monaco chicane, so chicanes measured as straight and the
    // sim never asked you to brake for them. ±8 m at the finer sampling keeps
    // source noise out while leaving genuine short corners intact: slow-corner
    // road across the calendar goes from 2.7% of the lap to 3.4%.
    const W = Math.max(1, Math.round(8 / (d / SAMPLES)));
    for (let i = 0; i < SAMPLES; i++) {
      let s = 0;
      for (let o=-W;o<=W;o++) s += rawC[(i+o+SAMPLES)%SAMPLES];
      this.curv[i] = s/(2*W+1);
    }

    // --- elevation profile (loop-periodic harmonics, per-track character) ---
    const amp = this.def.elev != null ? this.def.elev : 6;
    const seed = (this.def.id ? this.def.id.length : 5) * 7 + (this.def.round || 1);
    for (let i = 0; i < SAMPLES; i++) {
      const u = this.dist[i] / this.length * Math.PI * 2;
      this.py[i] = amp * (
        0.55 * Math.sin(u + seed) +
        0.30 * Math.sin(2*u + seed*1.7) +
        0.15 * Math.sin(5*u + seed*2.3)
      );
    }
    // --- camber: corners tilt inward (positive camber) ---
    for (let i = 0; i < SAMPLES; i++) {
      let b = this.curv[i] * 8;
      this.bank[i] = Math.max(-0.07, Math.min(0.07, b));
    }
  }

  nearest(x, z, hint, win) {
    const N = this.n;
    if (hint == null) {
      let best=0, bd=Infinity;
      for (let i=0;i<N;i+=4) {
        const dx=this.px[i]-x, dz=this.pz[i]-z, dd=dx*dx+dz*dz;
        if (dd<bd){bd=dd;best=i;}
      }
      hint = best;
      win = 12;
    }
    const W = win || 30;
    let idx = hint, bd = Infinity;
    for (let o=-W;o<=W;o++) {
      const i=(hint+o+N)%N;
      const dx=this.px[i]-x, dz=this.pz[i]-z, dd=dx*dx+dz*dz;
      if (dd<bd){bd=dd;idx=i;}
    }
    return idx;
  }

  lateral(x, z, idx) {
    return (x-this.px[idx])*this.nx[idx] + (z-this.pz[idx])*this.nz[idx];
  }

  // nearest sample index for a lap distance in metres (wraps)
  idxAtDist(d) {
    const L = this.length;
    d = ((d % L) + L) % L;
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.dist[m] < d) lo = m + 1; else hi = m; }
    return lo;
  }

  posAt(idx, lat) {
    return {
      x: this.px[idx] + this.nx[idx]*lat,
      z: this.pz[idx] + this.nz[idx]*lat,
    };
  }

  // road surface height at sample + lateral offset (elevation + camber)
  heightAt(idx, lat) {
    return this.py[idx] - this.bank[idx] * lat;
  }

  // DRS zones: the track's N longest straights (matching the real circuit's
  // zone count). Each zone = {det, start, end} in lap-distance meters.
  computeDrsZones(count) {
    const N = this.n, L = this.length;
    // collect straight runs (|curv| below threshold), incl. the wrap at S/F
    const flat = i => Math.abs(this.curv[((i % N) + N) % N]) < 0.0035;
    const runs = [];
    let i = 0;
    // step past a corner so runs don't start mid-straight at index 0
    while (i < N && flat(i)) i++;
    if (i >= N) { // entire track "straight" (never happens, safety)
      this.drsZones = [{ det: 0, start: 50, end: L * 0.4 }];
      return;
    }
    let scanned = 0, j = i;
    while (scanned < N) {
      // find next straight run starting at j
      while (scanned < N && !flat(j)) { j++; scanned++; }
      const s = j % N;
      let len = 0;
      while (scanned < N && flat(j)) { j++; scanned++; len++; }
      if (len > 8) {
        const e = (s + len) % N;
        const d0 = this.dist[s];
        let d1 = this.dist[e];
        if (d1 < d0) d1 += L; // wrapped past the line
        runs.push({ d0, d1, len: d1 - d0 });
      }
    }
    runs.sort((a, b) => b.len - a.len);
    const picked = runs.slice(0, Math.max(1, count));
    picked.sort((a, b) => a.d0 - b.d0);
    // FIA layout: a DETECTION point sits before the corner leading onto the
    // straight, then the ACTIVATION line a little way down the straight. The
    // gap is measured once, at detection — what happens afterwards (including
    // completing the pass) does not close the wing.
    this.drsZones = picked.map(r => {
      const det = ((r.d0 - 150) % L + L) % L;
      const start = (r.d0 + Math.min(120, r.len * 0.25)) % L;
      const end = r.d1 % L;
      return {
        det, start, end,
        detIdx: this.idxAtDist(det),
        startIdx: this.idxAtDist(start),
        endIdx: this.idxAtDist(end),
      };
    });
  }

  // smooth surface height at an exact world position: interpolates
  // elevation/camber between samples so cars sit flush on slopes
  surfaceY(x, z, idx) {
    const dx = x - this.px[idx], dz = z - this.pz[idx];
    const along = dx*this.tx[idx] + dz*this.tz[idx];
    const ds = this.length / this.n;
    const f = Math.max(-1, Math.min(1, along / ds));
    const j = f >= 0 ? (idx+1)%this.n : (idx-1+this.n)%this.n;
    const w = Math.abs(f);
    const py = this.py[idx]*(1-w) + this.py[j]*w;
    const bank = this.bank[idx]*(1-w) + this.bank[j]*w;
    const lat = dx*this.nx[idx] + dz*this.nz[idx];
    return py - bank * Math.max(-this.width, Math.min(this.width, lat));
  }
}

// ------------------------------------------------------------
// Themes
// ------------------------------------------------------------
const THEMES = {
  green:       { sky:0x87b5e0, fog:[600,2400], sun:0.85, amb:0.45, ambC:0x8899bb, ground:'stripes', g1:'#2a6b28', g2:'#235c21', turf:0x1d4a1d, tree:'pine', treeCount:170, stands:true, buildings:false, night:false },
  forest:      { sky:0x9cc4e4, fog:[500,2100], sun:0.80, amb:0.42, ambC:0x8899bb, ground:'stripes', g1:'#1f5c20', g2:'#194e1a', turf:0x16401a, tree:'pine', treeCount:280, stands:true, buildings:false, night:false },
  dunes:       { sky:0xa8c8e8, fog:[500,2100], sun:0.90, amb:0.50, ambC:0x99a0b0, ground:'stripes', g1:'#6d7f4a', g2:'#617240', turf:0x556b3a, tree:'pine', treeCount:70, stands:true, buildings:false, night:false },
  desertNight: { sky:0x0b1026, fog:[450,2000], sun:0.20, amb:0.42, ambC:0x8899cc, ground:'sand', g1:'#77653f', g2:'#6b5a38', turf:0x5e5136, tree:'palm', treeCount:80, stands:true, buildings:false, night:true },
  streetDay:   { sky:0x9fc3e0, fog:[500,2100], sun:0.85, amb:0.50, ambC:0x8899bb, ground:'urban', g1:'#4a4a50', g2:'#404046', turf:0x44444c, tree:'palm', treeCount:50, stands:false, buildings:true, night:false },
  streetNight: { sky:0x080c1d, fog:[400,1800], sun:0.18, amb:0.40, ambC:0x8090cc, ground:'urban', g1:'#26262c', g2:'#1f1f25', turf:0x2a2a32, tree:'none', treeCount:0, stands:false, buildings:true, night:true },
  // ---- per-circuit looks (BUILD 84): real surroundings, real race time of day ----
  // Monaco: Riviera afternoon — hard Mediterranean light, harbour, pastel town
  monaco:      { sky:0x8cc3ef, fog:[700,2600], sun:1.0, amb:0.50, ambC:0x99a6bb, sunC:0xfff2dc, ground:'urban', g1:'#7c7466', g2:'#706a5d', turf:0x5d6a43, tree:'palm', treeCount:70, stands:false, buildings:true, buildStyle:'riviera', night:false },
  // Spa: Ardennes — low grey cloud, mist, tall dark conifers to the kerbs
  spa:         { sky:0xa7b1ba, fog:[320,1600], sun:0.50, amb:0.46, ambC:0xa9b2bf, sunC:0xe6ebf2, skyStyle:'overcast', ground:'stripes', g1:'#2a5524', g2:'#244c1f', turf:0x22461f, tree:'pine', treeCount:2800, treeNear:2, treeFar:130, treeScale:[1.5,2.6], treeColor:0x0c2410, stands:true, buildings:false, night:false },
  // Silverstone: flat old airfield — big skies, broken cloud, open grass
  silverstone: { sky:0x9fbfdc, fog:[800,2900], sun:0.82, amb:0.52, ambC:0x99a8c0, skyStyle:'broken', ground:'stripes', g1:'#4f8a3a', g2:'#477f34', turf:0x3f7a30, tree:'broadleaf', treeCount:110, treeNear:60, treeFar:260, treeScale:[0.9,1.4], stands:true, buildings:false, night:false },
  // Monza: the royal park — sunny late summer, dense old trees close to the track
  monza:       { sky:0x8dbbe8, fog:[600,2300], sun:0.95, amb:0.48, ambC:0x99a6bb, sunC:0xfff1d6, ground:'stripes', g1:'#3c6e2e', g2:'#356428', turf:0x2f5a26, tree:'broadleaf', treeCount:3600, treeNear:4, treeFar:95, treeScale:[1.2,2.1], stands:true, buildings:false, night:false },
  // Suzuka: spring afternoon in Mie — wooded hills, the funfair by the straight
  suzuka:      { sky:0x93c0ea, fog:[650,2500], sun:0.92, amb:0.48, ambC:0x99a6bb, sunC:0xfff3e0, ground:'stripes', g1:'#40752f', g2:'#3a6a2a', turf:0x33612a, tree:'mixed', treeCount:520, treeNear:14, treeFar:220, treeScale:[0.9,1.6], stands:true, buildings:false, night:false },
  // Singapore: night race under the floodlights, Marina Bay skyline
  singapore:   { sky:0x0a1024, fog:[600,2600], sun:0.18, amb:0.42, ambC:0x8090cc, ground:'urban', g1:'#24262e', g2:'#1e2027', turf:0x283228, tree:'palm', treeCount:60, stands:false, buildings:true, buildStyle:'tower', night:true },
};

// ------------------------------------------------------------
// Procedural textures
// ------------------------------------------------------------
function canvasTex(w, h, draw, repX, repY) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.encoding = THREE.sRGBEncoding;
  if (repX) tex.repeat.set(repX, repY || repX);
  return tex;
}

function skyTex(theme) {
  // Night skies need real horizontal resolution: this canvas wraps the whole
  // sky dome, so at 64px wide every 1px star was stretched into a long grey
  // smear across the sky (and the moon into a streak). Day skies are pure
  // vertical gradients and stay cheap.
  const clouds = theme.skyStyle === 'overcast' || theme.skyStyle === 'broken';
  return canvasTex(theme.night ? 2048 : clouds ? 1024 : 64, 512, (ctx,w,h) => {
    const c = '#' + theme.sky.toString(16).padStart(6,'0');
    const grd = ctx.createLinearGradient(0,0,0,h);
    if (theme.skyStyle === 'overcast') {
      // a low grey lid: brighter where the sun is behind it, darker overhead
      grd.addColorStop(0, '#7d8792'); grd.addColorStop(0.45, '#9aa4ae');
      grd.addColorStop(0.72, '#c3cad0'); grd.addColorStop(0.82, '#d0d5d9'); grd.addColorStop(1, c);
    } else if (theme.night) {
      grd.addColorStop(0, '#03040c');
      grd.addColorStop(0.55, c);
      grd.addColorStop(0.75, '#232c52');
      grd.addColorStop(1, c);
    } else {
      // deeper blue overhead easing into a bright, hazy horizon band — this
      // gradient is what gives distant scenery its sense of depth
      grd.addColorStop(0, '#2f6bb0');
      grd.addColorStop(0.28, '#4a86c8');
      grd.addColorStop(0.55, c);
      grd.addColorStop(0.70, '#cfe0f0');
      grd.addColorStop(0.78, '#e8f0f7');
      grd.addColorStop(0.88, '#dbe7f1');
      grd.addColorStop(1, c);
    }
    ctx.fillStyle = grd; ctx.fillRect(0,0,w,h);
    if (clouds) {
      // soft cloud banks. Drawn 2x wide (the dome stretches x by 2) and
      // denser toward the horizon, where perspective packs cloud together.
      let sd = 4242; const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      const n = theme.skyStyle === 'overcast' ? 260 : 110;
      for (let i = 0; i < n; i++) {
        const y = h * (0.12 + Math.pow(r(), 0.6) * 0.62);
        const x = r() * w, rad = (theme.skyStyle === 'overcast' ? 30 : 18) + r() * 40 * (y / h);
        const shade = theme.skyStyle === 'overcast' ? 150 + r() * 60 : 225 + r() * 30;
        const a = theme.skyStyle === 'overcast' ? 0.18 + r() * 0.2 : 0.35 + r() * 0.4;
        ctx.save(); ctx.translate(x, y); ctx.scale(2.2, 0.8);
        const g = ctx.createRadialGradient(0, 0, 1, 0, 0, rad);
        g.addColorStop(0, 'rgba(' + shade + ',' + shade + ',' + (shade + 6) + ',' + a.toFixed(2) + ')');
        g.addColorStop(1, 'rgba(' + shade + ',' + shade + ',' + (shade + 6) + ',0)');
        ctx.fillStyle = g; ctx.fillRect(-rad, -rad, rad * 2, rad * 2);
        ctx.restore();
        // wrap the seam so the dome has no visible join
        if (x < rad * 2.2) { ctx.save(); ctx.translate(x + w, y); ctx.scale(2.2, 0.8); ctx.fillStyle = g; ctx.fillRect(-rad, -rad, rad*2, rad*2); ctx.restore(); }
      }
    }
    if (!theme.night && theme.skyStyle !== 'overcast') {
      // soft haze thickening toward the horizon line
      const haze = ctx.createLinearGradient(0, h*0.6, 0, h*0.82);
      haze.addColorStop(0, 'rgba(255,255,255,0)');
      haze.addColorStop(1, 'rgba(255,255,255,0.30)');
      ctx.fillStyle = haze; ctx.fillRect(0, h*0.6, w, h*0.24);
    }
    if (theme.night) {
      // stars: point-sized, thinning toward the horizon glow
      for (let i=0;i<1400;i++) {
        const y = Math.pow(Math.random(), 1.6) * h*0.52;
        const a = (0.25+Math.random()*0.75) * (1 - y/(h*0.6));
        ctx.fillStyle = 'rgba(235,240,255,' + a.toFixed(2) + ')';
        const s = Math.random() < 0.06 ? 2 : 1;
        ctx.fillRect(Math.random()*w, y, s, s);
      }
      // moon with a soft halo. The dome maps 2048px round the full circle but
      // 512px over only half of it vertically, so a horizontal pixel covers
      // half the angle of a vertical one — draw everything 2x wide to land
      // round on screen.
      const mx = w*0.7, my = h*0.22;
      ctx.save(); ctx.translate(mx, my); ctx.scale(2, 1);
      const halo = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
      halo.addColorStop(0, 'rgba(232,228,216,0.35)'); halo.addColorStop(1, 'rgba(232,228,216,0)');
      ctx.fillStyle = halo; ctx.fillRect(-30, -30, 60, 60);
      ctx.fillStyle = '#ece8dc';
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, 7); ctx.fill();
      ctx.restore();
    }
  });
}

function barrierTex(night) {
  return canvasTex(64, 32, (ctx,w,h) => {
    ctx.fillStyle = night ? '#31435f' : '#c8342c';
    ctx.fillRect(0,0,w/2,h);
    ctx.fillStyle = '#e8eaee';
    ctx.fillRect(w/2,0,w/2,h);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0,h-5,w,5);
  });
}

const ASPHALT_GAIN = 6.0;
function asphaltTex() {
  return canvasTex(256, 256, (ctx,w,h) => {
    ctx.fillStyle = '#3d3d44'; ctx.fillRect(0,0,w,h);
    for (let i=0;i<4200;i++) {
      const v = 46 + Math.random()*28;
      ctx.fillStyle = 'rgb('+v+','+v+','+(v+6)+')';
      ctx.fillRect(Math.random()*w, Math.random()*h, 2, 2);
    }
    // rubbered-in groove
    const grd = ctx.createLinearGradient(0,0,w,0);
    grd.addColorStop(0,'rgba(0,0,0,0)');
    grd.addColorStop(0.32,'rgba(8,8,10,0.42)');
    grd.addColorStop(0.68,'rgba(8,8,10,0.42)');
    grd.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = grd; ctx.fillRect(0,0,w,h);
    // faint longitudinal streaks
    for (let i=0;i<26;i++) {
      const x = w*0.3 + Math.random()*w*0.4;
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(x, 0, 1.5, h);
    }
  }, 1, 40);
}

function groundTex(theme) {
  return canvasTex(512, 512, (ctx,w,h) => {
    if (theme.ground === 'stripes') {
      for (let i=0;i<8;i++) {
        ctx.fillStyle = i%2 ? theme.g1 : theme.g2;
        ctx.fillRect(0, i*h/8, w, h/8);
      }
      for (let i=0;i<2500;i++) {
        ctx.fillStyle = 'rgba(0,40,0,0.15)';
        ctx.fillRect(Math.random()*w, Math.random()*h, 2, 2);
      }
    } else if (theme.ground === 'sand') {
      ctx.fillStyle = theme.g1; ctx.fillRect(0,0,w,h);
      for (let i=0;i<5000;i++) {
        ctx.fillStyle = Math.random()>0.5 ? theme.g2 : 'rgba(255,240,200,0.12)';
        ctx.fillRect(Math.random()*w, Math.random()*h, 2, 2);
      }
    } else {
      // real mown grass: cut stripes at two scales, blade noise, wear patches
      ctx.fillStyle = theme.g1; ctx.fillRect(0,0,w,h);
      for (let i=0;i<16;i++) {
        ctx.fillStyle = i%2 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.07)';
        ctx.fillRect(0, i*h/16, w, h/16);
      }
      for (let i=0;i<4;i++) { // wider mower passes crossing the stripes
        ctx.fillStyle = i%2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.04)';
        ctx.fillRect(i*w/4, 0, w/4, h);
      }
      ctx.strokeStyle = theme.g2; ctx.lineWidth = 1;
      for (let i=0;i<9000;i++) {
        const x = Math.random()*w, y = Math.random()*h;
        ctx.globalAlpha = 0.10 + Math.random()*0.22;
        ctx.beginPath(); ctx.moveTo(x,y);
        ctx.lineTo(x + (Math.random()*2-1)*1.8, y - 1 - Math.random()*2.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (let i=0;i<40;i++) { // dry, worn patches
        const x = Math.random()*w, y = Math.random()*h, r = 10 + Math.random()*34;
        const p = ctx.createRadialGradient(x,y,1, x,y,r);
        p.addColorStop(0, 'rgba(158,146,88,0.22)');
        p.addColorStop(1, 'rgba(158,146,88,0)');
        ctx.fillStyle = p;
        ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill();
      }
    }
  }, 40, 40);
}

// Kerb wear: a greyscale scuff/dirt sheet multiplied over the red or white
// base colour, so painted concrete reads as worn rather than flat plastic.
// One texture serves both stripes — the material colour does the tinting.
function kerbWearTex() {
  return canvasTex(128, 128, (ctx,w,h) => {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,w,h);
    // grime settling into the joints at each end of the block
    const edge = ctx.createLinearGradient(0,0,0,h);
    edge.addColorStop(0,   'rgba(60,55,50,0.55)');
    edge.addColorStop(0.14,'rgba(255,255,255,0)');
    edge.addColorStop(0.86,'rgba(255,255,255,0)');
    edge.addColorStop(1,   'rgba(60,55,50,0.55)');
    ctx.fillStyle = edge; ctx.fillRect(0,0,w,h);
    // rubber laid down on the inner half, where cars actually run over it
    const rub = ctx.createLinearGradient(0,0,w,0);
    rub.addColorStop(0,   'rgba(40,38,40,0.42)');
    rub.addColorStop(0.45,'rgba(255,255,255,0)');
    ctx.fillStyle = rub; ctx.fillRect(0,0,w,h);
    // chipped paint and aggregate speckle
    for (let i=0;i<420;i++) {
      const g = 150 + Math.random()*90;
      ctx.fillStyle = 'rgba('+(g|0)+','+(g|0)+','+((g*0.97)|0)+',' + (0.10+Math.random()*0.22) + ')';
      const s = 1 + Math.random()*2.6;
      ctx.fillRect(Math.random()*w, Math.random()*h, s, s);
    }
    for (let i=0;i<26;i++) { // knocks along the leading edge
      ctx.fillStyle = 'rgba(90,86,80,0.5)';
      ctx.fillRect(Math.random()*w*0.25, Math.random()*h, 2+Math.random()*5, 1+Math.random()*3);
    }
  });
}

// Roughness companion for the kerbs: worn/rubbered areas are smoother than
// the raw concrete, which is what makes them glint at a low sun angle.
function kerbRoughTex() {
  return canvasTex(128, 128, (ctx,w,h) => {
    ctx.fillStyle = '#b4b4b4'; ctx.fillRect(0,0,w,h); // rough concrete
    const rub = ctx.createLinearGradient(0,0,w,0);
    rub.addColorStop(0,   '#5a5a5a');   // polished by tyres
    rub.addColorStop(0.5, '#b4b4b4');
    ctx.fillStyle = rub; ctx.fillRect(0,0,w,h);
    for (let i=0;i<600;i++) {
      const g = 140 + Math.random()*80;
      ctx.fillStyle = 'rgba('+(g|0)+','+(g|0)+','+(g|0)+',0.5)';
      ctx.fillRect(Math.random()*w, Math.random()*h, 2, 2);
    }
  });
}

function windowTex(night) {
  return canvasTex(128, 256, (ctx,w,h) => {
    ctx.fillStyle = night ? '#10131f' : '#8f98a5';
    ctx.fillRect(0,0,w,h);
    for (let y=6;y<h-6;y+=14) {
      for (let x=6;x<w-6;x+=12) {
        if (night) {
          ctx.fillStyle = Math.random()<0.55 ? (Math.random()<0.85?'#ffd77a':'#aee3ff') : '#1b2030';
        } else {
          ctx.fillStyle = Math.random()<0.3 ? '#c9d8e8' : '#3d4a5c';
        }
        ctx.fillRect(x, y, 7, 9);
      }
    }
  });
}

function crowdTex() {
  return canvasTex(256, 128, (ctx,w,h) => {
    ctx.fillStyle = '#2a2d38'; ctx.fillRect(0,0,w,h);
    const cols = ['#e14444','#eee','#4a7de1','#e1b84a','#4ae17d','#e17d4a','#b04ae1','#333'];
    for (let y=4;y<h;y+=9) {
      for (let x=2;x<w;x+=6) {
        ctx.fillStyle = cols[Math.floor(Math.random()*cols.length)];
        ctx.beginPath(); ctx.arc(x+Math.random()*2, y+Math.random()*2, 2.4, 0, 7); ctx.fill();
      }
    }
  });
}

function boardTex(text, bg, fg) {
  return canvasTex(512, 64, (ctx,w,h) => {
    ctx.fillStyle = bg; ctx.fillRect(0,0,w,h);
    ctx.fillStyle = fg;
    ctx.font = '900 44px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w/2, h/2+2);
  });
}

// normal map: procedural aggregate bumps (RGB-encoded surface normals)
function asphaltNormalTex() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const ctx = cv.getContext('2d');
  // height field
  const hgt = new Float32Array(128*128);
  for (let i=0;i<hgt.length;i++) hgt[i] = Math.random();
  // blur once
  const sm = new Float32Array(128*128);
  for (let y=0;y<128;y++) for (let x=0;x<128;x++) {
    let s=0;
    for (let oy=-1;oy<=1;oy++) for (let ox=-1;ox<=1;ox++)
      s += hgt[((y+oy+128)%128)*128 + ((x+ox+128)%128)];
    sm[y*128+x] = s/9;
  }
  const img = ctx.createImageData(128,128);
  for (let y=0;y<128;y++) for (let x=0;x<128;x++) {
    const dx = sm[y*128+((x+1)%128)] - sm[y*128+((x-1+128)%128)];
    const dy = sm[((y+1)%128)*128+x] - sm[((y-1+128)%128)*128+x];
    const i4 = (y*128+x)*4;
    img.data[i4]   = 128 + dx*220;
    img.data[i4+1] = 128 + dy*220;
    img.data[i4+2] = 255;
    img.data[i4+3] = 255;
  }
  ctx.putImageData(img,0,0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// roughness map: rubbered racing line is smoother (reflective) than the edges
function asphaltRoughTex() {
  return canvasTex(128, 128, (ctx,w,h) => {
    ctx.fillStyle = '#ececec'; ctx.fillRect(0,0,w,h);
    const grd = ctx.createLinearGradient(0,0,w,0);
    grd.addColorStop(0,'rgba(120,120,120,0)');
    grd.addColorStop(0.35,'rgba(120,120,120,0.85)');
    grd.addColorStop(0.65,'rgba(120,120,120,0.85)');
    grd.addColorStop(1,'rgba(120,120,120,0)');
    ctx.fillStyle = grd; ctx.fillRect(0,0,w,h);
  });
}

function upNormals(geo, count) {
  const n = new Float32Array(count*3);
  for (let i=0;i<count;i++) n[i*3+1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(n,3));
}

// ------------------------------------------------------------
// Build all scene meshes for a track. Returns group.
// ------------------------------------------------------------
function buildTrackScene(track, scene, themeName) {
  const theme = THEMES[themeName] || THEMES.green;
  const grp = new THREE.Group();
  const N = track.n, hw = track.width/2;
  const boff = track.wallOff + 0.8; // visual barrier just beyond the physics wall
  let rnd = 987654;
  const rand = () => { rnd = (rnd*16807)%2147483647; return rnd/2147483647; };
  const H = (k, lat) => track.heightAt(k, lat); // road-surface height helper

  // generic banked/elevated ribbon between lateral offsets o1..o2
  function ribbon(o1, o2, mat, yLift, uvAlong) {
    const v = new Float32Array((N+1)*2*3);
    const uv2 = new Float32Array((N+1)*2*2);
    const ia = [];
    for (let i=0;i<=N;i++) {
      const k=i%N;
      v[i*6+0]=track.px[k]+track.nx[k]*o1; v[i*6+1]=H(k,o1)+yLift; v[i*6+2]=track.pz[k]+track.nz[k]*o1;
      v[i*6+3]=track.px[k]+track.nx[k]*o2; v[i*6+4]=H(k,o2)+yLift; v[i*6+5]=track.pz[k]+track.nz[k]*o2;
      uv2[i*4+0]=0; uv2[i*4+1]=i*(uvAlong||0.02);
      uv2[i*4+2]=1; uv2[i*4+3]=i*(uvAlong||0.02);
      if (i<N){const a=i*2;ia.push(a,a+1,a+2, a+1,a+3,a+2);}
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(v,3));
    gg.setAttribute('uv', new THREE.BufferAttribute(uv2,2));
    gg.setIndex(ia);
    upNormals(gg, (N+1)*2);
    const m = new THREE.Mesh(gg, mat);
    m.userData.ground = true; // receives shadow, doesn't cast one
    return m;
  }

  // --- road (banked, elevated, PBR: albedo + normal + roughness) ---
  {
    const maxAniso = (typeof renderer !== 'undefined' && renderer.capabilities)
      ? renderer.capabilities.getMaxAnisotropy() : 8;
    const albedo = asphaltTex(); albedo.anisotropy = maxAniso;
    const nrm = asphaltNormalTex(); nrm.repeat.set(1, 40);
    const rgh = asphaltRoughTex(); rgh.repeat.set(1, 40);
    const roadMat = new THREE.MeshStandardMaterial({
      map: albedo,
      normalMap: nrm,
      normalScale: new THREE.Vector2(0.4, 0.4),
      roughnessMap: rgh,
      roughness: 1.0,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    roadMat.envMapIntensity = 0.18; // asphalt barely reflects the sky/env
    // The canvas asphalt averages ~44/255 sRGB = ~2.6% linear reflectance;
    // real asphalt is 5-12%, and after ACES tone mapping 2.6% read as a black
    // void in every view, day and night. Lifting it 6x (linear) lands the
    // average near 15% — mid-grey tarmac with visible grain and a darker
    // rubbered line, and the car now stands out against it.
    roadMat.color.setScalar(ASPHALT_GAIN);
    grp.add(ribbon(hw, -hw, roadMat, 0.05, 0.02));
  }

  // --- white edge lines ---
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xdddddd, roughness: 0.62, metalness: 0.0, side: THREE.DoubleSide });
  grp.add(ribbon(hw-0.35, hw, lineMat, 0.075));
  grp.add(ribbon(-hw, -hw+0.35, lineMat, 0.075));

  // --- synthetic turf strip outside the white lines ---
  const turfMat = new THREE.MeshStandardMaterial({
    color: theme.turf, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
  grp.add(ribbon(hw+0.02, hw+1.15, turfMat, 0.045));
  grp.add(ribbon(-hw-1.15, -hw-0.02, turfMat, 0.045));

  // --- kerbs (raised sawtooth blocks, merged: 2 draw calls total) ---
  // Painted concrete: a shared wear sheet tinted red or white, plus a
  // roughness map so the rubbered-in inner edge catches the sun.
  const kerbThresh = 0.008;
  const kerbWear = kerbWearTex(), kerbRough = kerbRoughTex();
  const kerbMatR = new THREE.MeshStandardMaterial({
    color: 0xd63030, map: kerbWear, roughnessMap: kerbRough,
    roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide });
  const kerbMatW = new THREE.MeshStandardMaterial({
    color: 0xe8e8e8, map: kerbWear, roughnessMap: kerbRough,
    roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide });
  const kerbAcc = { r: {v:[], uv:[], i:[]}, w: {v:[], uv:[], i:[]} };
  let i = 0;
  const cornerCenters = [];
  const corners = [];
  while (i < N) {
    if (Math.abs(track.curv[i]) > kerbThresh) {
      let j = i;
      while (j < N && Math.abs(track.curv[j % N]) > kerbThresh*0.6) j++;
      const side = track.curv[i] > 0 ? 1 : -1;
      const segLen = j - i;
      if (segLen > 6) {
        corners.push({ start: i, end: j, side });
        cornerCenters.push(Math.floor((i+j)/2) % N);
        const step = 4;
        for (let s=i; s<j; s+=step) {
          const k = s % N;
          const even = Math.floor(s/step)%2===0;
          const acc = even ? kerbAcc.r : kerbAcc.w;
          const o1 = side*hw, o2 = side*(hw+1.4);
          const k2 = Math.min(s+step, j) % N;
          const lift = even ? 0.12 : 0.08; // sawtooth
          const b = acc.v.length / 3;
          acc.v.push(
            track.px[k]+track.nx[k]*o1, H(k,o1)+lift, track.pz[k]+track.nz[k]*o1,
            track.px[k]+track.nx[k]*o2, H(k,o2)+0.05, track.pz[k]+track.nz[k]*o2,
            track.px[k2]+track.nx[k2]*o1, H(k2,o1)+lift, track.pz[k2]+track.nz[k2]*o1,
            track.px[k2]+track.nx[k2]*o2, H(k2,o2)+0.05, track.pz[k2]+track.nz[k2]*o2
          );
          // u runs across the kerb (0 = track edge, where the rubber is),
          // v runs along it, one texture tile per block
          acc.uv.push(0,0, 1,0, 0,1, 1,1);
          acc.i.push(b, b+1, b+2, b+1, b+3, b+2);
        }
      }
      i = j + 1;
    } else i++;
  }
  [[kerbAcc.r, kerbMatR], [kerbAcc.w, kerbMatW]].forEach(([acc, mat]) => {
    if (!acc.i.length) return;
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(acc.v), 3));
    gg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(acc.uv), 2));
    gg.setIndex(acc.i);
    gg.computeVertexNormals();
    grp.add(new THREE.Mesh(gg, mat));
  });

  // --- gravel traps outside significant corners (permanent circuits) ---
  if (!theme.buildings) {
    const gravelMat = new THREE.MeshStandardMaterial({
      color: theme.ground === 'sand' ? 0x94805a : 0xc2ad7e,
      roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide });
    corners.forEach(({start, end, side}) => {
      if (end - start < 14) return;
      const out = -side;
      const verts2 = [], idx2 = [];
      let vi = 0;
      for (let s = start; s <= end; s += 3) {
        const k = s % N;
        const o1 = out*(hw + 1.5), o2 = out*(hw + 7.5);
        verts2.push(
          track.px[k]+track.nx[k]*o1, H(k,o1)+0.04, track.pz[k]+track.nz[k]*o1,
          track.px[k]+track.nx[k]*o2, H(k,o2)+0.03, track.pz[k]+track.nz[k]*o2
        );
        if (vi > 0) { const a=(vi-1)*2; idx2.push(a,a+1,a+2, a+1,a+3,a+2); }
        vi++;
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts2),3));
      gg.setIndex(idx2);
      upNormals(gg, vi*2);
      grp.add(new THREE.Mesh(gg, gravelMat));
    });
  }

  // --- skid marks into braking zones ---
  {
    const skidMat = new THREE.MeshBasicMaterial({ color: 0x0c0c10, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
    const sampleM = track.length / N;
    corners.forEach(({start, side}, ci) => {
      if (ci % 2) return;
      const from = ((start - Math.round(55 / sampleM)) % N + N) % N;
      const len = Math.round(65 / sampleM);
      [-0.9, 0.9].forEach(lat0 => {
        const verts2 = [], idx2 = [];
        let vi = 0;
        for (let s=0; s<=len; s+=2) {
          const k = (from + s) % N;
          const drift = (s/len) * side * 1.6;
          const o1 = lat0 + drift - 0.18, o2 = lat0 + drift + 0.18;
          verts2.push(
            track.px[k]+track.nx[k]*o1, H(k,o1)+0.065, track.pz[k]+track.nz[k]*o1,
            track.px[k]+track.nx[k]*o2, H(k,o2)+0.065, track.pz[k]+track.nz[k]*o2
          );
          if (vi>0){ const a=(vi-1)*2; idx2.push(a,a+1,a+2, a+1,a+3,a+2); }
          vi++;
        }
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts2),3));
        gg.setIndex(idx2);
        upNormals(gg, vi*2);
        grp.add(new THREE.Mesh(gg, skidMat));
      });
    });
  }

  // --- brake marker boards: 150 / 100 / 50 m before EVERY braking corner ---
  // Real circuits carry white-on-blue distance boards on the outside of the
  // corner. Only proper braking corners get them — long open sweepers that are
  // taken flat have none, same as the real thing.
  {
    const mkTex = { 150: boardTex('150', '#0a2a6b', '#fff'),
                    100: boardTex('100', '#0a2a6b', '#fff'),
                     50: boardTex('50',  '#0a2a6b', '#fff') };
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3c4350, roughness: 0.55, metalness: 0.25 });
    const sampleM = track.length / N;
    corners.forEach(({start, end, side}) => {
      // peak curvature through the corner decides whether it needs braking
      let peak = 0;
      for (let s = start; s < end; s++) peak = Math.max(peak, Math.abs(track.curv[s % N]));
      if (peak < 0.011) return; // fast kink — no boards
      [150, 100, 50].forEach(m => {
        const k = ((start - Math.round(m / sampleM)) % N + N) % N;
        const p = track.posAt(k, -side*(boff - 0.9));
        const y0 = track.py[k];
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.12), postMat);
        post.position.set(p.x, y0+0.8, p.z);
        grp.add(post);
        const bd = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.08),
          new THREE.MeshBasicMaterial({ map: mkTex[m] }));
        bd.position.set(p.x, y0+2.0, p.z);
        bd.rotation.y = Math.atan2(track.tx[k], track.tz[k]);
        grp.add(bd);
      });
    });
  }

  // --- DRS detection / activation signage ---
  // A painted line across the road plus a gantry board on both sides, so the
  // detection point is something you can actually aim for on the lap.
  if (track.drsZones && track.drsZones.length) {
    const lineMatY = new THREE.MeshBasicMaterial({ color: 0xffd12e });
    const lineMatG = new THREE.MeshBasicMaterial({ color: 0x2ecc71 });
    const postMat  = new THREE.MeshStandardMaterial({ color: 0x3c4350, roughness: 0.55, metalness: 0.25 });
    const texDet = boardTex('DRS DETECTION', '#141414', '#ffd12e');
    const texAct = boardTex('DRS', '#0a2a0a', '#2ecc71');
    const texEnd = boardTex('DRS END', '#141414', '#9fb0cc');
    const mark = (k, mat, tex, width) => {
      const ang = Math.atan2(track.tx[k], track.tz[k]);
      // road line
      const ln = new THREE.Mesh(new THREE.PlaneGeometry(track.width, 0.55), mat);
      ln.rotation.order = 'YXZ';   // same convention as the start/finish squares
      ln.rotation.y = ang;
      ln.rotation.x = -Math.PI/2;
      const c = track.posAt(k, 0);
      ln.position.set(c.x, H(k, 0) + 0.035, c.z);
      grp.add(ln);
      // boards either side
      [1, -1].forEach(sd => {
        const p = track.posAt(k, sd*(boff - 0.8));
        const y0 = track.py[k];
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.2, 0.14), postMat);
        post.position.set(p.x, y0+1.1, p.z);
        grp.add(post);
        const bd = new THREE.Mesh(new THREE.BoxGeometry(width, 0.85, 0.08),
          new THREE.MeshBasicMaterial({ map: tex }));
        bd.position.set(p.x, y0+2.7, p.z);
        bd.rotation.y = ang;
        grp.add(bd);
      });
    };
    track.drsZones.forEach(z => {
      mark(z.detIdx, lineMatY, texDet, 5.2);
      mark(z.startIdx, lineMatG, texAct, 2.6);
      mark(z.endIdx, lineMatY, texEnd, 3.4);
    });
  }

  // --- start/finish checkers ---
  {
    const sq = 1.2;
    const cols = Math.floor(track.width / sq);
    const ang = Math.atan2(track.tx[2], track.tz[2]);
    for (let r=0;r<2;r++) {
      for (let c=0;c<cols;c++) {
        if ((r+c)%2) continue;
        const lat = -hw + c*sq + sq/2;
        const p = track.posAt(2 + r*2, lat);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(sq, sq),
          new THREE.MeshBasicMaterial({ color: 0xffffff }));
        m.rotation.order = 'YXZ';
        m.rotation.y = ang;
        m.rotation.x = -Math.PI/2;
        m.position.set(p.x, H(2+r*2, lat)+0.11, p.z);
        grp.add(m);
      }
    }
  }

  // --- bounds ---
  let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
  for (let k=0;k<N;k++){
    minX=Math.min(minX,track.px[k]); maxX=Math.max(maxX,track.px[k]);
    minZ=Math.min(minZ,track.pz[k]); maxZ=Math.max(maxZ,track.pz[k]);
  }
  const cx=(minX+maxX)/2, cz=(minZ+maxZ)/2;
  const span=Math.max(maxX-minX,maxZ-minZ)+1200;

  // --- per-circuit scenery (scenery.js): water mask first — the terrain needs it ---
  if (typeof prepareScenery === 'function') prepareScenery(track, theme);

  // --- terrain height query (blends toward track elevation near the circuit) ---
  function terrainY(x, z) {
    // Take the LOWEST nearby road elevation, not just the nearest sample's.
    // Where a circuit doubles back on itself — Monaco is full of it — a patch
    // of ground can sit between two road sections at different heights. Using
    // the nearest sample meant the terrain took the HIGHER of the two and then
    // punched up through the lower road. The search radius is deliberately
    // small: at 70 m it also dragged the ground far below the road on any
    // gradient, which on Monaco's 20 m of elevation opened gaps up to 10 m
    // deep beside the track that you could see straight through.
    let bd = Infinity, bi = 0, loY = Infinity;
    for (let q=0;q<N;q+=6){
      const dx=track.px[q]-x, dz=track.pz[q]-z;
      const dd=dx*dx+dz*dz;
      if (dd<bd){bd=dd;bi=q;}
      if (dd < 625 && track.py[q] < loY) loY = track.py[q];    // within 25 m
    }
    const d = Math.sqrt(bd);
    const base = Math.min(track.py[bi], isFinite(loY) ? loY : track.py[bi]);
    // 0.55 m is the smallest clearance that keeps the ground out of the road
    // on every circuit (measured); any less and Austria, Belgium and Brazil
    // start punching through again. Keeping it tight matters because the car
    // has to sit on this when it runs wide.
    const CLEAR = 0.55;
    // water (Monaco harbour, Marina Bay): drop the ground under the sea level
    // plane, keeping a margin of land along the road
    if (track._water && d > hw + 14 && track._water(x, z)) return track._seaY - 6;
    if (d < 55) return base - CLEAR;
    let t01 = Math.min(1, (d-55)/180);
    t01 = t01*t01*(3-2*t01); // smoothstep
    const rolling = 3.5*Math.sin(x*0.004)*Math.cos(z*0.0047) + 1.5*Math.sin(x*0.011+z*0.009);
    return (base-CLEAR)*(1-t01) + rolling*t01;
  }

  // --- terrain mesh (sculpted ground, no more flatland) ---
  {
    const RES = 150; // fine enough that hilly tracks don't clip the road
    const verts2 = new Float32Array((RES+1)*(RES+1)*3);
    const uv2 = new Float32Array((RES+1)*(RES+1)*2);
    const idx2 = [];
    for (let gy=0; gy<=RES; gy++) {
      for (let gx=0; gx<=RES; gx++) {
        const vi = gy*(RES+1)+gx;
        const x = cx - span/2 + gx/RES*span;
        const z = cz - span/2 + gy/RES*span;
        verts2[vi*3+0]=x;
        verts2[vi*3+1]=terrainY(x,z);
        verts2[vi*3+2]=z;
        uv2[vi*2+0]=gx/RES*40;
        uv2[vi*2+1]=gy/RES*40;
        if (gx<RES && gy<RES) {
          const a=vi, b=vi+1, c=vi+RES+1, dd=vi+RES+2;
          idx2.push(a,c,b, b,c,dd);
        }
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(verts2,3));
    gg.setAttribute('uv', new THREE.BufferAttribute(uv2,2));
    gg.setIndex(idx2);
    gg.computeVertexNormals();
    const tx = groundTex(theme);
    tx.repeat.set(1,1);
    const ground = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({
      map: tx, roughness: 0.98, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }));
    ground.userData.ground = true;
    grp.add(ground);
  }

  // the car needs this to sit on the ground when it runs off the road
  track.terrainY = terrainY;

  // --- skirt under the road edge ---
  // The road is a ribbon floating above a separately generated ground mesh, so
  // wherever the two diverge there is an open gap you can see under. Rather
  // than trying to make the terrain follow the road exactly — impossible on a
  // 150x150 grid — close the gap with a vertical apron dropped from the verge
  // down past the ground on both sides.
  {
    const skirtM = new THREE.MeshStandardMaterial({
      color: theme.night ? 0x1b1d24 : 0x3f4048, roughness: 0.95, metalness: 0.0,
      side: THREE.DoubleSide });
    [1, -1].forEach(side => {
      const off = side * (hw + 1.15);
      const v = new Float32Array((N+1)*2*3), uv = new Float32Array((N+1)*2*2), ia = [];
      for (let i2 = 0; i2 <= N; i2++) {
        const k = i2 % N;
        const p = track.posAt(k, off);
        const top = H(k, off) + 0.04;
        const ground = terrainY(p.x, p.z) - 1.5;   // always finish below the dirt
        v[i2*6+0]=p.x; v[i2*6+1]=top;    v[i2*6+2]=p.z;
        v[i2*6+3]=p.x; v[i2*6+4]=ground; v[i2*6+5]=p.z;
        uv[i2*4+0]=0; uv[i2*4+1]=i2*0.05; uv[i2*4+2]=1; uv[i2*4+3]=i2*0.05;
        if (i2 < N) { const b = i2*2; ia.push(b,b+1,b+2, b+1,b+3,b+2); }
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(v,3));
      gg.setAttribute('uv', new THREE.BufferAttribute(uv,2));
      gg.setIndex(ia); gg.computeVertexNormals();
      const m = new THREE.Mesh(gg, skirtM);
      m.userData.ground = true;      // receives shadow, doesn't cast
      grp.add(m);
    });
  }

  // --- barriers (striped) + catch fencing, following elevation ---
  const bTex = barrierTex(theme.night);
  function wallStrip(off, y1, y2, mat, uvScale, offFn) {
    const v = new Float32Array((N+1)*2*3);
    const uv2 = new Float32Array((N+1)*2*2);
    const ia=[];
    const offs = [];
    for (let i2=0;i2<=N;i2++) offs.push(offFn ? offFn(i2%N) : off);
    for (let i2=0;i2<=N;i2++){
      const k=i2%N;
      const o = offs[i2] == null ? off : offs[i2];
      const bx=track.px[k]+track.nx[k]*o, bz=track.pz[k]+track.nz[k]*o;
      const by=track.py[k];
      v[i2*6+0]=bx; v[i2*6+1]=by+y1; v[i2*6+2]=bz;
      v[i2*6+3]=bx; v[i2*6+4]=by+y2; v[i2*6+5]=bz;
      uv2[i2*4+0]=i2*uvScale; uv2[i2*4+1]=0;
      uv2[i2*4+2]=i2*uvScale; uv2[i2*4+3]=1;
      if(i2<N && offs[i2] != null && offs[i2+1] != null){const a=i2*2;ia.push(a,a+1,a+2, a+1,a+3,a+2);}
    }
    const gg=new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(v,3));
    gg.setAttribute('uv', new THREE.BufferAttribute(uv2,2));
    gg.setIndex(ia);
    return new THREE.Mesh(gg, mat);
  }
  const barrierMat = new THREE.MeshBasicMaterial({ map: bTex, side: THREE.DoubleSide });
  // the barrier walls are the one piece of scenery whose shadow lands on the
  // racing line, so they're the only tagged casters
  const wallA = wallStrip(boff, 0, 1.1, barrierMat, 0.35);
  // pit side: the barrier steps out around the pit lane, and the garages
  // themselves form the wall along the boxes
  const pitBar = k => pitSideBarrierOff(track, k, boff);
  const wallB = wallStrip(-boff, 0, 1.1, barrierMat, 0.35, pitBar);
  wallA.userData.caster = true; wallB.userData.caster = true;
  grp.add(wallA); grp.add(wallB);
  const fenceTex = canvasTex(64, 64, (ctx,w,h) => {
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle = 'rgba(120,128,145,0.85)';
    ctx.lineWidth = 2;
    for (let x=0;x<=w;x+=10) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
    for (let y=0;y<=h;y+=10) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  });
  const fenceMat = new THREE.MeshBasicMaterial({ map: fenceTex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  grp.add(wallStrip(boff, 1.1, 3.4, fenceMat, 0.5));
  grp.add(wallStrip(-boff, 1.1, 3.4, fenceMat, 0.5, pitBar));

  // --- sky dome ---
  {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 20, 14),
      new THREE.MeshBasicMaterial({ map: skyTex(theme), side: THREE.BackSide, fog: false }));
    dome.position.set(cx, 0, cz);
    grp.add(dome);
  }

  function clearOfTrack(x, z, r) {
    for (let q=0;q<N;q+=6){
      const dx=track.px[q]-x, dz=track.pz[q]-z;
      if (dx*dx+dz*dz < r*r) return false;
    }
    return true;
  }

  // --- ad boards along straights ---
  {
    const texts = [
      boardTex('F1 2026', '#111', '#fff'),
      boardTex('GRAND PRIX', '#e10600', '#fff'),
      boardTex(track.def.gp.toUpperCase(), '#0a1a3a', '#fff'),
      boardTex('APEX FUEL', '#0d4d2a', '#ffd12e'),
      boardTex('VELOCITA', '#222', '#4ad1ff'),
      boardTex('TURBO+', '#3a0d4d', '#ff7ad1'),
    ];
    let bi = 0;
    const stepB = Math.floor(N / (track.length/170));
    for (let k=0;k<N;k+=stepB) {
      if (Math.abs(track.curv[k]) > 0.004) continue;
      const side = (bi%2===0) ? 1 : -1;
      const off = side*(boff - 0.6);
      if (inPitComplex(track, k, off)) { bi++; continue; }
      const p = track.posAt(k, off);
      const board = new THREE.Mesh(new THREE.BoxGeometry(13, 1.3, 0.25),
        new THREE.MeshBasicMaterial({ map: texts[bi % texts.length] }));
      board.position.set(p.x, track.py[k]+1.7, p.z);
      // long axis along the track, printed face toward the road
      board.rotation.y = Math.atan2(track.tx[k], track.tz[k]) - Math.PI/2 + (side > 0 ? Math.PI : 0);
      grp.add(board);
      bi++;
    }
  }

  // --- grandstands ---
  if (theme.stands) {
    const crowd = crowdTex();
    const frameM = new THREE.MeshStandardMaterial({ color: 0x9aa2b0, roughness: 0.52, metalness: 0.30 });
    const crowdM = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9, metalness: 0.0 });
    const spots = [{k:8, side:1}].concat(
      cornerCenters.filter((c,ii)=>ii%3===0).slice(0,5).map(k => ({
        k, side: Math.abs(track.curv[k])>0.004 ? (track.curv[k]>0?-1:1) : 1
      })));
    spots.forEach(({k, side}) => {
      const off = side*(boff + 26);
      const p = track.posAt(k, off);
      if (!clearOfTrack(p.x, p.z, boff+14) || inPitComplex(track, k, off)) return;
      const y0 = terrainY(p.x, p.z);
      const stand = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(58, 1.8, 11), frameM);
      base.position.y = 0.9; stand.add(base);
      const seats = new THREE.Mesh(new THREE.BoxGeometry(58, 6, 9),
        [frameM, frameM, frameM, frameM, crowdM, frameM]);
      seats.position.set(0, 4.4, -1);
      seats.rotation.x = 0.32;
      stand.add(seats);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(60, 0.5, 11), frameM);
      roof.position.set(0, 8.6, -1.5); stand.add(roof);
      stand.position.set(p.x, y0, p.z);
      // long axis parallel to the track, crowd face toward the road
      stand.rotation.y = Math.atan2(track.tx[k], track.tz[k]) - Math.PI/2 + (side>0 ? Math.PI : 0);
      grp.add(stand);
    });
  }

  // --- pit complex: lanes, wall, lines, team boxes and garages (pitlane.js) ---
  buildPitComplex(track, grp, theme, terrainY);

  // --- city buildings for street circuits ---
  // buildStyle 'riviera' (Monaco): pastel stucco blocks with terracotta roofs,
  // stacked up the hillside in rows; 'tower' (Singapore): a dense skyline of
  // lit glass towers. Default: the generic street-circuit blocks.
  if (theme.buildings) {
    const wtex = windowTex(theme.night);
    const style = theme.buildStyle;
    const heights = style === 'tower' ? [30, 160] : style === 'riviera' ? [14, 42] : theme.night ? [18, 90] : [12, 45];
    const rows = style ? 3 : 1;
    const bStep = Math.max(6, Math.floor(N/(style ? 180 : 140)));
    const PASTEL = [0xd9a866, 0xe0906a, 0xe8c45c, 0xc9805c, 0xdcbb92, 0xeadbbf, 0xbf9a62, 0xdca0a4];
    const roofM = new THREE.MeshStandardMaterial({ color: 0xa2553a, roughness: 0.85 });
    // Riviera façades: pastel stucco, rows of shuttered windows, balconies
    const facade = c => canvasTex(128, 256, (ctx, w, h) => {
      ctx.fillStyle = '#' + c.toString(16).padStart(6, '0'); ctx.fillRect(0, 0, w, h);
      const shut = ['#4f6b45', '#6b4a32', '#3f5f6e'][c % 3];
      for (let y = 10; y < h - 8; y += 22) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(0, y + 15, w, 2);        // balcony ledge
        for (let x = 8; x < w - 8; x += 20) {
          ctx.fillStyle = '#2a2f36'; ctx.fillRect(x, y, 8, 12);                         // window
          ctx.fillStyle = shut; ctx.fillRect(x - 3, y, 3, 12); ctx.fillRect(x + 8, y, 3, 12); // shutters
        }
      }
    });
    const rivMats = PASTEL.map(c => new THREE.MeshStandardMaterial({ map: facade(c), roughness: 0.8, metalness: 0.0 }));
    const towerM = theme.night ? new THREE.MeshBasicMaterial({ map: wtex })
      : new THREE.MeshStandardMaterial({ map: wtex, roughness: 0.22, metalness: 0.55 });
    // styled towns are merged by material (Monaco was ~600 separate meshes)
    const bgrp = style ? new THREE.Group() : grp;
    for (let row = 0; row < rows; row++)
    for (let k=row*3;k<N;k+=bStep) {
      if (rand() < (style ? 0.15 : 0.25)) continue;
      const side = style ? (rand() < 0.5 ? 1 : -1) : ((Math.floor(k/bStep)%2===0) ? 1 : -1);
      const w = 16 + rand()*22, dpt = 14 + rand()*16;
      const off = side*(boff + (style === 'tower' ? 26 : 10) + w/2 + rand()*8 + row * 42); // w is the cross-track dimension
      const x = track.px[k]+track.nx[k]*off, z = track.pz[k]+track.nz[k]*off;
      if (inPitComplex(track, k, off - Math.sign(off)*w/2)) continue;
      const rad = Math.hypot(w, dpt)/2 + hw + 3;
      if (!clearOfTrack(x, z, rad)) continue;
      if (track._sceneryClear && !track._sceneryClear(x, z, Math.hypot(w, dpt) / 2)) continue;
      // further back = taller (the town climbs the hill / the skyline rises)
      let h = heights[0] + rand()*(heights[1]-heights[0]) * (style ? 0.55 + row * 0.3 : 1);
      const y0 = terrainY(x,z);
      const rotY = Math.atan2(track.tx[k], track.tz[k]);
      if (style === 'riviera') {
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, dpt), rivMats[Math.floor(rand() * rivMats.length)]);
        b.position.set(x, y0 + h/2, z); b.rotation.y = rotY; b.userData.caster = row === 0; bgrp.add(b);
        const r = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 1.4, dpt + 1.2), roofM);
        r.position.set(x, y0 + h + 0.7, z); r.rotation.y = rotY; bgrp.add(r);
        continue;
      }
      const mat = style ? towerM : theme.night
        ? new THREE.MeshBasicMaterial({ map: wtex })
        : new THREE.MeshStandardMaterial({ map: wtex, roughness: 0.22, metalness: 0.55 });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, dpt), mat);
      b.position.set(x, y0 + h/2, z);
      b.rotation.y = rotY;
      bgrp.add(b);
    }
    if (style) { if (typeof _mergeStatic === 'function') _mergeStatic(bgrp, new Set()); grp.add(bgrp); }
  }

  // --- floodlights for night circuits ---
  if (theme.night) {
    const count = Math.floor(track.length / 60);
    const poleGeo = new THREE.CylinderGeometry(0.16, 0.22, 13, 5);
    const headGeo = new THREE.BoxGeometry(2.6, 0.5, 0.9);
    const poleMesh = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x646c80, roughness: 0.55, metalness: 0.25 }), count);
    const headMesh = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ color: 0xfff2c4 }), count);
    const m4 = new THREE.Matrix4();
    for (let li=0; li<count; li++) {
      const k = Math.floor(li/count*N);
      const side = li%2===0 ? 1 : -1;
      const p = track.posAt(k, side*(boff+1.2));
      const y0 = track.py[k];
      m4.makeRotationY(Math.atan2(track.tx[k], track.tz[k]));
      m4.setPosition(p.x, y0+6.5, p.z);
      poleMesh.setMatrixAt(li, m4);
      m4.setPosition(p.x, y0+12.9, p.z);
      headMesh.setMatrixAt(li, m4);
    }
    grp.add(poleMesh); grp.add(headMesh);
  }

  // --- vegetation (instanced, seated on terrain) ---
  if (theme.tree !== 'none' && theme.treeCount > 0) {
    const count = theme.treeCount;
    const positions = [];
    let attempts = 0;
    while (positions.length < count && attempts < count*8) {
      attempts++;
      const k = Math.floor(rand()*N);
      const side = rand()>0.5?1:-1;
      const near = theme.treeNear != null ? theme.treeNear : 10, far = theme.treeFar || 140;
      const off = side*(boff + near + rand()*far);
      const x = track.px[k]+track.nx[k]*off, z = track.pz[k]+track.nz[k]*off;
      if (!clearOfTrack(x, z, boff + Math.min(5, near)) || inPitComplex(track, k, off)) continue;
      if (track._sceneryClear && !track._sceneryClear(x, z, 4)) continue;   // landmarks, water
      const sc = theme.treeScale ? theme.treeScale[0] + rand() * (theme.treeScale[1] - theme.treeScale[0]) : 0.7 + rand()*0.7;
      positions.push([x, z, sc, terrainY(x,z), rand()]);
    }
    const m4 = new THREE.Matrix4();
    if (theme.tree === 'broadleaf' || theme.tree === 'mixed') {
      // deciduous park trees (Monza, Silverstone) — round crowns in a few
      // greens; 'mixed' adds conifers (Suzuka's wooded hills)
      const conifer = theme.tree === 'mixed' ? positions.filter(p => p[4] < 0.4) : [];
      const broad = theme.tree === 'mixed' ? positions.filter(p => p[4] >= 0.4) : positions;
      const crownG = new THREE.IcosahedronGeometry(4.2, 0);
      const trunkG = new THREE.CylinderGeometry(0.35, 0.55, 5, 5);
      const greens = [0x1f4a1c, 0x29561f, 0x1b3f18, 0x335f26];
      const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x4c3a28, roughness: 0.95 }), broad.length);
      const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), broad.length);
      const col = new THREE.Color();
      broad.forEach((p, ii) => {
        m4.makeScale(p[2], p[2], p[2]); m4.setPosition(p[0], p[3] + 2.5 * p[2], p[1]); trunks.setMatrixAt(ii, m4);
        const sq = 0.8 + p[4] * 0.4;
        m4.makeScale(p[2] * sq, p[2] * (1.15 - p[4] * 0.2), p[2] * sq); m4.setPosition(p[0], p[3] + 7.2 * p[2], p[1]); crowns.setMatrixAt(ii, m4);
        col.setHex(greens[Math.floor(p[4] * greens.length) % greens.length]); if (theme.night) col.multiplyScalar(0.45);
        crowns.setColorAt(ii, col);
      });
      grp.add(trunks); grp.add(crowns);
      if (conifer.length) {
        const coneG = new THREE.ConeGeometry(2.6, 8, 6);
        const cones = new THREE.InstancedMesh(coneG, new THREE.MeshStandardMaterial({ color: 0x1f4f22, roughness: 0.95 }), conifer.length);
        conifer.forEach((p, ii) => { m4.makeScale(p[2], p[2] * 1.2, p[2]); m4.setPosition(p[0], p[3] + 6.5 * p[2], p[1]); cones.setMatrixAt(ii, m4); });
        grp.add(cones);
      }
    } else if (theme.tree === 'pine') {
      const coneG = new THREE.ConeGeometry(2.6, 8, 6);
      const trunkG = new THREE.CylinderGeometry(0.4, 0.55, 2.6, 5);
      const cones = new THREE.InstancedMesh(coneG, new THREE.MeshStandardMaterial({ color: theme.night?0x0e2413:(theme.treeColor || 0x1d4d1e), roughness: 0.95, metalness: 0.0 }), positions.length);
      const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.95, metalness: 0.0 }), positions.length);
      positions.forEach((p, ii) => {
        const tall = theme.treeScale ? 1.5 : 1;          // spruce: slimmer and taller
        m4.makeScale(p[2] / Math.sqrt(tall), p[2] * tall, p[2] / Math.sqrt(tall));
        m4.setPosition(p[0], p[3]+6*p[2]*tall, p[1]);
        cones.setMatrixAt(ii, m4);
        m4.makeScale(p[2],p[2],p[2]);
        m4.setPosition(p[0], p[3]+1.2*p[2], p[1]);
        trunks.setMatrixAt(ii, m4);
      });
      grp.add(cones); grp.add(trunks);
    } else {
      const trunkG = new THREE.CylinderGeometry(0.25, 0.4, 7, 5);
      const crownG = new THREE.ConeGeometry(3.2, 1.6, 7);
      const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x7a6244, roughness: 0.95, metalness: 0.0 }), positions.length);
      const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: theme.night?0x14361c:0x2d7a35, roughness: 0.95, metalness: 0.0 }), positions.length);
      positions.forEach((p, ii) => {
        m4.makeScale(p[2],p[2],p[2]);
        m4.setPosition(p[0], p[3]+3.5*p[2], p[1]);
        trunks.setMatrixAt(ii, m4);
        m4.makeScale(p[2],p[2],p[2]);
        m4.setPosition(p[0], p[3]+7.4*p[2], p[1]);
        crowns.setMatrixAt(ii, m4);
      });
      grp.add(trunks); grp.add(crowns);
    }
  }

  // --- landmarks (scenery.js) ---
  if (typeof buildScenery === 'function') buildScenery(track, grp, theme, { terrainY, clearOfTrack, boff, rand });

  // --- start gantry ---
  {
    const p = track.posAt(4, 0);
    const y0 = track.py[4];
    const dirA = Math.atan2(track.tx[4], track.tz[4]);
    const gantry = new THREE.Group();
    const mG = new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.82, metalness: 0.0 });
    const pl = new THREE.Mesh(new THREE.BoxGeometry(0.5,7,0.5), mG);
    pl.position.set(-hw-1.5,3.5,0); gantry.add(pl);
    const pr = pl.clone(); pr.position.set(hw+1.5,3.5,0); gantry.add(pr);
    const beam = new THREE.Mesh(new THREE.BoxGeometry((hw+1.5)*2+0.5,1.6,0.8),
      new THREE.MeshBasicMaterial({ map: boardTex(track.def.gp.toUpperCase(), '#0a0a0f', '#ffffff') }));
    beam.position.set(0,6.8,0); gantry.add(beam);
    gantry.position.set(p.x,y0,p.z);
    gantry.rotation.y = dirA;
    grp.add(gantry);
  }

  // --- tunnel (Monaco) ---
  // Roof and side walls over a stretch of the lap. Built unlit and dark so it
  // reads as a covered section, with the far end open to daylight.
  {
    const span = (typeof TRACK_TUNNEL !== 'undefined') && TRACK_TUNNEL[track.def.id];
    if (span) {
      const i0 = Math.floor(span[0] * N), i1 = Math.floor(span[1] * N);
      const H_ROOF = 7.2, OUT = hw + 2.6;
      const wallM = new THREE.MeshStandardMaterial({
        color: theme.night ? 0x22252e : 0x6d6a63, roughness: 0.92, metalness: 0.0,
        side: THREE.DoubleSide });
      const roofM = new THREE.MeshStandardMaterial({
        color: 0x2a2823, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
      // sodium lamps down the middle, the thing that makes a tunnel read as one
      const lampM = new THREE.MeshBasicMaterial({ color: 0xffcc66 });
      const strip = (o1, o2, y1, y2, mat) => {
        const cnt = i1 - i0;
        const v = new Float32Array((cnt+1)*2*3), uv = new Float32Array((cnt+1)*2*2), ia = [];
        for (let s2 = 0; s2 <= cnt; s2++) {
          const k = (i0 + s2) % N;
          const a = track.posAt(k, o1), b = track.posAt(k, o2);
          v[s2*6+0]=a.x; v[s2*6+1]=track.py[k]+y1; v[s2*6+2]=a.z;
          v[s2*6+3]=b.x; v[s2*6+4]=track.py[k]+y2; v[s2*6+5]=b.z;
          uv[s2*4+0]=0; uv[s2*4+1]=s2*0.06; uv[s2*4+2]=1; uv[s2*4+3]=s2*0.06;
          if (s2 < cnt) { const q = s2*2; ia.push(q,q+1,q+2, q+1,q+3,q+2); }
        }
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.BufferAttribute(v,3));
        gg.setAttribute('uv', new THREE.BufferAttribute(uv,2));
        gg.setIndex(ia); gg.computeVertexNormals();
        const m = new THREE.Mesh(gg, mat);
        m.userData.noShadow = true;   // the tunnel shades itself, cheaply
        return m;
      };
      grp.add(strip(-OUT, -OUT, 0, H_ROOF, wallM));   // left wall
      grp.add(strip( OUT,  OUT, 0, H_ROOF, wallM));   // right wall
      grp.add(strip(-OUT,  OUT, H_ROOF, H_ROOF, roofM)); // roof
      // lamp strip just under the roof
      const lamp = strip(-0.9, 0.9, H_ROOF-0.35, H_ROOF-0.35, lampM);
      grp.add(lamp);
    }
  }

  // --- shadow flags ---
  // Unlit meshes (sky dome, painted lines, signage) sit out of the shadow pass
  // entirely. Ground surfaces receive but don't cast — the road casting onto
  // itself is invisible and doubles the shadow-pass cost.
  // Scenery RECEIVES shadows but almost none of it casts. Trees, grandstands,
  // fence posts and kerbs cast onto grass nobody is looking at, while costing
  // a full extra pass over thousands of instances. Only the barrier walls and
  // the pit building — the things that throw a shadow across the racing line —
  // are tagged as casters.
  grp.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (o.userData.noShadow || (m && m.isMeshBasicMaterial)) {
      o.castShadow = false; o.receiveShadow = false; return;
    }
    o.receiveShadow = true;
    o.castShadow = !!o.userData.caster;
  });

  scene.add(grp);
  return grp;
}

// ---------- pit lane geometry ----------
// The lane is an offset corridor on the pit side (negative lateral) running
// along the final straight: the car peels off the track before the line, runs
// past the garages behind a pit wall, stops in its box, and rejoins. Modelled
// as a lateral-offset function of lap distance so it slots into the existing
// centreline+offset world. Shared by the renderer (trackbuilder) and the pit
// driving logic (main.js).
function pitLaneGeom(track) {
  if (track._pitG) return track._pitG;
  const L = track.length, hw = track.width / 2, N = track.n;
  // Fit the pit lane to THIS circuit's start/finish straight. It used to be
  // the fixed last 340m before the line, which on many tracks ran through a
  // tight corner (Spa's Bus Stop R11m, COTA's last corner R12m, Shanghai,
  // Abu Dhabi...). Offsetting a lane 11m round an 11m-radius corner folds the
  // lane back on itself — cars ended up chasing a scrambled line into walls.
  // Real pit lanes run along the straight and straddle the line; so do these.
  const THR = 0.006;               // |curvature| above this = no longer straight
  let back = 0, fwd = 0;
  for (let k = 1; k < N; k++) { const i = (N - k) % N; if (Math.abs(track.curv[i]) > THR) break; back = L - track.dist[i]; }
  for (let i = 1; i < N; i++) { if (Math.abs(track.curv[i]) > THR) break; fwd = track.dist[i]; }
  // corridor [a, b] in metres relative to the line (negative = before it)
  // leave some straight between the last corner's exit and the pit entry, so
  // a car can move across to the pit side on the straight rather than at the
  // exit of the corner (Hungary's entry used to begin 12m after T14)
  const lead = Math.min(60, back * 0.35);
  let a = -Math.max(0, back - lead), b = Math.max(0, fwd - 12);
  if (a < -300) a = -300;                       // long straights: don't start miles back
  if (b - a > 430) b = a + 430;                 // real pit lanes run ~350-450m
  if (b - a < 200) { b = a + 200; }             // floor (no track is this short; safety)
  const total = b - a;
  const entryLen = Math.min(75, total * 0.20), exitLen = Math.min(70, total * 0.18);
  const sExitStart = total - exitLen;
  // the box sits at the line where possible, otherwise as close as the lane allows
  const sBox = Math.max(entryLen + 30, Math.min(sExitStart - 40, -a));
  const entryStart = ((a % L) + L) % L;
  const at = s => (entryStart + s) % L;
  track._pitG = {
    laneOff:  hw + 5.5,                       // lane centreline, pit side
    laneHalf: 2.6,                            // half-width of the paved lane
    wallOff:  hw + 2.2,                       // pit wall between track and lane
    edgeOff:  hw - 1.6,                       // where the car hugs before peeling
    // corridor coordinates (metres from the pit entry; the lane may wrap past
    // the start/finish line, so ALWAYS compare positions with pitS(), never
    // raw lap distance)
    total, sEntryEnd: entryLen, sBox, sExitStart, sExitEnd: total,
    // absolute lap distances, for drawing and markers
    entryStart, entryEnd: at(entryLen), boxDist: at(sBox), exitStart: at(sExitStart), exitEnd: at(total),
    // working lane (where the boxes are) between the fast lane and the garages
    workOff:  hw + 10.8, workHalf: 2.7, garageOff: hw + 14.2,
  };
  // one box per team along the straight part of the lane, in front of its
  // garage (order ~ last year's constructors' standings, leader nearest the exit)
  const G_ = track._pitG, straight = sExitStart - entryLen, nT = PIT_TEAM_ORDER.length;
  G_.boxSpacing = Math.min(14, (straight - 16) / nT);
  const s0 = entryLen + (straight - G_.boxSpacing * nT) / 2;
  G_.boxS = {};
  PIT_TEAM_ORDER.forEach((tm, i) => { G_.boxS[tm] = s0 + (nT - 1 - i + 0.5) * G_.boxSpacing; });
  G_.garageS0 = s0; G_.garageS1 = s0 + G_.boxSpacing * nT;
  return track._pitG;
}

const PIT_TEAM_ORDER = ['mclaren','mercedes','redbull','ferrari','williams','racingbulls','aston','haas','audi','alpine','cadillac'];

// Lateral target for a car using the pit lane with its own box at corridor
// position boxS: the fast lane, swinging into the working lane for the box and
// back out after it. boxS == null (drive-through) = fast lane only.
function pitCarOffset(track, lapDist, boxS) {
  const base = pitLaneOffset(track, lapDist);
  if (base == null || boxS == null) return base;
  const g = pitLaneGeom(track), s = pitS(track, lapDist);
  const w = s <= boxS ? _ss(boxS - 26, boxS - 5, s) : 1 - _ss(boxS + 3, boxS + 24, s);
  return base + (-g.workOff - base) * w;
}

// distance along the pit corridor from its entry (wraps across the line).
// Values > g.total mean "not in the corridor".
function pitS(track, lapDist) {
  const g = pitLaneGeom(track), L = track.length;
  return ((lapDist - g.entryStart) % L + L) % L;
}

// smoothstep 0..1
function _ss(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t*t*(3-2*t); }

// Target lateral offset (negative = pit side) for a car following the pit lane
// at a given lap distance. Returns null outside the pit corridor (= on track).
function pitLaneOffset(track, lapDist) {
  const g = pitLaneGeom(track), s = pitS(track, lapDist);
  if (s > g.total) return null;
  if (s < g.sEntryEnd) return -(g.edgeOff + (g.laneOff - g.edgeOff) * _ss(0, g.sEntryEnd, s));
  if (s < g.sExitStart) return -g.laneOff;
  return -(g.laneOff + (g.edgeOff - g.laneOff) * _ss(g.sExitStart, g.total, s));
}

// grid slot: returns {x,z,angle} for grid position i (0 = pole)
function gridSlot(track, i) {
  const gap = 10;
  const backIdx = (idx, meters) => {
    let k = idx, remaining = meters;
    while (remaining > 0) {
      const k2 = (k-1+track.n)%track.n;
      remaining -= Math.hypot(track.px[k]-track.px[k2], track.pz[k]-track.pz[k2]);
      k = k2;
    }
    return k;
  };
  // proper staggered grid: alternate sides of the track, rows offset so the
  // second car of a row sits alongside the gap, not nose-to-tail
  const row = Math.floor(i/2);
  const lat = Math.max(3.2, track.width * 0.30);
  const sideOff = (i%2===0) ? -lat : lat;
  const stagger = (i%2===0) ? 0 : gap*0.55;
  const k = backIdx(0, 15 + row*gap + stagger);
  const p = track.posAt(k, sideOff);
  return { x:p.x, z:p.z, angle: Math.atan2(track.tx[k], track.tz[k]), idx:k };
}

// draw minimap onto a 2d canvas
// zoom = 1 fits the whole circuit; higher zooms in and follows the car
// (cxWorld/czWorld), so you can read the corner you're actually approaching.
function drawMinimapBase(track, canvas, zoom, cxWorld, czWorld) {
  zoom = zoom || 1;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
  for (let k=0;k<track.n;k++){
    minX=Math.min(minX,track.px[k]); maxX=Math.max(maxX,track.px[k]);
    minZ=Math.min(minZ,track.pz[k]); maxZ=Math.max(maxZ,track.pz[k]);
  }
  const pad=10;
  const sc=Math.min((W-pad*2)/(maxX-minX),(H-pad*2)/(maxZ-minZ)) * zoom;
  let ox, oz;
  if (zoom > 1.01 && cxWorld != null) {
    // keep the car in the middle of the window
    ox = W/2 - (cxWorld-minX)*sc;
    oz = H/2 - (czWorld-minZ)*sc;
  } else {
    ox=(W-(maxX-minX)*sc)/2; oz=(H-(maxZ-minZ)*sc)/2;
  }
  track._mapScale = sc; track._mapMinX=minX; track._mapMinZ=minZ; track._mapOx=ox; track._mapOz=oz;
  ctx.strokeStyle='rgba(255,255,255,0.9)';
  ctx.lineWidth=3; ctx.lineJoin='round';
  ctx.beginPath();
  for (let k=0;k<=track.n;k+=2){
    const i=k%track.n;
    const x=ox+(track.px[i]-minX)*sc, y=oz+(track.pz[i]-minZ)*sc;
    if(k===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle='#e10600'; ctx.lineWidth=3;
  const sx=ox+(track.px[0]-minX)*sc, sy=oz+(track.pz[0]-minZ)*sc;
  ctx.beginPath();
  ctx.moveTo(sx-4,sy-4); ctx.lineTo(sx+4,sy+4);
  ctx.stroke();
}

function mapPoint(track, x, z) {
  return {
    x: track._mapOx + (x - track._mapMinX) * track._mapScale,
    y: track._mapOz + (z - track._mapMinZ) * track._mapScale,
  };
}
