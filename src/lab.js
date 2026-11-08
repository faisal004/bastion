// Stress Lab: holds the game at a fixed load (enemies / towers / projectiles),
// records frame times, and ramps the load to find where FPS breaks.
// Open with `L` or ?lab. ?stress=5000,100,1000 applies a load on load.
import * as C from './config.js';

export const TARGET = { enemies: 5000, towers: 100, projectiles: 1000 };
const STRESS_TYPES = ['grunt', 'grunt', 'runner', 'tank', 'swarm', 'swarm', 'flyer'];
const TOWER_MIX = ['blaster', 'cannon', 'frost', 'sniper', 'blaster'];
const RAMP_STEPS = [0.1, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 3, 4, 6, 8];
const MAX_TOWERS = 600;
const FPS45_MS = 1000 / 45 + 0.5; // small tolerance for rAF timestamp jitter
const GRAPH_N = 300;
const STORE_KEY = 'bastion.lab.results';

export function frameStats(samples) {
  const n = samples.length;
  if (!n) return null;
  const s = Float64Array.from(samples).sort();
  let sum = 0, over33 = 0, under45 = 0;
  for (let i = 0; i < n; i++) {
    const v = s[i];
    sum += v;
    if (v > 33.4) over33++;
    if (v > FPS45_MS) under45++;
  }
  const q = (p) => s[Math.min(n - 1, Math.floor(n * p))];
  return {
    frames: n,
    avgFps: 1000 / (sum / n),
    p50: q(0.5), p95: q(0.95), p99: q(0.99),
    fps95: 1000 / q(0.95),          // the FPS that 95% of frames meet or beat
    pctAt45: ((n - under45) / n) * 100,
    pctOver33: (over33 / n) * 100,
  };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const fmt = (v, d = 1) => (v == null || !isFinite(v) ? '–' : v.toFixed(d));

export class Lab {
  constructor(app) {
    this.app = app; // { game, ctl, ui, view, version() }
    this.active = false;
    this.cfg = { ...TARGET };
    this.ring = new Float32Array(GRAPH_N);
    this.ri = 0;
    this.job = null;
    this.rampPoints = [];
    this.rampMeta = null;
    this.readoutT = 0;
    this.results = [];
    try { this.results = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { this.results = []; }
    this.cand = null;
    this.build();
  }

  // ---------- DOM ----------
  build() {
    const el = document.createElement('div');
    el.id = 'lab';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="lab-head"><b>Stress Lab</b><span id="lab-ver" class="lab-ver"></span><button data-l="close" title="Close (L)">×</button></div>
      <div class="lab-big">
        <div><b id="lab-fps">–</b><span>avg fps</span></div>
        <div><b id="lab-fps95">–</b><span>fps @95%</span></div>
        <div><b id="lab-o33">–</b><span>&gt;33 ms</span></div>
      </div>
      <canvas id="lab-graph"></canvas>
      <div class="lab-counts" id="lab-counts"></div>
      ${this.slider('enemies', 'Enemies', 0, 40000, 250)}
      ${this.slider('towers', 'Towers', 0, MAX_TOWERS, 10)}
      ${this.slider('projectiles', 'Projectiles', 0, 8000, 100)}
      <div class="lab-row">
        <button data-l="apply" class="primary">Apply load</button>
        <button data-l="target">Target 5k/100/1k</button>
        <button data-l="stop">Stop</button>
      </div>
      <div class="lab-row">
        <button data-l="bench">Benchmark 5s</button>
        <button data-l="ramp" class="primary">Find breaking point</button>
        <select id="lab-mode" title="What the ramp scales">
          <option value="all">scale all 3</option>
          <option value="enemies">enemies only</option>
        </select>
      </div>
      <div id="lab-status" class="lab-status">Pick a load and press Apply, or let the ramp find the breaking point.</div>
      <canvas id="lab-chart"></canvas>
      <div class="lab-row tight"><b class="lab-sub">Results</b><span class="spacer"></span>
        <button data-l="copy" class="mini">Copy JSON</button><button data-l="clear" class="mini">Clear</button></div>
      <div id="lab-results"></div>`;
    document.getElementById('stage').appendChild(el);
    this.el = el;
    this.$ = (id) => el.querySelector('#' + id);
    this.graph = this.setupCanvas(this.$('lab-graph'), 300, 64);
    this.chart = this.setupCanvas(this.$('lab-chart'), 300, 150);

    for (const k of ['enemies', 'towers', 'projectiles']) {
      const input = this.$('lab-in-' + k);
      input.value = this.cfg[k];
      input.oninput = () => { this.cfg[k] = +input.value; this.$('lab-v-' + k).textContent = input.value; };
      this.$('lab-v-' + k).textContent = this.cfg[k];
    }
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-l]');
      if (!b) return;
      const a = b.dataset.l;
      if (a === 'close') this.toggle(false);
      else if (a === 'apply') this.apply(this.cfg);
      else if (a === 'target') { this.setSliders(TARGET); this.apply(TARGET); }
      else if (a === 'stop') this.stop();
      else if (a === 'bench') this.startBench();
      else if (a === 'ramp') this.startRamp(this.$('lab-mode').value);
      else if (a === 'copy') navigator.clipboard?.writeText(JSON.stringify(this.results, null, 2));
      else if (a === 'clear') { this.results = []; this.save(); this.renderResults(); }
    });
    // keep game hotkeys from firing while using the panel's inputs
    el.addEventListener('keydown', (e) => e.stopPropagation());
    this.renderResults();
  }

  slider(k, label, min, max, step) {
    return `<label class="lab-slider"><span>${label}</span>
      <input id="lab-in-${k}" type="range" min="${min}" max="${max}" step="${step}">
      <b id="lab-v-${k}"></b></label>`;
  }

  setSliders(cfg) {
    for (const k of ['enemies', 'towers', 'projectiles']) {
      this.cfg[k] = cfg[k];
      this.$('lab-in-' + k).value = cfg[k];
      this.$('lab-v-' + k).textContent = cfg[k];
    }
  }

  setupCanvas(cv, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    return { cv, ctx, w, h };
  }

  get visible() { return !this.el.classList.contains('hidden'); }

  toggle(force) {
    const show = force ?? !this.visible;
    this.el.classList.toggle('hidden', !show);
    if (show) this.app.ui.titleDismissed = true;
  }

  save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(this.results)); } catch { /* storage unavailable */ } }

  // ---------- load control ----------
  apply(cfg) {
    const { game, ui, ctl, view } = this.app;
    this.cfg = { ...this.cfg, ...cfg };
    game.reset();
    game.stress = true;
    game.state = 'playing';
    game.gold = 1e9;
    ui.titleDismissed = true;
    ctl.paused = false;
    ctl.speed = 1;
    view.selected = null; view.placing = null;
    this.placeTowers(this.cfg.towers);
    this.active = true;
    this.topUp();
  }

  stop() {
    this.job = null;
    this.active = false;
    this.app.game.reset();
    this.status('Stopped.');
  }

  placeTowers(n) {
    const game = this.app.game;
    if (!this.cand) {
      // buildable tiles ordered by how much road they cover
      const cand = [];
      for (let r = 0; r < C.ROWS; r++) for (let c = 0; c < C.COLS; c++) {
        if (game.grid[r * C.COLS + c] !== 0) continue;
        let k = 0;
        for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
          const rr = r + dr, cc = c + dc;
          if (dr * dr + dc * dc <= 9 && rr >= 0 && rr < C.ROWS && cc >= 0 && cc < C.COLS && game.grid[rr * C.COLS + cc] === 1) k++;
        }
        cand.push({ c, r, k });
      }
      cand.sort((a, b) => b.k - a.k);
      this.cand = cand;
    }
    for (let i = 0, placed = 0; placed < n && i < this.cand.length; i++) {
      const t = game.placeTower(TOWER_MIX[placed % TOWER_MIX.length], this.cand[i].c, this.cand[i].r, true);
      if (t) { t.level = 2; placed++; }
    }
    game.effects.length = 0;
  }

  // Called once per frame before the simulation runs: hold counts at the target.
  topUp() {
    if (!this.active) return;
    const game = this.app.game;
    const hpMul = C.hpScale(30);
    for (let need = this.cfg.enemies - game.enemyCount; need > 0; need--) {
      game.spawnEnemy(STRESS_TYPES[(Math.random() * STRESS_TYPES.length) | 0], hpMul, 1, 3, Math.random() * game.pathLen * 0.98);
    }
    if (game.enemyCount === 0) return;
    const towers = game.towers;
    for (let need = this.cfg.projectiles - game.projectileCount; need > 0; need--) {
      const e = game.randomEnemy();
      const t = towers.length ? towers[(Math.random() * towers.length) | 0] : null;
      const x = t ? t.x : Math.random() * C.WORLD_W, y = t ? t.y : Math.random() * C.WORLD_H;
      game.spawnProjectile('bullet', x, y, e, 4 * C.TILE, 2, 0, null);
    }
  }

  // ---------- measurement ----------
  // dtMs = time since the previous frame (what the player feels); workMs = sim + draw CPU time.
  frame(dtMs, simMs, drawMs) {
    this.ring[this.ri] = dtMs;
    this.ri = (this.ri + 1) % GRAPH_N;
    const job = this.job;
    if (job) this.tickJob(job, dtMs, simMs, drawMs);
    if (!this.visible) return;
    this.drawGraph();
    this.readoutT -= dtMs;
    if (this.readoutT <= 0) {
      this.readoutT = 250;
      const st = frameStats(Array.from(this.ring).filter((v) => v > 0).slice(-120));
      if (st) {
        this.setBig('lab-fps', st.avgFps, st.avgFps >= 55 ? 'ok' : st.avgFps >= 45 ? 'warn' : 'bad');
        this.setBig('lab-fps95', st.fps95, st.fps95 >= 45 ? 'ok' : st.fps95 >= 30 ? 'warn' : 'bad');
        this.setBig('lab-o33', st.pctOver33, st.pctOver33 < 5 ? 'ok' : 'bad', '%');
      }
      const g = this.app.game;
      this.$('lab-counts').textContent =
        `live: ${g.enemyCount} enemies · ${g.towers.length} towers · ${g.projectileCount} projectiles · sim ${fmt(simMs, 2)}ms · draw ${fmt(drawMs, 2)}ms`;
      this.$('lab-ver').textContent = this.app.version();
    }
  }

  setBig(id, v, cls, suffix = '') {
    const el = this.$(id);
    el.textContent = fmt(v, suffix ? 1 : 0) + suffix;
    el.className = cls;
  }

  status(t) { this.$('lab-status').textContent = t; }

  newSample(label, cfg, settle, dur) {
    return { label, cfg: { ...cfg }, t: 0, settle, dur, dt: [], sim: [], draw: [], ec: [], pc: [] };
  }

  startBench() {
    if (!this.active) this.apply(this.cfg);
    this.job = { type: 'bench', s: this.newSample('bench', this.cfg, 1000, 5000) };
    this.status(`Benchmarking ${this.cfg.enemies}/${this.cfg.towers}/${this.cfg.projectiles} for 5 s…`);
  }

  startRamp(mode) {
    const steps = RAMP_STEPS.map((f) => mode === 'all'
      ? { enemies: Math.round(TARGET.enemies * f), towers: Math.min(MAX_TOWERS, Math.round(TARGET.towers * f)), projectiles: Math.round(TARGET.projectiles * f) }
      : { enemies: Math.round(TARGET.enemies * f), towers: TARGET.towers, projectiles: TARGET.projectiles });
    this.rampPoints = [];
    this.rampMeta = { mode, version: this.app.version() };
    this.job = { type: 'ramp', steps, i: 0, s: null };
    this.nextRampStep();
  }

  nextRampStep() {
    const job = this.job;
    const cfg = job.steps[job.i];
    this.setSliders(cfg);
    this.apply(cfg);
    job.s = this.newSample('ramp', cfg, 1000, 3000);
    this.status(`Ramp ${job.i + 1}/${job.steps.length}: ${cfg.enemies} enemies · ${cfg.towers} towers · ${cfg.projectiles} projectiles`);
  }

  tickJob(job, dtMs, simMs, drawMs) {
    const s = job.s;
    s.t += dtMs;
    if (s.t < s.settle) return;
    s.dt.push(dtMs); s.sim.push(simMs); s.draw.push(drawMs);
    s.ec.push(this.app.game.enemyCount); s.pc.push(this.app.game.projectileCount);
    if (s.t < s.settle + s.dur) return;

    const r = this.finishSample(s);
    if (job.type === 'bench') {
      this.job = null;
      this.pushResult(r);
      this.status(`Done: ${fmt(r.avgFps, 0)} avg fps, ${fmt(r.fps95, 0)} fps for 95% of frames, ${fmt(r.pctOver33)}% frames over 33 ms.`);
      return;
    }
    this.rampPoints.push(r);
    this.drawChart();
    job.i++;
    const tooSlow = r.fps95 < 10;
    if (job.i < job.steps.length && !tooSlow) { this.nextRampStep(); return; }

    this.job = null;
    const brk = this.rampPoints.find((p) => p.fps95 < 45 || p.pctOver33 > 5);
    const best = [...this.rampPoints].reverse().find((p) => p.fps95 >= 45 && p.pctOver33 <= 5);
    const summary = {
      ...this.rampMeta, label: 'ramp', time: new Date().toISOString(),
      lastPassing: best ? best.cfg : null, breaksAt: brk ? brk.cfg : null,
      points: this.rampPoints.map((p) => ({ ...p.cfg, avgFps: +p.avgFps.toFixed(1), fps95: +p.fps95.toFixed(1), pctOver33: +p.pctOver33.toFixed(1), simMs: +p.simMs.toFixed(2), drawMs: +p.drawMs.toFixed(2) })),
    };
    this.results.push(summary);
    this.save();
    this.renderResults();
    this.drawChart();
    this.status(brk
      ? `Breaks at ${brk.cfg.enemies} enemies / ${brk.cfg.towers} towers / ${brk.cfg.projectiles} projectiles` +
        (best ? ` (last passing: ${best.cfg.enemies}/${best.cfg.towers}/${best.cfg.projectiles})` : '')
      : 'Never broke — passes at every step.');
    window.dispatchEvent(new CustomEvent('lab:ramp-done', { detail: summary }));
  }

  finishSample(s) {
    const st = frameStats(s.dt);
    return {
      ...st, cfg: s.cfg, label: s.label,
      simMs: mean(s.sim), drawMs: mean(s.draw),
      liveEnemies: Math.round(mean(s.ec)), liveProjectiles: Math.round(mean(s.pc)),
    };
  }

  pushResult(r) {
    this.results.push({
      label: 'bench', version: this.app.version(), time: new Date().toISOString(),
      ...r.cfg, liveEnemies: r.liveEnemies, liveProjectiles: r.liveProjectiles,
      avgFps: +r.avgFps.toFixed(1), fps95: +r.fps95.toFixed(1), pctAt45: +r.pctAt45.toFixed(1),
      pctOver33: +r.pctOver33.toFixed(1), p95: +r.p95.toFixed(2), simMs: +r.simMs.toFixed(2), drawMs: +r.drawMs.toFixed(2),
    });
    this.save();
    this.renderResults();
    window.dispatchEvent(new CustomEvent('lab:bench-done', { detail: this.results[this.results.length - 1] }));
  }

  renderResults() {
    const rows = this.results.slice(-8).reverse().map((r) => r.label === 'ramp'
      ? `<tr><td>${r.version}</td><td colspan="5">ramp (${r.mode}): passes ${r.lastPassing ? `${r.lastPassing.enemies}/${r.lastPassing.towers}/${r.lastPassing.projectiles}` : 'nothing'} · breaks ${r.breaksAt ? `${r.breaksAt.enemies}/${r.breaksAt.towers}/${r.breaksAt.projectiles}` : 'never'}</td></tr>`
      : `<tr><td>${r.version}</td><td>${r.enemies}/${r.towers}/${r.projectiles}</td><td>${r.avgFps}</td><td>${r.fps95}</td><td>${r.pctOver33}%</td><td>${r.simMs}+${r.drawMs}</td></tr>`);
    this.$('lab-results').innerHTML = rows.length
      ? `<table><tr><th>build</th><th>E/T/P</th><th>fps</th><th>@95%</th><th>&gt;33</th><th>sim+draw ms</th></tr>${rows.join('')}</table>`
      : '<div class="lab-empty">No runs yet.</div>';
  }

  // ---------- drawing ----------
  drawGraph() {
    const { ctx, w, h } = this.graph;
    const maxMs = 50;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, w, h);
    const bw = w / GRAPH_N;
    // one path per color instead of one fill per bar
    for (const [lo, hi, col] of [[0, FPS45_MS, '#68d391'], [FPS45_MS, 33.4, '#f6e05e'], [33.4, Infinity, '#fc8181']]) {
      ctx.beginPath();
      for (let i = 0; i < GRAPH_N; i++) {
        const v = this.ring[(this.ri + i) % GRAPH_N];
        if (v <= lo || v > hi) continue;
        const bh = Math.min(h, (v / maxMs) * h);
        ctx.rect(i * bw, h - bh, Math.max(1, bw - 0.2), bh);
      }
      ctx.fillStyle = col;
      ctx.fill();
    }
    ctx.font = '9px ui-monospace, monospace';
    for (const [ms, label, lx] of [[16.7, '60', 38], [22.2, '45', 80], [33.3, '30', 38]]) {
      const y = h - (ms / maxMs) * h;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(label + ' fps', w - lx, y - 2);
    }
  }

  drawChart() {
    const { ctx, w, h } = this.chart;
    const pts = this.rampPoints;
    ctx.clearRect(0, 0, w, h);
    if (!pts.length) return;
    const L = 28, R = 6, T = 16, B = 16;
    const pw = w - L - R, ph = h - T - B;
    const maxFps = Math.max(70, ...pts.map((p) => p.avgFps)) * 1.05;
    const X = (i) => L + (pts.length === 1 ? pw / 2 : (i / (pts.length - 1)) * pw);
    const Y = (f) => T + ph - (Math.min(f, maxFps) / maxFps) * ph;

    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(L, T, pw, ph);
    // threshold
    ctx.strokeStyle = 'rgba(252,129,129,0.7)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(L, Y(45)); ctx.lineTo(L + pw, Y(45)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(252,129,129,0.9)';
    ctx.fillText('45', 6, Y(45) + 3);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(Math.round(maxFps / 1.05 / 10) * 10 + '', 6, T + 8);
    ctx.fillText('0', 14, T + ph);

    const brkI = pts.findIndex((p) => p.fps95 < 45 || p.pctOver33 > 5);
    if (brkI >= 0) {
      ctx.fillStyle = 'rgba(252,129,129,0.12)';
      const x0 = brkI > 0 ? (X(brkI - 1) + X(brkI)) / 2 : L;
      ctx.fillRect(x0, T, L + pw - x0, ph);
      ctx.strokeStyle = '#fc8181';
      ctx.beginPath(); ctx.moveTo(X(brkI), T); ctx.lineTo(X(brkI), T + ph); ctx.stroke();
      ctx.fillStyle = '#fc8181';
      const p = pts[brkI].cfg;
      const lbl = `breaks: ${p.enemies}e`;
      ctx.fillText(lbl, Math.max(L, Math.min(X(brkI) + 3, L + pw - ctx.measureText(lbl).width)), T + 10);
    }
    for (const [key, col] of [['avgFps', '#4fd1c5'], ['fps95', '#f6ad55']]) {
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p[key])) : ctx.moveTo(X(i), Y(p[key]))));
      ctx.stroke();
      ctx.fillStyle = col;
      pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(X(i), Y(p[key]), 2.5, 0, Math.PI * 2); ctx.fill(); });
    }
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const stride = Math.ceil(pts.length / 5);
    pts.forEach((p, i) => {
      if (i % stride && i !== pts.length - 1) return;
      const t = p.cfg.enemies >= 1000 ? (p.cfg.enemies / 1000).toFixed(p.cfg.enemies % 1000 ? 1 : 0) + 'k' : String(p.cfg.enemies);
      ctx.fillText(t, X(i) - ctx.measureText(t).width / 2, h - 4);
    });
    ctx.fillStyle = '#4fd1c5'; ctx.fillText('— avg fps', L, 9);
    ctx.fillStyle = '#f6ad55'; ctx.fillText('— fps @95%', L + 58, 9);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillText('x: enemies', L + pw - 52, 9);
  }
}
