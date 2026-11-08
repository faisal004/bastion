// Runtime optimization switches. Every optimization can be flipped live (Stress Lab panel)
// or from the URL, so before/after can be shown and measured on the same build.
//   ?baseline                 -> every switch at its first (original) choice
//   ?opt=render:paths         -> override individual switches
export const OPT_DEFS = [
  {
    key: 'render', label: 'Entity drawing',
    choices: ['naive', 'paths', 'sprites', 'webgl'],
    names: { naive: 'naive (path per entity)', paths: 'batched paths', sprites: 'sprite atlas', webgl: 'WebGL2 instanced' },
    best: 'webgl',
  },
  {
    key: 'sim', label: 'Simulation thread', reload: true,
    choices: ['main', 'worker'],
    names: { main: 'main thread (with drawing)', worker: 'Web Worker (parallel)' },
    // Measured, not assumed: the worker did not raise the breaking point on the test machine
    // (see NUMBERS.md section 5), so the main thread stays the default.
    best: 'main',
  },
  {
    key: 'grid', label: 'Range queries',
    choices: ['off', 'on'],
    names: { off: 'scan every enemy', on: 'spatial hash grid' },
    best: 'on',
  },
  {
    key: 'path', label: 'Enemy movement',
    choices: ['scan', 'cached'],
    names: { scan: 'search path each step', cached: 'cached segment' },
    best: 'cached',
  },
  {
    key: 'alloc', label: 'Entity memory',
    choices: ['filter', 'pooled'],
    names: { filter: 'filter() + new objects', pooled: 'pools + in-place compaction' },
    best: 'pooled',
  },
  {
    key: 'glfill', label: 'GPU buffer fill',
    choices: ['buckets', 'counting'],
    names: { buckets: 'bucket arrays, 4 passes', counting: 'counting sort, 2 passes' },
    best: 'counting',
  },
  {
    key: 'cull', label: 'Off-screen culling',
    choices: ['off', 'on'],
    names: { off: 'draw everything', on: 'skip off-screen' },
    best: 'on',
  },
  {
    key: 'bg', label: 'Static ground',
    choices: ['redraw', 'cached'],
    names: { redraw: 'redraw every frame', cached: 'cached layer' },
    best: 'cached',
  },
];

export const opts = {};

export function initOpts(search = location.search) {
  const q = new URLSearchParams(search);
  const baseline = q.has('baseline');
  for (const d of OPT_DEFS) opts[d.key] = baseline ? d.choices[0] : d.best;
  for (const pair of (q.get('opt') || '').split(',').filter(Boolean)) {
    const [k, v] = pair.split(':');
    const d = OPT_DEFS.find((x) => x.key === k);
    if (d && d.choices.includes(v)) opts[k] = v;
  }
  return opts;
}

export function optsLabel() {
  const changed = OPT_DEFS.filter((d) => opts[d.key] !== d.choices[0]).map((d) => `${d.key}=${opts[d.key]}`);
  return changed.length ? changed.join(' ') : 'baseline';
}
