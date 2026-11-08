#!/usr/bin/env node
// Memory stability across a complete 50-wave game (bot-driven, headless).
// Prints heap used after a forced GC at the end of every 5th wave.
//   node --expose-gc scripts/check-memory.mjs [opt=alloc:filter]
import * as C from '../src/config.js';
import { Game } from '../src/game.js';
import { initOpts } from '../src/opts.js';
import { makeBot } from '../src/bot.js';

initOpts('?' + (process.argv.find((a) => a.startsWith('opt=')) || ''));
if (!global.gc) { console.error('run with: node --expose-gc scripts/check-memory.mjs'); process.exit(1); }
const mb = () => { global.gc(); return process.memoryUsage().heapUsed / 1e6; };

Math.random = C.mulberry32(3);
const g = new Game();
const think = makeBot(g);
g.startNextWave();
const rows = [];
let lastWave = 0, steps = 0, peak = 0;
const base = mb();
while (g.state === 'playing') {
  if (steps++ % 6 === 0) think();
  g.update(C.STEP);
  if (g.enemies.length > peak) peak = g.enemies.length;
  if (g.wave !== lastWave) {
    lastWave = g.wave;
    if (g.wave % 5 === 0) rows.push([g.wave, mb()]);
  }
}
rows.push(['end', mb()]);
console.log(`result: ${g.state} at wave ${g.wave}, ${g.towers.length} towers, peak ${peak} enemies on screen`);
console.log(`heap after GC: start ${base.toFixed(2)} MB → ` + rows.map(([w, m]) => `w${w} ${m.toFixed(2)}`).join(' · ') + ' MB');
