// WebGL2 instanced renderer for the high-count entities: enemies, health bars, slow rings
// and projectiles. Everything goes into ONE interleaved typed array that is uploaded once per
// frame and drawn with ONE instanced draw call, whatever the entity count.
//
// Instance layout (36 bytes): rect x,y,w,h (world) | uv u0,v0,u1,v1 | rgba8 tint (premultiplied)
// Sprites come from a texture atlas painted with the same code as the Canvas 2D renderer.
import * as C from './config.js';
import { DIRS, dirIndex, paintEnemy, spriteHalf } from './shapes.js';

const TILE = C.TILE;
const TAU = Math.PI * 2;
const STRIDE = 9; // floats per instance
const LAYER_ORDER = ['swarm', 'runner', 'grunt', 'tank', 'boss', 'flyer'];
const ATLAS = 2048;

const VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec4 a_uv;
layout(location=3) in vec4 a_color;
uniform vec2 u_cam;
uniform float u_scale;
uniform vec2 u_view;
out vec2 v_uv;
out vec4 v_color;
void main() {
  vec2 world = a_rect.xy + a_corner * a_rect.zw;
  vec2 clip = (world - u_cam) * u_scale / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_color = a_color;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
out vec4 o;
void main() { o = texture(u_tex, v_uv) * v_color; }`;

// Pack an rgba color (0-255, alpha 0-1) as premultiplied little-endian RGBA8.
function pack(r, g, b, a = 1) {
  const A = Math.round(a * 255);
  return ((Math.round(r * a)) | (Math.round(g * a) << 8) | (Math.round(b * a) << 16) | (A << 24)) >>> 0;
}
const WHITE = pack(255, 255, 255);
const BAR_BG = pack(0, 0, 0, 0.6);
const BAR_COLORS = [pack(0x68, 0xd3, 0x91), pack(0xf6, 0xe0, 0x5e), pack(0xfc, 0x81, 0x81)];

export class GLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return;
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; });
    canvas.addEventListener('webglcontextrestored', () => this.init());
    this.init();
  }

  init() {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uCam = gl.getUniformLocation(prog, 'u_cam');
    this.uScale = gl.getUniformLocation(prog, 'u_scale');
    this.uView = gl.getUniformLocation(prog, 'u_view');

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    const B = STRIDE * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, B, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, B, 16); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, B, 32); gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture();
    this.atlasQ = 0;
    this.capacity = 0;
    this.grow(16384);
    this.buckets = Object.fromEntries(LAYER_ORDER.map((k) => [k, []]));
    this.ok = true;
  }

  grow(n) {
    this.capacity = n;
    this.f32 = new Float32Array(n * STRIDE);
    this.u32 = new Uint32Array(this.f32.buffer);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.f32.byteLength, gl.DYNAMIC_DRAW);
  }

  resize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  // ---------- atlas ----------
  // Rebuilt only when the camera scale crosses a 0.5 step, so sprites stay crisp when zooming.
  ensureAtlas(scale) {
    const q = Math.min(4, Math.max(0.5, Math.ceil(scale * 2) / 2));
    if (q === this.atlasQ) return;
    this.atlasQ = q;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(ATLAS, ATLAS) : Object.assign(document.createElement('canvas'), { width: ATLAS, height: ATLAS });
    const g = cv.getContext('2d');
    const entries = new Map();
    let x = 1, y = 1, rowH = 0;
    const add = (key, half, paint) => {
      const px = Math.ceil(half * 2 * q);
      if (x + px + 1 > ATLAS) { x = 1; y += rowH + 2; rowH = 0; }
      g.save();
      g.translate(x, y);
      g.scale(px / (half * 2), px / (half * 2));
      g.translate(half, half);
      paint(g);
      g.restore();
      entries.set(key, { u0: x / ATLAS, v0: y / ATLAS, u1: (x + px) / ATLAS, v1: (y + px) / ATLAS, h: half });
      x += px + 2;
      rowH = Math.max(rowH, px);
    };
    // solid texel for bars: sample the middle of a small white square
    g.fillStyle = '#fff';
    g.fillRect(x, y, 4, 4);
    entries.set('white', { u0: (x + 2) / ATLAS, v0: (y + 2) / ATLAS, u1: (x + 2) / ATLAS, v1: (y + 2) / ATLAS, h: 0 });
    x += 6;
    for (const type of LAYER_ORDER) {
      const def = C.ENEMIES[type];
      const dirs = def.shape === 'triangle' ? 4 : 1;
      for (const hit of [false, true]) for (let d = 0; d < dirs; d++) {
        add(type + (hit ? '!' : '') + d, spriteHalf(def), (c) => paintEnemy(c, def, hit, d));
      }
      const rr = def.radius * TILE + 3;
      add('ring:' + type, rr + 2, (c) => {
        c.strokeStyle = 'rgba(144,205,244,0.85)'; c.lineWidth = 1.5;
        c.beginPath(); c.arc(0, 0, rr, 0, TAU); c.stroke();
      });
    }
    add('bullet', 3.5, (c) => { c.fillStyle = '#b2f5ea'; c.beginPath(); c.arc(0, 0, 2.5, 0, TAU); c.fill(); });
    add('shell', 6, (c) => {
      c.fillStyle = '#1a202c'; c.beginPath(); c.arc(0, 0, 5, 0, TAU); c.fill();
      c.fillStyle = '#f6ad55'; c.beginPath(); c.arc(0, 0, 3, 0, TAU); c.fill();
    });
    this.entries = entries;
    this.spriteKeys = {};
    for (const type of LAYER_ORDER) {
      this.spriteKeys[type] = [0, 1, 2, 3].map((d) => entries.get(type + d) || entries.get(type + '0'));
      this.spriteKeys[type + '!'] = [0, 1, 2, 3].map((d) => entries.get(type + '!' + d) || entries.get(type + '!0'));
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // ---------- per frame ----------
  draw(game, cam, scale, alpha) {
    const gl = this.gl;
    this.ensureAtlas(scale);
    const enemies = game.enemies, projectiles = game.projectiles;
    const need = enemies.length * 4 + projectiles.length + 16;
    if (need > this.capacity) this.grow(Math.ceil(need * 1.5));
    const f = this.f32, u = this.u32;
    let n = 0;
    const put = (x, y, w, h, e, color) => {
      const o = n * STRIDE;
      f[o] = x; f[o + 1] = y; f[o + 2] = w; f[o + 3] = h;
      f[o + 4] = e.u0; f[o + 5] = e.v0; f[o + 6] = e.u1; f[o + 7] = e.v1;
      u[o + 8] = color;
      n++;
    };

    // enemies, bucketed into layer order; hit-flash variants go last so they read on top
    const B = this.buckets;
    for (const k of LAYER_ORDER) B[k].length = 0;
    for (let i = 0; i < enemies.length; i++) B[enemies[i].type].push(enemies[i]);
    for (let pass = 0; pass < 2; pass++) {
      for (const type of LAYER_ORDER) {
        const list = B[type];
        if (!list.length) continue;
        const normal = this.spriteKeys[type], hitK = this.spriteKeys[type + '!'];
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if ((e.hitT > 0) !== (pass === 1)) continue;
          const s = (pass ? hitK : normal)[dirIndex(e)];
          const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
          put(x - s.h, y - s.h, s.h * 2, s.h * 2, s, WHITE);
        }
      }
    }
    // slow rings
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.slowT <= 0) continue;
      const s = this.entries.get('ring:' + e.type);
      const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
      put(x - s.h, y - s.h, s.h * 2, s.h * 2, s, WHITE);
    }
    // health bars
    const white = this.entries.get('white');
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.hp >= e.maxHp) continue;
      const r = e.def.radius * TILE, w = Math.max(14, r * 2.2);
      const x = e.px + (e.x - e.px) * alpha, y = e.py + (e.y - e.py) * alpha;
      const fr = Math.max(0, e.hp / e.maxHp);
      put(x - w / 2 - 1, y - r - 9, w + 2, 5, white, BAR_BG);
      put(x - w / 2, y - r - 8, w * fr, 3, white, BAR_COLORS[fr > 0.5 ? 0 : fr > 0.25 ? 1 : 2]);
    }
    // projectiles
    const bullet = this.entries.get('bullet'), shell = this.entries.get('shell');
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      const s = p.kind === 'shell' ? shell : bullet;
      const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha;
      put(x - s.h, y - s.h, s.h * 2, s.h * 2, s, WHITE);
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!n) return n;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.uniform2f(this.uCam, cam.x, cam.y);
    gl.uniform1f(this.uScale, scale);
    gl.uniform2f(this.uView, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f, 0, n * STRIDE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
    return n;
  }

  clear() {
    if (!this.ok) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

export { DIRS };
