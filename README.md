# F1 2026 Simulator

A 3D Formula 1 simulator that runs entirely in the browser. No build step, no
framework, no game engine — just Three.js and vanilla JavaScript.

Drive as Max Verstappen for Oracle Red Bull Racing across all 24 circuits of the
2026 season, with real track geometry, tyre strategy, dynamic weather, pit stops
and an FIA-style stewards system.

**▶ Play it:** _https://nibhrit.github.io/f1-2026-sim/_

---

## Features

**Circuits** — all 24 rounds of the 2026 calendar built from real centreline
data (TUM racetrack database + OpenStreetMap), including Madrid's new Madring.
Correct direction of travel, elevation, banking, kerbs, gravel traps and
per-track DRS zone counts matching the real layouts.

**Sessions**
- **Practice** — unlimited running
- **Qualifying** — 5-minute clock, chequered flag, track-limits lap deletion
- **Race** — full grid or head-to-head, Short / Half / Full distance (real lap counts)
- **Grand Prix Weekend** — practice → qualifying → race, with your grid slot carried over
- **Season** — all 24 rounds, drivers' + constructors' championships, calendar history

**Driving model** — quadratic aerodynamic downforce, load transfer under braking,
grip-limited steering, tyre wear and temperature (cold tyres need a lap to switch
on; overheating costs grip), and a genuine wet-weather model where a soaked track
is slower whatever you fit.

**Strategy** — Soft / Medium / Hard plus Intermediates and Wets, mandatory
two-compound rule in races over 20 laps, multi-stop strategies, and a
reaction-light pit stop minigame that decides your stationary time.

**Weather** — per-circuit rain probability based on real climate, evolving
conditions (drizzle, downpour, drying track, rain arriving mid-race), animated
3D rain, spray haze and engineer radio calls for the crossover.

**Racecraft & stewards** — AI follows a computed racing line, defends the inside,
and sets up switchbacks. FIA-style penalties apply to everyone: escalating track
limits (3 warnings → 5s → 10s → drive-through), collision fault, and
disqualification for skipping the mandatory pit stop.

**Presentation** — broadcast-style timing tower with live tyre compounds and
in-pit tags, sector timing with purple/green/yellow splits, live delta, DRS
indicator, podium celebrations, and persistent lap records per circuit.

---

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake (and reverse from a standstill) |
| `A` `D` / `←` `→` | Steer |
| `C` | Cycle camera — chase / cockpit / T-cam / TV |
| `V` | Look behind (hold) |
| `P` | Pit this lap |
| `Space` | Pit stop reaction lights |
| `M` | Mute / unmute |
| `R` | Reset to track |
| `Esc` | Pause |

---

## Running locally

No build step — just serve the folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Opening `index.html` directly via `file://` also works, but browsers cache
aggressively there. The build number shown on the main menu tells you which
version you're actually running — if it looks stale, hard-refresh with
`Cmd/Ctrl + Shift + R`.

## Background music

The game looks for `music.mp3` in the project root and plays it quietly in the
background. If the file is missing it falls back to an original procedural
loop, so the game works fine without it.

## Tech notes

- **Three.js r128** with a post-processing pipeline (SSAO, bloom, speed blur),
  ACES filmic tone mapping and image-based lighting.
- **Procedural everything** — track meshes, car models, textures, sky and all
  audio are generated at runtime. No downloaded art assets.
- **Adaptive quality** — pixel ratio steps down, then SSAO, then bloom if the
  frame rate drops, so it holds 60fps on modest hardware.
- **Web Audio** — engine note synthesised from a harmonic stack with
  downshift barks, tyre scrub, kerb rumble and doppler overtakes.

Track centreline data: [TUM racetrack database](https://github.com/TUMFTM/racetrack-database)
and OpenStreetMap contributors.
