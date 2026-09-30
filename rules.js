// ============================================================
// Race rules — pure functions (no DOM, no THREE) so the test gauntlet can
// exercise them directly. main.js calls these; nothing here touches G.
// ============================================================

// Classify a race the way the FIA does.
//  - Everyone who takes the chequered flag is classified by LAPS COMPLETED,
//    then by elapsed time INCLUDING stewards' time penalties. A penalty is
//    part of your race time: a 45s penalty with a 7s lead puts you behind.
//  - Cars still running when classification happens are projected to their
//    next crossing of the line (that's when they'd have taken the flag).
//  - Retirements below all runners (most laps first), disqualifications last.
//
// cars: [{ id, retired, dsq, finished, finishTime, lapsDone, lap, lapDist,
//          totalDist, bestLap, pitted }]
// o:    { raceLaps, trackLen, simTime, penalties:{id:secs}, mandatoryStop }
function classifyRace(cars, o) {
  const L = o.trackLen, N = o.raceLaps, now = o.simTime;
  const rows = cars.map(c => {
    const pen = (o.penalties && o.penalties[c.id]) || 0;
    let status = c.retired ? 'dnf' : 'run';
    let laps, time;
    if (c.finished) {
      laps = c.lapsDone != null ? c.lapsDone : N;
      time = c.finishTime;
    } else {
      const done = Math.max(0, (c.lap || 0) - 1);
      if (status === 'dnf') { laps = done; time = null; }
      else {
        // still running: they take the flag at their next crossing
        const pace = c.bestLap ? L / (c.bestLap * 1.03)
                   : Math.max(5, (c.totalDist || 0) / Math.max(1, now));
        laps = Math.min(N, done + 1);
        time = now + Math.max(0, L - (c.lapDist || 0)) / Math.max(5, pace);
      }
    }
    if (status !== 'dnf' && (c.dsq || (o.mandatoryStop && !c.pitted))) status = 'dsq';
    const corrected = time != null ? time + pen : null;
    return { src: c, id: c.id, status, laps, time, pen, corrected };
  });
  const rank = s => s === 'run' ? 0 : s === 'dnf' ? 1 : 2;
  rows.sort((a, b) => {
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    if (a.laps !== b.laps) return b.laps - a.laps;              // more laps first
    if (a.status !== 'run') return 0;
    return a.corrected - b.corrected;                           // then time incl. penalties
  });
  // gaps: same lap as the winner → seconds; lapped → "+N Laps" plus a
  // seconds estimate of how far back they'd have been over the full distance
  const win = rows[0];
  const avgLap = win && win.laps > 0 ? win.time / win.laps : 90;
  rows.forEach((r, i) => {
    r.pos = i + 1;
    if (r.status === 'dnf') { r.text = 'DNF — damage'; return; }
    if (r.status === 'dsq') { r.text = 'DSQ — no mandatory stop'; return; }
    if (i === 0) { r.text = null; r.gap = 0; return; }
    const down = win.laps - r.laps;
    if (down <= 0) { r.gap = r.corrected - win.corrected; r.text = '+' + r.gap.toFixed(3); }
    else {
      r.gap = (r.corrected + down * avgLap) - win.corrected;
      r.text = '+' + down + ' Lap' + (down > 1 ? 's' : '');
    }
  });
  return rows;
}

if (typeof module !== 'undefined') module.exports = { classifyRace };
