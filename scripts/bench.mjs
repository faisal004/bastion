#!/usr/bin/env node
// Zero-dependency benchmark runner: launches Chrome with a throwaway profile,
// drives the in-game Stress Lab over the DevTools protocol, prints the results.
//
//   node scripts/bench.mjs                         # ramp: find the breaking point
//   node scripts/bench.mjs --mode bench --load 5000,100,1000
//   node scripts/bench.mjs --headed                # real window (real vsync + compositor)
//   options: --url http://localhost:5173  --ramp all|enemies  --out results.json  --dpr 2
//            --cpu 4   (DevTools CPU throttling, e.g. 4 = "4x slowdown" mid-range laptop)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const url = args.url || 'http://localhost:5173';
const mode = args.mode || 'ramp';
const load = (args.load || '5000,100,1000').split(',').map(Number);
const dpr = Number(args.dpr || 2);
const query = (args.query ? '&' + args.query : '') + (Number(args.cpu) > 1 ? `&workercpu=${Number(args.cpu)}` : '');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), 'bastion-bench-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000',
  `--force-device-scale-factor=${dpr}`,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ...(args.headed ? [] : ['--headless=new']),
  `${url}/?lab${query}`,
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch {} setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500); };
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function pageTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.startsWith(url));
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chrome did not start (is the game server running at ' + url + '?)');
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}, sessionId) => new Promise((res) => {
  const id = ++seq; pending.set(id, res);
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
}

try {
  const ready = `new Promise(r => { const w = () => window.bastion ? r() : setTimeout(w, 50); w(); })`;
  for (let i = 0; i < 5; i++) {
    await evaluate(ready);
    await new Promise((r) => setTimeout(r, 1500)); // let the first frames settle (headed windows may reload once)
    if (await evaluate('!!window.bastion')) break;
  }
  const env = await evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return { ua: navigator.userAgent.match(/Chrome\\/[\\d.]+/)?.[0], dpr: devicePixelRatio,
      viewport: innerWidth + 'x' + innerHeight, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown',
      version: window.bastion.lab.app.version() };
  })()`);
  const throttle = Number(args.cpu || 1);
  if (throttle > 1) {
    await send('Emulation.setCPUThrottlingRate', { rate: throttle });
    // DevTools throttling only applies to pages ("not supported for workers"), so the URL carries
    // workercpu=N and the simulation worker emulates the same slowdown itself (see sim-worker.js).
  }
  console.log(`\n${env.version} · ${env.ua} · ${env.gpu} · ${env.viewport}@${env.dpr}x · ${args.headed ? 'headed' : 'headless'}${throttle > 1 ? ` · CPU throttled ${throttle}x (main via DevTools, worker via workercpu)` : ''}`);
  env.cpuThrottle = throttle;

  const cadence = await evaluate(`new Promise(res => { const ts = []; const f = t => { ts.push(t); ts.length < 31 ? requestAnimationFrame(f) : res(ts.slice(1).map((t, i) => t - ts[i])); }; requestAnimationFrame(f); })`);
  console.log(`  idle frame cadence: ${(cadence.reduce((a, b) => a + b, 0) / cadence.length).toFixed(1)} ms (${Math.round(1000 / (cadence.reduce((a, b) => a + b, 0) / cadence.length))} Hz)`);

  let result;
  if (mode === 'clicktest') {
    // Trusted mouse input (Input.dispatchMouseEvent) onto random buildable tiles in the current
    // renderer; every click must place a tower on exactly the tile aimed at.
    await evaluate(`(async () => { await new Promise(r => setTimeout(r, 800)); document.querySelector('[data-act=play]')?.click(); window.bastion.game.gold = 1e6; window.bastion.lab.toggle(false); })()`);
    const targets = await evaluate(`(async () => {
      const b = window.bastion, C = await import('/src/config.js');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const rect = document.getElementById('game').getBoundingClientRect();
      const r3 = b.renderer.is3D ? b.renderer.r3d : null;
      const out = [];
      for (let row = 0; row < C.ROWS; row++) for (let col = 0; col < C.COLS; col++) {
        if (!b.game.canPlace(col, row)) continue;
        let x, y;
        if (r3) { const p = r3.project((col + 0.5) * C.TILE, 0, (row + 0.5) * C.TILE); x = p.x; y = p.y; }
        else { x = ((col + 0.5) * C.TILE - b.cam.x) * b.cam.zoom; y = ((row + 0.5) * C.TILE - b.cam.y) * b.cam.zoom; }
        if (x > 20 && y > 20 && x < rect.width - 20 && y < rect.height - 20) out.push([col, row, rect.left + x, rect.top + y]);
      }
      out.sort(() => Math.random() - 0.5);
      return { mode: r3 ? '3d' : '2d', tiles: out.slice(0, ${Number(args.n || 40)}) };
    })()`);
    let ok = 0; const bad = [];
    for (const [col, row, x, y] of targets.tiles) {
      if (!(await evaluate('window.bastion.view.placing'))) { // '1' toggles, so only press it when not placing
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '1', text: '1' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '1' });
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      const t = await evaluate(`(() => { const t = window.bastion.game.towerAt(${col}, ${row}); return t ? t.type : null; })()`);
      if (t) ok++;
      else bad.push([col, row, await evaluate(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.id || e.className || e.tagName) : null; })()`)]);
    }
    result = { mode: targets.mode, clicks: targets.tiles.length, ok, bad: bad.slice(0, 5) };
    console.log(`  ${result.mode}: ${ok}/${result.clicks} clicks placed a tower on the intended tile${bad.length ? ' · misses: ' + JSON.stringify(result.bad) : ''}`);
  } else if (mode === 'phases') {
    // Where does draw time go? Hold a load, then average the renderer's per-phase timers.
    result = await evaluate(`(async () => {
      const b = window.bastion;
      b.lab.setSliders({ enemies: ${load[0]}, towers: ${load[1]}, projectiles: ${load[2]} }); b.lab.apply(b.lab.cfg);
      ${args.zoom ? `b.cam.zoom = ${Number(args.zoom)}; b.cam.x = ${Number(args.camx || 300)}; b.cam.y = ${Number(args.camy || 200)};` : ''}
      await new Promise(r => setTimeout(r, 2000));
      const P = b.renderer.prof; for (const k in P) P[k] = 0;
      const P3 = b.renderer.r3d && b.renderer.r3d.prof; if (P3) for (const k in P3) P3[k] = 0;
      await new Promise(r => setTimeout(r, 4000));
      const out = { frames: P.frames, effects: b.game.effects.length };
      for (const k of ['ground', 'towers', 'entities', 'effects']) out[k] = +(P[k] / P.frames).toFixed(2);
      if (P3 && P3.frames) { out.fill3d = +(P3.fill / P3.frames).toFixed(2); out.render3d = +(P3.render / P3.frames).toFixed(2);
        const info = b.renderer.r3d.renderer.info.render; out.calls = info.calls; }
      return out;
    })()`);
    if (result.fill3d !== undefined) console.log(`  ${load.join('/')}: 3D per frame — instance fill ${result.fill3d} ms · three.js render ${result.render3d} ms (${result.frames} frames)`);
    else console.log(`  ${load.join('/')}: per frame — ground ${result.ground} ms · towers ${result.towers} ms · entities ${result.entities} ms · effects+overlay ${result.effects} ms (${result.frames} frames)`);
  } else if (mode === 'shots') {
    // Same paused scene rendered once per choice of one switch: --opt-key render
    const key = args['opt-key'] || 'render';
    const choices = await evaluate(`(async () => {
      const b = window.bastion; const { OPT_DEFS } = await import('/src/opts.js');
      b.lab.setSliders({ enemies: ${load[0]}, towers: ${load[1]}, projectiles: ${load[2]} }); b.lab.apply(b.lab.cfg);
      await new Promise(r => setTimeout(r, 1500));
      b.lab.toggle(false); b.ctl.paused = true;
      document.head.insertAdjacentHTML('beforeend', '<style>#overlay,#perf,#toasts{display:none!important}</style>');
      b.cam.zoom = ${Number(args.zoom || 2.4)}; b.cam.x = ${Number(args.camx || 100)}; b.cam.y = ${Number(args.camy || 60)};
      return OPT_DEFS.find(d => d.key === ${JSON.stringify(key)}).choices;
    })()`);
    for (const c of choices) {
      await evaluate(`(async () => { (await import('/src/opts.js')).opts[${JSON.stringify(key)}] = ${JSON.stringify(c)};
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
      const rect = await evaluate(`(() => { const r = document.getElementById('game').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      if (args.select) await evaluate(`(() => { const b = window.bastion; const t = b.game.towers.find((x) => x.type === ${JSON.stringify(args.select)}); b.view.selected = t; })()`);
      if (args.select) await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      const shot = await send('Page.captureScreenshot', args.full ? { format: 'png' } : { format: 'png', clip: { ...rect, scale: 1 } });
      const file = `${args.dir || 'docs'}/${key}-${c}.png`;
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      console.log(`  ${file}`);
    }
  } else if (mode === 'ramp') {
    await evaluate(`window.__rampDone = null; window.addEventListener('lab:ramp-done', e => (window.__rampDone = e.detail), { once: true });
      window.bastion.lab.startRamp(${JSON.stringify(args.ramp || 'all')}); true`);
    let shown = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await evaluate(`({ done: window.__rampDone, n: window.bastion.lab.rampPoints.length, status: document.getElementById('lab-status').textContent })`);
      if (s.n > shown) { shown = s.n; process.stderr.write(`  · ${s.status}\n`); }
      if (s.done) { result = s.done; break; }
    }
    console.log('\n  enemies  towers  proj   avg fps  fps@95%  >33ms  sim speed   sim ms  draw ms');
    for (const p of result.points) {
      const ok = p.fps95 >= 45 && p.pctOver33 <= 5 && !(p.simSpeed < 0.95);
      console.log(`  ${String(p.enemies).padStart(7)} ${String(p.towers).padStart(7)} ${String(p.projectiles).padStart(5)}` +
        `  ${p.avgFps.toFixed(1).padStart(7)}  ${p.fps95.toFixed(1).padStart(7)}  ${(p.pctOver33.toFixed(1) + '%').padStart(6)}  ${((p.simSpeed * 100).toFixed(0) + '%').padStart(8)}` +
        `  ${p.simMs.toFixed(2).padStart(7)}  ${p.drawMs.toFixed(2).padStart(7)}  ${ok ? 'pass' : 'FAIL'}`);
    }
    const f = (c) => (c ? `${c.enemies} enemies / ${c.towers} towers / ${c.projectiles} projectiles` : 'none');
    console.log(`\n  last passing: ${f(result.lastPassing)}\n  breaks at:    ${f(result.breaksAt)}\n`);
  } else {
    result = await evaluate(`new Promise(res => {
      const lab = window.bastion.lab;
      window.addEventListener('lab:bench-done', e => res(e.detail), { once: true });
      lab.setSliders({ enemies: ${load[0]}, towers: ${load[1]}, projectiles: ${load[2]} });
      lab.apply(lab.cfg);
      lab.startBench();
    })`);
    console.log(`\n  load ${result.enemies}/${result.towers}/${result.projectiles} (live ${result.liveEnemies} enemies, ${result.liveProjectiles} projectiles)`);
    console.log(`  avg ${result.avgFps} fps · 95% of frames ≥ ${result.fps95} fps · ${result.pctAt45}% frames ≥45fps · ${result.pctOver33}% frames >33ms`);
    console.log(`  sim ${result.simMs} ms · draw ${result.drawMs} ms per frame · sim speed ${(result.simSpeed * 100).toFixed(0)}% of real time\n`);
  }
  if (args.out) writeFileSync(args.out, JSON.stringify({ env, mode, result }, null, 2));
  if (args.shot) {
    // re-apply the breaking load so the screenshot shows the game struggling next to the ramp chart
    if (mode === 'ramp' && result.breaksAt) {
      await evaluate(`(() => { const l = window.bastion.lab; const c = ${JSON.stringify(result.breaksAt)}; l.setSliders(c); l.apply(c); })()`);
      await new Promise((r) => setTimeout(r, 2500));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(args.shot, Buffer.from(shot.result.data, 'base64'));
    console.log(`  screenshot: ${args.shot}`);
  }
} finally {
  ws.close();
  cleanup();
}
