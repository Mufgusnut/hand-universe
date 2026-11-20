import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ---------------------------------------------------------------- config
const MP_VERSION = '0.10.14';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Gesture thresholds (tune here if detection feels off for your camera).
const T = {
  extended: 1.5,     // fingertip-to-wrist / knuckle-to-wrist above this = finger extended
  curled: 1.35,      // below this = finger curled
  pinchOn: 0.32,     // thumb-index distance / hand size to start a pinch
  pinchOff: 0.5,     // ...and to release it
  pinchHold: 0.4,    // seconds a pinch must be held in empty space before it makes something new
  pointStraight: 0.88, // index finger straightness needed to count as pointing
  pointLead: 0.15,     // ...and how much straighter it must be than the other three fingers
  pinchIndexOpen: 0.6, // index straightness above which thumb-on-index is a pinch, not a fist
  grabRadius: 2.8,     // how near (world units) a pinch must be to pick up an existing galaxy
  grabFling: 1.2,      // a released galaxy only drifts if the hand was moving faster than this
  fistDelay: 0.45,     // seconds after any point/pinch/peace during which a fist is ignored
  fistHoldFrames: 4,   // a fist must persist this many frames before it starts gathering
  minCharge: 0.1,      // how much a fist must have gathered (0-1) before opening it makes a supernova
  openWindow: 0.5,     // seconds a gathered charge is kept while the fist turns into an open hand
  galaxyMin: 0.12,     // radius of a galaxy at the instant it is pinched into being
  galaxyMax: 3.2,      // radius it reaches if the pinch is held the full time
  galaxyGrowTime: 6,   // seconds of holding to go from min to max
  tiltDepth: 2.5,      // how strongly tipping the hand toward/away from the camera tilts a held galaxy
  nebulaTouch: 1.3,    // how close (world units) two pointing fingertips must come to spark a nebula
  nebulaMin: 0.5,      // its width at that moment
  nebulaMax: 10,       // ...and the widest it can be pulled
  zoomInStart: 9,      // two open hands must come at least this close together (world units) before sweeping apart dives in
  zoomPull: 2.2,       // ...and how much further apart they must then sweep to commit to the dive
  zoomOutMin: 6,       // two open hands must have been at least this far apart for sweeping them together to zoom out
  holdFrames: 2,     // frames a gesture must persist before it takes effect
};

const PALETTES = [
  { name: 'CuzBro', colors: ['#2f8cff', '#ff8a1f', '#ffffff'] },
  { name: 'Nebula', colors: ['#3fd0ff', '#c04dff', '#ff4fa3'] },
  { name: 'Solar',  colors: ['#ffb02e', '#ff5a1f', '#ffe9a8'] },
  { name: 'Aurora', colors: ['#3dffa2', '#1fc8d6', '#4a7dff'] },
  { name: 'Frost',  colors: ['#ffffff', '#9fd4ff', '#b9a6ff'] },
].map(p => ({ name: p.name, colors: p.colors.map(c => new THREE.Color(c)) }));
let paletteIndex = 0;
let palette = PALETTES[0].colors;

// ---------------------------------------------------------------- scene
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio, 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02030a);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
camera.position.set(0, 0, 10);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.7, 0.05);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let viewW = 1, viewH = 1;
const uPx = { value: 1 }; // world-units -> pixels factor for point sprites
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  viewH = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  viewW = viewH * camera.aspect;
  uPx.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- particles
const MAX = 40000;
const pPos = new Float32Array(MAX * 3), pVel = new Float32Array(MAX * 3), pCol = new Float32Array(MAX * 3);
const pLife = new Float32Array(MAX), pMax = new Float32Array(MAX), pSize = new Float32Array(MAX), pFade = new Float32Array(MAX);
let pCursor = 0;

const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aFade', new THREE.BufferAttribute(pFade, 1).setUsage(THREE.DynamicDrawUsage));
const SPRITE_FRAG = /* glsl */`
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor * a * a, 1.0);
  }`;
const pMat = new THREE.ShaderMaterial({
  uniforms: { uPx },
  vertexShader: /* glsl */`
    attribute float aSize; attribute float aFade; attribute vec3 color;
    uniform float uPx; varying vec3 vColor;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * (0.4 + 0.6 * aFade) * uPx / max(0.1, -mv.z);
      vColor = color * aFade;
    }`,
  fragmentShader: SPRITE_FRAG,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
});
const particles = new THREE.Points(pGeo, pMat);
particles.frustumCulled = false;
scene.add(particles);

function spawn(x, y, z, vx, vy, vz, r, g, b, life, size) {
  const i = pCursor, j = i * 3;
  pCursor = (pCursor + 1) % MAX;
  pPos[j] = x; pPos[j + 1] = y; pPos[j + 2] = z;
  pVel[j] = vx; pVel[j + 1] = vy; pVel[j + 2] = vz;
  pCol[j] = r; pCol[j + 1] = g; pCol[j + 2] = b;
  pLife[i] = pMax[i] = life; pSize[i] = size;
}

let cr = 1, cg = 1, cb = 1;
function pickColor(whiten = 0) {
  const c = palette[(Math.random() * palette.length) | 0];
  const k = 0.3 + Math.random() * 0.3;
  cr = (c.r + (1 - c.r) * whiten) * k; cg = (c.g + (1 - c.g) * whiten) * k; cb = (c.b + (1 - c.b) * whiten) * k;
}

const wells = []; // gravity wells for this frame: {x, y, z, g}
function updateParticles(dt) {
  const drag = Math.exp(-1.0 * dt), nw = wells.length;
  for (let i = 0; i < MAX; i++) {
    if (pLife[i] <= 0) continue;
    const life = (pLife[i] -= dt);
    if (life <= 0) { pFade[i] = 0; continue; }
    const j = i * 3;
    let vx = pVel[j], vy = pVel[j + 1], vz = pVel[j + 2];
    for (let w = 0; w < nw; w++) {
      const W = wells[w];
      if (!W.fist) continue;
      const dx = W.x - pPos[j], dy = W.y - pPos[j + 1], dz = W.z - pPos[j + 2];
      const d2 = dx * dx + dy * dy + dz * dz + 0.25, d = Math.sqrt(d2);
      const a = W.g / d2 * dt / d, sw = 2.2 / (d + 0.6) * dt;
      vx += dx * a - dy * sw; vy += dy * a + dx * sw; vz += dz * a;
      if (d2 < 1.2) { const k = Math.exp(-3 * dt); vx *= k; vy *= k; vz *= k; }
    }
    vx *= drag; vy *= drag; vz *= drag;
    pVel[j] = vx; pVel[j + 1] = vy; pVel[j + 2] = vz;
    pPos[j] += vx * dt; pPos[j + 1] += vy * dt; pPos[j + 2] += vz * dt;
    pFade[i] = Math.min(1, life / pMax[i] * 1.7);
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
  pGeo.attributes.aSize.needsUpdate = true;
  pGeo.attributes.aFade.needsUpdate = true;
}

// ---------------------------------------------------------------- ambient stars
// The background itself: persistent stars that every gesture pushes, pulls and swirls,
// and that drift back to their home positions when left alone.
const AMB = 9000;
const aPos = new Float32Array(AMB * 3), aVel = new Float32Array(AMB * 3), aHome = new Float32Array(AMB * 3);
const aSeed = new Float32Array(AMB * 3), aCol = new Float32Array(AMB * 3);
const aSize = new Float32Array(AMB), aFade = new Float32Array(AMB), aHeat = new Float32Array(AMB);
const blasts = []; // supernovae still pushing their stars outward: {x, y, z, sp, t}
for (let i = 0; i < AMB; i++) {
  const j = i * 3, warm = Math.random(), k = 0.22 + Math.random() * 0.45;
  aSeed[j] = Math.random() * 2 - 1; aSeed[j + 1] = Math.random() * 2 - 1; aSeed[j + 2] = -9 + Math.random() * 10.5;
  aCol[j] = (0.6 + 0.4 * warm) * k; aCol[j + 1] = (0.72 + 0.18 * warm) * k; aCol[j + 2] = (1.0 - 0.25 * warm) * k;
  aSize[i] = 0.05 + Math.random() * 0.08; aFade[i] = 0.6;
}
let ambientPlaced = false, ambN = AMB; // a narrow (portrait) view shows fewer stars, or it would be packed solid
function layoutAmbient() {
  for (let i = 0; i < AMB; i++) {
    const j = i * 3, z = aSeed[j + 2], s = (camera.position.z - z) / camera.position.z; // fill the view frustum
    aHome[j] = aSeed[j] * viewW * 0.62 * s; aHome[j + 1] = aSeed[j + 1] * viewH * 0.62 * s; aHome[j + 2] = z;
  }
  ambN = Math.round(AMB * Math.min(1, Math.max(0.35, viewW / viewH / 1.6)));
  if (!ambientPlaced) { aPos.set(aHome); ambientPlaced = true; }
}
layoutAmbient();
window.addEventListener('resize', layoutAmbient);

const aGeo = new THREE.BufferGeometry();
aGeo.setAttribute('position', new THREE.BufferAttribute(aPos, 3).setUsage(THREE.DynamicDrawUsage));
aGeo.setAttribute('color', new THREE.BufferAttribute(aCol, 3));
aGeo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
aGeo.setAttribute('aFade', new THREE.BufferAttribute(aFade, 1).setUsage(THREE.DynamicDrawUsage));
const ambient = new THREE.Points(aGeo, pMat);
ambient.frustumCulled = false;
scene.add(ambient);

function updateAmbient(dt) {
  const nw = wells.length, drag = Math.exp(-1.5 * dt);
  let strong = false;
  for (let w = 0; w < nw; w++) if (wells[w].strong) strong = true;
  const k = strong ? 0.08 : 1.2; // homing spring relaxes while something is gathering
  for (let b = blasts.length - 1; b >= 0; b--) if ((blasts[b].t += dt) > 1.5) blasts.splice(b, 1);
  const nb = blasts.length;
  // With two fists up, each star answers only to the fist nearer its home, so the sky is shared
  // between them instead of whichever closed first keeping everything.
  let nf = 0;
  for (let w = 0; w < nw; w++) if (wells[w].fist) nf++;
  aGeo.setDrawRange(0, ambN);
  for (let i = 0; i < ambN; i++) {
    const j = i * 3, x = aPos[j], y = aPos[j + 1], z = aPos[j + 2];
    // heat 2..1: riding the blast outward; 1..0: being drawn smoothly back home
    const heat = aHeat[i], out = heat > 1 ? heat - 1 : 0, back = heat > 1 ? 0 : heat, bump = 4 * back * (1 - back);
    const kh = out > 0 ? k * Math.max(0, 1 - out * 3) : k * (1 + 4 * bump);
    if (heat > 0) aHeat[i] = Math.max(0, heat - dt * 1.1);
    let own = -1;
    if (nf > 1) {
      let bd = Infinity;
      for (let w = 0; w < nw; w++) {
        const W = wells[w];
        if (!W.fist) continue;
        const hx = W.x - aHome[j], hy = W.y - aHome[j + 1], hd = hx * hx + hy * hy;
        if (hd < bd) { bd = hd; own = w; }
      }
    }
    let ax = (aHome[j] - x) * kh, ay = (aHome[j + 1] - y) * kh, az = (aHome[j + 2] - z) * kh;
    for (let w = 0; w < nw; w++) {
      const W = wells[w], dx = W.x - x, dy = W.y - y, dz = W.z - z;
      if (own >= 0 && W.fist && w !== own) continue;
      if (W.g < 0) { // repel (open hand): stars part around it
        const d2 = dx * dx + dy * dy + dz * dz + 0.3, a = W.g / (d2 * Math.sqrt(d2));
        ax += dx * a; ay += dy * a; az += dz * a;
        continue;
      }
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-3;
      if (W.range && d > W.range) continue;
      // pull onto a ring of radius r0 around the well, flatten into its plane, and swirl
      const m = Math.max(W.g * (d - W.r0) / ((d + 0.5) * d), -W.g * 0.5), s = W.swirl / (d + 0.6);
      ax += (dx * m - dy * s) / d; ay += (dy * m + dx * s) / d; az += dz * (W.flat ?? 1.5);
    }
    if (out > 0) for (let b = 0; b < nb; b++) { // a steady shove rather than a single kick
      const B = blasts[b], dx = x - B.x, dy = y - B.y, dz = z - B.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.2;
      const a = B.sp * 3.4 * out / (1 + d * 0.25) / d;
      ax += dx * a; ay += dy * a; az += dz * a * 0.5;
    }
    const dg = bump > 0 ? drag * Math.max(0, 1 - 2.5 * bump * dt) : drag;
    const vx = (aVel[j] + ax * dt) * dg, vy = (aVel[j + 1] + ay * dt) * dg, vz = (aVel[j + 2] + az * dt) * dg;
    aVel[j] = vx; aVel[j + 1] = vy; aVel[j + 2] = vz;
    aPos[j] = x + vx * dt; aPos[j + 1] = y + vy * dt; aPos[j + 2] = z + vz * dt;
    aFade[i] = Math.min(2, 0.55 + Math.sqrt(vx * vx + vy * vy + vz * vz) * 0.12) + out * 0.5 + back * 0.15; // moving stars glow
  }
  aGeo.attributes.position.needsUpdate = true;
  aGeo.attributes.aFade.needsUpdate = true;
}

// diving in or climbing out: the whole sky lurches outward or inward, then settles
function warp(dir) {
  for (let i = 0; i < ambN; i++) { const j = i * 3; aVel[j] += aPos[j] * 0.9 * dir; aVel[j + 1] += aPos[j + 1] * 0.9 * dir; }
}

// ---------------------------------------------------------------- effects
function burst(p, power, vel) {
  const sp = 6 + 15 * power, gathered = 1.6 + 1.6 * power;
  blasts.push({ x: p.x, y: p.y, z: p.z, sp, t: 0 });
  for (let i = 0; i < ambN; i++) {
    const j = i * 3, dx = aPos[j] - p.x, dy = aPos[j + 1] - p.y, dz = aPos[j + 2] - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 7) continue;
    if (d < gathered) {
      // a star the fist pulled in: it is thrown outward in its own direction, glowing hot, trailing a spark
      const a = Math.random() * TAU, z = Math.random() * 2 - 1, q = Math.sqrt(1 - z * z), inv = 1 / (d + 0.05);
      let ux = dx * inv + q * Math.cos(a) * 0.45, uy = dy * inv + q * Math.sin(a) * 0.45, uz = dz * inv * 0.5 + z * 0.35;
      const n = 1 / (Math.hypot(ux, uy, uz) + 1e-3), v = sp * (0.3 + 0.7 * Math.cbrt(Math.random()));
      ux *= n * v; uy *= n * v; uz *= n * v;
      aVel[j] = ux * 0.22 + vel.x * 0.3; aVel[j + 1] = uy * 0.22 + vel.y * 0.3; aVel[j + 2] = uz * 0.13;
      aHeat[i] = 1.8 + Math.random() * 0.35;
      pickColor(Math.random() < 0.2 ? 0.7 : 0.1);
      const t = 0.55 + Math.random() * 0.4;
      spawn(aPos[j], aPos[j + 1], aPos[j + 2], ux * t + vel.x * 0.3, uy * t + vel.y * 0.3, uz * 0.6 * t,
        cr, cg, cb, 1 + Math.random() * 2.2, 0.05 + Math.random() * 0.08);
      continue;
    }
    const k = sp * (0.6 + Math.random() * 0.8) / (d + 0.4) / (d + 0.05); // the rest are shoved by the blast
    aVel[j] += dx * k * 0.6; aVel[j + 1] += dy * k * 0.6; aVel[j + 2] += dz * k * 0.3;
    if (aHeat[i] < 1) aHeat[i] = 1;
  }
  // shove whatever is already nearby (this is what makes a charged fist a supernova)
  for (let i = 0; i < MAX; i++) {
    if (pLife[i] <= 0) continue;
    const j = i * 3, dx = pPos[j] - p.x, dy = pPos[j + 1] - p.y, dz = pPos[j + 2] - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 3.5) continue;
    const k = sp * (0.5 + Math.random()) / (d + 0.4) / (d + 0.05);
    pVel[j] += dx * k; pVel[j + 1] += dy * k; pVel[j + 2] += dz * k;
    pLife[i] = Math.max(pLife[i], 1.2); pMax[i] = Math.max(pMax[i], pLife[i]);
  }
  const n = Math.floor(250 + 700 * power); // just a flash at the heart of it
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, z = Math.random() * 2 - 1, s = Math.sqrt(1 - z * z);
    const dx = s * Math.cos(a), dy = s * Math.sin(a), dz = z * 0.6;
    const v = sp * (0.12 + 0.88 * Math.cbrt(Math.random()));
    pickColor(Math.random() < 0.15 ? 0.7 : 0);
    spawn(p.x + dx * 0.1, p.y + dy * 0.1, p.z + dz * 0.1, dx * v + vel.x * 0.3, dy * v + vel.y * 0.3, dz * v,
      cr, cg, cb, 1.2 + Math.random() * 2.8, 0.05 + Math.random() * 0.1);
  }
  ring(p, 300 + 800 * power, sp * 1.3, 0.6);
}

