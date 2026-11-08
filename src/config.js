// All game data and balance curves live here.

export const TILE = 40;
export const COLS = 40;
export const ROWS = 24;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

export const SIM_HZ = 60;
export const STEP = 1 / SIM_HZ;
export const MAX_STEPS_PER_FRAME = 16;

export const START_GOLD = 220;
export const START_LIVES = 25;
export const MAX_WAVE = 50;
export const INTERMISSION = 12; // seconds between waves (auto-start)
export const SELL_REFUND = 0.7;

// Road waypoints in tile coordinates (tile centers). First point is off-map (spawn).
export const PATH_POINTS = [
  [-1, 3], [8, 3], [8, 12], [3, 12], [3, 20], [15, 20], [15, 7],
  [23, 7], [23, 18], [31, 18], [31, 4], [37, 4],
];

export const TARGET_MODES = ['first', 'last', 'strong', 'close'];

// Ranges / splash in tiles, rate in shots per second, pspeed in tiles/s.
export const TOWERS = {
  blaster: {
    name: 'Blaster', key: '1', color: '#4fd1c5', cost: 50, fire: 'bullet',
    desc: 'Rapid single-target fire. Struggles against armor.',
    levels: [
      { dmg: 6, rate: 5, range: 3.0, pspeed: 14 },
      { cost: 60, dmg: 10, rate: 6, range: 3.3, pspeed: 15 },
      { cost: 130, dmg: 17, rate: 7.5, range: 3.6, pspeed: 16 },
    ],
  },
  cannon: {
    name: 'Cannon', key: '2', color: '#f6ad55', cost: 100, fire: 'shell', groundOnly: true,
    desc: 'Explosive splash. Shreds packs. Cannot hit flyers.',
    levels: [
      { dmg: 30, rate: 0.85, range: 3.2, splash: 1.0, pspeed: 8 },
      { cost: 110, dmg: 55, rate: 0.95, range: 3.5, splash: 1.2, pspeed: 9 },
      { cost: 240, dmg: 95, rate: 1.05, range: 3.8, splash: 1.45, pspeed: 10 },
    ],
  },
  frost: {
    name: 'Frost', key: '3', color: '#90cdf4', cost: 80, fire: 'pulse',
    desc: 'Pulses a chilling wave: slows and chips everything nearby.',
    levels: [
      { dmg: 4, rate: 0.8, range: 2.3, slow: 0.35, slowDur: 1.6 },
      { cost: 90, dmg: 9, rate: 0.95, range: 2.6, slow: 0.45, slowDur: 1.8 },
      { cost: 190, dmg: 18, rate: 1.1, range: 2.9, slow: 0.55, slowDur: 2.0 },
    ],
  },
  sniper: {
    name: 'Sniper', key: '4', color: '#f687b3', cost: 150, fire: 'rail', pierce: true, defaultMode: 'strong',
    desc: 'Long-range rail shot. Ignores armor. Hunts the strongest.',
    levels: [
      { dmg: 75, rate: 0.55, range: 6.5 },
      { cost: 150, dmg: 150, rate: 0.65, range: 7.2 },
      { cost: 320, dmg: 290, rate: 0.8, range: 8.0 },
    ],
  },
};
export const TOWER_TYPES = Object.keys(TOWERS);

// hp at wave 1, speed in tiles/s, radius in tiles.
export const ENEMIES = {
  grunt:  { name: 'Grunt',  hp: 40,   speed: 1.3,  reward: 5,   armor: 0, radius: 0.28, color: '#e2e8f0', shape: 'circle',   lifeDmg: 1 },
  runner: { name: 'Runner', hp: 22,   speed: 2.6,  reward: 4,   armor: 0, radius: 0.22, color: '#fbd38d', shape: 'triangle', lifeDmg: 1 },
  tank:   { name: 'Tank',   hp: 170,  speed: 0.7,  reward: 14,  armor: 4, radius: 0.4,  color: '#a0aec0', shape: 'square',   lifeDmg: 2 },
  swarm:  { name: 'Swarm',  hp: 10,   speed: 1.9,  reward: 1,   armor: 0, radius: 0.15, color: '#9ae6b4', shape: 'circle',   lifeDmg: 1 },
  flyer:  { name: 'Flyer',  hp: 34,   speed: 1.7,  reward: 7,   armor: 0, radius: 0.26, color: '#d6bcfa', shape: 'diamond',  lifeDmg: 1, flying: true },
  boss:   { name: 'Warlord', hp: 1600, speed: 0.55, reward: 150, armor: 6, radius: 0.6, color: '#fc8181', shape: 'hex',      lifeDmg: 10, slowResist: 0.5 },
};

// Tuned with src/bot.js: a greedy mixed-tower bot clears wave 50 with ~15/25 lives;
// single-tower-type strategies collapse between waves 15 and 20.
export const hpScale = (w) => (1 + (w - 1) * 0.12 + (w - 1) * (w - 1) * 0.0085) * (1 + 1.2 * (w / 50) ** 2);
export const rewardScale = (w) => 1 + (w - 1) * 0.015;
export const armorBonus = (w) => Math.floor(w / 10);
export const waveClearBonus = (w) => 25 + w * 3;

// Deterministic wave composition. Groups spawn concurrently, each with its own delay.
export function buildWave(w) {
  const g = [];
  g.push({ type: 'grunt', count: 6 + Math.floor(w * 1.6), interval: Math.max(0.35, 1.0 - w * 0.013), delay: 0 });
  if (w >= 3) g.push({ type: 'runner', count: 3 + Math.floor(w * 0.9), interval: Math.max(0.25, 0.6 - w * 0.006), delay: 3 });
  if (w >= 5 && w % 2 === 1) g.push({ type: 'swarm', count: 14 + w * 2, interval: 0.12, delay: 5 });
  if (w >= 7) g.push({ type: 'tank', count: 1 + Math.floor((w - 5) / 3), interval: 2.4, delay: 6 });
  if (w >= 9 && w % 3 === 0) g.push({ type: 'flyer', count: 4 + Math.floor(w / 2), interval: 0.55, delay: 4 });
  if (w >= 20 && w % 4 === 2) g.push({ type: 'swarm', count: 20 + w * 2, interval: 0.08, delay: 12 });
  if (w % 10 === 0) g.push({ type: 'boss', count: w / 10, interval: 4, delay: 8 });
  return g;
}

export function describeWave(w) {
  const counts = {};
  for (const grp of buildWave(w)) counts[grp.type] = (counts[grp.type] || 0) + grp.count;
  return counts;
}

// Small seeded RNG so map decoration is identical every run.
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
