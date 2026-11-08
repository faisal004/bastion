// Simple autoplayer used for balance checks and long-run (memory) tests.
// Builds on the tiles that cover the most road, cycling through `plan`,
// and spends spare gold on upgrades.
import * as C from './config.js';

export function makeBot(game, plan = ['blaster', 'blaster', 'cannon', 'frost', 'sniper', 'cannon', 'blaster', 'sniper']) {
  const cand = [];
  for (let r = 0; r < C.ROWS; r++) for (let c = 0; c < C.COLS; c++) {
    if (game.grid[r * C.COLS + c] !== 0) continue;
    let n = 0;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      const rr = r + dr, cc = c + dc;
      if (dr * dr + dc * dc <= 9 && rr >= 0 && rr < C.ROWS && cc >= 0 && cc < C.COLS && game.grid[rr * C.COLS + cc] === 1) n++;
    }
    cand.push({ c, r, n });
  }
  cand.sort((a, b) => b.n - a.n);
  let ci = 0, bi = 0, flip = false;

  return function think() {
    for (let guard = 0; guard < 4; guard++) {
      const type = plan[bi % plan.length];
      let lowest = null;
      for (const t of game.towers) if (t.level < 2 && (!lowest || t.level < lowest.level)) lowest = t;
      flip = !flip;
      if (game.towers.length >= 6 && lowest && game.upgradeCost(lowest) <= game.gold && (game.towers.length > 14 || flip)) {
        game.upgradeTower(lowest);
        continue;
      }
      if (game.gold >= C.TOWERS[type].cost) {
        while (ci < cand.length && !game.canPlace(cand[ci].c, cand[ci].r)) ci++;
        if (ci < cand.length) { game.placeTower(type, cand[ci].c, cand[ci].r); bi++; continue; }
      }
      break;
    }
    if (game.state === 'playing' && !game.waveInProgress && game.intermission > 0 && game.intermission < C.INTERMISSION - 3) {
      game.startNextWave();
    }
  };
}

// Runs a whole game headlessly. Returns a summary.
export function simulate(Game, plan, maxMinutes = 90) {
  const g = new Game();
  const think = makeBot(g, plan);
  g.startNextWave();
  let steps = 0, peak = 0;
  const limit = maxMinutes * 60 * C.SIM_HZ;
  while (g.state === 'playing' && steps < limit) {
    if (steps % 6 === 0) think();
    g.update(C.STEP);
    steps++;
    if (g.enemies.length > peak) peak = g.enemies.length;
  }
  return { state: g.state, wave: g.wave, lives: g.lives, towers: g.towers.length, gold: g.gold,
    score: g.score, kills: g.kills, minutes: +(steps / C.SIM_HZ / 60).toFixed(1), peakEnemies: peak };
}
