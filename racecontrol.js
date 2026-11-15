// racecontrol.js — Race Control (BUILD 111): incidents, mechanical failures
// and the Virtual Safety Car, following the FIA Sporting Regulations:
//   * VSC DEPLOYED — every car slows and must stay ABOVE a minimum time
//     (here: never ahead of a reference "ghost" running ~40% slower than race
//     pace), checked at each light-panel sector; no overtaking except in the
//     pit lane or past a car with an obvious problem
//   * VSC ENDING — 10-15 s later the panels go green and racing resumes
// A car that stops (crash damage, or one of the occasional mechanical
// failures) becomes an incident; Race Control decides between local yellows
// and a VSC. (Safety Car and red flag build on this: BUILD 112 / 113.)
// Every function takes G explicitly — other scripts must not use a bare G.

const RC_LEVELS = { off: 0, realistic: 1, chaos: 3 };
const RC_VSC_PACE = 0.70;        // reference ghost speed, share of race pace
const RC_SECTORS = 10;           // light-panel (marshalling) sectors per lap
const RC_FAILS = [
  { id: 'engine', name: 'ENGINE FAILURE' },
  { id: 'hydraulics', name: 'HYDRAULICS FAILURE' },
  { id: 'gearbox', name: 'GEARBOX FAILURE' },
  { id: 'power', name: 'POWER UNIT FAILURE' },
];
// chance of a mechanical failure over a FULL race distance (scaled down for
// shorter races): roughly one AI retirement every race or two at full
// distance, and rare for you — not every race
const RC_FAIL_AI = 0.05, RC_FAIL_PLAYER = 0.03;

function rcLevel(G) {
  const k = G.incidents || 'realistic';
  return RC_LEVELS[k] != null ? RC_LEVELS[k] : 1;
}
function rcNeutral(G) { return !!(G.rc && G.rc.mode !== 'green'); }
function rcRcMsg(text, kind) { if (typeof stewardMsg === 'function') stewardMsg(text, kind || 'limits'); }
function rcBanner(text, secs, col) { if (typeof showBanner === 'function') showBanner(text, secs, col); }

// a full-grip race-pace speed profile of the circuit, cached on the track: the
// VSC reference runs at RC_VSC_PACE of it
function rcRefProfile(t) {
  if (t._rcProf) return t._rcProf;
  const c = new CarPhysics(t); c.gripBonus = 1;
  const ai = new AIDriver(c, t, { id: 'RC', skill: 0.9, team: 'redbull' });
  ai.buildCornerSpeeds();
  t._rcProf = Float64Array.from(ai.speedProfile(1.0, 0.9, 1.0));
  return t._rcProf;
}
function rcRefSpeed(t, idx) { return Math.max(12, rcRefProfile(t)[idx] * RC_VSC_PACE); }
function rcIdxAt(t, dist) { const L = t.length; return t.idxAtDist(((dist % L) + L) % L); }

// ---- race start: who (if anyone) will have a failure, and where ----
function rcInit(G) {
  G.rc = { mode: 'green', t: 0, timer: 0, vscCount: 0, scCount: 0, drsOffUntilLap: 0, incidents: [] };
  for (const c of G.cars) { c.failPlan = null; c.failing = null; c.rcGhost = null; c._rcSeen = !!c.retired; }
  const lvl = rcLevel(G);
  if (G.mode !== 'race' || !lvl || !G.track) return;
  const full = (G.trackDef && G.trackDef.fullLaps) || 60;
  const frac = Math.min(1, (G.raceLaps || 1) / full);
  const L = G.track.length;
  for (const c of G.cars) {
    const p = (c.driver.player ? RC_FAIL_PLAYER : RC_FAIL_AI) * lvl * frac;
    if (Math.random() < p) {
      c.failPlan = { at: (0.08 + 0.87 * Math.random()) * G.raceLaps * L,
                     type: RC_FAILS[Math.floor(Math.random() * RC_FAILS.length)].id };
    }
  }
}
function rcFailName(id) { const f = RC_FAILS.find(x => x.id === id); return f ? f.name : 'MECHANICAL FAILURE'; }

