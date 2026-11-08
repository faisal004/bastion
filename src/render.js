// Canvas 2D renderer. Reads game state, never mutates it.
// v0 baseline: background redrawn per tile every frame, each entity drawn
// with its own path + fillStyle change, no culling.
import * as C from './config.js';
import { opts } from './opts.js';
import { addShape, dirIndex, paintEnemy, spriteHalf } from './shapes.js';
import { GLRenderer } from './glrender.js';

const { TILE, COLS, ROWS, WORLD_W, WORLD_H } = C;
const TAU = Math.PI * 2;
// Batched draw order = layer order: small ground units at the bottom, flyers on top.
const ENEMY_TYPES = ['swarm', 'runner', 'grunt', 'tank', 'boss', 'flyer'];
const BAR_COLORS = ['#68d391', '#f6e05e', '#fc8181'];

// Layers (bottom to top): #game 2D (ground, base, towers [+ everything in 2D modes]),
// #gl WebGL2 (entities, webgl mode only), #fx 2D (effects + world overlay, webgl mode only).
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.w = 0; this.h = 0; this.dpr = 1;
    this.t = 0;
    const layer = (id) => {
      const c = document.createElement('canvas');
      c.id = id;
      c.className = 'layer';
      canvas.after(c);
      return c;
    };
    this.fxCanvas = layer('fx');
    this.glCanvas = layer('gl'); // inserted right after #game, so it sits below #fx
    this.fx = this.fxCanvas.getContext('2d');
    this.glr = new GLRenderer(this.glCanvas);
    this.layersDirty = false;
    // cumulative per-phase JS draw time; read and reset by the profiler (bench.mjs --mode phases)
    this.prof = { frames: 0, ground: 0, towers: 0, entities: 0, effects: 0 };
  }

  // worker mode has no enemy objects on this thread, so it always draws entities with WebGL
  get glActive() { return (opts.render === 'webgl' || this.forceGL) && this.glr.ok; }

  resize(w, h) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    for (const c of [this.fxCanvas, this.glCanvas]) {
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.fxCanvas.width = this.canvas.width; this.fxCanvas.height = this.canvas.height;
    this.glr.resize(this.canvas.width, this.canvas.height);
  }

  draw(game, cam, alpha, view, realDt) {
    const ctx = this.ctx;
    this.t += realDt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const s = cam.zoom * this.dpr;
    ctx.setTransform(s, 0, 0, s, -cam.x * s, -cam.y * s);

    const P = this.prof, now = performance.now.bind(performance);
    let t0 = now();
    this.drawGround(game, view);
    this.drawBase(game);
    let t1 = now(); P.ground += t1 - t0; t0 = t1;
    this.scale = s;
    const cull = opts.cull === 'on';
    const vx0 = cam.x - TILE, vy0 = cam.y - TILE, vx1 = cam.x + this.w / cam.zoom + TILE, vy1 = cam.y + this.h / cam.zoom + TILE;
    const towers = game.towers;
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (cull && (t.x < vx0 || t.x > vx1 || t.y < vy0 || t.y > vy1)) continue;
      this.drawTower(t, game, t === view.selected);
    }
    t1 = now(); P.towers += t1 - t0; t0 = t1;
    P.frames++;

    if (this.glActive) {
      this.glr.draw(game, cam, s, alpha);
      t1 = now(); P.entities += t1 - t0; t0 = t1;
      // effects + overlay must sit above the GL entities, so they go on the top 2D layer
      const fx = this.fx;
      fx.setTransform(1, 0, 0, 1, 0, 0);
      fx.clearRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
      fx.setTransform(s, 0, 0, s, -cam.x * s, -cam.y * s);
      this.ctx = fx;
      this.drawEffects(game);
      this.drawOverlayWorld(game, view);
      this.ctx = ctx;
      P.effects += now() - t0;
      this.layersDirty = true;
      return;
    }
    if (this.layersDirty) { // switched away from webgl: wipe the upper layers once
      this.layersDirty = false;
      this.glr.clear();
      this.fx.setTransform(1, 0, 0, 1, 0, 0);
      this.fx.clearRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
    }
    if (opts.render === 'naive') {
      for (const e of game.enemies) this.drawEnemy(e, alpha);
      for (const p of game.projectiles) this.drawProjectile(p, alpha);
    } else {
      this.drawEnemiesBatched(game.enemies, alpha, opts.render !== 'paths');
      this.drawProjectilesBatched(game.projectiles, alpha);
    }
    this.drawEffects(game);
    this.drawOverlayWorld(game, view);
  }

  drawGround(game, view) {
    const ctx = this.ctx;
    // The ground, road, grass and rocks never change during a game: paint them once into an
    // offscreen layer and blit it. Above 2.5x scale fall back to direct painting so it stays sharp.
    if (opts.bg === 'cached' && this.scale <= 2.5) {
      const q = Math.min(2.5, Math.max(1, Math.ceil(this.scale * 2) / 2));
      if (!this.bgCanvas || this.bgQ !== q || this.bgGame !== game.baseGrid) {
        this.bgQ = q; this.bgGame = game.baseGrid;
        const w = Math.ceil(WORLD_W * q), h = Math.ceil(WORLD_H * q);
        this.bgCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        const g = this.bgCanvas.getContext('2d');
        g.scale(q, q);
        this.paintStaticGround(g, game);
      }
      ctx.drawImage(this.bgCanvas, 0, 0, WORLD_W, WORLD_H);
    } else {
      this.paintStaticGround(ctx, game);
    }
    this.drawGroundDynamic(game, view);
  }

  paintStaticGround(ctx, game) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const v = game.grid[r * COLS + c];
        if (v === 1) ctx.fillStyle = '#3a3226';
        else ctx.fillStyle = (r + c) % 2 ? '#1f3a2a' : '#22402e';
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
    // road
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = '#4a3f2e';
    ctx.lineWidth = TILE * 0.92;
    ctx.beginPath();
    for (let i = 0; i < game.path.length; i++) {
      const p = game.path[i];
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#6b5a3e';
    ctx.lineWidth = TILE * 0.7;
    ctx.stroke();
    ctx.setLineDash([6, 10]);
    ctx.strokeStyle = 'rgba(255,240,200,0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    for (const t of game.tufts) {
      ctx.fillStyle = t.v > 0.5 ? '#2f5a3c' : '#284d34';
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.s, 0, TAU);
      ctx.fill();
    }
    for (const k of game.rocks) {
      const x = (k.c + 0.5) * TILE, y = (k.r + 0.5) * TILE, rr = k.s * TILE * 0.5;
      ctx.fillStyle = '#4a5568';
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = k.rot + (i / 6) * TAU, m = i % 2 ? 0.8 : 1;
        ctx.lineTo(x + Math.cos(a) * rr * m, y + Math.sin(a) * rr * m);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#718096';
      ctx.beginPath(); ctx.arc(x - rr * 0.2, y - rr * 0.25, rr * 0.35, 0, TAU); ctx.fill();
    }

  }

  drawGroundDynamic(game, view) {
    const ctx = this.ctx;
    if (view.placing) {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c <= COLS; c++) { ctx.moveTo(c * TILE, 0); ctx.lineTo(c * TILE, WORLD_H); }
      for (let r = 0; r <= ROWS; r++) { ctx.moveTo(0, r * TILE); ctx.lineTo(WORLD_W, r * TILE); }
      ctx.stroke();
    }

    // spawn portal
    const sp = game.path[1];
    const sy = sp.y, sx = 0;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3);
    ctx.fillStyle = `rgba(214,188,250,${0.25 + pulse * 0.25})`;
    ctx.beginPath(); ctx.ellipse(sx + 4, sy, 10, TILE * 0.55, 0, 0, TAU); ctx.fill();
  }

  drawBase(game) {
    const ctx = this.ctx;
    const b = game.base;
    const hit = Math.max(0, game.baseHit);
    const S = TILE * 1.3;
    ctx.save();
    ctx.translate(b.x, b.y);
    if (hit > 0) ctx.translate((Math.random() - 0.5) * 6 * hit, (Math.random() - 0.5) * 6 * hit);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-S + 4, -S + 6, S * 2, S * 2);
    ctx.fillStyle = hit > 0 ? '#9b2c2c' : '#2d3748';
    ctx.fillRect(-S, -S, S * 2, S * 2);
    ctx.fillStyle = '#4a5568';
    const q = S * 0.55;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.fillRect(dx * (S - q * 0.5) - q * 0.5, dy * (S - q * 0.5) - q * 0.5, q, q);
    }
    ctx.fillStyle = '#ecc94b';
    ctx.beginPath(); ctx.arc(0, 0, S * 0.38, 0, TAU); ctx.fill();
    ctx.fillStyle = '#975a16';
    ctx.beginPath(); ctx.arc(0, 0, S * 0.18, 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawTower(t, game, selected) {
    const ctx = this.ctx;
    const d = t.def;
    const x = t.x, y = t.y;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x - 15, y - 12, 32, 32);
    ctx.fillStyle = '#2d3748';
    ctx.fillRect(x - 16, y - 16, 32, 32);
    ctx.strokeStyle = selected ? '#fff' : d.color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.strokeRect(x - 15, y - 15, 30, 30);

    ctx.save();
    ctx.translate(x, y);
    if (d.fire === 'pulse') {
      const p = Math.max(0, t.flash) / 0.25;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + this.t * 0.8;
        const rr = i % 2 ? 6 : 11 + p * 3;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ebf8ff';
      ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, TAU); ctx.fill();
    } else {
      ctx.rotate(t.angle);
      const recoil = t.flash > 0 ? -3 : 0;
      ctx.fillStyle = '#1a202c';
      if (d.fire === 'bullet') {
        ctx.fillRect(4 + recoil, -5, 13, 3.5);
        ctx.fillRect(4 + recoil, 1.5, 13, 3.5);
      } else if (d.fire === 'shell') {
        ctx.fillRect(2 + recoil, -5, 15, 10);
      } else {
        ctx.fillRect(2 + recoil, -2.5, 22, 5);
      }
      ctx.fillStyle = d.color;
      ctx.beginPath(); ctx.arc(0, 0, d.fire === 'shell' ? 10 : 8, 0, TAU); ctx.fill();
      if (t.flash > 0 && d.fire !== 'rail') {
        ctx.fillStyle = '#fefcbf';
        ctx.beginPath(); ctx.arc(19, 0, 4, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();

    // level pips
    for (let i = 0; i <= t.level; i++) {
      ctx.fillStyle = '#faf089';
      ctx.fillRect(x - 12 + i * 7, y + 10, 5, 3);
    }
  }

  drawEnemy(e, alpha) {
    const ctx = this.ctx;
    const d = e.def;
    const x = e.px + (e.x - e.px) * alpha;
    const y = e.py + (e.y - e.py) * alpha;
    const r = d.radius * TILE;

    if (d.flying) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(x + 4, y + 10, r * 0.9, r * 0.45, 0, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = e.hitT > 0 ? '#ffffff' : d.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    switch (d.shape) {
      case 'circle': ctx.arc(x, y, r, 0, TAU); break;
      case 'triangle': {
        const fx = e.dirX, fy = e.dirY;
        ctx.moveTo(x + fx * r * 1.3, y + fy * r * 1.3);
        ctx.lineTo(x - fx * r + fy * r, y - fy * r - fx * r);
        ctx.lineTo(x - fx * r - fy * r, y - fy * r + fx * r);
        ctx.closePath();
        break;
      }
      case 'square': ctx.rect(x - r, y - r, r * 2, r * 2); break;
      case 'diamond': {
        const yy = y - 4;
        ctx.moveTo(x, yy - r * 1.2); ctx.lineTo(x + r, yy); ctx.lineTo(x, yy + r * 1.2); ctx.lineTo(x - r, yy);
        ctx.closePath();
        break;
      }
      case 'hex':
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + this.t;
          ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        ctx.closePath();
        break;
    }
    ctx.fill();
    ctx.stroke();

    if (e.slowT > 0) {
      ctx.strokeStyle = 'rgba(144,205,244,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, r + 3, 0, TAU); ctx.stroke();
    }
    if (e.hp < e.maxHp) {
      const w = Math.max(14, r * 2.2), h = 3;
      const bx = x - w / 2, by = y - r - 8;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
      const f = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = f > 0.5 ? '#68d391' : f > 0.25 ? '#f6e05e' : '#fc8181';
      ctx.fillRect(bx, by, w * f, h);
    }
  }

  // ---------- batched drawing ----------
  // Enemies are bucketed by type, then each bucket is one path + one fill + one stroke
  // ("paths"), or one drawImage per enemy from a pre-rendered sprite ("sprites").
  drawEnemiesBatched(enemies, alpha, sprites) {
    const ctx = this.ctx;
    const B = this.buckets || (this.buckets = Object.fromEntries(ENEMY_TYPES.map((k) => [k, []])));
    const hits = this.hits || (this.hits = []);
    for (const k of ENEMY_TYPES) B[k].length = 0;
    hits.length = 0;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.hitT > 0) hits.push(e); else B[e.type].push(e);
    }

    if (sprites) {
      const q = this.spriteQuality();
      for (const type of ENEMY_TYPES) {
        const list = B[type];
        if (!list.length) continue;
        if (C.ENEMIES[type].shape === 'hex') { this.pathBucket(list, alpha, C.ENEMIES[type].color, true); continue; }
        this.stampBucket(list, alpha, type, false, q);
      }
      if (hits.length) {
        for (const e of hits) {
          if (e.def.shape === 'hex') { this.pathBucket([e], alpha, '#ffffff', true); continue; }
          const spr = this.sprite(e.type, true, e.def.shape === 'triangle' ? dirIndex(e) : 0, q);
          const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
          ctx.drawImage(spr.c, x - spr.h, y - spr.h, spr.h * 2, spr.h * 2);
        }
      }
    } else {
      // flyer shadows (one path)
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e.def.flying) continue;
        const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha, r = e.def.radius * TILE;
        ctx.moveTo(x + 4 + r * 0.9, y + 10);
        ctx.ellipse(x + 4, y + 10, r * 0.9, r * 0.45, 0, 0, TAU);
      }
      ctx.fill();
      for (const type of ENEMY_TYPES) if (B[type].length) this.pathBucket(B[type], alpha, C.ENEMIES[type].color, true);
      if (hits.length) this.pathBucket(hits, alpha, '#ffffff', true);
    }

    // slow rings (one path)
    ctx.strokeStyle = 'rgba(144,205,244,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.slowT <= 0) continue;
      const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha, r = e.def.radius * TILE + 3;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.stroke();

    // health bars: one path for all backgrounds, one per fill color
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.hp >= e.maxHp) continue;
      const r = e.def.radius * TILE, w = Math.max(14, r * 2.2);
      const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
      ctx.rect(x - w / 2 - 1, y - r - 9, w + 2, 5);
    }
    ctx.fill();
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = BAR_COLORS[c];
      ctx.beginPath();
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (e.hp >= e.maxHp) continue;
        const f = Math.max(0, e.hp / e.maxHp);
        if ((f > 0.5 ? 0 : f > 0.25 ? 1 : 2) !== c) continue;
        const r = e.def.radius * TILE, w = Math.max(14, r * 2.2);
        const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
        ctx.rect(x - w / 2, y - r - 8, w * f, 3);
      }
      ctx.fill();
    }
  }

  pathBucket(list, alpha, color, stroke) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
      addShape(ctx, e.def.shape, x, y, e.def.radius * TILE, e.dirX, e.dirY, this.t);
    }
    ctx.fillStyle = color;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  stampBucket(list, alpha, type, hit, q) {
    const ctx = this.ctx;
    const directional = C.ENEMIES[type].shape === 'triangle';
    let spr = this.sprite(type, hit, 0, q);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (directional) spr = this.sprite(type, hit, dirIndex(e), q);
      const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
      ctx.drawImage(spr.c, x - spr.h, y - spr.h, spr.h * 2, spr.h * 2);
    }
  }

  // Sprite resolution follows the camera scale (in 0.5 steps) so sprites stay crisp when zoomed.
  spriteQuality() {
    const q = Math.min(8, Math.max(0.5, Math.ceil(this.scale * 2) / 2));
    if (q !== this.sprQ) { this.sprQ = q; this.sprites = new Map(); }
    return q;
  }

  sprite(type, hit, dir, q) {
    const key = type + (hit ? '!' : '') + dir;
    let s = this.sprites.get(key);
    if (s) return s;
    const def = C.ENEMIES[type];
    const h = spriteHalf(def);
    const px = Math.ceil(h * 2 * q);
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : Object.assign(document.createElement('canvas'), { width: px, height: px });
    const g = c.getContext('2d');
    g.scale(px / (h * 2), px / (h * 2));
    g.translate(h, h);
    paintEnemy(g, def, hit, dir);
    s = { c, h };
    this.sprites.set(key, s);
    return s;
  }

  drawProjectilesBatched(projectiles, alpha) {
    const ctx = this.ctx;
    for (const [kind, r, color] of [['bullet', 2.5, '#b2f5ea'], ['shell', 5, '#1a202c'], ['shell', 3, '#f6ad55']]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < projectiles.length; i++) {
        const p = projectiles[i];
        if ((p.kind === 'shell') !== (kind === 'shell')) continue;
        const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fill();
    }
  }

  drawProjectile(p, alpha) {
    const ctx = this.ctx;
    const x = p.px + (p.x - p.px) * alpha;
    const y = p.py + (p.y - p.py) * alpha;
    if (p.kind === 'shell') {
      ctx.fillStyle = '#1a202c';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.fill();
      ctx.fillStyle = '#f6ad55';
      ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = '#b2f5ea';
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
    }
  }

  drawEffects(game) {
    const ctx = this.ctx;
    for (const f of game.effects) {
      const k = f.life / f.max; // 1 -> 0
      ctx.globalAlpha = Math.max(0, k);
      switch (f.kind) {
        case 'ring': {
          const r = f.r1 + (f.r0 - f.r1) * k;
          ctx.strokeStyle = f.color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, TAU); ctx.stroke();
          break;
        }
        case 'pop': {
          ctx.fillStyle = f.color;
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r0 * (1.6 - k * 0.6), 0, TAU); ctx.fill();
          break;
        }
        case 'tracer': {
          ctx.strokeStyle = f.color; ctx.lineWidth = 3 * k + 0.5;
          ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x2, f.y2); ctx.stroke();
          break;
        }
        case 'text': {
          ctx.fillStyle = f.color;
          ctx.font = 'bold 13px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(f.text, f.x, f.y - (1 - k) * 22);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawOverlayWorld(game, view) {
    const ctx = this.ctx;
    const sel = view.selected;
    if (sel) {
      const r = game.stats(sel).range * TILE;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sel.x, sel.y, r, 0, TAU); ctx.fill(); ctx.stroke();
    }
    if (view.placing && view.hoverCol >= 0) {
      const def = C.TOWERS[view.placing];
      const c = view.hoverCol, r = view.hoverRow;
      const ok = game.canPlace(c, r) && game.gold >= def.cost;
      const x = (c + 0.5) * TILE, y = (r + 0.5) * TILE;
      const range = def.levels[0].range * TILE;
      ctx.fillStyle = ok ? 'rgba(104,211,145,0.10)' : 'rgba(252,129,129,0.10)';
      ctx.strokeStyle = ok ? 'rgba(104,211,145,0.7)' : 'rgba(252,129,129,0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, range, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = ok ? 'rgba(104,211,145,0.35)' : 'rgba(252,129,129,0.35)';
      ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = def.color;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    } else if (view.hoverCol >= 0 && game.towerAt(view.hoverCol, view.hoverRow)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(view.hoverCol * TILE + 2, view.hoverRow * TILE + 2, TILE - 4, TILE - 4);
    }
  }
}
