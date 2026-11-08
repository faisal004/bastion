#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { Audio } from '../src/audio.js';
import { writeSnapshot } from '../src/snapshot.js';
import { GameProxy } from '../src/proxy.js';

const game = new Game();
assert.equal(game.placeTower('blaster', 0, 3), null);
assert.equal(game.soundEvents.size, 0, 'Rejected placement is silent');
const tower = game.placeTower('blaster', 6, 2);
assert(game.soundEvents.has('build'));
assert(game.upgradeTower(tower));
assert(game.soundEvents.has('upgrade'));
game.sellTower(tower);
assert(game.soundEvents.has('sell'));
game.reset();
assert.equal(game.soundEvents.size, 0, 'Reset clears queued audio');
game.startNextWave();
assert(game.soundEvents.has('wave'));
game.reset(); game.wave = 9; game.startNextWave();
assert(game.soundEvents.has('boss'));
for (const type of ['blaster', 'cannon', 'frost', 'sniper']) {
  game.reset();
  const t = game.placeTower(type, 6, 2, true);
  game.spawnEnemy('grunt', 100, 1, 0, 260);
  t.cooldown = 0; game.updateTowers(1 / 60);
  assert(game.soundEvents.has(type), `${type} firing has its own cue`);
}
game.reset(); game.startNextWave();
const escapee = game.spawnEnemy('grunt', 1, 1, 0, game.pathLen - 1);
escapee.speed = 100; game.lives = 1; game.updateEnemies(1);
assert(game.soundEvents.has('base') && game.soundEvents.has('lost'));
game.reset(); game.startNextWave(); game.spawners = []; game.updateWaveState(0);
assert(game.soundEvents.has('clear'));
game.reset(); game.wave = 49; game.startNextWave(); game.spawners = []; game.updateWaveState(0);
assert(game.soundEvents.has('won'));
for (let i = 0; i < 10000; i++) game.sound('blaster');
assert.equal([...game.soundEvents].filter(k => k === 'blaster').length, 1, 'Bursts coalesce');
const snap = writeSnapshot(game, null, { list: [], index: new Map() });
assert.equal(game.soundEvents.size, 0, 'Worker snapshot drains audio');
assert(snap.soundEvents.includes('blaster'));
// Exercise the real proxy snapshot receiver without starting a browser Worker.
const proxy = Object.assign(Object.create(GameProxy.prototype), {
  f: null, palette: [], messages: [], soundEvents: new Set(), towerMap: new Array(960), effects: [], fxPool: [], flush() {},
});
proxy.onSnapshot({ ...snap, simMs: 0, packMs: 0, steps: 0 });
assert(proxy.soundEvents.has('blaster'), 'Proxy receives worker audio');
game.reset(); game.stress = true; game.sound('cannon');
assert.equal(game.soundEvents.size, 0, 'Performance stress tests remain silent');

let scheduled = 0;
const value = () => ({ value: 0, setValueAtTime() {}, setTargetAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
class Context {
  state = 'running'; currentTime = 0; destination = {};
  createGain() { return { gain: value(), connect() {}, disconnect() {} }; }
  createDynamicsCompressor() { return { connect() {} }; }
  createOscillator() { return { frequency: value(), connect() {}, disconnect() {}, start() { scheduled++; }, stop() {} }; }
}
globalThis.AudioContext = Context;
globalThis.document = { hidden: false, addEventListener() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
const button = { disabled: false, setAttribute() {} };
const audio = new Audio(button);
assert.equal(audio.context, undefined, 'No audio context before a gesture');
audio.unlock();
audio.play('blaster'); audio.play('blaster');
assert.equal(scheduled, 1, 'Rapid firing is rate limited');
audio.enabled = false; game.soundEvents.add('cannon'); audio.update(game, false);
assert.equal(scheduled, 1); assert.equal(game.soundEvents.size, 0, 'Muted events are drained');
audio.enabled = true; game.soundEvents.add('cannon'); audio.update(game, true);
assert.equal(scheduled, 1, 'Combat is silent while paused');
game.soundEvents.add('build'); audio.update(game, true);
assert.equal(scheduled, 3, 'Building while paused still gives feedback');
for (let i = 0; i < 50; i++) { audio.context.currentTime++; audio.play('sniper'); }
assert(audio.voices <= 16, 'Overlapping voices are capped');
delete globalThis.AudioContext;
const unavailable = new Audio({ disabled: false, setAttribute() {} }); unavailable.unlock();
assert(unavailable.button.disabled, 'Unsupported audio does not break the game');
console.log('Audio checks passed: simulation cues, coalescing, worker transfer, gesture startup, mute, pause, voice limit, and unavailable audio.');