// ---- every step of a race ----
function rcStep(G, dt) {
  if (!G.rc || G.mode !== 'race' || !G.raceStarted || !G.track) return;
  const rc = G.rc, t = G.track;
  rc.t += dt;

  // 1. mechanical failures: power fades, the car pulls over and stops
  for (const c of G.cars) {
    if (c.finished || c.retired) continue;
    if (c.failPlan && !c.failing && !c.pitState && c.phys.totalDist >= c.failPlan.at) {
      c.failing = { type: c.failPlan.type, t: 0 }; c.failPlan = null;
      const nm = rcFailName(c.failing.type);
      rcRcMsg(c.driver.id + ' — ' + nm + ', slowing', 'coll');
      if (c.driver.player) {
        rcBanner(nm + ' — PULL OVER', 4, '#ff5c5c');
        if (typeof radio === 'function') radio('We have lost the car. ' + nm.toLowerCase() + '. Pull over safely.');
      }
    }
    if (c.failing) {
      const f = c.failing; f.t += dt;
      c.phys.powerCut = Math.min(1, f.t / 2.5);
      if (c.ai && !c.pitState) {
        // pull over to the nearer side of the road
        const lat = t.lateral(c.phys.x, c.phys.z, c.phys.trackIdx);
        c.ai.laneOverride = (Math.sign(lat) || 1) * (t.width / 2 - 1.0);
        c.ai.speedCap = Math.max(0, c.phys.speed - 6 * dt);
      }
      if ((c.phys.speed < 3 && f.t > 2) || f.t > 16) {
        c.phys.dead = true; c.retireReason = rcFailName(f.type);
      }
    }
  }

  // 2. a car that has just stopped for good is an incident; a heavy hit may
  //    leave debris on the road
  for (const c of G.cars) if (c.retired && !c._rcSeen) { c._rcSeen = true; rcIncident(G, c); }
  for (const c of G.cars) {
    const imp = c.phys.lastImpact || 0;
    if (imp > (c._rcImp || 0) + 4) {
      if (imp > 16 && !c.retired && rcLevel(G) && rc.mode === 'green' && Math.random() < 0.3 * rcLevel(G)) rcDebris(G, c);
      c._rcImp = imp;
    }
  }

  // 3. neutralisation lifecycle
  if (rc.mode === 'vsc') {
    rc.timer -= dt;
    if (rc.timer <= 0) {
      rc.mode = 'vscEnding'; rc.timer = 10 + Math.random() * 5;
      rcBanner('VSC ENDING', 2.5, '#ffd12e'); rcRcMsg('RACE CONTROL: VSC ENDING');
    }
  } else if (rc.mode === 'vscEnding') {
    rc.timer -= dt;
    if (rc.timer <= 0) rcGreen(G);
  } else if (rc.mode === 'sc' || rc.mode === 'scIn' || rc.mode === 'restart') {
    rcScStep(G, dt);
  }

  // 4. VSC: hold every car behind its reference ghost
  if (rc.mode === 'vsc' || rc.mode === 'vscEnding') rcVscEnforce(G, dt);
  rcHud(G);
}

function rcIncident(G, c) {
  const rc = G.rc, t = G.track, p = c.phys;
  const lat = t.lateral(p.x, p.z, p.trackIdx), hw = t.width / 2;
  const onTrack = Math.abs(lat) < hw + 0.5;
  rc.incidents.push({ id: c.driver.id, lapDist: Math.round(p.lapDist), onTrack, at: +rc.t.toFixed(1), why: c.retireReason || 'damage' });
  if (!rcLevel(G)) return;
  // the last lap: nothing left to neutralise for (the field takes the flag)
  const leader = G.cars.reduce((a, b) => (!b.retired && b.phys.totalDist > (a ? a.phys.totalDist : -1e12)) ? b : a, null);
  if (leader && leader.phys.lap >= G.raceLaps) { rcRcMsg('YELLOW FLAG — ' + c.driver.id + ' stopped'); return; }
  // a car stopped in a safe spot off the road is often only local yellows;
  // one on (or at the edge of) the road needs marshals on track: VSC
  const r = Math.random();
  if (!onTrack) {
    if (r < 0.4) { rcRcMsg('YELLOW FLAG — ' + c.driver.id + ' stopped off the track'); return; }
    if (r < 0.85) { rcDeployVSC(G, 28 + Math.random() * 40); return; }
    rcDeploySC(G, 70 + Math.random() * 60);       // a crane job
    return;
  }
  // stopped on (or at the edge of) the road: marshals on track
  if (r < 0.3) rcDeployVSC(G, 45 + Math.random() * 40);
  else rcDeploySC(G, 80 + Math.random() * 70);
}
function rcDebris(G, c) {
  rcRcMsg('RACE CONTROL: DEBRIS ON TRACK after contact involving ' + c.driver.id);
  G.rc.incidents.push({ id: c.driver.id, lapDist: Math.round(c.phys.lapDist), onTrack: true, at: +G.rc.t.toFixed(1), why: 'debris' });
  if (Math.random() < 0.55) rcDeployVSC(G, 30 + Math.random() * 30);
  else rcDeploySC(G, 60 + Math.random() * 50);
}

