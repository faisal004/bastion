# Bastion — Browser Tower Defense

A 3D tower defense game that runs in the browser with no build step and no network access.
The only third-party code is three.js, vendored in the repo.
You hold a fortress against 50 waves of enemies by placing, upgrading and selling
towers along a winding road.

```bash
node server.js          # then open http://localhost:5173
# or: python3 -m http.server 5173
```

> Status: this README is written **incrementally**, alongside the code.
> Sections marked _(planned)_ describe work that has not landed yet.

---

## Gameplay

| | |
|---|---|
| **Goal** | Survive all 50 waves. Each enemy that reaches the fortress costs lives. |
| **Economy** | Kills pay gold. Clearing a wave pays a bonus. Calling the next wave early pays extra. |
| **Score** | Kill points + wave-clear points + a bonus for lives left at victory. |

### Towers
| Tower | Role | Notes |
|---|---|---|
| **Blaster** | Fast single-target DPS | Cheap. Weak against armor (low damage per hit). |
| **Cannon** | Area-splash shells | Ground only: cannot hit flyers. Good against swarms. |
| **Frost** | Pulse aura that slows and chips | Hits everything in range. Bosses resist half of the slow. |
| **Sniper** | Long-range rail shot | Ignores armor. Targets the strongest enemy by default. |

Every tower has 3 levels. Selling refunds 70% of the gold you put into it.
You can set each tower's targeting mode: first, last, strongest or closest.

### Enemies
| Enemy | Trait |
|---|---|
| **Grunt** | Baseline |
| **Runner** | Fast and fragile |
| **Tank** | Slow, armored (flat damage reduction), costs 2 lives |
| **Swarm** | Tiny, arrives in large packs |
| **Flyer** | Airborne: immune to Cannon splash |
| **Boss** | Every 10th wave. Huge HP, heavy armor, partly resists slow, costs 10 lives |

Enemy HP grows quadratically with the wave number. Armor grows every 10 waves.
New enemy types arrive as the waves go on, so the game gets steadily harder.

### Controls
| Input | Action |
|---|---|
| `1`–`4` / click a card | Pick a tower to place (hold `Shift` to keep placing) |
| Left click | Place a tower, or select one |
| `U` / `X` | Upgrade / sell the selected tower |
| `T` | Change the selected tower's targeting mode |
| `N` | Start the next wave (early calls pay bonus gold) |
| `Space` | Pause |
| `F` | Game speed 1× → 2× → 4× |
| `R` (twice) | Restart |
| `Shift+M` | Cheat: unlimited gold until restart |
| Sound on / Sound off | Toggle sound effects (preference is saved) |
| Wheel / pinch | Zoom |
| Drag, right-drag, `WASD` / arrows | Pan |
| `` ` `` | Toggle the performance overlay |
| `L` | Open the Stress Lab |
| `G` | Toggle renderer: original Canvas 2D ↔ WebGL2 (for before/after demos) |
| `V` | Toggle 2D ↔ 3D view |
| `Esc` | Cancel placement / deselect |

Sound effects use the browser Web Audio API and start after your first interaction. Each tower has a distinct firing cue, with effects for construction, upgrades, selling, explosions, fortress damage, wave events, and victory/defeat. Effects are rate-limited; stress tests remain silent. No audio downloads are required.

Run the sound checks with `node scripts/check-audio.mjs`.

---

## Architecture

```
index.html, style.css     DOM shell: HUD bar, side panel, overlays
server.js                 zero-dependency static file server
src/
  config.js               all game data: map, towers, enemies, wave generator, balance curves
  game.js                 simulation (pure state + fixed-step update); knows nothing about the DOM
  render.js               layered renderer: Canvas 2D ground/towers/effects + mode switch for entities
  render3d.js             3D renderer (three.js): instanced meshes, custom shaders, bloom, adaptive quality
  glrender.js             WebGL2 instanced entity renderer (one draw call) + sprite atlas
  shapes.js               enemy shape painting shared by every renderer
  opts.js                 runtime optimization switches (?baseline, ?opt=key:value)
  grid.js                 spatial hash grid for range queries
  stress.js               stress-load setup shared by the lab and the worker
  sim-worker.js           optional: simulation in a Web Worker (sim: worker)
  snapshot.js             worker -> main snapshot format (transferred Float32Array)
  proxy.js                main-thread GameProxy used in worker mode
  ui.js                   DOM HUD / shop / selection panel; writes to the DOM only when values change
  main.js                 bootstrap, the single frame loop, input, camera, perf meter
  bot.js                  headless autoplayer, used for balance tuning and long-run tests
  lab.js                  Stress Lab: fixed-load harness, frame-time recorder, breaking-point ramp
