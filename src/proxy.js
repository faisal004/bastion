// Main-thread stand-in for Game when the simulation runs in a worker.
// Exposes the same read API the renderer and UI use, fed by snapshots, and turns
// mutating calls into commands for the worker. Towers are addressed by tile (c, r),
// which stays valid while a command is in flight.
import * as C from './config.js';
import { Game } from './game.js';
import { FX_KINDS, ES, PS, FS } from './snapshot.js';

const MAX_STEPS = C.MAX_STEPS_PER_FRAME;

export class GameProxy {
  constructor(worker, initialOpts) {
    this.isProxy = true;
    this.worker = worker;
    // static map data (path, rocks, base...) is deterministic, so build it locally
    const local = new Game();
    for (const k of ['path', 'segs', 'pathLen', 'base', 'rocks', 'tufts', 'baseGrid']) this[k] = local[k];
    this.grid = new Uint8Array(local.grid);
    this.towers = []; this.effects = []; this.enemies = []; this.projectiles = []; this.messages = [];
    this.towerMap = new Array(C.COLS * C.ROWS).fill(null);
    this.fxPool = [];
    this.palette = [];
    this.gold = C.START_GOLD; this.lives = C.START_LIVES; this.score = 0; this.kills = 0; this.wave = 0;
    this.state = 'ready'; this.intermission = 0; this.waveInProgress = false; this.spawners = { length: 0 };
    this.baseHit = 0; this.stress = false; this.time = 0;
    this.ne = 0; this.np = 0; this.nf = 0; this.f = null;
    this.spare = null;      // a snapshot buffer to hand back to the worker
    this.inFlight = false;  // at most one tick outstanding: never queue work faster than the worker drains it
    this.owed = 0;          // steps requested by the frame loop but not yet sent
    this.dirty = false;     // a command was sent: fetch a fresh snapshot even when no steps are owed
    this.simMs = 0; this.packMs = 0; this.lastSteps = 0;
    // benchmark-only: emulate a slower CPU in the worker (DevTools cannot throttle workers)
    this.cpu = Math.max(1, Number(new URLSearchParams(location.search).get('workercpu')) || 1);
    worker.onmessage = (ev) => this.onSnapshot(ev.data);
    this.setOpts(initialOpts);
    this.post({ type: 'tick', steps: 0, buf: null });
    this.inFlight = true;
  }

  post(m, transfer) { this.worker.postMessage(m, transfer || []); }
  setOpts(o) { this.post({ type: 'opts', opts: { ...o } }); }
  cmd(cmd, extra = {}) { this.post({ type: 'cmd', cmd, ...extra }); this.dirty = true; this.flush(); }

  // Called by the frame loop with the number of fixed steps it owes this frame.
  requestSteps(n) {
    this.owed = Math.min(this.owed + n, MAX_STEPS); // can't keep up: drop time instead of spiraling
    this.flush();
  }

  flush() {
    if (this.inFlight || (this.owed === 0 && !this.dirty)) return;
    const steps = this.owed;
    this.owed = 0; this.dirty = false; this.inFlight = true;
    const buf = this.spare; this.spare = null;
    this.post({ type: 'tick', steps, buf, cpu: this.cpu }, buf ? [buf] : []);
  }

  onSnapshot(s) {
    if (this.f) this.spare = this.f.buffer; // the snapshot we were drawing becomes the next spare
    this.f = s.f; this.ne = s.ne; this.np = s.np; this.nf = s.nf;
    for (const c of s.newColors) this.palette.push(c);
    this.gold = s.gold; this.lives = s.lives; this.score = s.score; this.kills = s.kills; this.wave = s.wave;
    this.state = s.state; this.intermission = s.intermission; this.waveInProgress = s.waveInProgress;
    this.spawners = { length: s.spawners }; this.baseHit = s.baseHit; this.stress = s.stress; this.time = s.time;
    this.grid = s.grid;
    this.simMs = s.simMs; this.packMs = s.packMs; this.lastSteps = s.steps;
    for (const m of s.messages) this.messages.push(m);
    this.towerMap.fill(null);
    for (const t of s.towers) { t.def = C.TOWERS[t.type]; this.towerMap[t.r * C.COLS + t.c] = t; }
    this.towers = s.towers;
    this.unpackEffects();
    this.inFlight = false;
    this.flush();
  }

  // Effects are few (hundreds to a few thousand) and drawn by the Canvas 2D effects layer,
  // which expects objects: rebuild them into pooled objects.
  unpackEffects() {
    const f = this.f, fx = this.effects, pool = this.fxPool;
    while (fx.length) pool.push(fx.pop());
    let o = this.ne * ES + this.np * PS;
    for (let i = 0; i < this.nf; i++, o += FS) {
      const e = pool.pop() || { kind: '', x: 0, y: 0, x2: 0, y2: 0, r0: 0, r1: 0, color: '', text: '', life: 0, max: 0 };
      e.kind = FX_KINDS[f[o]]; e.x = f[o + 1]; e.y = f[o + 2]; e.x2 = f[o + 3]; e.y2 = f[o + 4];
      e.r0 = f[o + 5]; e.r1 = f[o + 6]; e.color = this.palette[f[o + 7]]; e.life = f[o + 8]; e.max = f[o + 9];
      e.text = e.kind === 'text' ? '+' + f[o + 10] : '';
      fx.push(e);
    }
  }

  get enemyCount() { return this.ne; }
  get projectileCount() { return this.np; }

  // ---------- commands (optimistic where the UI needs instant feedback) ----------
  placeTower(type, c, r) {
    const def = C.TOWERS[type];
    if (!this.canPlace(c, r) || this.gold < def.cost) return null;
    this.gold -= def.cost;
    this.grid[r * C.COLS + c] = 2; // block the tile now so a double click can't place twice
    this.cmd('place', { tower: type, c, r });
    return { c, r, pending: performance.now() };
  }
  upgradeTower(t) {
    const cost = this.upgradeCost(t);
    if (cost == null || this.gold < cost) return false;
    this.gold -= cost;
    this.cmd('upgrade', { c: t.c, r: t.r });
    return true;
  }
  sellTower(t) { this.cmd('sell', { c: t.c, r: t.r }); return this.sellValue(t); }
  cycleMode(t) {
    const i = C.TARGET_MODES.indexOf(t.mode);
    t.mode = C.TARGET_MODES[(i + 1) % C.TARGET_MODES.length];
    this.cmd('mode', { c: t.c, r: t.r });
  }
  startNextWave() { if (!this.canCallWave()) return false; this.cmd('wave'); return true; }
  reset() {
    this.cmd('reset');
    this.towers = []; this.towerMap.fill(null); this.effects.length = 0; this.ne = this.np = this.nf = 0;
    this.grid = new Uint8Array(this.baseGrid);
    this.state = 'ready'; this.wave = 0; this.gold = C.START_GOLD; this.lives = C.START_LIVES;
    this.score = 0; this.kills = 0; this.stress = false;
  }
  stressLoad(cfg) { this.cmd('stress', { cfg }); this.state = 'playing'; this.stress = true; }
}

// Pure rule helpers are shared with Game, so the two can never disagree.
for (const k of ['canPlace', 'towerAt', 'stats', 'upgradeCost', 'sellValue', 'canCallWave']) {
  GameProxy.prototype[k] = Game.prototype[k];
}
