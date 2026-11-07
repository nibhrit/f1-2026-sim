// ============================================================
// Tilt → steering maths (pure functions, shared by touch.js and the
// simulated-novice test harness so the test drives the REAL mapping).
// ============================================================
const TILT_FEEL = {
  // BUILD 100: every preset a notch calmer (Balanced is the old Smooth+)
  smooth:   { curve: 2.0,  tau: 0.16 },
  balanced: { curve: 1.75, tau: 0.11 },
  direct:   { curve: 1.4,  tau: 0.07 },
};
// d: phone turn in degrees from level (+ clockwise), after trim.
// Returns steer -1..1 (+ = left, the game's convention), before filtering.
function tiltShape(d, cfg, speed) {
  const F = TILT_FEEL[cfg.feel] || TILT_FEEL.balanced;
  const dz = 0.6;                                       // dead-zone, degrees
  d = Math.sign(d) * Math.max(0, Math.abs(d) - dz);
  const x = Math.min(1, Math.abs(d) / Math.max(8, cfg.sens));
  // curved response: gentle around centre, full lock still at the same angle;
  // a little gentler still at high speed
  const hi = Math.max(0, Math.min(1, ((speed || 0) - 50) / 35));
  let s = Math.sign(d) * Math.pow(x, F.curve + 0.35 * hi);
  s = -s;                                               // clockwise = right = negative steer
  if (cfg.invert) s = -s;
  return s;
}
function tiltFilterK(cfg, dt) { const F = TILT_FEEL[cfg.feel] || TILT_FEEL.balanced; return 1 - Math.exp(-dt / F.tau); }
