# Performance numbers

All numbers come from `scripts/bench.mjs`, which drives the in-game Stress Lab in a real
(headed) Chrome window. Raw JSON for each run is in `bench/results/`.

**Machine:** Apple M5, Chrome 156, ANGLE/Metal, 1403×836 CSS px at 2× DPR, 60 Hz.
**Pass criteria** (from the brief): ≥ 45 fps for 95% of frames **and** < 5% of frames over 33 ms.
**Ramp:** all three loads scale together from 10% to 800% of the target (5,000 enemies / 100 towers /
1,000 projectiles). Each step settles for 1 s, then records 3 s of real frame times.

Two settings:
- **native** — the M5 at full speed.
- **4× CPU** — Chrome DevTools CPU throttling at 4×, the usual stand-in for a mid-range laptop.
  This is the headline setting, because the M5 hides problems a typical player would hit.

## Baseline (v0) — where the first implementation breaks

| Setting | Last passing load (E/T/P) | Breaks at (E/T/P) | At target 5k/100/1k: fps@95% · sim · draw |
|---|---|---|---|
| native | 10,000 / 200 / 2,000 | 15,000 / 300 / 3,000 | 59.5 · 0.30 ms · 2.49 ms |
| 4× CPU | 5,000 / 100 / 1,000 | **7,500 / 150 / 1,500** | 56.8 · 1.02 ms · 10.02 ms |

![v0 breaking point](docs/v0-breaking-point.png)

### Full ramp, 4× CPU
| Enemies | Towers | Projectiles | avg fps | fps @95% | >33 ms | sim ms | draw ms | |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 500 | 10 | 100 | 60.0 | 56.8 | 0.0% | 0.05 | 1.01 | pass |
| 1,000 | 20 | 200 | 60.0 | 56.8 | 0.0% | 0.07 | 1.85 | pass |
| 2,000 | 40 | 400 | 60.0 | 56.8 | 0.0% | 0.22 | 3.86 | pass |
| 3,000 | 60 | 600 | 60.0 | 57.1 | 0.0% | 0.38 | 5.83 | pass |
| 4,000 | 80 | 800 | 60.0 | 56.8 | 0.0% | 0.60 | 7.61 | pass |
| 5,000 | 100 | 1,000 | 60.0 | 56.8 | 0.0% | 1.02 | 10.02 | pass |
| 7,500 | 150 | 1,500 | 40.7 | 29.2 | 10.5% | 3.09 | 15.05 | **FAIL** |
| 10,000 | 200 | 2,000 | 29.2 | 20.0 | 43.8% | 6.25 | 19.73 | FAIL |
| 15,000 | 300 | 3,000 | 15.7 | 12.0 | 98.0% | 22.01 | 37.76 | FAIL |
| 20,000 | 400 | 4,000 | 8.5 | 6.6 | 100.0% | 64.84 | 48.73 | FAIL |

### Full ramp, native
| Enemies | Towers | Projectiles | avg fps | fps @95% | >33 ms | sim ms | draw ms | |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 5,000 | 100 | 1,000 | 60.0 | 59.5 | 0.0% | 0.30 | 2.49 | pass |
| 7,500 | 150 | 1,500 | 60.0 | 59.5 | 0.0% | 0.51 | 3.50 | pass |
| 10,000 | 200 | 2,000 | 60.0 | 59.5 | 0.0% | 0.79 | 4.78 | pass |
| 15,000 | 300 | 3,000 | 47.7 | 29.9 | 2.8% | 2.35 | 16.86 | **FAIL** |
| 20,000 | 400 | 4,000 | 33.5 | 20.0 | 14.9% | 5.58 | 21.14 | FAIL |
| 30,000 | 600 | 6,000 | 17.0 | 15.0 | 92.3% | 33.53 | 23.84 | FAIL |
| 40,000 | 600 | 8,000 | 5.7 | 4.6 | 100.0% | 117.34 | 27.69 | FAIL |

### What the baseline numbers say
- **Drawing dominates first.** At the target load, draw costs about 10× more than simulation
  (10.0 ms vs 1.0 ms at 4× CPU). Every enemy gets its own `beginPath`, fill-style change, fill,
  stroke and health bar.
- **The simulation then blows up quadratically.** From 20k to 40k enemies, sim time goes from
  5.6 ms to 117 ms: tower target search and splash are O(towers × enemies), and `filter()`
  reallocates arrays every step.
- `sim`/`draw` count only JavaScript time. GPU raster time shows up in the frame times
  instead, which is why fps can drop even when sim + draw < 16 ms.

## Optimizations

_(one row per optimization, filled in as each lands)_

| # | Optimization | Breaks at, 4× CPU (before → after) | Target load fps@95% (before → after) |
|---|---|---|---|
