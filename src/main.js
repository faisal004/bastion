// Bootstrap: the single frame loop, input, camera and perf meter.
import * as C from './config.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { Lab } from './lab.js';
import { initOpts, optsLabel, opts, OPT_DEFS } from './opts.js';
import { GameProxy } from './proxy.js';

initOpts();

const canvas = document.getElementById('game');
const stage = document.getElementById('stage');
const perfEl = document.getElementById('perf');

const renderer = new Renderer(canvas);
// Worker mode needs WebGL (no enemy objects exist on this thread to draw with Canvas 2D).
const useWorker = opts.sim === 'worker' && typeof Worker !== 'undefined' && renderer.glr.ok;
if (!useWorker) opts.sim = 'main';
const game = useWorker
  ? new GameProxy(new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' }), opts)
  : new Game();
renderer.forceGL = useWorker;
const cam = { x: 0, y: 0, zoom: 1, minZoom: 0.5, maxZoom: 3 };
const view = { placing: null, selected: null, hoverCol: -1, hoverRow: -1, mx: 0, my: 0, inside: false };
const ctl = { paused: false, speed: 1, restartArmed: false };
const SPEEDS = [1, 2, 4];

// ---------- actions ----------
let restartTimer = 0;
const actions = {
  nextWave() { game.startNextWave(); },
  togglePause() {
    if (game.state === 'won' || game.state === 'lost') return;
    ctl.paused = !ctl.paused;
  },
  cycleSpeed() { ctl.speed = SPEEDS[(SPEEDS.indexOf(ctl.speed) + 1) % SPEEDS.length]; },
  restart(force = false) {
    const over = game.state === 'won' || game.state === 'lost' || game.wave === 0;
    if (!force && !over && !ctl.restartArmed) {
      ctl.restartArmed = true;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => (ctl.restartArmed = false), 2500);
      ui.toast('Press Restart again to confirm', 'warn');
      return;
    }
    ctl.restartArmed = false;
    game.reset();
    view.selected = null; view.placing = null;
    ctl.paused = false;
  },
  selectBuild(type) {
    view.selected = null;
    view.placing = view.placing === type ? null : type;
  },
  upgrade() {
    if (!view.selected || !view.selected.def) return;
    if (!game.upgradeTower(view.selected)) {
      if (game.upgradeCost(view.selected) != null) ui.toast('Not enough gold', 'warn');
    }
  },
  sell() {
    if (!view.selected || !view.selected.def) return;
    game.sellTower(view.selected);
    view.selected = null;
  },
  cycleMode() { if (view.selected && view.selected.def) game.cycleMode(view.selected); },
};

const ui = new UI(game, view, ctl, actions);
const lab = new Lab({ game, ctl, ui, view, version: optsLabel });

{
  const q = new URLSearchParams(location.search);
  if (q.has('lab')) lab.toggle(true);
  if (q.has('stress')) {
    const [e = 5000, t = 100, p = 1000] = q.get('stress').split(',').map(Number);
    lab.toggle(true);
    lab.setSliders({ enemies: e, towers: t, projectiles: p });
    lab.apply({ enemies: e, towers: t, projectiles: p });
  }
}

// ---------- camera ----------
function fitCamera() {
  const w = renderer.w, h = renderer.h;
  const z = Math.min(w / C.WORLD_W, h / C.WORLD_H);
  cam.minZoom = z * 0.9;
  cam.maxZoom = Math.max(3, z * 4);
  cam.zoom = z;
  cam.x = (C.WORLD_W - w / z) / 2;
  cam.y = (C.WORLD_H - h / z) / 2;
}

function clampCamera() {
  const vw = renderer.w / cam.zoom, vh = renderer.h / cam.zoom;
  const mx = C.TILE * 2;
  if (vw >= C.WORLD_W) cam.x = (C.WORLD_W - vw) / 2;
  else cam.x = Math.min(Math.max(cam.x, -mx), C.WORLD_W - vw + mx);
  if (vh >= C.WORLD_H) cam.y = (C.WORLD_H - vh) / 2;
  else cam.y = Math.min(Math.max(cam.y, -mx), C.WORLD_H - vh + mx);
}

