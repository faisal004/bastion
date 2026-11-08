#!/usr/bin/env node
// Lockstep equivalence check: two games with identical random seeds, one with the original
// settings and one with optimized `path` + `alloc`, must stay bit-identical every step.
// (The grid is held equal in both: it is checked separately by check-grid.mjs.)
//   node scripts/check-sim.mjs
import * as C from '../src/config.js';
import { Game } from '../src/game.js';
import { opts } from '../src/opts.js';
import { makeBot } from '../src/bot.js';

const A = { grid: 'on', path: 'scan', alloc: 'filter' };
const B = { grid: 'on', path: 'cached', alloc: 'pooled' };

function lockstep(label, setup, steps) {
  const rngA = C.mulberry32(42), rngB = C.mulberry32(42);
  const realRandom = Math.random;
  const run = (game, cfg, rng, fn) => { Object.assign(opts, cfg); Math.random = rng; try { return fn(game); } finally { Math.random = realRandom; } };
  const ga = run(new Game(), A, rngA, (g) => g), gb = run(new Game(), B, rngB, (g) => g);
  const ta = run(ga, A, rngA, setup), tb = run(gb, B, rngB, setup);
  const hash = (g) => {
    let h = `${g.state}|${g.wave}|${g.lives}|${g.gold}|${g.kills}|${g.enemies.length}|${g.projectiles.length}|${g.effects.length}`;
    for (const e of g.enemies) h += `|${e.id}:${e.x}:${e.y}:${e.hp}:${e.slow}`;
    for (const p of g.projectiles) h += `|${p.x}:${p.y}`;
    return h;
  };
  for (let i = 0; i < steps; i++) {
    run(ga, A, rngA, (g) => { ta && ta(g); g.update(C.STEP); });
    run(gb, B, rngB, (g) => { tb && tb(g); g.update(C.STEP); });
    if (hash(ga) !== hash(gb)) {
      console.log(`${label}: DIVERGED at step ${i}`);
      return false;
    }
    if (ga.state !== 'playing') break;
  }
  console.log(`${label}: identical for ${steps} steps (wave ${ga.wave}, ${ga.kills} kills, pool sizes e/p/fx ${gb.enemyPool.length}/${gb.projectilePool.length}/${gb.fxPool.length})`);
  return true;
}

let ok = true;
// 1) a real game driven by the bot, first ~25 minutes of game time
ok &= lockstep('bot game', (g) => { const think = makeBot(g); g.startNextWave(); let n = 0; return () => { if (n++ % 6 === 0) think(); }; }, 60 * 60 * 25);
// 2) a stress setup: 3,000 looping enemies, constant churn
ok &= lockstep('stress loop', (g) => {
  g.stress = true; g.state = 'playing';
  const types = ['grunt', 'runner', 'tank', 'swarm', 'flyer'];
  for (let i = 0; i < 40; i++) g.placeTower(['blaster', 'cannon', 'frost', 'sniper'][i % 4], 2 + (i % 18) * 2, i < 20 ? 5 : 9, true);
  return () => {
    while (g.enemies.length < 3000) g.spawnEnemy(types[(Math.random() * 5) | 0], 3, 1, 0, Math.random() * g.pathLen);
  };
}, 60 * 30);
process.exit(ok ? 0 : 1);