function rcDeployVSC(G, dur) {
  const rc = G.rc;
  if (rc.mode === 'vsc') { rc.timer = Math.max(rc.timer, dur); return; }
  if (rc.mode === 'sc' || rc.mode === 'scIn' || rc.mode === 'restart') { if (rc.mode !== 'restart') { rc.timer = Math.max(rc.timer, dur); rc.mode = 'sc'; } return; }
  rc.mode = 'vsc'; rc.timer = dur; rc.vscCount++; rc.since = rc.t;
  for (const c of G.cars) c.rcGhost = null;     // (re)started from where each car is
  rc.pl = { warned: 0, sec: null, pass: null, passT: 0 };
  rcBanner('VIRTUAL SAFETY CAR', 3, '#ffd12e');
  rcRcMsg('RACE CONTROL: VSC DEPLOYED');
  rcCheapStops(G, 'vsc');
}

function rcGreen(G) {
  const rc = G.rc;
  rc.mode = 'green'; rc.timer = 0;
  for (const c of G.cars) {
    c.rcGhost = null; c.rcUnlap = false; c.rcGo = false; c.rcQueued = false; c.rcPastSC = false; c._rcLap0 = null; c.rcDelta = null;
    for (const a of [c.ai, c.autoAi]) if (a) { a.rcCap = null; a.rcNeutral = false; a.rcUnlap = false; }
  }
  rcScRemove(G);
  const lead = Math.max(...G.cars.filter(c => !c.retired).map(c => c.phys.lap));
  rc.drsOffUntilLap = lead + (rc.wasSC ? 2 : 1);  // DRS back 2 laps after an SC restart, 1 after a VSC
  rc.wasSC = false;
  rcBanner('GREEN FLAG', 2, '#2ecc71'); rcRcMsg('RACE CONTROL: TRACK CLEAR — GREEN FLAG');
}

// the reference: each car's own ghost, started ~2 s up the road from where it
// was when the VSC came out (time to slow down), advancing at reference pace
function rcVscEnforce(G, dt) {
  const rc = G.rc, t = G.track;
  for (const c of G.cars) {
    if (c.finished || c.retired) continue;
    // the AI driving this car (yours too, on autopilot)
    const ai = c.ai || (c.driver.player && G.autopilot ? c.autoAi : null);
    if (c.pitState) { c.rcGhost = null; if (ai) ai.rcCap = null; continue; }   // pit lane: its own limit
    const p = c.phys;
    if (c.rcGhost == null) c.rcGhost = p.totalDist + Math.max(10, p.speed * 2.0);
    const gIdx = rcIdxAt(t, c.rcGhost);
    const vg = rcRefSpeed(t, gIdx);
    c.rcGhost += vg * dt;
    const vMe = rcRefSpeed(t, p.trackIdx);
    const delta = (c.rcGhost - p.totalDist) / Math.max(8, vMe);   // s, + = behind the ghost (legal)
    c.rcDelta = delta;
    if (ai) {
      ai.rcNeutral = true;
      // aim ~0.4 s behind the reference: legal with a margin, no time wasted
      const f = Math.max(0.55, Math.min(1.08, 1 + (delta - 0.4) * 0.35));
      ai.rcCap = c.failing ? 0 : vMe * f;
    }
  }
  rcPlayerChecks(G, dt);
}