function ring(p, n, speed, whiten) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.96 + Math.random() * 0.08);
    pickColor(whiten);
    spawn(p.x, p.y, p.z, Math.cos(a) * v, Math.sin(a) * v, (Math.random() - 0.5) * 0.4,
      cr, cg, cb, 0.8 + Math.random() * 0.6, 0.07);
  }
}

// --- galaxies (GPU-animated, one draw call each; every galaxy is generated with its own shape and size)
const GALAXY_N = 10000;
// Shapes are drawn from a seeded generator, so a galaxy can be rebuilt exactly from its seed after a reload.
const mulberry32 = a => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
let rng = Math.random;
const gauss = () => (rng() + rng() + rng() - 1.5) / 1.5;
const rand = (a, b) => a + rng() * (b - a);
const TAU = Math.PI * 2;

function shapeGalaxy(g, fresh = false) {
  rng = mulberry32(g.seed);
  const data = g.data, u = g.mat.uniforms, palette = PALETTES[g.pal % PALETTES.length].colors;
  const kind = ['spiral', 'spiral', 'spiral', 'barred', 'barred', 'ring', 'elliptical', 'irregular'][(rng() * 8) | 0];
  const put = (i, r, ang, h, w = rng() * 0.96) => { const j = i * 4; data[j] = r; data[j + 1] = ang; data[j + 2] = h; data[j + 3] = w; };
  // most arm stars sit in a tight lane, the rest form a soft haze around it
  const lane = () => gauss() * (rng() < 0.65 ? 0.35 : 1.25);
  // star-forming knots: small bright clumps strung along the arms
  const knots = (armAngle, rMin) => {
    const list = Array.from({ length: 10 + ((rng() * 10) | 0) }, () => { const r = rand(rMin, 0.95); return { r, a: armAngle(r, (rng() * 8) | 0) }; });
    return i => { const k = list[(rng() * list.length) | 0], x = k.r * Math.cos(k.a) + gauss() * 0.022, z = k.r * Math.sin(k.a) + gauss() * 0.022;
      put(i, Math.hypot(x, z), Math.atan2(z, x), gauss() * 0.015, rand(0.9, 1)); };
  };
  let rigid = 0.35, diff = 0.25, squash = 1, maxScale = rand(0.9, 3.2);

  if (kind === 'spiral') {
    const arms = 2 + ((rng() * 4) | 0), twist = rand(2.5, 7), spread = rand(0.2, 0.55);
    const bulge = rand(0.08, 0.22), bulgeR = rand(0.1, 0.22);
    const knot = knots((r, n) => ((n % arms) / arms) * TAU + r * twist, 0.2);
    for (let i = 0; i < GALAXY_N; i++) {
      const v = rng();
      if (v < bulge) { put(i, Math.pow(rng(), 1.6) * bulgeR, rand(0, TAU), gauss() * 0.06); continue; }
      if (v > 0.93) { knot(i); continue; }
      const r = 0.05 + Math.pow(rng(), 1.4) * 0.95;
      put(i, r, ((i % arms) / arms) * TAU + r * twist + lane() * spread * (1 - r * 0.5), gauss() * 0.03);
    }
  } else if (kind === 'barred') {
    const bar = rand(0.25, 0.45), twist = rand(3, 6);
    rigid = 0.5; diff = 0.04; // turns almost rigidly so the bar holds together
    const knot = knots((r, n) => (n % 2) * Math.PI + (r - bar) * twist, bar);
    for (let i = 0; i < GALAXY_N; i++) {
      const v = rng(), side = (i % 2) * Math.PI;
      if (v > 0.94) { knot(i); continue; }
      if (v < 0.12) put(i, rng() * 0.12, rand(0, TAU), gauss() * 0.06);
      else if (v < 0.42) { const r = rng() * bar, w = gauss() * 0.05; put(i, Math.hypot(r, w), side + Math.atan2(w, r), gauss() * 0.03); }
      else { const r = bar + Math.pow(rng(), 1.3) * (1 - bar); put(i, r, side + (r - bar) * twist + lane() * 0.3, gauss() * 0.03); }
    }
  } else if (kind === 'ring') {
    const ringR = rand(0.6, 0.85), width = rand(0.04, 0.09);
    for (let i = 0; i < GALAXY_N; i++) {
      const v = rng();
      if (v < 0.2) put(i, rng() * 0.15, rand(0, TAU), gauss() * 0.06);
      else if (v < 0.82) put(i, ringR + gauss() * width, rand(0, TAU), gauss() * 0.03);
      else put(i, rng() * ringR, rand(0, TAU), gauss() * 0.03);
    }
  } else if (kind === 'elliptical') {
    rigid = 0.18; diff = 0.1; squash = rand(0.5, 0.9); maxScale = rand(0.8, 2.3);
    for (let i = 0; i < GALAXY_N; i++) { const r = Math.pow(rng(), 2.2); put(i, r, rand(0, TAU), gauss() * 0.3 * (1 - r * 0.7)); }
  } else { // irregular: a handful of ragged clumps
    rigid = 0.28; diff = 0.05; squash = rand(0.7, 1); maxScale = rand(0.8, 2.3);
    const clumps = Array.from({ length: 3 + ((rng() * 4) | 0) }, () => ({ r: rand(0.1, 0.7), a: rand(0, TAU), s: rand(0.08, 0.25) }));
    for (let i = 0; i < GALAXY_N; i++) {
      if (rng() < 0.3) { put(i, Math.pow(rng(), 1.5) * 0.9, rand(0, TAU), gauss() * 0.08); continue; }
      const c = clumps[(rng() * clumps.length) | 0];
      const x = c.r * Math.cos(c.a) + gauss() * c.s, z = c.r * Math.sin(c.a) + gauss() * c.s;
      put(i, Math.hypot(x, z), Math.atan2(z, x), gauss() * 0.08);
    }
  }
  g.geo.attributes.aData.needsUpdate = true;

  const spin = (rng() < 0.5 ? -1 : 1) * rand(0.7, 1.5);
  u.uRigid.value = rigid * spin; u.uDiff.value = diff * spin; u.uSquash.value = squash;
  const tilt = rand(0.35, 1.35), roll = rand(-0.9, 0.9); // from nearly edge-on to nearly face-on
  if (fresh) g.quat.setFromEuler(new THREE.Euler(tilt, 0, roll));
  if (kind === 'elliptical') { u.uA.value.setRGB(1, 0.72, 0.42); u.uB.value.setRGB(1, 0.9, 0.7); }
  else {
    const a = (rng() * palette.length) | 0, b = (a + 1 + ((rng() * (palette.length - 1)) | 0)) % palette.length;
    u.uA.value.copy(palette[a]); u.uB.value.copy(palette[b]);
  }
  u.uCore.value.setRGB(1, rand(0.82, 0.97), rand(0.6, 0.95));
  rng = Math.random;
}

function makeGalaxy() {
  const data = new Float32Array(GALAXY_N * 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GALAXY_N * 3), 3));
  geo.setAttribute('aData', new THREE.BufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPx, uTime: { value: 0 }, uAlpha: { value: 0 }, uSize: { value: 1 },
      uRigid: { value: 0.35 }, uDiff: { value: 0.25 }, uSquash: { value: 1 },
      uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uCore: { value: new THREE.Color() } },
    vertexShader: /* glsl */`
      attribute vec4 aData;
      uniform float uPx, uTime, uAlpha, uSize, uRigid, uDiff, uSquash; uniform vec3 uA, uB, uCore;
      varying vec3 vColor;
      void main() {
        float r = aData.x;
        float ang = aData.y + uTime * (uRigid + uDiff / (0.3 + r));
        vec3 p = vec3(cos(ang) * r, aData.z, sin(ang) * r * uSquash);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float knot = step(0.9, aData.w);            // the brightest few: knots and giant stars
        gl_PointSize = (0.012 + 0.026 * aData.w + 0.018 * knot) * uSize * uPx / max(0.1, -mv.z);
        vec3 arm = mix(uA, uB, aData.w);
        vColor = mix(uCore, arm, smoothstep(0.04, 0.4, r)) * uAlpha * (0.07 + 0.13 * aData.w + 0.08 * knot);
      }`,
    fragmentShader: SPRITE_FRAG,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; points.visible = false; points.renderOrder = 2;
  scene.add(points);
  // pos and quat are where the galaxy sits in the universe; the drawn points leave them while we dive inside it
  return { kind: 'galaxy', points, mat, geo, data, alive: false, held: false, growing: false, isNew: false, holder: null,
    id: 0, seed: 0, pal: 0, stars: [], grow: 0, swallow: 0, radius: 0.25, wx: 0, wy: 0, reach: 0,
    pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3() };
}
const GALAXY_MAX = 8;
const galaxies = Array.from({ length: GALAXY_MAX }, makeGalaxy);
let nextId = 1;

function acquireGalaxy(p) {
  const g = galaxies.find(x => !x.alive);
  if (!g) { note('The universe is full. Set off a supernova on a galaxy to clear it away.'); return null; }
  g.id = nextId++; g.seed = (Math.random() * 4294967296) >>> 0; g.pal = paletteIndex; g.stars = [];
  shapeGalaxy(g, true);
  g.alive = true; g.held = true; g.growing = true; g.isNew = true; g.grow = 0; g.swallow = 0; g.vel.set(0, 0, 0);
  g.pos.copy(p); g.wx = p.x; g.wy = p.y; g.reach = T.grabRadius; g.radius = T.galaxyMin;
  return g;
}

// A pinch picks up whatever is under or near it (the target is generous) and only makes something new in
// empty space. A thing whose holder has stopped being tracked can be taken over, so a hand that the tracker
// briefly loses or relabels carries on holding it. If the other hand really is holding it, this hand joins
// in rather than making a second thing right on top of it.
function pinchPick(list, p, hand, now, create) {
  let best = null, bestD = Infinity, shared = null;
  for (const o of list) {
    if (o.swallow > 0) continue;
    const d = Math.hypot(o.wx - p.x, o.wy - p.y);
    const busy = o.held && o.holder && o.holder !== hand && o.holder.gesture === 'pinch' && now - o.holder.lastSeen < 0.15;
    if (busy) { if (d < o.reach * 1.6) shared = o; continue; }
    if (d < o.reach && d < bestD) { best = o; bestD = d; }
  }
  if (shared) { hand.assist = shared; return null; }
  if (best) {
    if (best.holder && best.holder !== hand && best.holder.grab === best) best.holder.grab = null;
    if (!best.held) best.growing = false;
    best.held = true;
    if (best.vel) best.vel.set(0, 0, 0);
  } else best = create();
  if (best) best.holder = hand;
  return best;
}

function killGalaxy(g) {
  if (g.holder && g.holder.grab === g) g.holder.grab = null;
  for (let i = nebulae.length - 1; i >= 0; i--) if (nebulae[i].space === g.id) dropNebula(nebulae[i]);
  if (focusG === g) { focusG = null; focusS = null; }
  g.holder = null; g.alive = false; g.held = false; g.swallow = 0; g.stars = []; g.points.visible = false;
  markDirty();
}

function updateGalaxies(dt) {
  const hw = viewW * 0.5, hh = viewH * 0.5;
  for (const g of galaxies) {
    if (!g.alive) { g.points.visible = false; continue; }
    if (g.held) { if (g.growing) g.grow += dt; }
    else if (level === 0) {
      g.pos.addScaledVector(g.vel, dt);
      g.vel.multiplyScalar(Math.exp(-0.6 * dt));
      // nothing lasts 45 seconds and fades any more, so a thrown galaxy has to stay where it can be reached
      g.pos.x = THREE.MathUtils.clamp(g.pos.x, -hw, hw); g.pos.y = THREE.MathUtils.clamp(g.pos.y, -hh, hh);
    }
    const t = Math.min(1, g.grow / T.galaxyGrowTime);
    g.radius = T.galaxyMin + (T.galaxyMax - T.galaxyMin) * (1 - (1 - t) * (1 - t)); // quick at first, easing into the maximum
    g.wx = g.pos.x; g.wy = g.pos.y; g.reach = Math.max(T.grabRadius, g.radius + 1);
    const focus = g === focusG && E1 > 0;
    let scale = g.radius;
    if (focus) { // the galaxy we are diving into swings face-on and grows until it is the whole sky
      place(0, 0, _w);
      g.points.position.set(_w.x, _w.y, THREE.MathUtils.lerp(g.pos.z, C0.z, E1));
      g.points.quaternion.slerpQuaternions(g.quat, FACE, E1);
      scale = gK * zM;
    } else { g.points.position.copy(g.pos); g.points.quaternion.copy(g.quat); }
    scale *= Math.max(0.02, 1 - g.swallow);
    g.points.scale.setScalar(scale);
    g.mat.uniforms.uSize.value = 0.2 + Math.min(scale, 3.2) * 0.62 + Math.max(0, scale - 3.2) * 0.1;
    g.mat.uniforms.uTime.value += dt * (g.held && g.growing ? 2.2 : 1) * (1 + g.swallow * 7) * (focus ? 1 - 0.92 * E1 : 1);
    const fadeIn = Math.min(1, g.grow * 3);
    const density = Math.min(1, 0.2 + 0.22 * scale * scale); // same star count in less area would burn out
    const seen = focus ? (1 - 0.3 * E1) * (1 - 0.6 * E2) * (1 - 0.5 * E3) : 1 - E1;
    const alpha = fadeIn * density * (g.held && !g.growing ? 1.3 : 1) * seen;
    g.mat.uniforms.uAlpha.value = alpha;
    g.points.visible = alpha > 0.003;
  }
}

// ---------------------------------------------------------------- levels
// Three scales of the same place: the universe (0), the inside of one galaxy (1) and one star's solar
// system (2). `depth` eases toward the level we are on, and is nudged a little by a two-handed sweep that
// is under way, so the view starts answering the hands before the dive commits.
const C0 = new THREE.Vector3(0, 0, -1), FACE = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const SYSTEM_ZOOM = 5;
let level = 0, depth = 0, E1 = 0, E2 = 0, E3 = 0, focusG = null, focusS = null, focusP = null;
let zoomNudge = 0, zoomLock = false, zoomKey = null, zoomOn = false, zoomMin = 0, zoomMax = 0, zoomGap = 0, zoomHeld = 0, zoomShow = false;
let galS = 9, sysR = 4.8, gK = 1, zM = 1, zPx = 0, zPy = 0, bodyTime = 0;
const gO = new THREE.Vector3(), _w = new THREE.Vector3();
const ease = t => t * t * (3 - 2 * t), clamp01 = t => Math.min(1, Math.max(0, t));

