// 3D renderer (three.js, vendored). Reads game state, never mutates it.
//
// Units: 1 world unit = 1 tile. Game x -> world x, game y -> world z, up is +y.
// Performance rules carried over from the 2D WebGL renderer:
//   * every high-count thing (enemies, shadows, bars, projectiles, tower parts, effects) is ONE
//     InstancedMesh, filled by writing straight into its typed arrays (no per-entity objects,
//     no Object3D, no setMatrixAt) and uploaded with an explicit update range;
//   * off-screen enemies and projectiles are culled against the ground footprint of the view;
//   * death bursts are GPU particles: the CPU writes 7 particles once per death, the vertex
//     shader animates them, so a particle costs nothing per frame on the CPU.
// "Soul" lives in a few custom shaders: procedural terrain + road, wind-blown grass, the
// spawn portal, glowing rings, particles, and a grading/vignette pass after bloom.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as C from './config.js';
import { opts } from './opts.js';

const T = C.TILE;
const LAYERS = ['swarm', 'runner', 'grunt', 'tank', 'boss', 'flyer'];
const FOV = 36, PITCH = (55 * Math.PI) / 180;
const PARTICLE_CAP = 32768, PARTICLE_LIFE = 0.75;
const CORNERS = [-1, -1, 1, -1, -1, 1, 1, 1];
const lin = (hex) => new THREE.Color(hex); // three converts sRGB hex to linear
// Parsed-color cache: effects carry CSS color strings, and parsing one per effect per frame
// (regex + temporaries) was a steady source of GC hitches.
const COLOR_CACHE = new Map();
const cachedColor = (css) => { let c = COLOR_CACHE.get(css); if (!c) { c = new THREE.Color(css); COLOR_CACHE.set(css, c); } return c; };

