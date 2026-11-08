# Bastion — Browser Tower Defense

A tower defense game that runs in the browser with no dependencies and no build step.
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
| Wheel / pinch | Zoom |
| Drag, right-drag, `WASD` / arrows | Pan |
| `` ` `` | Toggle the performance overlay |
| `L` | Open the Stress Lab |
| `Esc` | Cancel placement / deselect |

---

## Architecture

```
index.html, style.css     DOM shell: HUD bar, side panel, overlays
server.js                 zero-dependency static file server
src/
  config.js               all game data: map, towers, enemies, wave generator, balance curves
  game.js                 simulation (pure state + fixed-step update); knows nothing about the DOM
  render.js               Canvas 2D renderer; reads game state, never changes it
  ui.js                   DOM HUD / shop / selection panel; writes to the DOM only when values change
  main.js                 bootstrap, the single frame loop, input, camera, perf meter
  bot.js                  headless autoplayer, used for balance tuning and long-run tests
  lab.js                  Stress Lab: fixed-load harness, frame-time recorder, breaking-point ramp
scripts/bench.mjs         zero-dependency Chrome/DevTools benchmark runner
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

Canvas 2D with a world-space camera (zoom and pan) and a device-pixel-ratio-aware
backing store.

## Performance

Numbers live in [`NUMBERS.md`](NUMBERS.md). Baseline summary (Apple M5, 4× CPU throttle):
the first implementation just passes the target 5k/100/1k and **breaks at 7.5k enemies /
150 towers / 1.5k projectiles**. Drawing is the first bottleneck; the O(n²) simulation is the next.

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
- A live frame-time graph turns yellow below 45 fps and red below 30 fps.
- **Find breaking point** ramps the load from 10% to 800% of the target and plots fps per step.
  It then marks the first step that fails either criterion.

**`scripts/bench.mjs`** is the same measurement, automated and reproducible:
```bash
node server.js &
node scripts/bench.mjs --headed            # ramp in a real Chrome window
node scripts/bench.mjs --headed --cpu 4    # same, with DevTools 4× CPU throttling
node scripts/bench.mjs --headed --mode bench --load 5000,100,1000
```
- It launches Chrome with a throwaway profile, at 2× DPR, with background throttling disabled.
- It drives the Stress Lab over the DevTools protocol, prints a table, and can save JSON
  (`--out`) and a screenshot (`--shot`).
- Use `--headed`. Headless Chrome reported 60 fps at loads where the real window could not keep up.

Roadmap:

1. ✅ **Baseline (v0)** — a straightforward first implementation: object-per-entity arrays,
   `filter()` to remove dead entities, O(towers × enemies) target search, O(enemies)
   splash search, every shape drawn with its own path and fill-style change, and no
   culling. This is the "initial implementation" that the later steps are compared against.
2. ✅ **Stress harness** — the Stress Lab and `scripts/bench.mjs` described above.
   The baseline's breaking point is recorded in `NUMBERS.md`.
3. **Optimization steps**, each behind a runtime toggle so before and after can be shown
   live:
   - spatial hash grid for target and splash queries
   - struct-of-arrays / typed-array pools with swap-remove (no per-frame allocation, no GC churn)
   - batched rendering (one path per enemy type / color, sprite atlases)
   - viewport culling
   - a cached static background layer
   - possibly a WebGL instanced renderer, if Canvas 2D becomes the ceiling
4. **Measurement write-up** — a methodology section, plus `NUMBERS.md` with a
   before/after table for each optimization.
