#!/usr/bin/env node
// Correctness check for the spatial grid: for many random game states, every range query
// must return exactly the same set of in-range enemies as a full scan.
//   node scripts/check-grid.mjs
import * as C from '../src/config.js';
import { Game } from '../src/game.js';
import { opts } from '../src/opts.js';
import { simulate } from '../src/bot.js';

let checked = 0, mismatches = 0;
const inRange = (list, x, y, r) => {
  const out = new Set();
  for (const e of list) if (e.alive && (e.x - x) ** 2 + (e.y - y) ** 2 <= r * r) out.add(e.id);
  return out;
};

for (let trial = 0; trial < 20; trial++) {
  const g = new Game();
  g.stress = true; g.state = 'playing';
  const n = 200 + Math.floor(Math.random() * 6000);
  const types = Object.keys(C.ENEMIES);
  for (let i = 0; i < n; i++) g.spawnEnemy(types[i % types.length], 1, 1, 0, Math.random() * g.pathLen);
  // a few enemies off-map / at the edges to exercise clamping
  for (let i = 0; i < 20; i++) g.spawnEnemy('grunt', 1, 1, 0, Math.random() * 30);
  opts.grid = 'on';
  g.sgrid.build(g.enemies);
  for (let q = 0; q < 400; q++) {
    const x = Math.random() * (C.WORLD_W + 200) - 100, y = Math.random() * (C.WORLD_H + 200) - 100;
    const r = 10 + Math.random() * 9 * C.TILE;
    const n = g.candidates(x, y, r);
    const viaGrid = inRange(Array.from(g.cand.subarray(0, n), (i) => g.enemies[i]), x, y, r);
    const viaScan = inRange(g.enemies, x, y, r);
    checked++;
    if (viaGrid.size !== viaScan.size || [...viaScan].some((id) => !viaGrid.has(id))) mismatches++;
  }
}
console.log(`range queries: ${checked} checked, ${mismatches} mismatches`);

// Whole-game check with a seeded RNG. Targets can still differ when two enemies tie on score
// (e.g. equal HP in 'strongest' mode), because the grid visits enemies in a different order.
const realRandom = Math.random;
for (const mode of ['off', 'on']) {
  opts.grid = mode;
  Math.random = C.mulberry32(7); // same lane offsets in both runs
  const t0 = performance.now();
  const r = simulate(Game, ['blaster', 'blaster', 'cannon', 'frost', 'sniper', 'cannon', 'blaster', 'sniper']);
  Math.random = realRandom;
  console.log(`full game, grid ${mode}: ${r.state} at wave ${r.wave}, lives ${r.lives}, kills ${r.kills} (${Math.round(performance.now() - t0)} ms)`);
}
process.exit(mismatches ? 1 : 0);
