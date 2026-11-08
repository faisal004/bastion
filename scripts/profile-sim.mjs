#!/usr/bin/env node
// Per-phase simulation profile at a fixed stress load, headless (no rendering).
//   node scripts/profile-sim.mjs [enemies towers projectiles] [opt=grid:on,...]
import * as C from '../src/config.js';
import { Game } from '../src/game.js';
import { initOpts } from '../src/opts.js';

const [E = 20000, T = 400, P = 4000] = process.argv.slice(2, 5).filter((a) => !a.includes('=')).map(Number);
const optArg = process.argv.find((a) => a.startsWith('opt=')) || 'opt=grid:on';
initOpts('?baseline&' + optArg);

const g = new Game();
g.stress = true; g.state = 'playing'; g.gold = 1e9;
// same tower placement as the Stress Lab: tiles covering the most road first
const cand = [];
for (let r = 0; r < C.ROWS; r++) for (let c = 0; c < C.COLS; c++) {
  if (g.grid[r * C.COLS + c] !== 0) continue;
  let k = 0;
  for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
    const rr = r + dr, cc = c + dc;
    if (dr * dr + dc * dc <= 9 && rr >= 0 && rr < C.ROWS && cc >= 0 && cc < C.COLS && g.grid[rr * C.COLS + cc] === 1) k++;
  }
  cand.push({ c, r, k });
}
cand.sort((a, b) => b.k - a.k);
const MIX = ['blaster', 'cannon', 'frost', 'sniper', 'blaster'];
for (let i = 0, n = 0; n < T && i < cand.length; i++) { const t = g.placeTower(MIX[n % 5], cand[i].c, cand[i].r, true); if (t) { t.level = 2; n++; } }
const TYPES = ['grunt', 'grunt', 'runner', 'tank', 'swarm', 'swarm', 'flyer'];
const topUp = () => {
  for (let need = E - g.enemyCount; need > 0; need--) g.spawnEnemy(TYPES[(Math.random() * 7) | 0], C.hpScale(30), 1, 3, Math.random() * g.pathLen * 0.98);
  for (let need = P - g.projectileCount; need > 0; need--) {
    const t = g.towers[(Math.random() * g.towers.length) | 0];
    g.spawnProjectile('bullet', t.x, t.y, g.randomEnemy(), 4 * C.TILE, 2, 0, null);
  }
};

const phases = ['updateSpawners', 'updateEnemies', 'updateTowers', 'updateProjectiles', 'updateEffects', 'cleanup', 'updateWaveState'];
const acc = Object.fromEntries(phases.map((p) => [p, 0]));
let topMs = 0;
const orig = {};
for (const p of phases) {
  orig[p] = g[p].bind(g);
  g[p] = (dt) => { const t0 = performance.now(); orig[p](dt); acc[p] += performance.now() - t0; };
}
const STEPS = 300, WARM = 60;
for (let i = 0; i < STEPS + WARM; i++) {
  if (i === WARM) { for (const p of phases) acc[p] = 0; topMs = 0; }
  const t0 = performance.now(); topUp(); topMs += performance.now() - t0;
  g.update(C.STEP);
}
const total = Object.values(acc).reduce((a, b) => a + b, 0);
console.log(`${E}/${T}/${P} ${optArg} — ${(total / STEPS).toFixed(2)} ms/step (+ refill ${(topMs / STEPS).toFixed(2)} ms), effects alive: ${g.effects.length}`);
for (const p of phases) console.log(`  ${p.padEnd(18)} ${(acc[p] / STEPS).toFixed(3)} ms  ${((acc[p] / total) * 100).toFixed(0)}%`);