function updateView(dt) {
  galS = Math.max(viewW, viewH) * 0.5;  // how big a galaxy's disc is drawn once we are inside it
  sysR = Math.min(viewW, viewH) * 0.47; // the widest orbit that still fits on screen
  if (level === 3 && !focusP) setLevel(2);
  if (level >= 2 && !focusS) setLevel(1);
  if (level >= 1 && !focusG) setLevel(0);
  const target = level + zoomNudge;
  depth += (target - depth) * Math.min(1, dt * 3);
  if (Math.abs(target - depth) < 0.0015) depth = target;
  E1 = ease(clamp01(depth)); E2 = ease(clamp01(depth - 1)); E3 = ease(clamp01(depth - 2));
  if (level < 3 && E3 === 0 && zoomKey !== focusP) focusP = null;
  if (level < 2 && E2 === 0 && zoomKey !== focusS) focusS = null;
  if (level < 1 && E1 === 0 && zoomKey !== focusG) focusG = null;
  if (focusG) { gO.lerpVectors(focusG.pos, C0, E1); gK = focusG.radius * Math.pow(galS / focusG.radius, E1); }
  zM = Math.pow(SYSTEM_ZOOM, E2);
  if (focusS) { zPx = gO.x + focusS.u * gK; zPy = gO.y + focusS.v * gK; }
  bodyTime += dt;
}

// galaxy coordinates (in units of the galaxy's radius) <-> the screen's world coordinates
function place(u, v, out) {
  let x = gO.x + u * gK, y = gO.y + v * gK;
  if (E2 > 0) { x = (x - zPx) * zM + zPx * (1 - E2); y = (y - zPy) * zM + zPy * (1 - E2); }
  out.x = x; out.y = y; return out;
}
function unplace(x, y, out) {
  if (E2 > 0) { x = (x - zPx * (1 - E2)) / zM + zPx; y = (y - zPy * (1 - E2)) / zM + zPy; }
  out.x = (x - gO.x) / gK; out.y = (y - gO.y) / gK; return out;
}

function setLevel(n) {
  level = n; zoomLock = true; zoomKey = null; zoomOn = false; zoomHeld = 0; refreshChrome();
  note(n === 3 && focusP && !isSolid(focusP) ? 'Pinch the clouds to brew a storm' : ARRIVE[n], 6);
}

function diveInto(o) {
  for (const h of [hands.Left, hands.Right]) h.release();
  if (o.kind === 'galaxy') { o.vel.set(0, 0, 0); focusG = o; setLevel(1); }
  else if (o.kind === 'star') { focusS = o; setLevel(2); }
  else { focusP = o; setLevel(3); }
  warp(1);
}

function surface() {
  if (level === 0) return;
  for (const h of [hands.Left, hands.Right]) { // anything a hand had only just begun making is dropped
    const o = h.grab, raw = o && o.isNew && o.grow < 3;
    h.release();
    if (raw) removeBody(o);
  }
  setLevel(level - 1);
  warp(-1);
}

// Two open hands are the zoom control, like a swimmer's breaststroke. Bring them together over a galaxy
// or a star and sweep them apart: dive into it. Start wide and sweep them together over open space: climb
// back out. It is the sweep that counts, not the pose, so two open hands held still do nothing at all.
function zoomTarget(x, y, loose) {
  const list = level === 0 ? galaxies : level === 1 && focusG ? focusG.stars : level === 2 && focusS ? focusS.planets : null;
  let best = null, bd = Infinity;
  if (list) for (const o of list) {
    if (o.kind === 'galaxy' && !o.alive) continue;
    const d = Math.hypot(o.wx - x, o.wy - y);
    if (d < (loose ? Math.max(3.5, o.reach * 1.6) : o.reach) && d < bd) { best = o; bd = d; }
  }
  return best;
}
function updateZoom(L, R, now, dt) {
  const fresh = Math.max(L.charge, R.charge) >= T.minCharge || now - Math.max(L.lastBurst, R.lastBurst) < 1.2; // that is a supernova, not a stroke
  // A hand sweeping sideways is seen edge-on and stops reading as cleanly open, so one that was open a moment ago
  // and has not become anything else still counts, and a brief dropout does not throw the stroke away.
  const openish = h => h.active && (h.gesture === 'open' || (h.gesture === 'none' && now - h.lastOpen < 1));
  const both = openish(L) && openish(R) && (L.gesture === 'open' || R.gesture === 'open' || zoomOn) && !fresh;
  let nudge = zoomHeld;
  if (!both) {
    if (!zoomOn || fresh || (zoomGap += dt) > 0.4) { zoomOn = false; zoomKey = null; nudge = 0; if (Math.abs(depth - level) < 0.04) zoomLock = false; }
  } else if (!zoomLock) {
    zoomGap = 0; nudge = 0;
    const d = Math.hypot(L.pos.x - R.pos.x, L.pos.y - R.pos.y), mx = (L.pos.x + R.pos.x) / 2, my = (L.pos.y + R.pos.y) / 2;
    if (!zoomOn) { zoomOn = true; zoomMin = zoomMax = d; zoomKey = null; }
    zoomMax = Math.max(zoomMax, d);
    // the stroke outward is measured from where the hands were closest, and aims at whatever lay between them then
    if (d <= zoomMin) { zoomMin = d; zoomKey = null; }
    if (!zoomKey && zoomMin < T.zoomInStart && d - zoomMin < T.zoomPull * 0.6) zoomKey = zoomTarget(mx, my, true); // generous: the nearest thing roughly between the hands
    const o = zoomKey, kind = o && o.kind;
    const free = o && (kind === 'galaxy' ? (!focusG || focusG === o || depth < 0.02) : kind === 'star' ? (!focusS || focusS === o || depth < 1.02) : (!focusP || focusP === o || depth < 2.02));
    const inward = free ? clamp01((d - zoomMin) / T.zoomPull) : 0;
    // ...and the stroke inward from where they were widest, but only over open space, so that closing the
    // hands over a star to dive into it is never mistaken for leaving
    const outward = level > 0 && zoomMax > T.zoomOutMin && !zoomTarget(mx, my) ? clamp01((zoomMax - d) / (zoomMax * 0.5)) : 0;
    if (inward > 0) {
      if (kind === 'galaxy') focusG = o; else if (kind === 'star') focusS = o; else focusP = o;
      nudge = inward * 0.25;
      if (inward >= 1) { diveInto(o); nudge = 0; }
    } else if (outward > 0) {
      nudge = -outward * 0.25;
      if (outward >= 1) { surface(); nudge = 0; }
    }
  }
  zoomHeld = nudge; zoomShow = nudge !== 0;
  zoomNudge += (nudge - zoomNudge) * Math.min(1, dt * 10);
}

// ---------------------------------------------------------------- stars and planets
const STAR_MAX = 16, STAR_GROW = 6, PLANET_MAX = 8, PLANET_GROW = 6, MOON_MAX = 4;
const newSeed = () => (Math.random() * 1e9) | 0;
const mkStar = (u, v, grow, seed) => ({ kind: 'star', u, v, grow, seed, planets: [],
  held: false, growing: false, isNew: false, holder: null, swallow: 0, wx: 0, wy: 0, wr: 0.1, reach: 1.4 });
const mkPlanet = (r, a, grow, seed) => ({ kind: 'planet', r, a, grow, seed, rings: 0, moons: [],
  map: null, sea: null, spots: [], wind: 1, // the surface: hand-made changes to the terrain, sea level, a giant's storms and winds
  held: false, growing: false, isNew: false, holder: null, swallow: 0, wx: 0, wy: 0, reach: 1.1 });

