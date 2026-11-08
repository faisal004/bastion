// Stress-load control shared by the Stress Lab (main-thread sim) and the simulation worker.
import * as C from './config.js';

const STRESS_TYPES = ['grunt', 'grunt', 'runner', 'tank', 'swarm', 'swarm', 'flyer'];
const TOWER_MIX = ['blaster', 'cannon', 'frost', 'sniper', 'blaster'];
let candidates = null;

// Buildable tiles ordered by how much road they cover (computed once; the map never changes).
function towerSites(game) {
  if (candidates) return candidates;
  const g = game.baseGrid, cand = [];
  for (let r = 0; r < C.ROWS; r++) for (let c = 0; c < C.COLS; c++) {
    if (g[r * C.COLS + c] !== 0) continue;
    let k = 0;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      const rr = r + dr, cc = c + dc;
      if (dr * dr + dc * dc <= 9 && rr >= 0 && rr < C.ROWS && cc >= 0 && cc < C.COLS && g[rr * C.COLS + cc] === 1) k++;
    }
    cand.push({ c, r, k });
  }
  cand.sort((a, b) => b.k - a.k);
  return (candidates = cand);
}

// Fresh game held at a fixed load: max-level towers of every type along the road,
// enemies that loop forever (no lives lost), no waves.
export function stressSetup(game, cfg) {
  game.reset();
  game.stress = true;
  game.state = 'playing';
  game.gold = 1e9;
  const sites = towerSites(game);
  for (let i = 0, placed = 0; placed < cfg.towers && i < sites.length; i++) {
    const t = game.placeTower(TOWER_MIX[placed % TOWER_MIX.length], sites[i].c, sites[i].r, true);
    if (t) { t.level = 2; placed++; }
  }
  game.effects.length = 0;
  stressTopUp(game, cfg);
}

// Refill enemies and projectiles back to the target counts (called once per frame/tick).
export function stressTopUp(game, cfg) {
  const hpMul = C.hpScale(30);
  for (let need = cfg.enemies - game.enemyCount; need > 0; need--) {
    game.spawnEnemy(STRESS_TYPES[(Math.random() * STRESS_TYPES.length) | 0], hpMul, 1, 3, Math.random() * game.pathLen * 0.98);
  }
  if (game.enemyCount === 0) return;
  const towers = game.towers;
  for (let need = cfg.projectiles - game.projectileCount; need > 0; need--) {
    const e = game.randomEnemy();
    const t = towers.length ? towers[(Math.random() * towers.length) | 0] : null;
    const x = t ? t.x : Math.random() * C.WORLD_W, y = t ? t.y : Math.random() * C.WORLD_H;
    game.spawnProjectile('bullet', x, y, e, 4 * C.TILE, 2, 0, null);
  }
}