// ---------- shared GLSL ----------
const NOISE = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
`;

// ---------- small helpers ----------
// Column-major TRS with a yaw: local +X faces (fx, fz). Writes 16 floats at instance i.
function setYaw(M, i, x, y, z, fx, fz, sx, sy, sz) {
  const o = i * 16;
  M[o] = fx * sx; M[o + 1] = 0; M[o + 2] = fz * sx; M[o + 3] = 0;
  M[o + 4] = 0; M[o + 5] = sy; M[o + 6] = 0; M[o + 7] = 0;
  M[o + 8] = -fz * sz; M[o + 9] = 0; M[o + 10] = fx * sz; M[o + 11] = 0;
  M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
}
// Camera-facing quad (health bars): R = camera right/up/back basis.
function setBill(M, i, x, y, z, R, w, h) {
  const o = i * 16;
  M[o] = R[0] * w; M[o + 1] = R[1] * w; M[o + 2] = R[2] * w; M[o + 3] = 0;
  M[o + 4] = R[3] * h; M[o + 5] = R[4] * h; M[o + 6] = R[5] * h; M[o + 7] = 0;
  M[o + 8] = R[6]; M[o + 9] = R[7]; M[o + 10] = R[8]; M[o + 11] = 0;
  M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
}
function setRGB(Cc, i, r, g, b) { const o = i * 3; Cc[o] = r; Cc[o + 1] = g; Cc[o + 2] = b; }

// One InstancedMesh that grows on demand; written via its raw arrays.
class Batch {
  constructor(scene, geo, mat, cap, { color = true, shadow = false, order = 0 } = {}) {
    Object.assign(this, { scene, geo, mat, colorOn: color, shadow, order });
    this.make(cap);
  }
  make(cap) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); }
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.frustumCulled = false; // culled per instance by the fill loop instead
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (this.colorOn) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    m.castShadow = this.shadow;
    m.renderOrder = this.order;
    m.count = 0;
    this.scene.add(m);
    this.mesh = m; this.cap = cap;
    this.M = m.instanceMatrix.array;
    this.Cc = this.colorOn ? m.instanceColor.array : null;
  }
  ensure(n) { if (n > this.cap) this.make(Math.max(n, this.cap * 2)); } // rare; doubles
  commit(n) {
    const m = this.mesh;
    m.count = n;
    if (!n) return;
    const im = m.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, n * 16); im.needsUpdate = true;
    if (this.Cc) { const ic = m.instanceColor; ic.clearUpdateRanges(); ic.addUpdateRange(0, n * 3); ic.needsUpdate = true; }
  }
}

// Merge simple geometries into one, with a per-part vertex color (no BufferGeometryUtils needed).
function merged(parts) {
  const pos = [], nor = [], col = [];
  for (const { geo, color, m } of parts) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone());
    if (m) g.applyMatrix4(m);
    g.computeVertexNormals();
    const c = lin(color);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]); nor.push(n[i], n[i + 1], n[i + 2]); col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
const mtx = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));

function radialTexture(inner = 'rgba(0,0,0,1)', outer = 'rgba(0,0,0,0)') {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    let r;
    try {
      r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    } catch { return; }
    this.renderer = r;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.info.autoReset = false; // count draw calls across every composer pass, reset once per frame
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = (this.scene = new THREE.Scene());
    const sky = lin('#0f2219');
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, 34, 78);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 220);
    this.clock = 0;           // real seconds (ambient animation)
    this.uTime = { value: 0 }; // shared by animated shaders
    this.lastFxTime = -1;
    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.tmpV = new THREE.Vector3(); this.tmpV2 = new THREE.Vector2();
    this.R = new Float32Array(9);
    this.pointScale = { value: 400 }; // px per world unit at distance 1 (set in resize), shared by point shaders
    this.view = { x0: -1e9, z0: -1e9, x1: 1e9, z1: 1e9 };
    this.prof = { frames: 0, fill: 0, render: 0 }; // JS time: our instance fill vs three.js render (read by bench --mode phases)

    this.buildLights();
    this.built = false;
    this.ok = true;
  }

  // ---------- one-time scene construction (needs the map, so done on first draw) ----------
  build(game) {
    this.built = true;
    this.buildGround(game);
    this.buildDecor(game);
    this.buildFortress(game);
    this.buildPortal(game);
    this.buildEntities();
    this.buildTowers();
    this.buildEffects();
    this.buildOverlays();
    this.buildPost();
    this.renderer.compile(this.scene, this.camera); // no shader-compile hitch on first use
  }

  buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(lin('#bcd9ff'), lin('#2d3b22'), 1.25));
    const sun = (this.sun = new THREE.DirectionalLight(lin('#ffe7c4'), 2.6));
    const cx = C.COLS / 2, cz = C.ROWS / 2;
    sun.position.set(cx - 14, 26, cz + 16);
    sun.target.position.set(cx, 0, cz);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -26; sc.right = 26; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 70;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
    s.add(sun, sun.target);
  }

  buildGround(game) {
    const W = C.COLS + 40, H = C.ROWS + 40;
    const geo = new THREE.PlaneGeometry(W, H, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(C.COLS / 2, 0, C.ROWS / 2);
    const segs = game.path.slice(0, -1).map((a, i) => {
      const b = game.path[i + 1];
      return new THREE.Vector4(a.x / T, a.y / T, b.x / T, b.y / T);
    });
    const u = (this.groundU = {
      uSegs: { value: segs }, uTime: this.uTime,
      uGrid: { value: 0 }, uHover: { value: new THREE.Vector3(0, 0, 0) }, uHoverCol: { value: new THREE.Color() },
      uMap: { value: new THREE.Vector2(C.COLS, C.ROWS) },
    });
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWorld;
uniform vec4 uSegs[${segs.length}];
uniform float uTime; uniform float uGrid; uniform vec3 uHover; uniform vec3 uHoverCol; uniform vec2 uMap;
${NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 p = vWorld.xz;
  // distance to the road polyline
  float d = 1e3;
  for (int i = 0; i < ${segs.length}; i++) {
    vec2 a = uSegs[i].xy, b = uSegs[i].zw, pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    d = min(d, length(pa - ba * h));
  }
  vec2 edge2 = min(p, uMap - p);
  float inside = smoothstep(-0.9, 0.3, min(edge2.x, edge2.y) + (vnoise(p * 1.7) - 0.5) * 0.8);
  // grass: two greens + dry patches + fine speckle
  float n = fbm(p * 0.45), n2 = vnoise(p * 6.0), dry = smoothstep(0.55, 0.85, fbm(p * 0.11 + 7.0));
  vec3 grass = mix(srgb(vec3(0.15, 0.30, 0.17)), srgb(vec3(0.24, 0.42, 0.22)), n);
  grass = mix(grass, srgb(vec3(0.40, 0.42, 0.22)), dry * 0.55);
  grass *= 0.85 + 0.3 * n2;
  float chk = mod(floor(p.x) + floor(p.y), 2.0);
  grass *= 1.0 + (chk - 0.5) * 0.06 * inside;
  // road: packed dirt, worn darker in the middle, wobbly edge
  float wob = (fbm(p * 2.5) - 0.5) * 0.12;
  float road = smoothstep(0.47, 0.40, d + wob);
  vec3 dirt = mix(srgb(vec3(0.42, 0.33, 0.22)), srgb(vec3(0.52, 0.42, 0.28)), vnoise(p * 3.0));
  dirt *= 0.82 + 0.18 * smoothstep(0.0, 0.32, d);
  dirt *= 0.9 + 0.2 * vnoise(p * 14.0);
  vec3 col = mix(grass, dirt, road);
  col *= 1.0 - 0.35 * smoothstep(0.07, 0.0, abs(d + wob - 0.44)); // dark lip along the road edge
  col *= mix(0.62, 1.0, inside);
  if (uGrid > 0.5) {
    vec2 g = abs(fract(p) - 0.5);
    col = mix(col, vec3(1.0), smoothstep(0.46, 0.5, max(g.x, g.y)) * 0.10 * inside);
  }
  if (uHover.z > 0.5) {
    vec2 q = p - uHover.xy;
    float inTile = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
    col = mix(col, uHoverCol, inTile * 0.45);
  }
  diffuseColor.rgb = col;
}`);
    };
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  buildDecor(game) {
    const rnd = C.mulberry32(99);
    // rocks (blocking tiles), flat-shaded
    const rockGeo = new THREE.DodecahedronGeometry(0.34, 0);
    const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: lin('#5b6573'), flatShading: true, roughness: 0.9 }), game.rocks.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    game.rocks.forEach((k, i) => {
      e.set(rnd() * 3, k.rot, rnd() * 3);
      m.compose(new THREE.Vector3(k.c + 0.5, 0.12, k.r + 0.5), q.setFromEuler(e), new THREE.Vector3(k.s * 1.5, k.s, k.s * 1.4));
      rocks.setMatrixAt(i, m);
    });
    rocks.castShadow = rocks.receiveShadow = true;
    this.scene.add(rocks);

    // wind-blown grass blades (custom vertex shader on a standard material)
    const blade = new THREE.BufferGeometry();
    blade.setAttribute('position', new THREE.Float32BufferAttribute([-0.035, 0, 0, 0.035, 0, 0, 0, 0.32, 0], 3));
    blade.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    const bladeMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 1 });
    bladeMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vec3 root = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
  float k = position.y / 0.32;
  float sway = sin(uTime * 1.6 + root.x * 0.7 + root.z * 0.45) * 0.10 + sin(uTime * 3.7 + root.x * 2.1) * 0.03;
  transformed.x += sway * k * k;
  transformed.z += sway * 0.4 * k * k;`);
    };
    const blades = [];
    const g = game.baseGrid;
    for (let i = 0; i < 9000 && blades.length < 5200; i++) {
      const x = rnd() * C.COLS, z = rnd() * C.ROWS;
      const v = g[(z | 0) * C.COLS + (x | 0)];
      if (v === 1 || v === 3) continue;
      blades.push([x, z]);
    }
    const grass = new THREE.InstancedMesh(blade, bladeMat, blades.length);
    const gc = new THREE.Color();
    blades.forEach(([x, z], i) => {
      m.compose(new THREE.Vector3(x, 0, z), q.setFromEuler(e.set(0, rnd() * Math.PI, 0)), new THREE.Vector3(1, 0.45 + rnd() * 0.6, 1));
      grass.setMatrixAt(i, m);
      grass.setColorAt(i, gc.setHSL(0.25 + rnd() * 0.07, 0.55, 0.10 + rnd() * 0.07));
    });
    grass.receiveShadow = true;
    this.scene.add(grass);

    // low-poly trees framing the map (outside the playable area)
    const trees = [];
    for (let i = 0; i < 600 && trees.length < 110; i++) {
      const x = -9 + rnd() * (C.COLS + 18), z = -9 + rnd() * (C.ROWS + 18);
      if (x > -1.2 && x < C.COLS + 1.2 && z > -1.2 && z < C.ROWS + 1.2) continue;
      trees.push([x, z, 0.7 + rnd() * 0.8]);
    }
    const crownGeo = new THREE.ConeGeometry(0.75, 1.8, 6); crownGeo.translate(0, 1.6, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.12, 0.16, 0.8, 5); trunkGeo.translate(0, 0.4, 0);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: lin('#1f4a2c'), flatShading: true }), trees.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: lin('#4a3524'), flatShading: true }), trees.length);
    trees.forEach(([x, z, s], i) => {
      m.compose(new THREE.Vector3(x, 0, z), q.setFromEuler(e.set(0, rnd() * 6, 0)), new THREE.Vector3(s, s * (0.9 + rnd() * 0.4), s));
      crowns.setMatrixAt(i, m); trunks.setMatrixAt(i, m);
      crowns.setColorAt(i, gc.setHSL(0.36 + rnd() * 0.05, 0.4, 0.13 + rnd() * 0.07));
    });
    crowns.castShadow = trunks.castShadow = true;
    this.scene.add(crowns, trunks);

    // drifting motes / fireflies: animated entirely in the vertex shader
    const N = 260, mp = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) { mp[i * 3] = rnd() * C.COLS; mp[i * 3 + 1] = 0.3 + rnd() * 2.2; mp[i * 3 + 2] = rnd() * C.ROWS; seed[i] = rnd() * 100; }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const motes = new THREE.Points(mg, new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uScale: this.pointScale },
      vertexShader: /* glsl */ `
        attribute float aSeed; uniform float uTime; uniform float uScale; varying float vA;
        void main() {
          vec3 p = position + vec3(sin(uTime * 0.3 + aSeed) * 0.6, sin(uTime * 0.7 + aSeed * 2.0) * 0.25, cos(uTime * 0.25 + aSeed) * 0.6);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vA = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 1.3 + aSeed * 7.0), 3.0);
          gl_PointSize = 0.09 * uScale / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
          float a = (1.0 - r) * vA; gl_FragColor = vec4(vec3(1.0, 0.85, 0.45) * a * 1.6, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    motes.frustumCulled = false;
    this.scene.add(motes);
  }

  buildFortress(game) {
    const b = game.base, x = b.x / T, z = b.y / T;
    const stone = new THREE.MeshStandardMaterial({ color: lin('#5a6372'), flatShading: true, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: lin('#3a4150'), flatShading: true, roughness: 0.9 });
    const roof = new THREE.MeshStandardMaterial({ color: lin('#8b3a3a'), flatShading: true, roughness: 0.7 });
    const f = (this.fortress = new THREE.Group());
    f.position.set(x, 0, z);
    const add = (geo, mat, px, py, pz) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.castShadow = m.receiveShadow = true; f.add(m); return m; };
    add(new THREE.BoxGeometry(2.6, 0.5, 2.6), dark, 0, 0.25, 0);
    add(new THREE.BoxGeometry(1.5, 1.3, 1.5), stone, 0, 1.15, 0);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      add(new THREE.CylinderGeometry(0.32, 0.38, 1.7, 8), stone, dx * 1.05, 0.85, dz * 1.05);
      add(new THREE.ConeGeometry(0.45, 0.7, 8), roof, dx * 1.05, 2.05, dz * 1.05);
    }
    this.coreMat = new THREE.MeshStandardMaterial({ color: lin('#ffd166'), emissive: lin('#ffb020'), emissiveIntensity: 2.5, roughness: 0.3 });
    this.core = add(new THREE.IcosahedronGeometry(0.42, 0), this.coreMat, 0, 2.35, 0);
    this.core.castShadow = false;
    this.coreLight = new THREE.PointLight(lin('#ffbf55'), 6, 9, 1.6);
    this.coreLight.position.set(0, 2.4, 0);
    f.add(this.coreLight);
    this.scene.add(f);
  }

  buildPortal(game) {
    const p = game.path[1], z = p.y / T;
    const g = (this.portal = new THREE.Group());
    g.position.set(0.15, 0, z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.09, 8, 32),
      new THREE.MeshStandardMaterial({ color: lin('#6b46c1'), emissive: lin('#9f7aea'), emissiveIntensity: 2.2 }));
    ring.rotation.y = Math.PI / 2; ring.position.y = 0.95;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.8, 40), new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUv; ${NOISE}
        void main() {
          vec2 c = vUv - 0.5; float r = length(c) * 2.0; float a = atan(c.y, c.x);
          float swirl = fbm(vec2(a * 1.6 + r * 4.0 - uTime * 2.2, r * 3.0 - uTime * 0.6));
          vec3 col = mix(vec3(0.35, 0.12, 0.8), vec3(1.0, 0.55, 1.0), swirl) * (1.4 - r);
          float alpha = smoothstep(1.0, 0.6, r) * (0.55 + 0.45 * swirl);
          gl_FragColor = vec4(col * alpha * 1.8, alpha);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    disc.rotation.y = Math.PI / 2; disc.position.y = 0.95;
    g.add(ring, disc);
    this.scene.add(g);
  }

  buildEntities() {
    const s = this.scene;
    const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.55, metalness: 0.05 });
    const geos = {
      grunt: new THREE.IcosahedronGeometry(1, 1),
      runner: new THREE.ConeGeometry(0.75, 2.4, 5).rotateZ(-Math.PI / 2),
      tank: new THREE.BoxGeometry(2.0, 1.25, 1.7),
      swarm: new THREE.TetrahedronGeometry(1.25),
      flyer: new THREE.OctahedronGeometry(1.15),
      boss: new THREE.CylinderGeometry(1.0, 1.1, 1.5, 6),
    };
    this.enemyB = LAYERS.map((t) => new Batch(s, geos[t], mat, 4096, { color: true }));
    this.enemyColor = LAYERS.map((t) => lin(C.ENEMIES[t].color));
    this.enemyR = LAYERS.map((t) => C.ENEMIES[t].radius * 0.88);
    this.enemyLift = { grunt: 1.0, runner: 0.75, tank: 0.62, swarm: 0.9, flyer: 2.6, boss: 0.75 };
    this.layerOf = Object.fromEntries(LAYERS.map((t, i) => [t, i]));

    const flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadowB = new Batch(s, flat, new THREE.MeshBasicMaterial({ map: radialTexture('rgba(0,0,0,0.55)'), transparent: true, depthWrite: false }), 16384, { color: false, order: 1 });
    const bar = new THREE.PlaneGeometry(1, 1);
    this.barBgB = new Batch(s, bar, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.65, depthTest: false, depthWrite: false, toneMapped: false }), 16384, { color: false, order: 20 });
    this.barFgB = new Batch(s, bar, new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false }), 16384, { color: true, order: 21 });
    this.barCols = ['#68d391', '#f6e05e', '#fc8181'].map(lin);

    const glow = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.bulletB = new Batch(s, new THREE.SphereGeometry(1, 8, 6), glow, 4096, { color: false });
    glow.color = lin('#b2f5ea').multiplyScalar(1.5);
    const shellMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    shellMat.color = lin('#f6ad55').multiplyScalar(1.6);
    this.shellB = new Batch(s, new THREE.SphereGeometry(1, 10, 8), shellMat, 256, { color: false });
    this.ice = lin('#90cdf4');
  }

  buildTowers() {
    const s = this.scene;
    const base = merged([
      { geo: new THREE.BoxGeometry(0.88, 0.32, 0.88), color: '#2d3748', m: mtx(0, 0.16, 0) },
      { geo: new THREE.BoxGeometry(0.72, 0.08, 0.72), color: '#4a5568', m: mtx(0, 0.36, 0) },
    ]);
    const vmat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.2 });
    this.baseB = new Batch(s, base, vmat, 256, { color: false, shadow: true });
    // a ring of the tower's color around the top plate (instance-colored)
    this.trimB = new Batch(s, new THREE.TorusGeometry(0.36, 0.035, 4, 4).rotateX(Math.PI / 2).rotateY(Math.PI / 4),
      new THREE.MeshStandardMaterial({ roughness: 0.4, emissive: 0x000000 }), 256, { color: true });
    const dark = '#1a202c';
    const heads = {
      blaster: merged([
        { geo: new THREE.SphereGeometry(0.2, 10, 8), color: C.TOWERS.blaster.color },
        { geo: new THREE.BoxGeometry(0.42, 0.07, 0.07), color: dark, m: mtx(0.2, 0.02, -0.08) },
        { geo: new THREE.BoxGeometry(0.42, 0.07, 0.07), color: dark, m: mtx(0.2, 0.02, 0.08) },
      ]),
      cannon: merged([
        { geo: new THREE.SphereGeometry(0.27, 12, 8), color: C.TOWERS.cannon.color },
        { geo: new THREE.CylinderGeometry(0.1, 0.12, 0.5, 10), color: dark, m: mtx(0.26, 0.04, 0, 0, 0, -Math.PI / 2) },
      ]),
      sniper: merged([
        { geo: new THREE.SphereGeometry(0.17, 10, 8), color: C.TOWERS.sniper.color },
        { geo: new THREE.CylinderGeometry(0.035, 0.045, 0.75, 8), color: dark, m: mtx(0.38, 0.02, 0, 0, 0, -Math.PI / 2) },
        { geo: new THREE.BoxGeometry(0.12, 0.08, 0.06), color: dark, m: mtx(0.05, 0.13, 0) },
      ]),
      frost: merged([
        { geo: new THREE.OctahedronGeometry(0.24), color: C.TOWERS.frost.color, m: mtx(0, 0, 0, 0, 0, 0, 1) },
      ]),
    };
    this.headB = {};
    for (const [k, g] of Object.entries(heads)) {
      const mat = k === 'frost'
        ? new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, emissive: lin('#63b3ed'), emissiveIntensity: 1.4, roughness: 0.2 })
        : vmat;
      this.headB[k] = new Batch(s, g, mat, 128, { color: false, shadow: true });
    }
    const pipMat = new THREE.MeshStandardMaterial({ color: lin('#ecc94b'), emissive: lin('#b7791f'), emissiveIntensity: 0.6, roughness: 0.5 });
    this.pipB = new Batch(s, new THREE.BoxGeometry(0.12, 0.06, 0.12), pipMat, 512, { color: false });
    const flashMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    flashMat.color = lin('#fefcbf').multiplyScalar(4);
    this.flashB = new Batch(s, new THREE.SphereGeometry(1, 8, 6), flashMat, 128, { color: false });
    this.towerCol = Object.fromEntries(C.TOWER_TYPES.map((k) => [k, lin(C.TOWERS[k].color)]));
  }

  buildEffects() {
    const s = this.scene;
    // expanding glow rings (placement, upgrade, frost pulse, explosions, base hits)
    const ringGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol;
        void main() { vUv = uv; vCol = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol;
        void main() {
          float r = length(vUv - 0.5) * 2.0; if (r > 1.0) discard;
          float ring = smoothstep(0.78, 0.94, r) * smoothstep(1.0, 0.95, r);
          float a = ring + (1.0 - r) * 0.08;
          gl_FragColor = vec4(vCol * a * 1.2, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.ringB = new Batch(s, ringGeo, this.ringMat, 2048, { color: true, order: 5 });
    // sniper tracers
    const tracerMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.tracerB = new Batch(s, new THREE.BoxGeometry(1, 1, 1), tracerMat, 1024, { color: true, order: 6 });

    // GPU particles for death bursts: a ring buffer written once per particle, animated by the shader
    const g = new THREE.BufferGeometry();
    const attr = (n) => { const a = new THREE.BufferAttribute(new Float32Array(PARTICLE_CAP * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('position', attr(3)); g.setAttribute('aVel', attr(3)); g.setAttribute('aCol', attr(3)); g.setAttribute('aBirth', attr(1)); g.setAttribute('aSize', attr(1));
    g.attributes.aBirth.array.fill(-1e9);
    this.particles = { geo: g, head: 0 };
    this.particleU = { uTime: { value: 0 }, uScale: this.pointScale };
    const pts = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.particleU,
      vertexShader: /* glsl */ `
        attribute vec3 aVel; attribute vec3 aCol; attribute float aBirth; attribute float aSize;
        uniform float uTime; uniform float uScale; varying vec3 vCol; varying float vK;
        void main() {
          float age = uTime - aBirth;
          if (age < 0.0 || age > ${PARTICLE_LIFE.toFixed(2)}) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          vec3 p = position + aVel * age + vec3(0.0, -7.5, 0.0) * age * age;
          p.y = max(p.y, 0.04);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          vK = 1.0 - age / ${PARTICLE_LIFE.toFixed(2)};
          vCol = aCol;
          gl_PointSize = aSize * uScale * (0.35 + 0.65 * vK) / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol; varying float vK;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard;
          float a = (1.0 - r) * vK; gl_FragColor = vec4(vCol * a * 1.3, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    pts.frustumCulled = false;
    s.add(pts);
    this.textQueue = [];
  }

  buildOverlays() {
    const discMat = (fill, edge) => new THREE.ShaderMaterial({
      uniforms: { uCol: { value: lin('#ffffff') }, uFill: { value: fill }, uEdge: { value: edge } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; uniform float uFill; uniform float uEdge; varying vec2 vUv;
        void main() { float r = length(vUv - 0.5) * 2.0; if (r > 1.0) discard;
          float a = uFill + smoothstep(0.96, 0.99, r) * uEdge; gl_FragColor = vec4(uCol * a, a); }`,
      transparent: true, depthWrite: false,
    });
    const disc = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.rangeSel = new THREE.Mesh(disc, discMat(0.07, 0.55)); this.rangeSel.renderOrder = 4;
    this.rangeGhost = new THREE.Mesh(disc, discMat(0.10, 0.7)); this.rangeGhost.renderOrder = 4;
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }));
    this.rangeSel.position.y = this.rangeGhost.position.y = 0.03;
    this.scene.add(this.rangeSel, this.rangeGhost, this.ghost);
  }

  buildPost() {
    const r = this.renderer;
    const composer = (this.composer = new EffectComposer(r));
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.4, 0.92);
    composer.addPass(this.bloom);
    // grading: gentle vignette, warm highlights / cool shadows, a touch of saturation
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: this.uTime },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
          c.rgb = mix(vec3(l), c.rgb, 1.12);
          c.rgb *= mix(vec3(0.92, 0.97, 1.06), vec3(1.06, 1.0, 0.92), smoothstep(0.05, 0.6, l));
          vec2 q = vUv - 0.5; c.rgb *= 1.0 - dot(q, q) * 0.55;
          gl_FragColor = c;
        }`,
    });
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());
    if (this.w) this.resize(this.w, this.h, this.dpr);
  }

  resize(w, h, dpr) {
    if (!this.ok) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
      this.bloom.resolution.set(w * dpr / 2, h * dpr / 2);
    }
    this.pointScale.value = (h * dpr) / (2 * Math.tan((FOV * Math.PI) / 360));
  }

  // The 2D camera (top-left x/y in world px + zoom) drives a tilted perspective camera that
  // looks at the same point and shows about the same amount of ground.
  placeCamera(cam) {
    const tx = (cam.x + this.w / (2 * cam.zoom)) / T, tz = (cam.y + this.h / (2 * cam.zoom)) / T;
    const span = this.h / cam.zoom / T;
    const d = (span * Math.sin(PITCH)) / (2 * Math.tan((FOV * Math.PI) / 360)) * 0.92;
    this.camera.position.set(tx, d * Math.sin(PITCH), tz + d * Math.cos(PITCH) + 1.2);
    // fog follows the camera distance, so zooming out shows the whole map instead of haze
    this.scene.fog.near = d * 1.05 + 6;
    this.scene.fog.far = d * 2.4 + 30;
    this.camera.lookAt(tx, 0, tz + 1.2);
    this.camera.updateMatrixWorld();
    // ground footprint of the view, for culling
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, hits = 0;
    for (let c = 0; c < 8; c += 2) {
      const sx = CORNERS[c], sy = CORNERS[c + 1];
      this.ray.setFromCamera(this.tmpV2.set(sx, sy), this.camera);
      const p = this.ray.ray.intersectPlane(this.plane, this.tmpV);
      if (!p) continue;
      hits++; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const v = this.view, pad = 3;
    if (hits === 4) { v.x0 = x0 - pad; v.x1 = x1 + pad; v.z0 = z0 - pad; v.z1 = z1 + pad; }
    else { v.x0 = v.z0 = -1e9; v.x1 = v.z1 = 1e9; }
    const e = this.camera.matrixWorld.elements, R = this.R;
    R[0] = e[0]; R[1] = e[1]; R[2] = e[2]; R[3] = e[4]; R[4] = e[5]; R[5] = e[6]; R[6] = e[8]; R[7] = e[9]; R[8] = e[10];
  }

  // Screen (CSS px within the canvas) -> game world px on the ground plane, or null.
  pick(mx, my) {
    if (!this.ok || !this.w) return null;
    this.ray.setFromCamera(this.tmpV2.set((mx / this.w) * 2 - 1, -(my / this.h) * 2 + 1), this.camera);
    const p = this.ray.ray.intersectPlane(this.plane, this.tmpV);
    return p ? { x: p.x * T, y: p.z * T } : null;
  }

  project(xPx, height, yPx) {
    const v = this.tmpV.set(xPx / T, height, yPx / T).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h, behind: v.z > 1 };
  }

  // ---------- per frame ----------
  draw(game, cam, alpha, view, realDt) {
    if (!this.built) this.build(game);
    this.clock += realDt;
    const gameT = game.time + (game.state === 'playing' ? alpha * C.STEP : 0);
    this.uTime.value = this.clock;
    this.particleU.uTime.value = gameT;
    this.renderer.info.reset();
    const P = this.prof, t0 = performance.now();
    this.placeCamera(cam);
    this.fillEnemies(game, alpha, gameT);
    this.fillProjectiles(game, alpha);
    this.fillTowers(game, view);
    this.fillEffects(game, gameT);
    this.updateOverlays(game, view);
    this.animateSet(game);
    const t1 = performance.now();

    this.sun.castShadow = opts.shadows !== 'off';
    // Always go through the composer and only toggle the bloom pass: rendering straight to the
    // screen instead needs different shader variants (tone mapping/sRGB in-material), so every
    // on/off switch would recompile every shader and stall a frame.
    this.bloom.enabled = opts.bloom !== 'off' && this.adaptBloom(game, realDt);
    this.composer.render();
    P.fill += t1 - t0; P.render += performance.now() - t1; P.frames++;
  }

  // Adaptive quality: bloom is ~a dozen full-screen passes. If too many recent frames miss the
  // 45 fps budget it switches off, and only comes back once the enemy count is well below the
  // count at which it failed (no on/off flicker). opts.quality = 'fixed' keeps bloom on regardless.
  adaptBloom(game, dt) {
    if (opts.quality === 'fixed') return true;
    // Track the share of slow frames (> 22 ms, i.e. under 45 fps) over the last ~second: that is
    // what the 95%-of-frames criterion measures, and an average hides it.
    const W = 60, hist = this.slowHist || (this.slowHist = new Uint8Array(W));
    const i = (this.slowIdx = ((this.slowIdx || 0) + 1) % W);
    const slow = dt * 1000 > 22 ? 1 : 0;
    this.slowCount = (this.slowCount || 0) + slow - hist[i];
    hist[i] = slow;
    const n = game.enemies.length;
    if (this.bloomOn !== false) {
      if (this.slowCount >= 4) { this.bloomOn = false; this.bloomFailedAt = n; } // >= ~6% slow frames
    } else if (n < this.bloomFailedAt * 0.7 && this.slowCount === 0) {
      this.bloomOn = true;
    }
    return this.bloomOn !== false;
  }

  fillEnemies(game, alpha, t) {
    const en = game.enemies, n = en.length, v = this.view;
    for (const b of this.enemyB) b.ensure(n);
    this.shadowB.ensure(n); this.barBgB.ensure(n); this.barFgB.ensure(n);
    const counts = [0, 0, 0, 0, 0, 0];
    let ns = 0, nb = 0;
    const SM = this.shadowB.M, BM = this.barBgB.M, FM = this.barFgB.M, FC = this.barFgB.Cc, R = this.R;
    const ice = this.ice, bars = this.barCols;
    for (let i = 0; i < n; i++) {
      const e = en[i];
      const x = (e.px + (e.x - e.px) * alpha) / T, z = (e.py + (e.y - e.py) * alpha) / T;
      if (x < v.x0 || x > v.x1 || z < v.z0 || z > v.z1) continue;
      const L = e.def.layer !== undefined ? e.def.layer : this.layerOf[e.type];
      const b = this.enemyB[L], k = counts[L]++;
      const r = this.enemyR[L];
      const type = e.type;
      let fx = e.dirX, fz = e.dirY, y = r * this.enemyLift[type];
      let sy = r;
      if (type === 'flyer') y += Math.sin(t * 3 + e.id) * 0.12;
      else if (type === 'boss') { const a = t * 0.6; fx = Math.cos(a); fz = Math.sin(a); }
      else if (type === 'swarm') { const a = Math.atan2(fz, fx) + Math.sin(t * 14 + e.id) * 0.5; fx = Math.cos(a); fz = Math.sin(a); y += Math.abs(Math.sin(t * 16 + e.id)) * 0.05; }
      else { const hop = Math.abs(Math.sin(t * 9 + e.id)); y += hop * r * 0.18; sy = r * (1 - hop * 0.06); }
      setYaw(b.M, k, x, y, z, fx, fz, r, sy, r);
      const c = this.enemyColor[L];
      if (e.hitT > 0) setRGB(b.Cc, k, 1.25, 1.25, 1.25);
      else if (e.slowT > 0) setRGB(b.Cc, k, (c.r + ice.r) * 0.5, (c.g + ice.g) * 0.5, (c.b + ice.b) * 0.6);
      else setRGB(b.Cc, k, c.r, c.g, c.b);
      // blob shadow on the ground
      const ss = r * (type === 'flyer' ? 2.2 : 2.6);
      setYaw(SM, ns++, x, 0.02, z, 1, 0, ss, 1, ss);
      if (e.hp < e.maxHp) {
        const f = Math.max(0, e.hp / e.maxHp), w = Math.max(0.36, r * 2.4), top = y + r * 1.35 + 0.18;
        setBill(BM, nb, x, top, z, R, w + 0.04, 0.085);
        const off = (-w / 2 + (w * f) / 2);
        setBill(FM, nb, x + R[0] * off, top + R[1] * off, z + R[2] * off, R, w * f, 0.05);
        const bc = bars[f > 0.5 ? 0 : f > 0.25 ? 1 : 2];
        setRGB(FC, nb, bc.r, bc.g, bc.b);
        nb++;
      }
    }
    for (let L = 0; L < LAYERS.length; L++) this.enemyB[L].commit(counts[L]);
    this.shadowB.commit(ns);
    this.barBgB.commit(nb); this.barFgB.commit(nb);
  }

  fillProjectiles(game, alpha) {
    const pr = game.projectiles, n = pr.length, v = this.view;
    this.bulletB.ensure(n); this.shellB.ensure(n);
    let nb = 0, ns = 0;
    const BM = this.bulletB.M, SM = this.shellB.M;
    for (let i = 0; i < n; i++) {
      const p = pr[i];
      const x = (p.px + (p.x - p.px) * alpha) / T, z = (p.py + (p.y - p.py) * alpha) / T;
      if (x < v.x0 || x > v.x1 || z < v.z0 || z > v.z1) continue;
      if (p.kind === 'shell') {
        const rem = Math.hypot(p.tx - p.x, p.ty - p.y) / T;
        setYaw(SM, ns++, x, 0.45 + Math.min(rem, 4) * 0.32, z, 1, 0, 0.11, 0.11, 0.11);
      } else {
        setYaw(BM, nb++, x, 0.62, z, 1, 0, 0.05, 0.05, 0.05);
      }
    }
    this.bulletB.commit(nb); this.shellB.commit(ns);
  }

  fillTowers(game, view) {
    const tw = game.towers, n = tw.length;
    this.baseB.ensure(n); this.trimB.ensure(n); this.pipB.ensure(n * 3); this.flashB.ensure(n);
    const counts = { blaster: 0, cannon: 0, sniper: 0, frost: 0 };
    for (const k in this.headB) this.headB[k].ensure(n);
    let np = 0, nf = 0;
    const t = this.clock;
    for (let i = 0; i < n; i++) {
      const tower = tw[i];
      const x = tower.x / T, z = tower.y / T;
      setYaw(this.baseB.M, i, x, 0, z, 1, 0, 1, 1, 1);
      const col = this.towerCol[tower.type], sel = tower === view.selected ? 1.8 : 1;
      setYaw(this.trimB.M, i, x, 0.36, z, 1, 0, 1, 1, 1);
      setRGB(this.trimB.Cc, i, col.r * sel, col.g * sel, col.b * sel);
      const hb = this.headB[tower.type], k = counts[tower.type]++;
      if (tower.type === 'frost') {
        const a = t * 0.9 + tower.id, pulse = 1 + Math.max(0, tower.flash) * 1.6;
        setYaw(hb.M, k, x, 0.78 + Math.sin(t * 2 + tower.id) * 0.06, z, Math.cos(a), Math.sin(a), pulse, pulse * 1.3, pulse);
      } else {
        const fx = Math.cos(tower.angle), fz = Math.sin(tower.angle);
        const recoil = tower.flash > 0 ? -0.07 : 0;
        setYaw(hb.M, k, x + fx * recoil, 0.62, z + fz * recoil, fx, fz, 1, 1, 1);
        if (tower.flash > 0 && tower.type !== 'sniper') {
          const reach = tower.type === 'cannon' ? 0.55 : 0.45;
          setYaw(this.flashB.M, nf++, x + fx * reach, 0.66, z + fz * reach, 1, 0, 0.11, 0.11, 0.11);
        }
      }
      for (let l = 0; l <= tower.level; l++) setYaw(this.pipB.M, np++, x - 0.22 + l * 0.22, 0.42, z + 0.37, 1, 0, 1, 1, 1);
    }
    this.baseB.commit(n); this.trimB.commit(n); this.pipB.commit(np); this.flashB.commit(nf);
    for (const k in this.headB) this.headB[k].commit(counts[k]);
  }

  fillEffects(game, gameT) {
    const fx = game.effects, n = fx.length;
    this.ringB.ensure(n); this.tracerB.ensure(n);
    let nr = 0, nt = 0;
    const RM = this.ringB.M, RC = this.ringB.Cc, TM = this.tracerB.M, TC = this.tracerB.Cc;
    const P = this.particles, G = P.geo.attributes;
    const pos = G.position.array, vel = G.aVel.array, pc = G.aCol.array, birth = G.aBirth.array, size = G.aSize.array;
    if (gameT + 1e-6 < this.lastFxTime) this.lastFxTime = -1; // game restarted
    let newest = this.lastFxTime, spawned = 0;
    this.textQueue.length = 0;
    for (let i = 0; i < n; i++) {
      const f = fx[i], k = f.life / f.max;
      if (k <= 0) continue;
      if (f.kind === 'ring') {
        const r = (f.r1 + (f.r0 - f.r1) * k) / T;
        setYaw(RM, nr, f.x / T, 0.05, f.y / T, 1, 0, r, 1, r);
        const rc = cachedColor(f.color);
        setRGB(RC, nr++, rc.r * k, rc.g * k, rc.b * k);
      } else if (f.kind === 'tracer') {
        const x1 = f.x / T, z1 = f.y / T, x2 = f.x2 / T, z2 = f.y2 / T;
        const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz) || 1e-3;
        setYaw(TM, nt, (x1 + x2) / 2, 0.66, (z1 + z2) / 2, dx / len, dz / len, len, 0.05 * k + 0.01, 0.05 * k + 0.01);
        const tc = cachedColor(f.color);
        setRGB(TC, nt++, tc.r * k * 3, tc.g * k * 3, tc.b * k * 3);
      } else if (f.kind === 'text') {
        this.textQueue.push(f);
      } else if (f.kind === 'pop') {
        // spawn a GPU burst once, when the death is first seen
        const born = game.time - (f.max - f.life);
        if (born > this.lastFxTime + 1e-6 && spawned < 4000) {
          const c = cachedColor(f.color);
          for (let j = 0; j < 7; j++) {
            const h = P.head, o = h * 3;
            const a = Math.random() * Math.PI * 2, sp = 1.4 + Math.random() * 2.2;
            pos[o] = f.x / T; pos[o + 1] = 0.35; pos[o + 2] = f.y / T;
            vel[o] = Math.cos(a) * sp; vel[o + 1] = 2.2 + Math.random() * 2.6; vel[o + 2] = Math.sin(a) * sp;
            const w = j === 0 ? 1 : 0.35;
            pc[o] = c.r + (1 - c.r) * w; pc[o + 1] = c.g + (1 - c.g) * w; pc[o + 2] = c.b + (1 - c.b) * w;
            birth[h] = born; size[h] = j === 0 ? 0.5 : 0.18 + Math.random() * 0.14;
            P.head = (h + 1) % PARTICLE_CAP;
            spawned++;
          }
          if (born > newest) newest = born;
        }
      }
    }
    this.lastFxTime = newest;
    this.ringB.commit(nr); this.tracerB.commit(nt);
    if (spawned) for (const a of [G.position, G.aVel, G.aCol, G.aBirth, G.aSize]) a.needsUpdate = true;
  }

  updateOverlays(game, view) {
    const u = this.groundU;
    u.uGrid.value = view.placing ? 1 : 0;
    const sel = view.selected && view.selected.def ? view.selected : null;
    this.rangeSel.visible = !!sel;
    if (sel) {
      const r = game.stats(sel).range;
      this.rangeSel.position.set(sel.x / T, 0.03, sel.y / T);
      this.rangeSel.scale.set(r, 1, r);
    }
    const hc = view.hoverCol, hr = view.hoverRow;
    const placing = view.placing && hc >= 0;
    this.rangeGhost.visible = this.ghost.visible = !!placing;
    u.uHover.value.set(hc, hr, hc >= 0 ? 1 : 0);
    if (placing) {
      const def = C.TOWERS[view.placing];
      const ok = game.canPlace(hc, hr) && game.gold >= def.cost;
      const col = cachedColor(ok ? '#68d391' : '#fc8181');
      u.uHoverCol.value.copy(col);
      this.rangeGhost.material.uniforms.uCol.value.copy(col);
      this.rangeGhost.position.set(hc + 0.5, 0.03, hr + 0.5);
      this.rangeGhost.scale.set(def.levels[0].range, 1, def.levels[0].range);
      this.ghost.position.set(hc + 0.5, 0.25, hr + 0.5);
      this.ghost.material.color.copy(cachedColor(def.color));
    } else {
      u.uHoverCol.value.set(0.8, 0.8, 0.8);
      if (!(hc >= 0 && game.towerAt(hc, hr))) u.uHover.value.z = 0;
    }
  }

  animateSet(game) {
    const t = this.clock;
    this.core.rotation.y = t * 0.8;
    this.core.position.y = 2.35 + Math.sin(t * 1.6) * 0.08;
    const hit = Math.max(0, game.baseHit);
    this.coreMat.emissive.copy(cachedColor(hit > 0 ? '#ff3030' : '#ffb020'));
    this.coreMat.emissiveIntensity = 2.2 + Math.sin(t * 2.4) * 0.5 + hit * 8;
    this.coreLight.intensity = 5 + Math.sin(t * 2.4) * 1.2 + hit * 20;
    const b = game.base;
    this.fortress.position.set(b.x / T + (Math.random() - 0.5) * hit * 0.25, 0, b.y / T + (Math.random() - 0.5) * hit * 0.25);
  }
}
