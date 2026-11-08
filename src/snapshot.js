// Render snapshot exchanged between the simulation worker and the main thread.
//
// Bulk data lives in ONE Float32Array whose buffer is *transferred* (zero-copy) each tick and
// handed back on the next tick, so the two sides ping-pong a couple of buffers and nothing is
// copied or garbage-collected per entity. Small, rarely-large data (HUD numbers, towers,
// messages, the tile grid) rides along in the message object.
//
// Layout: [enemies | projectiles | effects]
//   enemy      (ES=7):  x, y, px, py, hpFrac, flags, layer
//                       flags = dir(0-3) | hit<<2 | slowed<<3 | damaged<<4
//   projectile (PS=5):  x, y, px, py, isShell
//   effect     (FS=11): kind, x, y, x2, y2, r0, r1, colorIndex, life, max, textNumber
import * as C from './config.js';
import { dirIndex } from './shapes.js';

export const ES = 7, PS = 5, FS = 11;
export const FX_KINDS = ['ring', 'pop', 'tracer', 'text'];
const FX_INDEX = Object.fromEntries(FX_KINDS.map((k, i) => [k, i]));
export const LAYERS = ['swarm', 'runner', 'grunt', 'tank', 'boss', 'flyer'];
const LAYER_INDEX = Object.fromEntries(LAYERS.map((k, i) => [k, i]));

// Worker side. `spare` is a buffer handed back by the main thread (or null).
export function writeSnapshot(game, spare, palette) {
  const en = game.enemies, pr = game.projectiles, fx = game.effects;
  const ne = en.length, np = pr.length, nf = fx.length;
  const need = ne * ES + np * PS + nf * FS;
  const f = spare && spare.byteLength >= need * 4 ? new Float32Array(spare) : new Float32Array(Math.ceil(need * 1.25) + 4096);
  let o = 0;
  for (let i = 0; i < ne; i++, o += ES) {
    const e = en[i];
    f[o] = e.x; f[o + 1] = e.y; f[o + 2] = e.px; f[o + 3] = e.py;
    f[o + 4] = e.hp / e.maxHp;
    f[o + 5] = dirIndex(e) | (e.hitT > 0 ? 4 : 0) | (e.slowT > 0 ? 8 : 0) | (e.hp < e.maxHp ? 16 : 0);
    f[o + 6] = LAYER_INDEX[e.type];
  }
  for (let i = 0; i < np; i++, o += PS) {
    const p = pr[i];
    f[o] = p.x; f[o + 1] = p.y; f[o + 2] = p.px; f[o + 3] = p.py; f[o + 4] = p.kind === 'shell' ? 1 : 0;
  }
  const newColors = [];
  for (let i = 0; i < nf; i++, o += FS) {
    const e = fx[i];
    let ci = palette.index.get(e.color);
    if (ci === undefined) { ci = palette.list.length; palette.list.push(e.color); palette.index.set(e.color, ci); newColors.push(e.color); }
    f[o] = FX_INDEX[e.kind]; f[o + 1] = e.x; f[o + 2] = e.y; f[o + 3] = e.x2; f[o + 4] = e.y2;
    f[o + 5] = e.r0; f[o + 6] = e.r1; f[o + 7] = ci; f[o + 8] = e.life; f[o + 9] = e.max;
    f[o + 10] = e.text ? Number(e.text.slice(1)) : 0;
  }
  const towers = game.towers.map((t) => ({
    id: t.id, type: t.type, c: t.c, r: t.r, x: t.x, y: t.y, level: t.level, angle: t.angle, flash: t.flash,
    mode: t.mode, invested: t.invested, kills: t.kills, damage: t.damage,
  }));
  return {
    type: 'snap', f, ne, np, nf, newColors, towers,
    grid: game.grid.slice(),
    gold: game.gold, lives: game.lives, score: game.score, kills: game.kills, wave: game.wave,
    state: game.state, intermission: game.intermission, waveInProgress: game.waveInProgress,
    spawners: game.spawners.length, baseHit: game.baseHit, stress: game.stress, time: game.time,
    messages: game.messages.splice(0),
  };
}

export { C };