// You: the minimum time at every light panel, and no overtaking
function rcPlayerChecks(G, dt) {
  const pl = G.player, rc = G.rc, t = G.track;
  if (!pl || pl.finished || pl.retired || pl.pitState || pl.failing) return;
  if (pl.rcGo || (pl.rcUnlap && !pl.rcPastSC)) { for (const c of G.cars) c._rcRel = null; return; }   // free to race / unlapping
  const st = rc.pl || (rc.pl = { warned: 0, sec: null, pass: null, passT: 0 });
  const grace = rc.t - (rc.since || 0) < 6;
  const sec = Math.floor(pl.phys.lapDist / t.length * RC_SECTORS);
  if (st.sec != null && sec !== st.sec && !grace && (pl.rcDelta || 0) < -0.15) {
    st.warned++;
    if (st.warned === 1) rcBanner('SLOW DOWN: STAY ABOVE THE MINIMUM TIME', 2.6, '#ff8a85');
    else if (typeof addPenalty === 'function') addPenalty(pl, 5, 'exceeding the ' + (rc.mode === 'vsc' || rc.mode === 'vscEnding' ? 'VSC' : 'safety car') + ' minimum time');
  }
  st.sec = sec;
  // overtaking: a car that was just ahead of you on the road is now behind,
  // and it wasn't in the pits or slowing with a problem — give it back
  const L = t.length;
  for (const c of G.cars) {
    if (c === pl || c.finished || c.retired) continue;
    const raw = c.phys.totalDist - pl.phys.totalDist;
    const g = ((raw % L) + L + L / 2) % L - L / 2;
    const was = c._rcRel;
    c._rcRel = g;
    if (was != null && was > 0 && g < 0 && Math.abs(g) < 30 && !c.pitState && !c.failing && !c.rcUnlap
        && c.phys.speed > 0.5 * rcRefSpeed(t, c.phys.trackIdx) && !st.pass) {
      st.pass = c; st.passT = 10;
      rcBanner((rc.mode === 'vsc' || rc.mode === 'vscEnding' ? 'VSC' : 'SAFETY CAR') + ' — NO OVERTAKING: GIVE THE PLACE BACK TO ' + c.driver.id, 3, '#ff8a85');
    }
  }
  if (st.pass) {
    const raw = st.pass.phys.totalDist - pl.phys.totalDist;
    const g = ((raw % L) + L + L / 2) % L - L / 2;
    st.passT -= dt;
    if (g > 0 || st.pass.retired || st.pass.pitState) st.pass = null;          // given back
    else if (st.passT <= 0) {
      if (typeof addPenalty === 'function') addPenalty(pl, 5, rc.mode === 'vsc' || rc.mode === 'vscEnding' ? 'overtaking under the VSC' : 'overtaking under the safety car');
      st.pass = null;
    }
  }
}

// a neutralisation makes a stop cheaper (everyone else is slow): the pit wall
// brings in the cars whose window is open or whose tyres are going off
function rcCheapStops(G, kind) {
  if (G.mode !== 'race') return;
  const pitsOpen = G.raceLaps > 20;
  for (const c of G.cars) {
    if (!c.ai || c.finished || c.retired || c.pitState || c.pitArmed || c.failing) continue;
    if (/^(inter|wet)$/.test(c.phys.compound)) continue;          // the weather decides those
    const left = G.raceLaps - c.phys.lap;
    if (left < 3) continue;
    const owes = pitsOpen && !c.pitted && !c.usedWet;
    const life = c.phys.tyreLife;
    let want = 0;
    if (owes && c.phys.lap >= (c.pitLap || G.raceLaps) - 6) want = 0.85;
    else if (owes && c.phys.lap >= G.raceLaps * 0.25) want = 0.45;
    else if (life < 0.5) want = 0.6;
    if (!want || Math.random() >= want) continue;
    c.pitCompound = (typeof aiCompoundFor === 'function') ? aiCompoundFor(left, owes ? c.phys.compound : null) : 'medium';
    if (c.pitted && c.pitLap2 && !c.pitted2) c.pitted2 = true;
    c.rcStop = kind;
    if (typeof armPit === 'function') armPit(c);
  }
  const pl = G.player;
  if (pl && !pl.finished && !pl.retired && !pl.pitState && typeof radio === 'function') {
    const owes = pitsOpen && !pl.pitted && !pl.usedWet;
    if ((owes && pl.phys.lap >= G.raceLaps * 0.25) || pl.phys.tyreLife < 0.5)
      radio((kind === 'vsc' ? 'VSC' : 'Safety car') + ' — a cheap stop if you box this lap.');
  }
}

