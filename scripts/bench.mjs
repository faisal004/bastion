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
const query = args.query ? '&' + args.query : '';
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
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
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
  if (throttle > 1) await send('Emulation.setCPUThrottlingRate', { rate: throttle });
  console.log(`\n${env.version} · ${env.ua} · ${env.gpu} · ${env.viewport}@${env.dpr}x · ${args.headed ? 'headed' : 'headless'}${throttle > 1 ? ` · CPU throttled ${throttle}x` : ''}`);
  env.cpuThrottle = throttle;

  const cadence = await evaluate(`new Promise(res => { const ts = []; const f = t => { ts.push(t); ts.length < 31 ? requestAnimationFrame(f) : res(ts.slice(1).map((t, i) => t - ts[i])); }; requestAnimationFrame(f); })`);
  console.log(`  idle frame cadence: ${(cadence.reduce((a, b) => a + b, 0) / cadence.length).toFixed(1)} ms (${Math.round(1000 / (cadence.reduce((a, b) => a + b, 0) / cadence.length))} Hz)`);

  let result;
  if (mode === 'shots') {
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
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
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
    console.log('\n  enemies  towers  proj   avg fps  fps@95%  >33ms   sim ms  draw ms');
    for (const p of result.points) {
      const ok = p.fps95 >= 45 && p.pctOver33 <= 5;
      console.log(`  ${String(p.enemies).padStart(7)} ${String(p.towers).padStart(7)} ${String(p.projectiles).padStart(5)}` +
        `  ${p.avgFps.toFixed(1).padStart(7)}  ${p.fps95.toFixed(1).padStart(7)}  ${(p.pctOver33.toFixed(1) + '%').padStart(6)}` +
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
    console.log(`  sim ${result.simMs} ms · draw ${result.drawMs} ms per frame\n`);
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
