// Simulation. Pure state + fixed-step update. No DOM, no canvas.
// v0 baseline: object-per-entity arrays, linear scans, filter() cleanup.
import * as C from './config.js';

const { TILE, COLS, ROWS } = C;

export class Game {
  constructor() {
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
    this.grid = new Uint8Array(this.baseGrid);
    this.towerMap = new Array(COLS * ROWS).fill(null);
    this.nextId = 1;
    this.baseHit = 0;
  }

  // ---------- path ----------
  samplePath(d, out) {
    const segs = this.segs;
    let s = segs[segs.length - 1];
    for (let i = 0; i < segs.length; i++) {
      if (d < segs[i].start + segs[i].len) { s = segs[i]; break; }
    }
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
    const e = {
      id: this.nextId++, type, def,
      x: 0, y: 0, px: 0, py: 0, dirX: 1, dirY: 0,
      ox: 0, oy: 0,
      dist,
      offset: (Math.random() - 0.5) * TILE * 0.45,
      hp, maxHp: hp,
      speed: def.speed * TILE,
      armor: def.armor + (def.armor > 0 ? armorBonus : 0),
      reward: Math.round(def.reward * rewardMul),
      slow: 0, slowT: 0, hitT: 0,
      alive: true,
    };
    const p = this.samplePath(dist, {});
    e.ox = -p.dy * e.offset; e.oy = p.dx * e.offset;
    e.x = e.px = p.x + e.ox;
    e.y = e.py = p.y + e.oy;
    e.dirX = p.dx; e.dirY = p.dy;
    this.enemies.push(e);
    return e;
  }

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
    this.effects.push({ kind: 'ring', x: t.x, y: t.y, r0: 6, r1: 28, life: 0.35, max: 0.35, color: def.color });
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
    this.effects.push({ kind: 'ring', x: t.x, y: t.y, r0: 8, r1: 40, life: 0.45, max: 0.45, color: '#faf089' });
    return true;
  }

  sellValue(t) { return Math.floor(t.invested * C.SELL_REFUND); }

  sellTower(t) {
    const v = this.sellValue(t);
    this.gold += v;
    this.towers = this.towers.filter((x) => x !== t);
    this.grid[t.r * COLS + t.c] = 0;
    this.towerMap[t.r * COLS + t.c] = null;
    this.effects.push({ kind: 'text', x: t.x, y: t.y - 10, text: `+${v}`, color: '#f6e05e', life: 0.9, max: 0.9 });
    return v;
  }

  cycleMode(t) {
    const i = C.TARGET_MODES.indexOf(t.mode);
    t.mode = C.TARGET_MODES[(i + 1) % C.TARGET_MODES.length];
  }

  stats(t) { return t.def.levels[t.level]; }

  findTarget(t, range) {
    const r2 = range * range;
    const groundOnly = t.def.groundOnly;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
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
      this.effects.push({ kind: 'pop', x: e.x, y: e.y, r: e.def.radius * TILE, color: e.def.color, life: 0.3, max: 0.3 });
      if (e.reward >= 10) {
        this.effects.push({ kind: 'text', x: e.x, y: e.y - 8, text: `+${e.reward}`, color: '#f6e05e', life: 0.8, max: 0.8 });
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
    const tmp = {};
    const k = Math.min(1, dt * 10);
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.px = e.x; e.py = e.y;
      if (e.slowT > 0) { e.slowT -= dt; if (e.slowT <= 0) e.slow = 0; }
      if (e.hitT > 0) e.hitT -= dt;
      e.dist += e.speed * (1 - e.slow) * dt;
      if (e.dist >= this.pathLen) {
        e.alive = false;
        this.lives -= e.def.lifeDmg;
        this.baseHit = 0.4;
        this.effects.push({ kind: 'ring', x: this.base.x, y: this.base.y, r0: 20, r1: 60, life: 0.4, max: 0.4, color: '#fc8181' });
        if (this.lives <= 0) {
          this.lives = 0;
          this.state = 'lost';
          this.messages.push({ text: 'The fortress has fallen', kind: 'boss' });
        }
        continue;
      }
      this.samplePath(e.dist, tmp);
      // smooth the lateral offset so lanes don't snap at corners
      e.ox += (-tmp.dy * e.offset - e.ox) * k;
      e.oy += (tmp.dx * e.offset - e.oy) * k;
      e.x = tmp.x + e.ox;
      e.y = tmp.y + e.oy;
      e.dirX = tmp.dx; e.dirY = tmp.dy;
    }
  }

  updateTowers(dt) {
    for (const t of this.towers) {
      if (t.flash > 0) t.flash -= dt;
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const st = this.stats(t);
      const range = st.range * TILE;
      const fire = t.def.fire;

      if (fire === 'pulse') {
        const r2 = range * range;
        let hit = false;
        for (const e of this.enemies) {
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
          this.effects.push({ kind: 'ring', x: t.x, y: t.y, r0: 10, r1: range, life: 0.45, max: 0.45, color: '#bee3f8' });
        }
        continue;
      }

      const target = this.findTarget(t, range);
      if (!target) continue;
      t.angle = Math.atan2(target.y - t.y, target.x - t.x);
      t.cooldown = 1 / st.rate;
      t.flash = 0.06;
      const mx = t.x + Math.cos(t.angle) * 16, my = t.y + Math.sin(t.angle) * 16;

      if (fire === 'rail') {
        this.damage(target, st.dmg, true, t);
        this.effects.push({ kind: 'tracer', x1: mx, y1: my, x2: target.x, y2: target.y, color: t.def.color, life: 0.18, max: 0.18 });
      } else {
        this.projectiles.push({
          kind: fire, x: mx, y: my, px: mx, py: my,
          target, tx: target.x, ty: target.y,
          speed: st.pspeed * TILE, dmg: st.dmg,
          splash: (st.splash || 0) * TILE, tower: t, alive: true,
        });
      }
    }
  }

  updateProjectiles(dt) {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.px = p.x; p.py = p.y;
      if (p.target && p.target.alive) { p.tx = p.target.x; p.ty = p.target.y; }
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (d <= step) {
        p.x = p.tx; p.y = p.ty;
        p.alive = false;
        if (p.kind === 'shell') this.explode(p);
        else if (p.target && p.target.alive) this.damage(p.target, p.dmg, false, p.tower);
      } else {
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
      }
    }
  }

  explode(p) {
    const r2 = p.splash * p.splash;
    for (const e of this.enemies) {
      if (!e.alive || e.def.flying) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      if (dx * dx + dy * dy <= r2) this.damage(e, p.dmg, false, p.tower);
    }
    this.effects.push({ kind: 'ring', x: p.x, y: p.y, r0: 4, r1: p.splash, life: 0.3, max: 0.3, color: '#fbd38d' });
  }

  updateEffects(dt) {
    for (const f of this.effects) f.life -= dt;
    if (this.baseHit > 0) this.baseHit -= dt;
  }

  cleanup() {
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
        this.score += this.lives * 250;
        this.messages.push({ text: 'Victory!', kind: 'wave' });
      } else {
        this.intermission = C.INTERMISSION;
        this.messages.push({ text: `Wave ${this.wave} cleared  +${bonus}g`, kind: 'gold' });
      }
    } else if (!this.waveInProgress && this.intermission > 0) {
      this.intermission -= dt;
      if (this.intermission <= 0) { this.intermission = 0; this.startNextWave(); }
    }
  }
}
