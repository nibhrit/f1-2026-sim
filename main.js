// ============================================================
// F1 2026 Simulator — main game loop, modes, UI
// ============================================================

(function(){
'use strict';

// ---------- renderer ----------
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true });
let pixelRatio = Math.min(window.devicePixelRatio, 2);
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
// ---------- shadows ----------
// Soft sun shadows. The map follows the player (see updateSunRig) because a
// single frustum stretched over a 5 km circuit would be too coarse to see.
// SHADOW_STEPS is the quality ladder the FPS watchdog walks down.
// Starts at 1024, not 2048. Until Build 34 the post-processing chain was
// silently dead, so the GPU budget everything was tuned against was fiction.
// With composer + shadows both live, 2048 was too much to open with.
const SHADOW_STEPS = [
  { size: 1024, soft: true },
  { size: 1024, soft: false },
  { size: 512,  soft: false },
  null, // off
];
let shadowStep = 0;
try {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
} catch (e) { /* stub renderer in tests */ }

// ---------- post-processing (SSAO + bloom + speed blur) ----------
// Radial speed blur + vignette in one pass. The vignette used to be a static
// CSS overlay sitting on top of everything; folding it in here means it
// operates on the rendered image (so it darkens tone-mapped highlights
// correctly) and can tighten with speed for a sense of tunnelling.
const SpeedBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0 },
    // 0.42 was a straight port of the old CSS overlay, but that sat on top of
    // an untone-mapped image. Through the composer it reads much heavier.
    vignette: { value: 0.24 },   // base darkening at the corners
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec2 center = vec2(0.5, 0.45);
      vec2 dir = vUv - center;
      float dist = length(dir);
      vec4 col = texture2D(tDiffuse, vUv);
      if (strength > 0.001) {
        float total = 1.0;
        for (int i = 1; i <= 6; i++) {
          float t = float(i) / 6.0;
          float w = 1.0 - t * 0.6;
          col += texture2D(tDiffuse, vUv - dir * t * strength * dist * 2.2) * w;
          total += w;
        }
        col /= total;
      }
      // smooth falloff from the centre; inner radius closes in with speed
      float inner = 0.62 - strength * 1.4;
      float v = smoothstep(inner, 1.02, dist * 1.42);
      col.rgb *= 1.0 - v * vignette;
      gl_FragColor = col;
    }`
};

let composer = null, ssaoPass = null, bloomPass = null, blurPass = null;
function setupComposer() {
  try {
    if (typeof THREE.EffectComposer === 'undefined' || typeof THREE.ShaderPass === 'undefined'
      || typeof THREE.Pass === 'undefined' || typeof THREE.RenderPass === 'undefined') return;
    const c = new THREE.EffectComposer(renderer);
    c.addPass(new THREE.RenderPass(scene, camera));
    try {
      if (typeof THREE.SSAOPass !== 'undefined') {
        ssaoPass = new THREE.SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
        // Pulled in from 0.7: real sun shadows now darken the same contact
        // points SSAO was faking, and the two stacked into black mush under
        // the cars. AO's job here is just the tight creases the shadow map
        // is too coarse to resolve.
        ssaoPass.kernelRadius = 0.34;
        ssaoPass.minDistance = 0.0006;
        ssaoPass.maxDistance = 0.06;
        // OFF by default. SSAO re-renders the scene's depth and normals every
        // frame — easily the most expensive pass here — and with real sun
        // shadows now working it adds very little. The ladder can't turn it
        // back on; it's opt-in only.
        ssaoPass.enabled = false;
        c.addPass(ssaoPass);
      }
    } catch(e) { ssaoPass = null; console.warn('SSAO unavailable', e); }
    try {
      if (typeof THREE.UnrealBloomPass !== 'undefined') {
        // threshold raised 0.82 → 0.94: metallic barriers and painted white
        // lines now sit far brighter under PBR + IBL than they did flat-lit,
        // and at the old threshold the whole track edge glowed. Strength
        // nudged up so the highlights that DO qualify still read.
        bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.38, 0.42, 0.94);
        c.addPass(bloomPass);
      }
    } catch(e) { bloomPass = null; console.warn('bloom unavailable', e); }
    blurPass = new THREE.ShaderPass(SpeedBlurShader);
    c.addPass(blurPass);
    composer = c;
  } catch(e) {
    composer = null;
    console.warn('post-processing disabled', e);
  }
}
// NOTE: setupComposer() is deliberately NOT called here. It reads `scene` and
// `camera`, which are `const` and declared below — calling it at this point
// threw a temporal-dead-zone ReferenceError that the try/catch swallowed,
// leaving composer === null forever. The call now lives just after the camera.

// image-based lighting from the theme sky (reflections on car paint)
let envRT = null;
function setupEnvironment(themeName) {
  try {
    const th = THEMES[themeName] || THEMES.green;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(
      new THREE.SphereGeometry(60, 16, 12),
      new THREE.MeshBasicMaterial({ map: skyTex(th), side: THREE.BackSide })));
    const gp = new THREE.Mesh(new THREE.PlaneGeometry(200,200),
      new THREE.MeshBasicMaterial({ color: parseInt(th.g1.slice(1),16) }));
    gp.rotation.x = -Math.PI/2; gp.position.y = -2;
    envScene.add(gp);
    const rt = pmrem.fromScene(envScene, 0.05);
    if (envRT) envRT.dispose();
    envRT = rt;
    scene.environment = rt.texture;
    pmrem.dispose();
  } catch(e) { /* IBL optional */ }
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5e0);
scene.fog = new THREE.Fog(0x87b5e0, 500, 1600);

// Near plane is per-camera-mode (see updateCamera). The cockpit needs 0.25 m
// so the steering wheel isn't clipped away; every other view keeps 1 m,
// because at 0.25 m the T-cam starts drawing the airbox and engine cover that
// sit right in front of it — a block filling the middle of the screen.
const NEAR_COCKPIT = 0.25, NEAR_DEFAULT = 1;
const camera = new THREE.PerspectiveCamera(72, window.innerWidth/window.innerHeight, NEAR_DEFAULT, 3000);

// now that scene and camera exist, the post-processing chain can be built
setupComposer();
// the shader pass owns the vignette when post-processing is available; the
// CSS overlay stays behind purely as the no-composer fallback
{
  const vigEl = document.getElementById('vignette');
  if (vigEl && composer) vigEl.style.display = 'none';
}
camera.position.set(0, 30, 60);

const sun = new THREE.DirectionalLight(0xffffff, 0.85);
sun.position.set(300, 500, 200);
scene.add(sun);
// the shadow frustum is a box that rides along with the car
const SHADOW_HALF = 55;  // metres covered either side of the player
const SUN_OFFSET = { x: 120, y: 210, z: 80 }; // sun direction, in metres
try {
  sun.castShadow = true;
  sun.shadow.mapSize.width = SHADOW_STEPS[0].size;
  sun.shadow.mapSize.height = SHADOW_STEPS[0].size;
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF;
  sc.top = SHADOW_HALF;   sc.bottom = -SHADOW_HALF;
  sc.near = 20; sc.far = 700;
  sc.updateProjectionMatrix();
  // banked, sloping asphalt shadow-acnes badly without both of these
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(sun.target);
} catch (e) { /* stub light in tests */ }

// Keep the shadow box centred on the car. Snapping the centre to whole
// texels stops the shadow edges crawling as you drive.
function updateSunRig(x, z) {
  if (!sun.castShadow || !sun.shadow) return;
  const texel = (SHADOW_HALF * 2) / (sun.shadow.mapSize.width || 2048);
  const cx = Math.round(x / texel) * texel;
  const cz = Math.round(z / texel) * texel;
  sun.target.position.set(cx, 0, cz);
  sun.position.set(cx + SUN_OFFSET.x, SUN_OFFSET.y, cz + SUN_OFFSET.z);
  sun.target.updateMatrixWorld();
}

// Walk down the shadow ladder when frames get tight.
function degradeShadows() {
  if (shadowStep >= SHADOW_STEPS.length - 1) return false;
  shadowStep++;
  const s = SHADOW_STEPS[shadowStep];
  try {
    if (!s) {
      sun.castShadow = false;
      renderer.shadowMap.enabled = false;
      console.log('[perf] shadows off');
    } else {
      sun.shadow.mapSize.width = s.size;
      sun.shadow.mapSize.height = s.size;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      renderer.shadowMap.type = s.soft ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
      renderer.shadowMap.needsUpdate = true;
      console.log('[perf] shadows →', s.size + (s.soft ? ' soft' : ' hard'));
    }
  } catch (e) { return false; }
  return true;
}
const ambient = new THREE.AmbientLight(0x8899bb, 0.45);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a5a2a, 0.25);
scene.add(hemi);

function applyTheme(themeName) {
  const th = THEMES[themeName] || THEMES.green;
  scene.background = new THREE.Color(th.sky);
  scene.fog = new THREE.Fog(th.sky, th.fog[0], th.fog[1]);
  sun.intensity = th.sun;
  // The light levels were set when everything was MeshLambertMaterial, which
  // is far more forgiving than PBR: a rough Standard surface under a 0.20 sun
  // reads much darker than the same Lambert one. Night circuits (Bahrain,
  // Singapore, Vegas, Qatar) were hit hardest, so they get the biggest lift.
  const lift = th.night ? 1.55 : 1.15;
  ambient.intensity = th.amb * lift;
  ambient.color.setHex(th.ambC);
  hemi.intensity = th.night ? 0.30 : 0.32;
  renderer.toneMappingExposure = th.night ? 1.75 : 1.38;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- dom ----------
const $ = id => document.getElementById(id);
const screens = {
  main: $('screen-main'), track: $('screen-track'), raceopts: $('screen-raceopts'),
  opponent: $('screen-opponent'), results: $('screen-results'), pause: $('screen-pause'),
  standings: $('screen-standings'),
};
const hud = $('hud');
const banner = $('msg-banner');
const lightsEl = $('start-lights');
const lights = lightsEl.querySelectorAll('.light');

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  if (name) screens[name].classList.remove('hidden');
}

// ---------- input ----------
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  AUDIO.init();
  if (e.code === 'KeyN') {
    const m = AUDIO.toggleMute();
    if (G.state === 'driving') showBanner(m ? 'SOUND OFF' : 'SOUND ON', 1.2, '#6fa0ff');
  }
  // M cycles the minimap zoom: whole circuit → 2x → 3.5x (follows the car)
  if (e.code === 'KeyM' && G.state === 'driving') {
    G.mapZoom = (G.mapZoom + 1) % MAP_ZOOMS.length;
    const z = MAP_ZOOMS[G.mapZoom];
    showBanner(z === 1 ? 'MAP: FULL CIRCUIT' : 'MAP ZOOM ' + z + '×', 1.2, '#6fa0ff');
  }
  if (e.code === 'Escape') togglePause();
  if (e.code === 'KeyC' && G.state === 'driving') {
    G.camMode = (G.camMode+1)%4;
    const names = ['CHASE CAM','COCKPIT CAM','T-CAM','BROADCAST CAM'];
    showBanner(names[G.camMode], 1, '#6fa0ff');
  }
  if (e.code === 'KeyT' && G.state === 'driving') {
    G.autopilot = !G.autopilot;
    showBanner(G.autopilot ? 'AUTOPILOT ON' : 'AUTOPILOT OFF', 1.5, '#6fa0ff');
  }
  if (e.code === 'KeyR' && G.state === 'driving' && G.player) G.player.phys.resetToTrack();
  // box any lap, in any session — practice and qualifying included
  if (e.code === 'KeyP' && G.state === 'driving' && G.player
      && !G.player.finished && !G.player.pitState) {
    const c = G.player;
    if (c.pitArmed) {                       // press again to call it off
      c.pitArmed = false; c.pitArmLap = null;
      showBanner('BOX CANCELLED', 1.4, '#8fa3c8');
    } else if (G.mode === 'practice' || !(c.pitPlan && c.pitPlan.length)) {
      // no planned stop left (practice, a short race, or the plan is used up)
      // — pick what to fit right now
      showTyrePicker('pit');
    } else {
      const nextLap = armPit(c);
      showBanner(nextLap ? 'BOX NEXT LAP' : 'BOX THIS LAP', 1.8, '#ffd12e');
    }
  }
  // SPACE resolves the reaction-light pit game while stationary
  if (e.code === 'Space' && G.player && G.player.pitState === 'stopped' && G.pitGame && !G.pitGame.done) {
    pitGameKey();
  }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('pointerdown', () => { AUDIO.init(); AUDIO.musicStart(); });
window.addEventListener('keydown', () => { AUDIO.musicStart(); }, { once: true });

function playerInput() {
  return {
    throttle: (keys['KeyW']||keys['ArrowUp']) ? 1 : 0,
    brake: (keys['KeyS']||keys['ArrowDown']||keys['Space']) ? 1 : 0,
    steer: ((keys['KeyA']||keys['ArrowLeft']) ? 1 : 0) + ((keys['KeyD']||keys['ArrowRight']) ? -1 : 0),
  };
}

const MAP_ZOOMS = [1, 2, 3.5]; // minimap zoom steps (M cycles)

// ---------- game state ----------
const G = {
  state: 'menu',          // menu | driving | paused | results
  mode: null,             // practice | qualify | race
  trackDef: null,
  track: null,
  trackGroup: null,
  cars: [],               // {phys, mesh, driver, ai, lapTimes[], bestLap, curLapStart, finished, finishTime}
  player: null,
  camMode: 0,
  mapZoom: 0,             // index into MAP_ZOOMS
  raceLaps: 5,
  raceType: 'full',       // full | h2h
  opponent: null,
  simTime: 0,
  countdown: null,        // {phase, t}
  raceStarted: false,
  qualiLapsLimit: 3,      // legacy; quali now runs on a clock (QUALI_TIME)
  qualiTime: 0,          // seconds left on the qualifying clock
  qualiFlag: false,      // chequered flag out — finish your current lap
  qualiLapsDone: 0,      // laps completed this session (valid or deleted)
  bestCheckpoints: null,  // for live delta
  curCheckpoints: null,
  msgTimer: 0,
  difficulty: 1.06,       // AI ability multiplier (Pro default)
  penalties: {},          // stewards' time penalties per driver id
  raceDist: 'short',      // race distance: short | half | full
  weekend: false,         // Grand Prix weekend flow
  gpGrid: null,           // qualifying result → race grid
  seasonActive: false,    // championship season flow
  seasonData: { round: 0, points: {}, teamPoints: {}, history: [] }, // points keyed by driver id, teamPoints by team key
  // dynamic weather (see rollWeather / updateWeather)
  weather: { wetness:0, target:0, trend:0, raining:false, forecast:'DRY', scenario:'dry' },
  // sector timing benchmarks
  sectorSB: [null,null,null],   // session-best per sector (purple)
  pbLapSectors: [null,null,null], // sectors of personal-best lap (green)
  curSectors: [null,null,null],
  curSec: 0,
  sectorEntryTime: 0,
};

// ---------- menu wiring ----------
document.querySelectorAll('#screen-main .btn[data-mode]').forEach(b => {
  b.addEventListener('click', () => {
    const m = b.dataset.mode;
    if (m === 'season') { openSeason(); return; }
    G.weekend = (m === 'gp');
    G.mode = G.weekend ? 'practice' : m;
    const label = G.weekend ? 'GRAND PRIX WEEKEND' : m.toUpperCase();
    $('track-mode-label').textContent = label + ' — 2026 SEASON — 24 ROUNDS';
    refreshRecordLabels();
    showScreen('track');
  });
});
// AI difficulty selector
document.querySelectorAll('#diff-row [data-diff]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#diff-row [data-diff]').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    G.difficulty = parseFloat(b.dataset.diff);
  });
});
// race distance selector
document.querySelectorAll('#dist-row [data-dist]').forEach(b => {
  b.addEventListener('click', () => {
    G.raceDist = b.dataset.dist;
    syncDistButtons();
  });
});
// laps for a race at this track, honouring the race-distance setting
function raceLapsFor(def) { return G.raceDist==='full' ? def.fullLaps : G.raceDist==='half' ? Math.ceil(def.fullLaps/2) : def.laps; }

// keep both distance selectors in step and show real lap counts for the track
function syncDistButtons() {
  document.querySelectorAll('#dist-row [data-dist], #ro-dist-row [data-dist]').forEach(x =>
    x.classList.toggle('selected', x.dataset.dist === G.raceDist));
  const def = G.trackDef;
  if (!def) return;
  const laps = { short: def.laps, half: Math.ceil(def.fullLaps/2), full: def.fullLaps };
  ['short','half','full'].forEach(k => {
    const el = $('ro-' + k);
    if (el) el.textContent = k[0].toUpperCase() + k.slice(1) + ' — ' + laps[k];
  });
}
document.querySelectorAll('.back-link').forEach(b => {
  b.addEventListener('click', () => showScreen(b.dataset.back));
});

// ---------- persistent track records (lap-record per circuit) ----------
function loadRecords() {
  try { return JSON.parse(localStorage.getItem('f1sim_records') || '{}'); }
  catch(e) { return {}; }
}
function saveRecord(trackId, time) {
  try {
    const r = loadRecords();
    if (r[trackId] == null || time < r[trackId]) {
      r[trackId] = time;
      localStorage.setItem('f1sim_records', JSON.stringify(r));
      return true;
    }
  } catch(e) {}
  return false;
}
const recordEls = {}; // track-card record labels, refreshed on menu return
function refreshRecordLabels() {
  const recs = loadRecords();
  Object.keys(recordEls).forEach(id => {
    recordEls[id].textContent = recs[id] != null ? 'REC ' + fmtTime(recs[id]) : '';
  });
}

// track cards
const trackGrid = $('track-grid');
TRACKS.forEach(def => {
  const card = document.createElement('div');
  card.className = 'track-card';
  const cv = document.createElement('canvas');
  cv.width = 120; cv.height = 78;
  card.appendChild(cv);
  const round = document.createElement('div');
  round.className = 't-round'; round.textContent = 'ROUND ' + def.round;
  card.appendChild(round);
  const nm = document.createElement('div');
  nm.className = 't-name'; nm.textContent = def.name;
  card.appendChild(nm);
  const cn = document.createElement('div');
  cn.className = 't-len'; cn.textContent = def.gp;
  card.appendChild(cn);
  const rec = document.createElement('div');
  rec.className = 't-len';
  rec.style.color = '#a640ff';
  recordEls[def.id] = rec;
  card.appendChild(rec);
  // draw layout
  const ctx = cv.getContext('2d');
  const pts = def.points;
  let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
  pts.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);});
  const sc=Math.min(108/(maxX-minX),66/(maxZ-minZ));
  const ox=(120-(maxX-minX)*sc)/2, oz=(78-(maxZ-minZ)*sc)/2;
  ctx.strokeStyle='#7fa8e8'; ctx.lineWidth=2; ctx.lineJoin='round';
  ctx.beginPath();
  pts.forEach((p,i)=>{
    const x=ox+(p.x-minX)*sc, y=oz+(p.z-minZ)*sc;
    if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  });
  ctx.closePath(); ctx.stroke();
  card.addEventListener('click', () => selectTrack(def));
  trackGrid.appendChild(card);
});
refreshRecordLabels();

function selectTrack(def) {
  G.trackDef = def;
  if (G.weekend) {
    // Grand Prix weekend always begins with Practice
    G.mode = 'practice';
    G.gpGrid = null;
    startSession();
  } else if (G.mode === 'race') {
    $('raceopts-track-label').textContent = def.gp.toUpperCase() + ' — ' + def.name.toUpperCase();
    syncDistButtons(); // label the buttons with this circuit's lap counts
    showScreen('raceopts');
  } else {
    startSession();
  }
}

// race options
$('opt-fullgrid').addEventListener('click', () => { G.raceType='full'; startSession(); });
$('opt-h2h').addEventListener('click', () => {
  G.raceType='h2h';
  buildOpponentGrid();
  showScreen('opponent');
});
// race-setup distance buttons mirror the home-page setting — one shared value,
// editable from either screen, labelled with this circuit's real lap counts
document.querySelectorAll('#ro-dist-row [data-dist]').forEach(b => {
  b.addEventListener('click', () => {
    G.raceDist = b.dataset.dist;
    syncDistButtons();
  });
});

function buildOpponentGrid() {
  const grid = $('opp-grid');
  grid.innerHTML = '';
  DRIVERS.filter(d => !d.player).forEach(d => {
    const card = document.createElement('div');
    card.className = 'opp-card';
    const sw = document.createElement('div');
    sw.className = 'opp-swatch';
    sw.style.background = '#' + TEAMS[d.team].color.toString(16).padStart(6,'0');
    card.appendChild(sw);
    const info = document.createElement('div');
    info.innerHTML = '<div class="opp-name">'+d.name+'</div><div class="opp-team">'+TEAMS[d.team].name+'</div>';
    card.appendChild(info);
    card.addEventListener('click', () => { G.opponent = d; startSession(); });
    grid.appendChild(card);
  });
}

// results / pause buttons
$('btn-restart').addEventListener('click', () => startSession());
$('btn-restart2').addEventListener('click', () => startSession());
$('btn-menu').addEventListener('click', backToMenu);
$('btn-menu2').addEventListener('click', backToMenu);
$('btn-resume').addEventListener('click', togglePause);
$('btn-next').addEventListener('click', () => {
  // season race finished → standings; otherwise drive the GP weekend forward
  if (G.seasonActive && G.mode === 'race') showStandings();
  else advanceWeekend();
});
$('btn-next2').addEventListener('click', () => { showScreen(null); advanceWeekend(); });

function backToMenu() {
  teardownSession();
  G.state = 'menu';
  G.weekend = false;
  G.seasonActive = false;
  hud.classList.remove('active');
  AUDIO.musicDuck(false);
  showScreen('main');
}

function togglePause() {
  if (G.state === 'driving') {
    G.state = 'paused';
    // during a GP practice, offer to move on to qualifying
    const showNext = G.weekend && G.mode === 'practice';
    $('btn-next2').classList.toggle('hidden', !showNext);
    if (showNext) $('btn-next2').textContent = 'Go to Qualifying';
    // during GP qualifying, offer to skip straight to the race
    const showSkipQ = G.weekend && G.mode === 'qualify';
    $('btn-skipq').classList.toggle('hidden', !showSkipQ);
    // during any qualifying, allow ending the session early (keeping your time)
    const showEndQ = G.mode === 'qualify' && G.raceStarted && !G.qualiFlag;
    $('btn-endq').classList.toggle('hidden', !showEndQ);
    showScreen('pause');
  } else if (G.state === 'paused') {
    G.state = 'driving';
    showScreen(null);
    lastT = performance.now();
  }
}

// ---------- session setup ----------
function teardownSession() {
  if (G.endTimer) { clearTimeout(G.endTimer); G.endTimer = null; }
  if (G.trackGroup) { scene.remove(G.trackGroup); disposeGroup(G.trackGroup); G.trackGroup = null; }
  G.cars.forEach(c => { scene.remove(c.mesh); disposeGroup(c.mesh); });
  G.cars = [];
  G.player = null;
}

// THREE's material.dispose() does NOT free the textures hanging off it, so
// every session was leaving its canvas textures resident on the GPU: the
// asphalt albedo/normal/roughness, ground, sky dome, barriers, crowd, kerbs
// and signage. Start enough sessions in one sitting and the driver is juggling
// hundreds of dead textures, which is exactly what a slow creeping frame rate
// looks like. Textures flagged __shared (the per-team car liveries) are
// deliberately kept — they're a bounded set reused by every session.
const TEX_SLOTS = ['map','normalMap','roughnessMap','metalnessMap','emissiveMap',
                   'aoMap','alphaMap','bumpMap','displacementMap','envMap','lightMap'];

function disposeMaterial(m) {
  if (!m) return;
  for (const slot of TEX_SLOTS) {
    const tex = m[slot];
    if (tex && tex.dispose && !tex.__shared) tex.dispose();
  }
  m.dispose();
}

function disposeGroup(grp) {
  grp.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      Array.isArray(o.material) ? o.material.forEach(disposeMaterial) : disposeMaterial(o.material);
    }
  });
}

function makeCar(driver, track) {
  // only the player's car needs a steering wheel and hands — nobody ever
  // sits in anyone else's cockpit
  const mesh = buildF1Car(driver.team, {
    helmet: driver.player ? 0xe10600 : 0xdddddd,
    cockpit: !!driver.player,
  });
  scene.add(mesh);
  const phys = new CarPhysics(track);
  const car = {
    driver, mesh, phys,
    ai: driver.player ? null : null, // set after
    lapTimes: [], bestLap: null, curLapStart: 0,
    finished: false, finishTime: null,
    pitState: null, pitArmed: false, pitted: false, pitCompound: null, pitLap: null, pitTimer: 0,
    limitTimer: 0, limitStrikes: 0, lapInvalid: false, contactCd: 0,
  };
  if (!driver.player) {
    car.ai = new AIDriver(phys, track, driver);
    // difficulty drives cornering pace, braking depth and top speed
    car.ai.diff = G.difficulty;
    // Car performance: team ranking × this circuit's character × wet ability.
    const cp = carPace(driver, G.trackDef.id, (G.weather && G.weather.wetness) || 0);
    // Difficulty must NOT multiply pace on top of grip. gripBonus already
    // raises what the car can do; multiplying paceMul by G.difficulty as well
    // meant Elite planned at ~109% of its own limit and scrubbed speed all the
    // way round — which is why Elite was lapping SLOWER than Pro at Monza and
    // China despite never leaving the road. paceMul is now purely "what
    // fraction of the available limit this driver uses", and always under 1.
    const dt2 = Math.max(0, Math.min(1, (G.difficulty - 0.98) / 0.12));
    car.ai.paceMul = cp * (0.900 + 0.130 * dt2) * (0.990 + driver.skill * 0.010);
    car.ai.buildCornerSpeeds();
    // Pace alone barely separates the field, because the quick cars end up
    // pegged at the grip limit either way. Feeding the same figure into grip
    // is what turns the constructors' table into a real lap-time spread.
    // (dt2 is computed just above and reused here.)
    //
    // The grip range is the difficulty dial, and it's also the realism dial:
    // whatever sits above 1.0 is corner grip the player's car does not have.
    // The dial: at 0.24 the Elite field cornered 22% harder than physically
    // possible for you (felt like cheating); 0.12 was 10% (too soft, no real
    // fight); 0.18 is 16% — enough grip that Elite is properly quick on
    // grip-limited circuits without the superhuman feel. Note it barely helps
    // on power/flow tracks like COTA, where the AI is execution-limited, not
    // grip-limited.
    // (Their braking power is ~33 m/s² vs your 35-38 — always was fair.)
    // The whole ladder moved up a step: what used to be Elite is now Pro.
    // The grip curve is re-anchored to match, otherwise 1.06 and 1.10 would
    // both clamp to full grip and Pro/Elite would be identical.
    phys.gripBonus = (0.98 + dt2 * 0.18) * (1 - (1 - cp / CAR_PACE_TOP) * 4);
  }
  return car;
}

// ---------- weather ----------
// progress through the current session (0..1) for drying/incoming scenarios
function sessionProgress() {
  if (G.mode === 'race' && G.raceLaps > 0 && G.player) {
    return Math.max(0, Math.min(1, (G.player.phys.lap - 1) / G.raceLaps));
  }
  return Math.max(0, Math.min(1, G.simTime / 180));
}

// roll a fresh weather scenario for the session about to start
function rollWeather() {
  const t = G.trackDef;
  const w = G.weather;
  w.wetness = 0; w.target = 0; w.trend = 0; w.raining = false;
  w.scenario = 'dry'; w.peak = 0; w.arriveFrac = 1; w.arriveLap = 0;
  w._wxDir = 0; w._visWet = 0;
  w._hintRain = w._hintWet = w._hintDry = false; w.hintCd = 0;
  const chance = (t && t.rainChance != null) ? t.rainChance : 0.15;
  const laps = (G.mode === 'race') ? Math.max(1, G.raceLaps) : 1;
  if (Math.random() < chance) {
    const r = Math.random();
    if (r < 0.34) {                 // steady rain
      w.scenario = 'steady';
      w.wetness = 0.6 + Math.random()*0.3;   // 0.6-0.9
      w.target = w.wetness; w.raining = true;
    } else if (r < 0.6) {           // light drizzle
      w.scenario = 'drizzle';
      w.wetness = 0.3 + Math.random()*0.2;   // 0.3-0.5
      w.target = w.wetness; w.raining = true;
    } else if (r < 0.8) {           // drying track
      w.scenario = 'drying';
      w.wetness = 0.65 + Math.random()*0.1;  // starts ~0.7
      w.target = 0.08; w.raining = false;
    } else {                        // rain incoming later in the session
      w.scenario = 'incoming';
      w.wetness = 0; w.target = 0; w.raining = false;
      w.peak = 0.6 + Math.random()*0.3;      // arrives to 0.6-0.9
      w.arriveFrac = 0.3 + Math.random()*0.3; // at 30-60% distance
      w.arriveLap = Math.max(1, Math.round(w.arriveFrac * laps));
    }
  }
  w.forecast = forecastText();
  setWetness(w.wetness);
}

// broadcast-style forecast string from the live scenario/wetness
function forecastText() {
  const w = G.weather, wet = w.wetness;
  if (w.scenario === 'incoming' && wet < 0.15) {
    return G.mode === 'race' ? 'RAIN EXPECTED ~LAP ' + w.arriveLap : 'RAIN INCOMING';
  }
  if (w.scenario === 'drying' && wet > 0.12) return 'TRACK DRYING';
  if (wet < 0.12) return 'DRY';
  if (wet < 0.35) return 'LIGHT RAIN';
  if (wet < 0.70) return 'RAIN';
  return 'HEAVY RAIN';
}

// evolve wetness each sim step (called from stepSim)
function updateWeather(dt) {
  const w = G.weather;
  if (w.scenario === 'incoming') {
    const prog = sessionProgress();
    if (prog >= w.arriveFrac - 0.15) {
      const f = Math.max(0, Math.min(1, (prog - (w.arriveFrac - 0.15)) / 0.35));
      w.target = w.peak * f;
      if (w.target > 0.12) w.raining = true;
    }
  } else if (w.scenario === 'drying') {
    w.target = Math.max(0.05, 0.72 * (1 - sessionProgress()));
    w.raining = w.wetness > 0.5;
  }
  // ease wetness toward target (only the dynamic scenarios move on their own)
  if (w.scenario === 'incoming' || w.scenario === 'drying') {
    if (w.wetness < w.target)      w.wetness = Math.min(w.target, w.wetness + 0.05*dt);
    else if (w.wetness > w.target) w.wetness = Math.max(w.target, w.wetness - 0.04*dt);
  }
  w.forecast = forecastText();
  setWetness(w.wetness);
  weatherHints(dt);
}

// throttled radio-style engineer hints as the crossover approaches
function weatherHints(dt) {
  if (G.mode !== 'race' || !G.raceStarted || !G.player || G.player.finished) return;
  const w = G.weather, wet = w.wetness;
  const slick = ((COMPOUNDS[G.player.phys.compound] || {}).wetOptimal || 0) === 0;
  w.hintCd = Math.max(0, (w.hintCd || 0) - dt);
  if (w.hintCd > 0) return;
  if (w.scenario === 'incoming' && slick && wet < 0.2 && !w._hintRain
      && sessionProgress() > w.arriveFrac - 0.14) {
    showBanner('RAIN IN ~2 LAPS — BOX FOR INTERS?', 3, '#6fa0ff');
    w._hintRain = true; w.hintCd = 8;
  } else if (slick && wet > 0.4 && !w._hintWet) {
    showBanner(wet > 0.7 ? 'CONDITIONS FOR WETS NOW' : 'INTERS NOW — SLICKS DONE', 3, '#6fa0ff');
    w._hintWet = true; w.hintCd = 8;
  } else if (!slick && wet < 0.3 && !w._hintDry) {
    showBanner('TRACK DRYING — SLICKS COMING ALIVE', 3, '#6fa0ff');
    w._hintDry = true; w.hintCd = 8;
  }
}

// tyre "category": 0 slick, 1 intermediate, 2 full wet
function tyreCategory(name) { return name === 'wet' ? 2 : name === 'inter' ? 1 : 0; }
function idealCategory(wet) { return wet > 0.7 ? 2 : wet > 0.4 ? 1 : 0; }

// AI reacts to a conditions crossover: arm one weather stop per direction
function weatherPitCheck(c) {
  if (!G.raceStarted || c.phys.lap < 1) return;
  const want = idealCategory(G.weather.wetness);
  const have = tyreCategory(c.phys.compound);
  if (want === have) return;
  // Gate on the CATEGORY we last reacted to, not the direction. Gating on
  // direction blocked the second step of a drying track — wet → inter → slick
  // is two changes the same way, so cars got stranded on inters once the
  // circuit dried out.
  if (c._wxWant === want) return;         // already committed to this change
  c._wxWant = want;
  armPit(c);
  c.pitCompound = want === 2 ? 'wet' : want === 1 ? 'inter' : 'medium';
}

// What this car should be on right now, used at the moment of a stop so a
// scheduled dry stop never refits the inters a shower called for ten laps ago.
function compoundForConditions(c) {
  const cat = idealCategory(G.weather.wetness);
  if (cat === 2) return 'wet';
  if (cat === 1) return 'inter';
  // dry: keep whatever slick was planned, but never a wet-weather tyre
  const planned = c.pitCompound;
  return (planned && tyreCategory(planned) === 0) ? planned : 'medium';
}

// darken the scene when it's wet (greyer fog, lower sun); restore when dry
function mixHex(a, b, t) {
  const ar=(a>>16)&255, ag=(a>>8)&255, ab=a&255;
  const br=(b>>16)&255, bg=(b>>8)&255, bb=b&255;
  return (Math.round(ar+(br-ar)*t)<<16) | (Math.round(ag+(bg-ag)*t)<<8) | Math.round(ab+(bb-ab)*t);
}
function applyWeatherVisuals() {
  const th = THEMES[G.trackDef.theme] || THEMES.green;
  const wet = G.weather.wetness;
  if (wet < 0.05) { applyTheme(G.trackDef.theme); return; }
  const k = Math.min(1, wet);
  const grey = 0x5a6472;
  sun.intensity = th.sun * (1 - 0.60*k);
  ambient.intensity = th.amb * (1 - 0.22*k);
  // denser fog pulled in close = real reduced visibility (spray-like) in heavy rain
  scene.fog = new THREE.Fog(mixHex(th.sky, grey, 0.6*k), th.fog[0]*(1-0.45*k), th.fog[1]*(1-0.55*k));
  scene.background = new THREE.Color(mixHex(th.sky, grey, 0.6*k));
}

// ---------- animated 3D rain ----------
// Real falling streaks in world space, kept in a box around the camera so they
// follow the car. Density/opacity/speed all scale with how wet the track is.
const RAIN_N = 1600, RAIN_BOX = 130, RAIN_H = 70;
let rainMesh = null;
function buildRain() {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(RAIN_N * 6);
  const vel = new Float32Array(RAIN_N);
  const len = new Float32Array(RAIN_N);
  for (let i = 0; i < RAIN_N; i++) {
    const x = (Math.random()-0.5)*RAIN_BOX, y = Math.random()*RAIN_H, z = (Math.random()-0.5)*RAIN_BOX;
    len[i] = 1.1 + Math.random()*1.9;
    pos[i*6+0]=x; pos[i*6+1]=y;         pos[i*6+2]=z;
    pos[i*6+3]=x; pos[i*6+4]=y-len[i];  pos[i*6+5]=z;
    vel[i] = 38 + Math.random()*28;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rainMesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0xd4e4ff, transparent: true, opacity: 0, depthWrite: false, fog: false }));
  rainMesh.frustumCulled = false;
  rainMesh.visible = false;
  scene.add(rainMesh);
  rainMesh.userData.vel = vel;
  rainMesh.userData.len = len;
}

function updateRain(dt) {
  if (!rainMesh) return;
  const wet = (G.weather && G.weather.wetness) || 0;
  const mat = rainMesh.material;
  mat.opacity = wet > 0.05 ? Math.min(0.9, 0.2 + wet*0.8) : 0;
  rainMesh.visible = G.state === 'driving' && mat.opacity > 0.02;
  if (!rainMesh.visible) return;
  const pos = rainMesh.geometry.attributes.position.array;
  const vel = rainMesh.userData.vel;
  const len = rainMesh.userData.len;
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const half = RAIN_BOX/2;
  const speedMul = dt * (0.55 + wet*0.75);

  // Streak direction. The old version slanted every drop along world +X, so
  // driving along the X axis put the slant straight down the view axis and the
  // rain rendered as dead vertical lines. The slant now leans AGAINST the car's
  // direction of travel — apparent wind — so streaks always rake across the
  // screen and never collapse to vertical.
  const pp = G.player && G.player.phys;
  const spd = pp ? pp.speed : 0;
  const lean = Math.min(1.1, 0.30 + spd*0.013);   // how far the streak rakes
  const hx = pp ? -Math.sin(pp.heading)*lean : lean*0.7;
  const hz = pp ? -Math.cos(pp.heading)*lean : 0;
  // Normalise (hx, -1, hz) to a unit direction. Without this the lean is added
  // ON TOP of the drop length, so a 3 m streak became a 5.4 m one at racing
  // speed — long raking lines across the screen, exactly what we're removing.
  const inv = 1 / Math.hypot(hx, 1, hz);
  const ux = hx*inv, uy = -inv, uz = hz*inv;
  // gentle sideways drift of the whole volume, same direction as the lean
  const driftX = hx * 0.30, driftZ = hz * 0.30;

  const active = Math.floor(RAIN_N * Math.min(1, 0.25 + wet));
  rainMesh.geometry.setDrawRange(0, active*2);
  // drops closer than this to the camera are recycled — a 3 m streak passing
  // a few centimetres from the lens is what reads as a stray vertical line
  const NEAR_R = 3.5;
  for (let i = 0; i < active; i++) {
    const o = i*6;
    const d = vel[i]*speedMul;
    pos[o+1] -= d;
    pos[o+0] += d*driftX;
    pos[o+2] += d*driftZ;

    let x = pos[o+0], y = pos[o+1], z = pos[o+2];
    // respawn once it falls past the car, or if it would pass through the lens
    const dx = x - cx, dz = z - cz, dy = y - cy;
    if (y < cy - 22 || (dx*dx + dy*dy + dz*dz) < NEAR_R*NEAR_R) {
      x = cx + (Math.random()-0.5)*RAIN_BOX;
      y = cy + RAIN_H*0.55 + Math.random()*RAIN_H*0.45;
      z = cz + (Math.random()-0.5)*RAIN_BOX;
      pos[o+0]=x; pos[o+1]=y; pos[o+2]=z;
    } else {
      // wrap horizontally so the volume travels with the car at 300km/h
      if (x - cx >  half) { x -= RAIN_BOX; }
      if (x - cx < -half) { x += RAIN_BOX; }
      if (z - cz >  half) { z -= RAIN_BOX; }
      if (z - cz < -half) { z += RAIN_BOX; }
      pos[o+0]=x; pos[o+2]=z;
    }
    // the tail is always derived from the head, so a streak can never be
    // stretched or left behind by a wrap
    const L = len[i];
    pos[o+3] = x        + ux*L;
    pos[o+4] = pos[o+1] + uy*L;
    pos[o+5] = z        + uz*L;
  }
  rainMesh.geometry.attributes.position.needsUpdate = true;
}
buildRain();

const QUALI_TIME = 300; // qualifying session length in seconds (F1-style clock)

function startSession() {
  teardownSession();
  showScreen(null);
  hud.classList.add('active');
  banner.style.display = 'none';
  lightsEl.style.display = 'none';

  G.track = new TrackData(G.trackDef);
  G.track.computeDrsZones(G.trackDef.drs || 2);
  applyTheme(G.trackDef.theme);
  setupEnvironment(G.trackDef.theme);
  G.trackGroup = buildTrackScene(G.track, scene, G.trackDef.theme);
  drawMinimapBase(G.track, $('minimap-canvas'));

  G.simTime = 0;
  G.raceStarted = false;
  G.playerDrsState = 0;
  G.drsInfo = '';
  G.countdown = null;
  G.firstFinish = null;
  G.bestCheckpoints = null;
  G.curCheckpoints = [];
  G.msgTimer = 0;
  // reset sector benchmarks for a fresh session
  G.sectorSB = [null,null,null];
  G.pbLapSectors = [null,null,null];
  G.curSectors = [null,null,null];
  G.curSec = 0;
  G.sectorEntryTime = 0;
  ['sec0','sec1','sec2'].forEach((id,i) => { $(id).textContent = 'S'+(i+1)+' --.-'; $(id).className='sec'; });
  // clear the timing HUD so a previous track's times don't linger
  $('cur-time').textContent = '--:--.---';
  $('last-time').textContent = '--:--.---';
  $('best-time').textContent = '--:--.---';
  $('delta-time').textContent = '--';
  $('delta-time').className = 't-val';
  // reset stewards for a fresh session
  G.penalties = {};
  G.penaltyFlash = {};
  G.raceFL = null;
  G.refCheckpoints = null;
  G.refTime = null;
  if ($('stewards')) $('stewards').innerHTML = '';

  // remember whether a record already existed (so the banner means "beaten", not "first lap")
  G.hadRecord = loadRecords()[G.trackDef.id] != null;

  const me = DRIVERS.find(d => d.player);

  // resuming a season race exactly where it was left
  const snap = G.pendingRaceSnap;
  G.pendingRaceSnap = null;
  if (snap && G.mode === 'race') { restoreRace(snap); updateLapPanel(); AUDIO.musicDuck(true); lastT = performance.now(); return; }

  if (G.mode === 'race') {
    // Grand Prix race length follows the race-distance setting
    G.raceLaps = raceLapsFor(G.trackDef); // one shared distance for every race
    rollWeather();
    let roster;
    if (G.raceType === 'h2h') roster = [me, G.opponent];
    else if (G.weekend && G.gpGrid) {
      // grid set by qualifying result
      roster = G.gpGrid.map(id => DRIVERS.find(d => d.id === id));
    }
    else {
      roster = DRIVERS.slice();
      // qualifying-ish grid order by skill with randomness; player P3-ish for fun
      roster.sort((a,b) => (b.skill + Math.random()*0.06) - (a.skill + Math.random()*0.06));
    }
    roster.forEach((d, i) => {
      const car = makeCar(d, G.track);
      const slot = gridSlot(G.track, i);
      car.phys.placeAt(slot.x, slot.z, slot.angle);
      car.phys.lap = 0; // becomes 1 at start-line cross
      // race progress must reflect the grid slot, otherwise every car reads as
      // level with every other: the field would order randomly and each driver
      // would think a rival was right on its nose and lift off the line
      car.phys.totalDist = -(G.track.length - G.track.dist[slot.idx]);
      // AI starting compound: wet-weather tyres if the track's wet, else the
      // usual 40/40/20 soft/medium/hard slick strategy with a pit tyre differing
      if (!d.player) {
        // Start compound has to read the FORECAST, not the current wetness.
        // On a drying track wetness starts around 0.7 and falls to 0.08, so
        // reading the instant value put the whole grid on full wets for a race
        // that was slick-dry by lap five. Teams look at where it's going.
        const now = G.weather.wetness;
        const soon = G.weather.target != null ? G.weather.target : now;
        // weight the forecast heavily when the track is heading somewhere else
        const wet = now * 0.45 + soon * 0.55;
        if (wet > 0.7) { car.phys.setTyre('wet'); car.pitCompound = 'inter'; }
        else if (wet > 0.35) { car.phys.setTyre('inter'); car.pitCompound = soon < 0.2 ? 'medium' : (soon > 0.7 ? 'wet' : 'medium'); }
        else {
          const r = Math.random();
          const start = r < 0.4 ? 'soft' : r < 0.8 ? 'medium' : 'hard';
          car.phys.setTyre(start);
          const others = ['soft','medium','hard'].filter(n => n !== start);
          car.pitCompound = others[Math.floor(Math.random()*others.length)];
          if (G.raceLaps > 20) {
            const lo = Math.ceil(G.raceLaps*0.35), hi = Math.floor(G.raceLaps*0.65);
            car.pitLap = lo + Math.floor(Math.random()*(hi - lo + 1));
            // long races: ~45% of the field plans a two-stopper
            if (G.raceLaps >= 35 && Math.random() < 0.45) {
              const lo2 = Math.ceil(G.raceLaps*0.60), hi2 = Math.floor(G.raceLaps*0.82);
              car.pitLap2 = Math.max(car.pitLap + 6, lo2 + Math.floor(Math.random()*(hi2 - lo2 + 1)));
              car.pitLap = Math.ceil(car.pitLap * 0.75); // first stop earlier on a 2-stop
            }
          }
        }
      }
      G.cars.push(car);
      if (d.player) G.player = car;
    });
    // countdown is created once the player confirms a tyre choice
    showTyrePicker();
  } else {
    // practice / qualify: player alone
    rollWeather();
    const car = makeCar(me, G.track);
    const slot = gridSlot(G.track, 0);
    car.phys.placeAt(slot.x, slot.z, slot.angle);
    G.cars.push(car);
    G.player = car;
    if (G.mode === 'qualify') {
      G.qualiAITimes = simulateQualiTimes();
      G.qualiTime = QUALI_TIME;
      G.qualiFlag = false;
      G.qualiLapsDone = 0;
      // green flag waits for the tyre choice
      showTyrePicker();
    } else {
      // practice runs on the current conditions; hand the player sensible tyres
      const wet = G.weather.wetness;
      if (wet > 0.7) car.phys.setTyre('wet');
      else if (wet > 0.35) car.phys.setTyre('inter');
      G.raceStarted = true;
      G.state = 'driving';
      const wx = G.weather.forecast !== 'DRY' ? ' · ' + G.weather.forecast : '';
      showBanner((G.weekend ? 'FREE PRACTICE — ' : 'PRACTICE — ') + G.trackDef.name.toUpperCase() + wx, 3);
    }
  }
  applyWeatherVisuals();
  updateLapPanel();
  AUDIO.musicDuck(true);
  lastT = performance.now();
}

// simulate AI qualifying lap times via point-mass over corner speeds
function simulateQualiTimes() {
  const t = G.track;
  if (!t._cornerSpeed) {
    const cs = new Float32Array(t.n);
    for (let i=0;i<t.n;i++) {
      const c = Math.abs(t.curv[i]);
      if (c < 1e-4) { cs[i] = 999; continue; }
      const vCap = Math.sqrt(52 / c);
      const vMech = c > 0.0075 ? Math.sqrt(25.5 / (c - 0.0066)) : Infinity;
      cs[i] = Math.min(vCap, vMech);
    }
    t._cornerSpeed = cs;
  }
  const cs = t._cornerSpeed;
  function lapTime(paceMul) {
    // forward pass with accel limit, backward pass with braking limit
    const n = t.n;
    const v = new Float32Array(n);
    for (let i=0;i<n;i++) v[i] = Math.min(94, cs[i]*paceMul);
    for (let pass=0;pass<2;pass++) {
      for (let i=0;i<n*2;i++) {
        const a=i%n, b=(i+1)%n;
        const ds = t.length/n;
        const vmax = Math.sqrt(v[a]*v[a] + 2*11*ds);
        if (v[b] > vmax) v[b] = vmax;
      }
      for (let i=n*2;i>0;i--) {
        const a=i%n, b=(i-1+n)%n;
        const ds = t.length/n;
        const vmax = Math.sqrt(v[a]*v[a] + 2*26*ds);
        if (v[b] > vmax) v[b] = vmax;
      }
    }
    let time = 0;
    for (let i=0;i<n;i++) time += (t.length/n) / Math.max(v[i], 5);
    return time * 1.075; // calibration vs real driven laps
  }
  // everyone runs the quickest compound the conditions allow, as in real quali
  const wet = G.weather ? G.weather.wetness : 0;
  const qTyre = wet > 0.7 ? 'wet' : wet > 0.35 ? 'inter' : 'soft';
  return DRIVERS.filter(d=>!d.player).map(d => {
    // same performance model the race AI uses, so the grid you qualify against
    // matches the cars you then race — plus a little driver variability
    const cp = carPace(d, G.trackDef.id, wet);
    const paceMul = cp * (0.905 + d.skill * 0.055) * G.difficulty;
    return { driver: d, tyre: qTyre, time: lapTime(paceMul) * (1 + Math.random()*0.005) };
  });
}

// ---------- tyre picker (before qualifying / race sessions) ----------
const tyrePicker = $('tyre-picker');
let tpStart = 'medium', tpPit = 'hard';

let tpPit2 = 'soft', tpStops = 1, tpMode = 'session';

// how many stops the recommendation works out to at the chosen race distance
function recommendedStops() {
  const full = G.trackDef.fullLaps || 60;
  const rec = G.trackDef.recStops || 1;
  const frac = G.raceLaps / full;
  if (G.raceLaps <= 20) return 0;          // short races: no mandatory stop
  return Math.max(1, Math.round(rec * Math.min(1, frac + 0.25)));
}

// FIA two-compound rule: only a dry RACE over 20 laps forces the first stop to
// change compound. In qualifying, practice and wet races you may refit the same.
function mustDifferNow() {
  return tpMode === 'session' && G.mode === 'race' && G.raceLaps > 20
    && !(G.weather && G.weather.wetness > 0.3);
}

function refreshTyrePicker() {
  document.querySelectorAll('#tp-start-row .tyre-btn').forEach(b =>
    b.classList.toggle('selected', b.dataset.tyre === tpStart));
  const mustDiffer = mustDifferNow();
  document.querySelectorAll('#tp-pit-row .tyre-btn').forEach(b => {
    b.disabled = mustDiffer && b.dataset.tyre === tpStart;
    b.classList.toggle('selected', b.dataset.tyre === tpPit);
  });
  document.querySelectorAll('#tp-pit2-row .tyre-btn').forEach(b => {
    b.disabled = false;
    b.classList.toggle('selected', b.dataset.tyre === tpPit2);
  });
  document.querySelectorAll('#tp-strat-row [data-stops]').forEach(b =>
    b.classList.toggle('selected', +b.dataset.stops === tpStops));
  // reveal only the compound rows the chosen strategy needs
  const race = tpMode === 'session' && G.mode === 'race';
  const showPit1 = tpMode === 'pit' ? false : (race ? tpStops >= 1 : true);
  const showPit2 = race && tpStops >= 2;
  $('tp-pit-label').classList.toggle('hidden', !showPit1);
  $('tp-pit-row').classList.toggle('hidden', !showPit1);
  $('tp-pit2-label').classList.toggle('hidden', !showPit2);
  $('tp-pit2-row').classList.toggle('hidden', !showPit2);
}
const TYRE_ORDER = ['soft','medium','hard','inter','wet'];
document.querySelectorAll('#tp-start-row .tyre-btn').forEach(b => {
  b.addEventListener('click', () => {
    tpStart = b.dataset.tyre;
    if (mustDifferNow() && tpPit === tpStart) tpPit = TYRE_ORDER.find(n => n !== tpStart);
    refreshTyrePicker();
  });
});
document.querySelectorAll('#tp-pit-row .tyre-btn').forEach(b => {
  b.addEventListener('click', () => {
    if (mustDifferNow() && b.dataset.tyre === tpStart) return;
    tpPit = b.dataset.tyre;
    refreshTyrePicker();
  });
});

// mode 'session' = before qualifying/race; 'pit' = mid-session stop (practice)
function showTyrePicker(mode) {
  tpMode = mode || 'session';
  const wet = G.weather && G.weather.wetness > 0.3;
  document.querySelectorAll('.tyre-btn.wet-tyre').forEach(b => b.classList.toggle('hidden', !wet));
  const isWetC = n => n === 'inter' || n === 'wet';
  if (wet) tpStart = G.weather.wetness > 0.7 ? 'wet' : 'inter';
  else if (isWetC(tpStart)) tpStart = 'medium';
  // never leave a selection pointing at a compound whose button is hidden —
  // that's how a wet session's choice leaked into the next dry one
  if (!wet) {
    if (isWetC(tpPit)) tpPit = 'hard';
    if (isWetC(tpPit2)) tpPit2 = 'soft';
  } else if (!isWetC(tpPit)) {
    tpPit = tpStart;              // sensible wet default: another set of the same
  }

  const race = tpMode === 'session' && G.mode === 'race';
  // strategy step comes first in a race, with a per-track recommendation
  if (race) {
    const rec = recommendedStops();
    tpStops = rec;
    $('tp-rec').textContent = 'RECOMMENDED HERE: ' + (rec === 0 ? 'NO STOP' : rec + (rec > 1 ? ' STOPS' : ' STOP'));
    document.querySelector('#tp-strat-row [data-stops="0"]').classList.toggle('hidden', G.raceLaps > 20);
  }
  $('tp-strat-label').classList.toggle('hidden', !race);
  $('tp-strat-row').classList.toggle('hidden', !race);
  $('tp-rec').classList.toggle('hidden', !race);

  $('tp-title-text').textContent = tpMode === 'pit' ? 'Pit Stop — Choose Tyre' : 'Select Tyres';
  if (tpMode === 'pit') $('tp-start-label').textContent = 'FITTING';
  else $('tp-start-label').textContent = 'STARTING TYRE';

  const mustDiffer = race && G.raceLaps > 20 && !wet;
  if (mustDiffer && tpPit === tpStart) tpPit = TYRE_ORDER.find(n => n !== tpStart);
  const wxEl = $('tp-weather');
  if (wxEl) { wxEl.textContent = 'FORECAST: ' + (G.weather ? G.weather.forecast : 'DRY'); wxEl.style.color = wet ? '#6fb0ff' : '#7d8db0'; }
  refreshTyrePicker();
  tyrePicker.classList.remove('hidden');
  G.state = 'tyrepick';
}

document.querySelectorAll('#tp-strat-row [data-stops]').forEach(b => {
  b.addEventListener('click', () => { tpStops = +b.dataset.stops; refreshTyrePicker(); });
});
document.querySelectorAll('#tp-pit2-row .tyre-btn').forEach(b => {
  b.addEventListener('click', () => { tpPit2 = b.dataset.tyre; refreshTyrePicker(); });
});

$('tp-confirm').addEventListener('click', () => {
  if (G.state !== 'tyrepick' || !G.player) return;
  tyrePicker.classList.add('hidden');
  const c = G.player;

  if (tpMode === 'pit') {
    // mid-session stop: fit this compound at the next box
    c.pitPlan = [tpStart];
    const nextLap = armPit(c);
    showBanner(nextLap ? 'BOX NEXT LAP' : 'BOX THIS LAP', 1.8, '#ffd12e');
    G.state = 'driving';
    lastT = performance.now();
    return;
  }

  c.phys.setTyre(tpStart);
  // planned stops, in order — the pit machine works through this list
  c.pitPlan = G.mode === 'race'
    ? [tpPit, tpPit2].slice(0, tpStops)
    : [tpPit];                       // qualifying: one planned change
  c.pitCompound = c.pitPlan[0] || null;
  G.plannedStops = G.mode === 'race' ? tpStops : 0;
  if (G.mode === 'race') {
    G.countdown = { phase: 0, t: 1.2 };
  } else {
    G.raceStarted = true;
    showBanner('QUALIFYING — ' + Math.floor(QUALI_TIME/60) + ' MINUTES ON THE CLOCK', 3);
  }
  G.state = 'driving';
  lastT = performance.now();
});

// ---------- banner ----------
function showBanner(text, secs, color) {
  banner.textContent = text;
  banner.style.color = color || '#fff';
  banner.style.display = 'block';
  G.msgTimer = secs;
}

// ---------- timing ----------
function fmtTime(s) {
  if (s == null || !isFinite(s)) return '--:--.---';
  const m = Math.floor(s/60);
  const sec = s - m*60;
  return m + ':' + sec.toFixed(3).padStart(6,'0');
}

// Race fastest lap: any car (AI or player) that betters it triggers the purple
// banner and takes the FL marker in the timing tower.
function noteRaceLap(car, lapTime) {
  if (G.mode !== 'race' || !(lapTime > 15)) return;
  const fl = G.raceFL;
  if (!fl || lapTime < fl.time - 1e-6) {
    G.raceFL = { time: lapTime, id: car.driver.id };
    // don't fanfare the very first lap of the race (everyone's is a "record")
    if (fl) {
      showBanner('FASTEST LAP  ·  ' + car.driver.id + '  ' + fmtTime(lapTime), 2.6, '#a640ff');
    }
  }
}

function onPlayerLapComplete() {
  const p = G.player;
  const lapTime = G.simTime - p.curLapStart;
  // close out sector 3 (from last sector boundary to the line)
  finishSector(2, G.simTime - G.sectorEntryTime);
  p.curLapStart = G.simTime;
  // a track-limits deletion voids this lap for best-time purposes
  const invalid = p.lapInvalid;
  p.lapInvalid = false;
  // keep a pace reference even from deleted laps, so the delta still works
  // on the next lap (a deletion voids the TIME, not your reference pace)
  if (lapTime > 15 && (G.refTime == null || lapTime < G.refTime)) {
    G.refTime = lapTime;
    G.refCheckpoints = G.curCheckpoints.slice();
  }
  if (lapTime > 15 && invalid) {
    $('last-time').textContent = fmtTime(lapTime) + ' ✗';
  } else if (lapTime > 15) { // sanity: ignore instant re-crossings
    p.lapTimes.push(lapTime);
    $('last-time').textContent = fmtTime(lapTime);
    noteRaceLap(p, lapTime);
    if (!p.bestLap || lapTime < p.bestLap) {
      p.bestLap = lapTime;
      p.bestLapTyre = p.phys.compound; // tyre the best lap was set on
      $('best-time').textContent = fmtTime(lapTime);
      G.bestCheckpoints = G.curCheckpoints.slice();
      G.pbLapSectors = G.curSectors.slice(); // this lap's sectors become the green benchmark
      const newRecord = saveRecord(G.trackDef.id, lapTime);
      if (newRecord && G.hadRecord) showBanner('NEW TRACK RECORD  ' + fmtTime(lapTime), 2.6, '#ffd12e');
      else if (p.lapTimes.length > 1) showBanner('NEW BEST LAP  ' + fmtTime(lapTime), 2.2, '#a640ff');
    }
    const d = p.bestLap ? lapTime - p.bestLap : 0;
    const el = $('delta-time');
    el.textContent = (d >= 0 ? '+' : '') + d.toFixed(3);
    el.className = 't-val ' + (d <= 0 ? 'delta-neg' : 'delta-pos');
  }
  G.curCheckpoints = [];
  // start a fresh lap of sectors — bars blank out and start timing again
  G.curSectors = [null,null,null];
  G.curSec = 0;
  G.sectorEntryTime = G.simTime;
  clearSectorBars();

  // qualifying runs on the clock: every crossing counts as a lap (valid or
  // deleted). The session ends once the chequered flag is out and you've
  // completed the lap you were on.
  if (G.mode === 'qualify') {
    G.qualiLapsDone++;
    if (G.qualiFlag) endQualify();
  }
  // season races checkpoint once per lap, so quitting costs at most this lap
  if (G.seasonActive && G.mode === 'race' && !p.finished) saveRaceSnapshot();
}

// record a completed sector and colour it (purple/green/yellow)
function finishSector(i, ts) {
  if (!(ts > 3)) return; // ignore bogus splits
  G.curSectors[i] = ts;
  let cls;
  if (G.sectorSB[i] == null || ts < G.sectorSB[i]) { G.sectorSB[i] = ts; cls = 'sb'; }
  else if (G.pbLapSectors[i] != null && ts <= G.pbLapSectors[i] + 0.001) cls = 'pb';
  else cls = 'slow';
  const el = $('sec'+i);
  el.textContent = 'S'+(i+1)+' '+ts.toFixed(1);
  el.className = 'sec ' + cls;
}

// called each frame while driving: detect sector boundary crossings
function updateSectors() {
  const p = G.player.phys;
  const frac = p.lapDist / G.track.length;
  const sec = frac < 1/3 ? 0 : frac < 2/3 ? 1 : 2;
  if (sec === G.curSec + 1) { // forward into next sector (S1→S2 or S2→S3)
    finishSector(G.curSec, G.simTime - G.sectorEntryTime);
    G.curSec = sec;
    G.sectorEntryTime = G.simTime;
  }
  // live running time in the sector you're currently in
  const el = $('sec' + G.curSec);
  if (el && G.curSectors[G.curSec] == null) {
    el.textContent = 'S' + (G.curSec+1) + ' ' + (G.simTime - G.sectorEntryTime).toFixed(1);
    el.className = 'sec live';
  }
  // S3→S1 wrap is handled by onPlayerLapComplete
}

// blank all three sector bars (start of a new lap)
function clearSectorBars() {
  ['sec0','sec1','sec2'].forEach((id,i) => {
    const el = $(id);
    if (el) { el.textContent = 'S'+(i+1)+' --.-'; el.className = 'sec'; }
  });
}

// live delta via checkpoint buckets (every ~2% of lap)
function recordCheckpoint() {
  const p = G.player.phys;
  const frac = p.lapDist / G.track.length;
  const bucket = Math.floor(frac * 50);
  if (G.curCheckpoints[bucket] == null) {
    G.curCheckpoints[bucket] = G.simTime - G.player.curLapStart;
    // prefer the best VALID lap; fall back to the fastest lap of any kind so a
    // deleted lap doesn't leave you with no delta reference
    const ref = G.bestCheckpoints || G.refCheckpoints;
    if (ref && ref[bucket] != null) {
      const d = G.curCheckpoints[bucket] - ref[bucket];
      const el = $('delta-time');
      el.textContent = (d >= 0 ? '+' : '') + d.toFixed(2);
      el.className = 't-val ' + (d <= 0 ? 'delta-neg' : 'delta-pos');
    }
  }
}

// ---------- session end ----------
// compact tyre dot for the live position tower
function tyreDot(compound) {
  const cw = COMPOUNDS[compound];
  if (!cw) return '';
  const col = '#' + cw.color.toString(16).padStart(6,'0');
  const ink = (compound === 'medium' || compound === 'hard') ? '#151515' : '#fff';
  return '<span class="p-tyre" style="background:'+col+';color:'+ink+'">'+cw.label+'</span>';
}

// small coloured compound badge for results tables
function tyreTag(compound) {
  const cw = COMPOUNDS[compound];
  if (!cw) return '';
  const col = '#' + cw.color.toString(16).padStart(6,'0');
  const dark = (compound === 'medium' || compound === 'hard') ? '#151515' : '#fff';
  return ' <span style="display:inline-block;min-width:15px;text-align:center;background:'+col
    + ';color:'+dark+';font-size:9.5px;font-weight:900;padding:1px 4px;border-radius:3px;'
    + 'margin-left:6px;vertical-align:middle">'+cw.label+'</span>';
}

function endQualify() {
  const p = G.player;
  const rows = G.qualiAITimes.map(q => ({ id:q.driver.id, name:q.driver.name, team:q.driver.team, time:q.time, tyre:q.tyre, me:false }));
  rows.push({ id:'VER', name:'Max Verstappen', team:'redbull', time:p.bestLap || 9999,
              tyre:p.bestLapTyre || p.phys.compound, me:true });
  rows.sort((a,b)=>a.time-b.time);
  if (G.weekend) {
    // this order becomes the race grid
    G.gpGrid = rows.map(r => r.id);
    // qualifying is done — bank the grid so quitting here resumes at the race
    if (G.seasonActive) saveSeasonProgress('race');
    const myPos = rows.findIndex(r => r.me) + 1;
    showBanner('QUALIFIED P' + myPos, 2.5, myPos<=3 ? '#a640ff' : '#fff');
  }
  showResults((G.weekend ? 'Qualifying (P' + (rows.findIndex(r=>r.me)+1) + ') — ' : 'Qualifying — ') + G.trackDef.gp,
    rows.map((r,i)=>({
      pos:i+1, name:r.name, team:r.team, me:r.me,
      val: (r.time >= 9999 ? 'NO TIME' : (i===0 ? fmtTime(r.time) : '+'+(r.time-rows[0].time).toFixed(3)))
        + (r.time < 9999 && r.tyre ? tyreTag(r.tyre) : ''),
    })), G.weekend ? 'Start Race' : null);
}

// skip qualifying: AI grid from simulated times, player slotted in at random
function skipQualify() {
  const rows = G.qualiAITimes.map(q => ({ id:q.driver.id, name:q.driver.name, team:q.driver.team, time:q.time, tyre:q.tyre, me:false }));
  rows.sort((a,b) => a.time - b.time);
  const slot = Math.floor(Math.random()*22); // random P1..P22
  rows.splice(slot, 0, { id:'VER', name:'Max Verstappen', team:'redbull', time:null, me:true });
  G.gpGrid = rows.map(r => r.id);
  if (G.seasonActive) saveSeasonProgress('race');  // grid banked
  const myPos = slot + 1;
  showBanner('QUALIFYING SKIPPED — P' + myPos, 2.5, '#ffd12e');
  showResults('Qualifying (P' + myPos + ' - RANDOM GRID) — ' + G.trackDef.gp,
    rows.map((r,i)=>({
      pos:i+1, name:r.name, team:r.team, me:r.me,
      val: r.me ? 'SKIPPED' : fmtTime(r.time) + (r.tyre ? tyreTag(r.tyre) : ''),
    })), 'Start Race');
}

$('btn-skipq').addEventListener('click', () => {
  if (!(G.weekend && G.mode === 'qualify')) return;
  skipQualify();
});

// leave qualifying early: your lap time is locked, and the remaining session is
// simulated for the AI — with time still on the clock they push harder, so you
// can drop a position or two. The more time you leave on the table, the more
// they improve (weighted by driver skill).
function endQualifyEarly() {
  if (G.mode !== 'qualify') return;
  const fRemain = Math.max(0, Math.min(1, G.qualiTime / QUALI_TIME));
  G.qualiAITimes.forEach(q => {
    // top drivers extract more from extra track time; up to ~2% at a full session
    const gain = fRemain * (0.3 + q.driver.skill * 0.7) * 0.02;
    q.time *= (1 - gain);
  });
  G.state = 'driving';        // leave the pause screen
  showScreen(null);
  if (fRemain > 0.05) showBanner('SESSION ENDED — RIVALS STILL PUSHING…', 2, '#ffd12e');
  endQualify();
}

$('btn-endq').addEventListener('click', endQualifyEarly);

function endRace() {
  // classify: finished cars by time, others by progress
  // mandatory-stop rule (races > 20 laps): +25s if a car never pitted
  // FIA: failing to use two dry compounds is a DISQUALIFICATION, not a time
  // penalty — so skipping the stop can never be the quick way out.
  if (G.raceLaps > 20) {
    G.cars.forEach(c => {
      if (c.finished && !c.pitted) c.dsq = true;
    });
  }
  // stewards' time penalties applied to the finishing time
  G.cars.forEach(c => {
    const pen = (G.penalties && G.penalties[c.driver.id]) || 0;
    if (pen > 0 && c.finished && !c._stewApplied) {
      c.finishTime += pen;
      c._stewApplied = true;
      c.stewPen = pen;
    }
  });
  const rows = G.cars.slice().sort((a,b) => {
    if (!!a.dsq !== !!b.dsq) return a.dsq ? 1 : -1; // DSQ classified last
    if (!!a.retired !== !!b.retired) return a.retired ? 1 : -1;  // DNF below runners
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.phys.totalDist - a.phys.totalDist;
  });
  const winner = rows.find(r => !r.dsq && r.finished) || rows[0];
  const winT = winner.finishTime || G.simTime;
  const myPos = rows.findIndex(r => r.driver && r.driver.player) + 1;
  // fastest race lap across the whole field (AI laps timed in stepSim)
  let flCar = null;
  G.cars.forEach(c => {
    if (c.bestLap != null && (!flCar || c.bestLap < flCar.bestLap)) flCar = c;
  });
  const flTop10 = flCar ? rows.indexOf(flCar) < 10 : false;
  let nextLabel = null;
  if (G.seasonActive) {
    if (!G.seasonData.teamPoints) G.seasonData.teamPoints = {};
    if (!G.seasonData.history) G.seasonData.history = [];
    // championship points by finishing order, then move the calendar on
    rows.forEach((r,i) => {
      if (i < SEASON_POINTS.length) {
        const id = r.driver.id, team = r.driver.team;
        G.seasonData.points[id] = (G.seasonData.points[id] || 0) + SEASON_POINTS[i];
        G.seasonData.teamPoints[team] = (G.seasonData.teamPoints[team] || 0) + SEASON_POINTS[i];
      }
    });
    // fastest lap point: holder must finish in the top 10 (like real F1)
    if (flCar && flTop10) {
      const id = flCar.driver.id, team = flCar.driver.team;
      G.seasonData.points[id] = (G.seasonData.points[id] || 0) + 1;
      G.seasonData.teamPoints[team] = (G.seasonData.teamPoints[team] || 0) + 1;
    }
    G.seasonData.history.push({
      round: G.seasonData.round + 1,
      trackId: G.trackDef.id,
      gp: G.trackDef.gp,
      winnerId: rows[0].driver.id,
      playerPos: myPos,
      flId: flCar ? flCar.driver.id : null,
    });
    G.seasonData.round++;
    G.seasonData.session = null;   // weekend done — next entry lands on standings
    G.seasonData.grid = null;
    saveSeason();
    clearRaceSnapshot();
    nextLabel = 'Standings';
  }
  // Time gap for cars that never took the flag. They have no finishTime, so
  // work one out from how far behind they actually were and the pace they were
  // running: distance still to cover / their own average speed. Real timing
  // screens just say "+1 Lap", but the seconds are more use when you want to
  // know how close it was.
  const lapsOf = r => Math.max(1, G.raceLaps + 1 - r.phys.lap);
  function projectedGap(r) {
    const raced = r.phys.totalDist;
    const full = G.raceLaps * G.track.length;
    const behind = Math.max(0, full - raced);
    // their own average pace over the race, falling back to the winner's
    const elapsed = Math.max(1, G.simTime);
    const pace = raced > 100 ? raced / elapsed : G.track.length / Math.max(1, winner.bestLap || 90);
    return behind / Math.max(5, pace);
  }
  const resRows = rows.map((r,i)=>({
    pos:i+1, name:r.driver.name, team:r.driver.team, me:!!r.driver.player,
    val: (r.retired ? 'DNF — damage'
       : r.dsq ? 'DSQ — no mandatory stop'
       : r.finished ? (i===0 ? fmtTime(r.finishTime) : '+'+(r.finishTime-winT).toFixed(3))
       : '+' + fmtTime(projectedGap(r)) + ' (' + lapsOf(r) + ' Lap' + (lapsOf(r)>1?'s':'') + ')')
       + (r.stewPen ? ' (+' + r.stewPen + 's PEN)' : '')
       + (r === flCar ? ' · <span style="color:#a640ff">FL</span>' : ''),
  }));
  const title = 'Race — ' + G.trackDef.gp
    + (flCar ? ' · FASTEST LAP: ' + flCar.driver.id + ' ' + fmtTime(flCar.bestLap) : '');
  if (myPos >= 1 && myPos <= 3) {
    // podium finish: celebrate first, results follow on Continue
    G.pendingResults = { title, rows: resRows, nextLabel };
    showPodium(myPos);
  } else {
    showResults(title, resRows, nextLabel);
    // prominent finish position headline for off-podium results
    $('results-title').textContent = 'You finished P' + myPos + ' — Race Results';
  }
}

// ---------- podium celebration ----------
function showPodium(pos) {
  G.state = 'results';
  hud.classList.remove('active');
  banner.style.display = 'none';
  const me = DRIVERS.find(d => d.player);
  const posEl = $('podium-pos');
  posEl.textContent = 'P' + pos;
  posEl.className = 'p' + pos;
  $('podium-name').textContent = me.name.toUpperCase();
  $('podium-sub').textContent = pos === 1
    ? 'RACE WINNER — ' + G.trackDef.gp.toUpperCase()
    : 'P' + pos + ' — PODIUM FINISH';
  showScreen(null);
  $('podium-screen').classList.remove('hidden');
  if (!REDUCED_MOTION) startConfetti();
  playFanfare(pos);
}

$('podium-continue').addEventListener('click', () => {
  $('podium-screen').classList.add('hidden');
  stopConfetti();
  const pr = G.pendingResults;
  G.pendingResults = null;
  if (pr) showResults(pr.title, pr.rows, pr.nextLabel);
});

// original ascending beep fanfare (simple arpeggio, nothing copied)
function playFanfare(pos) {
  AUDIO.crash(0.1); // crowd-noise burst
  const seq = pos === 1
    ? [[523,0,0.18],[659,160,0.18],[784,320,0.18],[1047,480,0.55]]
    : pos === 2
    ? [[440,0,0.14],[554,150,0.14],[659,300,0.4]]
    : [[392,0,0.14],[494,150,0.14],[587,300,0.35]];
  seq.forEach(s => setTimeout(() => AUDIO.beep(s[0], s[2], 0.13), s[1]));
}

let confettiActive = false;
function startConfetti() {
  const cv = $('confetti-canvas');
  const ctx = cv.getContext && cv.getContext('2d');
  if (!ctx) return;
  cv.width = window.innerWidth || 800;
  cv.height = window.innerHeight || 600;
  const colors = ['#ffd12e','#e10600','#3671c6','#2ecc71','#ffffff','#a640ff'];
  const parts = [];
  for (let i = 0; i < 120; i++) parts.push({
    x: Math.random()*cv.width, y: -Math.random()*cv.height,
    vx: (Math.random()-0.5)*40, vy: 60 + Math.random()*120,
    w: 4 + Math.random()*5, h: 6 + Math.random()*8,
    rot: Math.random()*Math.PI*2, vr: (Math.random()-0.5)*6,
    color: colors[Math.floor(Math.random()*colors.length)],
  });
  const t0 = performance.now();
  let last = t0;
  confettiActive = true;
  function tick(now) {
    if (!confettiActive || $('podium-screen').classList.contains('hidden')) {
      confettiActive = false;
      return;
    }
    const dt = Math.min(0.05, (now - last)/1000);
    last = now;
    const respawn = now - t0 < 6000; // keep raining for ~6s
    ctx.clearRect(0, 0, cv.width, cv.height);
    let alive = false;
    for (const p of parts) {
      p.vy += 60*dt;                       // gravity
      p.x += p.vx*dt + Math.sin(now/400 + p.rot)*20*dt; // drift
      p.y += p.vy*dt;
      p.rot += p.vr*dt;
      if (p.y > cv.height + 20) {
        if (!respawn) continue;
        p.y = -20; p.x = Math.random()*cv.width;
        p.vy = 60 + Math.random()*120;
      }
      alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      ctx.restore();
    }
    if (!alive) { confettiActive = false; return; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
function stopConfetti() { confettiActive = false; }

function showResults(title, rows, nextLabel) {
  G.state = 'results';
  hud.classList.remove('active');
  AUDIO.musicDuck(false); // session over — music returns
  $('results-title').textContent = title.split(' — ')[0] + ' Results';
  $('results-sub').textContent = title.split(' — ')[1] || '';
  const tbl = $('results-table');
  tbl.innerHTML = '';
  rows.forEach(r => {
    const div = document.createElement('div');
    div.className = 'res-row' + (r.me ? ' me' : '');
    const sw = '#' + TEAMS[r.team].color.toString(16).padStart(6,'0');
    div.innerHTML = '<span class="r-pos">'+r.pos+'</span>'
      + '<span style="width:5px;height:14px;border-radius:2px;background:'+sw+'"></span>'
      + '<span class="r-name">'+r.name+'</span><span class="r-time">'+r.val+'</span>';
    tbl.appendChild(div);
  });
  // "Continue" button drives the Grand Prix weekend forward
  const nextBtn = $('btn-next');
  if (nextLabel) {
    nextBtn.textContent = nextLabel;
    nextBtn.classList.remove('hidden');
  } else {
    nextBtn.classList.add('hidden');
  }
  showScreen('results');
}

// advance the Grand Prix weekend: practice → qualify → race
function advanceWeekend() {
  if (!G.weekend) return;
  if (G.mode === 'practice') { G.mode = 'qualify'; saveSeasonProgress('qualify'); startSession(); }
  else if (G.mode === 'qualify') {
    G.mode = 'race'; G.raceType = 'full';
    saveSeasonProgress('race');   // stores the qualifying grid too
    startSession();
  }
}

// ---------- season mode (24-round championship of GP weekends) ----------
const SEASON_POINTS = [25,18,15,12,10,8,6,4,2,1];
function loadSeason() {
  try { return JSON.parse(localStorage.getItem('f1sim_season') || 'null'); }
  catch(e) { return null; }
}
function saveSeason() {
  try { localStorage.setItem('f1sim_season', JSON.stringify(G.seasonData)); } catch(e) {}
}
function clearSeason() {
  try { localStorage.removeItem('f1sim_season'); } catch(e) {}
}
// rebuild constructors' points from driver points (migration for old saves)
function rebuildTeamPoints(points) {
  const tp = {};
  DRIVERS.forEach(d => {
    const p = (points && points[d.id]) || 0;
    if (p) tp[d.team] = (tp[d.team] || 0) + p;
  });
  return tp;
}
// normalize a loaded save: old saves lack teamPoints/history
function normalizeSeason(saved) {
  const points = saved.points || {};
  return {
    round: saved.round,
    points,
    teamPoints: saved.teamPoints || rebuildTeamPoints(points),
    history: saved.history || [],
    session: saved.session || null,
    grid: saved.grid || null,
  };
}
function freshSeason() { return { round: 0, points: {}, teamPoints: {}, history: [], session: null, grid: null }; }

// rebuild a race mid-flight from a snapshot: every car back where it was, on
// the tyres it was using, with its wear, damage to its strategy and penalties
function restoreRace(snap) {
  const t = G.track;
  G.raceLaps = snap.raceLaps;
  G.difficulty = snap.difficulty != null ? snap.difficulty : G.difficulty;
  G.simTime = snap.simTime || 0;
  G.firstFinish = snap.firstFinish || null;
  G.penalties = snap.penalties || {};
  if (snap.weather) { G.weather = snap.weather; setWetness(G.weather.wetness); applyWeatherVisuals(); }

  snap.cars.forEach(cs => {
    const d = DRIVERS.find(x => x.id === cs.id);
    if (!d) return;
    const car = makeCar(d, t);
    const p = car.phys;
    p.x = cs.x; p.z = cs.z; p.heading = cs.heading; p.speed = cs.speed;
    p.trackIdx = t.nearest(cs.x, cs.z, null);
    p.lapDist = t.dist[p.trackIdx];
    p.totalDist = cs.totalDist;
    p.lap = cs.lap;
    p._lastCrossDist = cs.totalDist;   // don't fire a phantom lap on the first step
    p.setTyre(cs.compound);            // resets wear/temp, so restore them after
    p.tyreWearKm = cs.wear; p.tyreTemp = cs.temp;
    car.finished = cs.finished; car.finishTime = cs.finishTime; car.bestLap = cs.bestLap;
    car.pitted = cs.pitted; car.pitted2 = cs.pitted2;
    car.pitPlan = cs.pitPlan ? cs.pitPlan.slice() : null;
    car.pitCompound = cs.pitCompound; car.pitLap = cs.pitLap; car.pitLap2 = cs.pitLap2;
    car.limitStrikes = cs.limitStrikes; car.collCount = cs.collCount;
    car.driveThroughServed = cs.dtServed;
    car._lapStart = cs.lapStart; car.curLapStart = cs.curLapStart;
    G.cars.push(car);
    if (d.player) G.player = car;
  });

  const pl = snap.player || {};
  if (G.player) {
    G.player.lapTimes = pl.lapTimes || [];
    G.player.bestLap = pl.bestLap || null;
    G.player.bestLapTyre = pl.bestLapTyre || null;
  }
  G.sectorSB = pl.sectorSB || [null,null,null];
  G.pbLapSectors = pl.pbLapSectors || [null,null,null];
  G.bestCheckpoints = pl.bestCheckpoints || null;
  G.refCheckpoints = pl.refCheckpoints || null;
  G.refTime = pl.refTime || null;
  G.curSectors = [null,null,null];
  G.curSec = 0;
  G.sectorEntryTime = G.simTime;
  if (G.player) G.player.curLapStart = G.simTime; // current lap restarts cleanly
  if (pl.bestLap) $('best-time').textContent = fmtTime(pl.bestLap);

  // straight back to green — no countdown, no tyre picker
  G.countdown = null;
  G.raceStarted = true;
  G.state = 'driving';
  showBanner('RESUMING — LAP ' + Math.min(G.player ? G.player.phys.lap : 1, G.raceLaps) + ' / ' + G.raceLaps, 2.5, '#ffd12e');
}

// ---------- mid-race snapshot (season only, written once per lap) ----------
const RACE_SNAP_KEY = 'f1sim_race', RACE_SNAP_V = 1;

function saveRaceSnapshot() {
  if (!G.seasonActive || G.mode !== 'race' || !G.raceStarted) return;
  try {
    const snap = {
      v: RACE_SNAP_V,
      round: G.seasonData.round,
      trackId: G.trackDef.id,
      raceLaps: G.raceLaps,
      raceDist: G.raceDist,
      difficulty: G.difficulty,
      simTime: G.simTime,
      firstFinish: G.firstFinish,
      weather: JSON.parse(JSON.stringify(G.weather)),
      penalties: G.penalties,
      cars: G.cars.map(c => ({
        id: c.driver.id,
        x: c.phys.x, z: c.phys.z, heading: c.phys.heading, speed: c.phys.speed,
        lap: c.phys.lap, totalDist: c.phys.totalDist,
        compound: c.phys.compound, wear: c.phys.tyreWearKm, temp: c.phys.tyreTemp,
        finished: c.finished, finishTime: c.finishTime, bestLap: c.bestLap,
        pitted: c.pitted, pitted2: c.pitted2, pitPlan: c.pitPlan || null,
        pitCompound: c.pitCompound, pitLap: c.pitLap, pitLap2: c.pitLap2,
        limitStrikes: c.limitStrikes || 0, collCount: c.collCount || 0,
        dtServed: !!c.driveThroughServed,
        lapStart: c._lapStart || 0, curLapStart: c.curLapStart || 0,
      })),
      player: {
        lapTimes: G.player.lapTimes, bestLap: G.player.bestLap, bestLapTyre: G.player.bestLapTyre,
        sectorSB: G.sectorSB, pbLapSectors: G.pbLapSectors,
        bestCheckpoints: G.bestCheckpoints, refCheckpoints: G.refCheckpoints, refTime: G.refTime,
      },
    };
    localStorage.setItem(RACE_SNAP_KEY, JSON.stringify(snap));
  } catch(e) {}
}
function loadRaceSnapshot() {
  try {
    const s = JSON.parse(localStorage.getItem(RACE_SNAP_KEY) || 'null');
    return (s && s.v === RACE_SNAP_V) ? s : null;
  } catch(e) { return null; }
}
function clearRaceSnapshot() { try { localStorage.removeItem(RACE_SNAP_KEY); } catch(e) {} }

// remember exactly where we are inside a weekend, so quitting mid-session
// resumes there instead of restarting the round
function saveSeasonProgress(session) {
  if (!G.seasonActive) return;
  G.seasonData.session = session;
  G.seasonData.grid = G.gpGrid || null;
  saveSeason();
}

function openSeason() {
  const saved = loadSeason();
  const inProgress = saved && typeof saved.round === 'number' && saved.round < TRACKS.length
    && (saved.round > 0 || saved.session);
  if (inProgress) {
    G.seasonData = normalizeSeason(saved);
    if (G.seasonData.session) {
      // mid-weekend: drop straight back into the session that was running
      G.weekend = true;
      G.seasonActive = true;
      G.trackDef = TRACKS[G.seasonData.round];
      G.mode = G.seasonData.session;
      G.gpGrid = G.seasonData.grid || null;
      // a race in progress resumes exactly where it stopped
      const rs = loadRaceSnapshot();
      G.pendingRaceSnap = (G.mode === 'race' && rs && rs.round === G.seasonData.round
        && rs.trackId === G.trackDef.id) ? rs : null;
      startSession();
    } else {
      showStandings();   // between rounds
    }
  } else {
    G.seasonData = freshSeason();
    startSeasonRound();
  }
}
function startSeasonRound() {
  const def = TRACKS[G.seasonData.round];
  if (!def) { showStandings(); return; } // calendar exhausted → season complete
  G.weekend = true;
  G.seasonActive = true;
  G.trackDef = def;
  G.mode = 'practice';
  G.gpGrid = null;
  clearRaceSnapshot();   // new weekend — any old race snapshot is stale
  saveSeasonProgress('practice');
  startSession();
}
let standingsView = 'drivers'; // drivers | teams | calendar
function swatchHtml(hex) {
  return '<span style="width:5px;height:14px;border-radius:2px;background:'+hex+'"></span>';
}
function teamSwatch(teamKey) {
  return swatchHtml('#' + TEAMS[teamKey].color.toString(16).padStart(6,'0'));
}
function renderStandingsTable() {
  const sd = G.seasonData;
  const tbl = $('standings-table');
  tbl.innerHTML = '';
  if (standingsView === 'teams') {
    const tp = sd.teamPoints || {};
    const order = Object.keys(TEAMS).sort((a,b) => (tp[b]||0) - (tp[a]||0));
    order.forEach((key,i) => {
      const div = document.createElement('div');
      div.className = 'res-row' + (key === 'redbull' ? ' me' : '');
      div.innerHTML = '<span class="r-pos">'+(i+1)+'</span>'
        + teamSwatch(key)
        + '<span class="r-name">'+TEAMS[key].name+'</span><span class="r-time">'+(tp[key]||0)+' pts</span>';
      tbl.appendChild(div);
    });
  } else if (standingsView === 'calendar') {
    const hist = sd.history || [];
    TRACKS.forEach((def,i) => {
      const h = hist.find(e => e.round === def.round) || (i < sd.round ? hist[i] : null);
      const isNext = !h && i === sd.round;
      const div = document.createElement('div');
      div.className = 'res-row' + (isNext ? ' me' : '');
      let val, sw = '<span style="width:5px;height:14px"></span>';
      if (h) {
        const winner = DRIVERS.find(d => d.id === h.winnerId);
        if (winner) sw = teamSwatch(winner.team);
        val = 'W: ' + h.winnerId + ' · You: P' + h.playerPos
          + (h.flId ? ' · <span style="color:#a640ff">FL ' + h.flId + '</span>' : '');
      } else if (isNext) {
        val = 'NEXT →';
      } else {
        val = '—';
        div.style.opacity = '0.45';
      }
      div.innerHTML = '<span class="r-pos">'+def.round+'</span>' + sw
        + '<span class="r-name">'+def.gp+'</span><span class="r-time">'+val+'</span>';
      tbl.appendChild(div);
    });
  } else {
    const order = DRIVERS.slice().sort((a,b) => (sd.points[b.id]||0) - (sd.points[a.id]||0));
    order.forEach((d,i) => {
      const div = document.createElement('div');
      div.className = 'res-row' + (d.player ? ' me' : '');
      div.innerHTML = '<span class="r-pos">'+(i+1)+'</span>'
        + teamSwatch(d.team)
        + '<span class="r-name">'+d.name+'</span><span class="r-time">'+(sd.points[d.id]||0)+' pts</span>';
      tbl.appendChild(div);
    });
  }
}
function setStandingsView(view) {
  standingsView = view;
  [['st-view-drivers','drivers'],['st-view-teams','teams'],['st-view-calendar','calendar']].forEach(([id,v]) => {
    $(id).classList.toggle('selected', v === view);
  });
  renderStandingsTable();
}
$('st-view-drivers').addEventListener('click', () => setStandingsView('drivers'));
$('st-view-teams').addEventListener('click', () => setStandingsView('teams'));
$('st-view-calendar').addEventListener('click', () => setStandingsView('calendar'));
function showStandings() {
  const sd = G.seasonData;
  if (!sd.teamPoints) sd.teamPoints = rebuildTeamPoints(sd.points);
  if (!sd.history) sd.history = [];
  const done = sd.round >= TRACKS.length || !TRACKS[sd.round];
  const order = DRIVERS.slice().sort((a,b) => (sd.points[b.id]||0) - (sd.points[a.id]||0));
  $('standings-sub').textContent = done
    ? 'SEASON COMPLETE — Champion: ' + order[0].name
    : 'After Round ' + sd.round + ' of ' + TRACKS.length + ' — Next: ' + TRACKS[sd.round].gp;
  setStandingsView('drivers'); // default view is always Drivers
  $('btn-nextround').classList.toggle('hidden', done);
  hud.classList.remove('active');
  showScreen('standings');
}
$('btn-nextround').addEventListener('click', startSeasonRound);
$('btn-newseason').addEventListener('click', () => {
  clearSeason();
  clearRaceSnapshot();
  G.seasonData = freshSeason();
  startSeasonRound();
});
$('btn-standings-menu').addEventListener('click', backToMenu);
// restore any saved season at boot
{
  const s = loadSeason();
  if (s && typeof s.round === 'number') G.seasonData = normalizeSeason(s);
}

// ---------- HUD ----------
function updateLapPanel() {
  const p = G.player;
  if (!p) return;
  if (G.mode === 'race') {
    $('lap-val').textContent = Math.min(Math.max(p.phys.lap,1), G.raceLaps) + ' / ' + G.raceLaps;
    $('lap-label').textContent = 'LAP';
  } else if (G.mode === 'qualify') {
    $('lap-val').textContent = String(G.qualiLapsDone);
    $('lap-label').textContent = 'LAPS DONE';
  } else {
    $('lap-val').textContent = String(p.lapTimes.length);
    $('lap-label').textContent = 'LAPS DONE';
  }
}

// purple FL marker for whoever holds the race fastest lap
function flTag(c) {
  return (G.raceFL && G.raceFL.id === c.driver.id)
    ? ' <span class="p-fl">FL</span>' : '';
}

function updateHUD() {
  const p = G.player;
  if (!p) return;
  $('speed-val').textContent = p.phys.kmh;
  $('gear-val').textContent = p.phys.gear;
  $('rpm-fill').style.width = (p.phys.rpmFrac*100).toFixed(0) + '%';
  // tyre compound + wear
  {
    const cw = COMPOUNDS[p.phys.compound];
    $('tyre-dot').style.borderColor = '#' + cw.color.toString(16).padStart(6,'0');
    $('tyre-letter').textContent = cw.label;
    const life = p.phys.tyreLife;
    $('tyre-fill').style.width = (life*100).toFixed(0) + '%';
    $('tyre-fill').style.background = life > 0.5 ? '#2ecc71' : life > 0.25 ? '#f5c518' : '#e74c3c';
    // pulse a pit reminder while the mandatory stop is outstanding
    const needPit = G.mode === 'race' && G.raceLaps > 20 && !p.pitted && !p.pitState && p.phys.lap >= 2;
    $('tyre-letter').textContent = cw.label + (needPit ? '  ·  P—PIT' : '');
    $('tyre-letter').style.color = needPit && (G.simTime % 1 < 0.5) ? '#ffd12e' : '#fff';
    // tyre temperature: blue = cold, green = in the window, red = overheating
    const T = p.phys.tyreTemp;
    const tempC = Math.round(45 + T * 75); // display as ~50-130°C
    const te = $('tyre-temp');
    te.textContent = tempC + '°';
    te.style.color = T < 0.45 ? '#6fb0ff' : T < 0.92 ? '#2ecc71' : '#ff5c5c';
    // DRS badge + detection readout
    const db = $('drs-badge');
    const s = G.playerDrsState;
    db.className = s === 2 ? 'open' : (s === 1 || s === 1.5) ? 'armed' : (s ? 'zone' : '');
    // damage readout — only appears once something is actually broken
    {
      const dmgEl = $('dmg-info');
      if (dmgEl) {
        const bits = [];
        if (p.phys.puncture > 0) bits.push('PUNCTURE');
        if (p.phys.dmgWing > 0.12) bits.push('WING ' + Math.round(p.phys.dmgWing*100) + '%');
        if (p.phys.dmgFloor > 0.12) bits.push('FLOOR ' + Math.round(p.phys.dmgFloor*100) + '%');
        dmgEl.textContent = bits.join(' · ');
        dmgEl.style.display = bits.length ? 'block' : 'none';
      }
    }
    const di = $('drs-info');
    if (di) {
      const tow = G.playerTow || 0;
      const towTxt = tow > 0.12 ? 'TOW ' + Math.round(tow * 100) + '%' : '';
      di.textContent = towTxt && G.drsInfo ? (towTxt + ' · ' + G.drsInfo)
                     : (towTxt || G.drsInfo || '');
      di.className = s === 2 ? 'open' : (s === 1 || s === 1.5) ? 'armed' : '';
    }
  }
  $('cur-time').textContent = G.raceStarted ? fmtTime(G.simTime - p.curLapStart) : '--:--.---';
  if (G.mode === 'qualify') {
    // count-down clock: mm:ss, red under 30s, "FLAG" once time is up
    const rem = Math.max(0, G.qualiTime);
    const mm = Math.floor(rem/60), ss = Math.floor(rem%60);
    const sc = $('session-clock');
    sc.textContent = G.qualiFlag ? '🏁 FINISH LAP' : ('Q  ' + mm + ':' + String(ss).padStart(2,'0'));
    sc.style.color = (!G.qualiFlag && rem < 30) ? '#ff5c5c' : '#dfe8ff';
  } else {
    $('session-clock').style.color = '#dfe8ff';
    $('session-clock').textContent = G.mode === 'race' ? '' : fmtTime(G.simTime);
  }

  // positions
  const panel = $('pos-panel');
  if (G.mode === 'race' && G.cars.length > 1) {
    const order = G.cars.slice().sort((a,b) => {
      if (!!a.retired !== !!b.retired) return a.retired ? 1 : -1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.phys.totalDist - a.phys.totalDist;
    });
    let html = '';
    const leader = order[0];
    order.forEach((c,i) => {
      const sw = '#' + TEAMS[c.driver.team].color.toString(16).padStart(6,'0');
      let gap = '';
      if (c.retired) gap = 'OUT';
      else if (i === 0) gap = c.finished ? 'FIN' : 'Leader';
      else if (c.finished) gap = '+' + (c.finishTime - leader.finishTime).toFixed(1);
      else {
        const dd = leader.phys.totalDist - c.phys.totalDist;
        gap = '+' + (dd / Math.max(c.phys.speed, 20)).toFixed(1) + 's';
      }
      // broadcast-style in-pit tag next to the driver
      const pitTag = c.retired
        ? ' <span class="p-pen">DNF</span>'
        : (c.pitState ? ' <span class="p-pit">' + (c.driveThrough ? 'D-T' : 'PIT') + '</span>' : '');
      // outstanding penalties, exactly as the real timing tower carries them:
      // accumulated time penalties, plus an unserved drive-through
      const secs = (G.penalties && G.penalties[c.driver.id]) || 0;
      const flashed = G.penaltyFlash && G.penaltyFlash[c.driver.id];
      const fresh = flashed != null && (G.simTime - flashed) < 5;
      let penTag = '';
      if (c.driveThrough && !c.pitState)
        penTag += ' <span class="p-pen' + (fresh ? ' new' : '') + '">D-T</span>';
      if (secs > 0)
        penTag += ' <span class="p-pen' + (fresh ? ' new' : '') + '">+' + secs + 's</span>';
      html += '<div class="pos-row'+(c.driver.player?' me':'')+'">'
        + '<span class="p-num">'+(i+1)+'</span>'
        + '<span class="p-swatch" style="background:'+sw+'"></span>'
        + tyreDot(c.phys.compound)
        + '<span class="p-name">'+c.driver.id+pitTag+penTag+flTag(c)+'</span>'
        + '<span class="p-gap">'+gap+'</span></div>';
    });
    panel.style.display = 'block';
    panel.innerHTML = html;
  } else if (G.mode === 'qualify' && G.qualiAITimes) {
    const rows = G.qualiAITimes.map(q => ({ name:q.driver.id, time:q.time, me:false, team:q.driver.team, tyre:q.tyre }));
    // the player's badge tracks the tyre they're on right now
    rows.push({ name:'VER', time:p.bestLap || 99999, me:true, team:'redbull', tyre:p.phys.compound });
    rows.sort((a,b)=>a.time-b.time);
    let html = '';
    rows.slice(0,12).forEach((r,i) => {
      const sw = '#' + TEAMS[r.team].color.toString(16).padStart(6,'0');
      html += '<div class="pos-row'+(r.me?' me':'')+'">'
        + '<span class="p-num">'+(i+1)+'</span>'
        + '<span class="p-swatch" style="background:'+sw+'"></span>'
        + tyreDot(r.tyre)
        + '<span class="p-name">'+r.name+'</span>'
        + '<span class="p-gap">'+(r.time>9000?'—':fmtTime(r.time))+'</span></div>';
    });
    panel.style.display = 'block';
    panel.innerHTML = html;
  } else {
    panel.style.display = 'none';
  }

  // weather indicator + rain overlay
  {
    const w = G.weather;
    const wt = $('weather-text'), wf = $('weather-fill'), ro = $('rain-overlay');
    if (wt) wt.textContent = w.forecast || 'DRY';
    if (wf) {
      wf.style.width = Math.round(w.wetness*100) + '%';
      wf.style.background = w.wetness > 0.7 ? '#2f7fd0' : w.wetness > 0.35 ? '#3fbf4f' : '#6fb0ff';
    }
    // 3D rain does the heavy lifting now; the screen streaks are just a light
    // windscreen effect on top
    if (ro) ro.style.opacity = w.wetness > 0.05 ? Math.min(0.30, 0.08 + w.wetness*0.26).toFixed(2) : '0';
    const haze = $('rain-haze');
    if (haze) haze.style.opacity = w.wetness > 0.35 ? Math.min(0.7, (w.wetness-0.35)*1.1).toFixed(2) : '0';
    // re-derive scene lighting/fog only when wetness shifts meaningfully
    if (Math.abs((w._visWet || 0) - w.wetness) > 0.03) { w._visWet = w.wetness; applyWeatherVisuals(); }
  }

  // minimap dots (zoomed views follow the player's car)
  drawMinimapBase(G.track, $('minimap-canvas'), MAP_ZOOMS[G.mapZoom], p.phys.x, p.phys.z);
  const ctx = $('minimap-canvas').getContext('2d');
  G.cars.forEach(c => {
    if (c.retired) return;                     // out of the race, off the map
    const pt = mapPoint(G.track, c.phys.x, c.phys.z);
    ctx.fillStyle = c.driver.player ? '#ffd12e' : '#'+TEAMS[c.driver.team].color.toString(16).padStart(6,'0');
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, c.driver.player ? 4 : 2.7, 0, Math.PI*2);
    ctx.fill();
  });
}

// ---------- camera ----------
const camTmp = new THREE.Vector3();
let camSway = 0;
function updateCamera(dt) {
  const p = G.player.phys;
  const back = keys['KeyV'] ? -1 : 1; // hold V to look behind
  const sx = Math.sin(p.heading) * back, cz = Math.cos(p.heading) * back;
  const rx = cz, rz = -sx; // right vector
  const baseY = G.player.mesh ? G.player.mesh.position.y : 0;
  if (G.camMode === 0) {
    // F1-game chase: low, tight behind the rear wing
    const dist = 6.3 + p.speed*0.022;
    const h = 2.05 + p.speed*0.007;
    camSway += ((-p.steer * Math.min(1, p.speed/25) * 0.85) - camSway) * Math.min(1, dt*6);
    camTmp.set(
      p.x - sx*dist + rx*camSway,
      baseY + h,
      p.z - cz*dist + rz*camSway
    );
    // stiff follow
    camera.position.lerp(camTmp, Math.min(1, dt*14));
    // subtle high-speed vibration
    if (p.speed > 60 && !REDUCED_MOTION) {
      const sh = (p.speed-60)*0.0006;
      camera.position.x += (Math.random()-0.5)*sh;
      camera.position.y += (Math.random()-0.5)*sh*0.6;
    }
    // look ahead through corners along the track direction
    const tA = G.track, kA = (p.trackIdx + Math.floor(14 / (tA.length/tA.n))) % tA.n;
    camera.lookAt(p.x + sx*6 + tA.tx[kA]*3*back, baseY + 0.85, p.z + cz*6 + tA.tz[kA]*3*back);
    camera.rotation.z += camSway * 0.035; // slight roll into corners
    camera.fov = 63 + Math.min(13, p.speed*0.10);
  } else if (G.camMode === 1) {
    // cockpit / helmet cam: driver's-eye height, halo strut and nose in frame
    const tA = G.track, kA = (p.trackIdx + Math.floor(12 / (tA.length/tA.n))) % tA.n;
    camera.position.set(p.x + sx*0.05, baseY + 1.02, p.z + cz*0.05);
    // look ahead, biased into the upcoming corner like a driver's gaze
    camera.lookAt(
      p.x + sx*22 + tA.tx[kA]*4*back, baseY + 0.62, p.z + cz*22 + tA.tz[kA]*4*back);
    camera.rotation.z += -p.steer * 0.03; // head leans with the g-force
    if (p.speed > 55 && !REDUCED_MOTION) {
      const sh = (p.speed-55)*0.0007;
      camera.position.x += (Math.random()-0.5)*sh;
      camera.position.y += (Math.random()-0.5)*sh*0.7;
    }
    camera.fov = 76;
  } else if (G.camMode === 2) {
    // T-cam onboard, mounted higher and further back than before so the halo,
    // mirrors, nose and front wheels are all in shot rather than just the top
    // of the helmet. Looks down more steeply, which also brings the top of the
    // wheel and the driver's hands into frame either side of the helmet.
    camera.position.set(p.x - sx*1.05, baseY + 1.66, p.z - cz*1.05);
    camera.lookAt(p.x + sx*17, baseY + 0.30, p.z + cz*17);
    camera.rotation.z += -p.steer * 0.022;
    if (p.speed > 55 && !REDUCED_MOTION) {
      const sh = (p.speed-55)*0.0005;
      camera.position.y += (Math.random()-0.5)*sh;
    }
    camera.fov = 72;
  } else {
    // Broadcast chase: wide and high enough to hold the whole car in frame so
    // the livery reads, but it tracks the car like a chase cam and is meant to
    // be driven in. Replaces the old static TV orbit, which you couldn't
    // usefully drive from.
    const dist = 11.5 + p.speed*0.030;
    const h = 4.1 + p.speed*0.010;
    camSway += ((-p.steer * Math.min(1, p.speed/28) * 1.5) - camSway) * Math.min(1, dt*4.5);
    camTmp.set(
      p.x - sx*dist + rx*camSway,
      baseY + h,
      p.z - cz*dist + rz*camSway
    );
    // looser follow than the chase cam, so it swings like a trackside shot
    camera.position.lerp(camTmp, Math.min(1, dt*6));
    const tB = G.track, kB = (p.trackIdx + Math.floor(20 / (tB.length/tB.n))) % tB.n;
    camera.lookAt(p.x + sx*4 + tB.tx[kB]*4*back, baseY + 0.75, p.z + cz*4 + tB.tz[kB]*4*back);
    camera.rotation.z += camSway * 0.02;
    camera.fov = 50;
  }
  // only the cockpit gets the close near plane; the others keep 1 m so
  // bodywork sitting right in front of the lens stays clipped out of frame
  camera.near = (G.camMode === 1) ? NEAR_COCKPIT : NEAR_DEFAULT;
  camera.updateProjectionMatrix();
}

// ---------- collisions (car vs car) ----------
// ---------- stewards: penalties + ticker (semi-lenient) ----------
// Tunable thresholds — err toward NOT penalizing (racing incidents are fine).
const STEW = {
  rearFaultOverlap: 0.30,   // hitter this far behind (<30% alongside) = at fault
  entitledOverlap: 0.50,    // >=50% alongside = entitled to room
  contactCooldown: 5,       // s between penalties for the same car
  limitTime: 0.75,          // s all-wheels-off before a strike (was 0.45 — a brief combat clip should not count, only a sustained run-wide)
  limitSpeed: 24,           // only strike when carrying real speed (not a spin)
  // FIA ladder: 3 track-limits warnings (black & white flag), then
  // 4th = 5s, 5th = 10s, 6th+ = drive-through. Collisions escalate the same way.
  warnLimit: 3,
  penColl: 5, penColl2: 10, // collision: 1st 5s, 2nd 10s, 3rd+ drive-through
};

// serve a drive-through: forced pass through the pit lane at pit speed with no
// stop and no tyre change (does NOT satisfy the mandatory compound rule)
// Arm a pit stop from anywhere on the lap. If we're already past the pit entry
// the stop rolls over to the next lap, so a late call never yanks the car
// sideways into a box it has already driven past.
function armPit(c) {
  c.pitArmed = true;
  c.pitArmLap = c.phys.lap + (c.phys.lapDist >= G.track.length - 320 ? 1 : 0);
  return c.pitArmLap > c.phys.lap; // true = it'll be next lap
}

function orderDriveThrough(car, reason) {
  if (car.finished || car.driveThroughServed) return;
  car.driveThrough = true;
  armPit(car);
  G.penaltyFlash = G.penaltyFlash || {};
  G.penaltyFlash[car.driver.id] = G.simTime;
  stewardMsg('STEWARDS: ' + car.driver.id + '  DRIVE-THROUGH — ' + reason, 'coll');
  if (car.driver.player) showBanner('DRIVE-THROUGH PENALTY — ' + reason.toUpperCase(), 3, '#ff5c5c');
}

function addPenalty(car, secs, reason, kind) {
  const id = car.driver.id;
  G.penalties[id] = (G.penalties[id] || 0) + secs;
  // timestamp it so the timing tower can flash the new total
  G.penaltyFlash = G.penaltyFlash || {};
  G.penaltyFlash[id] = G.simTime;
  const who = car.driver.id;
  stewardMsg((kind === 'limits' ? 'TRACK LIMITS: ' : 'STEWARDS: ') + who + '  +' + secs + 's — ' + reason, kind);
  if (car.driver.player) showBanner('STEWARDS: +' + secs + 's — ' + reason.toUpperCase(), 2.6, '#ff5c5c');
}

function stewardMsg(text, kind) {
  const box = $('stewards');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'steward-msg' + (kind === 'limits' ? ' limits' : '');
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 2) box.removeChild(box.firstChild);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 600); }, 4200);
}

// track-limits monitor: all four wheels beyond the line, carrying speed, for a
// sustained moment = a strike. Quali → lap deleted; race → 3 strikes = +5s.
function checkTrackLimits(dt) {
  if (!G.raceStarted) return;
  for (const c of G.cars) {
    if (c.finished || c.pitState) continue;
    const p = c.phys;
    const t = G.track;
    const lat = t.lateral(p.x, p.z, p.trackIdx);
    const off = Math.abs(lat) > t.width/2 + 1.9; // clearly all wheels beyond
    // A car pushed off by contact isn't running wide of its own accord, so it
    // gets a 1.5 s grace — real stewards don't penalise a forced-off car, and
    // without this a mid-pack tangle handed strikes to the innocent party too.
    if (c._contactT != null && G.simTime - c._contactT < 1.5) {
      c.limitTimer = 0; c._limitFlagged = false; continue;
    }
    if (off && p.speed > STEW.limitSpeed) {
      c.limitTimer = (c.limitTimer || 0) + dt;
      if (c.limitTimer >= STEW.limitTime && !c._limitFlagged) {
        c._limitFlagged = true; // one strike per excursion
        if (G.mode === 'qualify') {
          if (c.driver.player) { c.lapInvalid = true; stewardMsg('TRACK LIMITS: VER — LAP DELETED', 'limits'); }
        } else if (G.mode === 'race') {
          // FIA ladder: 3 warnings, then 5s, then 10s, then drive-through
          c.limitStrikes = (c.limitStrikes || 0) + 1;
          const n = c.limitStrikes;
          if (n <= STEW.warnLimit) {
            stewardMsg('TRACK LIMITS: ' + c.driver.id + ' — WARNING (' + n + '/' + STEW.warnLimit + ')', 'limits');
            if (c.driver.player) showBanner('TRACK LIMITS WARNING ' + n + '/' + STEW.warnLimit, 1.6, '#e8b64c');
          } else if (n === STEW.warnLimit + 1) {
            addPenalty(c, 5, 'track limits', 'limits');
          } else if (n === STEW.warnLimit + 2) {
            addPenalty(c, 10, 'repeated track limits', 'limits');
          } else {
            orderDriveThrough(c, 'persistent track limits');
            c.limitStrikes = STEW.warnLimit + 1; // further breaches re-escalate
          }
        }
      }
    } else {
      c.limitTimer = 0;
      c._limitFlagged = false;
    }
  }
}

function resolveCollisions() {
  const cars = G.cars;
  for (let i=0;i<cars.length;i++) {
    for (let j=i+1;j<cars.length;j++) {
      // pit-lane and retired cars are ghosts to everyone else
      if (cars[i].pitState || cars[j].pitState || cars[i].retired || cars[j].retired) continue;
      const a = cars[i].phys, b = cars[j].phys;
      const dx = b.x-a.x, dz = b.z-a.z;
      const dd = dx*dx+dz*dz;
      const R = 2.6;
      // Height-aware: two cars on parallel track sections at different
      // elevations (or one sunk off in a dip) shouldn't collide just because
      // they line up in the x/z plane. Skip if they're more than 2 m apart
      // vertically.
      const ay = cars[i].mesh && cars[i].mesh.userData.groundY;
      const by = cars[j].mesh && cars[j].mesh.userData.groundY;
      if (ay != null && by != null && Math.abs(ay - by) > 2) continue;
      if (dd < R*R && dd > 0.0001) {
        const d = Math.sqrt(dd);
        const push = (R-d)/2;
        const ux = dx/d, uz = dz/d;
        a.x -= ux*push; a.z -= uz*push;
        b.x += ux*push; b.z += uz*push;
        // remember the moment of contact so the stewards don't strike a car
        // that a rival has just shoved off the road
        cars[i]._contactT = G.simTime; cars[j]._contactT = G.simTime;
        // Closing speed along the line between the two cars — that, not raw
        // speed, is what decides whether this is a brush or a shunt.
        const closeV = Math.abs((a.speed * Math.sin(a.heading) - b.speed * Math.sin(b.heading)) * ux
                     + (a.speed * Math.cos(a.heading) - b.speed * Math.cos(b.heading)) * uz);
        const rear = a.totalDist > b.totalDist ? b : a;
        const front = rear === a ? b : a;
        rear.speed = Math.min(rear.speed, front.speed * 0.92 + 0.6);
        // Damage lands ONCE per contact, not every frame the two cars overlap.
        // Without this gate, two cars running nose-to-tail (drafting, or bunched
        // in wet-race traffic) racked up wing and floor damage at 120 Hz and the
        // whole field wrote itself off — which is exactly the all-cars-DNF the
        // rain produced. A short cooldown per car lets a genuine second hit
        // count while ignoring the sustained rub of side-by-side running.
        // Damage lands once per contact (0.6 s cooldown). Racing is full of
        // gentle rubs — 85% of all contact is under 5 m/s closing — so light
        // touches must cost nothing, or a whole field trades paint into
        // oblivion. Only a firm hit marks the car, and a race-ending shunt has
        // to be both very hard AND unlucky, so DNFs stay in the real 0-3 range
        // rather than the dozen the rain was producing.
        const dmgReady = (rear.dmgCd || 0) <= 0 && (front.dmgCd || 0) <= 0;
        if (closeV > 7 && dmgReady) {
          rear.dmgCd = front.dmgCd = 0.6;   // seconds
          const bite = Math.min(1, (closeV - 7) / 20);
          rear.dmgWing  = Math.min(1, rear.dmgWing  + bite * 0.35);
          front.dmgFloor = Math.min(1, front.dmgFloor + bite * 0.10);
          rear.lastImpact = Math.max(rear.lastImpact, closeV);
          front.lastImpact = Math.max(front.lastImpact, closeV);
          // a heavy hit spins them. The spin is capped and does NOT feed back
          // into the next frame's closing-speed calc (that loop is what let a
          // single tangle cascade into the whole field wiping out).
          if (closeV > 14) {
            const spin = Math.min(0.25, (closeV - 14) * 0.02);
            rear.heading  += (Math.random()-0.5) * spin;
            front.heading += (Math.random()-0.5) * spin;
            rear.speed *= 0.75; front.speed *= 0.88;
            if (Math.random() < (closeV - 14) * 0.03) front.puncture = 1;
            // terminal only on a big, square, unlucky hit
            if (closeV > 30 && Math.random() < 0.5) rear.dead = true;
          }
        }
        if (G.player && (a === G.player.phys || b === G.player.phys) && (G.crashCd||0) <= 0) {
          AUDIO.crash(Math.min(1, 0.35 + closeV * 0.05));
          G.crashCd = 0.5;
        }
        // ---- stewards: classify fault (semi-lenient) ----
        if (G.state === 'driving' && G.raceStarted && G.mode === 'race') {
          const carA = cars[i], carB = cars[j];
          const gap = Math.abs(a.totalDist - b.totalDist);
          const overlap = 1 - Math.min(1, gap / 5); // 1 = side by side, 0 = a car-length apart
          const t = G.track;
          const latA = t.lateral(a.x, a.z, a.trackIdx), latB = t.lateral(b.x, b.z, b.trackIdx);
          const closing = (rear.speed) > (front.speed) + 4;
          const rearCar = rear === a ? carA : carB;
          const frontCar = rear === a ? carB : carA;
          if (overlap < STEW.rearFaultOverlap && closing && (rearCar.contactCd||0) <= 0) {
            // clear rear-end: the car behind caused it
            rearCar.contactCd = STEW.contactCooldown;
            rearCar.collCount = (rearCar.collCount || 0) + 1;
            if (rearCar.collCount === 1) addPenalty(rearCar, STEW.penColl, 'causing a collision');
            else if (rearCar.collCount === 2) addPenalty(rearCar, STEW.penColl2, 'causing a collision (repeat)');
            else orderDriveThrough(rearCar, 'repeated collisions');
          } else if (overlap >= STEW.entitledOverlap) {
            // side-by-side: if one gets shoved off the track, the other squeezed
            const aOff = Math.abs(latA) > t.width/2 + 1.6;
            const bOff = Math.abs(latB) > t.width/2 + 1.6;
            if (aOff !== bOff) {
              const victim = aOff ? carA : carB;
              const guilty = aOff ? carB : carA;
              if ((guilty.contactCd||0) <= 0) {
                guilty.contactCd = STEW.contactCooldown;
                guilty.collCount = (guilty.collCount || 0) + 1;
                if (guilty.collCount === 1) addPenalty(guilty, STEW.penColl, 'forcing a car off track');
                else if (guilty.collCount === 2) addPenalty(guilty, STEW.penColl2, 'forcing a car off track (repeat)');
                else orderDriveThrough(guilty, 'repeated incidents');
              }
            }
            // otherwise: hard racing, let them race (no penalty)
          }
        }
      }
    }
  }
}

// ---------- race countdown ----------
function updateCountdown(dt) {
  const cd = G.countdown;
  if (!cd) return;
  cd.t -= dt;
  if (cd.phase === 0) {
    lightsEl.style.display = 'flex';
    lights.forEach(l=>l.classList.remove('on'));
    if (cd.t <= 0) { cd.phase = 1; cd.t = 0.9; }
  } else if (cd.phase >= 1 && cd.phase <= 5) {
    for (let i=0;i<cd.phase;i++) lights[i].classList.add('on');
    if (cd.t <= 0) {
      AUDIO.beep(440, 0.18, 0.14);
      cd.phase++;
      cd.t = cd.phase === 6 ? 0.4 + Math.random()*1.4 : 0.9;
    }
  } else if (cd.phase === 6) {
    if (cd.t <= 0) {
      lights.forEach(l=>l.classList.remove('on'));
      lightsEl.style.display = 'none';
      G.countdown = null;
      G.raceStarted = true;
      G.simTime = 0;
      G.cars.forEach(c => {
        c.curLapStart = 0; c._lapStart = 0;
        if (c.ai) {
          c.ai.launchT = 6;      // everyone launches hard off the line
          c.ai.laneBlend = 0;    // and holds its grid lane before fanning out
          c.ai.gridLane = null;
        }
      });
      AUDIO.beep(880, 0.5, 0.16);
      showBanner("LIGHTS OUT AND AWAY WE GO!", 2.2, '#2ecc71');
    }
  }
}

// ---------- main loop ----------
let lastT = performance.now();
const FIXED = 1/120;
let acc = 0;
let fpsCount = 0, fpsT = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (now - lastT)/1000);
  lastT = now;
  fpsCount++; fpsT += rawDt;
  // 2s window, not 5: on a struggling machine the old ladder took 15 seconds
  // to walk down two steps, which felt like the game was just slow.
  if (fpsT >= 2) {
    const fps = fpsCount/fpsT;
    console.log('[FPS]', fps.toFixed(1), G.state, G.cars.length + ' cars');
    // adaptive quality ladder (skyline-run style): pixel ratio first —
    // least visible — then SSAO, then bloom
    if (fps < 45 && G.state === 'driving') {
      if (pixelRatio > 1.01) {
        pixelRatio = Math.max(1, pixelRatio - 0.35);
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        if (composer) composer.setSize(window.innerWidth, window.innerHeight);
        console.log('[perf] pixel ratio →', pixelRatio.toFixed(2));
      } else if (ssaoPass && ssaoPass.enabled) { ssaoPass.enabled = false; console.log('[perf] SSAO off'); }
      else if (degradeShadows()) { /* 2048 soft → 1024 soft → 1024 hard → off */ }
      else if (bloomPass && bloomPass.enabled) { bloomPass.enabled = false; console.log('[perf] bloom off'); }
    }
    fpsCount = 0; fpsT = 0;
  }

  if (G.state !== 'driving') {
    if (rainMesh) rainMesh.visible = false;
    AUDIO.update(null, rawDt, null, false); // silence engine on pause/menu/results
    renderer.render(scene, camera);
    return;
  }

  acc += rawDt;
  while (acc >= FIXED) {
    stepSim(FIXED);
    acc -= FIXED;
  }

  // visuals
  const trk = G.track;
  G.cars.forEach(c => {
    const p = c.phys;
    // Ride height follows whatever the car is actually on. surfaceY only knows
    // about the road, so once a car ran wide it stayed pinned at road height
    // and hovered above the grass, which sits below the tarmac. Past the verge
    // we blend onto the terrain instead.
    const roadY = trk.surfaceY(p.x, p.z, p.trackIdx) + 0.05;
    let y = roadY;
    if (trk.terrainY) {
      const lat = Math.abs(trk.lateral(p.x, p.z, p.trackIdx));
      const edge = trk.width/2 + 1.15;          // outside edge of the turf strip
      if (lat > edge) {
        const t01 = Math.min(1, (lat - edge) / 2.5);
        y = y*(1-t01) + (trk.terrainY(p.x, p.z) + 0.05)*t01;
      }
    }
    // Hard floor: never let the car drop more than 0.5 m below the road it's
    // nearest to. Where a circuit doubles back at different elevations,
    // terrainY references the LOWER section and a car running wide sank
    // metres "underground" then popped back up on return — which also fed the
    // height-blind collision check. Clamping to the local road kills both.
    y = Math.max(y, roadY - 0.5);
    c.mesh.userData.groundY = y;                // for the height-aware collision check
    c.mesh.position.set(p.x, y, p.z);
    c.mesh.rotation.order = 'YXZ';
    c.mesh.rotation.y = p.heading;
    // pitch with track gradient, roll with camber
    const iA = (p.trackIdx+5) % trk.n, iB = (p.trackIdx-5+trk.n) % trk.n;
    const slope = (trk.py[iA]-trk.py[iB]) / (10 * trk.length / trk.n);
    c.mesh.rotation.x = Math.atan(slope) * (p.speed > 1 ? 1 : 0);
    c.mesh.rotation.z = Math.atan(trk.bank[p.trackIdx]);
    const wr = p.speed / 0.35 * FIXED * 8;
    const w = c.mesh.userData.wheels;
    [w.fl,w.fr,w.rl,w.rr].forEach(wh => { wh.children.forEach((ch,ci) => { if (ci<2) ch.rotation.x += p.speed*0.05; }); });
    w.fl.rotation.y = p.steer*0.35; w.fr.rotation.y = p.steer*0.35;
    if (c.retired && !c.mesh.visible) return;   // recovered by the marshals
    // the painted blob is only needed when real shadow maps are off
    if (c.mesh.userData.blobShadow) c.mesh.userData.blobShadow.visible = !sun.castShadow;
    // cockpit rig: visible from the helmet cam only. Read-only mirror of the
    // steer value the physics already produced — roughly 120° of wheel at
    // full lock. Nothing here feeds back into the car's behaviour.
    const rig = c.mesh.userData.cockpitRig;
    if (rig) {
      rig.visible = (G.camMode === 1 || G.camMode === 2);
      // steer is positive for a LEFT turn here, and the driver views the wheel
      // from behind, so the sign flips twice: right lock reads clockwise.
      if (rig.visible) c.mesh.userData.steeringWheel.rotation.z = -p.steer * 2.1;
    }
    // Visible damage: the wing droops and skews as it breaks up, then drops
    // away entirely once it's gone. Cheap, and instantly readable from behind.
    const fw = c.mesh.userData.frontWing;
    if (fw) {
      const d = p.dmgWing;
      const gone = d >= 0.98;
      fw.forEach((part, k) => {
        part.visible = !gone;
        if (!gone) {
          part.rotation.z = d * 0.22 * (k % 2 ? 1 : -1);
          part.position.y = part.userData.y0 != null
            ? part.userData.y0 - d * 0.09
            : (part.userData.y0 = part.position.y, part.position.y);
        }
      });
    }
    if (c.mesh.userData.brakeLight) {
      c.mesh.userData.brakeLight.color.setHex(p.brake > 0.25 ? 0xff2a00 : 0x661111);
    }
    if (c.mesh.userData.drsFlap) {
      // flap swings up when DRS is open
      const f = c.mesh.userData.drsFlap;
      const tgt = p.drsOpen ? -1.25 : -0.18;
      f.rotation.x += (tgt - f.rotation.x) * 0.3;
    }
  });

  updateCamera(rawDt);
  if (G.player) updateSunRig(G.player.phys.x, G.player.phys.z);
  updateRain(rawDt);
  updateHUD();
  updatePitUI();

  // audio
  AUDIO.update(G.player && G.player.phys, rawDt, G.cars, G.state === 'driving');
  // overtake whoosh: passing close to another car at a speed difference
  if (G.player && G.state === 'driving') {
    const pp = G.player.phys;
    for (const c of G.cars) {
      if (c === G.player) continue;
      const dx = c.phys.x - pp.x, dz = c.phys.z - pp.z;
      const dd = dx*dx + dz*dz;
      c._whooshCd = Math.max(0, (c._whooshCd || 0) - rawDt);
      if (dd < 20 && c._whooshCd <= 0) {
        const rel = Math.abs(pp.speed - c.phys.speed);
        if (rel > 4) {
          AUDIO.whoosh(0.1 + Math.min(0.18, rel * 0.01));
          c._whooshCd = 2;
        }
      }
    }
  }
  // kerb rumble: rapid soft ticks while riding a kerb
  if (G.player && G.player.phys.onKerb && G.player.phys.speed > 12) {
    G.kerbT = (G.kerbT || 0) - rawDt;
    if (G.kerbT <= 0) {
      AUDIO.crash(0.06);
      G.kerbT = 0.05;
    }
  }
  G.crashCd = Math.max(0, (G.crashCd||0) - rawDt);
  if (G.player && G.player.phys.wallHit > 0.2 && G.crashCd <= 0) {
    AUDIO.crash(G.player.phys.wallHit);
    G.crashCd = 0.4;
  }

  if (G.msgTimer > 0) {
    G.msgTimer -= rawDt;
    if (G.msgTimer <= 0) banner.style.display = 'none';
  }

  if (composer) {
    // Speed blur: starts later (55 m/s ≈ 200 km/h, not 126) and peaks at a
    // third of what it did. The old 0.35 smeared the whole frame.
    if (blurPass) blurPass.uniforms.strength.value = REDUCED_MOTION ? 0 :
      Math.max(0, (G.player.phys.speed - 55) / 90) * 0.12;
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// pit-lane driving override: pursuit toward the pit-side lane, limited speed,
// 2.8s standstill at 120m before the line (simplified pit model, no lane geometry)
function pitInput(c, dt) {
  const p = c.phys, t = G.track;
  const pitLat = -(t.width/2 - 1.6); // toward the pit building side
  // simple pursuit toward a point ahead on the pit line
  const lookM = Math.max(6, p.speed * 0.5);
  const kAhead = (p.trackIdx + Math.ceil(lookM / (t.length / t.n))) % t.n;
  const target = t.posAt(kAhead, pitLat);
  let da = Math.atan2(target.x - p.x, target.z - p.z) - p.heading;
  while (da > Math.PI) da -= 2*Math.PI;
  while (da < -Math.PI) da += 2*Math.PI;
  const steer = Math.max(-1, Math.min(1, da * 2.2));

  if (c.pitState === 'stopped') {
    // player's stationary time is decided by the reaction-light game
    if (c.driver.player && G.pitGame && !G.pitGame.done) {
      advancePitGame(c, dt);
    } else {
      c.pitTimer -= dt;
    }
    if (c.pitTimer <= 0) {
      c.pitState = 'exiting';
      if (c.driver.player) AUDIO.beep(700, 0.2, 0.12); // wheel-gun release
    }
    return { throttle: 0, brake: 1, steer: 0 };
  }
  let vTarget = 22; // pit speed limit
  if (c.pitState === 'entering') {
    const dStop = Math.max(0, (t.length - 120) - p.lapDist); // box at 120m before the line
    vTarget = Math.min(22, Math.sqrt(2 * 8 * dStop));
    // a drive-through never stops: stay at pit speed and rejoin
    if (c.driveThrough) {
      vTarget = 22;
      if (p.lapDist > t.length - 60) c.pitState = 'exiting';
    } else if (dStop < 2.5 && p.speed < 2) {
      c.pitState = 'stopped';
      c.pitStopStart = G.simTime;
      if (c.driver.player) {
        // stationary time resolved by the reaction-light game
        c.pitTimer = 99;
        G.pitGame = { t: 0, lights: 0, holdT: 0.45 + Math.random()*0.85, done: false,
                      pressed: false, stationary: 0, msg: 'SPACE when the lights go out' };
        AUDIO.crash(0.15); // car drops on the jacks
      } else {
        // AI crews: 2.0-3.5s, with the occasional botched stop
        c.pitTimer = Math.random() < 0.06 ? 5 + Math.random()*2 : 2.0 + Math.random()*1.5;
      }
      return { throttle: 0, brake: 1, steer: 0 };
    }
  }
  let throttle = 0, brake = 0;
  if (p.speed > vTarget + 0.5) brake = Math.min(1, (p.speed - vTarget) * 0.3);
  else if (p.speed < vTarget - 0.8) throttle = 0.7;
  return { throttle, brake, steer };
}

// ---------- reaction-light pit stop game ----------
// Five red lights come on one by one, hold, then go out. Press SPACE the
// instant they're out: reaction < 0.20s = perfect ~2.0s stop; slower adds time;
// jumping the start (press while lights still on) = a penalty ~4.5s stop.
function advancePitGame(c, dt) {
  const g = G.pitGame;
  g.t += dt;
  if (g.lights < 5) {
    // sequence the five lights on ~0.25s apart
    const nextAt = (g.lights + 1) * 0.25;
    if (g.t >= nextAt) { g.lights++; AUDIO.beep(440, 0.12, 0.12); }
    g.phase = 'sequencing';
    return;
  }
  // all five on: hold, then out
  const outAt = 5 * 0.25 + g.holdT;
  if (g.t < outAt) { g.phase = 'hold'; }
  else if (!g.done) {
    g.phase = 'go';
    if (g.outTime == null) g.outTime = g.t; // moment the lights went out
  }
  // resolve when pressed (handled in keydown) or auto-finish if they never press
  if (g.done) {
    c.pitTimer -= dt; // count down the resolved stationary time
  } else if (g.t > outAt + 3) {
    // never pressed → treat as a slow 5s stop
    resolvePitGame(6.0, 'TOO SLOW — asleep at the wheel');
  }
}

function resolvePitGame(stationary, msg) {
  const g = G.pitGame;
  if (!g || g.done) return;
  g.done = true;
  g.stationary = stationary;
  g.msg = msg;
  // remaining stationary time the stop machine still has to wait
  const player = G.player;
  const elapsed = G.simTime - (player.pitStopStart || G.simTime);
  player.pitTimer = Math.max(0.05, stationary - elapsed);
  AUDIO.beep(880, 0.15, 0.12);
}

function pitGameKey() {
  const g = G.pitGame;
  if (!g || g.done) return;
  if (g.phase === 'go') {
    const reaction = g.t - g.outTime; // seconds after lights out
    let stationary, msg;
    if (reaction < 0.20)      { stationary = 2.0; msg = 'PERFECT STOP ' + reaction.toFixed(2) + 's'; }
    else if (reaction < 0.40) { stationary = 2.4; msg = 'GREAT ' + reaction.toFixed(2) + 's'; }
    else if (reaction < 0.70) { stationary = 3.0; msg = 'OK ' + reaction.toFixed(2) + 's'; }
    else                      { stationary = 3.8; msg = 'SLOW ' + reaction.toFixed(2) + 's'; }
    resolvePitGame(stationary, msg);
  } else {
    // jumped the start
    resolvePitGame(4.5, 'JUMP START — penalty');
  }
}

function updatePitUI() {
  const c = G.player;
  const inPit = c && c.pitState;
  const el = $('pit-ui');
  if (!inPit) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  // pit-lane running time
  const lane = c.pitLaneStart != null ? (G.simTime - c.pitLaneStart) : 0;
  $('pit-lane-time').textContent = 'PIT LANE ' + lane.toFixed(1) + 's';
  const g = G.pitGame;
  const lights = document.querySelectorAll('#pit-lights .plight');
  if (c.pitState === 'stopped' && g) {
    const on = g.phase === 'go' || g.done ? 0 : g.lights;
    lights.forEach((l,i) => l.classList.toggle('on', i < on));
    const stat = g.done ? g.stationary : (G.simTime - (c.pitStopStart || G.simTime));
    $('pit-stationary').textContent = stat.toFixed(1);
    $('pit-msg').textContent = g.msg || '';
  } else {
    lights.forEach(l => l.classList.remove('on'));
    $('pit-stationary').textContent = '--.-';
    $('pit-msg').textContent = c.pitState === 'entering' ? 'ENTERING PIT LANE' : 'REJOINING';
  }
}

// ---------- DRS ----------
// FIA procedure, as close as this sim can get:
//   • Each zone has a DETECTION point and, further on, an ACTIVATION line.
//   • The gap to the car ahead is measured ONCE, at detection. Within 1.000s
//     you are armed for that zone — and you stay armed even if you complete
//     the pass, because the measurement already happened.
//   • The wing opens at the activation line and closes the moment you first
//     touch the brakes (or at the end of the zone). Nothing else shuts it.
//   • Race: enabled from lap 2 (one lap after the start). Practice and
//     qualifying: free in every zone, no gap requirement.
//   • Heavy rain: the race director disables DRS entirely.
const DRS_GAP = 1.0;      // seconds at the detection point
const DRS_DET_WINDOW = 24; // metres of road over which detection is sampled

function inSpan(d, a, b, L) {
  if (a <= b) return d >= a && d <= b;
  return d >= a || d <= b; // span wraps the start/finish line
}

// How far ahead another car is ON TRACK, regardless of which lap either of
// you is on. Using totalDist (race distance) breaks the moment lapping
// starts: a backmarker sitting right in front of you reads as a whole lap
// BEHIND, so you get no DRS and no tow off a car you are about to pass —
// the opposite of real F1, where you very much do.
// Returns Infinity when the other car isn't genuinely just up the road.
function roadGapAhead(p, op, t) {
  const L = t.length;
  let g = op.lapDist - p.lapDist;
  if (g < 0) g += L;                    // wrap: they're round the lap in front
  if (g > L * 0.5) return Infinity;     // more than half a lap = actually behind
  // sanity check against the geometry, so a car on a parallel section of the
  // circuit doesn't count as being in front of us
  if (Math.hypot(op.x - p.x, op.z - p.z) > g + 30) return Infinity;
  return g;
}

// signed distance from d to target going forwards around the lap
function fwdDist(d, target, L) {
  let g = target - d;
  while (g < 0) g += L;
  return g;
}

// gap in seconds to the nearest car ahead on the road
function gapAheadSec(c) {
  const p = c.phys;
  const t = G.track;
  let best = Infinity;
  for (const o of G.cars) {
    if (o === c || o.finished || o.pitState) continue;
    // on-track gap, so lapped cars and cars you're lapping both count —
    // in real F1 you get DRS behind a backmarker just the same
    const gap = roadGapAhead(p, o.phys, t);
    if (gap > 1 && gap < best) best = gap;
  }
  if (!isFinite(best)) return Infinity;
  return best / Math.max(14, p.speed); // metres → seconds at current pace
}

// ---------- slipstream ----------
// Running in another car's wake cuts your drag. It reaches roughly ten car
// lengths back, is strongest directly behind, and fades as you move offline —
// which is why a driver dives out of the tow at the last moment to brake.
// Only matters at speed, so it does nothing through slow corners.
const TOW_RANGE = 55;   // metres of usable wake
const TOW_WIDTH = 3.4;  // metres of lateral offset before it's gone

function updateSlipstream() {
  const t = G.track;
  if (!t) return;
  for (const c of G.cars) {
    const p = c.phys;
    if (c.finished || c.retired || c.pitState || p.speed < 33) { p.tow = 0; continue; }
    let best = 0;
    const myLat = t.lateral(p.x, p.z, p.trackIdx);
    for (const o of G.cars) {
      if (o === c || o.finished || o.pitState) continue;
      const op = o.phys;
      // on-track gap: a car's wake doesn't care whose lap it is
      const gap = roadGapAhead(p, op, t);
      if (gap <= 2 || gap > TOW_RANGE) continue;
      const dLat = Math.abs(t.lateral(op.x, op.z, op.trackIdx) - myLat);
      if (dLat > TOW_WIDTH) continue;
      const byGap = 1 - (gap - 2) / (TOW_RANGE - 2);
      const byLat = 1 - dLat / TOW_WIDTH;
      const strength = byGap * byGap * byLat;   // falls off fast with distance
      if (strength > best) best = strength;
    }
    p.tow = Math.min(1, best);
  }
  if (G.player) G.playerTow = G.player.phys.tow;
}

function updateDRS() {
  const t = G.track;
  if (!t || !t.drsZones || !t.drsZones.length || !G.raceStarted) return;
  const L = t.length;
  const raceMode = G.mode === 'race';
  const rainedOff = G.weather && G.weather.wetness > 0.55; // race director call
  for (const c of G.cars) {
    const p = c.phys;
    if (c.finished || c.retired || c.pitState || rainedOff) {
      p.drsOpen = false; c.drsArmed = -1; c.drsShut = -1;
      if (c.driver.player) { G.playerDrsState = 0; G.drsInfo = rainedOff ? 'DRS DISABLED — WET' : ''; }
      continue;
    }
    if (c.drsArmed == null) { c.drsArmed = -1; c.drsShut = -1; }

    // ---- detection ----
    let inDet = -1;
    t.drsZones.forEach((z, zi) => {
      if (inSpan(p.lapDist, z.det, (z.det + DRS_DET_WINDOW) % L, L)) inDet = zi;
    });
    if (inDet >= 0) {
      let ok = true;
      if (raceMode) ok = p.lap >= 2 && gapAheadSec(c) <= DRS_GAP;
      c.drsArmed = ok ? inDet : -1;
      if (ok) c.drsShut = -1;
    }

    // ---- activation ----
    let zi = -1;
    t.drsZones.forEach((z, i) => { if (inSpan(p.lapDist, z.start, z.end, L)) zi = i; });
    if (zi < 0) {
      p.drsOpen = false;
    } else {
      if (p.brake > 0.05) c.drsShut = zi;      // first brake application closes it
      p.drsOpen = (c.drsArmed === zi) && c.drsShut !== zi && p.speed > 15;
    }

    // ---- player HUD state ----
    if (c.driver.player) {
      if (zi >= 0) {
        if (p.drsOpen) { G.playerDrsState = 2; G.drsInfo = 'DRS ACTIVE'; }
        else if (c.drsShut === zi) { G.playerDrsState = 0.5; G.drsInfo = 'DRS CLOSED — BRAKED'; }
        else { G.playerDrsState = 0.5; G.drsInfo = 'NO DRS THIS ZONE'; }
      } else {
        // nearest detection point ahead, with the live gap so you can see
        // whether you'll be inside the second when you get there
        let bestD = Infinity, armedFor = -1;
        t.drsZones.forEach((z, i) => {
          const d = fwdDist(p.lapDist, z.det, L);
          if (d < bestD) { bestD = d; armedFor = i; }
        });
        const g = gapAheadSec(c);
        const free = !raceMode;
        if (c.drsArmed >= 0 && c.drsArmed !== armedFor) {
          G.playerDrsState = 1;                  // detection passed, zone coming
          G.drsInfo = 'DRS ARMED';
        } else if (bestD < 900) {
          G.playerDrsState = 0.5;
          G.drsInfo = free
            ? 'DETECTION ' + Math.round(bestD) + 'm'
            : 'DETECTION ' + Math.round(bestD) + 'm · GAP ' + (isFinite(g) ? g.toFixed(2) + 's' : '--');
        } else {
          G.playerDrsState = 0;
          G.drsInfo = '';
        }
      }
    }
  }
}

// A car whose chassis has failed is out. Park it, tell the stewards' ticker,
// and let the classification treat it as a non-finisher.
function checkRetirements() {
  if (G.mode !== 'race' || !G.raceStarted) return;
  for (const c of G.cars) {
    // New retirement this frame.
    if (!c.retired && !c.finished && c.phys.dead) {
      c.retired = true;
      c.phys.speed = 0;
      c.retireAt = G.simTime;
      stewardMsg('RETIREMENT: ' + c.driver.id + ' — terminal damage', 'coll');
      if (c.driver.player) {
        showBanner('RACE OVER — TERMINAL DAMAGE', 4, '#ff5c5c');
        // your race is done: let the rest play out on paper and go to results
        if (!G.endTimer) G.endTimer = setTimeout(() => { simulateRemainder(); endRace(); }, 4000);
      }
    }
    // Recover a retired car once the moment has passed. This has to run for
    // cars that are ALREADY retired, so it can't sit behind a `continue` that
    // skips them — which is exactly the bug that left ghost cars on track.
    if (c.retired && c.mesh && c.mesh.visible && G.simTime - (c.retireAt || 0) > 2.5) {
      c.mesh.visible = false;
    }
  }

  // If every car that isn't the player is out (retired or classified), there
  // is no race left to run — end it rather than leaving the player circulating
  // alone forever.
  if (!G.endTimer && G.player && !G.player.retired && !G.player.finished) {
    const others = G.cars.filter(c => c !== G.player);
    if (others.length && others.every(c => c.retired || c.finished)) {
      showBanner('RACE OVER — ALL OTHERS OUT', 3.5, '#ffd12e');
      G.endTimer = setTimeout(() => {
        // the player is the only runner: hand them the win and classify.
        if (!G.player.finished && !G.player.retired) {
          G.player.finished = true;
          G.player.finishTime = G.simTime;
        }
        endRace();
      }, 3000);
    }
  }
}

// The player is out, so nobody is watching the remaining laps. Project each
// running car to the flag from the pace it has actually been setting, so the
// classification is plausible rather than frozen at the moment you crashed.
function simulateRemainder() {
  const full = G.raceLaps * G.track.length;
  const needsStop = G.raceLaps > 20;
  const running = G.cars.filter(c => !c.finished && !c.retired);
  if (!running.length) return;

  // Hold the CURRENT running order and gaps to the flag rather than
  // extrapolating pace. Extrapolation was doubly wrong: running each car to the
  // full distance produced +3000s gaps, and projecting pace forward amplified
  // the standing-start spread into a field that was mostly "lapped". The gaps
  // the player can actually see at the moment of the crash are the honest
  // basis for the result, so we simply carry them forward.
  running.sort((a, b) => b.phys.totalDist - a.phys.totalDist);
  const leader = running[0];
  const L = G.track.length;
  const raceSpeed = Math.max(30, leader.phys.totalDist / Math.max(1, G.simTime));
  // leader's own projected finish time, so the numbers are on a sane scale
  const winTime = G.simTime + Math.max(0, full - leader.phys.totalDist) / raceSpeed
                + (needsStop && !leader.pitted ? 22 : 0);
  running.forEach((c, i) => {
    const distGap = leader.phys.totalDist - c.phys.totalDist;   // metres behind, now
    if (distGap < L - 5) {
      // same lap as the leader → a finisher, gap = that distance in seconds,
      // with a touch of scatter so positions don't tie
      c.finished = true;
      c.finishTime = winTime + distGap / raceSpeed + Math.random() * 0.4;
      if (needsStop && !c.pitted) {
        c.pitted = true;
        if (c.phys.compound === 'soft') c.pitCompound = 'hard';
        else if (c.phys.compound === 'hard') c.pitCompound = 'soft';
        else c.pitCompound = 'medium';
      }
    }
    // a car genuinely a lap or more down at the crash keeps its distance and
    // falls through to the results screen's "+N Laps" path unchanged.
  });
}

function stepSim(dt) {
  updateCountdown(dt);
  const started = G.raceStarted;
  if (started) G.simTime += dt;
  updateSlipstream();
  updateDRS();
  checkRetirements();
  // qualifying clock: count down; drop the chequered flag at zero
  if (started && G.mode === 'qualify') {
    if (G.qualiTime > 0) {
      G.qualiTime -= dt;
      if (G.qualiTime <= 0 && !G.qualiFlag) {
        G.qualiTime = 0;
        G.qualiFlag = true;
        AUDIO.beep(660, 0.4, 0.12);
        showBanner('CHEQUERED FLAG — COMPLETE YOUR LAP', 3.5, '#ffd12e');
      }
    } else if (G.qualiFlag) {
      // safety net: if the player parks after the flag, end the session
      G.qualiTime -= dt;
      if (G.qualiTime < -150) endQualify();
    }
  }
  updateWeather(dt);
  const pitsOpen = G.mode === 'race' && G.raceLaps > 20;
  // cars in the pit are ghosts: other cars' AI ignores them entirely
  const physList = [];
  for (const c of G.cars) if (!c.pitState) physList.push(c.phys);

  // pit arming / zone entry (zone = last 300m before the start/finish line).
  // Weather stops work at any race length; the mandatory strategy stop only
  // applies to races over 20 laps.
  // (the player can box in any session; AI strategy stops are race-only)
  if (started) {
    for (const c of G.cars) {
      if (c.finished || c.pitState) continue;
      if (G.mode !== 'race' && c.ai) continue; // no AI stops outside a race
      if (pitsOpen && c.ai && !c.pitArmed && !c.pitted && c.pitLap && c.phys.lap === c.pitLap) armPit(c);
      // planned second stop for AI two-stoppers in long races
      if (pitsOpen && c.ai && !c.pitArmed && c.pitted && !c.pitted2 && c.pitLap2 && c.phys.lap === c.pitLap2) {
        armPit(c); c.pitted2 = true;
      }
      if (c.ai && !c.pitArmed) weatherPitCheck(c);
      if (c.pitArmed && !c.pitState && (c.pitArmLap == null || c.phys.lap >= c.pitArmLap)
          && c.phys.lapDist >= G.track.length - 300) {
        c.pitState = 'entering';
        c.pitLaneStart = G.simTime; // start the pit-lane clock
        if (c.driver.player) showBanner('IN PIT', 1.6, '#6fa0ff');
      }
    }
  }

  for (const c of G.cars) {
    if (c.finished) {
      // cruise slowly after finish
      if (c.ai) {
        const inp = c.ai.compute(dt, physList);
        inp.throttle = Math.min(inp.throttle, 0.3);
        c.phys.step(dt, inp);
      } else {
        c.phys.step(dt, { throttle:0, brake:0.4, steer:0 });
      }
      continue;
    }
    let inp;
    // Before lights out nobody gets to think. Running the AI here used to trip
    // its stuck-recovery (2.5s below 2.5 km/h) during the countdown, which called
    // resetToTrack() and snapped every car onto the centreline — the staggered
    // grid collapsed into a single queue.
    if (!started) { c.phys.speed = 0; c.phys.step(dt, { throttle:0, brake:0, steer:0 }); continue; }
    if (c.pitState) inp = pitInput(c, dt); // pit machine overrides all input
    else if (c.driver.player) {
      if (G.autopilot) {
        if (!c.autoAi) c.autoAi = new AIDriver(c.phys, G.track, c.driver);
        inp = c.autoAi.compute(dt, physList);
      } else inp = playerInput();
    }
    else inp = c.ai.compute(dt, physList);
    c.phys.step(dt, inp);

    // pit exit: crossing the line rejoins the race on fresh tyres. The compound
    // just removed becomes the default for a further stop (multi-stop allowed);
    // the weather logic can override pitCompound at any time.
    if (c.pitState && c.phys.crossedLine) {
      if (c.driveThrough) {
        // penalty served: no tyres, no stop, does not count as the mandatory stop
        c.driveThrough = false; c.driveThroughServed = true;
        c.pitState = null; c.pitArmed = false; c.pitArmLap = null;
        if (c.driver.player) showBanner('PENALTY SERVED', 2, '#ffd12e');
        continue;
      }
      // a nose change costs time but restores the front wing
      if (c.phys.dmgWing > 0.15) {
        c.phys.dmgWing = 0;
        c.pitTimer = (c.pitTimer || 0) + 4.5;
        if (c.driver.player) showBanner('NEW FRONT WING  +4.5s', 2.2, '#ffd12e');
      }
      // the crew can patch the floor too — most of it back, for extra time
      if (c.phys.dmgFloor > 0.15) {
        c.phys.dmgFloor *= 0.25;
        c.pitTimer = (c.pitTimer || 0) + 3.5;
        if (c.driver.player) showBanner('FLOOR REPAIR  +3.5s', 2.2, '#ffd12e');
      }
      c.phys.puncture = 0;
      const removed = c.phys.compound;
      // work through the planned stops; once the plan runs out, refit fresh
      // tyres of the compound just removed
      let next = (c.pitPlan && c.pitPlan.length) ? c.pitPlan.shift() : (c.pitCompound || removed);
      // Sanity-check against the weather at the moment of the stop. Without
      // this, a car that armed a wet stop earlier would come in later for its
      // scheduled dry stop and bolt on inters again — twice in a row.
      if (!c.driver.player) next = compoundForConditions({ pitCompound: next });
      c.phys.setTyre(next);
      c.pitCompound = (c.pitPlan && c.pitPlan.length) ? c.pitPlan[0] : removed;
      c.pitted = true; c.pitState = null; c.pitArmed = false; c.pitArmLap = null;
      if (c.driver.player) {
        const lane = c.pitLaneStart != null ? (G.simTime - c.pitLaneStart) : 0;
        showBanner('OUT — ' + c.phys.compound.toUpperCase() + 'S · PIT LANE ' + lane.toFixed(1) + 's', 2.4, '#2ecc71');
        G.pitGame = null;
      }
    }

    if (started && c.phys.crossedLine) {
      // lightweight AI lap timing (player timing lives in onPlayerLapComplete)
      if (!c.driver.player) {
        const aiLap = G.simTime - (c._lapStart || 0);
        c._lapStart = G.simTime;
        if (aiLap > 15 && (c.bestLap == null || aiLap < c.bestLap)) c.bestLap = aiLap;
        if (aiLap > 15) noteRaceLap(c, aiLap);
      }
      if (c.driver.player) {
        onPlayerLapComplete();
        updateLapPanel();
        if (G.mode === 'race') {
          if (c.phys.lap > G.raceLaps) {
            c.finished = true; c.finishTime = G.simTime;
            if (G.raceLaps > 20 && !c.pitted) showBanner('DISQUALIFIED — NO MANDATORY PIT STOP', 3, '#ff5c5c');
            else showBanner('FINISHED', 3, '#ffd12e');
            G.endTimer = setTimeout(endRace, 1800);
          } else if (c.phys.lap === G.raceLaps) {
            showBanner('FINAL LAP', 2, '#ffd12e');
          }
        }
      } else if (G.mode === 'race' && c.phys.lap > G.raceLaps) {
        c.finished = true; c.finishTime = G.simTime;
        if (!G.firstFinish) {
          G.firstFinish = G.simTime;
          showBanner(c.driver.id + ' WINS THE RACE', 2.5, '#ff5c5c');
        }
      }
    }
  }
  if (started && G.player && !G.player.finished) { recordCheckpoint(); updateSectors(); }
  // safety: classify stragglers 45s after the winner
  if (G.mode === 'race' && G.firstFinish && !G.endTimer && G.simTime - G.firstFinish > 45) {
    G.endTimer = setTimeout(endRace, 100);
  }
  resolveCollisions();
  // stewards: decay contact cooldowns, monitor track limits
  for (const c of G.cars) { if (c.contactCd > 0) c.contactCd -= dt; if (c.phys.dmgCd > 0) c.phys.dmgCd -= dt; }
  checkTrackLimits(dt);
}

// keep simulation alive when tab is hidden (rendering stays paused)
let bgLast = performance.now();
setInterval(() => {
  const now = performance.now();
  if (document.hidden && G.state === 'driving') {
    let el = Math.min(2, (now - bgLast) / 1000);
    while (el > 0) { stepSim(FIXED); el -= FIXED; }
    lastT = now;
  }
  bgLast = now;
}, 100);

window.__G = G; // debug handle
requestAnimationFrame(frame);
$('loading-note').textContent = 'Ready — select a mode   ·   BUILD 57';
})();