const starT = s => Math.min(1, s.grow / STAR_GROW);
const starRadius = s => 0.07 + 0.3 * Math.pow(starT(s), 0.8); // seen from inside its galaxy
const sunRadius = s => sysR * (0.075 + 0.075 * starT(s));       // seen from inside its own system
const orbitMin = s => 0.17 + 0.08 * starT(s);                 // nearest orbit, as a fraction of sysR
const starName = s => { const t = starT(s); return t < 0.2 ? 'Red dwarf' : t < 0.4 ? 'Orange dwarf' : t < 0.62 ? 'Yellow star' : t < 0.85 ? 'White star' : 'Blue giant'; };
const STAR_RAMP = [[1, 0.3, 0.16], [1, 0.52, 0.22], [1, 0.84, 0.48], [1, 0.97, 0.92], [0.6, 0.75, 1]];
function starColor(t, out) {
  const x = t * (STAR_RAMP.length - 1), i = Math.min(STAR_RAMP.length - 2, x | 0), f = x - i, a = STAR_RAMP[i], b = STAR_RAMP[i + 1];
  return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

const planetT = p => Math.min(1, p.grow / PLANET_GROW);
const planetRadius = p => sysR * (0.016 + 0.068 * Math.pow(planetT(p), 1.2));
const planetName = p => { const t = planetT(p); return t < 0.3 ? 'Rocky world' : t < 0.55 ? 'Ocean world' : t < 0.78 ? 'Ice giant' : 'Gas giant'; };
const hexes = rows => rows.map(r => r.map(c => new THREE.Color(c)));
const ROCKS = hexes([['#5c5148', '#8a7a6a', '#b9b0a5'], ['#6b3a26', '#a85a36', '#d9a27a'], ['#4a4a52', '#77777f', '#b5b5c0'], ['#3d3326', '#7d6a45', '#c9b47f']]);
const WORLDS = hexes([['#12408f', '#3f8f4a', '#ffffff'], ['#0f4f8a', '#b89a5a', '#f2f6ff'], ['#1a5a6a', '#7fae5a', '#ffffff'], ['#1b3a9a', '#5a9a6a', '#eef4ff']]);
const ICES = hexes([['#2f6fb0', '#7fd0e6', '#d9f6ff'], ['#3a4fc0', '#6fa0ff', '#cfe0ff'], ['#2a8f8f', '#8fe6d0', '#e6fff6']]);
const GASES = hexes([['#8a5a32', '#e0b888', '#fff0d8'], ['#a0522d', '#f0c27a', '#ffe6b0'], ['#6a4a7a', '#d09ac0', '#ffe0f0'], ['#7a6a3a', '#e6d28a', '#fffbe0']]);
function planetLook(p) {
  const t = planetT(p), set = t < 0.3 ? ROCKS : t < 0.55 ? WORLDS : t < 0.78 ? ICES : GASES;
  return { c: set[p.seed % set.length], gas: t < 0.55 ? 0 : 1, cloud: t < 0.3 ? 0.12 : 0.8 };
}
const moonLook = m => ({ c: ROCKS[m.seed % ROCKS.length], gas: 0, cloud: 0.1 });

function newStar(p) {
  if (focusG.stars.length >= STAR_MAX) { note('This galaxy has all the stars it can hold. A supernova will clear one away.'); return null; }
  unplace(p.x, p.y, _w);
  const s = mkStar(_w.x, _w.y, 0, newSeed());
  s.held = s.growing = s.isNew = true; s.wx = p.x; s.wy = p.y;
  focusG.stars.push(s);
  return s;
}
function newPlanet(p) {
  const d = Math.hypot(p.x, p.y);
  if (d < sunRadius(focusS) * 0.9) return null; // not inside the sun
  if (focusS.planets.length >= PLANET_MAX) { note('This star has all the planets it can hold. A supernova will smash one.'); return null; }
  const o = mkPlanet(THREE.MathUtils.clamp(d / sysR, orbitMin(focusS), 1), Math.atan2(p.y, p.x), 0, newSeed());
  o.held = o.growing = o.isNew = true; o.wx = p.x; o.wy = p.y;
  focusS.planets.push(o);
  return o;
}
function removeBody(o) {
  if (o.holder && o.holder.grab === o) o.holder.grab = null;
  o.holder = null; o.held = false;
  if (o.kind === 'galaxy') return killGalaxy(o);
  const list = o.kind === 'star' ? focusG?.stars : focusS?.planets, i = list ? list.indexOf(o) : -1;
  if (i >= 0) list.splice(i, 1);
  if (focusS === o) focusS = null;
  if (focusP === o) focusP = null;
  if (terrainOf === o) terrainOf = null;
  markDirty();
}
const inCloud = s => nebulae.some(n => n.space === focusG.id && Math.hypot(n.x - s.u, n.y - s.v) < n.size * 0.6);

// what a pinching hand does, every frame, to the thing it is holding
function holdBody(hand, o, dt) {
  const q = hand.pinchPt;
  if (o.kind === 'galaxy') {
    o.pos.lerp(q, Math.min(1, dt * (o.growing ? 14 : 7)));
    if (hand.grabInv && hand.hasQuat) { // the galaxy turns with the hand
      _q.copy(hand.quat).multiply(hand.grabInv).multiply(hand.grabQ);
      o.quat.slerp(_q, Math.min(1, dt * 10));
    }
    wells.push({ x: q.x, y: q.y, z: q.z, g: 6, r0: o.radius * 0.9, swirl: 5, range: 2 + o.radius * 1.5 }); // nearby stars fall into orbit
  } else if (o.kind === 'star') {
    const k = Math.min(1, dt * 12);
    unplace(q.x, q.y, _w);
    o.u += (_w.x - o.u) * k; o.v += (_w.y - o.v) * k;
    if (o.growing) o.grow = Math.min(STAR_GROW, o.grow + dt * (inCloud(o) ? 2 : 1)); // a dust cloud feeds it twice as fast
    wells.push({ x: q.x, y: q.y, z: 0, g: 5, r0: o.wr + 0.35, swirl: 5, range: 2.5 });
  } else {
    const k = Math.min(1, dt * 12), x = Math.cos(o.a) * o.r * sysR, y = Math.sin(o.a) * o.r * sysR;
    const nx = x + (q.x - x) * k, ny = y + (q.y - y) * k;
    o.r = THREE.MathUtils.clamp(Math.hypot(nx, ny) / sysR, orbitMin(focusS), 1); o.a = Math.atan2(ny, nx);
    if (o.growing) o.grow = Math.min(PLANET_GROW, o.grow + dt);
    wells.push({ x: q.x, y: q.y, z: 0, g: 3, r0: 0.5, swirl: 3, range: 1.8 });
  }
}

// A supernova set off on top of a star or planet takes it along: a star leaves a glowing cloud behind,
// a planet just bursts into rubble.
function shatter(p, power) {
  const list = level === 0 ? galaxies.filter(g => g.alive) : level === 1 && focusG ? focusG.stars : focusS ? focusS.planets : null;
  if (level === 3) return planetImpact(p, power, performance.now() / 1000);
  if (!list || zoomLock) return;
  let best = null, bd = Infinity;
  for (const o of list) {
    if (o.held) continue;
    const d = Math.hypot(o.wx - p.x, o.wy - p.y);
    // a galaxy has to be hit squarely: it may hold whole solar systems, so a near miss leaves it alone
    if (d < (o.kind === 'galaxy' ? Math.max(1, o.radius * 0.6) : o.reach + 0.5) && d < bd) { best = o; bd = d; }
  }
  if (!best) return;
  if (best.kind === 'galaxy') { ring(best.pos, 900, 7 + 4 * power, 0.4); removeBody(best); return; }
  _w.set(best.wx, best.wy, 0);
  ring(_w, 500, 5 + 4 * power, 0.5);
  if (best.kind === 'star') {
    addNebula(focusG.id, best.u, best.v, Math.random() * Math.PI, (1.6 + 2.4 * starT(best)) / galS, paletteIndex, (Math.random() * 3) | 0, Math.random() * 100);
  } else {
    for (let i = 0; i < 260; i++) { // rubble
      const a = Math.random() * TAU, v = 0.5 + Math.random() * 3.5, c = 0.25 + Math.random() * 0.3;
      spawn(best.wx, best.wy, 0, Math.cos(a) * v, Math.sin(a) * v, rnd(0.3), c, c * 0.92, c * 0.82, 0.8 + Math.random() * 1.6, 0.04 + Math.random() * 0.05);
    }
  }
  removeBody(best);
}

const QUAD = new THREE.PlaneGeometry(1, 1);
const NOISE_GLSL = /* glsl */`
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<5;i++){ v += a*noise(p); p = p*2.03 + 17.0; a *= 0.5; } return v; }`;
const QUAD_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// a star: a hot disc (radius 0.3 of the quad) inside a flickering corona
function makeStarMesh() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 }, uAlpha: { value: 1 }, uDetail: { value: 0 }, uCol: { value: new THREE.Color() } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */`
      varying vec2 vUv; uniform float uTime, uSeed, uAlpha, uDetail; uniform vec3 uCol;
      ${NOISE_GLSL}
      void main(){
        vec2 p = (vUv - 0.5) * 2.0; float r = length(p);
        const float R = 0.3;
        float disc = smoothstep(R, R - 0.025, r);
        float limb = sqrt(max(0.0, 1.0 - r * r / (R * R)));
        float gran = fbm(p * 14.0 + uSeed + vec2(uTime * 0.05, -uTime * 0.04));   // boiling surface, once we are close
        vec3 surf = mix(uCol, vec3(1.0), 0.08 + 0.3 * limb) * (1.0 + (gran - 0.5) * 0.9 * uDetail);
        float o = max(0.0, r - R);
        vec2 dir = p / max(r, 1e-4);
        float rays = 0.7 + 0.6 * fbm(dir * 2.2 + uSeed + uTime * 0.12);
        float corona = exp(-o * 12.0) * rays * 0.4 + exp(-o * 4.5) * 0.08;
        vec3 col = surf * disc * mix(0.7, 0.3, uDetail) + uCol * corona * (1.0 - disc);
        col *= smoothstep(1.0, 0.6, r);
        gl_FragColor = vec4(col * uAlpha, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  });
  const m = new THREE.Mesh(QUAD, mat);
  m.frustumCulled = false; m.visible = false; m.renderOrder = 2.5;
  scene.add(m);
  return m;
}

// a planet: a sphere (radius 0.4 of the quad) lit from the direction of its sun, with optional rings
function makePlanetMesh() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 }, uAlpha: { value: 1 }, uGas: { value: 0 }, uCloud: { value: 0 },
      uRing: { value: 0 }, uTilt: { value: 0 }, uLight: { value: new THREE.Vector2(1, 0) },
      uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */`
      varying vec2 vUv; uniform float uTime, uSeed, uAlpha, uGas, uCloud, uRing, uTilt; uniform vec2 uLight; uniform vec3 uA, uB, uC;
      ${NOISE_GLSL}
      void main(){
        vec2 p = (vUv - 0.5) * 2.0; float r = length(p);
        const float R = 0.4;
        float disc = smoothstep(R, R - 0.02, r);
        vec2 q = p / R; float z = sqrt(max(0.0, 1.0 - dot(q, q)));
        vec3 L = normalize(vec3(uLight, 0.4));
        float lit = 0.03 + 0.97 * pow(max(0.0, dot(vec3(q, z), L)), 0.85);
        vec2 s = vec2(q.x / (0.6 + z) + uTime * 0.05, q.y) + uSeed;               // the surface, slowly turning
        float bands = fbm(vec2(s.x * 1.2 + fbm(s * 3.0) * 0.5, q.y * 6.0 + uSeed));
        float land = smoothstep(0.44, 0.56, fbm(s * 3.2));
        vec3 surf = mix(uA, uB, mix(land, bands, uGas));
        surf = mix(surf, uC, smoothstep(0.55, 0.72, fbm(s * 5.0 + 7.0)) * uCloud * (1.0 - 0.6 * uGas));
        vec3 col = surf * lit * disc;
        float a = disc;
        float halo = smoothstep(R * 1.14, R, r) * (1.0 - disc);                    // a breath of atmosphere on the lit side
        col += uC * halo * 0.22 * clamp(dot(p / max(r, 1e-4), uLight) * 0.6 + 0.5, 0.0, 1.0);
        if (uRing > 0.0) {
          float c = cos(uTilt), sn = sin(uTilt);
          vec2 rq = vec2(c * p.x + sn * p.y, -sn * p.x + c * p.y);
          float front = step(rq.y, 0.0);
          rq.y /= 0.3;
          float rr = length(rq) / R, outer = 1.35 + uRing * 0.95;
          float m = smoothstep(1.22, 1.27, rr) * smoothstep(outer, outer - 0.06, rr) * (0.5 + 0.5 * sin(rr * 34.0 + uSeed));
          float vis = m * mix(1.0 - disc, 1.0, front) * 0.75;
          col = mix(col, mix(uB, uC, 0.5) * 0.5, vis);
          a = max(a, vis);
        }
        gl_FragColor = vec4(col * uAlpha, a * uAlpha);                             // premultiplied: a planet hides what is behind it
      }`,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    depthWrite: false, depthTest: false, transparent: true,
  });
  const m = new THREE.Mesh(QUAD, mat);
  m.frustumCulled = false; m.visible = false; m.renderOrder = 2.6;
  scene.add(m);
  return m;
}

const orbitGeo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, i) => new THREE.Vector3(Math.cos(i / 128 * TAU), Math.sin(i / 128 * TAU), 0)));
function makeOrbit() {
  const o = new THREE.LineLoop(orbitGeo, new THREE.LineBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthTest: false }));
  o.frustumCulled = false; o.visible = false; o.renderOrder = 1.8;
  scene.add(o);
  return o;
}

const starPool = [], planetPool = [], orbitPool = [];
function drawPlanet(i, x, y, r, seed, look, rings, lx, ly, alpha) {
  const m = planetPool[i] || (planetPool[i] = makePlanetMesh()), u = m.material.uniforms;
  m.visible = true; m.position.set(x, y, 0); m.scale.setScalar(r * 5);
  u.uA.value.copy(look.c[0]); u.uB.value.copy(look.c[1]); u.uC.value.copy(look.c[2]);
  u.uGas.value = look.gas; u.uCloud.value = look.cloud; u.uRing.value = rings;
  u.uSeed.value = seed % 100; u.uTilt.value = ((seed % 7) - 3) * 0.14; u.uLight.value.set(lx, ly);
  u.uTime.value = bodyTime; u.uAlpha.value = alpha;
}

function updateBodies(dt, now) {
  let ns = 0, np = 0, no = 0;
  // Landing on a planet: the whole system swells around it until that one planet fills the view.
  const fp = focusP && focusS && E3 > 0 ? focusP : null;
  let z3 = 1, fx = 0, fy = 0;
  if (fp) { globeR = Math.min(viewW, viewH) * 0.34; z3 = Math.pow(globeR / planetRadius(fp), E3); fx = Math.cos(fp.a) * fp.r * sysR; fy = Math.sin(fp.a) * fp.r * sysR; }
  const tx = x => (x - fx) * z3 + fx * (1 - E3), ty = y => (y - fy) * z3 + fy * (1 - E3), fade = E2 * (1 - E3);
  globe.visible = false;
  if (focusG && E1 > 0.002) {
    const k = gK / galS;
    for (const s of focusG.stars) {
      const focus = s === focusS && E2 > 0;
      place(s.u, s.v, _w);
      // the star we are diving toward swells into a sun; the others slide away and fade
      const r = (focus ? THREE.MathUtils.lerp(starRadius(s) * k, sunRadius(s), E2) : starRadius(s) * k * zM) * (1 - 0.9 * s.swallow);
      const a = E1 * (focus ? 1 - E3 : 1 - E2);
      s.wx = _w.x; s.wy = _w.y; s.wr = r; s.reach = Math.max(1.4, r + 0.8);
      if (a < 0.003) continue;
      const m = starPool[ns] || (starPool[ns] = makeStarMesh()), u = m.material.uniforms; ns++;
      m.visible = true; m.position.set(tx(_w.x), ty(_w.y), 0); m.scale.setScalar(r * z3 / 0.3 * 2);
      starColor(starT(s), u.uCol.value);
      u.uSeed.value = s.seed % 100; u.uTime.value = bodyTime; u.uDetail.value = focus ? E2 : 0;
      u.uAlpha.value = a * (s.held && s.growing ? 1.15 : 1);
    }
  }
  for (let i = ns; i < starPool.length; i++) starPool[i].visible = false;

  const s = focusS;
  if (s && E2 > 0.002) {
    for (const p of s.planets) {
      if (!p.held && p.swallow <= 0 && !fp) p.a += dt * 0.11 / Math.pow(p.r, 1.5); // inner planets race, outer ones crawl; all wait while we are down on one
      const R = p.r * sysR * E2, cx = Math.cos(p.a), cy = Math.sin(p.a), x = tx(cx * R), y = ty(cy * R), shrink = 1 - 0.9 * p.swallow;
      const pr = planetRadius(p) * (0.4 + 0.6 * E2) * shrink * z3;
      p.wx = x; p.wy = y; p.reach = Math.max(1.1, pr + 0.7);
      if (p === fp) updateGlobe(dt, now, x, y, pr, -cx, -cy); // the far-off dot gives way to the real globe
      drawPlanet(np++, x, y, pr, p.seed, planetLook(p), p.rings, -cx, -cy, p === fp ? E2 * Math.max(0, 1 - E3 * 4) : fade);
      for (const m of p.moons) {
        m.a += dt * 0.9 / (0.5 + m.d);
        const md = pr * (1.7 + 3.3 * m.d) + 0.1 * z3;
        drawPlanet(np++, x + Math.cos(m.a) * md, y + Math.sin(m.a) * md, sysR * (0.008 + (m.seed % 5) * 0.001) * shrink * z3, m.seed, moonLook(m), 0, -cx, -cy, fade);
      }
      const o = orbitPool[no] || (orbitPool[no] = makeOrbit()); no++;
      o.visible = true; o.position.set(tx(0), ty(0), 0); o.scale.setScalar(Math.max(1e-3, R * z3)); o.material.opacity = (p.held ? 0.4 : 0.14) * fade;
    }
  }
  for (let i = np; i < planetPool.length; i++) planetPool[i].visible = false;
  for (let i = no; i < orbitPool.length; i++) orbitPool[i].visible = false;
}

// ---------------------------------------------------------------- planet surfaces
// The fourth level: one planet, close up, as a globe you can reshape. A rocky or ocean world has real
// terrain: a height map wrapped round the sphere, built from the planet's seed and then edited by hand.
// Gas and ice giants have no ground, so they get weather instead: bands, winds and storms.
const MAP_W = 256, MAP_H = 128, MAP_N = MAP_W * MAP_H;
const mapH = new Float32Array(MAP_N), mapBase = new Float32Array(MAP_N), mapR = new Float32Array(MAP_N); // height now, height as generated, rivers
const mapHalf = new Uint16Array(MAP_N * 4);
const mapTex = new THREE.DataTexture(mapHalf, MAP_W, MAP_H, THREE.RGBAFormat, THREE.HalfFloatType);
mapTex.wrapS = THREE.RepeatWrapping; mapTex.wrapT = THREE.ClampToEdgeWrapping;
mapTex.magFilter = mapTex.minFilter = THREE.LinearFilter; mapTex.generateMipmaps = false;
const colSin = new Float32Array(MAP_W), colCos = new Float32Array(MAP_W), rowSin = new Float32Array(MAP_H), rowCos = new Float32Array(MAP_H);
for (let i = 0; i < MAP_W; i++) { const lon = ((i + 0.5) / MAP_W - 0.5) * TAU; colSin[i] = Math.sin(lon); colCos[i] = Math.cos(lon); }
for (let j = 0; j < MAP_H; j++) { const lat = ((j + 0.5) / MAP_H - 0.5) * Math.PI; rowSin[j] = Math.sin(lat); rowCos[j] = Math.cos(lat); }

const planetKind = p => { const t = planetT(p); return t < 0.3 ? 'rock' : t < 0.55 ? 'ocean' : t < 0.78 ? 'ice' : 'gas'; };
const isSolid = p => planetT(p) < 0.55;
const SEA_MIN = -1.05, SEA_MAX = 1.1, H_MIN = -1.4, H_MAX = 1.4, SPOT_MAX = 8;

// seeded 3D noise, so terrain wraps round the sphere without a seam
function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ s;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = hash3(xi, yi, zi, s), b = hash3(xi + 1, yi, zi, s), c = hash3(xi, yi + 1, zi, s), d = hash3(xi + 1, yi + 1, zi, s);
  const e = hash3(xi, yi, zi + 1, s), f = hash3(xi + 1, yi, zi + 1, s), g = hash3(xi, yi + 1, zi + 1, s), h = hash3(xi + 1, yi + 1, zi + 1, s);
  const lo = a + (b - a) * fx + (c + (d - c) * fx - a - (b - a) * fx) * fy, hi = e + (f - e) * fx + (g + (h - g) * fx - e - (f - e) * fx) * fy;
  return lo + (hi - lo) * fz;
}
function fbm3(x, y, z, s, oct) {
  let v = 0, a = 0.5;
  for (let o = 0; o < oct; o++) { v += a * noise3(x, y, z, s + o * 131); x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; }
  return v;
}

// every map texel within `rad` radians of a point on the sphere: fn(index, distance as a fraction of rad)
let dirtyLo = MAP_H, dirtyHi = -1;
function brush(lon, lat, rad, fn) {
  const cl = Math.cos(lat), cx = Math.sin(lon) * cl, cy = Math.sin(lat), cz = Math.cos(lon) * cl;
  const j0 = Math.max(0, Math.floor((lat - rad) / Math.PI * MAP_H + MAP_H / 2)), j1 = Math.min(MAP_H - 1, Math.ceil((lat + rad) / Math.PI * MAP_H + MAP_H / 2));
  const ic = Math.floor((lon / TAU + 0.5) * MAP_W), half = MAP_W / 2;
  for (let j = j0; j <= j1; j++) {
    const all = rowCos[j] < 0.06 || Math.abs(lat) + rad > Math.PI / 2, span = all ? half : Math.min(half, Math.ceil(rad / rowCos[j] / TAU * MAP_W) + 1);
    for (let di = -span; di < (span === half ? span : span + 1); di++) {
      const i = ((ic + di) % MAP_W + MAP_W) % MAP_W;
      const d = Math.acos(Math.min(1, cx * colSin[i] * rowCos[j] + cy * rowSin[j] + cz * colCos[i] * rowCos[j]));
      if (d < rad) fn(j * MAP_W + i, d / rad);
    }
  }
  dirtyLo = Math.min(dirtyLo, j0); dirtyHi = Math.max(dirtyHi, j1);
}
function syncMap(all) { // copy edited rows into the texture
  if (all) { dirtyLo = 0; dirtyHi = MAP_H - 1; }
  if (dirtyHi < dirtyLo) return;
  for (let k = dirtyLo * MAP_W, e = (dirtyHi + 1) * MAP_W; k < e; k++) {
    mapHalf[k * 4] = THREE.DataUtils.toHalfFloat(mapH[k]); mapHalf[k * 4 + 1] = THREE.DataUtils.toHalfFloat(mapR[k]);
  }
  mapTex.needsUpdate = true; dirtyLo = MAP_H; dirtyHi = -1;
}
const clampH = v => (v < H_MIN ? H_MIN : v > H_MAX ? H_MAX : v);
function stampCrater(H, lon, lat, rad, depth) { // a bowl with a raised rim; anything in it (rivers too) is gone
  brush(lon, lat, rad * 1.5, (k, d0) => {
    const d = d0 * 1.5;
    let v = H[k] + depth * 0.35 * Math.exp(-(((d - 1) / 0.22) ** 2));
    if (d < 1) { v -= depth * (1 - d * d); if (H === mapH) mapR[k] = 0; }
    H[k] = clampH(v);
  });
}

// Build a planet's terrain from its seed. Returns the sea level it starts with.
function generateTerrain(p, H) {
  const ocean = planetKind(p) === 'ocean', r = mulberry32(p.seed ^ 0x51ed270b), s = p.seed | 0;
  const f = 1.2 + r() * 1.2, ox = r() * 40, oy = r() * 40, oz = r() * 40, rough = 0.35 + r() * 0.5;
  for (let j = 0, k = 0; j < MAP_H; j++) for (let i = 0; i < MAP_W; i++, k++) {
    const x = colSin[i] * rowCos[j], y = rowSin[j], z = colCos[i] * rowCos[j];
    if (ocean) { // continents, with mountain ranges ridged up along their spines
      let h = (fbm3(x * f + ox, y * f + oy, z * f + oz, s, 6) - 0.5) * 2.7;
      if (h > 0) { const rg = 1 - Math.abs(2 * fbm3(x * 3.3 + oz, y * 3.3 + ox, z * 3.3 + oy, s + 977, 5) - 1); h += rg * rg * rough * Math.min(1, h * 4); }
      H[k] = clampH(h);
    } else H[k] = (fbm3(x * f + ox, y * f + oy, z * f + oz, s, 6) - 0.5) * 1.1 + (fbm3(x * 6 + oy, y * 6 + oz, z * 6 + ox, s + 31, 4) - 0.5) * 0.3 * rough;
  }
  if (!ocean) { // a dry, battered world
    for (let n = 25 + ((r() * 45) | 0); n > 0; n--) {
      const rad = 0.03 + r() * r() * 0.2;
      stampCrater(H, (r() - 0.5) * TAU, Math.asin(r() * 2 - 1), rad, rad * (0.8 + r() * 0.8));
    }
    return SEA_MIN;
  }
  return (r() - 0.4) * 0.3;
}

// Only what was changed by hand is stored: the difference from the generated terrain, run-length packed.
function pack(n, at) {
  let s = '', any = false;
  for (let i = 0; i < n;) {
    const v = at(i); let run = 1;
    while (run < 255 && i + run < n && at(i + run) === v) run++;
    if (v) any = true;
    s += String.fromCharCode(run, v); i += run;
  }
  return any ? btoa(s) : '';
}
function unpack(b64, n, put) {
  const s = atob(b64);
  for (let c = 0, i = 0; c + 1 < s.length && i < n; c += 2) for (let run = s.charCodeAt(c), v = s.charCodeAt(c + 1); run > 0 && i < n; run--, i++) put(i, v);
}
let terrainOf = null, terrainDirty = false, seaDefault = 0;
function storeTerrain() {
  if (!terrainOf || !terrainDirty) return;
  terrainDirty = false;
  if (!isSolid(terrainOf)) return;
  const h = pack(MAP_N, i => (Math.max(-127, Math.min(127, Math.round((mapH[i] - mapBase[i]) * 80))) + 256) & 255), r = pack(MAP_N, i => Math.round(mapR[i] * 15));
  terrainOf.map = h || r ? { h, r } : null;
}
function loadTerrain(p) {
  storeTerrain();
  terrainOf = p; terrainDirty = false;
  if (!isSolid(p)) return;
  rng = Math.random;
  seaDefault = generateTerrain(p, mapBase);
  dirtyLo = MAP_H; dirtyHi = -1;
  mapH.set(mapBase); mapR.fill(0);
  if (p.map) try {
    if (p.map.h) unpack(p.map.h, MAP_N, (i, v) => { mapH[i] = clampH(mapBase[i] + (v > 127 ? v - 256 : v) / 80); });
    if (p.map.r) unpack(p.map.r, MAP_N, (i, v) => { mapR[i] = v / 15; });
  } catch (err) { console.warn('Could not restore this planet\'s terrain:', err); }
  syncMap(true);
}
const seaOf = p => (p.sea == null ? seaDefault : p.sea);

// --- the globe
const NOISE3_GLSL = /* glsl */`
  float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hash3(i), hash3(i+vec3(1,0,0)), f.x), mix(hash3(i+vec3(0,1,0)), hash3(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(hash3(i+vec3(0,0,1)), hash3(i+vec3(1,0,1)), f.x), mix(hash3(i+vec3(0,1,1)), hash3(i+vec3(1,1,1)), f.x), f.y), f.z); }
  float fbm3(vec3 p){ float v = 0.0, a = 0.5; for(int i=0;i<4;i++){ v += a*noise3(p); p = p*2.03 + 7.0; a *= 0.5; } return v; }`;
const col3 = (r, g, b) => ({ value: new THREE.Color().setRGB(r, g, b) });
const globeMat = new THREE.ShaderMaterial({
  uniforms: { uMap: { value: mapTex }, uRot: { value: new THREE.Matrix3() }, uLight: { value: new THREE.Vector3(0, 0, 1) },
    uTime: { value: 0 }, uSeed: { value: 0 }, uAlpha: { value: 0 }, uKind: { value: 0 }, uSea: { value: 0 }, uBase: { value: -1.5 }, uSnow: { value: 0.55 }, uPolar: { value: 0.5 },
    uCloud: { value: 0 }, uRing: { value: 0 }, uTilt: { value: 0 }, uBands: { value: 9 }, uWind: { value: 1 },
    uDeep: col3(0, 0, 0), uShallow: col3(0, 0, 0), uSand: col3(0, 0, 0), uLow: col3(0, 0, 0), uHigh: col3(0, 0, 0), uPeak: col3(1, 1, 1), uAtm: col3(0, 0, 0),
    uSpots: { value: Array.from({ length: SPOT_MAX }, () => new THREE.Vector4()) } },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D uMap; uniform mat3 uRot; uniform vec3 uLight, uDeep, uShallow, uSand, uLow, uHigh, uPeak, uAtm;
    uniform float uTime, uSeed, uAlpha, uKind, uSea, uBase, uSnow, uPolar, uCloud, uRing, uTilt, uBands, uWind;
    uniform vec4 uSpots[${SPOT_MAX}];
    ${NOISE3_GLSL}
    void main(){
      vec2 p = (vUv - 0.5) * 2.0; float r = length(p);
      const float R = 0.4;
      float disc = smoothstep(R, R - 0.004, r);
      vec2 q = p / R; float z = sqrt(max(0.0, 1.0 - dot(q, q)));
      vec3 m = uRot * vec3(q, z), Lp = uRot * uLight;          // this point, and the sun, in the planet's own frame
      float lat = asin(clamp(m.y, -1.0, 1.0)), lon = atan(m.x, m.z);
      vec3 col, N = m; float spec = 0.0;
      if (uKind < 0.5) {
        vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.14159265 + 0.5);
        vec4 t = texture2D(uMap, uv);
        const float ex = 1.0 / ${MAP_W}.0, ey = 1.0 / ${MAP_H}.0;
        float gE = (texture2D(uMap, uv + vec2(ex, 0.0)).r - texture2D(uMap, uv - vec2(ex, 0.0)).r) / (2.0 * ex * 6.2831853 * max(0.12, cos(lat)));
        float gN = (texture2D(uMap, uv + vec2(0.0, ey)).r - texture2D(uMap, uv - vec2(0.0, ey)).r) / (2.0 * ey * 3.14159265);
        float fine = fbm3(m * 22.0 + uSeed);
        float h = t.r + (fine - 0.5) * 0.06, depth = uSea - h;
        float ground = max(uSea, uBase);                          // heights are judged from the sea, or on a dry world from its plains
        bool wet = depth > 0.0 || t.g > 0.5;
        if (wet) {                                                // sea, lake or river
          col = mix(uShallow, uDeep, smoothstep(0.0, 0.3, depth));
          spec = pow(max(0.0, dot(m, normalize(Lp + uRot * vec3(0.0, 0.0, 1.0)))), 220.0) * 0.45;
        } else {                                                  // shore, lowland, highland
          float el = h - ground;
          col = mix(uSand, uLow, smoothstep(0.0, 0.035, el + (uSea < uBase ? 0.25 : 0.0)));
          col = mix(col, uHigh, smoothstep(0.14, 0.42, el + (fine - 0.5) * 0.1));
          col *= 0.85 + 0.3 * fine;
          vec3 east = normalize(vec3(m.z, 0.0, -m.x) + 1e-5), north = cross(m, east);
          N = normalize(m - 0.1 * (east * gE + north * gN));     // slopes catch the light
        }
        float line = uSnow - abs(lat) * uPolar;                   // snow on the peaks, lower and lower toward the poles
        float ice = smoothstep(line, line + 0.07, (wet ? -0.05 : h - ground) + (fine - 0.5) * 0.12);
        col = mix(col, uPeak, ice); spec *= 1.0 - ice;
      } else {                                                    // a giant: bands of cloud sliding past each other
        float lonF = lon + uTime * 0.02 * uWind * (1.0 + 2.0 * sin(lat * uBands * 0.7 + uSeed));
        vec3 mf = vec3(sin(lonF) * cos(lat), m.y, cos(lonF) * cos(lat));
        float turb = fbm3(mf * vec3(3.0, 9.0, 3.0) + uSeed);
        col = mix(uLow, uHigh, 0.5 + 0.5 * sin(lat * uBands + (turb - 0.5) * 3.0 * (0.4 + 0.3 * uWind)));
        col = mix(col, uPeak, smoothstep(0.55, 0.8, fbm3(mf * vec3(5.0, 22.0, 5.0) + 3.0 + uSeed)) * 0.45);
        for (int i = 0; i < ${SPOT_MAX}; i++) {                   // storms, and the scars of impacts
          vec4 s = uSpots[i];
          if (s.z <= 0.0) continue;
          float dl = lon - s.x; dl = atan(sin(dl), cos(dl));
          vec2 o = vec2(dl * cos(lat) * 0.6, lat - s.y) / s.z; float rr = length(o);
          if (rr < 1.0) {
            float sw = 0.5 + 0.5 * sin(atan(o.y, o.x) * 2.0 + rr * 9.0 - uTime * 0.8);
            vec3 sc = s.w > 0.5 ? vec3(0.03, 0.02, 0.02) : mix(uPeak, vec3(0.8, 0.25, 0.12), 0.6) * (0.75 + 0.25 * sw);
            col = mix(col, sc, smoothstep(1.0, 0.55, rr) * 0.88);
          }
        }
      }
      float sun = dot(m, Lp), day = smoothstep(-0.06, 0.16, sun);
      col = col * (0.07 + 0.93 * pow(max(0.0, dot(N, Lp)), 0.8) * day) + spec * day;
      float ca = cos(uTime * 0.012), sa = sin(uTime * 0.012);      // weather drifting over it all
      float cloud = smoothstep(0.5, 0.72, fbm3(vec3(m.x * ca - m.z * sa, m.y, m.x * sa + m.z * ca) * 3.2 + uSeed * 1.7)) * uCloud;
      col = mix(col, vec3(0.07 + 0.93 * max(0.0, sun)), cloud);
      col += uAtm * pow(1.0 - z, 2.5) * 0.5 * max(0.0, sun * 0.7 + 0.3);
      col *= disc * 0.6;                                          // a whole lit globe is a lot of light for the bloom to chew on
      float a = disc;
      col += uAtm * smoothstep(R * 1.1, R, r) * (1.0 - disc) * 0.3 * clamp(dot(p / max(r, 1e-4), uLight.xy) * 0.6 + 0.5, 0.0, 1.0);
      if (uRing > 0.0) {
        float c = cos(uTilt), sn = sin(uTilt);
        vec2 rq = vec2(c * p.x + sn * p.y, -sn * p.x + c * p.y);
        float front = step(rq.y, 0.0);
        rq.y /= 0.3;
        float rr = length(rq) / R, outer = 1.35 + uRing * 0.95;
        float mk = smoothstep(1.22, 1.27, rr) * smoothstep(outer, outer - 0.06, rr) * (0.5 + 0.5 * sin(rr * 34.0 + uSeed));
        float vis = mk * mix(1.0 - disc, 1.0, front) * 0.75;
        col = mix(col, mix(uHigh, uPeak, 0.5) * 0.5, vis);
        a = max(a, vis);
      }
      gl_FragColor = vec4(col * uAlpha, a * uAlpha);
    }`,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  depthWrite: false, depthTest: false, transparent: true,
});
const globe = new THREE.Mesh(QUAD, globeMat);
globe.frustumCulled = false; globe.visible = false; globe.renderOrder = 2.7;
scene.add(globe);

