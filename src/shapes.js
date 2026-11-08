// Enemy shape drawing shared by every renderer, so all modes look identical.
import * as C from './config.js';

const TAU = Math.PI * 2;
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

// Adds one enemy outline to the current path (no beginPath/fill), so many can share one fill.
export function addShape(ctx, shape, x, y, r, dx, dy, spin) {
  switch (shape) {
    case 'circle':
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
      break;
    case 'triangle':
      ctx.moveTo(x + dx * r * 1.3, y + dy * r * 1.3);
      ctx.lineTo(x - dx * r + dy * r, y - dy * r - dx * r);
      ctx.lineTo(x - dx * r - dy * r, y - dy * r + dx * r);
      ctx.closePath();
      break;
    case 'square':
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case 'diamond': {
      const yy = y - 4;
      ctx.moveTo(x, yy - r * 1.2); ctx.lineTo(x + r, yy); ctx.lineTo(x, yy + r * 1.2); ctx.lineTo(x - r, yy);
      ctx.closePath();
      break;
    }
    case 'hex':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + spin;
        if (i) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      ctx.closePath();
      break;
  }
}

export const dirIndex = (e) => (e.dirX > 0.5 ? 0 : e.dirY > 0.5 ? 1 : e.dirX < -0.5 ? 2 : 3);

// Extent (world units, from center) that a sprite of this enemy type needs.
export function spriteHalf(def) { return def.radius * C.TILE * 1.3 + (def.flying ? 16 : 4); }

// Paints one enemy centered at (0,0) in a context already scaled to world units.
export function paintEnemy(g, def, hit, dir) {
  const r = def.radius * C.TILE;
  if (def.flying) {
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.ellipse(4, 10, r * 0.9, r * 0.45, 0, 0, TAU); g.fill();
  }
  const [dx, dy] = DIRS[dir];
  g.beginPath();
  addShape(g, def.shape, 0, 0, r, dx, dy, 0);
  g.fillStyle = hit ? '#ffffff' : def.color;
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 2;
  g.stroke();
}
