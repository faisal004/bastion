// Canvas 2D renderer. Reads game state, never mutates it.
// v0 baseline: background redrawn per tile every frame, each entity drawn
// with its own path + fillStyle change, no culling.
import * as C from './config.js';

const { TILE, COLS, ROWS, WORLD_W, WORLD_H } = C;
const TAU = Math.PI * 2;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.w = 0; this.h = 0; this.dpr = 1;
    this.t = 0;
  }

  resize(w, h) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  draw(game, cam, alpha, view, realDt) {
    const ctx = this.ctx;
    this.t += realDt;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const s = cam.zoom * this.dpr;
    ctx.setTransform(s, 0, 0, s, -cam.x * s, -cam.y * s);

    this.drawGround(game, view);
    this.drawBase(game);
    for (const t of game.towers) this.drawTower(t, game, t === view.selected);
    for (const e of game.enemies) this.drawEnemy(e, alpha);
    for (const p of game.projectiles) this.drawProjectile(p, alpha);
    this.drawEffects(game);
    this.drawOverlayWorld(game, view);
  }

  drawGround(game, view) {
    const ctx = this.ctx;
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
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1.6 - k * 0.6), 0, TAU); ctx.fill();
          break;
        }
        case 'tracer': {
          ctx.strokeStyle = f.color; ctx.lineWidth = 3 * k + 0.5;
          ctx.beginPath(); ctx.moveTo(f.x1, f.y1); ctx.lineTo(f.x2, f.y2); ctx.stroke();
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