const SEA_DEEP = new THREE.Color(0.01, 0.04, 0.16), SEA_SHALLOW = new THREE.Color(0.04, 0.22, 0.36), SAND = new THREE.Color(0.55, 0.47, 0.3);
const ROCK_HIGH = new THREE.Color(0.2, 0.17, 0.15), WHITE = new THREE.Color(1, 1, 1), SKY = new THREE.Color(0.25, 0.45, 1);
function globeLook(p, u) {
  const kind = planetKind(p), c = planetLook(p).c;
  u.uKind.value = isSolid(p) ? 0 : 1; u.uSeed.value = p.seed % 100; u.uRing.value = p.rings; u.uTilt.value = ((p.seed % 7) - 3) * 0.14;
  if (kind === 'ocean') {
    u.uDeep.value.copy(c[0]).multiplyScalar(0.45); u.uShallow.value.copy(c[0]).lerp(SEA_SHALLOW, 0.5); u.uSand.value.copy(SAND);
    u.uLow.value.copy(c[1]); u.uHigh.value.copy(ROCK_HIGH); u.uPeak.value.copy(WHITE); u.uAtm.value.copy(SKY);
    u.uSnow.value = 0.68; u.uPolar.value = 0.6; u.uCloud.value = 0.6; u.uBase.value = SEA_MIN;
  } else if (kind === 'rock') { // dry to begin with, but it will hold water if you give it some
    u.uDeep.value.copy(SEA_DEEP); u.uShallow.value.copy(SEA_SHALLOW); u.uSand.value.copy(c[0]).lerp(c[1], 0.5);
    u.uLow.value.copy(c[0]); u.uHigh.value.copy(c[1]); u.uPeak.value.copy(c[2]).lerp(WHITE, 0.6); u.uAtm.value.copy(c[2]).multiplyScalar(0.25);
    u.uSnow.value = 0.95; u.uPolar.value = p.seed % 3 ? 0.62 : 0.1; u.uCloud.value = 0; u.uBase.value = -0.2;
  } else {
    u.uLow.value.copy(c[0]); u.uHigh.value.copy(c[1]); u.uPeak.value.copy(c[2]); u.uAtm.value.copy(c[1]).multiplyScalar(0.6);
    u.uBands.value = kind === 'ice' ? 5 + (p.seed % 3) : 8 + (p.seed % 5); u.uCloud.value = 0; u.uWind.value = p.wind ?? 1;
    u.uSpots.value.forEach((v, i) => { const s = p.spots[i]; if (s) v.set(s[0], s[1], s[2], s[3]); else v.set(0, 0, 0, 0); });
  }
}

// The globe's orientation is the planet's frame seen from here. One open hand drags it round; left alone it turns on its axis.
const globeQ = new THREE.Quaternion(), _gq = new THREE.Quaternion(), _gv = new THREE.Vector3(), _gm = new THREE.Matrix4();
const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Y = new THREE.Vector3(0, 1, 0), at = { lon: 0, lat: 0 };
let globeR = 3.5, globeWx = 0, globeWy = 0, globeTouched = -10, globeBusy = -10;
// the spot on the planet under a point on the screen (false if it misses, or we have not arrived yet)
function globePoint(x, y) {
  if (level !== 3 || E3 < 0.9 || zoomLock) return false;
  const qx = x / globeR, qy = y / globeR, d2 = qx * qx + qy * qy;
  if (d2 > 0.94) return false;
  _gv.set(qx, qy, Math.sqrt(1 - d2)).applyQuaternion(_gq.copy(globeQ).invert());
  at.lon = Math.atan2(_gv.x, _gv.z); at.lat = Math.asin(Math.max(-1, Math.min(1, _gv.y)));
  return true;
}
function touched(now) { globeBusy = now; terrainDirty = true; markDirty(); }
function dust(x, y, n, r, g, b) { for (let i = 0; i < n; i++) spawn(x + rnd(0.1), y + rnd(0.1), 0, rnd(0.8), rnd(0.8) + 0.3, 0, r, g, b, 0.3 + Math.random() * 0.5, 0.04 + Math.random() * 0.04); }