scripts/bench.mjs         zero-dependency Chrome/DevTools benchmark runner (ramp, bench, phases, shots, clicktest)
vendor/three/             three.js r186.1, only the files the game imports (core + bloom post-processing)
bench/results/            raw JSON from benchmark runs
```

**Balance** is tuned with `bot.js`, which plays complete games headlessly in about
1 s each. A greedy mixed-tower bot clears wave 50 with ~15/25 lives left.
Blaster-only collapses on wave 20 and Cannon-only on wave 15, because armor and
flyers punish a one-tower strategy. To re-run it from the browser console:

```js
const { Game } = await import('/src/game.js');
const { simulate } = await import('/src/bot.js');
simulate(Game, ['blaster', 'cannon', 'frost', 'sniper']);
```

**One loop.** There is one `requestAnimationFrame` loop for the whole game. No entity
owns a timer or an animation loop. Every system iterates its entity list once per
simulation step.

**Fixed-timestep simulation.** The simulation always advances in fixed 1/60 s steps,
driven by an accumulator (`frameTime × gameSpeed`). Rendering interpolates between the
previous and current step positions. This makes game behavior identical on 30, 60, 120
and 144 Hz displays. Game speed (2×, 4×) runs more fixed steps per frame. It never
uses a bigger `dt`, so 4× plays out the same as 1×, just faster. A cap on steps per
frame prevents a "spiral of death" when the tab stalls.

**State/render split.** `game.js` owns all state. `render.js` and `ui.js` only read it.
This keeps the simulation easy to measure on its own, to run headless, and to optimize
separately from drawing.

## Rendering approach

**Default: 3D with three.js** ([src/render3d.js](src/render3d.js)).
- three.js r186.1 is vendored in `vendor/three` (sha512-verified from npm), mapped with an import
  map, and nothing is fetched at runtime.
- The simulation is unchanged. The 3D view is another renderer over the same game state.
- **Camera:** a tilted perspective camera follows the same pan/zoom as the 2D camera. Clicks are
  ray-cast onto the ground plane to find the tile.
- **Instancing as in 2D:** every high-count thing is one `InstancedMesh`, filled by writing
  straight into its typed arrays. That covers enemies (one mesh per type), blob shadows, billboard
  health bars, projectiles, tower bases, turrets, level pips, muzzle flashes, rings and tracers.
- **Culling:** off-screen enemies and projectiles are skipped using the camera's ground footprint.
- **Custom shaders, for the look:**
  - procedural terrain: fbm grass, dry patches, a worn dirt road with a dark lip, all from a
    distance-to-path field; a placement grid and a hover tile
  - wind-blown grass blades (vertex shader)
  - fireflies (vertex shader)
  - a swirling spawn portal
  - additive glow rings for frost pulses and explosions
  - GPU-animated death-burst particles
  - a grading pass: vignette, split toning and saturation
- **Lighting:** sun with soft shadows, sky/ground hemisphere light, and a pulsing fortress core
  with a point light that flares red when the fortress is hit.
- **Adaptive quality:** bloom (`UnrealBloomPass`) drops out automatically when too many frames miss
  the 45 fps budget, and comes back when the load falls.

**2D modes** (still available: `V` toggles 2D/3D, and the Stress Lab has every mode):

Three stacked canvases share one world-space camera (zoom and pan) and a backing store
that accounts for device pixel ratio:

| Layer | API | Draws |
|---|---|---|
| `#game` (bottom) | Canvas 2D | ground, road, rocks, base, towers |
| `#gl` | **WebGL2, instanced** | enemies, health bars, slow rings, projectiles |
| `#fx` (top) | Canvas 2D | effects (rings, tracers, damage text), range and placement overlays |

