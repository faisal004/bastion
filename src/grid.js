// Uniform spatial hash grid over the world, rebuilt every simulation step.
//
// Built with a counting sort into flat typed arrays, so a rebuild is O(n) with no allocation:
//   count[cell]  -> how many enemies are in each cell
//   start[cell]  -> prefix sum: this cell's slice in `items` is [start[cell], start[cell+1])
//   items[]      -> enemy indices, grouped by cell
// A radius query then visits only the cells that the query's bounding box overlaps.
export class SpatialGrid {
  constructor(width, height, cell) {
    this.cell = cell;
    this.inv = 1 / cell;
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    const n = this.cols * this.rows;
    this.count = new Int32Array(n);
    this.start = new Int32Array(n + 1);
    this.cursor = new Int32Array(n);
    this.items = new Int32Array(0);
    this.cellOf = new Int32Array(0);
    // last query's cell rectangle (inclusive), written by rect()
    this.c0 = 0; this.c1 = 0; this.r0 = 0; this.r1 = 0;
  }

  // Entities outside the world (e.g. spawning off-map) are clamped into edge cells;
  // queries always do an exact distance check, so this stays correct.
  cellIndex(x, y) {
    let c = (x * this.inv) | 0, r = (y * this.inv) | 0;
    if (c < 0) c = 0; else if (c >= this.cols) c = this.cols - 1;
    if (r < 0) r = 0; else if (r >= this.rows) r = this.rows - 1;
    return r * this.cols + c;
  }

  build(list) {
    const n = list.length;
    if (this.items.length < n) {
      const cap = Math.max(1024, Math.ceil(n * 1.5));
      this.items = new Int32Array(cap);
      this.cellOf = new Int32Array(cap);
    }
    const count = this.count, cellOf = this.cellOf;
    count.fill(0);
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (!e.alive) { cellOf[i] = -1; continue; }
      const ci = this.cellIndex(e.x, e.y);
      cellOf[i] = ci;
      count[ci]++;
    }
    const start = this.start, cursor = this.cursor;
    let acc = 0;
    for (let c = 0; c < count.length; c++) {
      start[c] = acc;
      cursor[c] = acc;
      acc += count[c];
    }
    start[count.length] = acc;
    const items = this.items;
    for (let i = 0; i < n; i++) {
      const ci = cellOf[i];
      if (ci >= 0) items[cursor[ci]++] = i;
    }
    this.size = n;
  }

  // Sets c0..c1 / r0..r1 to the cells overlapping the circle's bounding box.
  rect(x, y, radius) {
    const inv = this.inv;
    let c0 = ((x - radius) * inv) | 0, c1 = ((x + radius) * inv) | 0;
    let r0 = ((y - radius) * inv) | 0, r1 = ((y + radius) * inv) | 0;
    if (x - radius < 0) c0 = 0;
    if (y - radius < 0) r0 = 0;
    if (c1 >= this.cols) c1 = this.cols - 1;
    if (r1 >= this.rows) r1 = this.rows - 1;
    this.c0 = c0; this.c1 = c1; this.r0 = r0; this.r1 = r1;
  }
}