// pinch: pull mountains up out of the ground, or on a giant, wind up a storm
function planetPinch(hand, now, dt) {
  const p = focusP, q = hand.pinchPt;
  if (!p || now - hand.pinchAt < 0.15 || !globePoint(q.x, q.y)) return;
  if (isSolid(p)) {
    brush(at.lon, at.lat, 0.17, (k, d) => { const w = 1 - d * d; mapH[k] = clampH(mapH[k] + dt * 0.32 * w * w); });
    dust(q.x, q.y, 2, 0.5, 0.45, 0.4);
  } else {
    if (!hand.spot) { hand.spot = [at.lon, at.lat, 0.03, 0]; p.spots.push(hand.spot); if (p.spots.length > SPOT_MAX) p.spots.shift(); }
    hand.spot[2] = Math.min(0.42, hand.spot[2] + dt * 0.07);
    dust(q.x, q.y, 1, 0.6, 0.4, 0.3);
  }
  touched(now);
}
// point: a fingertip run across the land leaves a river behind it
function planetDraw(hand, now) {
  const p = focusP, a = hand.prevTip, b = hand.tips[1];
  if (!p || !isSolid(p)) return;
  for (let s = 1; s <= 4; s++) {
    if (!globePoint(a.x + (b.x - a.x) * s / 4, a.y + (b.y - a.y) * s / 4)) continue;
    brush(at.lon, at.lat, 0.04, (k, d) => { const w = 1 - d; mapR[k] = Math.max(mapR[k], Math.min(1, w * 2.2)); mapH[k] = clampH(mapH[k] - 0.003 * w); });
    touched(now);
  }
}
// a supernova over the planet arrives as a meteor: the harder the fist was held, the bigger the crater
function planetImpact(pt, power, now) {
  const p = focusP;
  if (!p || !globePoint(pt.x, pt.y)) return;
  if (isSolid(p)) stampCrater(mapH, at.lon, at.lat, 0.07 + 0.2 * power, 0.14 + 0.3 * power);
  else { p.spots.push([at.lon, at.lat, 0.05 + 0.12 * power, 1]); if (p.spots.length > SPOT_MAX) p.spots.shift(); }
  touched(now);
}
// two fingertips: spread them to raise the sea (or whip up a giant's winds), close them to drain it
function planetTide(d, now) {
  const p = focusP;
  if (!p || E3 < 0.9 || zoomLock) return;
  if (!sculpt) sculpt = { tide: true, d };
  const step = d - sculpt.d; sculpt.d = d;
  if (isSolid(p)) p.sea = THREE.MathUtils.clamp(seaOf(p) + step * 0.06, SEA_MIN, SEA_MAX);
  else p.wind = THREE.MathUtils.clamp((p.wind ?? 1) + step * 0.3, 0, 5);
  if (step) touched(now);
}
function planetSpin(hand, now) {
  if (level !== 3 || E3 < 0.9 || Math.hypot(hand.pos.x, hand.pos.y) > globeR * 1.3) return;
  globeWx += (hand.vel.x / globeR - globeWx) * 0.25; globeWy += (hand.vel.y / globeR - globeWy) * 0.25;
  globeTouched = now;
}

function updateGlobe(dt, now, px, py, radius, lx, ly) {
  const p = focusP, u = globeMat.uniforms;
  if (terrainOf !== p) { loadTerrain(p); globeQ.setFromAxisAngle(AXIS_X, 0.35); globeWx = globeWy = 0; }
  if (now - globeTouched > 0.1) { const k = Math.exp(-2.5 * dt); globeWx *= k; globeWy *= k; }
  globeQ.premultiply(_gq.setFromAxisAngle(AXIS_Y, globeWx * dt)).premultiply(_gq.setFromAxisAngle(AXIS_X, -globeWy * dt));
  if (now - globeBusy > 1.5 && now - globeTouched > 1.5) globeQ.multiply(_gq.setFromAxisAngle(AXIS_Y, dt * 0.04)); // idling: it turns on its own axis
  globeQ.normalize();
  syncMap(false);
  globeLook(p, u);
  u.uRot.value.setFromMatrix4(_gm.makeRotationFromQuaternion(_gq.copy(globeQ).invert()));
  u.uLight.value.set(lx * 0.75, ly * 0.75, 0.8).normalize();
  u.uSea.value = isSolid(p) ? seaOf(p) : 0; u.uTime.value = bodyTime; u.uAlpha.value = Math.min(1, E3 * 4);
  globe.visible = true; globe.position.set(px, py, 0); globe.scale.setScalar(radius * 5);
}

ambient.renderOrder = 0; particles.renderOrder = 2;