**The WebGL layer** ([src/glrender.js](src/glrender.js)):
- Every entity becomes one instance in an interleaved `Float32Array`: a world rect, an atlas UV
  rect and a packed RGBA8 tint, 36 bytes each.
- Each frame is one `bufferSubData` plus **one `drawArraysInstanced`**, whatever the entity count.
- Sprites live in a texture atlas painted by the same shape code the Canvas 2D renderer uses
  ([src/shapes.js](src/shapes.js)), so every mode looks the same.
- The atlas is repainted only when the zoom crosses a 0.5× step, so sprites stay crisp.
- Health bars use a solid texel from the atlas and a tint, so they go out in the same draw call.

The low-count layers (towers, effects, UI overlays) stay in Canvas 2D, because it is simpler
and they are not hot. The older Canvas 2D entity renderers are still there as switchable
modes (`naive`, `paths`, `sprites`) for comparison.

## Performance

Numbers live in [`NUMBERS.md`](NUMBERS.md). Summary (Apple M5, 4× CPU throttle):

| Build | Breaks at (enemies / towers / projectiles) |
|---|---|
| Baseline | 7,500 / 150 / 1,500 |
| + WebGL2 instanced renderer | 15,000 / 300 / 3,000 |
| + spatial hash grid | 20,000 / 400 / 4,000 (native: none up to 40,000 / 600 / 8,000) |
| + allocation-free simulation | 30,000 / 600 / 6,000 (native: none up to 40,000 / 600 / 8,000) |
| + counting-sort GPU fill, culling, cached ground | unchanged at 4× (draw −21–45%); last pass 20,000 / 400 / 4,000 |

### Bottlenecks found
1. **Per-call Canvas 2D overhead (fixed).** At the target load, drawing cost 10 ms per frame
   versus 1 ms for the simulation, and nearly all of it was the main-thread cost of thousands
   of `arc`/`fill`/`fillRect` calls.
   - Batching into big paths made it worse: Skia must tessellate the whole path.
   - Sprites drawn with `drawImage` were also worse: Skia cannot merge draws from different sources.
   - WebGL instancing fixed it. See NUMBERS.md for the full comparison.
2. **O(towers × enemies) range queries (fixed).** Target search, splash and frost pulses scanned
   every enemy. At 30k that took 395 ms per frame. A spatial hash grid brought it to 23 ms.
3. **Enemy movement and GC churn (fixed).**
   - Every enemy re-walked the road's segment list each step (44% of sim time).
   - Hidden allocations (a reallocating scratch array, `Math.hypot`, `for…of` iterators) plus
     `filter()` and new objects caused about one GC every 4 steps at 40k.
   - Now: cached segments, pools, in-place compaction. 6.6 → 3.1 ms per step, 92 → 11 GCs.
4. **WebGL buffer fill (fixed).**
   - The assumption was that the 2D layers cost the most. Per-phase timers showed the WebGL
     instance fill was 6.7 of ~9 ms at 20k: bucket arrays regrown every frame, 4 passes,
     string keys.
   - A counting-sort fill halved it. Culling makes zoomed-in draw cost follow what is on screen.
     The static ground is cached.
5. **Sim + draw on one thread (tried a worker; not adopted).**
   - At 25k under 4× throttling, one sim step (~8 ms) plus draw (~9.6 ms) exceeds 16.7 ms.
   - Moving the sim into a Web Worker (transferred `Float32Array` snapshots, a main-thread
     `GameProxy`) did not raise the breaking point. The same step runs ~60% slower in the worker
     (likely efficiency-core scheduling), and packing/unpacking snapshots costs main-thread time.
   - It stays available as `sim: worker`. See NUMBERS.md section 5.

### Optimizations
| # | What | Switch |
|---|---|---|
| 1 | WebGL2 instanced entity renderer (one draw call) | `render`: naive / paths / sprites / **webgl** |
| 2 | Spatial hash grid: counting-sort rebuild per step, typed arrays, no allocation | `grid`: off / **on** |
| 3 | Cached path segment per enemy | `path`: scan / **cached** |
| 3 | Object pools + in-place compaction (fixed object shapes, id-checked targets) | `alloc`: filter / **pooled** |
| 4 | Counting-sort WebGL instance fill (2 passes, zero garbage) | `glfill`: buckets / **counting** |
| 4 | Viewport culling for enemies, projectiles and towers | `cull`: off / **on** |
| 4 | Static ground cached in an offscreen layer | `bg`: redraw / **cached** |
| 5 | Simulation in a Web Worker: zero-copy snapshots, `GameProxy` (measured slower; not default) | `sim`: **main** / worker |
| 6 | 3D renderer (three.js) with instanced fills, culling, GPU particles, adaptive bloom | `render`: … / **3d**, `quality`, `bloom`, `shadows` |

