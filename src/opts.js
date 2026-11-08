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