// --- nebulae: touch two pointing fingertips together, then draw them apart to stretch a cloud between them.
// Each one belongs to a space: the universe (0) or the inside of one galaxy (that galaxy's id).
const NEBULA_MAX = 4, nebulae = [], nebulaPool = [];
function makeNebulaMesh() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSeed: { value: 0 }, uAlpha: { value: 0 },
      uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; uniform float uTime, uSeed, uAlpha; uniform vec3 uA, uB, uC;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<6;i++){ v += a*noise(p); p = p*2.03 + 17.0; a *= 0.5; } return v; }
      void main(){
        vec2 p = (vUv - 0.5) * 2.0;
        vec2 q = p * 2.0 + uSeed;
        vec2 w = vec2(fbm(q + uTime * 0.035), fbm(q + 5.2 - uTime * 0.03));   // slow billowing
        float n = fbm(q + w * 1.8), n2 = fbm(q * 2.3 + w * 2.5 + 9.0);
        float mask = smoothstep(1.0, 0.1, length(p * vec2(1.0, 1.2)) + (n - 0.5) * 0.9) * smoothstep(1.0, 0.72, length(p));
        float cloud = pow(n, 1.7) * 1.9;
        float fil = pow(1.0 - abs(n2 * 2.0 - 1.0), 5.0);                       // bright filaments
        float dust = smoothstep(0.38, 0.6, fbm(q * 1.7 - w * 1.4 + 3.0));      // dark lanes
        vec3 col = mix(uA, uB, smoothstep(0.35, 0.65, w.x)) * cloud + uC * fil * 0.55;
        col *= mix(0.25, 1.0, dust);
        vec2 sp = p * 46.0 + uSeed; vec2 f = fract(sp) - 0.5;                   // young stars inside the cloud
        col += vec3(1.0, 0.96, 0.9) * step(0.985, hash(floor(sp))) * smoothstep(0.3, 0.0, length(f)) * 1.6;
        gl_FragColor = vec4(col * mask * uAlpha * 0.17, 1.0);
      }`,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.visible = false; mesh.renderOrder = 1.5; mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
// x, y and size are in the units of the nebula's own space: world units out in the universe, galaxy radii inside one
function addNebula(space, x, y, rot, size, pal, ci, seed) {
  const same = nebulae.filter(n => n.space === space);
  if (same.length >= NEBULA_MAX) dropNebula(same[0]); // the oldest cloud in that space makes way
  const mesh = nebulaPool.pop() || makeNebulaMesh(), u = mesh.material.uniforms, c = PALETTES[pal % PALETTES.length].colors;
  u.uA.value.copy(c[ci % c.length]); u.uB.value.copy(c[(ci + 1) % c.length]); u.uC.value.copy(c[(ci + 2) % c.length]);
  u.uSeed.value = seed;
  const n = { mesh, space, x, y, rot, size, pal, ci, seed, held: false, born: 0 };
  nebulae.push(n);
  markDirty();
  return n;
}
function dropNebula(n) {
  const i = nebulae.indexOf(n);
  if (i < 0) return;
  nebulae.splice(i, 1); n.mesh.visible = false; nebulaPool.push(n.mesh);
  if (nebula === n) nebula = null;
}
let nebula = null, nebulaLost = 0; // the one being pulled right now
let sculpt = null;                 // ...or, inside a solar system, the planet being given rings or a moon

// Inside a solar system the same gesture works on a planet: the first pull draws out rings, later ones add moons.
function sculptPlanet(mx, my, d) {
  if (!focusS || zoomLock) return;
  if (!sculpt && d < T.nebulaTouch) {
    let best = null, bd = Infinity;
    for (const p of focusS.planets) {
      const q = Math.hypot(p.wx - mx, p.wy - my);
      if (q < p.reach + 0.4 && q < bd) { best = p; bd = q; }
    }
    if (!best) return;
    sculpt = { p: best, moon: null };
    if (best.rings && best.moons.length < MOON_MAX) { sculpt.moon = { d: 0, a: Math.random() * TAU, seed: newSeed() }; best.moons.push(sculpt.moon); }
  }
  if (sculpt) {
    const pull = clamp01((d - 0.6) / 5);
    if (sculpt.moon) sculpt.moon.d = pull; else sculpt.p.rings = Math.max(0.12, pull);
  }
}

function updateNebulae(dt, L, R) {
  const both = L.active && R.active && L.gesture === 'point' && R.gesture === 'point';
  const space = level === 0 ? 0 : level === 1 && focusG ? focusG.id : -1;
  if (nebula && nebula.space !== space) { nebula.held = false; nebula = null; }
  if (sculpt && (level < 2 || !!sculpt.tide !== (level === 3))) sculpt = null;
  if (both) {
    const a = L.tips[1], b = R.tips[1], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const W = space === 0 ? 1 : gK; // world units per unit of this space
    const local = () => (space === 0 ? _w.set(mx, my, 0) : unplace(mx, my, _w));
    if (level === 3) planetTide(d, performance.now() / 1000);
    else if (level === 2) sculptPlanet(mx, my, d);
    else if (!nebula && space >= 0 && d < T.nebulaTouch && !zoomLock) {
      local();
      nebula = addNebula(space, _w.x, _w.y, Math.atan2(b.y - a.y, b.x - a.x), T.nebulaMin / W, paletteIndex, (Math.random() * 3) | 0, Math.random() * 100);
      nebula.held = true;
    }
    if (nebula) {
      const k = Math.min(1, dt * 10);
      local();
      nebula.size += (THREE.MathUtils.clamp(d, T.nebulaMin, T.nebulaMax) / W - nebula.size) * k;
      nebula.x += (_w.x - nebula.x) * k; nebula.y += (_w.y - nebula.y) * k;
      // lies along the line between the fingertips; a half-turn either way is the same line, so take the nearer one
      let ang = Math.atan2(b.y - a.y, b.x - a.x);
      ang += Math.PI * Math.round((nebula.rot - ang) / Math.PI);
      nebula.rot += (ang - nebula.rot) * k;
    }
    if (nebula || sculpt) {
      nebulaLost = 0;
      for (const t of [a, b]) { // a spark at each fingertip
        pickColor(0.5);
        spawn(t.x + rnd(0.05), t.y + rnd(0.05), t.z, rnd(0.5), rnd(0.5), rnd(0.3), cr, cg, cb, 0.3 + Math.random() * 0.5, 0.04 + Math.random() * 0.04);
      }
    }
  } else if ((nebula || sculpt) && (nebulaLost += dt) > 0.3) {
    if (nebula) nebula.held = false;
    nebula = null; sculpt = null; markDirty();
  }

  for (const n of nebulae) {
    n.born += dt;
    const out = n.space === 0, seen = out ? 1 - E1 : focusG && n.space === focusG.id ? E1 * (1 - E2) : 0;
    n.mesh.visible = seen > 0.003;
    if (!n.mesh.visible) continue;
    let W = 1, f = 1;
    if (out) n.mesh.position.set(n.x, n.y, -0.5);
    else { place(n.x, n.y, _w); n.mesh.position.set(_w.x, _w.y, -0.5); W = gK * zM; f = W / galS; }
    const sw = n.size * W;
    n.mesh.scale.set(sw * 1.5 + 0.4 * f, sw * 1.05 + 0.4 * f, 1);
    n.mesh.rotation.z = n.rot;
    n.mesh.material.uniforms.uTime.value += dt * (n.held ? 2.5 : 1);
    n.mesh.material.uniforms.uAlpha.value = Math.min(1, n.born * 2.5) * seen;
  }
}

// ---------------------------------------------------------------- hands
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const TIP_IDS = [4, 8, 12, 16, 20];

class Hand {
  constructor() {
    this.active = false; this.lastSeen = -1; this.hasJoints = false;
    this.joints = Array.from({ length: 21 }, () => new THREE.Vector3());
    this.pos = new THREE.Vector3(); this.prevPos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.tips = Array.from({ length: 5 }, () => new THREE.Vector3());
    this.pinchPt = new THREE.Vector3(); this.prevTip = new THREE.Vector3();
    this.quat = new THREE.Quaternion(); this.hasQuat = false; this.grabInv = null; this.grabQ = new THREE.Quaternion();
    this.gesture = 'none'; this.cand = 'none'; this.candN = 0; this.lastSolid = 'none';
    this.charge = 0; this.lastBurst = -10; this.lastPeace = -10; this.lastOpen = -10; this.pinchAt = null; this.spot = null;
    this.grab = null;   // the galaxy, star or planet this hand is pinching
    this.assist = null; // ...or one the other hand is pinching that this hand has joined in on

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CONNECTIONS.length * 6), 3));
    this.lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
      transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthTest: false }));
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(21 * 3), 3));
    this.dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({
      size: 0.13, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthTest: false }));
    this.lines.frustumCulled = this.dots.frustumCulled = false;
    this.lines.renderOrder = 5; this.dots.renderOrder = 5.1; // over everything, planets included, so you can see what you are touching
    this.lines.visible = this.dots.visible = false;
    scene.add(this.lines, this.dots);
  }

  // Feed a new pose (position, tips and joints are already set by the tracker).
  setPose(now, dt, rawGesture, fresh) {
    if (fresh) {
      this.prevPos.copy(this.pos); this.vel.set(0, 0, 0); this.prevTip.copy(this.tips[1]);
      this.gesture = this.cand = this.lastSolid = 'none'; this.candN = 0; this.charge = 0; this.lastOther = -10;
    }
    const since = fresh ? 0 : now - this.lastSeen;
    this.active = true; this.lastSeen = now;
    if (since > 0) {
      _v.subVectors(this.pos, this.prevPos).divideScalar(since);
      this.vel.lerp(_v, 0.35);
    }
    // Pointing, pinching and the peace sign all outrank a fist, and keep outranking it for a moment after
    // they are lost, so a finger slipping out of view never turns into accidental gathering.
    if (rawGesture === 'point' || rawGesture === 'pinch' || rawGesture === 'peace') this.lastOther = now;
    else if (rawGesture === 'fist' && now - this.lastOther < T.fistDelay) rawGesture = 'none';
    if (rawGesture === this.cand) this.candN++; else { this.cand = rawGesture; this.candN = 1; }
    this.prevGesture = this.gesture;
    if (this.candN >= (this.cand === 'fist' ? T.fistHoldFrames : T.holdFrames)) this.gesture = this.cand;
    if (this.gesture === 'open') this.lastOpen = now;
  }

  drawSkeleton() {
    const show = this.active && this.hasJoints;
    this.lines.visible = this.dots.visible = show;
    if (!show) return;
    const lp = this.lines.geometry.attributes.position, dp = this.dots.geometry.attributes.position;
    CONNECTIONS.forEach(([a, b], i) => {
      lp.setXYZ(i * 2, this.joints[a].x, this.joints[a].y, this.joints[a].z);
      lp.setXYZ(i * 2 + 1, this.joints[b].x, this.joints[b].y, this.joints[b].z);
    });
    this.joints.forEach((j, i) => dp.setXYZ(i, j.x, j.y, j.z));
    lp.needsUpdate = dp.needsUpdate = true;
    this.lines.material.color.copy(palette[0]); this.dots.material.color.copy(palette[1]);
    // Glowing light vanishes against a bright planet, so down on one the hand is drawn as a solid, see-through overlay instead.
    const solid = E3 > 0.5;
    this.lines.material.blending = this.dots.material.blending = solid ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.lines.material.opacity = solid ? 0.6 : 0.55; this.dots.material.opacity = solid ? 0.75 : 0.9;
  }

  release() {
    const o = this.grab;
    if (o) {
      o.held = false; o.growing = false; o.isNew = false; o.holder = null;
      if (o.kind === 'galaxy') { // it stays where you put it unless you actually throw it
        if (this.vel.length() > T.grabFling) o.vel.copy(this.vel).multiplyScalar(0.25).clampLength(0, 3);
        else o.vel.set(0, 0, 0);
      }
      this.grab = null;
      markDirty();
    }
    this.assist = null;
  }

  deactivate() { this.release(); this.pinchAt = null; this.active = false; this.gesture = 'none'; this.charge = 0; this.hasQuat = false; }

  // Orientation of the palm, from the knuckle line (index to pinky) and the wrist-to-middle-knuckle line.
  updateOrientation(fresh) {
    const j = this.joints;
    _ax.subVectors(j[5], j[17]); _ay.subVectors(j[9], j[0]);
    _ax.z *= T.tiltDepth; _ay.z *= T.tiltDepth;
    if (_ax.lengthSq() < 1e-6 || _ay.lengthSq() < 1e-6) return;
    _ax.normalize(); _az.crossVectors(_ax, _ay);
    if (_az.lengthSq() < 1e-6) return;
    _az.normalize(); _ay.crossVectors(_az, _ax);
    _q.setFromRotationMatrix(_m.makeBasis(_ax, _ay, _az));
    if (fresh || !this.hasQuat) this.quat.copy(_q); else this.quat.slerp(_q, 0.3);
    this.hasQuat = true;
  }

  act(now, dt, sculpting) {
    const g = this.gesture, p = this.pos;
    if (g !== 'pinch') { this.release(); this.pinchAt = null; this.spot = null; } else if (this.pinchAt == null) this.pinchAt = now;
    // the gathered charge survives the split second it takes a fist to become an open hand, then drains
    if (g !== 'fist' && now - (this.fistAt ?? -10) > T.openWindow) this.charge = Math.max(0, this.charge - dt * 3);

    if (g === 'open') {
      // An open hand on its own never explodes. The supernova only fires when a fist that has
      // actually been gathering is opened.
      if (this.charge >= T.minCharge) { burst(p, this.charge, this.vel); shatter(p, this.charge); this.lastBurst = now; }
      this.charge = 0;
      wells.push({ x: p.x, y: p.y, z: p.z, g: -7 });
      planetSpin(this, now); // down on a planet, an open hand turns the globe
      { // streamers off every fingertip
        for (const t of this.tips) for (let k = 0; k < 5; k++) {
          _v.subVectors(t, p).normalize().multiplyScalar(1.5 + Math.random() * 2.5);
          pickColor(0.2);
          spawn(t.x, t.y, t.z, _v.x + this.vel.x * 0.4 + rnd(0.6), _v.y + this.vel.y * 0.4 + rnd(0.6), rnd(0.6),
            cr, cg, cb, 0.6 + Math.random() * 1.2, 0.04 + Math.random() * 0.05);
        }
      }
    } else if (g === 'fist') {
      this.charge = Math.min(1, this.charge + dt / 2.2); this.fistAt = now;
      // pulls the background stars (and any loose sparks) into a spinning disc around the fist
      wells.push({ x: p.x, y: p.y, z: p.z, g: 30 + 40 * this.charge, r0: 0.45 + 0.5 * this.charge, swirl: 12, strong: true, fist: true });
      pickColor(0.8); // hot core
      spawn(p.x + rnd(0.05), p.y + rnd(0.05), p.z, 0, 0, 0, cr * 0.4, cg * 0.4, cb * 0.4, 0.2, 0.3 + 0.6 * this.charge);
    } else if (g === 'pinch' && level === 3) {
      planetPinch(this, now, dt);
    } else if (g === 'pinch') {
      if (this.assist && !this.assist.held) this.assist = null; // the other hand let go: this one takes it over
      if (!this.grab && !this.assist && !zoomLock) {
        const q = this.pinchPt; // what a pinch makes or picks up depends on how far in we are
        // Picking something up is instant, but making something new waits for the pinch to be held a moment:
        // a hand closing into a fist passes through a pinch on the way, and that must not leave a stray behind.
        const ready = now - this.pinchAt >= T.pinchHold, make = fn => () => (ready ? fn(q) : null);
        this.grab = level === 0 ? pinchPick(galaxies.filter(x => x.alive), q, this, now, make(acquireGalaxy))
          : level === 1 ? pinchPick(focusG.stars, q, this, now, make(newStar))
          : pinchPick(focusS.planets, q, this, now, make(newPlanet));
        if (!this.grab && !this.assist && !ready) { // a glint at the fingertips while it waits
          pickColor(0.6);
          spawn(q.x + rnd(0.06), q.y + rnd(0.06), q.z, rnd(0.3), rnd(0.3), 0, cr, cg, cb, 0.25 + Math.random() * 0.25, 0.04);
        }
        this.grabInv = null; // remember how the hand and the galaxy were angled when the pinch began
        if (this.grab?.kind === 'galaxy' && this.hasQuat) { this.grabInv = this.quat.clone().invert(); this.grabQ.copy(this.grab.quat); }
      }
      if (this.grab) holdBody(this, this.grab, dt);
    } else if (g === 'point' && !sculpting) {
      if (level === 3) planetDraw(this, now);
      const tip = this.tips[1], n = 14;
      for (let k = 0; k < n; k++) { // interpolate so fast strokes stay continuous
        _v.lerpVectors(this.prevTip, tip, k / n);
        pickColor(0.25);
        spawn(_v.x + rnd(0.04), _v.y + rnd(0.04), _v.z, rnd(0.25), rnd(0.25), rnd(0.25), cr, cg, cb,
          1.6 + Math.random() * 1.6, 0.05 + Math.random() * 0.05);
      }
    } else if (g === 'peace') {
      if (this.lastSolid !== 'peace' && now - this.lastPeace > 1) {
        this.lastPeace = now;
        setPalette(paletteIndex + 1);
        ring(p, 1200, 7, 0.1);
      }
    }
    if (g !== 'none') this.lastSolid = g;
    this.prevTip.copy(this.tips[1]);
  }
}
const _v = new THREE.Vector3(), _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const rnd = s => (Math.random() - 0.5) * 2 * s;
const hands = { Left: new Hand(), Right: new Hand() };

function setPalette(i) {
  paletteIndex = ((i % PALETTES.length) + PALETTES.length) % PALETTES.length;
  palette = PALETTES[paletteIndex].colors;
  paletteEl.textContent = PALETTES[paletteIndex].name;
}

// ---------------------------------------------------------------- gesture recognition
function classify(lm, aspect, prev) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y, (lm[a].z - lm[b].z) * aspect);
  const flat = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  const size = d(0, 9) || 1e-6;
  const curl = [[8, 5], [12, 9], [16, 13], [20, 17]].map(([tip, mcp]) => d(tip, 0) / (d(mcp, 0) || 1e-6));
  const ext = curl.map(c => c > T.extended), bent = curl.map(c => c < T.curled);
  // How straight each finger is (1 = ruler-straight, ~0.5 = folded). Measured in the image plane, where a
  // straight finger stays straight even when it is aimed at the camera and looks short.
  const straight = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]
    .map(([a, b, c, e]) => flat(a, e) / ((flat(a, b) + flat(b, c) + flat(c, e)) || 1e-6));
  const loose = g => (prev === g ? 0.08 : 0), lead = g => (prev === g ? T.pointLead * 0.5 : T.pointLead);
  const pinching = d(4, 8) / size < (prev === 'pinch' ? T.pinchOff : T.pinchOn);
  // These three outrank a fist: if the hand is clearly making one of them it never gathers,
  // whatever the remaining fingers are doing.
  const indexOut = straight[0] > T.pointStraight - loose('point')
    && straight[0] - Math.max(straight[1], straight[2], straight[3]) > lead('point')
    && !ext[1] && !ext[2] && !ext[3];
  if (indexOut && !pinching) return 'point';
  const twoOut = Math.min(straight[0], straight[1]) > T.pointStraight - loose('peace')
    && Math.min(straight[0], straight[1]) - Math.max(straight[2], straight[3]) > lead('peace')
    && !ext[2] && !ext[3];
  if (twoOut && !pinching) return 'peace';
  // a pinch needs the index finger reaching out to the thumb, not folded into the palm as in a fist
  if (pinching && straight[0] > T.pinchIndexOpen) return 'pinch';
  if (bent.every(Boolean)) return 'fist';
  if (pinching) return 'pinch';
  if (ext.every(Boolean)) return 'open';
  if (ext[0] && ext[1] && !ext[2] && !ext[3]) return 'peace';
  if (ext[0] && !ext[1] && !ext[2] && !ext[3]) return 'point';
  return 'none';
}

// ---------------------------------------------------------------- camera tracking
const video = document.getElementById('cam');
let mode = 'idle', landmarker = null, lastVideoTime = -1;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera support (the page must be served from localhost or https).');
  setStatus('Waiting for camera permission…');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  await video.play();
  setStatus('Loading hand-tracking model…');
  const { FilesetResolver, HandLandmarker } = await import(MP_URL);
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const make = delegate => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
  try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }
  mode = 'camera';
  video.classList.add('on');
  camBtn.hidden = false;
  hintEl.textContent = matchMedia('(pointer: coarse)').matches
    ? 'Prop your device up and step back so the camera can see both hands · tap here to hide this guide'
    : 'Stand back so the camera sees your hands · V camera preview · F full screen · U universes · H hides this guide';
}

function trackCamera(now, dt) {
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, performance.now());
  const sides = res.handedness || res.handednesses || [];
  const aspect = video.videoWidth / video.videoHeight || 16 / 9;
  const dets = (res.landmarks || []).map((lm, i) => {
    let x = 0, y = 0;
    for (const k of [0, 5, 9, 13, 17]) { x += lm[k].x; y += lm[k].y; }
    return { lm, label: sides[i]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right',
      x: (0.5 - x / 5) * viewW * 1.1, y: (0.5 - y / 5) * viewH * 1.1, key: null };
  });
  const taken = {}, pairs = [];
  dets.forEach((d, i) => { for (const k of ['Left', 'Right']) if (hands[k].active) pairs.push({ i, k, dist: Math.hypot(hands[k].pos.x - d.x, hands[k].pos.y - d.y) }); });
  pairs.sort((a, b) => a.dist - b.dist);
  for (const p of pairs) if (p.dist < 4 && !dets[p.i].key && !taken[p.k]) { dets[p.i].key = p.k; taken[p.k] = true; }
  for (const d of dets) {
    if (d.key) continue;
    let k = d.label;
    if (taken[k]) k = k === 'Left' ? 'Right' : 'Left';
    if (!taken[k]) { d.key = k; taken[k] = true; }
  }
  dets.forEach(({ lm, key }) => {
    if (!key) return;
    const h = hands[key], fresh = !h.active;
    h.hasJoints = true;
    for (let k = 0; k < 21; k++) { // mirror x so it behaves like a mirror
      _v.set((0.5 - lm[k].x) * viewW * 1.1, (0.5 - lm[k].y) * viewH * 1.1, -lm[k].z * viewW * 0.4);
      if (fresh) h.joints[k].copy(_v); else h.joints[k].lerp(_v, 0.55);
    }
    h.prevPos.copy(h.pos);
    h.pos.set(0, 0, 0);
    for (const k of [0, 5, 9, 13, 17]) h.pos.add(h.joints[k]);
    h.pos.multiplyScalar(0.2);
    TIP_IDS.forEach((id, k) => h.tips[k].copy(h.joints[id]));
    h.updateOrientation(fresh);
    h.pinchPt.lerpVectors(h.joints[4], h.joints[8], 0.5);
    h.setPose(now, dt, classify(lm, aspect, h.gesture), fresh);
  });
}

// ---------------------------------------------------------------- UI
const introEl = document.getElementById('intro'), statusEl = document.getElementById('status');
const hudEl = document.getElementById('hud'), hintEl = document.getElementById('hint'), paletteEl = document.getElementById('palette');
const chips = Object.fromEntries([...document.querySelectorAll('.chip')].map(c => [c.dataset.g, c]));
function setStatus(msg, err = false) { statusEl.textContent = msg; statusEl.classList.toggle('err', err); }
const whereEl = document.getElementById('where'), noteEl = document.getElementById('note'), upBtn = document.getElementById('upBtn');
let entered = false, noteT = 0, saveT = 0;
function enter() {
  if (entered) return;
  keepAwake(); legendBtn.hidden = false; setPalette(0); introEl.classList.add('hidden'); hudEl.classList.add('on'); paletteEl.classList.add('on');
  loadUniverse(); entered = true; whereEl.classList.add('on'); refreshChrome();
}

// a short message in the middle of the screen: what you are growing, where you have arrived, why nothing happened
function note(msg, secs = 3.5) {
  if (noteEl.textContent !== msg) noteEl.textContent = msg;
  noteEl.classList.add('on'); noteT = secs;
}

// the gesture guide and the "where am I" line change with the level
const LEGEND = { // one line per level: universe, galaxy, solar system, a world with ground, a giant
  'fist open': ['<b>Fist</b>gather, then <b class="in">open</b> for a supernova; on a galaxy it destroys it',
    '<b>Fist</b>gather, then <b class="in">open</b> on a star to blow it up',
    '<b>Fist</b>gather, then <b class="in">open</b> on a planet to smash it',
    '<b>Fist</b>gather, then <b class="in">open</b> on the planet for a meteor strike',
    '<b>Fist</b>gather, then <b class="in">open</b> on the planet to scar its clouds'],
  pinch: ['<b>Pinch</b>hold to grow a galaxy, twist to tilt, or grab one',
    '<b>Pinch</b>hold to grow a star, or grab one',
    '<b>Pinch</b>hold to grow a planet, or grab one to move its orbit',
    '<b>Pinch</b>hold on the planet to raise mountains',
    '<b>Pinch</b>hold on the planet to brew a storm'],
  zoom: ['<b>Both hands open</b>together over a galaxy, then sweep apart to dive in',
    '<b>Both hands open</b>sweep apart over a star to visit, or together to leave',
    '<b>Both hands open</b>sweep apart over a planet to land, or together to leave',
    '<b>Open hand</b>spins the planet; sweep both hands together to leave',
    '<b>Open hand</b>spins the planet; sweep both hands together to leave'],
  point: ['<b>Point</b>draw with light', '<b>Point</b>draw with light', '<b>Point</b>draw with light',
    '<b>Point</b>draw rivers across the land', '<b>Point</b>draw with light'],
  nebula: ['<b>Two fingertips</b>touch, then pull apart for a nebula',
    '<b>Two fingertips</b>touch, then pull apart for a dust cloud',
    '<b>Two fingertips</b>touch on a planet, pull apart for rings, then moons',
    '<b>Two fingertips</b>spread to raise the sea, close to drain it',
    '<b>Two fingertips</b>spread for faster winds, close to calm them'],
};
const ARRIVE = ['Back in the universe', 'Inside the galaxy. Pinch and hold to light a star.', 'A solar system. Pinch and hold to grow a planet.',
  'Pinch the land to raise mountains'];
function refreshChrome() {
  const row = level < 3 ? level : focusP && !isSolid(focusP) ? 4 : 3;
  for (const k in LEGEND) if (chips[k]) chips[k].innerHTML = LEGEND[k][row];
  whereEl.textContent = level === 0 ? 'Universe' : level === 1 ? 'Universe › Galaxy' : `Universe › Galaxy › ${focusS ? starName(focusS) : 'Star'}${level === 3 && focusP ? ' › ' + planetName(focusP) : ''}`;
  upBtn.hidden = !entered || level === 0;
  savesBtn.hidden = !entered;
}
upBtn.addEventListener('click', e => { surface(); e.currentTarget.blur(); });
window.addEventListener('keydown', e => { if ((e.key === 'b' || e.key === 'B' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey && entered) surface(); });

// Everything you make is kept in this browser, so the universe is still there next time.
const SAVE_KEY = 'handiverse.universe.v1';
function markDirty() { if (saveT <= 0) saveT = 1.5; }
function snapshot() {
  storeTerrain(); // fold the planet being worked on back into its record first
  const r = x => Math.round(x * 1e4) / 1e4;
  return { v: 1, nextId,
    galaxies: galaxies.filter(g => g.alive).map(g => ({ id: g.id, seed: g.seed, pal: g.pal, grow: r(g.grow),
      p: g.pos.toArray().map(r), q: g.quat.toArray().map(r),
      stars: g.stars.map(s => ({ u: r(s.u), v: r(s.v), grow: r(s.grow), seed: s.seed,
        planets: s.planets.map(p => ({ r: r(p.r), a: r(p.a), grow: r(p.grow), seed: p.seed, rings: r(p.rings),
          map: p.map || undefined, sea: p.sea == null ? undefined : r(p.sea), wind: p.wind === 1 ? undefined : r(p.wind), spots: p.spots.length ? p.spots.map(q => q.map(r)) : undefined,
          moons: p.moons.map(m => ({ d: r(m.d), a: r(m.a), seed: m.seed })) })) })) })),
    nebulae: nebulae.map(n => ({ space: n.space, x: r(n.x), y: r(n.y), rot: r(n.rot), size: r(n.size), pal: n.pal, ci: n.ci, seed: r(n.seed) })) };
}
function saveUniverse() {
  saveT = 0;
  if (!entered) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot())); } catch {}
}
// back to an empty universe, seen from the outside
function clearUniverse() {
  for (const h of [hands.Left, hands.Right]) h.release();
  for (const g of galaxies) if (g.alive) killGalaxy(g);
  while (nebulae.length) dropNebula(nebulae[0]);
  nebula = null; sculpt = null; nextId = 1;
  level = 0; depth = 0; zoomNudge = 0; zoomHeld = 0; zoomOn = false; zoomKey = null; zoomLock = false; focusG = focusS = focusP = null; terrainOf = null; terrainDirty = false;
}
function applySnapshot(d) {
  clearUniverse();
  if (!d || d.v !== 1) return;
  nextId = d.nextId || 1;
  (d.galaxies || []).slice(0, GALAXY_MAX).forEach((s, i) => {
    const g = galaxies[i];
    g.id = s.id; g.seed = s.seed; g.pal = s.pal; g.grow = s.grow; g.pos.fromArray(s.p); g.quat.fromArray(s.q); g.vel.set(0, 0, 0);
    g.stars = (s.stars || []).map(a => {
      const st = mkStar(a.u, a.v, a.grow, a.seed);
      st.planets = (a.planets || []).map(b => { const p = mkPlanet(b.r, b.a, b.grow, b.seed); p.rings = b.rings || 0; p.moons = (b.moons || []).map(m => ({ ...m }));
        p.map = b.map || null; p.sea = b.sea ?? null; p.wind = b.wind ?? 1; p.spots = (b.spots || []).map(q => [...q]); return p; });
      return st;
    });
    shapeGalaxy(g);
    g.alive = true; g.held = g.growing = g.isNew = false; g.holder = null; g.swallow = 0;
  });
  for (const n of d.nebulae || []) addNebula(n.space, n.x, n.y, n.rot, n.size, n.pal, n.ci, n.seed).born = 1;
}
function loadUniverse() {
  try { applySnapshot(JSON.parse(localStorage.getItem(SAVE_KEY) || 'null')); }
  catch (err) { console.warn('Could not restore the saved universe:', err); }
  saveT = 0;
}
window.addEventListener('pagehide', saveUniverse);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveUniverse(); });

// --- named saves: any number of universes kept side by side, plus a way to start a fresh one
const SLOTS_KEY = 'handiverse.saves.v1';
const savesEl = document.getElementById('saves'), savesBtn = document.getElementById('savesBtn'), saveList = document.getElementById('saveList');
const saveName = document.getElementById('saveName'), newUniBtn = document.getElementById('newUni');
const readSlots = () => { try { const a = JSON.parse(localStorage.getItem(SLOTS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const writeSlots = a => { try { localStorage.setItem(SLOTS_KEY, JSON.stringify(a)); return true; } catch { return false; } };
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function describe(d) {
  const gs = d.galaxies || [], stars = gs.reduce((n, g) => n + (g.stars || []).length, 0);
  const planets = gs.reduce((n, g) => n + (g.stars || []).reduce((m, s) => m + (s.planets || []).length, 0), 0);
  return `${count(gs.length, 'galaxy', 'galaxies')} · ${count(stars, 'star', 'stars')} · ${count(planets, 'planet', 'planets')}`;
}
// a button that asks once more before doing something that cannot be undone
function twice(btn, ask, fn) {
  const label = btn.textContent;
  btn.addEventListener('click', () => {
    if (btn.classList.contains('armed')) return fn();
    btn.classList.add('armed'); btn.textContent = ask;
    setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 2500);
  });
}
function renderSaves() {
  const slots = readSlots();
  saveList.replaceChildren(...slots.map(s => {
    const li = document.createElement('li'), info = document.createElement('div'), name = document.createElement('b'), sub = document.createElement('span');
    const load = document.createElement('button'), del = document.createElement('button');
    name.textContent = s.name;
    sub.textContent = `${describe(s.data)} · ${new Date(s.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    info.append(name, sub);
    load.type = del.type = 'button'; load.textContent = 'Load'; del.textContent = 'Delete'; del.className = 'quiet';
    twice(load, 'Replace current?', () => {
      applySnapshot(s.data); saveUniverse(); refreshChrome(); showSaves(false); note(`Loaded ${s.name}`);
    });
    twice(del, 'Sure?', () => { writeSlots(readSlots().filter(x => x.id !== s.id)); renderSaves(); });
    li.append(info, load, del);
    return li;
  }));
  document.getElementById('saveEmpty').hidden = slots.length > 0;
  saveName.placeholder = `Universe ${slots.length + 1}`;
}
function showSaves(on) {
  if (!entered) return;
  savesEl.hidden = !on; savesBtn.classList.toggle('lit', on);
  if (on) { saveName.value = ''; renderSaves(); } else saveName.blur();
}
document.getElementById('saveForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = saveName.value.trim() || saveName.placeholder, slots = readSlots().filter(s => s.name !== name); // same name: overwrite
  slots.unshift({ id: Date.now(), name, at: Date.now(), data: snapshot() });
  if (writeSlots(slots)) note(`Saved ${name}`); else note('Could not save: this browser\'s storage is full or blocked.');
  saveName.value = ''; renderSaves();
});
savesBtn.addEventListener('click', e => { showSaves(savesEl.hidden); e.currentTarget.blur(); });
document.getElementById('savesClose').addEventListener('click', () => showSaves(false));
savesEl.addEventListener('click', e => { if (e.target === savesEl) showSaves(false); });

