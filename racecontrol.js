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

  // 2. a car that has just stopped for good is an incident
  for (const c of G.cars) if (c.retired && !c._rcSeen) { c._rcSeen = true; rcIncident(G, c); }

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
  if (!onTrack && Math.random() < 0.4) { rcRcMsg('YELLOW FLAG — ' + c.driver.id + ' stopped off the track'); return; }
  rcDeployVSC(G, 28 + Math.random() * 40 + (onTrack ? 15 : 0));
}

function rcDeployVSC(G, dur) {
  const rc = G.rc;
  if (rc.mode === 'vsc') { rc.timer = Math.max(rc.timer, dur); return; }
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
    c.rcGhost = null;
    for (const a of [c.ai, c.autoAi]) if (a) { a.rcCap = null; a.rcNeutral = false; }
  }
  const lead = Math.max(...G.cars.filter(c => !c.retired).map(c => c.phys.lap));
  rc.drsOffUntilLap = lead + 1;                 // DRS back a lap after the restart
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
  const st = rc.pl || (rc.pl = { warned: 0, sec: null, pass: null, passT: 0 });
  const grace = rc.t - (rc.since || 0) < 6;
  const sec = Math.floor(pl.phys.lapDist / t.length * RC_SECTORS);
  if (st.sec != null && sec !== st.sec && !grace && (pl.rcDelta || 0) < -0.15) {
    st.warned++;
    if (st.warned === 1) rcBanner('VSC — SLOW DOWN: STAY ABOVE THE MINIMUM TIME', 2.6, '#ff8a85');
    else if (typeof addPenalty === 'function') addPenalty(pl, 5, 'exceeding the VSC minimum time');
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
    if (was != null && was > 0 && g < 0 && Math.abs(g) < 30 && !c.pitState && !c.failing
        && c.phys.speed > 0.5 * rcRefSpeed(t, c.phys.trackIdx) && !st.pass) {
      st.pass = c; st.passT = 10;
      rcBanner('VSC — NO OVERTAKING: GIVE THE PLACE BACK TO ' + c.driver.id, 3, '#ff8a85');
    }
  }
  if (st.pass) {
    const raw = st.pass.phys.totalDist - pl.phys.totalDist;
    const g = ((raw % L) + L + L / 2) % L - L / 2;
    st.passT -= dt;
    if (g > 0 || st.pass.retired || st.pass.pitState) st.pass = null;          // given back
    else if (st.passT <= 0) {
      if (typeof addPenalty === 'function') addPenalty(pl, 5, 'overtaking under the VSC');
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
  const ending = rc.mode === 'vscEnding';
  el.style.background = ending ? '#2a2a10' : '#3b3200';
  el.style.color = '#ffd12e';
  el.style.border = '2px solid #ffd12e';
  let txt = ending ? 'VSC ENDING' : 'VIRTUAL SAFETY CAR';
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
           drsOffUntilLap: rc.drsOffUntilLap || 0, since: rc.since || 0, incidents: rc.incidents.slice(-20) };
}
function rcCarSnapshot(c) {
  return { failPlan: c.failPlan || null, failing: c.failing || null, rcGhost: c.rcGhost != null ? c.rcGhost : null, rcSeen: !!c._rcSeen, retireReason: c.retireReason || null };
}
function rcRestore(G, snap, carsSnap) {
  G.rc = { mode: 'green', t: 0, timer: 0, vscCount: 0, scCount: 0, drsOffUntilLap: 0, incidents: [] };
  if (snap) Object.assign(G.rc, snap, { incidents: (snap.incidents || []).slice() });
  if (carsSnap) for (const c of G.cars) {
    const s = carsSnap[c.driver.id];
    if (!s) { c._rcSeen = !!c.retired; continue; }
    c.failPlan = s.failPlan; c.failing = s.failing; c.rcGhost = s.rcGhost; c._rcSeen = s.rcSeen || !!c.retired; c.retireReason = s.retireReason;
  }
}