// DRS: off while neutralised and for a lap after
function rcDrsBlocked(G) {
  if (!G.rc) return false;
  if (G.rc.mode !== 'green') return true;
  if (!G.rc.drsOffUntilLap) return false;
  const lead = Math.max(...G.cars.filter(c => !c.retired).map(c => c.phys.lap));
  return lead < G.rc.drsOffUntilLap;
}

// ---- HUD: the light panel + your VSC delta ----
function rcHud(G) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('rc-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rc-panel';
    el.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 54px);left:50%;transform:translateX(-50%);z-index:30;'
      + 'padding:5px 14px;border-radius:6px;font:700 14px/1.2 system-ui,sans-serif;letter-spacing:2px;display:none;text-align:center;pointer-events:none;';
    document.body.appendChild(el);
  }
  const rc = G.rc, pl = G.player;
  if (!rc || rc.mode === 'green' || G.mode !== 'race') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const ending = rc.mode === 'vscEnding' || rc.mode === 'scIn';
  el.style.background = ending ? '#2a2a10' : '#3b3200';
  el.style.color = '#ffd12e';
  el.style.border = '2px solid #ffd12e';
  let txt = { vsc: 'VIRTUAL SAFETY CAR', vscEnding: 'VSC ENDING', sc: 'SAFETY CAR', scIn: 'SAFETY CAR IN THIS LAP', restart: 'RESTART — NO OVERTAKING UNTIL THE LINE' }[rc.mode] || rc.mode.toUpperCase();
  if (rc.mode === 'restart' && pl && pl.rcGo) { el.style.display = 'none'; return; }
  if (pl && pl.rcUnlap && !pl.rcPastSC) txt += '<div style="font-size:12px;letter-spacing:1px;margin-top:2px;color:#5dff9b">UNLAP: OVERTAKE THE SAFETY CAR</div>';
  else if (pl && (rc.mode === 'sc' || rc.mode === 'scIn') && pl.rcQueued && pl.rcGap < 1e8) txt += '<div style="font-size:12px;letter-spacing:1px;margin-top:2px;color:#cdd8f0">GAP AHEAD ' + Math.round(pl.rcGap) + ' m</div>';
  if (pl && !pl.pitState && pl.rcDelta != null && !pl.retired && !pl.finished) {
    const d = pl.rcDelta;
    txt += '<div style="font-size:12px;letter-spacing:1px;margin-top:2px;color:' + (d >= 0 ? '#5dff9b' : '#ff6b6b') + '">DELTA ' + (d >= 0 ? '+' : '') + d.toFixed(1) + '</div>';
  }
  el.innerHTML = txt;
}

// ---- save / resume ----
function rcSnapshot(G) {
  const rc = G.rc;
  if (!rc) return null;
  return { mode: rc.mode, timer: rc.timer, t: rc.t, vscCount: rc.vscCount, scCount: rc.scCount || 0,
           drsOffUntilLap: rc.drsOffUntilLap || 0, since: rc.since || 0, incidents: rc.incidents.slice(-20),
           wasSC: !!rc.wasSC, scLaps: rc.scLaps || 0, unlapMsg: !!rc.unlapMsg, unlapDone: !!rc.unlapDone, goAt: rc.goAt != null ? rc.goAt : null,
           sc: rc.sc ? { d: rc.sc.phys.totalDist } : null };
}
function rcCarSnapshot(c) {
  return { failPlan: c.failPlan || null, failing: c.failing || null, rcGhost: c.rcGhost != null ? c.rcGhost : null, rcSeen: !!c._rcSeen, retireReason: c.retireReason || null,
           rcUnlap: !!c.rcUnlap, rcPastSC: !!c.rcPastSC };
}
function rcRestore(G, snap, carsSnap) {
  G.rc = { mode: 'green', t: 0, timer: 0, vscCount: 0, scCount: 0, drsOffUntilLap: 0, incidents: [] };
  if (snap) Object.assign(G.rc, snap, { incidents: (snap.incidents || []).slice(), sc: null });
  if (snap && snap.sc && (snap.mode === 'sc' || snap.mode === 'scIn')) rcScSpawn(G, snap.sc.d);
  if (G.rc.mode === 'restart') rcGreen(G);              // (a restart in progress resumes as green)
  if (carsSnap) for (const c of G.cars) {
    const s = carsSnap[c.driver.id];
    if (!s) { c._rcSeen = !!c.retired; continue; }
    c.failPlan = s.failPlan; c.failing = s.failing; c.rcGhost = s.rcGhost; c._rcSeen = s.rcSeen || !!c.retired; c.retireReason = s.retireReason;
    c.rcUnlap = !!s.rcUnlap; c.rcPastSC = !!s.rcPastSC;
  }
}


