// Simulation. Pure state + fixed-step update. No DOM, no canvas.
// v0 baseline: object-per-entity arrays, linear scans, filter() cleanup.
import * as C from './config.js';
import { opts } from './opts.js';
import { SpatialGrid } from './grid.js';

const { TILE, COLS, ROWS } = C;
const GRID_CELL = TILE * 2; // ~ the smallest tower range diameter / 3; tuned in NUMBERS.md

function compact(list, pool, isEffect) {
  let w = 0;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (isEffect ? o.life > 0 : o.alive) list[w++] = o;
    else pool.push(o);
  }
  list.length = w;
}

export class Game {
  constructor() {
    this.sgrid = new SpatialGrid(C.WORLD_W, C.WORLD_H, GRID_CELL);
    this.cand = new Int32Array(4096);
    this.buildMap();
    this.reset();
  }

  buildMap() {
    const pts = C.PATH_POINTS.map(([c, r]) => ({ x: (c + 0.5) * TILE, y: (r + 0.5) * TILE }));
    this.path = pts;
    this.segs = [];
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      this.segs.push({ ax: a.x, ay: a.y, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len, len, start: acc });
      acc += len;
    }
    this.pathLen = acc;

    // 0 = buildable, 1 = road, 3 = blocked (base / rocks)
    const g = new Uint8Array(COLS * ROWS);
    for (let i = 0; i < C.PATH_POINTS.length - 1; i++) {
      const [c0, r0] = C.PATH_POINTS[i], [c1, r1] = C.PATH_POINTS[i + 1];
      const sc = Math.sign(c1 - c0), sr = Math.sign(r1 - r0);
      let c = c0, r = r0;
      for (;;) {
        if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g[r * COLS + c] = 1;
        if (c === c1 && r === r1) break;
        c += sc; r += sr;
      }
    }
    const [bc, br] = C.PATH_POINTS[C.PATH_POINTS.length - 1];
    this.base = { x: (bc + 0.5) * TILE, y: (br + 0.5) * TILE, col: bc, row: br };
    for (let r = br - 1; r <= br + 1; r++) for (let c = bc - 1; c <= bc + 1; c++) {
      if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g[r * COLS + c] = 3;
    }
    // Decorations: blocking rocks + non-blocking grass tufts.
    const rnd = C.mulberry32(1337);
    this.rocks = [];
    this.tufts = [];
    for (let i = 0; i < 400 && this.rocks.length < 26; i++) {
      const c = (rnd() * COLS) | 0, r = (rnd() * ROWS) | 0;
      if (g[r * COLS + c] !== 0) continue;
      // keep rocks away from the road so the map stays generous
      let nearRoad = false;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && g[rr * COLS + cc] === 1) nearRoad = true;
      }
      if (nearRoad) continue;
      g[r * COLS + c] = 3;
      this.rocks.push({ c, r, s: 0.55 + rnd() * 0.3, rot: rnd() * Math.PI });
    }
    for (let i = 0; i < 260; i++) {
      const c = (rnd() * COLS) | 0, r = (rnd() * ROWS) | 0;
      if (g[r * COLS + c] !== 0) continue;
      this.tufts.push({ x: (c + rnd()) * TILE, y: (r + rnd()) * TILE, s: 2 + rnd() * 3, v: rnd() });
    }
    this.baseGrid = g;
  }

  reset() {
    this.time = 0;
    this.gold = C.START_GOLD;
    this.lives = C.START_LIVES;
    this.score = 0;
    this.kills = 0;
    this.wave = 0;
    this.state = 'ready'; // ready | playing | won | lost
    this.waveInProgress = false;
    this.intermission = 0;
    this.enemies = [];
    this.towers = [];
    this.projectiles = [];
    this.effects = [];
    this.spawners = [];
    this.messages = [];
    this.soundEvents = new Set();
    this.grid = new Uint8Array(this.baseGrid);
    this.towerMap = new Array(COLS * ROWS).fill(null);
    this.nextId = 1;
    this.baseHit = 0;
    this.stress = false; // set by the stress lab: enemies loop the road and never cost lives
    // free lists used when opts.alloc === 'pooled'
    this.enemyPool = [];
    this.projectilePool = [];
    this.fxPool = [];
    this.tmp = { x: 0, y: 0, dx: 0, dy: 0, seg: 0 };
  }

  sound(kind) { if (!this.stress) this.soundEvents.add(kind); }

  // ---------- path ----------
  samplePath(d, out) {
    const segs = this.segs;
    let i = 0;
    while (i < segs.length - 1 && d >= segs[i].start + segs[i].len) i++;
    const s = segs[i];
    out.seg = i;
    const t = d - s.start;
    out.x = s.ax + s.dx * t;
    out.y = s.ay + s.dy * t;
    out.dx = s.dx;
    out.dy = s.dy;
    return out;
  }

  // ---------- waves ----------
  canCallWave() {
    if (this.state === 'ready') return true;
    return this.state === 'playing' && this.spawners.length === 0 && this.wave < C.MAX_WAVE;
  }

  startNextWave() {
    if (!this.canCallWave()) return false;
    if (this.state === 'playing' && this.wave > 0) {
      // calling early pays: remaining countdown, or a flat bonus if enemies are still on the road
      const bonus = this.waveInProgress ? 10 + this.wave : Math.floor(this.intermission * 2);
      if (bonus > 0) {
        this.gold += bonus;
        this.messages.push({ text: `Early call +${bonus}g`, kind: 'gold' });
      }
    }
    this.state = 'playing';
    this.wave++;
    this.sound(this.wave % 10 === 0 ? 'boss' : 'wave');
    this.intermission = 0;
    this.waveInProgress = true;
    const w = this.wave;
    for (const grp of C.buildWave(w)) {
      this.spawners.push({
        type: grp.type, remaining: grp.count, interval: grp.interval, timer: grp.delay,
        hpMul: C.hpScale(w), rewardMul: C.rewardScale(w), armor: C.armorBonus(w),
      });
    }
    if (w % 10 === 0) this.messages.push({ text: `Wave ${w} — the Warlord approaches!`, kind: 'boss' });
    else this.messages.push({ text: `Wave ${w}`, kind: 'wave' });
    return true;
  }

  spawnEnemy(type, hpMul = 1, rewardMul = 1, armorBonus = 0, dist = 0) {
    const def = C.ENEMIES[type];
    const hp = Math.round(def.hp * hpMul);
    const pooled = opts.alloc === 'pooled' && this.enemyPool.length > 0;
    // every enemy object has exactly this shape, so recycled objects keep one hidden class
    const e = pooled ? this.enemyPool.pop() : {
      id: 0, type: '', def: null, x: 0, y: 0, px: 0, py: 0, dirX: 1, dirY: 0, ox: 0, oy: 0,
      dist: 0, seg: 0, offset: 0, hp: 0, maxHp: 0, speed: 0, armor: 0, reward: 0,
      slow: 0, slowT: 0, hitT: 0, alive: true,
    };
    e.id = this.nextId++; e.type = type; e.def = def;
    e.dist = dist;
    e.offset = (Math.random() - 0.5) * TILE * 0.45;
    e.hp = hp; e.maxHp = hp;
    e.speed = def.speed * TILE;
    e.armor = def.armor + (def.armor > 0 ? armorBonus : 0);
    e.reward = Math.round(def.reward * rewardMul);
    e.slow = 0; e.slowT = 0; e.hitT = 0;
    e.alive = true;
    const p = this.samplePath(dist, this.tmp);
    e.seg = p.seg;
    e.ox = -p.dy * e.offset; e.oy = p.dx * e.offset;
    e.x = e.px = p.x + e.ox;
    e.y = e.py = p.y + e.oy;
    e.dirX = p.dx; e.dirY = p.dy;
    this.enemies.push(e);
    return e;
  }

  spawnProjectile(kind, x, y, target, speed, dmg, splash, tower) {
    const p = opts.alloc === 'pooled' && this.projectilePool.length > 0 ? this.projectilePool.pop() : {
      kind: '', x: 0, y: 0, px: 0, py: 0, target: null, targetId: 0, tx: 0, ty: 0,
      speed: 0, dmg: 0, splash: 0, tower: null, alive: true,
    };
    p.kind = kind; p.x = p.px = x; p.y = p.py = y;
    // targetId guards against enemy objects being recycled while this shot is in flight
    p.target = target; p.targetId = target.id; p.tx = target.x; p.ty = target.y;
    p.speed = speed; p.dmg = dmg; p.splash = splash; p.tower = tower; p.alive = true;
    this.projectiles.push(p);
  }

  // Effects share one object shape: ring (r0 -> r1), pop (r0), tracer (x,y -> x2,y2), text.
  fx(kind, x, y, r0, r1, color, life, x2 = 0, y2 = 0, text = '') {
    const f = opts.alloc === 'pooled' && this.fxPool.length > 0 ? this.fxPool.pop() : {
      kind: '', x: 0, y: 0, x2: 0, y2: 0, r0: 0, r1: 0, color: '', text: '', life: 0, max: 0,
    };
    f.kind = kind; f.x = x; f.y = y; f.x2 = x2; f.y2 = y2; f.r0 = r0; f.r1 = r1;
    f.color = color; f.text = text; f.life = life; f.max = life;
    this.effects.push(f);
    return f;
  }

  get enemyCount() { return this.enemies.length; }
  get projectileCount() { return this.projectiles.length; }
  randomEnemy() { return this.enemies[(Math.random() * this.enemies.length) | 0]; }

  // ---------- towers ----------
  canPlace(c, r) {
    return c >= 0 && c < COLS && r >= 0 && r < ROWS && this.grid[r * COLS + c] === 0;
  }

  towerAt(c, r) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
    return this.towerMap[r * COLS + c];
  }

  placeTower(type, c, r, free = false) {
    const def = C.TOWERS[type];
    if (!this.canPlace(c, r)) return null;
    if (!free && this.gold < def.cost) return null;
    if (!free) this.gold -= def.cost;
    const t = {
      id: this.nextId++, type, def, c, r,
      x: (c + 0.5) * TILE, y: (r + 0.5) * TILE,
      level: 0, cooldown: 0.2, angle: -Math.PI / 2,
      mode: def.defaultMode || 'first',
      invested: free ? 0 : def.cost, kills: 0, damage: 0, flash: 0,
    };
    this.towers.push(t);
    this.grid[r * COLS + c] = 2;
    this.towerMap[r * COLS + c] = t;
    this.fx('ring', t.x, t.y, 6, 28, def.color, 0.35);
    if (!free) this.sound('build');
    return t;
  }

  upgradeCost(t) {
    const next = t.def.levels[t.level + 1];
    return next ? next.cost : null;
  }

  upgradeTower(t) {
    const cost = this.upgradeCost(t);
    if (cost == null || this.gold < cost) return false;
    this.gold -= cost;
    t.invested += cost;
    t.level++;
    this.sound('upgrade');
    this.fx('ring', t.x, t.y, 8, 40, '#faf089', 0.45);
    return true;
  }

  sellValue(t) { return Math.floor(t.invested * C.SELL_REFUND); }

  sellTower(t) {
    const v = this.sellValue(t);
    this.gold += v;
    this.sound('sell');
    this.towers = this.towers.filter((x) => x !== t);
    this.grid[t.r * COLS + t.c] = 0;
    this.towerMap[t.r * COLS + t.c] = null;
    this.fx('text', t.x, t.y - 10, 0, 0, '#f6e05e', 0.9, 0, 0, `+${v}`);
    return v;
  }

  cycleMode(t) {
    const i = C.TARGET_MODES.indexOf(t.mode);
    t.mode = C.TARGET_MODES[(i + 1) % C.TARGET_MODES.length];
  }

  stats(t) { return t.def.levels[t.level]; }

  // Indices of enemies that might be within `r` of (x, y), written into this.cand (a reused
  // Int32Array). Returns the count, or -1 meaning "every enemy" (grid off).
  // Callers still do the exact distance check.
  candidates(x, y, r) {
    if (opts.grid !== 'on') return -1;
    const g = this.sgrid, start = g.start, items = g.items;
    g.rect(x, y, r);
    let n = 0, cand = this.cand;
    for (let row = g.r0; row <= g.r1; row++) {
      const base = row * g.cols;
      const k0 = start[base + g.c0], k1 = start[base + g.c1 + 1]; // a row's cells are contiguous in items
      if (n + (k1 - k0) > cand.length) {
        const bigger = new Int32Array(Math.max(cand.length * 2, n + (k1 - k0)));
        bigger.set(cand.subarray(0, n));
        this.cand = cand = bigger;
      }
      for (let k = k0; k < k1; k++) cand[n++] = items[k];
    }
    return n;
  }

  findTarget(t, range) {
    const r2 = range * range;
    const groundOnly = t.def.groundOnly;
    let best = null, bestScore = -Infinity;
    const enemies = this.enemies;
    const n = this.candidates(t.x, t.y, range), all = n < 0, cnt = all ? enemies.length : n, cand = this.cand;
    for (let i = 0; i < cnt; i++) {
      const e = enemies[all ? i : cand[i]];
      if (!e.alive || (groundOnly && e.def.flying)) continue;
      const dx = e.x - t.x, dy = e.y - t.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      let score;
      switch (t.mode) {
        case 'first': score = e.dist; break;
        case 'last': score = -e.dist; break;
        case 'strong': score = e.hp; break;
        default: score = -d2;
      }
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  damage(e, amount, pierce, tower) {
    if (!e.alive) return;
    const dealt = Math.max(1, amount - (pierce ? 0 : e.armor));
    e.hp -= dealt;
    e.hitT = 0.08;
    if (tower) tower.damage += Math.min(dealt, e.hp + dealt);
    if (e.hp <= 0) {
      e.alive = false;
      this.gold += e.reward;
      this.score += e.reward * 10;
      this.kills++;
      if (tower) tower.kills++;
      this.fx('pop', e.x, e.y, e.def.radius * TILE, 0, e.def.color, 0.3);
      if (e.reward >= 10) {
        this.fx('text', e.x, e.y - 8, 0, 0, '#f6e05e', 0.8, 0, 0, `+${e.reward}`);
      }
    }
  }

  // ---------- update ----------
  update(dt) {
    if (this.state !== 'playing') return;
    this.time += dt;
    this.updateSpawners(dt);
    this.updateEnemies(dt);
    this.updateTowers(dt);
    this.updateProjectiles(dt);
    this.updateEffects(dt);
    this.cleanup();
    this.updateWaveState(dt);
  }

  updateSpawners(dt) {
    for (const s of this.spawners) {
      s.timer -= dt;
      while (s.timer <= 0 && s.remaining > 0) {
        this.spawnEnemy(s.type, s.hpMul, s.rewardMul, s.armor);
        s.remaining--;
        s.timer += s.interval;
      }
    }
    this.spawners = this.spawners.filter((s) => s.remaining > 0);
  }

  updateEnemies(dt) {
    const tmp = this.tmp;
    const cached = opts.path === 'cached';
    const segs = this.segs, lastSeg = segs.length - 1;
    const k = Math.min(1, dt * 10);
    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      e.px = e.x; e.py = e.y;
      if (e.slowT > 0) { e.slowT -= dt; if (e.slowT <= 0) e.slow = 0; }
      if (e.hitT > 0) e.hitT -= dt;
      e.dist += e.speed * (1 - e.slow) * dt;
      if (this.stress && e.dist >= this.pathLen) e.dist -= this.pathLen; // stress: loop, no life loss
      if (e.dist >= this.pathLen) {
        e.alive = false;
        this.lives -= e.def.lifeDmg;
        this.baseHit = 0.4;
        this.sound('base');
        this.fx('ring', this.base.x, this.base.y, 20, 60, '#fc8181', 0.4);
        if (this.lives <= 0) {
          this.lives = 0;
          this.state = 'lost';
          this.sound('lost');
          this.messages.push({ text: 'The fortress has fallen', kind: 'boss' });
        }
        continue;
      }
      if (cached) {
        // enemies only move forward, so advance from the remembered segment: O(1) amortized
        let si = e.seg;
        if (e.dist < segs[si].start) si = 0; // looped back to the start (stress mode)
        while (si < lastSeg && e.dist >= segs[si].start + segs[si].len) si++;
        e.seg = si;
        const sg = segs[si], t = e.dist - sg.start;
        tmp.x = sg.ax + sg.dx * t; tmp.y = sg.ay + sg.dy * t; tmp.dx = sg.dx; tmp.dy = sg.dy;
      } else {
        this.samplePath(e.dist, tmp);
      }
      // smooth the lateral offset so lanes don't snap at corners
      e.ox += (-tmp.dy * e.offset - e.ox) * k;
      e.oy += (tmp.dx * e.offset - e.oy) * k;
      e.x = tmp.x + e.ox;
      e.y = tmp.y + e.oy;
      e.dirX = tmp.dx; e.dirY = tmp.dy;
    }
  }

  updateTowers(dt) {
    if (opts.grid === 'on') this.sgrid.build(this.enemies); // enemies have moved: re-bucket (O(n), no allocation)
    const towers = this.towers;
    for (let ti = 0; ti < towers.length; ti++) {
      const t = towers[ti];
      if (t.flash > 0) t.flash -= dt;
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const st = this.stats(t);
      const range = st.range * TILE;
      const fire = t.def.fire;

      if (fire === 'pulse') {
        const r2 = range * range;
        let hit = false;
        const enemies = this.enemies;
        const n = this.candidates(t.x, t.y, range), all = n < 0, cnt = all ? enemies.length : n, cand = this.cand;
        for (let i = 0; i < cnt; i++) {
          const e = enemies[all ? i : cand[i]];
          if (!e.alive) continue;
          const dx = e.x - t.x, dy = e.y - t.y;
          if (dx * dx + dy * dy > r2) continue;
          hit = true;
          const slow = st.slow * (1 - (e.def.slowResist || 0));
          if (slow >= e.slow) { e.slow = slow; e.slowT = st.slowDur; }
          this.damage(e, st.dmg, false, t);
        }
        if (hit) {
          t.cooldown = 1 / st.rate;
          t.flash = 0.25;
          this.sound(t.type);
          this.fx('ring', t.x, t.y, 10, range, '#bee3f8', 0.45);
        }
        continue;
      }

      const target = this.findTarget(t, range);
      if (!target) continue;
      t.angle = Math.atan2(target.y - t.y, target.x - t.x);
      t.cooldown = 1 / st.rate;
      t.flash = 0.06;
      this.sound(t.type);
      const mx = t.x + Math.cos(t.angle) * 16, my = t.y + Math.sin(t.angle) * 16;

      if (fire === 'rail') {
        this.damage(target, st.dmg, true, t);
        this.fx('tracer', mx, my, 0, 0, t.def.color, 0.18, target.x, target.y);
      } else {
        this.spawnProjectile(fire, mx, my, target, st.pspeed * TILE, st.dmg, (st.splash || 0) * TILE, t);
      }
    }
  }

  updateProjectiles(dt) {
    const projectiles = this.projectiles;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (!p.alive) continue;
      p.px = p.x; p.py = p.y;
      const live = p.target !== null && p.target.alive && p.target.id === p.targetId;
      if (live) { p.tx = p.target.x; p.ty = p.target.y; }
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const step = p.speed * dt;
      if (d <= step) {
        p.x = p.tx; p.y = p.ty;
        p.alive = false;
        if (p.kind === 'shell') this.explode(p);
        else if (live) this.damage(p.target, p.dmg, false, p.tower);
      } else {
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
      }
    }
  }

  explode(p) {
    this.sound('impact');
    const r2 = p.splash * p.splash;
    const enemies = this.enemies;
    const n = this.candidates(p.x, p.y, p.splash), all = n < 0, cnt = all ? enemies.length : n, cand = this.cand;
    for (let i = 0; i < cnt; i++) {
      const e = enemies[all ? i : cand[i]];
      if (!e.alive || e.def.flying) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      if (dx * dx + dy * dy <= r2) this.damage(e, p.dmg, false, p.tower);
    }
    this.fx('ring', p.x, p.y, 4, p.splash, '#fbd38d', 0.3);
  }

  updateEffects(dt) {
    const effects = this.effects;
    for (let i = 0; i < effects.length; i++) effects[i].life -= dt;
    if (this.baseHit > 0) this.baseHit -= dt;
  }

  cleanup() {
    if (opts.alloc === 'pooled') {
      // compact in place (order kept), recycling the dead: no new arrays, no garbage
      compact(this.enemies, this.enemyPool, false);
      compact(this.projectiles, this.projectilePool, false);
      compact(this.effects, this.fxPool, true);
      return;
    }
    this.enemies = this.enemies.filter((e) => e.alive);
    this.projectiles = this.projectiles.filter((p) => p.alive);
    this.effects = this.effects.filter((f) => f.life > 0);
  }

  updateWaveState(dt) {
    if (this.state !== 'playing') return;
    if (this.waveInProgress && this.spawners.length === 0 && this.enemies.length === 0) {
      this.waveInProgress = false;
      const bonus = C.waveClearBonus(this.wave);
      this.gold += bonus;
      this.score += this.wave * 100;
      if (this.wave >= C.MAX_WAVE) {
        this.state = 'won';
        this.sound('won');
        this.score += this.lives * 250;
        this.messages.push({ text: 'Victory!', kind: 'wave' });
      } else {
        this.intermission = C.INTERMISSION;
        this.sound('clear');
        this.messages.push({ text: `Wave ${this.wave} cleared  +${bonus}g`, kind: 'gold' });
      }
    } else if (!this.waveInProgress && this.intermission > 0) {
      this.intermission -= dt;
      if (this.intermission <= 0) { this.intermission = 0; this.startNextWave(); }
    }
  }
}
