// Simulation worker: owns the authoritative Game and runs fixed steps on request, so the
// simulation runs in parallel with the main thread's rendering instead of before it.
//
// Protocol (main -> worker):
//   { type: 'opts', opts }                      switch values (grid/path/alloc)
//   { type: 'cmd', cmd, ... }                   player/lab actions, applied before the next tick
//   { type: 'tick', steps, buf }                run `steps` fixed steps, reply with a snapshot;
//                                               `buf` is the previous snapshot buffer handed back
// worker -> main: snapshot (see snapshot.js), with its Float32Array buffer transferred.
import * as C from './config.js';
import { Game } from './game.js';
import { opts } from './opts.js';
import { stressSetup, stressTopUp } from './stress.js';
import { writeSnapshot } from './snapshot.js';

const game = new Game();
let stressCfg = null;
const palette = { list: [], index: new Map() };

const towerAt = (m) => game.towerAt(m.c, m.r);

function command(m) {
  switch (m.cmd) {
    case 'place': game.placeTower(m.tower, m.c, m.r); break;
    case 'upgrade': { const t = towerAt(m); if (t) game.upgradeTower(t); break; }
    case 'sell': { const t = towerAt(m); if (t) game.sellTower(t); break; }
    case 'mode': { const t = towerAt(m); if (t) game.cycleMode(t); break; }
    case 'wave': game.startNextWave(); break;
    case 'unlimitedGold': game.enableUnlimitedGold(); break;
    case 'reset': stressCfg = null; game.reset(); break;
    case 'stress': stressCfg = m.cfg; stressSetup(game, stressCfg); break;
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'opts') { Object.assign(opts, m.opts); return; }
  if (m.type === 'cmd') { command(m); return; }
  if (m.type === 'tick') {
    const t0 = performance.now();
    if (stressCfg && m.steps > 0) stressTopUp(game, stressCfg);
    for (let i = 0; i < m.steps; i++) game.update(C.STEP);
    const t1 = performance.now();
    const snap = writeSnapshot(game, m.buf, palette);
    const t2 = performance.now();
    // Benchmark-only CPU emulation (?workercpu=N): DevTools CPU throttling is not supported for
    // workers, so emulate an N-times slower core here by keeping this thread busy for (N-1) x the
    // measured work. Off (N = 1) in normal play.
    if (m.cpu > 1) { const until = t2 + (t2 - t0) * (m.cpu - 1); while (performance.now() < until) { /* busy */ } }
    snap.simMs = (t1 - t0) * (m.cpu || 1);
    snap.packMs = (t2 - t1) * (m.cpu || 1);
    snap.steps = m.steps;
    self.postMessage(snap, [snap.f.buffer]);
  }
};