// A new universe wipes the one you are in, so it has to be held for, not just tapped: the button in the
// panel, or the N key.
const HOLD = 1.2;
let holdTimer = 0;
function newUniverse() {
  clearUniverse(); saveUniverse(); refreshChrome(); showSaves(false); note('A new universe');
}
function holdStart() {
  if (holdTimer || !entered) return;
  newUniBtn.classList.add('holding');
  holdTimer = setTimeout(() => { holdEnd(); newUniverse(); }, HOLD * 1000);
}
function holdEnd() { clearTimeout(holdTimer); holdTimer = 0; newUniBtn.classList.remove('holding'); }
newUniBtn.addEventListener('pointerdown', holdStart);
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) newUniBtn.addEventListener(ev, holdEnd);
newUniBtn.addEventListener('contextmenu', e => e.preventDefault()); // a long press on a touch screen
// typing a name must not set off the single-key shortcuts
window.addEventListener('keydown', e => { if (e.target instanceof HTMLInputElement) { if (e.key === 'Escape') showSaves(false); e.stopImmediatePropagation(); } }, true);
window.addEventListener('keydown', e => {
  if (!entered || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'u' || e.key === 'U') showSaves(savesEl.hidden);
  else if (e.key === 'Escape') showSaves(false);
  else if ((e.key === 'n' || e.key === 'N') && !e.repeat) { holdStart(); if (holdTimer) note('Keep holding N for a new universe…', HOLD); }
});
window.addEventListener('keyup', e => { if (e.key === 'n' || e.key === 'N') holdEnd(); });
window.addEventListener('blur', holdEnd);

document.getElementById('startCam').addEventListener('click', async e => {
  e.currentTarget.disabled = true;
  try { await startCamera(); enter(); }
  catch (err) {
    console.error(err);
    const denied = err?.name === 'NotAllowedError', none = err?.name === 'NotFoundError';
    setStatus(denied ? 'Camera permission was denied. Allow it from the icon in the address bar, then try again.'
      : none ? 'No camera found. Handiverse needs a webcam to see your hands.'
      : `Could not start hand tracking: ${err?.message || err}`, true);
    e.currentTarget.disabled = false;
  }
});
// gesture guide: tap it (or the ? button, or H) to hide it, and the ? button or H to bring it back
const legendBtn = document.getElementById('legendBtn');
function setLegend(show) {
  hudEl.classList.toggle('min', !show);
  legendBtn.classList.toggle('off', !show);
  legendBtn.title = show ? 'Hide gesture guide (H)' : 'Show gesture guide (H)';
  try { localStorage.setItem('handiverse.legend', show ? '1' : '0'); } catch {}
}
const toggleLegend = () => setLegend(hudEl.classList.contains('min'));
legendBtn.addEventListener('click', e => { toggleLegend(); e.currentTarget.blur(); });
document.getElementById('legend').addEventListener('click', toggleLegend);
hintEl.addEventListener('click', toggleLegend);
window.addEventListener('keydown', e => { if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey && hudEl.classList.contains('on')) toggleLegend(); });
try { if (localStorage.getItem('handiverse.legend') === '0') setLegend(false); } catch {}

// camera preview: button in the corner, or the V key
const camBtn = document.getElementById('camBtn');
function toggleCam() {
  if (mode !== 'camera') return;
  const on = video.classList.toggle('on');
  camBtn.classList.toggle('off', !on);
  camBtn.title = on ? 'Hide camera preview (V)' : 'Show camera preview (V)';
}
camBtn.addEventListener('click', e => { toggleCam(); e.currentTarget.blur(); });
window.addEventListener('keydown', e => { if (e.key === 'v' || e.key === 'V') toggleCam(); });

// full screen: button in the corner, or the F key (older iPads only have the webkit-prefixed API; iPhones have none)
const fsBtn = document.getElementById('fs'), rootEl = document.documentElement;
const requestFs = rootEl.requestFullscreen || rootEl.webkitRequestFullscreen;
const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFullscreen() {
  try {
    const p = fsElement() ? exitFs.call(document) : requestFs.call(rootEl);
    p?.catch?.(err => console.warn('Full screen was refused:', err));
  } catch (err) { console.warn('Full screen was refused:', err); }
}
if (requestFs && exitFs && (document.fullscreenEnabled ?? document.webkitFullscreenEnabled) !== false) {
  fsBtn.addEventListener('click', e => { toggleFullscreen(); e.currentTarget.blur(); });
  window.addEventListener('keydown', e => { if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFullscreen(); });
  const onFsChange = () => {
    const on = !!fsElement();
    fsBtn.classList.toggle('on', on);
    fsBtn.title = on ? 'Exit full screen (F or Esc)' : 'Full screen (F)';
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
} else fsBtn.hidden = true;

// Nobody touches the screen while playing, so stop the device dimming or locking, and pick the
// camera back up when the tab or app comes back to the front.
let wakeLock = null;
async function keepAwake() {
  try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
  catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || mode !== 'camera') return;
  keepAwake();
  video.play().catch(() => {});
});
setPalette(0);

// ---------------------------------------------------------------- main loop
let last = performance.now() / 1000, idleT = 0, nextMeteor = 4, meteor = null, perfT = 0, perfN = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, rawDt = now - last, dt = Math.min(0.05, rawDt);
  last = now;
  // on a device that cannot keep up, trade resolution for smoothness
  if (mode === 'camera' && rawDt < 0.25) {
    perfT += rawDt; perfN++;
    if (perfT >= 2) {
      if (perfN / perfT < 38 && pixelRatio > 0.75) {
        pixelRatio = Math.max(0.75, pixelRatio - 0.25);
        renderer.setPixelRatio(pixelRatio); composer.setPixelRatio(pixelRatio); resize();
      }
      perfT = perfN = 0;
    }
  }
  wells.length = 0;

  if (mode === 'camera') trackCamera(now, dt);
  else { // behind the intro: two slow eddies drifting through the stars, and now and then a shooting star
    wells.push({ x: Math.sin(now * 0.11) * viewW * 0.3, y: Math.cos(now * 0.15) * viewH * 0.25, z: 0, g: 0.5, r0: 3, swirl: 2.2, range: 7, flat: 0 });
    wells.push({ x: Math.cos(now * 0.09) * viewW * 0.32, y: Math.sin(now * 0.13) * viewH * 0.28, z: 0, g: 0.5, r0: 3, swirl: -1.8, range: 6, flat: 0 });
    idleT += dt;
    if (!meteor && idleT > nextMeteor) {
      idleT = 0; nextMeteor = rand(5, 11);
      const dir = Math.random() < 0.5 ? -1 : 1;
      meteor = { x: -dir * rand(0.1, 0.45) * viewW, y: rand(0.1, 0.45) * viewH, z: rand(-4, -1), vx: dir * rand(7, 11), vy: -rand(2, 4), life: rand(0.7, 1.1) };
    }
    if (meteor) {
      for (let k = 0; k < 6; k++) {
        const f = k / 6 * dt;
        spawn(meteor.x - meteor.vx * f, meteor.y - meteor.vy * f, meteor.z, rnd(0.08), rnd(0.08), 0,
          0.4, 0.48, 0.62, 0.35 + Math.random() * 0.5, 0.03 + Math.random() * 0.04);
      }
      meteor.x += meteor.vx * dt; meteor.y += meteor.vy * dt;
      if ((meteor.life -= dt) <= 0) meteor = null;
    }
  }

  const L = hands.Left, R = hands.Right;
  for (const h of [L, R]) {
    if (h.active && now - h.lastSeen > 0.35) h.deactivate();
  }
  updateView(dt);
  updateNebulae(dt, L, R);
  const drawing = !!(nebula || sculpt);
  for (const h of [L, R]) { if (h.active) h.act(now, dt, drawing); h.drawSkeleton(); }
  updateZoom(L, R, now, dt);

  updateGalaxies(dt);
  updateBodies(dt, now);
  bloom.strength = 0.85 - 0.6 * E3; // close to a planet the glow would wash its surface out
  updateParticles(dt);
  updateAmbient(dt);

  for (const g in chips) {
    const names = g.split(' ');
    chips[g].classList.toggle('active', g === 'nebula' ? drawing : g === 'zoom' ? zoomShow
      : !(drawing && g === 'point') && ((L.active && names.includes(L.gesture)) || (R.active && names.includes(R.gesture))));
  }

  // name the star or planet being grown, as it passes from one kind to the next
  const maker = [L, R].find(h => h.active && h.grab && h.grab.growing && h.grab.kind !== 'galaxy');
  if (maker) note(maker.grab.kind === 'star' ? starName(maker.grab) : planetName(maker.grab), 0.5);
  else if (noteT > 0 && (noteT -= dt) <= 0) noteEl.classList.remove('on');
  if (saveT > 0 && (saveT -= dt) <= 0) saveUniverse();

  // gentle parallax toward the hands
  let tx = 0, ty = 0, n = 0;
  for (const h of [L, R]) if (h.active) { tx += h.pos.x; ty += h.pos.y; n++; }
  if (n) { tx = tx / n * 0.06; ty = ty / n * 0.06; }
  camera.position.x += (tx - camera.position.x) * 0.04;
  camera.position.y += (ty - camera.position.y) * 0.04;
  camera.lookAt(0, 0, 0);

  composer.render();
}
frame();

// A handle for poking at things from the console. pose() stands in for the camera: call it every frame
// with a hand's position and gesture and the rest of the game cannot tell the difference.
window.__universe = { get pixelRatio() { return pixelRatio; }, hands, galaxies, nebulae, burst, setPalette, enter, surface, saveUniverse,
  get mode() { return mode; }, get level() { return level; }, get depth() { return depth; }, get focusG() { return focusG; }, get focusS() { return focusS; }, get focusP() { return focusP; }, get globeR() { return globeR; }, globePoint, mapH,
  get at() { return at; },
  pose(key, x, y, gesture, tipX = x, tipY = y) {
    const h = hands[key], fresh = !h.active;
    h.prevPos.copy(h.pos); h.pos.set(x, y, 0); h.hasJoints = false; h.pinchPt.set(x, y, 0);
    for (const t of h.tips) t.set(tipX, tipY, 0);
    h.setPose(performance.now() / 1000, 1 / 60, gesture, fresh);
  } };
