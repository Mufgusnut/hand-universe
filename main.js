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
  portalDelay: 2.2,    // seconds after a supernova before two open hands may open a portal
  nebulaTouch: 1.3,    // how close (world units) two pointing fingertips must come to spark a nebula
  nebulaMin: 0.5,      // its width at that moment
  nebulaMax: 10,       // ...and the widest it can be pulled
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
let ambientPlaced = false;
function layoutAmbient() {
  for (let i = 0; i < AMB; i++) {
    const j = i * 3, z = aSeed[j + 2], s = (camera.position.z - z) / camera.position.z; // fill the view frustum
    aHome[j] = aSeed[j] * viewW * 0.62 * s; aHome[j + 1] = aSeed[j + 1] * viewH * 0.62 * s; aHome[j + 2] = z;
  }
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
  for (let i = 0; i < AMB; i++) {
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

// ---------------------------------------------------------------- effects
function burst(p, power, vel) {
  const sp = 6 + 15 * power, gathered = 1.6 + 1.6 * power;
  blasts.push({ x: p.x, y: p.y, z: p.z, sp, t: 0 });
  for (let i = 0; i < AMB; i++) {
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
const GALAXY_N = 10000, GALAXY_LIFE = 45;
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

function shapeGalaxy(g) {
  const data = g.data, u = g.mat.uniforms;
  const kind = ['spiral', 'spiral', 'spiral', 'barred', 'barred', 'ring', 'elliptical', 'irregular'][(Math.random() * 8) | 0];
  const put = (i, r, ang, h, w = Math.random() * 0.96) => { const j = i * 4; data[j] = r; data[j + 1] = ang; data[j + 2] = h; data[j + 3] = w; };
  // most arm stars sit in a tight lane, the rest form a soft haze around it
  const lane = () => gauss() * (Math.random() < 0.65 ? 0.35 : 1.25);
  // star-forming knots: small bright clumps strung along the arms
  const knots = (armAngle, rMin) => {
    const list = Array.from({ length: 10 + ((Math.random() * 10) | 0) }, () => { const r = rand(rMin, 0.95); return { r, a: armAngle(r, (Math.random() * 8) | 0) }; });
    return i => { const k = list[(Math.random() * list.length) | 0], x = k.r * Math.cos(k.a) + gauss() * 0.022, z = k.r * Math.sin(k.a) + gauss() * 0.022;
      put(i, Math.hypot(x, z), Math.atan2(z, x), gauss() * 0.015, rand(0.9, 1)); };
  };
  let rigid = 0.35, diff = 0.25, squash = 1, maxScale = rand(0.9, 3.2);

  if (kind === 'spiral') {
    const arms = 2 + ((Math.random() * 4) | 0), twist = rand(2.5, 7), spread = rand(0.2, 0.55);
    const bulge = rand(0.08, 0.22), bulgeR = rand(0.1, 0.22);
    const knot = knots((r, n) => ((n % arms) / arms) * TAU + r * twist, 0.2);
    for (let i = 0; i < GALAXY_N; i++) {
      const v = Math.random();
      if (v < bulge) { put(i, Math.pow(Math.random(), 1.6) * bulgeR, rand(0, TAU), gauss() * 0.06); continue; }
      if (v > 0.93) { knot(i); continue; }
      const r = 0.05 + Math.pow(Math.random(), 1.4) * 0.95;
      put(i, r, ((i % arms) / arms) * TAU + r * twist + lane() * spread * (1 - r * 0.5), gauss() * 0.03);
    }
  } else if (kind === 'barred') {
    const bar = rand(0.25, 0.45), twist = rand(3, 6);
    rigid = 0.5; diff = 0.04; // turns almost rigidly so the bar holds together
    const knot = knots((r, n) => (n % 2) * Math.PI + (r - bar) * twist, bar);
    for (let i = 0; i < GALAXY_N; i++) {
      const v = Math.random(), side = (i % 2) * Math.PI;
      if (v > 0.94) { knot(i); continue; }
      if (v < 0.12) put(i, Math.random() * 0.12, rand(0, TAU), gauss() * 0.06);
      else if (v < 0.42) { const r = Math.random() * bar, w = gauss() * 0.05; put(i, Math.hypot(r, w), side + Math.atan2(w, r), gauss() * 0.03); }
      else { const r = bar + Math.pow(Math.random(), 1.3) * (1 - bar); put(i, r, side + (r - bar) * twist + lane() * 0.3, gauss() * 0.03); }
    }
  } else if (kind === 'ring') {
    const ringR = rand(0.6, 0.85), width = rand(0.04, 0.09);
    for (let i = 0; i < GALAXY_N; i++) {
      const v = Math.random();
      if (v < 0.2) put(i, Math.random() * 0.15, rand(0, TAU), gauss() * 0.06);
      else if (v < 0.82) put(i, ringR + gauss() * width, rand(0, TAU), gauss() * 0.03);
      else put(i, Math.random() * ringR, rand(0, TAU), gauss() * 0.03);
    }
  } else if (kind === 'elliptical') {
    rigid = 0.18; diff = 0.1; squash = rand(0.5, 0.9); maxScale = rand(0.8, 2.3);
    for (let i = 0; i < GALAXY_N; i++) { const r = Math.pow(Math.random(), 2.2); put(i, r, rand(0, TAU), gauss() * 0.3 * (1 - r * 0.7)); }
  } else { // irregular: a handful of ragged clumps
    rigid = 0.28; diff = 0.05; squash = rand(0.7, 1); maxScale = rand(0.8, 2.3);
    const clumps = Array.from({ length: 3 + ((Math.random() * 4) | 0) }, () => ({ r: rand(0.1, 0.7), a: rand(0, TAU), s: rand(0.08, 0.25) }));
    for (let i = 0; i < GALAXY_N; i++) {
      if (Math.random() < 0.3) { put(i, Math.pow(Math.random(), 1.5) * 0.9, rand(0, TAU), gauss() * 0.08); continue; }
      const c = clumps[(Math.random() * clumps.length) | 0];
      const x = c.r * Math.cos(c.a) + gauss() * c.s, z = c.r * Math.sin(c.a) + gauss() * c.s;
      put(i, Math.hypot(x, z), Math.atan2(z, x), gauss() * 0.08);
    }
  }
  g.geo.attributes.aData.needsUpdate = true;

  const spin = (Math.random() < 0.5 ? -1 : 1) * rand(0.7, 1.5);
  u.uRigid.value = rigid * spin; u.uDiff.value = diff * spin; u.uSquash.value = squash;
  g.maxScale = maxScale; g.growTime = rand(1.0, 2.4);
  g.points.rotation.set(rand(0.35, 1.35), 0, rand(-0.9, 0.9)); // from nearly edge-on to nearly face-on
  if (kind === 'elliptical') { u.uA.value.setRGB(1, 0.72, 0.42); u.uB.value.setRGB(1, 0.9, 0.7); }
  else {
    const a = (Math.random() * palette.length) | 0, b = (a + 1 + ((Math.random() * (palette.length - 1)) | 0)) % palette.length;
    u.uA.value.copy(palette[a]); u.uB.value.copy(palette[b]);
  }
  u.uCore.value.setRGB(1, rand(0.82, 0.97), rand(0.6, 0.95));
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
  return { points, mat, geo, data, alive: false, held: false, growing: false, age: 0, grow: 0, swallow: 0,
    maxScale: 2, growTime: 1.6, radius: 0.25, vel: new THREE.Vector3() };
}
const galaxies = Array.from({ length: 6 }, makeGalaxy);

function acquireGalaxy(p) {
  let g = galaxies.find(x => !x.alive);
  if (!g) g = galaxies.filter(x => !x.held).sort((a, b) => b.age - a.age)[0];
  if (!g) return null;
  shapeGalaxy(g);
  g.alive = true; g.held = true; g.growing = true; g.age = 0; g.grow = 0; g.swallow = 0; g.vel.set(0, 0, 0);
  g.points.visible = true; g.points.position.copy(p);
  return g;
}

// A pinch picks up whatever galaxy is under or near it (the target is generous) and only makes a new one
// in empty space. A galaxy whose holder has stopped being tracked can be taken over, so a hand that the
// tracker briefly loses or relabels carries on holding the same galaxy instead of spawning another.
function pinchGalaxy(p, hand, now) {
  let best = null, bestD = Infinity, blocked = false;
  for (const g of galaxies) {
    if (!g.alive || g.swallow > 0) continue;
    const d = Math.hypot(g.points.position.x - p.x, g.points.position.y - p.y);
    if (d >= Math.max(T.grabRadius, g.radius + 1)) continue;
    const busy = g.held && g.holder && g.holder !== hand && g.holder.gesture === 'pinch' && now - g.holder.lastSeen < 0.15;
    if (busy) { blocked = true; continue; } // the other hand really is holding it
    if (d < bestD) { best = g; bestD = d; }
  }
  if (best) {
    if (best.holder && best.holder !== hand && best.holder.galaxy === best) best.holder.galaxy = null;
    if (!best.held) best.growing = false;
    best.held = true; best.age = 0; best.vel.set(0, 0, 0);
  } else if (!blocked) best = acquireGalaxy(p);
  if (best) best.holder = hand;
  return best;
}

function killGalaxy(g) { if (g.holder && g.holder.galaxy === g) g.holder.galaxy = null; g.holder = null; g.alive = false; g.held = false; g.swallow = 0; g.points.visible = false; }

function updateGalaxies(dt) {
  for (const g of galaxies) {
    if (!g.alive) continue;
    g.age += dt;
    if (g.held) { g.age = 0; if (g.growing) g.grow += dt; }
    else {
      g.points.position.addScaledVector(g.vel, dt);
      g.vel.multiplyScalar(Math.exp(-0.6 * dt));
      if (g.age > GALAXY_LIFE) { killGalaxy(g); continue; }
    }
    const t = Math.min(1, g.grow / T.galaxyGrowTime);
    g.radius = T.galaxyMin + (T.galaxyMax - T.galaxyMin) * (1 - (1 - t) * (1 - t)); // quick at first, easing into the maximum
    const scale = g.radius * Math.max(0.02, 1 - g.swallow);
    g.points.scale.setScalar(scale);
    g.mat.uniforms.uSize.value = 0.2 + scale * 0.62;
    g.mat.uniforms.uTime.value += dt * (g.held && g.growing ? 2.2 : 1) * (1 + g.swallow * 7);
    const fadeIn = Math.min(1, g.grow * 3), fadeOut = g.held ? 1 : Math.min(1, (GALAXY_LIFE - g.age) / 3);
    const density = Math.min(1, 0.2 + 0.22 * scale * scale); // same star count in less area would burn out
    g.mat.uniforms.uAlpha.value = fadeIn * fadeOut * density * (g.held && !g.growing ? 1.3 : 1);
  }
}

// --- portal: an opaque window into somewhere else, ringed with energy
ambient.renderOrder = 0; particles.renderOrder = 2;
const portalMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uPulse: { value: 0 },
    uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    varying vec2 vUv; uniform float uTime, uOpen, uPulse; uniform vec3 uA, uB, uC;
    float hash1(float n){ return fract(sin(n) * 43758.5453); }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<5;i++){ v += a*noise(p); p = p*2.03 + 17.0; a *= 0.5; } return v; }
    void main(){
      vec2 p = (vUv - 0.5) * 3.4;            // rim sits at r = 1
      float r = length(p), a = atan(p.y, p.x);
      float inside = smoothstep(1.0, 0.965, r);

      // faint nebula swirling down the throat
      float sw = a + uTime * 0.6 + 2.6 * log(r + 0.06);
      float n = fbm(vec2(cos(sw), sin(sw)) * 1.6 + (0.9 / (r + 0.2) + uTime * 0.5) * vec2(0.8, 0.6));
      vec3 col = mix(uC, uA, smoothstep(0.1, 1.0, r)) * pow(n, 2.4) * 0.3;

      // stars streaking out of the centre at warp speed
      float an = a / 6.2831853 + 0.5;
      for (int i = 0; i < 2; i++) {
        float fi = float(i), cells = 36.0 + 22.0 * fi;
        float c = an * cells;
        float id = mod(floor(c), cells), f = fract(c) - 0.5;
        float rnd = hash1(id * 17.3 + fi * 91.7), rnd2 = hash1(id * 5.1 + fi * 13.3);
        float s = fract(rnd + uTime * (0.18 + 0.3 * rnd2));
        float rs = s * s * 1.05, len = 0.02 + 0.28 * s;
        float along = smoothstep(rs - len, rs, r) * smoothstep(rs + 0.015, rs, r);
        float across = smoothstep(0.5, 0.0, abs(f) * (1.0 + 6.0 * (1.0 - rnd2)));
        col += mix(vec3(1.0), mix(uA, uB, rnd), 0.55) * along * across * across * (0.15 + 0.5 * s);
      }
      col += mix(uC, vec3(1.0), 0.5) * 0.0012 / (r * r + 0.006);
      col *= inside;

      // the rim: a thin bright thread inside a wide, soft halo in the current colours
      float flick = 0.85 + 0.3 * fbm(vec2(cos(a + uTime * 0.7), sin(a + uTime * 0.7)) * 2.0 + uTime * 0.3);
      vec3 rimCol = mix(uA, uB, 0.5 + 0.5 * sin(a * 2.0 - uTime * 1.2));
      float dr = r - 1.0;
      float line = exp(-pow(dr / 0.014, 2.0)), glow = exp(-pow(dr / (dr > 0.0 ? 0.2 : 0.07), 2.0));
      col += (rimCol * glow * 0.2 * flick + mix(rimCol, vec3(1.0), 0.3) * line * 0.38) * (1.0 + 0.9 * uPulse);

      // premultiplied: the disc hides the stars behind it, everything else adds light
      gl_FragColor = vec4(col * uOpen, inside * 0.8 * uOpen);
    }`,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  depthWrite: false, depthTest: false, transparent: true,
});
const portal = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), portalMat);
portal.visible = false; portal.renderOrder = 1;
scene.add(portal);
let portalOpen = 0, portalRadius = 1, portalAge = 0, portalPulse = 0, portalWas = false;

function updatePortal(dt, active, a, b) {
  portalOpen += ((active ? 1 : 0) - portalOpen) * Math.min(1, dt * (active ? 5 : 3.5));
  portalPulse = Math.max(0, portalPulse - dt * 1.8);
  portal.visible = portalOpen > 0.01;
  if (active) {
    // sized to sit in the gap between the two palms rather than spill past them
    const target = THREE.MathUtils.clamp(Math.hypot(a.x - b.x, a.y - b.y) / 2 - 1.0, 0.35, 4.5);
    portalRadius += (target - portalRadius) * Math.min(1, dt * 8);
    portal.position.lerpVectors(a, b, 0.5); portal.position.z = -0.2;
    if (!portalWas) { portalAge = 0; portalPulse = 1; ring(portal.position, 220, 3.5, 0.2); } // it opens with a soft ripple
    portalAge += dt;
    // background stars get drawn onto the rim and race around it
    wells.push({ x: portal.position.x, y: portal.position.y, z: 0, g: 3, r0: portalRadius * 1.2, swirl: 4, range: portalRadius * 2.5 + 1.5 });
    for (let i = 0; i < 5; i++) {
      const ang = Math.random() * TAU, c = Math.cos(ang), s = Math.sin(ang), v = 1 + Math.random() * 1.5;
      pickColor(0.3);
      spawn(portal.position.x + c * portalRadius, portal.position.y + s * portalRadius, 0,
        -s * v + c * (Math.random() - 0.3) * 2, c * v + s * (Math.random() - 0.3) * 2, (Math.random() - 0.5),
        cr, cg, cb, 0.5 + Math.random() * 0.9, 0.03 + Math.random() * 0.03);
    }
  }
  portalWas = active;

  // Galaxies fall in: at once if they are close, and from further and further away the longer it stays open.
  const reach = portalRadius * 1.3 + 0.6 + portalAge * 0.55;
  for (const g of galaxies) {
    if (!g.alive || g.held) continue;
    if (!active) { g.swallow = Math.max(0, g.swallow - dt * 2); continue; } // it closed in time: the galaxy recovers
    const dx = portal.position.x - g.points.position.x, dy = portal.position.y - g.points.position.y;
    const d = Math.hypot(dx, dy) + 1e-3;
    if (g.swallow > 0 || d < Math.max(0.6, portalRadius * 0.7)) { // past the rim there is no way back
      g.swallow = Math.min(1, g.swallow + dt * 1.3);
      const k = Math.min(1, dt * 5);
      g.points.position.x += dx * k; g.points.position.y += dy * k;
      g.vel.multiplyScalar(Math.exp(-4 * dt));
      if (g.swallow >= 1) { killGalaxy(g); portalPulse = 1; ring(portal.position, 300, 5, 0.3); }
    } else if (d < reach) {
      const acc = (3.5 + 7 * portalAge / (portalAge + 4)) * (1 - 0.6 * d / reach);
      g.vel.x += (dx - dy * 0.3) / d * acc * dt; g.vel.y += (dy + dx * 0.3) / d * acc * dt; // spiral inward
      g.vel.multiplyScalar(Math.exp(-1.5 * dt));
      g.age = Math.min(g.age, GALAXY_LIFE - 4);
    }
  }

  if (!portal.visible) return;
  portal.scale.setScalar(portalRadius * (0.2 + 0.8 * portalOpen) * (1 + 0.04 * portalPulse));
  const u = portalMat.uniforms;
  u.uTime.value += dt; u.uOpen.value = portalOpen; u.uPulse.value = portalPulse;
  u.uA.value.copy(palette[0]); u.uB.value.copy(palette[1]); u.uC.value.copy(palette[2]);
}

// --- nebulae: touch two pointing fingertips together, then draw them apart to stretch a cloud between them
const NEBULA_LIFE = 60;
function makeNebula() {
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
  return { mesh, mat, alive: false, held: false, age: 0, born: 0, size: 1 };
}
const nebulae = Array.from({ length: 4 }, makeNebula);
let nebula = null, nebulaLost = 0; // the one being pulled right now

function updateNebulae(dt, L, R) {
  const both = L.active && R.active && L.gesture === 'point' && R.gesture === 'point';
  if (both) {
    const a = L.tips[1], b = R.tips[1], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (!nebula && d < T.nebulaTouch) {
      const n = nebulae.find(x => !x.alive) || nebulae.slice().sort((x, y) => y.age - x.age)[0];
      const u = n.mat.uniforms, i = (Math.random() * palette.length) | 0;
      u.uA.value.copy(palette[i]); u.uB.value.copy(palette[(i + 1) % palette.length]); u.uC.value.copy(palette[(i + 2) % palette.length]);
      u.uSeed.value = Math.random() * 100;
      n.alive = n.held = true; n.age = n.born = 0; n.size = T.nebulaMin;
      n.mesh.visible = true; n.mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, -0.5);
      n.mesh.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
      nebula = n;
    }
    if (nebula) {
      nebulaLost = 0;
      const k = Math.min(1, dt * 10), m = nebula.mesh;
      nebula.size += (THREE.MathUtils.clamp(d, T.nebulaMin, T.nebulaMax) - nebula.size) * k;
      m.position.x += ((a.x + b.x) / 2 - m.position.x) * k; m.position.y += ((a.y + b.y) / 2 - m.position.y) * k;
      // lies along the line between the fingertips; a half-turn either way is the same line, so take the nearer one
      let ang = Math.atan2(b.y - a.y, b.x - a.x);
      ang += Math.PI * Math.round((m.rotation.z - ang) / Math.PI);
      m.rotation.z += (ang - m.rotation.z) * k;
      for (const t of [a, b]) { // a spark at each fingertip
        pickColor(0.5);
        spawn(t.x + rnd(0.05), t.y + rnd(0.05), t.z, rnd(0.5), rnd(0.5), rnd(0.3), cr, cg, cb, 0.3 + Math.random() * 0.5, 0.04 + Math.random() * 0.04);
      }
    }
  } else if (nebula && (nebulaLost += dt) > 0.3) { nebula.held = false; nebula = null; }

  for (const n of nebulae) {
    if (!n.alive) continue;
    n.born += dt;
    if (n.held) n.age = 0; else if ((n.age += dt) > NEBULA_LIFE) { n.alive = false; n.mesh.visible = false; continue; }
    n.mesh.scale.set(n.size * 1.5 + 0.4, n.size * 1.05 + 0.4, 1);
    n.mat.uniforms.uTime.value += dt * (n.held ? 2.5 : 1);
    n.mat.uniforms.uAlpha.value = Math.min(1, n.born * 2.5) * Math.min(1, (NEBULA_LIFE - n.age) / 5);
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
    this.charge = 0; this.lastBurst = -10; this.lastPeace = -10; this.galaxy = null;

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CONNECTIONS.length * 6), 3));
    this.lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
      transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthTest: false }));
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(21 * 3), 3));
    this.dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({
      size: 0.13, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthTest: false }));
    this.lines.frustumCulled = this.dots.frustumCulled = false;
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
  }

  release() {
    if (this.galaxy) {
      this.galaxy.held = false; this.galaxy.growing = false; this.galaxy.holder = null;
      // it stays where you put it unless you actually throw it
      if (this.vel.length() > T.grabFling) this.galaxy.vel.copy(this.vel).multiplyScalar(0.25).clampLength(0, 3);
      else this.galaxy.vel.set(0, 0, 0);
      this.galaxy = null;
    }
  }

  deactivate() { this.release(); this.active = false; this.gesture = 'none'; this.charge = 0; this.hasQuat = false; }

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

  act(now, dt, portalActive, sculpting) {
    const g = this.gesture, p = this.pos;
    if (g !== 'pinch') this.release();
    // the gathered charge survives the split second it takes a fist to become an open hand, then drains
    if (g !== 'fist' && now - (this.fistAt ?? -10) > T.openWindow) this.charge = Math.max(0, this.charge - dt * 3);

    if (g === 'open') {
      // An open hand on its own never explodes. The supernova only fires when a fist that has
      // actually been gathering is opened.
      if (this.charge >= T.minCharge) { burst(p, this.charge, this.vel); this.lastBurst = now; }
      this.charge = 0;
      if (!portalActive) wells.push({ x: p.x, y: p.y, z: p.z, g: -7 });
      if (!portalActive) { // streamers off every fingertip
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
    } else if (g === 'pinch') {
      if (!this.galaxy) {
        this.galaxy = pinchGalaxy(this.pinchPt, this, now);
        this.grabInv = null; // remember how the hand and the galaxy were angled when the pinch began
        if (this.galaxy && this.hasQuat) { this.grabInv = this.quat.clone().invert(); this.grabQ.copy(this.galaxy.points.quaternion); }
      }
      if (this.galaxy) {
        this.galaxy.points.position.lerp(this.pinchPt, Math.min(1, dt * (this.galaxy.growing ? 14 : 7)));
        if (this.grabInv && this.hasQuat) { // the galaxy turns with the hand from then on
          _q.copy(this.quat).multiply(this.grabInv).multiply(this.grabQ);
          this.galaxy.points.quaternion.slerp(_q, Math.min(1, dt * 10));
        }
        const q = this.pinchPt, r = this.galaxy.points.scale.x; // nearby stars fall into orbit
        wells.push({ x: q.x, y: q.y, z: q.z, g: 6, r0: r * 0.9, swirl: 5, range: 2 + r * 1.5 });
      }
    } else if (g === 'point' && !sculpting) {
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
  hintEl.textContent = 'Stand back so the camera sees your hands · V toggles the camera preview · F for full screen';
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
function enter() { setPalette(0); introEl.classList.add('hidden'); hudEl.classList.add('on'); paletteEl.classList.add('on'); }

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
window.addEventListener('keydown', e => { if ((e.key === 'v' || e.key === 'V') && mode === 'camera') video.classList.toggle('on'); });

// full screen: button in the corner, or the F key
const fsBtn = document.getElementById('fs');
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(err => console.warn('Full screen was refused:', err));
}
if (document.fullscreenEnabled) {
  fsBtn.addEventListener('click', e => { toggleFullscreen(); e.currentTarget.blur(); });
  window.addEventListener('keydown', e => { if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFullscreen(); });
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    fsBtn.classList.toggle('on', on);
    fsBtn.title = on ? 'Exit full screen (F or Esc)' : 'Full screen (F)';
  });
} else fsBtn.hidden = true;
setPalette(0);

// ---------------------------------------------------------------- main loop
let last = performance.now() / 1000, idleT = 0, nextMeteor = 4, meteor = null;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, dt = Math.min(0.05, now - last);
  last = now;
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
  const novaBusy = Math.max(L.charge, R.charge) >= T.minCharge || now - Math.max(L.lastBurst, R.lastBurst) < T.portalDelay;
  const portalActive = L.active && R.active && L.gesture === 'open' && R.gesture === 'open' && !novaBusy;
  updateNebulae(dt, L, R);
  for (const h of [L, R]) { if (h.active) h.act(now, dt, portalActive, !!nebula); h.drawSkeleton(); }

  updatePortal(dt, portalActive, L.pos, R.pos);
  updateGalaxies(dt);
  updateParticles(dt);
  updateAmbient(dt);

  for (const g in chips) {
    const names = g.split(' ');
    chips[g].classList.toggle('active', g === 'portal' ? portalActive : g === 'nebula' ? !!nebula
      : !portalActive && !(nebula && g === 'point') && ((L.active && names.includes(L.gesture)) || (R.active && names.includes(R.gesture))));
  }

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

window.__universe = { hands, galaxies, nebulae, burst, setPalette, get mode() { return mode; } };