function zoomAt(sx, sy, factor) {
  camTouched = true;
  const wx = cam.x + sx / cam.zoom, wy = cam.y + sy / cam.zoom;
  cam.zoom = Math.min(cam.maxZoom, Math.max(cam.minZoom, cam.zoom * factor));
  cam.x = wx - sx / cam.zoom;
  cam.y = wy - sy / cam.zoom;
  clampCamera();
}

let camTouched = false; // keep auto-fitting until the player pans or zooms
function onResize() {
  const r = stage.getBoundingClientRect();
  renderer.resize(r.width, r.height);
  if (!camTouched) fitCamera();
  else {
    cam.minZoom = Math.min(renderer.w / C.WORLD_W, renderer.h / C.WORLD_H) * 0.9;
    clampCamera();
  }
}
new ResizeObserver(onResize).observe(stage);
onResize();

// ---------- input ----------
function updateHover() {
  const wx = cam.x + view.mx / cam.zoom, wy = cam.y + view.my / cam.zoom;
  if (!view.inside) { view.hoverCol = view.hoverRow = -1; return; }
  view.hoverCol = Math.floor(wx / C.TILE);
  view.hoverRow = Math.floor(wy / C.TILE);
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, sx: e.offsetX, sy: e.offsetY, cx: cam.x, cy: cam.y, moved: false, button: e.button };
});
canvas.addEventListener('pointermove', (e) => {
  view.mx = e.offsetX; view.my = e.offsetY; view.inside = true;
  if (drag && drag.id === e.pointerId) {
    const dx = e.offsetX - drag.sx, dy = e.offsetY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
    if (drag.moved) {
      camTouched = true;
      cam.x = drag.cx - dx / cam.zoom;
      cam.y = drag.cy - dy / cam.zoom;
      clampCamera();
    }
  }
  updateHover();
});
canvas.addEventListener('pointerleave', () => { view.inside = false; updateHover(); });
canvas.addEventListener('pointerup', (e) => {
  if (!drag || drag.id !== e.pointerId) return;
  const d = drag; drag = null;
  if (d.moved) return;
  if (d.button === 2) { view.placing = null; view.selected = null; return; }
  if (d.button !== 0) return;
  view.mx = e.offsetX; view.my = e.offsetY; view.inside = true;
  updateHover();
  handleClick(e.shiftKey);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 40 : 1;
  zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0015)));
  updateHover();
}, { passive: false });