// ===================== SAFETY CAR (BUILD 112) =====================
// SAFETY CAR DEPLOYED -> the safety car picks up the leader and the field
// queues behind it (no overtaking; cars still catching the queue must stay
// above the minimum time). Pit lane open. Once the incident is cleared:
// LAPPED CARS MAY NOW OVERTAKE (they pass the queue and the safety car and
// rejoin at the back), then SAFETY CAR IN THIS LAP: it pulls into the pit
// lane at the end of the lap, the leader controls the pace and nobody may
// overtake until they cross the control line. DRS back two laps later.
const RC_SC_PACE = 0.60;          // safety car speed, share of race pace

function rcRunning(G) { return G.cars.filter(c => !c.finished && !c.retired && !c.pitState && !c.failing); }
function rcRoadGap(t, a, b) {     // metres a is ahead of b along the road (-L/2..L/2)
  const L = t.length, raw = a.totalDist - b.totalDist;
  return ((raw % L) + L + L / 2) % L - L / 2;
}

function rcDeploySC(G, dur) {
  const rc = G.rc, t = G.track;
  if (rc.mode === 'sc' || rc.mode === 'scIn') { rc.timer = Math.max(rc.timer, dur); rc.mode = 'sc'; return; }
  if (rc.mode === 'restart') return;      // let this restart happen
  rc.mode = 'sc'; rc.timer = dur; rc.scCount = (rc.scCount || 0) + 1; rc.since = rc.t; rc.wasSC = true;
  rc.scLaps = 0; rc.unlapDone = false; rc.unlapMsg = false; rc.scInT = 0;
  for (const c of G.cars) { c.rcGhost = null; c.rcUnlap = false; c.rcGo = false; c.rcQueued = false; }
  rc.pl = { warned: 0, sec: null, pass: null, passT: 0 };
  // the safety car comes out ahead of the leader
  const run = rcRunning(G);
  const lead = run.reduce((a, b) => (!a || b.phys.totalDist > a.phys.totalDist) ? b : a, null);
  rcScSpawn(G, lead ? lead.phys.totalDist + 260 : 0);
  rcBanner('SAFETY CAR DEPLOYED', 3.2, '#ffd12e');
  rcRcMsg('RACE CONTROL: SAFETY CAR DEPLOYED');
  rcCheapStops(G, 'sc');
}

function rcScSpawn(G, dist) {
  const rc = G.rc, t = G.track, L = t.length;
  const ld = ((dist % L) + L) % L, k = t.idxAtDist(ld);
  const ph = new CarPhysics(t);
  const rl = t._raceLine ? t._raceLine[k] : 0, pos = t.posAt(k, rl);
  ph.placeAt(pos.x, pos.z, Math.atan2(t.tx[k], t.tz[k]));
  ph.totalDist = dist; ph.lapDist = ld; ph.speed = rcRefSpeed(t, k) / RC_VSC_PACE * RC_SC_PACE;
  ph.gripBonus = 1; ph.isSC = true; ph.setTyre('medium'); ph.tyreTemp = 0.8;
  const ai = new AIDriver(ph, t, { id: 'SC', skill: 0.9, team: 'redbull' });
  ai.buildCornerSpeeds(); ai.laneBlend = 1;
  if (typeof aiSkillFromLevel === 'function') ai.setSkill(aiSkillFromLevel(0.7));
  rc.sc = { phys: ph, ai, mesh: null, lap0: Math.floor(dist / L) };
  const scene = G.__scene;
  if (scene && typeof THREE !== 'undefined' && THREE.Group) {
    try {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 4.6), new THREE.MeshLambertMaterial({ color: 0x2a2e36 }));
      body.position.y = 0.55; g.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.2), new THREE.MeshLambertMaterial({ color: 0x1b1e24 }));
      roof.position.set(0, 1.2, -0.3); g.add(roof);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.14, 0.3), new THREE.MeshBasicMaterial({ color: 0xffb000 }));
      bar.position.set(0, 1.52, -0.3); g.add(bar);
      scene.add(g); rc.sc.mesh = g; rc.sc.bar = bar;
    } catch (e) {}
  }
}
function rcScRemove(G) {
  const rc = G.rc;
  if (rc && rc.sc) {
    if (rc.sc.mesh && G.__scene) { try { G.__scene.remove(rc.sc.mesh); } catch (e) {} }
    rc.sc = null;
  }
}