Every optimization is a runtime switch, so before and after run on the same build:
- `?baseline` starts with every switch at its original setting.
- `?opt=render:webgl` sets one switch.
- The Stress Lab panel flips switches live, and `G` toggles the renderer during play.

### How performance is measured

**Stress Lab** (in game: press `L`, or open `/?lab`; `/?stress=5000,100,1000` applies a load on page load).
- It holds the game at a fixed number of enemies, towers and projectiles. Enemies loop the road
  forever and are refilled as they die. Towers are max level, a mix of all four types, placed
  along the road. Extra projectiles fly at random enemies until the projectile count reaches the target.
- It records the real time between `requestAnimationFrame` callbacks, which is what the player
  sees. It also records the JavaScript cost of sim and draw.
  - **avg fps**: 1000 / mean frame time.
  - **fps @95%**: 1000 / p95 frame time. This is the frame rate that 95% of frames meet.
    The brief requires ≥ 45.
  - **>33 ms**: the share of frames slower than 33 ms. The brief requires < 5%.
  - **sim speed**: game time advanced ÷ real time. This catches a simulation that falls behind
    while frames stay smooth. It must be ≥ 95%.
- A live frame-time graph turns yellow below 45 fps and red below 30 fps.
- **Find breaking point** ramps the load from 10% to 800% of the target and plots fps per step.
  It then marks the first step that fails either criterion.

**`scripts/bench.mjs`** is the same measurement, automated and reproducible:
```bash
node server.js &
node scripts/bench.mjs --headed            # ramp in a real Chrome window
node scripts/bench.mjs --headed --cpu 4    # same, with DevTools 4× CPU throttling
node scripts/bench.mjs --headed --mode bench --load 5000,100,1000
node scripts/bench.mjs --headed --cpu 4 --mode phases --load 20000,400,4000   # draw time per phase
node scripts/check-grid.mjs                # grid == full scan, plus a full-game check
node scripts/check-sim.mjs                 # optimized sim stays bit-identical to the original
node --expose-gc scripts/check-memory.mjs  # heap across a full 50-wave game
node scripts/profile-sim.mjs 20000 400 4000 opt=grid:on   # per-phase sim profile (Node)
```
- It launches Chrome with a throwaway profile, at 2× DPR, with background throttling disabled.
- It drives the Stress Lab over the DevTools protocol, prints a table, and can save JSON
  (`--out`) and a screenshot (`--shot`).
- Use `--headed`. Headless Chrome reported 60 fps at loads where the real window could not keep up.
- DevTools CPU throttling does not reach Web Workers. With `--cpu N`, the script also passes
  `workercpu=N`, so the worker emulates the same slowdown.

Roadmap:

1. ✅ **Baseline (v0)** — a straightforward first implementation: object-per-entity arrays,
   `filter()` to remove dead entities, O(towers × enemies) target search, O(enemies)
   splash search, every shape drawn with its own path and fill-style change, and no
   culling. This is the "initial implementation" that the later steps are compared against.
2. ✅ **Stress harness** — the Stress Lab and `scripts/bench.mjs` described above.
   The baseline's breaking point is recorded in `NUMBERS.md`.
3. **Optimization steps**, each behind a runtime toggle so before and after can be shown
   live:
   - ✅ spatial hash grid for target, splash and frost queries
   - ✅ allocation-free simulation: object pools, in-place compaction, cached path segments
   - ✅ instanced WebGL2 rendering (batched paths and sprite atlases were tried first, and lost)
   - ✅ counting-sort WebGL fill, viewport culling, cached static ground
4. **Measurement write-up** — a methodology section, plus `NUMBERS.md` with a
   before/after table for each optimization.