function handleClick(shift) {
  if (game.state === 'won' || game.state === 'lost') return;
  const c = view.hoverCol, r = view.hoverRow;
  if (view.placing) {
    const def = C.TOWERS[view.placing];
    if (!game.canPlace(c, r)) {
      const t = game.towerAt(c, r);
      if (t) { view.placing = null; view.selected = t; }
      return;
    }
    if (game.gold < def.cost) { ui.toast('Not enough gold', 'warn'); return; }
    const t = game.placeTower(view.placing, c, r);
    if (t && !shift) { view.placing = null; view.selected = t; }
    return;
  }
  view.selected = game.towerAt(c, r);
}

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (e.repeat) return;
  const typeByKey = C.TOWER_TYPES.find((t) => C.TOWERS[t].key === k);
  if (typeByKey) { actions.selectBuild(typeByKey); return; }
  switch (k) {
    case ' ': e.preventDefault(); actions.togglePause(); break;
    case 'f': actions.cycleSpeed(); break;
    case 'n': actions.nextWave(); break;
    case 'r': actions.restart(); break;
    case 'u': actions.upgrade(); break;
    case 'x': case 'delete': case 'backspace': actions.sell(); break;
    case 't': actions.cycleMode(); break;
    case 'escape': view.placing = null; view.selected = null; break;
    case '`': perfEl.classList.toggle('hidden'); break;
    case 'l': lab.toggle(); break;
    case 'g': { // demo toggle: original renderer <-> best renderer
      const d = OPT_DEFS.find((x) => x.key === 'render');
      if (game.isProxy) { ui.toast('Renderer switching needs the main-thread sim (Stress Lab → Simulation thread)', 'warn'); break; }
      opts.render = opts.render === d.best ? d.choices[0] : d.best;
      lab.syncOpts();
      ui.toast(`Renderer: ${d.names[opts.render]}`, 'warn');
      break;
    }
    case '0': camTouched = false; fitCamera(); break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function panKeys(dt) {
  let dx = 0, dy = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
  if (keys.has('d') || keys.has('arrowright')) dx += 1;
  if (keys.has('w') || keys.has('arrowup')) dy -= 1;
  if (keys.has('s') || keys.has('arrowdown')) dy += 1;
  if (!dx && !dy) return;
  camTouched = true;
  const sp = 700 / cam.zoom;
  cam.x += dx * sp * dt; cam.y += dy * sp * dt;
  clampCamera();
  updateHover();
}

// ---------- perf meter ----------
const FT_N = 240;
const frameTimes = new Float32Array(FT_N);
let ftIdx = 0, ftCount = 0;
let simMs = 0, drawMs = 0, perfTimer = 0;
const sorted = new Float32Array(FT_N);

function perfReport() {
  const n = ftCount;
  if (!n) return;
  sorted.set(frameTimes);
  const view = sorted.subarray(0, n).sort();
  let sum = 0, slow = 0;
  for (let i = 0; i < n; i++) { sum += view[i]; if (view[i] > 33.4) slow++; }
  const avg = sum / n;
  const p95 = view[Math.min(n - 1, Math.floor(n * 0.95))];
  perfEl.innerHTML =
    `<b>${(1000 / avg).toFixed(0)}</b> fps · p95 ${p95.toFixed(1)}ms · &gt;33ms ${((slow / n) * 100).toFixed(1)}%<br>` +
    `sim ${simMs.toFixed(2)}ms · draw ${drawMs.toFixed(2)}ms<br>` +
    `enemies ${game.enemies.length} · towers ${game.towers.length} · proj ${game.projectiles.length} · fx ${game.effects.length}`;
}

// ---------- the one frame loop ----------
let last = performance.now();
let acc = 0;
function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  const rawDtMs = dt * 1000;
  if (dt > 0.25) dt = 0.25; // tab was in the background; don't fast-forward

  frameTimes[ftIdx] = dt * 1000;
  ftIdx = (ftIdx + 1) % FT_N;
  if (ftCount < FT_N) ftCount++;

  panKeys(dt);

  const t0 = performance.now();
  const running = ui.titleDismissed && !ctl.paused && game.state === 'playing';
  if (running) {
    lab.topUp();
    acc += dt * ctl.speed;
    if (game.isProxy) {
      // the worker runs the fixed steps in parallel; we only tell it how many are owed
      const steps = Math.floor(acc / C.STEP);
      acc -= steps * C.STEP;
      game.requestSteps(steps);
    } else {
      let steps = 0;
      while (acc >= C.STEP && steps < C.MAX_STEPS_PER_FRAME) {
        game.update(C.STEP);
        acc -= C.STEP;
        steps++;
      }
      if (steps === C.MAX_STEPS_PER_FRAME) acc = 0; // can't keep up: drop time instead of spiraling
    }
  }
  // Selection is a tile: re-resolve it every frame (towers are new objects each snapshot in
  // worker mode; a freshly placed tower is 'pending' until the worker confirms it).
  if (view.selected) {
    const s = view.selected, t = game.towerAt(s.c, s.r);
    if (t) view.selected = t;
    else if (!(s.pending && performance.now() - s.pending < 1000)) view.selected = null;
  }
  const t1 = performance.now();
  renderer.draw(game, cam, running ? acc / C.STEP : 1, view, ctl.paused ? 0 : dt);
  const t2 = performance.now();
  simMs = simMs * 0.9 + (t1 - t0) * 0.1;
  drawMs = drawMs * 0.9 + (t2 - t1) * 0.1;

  ui.update();
  lab.frame(rawDtMs, game.isProxy ? game.simMs : t1 - t0, t2 - t1);
  perfTimer -= dt;
  if (perfTimer <= 0) { perfTimer = 0.25; perfReport(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exposed for the console / upcoming stress harness.
window.bastion = { game, cam, view, ctl, renderer, lab };