function rcScStep(G, dt) {
  const rc = G.rc, t = G.track, L = t.length;
  const run = rcRunning(G);
  const lead = run.reduce((a, b) => (!a || b.phys.totalDist > a.phys.totalDist) ? b : a, null);
  const sc = rc.sc;

  // ---- the safety car itself ----
  if (sc) {
    const ph = sc.phys;
    const vSC = rcRefSpeed(t, ph.trackIdx) / RC_VSC_PACE * RC_SC_PACE;
    // waits for the leader if it has got away, never runs away from it
    let cap = vSC;
    if (lead) { const gap = rcRoadGap(t, ph, lead.phys); if (gap > 120) cap = Math.min(cap, Math.max(10, lead.phys.speed - 3)); }
    sc.ai.rcCap = cap;
    const inp = sc.ai.compute(dt, [ph]);
    ph.step(dt, inp);
    if (sc.mesh) {
      const y = (t.surfaceY ? t.surfaceY(ph.x, ph.z, ph.trackIdx) : 0) + 0.05;
      sc.mesh.position.set(ph.x, y, ph.z); sc.mesh.rotation.y = ph.heading;
      if (sc.bar && sc.bar.material) sc.bar.material.color.setHex(rc.mode === 'sc' && ((rc.t * 3) | 0) % 2 ? 0xffb000 : (rc.mode === 'sc' ? 0x6b4a00 : 0x222222));
    }
    rc.scLaps = Math.floor(ph.totalDist / L) - sc.lap0;
  }

  // ---- incident cleared: unlap, then "safety car in this lap" ----
  if (rc.mode === 'sc') {
    rc.timer -= dt;
    // everyone has caught up: lapped cars may now overtake (once)
    if (!rc.unlapMsg && rc.scLaps >= 1 && lead) {
      const lapped = run.filter(c => c !== lead && lead.phys.totalDist - c.phys.totalDist > L - 150);
      rc.unlapMsg = true;
      if (lapped.length) {
        for (const c of lapped) c.rcUnlap = true;
        rcBanner('LAPPED CARS MAY NOW OVERTAKE', 3, '#ffd12e'); rcRcMsg('RACE CONTROL: LAPPED CARS MAY NOW OVERTAKE');
        if (G.player && G.player.rcUnlap && typeof radio === 'function') radio('You are a lap down — you may overtake the safety car and unlap yourself.');
      } else rc.unlapDone = true;
    }
    if (rc.unlapMsg && !rc.unlapDone) {
      // done once every unlapping car is past the safety car
      rc.unlapDone = !G.cars.some(c => c.rcUnlap && !c.rcPastSC && !c.retired && !c.finished);
    }
    if (rc.timer <= 0 && rc.unlapDone && rc.scLaps >= 1) {
      rc.mode = 'scIn'; rc.scInT = 0;
      rcBanner('SAFETY CAR IN THIS LAP', 3, '#ffd12e'); rcRcMsg('RACE CONTROL: SAFETY CAR IN THIS LAP');
    }
  }
  if (rc.mode === 'scIn' && sc) {
    // into the pit lane at the end of the lap
    const g = typeof pitLaneGeom === 'function' ? pitLaneGeom(t) : null;
    const entry = g ? g.entryStart : L - 300;
    const ld = sc.phys.lapDist, prev = sc._ld != null ? sc._ld : ld;
    sc._ld = ld;
    rc.scInT += dt;
    const crossed = (prev < entry && ld >= entry) || (prev > ld && (entry > prev || entry <= ld));
    if (rc.scInT > 3 && crossed) {
      rcScRemove(G);
      rc.mode = 'restart'; rc.timer = 0; rc.goAt = null;
      // the leader picks the moment, somewhere between here and the line
      const toLine = Math.max(80, L - entry);
      rc.goAt = (lead ? lead.phys.totalDist : 0) + toLine * (0.35 + 0.5 * Math.random());
    }
  }

  // ---- every car ----
  const order = run.slice().sort((a, b) => b.phys.totalDist - a.phys.totalDist);
  for (const c of G.cars) {
    if (c.finished || c.retired) continue;
    const ai = c.ai || (c.driver.player && G.autopilot ? c.autoAi : null);
    if (c.pitState) { c.rcGhost = null; if (ai) ai.rcCap = null; continue; }
    const p = c.phys;
    // restart: released at the control line
    if (rc.mode === 'restart') {
      if (!c.rcGo) {
        const lineCrossed = c._rcLap0 != null && p.lap > c._rcLap0;
        if (c._rcLap0 == null) c._rcLap0 = p.lap;
        if (lineCrossed) c.rcGo = true;
      }
      if (c.rcGo) { if (ai) { ai.rcCap = null; ai.rcNeutral = false; } continue; }
    }
    // the car (or safety car) ahead of us on the road
    let ah = null, gap = 1e9;
    const objs = run.map(x => x.phys); if (sc) objs.push(sc.phys);
    for (const o of objs) {
      if (o === p) continue;
      const g = rcRoadGap(t, o, p);
      if (g > 0 && g < gap) { gap = g; ah = o; }
    }
    const vRef = rcRefSpeed(t, p.trackIdx);
    let cap;
    if (c.rcUnlap && !c.rcPastSC) {
      // unlapping: past the queue and the safety car at a brisk pace
      cap = vRef / RC_VSC_PACE * 0.82;
      if (sc && rcRoadGap(t, p, sc.phys) > 40) c.rcPastSC = true;
      if (ai) { ai.rcNeutral = false; ai.rcUnlap = true; }
    } else if (rc.mode === 'restart' && c === order[0]) {
      // the leader: safety-car pace until it chooses to go
      cap = rc.goAt != null && p.totalDist >= rc.goAt ? null : vRef / RC_VSC_PACE * RC_SC_PACE;
      if (cap == null && !rc.went) { rc.went = true; rcBanner('RESTART — GREEN AT THE LINE', 2, '#2ecc71'); }
      if (ai) { ai.rcNeutral = true; ai.rcUnlap = false; }
    } else if (gap > 80 && !(rc.mode === 'restart')) {
      // still catching the queue: stay above the minimum time
      if (c.rcGhost == null) c.rcGhost = p.totalDist + Math.max(10, p.speed * 2.0);
      const vg = rcRefSpeed(t, rcIdxAt(t, c.rcGhost));
      c.rcGhost += vg * dt;
      c.rcDelta = (c.rcGhost - p.totalDist) / Math.max(8, vRef);
      cap = vRef * Math.max(0.55, Math.min(1.08, 1 + (c.rcDelta - 0.4) * 0.35));
      c.rcQueued = false;
      if (ai) { ai.rcNeutral = true; ai.rcUnlap = false; }
    } else {
      // in the queue: hold station ~20 m behind the car ahead
      c.rcQueued = true; c.rcGhost = null; c.rcDelta = null;
      const vA = ah ? ah.speed : vRef;
      cap = Math.max(0, Math.min(vA + 6, vA + 0.35 * (gap - 20)));
      if (c.rcPastSC) { c.rcUnlap = false; }
      if (ai) { ai.rcNeutral = true; ai.rcUnlap = false; }
    }
    if (ai) ai.rcCap = c.failing ? 0 : cap;
    c.rcGap = gap;
  }
  // everyone's through the line (or 25 s after the leader went): racing
  if (rc.mode === 'restart' && rc.went) {
    rc.timer += dt;
    if (G.cars.every(c => c.finished || c.retired || c.pitState || c.rcGo) || rc.timer > 25) { rc.went = false; rcGreen(G); }
  }
  rcPlayerChecks(G, dt);
}
