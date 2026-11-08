#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as C from '../src/config.js';
import { Game } from '../src/game.js';
import { GameProxy } from '../src/proxy.js';
import { opts } from '../src/opts.js';

function checkCheat(game, sync = () => {}) {
  assert.equal(game.gold, C.START_GOLD);
  game.gold = 0;
  assert.equal(game.placeTower('sniper', 6, 2), null);
  game.enableUnlimitedGold();
  sync();
  assert.equal(game.gold, Infinity);
  const tower = game.placeTower('sniper', 6, 2);
  assert(tower);
  sync();
  const placed = game.towerAt(6, 2);
  assert(game.upgradeTower(placed));
  sync();
  assert(game.upgradeTower(game.towerAt(6, 2)));
  sync();
  assert.equal(game.upgradeTower(game.towerAt(6, 2)), false, 'Level cap still applies');
  assert.equal(game.placeTower('sniper', 6, 2), null, 'Occupied tiles stay blocked');
  game.sellTower(game.towerAt(6, 2));
  game.startNextWave();
  sync();
  assert.equal(game.gold, Infinity, 'Spending, selling and waves keep unlimited gold');
  game.reset();
  sync();
  assert.equal(game.gold, C.START_GOLD, 'Restart restores the normal economy');
}

checkCheat(new Game());

// Route the real proxy through the worker handler, preserving message order and cloning.
const pending = [];
const worker = { postMessage(message) { pending.push(structuredClone(message)); } };
globalThis.location = { search: '' };
globalThis.self = { postMessage(snapshot) { worker.onmessage({ data: structuredClone(snapshot) }); } };
await import('../src/sim-worker.js');
function sync() {
  while (pending.length) self.onmessage({ data: pending.shift() });
}
const proxy = new GameProxy(worker, opts);
sync();
checkCheat(proxy, sync);
console.log('Unlimited gold: main simulation, worker commands, snapshots and restart passed');
