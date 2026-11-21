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
  pinchHold: 1.0,    // seconds a pinch must be held in empty space, gathering light, before it makes something new
  lockHold: 0.5,     // seconds a pinch must rest on something before it takes hold of it
  pinchDrift: 0.7,   // ...and how far it may wander in that time: a pinch on the move is not asking for anything
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
  lifeSpeed: 1,        // how fast life and its troubles move along (1 = as designed)
  pushGrow: 0.2,       // an open palm that grows this much bigger in the camera's eye has been pushed at the screen: go in
  pushTime: 0.8,       // ...if it did so within this many seconds (slower than that is just drifting about)
  landHold: 1.0,       // two fingers rested this long on a spot of a planet take you down to stand there
  climateHold: 1.0,    // seconds a pointing finger must rest on a planet before the climate there changes
  climateStep: 1.5,    // ...and how long each climate lasts before it moves on to the next, if the finger stays
  zoomPull: 2.0,       // how far (world units) two open hands must sweep apart to dive in
  zoomTouch: 0.5,      // two open hands count as touching when any parts of them are this close, in hand-lengths...
  zoomCame: 2.0,       // ...provided they travelled at least this far (world units) to meet...
  zoomRest: 0.35,      // ...and climbing out happens once they have rested together this many seconds; parting sooner is a dive
  zoomInDelay: 1.5,    // after climbing out, sweeping apart does nothing for this many seconds
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
// What the player has chosen in the settings window, remembered in this browser.
const SET_KEY = 'handiverse.settings', SET_DEFAULT = { res: '2', glow: 1, pace: 1, disasters: true, sound: false, volume: 0.6, hum: true, chimes: true };
const settings = { ...SET_DEFAULT };
try { const saved = JSON.parse(localStorage.getItem(SET_KEY) || '{}'); for (const k in SET_DEFAULT) if (typeof saved[k] === typeof SET_DEFAULT[k]) settings[k] = saved[k]; } catch {}
const autoRatio = () => Math.min(window.devicePixelRatio, 1.5);
let pixelRatio = settings.res === 'auto' ? autoRatio() : Math.min(2, +settings.res || 1);
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

// Light drawn in to a pinch that is about to make something: a ring closing, motes, a brightening spark.
function gatherLight(q, k, now) {
    const e = k * k * (3 - 2 * k), ringR = 1.15 * (1 - e) + 0.12, spin = now * 2.2;
    pickColor(0.7);
    for (let i = 0; i < 10; i++) { // a ring of light closing in, turning as it comes
      const a = spin + i * TAU / 10 + rnd(0.3), b = (i % 2 ? 1.1 : 2.2) * (0.6 + 0.4 * k);
      spawn(q.x + Math.cos(a) * ringR, q.y + Math.sin(a) * ringR, q.z, 0, 0, 0, cr * b, cg * b, cb * b, 0.2, 0.05 + 0.04 * k);
    }
    for (let i = 0; i < 5; i++) { // motes drawn in from further out
      const a = Math.random() * TAU, r = ringR + 0.25 + Math.random() * 0.5, life = 0.32 + Math.random() * 0.12, v = r / life * 0.9;
      pickColor(0.35);
      spawn(q.x + Math.cos(a) * r, q.y + Math.sin(a) * r, q.z, -Math.cos(a) * v - Math.sin(a) * 0.6, -Math.sin(a) * v + Math.cos(a) * 0.6, 0, cr * 1.8, cg * 1.8, cb * 1.8, life, 0.045);
    }
    pickColor(0.9); // and the spark they feed, brightening
    spawn(q.x + rnd(0.02), q.y + rnd(0.02), q.z, 0, 0, 0, cr * (0.6 + 1.8 * k), cg * (0.6 + 1.8 * k), cb * (0.6 + 1.8 * k), 0.14, 0.1 + 0.3 * k);
}
// ...and the brackets that turn and tighten round a thing a pinch is locking on to (e runs 0 to 1)
function lockRing(x, y, z, R, e, now) {
  pickColor(0.85);
  for (let i = 0, n = Math.round(12 + R * 16); i < n; i++) {
    const a = now * 1.6 * (1 - 0.7 * e) + (i % 4) * TAU / 4 + Math.random() * 0.75, b = 2 + 2 * e;
    spawn(x + Math.cos(a) * R, y + Math.sin(a) * R, z, 0, 0, 0, cr * b, cg * b, cb * b, 0.18, 0.06 + 0.035 * e);
  }
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
  // Something loose is only picked up once the pinch has rested on it long enough to lock on. (A thing still
  // marked as held is being handed over from a hand the tracker lost, and that is not made to wait.)
  if (best && !best.held && !(hand.lockObj === best && hand.lockK >= 1)) { hand.lockSeen = best; return null; }
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
let level = 0, depth = 0, E1 = 0, E2 = 0, E3 = 0, E4 = 0, focusG = null, focusS = null, focusP = null, land = null;
let zoomNudge = 0, zoomLock = false, zoomKey = null, zoomOn = false, zoomMin = 0, zoomMax = 0, zoomGap = 0, zoomHeld = 0, zoomShow = false, zoomWait = 0, zoomFar = 0, zoomMeet = false, zoomRested = 0;
let galS = 9, sysR = 4.8, gK = 1, zM = 1, zPx = 0, zPy = 0, bodyTime = 0;
const gO = new THREE.Vector3(), _w = new THREE.Vector3();
const ease = t => t * t * (3 - 2 * t), clamp01 = t => Math.min(1, Math.max(0, t));

function updateView(dt) {
  galS = Math.max(viewW, viewH) * 0.5;  // how big a galaxy's disc is drawn once we are inside it
  sysR = Math.min(viewW, viewH) * 0.47; // the widest orbit that still fits on screen
  if (level >= 3 && !focusP) setLevel(2);
  if (level >= 2 && !focusS) setLevel(1);
  if (level >= 1 && !focusG) setLevel(0);
  const target = level + zoomNudge;
  depth += (target - depth) * Math.min(1, dt * 3);
  if (Math.abs(target - depth) < 0.0015) depth = target;
  E1 = ease(clamp01(depth)); E2 = ease(clamp01(depth - 1)); E3 = ease(clamp01(depth - 2)); E4 = ease(clamp01(depth - 3));
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
  note(n === 3 && focusP && !isSolid(focusP) ? 'Pinch the clouds to brew a storm' : n === 3 && focusP && focusP.life && focusP.life.s === 4 ? `The ${folk(focusP).name} live on ${properName(focusP.seed)}: ${folk(focusP).traitText}. ${mood(focusP.life.f)}.` : ARRIVE[n], 6);
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

// Going in and coming out are deliberately different moves so that one is never taken for the other. Push an
// open palm at the screen: dive into what is under it. Bring both hands together and keep them together for
// a moment: climb back out.
function zoomTarget(x, y, wide) {
  const list = level === 0 ? galaxies : level === 1 && focusG ? focusG.stars : level === 2 && focusS ? focusS.planets : null;
  let best = null, bd = Infinity;
  if (list) for (const o of list) {
    if (o.kind === 'galaxy' && !o.alive) continue;
    const d = Math.hypot(o.wx - x, o.wy - y);
    if (d < (wide ? Math.max(4.5, o.reach * 2) : Math.max(2.2, o.reach * 1.3)) && d < bd) { best = o; bd = d; }
  }
  return best;
}
// Do the two hands meet? Measured between their nearest joints and scaled by the size of the hands, so it
// works the same near the camera and far from it.
function handsTouch(L, R, d) {
  if (!L.hasJoints || !R.hasJoints) return d < 2.2;
  const size = (Math.hypot(L.joints[9].x - L.joints[0].x, L.joints[9].y - L.joints[0].y) + Math.hypot(R.joints[9].x - R.joints[0].x, R.joints[9].y - R.joints[0].y)) / 2;
  let best = Infinity;
  for (const a of L.joints) for (const b of R.joints) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
  return best < size * T.zoomTouch;
}
// How hard is this palm being pushed at the screen? Read from how much bigger it has grown than it was at its
// smallest in the last moment or so: a hand coming toward the camera swells, one drifting about does not.
let pushWait = 0;
function pushOf(h, now, ok) {
  const tr = h.push || (h.push = []);
  if (!ok || !h.active || h.gesture !== 'open' || !h.size) { if (!ok || now - (h.pushAt ?? -9) > 0.25) tr.length = 0; return 0; }
  h.pushAt = now; tr.push(now, h.size);
  while (tr.length && now - tr[0] > T.pushTime) tr.splice(0, 2);
  let ref = Infinity;
  for (let i = 1; i < tr.length; i += 2) ref = Math.min(ref, tr[i]);
  return clamp01((h.size / ref - 1.05) / (T.pushGrow - 0.05));
}
function updateZoom(L, R, now, dt) {
  const fresh = Math.max(L.charge, R.charge) >= T.minCharge || now - Math.max(L.lastBurst, R.lastBurst) < 1.2; // that is a supernova, not a stroke
  // A hand sweeping sideways is seen edge-on and stops reading as cleanly open, so one that was open in the
  // last couple of seconds and has not become a fist, pinch or point still counts.
  const openish = h => h.active && (h.gesture === 'open' || h.gesture === 'none') && now - h.lastOpen < 2;
  const both = openish(L) && openish(R) && !fresh;
  let nudge = zoomHeld;
  // How far apart the hands recently were, remembered through tracking dropouts and fading over a few
  // seconds, so that hands which blur or vanish for a moment on the way together still count as having come.
  if (L.active && R.active) zoomFar = Math.max(Math.hypot(L.pos.x - R.pos.x, L.pos.y - R.pos.y), zoomFar - dt * 1.2);
  else zoomFar = Math.max(0, zoomFar - dt * 1.2);
  // A dive or a climb finishes by itself: once the view has settled the hands can go straight into the next
  // one, measured afresh from wherever they now are, without having to be dropped first.
  if (zoomLock && Math.abs(depth - level) < 0.04) { zoomLock = false; zoomOn = false; }
  if (!both) {
    if (!zoomOn || fresh || (zoomGap += dt) > 0.6) { zoomOn = false; zoomKey = null; nudge = 0; } // a brief dropout does not throw the stroke away
  } else if (!zoomLock) {
    zoomGap = 0; nudge = 0;
    const d = Math.hypot(L.pos.x - R.pos.x, L.pos.y - R.pos.y), mx = (L.pos.x + R.pos.x) / 2, my = (L.pos.y + R.pos.y) / 2;
    if (!zoomOn) { zoomOn = true; zoomMin = zoomMax = d; zoomKey = null; }
    zoomMax = Math.max(zoomMax, d);
    if (d < zoomMin) { zoomMin = d; zoomKey = null; }
    if (now < zoomWait) { zoomMin = zoomMax = zoomFar = d; zoomKey = null; } // just climbed out: parting the hands again is not a dive, yet
    // Touching hands could be the wind-up for a dive or the wish to leave, and only what happens next says
    // which: parted again straight away it is a dive, measured from where they met; rested together, we leave.
    if (handsTouch(L, R, d)) {
      if (!zoomMeet && zoomFar - d > T.zoomCame) zoomMeet = true;
      zoomMin = d; zoomKey = null;
      zoomRested = zoomMeet && level > 0 && level < 4 && now >= zoomWait ? zoomRested + dt : 0;
    } else { zoomMeet = false; zoomRested = 0; }
    const outward = clamp01(zoomRested / T.zoomRest);
    if (outward > 0) {
      nudge = -outward * 0.25;
      if (outward >= 1) { surface(); zoomWait = now + T.zoomInDelay; zoomMeet = false; zoomRested = 0; zoomFar = 0; nudge = 0; pushWait = now + 1; }
    }
  }
  // In: an open palm pushed at the screen goes into whatever is under it. A galaxy, a star, a planet, and
  // from a planet down to the ground where the palm is.
  if (!zoomLock && !fresh && level < 4 && now >= pushWait && zoomRested === 0) {
    const pl = pushOf(L, now, true), pr = pushOf(R, now, true), hd = pl >= pr ? L : R, k = Math.max(pl, pr);
    let went = false;
    if (k > 0 && level === 3) {
      if (k >= 1 && focusP && isSolid(focusP) && globePoint(hd.pos.x, hd.pos.y)) { enterLand(at.lon, at.lat); went = true; }
    } else if (k > 0) {
      const o = zoomTarget(hd.pos.x, hd.pos.y, false), kind = o && o.kind;
      const free = o && (kind === 'galaxy' ? (!focusG || focusG === o || depth < 0.02) : kind === 'star' ? (!focusS || focusS === o || depth < 1.02) : (!focusP || focusP === o || depth < 2.02));
      if (free) {
        if (kind === 'galaxy') focusG = o; else if (kind === 'star') focusS = o; else focusP = o;
        zoomKey = o; nudge = k * 0.25;
        if (k >= 1) { diveInto(o); nudge = 0; went = true; }
      }
    }
    if (went) { L.push.length = R.push.length = 0; pushWait = now + 1; }
  } else { pushOf(L, now, false); pushOf(R, now, false); }
  zoomHeld = nudge; zoomShow = nudge !== 0;
  zoomNudge += (nudge - zoomNudge) * Math.min(1, dt * 10);
}

// ---------------------------------------------------------------- stars and planets
const STAR_MAX = 16, STAR_GROW = 6, PLANET_MAX = 8, PLANET_GROW = 6, MOON_MAX = 4;
const newSeed = () => (Math.random() * 1e9) | 0;
// Everything you make gets a name of its own, read off its seed, so it is the same name every time you come back.
const NAME_START = ['Va', 'Ke', 'Ti', 'Or', 'Sa', 'Lu', 'Mi', 'Za', 'El', 'Ny', 'Tha', 'Bra', 'Cor', 'Ae', 'Is', 'Dro', 'Fen', 'Ha', 'Jo', 'Qui', 'Ru', 'Sy', 'Ul', 'Xan', 'Ye', 'An', 'Bel', 'Cy', 'Del', 'Eri', 'Ga', 'Ili', 'Ka', 'Lo', 'Mor', 'No', 'Os', 'Pha', 'Rho', 'Tal'];
const NAME_MID = ['la', 'ri', 'no', 'the', 'ma', 'lo', 'ra', 'si', 'ne', 'du', 'vi', 'ka', 'me', 'to', 'li', 'sha'];
const NAME_END = ['ra', 'nis', 'ron', 'ria', 'th', 'ne', 'lix', 'mus', 'dor', 'ssa', 'von', 'ris', 'tea', 'on', 'ara', 'ium', 'eth', 'ys', 'una', 'ix', 'os', 'ane', 'ille', 'or'];
function properName(seed) {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  const next = n => { x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0; x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0; x = (x ^ (x >>> 15)) >>> 0; return x % n; };
  return NAME_START[next(NAME_START.length)] + (next(3) === 0 ? NAME_MID[next(NAME_MID.length)] : '') + NAME_END[next(NAME_END.length)];
}
// "Velora galaxy", "Kessa yellow star", "Tirune ocean world"
const titleOf = o => properName(o.seed) + ' ' + (o.kind === 'galaxy' ? 'galaxy' : (o.kind === 'star' ? starName(o) : planetName(o)).toLowerCase());
const mkStar = (u, v, grow, seed) => ({ kind: 'star', u, v, grow, seed, planets: [],
  held: false, growing: false, isNew: false, holder: null, swallow: 0, wx: 0, wy: 0, wr: 0.1, reach: 1.4 });
const mkPlanet = (r, a, grow, seed) => ({ kind: 'planet', r, a, grow, seed, rings: 0, moons: [],
  life: null, scars: [], // what lives there and how it feels about you; craters from meteors that fell while you were away
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
// A world's climate starts with where it sits: close in to its star it bakes, far out it freezes, and a hotter
// star pushes the mild orbits further out. Then its seas: the more open water, the more rain falls on the land.
const orbitHeat = p => { const st = p.sun || focusS; if (!st) return 0; const lo = orbitMin(st), x = clamp01((p.r - lo) / (1 - lo)); return (0.45 - x) * (x < 0.45 ? 2.6 : 1.6) + (starT(st) - 0.5) * 0.5; };
const baseTemp = p => (planetT(p) < 0.3 ? -0.1 : 0.05) + orbitHeat(p);
const seaWet = w => (w == null ? 0 : THREE.MathUtils.clamp((w - 0.5) * 1.2, -0.6, 0.4)); // from the share of the world under water
const hexes = rows => rows.map(r => r.map(c => new THREE.Color(c)));
const ROCKS = hexes([['#5c5148', '#8a7a6a', '#b9b0a5'], ['#6b3a26', '#a85a36', '#d9a27a'], ['#4a4a52', '#77777f', '#b5b5c0'], ['#3d3326', '#7d6a45', '#c9b47f']]);
const WORLDS = hexes([['#12408f', '#8a6a48', '#ffffff'], ['#0f4f8a', '#b89a5a', '#f2f6ff'], ['#1a5a6a', '#7d6f5a', '#ffffff'], ['#1b3a9a', '#9a5f3c', '#eef4ff']]); // sea, bare land, cloud: nothing grows yet
const ICES = hexes([['#2f6fb0', '#7fd0e6', '#d9f6ff'], ['#3a4fc0', '#6fa0ff', '#cfe0ff'], ['#2a8f8f', '#8fe6d0', '#e6fff6']]);
const GASES = hexes([['#8a5a32', '#e0b888', '#fff0d8'], ['#a0522d', '#f0c27a', '#ffe6b0'], ['#6a4a7a', '#d09ac0', '#ffe0f0'], ['#7a6a3a', '#e6d28a', '#fffbe0']]);
function planetLook(p) {
  const t = planetT(p), set = t < 0.3 ? ROCKS : t < 0.55 ? WORLDS : t < 0.78 ? ICES : GASES;
  return { c: set[p.seed % set.length], gas: t < 0.55 ? 0 : 1, cloud: t < 0.3 ? 0.12 : 0.8 };
}
const MOON_IN = 1.45, MOON_SPAN = 1.1, MOON_SQ = 0.35; // a moon's orbit seen from its planet: nearest and furthest (in globe radii), and how flat it looks
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
  o.sun = focusS; focusS.planets.push(o);
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
  const lost = (best.kind === 'galaxy' ? best.stars.flatMap(st => st.planets) : best.kind === 'star' ? best.planets : [best]).filter(q => q.life && q.life.s === 4).length;
  note(`${titleOf(best)} destroyed${lost ? best.kind === 'planet' ? ', and its civilization with it' : lost > 1 ? `, and ${lost} civilizations with it` : ', and a civilization with it' : ''}`, 6);
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
  u.uTime.value = bodyTime; u.uAlpha.value = alpha; m.renderOrder = 2.6;
  return m;
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
        const near = p === fp ? E3 : 0;
        if (now - (m.heldAt ?? -9) > 0.25) m.a += dt * 0.9 / (0.5 + m.d) * (1 - 0.65 * near); // it waits while a hand is on it
        const md = pr * (1.7 + 3.3 * m.d) + 0.1 * z3, ca = Math.cos(m.a), sa = Math.sin(m.a);
        let mx = x + ca * md, my = y + sa * md, mr = sysR * (0.008 + (m.seed % 5) * 0.001) * shrink * z3;
        if (near) { // up close the orbit is drawn in to fit the view, and seen nearly edge on
          const md3 = globeR * (MOON_IN + MOON_SPAN * m.d);
          mx += (x + ca * md3 - mx) * near; my += (y + sa * md3 * MOON_SQ - my) * near;
          mr += (THREE.MathUtils.clamp(mr, globeR * 0.08, globeR * 0.2) - mr) * near;
        }
        m.wx = mx; m.wy = my; m.wr = mr;
        drawPlanet(np++, mx, my, mr, m.seed, moonLook(m), 0, -cx, -cy, p === fp ? E2 : fade).renderOrder = near > 0.5 && sa < 0 ? 2.75 : 2.6; // the near half of the orbit passes in front of the globe
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
const MAP_W = 512, MAP_H = 256, MAP_N = MAP_W * MAP_H;
const mapH = new Float32Array(MAP_N), mapBase = new Float32Array(MAP_N), mapR = new Float32Array(MAP_N); // height now, height as generated, rivers
const mapT = new Float32Array(MAP_N), mapM = new Float32Array(MAP_N); // climate: how much warmer and how much wetter than the place would naturally be
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
    mapHalf[k * 4 + 2] = THREE.DataUtils.toHalfFloat(mapT[k]); mapHalf[k * 4 + 3] = THREE.DataUtils.toHalfFloat(mapM[k]);
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
const sbyte = (v, k) => (Math.max(-127, Math.min(127, Math.round(v * k))) + 256) & 255, unsbyte = v => (v > 127 ? v - 256 : v);
const CW = MAP_W / 4, CH = MAP_H / 4;
function coarse(b64, out, k) { // unpack a quarter-resolution layer and smooth it back up to full size
  if (!b64) return;
  const tmp = new Float32Array(CW * CH);
  unpack(b64, CW * CH, (i, v) => { tmp[i] = unsbyte(v) / k; });
  for (let j = 0, n = 0; j < MAP_H; j++) {
    const y = Math.max(0, Math.min(CH - 1, (j - 1.5) / 4)), y0 = Math.floor(y), y1 = Math.min(CH - 1, y0 + 1), fy = y - y0;
    for (let i = 0; i < MAP_W; i++, n++) {
      const x = ((i - 1.5) / 4 + CW) % CW, x0 = Math.floor(x), x1 = (x0 + 1) % CW, fx = x - x0;
      const a = tmp[y0 * CW + x0] + (tmp[y0 * CW + x1] - tmp[y0 * CW + x0]) * fx, b = tmp[y1 * CW + x0] + (tmp[y1 * CW + x1] - tmp[y1 * CW + x0]) * fx;
      out[n] = a + (b - a) * fy;
    }
  }
}
function storeTerrain() {
  if (!terrainOf || !terrainDirty) return;
  terrainDirty = false;
  if (!isSolid(terrainOf)) return;
  const h = pack(MAP_N, i => sbyte(mapH[i] - mapBase[i], 80)), r = pack(MAP_N, i => Math.round(mapR[i] * 15));
  // climate changes are broad and soft, so they are kept at a quarter of the resolution each way
  const q = i => ((((i / CW) | 0) * 4 + 2) * MAP_W) + (i % CW) * 4 + 2;
  const t = pack(CW * CH, i => sbyte(mapT[q(i)], 60)), m = pack(CW * CH, i => sbyte(mapM[q(i)], 100));
  terrainOf.map = h || r || t || m ? { v: 2, h, r, t, m } : null;
}
const baseCache = new WeakMap();
function baseOf(p) { // a planet's terrain as its seed made it, before any hand touched it
  let b = baseCache.get(p);
  if (!b || b.kind !== planetKind(p)) { const H = new Float32Array(MAP_N); b = { H, sea: generateTerrain(p, H), kind: planetKind(p) }; baseCache.set(p, b); }
  return b;
}
// lay the hand-made changes over the generated terrain already in H
function decodeMap(p, H, R, Tm, Mm) {
  if (p.map) try {
    // the first version of these maps was half as fine each way: spread each of its texels over four
    const old = p.map.v !== 2, n = old ? MAP_N / 4 : MAP_N;
    const each = (b64, put) => {
      if (!b64) return;
      if (!old) return unpack(b64, n, put);
      const tmp = new Uint8Array(n);
      unpack(b64, n, (i, v) => { tmp[i] = v; });
      for (let j = 0, k = 0; j < MAP_H; j++) for (let i = 0; i < MAP_W; i++, k++) put(k, tmp[(j >> 1) * (MAP_W / 2) + (i >> 1)]);
    };
    each(p.map.h, (i, v) => { H[i] = clampH(H[i] + unsbyte(v) / 80); });
    if (R) each(p.map.r, (i, v) => { R[i] = v / 15; });
    coarse(p.map.t, Tm, 60); coarse(p.map.m, Mm, 100);
  } catch (err) { console.warn('Could not restore this planet\'s terrain:', err); }
  for (const c of p.scars) stampCrater(H, c[0], c[1], c[2], c[3]);
}
function loadTerrain(p) {
  storeTerrain();
  terrainOf = p; terrainDirty = false;
  if (!isSolid(p)) return;
  const b = baseOf(p);
  seaDefault = b.sea; mapBase.set(b.H);
  dirtyLo = MAP_H; dirtyHi = -1;
  mapH.set(mapBase); mapR.fill(0); mapT.fill(0); mapM.fill(0);
  decodeMap(p, mapH, mapR, mapT, mapM);
  if (p.scars.length) { p.scars.length = 0; terrainDirty = true; markDirty(); } // those craters are part of the map from now on
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
    uTime: { value: 0 }, uSeed: { value: 0 }, uAlpha: { value: 0 }, uKind: { value: 0 }, uSea: { value: 0 }, uBase: { value: -1.5 }, uTemp: { value: 0 }, uLife: { value: 0 },
    uCloud: { value: 0 }, uGreen: { value: 0 }, uSeaLife: { value: 0 }, uCiv: { value: 0 }, uWet: { value: 0 }, uCivCol: col3(1, 0.8, 0.5), uRing: { value: 0 }, uTilt: { value: 0 }, uBands: { value: 9 }, uWind: { value: 1 },
    uDeep: col3(0, 0, 0), uShallow: col3(0, 0, 0), uSand: col3(0, 0, 0), uLow: col3(0, 0, 0), uForest: col3(0, 0, 0), uHigh: col3(0, 0, 0), uPeak: col3(1, 1, 1), uAtm: col3(0, 0, 0),
    uSpots: { value: Array.from({ length: SPOT_MAX }, () => new THREE.Vector4()) } },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D uMap; uniform mat3 uRot; uniform vec3 uLight, uDeep, uShallow, uSand, uLow, uForest, uHigh, uPeak, uAtm, uCivCol;
    uniform float uTime, uSeed, uAlpha, uKind, uSea, uBase, uTemp, uLife, uCloud, uRing, uTilt, uBands, uWind, uGreen, uSeaLife, uCiv, uWet;
    uniform vec4 uSpots[${SPOT_MAX}];
    ${NOISE3_GLSL}
    void main(){
      vec2 p = (vUv - 0.5) * 2.0; float r = length(p);
      const float R = 0.4;
      float disc = smoothstep(R, R - 0.004, r);
      vec2 q = p / R; float z = sqrt(max(0.0, 1.0 - dot(q, q)));
      vec3 m = uRot * vec3(q, z), Lp = uRot * uLight;          // this point, and the sun, in the planet's own frame
      float lat = asin(clamp(m.y, -1.0, 1.0)), lon = atan(m.x, m.z);
      vec3 col, N = m; float spec = 0.0, lights = 0.0;
      if (uKind < 0.5) {
        vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.14159265 + 0.5);
        vec4 t = texture2D(uMap, uv);
        const float ex = 1.0 / ${MAP_W}.0, ey = 1.0 / ${MAP_H}.0;
        float gE = (texture2D(uMap, uv + vec2(ex, 0.0)).r - texture2D(uMap, uv - vec2(ex, 0.0)).r) / (2.0 * ex * 6.2831853 * max(0.12, cos(lat)));
        float gN = (texture2D(uMap, uv + vec2(0.0, ey)).r - texture2D(uMap, uv - vec2(0.0, ey)).r) / (2.0 * ey * 3.14159265);
        float fine = fbm3(m * 22.0 + uSeed), grit = noise3(m * 95.0 + uSeed);
        float h = t.r + (fine - 0.5) * 0.06 + (grit - 0.5) * 0.014, depth = uSea - h;
        float ground = max(uSea, uBase);                          // heights are judged from the sea, or on a dry world from its plains
        float el = max(0.0, h - ground);
        // Climate: warm at the equator, cold at the poles and on the heights; damp here, dry there. Both can
        // be pushed either way by hand (the map's third and fourth channels).
        float warm = 1.0 - abs(lat) / 1.35 + uTemp + t.b + (fine - 0.5) * 0.18;
        float damp = clamp(fbm3(m * 2.6 + uSeed + 11.0) * 1.3 - 0.15 + (t.a + uWet) * 0.7, 0.0, 1.0);
        float frost;
        bool wet = depth > 0.0 || t.g > 0.5;
        if (wet) {                                                // sea, lake or river
          col = mix(uShallow, uDeep, smoothstep(0.0, 0.3, depth));
          col = mix(col, vec3(0.05, 0.32, 0.22), uSeaLife * 0.3 * smoothstep(0.3, 0.0, depth));   // living shallows
          col = mix(col, vec3(0.6, 0.72, 0.78), smoothstep(0.014, 0.0, depth) * step(0.0, depth) * 0.4);   // surf along the shore
          spec = pow(max(0.0, dot(m, normalize(Lp + uRot * vec3(0.0, 0.0, 1.0)))), 220.0) * 0.45;
          float cold = smoothstep(0.22, -0.06, warm);             // open water, then drifting icebergs, then solid pack ice
          frost = smoothstep(0.7 - cold * 0.75, 0.74 - cold * 0.75, noise3(m * 48.0 + uSeed) * 0.6 + grit * 0.4) * step(0.001, cold);
        } else {
          float air = warm - el * 0.9;                            // colder the higher you climb
          col = mix(uSand, uLow, smoothstep(0.28, 0.5, damp));    // dry sand, bare earth, dark damp ground (nothing grows here yet)
          col = mix(col, uForest, smoothstep(0.6, 0.85, damp));
          col = mix(col, vec3(0.3, 0.28, 0.22), smoothstep(0.3, 0.05, air) * uLife);      // tundra
          col = mix(col, vec3(0.33, 0.17, 0.1), smoothstep(1.45, 1.9, air) * 0.7);        // scorched ground, too close to the star
          if (uSea > uBase) col = mix(col, vec3(0.55, 0.47, 0.3), smoothstep(0.03, 0.0, el) * 0.8);   // beaches
          col = mix(col, uHigh, smoothstep(0.16, 0.45, el + (fine - 0.5) * 0.1));          // bare rock on the heights
          // Life, where it has taken hold: green wherever the land is mild and watered, and then the towns.
          float suit = smoothstep(0.02, 0.2, air) * (1.0 - smoothstep(1.3, 1.7, air)) * smoothstep(-0.1, 0.25, damp) * (1.0 - smoothstep(0.2, 0.45, el));
          float veg = smoothstep(1.0 - uGreen * 1.15, 1.12 - uGreen * 1.15, suit * 0.75 + fine * 0.3) * step(0.001, uGreen);
          col = mix(col, mix(vec3(0.17, 0.3, 0.07), vec3(0.03, 0.13, 0.04), smoothstep(0.4, 0.9, damp)), veg * 0.9);
          float town = smoothstep(1.0 - uCiv * 0.7, 1.06 - uCiv * 0.7, suit * 0.6 + fbm3(m * 7.0 + uSeed + 5.0) * 0.5) * step(0.001, uCiv);
          col = mix(col, vec3(0.42, 0.4, 0.37), town * 0.3 * step(0.55, grit));
          lights = step(0.8, noise3(m * 150.0 + uSeed)) * town;
          col *= 0.82 + 0.3 * fine + 0.14 * (grit - 0.5);
          vec3 east = normalize(vec3(m.z, 0.0, -m.x) + 1e-5), north = cross(m, east);
          N = normalize(m - 0.1 * (east * gE + north * gN));     // slopes catch the light
          frost = smoothstep(0.02, -0.07, air + (grit - 0.5) * 0.1);
          lights *= 1.0 - frost;
        }
        col = mix(col, uPeak, frost); spec *= 1.0 - frost;
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
      col = col * (0.07 + 0.93 * pow(max(0.0, dot(N, Lp)), 0.8) * day) + spec * day + uCivCol * lights * (1.0 - day) * 0.9;
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
    u.uLow.value.copy(c[1]); u.uForest.value.copy(c[1]).multiplyScalar(0.55); u.uHigh.value.copy(ROCK_HIGH); u.uPeak.value.copy(WHITE); u.uAtm.value.copy(SKY);
    u.uTemp.value = baseTemp(p); u.uLife.value = 1; u.uCloud.value = 0.6; u.uBase.value = SEA_MIN;
  } else if (kind === 'rock') { // dry to begin with, but it will hold water if you give it some
    u.uDeep.value.copy(SEA_DEEP); u.uShallow.value.copy(SEA_SHALLOW); u.uSand.value.copy(c[0]).lerp(c[2], 0.3);
    u.uLow.value.copy(c[0]); u.uForest.value.copy(c[0]).multiplyScalar(0.7); u.uHigh.value.copy(c[1]); u.uPeak.value.copy(c[2]).lerp(WHITE, 0.6); u.uAtm.value.copy(c[2]).multiplyScalar(0.25);
    u.uTemp.value = baseTemp(p); u.uLife.value = 0; u.uCloud.value = 0; u.uBase.value = -0.2;
  } else {
    u.uLow.value.copy(c[0]); u.uHigh.value.copy(c[1]); u.uPeak.value.copy(c[2]); u.uAtm.value.copy(c[1]).multiplyScalar(0.6);
    u.uBands.value = kind === 'ice' ? 5 + (p.seed % 3) : 8 + (p.seed % 5); u.uCloud.value = 0; u.uWind.value = p.wind ?? 1;
    u.uSpots.value.forEach((v, i) => { const s = p.spots[i]; if (s) v.set(s[0], s[1], s[2], s[3]); else v.set(0, 0, 0, 0); });
  }
  const L = isSolid(p) ? p.life : null, ev = L && L.ev ? DISASTERS[L.ev.k] : null; // what lives here, and what the universe is doing to it
  u.uGreen.value = L ? L.g : 0; u.uSeaLife.value = L && L.s ? 1 : 0; u.uCiv.value = L ? L.c : 0; u.uWet.value = (ev ? ev[2] : 0) + seaWet(L ? L.w : null);
  faithColor(L ? L.f : 0, u.uCivCol.value);
  if (ev) u.uTemp.value += ev[1];
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
function touched(now) { globeBusy = now; terrainDirty = true; markDirty(); if (focusP && focusP.life) focusP.life.acted = 1; }
function dust(x, y, n, r, g, b) { for (let i = 0; i < n; i++) spawn(x + rnd(0.1), y + rnd(0.1), 0, rnd(0.8), rnd(0.8) + 0.3, 0, r, g, b, 0.3 + Math.random() * 0.5, 0.04 + Math.random() * 0.04); }

const _gc = new THREE.Vector3();
const dirOf = (lon, lat, out) => out.set(Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat));

// Pinch: held still it swells the land up into a dome; dragged it draws a craggy mountain range along the
// path. On a giant it winds up a storm instead.
function setMoon(m, q) { m.a = Math.atan2(q.y / MOON_SQ, q.x); m.d = clamp01((Math.hypot(q.x, q.y / MOON_SQ) / globeR - MOON_IN) / MOON_SPAN); }
// Out in the space beside the planet a pinch is about moons: held still it gathers light and makes one, rested
// on one that is there it locks on, and then the moon goes where the pinch goes until it is let go.
function moonPinch(hand, now) {
  const p = focusP, q = hand.pinchPt;
  if (hand.moon) {
    if (!p.moons.includes(hand.moon)) { hand.moon = null; return; }
    setMoon(hand.moon, q); hand.moon.heldAt = now; markDirty();
    return;
  }
  let best = null, bd = Infinity;
  for (const m of p.moons) { const d = Math.hypot(m.wx - q.x, m.wy - q.y); if (d < m.wr + 0.7 && d < bd) { best = m; bd = d; } }
  if (!hand.makeAt || hand.makeFor !== best || Math.hypot(q.x - hand.makeX, q.y - hand.makeY) > T.pinchDrift) { hand.makeAt = now; hand.makeX = q.x; hand.makeY = q.y; hand.makeFor = best; }
  if (best) {
    const k = (now - hand.makeAt) / T.lockHold;
    best.heldAt = now;
    if (k < 1) return lockRing(best.wx, best.wy, 0, best.wr * (2.1 - 0.7 * k * k), k, now);
    hand.moon = best;
    pickColor(0.9);
    for (let i = 0; i < 40; i++) { const a = i / 40 * TAU, R = best.wr * 1.4; spawn(best.wx + Math.cos(a) * R, best.wy + Math.sin(a) * R, 0, -Math.cos(a) * 0.4, -Math.sin(a) * 0.4, 0, cr * 2.4, cg * 2.4, cb * 2.4, 0.35, 0.06); }
    return;
  }
  const k = (now - hand.makeAt) / T.pinchHold;
  if (k < 1) return gatherLight(q, k, now);
  if (p.moons.length >= MOON_MAX) { note('This planet has all the moons it can hold. A supernova will clear one away.'); hand.makeAt = now; return; }
  const m = { d: 0, a: 0, seed: newSeed() };
  setMoon(m, q); m.heldAt = now; m.wx = q.x; m.wy = q.y; m.wr = globeR * 0.1;
  p.moons.push(m); hand.moon = m; markDirty(); if (isSolid(p)) chron(p, `A new moon, ${properName(m.seed)}, appears in the sky`);
  note(`${properName(m.seed)}, a moon of ${properName(p.seed)}`, 4);
}
function planetPinch(hand, now, dt) {
  const p = focusP, q = hand.pinchPt;
  if (p && level === 3 && E3 >= 0.9 && !zoomLock && (hand.moon || Math.hypot(q.x, q.y) > globeR * 1.03)) { hand.pv = null; return moonPinch(hand, now); }
  if (!p || now - hand.pinchAt < 0.15 || !globePoint(q.x, q.y)) { hand.pv = null; return; }
  touched(now);
  if (!isSolid(p)) {
    if (!hand.spot) { hand.spot = [at.lon, at.lat, 0.03, 0]; p.spots.push(hand.spot); if (p.spots.length > SPOT_MAX) p.spots.shift(); }
    hand.spot[2] = Math.min(0.42, hand.spot[2] + dt * 0.07);
    return dust(q.x, q.y, 1, 0.6, 0.4, 0.3);
  }
  dirOf(at.lon, at.lat, _gc);
  dust(q.x, q.y, 2, 0.5, 0.45, 0.4);
  if (!hand.pv) { hand.pv = _gc.clone(); return; }
  const ang = Math.acos(Math.min(1, hand.pv.dot(_gc)));
  if (ang > 0.5) { hand.pv.copy(_gc); return; } // the hand jumped (tracking slipped): start afresh rather than rule a line across the world
  if (ang < 0.012) return brush(at.lon, at.lat, 0.15, (k, d) => { const w = 1 - d * d; mapH[k] = clampH(mapH[k] + dt * 0.24 * w * w); });
  const steps = Math.min(40, Math.ceil(ang / 0.025)), amt = 0.085 * ang / steps / 0.025, seed = p.seed | 0;
  for (let n = 1; n <= steps; n++) {
    _gv.copy(hand.pv).lerp(_gc, n / steps).normalize();
    brush(Math.atan2(_gv.x, _gv.z), Math.asin(Math.max(-1, Math.min(1, _gv.y))), 0.075, (k, d) => {
      const i = k % MAP_W, j = (k / MAP_W) | 0, w = 1 - d * d;
      const crag = noise3(colSin[i] * rowCos[j] * 34, rowSin[j] * 34, colCos[i] * rowCos[j] * 34, seed);
      mapH[k] = clampH(mapH[k] + amt * w * w * (0.35 + 1.5 * crag));
    });
  }
  hand.pv.copy(_gc);
}
// Fist pressed on the ground: the land sinks under it, and fills with water if it goes below the sea.
// (A fist that was gathered out in space first is a meteor on its way, and is left alone.)
function planetDig(hand, now, dt) {
  const p = focusP;
  if (!p || !isSolid(p) || hand.charge >= T.minCharge || !globePoint(hand.pos.x, hand.pos.y)) return false;
  brush(at.lon, at.lat, 0.16, (k, d) => { const w = 1 - d * d; mapH[k] = clampH(mapH[k] - dt * 0.3 * w * w); });
  dust(hand.pos.x, hand.pos.y, 2, 0.4, 0.36, 0.32);
  touched(now); smite(p, dt * 0.03);
  return true;
}
// Two fingers rested on the land take you down to stand there. Moving them only moves where that will be.
function planetPeace(hand, now) {
  const p = focusP, tip = hand.tips[1];
  if (!p || !isSolid(p)) return;
  if (hand.lastSolid !== 'peace' || !hand.rest) hand.rest = { x: tip.x, y: tip.y, t: now };
  const r = hand.rest;
  if (Math.hypot(tip.x - r.x, tip.y - r.y) > 0.45 || !globePoint(tip.x, tip.y)) { r.x = tip.x; r.y = tip.y; r.t = now; return; }
  globeBusy = now;
  const k = (now - r.t) / T.landHold;
  pickColor(0.7);
  for (let i = 0; i < 3; i++) { const a = Math.random() * TAU, d = 0.5 * (1 - Math.min(1, k)) + 0.08; spawn(tip.x + Math.cos(a) * d, tip.y + Math.sin(a) * d, 0, 0, 0, 0, cr, cg, cb, 0.25, 0.05); } // a ring closing in
  if (k >= 1) { hand.rest = null; enterLand(at.lon, at.lat); }
}
// A pointing finger rested on one spot freezes it, or thaws it if it was frozen already. Which one is settled
// by what lies under the fingertip when the hold completes, and stays that way for as long as the finger rests.
function planetClimate(hand, now, dt) {
  const p = focusP, tip = hand.tips[1];
  if (!p || !isSolid(p) || !globePoint(tip.x, tip.y)) { hand.dwell = null; return false; }
  globeBusy = now;
  dirOf(at.lon, at.lat, _gc);
  const d = hand.dwell;
  if (!d || d.v.dot(_gc) < Math.cos(0.14)) { hand.dwell = { v: _gc.clone(), lon: at.lon, lat: at.lat, t: now, step: -1, melt: false }; return true; } // it moved: start again there
  pickColor(0.7);
  spawn(tip.x + rnd(0.25), tip.y + rnd(0.25), 0, 0, 0, 0, cr, cg, cb, 0.3, 0.03 + 0.05 * Math.min(1, (now - d.t) / T.climateHold)); // gathering
  if (now - d.t < T.climateHold) return true;
  const g = globeMat.uniforms, sea = seaOf(p), ground = Math.max(sea, g.uBase.value), temp = g.uTemp.value;
  // how warm a cell would be with no help from you: the air on land, the water at sea
  const bare = k => 1 - Math.abs((((k / MAP_W) | 0) + 0.5) / MAP_H - 0.5) * Math.PI / 1.35 + temp - Math.max(0, mapH[k] - ground) * 0.9;
  if (d.step < 0) {
    const j = Math.max(0, Math.min(MAP_H - 1, Math.floor((d.lat / Math.PI + 0.5) * MAP_H))), i = ((Math.floor((d.lon / TAU + 0.5) * MAP_W) % MAP_W) + MAP_W) % MAP_W, k = j * MAP_W + i;
    d.melt = bare(k) + mapT[k] < (mapH[k] < sea ? 0.08 : 0);
    d.step = 0; note(d.melt ? 'Thaw' : 'Ice', 2);
  }
  const rate = Math.min(1, dt * 5);
  brush(d.lon, d.lat, 0.4, (k, q) => {
    const w = 1 - q * q, f = w * w * rate, base = bare(k);
    if (d.melt) { const to = Math.max(0, 0.35 - base); if (mapT[k] < to) mapT[k] += (to - mapT[k]) * f; }  // only as warm as it takes to clear the ice
    else { const to = Math.min(0, -0.3 - base); if (mapT[k] > to) mapT[k] += (to - mapT[k]) * f; }
  });
  touched(now);
  return true;
}
// a supernova over the planet arrives as a meteor: the harder the fist was held, the bigger the crater
function skyImpact(p, pt) {
  let best = null, bd = Infinity;
  for (const m of p.moons) { const d = Math.hypot(m.wx - pt.x, m.wy - pt.y); if (d < m.wr + 0.9 && d < bd) { best = m; bd = d; } }
  if (best) {
    p.moons.splice(p.moons.indexOf(best), 1);
    for (let i = 0; i < 180; i++) { const a = Math.random() * TAU, v = 0.5 + Math.random() * 3.5, c = 0.25 + Math.random() * 0.3; spawn(best.wx, best.wy, 0, Math.cos(a) * v, Math.sin(a) * v, rnd(0.3), c, c * 0.92, c * 0.82, 0.8 + Math.random() * 1.6, 0.04 + Math.random() * 0.05); }
    note(`${properName(best.seed)}, a moon of ${properName(p.seed)}, destroyed`, 5);
    if (isSolid(p)) chron(p, `The moon ${properName(best.seed)} is destroyed${best.col ? ', and its colony with it' : ''}`);
    smite(p, best.col ? 0.3 : 0.12); markDirty();
    return;
  }
  if (!p.rings) return;
  const tilt = ((p.seed % 7) - 3) * 0.14, c = Math.cos(tilt), sn = Math.sin(tilt), outer = 1.35 + p.rings * 0.95;
  const rr = Math.hypot(c * pt.x + sn * pt.y, (-sn * pt.x + c * pt.y) / 0.3) / globeR;
  if (rr < 1.05 || rr > outer + 0.3) return;
  for (let i = 0; i < 320; i++) { // the rings fly apart
    const a = Math.random() * TAU, R = globeR * (1.24 + Math.random() * (outer - 1.24)), ex = Math.cos(a) * R, ey = Math.sin(a) * R * 0.3, v = 0.6 + Math.random() * 2.4, g = 0.3 + Math.random() * 0.3;
    spawn(c * ex - sn * ey, sn * ex + c * ey, 0, Math.cos(a) * v, Math.sin(a) * v * 0.5 + rnd(0.6), 0, g, g * 0.95, g * 0.85, 0.8 + Math.random() * 1.4, 0.035 + Math.random() * 0.04);
  }
  p.rings = 0; markDirty(); if (isSolid(p)) chron(p, 'The rings are scattered');
  note(`The rings of ${properName(p.seed)} are scattered`, 5);
}
function planetImpact(pt, power, now) {
  const p = focusP;
  if (!p || level !== 3 || E3 < 0.9 || zoomLock) return;
  if (!globePoint(pt.x, pt.y)) return skyImpact(p, pt);
  if (isSolid(p)) { stampCrater(mapH, at.lon, at.lat, 0.07 + 0.2 * power, 0.14 + 0.3 * power); chron(p, 'A meteor is thrown down by your hand'); if (p.life && p.life.s === 4) p.life.ruin = Math.min(1, p.life.ruin + 0.15 + 0.3 * power); smite(p, 0.15 + 0.3 * power); }
  else { p.spots.push([at.lon, at.lat, 0.05 + 0.12 * power, 1]); if (p.spots.length > SPOT_MAX) p.spots.shift(); }
  touched(now);
}
// two fingertips: spread them to raise the sea (or whip up a giant's winds), close them to drain it
function planetTips(mx, my, d, now) {
  const p = focusP;
  if (!p || E3 < 0.9 || zoomLock) return;
  if (!sculpt) { // where the fingertips come together says which: on the planet, its sea; out beside it, its rings
    if (Math.hypot(mx, my) <= globeR) sculpt = { tide: true, d };
    else if (d < T.nebulaTouch) sculpt = { tide: true, ring: true, d };
    else return;
  }
  if (sculpt.ring) { if (!p.rings && isSolid(p)) chron(p, 'Rings are drawn round the world'); p.rings = Math.max(0.12, clamp01((d - 0.6) / 5)); markDirty(); return; }
  planetTide(d, now);
}
function planetTide(d, now) {
  const p = focusP;
  if (!p || E3 < 0.9 || zoomLock) return;
  if (!sculpt) sculpt = { tide: true, d };
  const step = d - sculpt.d; sculpt.d = d;
  if (isSolid(p)) p.sea = THREE.MathUtils.clamp(seaOf(p) + step * 0.06, SEA_MIN, SEA_MAX);
  else p.wind = THREE.MathUtils.clamp((p.wind ?? 1) + step * 0.3, 0, 5);
  if (step) touched(now);
}
// An open hand on the planet takes hold of it. Kept steady, it holds the globe still for the other hand to
// work on; moved, it turns the globe with it, and a flick sets it spinning.
function planetHold(hand, now) {
  if (level !== 3 || E3 < 0.9 || Math.hypot(hand.pos.x, hand.pos.y) > globeR * 1.2) return false;
  const sp = hand.vel.length(), k = sp < 0.6 ? 0 : (sp - 0.6) / sp / globeR; // a hand is never perfectly still: ignore the tremble
  globeWx += (hand.vel.x * k - globeWx) * 0.4; globeWy += (hand.vel.y * k - globeWy) * 0.4;
  globeTouched = now;
  return true;
}

function updateGlobe(dt, now, px, py, radius, lx, ly) {
  const p = focusP, u = globeMat.uniforms;
  if (terrainOf !== p) { loadTerrain(p); globeQ.setFromAxisAngle(AXIS_X, 0.35); globeWx = globeWy = 0; }
  if (now - globeTouched > 0.1) { const k = Math.exp(-2.5 * dt); globeWx *= k; globeWy *= k; }
  globeQ.premultiply(_gq.setFromAxisAngle(AXIS_Y, globeWx * dt)).premultiply(_gq.setFromAxisAngle(AXIS_X, -globeWy * dt));
  if (now - globeBusy > 4 && now - globeTouched > 4) globeQ.multiply(_gq.setFromAxisAngle(AXIS_Y, dt * 0.04)); // idling: it turns on its own axis
  globeQ.normalize();
  syncMap(false);
  globeLook(p, u);
  u.uRot.value.setFromMatrix4(_gm.makeRotationFromQuaternion(_gq.copy(globeQ).invert()));
  u.uLight.value.set(lx * 0.75, ly * 0.75, 0.8).normalize();
  u.uSea.value = isSolid(p) ? seaOf(p) : 0; u.uTime.value = bodyTime; u.uAlpha.value = Math.min(1, E3 * 4);
  globe.visible = true; globe.position.set(px, py, 0); globe.scale.setScalar(radius * 5);
}

// ---------------------------------------------------------------- life
// You set the conditions; life takes it from there. Where a world has open water that is neither frozen nor
// boiling, microbes appear in its seas; given temperate, watered land they become plants, then animals, then
// people. The people judge you by what your hands do to their world. And the universe has plans of its own:
// meteors, ice ages, heat and drought arrive unasked, and it is for you to put right or not.
const STAGE_SECS = [50, 80, 110, 150]; // seconds each step takes on a perfectly hospitable world
const STAGE_SHORT = ['', 'Microbes', 'Plants', 'Animals', 'Civilization'];
const STAGE_NEWS = ['', 'Life has begun in the seas', 'Plants are spreading over the land', 'Animals now roam', 'A civilization has arisen'];
const DISASTERS = [['An ice age', -0.55, 0], ['A heat wave', 0.65, -0.3], ['A drought', 0.1, -0.7]]; // name, warmer or colder, wetter or drier
const lifeOf = p => p.life || (p.life = { s: 0, t: 0, g: 0, c: 0, f: 0, hs: 0, hl: 0, ev: null, stale: true, acted: 0,
  y: 0, hist: [], tier: 0, ruin: 0, temple: 0, mon: 0, sp: 0, out: 0, o: 0, gen: 0, fb: 0, dt: 0, wt: 0, help: 0, harm: 0 }); // its years and its chronicle; then what its people have built, how far they have gone, and what they remember of you
const mood = f => (f > 0.6 ? 'They worship you' : f > 0.2 ? 'They love you' : f < -0.6 ? 'They live in terror of you' : f < -0.2 ? 'They fear you' : 'They are unsure of you');
function faithColor(f, out) { return f >= 0 ? out.setRGB(1, 0.86 - 0.12 * f, 0.62 - 0.34 * f) : out.setRGB(1, 0.86 + 0.78 * f, 0.62 + 0.6 * f); } // lamplight: gold where you are loved, red where you are feared

// How welcoming a world is: for its seas (open water, not frozen, not boiling) and for its land (temperate and
// watered, with a sea somewhere to feed the rain). Read off its map, a sample every few cells.
function habitability(H, Tm, Mm, sea, p, dT, dM) {
  const rock = planetKind(p) === 'rock', temp = baseTemp(p) + dT, ground = Math.max(sea, rock ? -0.2 : SEA_MIN);
  let land = 0, good = 0, wet = 0, live = 0, all = 0;
  for (let j = 2; j < MAP_H; j += 4) for (let i = 2; i < MAP_W; i += 4) { all += rowCos[j]; if (H[j * MAP_W + i] < sea) wet += rowCos[j]; }
  const share = wet / all; dM += seaWet(share); wet = all = 0;
  for (let j = 2; j < MAP_H; j += 4) {
    const w = rowCos[j], lat = ((j + 0.5) / MAP_H - 0.5) * Math.PI;
    for (let i = 2; i < MAP_W; i += 4) {
      const k = j * MAP_W + i, h = H[k], warm = 1 - Math.abs(lat) / 1.35 + temp + Tm[k];
      all += w;
      if (h < sea) { wet += w; if (warm > 0.2 && warm < 1.9) live += w; continue; }
      const air = warm - (h - ground) * 0.9;
      land += w;
      good += w * clamp01((air - 0.02) / 0.25) * clamp01((1.7 - air) / 0.4) * clamp01(0.55 + (Mm[k] + dM) * 0.8);
    }
  }
  const W = wet / all, Ld = land / all;
  return { w: share, sea: wet ? live / wet * Math.min(1, W * 5) : 0, land: land ? good / land * Math.min(1, W * 6) * Math.min(1, Ld * 6) : 0 };
}
const sH = new Float32Array(MAP_N), sT = new Float32Array(MAP_N), sM = new Float32Array(MAP_N); // somewhere to unfold a world we are not looking at
function measureLife(p) {
  const L = lifeOf(p), ev = L.ev ? DISASTERS[L.ev.k] : null;
  let r;
  if (terrainOf === p) r = habitability(mapH, mapT, mapM, seaOf(p), p, ev ? ev[1] : 0, ev ? ev[2] : 0);
  else {
    const b = baseOf(p);
    sH.set(b.H); sT.fill(0); sM.fill(0);
    decodeMap(p, sH, null, sT, sM);
    r = habitability(sH, sT, sM, p.sea == null ? b.sea : p.sea, p, ev ? ev[1] : 0, ev ? ev[2] : 0);
  }
  L.hs = r.sea; L.hl = r.land; L.w = r.w; L.stale = false;
}
// "on the ocean world of a yellow star", or just "here"
const placeOf = (p, s) => (p === focusP && level >= 3 ? 'here' : `on ${properName(p.seed)}${s === focusS && level >= 2 ? '' : ', a world of ' + properName(s.seed)}`);
const lifeLabel = p => { const L = p.life; return !L || !isSolid(p) ? '' : (L.s === 4 ? ' · ' + mood(L.f) : L.s ? ' · ' + STAGE_SHORT[L.s] : '') + (L.ev ? ' · ' + DISASTERS[L.ev.k][0].replace(/^An? /, '') : ''); };
// they noticed that, and did not like it
function smite(p, amt, why) {
  const L = p && p.life;
  if (!L || L.s < 4) return;
  const F = folk(p);
  if (amt >= 0.05) L.harm++;
  amt *= F.has('devout') ? 1.3 : F.has('skeptical') ? 0.7 : 1; // the devout take it to heart; sceptics call it weather
  L.f = Math.max(-1, L.f - amt); L.c *= 1 - amt * (F.has('hardy') ? 0.15 : 0.3); markDirty();
  if (why) chron(p, why);
}

let lifeT = 0, nextDisaster = 100 + Math.random() * 80;
function updateLife(dt) {
  if (!entered || (lifeT += dt * T.lifeSpeed) < 1) return;
  const step = lifeT; lifeT = 0;
  let budget = 1; // unfolding a world we are not on is not free: one a tick is plenty
  const living = [];
  for (const g of galaxies) if (g.alive) for (const s of g.stars) for (const p of s.planets) {
    s.gal = g;
    if (!isSolid(p) || p.growing || p.isNew) continue;
    p.sun = s;
    const L = lifeOf(p), here = terrainOf === p, heat = orbitHeat(p), F = L.s === 4 ? folk(p) : null;
    if (!L.hist.length) L.hist.push([0, L.s ? 'The oldest records begin here' : `${properName(p.seed)} takes shape`]);
    if (F && !L.o) L.o = F.o; // a people from before records were kept
    L.y += step * YEAR; L.ruin = Math.max(0, L.ruin - step / 700); // the years pass, and the grass grows over what fell
    if (L.oh == null) L.oh = heat;
    const moved = !p.held && Math.abs(heat - L.oh) > 0.03 ? heat - L.oh : 0;
    if (moved) { L.oh = heat; note(`${properName(p.seed)} grows ${moved > 0 ? 'warmer' : 'colder'}`, 4); chron(p, `Its orbit shifts, and the world grows ${moved > 0 ? 'warmer' : 'colder'}`); }
    if (L.ev && (L.ev.left -= step) <= 0) { const was = DISASTERS[L.ev.k][0]; L.ev = null; L.stale = true; chron(p, `${was} ends`); if (L.s) note(`${was} is over ${placeOf(p, s)}`, 5); }
    if ((L.acted && here) || moved) { // your hand has been at work here: is the world better for it, or worse?
      const before = L.hl;
      measureLife(p); L.acted = 0;
      if (F) { // the devout make much of it either way; sceptics shrug
        const d = (L.hl - before) * (moved ? 5 : 10) * (F.has('devout') ? 1.4 : F.has('skeptical') ? 0.6 : 1);
        L.f = THREE.MathUtils.clamp(L.f + d, -1, 1);
        if (d > 0.03) L.help++; else if (d < -0.03) L.harm++;
      }
    } else if (L.stale) { if (!here && budget-- <= 0) continue; measureLife(p); }
    const h = L.s <= 1 ? L.hs : L.hl, up = L.s === 0 ? L.hs : L.hl; // the seas keep microbes going; anything more needs land
    if (h < 0.06) L.t -= step / (F && F.has('hardy') ? 45 : 25);
    else if (L.s < 4 && up >= 0.06) L.t += step * clamp01(up * 2.2) / STAGE_SECS[L.s];
    else if (L.t < 0) L.t = Math.min(0, L.t + step / 25);
    if (L.t >= 1) {
      L.s++; L.t = 0; say(p, s, STAGE_NEWS[L.s]);
      if (L.s === 4) { L.o = (p.seed + L.gen * 7919) | 0 || 1; L.tier = 0; L.sp = 0; p._folk = null; const N = folk(p); chron(p, `They call themselves the ${N.name}, and are ${N.traitText}`); }
    }
    else if (L.t < 0) {
      if (L.s > 0 && L.t > -1) { /* hard times, but they hang on a while yet */ }
      else if (L.s > 0) { if (L.s === 4) fallOf(p, L); L.s--; L.t = 0.5; say(p, s, L.s ? 'Life is dying back' : 'Life has died out'); }
      else L.t = 0;
    }
    const gTo = L.s >= 2 ? clamp01(L.hl * 1.6) : 0, cTo = L.s === 4 ? clamp01(L.hl * 1.5) * (0.65 + 0.35 * L.f) : 0;
    L.g += THREE.MathUtils.clamp(gTo - L.g, -step / 40, step / 90);
    L.c += THREE.MathUtils.clamp(cTo - L.c, -step / 30, step / (F && F.has('industrious') ? 75 : 120));
    if (L.s === 4 && F) { L.f *= 1 - step / (F.has('devout') ? 2400 : F.has('skeptical') ? 700 : 1200); updateFolk(p, s, L, F, step); } // the generations slowly forget
    else if (L.s < 4) L.f = 0;
    if (L.s) living.push([p, s]);
  }
  if ((nextDisaster -= step) <= 0 && living.length && settings.disasters) {
    nextDisaster = 90 + Math.random() * 120;
    const [p, s] = living[(Math.random() * living.length) | 0], L = p.life;
    if (Math.random() < 0.35) { // a meteor nobody threw
      const c = [(Math.random() - 0.5) * TAU, Math.asin(Math.random() * 2 - 1), 0.09 + Math.random() * 0.1, 0.25 + Math.random() * 0.2];
      if (terrainOf === p) { stampCrater(mapH, c[0], c[1], c[2], c[3]); terrainDirty = true; } else p.scars.push(c);
      L.t -= 0.3; L.g *= 0.8; L.c *= 0.6; L.stale = true; if (L.s === 4) L.ruin = Math.min(1, L.ruin + 0.25);
      say(p, s, 'A meteor has fallen');
    } else if (!L.ev) {
      L.ev = { k: (Math.random() * DISASTERS.length) | 0, left: 150 }; L.stale = true;
      say(p, s, `${DISASTERS[L.ev.k][0]} has begun`);
    }
    markDirty();
  }
  const t = whereText();
  if (whereEl.textContent !== t) whereEl.textContent = t;
  if (!chronEl.hidden) renderChron(histDirty);
}
function whereText() {
  const gal = focusG ? titleOf(focusG) : 'Galaxy';
  return level === 0 ? 'Universe' : level === 1 ? `Universe › ${gal}`
    : `Universe › ${gal} › ${focusS ? titleOf(focusS) : 'Star'}${level >= 3 && focusP ? ' › ' + titleOf(focusP) + lifeLabel(focusP) : ''}${level === 4 && land ? ' › ' + land.name : ''}`;
}

// ---------------------------------------------------------------- the people, their record, and where they go
// Every world keeps a chronicle of what has happened to it. Once people arise they have a name and a character
// of their own, build camps into cities, raise temples or tear them down, and in time leave for other worlds.
const YEAR = 4; // years of a world's history to one second of ours, at the normal pace
const TRAITS = { devout: 'devout', skeptical: 'sceptical', curious: 'curious', warlike: 'warlike', industrious: 'industrious', hardy: 'hardy' };
const TRAIT_KEYS = Object.keys(TRAITS), TIERS = ['camps', 'villages', 'towns', 'cities'];
const tierOf = c => (c < 0.1 ? 0 : c < 0.32 ? 1 : c < 0.62 ? 2 : 3);
let histDirty = false;
// Who lives here: a name and two traits, read off the seed of the world their kind first arose on.
function folk(p) {
  const o = (p.life && p.life.o) || p.seed;
  if (p._folk && p._folk.o === o) return p._folk;
  const r = seeded((o ^ 0x2f6e2b1) | 0), base = properName((o ^ 0x5bd1e995) >>> 0), a = TRAIT_KEYS[(r() * 6) | 0];
  let b = a;
  while (b === a || (a === 'devout' && b === 'skeptical') || (a === 'skeptical' && b === 'devout')) b = TRAIT_KEYS[(r() * 6) | 0];
  const traits = [a, b];
  return (p._folk = { o, name: base + (/[aeiou]$/.test(base) ? 'ns' : 'i'), city: properName((o ^ 0x1b873593) >>> 0), traits, has: t => traits.includes(t), traitText: `${TRAITS[a]} and ${TRAITS[b]}` });
}
// write a line in a world's chronicle
function chron(p, text) {
  const L = lifeOf(p), h = L.hist, y = Math.round(L.y), last = h[h.length - 1];
  if (last && last[1] === text && y - last[0] < 60) return;
  h.push([y, text]);
  if (h.length > 60) h.splice(1, h.length - 60); // its beginning is kept; the oldest years after that are let go
  histDirty = true; markDirty();
}
// ...and tell you about it as well
function say(p, s, text, secs = 7) { chron(p, text); note(`${text} ${placeOf(p, s)}`, secs); }

function fallOf(p, L) {
  chron(p, `The civilization of the ${folk(p).name} falls`);
  L.ruin = Math.min(1, L.ruin + 0.3 + L.c); L.temple = L.mon = L.fb = L.sp = L.out = L.tier = L.help = L.harm = L.dt = L.o = 0; L.gen = (L.gen | 0) + 1;
  for (const m of p.moons) m.col = 0;
  p._folk = null;
}

// one tick in the life of a people
function updateFolk(p, s, L, F, step) {
  const nm = F.name, up = tierOf(L.c), dn = tierOf(L.c + 0.05), tier = up > L.tier ? up : dn < L.tier ? dn : L.tier;
  if (tier > L.tier) say(p, s, [`The ${nm} gather in their first villages`, `The villages of the ${nm} grow into towns`, `${F.city}, the first city of the ${nm}, is raised`][tier - 1]);
  else if (tier < L.tier) { say(p, s, [`The last villages of the ${nm} stand empty`, `The towns of the ${nm} shrink back to villages`, `The cities of the ${nm} are abandoned`][tier]); L.ruin = Math.min(1, L.ruin + 0.3); }
  L.tier = tier;
  // how they stand with you
  if (!L.temple && tier >= 1 && L.f > (F.has('devout') ? 0.3 : 0.5)) { L.temple = 1; say(p, s, `The ${nm} raise a temple to you`); }
  else if (L.temple && L.f < -0.15) { L.temple = 0; L.mon = 0; L.ruin = Math.min(1, L.ruin + 0.15); say(p, s, `The ${nm} tear down your temple`); }
  if (!L.mon && L.temple && tier >= 2 && Math.random() < step / (F.has('industrious') ? 90 : 180)) { L.mon = 1; say(p, s, `The ${nm} build a monument to their creator: a great stone hand`); }
  if (L.f > 0.6 && L.fb < 1) { L.fb = 1; say(p, s, `The ${nm} begin to worship you`); }
  else if (L.f < -0.6 && L.fb > -1) { L.fb = -1; say(p, s, `The ${nm} come to live in terror of you`); }
  else if (Math.abs(L.f) < 0.3) L.fb = 0;
  if (!L.dt && tier >= 2 && Math.abs(L.f) < 0.08 && Math.random() < step / (F.has('skeptical') ? 150 : 600)) { L.dt = 1; say(p, s, `Thinkers among the ${nm} begin to question whether you exist`); }
  if (L.ev && !L.ev.pr && p === focusP && level >= 3 && Math.random() < step / 20) { L.ev.pr = 1; note(`The ${nm} pray to you to end ${DISASTERS[L.ev.k][0].toLowerCase()}`, 6); }
  // and with each other
  L.wt = Math.max(0, (L.wt || 0) - step);
  if (tier >= 2 && !L.wt && Math.random() < step / (F.has('warlike') ? 260 : 1500) * (L.f > 0.6 ? 0.4 : 1)) {
    L.wt = 300; L.c *= 0.6; L.ruin = Math.min(1, L.ruin + 0.3);
    say(p, s, `The ${TIERS[tier]} of the ${nm} go to war with one another`);
  }
  // outward
  if (tier >= 3 && !L.out) {
    const next = Math.floor(L.sp) + 1;
    L.sp = Math.min(next, L.sp + step / 170 * (F.has('curious') ? 1.7 : 1));
    if (L.sp >= next) reach(p, s, L, F, next);
  }
}
// Each step outward is further than the last: into the sky, to a moon, to another world of the same star, to
// another star. After that they go on looking for the next world for as long as their cities stand.
function reach(p, s, L, F, n) {
  if (n === 1) return say(p, s, `The ${F.name} launch their first spacecraft`);
  if (n === 2) { const m = p.moons.find(q => !q.col); if (m) launch(p, s, m, 'moon', 14); return; }
  const open = q => q !== p && isSolid(q) && !q.growing && !q.isNew && lifeOf(q).s < 4 && !ships.some(sh => sh.to === q);
  let best = null;
  if (n === 3) { for (const q of s.planets) if (open(q) && (!best || q.life.hl > best.life.hl)) best = q; }
  else for (const s2 of s.gal.stars) if (s2 !== s) for (const q of s2.planets) { q.sun = s2; s2.gal = s.gal; if (open(q) && (!best || q.life.hl > best.life.hl)) best = q; }
  if (best) {
    launch(p, s, best, n === 3 ? 'planet' : 'star', n === 3 ? 26 : 55);
    say(p, s, n === 3 ? `A ship of the ${F.name} sets out for ${properName(best.seed)}` : `A starship of the ${F.name} leaves for ${properName(best.seed)}, a world of the star ${properName(best.sun.seed)}`);
  }
  if (n >= 4) L.sp = 1;
}

const ships = []; // those under way just now. They are not kept between visits: one lost that way is simply sent again.
function launch(p, s, to, kind, dur) { p.life.out = 1; ships.push({ p, s, to, kind, t: 0, dur, s2: kind === 'moon' ? s : to.sun }); }
function arrive(sh) {
  const { p, s, to, kind } = sh, L = p.life, nm = folk(p).name;
  L.out = 0;
  if (kind === 'moon') { to.col = 1; say(p, s, `The ${nm} found a colony on the moon ${properName(to.seed)}`, 8); return; }
  const Q = lifeOf(to), there = properName(to.seed), from = properName(p.seed);
  if (Q.s === 4) return; // someone else got there first
  if (Q.stale) measureLife(to);
  if (Q.hl < 0.06) { chron(to, `A ship of the ${nm} lands, finds the world too harsh, and leaves`); say(p, s, `The expedition to ${there} finds it too harsh to settle`); return; }
  Object.assign(Q, { s: 4, t: 0, c: 0.14, g: Math.max(Q.g, 0.3), f: L.f * 0.6, o: folk(p).o, tier: 1, sp: 0, temple: 0, mon: 0, fb: 0, help: 0, harm: 0, dt: 0 });
  to._folk = null;
  chron(to, `Settlers of the ${nm} arrive from ${from}${kind === 'star' ? `, a world of the star ${properName(s.seed)}` : ''}, and stay`);
  chron(p, `A colony is founded on ${there}${kind === 'star' ? `, a world of the star ${properName(sh.s2.seed)}` : ''}`);
  note(`A ship of the ${nm} from ${from} has landed on ${there}`, 9);
}
function updateShips(dt, now) {
  for (let i = ships.length - 1; i >= 0; i--) {
    const sh = ships[i], { p, s, to, s2 } = sh, L = p.life, g = s.gal;
    const lost = !L || L.s < 4 || !g || !g.alive || !g.stars.includes(s) || !s.planets.includes(p) || (sh.kind === 'moon' ? !p.moons.includes(to) : !g.stars.includes(s2) || !s2.planets.includes(to));
    if (lost) { if (L) L.out = 0; ships.splice(i, 1); continue; }
    sh.t += dt * T.lifeSpeed / sh.dur;
    const k = clamp01(sh.t), e = ease(k);
    let ax, ay, bx, by, f = e, show = false;
    if (s2 === s) { if (focusS === s && E2 > 0.5 && E4 < 0.5) { ax = p.wx; ay = p.wy; bx = to.wx; by = to.wy; show = true; } }
    else if (focusG === g && E1 > 0.5 && E4 < 0.5) {
      const far = Math.max(viewW, viewH) * 0.75;
      let dx = s2.u - s.u, dy = s2.v - s.v; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      if (E2 < 0.5) { ax = s.wx; ay = s.wy; bx = s2.wx; by = s2.wy; show = true; }
      else if (focusS === s && k < 0.3) { ax = p.wx; ay = p.wy; bx = ax + dx * far; by = ay + dy * far; f = k / 0.3; f *= f; show = true; }       // leaving
      else if (focusS === s2 && k > 0.7) { bx = to.wx; by = to.wy; ax = bx - dx * far; ay = by - dy * far; f = (k - 0.7) / 0.3; f = 1 - (1 - f) * (1 - f); show = true; } // arriving
    }
    if (show) {
      const lx = bx - ax, ly = by - ay, bow = Math.sin(f * Math.PI) * 0.1, x = ax + lx * f - ly * bow, y = ay + ly * f + lx * bow, z = 0.045 + 0.02 * E2;
      spawn(x, y, 0, 0, 0, 0, 2.6, 2.4, 1.9, 0.12, z * 1.5);
      for (let n = 0; n < 2; n++) spawn(x + rnd(0.02), y + rnd(0.02), 0, rnd(0.06), rnd(0.06), 0, 1.0, 0.75, 0.4, 0.5 + Math.random() * 0.5, z);
    }
    if (sh.t >= 1) { ships.splice(i, 1); arrive(sh); }
  }
  // close to a world that has taken to the sky: craft in orbit, and ferries out to any moon they have settled
  const p = focusP, L = p && p.life;
  if (p && L && L.s === 4 && L.sp >= 1 && level === 3 && E3 > 0.9 && E4 < 0.3) {
    for (let n = 0; n < Math.min(3, Math.floor(L.sp)); n++) {
      const a = now * (0.55 + n * 0.13) + n * 2.1, tl = 0.25 - n * 0.3, ex = Math.cos(a) * globeR * (1.16 + n * 0.07), ey = Math.sin(a) * globeR * 0.2;
      spawn(p.wx + ex * Math.cos(tl) - ey * Math.sin(tl), p.wy + ex * Math.sin(tl) + ey * Math.cos(tl), 0, 0, 0, 0, 1.8, 1.7, 1.4, 0.3, 0.04);
    }
    p.moons.forEach((m, n) => {
      if (!m.col) return;
      const ph = (now / 11 + n * 0.37) % 1, f = ph < 0.5 ? ph * 2 : 2 - ph * 2, dx = m.wx - p.wx, dy = m.wy - p.wy, d = Math.hypot(dx, dy) || 1, a0 = globeR * 1.03 / d;
      spawn(p.wx + dx * (a0 + (1 - a0) * f), p.wy + dy * (a0 + (1 - a0) * f), 0, 0, 0, 0, 1.6, 1.2, 0.7, 0.35, 0.035);
      spawn(m.wx + m.wr * 1.15, m.wy + m.wr * 0.2, 0, 0, 0, 0, 1.5, 1.1, 0.5, 0.2, 0.03); // the lamp of the colony
    });
  }
}

// ---------------------------------------------------------------- down on the surface
// Two fingers rested on a spot of a planet take you down inside its air, to stand in that place: its heights,
// its water, its cold and its damp are read off the planet's map there and painted as a landscape.
const WEATHER = [['Clear skies', 0.12, 0, 0], ['Clouds', 0.62, 0, 0], ['Storm', 1, 1, 0.2], ['Mist', 0.4, 0, 1]]; // name, cloud, rain, fog
const LAND_M = 1.25, LAND_H0 = 0.44; // the picture overfills the screen by this much; where its horizon sits
const LAND_TURN = 7.2; // in screen heights: a full turn on the spot is about four screens wide
const wrapTurn = x => x - LAND_TURN * Math.round(x / LAND_TURN);
const landMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uSeed: { value: 0 }, uAlpha: { value: 0 }, uAspect: { value: 1.7 }, uRelief: { value: 0.5 }, uWater: { value: 0 }, uCold: { value: 0 },
    uAirT: { value: 0.5 }, uDamp: { value: 0.5 }, uPan: { value: 0 }, uCloud: { value: 0.2 }, uRain: { value: 0 }, uFog: { value: 0 }, uFlash: { value: 0 }, uBoltX: { value: 0 },
    uVeg: { value: 0 }, uCivL: { value: 0 }, uCivCol: col3(1, 0.8, 0.5), uRing: { value: 0 }, uMoons: { value: 0 }, uAir: { value: 1 }, uSnowing: { value: 0 }, uSun: { value: new THREE.Vector2(0.4, 0.72) },
    uDeep: col3(0, 0, 0), uShallow: col3(0, 0, 0), uSand: col3(0, 0, 0), uLow: col3(0, 0, 0), uForest: col3(0, 0, 0), uHigh: col3(0, 0, 0), uPeak: col3(1, 1, 1), uAtm: col3(0, 0, 0) },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform float uTime, uSeed, uAlpha, uAspect, uRelief, uWater, uCold, uAirT, uDamp, uPan, uCloud, uRain, uFog, uFlash, uBoltX, uRing, uMoons, uAir, uSnowing, uVeg, uCivL;
    uniform vec2 uSun;
    uniform vec3 uDeep, uShallow, uSand, uLow, uForest, uHigh, uPeak, uAtm, uCivCol;
    ${NOISE_GLSL}
    const float H0 = ${LAND_H0}, TURN = ${LAND_TURN.toFixed(2)};      // TURN: how far the picture slides in one full turn on the spot
    float gDay, gDusk, gSh, gHot; vec3 gTint, gLight, gHz;
    float wrapT(float x){ return x - TURN * floor(x / TURN + 0.5); }

    // the skyline of one range of hills: rolling where the land is gentle, sharp where it is mountainous
    float crags(vec2 p){ float v = 0.0, a = 0.55; for (int i = 0; i < 4; i++) { float n = 1.0 - abs(2.0 * noise(p) - 1.0); v += a * n * n; p = p * 2.1 + 13.0; a *= 0.5; } return v; }
    float ridge(float x, float i, float fq){                     // x is a bearing: the skyline is read round a circle, so it meets itself
      float th = x * 6.2831853 / TURN, R = TURN * fq / 6.2831853;
      vec2 q = vec2(cos(th), sin(th)) * R + vec2(i * 17.3 + uSeed, i * 7.31);
      float a = fbm(q);
      return mix(a, a * 0.3 + crags(q * 0.8 + 31.7) * 0.75, uRelief);
    }
    // one range, nearer as i grows: rgb and whether this pixel is inside it
    vec4 range(vec2 p, float i){
      float f = i / 5.0, fq = mix(2.4, 1.0, f);
      float base = H0 - f * f * 0.34 - 0.004;
      float amp = (uRelief * mix(0.42, 0.2, f) + 0.075 * (1.0 - smoothstep(0.85, 1.0, uWater))) * (1.0 - 0.45 * f * (1.0 - uRelief));
      float wx = p.x + uPan, px = wx * fq + i * 7.31;
      float r0 = ridge(wx, i, fq), below = base + amp * r0 - p.y;
      below += uVeg * 0.012 * noise(vec2(px * 140.0, i)) * step(0.35, noise(vec2(px * 9.0, i + 3.0)));   // treetops along the skyline
      if (below <= 0.0) return vec4(0.0);
      // Which flank is this? Look at the skyline a little way toward the sun: if it falls away, this side faces it.
      float sgn = clamp((uSun.x - p.x) * 3.0, -1.0, 1.0);
      float r1 = ridge(wx + sgn * (0.03 + below * 1.3), i, fq);
      float side = mix(0.5, smoothstep(-0.014, 0.014, (r0 - r1) * amp), abs(sgn));
      side = mix(side, 0.75, 0.5 * smoothstep(0.1, 0.45, gSh));    // a high sun lights both flanks
      float alt = (clamp((p.y - base) / max(amp, 1e-3), 0.0, 1.0) - 0.35) * uRelief * 0.7;   // above or below where you stand
      float n = fbm(vec2(px * 6.0, p.y * 30.0) + i * 3.0), n2 = fbm(vec2(px * 14.0 + below * 30.0 * sgn, below * 22.0) + i);
      float damp = uDamp + (n - 0.5) * 0.3;
      vec3 g = mix(uSand, uLow, smoothstep(0.28, 0.5, damp));
      g = mix(g, uForest, smoothstep(0.6, 0.85, damp));
      g = mix(g, uHigh, smoothstep(0.02, 0.22, alt + (n - 0.5) * 0.2));
      g = mix(g, mix(vec3(0.2, 0.34, 0.08), vec3(0.04, 0.15, 0.05), smoothstep(0.4, 0.9, damp)), (1.0 - smoothstep(0.08, 0.2, alt)) * smoothstep(0.5, 0.75, n * 0.5 + uVeg * 0.75));
      g = mix(g, uPeak, smoothstep(0.02, -0.05, uAirT - alt * 0.9 + (n2 - 0.5) * 0.14));
      g = mix(g, mix(vec3(0.07, 0.05, 0.05), vec3(0.34, 0.13, 0.06), n), gHot * 0.88);   // burnt black and rust
      g *= (0.38 + 0.8 * side) * (0.72 + 0.3 * n + 0.3 * n2);
      float hz = clamp((1.0 - f * 1.15) * 0.6 + uFog * 0.5 * (1.0 - f * 0.4), 0.0, 0.97);
      vec3 c = mix(g * gLight, gHz, hz);
      if (gHot > 0.0) {                                           // fire in the cracks of the ground
        float v = fbm(vec2(px * 9.0, below * 26.0 + i * 5.0));
        float crack = smoothstep(0.035, 0.0, abs(v - 0.5)) * smoothstep(0.3, 0.7, fbm(vec2(px * 2.0 + 9.0, below * 5.0 + i)));
        c += vec3(1.0, 0.32, 0.05) * crack * gHot * (0.55 + 0.25 * sin(uTime * 1.3 + v * 40.0)) * (1.0 - hz * 0.7) * (1.6 - gDay);
      }
      if (uCivL > 0.0 && i > 1.5) {                               // lamps in the windows of whoever lives here
        vec2 q = vec2(px * 120.0, below * 170.0), id = floor(q);
        float lit = step(1.0 - uCivL * 0.16, hash(id + i)) * smoothstep(0.3, 0.1, length(fract(q) - 0.5));
        lit *= smoothstep(0.012, 0.03, below) * smoothstep(0.11, 0.06, below) * step(0.55, noise(vec2(px * 2.2, i * 5.0)));
        c += uCivCol * lit * (1.0 - 0.97 * gDay) * 1.6;
      }
      return vec4(c, 1.0);
    }
    // the sky and everything standing against it
    vec3 world(vec2 p){
      float up = clamp((p.y - H0) / (1.0 - H0), 0.0, 1.0);
      vec3 hor = mix(mix(uAtm, vec3(1.0), 0.45), vec3(1.0, 0.62, 0.3), gHot * 0.8);
      vec3 sky = mix(hor, mix(uAtm * 0.55, vec3(0.5, 0.2, 0.08), gHot * 0.8), pow(up, 0.55)) * (0.03 + 0.97 * gDay) + vec3(0.008, 0.012, 0.03) + vec3(0.1, 0.03, 0.0) * gHot * exp(-up * 5.0);
      float ds = length(p - uSun);
      sky += vec3(1.0, 0.4, 0.12) * gDusk * exp(-up * 3.5) * (0.35 + 0.65 * exp(-abs(p.x - uSun.x) * 1.2));
      float nightVis = 1.0 - gDay * uAir;                         // where the air is thin the stars never quite go out
      vec2 sg = vec2(p.x + uPan, p.y) * 90.0; float sr = hash(floor(sg) + uSeed);
      sky += step(0.992, sr) * smoothstep(0.35, 0.0, length(fract(sg) - 0.5)) * (0.6 + 0.4 * sin(uTime * 2.0 + sr * 90.0)) * nightVis * 0.9 * (1.0 - uCloud * 0.85);
      if (uRing > 0.0) {                                          // the planet's own rings, arching overhead
        float c = 0.93 - 0.3 * (p.x - 0.2) * (p.x - 0.2), t = (p.y - c) / (0.02 + 0.045 * uRing);
        sky += vec3(0.8, 0.75, 0.65) * smoothstep(1.0, 0.8, abs(t)) * (0.55 + 0.45 * sin(t * 14.0 + uSeed)) * 0.3 * (0.35 + 0.65 * nightVis);
      }
      for (int i = 0; i < 4; i++) {                               // and its moons
        float fi = float(i);
        if (fi >= uMoons) break;
        vec2 mp = vec2(-0.6 + 0.42 * fi + 0.1 * sin(uSeed + fi * 2.0), 0.8 + 0.07 * sin(uSeed * 1.7 + fi * 4.1));
        mp.x = p.x - wrapT(p.x + uPan - mp.x);                   // where that bearing is on the screen just now
        float mr = 0.02 + 0.014 * hash(vec2(fi, uSeed)), dm = length(p - mp);
        float lit = clamp(0.5 + dot((p - mp) / mr, normalize(uSun - mp)) * 0.9, 0.0, 1.0);
        sky = mix(sky, vec3(0.85, 0.84, 0.8) * (0.12 + 0.88 * lit) * (0.4 + 0.6 * nightVis) + sky * 0.6 * (1.0 - nightVis), smoothstep(mr, mr - 0.004, dm));
      }
      float sz = 1.0 + 1.6 * gHot;                                // the star fills more of the sky from in here
      sky += gTint * (smoothstep(0.034 * sz, 0.028 * sz, ds) * 3.0 + exp(-ds * 9.0 / sz) * 0.45 + exp(-ds * 40.0 / sz) * 0.8);
      float t = 1.0 / (up * 1.6 + 0.12);                          // clouds: a flat ceiling running away to the horizon
      vec2 cuv = vec2((p.x + uPan) * t * 0.9 + uTime * 0.02, t * 1.3) + uSeed;
      float cl = smoothstep(0.72 - uCloud * 0.4, 0.85 - uCloud * 0.4, fbm(cuv)) * smoothstep(0.0, 0.06, up);
      vec3 cc = vec3(0.9, 0.92, 0.96) * (0.06 + 0.94 * gDay);
      cc = mix(cc, gTint * (0.15 + 0.9 * gDay) + vec3(1.0, 0.45, 0.2) * gDusk * 0.8, 0.4 + 0.4 * exp(-ds * 2.5));
      cc *= 1.0 - 0.6 * uRain - 0.25 * fbm(cuv * 2.3);
      cc += uFlash * vec3(0.8, 0.85, 1.0) * (0.3 + 0.7 * fbm(cuv * 2.0));
      vec3 col = mix(sky, cc, cl * 0.92);
      for (int i = 0; i < 5; i++) { vec4 r = range(p, float(i)); col = mix(col, r.rgb, r.a); }
      return col;
    }
    void main(){
      vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y);
      gSh = uSun.y - H0; gHot = smoothstep(1.45, 1.85, uAirT);
      p.x += sin(p.y * 150.0 + uTime * 7.0) * 0.0016 * gHot * smoothstep(0.25, 0.0, abs(p.y - H0));   // heat shimmer over the ground
      gDay = smoothstep(-0.14, 0.08, gSh);
      gDusk = smoothstep(0.3, 0.0, gSh) * smoothstep(-0.22, -0.02, gSh);
      gTint = mix(vec3(1.0, 0.42, 0.16), vec3(1.0, 0.95, 0.86), smoothstep(-0.02, 0.3, gSh));
      gLight = gTint * (0.05 + 0.95 * gDay) * (1.0 - 0.45 * uRain) + vec3(0.02, 0.03, 0.07);
      gHz = mix(uAtm, vec3(1.0), 0.45) * (0.03 + 0.97 * gDay) + vec3(1.0, 0.4, 0.12) * gDusk * 0.45 + vec3(0.008, 0.012, 0.03);
      gHz = mix(gHz, vec3(0.9, 0.5, 0.25) * (0.1 + 0.9 * gDay), gHot * 0.7);
      gHz = mix(gHz, vec3(0.6, 0.63, 0.68) * (0.06 + 0.94 * gDay), max(uFog, uRain * 0.5));
      vec3 col = world(p);
      float yW = uWater > 0.0 ? H0 - 0.012 - (1.0 - smoothstep(0.3, 1.0, uWater)) * 0.2 : -1.0;
      if (p.y < yW) {                                             // water: it mirrors the world above, broken by ripples
        float d = yW - p.y, pers = min(40.0, 1.0 / (d + 0.015));
        float w = noise(vec2((p.x + uPan) * pers * 1.5, pers * 2.0 + uTime * 0.6)) - 0.5;
        vec3 refl = world(vec2(p.x + w * 0.02 * (0.3 + d * 4.0), 2.0 * yW - p.y + w * 0.012));
        vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 0.25, d)) * (0.06 + 0.94 * gDay);
        vec3 wc = mix(body, refl, 0.35 + 0.5 * exp(-d * 6.0));
        float gl = pow(max(0.0, 1.0 - abs(p.x - uSun.x) / (0.05 + d * 0.5)), 2.0) * step(0.55, noise(vec2(p.x * pers * 6.0, pers * 8.0 + uTime * 2.0)));
        wc += gTint * gl * 0.7 * gDay * smoothstep(-0.02, 0.05, gSh) * (1.0 - uCloud * 0.7);
        if (uCold > 0.0) {                                        // drifting ice, thickening to a solid pack
          vec2 iuv = vec2((p.x + uPan) * pers * 0.5 + uSeed, pers * 0.9);
          float ic = noise(iuv) * 0.6 + noise(iuv * 3.1) * 0.4;
          wc = mix(wc, uPeak * gLight * (0.8 + 0.2 * noise(iuv * 9.0)), smoothstep(0.72 - uCold * 0.7, 0.76 - uCold * 0.7, ic));
        }
        col = mix(wc, gHz, exp(-d * 25.0) * 0.6);
      }
      if (uWater < 0.9) { vec4 r = range(p, 5.0); col = mix(col, r.rgb, r.a); }   // the ground you stand on
      // weather falling through the picture
      float rr = noise(vec2((p.x + p.y * 0.18) * 300.0, p.y * 3.5 + uTime * 12.0));
      col = mix(col, vec3(0.7, 0.75, 0.8) * (0.1 + 0.9 * gDay), smoothstep(0.74, 0.95, rr) * uRain * 0.28 * (1.0 - uSnowing));
      for (int k = 0; k < 3; k++) {
        float fk = float(k), s = 14.0 + fk * 9.0;
        vec2 g = vec2(p.x * s + sin(uTime * 0.5 + fk * 2.0 + p.y * 3.0) * 0.4, p.y * s + uTime * (1.2 + fk * 0.6));
        vec2 id = floor(g);
        vec2 o = vec2(hash(id + fk), hash(id + 7.0 + fk)) * 0.6 + 0.2;
        col += smoothstep(0.1, 0.03, length(fract(g) - o)) * step(0.45, hash(id + 3.0)) * uRain * uSnowing * (0.25 + 0.75 * gDay) * 0.8;
      }
      float bx = uBoltX + (noise(vec2(p.y * 14.0, uSeed + uBoltX * 9.0)) - 0.5) * 0.14;
      col += vec3(0.8, 0.85, 1.0) * (smoothstep(0.007, 0.0, abs(p.x - bx)) * step(H0 - 0.08, p.y) * step(p.y, 0.86) * 2.5 + 0.12) * uFlash;
      col = mix(col, gHz, uFog * 0.35);
      col *= 0.72;                                                // leave the bloom something to do, not everything
      gl_FragColor = vec4(col * uAlpha, uAlpha);
    }`,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  depthWrite: false, depthTest: false, transparent: true,
});
const landMesh = new THREE.Mesh(QUAD, landMat);
landMesh.frustumCulled = false; landMesh.visible = false; landMesh.renderOrder = 2.8;
scene.add(landMesh);

function enterLand(lon, lat) {
  const p = focusP;
  if (!p || !isSolid(p) || level !== 3) return;
  const g = globeMat.uniforms, u = landMat.uniforms, sea = seaOf(p), ground = Math.max(sea, g.uBase.value);
  const idx = (lo, la) => (Math.max(0, Math.min(MAP_H - 1, Math.floor((la / Math.PI + 0.5) * MAP_H))) * MAP_W) + (((Math.floor((lo / TAU + 0.5) * MAP_W) % MAP_W) + MAP_W) % MAP_W);
  const k = idx(lon, lat), h = mapH[k], under = h < sea;
  let hi = h, lo = h, wetN = 0, n = 0; // what stands around this place: how high it climbs, how much of it is water
  for (const rad of [0.05, 0.11, 0.18]) for (let a = 0; a < 8; a++) {
    const q = idx(lon + Math.cos(a * TAU / 8) * rad / Math.max(0.2, Math.cos(lat)), lat + Math.sin(a * TAU / 8) * rad);
    hi = Math.max(hi, mapH[q]); lo = Math.min(lo, mapH[q]); if (mapH[q] < sea || mapR[q] > 0.5) wetN++; n++;
  }
  const relief = clamp01((hi - Math.max(lo, ground)) / 0.4), wetFrac = wetN / n;
  const warm = 1 - Math.abs(lat) / 1.35 + g.uTemp.value + mapT[k], air = warm - Math.max(0, h - ground) * 0.9;
  dirOf(lon, lat, _gc);
  const dampBase = noise3(_gc.x * 2.6, _gc.y * 2.6, _gc.z * 2.6, p.seed | 0) * 1.3 - 0.15, damp = clamp01(dampBase + (mapM[k] + g.uWet.value) * 0.7);
  const L = p.life, suit = under ? 0 : clamp01((air - 0.02) / 0.2) * clamp01((1.7 - air) / 0.4) * clamp01((damp + 0.1) / 0.35), veg = L ? clamp01(L.g * 1.5) * suit : 0;
  const water = under ? 1 : mapR[k] > 0.5 ? 0.55 : wetFrac > 0.12 ? Math.min(0.8, 0.3 + 0.5 * wetFrac) : 0;
  const cold = clamp01((0.22 - warm) / 0.28);
  const name = under ? (cold > 0.6 ? 'Pack ice' : cold > 0 ? 'Icy sea' : 'Open sea') : air < 0.02 ? (relief > 0.5 ? 'Snowy peaks' : 'Snowfield')
    : relief > 0.5 ? 'Mountains' : veg > 0.45 ? (damp > 0.6 ? 'Forest' : 'Grassland') : water > 0 ? (mapR[k] > 0.5 ? 'Riverbank' : 'Shore') : damp < 0.3 ? 'Desert' : relief > 0.2 ? 'Hills' : 'Plains';
  const zone = (under ? warm : air) < 0.02 ? 'polar' : (under ? warm : air) < 0.3 ? 'subpolar' : (under ? warm : air) > 1.6 ? 'scorching' : under ? (warm > 1.05 ? 'tropical' : 'temperate')
    : damp < 0.3 ? 'arid' : air > 1.05 ? (damp > 0.6 ? 'tropical' : 'subtropical') : 'temperate';
  for (const c of ['uDeep', 'uShallow', 'uSand', 'uLow', 'uForest', 'uHigh', 'uPeak', 'uAtm']) u[c].value.copy(g[c].value);
  u.uSeed.value = ((p.seed % 100) + lon * 3.1 + lat * 7.7 + 50) % 100; u.uRelief.value = relief; u.uWater.value = water; u.uCold.value = water ? cold : 0;
  u.uAirT.value = air; u.uDamp.value = damp; u.uRing.value = p.rings; u.uMoons.value = p.moons.length; u.uAir.value = planetKind(p) === 'ocean' ? 1 : 0.8;
  u.uVeg.value = veg; u.uCivL.value = L ? L.c * suit : 0; faithColor(L ? L.f : 0, u.uCivCol.value);
  land = { name: `${name}, ${zone}`, air, weather: damp > 0.6 ? 1 : 0, sunX: 0.42, sunY: 0.74, pan: 0, panV: 0, panAt: -10, flash: 0,
    lon, lat, k, dampBase, under, chosen: false, since: 0, tick: 0, told: -1, sig: civSig(L) }; // where on the world this is, for the weather to work on
  populateLand(p, lon, lat); lifeAmounts(L, suit);
  u.uSun.value.set(land.sunX, land.sunY); u.uCloud.value = WEATHER[land.weather][1]; u.uRain.value = u.uFog.value = u.uFlash.value = 0; u.uPan.value = 0;
  for (const hd of [hands.Left, hands.Right]) { hd.release(); hd.dwell = null; hd.rest = null; hd.charge = 0; }
  setLevel(4); warp(1);
  syncBar();
  note(`${name}. The climate here is ${zone}. Your hands can rest: drag with the mouse to look around.`, 7);
}

// Down here the hands rest: the ground is worked with the mouse and the keyboard.
function setWeather(i) {
  if (level !== 4 || !land) return;
  land.weather = i; land.chosen = true; land.since = 0; syncBar();
  note(i === 2 && land.air < 0.08 ? 'Snowstorm' : WEATHER[i][0], 2);
}
function bolt(x) {
  if (level !== 4 || !land) return;
  land.flash = 1; landMat.uniforms.uBoltX.value = x;
  const p = focusP;
  if (p && p.life && p.life.s === 4) { smite(p, 0.08, `Lightning strikes at your command, and the ${folk(p).name} cower`); note('They cower from your lightning', 3); }
}
function syncBar() { if (land) document.querySelectorAll('#landBar [data-w]').forEach(b => b.classList.toggle('sel', +b.dataset.w === land.weather)); }
const civSig = L => (!L ? '' : (L.s === 4 ? `${L.tier}${L.temple}${L.mon}${L.sp >= 1 ? 1 : 0}` : 'x') + Math.round(L.ruin * 7));

// The weather you call is real. A storm waters the country around where you stand, a little more for every
// moment it rains; clear skies that you chose yourself slowly bake it dry. Cloud and mist leave it be.
function landWeather(dt, now) {
  const p = focusP, u = landMat.uniforms;
  if (!p || terrainOf !== p || level !== 4) return;
  land.since += dt;
  if ((land.tick += dt) < 0.5) return;
  const step = land.tick; land.tick = 0;
  const rain = land.weather === 2 && u.uRain.value > 0.5, dry = land.weather === 0 && land.chosen && land.since > 6;
  if (rain || dry) {
    const to = rain ? 1 : -1, rate = step * (rain ? 0.11 : 0.05);
    brush(land.lon, land.lat, 0.32, (k, q) => { const w = 1 - q * q; mapM[k] += (to - mapM[k]) * Math.min(1, w * rate); });
    touched(now);
    const Lp = p.life;
    if (rain && Lp && Lp.s === 4 && Lp.ev && DISASTERS[Lp.ev.k][2] < 0 && !Lp.ev.ans) {
      Lp.ev.ans = 1; Lp.f = Math.min(1, Lp.f + 0.18); Lp.help++;
      chron(p, `You send rain in the midst of ${DISASTERS[Lp.ev.k][0].toLowerCase()}; the ${folk(p).name} give thanks`); note(`The ${folk(p).name} give thanks for the rain`, 5);
    }
    if (land.told !== land.weather) { land.told = land.weather; note(rain ? (land.air < 0.08 ? 'Snow is settling on the land' : 'Rain is soaking the land') : 'The land is drying out', 4); }
  }
  // and the view answers: the ground darkens and greens, or pales
  const L = p.life, damp = clamp01(land.dampBase + (mapM[land.k] + globeMat.uniforms.uWet.value) * 0.7), air = land.air;
  const suit = land.under ? 0 : clamp01((air - 0.02) / 0.2) * clamp01((1.7 - air) / 0.4) * clamp01((damp + 0.1) / 0.35), e = Math.min(1, step * 0.8);
  u.uDamp.value += (damp - u.uDamp.value) * e;
  u.uVeg.value += ((L ? clamp01(L.g * 1.5) * suit : 0) - u.uVeg.value) * e;
  u.uCivL.value += ((L ? L.c * suit : 0) - u.uCivL.value) * e;
  if (L) faithColor(L.f, u.uCivCol.value);
  if (civSig(L) !== land.sig) { land.sig = civSig(L); populateLand(p, land.lon, land.lat); } // something was built, or fell
  lifeAmounts(L, suit);
}

function updateLand(dt, now) {
  if (E4 <= 0 || !land) { landMesh.visible = lifeMesh.visible = false; if (level < 4 && E4 <= 0) land = null; return; }
  const u = landMat.uniforms, w = WEATHER[land.weather], k = Math.min(1, dt * 1.2);
  const key = (...ks) => (ks.some(q => landKeys.has(q)) ? 1 : 0), turn = key('ArrowRight', 'd') - key('ArrowLeft', 'a'), lift = key('ArrowUp') - key('ArrowDown');
  if (level === 4 && turn) { land.panV += (turn * 1.1 - land.panV) * Math.min(1, dt * 5); land.panAt = now; }
  if (level === 4 && lift) land.sunY = THREE.MathUtils.clamp(land.sunY + lift * dt * 0.3, 0.12, 0.95);
  if (now - land.panAt > 0.1) land.panV *= Math.exp(-2.5 * dt);
  if (!landDrag || landDrag.sun) land.pan += land.panV * dt;
  land.flash *= Math.exp(-5 * dt);
  landWeather(dt, now);
  u.uCloud.value += (w[1] - u.uCloud.value) * k; u.uRain.value += (w[2] - u.uRain.value) * k; u.uFog.value += (w[3] - u.uFog.value) * k;
  u.uSnowing.value = land.air < 0.08 ? 1 : 0;
  u.uSun.value.set(wrapTurn(land.sunX - land.pan), land.sunY); u.uPan.value = land.pan; u.uFlash.value = land.flash < 0.01 ? 0 : land.flash * (0.6 + 0.4 * Math.sin(now * 70));
  u.uTime.value = bodyTime; u.uAlpha.value = E4; u.uAspect.value = viewW / viewH;
  landMesh.visible = lifeMesh.visible = true; landMesh.scale.set(viewW * LAND_M, viewH * LAND_M, 1); lifeMat.uniforms.uS.value = viewH * LAND_M;
  if (E4 >= 0.999) globe.visible = false; // nothing of the globe shows through any more
}

// ---------------------------------------------------------------- the living things you can see from the ground
// Every world grows its own: its plants, its animals and its people are drawn once, from the planet's seed, as
// a sheet of little cartoon pictures, and then stood about the hills wherever the land will have them.
const ART_CELL = 128, ART_COLS = 8, ART_ROWS = 4, LIFE_MAX = 200;
const artCanvas = document.createElement('canvas');
artCanvas.width = ART_CELL * ART_COLS; artCanvas.height = ART_CELL * ART_ROWS;
const artCtx = artCanvas.getContext('2d'), artTex = new THREE.CanvasTexture(artCanvas);
let artSeed = null;
const seeded = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360},${Math.max(0, Math.min(100, s))}%,${Math.max(0, Math.min(100, l))}%)`;
const INK = 'rgba(24,16,38,0.82)';

// One picture is a stack of flat shapes. All of them are inked round first, then filled in order, so the
// whole figure gets a single clean outline however many pieces it is built from.
function sketch() {
  const items = [];
  const S = {
    add(path, fill, ink = true) { items.push({ path, fill, ink }); return S; },
    line(path, stroke, w = 2) { items.push({ path, stroke, w }); return S; },
    circ(x, y, r, fill, ink) { const p = new Path2D(); p.arc(x, y, Math.max(0.5, r), 0, TAU); return S.add(p, fill, ink); },
    ell(x, y, rx, ry, fill, ink, rot = 0) { const p = new Path2D(); p.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, TAU); return S.add(p, fill, ink); },
    poly(pts, fill, ink) { const p = new Path2D(); pts.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]))); p.closePath(); return S.add(p, fill, ink); },
    // a limb: a tapering band along a bent line
    limb(x0, y0, x1, y1, bend, w0, w1, fill, ink) {
      const mx = (x0 + x1) / 2 - (y1 - y0) * bend, my = (y0 + y1) / 2 + (x1 - x0) * bend, a = [], b = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8, u = 1 - t, x = u * u * x0 + 2 * u * t * mx + t * t * x1, y = u * u * y0 + 2 * u * t * my + t * t * y1;
        const dx = 2 * u * (mx - x0) + 2 * t * (x1 - mx), dy = 2 * u * (my - y0) + 2 * t * (y1 - my), l = Math.hypot(dx, dy) || 1, w = (w0 + (w1 - w0) * t) / 2;
        a.push([x - dy / l * w, y + dx / l * w]); b.unshift([x + dy / l * w, y - dx / l * w]);
      }
      return S.poly(a.concat(b), fill, ink);
    },
    // a leaf: a pointed lens from one point to another
    leaf(x0, y0, x1, y1, fat, fill, ink) {
      const nx = -(y1 - y0) * fat, ny = (x1 - x0) * fat, mx = (x0 + x1) / 2, my = (y0 + y1) / 2, p = new Path2D();
      p.moveTo(x0, y0); p.quadraticCurveTo(mx + nx, my + ny, x1, y1); p.quadraticCurveTo(mx - nx, my - ny, x0, y0); p.closePath();
      return S.add(p, fill, ink);
    },
    dome(x, y, rx, ry, fill, ink) { const p = new Path2D(); p.ellipse(x, y, rx, ry, 0, Math.PI, 0); p.closePath(); return S.add(p, fill, ink); },
    box(x, y, w, h, r, fill, ink) { const p = new Path2D(); p.moveTo(x + r, y); p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r); p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath(); return S.add(p, fill, ink); },
    draw(ctx, col, row, scale = 1) {
      ctx.save();
      ctx.translate((col + 0.5) * ART_CELL, (row + 1) * ART_CELL - 10); ctx.scale(scale, scale);
      ctx.lineJoin = ctx.lineCap = 'round'; ctx.strokeStyle = INK; ctx.lineWidth = 5 / scale;
      for (const it of items) if (it.ink) ctx.stroke(it.path);
      for (const it of items) {
        if (it.stroke) { ctx.strokeStyle = it.stroke; ctx.lineWidth = it.w; ctx.stroke(it.path); }
        else { ctx.fillStyle = it.fill; ctx.fill(it.path); }
      }
      ctx.restore();
    },
  };
  return S;
}

// --- plants: eight kinds of growth, of which a world has three, in colours of its own
const PLANTS = [
  (S, r, c) => { // a round-headed tree
    const h = 52 + r() * 34, tw = 4 + r() * 3.5;
    S.limb(0, 0, (r() - 0.5) * 8, -h * 0.72, (r() - 0.5) * 0.2, tw * 2, tw, c.trunk);
    const n = 3 + ((r() * 3) | 0), blobs = [];
    for (let k = 0; k < n; k++) blobs.push([(r() - 0.5) * 34, -h * 0.72 - r() * 24, 15 + r() * 9]);
    for (const b of blobs) S.circ(b[0], b[1], b[2], c.leaf);
    for (const b of blobs) S.circ(b[0] + b[2] * 0.12, b[1] + b[2] * 0.3, b[2] * 0.72, c.leafLo, false);
    for (const b of blobs) S.circ(b[0] - b[2] * 0.22, b[1] - b[2] * 0.25, b[2] * 0.62, c.leaf, false);
    for (const b of blobs) S.circ(b[0] - b[2] * 0.3, b[1] - b[2] * 0.36, b[2] * 0.3, c.leafHi, false);
    if (r() < 0.5) for (let k = 0; k < 5; k++) { const b = blobs[(r() * n) | 0]; S.circ(b[0] + (r() - 0.5) * b[2], b[1] + (r() - 0.3) * b[2] * 0.8, 2.6, c.accent, false); }
  },
  (S, r, c) => { // a tiered conifer
    const n = 3 + ((r() * 2) | 0), w0 = 22 + r() * 10, step = 17 + r() * 6;
    S.box(-3.5, -16, 7, 16, 2, c.trunk);
    for (let k = 0; k < n; k++) { const y = -10 - k * step, w = w0 * (1 - k / (n + 0.6)); S.poly([[-w, y], [w, y], [0, y - step * 1.75]], c.leaf); }
    for (let k = 0; k < n; k++) { const y = -10 - k * step, w = w0 * (1 - k / (n + 0.6)); S.poly([[0, y - 1], [w * 0.9, y - 1], [0, y - step * 1.6]], c.leafLo, false); S.poly([[-w * 0.55, y - 3], [-w * 0.15, y - 3], [-1, y - step * 1.2]], c.leafHi, false); }
  },
  (S, r, c) => { // a palm: a bent trunk and a spray of fronds
    const h = 60 + r() * 28, lean = (r() - 0.5) * 30, n = 5 + ((r() * 3) | 0);
    S.limb(0, 0, lean, -h, 0.12 * Math.sign(lean || 1), 9, 5, c.trunk);
    for (let k = 0; k < n; k++) { const a = -Math.PI * (0.08 + 0.84 * k / (n - 1)), l = 26 + r() * 10; S.leaf(lean, -h, lean + Math.cos(a) * l, -h + Math.sin(a) * l * 0.75 + 9, 0.26, k % 2 ? c.leaf : c.leafLo); }
    for (let k = 1; k < n; k += 2) { const a = -Math.PI * (0.08 + 0.84 * k / (n - 1)), l = 22; S.leaf(lean, -h, lean + Math.cos(a) * l, -h + Math.sin(a) * l * 0.75 + 7, 0.1, c.leafHi, false); }
    S.circ(lean - 3, -h + 2, 3.4, c.accent, false).circ(lean + 4, -h + 3, 3, c.accent, false);
  },
  (S, r, c) => { // a great mushroom
    const h = 36 + r() * 40, rw = 22 + r() * 16, rh = 14 + r() * 14;
    S.limb(0, 0, (r() - 0.5) * 6, -h, (r() - 0.5) * 0.15, 13, 8, c.pale);
    S.dome(0, -h + 3, rw, rh, c.accent);
    S.ell(0, -h + 3, rw * 0.9, 3.2, c.leafLo, false);
    for (let k = 0; k < 5; k++) { const a = Math.PI * (0.15 + 0.7 * r()), d = 0.35 + r() * 0.45; S.circ(-Math.cos(a) * rw * d, -h + 3 - Math.sin(a) * rh * d, 2 + r() * 3, c.pale, false); }
  },
  (S, r, c) => { // stalks with glowing lamps
    const n = 2 + ((r() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const x = (k - (n - 1) / 2) * 13 + (r() - 0.5) * 6, h = 34 + r() * 50, tx = x * 1.9 + (r() - 0.5) * 10;
      S.limb(x * 0.4, 0, tx, -h, 0.18 * Math.sign(x || 1), 5, 2.6, c.leaf);
      const R = 6 + r() * 5;
      S.circ(tx, -h, R, c.accent).circ(tx - R * 0.25, -h - R * 0.25, R * 0.5, c.pale, false);
    }
    S.leaf(0, 0, -16, -12, 0.3, c.leafLo).leaf(0, 0, 15, -10, 0.3, c.leafLo);
  },
  (S, r, c) => { // a fat cactus
    const h = 44 + r() * 34, w = 15 + r() * 6;
    for (const sd of [-1, 1]) if (r() < 0.8) { const y = -h * (0.3 + r() * 0.3), l = 12 + r() * 8, ah = 14 + r() * 14; S.box(sd > 0 ? w / 2 - 3 : -w / 2 - l + 3, y - 4, l, 9, 4, c.leaf).box(sd > 0 ? w / 2 + l - 12 : -w / 2 - l + 3, y - ah, 9, ah + 4, 4.5, c.leaf); }
    S.box(-w / 2, -h, w, h, w / 2, c.leaf).box(-w / 2 + 2.5, -h + 6, w * 0.3, h - 14, w * 0.15, c.leafHi, false).box(w / 2 - w * 0.32, -h + 8, w * 0.24, h - 14, w * 0.12, c.leafLo, false);
    S.circ((r() - 0.5) * 6, -h - 2, 4.5, c.accent);
  },
  (S, r, c) => { // a fan of broad leaves
    const n = 5 + ((r() * 3) | 0), l = 40 + r() * 30;
    for (let k = 0; k < n; k++) { const a = -Math.PI / 2 + (k / (n - 1) - 0.5) * 2.1, ll = l * (1 - 0.35 * Math.abs(k / (n - 1) - 0.5) * 2); S.leaf(0, 0, Math.cos(a) * ll, Math.sin(a) * ll, 0.24, k % 2 ? c.leaf : c.leafLo); }
    for (let k = 0; k < n; k++) { const a = -Math.PI / 2 + (k / (n - 1) - 0.5) * 2.1, ll = l * (1 - 0.35 * Math.abs(k / (n - 1) - 0.5) * 2) * 0.8; S.leaf(0, 0, Math.cos(a) * ll, Math.sin(a) * ll, 0.05, c.leafHi, false); }
    if (r() < 0.6) { S.limb(0, 0, 2, -l * 1.05, 0.05, 3, 2, c.leafLo).circ(2, -l * 1.05, 6, c.accent).circ(0.5, -l * 1.05 - 1.5, 2.6, c.pale, false); }
  },
  (S, r, c) => { // a low bush, in berry
    const n = 4 + ((r() * 3) | 0), blobs = [];
    for (let k = 0; k < n; k++) blobs.push([(k - (n - 1) / 2) * 12 + (r() - 0.5) * 6, -9 - r() * 12, 11 + r() * 6]);
    for (const b of blobs) S.circ(b[0], b[1], b[2], c.leaf);
    for (const b of blobs) S.circ(b[0] + 1.5, b[1] + 3.5, b[2] * 0.75, c.leafLo, false);
    for (const b of blobs) S.circ(b[0] - 2.5, b[1] - 3, b[2] * 0.55, c.leafHi, false);
    for (let k = 0; k < 7; k++) { const b = blobs[(r() * n) | 0]; S.circ(b[0] + (r() - 0.5) * b[2] * 1.3, b[1] + (r() - 0.5) * b[2], 2.4, c.accent, false); }
  },
];

function eyesOn(S, x, y, n, R, look) { // big cartoon eyes, looking the way it is going
  const at = n === 1 ? [[0, 0, 1.25]] : n === 2 ? [[-0.95, 0, 1], [0.95, 0, 1]] : [[-1.25, 0.25, 0.8], [1.25, 0.25, 0.8], [0, -0.9, 0.9]];
  for (const [ex, ey, k] of at) S.circ(x + ex * R, y + ey * R, R * k, '#fdfcf6');
  for (const [ex, ey, k] of at) S.circ(x + ex * R + look * R * k * 0.3, y + ey * R + R * k * 0.08, R * k * 0.52, '#1c1626', false).circ(x + ex * R + look * R * k * 0.3 - R * k * 0.18, y + ey * R - R * k * 0.14, R * k * 0.2, '#ffffff', false);
}
// --- animals: a body on legs with a head, in a hundred proportions. Drawn walking to the right.
function drawAnimal(S, r, sp) {
  const { bl, bh, ll, neck, hr } = sp, by = -(ll + bh * 0.85), m = sp.legs / 2;
  const legX = k => (m === 1 ? 0 : (k / (m - 1) - 0.5) * bl * 1.25);
  for (let k = 0; k < m; k++) S.limb(legX(k) + 4, by + bh * 0.3, legX(k) + 6, -1, 0.06, 6, 4.5, sp.dark);
  if (sp.top === 4) for (let k = 0; k < 5; k++) { const x = (k / 4 - 0.5) * bl * 1.4; S.poly([[x - 5, by - bh * 0.7], [x + 5, by - bh * 0.7], [x, by - bh - 9 - (2 - Math.abs(k - 2)) * 3]], sp.accent); }
  if (sp.tail === 1) S.limb(-bl * 0.85, by, -bl - 16, by - 12 - r() * 8, -0.3, 5, 2, sp.main);
  if (sp.tail === 2) { S.limb(-bl * 0.85, by, -bl - 12, by - 8, -0.2, 6, 4, sp.main); S.circ(-bl - 14, by - 10, 7.5, sp.accent); }
  if (sp.tail === 3) S.poly([[-bl * 0.8, by - bh * 0.5], [-bl - 18, by + 2], [-bl * 0.8, by + bh * 0.5]], sp.main);
  S.ell(0, by, bl, bh, sp.main);
  const hx = bl * 0.62 + neck * 0.45, hy = by - bh * 0.35 - neck;
  S.limb(bl * 0.5, by - bh * 0.1, hx, hy, -0.08, hr * 1.5, hr * 1.1, sp.main);
  for (let k = 0; k < m; k++) { S.limb(legX(k) - 3, by + bh * 0.4, legX(k) - 1, -1, 0.06, 6.5, 5, sp.main); S.ell(legX(k) + 1, -1.5, 5, 3, sp.dark); }
  if (sp.top === 1) S.leaf(hx - hr * 0.5, hy - hr * 0.6, hx - hr * 0.9, hy - hr * 1.9, 0.3, sp.main).leaf(hx + hr * 0.3, hy - hr * 0.7, hx + hr * 0.5, hy - hr * 2, 0.3, sp.main);
  if (sp.top === 2) S.limb(hx - hr * 0.4, hy - hr * 0.7, hx - hr * 1.1, hy - hr * 2.1, 0.25, 4.5, 1.5, sp.pale).limb(hx + hr * 0.3, hy - hr * 0.7, hx + hr * 1, hy - hr * 2.1, -0.25, 4.5, 1.5, sp.pale);
  if (sp.top === 3) { S.limb(hx - hr * 0.3, hy - hr * 0.7, hx - hr * 0.8, hy - hr * 2.2, 0.2, 2.4, 1.6, sp.dark).limb(hx + hr * 0.3, hy - hr * 0.7, hx + hr * 0.9, hy - hr * 2.2, -0.2, 2.4, 1.6, sp.dark); S.circ(hx - hr * 0.8, hy - hr * 2.2, 3.4, sp.accent).circ(hx + hr * 0.9, hy - hr * 2.2, 3.4, sp.accent); }
  S.ell(hx, hy, hr * 1.12, hr, sp.main);
  S.ell(0, by + bh * 0.32, bl * 0.72, bh * 0.52, sp.light, false);
  if (sp.spots) for (let k = 0; k < 6; k++) S.circ((r() - 0.5) * bl * 1.3, by - bh * (0.15 + r() * 0.5), 2 + r() * 2.8, sp.dark, false);
  else for (let k = 0; k < 3; k++) { const x = (k - 1) * bl * 0.45; S.leaf(x, by - bh * 0.93, x + 3, by - bh * 0.1, 0.22, sp.dark, false); }
  eyesOn(S, hx + hr * 0.3, hy - hr * 0.12, sp.eyes, hr * (sp.eyes === 1 ? 0.5 : 0.36), 1);
  const mouth = new Path2D(); mouth.arc(hx + hr * 0.55, hy + hr * 0.35, hr * 0.32, 0.25, 2.2); S.line(mouth, INK, 2);
}
// --- the people: upright, front on, and no two worlds' alike. Arms down, or raised to you.
function drawAlien(S, r, sp, up, tall) {
  const bw = sp.bw, bh = sp.bh * tall, lh = sp.skirt ? 0 : sp.lh, sy = -lh - bh + 6, hy = -lh - bh - sp.hh * 0.72;
  if (!sp.skirt) for (const sd of [-1, 1]) { S.limb(sd * bw * 0.45, -lh - 3, sd * bw * 0.5, -1, 0, 6.5, 5.5, sp.skinLo); S.ell(sd * bw * 0.5 + sd * 1.5, -1.5, 5.5, 3, sp.skinLo); }
  for (const sd of [-1, 1]) { // arms behind the body, hands in front of nothing
    const hx = sd * (bw + (up ? 10 : 7)), hyy = up ? sy - sp.arm * 0.95 : sy + sp.arm * 0.85;
    S.limb(sd * bw * 0.7, sy + 2, hx, hyy, sd * (up ? 0.22 : -0.12), 6, 4.5, sp.skin); S.circ(hx, hyy, 4.2, sp.skin);
  }
  if (sp.skirt) S.poly([[-bw * 0.75, sy - 4], [bw * 0.75, sy - 4], [bw * 1.25, 0], [-bw * 1.25, 0]], sp.robe);
  else S.ell(0, -lh - bh / 2, bw, bh / 2 + 2, sp.robe);
  S.box(-bw * 0.8, -lh - bh * 0.5, bw * 1.6, 5, 2, sp.accent, false);
  S.circ(0, -lh - bh * 0.5 + 2.5, 3.6, sp.pale, false);
  if (sp.ears) for (const sd of [-1, 1]) S.leaf(sd * sp.hw * 0.8, hy, sd * (sp.hw + 11), hy - 9, 0.3, sp.skin);
  for (let k = 0; k < sp.ant; k++) { const sd = sp.ant === 1 ? 0 : k ? 1 : -1, ax = sd * sp.hw * 0.45, tx = sd * sp.hw * 0.9, ty = hy - sp.hh - 12; S.limb(ax, hy - sp.hh * 0.8, tx, ty, sd * 0.2, 2.6, 1.8, sp.skinLo); S.circ(tx, ty, 3.6, sp.accent); }
  S.ell(0, hy, sp.hw, sp.hh, sp.skin);
  S.ell(sp.hw * 0.1, hy + sp.hh * 0.42, sp.hw * 0.78, sp.hh * 0.45, sp.skinLo, false);
  S.ell(-sp.hw * 0.3, hy - sp.hh * 0.45, sp.hw * 0.4, sp.hh * 0.22, sp.skinHi, false);
  eyesOn(S, 0, hy - sp.hh * 0.05, sp.eyes, sp.hw * (sp.eyes === 1 ? 0.42 : 0.3), 0);
  const mouth = new Path2D(); mouth.arc(0, hy + sp.hh * 0.4, sp.hw * 0.3, up ? 0.15 : 0.5, Math.PI - (up ? 0.15 : 0.5)); S.line(mouth, INK, 2.2);
}
// --- and what they build
const HOMES = [
  (S, r, c) => { S.dome(0, 0, 38, 34 + r() * 10, c.wall); S.dome(0, 0, 38, 9, c.roof, false); S.box(-8, -22, 16, 22, 8, c.dark); S.circ(-22, -17, 5, c.lamp).circ(22, -17, 5, c.lamp); S.circ(0, -40, 5, c.roof); },
  (S, r, c) => { const h = 62 + r() * 18; S.box(-15, -h, 30, h, 4, c.wall); S.poly([[-23, -h + 3], [23, -h + 3], [0, -h - 30]], c.roof); S.box(-6, -18, 12, 18, 6, c.dark); S.circ(0, -h * 0.62, 5.5, c.lamp).box(-11, -h * 0.4, 22, 4, 2, c.roof, false); S.poly([[-6, -h - 2], [0, -h + 3], [-14, -h + 3]], c.pale, false); },
  (S, r, c) => { const h = 34 + r() * 14; S.box(-17, -h, 34, h, 9, c.pale); S.dome(0, -h + 5, 42, 30, c.roof); for (let k = 0; k < 4; k++) S.circ((k - 1.5) * 17 + (r() - 0.5) * 5, -h - 6 - r() * 12, 3 + r() * 2.5, c.pale, false); S.box(-6.5, -19, 13, 19, 6.5, c.dark); S.circ(11, -h * 0.55, 4, c.lamp); },
  (S, r, c) => { for (let k = 0; k < 3; k++) S.box(-17 + k * 3, -24 - k * 21, 34 - k * 6, 22, 7, k % 2 ? c.roof : c.wall); eyesOn(S, 0, -36, 2, 4.6, 0); S.limb(-13, -66, -24, -84, 0.3, 4, 2, c.wall).limb(13, -66, 24, -84, -0.3, 4, 2, c.wall); S.circ(0, -78, 9, c.lamp).circ(-2.5, -80.5, 3.6, '#fffbe6', false); },
];

// the bigger works: a camp tent, two towers, a temple, the monument, a ruin, and a ship with its fire
const WORKS = [
  (S, r, c) => { S.poly([[-28, 0], [28, 0], [3, -42], [-3, -42]], c.roof); S.poly([[-8, 0], [8, 0], [0, -24]], c.dark, false); S.limb(0, -40, 0, -54, 0, 2.4, 2, c.dark); S.poly([[0, -54], [13, -50], [0, -45]], c.lamp); },
  (S, r, c) => { S.box(-15, -100, 30, 100, 5, c.wall); S.box(-19, -106, 38, 11, 4, c.roof); S.limb(0, -106, 0, -120, 0, 4, 1.5, c.roof); for (let k = 0; k < 4; k++) for (const x of [-9, 3]) S.box(x, -90 + k * 19, 6, 10, 2, r() < 0.8 ? c.lamp : c.dark, false); S.box(-5, -14, 10, 14, 5, c.dark, false); },
  (S, r, c) => { for (let k = 0; k < 4; k++) S.box(-22 + k * 4, -26 - k * 24, 44 - k * 8, 26, 5, k % 2 ? c.pale : c.wall); S.dome(0, -98, 10, 14, c.roof); for (let k = 0; k < 4; k++) S.box(-4, -19 - k * 24, 8, 10, 2, k ? c.lamp : c.dark, false); S.box(-24, -4, 48, 4, 1, c.roof, false); },
  (S, r, c) => { S.box(-46, -8, 92, 8, 2, c.pale).box(-40, -16, 80, 8, 2, c.pale); for (const x of [-30, -10, 10, 30]) S.box(x - 4.5, -60, 9, 44, 2, c.wall); S.poly([[-46, -60], [46, -60], [0, -90]], c.roof); S.circ(0, -70, 7, c.lamp); S.box(-7, -16, 14, 0.1, 0, c.dark, false); S.circ(0, -99, 6.5, c.lamp).circ(-1.5, -101, 2.6, '#fffbe6', false); },
  (S, r, c) => { S.box(-26, -9, 52, 9, 2, c.wall); S.box(-9, -24, 18, 16, 2, c.pale); S.limb(-13, -40, -29, -58, 0.2, 9, 7, c.pale); for (const [x, hh] of [[-12, 24], [-4, 31], [4, 29], [12, 20]]) S.box(x - 4, -58 - hh, 8, hh + 8, 4, c.pale); S.box(-16, -60, 32, 38, 9, c.pale); S.ell(0, -40, 9, 12, c.wall, false); eyesOn(S, 0, -41, 1, 6.5, 0); },
  (S, r, c) => { S.poly([[-34, 0], [-34, -38], [-26, -30], [-19, -46], [-10, -20], [-10, 0]], c.grey); S.poly([[4, 0], [4, -24], [13, -33], [20, -15], [31, -22], [31, 0]], c.greyLo); S.box(-5, -15, 9, 15, 1, c.grey); S.circ(-18, -3, 5, c.greyLo).circ(18, -3, 4, c.grey).circ(-28, -44, 2.5, c.greyLo, false); S.box(-34, -14, 24, 3, 1, c.greyLo, false); },
  (S, r, c) => { for (const sd of [-1, 1]) S.poly([[sd * 8, -34], [sd * 25, -6], [sd * 25, 0], [sd * 8, -12]], c.roof); S.ell(0, -56, 12.5, 46, c.pale); S.poly([[-10.5, -80], [10.5, -80], [0, -110]], c.roof); S.box(-11, -34, 22, 6, 2, c.roof, false); S.circ(0, -66, 6, c.lamp).circ(-1.5, -67.5, 2.2, '#fffbe6', false); S.box(-6, -10, 12, 10, 2, c.dark); },
  S => { S.leaf(0, -114, 0, -22, 0.2, '#ff8a2a', false).leaf(0, -114, 0, -48, 0.17, '#ffd27a', false).leaf(0, -114, 0, -76, 0.12, '#fffbe6', false); },
];

function drawArt(p) {
  if (artSeed === p.seed) return;
  artSeed = p.seed;
  const r = seeded((p.seed ^ 0x51ed270b) | 0), ctx = artCtx;
  ctx.clearRect(0, 0, artCanvas.width, artCanvas.height);
  // plants: a world's own greens (or blues, or reds), and a brighter second colour for fruit, caps and lamps
  const hA = r() < 0.45 ? 80 + r() * 80 : r() * 360, hB = hA + 60 + r() * 220, sat = 42 + r() * 26, lum = 34 + r() * 12;
  const kinds = []; while (kinds.length < 3) { const k = (r() * PLANTS.length) | 0; if (!kinds.includes(k)) kinds.push(k); }
  for (let v = 0; v < ART_COLS; v++) {
    const h = hA + (r() - 0.5) * 26, S = sketch();
    PLANTS[kinds[v % 3]](S, r, { leaf: hsl(h, sat, lum), leafHi: hsl(h - 8, sat + 6, lum + 15), leafLo: hsl(h + 10, sat, lum - 11), accent: hsl(hB, 78, 62), pale: hsl(hB + 30, 30, 84),
      trunk: hsl(hA + 180 + (r() - 0.5) * 60, 22 + r() * 14, 30 + r() * 12) });
    S.draw(ctx, v, 0, 0.98);
  }
  // animals: two species, four of each
  for (let s = 0; s < 2; s++) {
    const h = r() * 360, legs = [2, 4, 4, 4, 6][(r() * 5) | 0], sp0 = { bl: 20 + r() * 20, bh: 12 + r() * 12, ll: 8 + r() * 26, neck: r() < 0.3 ? 16 + r() * 22 : r() * 8, hr: 9 + r() * 6,
      legs, eyes: 1 + ((r() * 3) | 0), tail: (r() * 4) | 0, top: (r() * 5) | 0, spots: r() < 0.5 };
    if (legs === 2) sp0.bl = Math.min(sp0.bl, 24);
    for (let v = 0; v < 4; v++) {
      const hh = h + (r() - 0.5) * 24, l = 52 + r() * 14, k = 0.82 + r() * 0.3, S = sketch();
      drawAnimal(S, r, { ...sp0, bl: sp0.bl * k, bh: sp0.bh * k, ll: sp0.ll * k, hr: sp0.hr * (0.92 + 0.16 * r()), main: hsl(hh, 55, l), dark: hsl(hh + 14, 50, l - 22), light: hsl(hh - 14, 55, l + 22), accent: hsl(hh + 150, 72, 60), pale: hsl(hh + 40, 30, 86) });
      const wide = sp0.bl * k * 2 + sp0.neck + 44, high = sp0.ll * k + sp0.bh * k * 2 + sp0.neck + sp0.hr * 3.4 + 6;
      S.draw(ctx, s * 4 + v, 1, Math.min(1.4, 110 / wide, 110 / high));
    }
  }
  // the people, and their houses
  const h = r() * 360, hc = h + 100 + r() * 160;
  const sp = { hw: 13 + r() * 9, hh: 11 + r() * 9, eyes: 1 + ((r() * 3) | 0), ant: (r() * 3) | 0, ears: r() < 0.4, bw: 10 + r() * 6, bh: 24 + r() * 12, lh: 8 + r() * 10, arm: 15 + r() * 8, skirt: r() < 0.35,
    skin: hsl(h, 50, 60), skinLo: hsl(h + 12, 46, 46), skinHi: hsl(h - 10, 60, 76), robe: hsl(hc, 48, 46), accent: hsl(hc + 160, 80, 64), pale: hsl(hc + 40, 40, 88) };
  for (let v = 0; v < 4; v++) { const S = sketch(), tall = v < 2 ? 1 : 0.72; drawAlien(S, r, sp, v % 2 === 1, tall); S.draw(ctx, v, 2, Math.min(1.5, 108 / (sp.lh + sp.bh * tall + sp.hh * 2 + sp.arm + 14), 108 / (sp.bw * 2 + 40))); }
  const hc2 = { wall: hsl(hc + 20, 26, 70), roof: hsl(hc, 52, 46), dark: hsl(hc, 30, 18), lamp: '#ffd27a', pale: hsl(hc + 40, 30, 88) };
  for (let v = 0; v < 4; v++) { const S = sketch(); HOMES[v](S, r, hc2); S.draw(ctx, 4 + v, 2, 1); }
  hc2.grey = hsl(hc + 20, 9, 56); hc2.greyLo = hsl(hc + 20, 9, 42);
  for (let v = 0; v < 8; v++) { const S = sketch(); WORKS[v](S, r, hc2); S.draw(ctx, v, 3, v === 7 ? 1 : 0.92); }
  artTex.needsUpdate = true;
}

const lifeGeo = new THREE.BufferGeometry();
{
  const corner = new Float32Array(LIFE_MAX * 12), idx = new Uint16Array(LIFE_MAX * 6);
  for (let i = 0; i < LIFE_MAX; i++) {
    corner.set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], i * 12);
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  lifeGeo.setAttribute('position', new THREE.BufferAttribute(corner, 3));
  lifeGeo.setAttribute('a0', new THREE.BufferAttribute(new Float32Array(LIFE_MAX * 16), 4));
  lifeGeo.setAttribute('a1', new THREE.BufferAttribute(new Float32Array(LIFE_MAX * 16), 4));
  lifeGeo.setAttribute('a2', new THREE.BufferAttribute(new Float32Array(LIFE_MAX * 4), 1));
  lifeGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  lifeGeo.setDrawRange(0, 0);
}
const LIFE_SHARED = /* glsl */`
    uniform float uTime, uSeed, uAlpha, uRelief, uWater, uPan, uFog, uRain, uFlash;
    uniform vec2 uSun;
    uniform vec3 uAtm;
    varying vec2 vUv, vP; varying float vI, vK;
    ${NOISE_GLSL}
    const float H0 = ${LAND_H0}, TURN = ${LAND_TURN.toFixed(2)};
    float wrapT(float x){ return x - TURN * floor(x / TURN + 0.5); }
    float crags(vec2 p){ float v = 0.0, a = 0.55; for (int i = 0; i < 4; i++) { float n = 1.0 - abs(2.0 * noise(p) - 1.0); v += a * n * n; p = p * 2.1 + 13.0; a *= 0.5; } return v; }
    float ridge(float x, float i, float fq){
      float th = x * 6.2831853 / TURN, R = TURN * fq / 6.2831853;
      vec2 q = vec2(cos(th), sin(th)) * R + vec2(i * 17.3 + uSeed, i * 7.31);
      float a = fbm(q);
      return mix(a, a * 0.3 + crags(q * 0.8 + 31.7) * 0.75, uRelief);
    }
    // the skyline of range i at bearing x, exactly as the landscape draws it
    float skyline(float x, float i){
      float f = i / 5.0, fq = mix(2.4, 1.0, f);
      float amp = (uRelief * mix(0.42, 0.2, f) + 0.075 * (1.0 - smoothstep(0.85, 1.0, uWater))) * (1.0 - 0.45 * f * (1.0 - uRelief));
      return H0 - f * f * 0.34 - 0.004 + amp * ridge(x, i, fq);
    }`;
const lifeMat = new THREE.ShaderMaterial({
  uniforms: { uAtlas: { value: artTex }, uAmt: { value: new THREE.Vector3() }, uS: { value: 1 }, uWorship: { value: 0 },
    ...Object.fromEntries(['uTime', 'uSeed', 'uAlpha', 'uRelief', 'uWater', 'uPan', 'uFog', 'uRain', 'uFlash', 'uSun', 'uAtm'].map(k => [k, landMat.uniforms[k]])) },
  vertexShader: /* glsl */`
    attribute vec4 a0, a1; attribute float a2;
    uniform float uS, uWorship; uniform vec3 uAmt;
    ${LIFE_SHARED}
    float sc(float i){ float f = i / 5.0; return (0.55 + 0.45 * f) / (2.4 - 1.4 * f); }   // how big things are drawn at that range
    void main(){
      float kind = a2, B = a0.x, i = a0.y, ph = a1.z, size = a0.w, flip = 1.0, hop = 0.0, cell = a1.x;
      float amt = kind < 0.5 ? uAmt.x : kind < 1.5 ? uAmt.y : kind > 3.5 && kind < 4.5 ? 1.0 : uAmt.z, climb = 0.0;
      if (kind > 0.5 && kind < 1.5) {                              // animals amble to and fro, and face the way they go
        float t = uTime * 0.09 + ph, v = cos(t) * 0.4 + cos(t * 2.7 + 1.0) * 0.324;
        B += sin(t) * 0.4 + sin(t * 2.7 + 1.0) * 0.12; flip = v < 0.0 ? -1.0 : 1.0;
        hop = abs(sin(uTime * 5.0 + ph * 7.0)) * min(1.0, abs(v) * 4.0);
      } else if (kind > 1.5 && kind < 2.5) {                       // people shuffle about, and raise their arms to a god they love
        B += sin(uTime * 0.06 + ph) * 0.1; hop = abs(sin(uTime * 3.0 + ph * 5.0)) * 0.5;
        if (uWorship > 0.5 && sin(uTime * 1.4 + ph * 3.0) > -0.2) cell += 1.0;
      }
      if (kind > 4.5) {                                            // the ship stands, shakes, and goes up on its fire
        float t = fract(uTime / 46.0 + ph), u = max(0.0, t - 0.8) / 0.2;
        climb = u * u * 1.5; B += sin(uTime * 60.0) * 0.0012 * step(0.76, t);
        if (kind > 5.5 && t < 0.78) amt = -1.0;                    // no fire until it lights
      }
      vK = kind;
      float yW = uWater > 0.0 ? H0 - 0.012 - (1.0 - smoothstep(0.3, 1.0, uWater)) * 0.2 : -1.0, dz = a0.z;
      if (kind > 2.5 && i < 4.5 && skyline(B, i) - dz < yW + 0.004) {   // its plot is under water here: build on the far shore, or failing that close by
        float i0 = i; i = 3.0;
        if (skyline(B, 3.0) - dz < yW + 0.004) i = 2.0;
        if (i < 2.5 && skyline(B, 2.0) - dz < yW + 0.004) i = uWater < 0.9 ? 5.0 : i0;
        float k = sc(i) / sc(i0); size *= k; dz *= k;
      }
      float y0 = skyline(B, i) - dz;
      vec2 c = position.xy;
      vUv = vec2((cell + (flip > 0.0 ? c.x : 1.0 - c.x)) / ${ART_COLS}.0, 1.0 - (a1.y + 1.0 - c.y) / ${ART_ROWS}.0);
      vec2 q = vec2(wrapT(B - uPan) + (c.x - 0.5) * size, y0 - 0.085 * size + c.y * size + hop * 0.05 * size + climb);
      if (kind > 5.5) { q.y -= size * 0.9; q.x += (c.x - 0.5) * size * 0.25 * sin(uTime * 37.0 + c.y * 9.0) * (1.0 - c.y); }
      if (kind < 0.5) q.x += sin(uTime * 1.1 + ph) * 0.04 * size * c.y * c.y;   // plants sway from the root
      vP = q; vI = i;
      bool hide = a1.w > amt || (i < 4.5 && y0 < yW + 0.004) || (i > 4.5 && uWater >= 0.9);
      gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(q.x * uS, (q.y - 0.5) * uS, 0.0, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uAtlas;
    ${LIFE_SHARED}
    void main(){
      vec4 t = texture2D(uAtlas, vUv);
      if (t.a < 0.03) discard;
      for (int j = 1; j < 6; j++) {                                // anything nearer that rises in front hides it
        float fj = float(j);
        if (fj > vI + 0.5 && (j < 5 || uWater < 0.9) && skyline(vP.x + uPan, fj) > vP.y) discard;
      }
      float gSh = uSun.y - H0, gDay = smoothstep(-0.14, 0.08, gSh), gDusk = smoothstep(0.3, 0.0, gSh) * smoothstep(-0.22, -0.02, gSh);
      vec3 gTint = mix(vec3(1.0, 0.42, 0.16), vec3(1.0, 0.95, 0.86), smoothstep(-0.02, 0.3, gSh));
      vec3 gLight = gTint * (0.07 + 0.93 * gDay) * (1.0 - 0.45 * uRain) + vec3(0.03, 0.04, 0.09);
      vec3 gHz = mix(uAtm, vec3(1.0), 0.45) * (0.03 + 0.97 * gDay) + vec3(1.0, 0.4, 0.12) * gDusk * 0.45 + vec3(0.008, 0.012, 0.03);
      gHz = mix(gHz, vec3(0.6, 0.63, 0.68) * (0.06 + 0.94 * gDay), max(uFog, uRain * 0.5));
      float f = vI / 5.0, hz = clamp((1.0 - f * 1.15) * 0.6 + uFog * 0.5 * (1.0 - f * 0.4), 0.0, 0.97);
      vec3 lit = t.rgb * gLight * 1.3;
      lit = mix(vec3(dot(lit, vec3(0.3, 0.59, 0.11))), lit, 1.25);          // keep the colours singing through the haze
      vec3 col = mix(lit, gHz, hz * 0.45);
      col += vec3(0.8, 0.85, 1.0) * 0.12 * uFlash;
      col = mix(col, gHz, uFog * 0.3) * 0.8;
      float lamp = smoothstep(0.3, 0.12, distance(t.rgb, vec3(1.0, 0.824, 0.478))) * step(2.5, vK);   // lit windows carry on into the night
      col += t.rgb * lamp * (1.0 - 0.9 * gDay) * 1.1;
      if (vK > 5.5) col = t.rgb * 1.5;                             // and fire is its own light
      gl_FragColor = vec4(col * t.a * uAlpha, t.a * uAlpha);
    }`,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  depthWrite: false, depthTest: false, transparent: true,
});
const lifeMesh = new THREE.Mesh(lifeGeo, lifeMat);
lifeMesh.frustumCulled = false; lifeMesh.visible = false; lifeMesh.renderOrder = 2.85;
scene.add(lifeMesh);

// Stand them about this place. Where each one goes is fixed by the planet and the spot, so coming back finds
// the same wood and the same village; how many of them show follows how the land is doing.
function populateLand(p, lon, lat) {
  drawArt(p);
  const r = seeded(((p.seed | 0) ^ Math.imul((lon * 977) | 0, 7919) ^ Math.imul((lat * 1291) | 0, 104729)) | 0), list = [];
  const scaleOf = i => { const f = i / 5; return (0.55 + 0.45 * f) / (2.4 - 1.4 * f); };
  const put = (kind, B, i, d, size, col, row, rank) => list.push({ kind, B, i, d: d * scaleOf(i) + 0.002, size: size * scaleOf(i) * (1 + d * 3), col, row, ph: r() * 40, rank });
  const groves = Array.from({ length: 9 }, () => r() * LAND_TURN);
  for (let n = 0; n < 118; n++) { // woods in clumps, with strays between
    const B = r() < 0.7 ? groves[(r() * groves.length) | 0] + (r() - 0.5) * 0.9 : r() * LAND_TURN, i = [2, 3, 3, 4, 4, 4, 5, 5][(r() * 8) | 0];
    put(0, B, i, r() * (i === 5 ? 0.1 : 0.05), 0.13 + r() * 0.1, (r() * ART_COLS) | 0, 0, n < 12 ? 0.02 : r());
  }
  for (let n = 0; n < 20; n++) put(1, r() * LAND_TURN, [3, 4, 4, 5, 5][(r() * 5) | 0], 0.01 + r() * 0.07, 0.1 + r() * 0.035, (r() * ART_COLS) | 0, 1, n < 5 ? 0.05 : r());
  const towns = [r() * LAND_TURN, r() * LAND_TURN, r() * LAND_TURN];
  for (let n = 0; n < 18; n++) put(2, towns[n % 3] + (r() - 0.5) * 0.9, [4, 4, 5, 5][(r() * 4) | 0], 0.03 + r() * 0.07, 0.125 + r() * 0.02, ((r() * 2) | 0) * 2, 2, n < 5 ? 0.05 : r());
  // What has been built, by how far these people have come: tents, then houses, then towers in the middle of
  // the largest places. Whatever stood on a plot that is now empty is a ruin there, while the ruins last.
  const L = p.life, civ = L && L.s === 4, tier = civ ? L.tier : -1, rb = seeded(((p.seed | 0) ^ Math.imul((lon * 977) | 0, 31337) ^ Math.imul((lat * 1291) | 0, 2713) ^ 0x7f4a7c15) | 0);
  const full = tier < 0 ? [0, 0, 0] : [[3, 0, 0], [4, 3, 0], [5, 4, 3], [7, 6, 5]][tier], tall = tier < 2 ? [0, 0, 0] : tier === 2 ? [1, 0, 0] : [3, 2, 1], empty = [];
  for (let t = 0; t < 3; t++) for (let j = 0; j < 7; j++) {
    const B = towns[t] + (j % 2 ? 1 : -1) * Math.ceil(j / 2) * 0.15 + (rb() - 0.5) * 0.07, i = [4, 4, 3, 5, 4, 3, 5][j], d = 0.006 + rb() * 0.03, home = 4 + ((rb() * 4) | 0), big = rb();
    if (j >= full[t]) empty.push([j, B, i, d]);
    else if (tier === 0) put(3, B, i, d, 0.15 + big * 0.04, 0, 3, 0.01);
    else if (j < tall[t]) put(3, B, i, d, 0.33 + big * 0.1, 1 + (home & 1), 3, 0.01);
    else put(3, B, i, d, 0.2 + big * 0.07, home, 2, 0.01);
  }
  empty.sort((a, b) => a[0] - b[0]);
  for (let n = 0, m = Math.min(empty.length, Math.round((L ? L.ruin : 0) * 7)); n < m; n++) put(4, empty[n][1], empty[n][2], empty[n][3], 0.19, 5, 3, 0);
  if (civ && L.temple) put(3, towns[0] + 0.52, 4, 0.02, 0.34, 3, 3, 0.01);
  if (civ && L.mon) put(3, towns[1] - 0.5, 4, 0.03, 0.3, 4, 3, 0.01);
  if (civ && L.sp >= 1) { put(5, towns[0] - 0.8, 3, 0.012, 0.3, 6, 3, 0.01); const ship = list[list.length - 1]; put(6, ship.B, 3, 0.012, 0.3, 7, 3, 0.01); const fire = list[list.length - 1]; fire.ph = ship.ph; fire.d = ship.d; fire.size = ship.size; }
  list.sort((a, b) => a.i - b.i || a.d - b.d || a.kind - b.kind); // far to near, so the near ones are drawn over the far
  const a0 = lifeGeo.attributes.a0, a1 = lifeGeo.attributes.a1, a2 = lifeGeo.attributes.a2, n = Math.min(list.length, LIFE_MAX);
  for (let k = 0; k < n; k++) for (let v = 0; v < 4; v++) {
    const o = list[k], j = k * 4 + v;
    a0.setXYZW(j, o.B, o.i, o.d, o.size); a1.setXYZW(j, o.col, o.row, o.ph, o.rank); a2.setX(j, o.kind);
  }
  a0.needsUpdate = a1.needsUpdate = a2.needsUpdate = true;
  lifeGeo.setDrawRange(0, n * 6);
}
// how much of it there is to see: plants with the green of the world, animals and people where the ground suits them
function lifeAmounts(L, suit) {
  const u = lifeMat.uniforms, to = [L && L.s >= 2 ? clamp01(L.g * 1.5) * suit : 0, L && L.s >= 3 ? clamp01(suit * 1.3) : 0, L && L.s === 4 && suit > 0.12 ? clamp01(0.3 + L.c * 1.1) : 0];
  u.uAmt.value.set(to[0], to[1], to[2]); u.uWorship.value = L && L.s === 4 && L.f > 0.2 ? 1 : 0;
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
let sculpt = null;                 // ...or, at a planet, its sea being raised or its rings drawn out

function updateNebulae(dt, L, R) {
  const both = L.active && R.active && L.gesture === 'point' && R.gesture === 'point';
  const space = level === 0 ? 0 : level === 1 && focusG ? focusG.id : -1;
  if (nebula && nebula.space !== space) { nebula.held = false; nebula = null; }
  if (sculpt && (level < 2 || !!sculpt.tide !== (level === 3))) sculpt = null;
  if (both) {
    const a = L.tips[1], b = R.tips[1], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const W = space === 0 ? 1 : gK; // world units per unit of this space
    const local = () => (space === 0 ? _w.set(mx, my, 0) : unplace(mx, my, _w));
    if (level === 3) planetTips(mx, my, d, performance.now() / 1000);
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
    const show = this.active && this.hasJoints && E4 < 0.5;
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
    if (g !== 'pinch') { this.release(); this.pinchAt = null; this.makeAt = 0; this.moon = null; this.lockObj = null; this.lockK = 0; this.spot = null; this.pv = null; } else if (this.pinchAt == null) this.pinchAt = now;
    if (g === 'point') this.pointAt = now; else if (now - (this.pointAt ?? -10) > 0.4) this.dwell = null; // a finger that flickers out of view for a moment keeps its place
    // the gathered charge survives the split second it takes a fist to become an open hand, then drains
    if (g !== 'fist' && now - (this.fistAt ?? -10) > T.openWindow) this.charge = Math.max(0, this.charge - dt * 3);

    if (level === 4) { // standing on the ground the hands are at rest
      this.charge = 0;
      if (g !== 'none') this.lastSolid = g;
      this.prevTip.copy(this.tips[1]);
      return;
    }
    if (g === 'open') {
      // An open hand on its own never explodes. The supernova only fires when a fist that has
      // actually been gathering is opened.
      if (this.charge >= T.minCharge) { burst(p, this.charge, this.vel); shatter(p, this.charge); this.lastBurst = now; }
      this.charge = 0;
      wells.push({ x: p.x, y: p.y, z: p.z, g: -7 });
      if (!planetHold(this, now)) { // streamers off every fingertip (but a hand holding a planet keeps it clear)
        for (const t of this.tips) for (let k = 0; k < 5; k++) {
          _v.subVectors(t, p).normalize().multiplyScalar(1.5 + Math.random() * 2.5);
          pickColor(0.2);
          spawn(t.x, t.y, t.z, _v.x + this.vel.x * 0.4 + rnd(0.6), _v.y + this.vel.y * 0.4 + rnd(0.6), rnd(0.6),
            cr, cg, cb, 0.6 + Math.random() * 1.2, 0.04 + Math.random() * 0.05);
        }
      }
    } else if (g === 'fist' && level === 3 && planetDig(this, now, dt)) {
      this.charge = 0; // pressing on the ground, not gathering a meteor
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
        // And it has to be held still: a pinch that wanders starts its count again from where it has got to.
        if (!this.makeAt || Math.hypot(q.x - this.makeX, q.y - this.makeY) > T.pinchDrift) { this.makeAt = now; this.makeX = q.x; this.makeY = q.y; }
        const k = (now - this.makeAt) / T.pinchHold, ready = k >= 1, make = fn => () => (ready ? fn(q) : null);
        this.lockSeen = null;
        this.grab = level === 0 ? pinchPick(galaxies.filter(x => x.alive), q, this, now, make(acquireGalaxy))
          : level === 1 ? pinchPick(focusG.stars, q, this, now, make(newStar))
          : pinchPick(focusS.planets, q, this, now, make(newPlanet));
        const o = this.lockSeen;
        if (o) { // resting on something: brackets of light turn and tighten round it until they lock
          if (this.lockObj !== o || Math.hypot(q.x - this.lockX, q.y - this.lockY) > T.pinchDrift) { this.lockObj = o; this.lockAt = now; this.lockX = q.x; this.lockY = q.y; }
          const lk = this.lockK = (now - this.lockAt) / T.lockHold, e = Math.min(1, lk), R = (o.kind === 'galaxy' ? o.radius * 0.8 : o.reach * 0.55) * (1.5 - 0.5 * e * e);
          this.makeAt = 0;
          pickColor(0.85);
          for (let i = 0, n = Math.round(12 + R * 16); i < n; i++) {
            const a = now * 1.6 * (1 - 0.7 * e) + (i % 4) * TAU / 4 + Math.random() * 0.75, b = 2 + 2 * e;
            spawn(o.wx + Math.cos(a) * R, o.wy + Math.sin(a) * R, q.z, 0, 0, 0, cr * b, cg * b, cb * b, 0.18, 0.06 + 0.035 * e);
          }
        } else if (this.grab && this.lockObj === this.grab) { // locked: the ring closes in a flash, and it is yours
          const g2 = this.grab, R = g2.kind === 'galaxy' ? g2.radius * 0.8 : g2.reach * 0.55;
          pickColor(0.9);
          for (let i = 0; i < 60; i++) { const a = i / 60 * TAU; spawn(g2.wx + Math.cos(a) * R, g2.wy + Math.sin(a) * R, q.z, -Math.cos(a) * 0.5, -Math.sin(a) * 0.5, 0, cr * 2.4, cg * 2.4, cb * 2.4, 0.35, 0.06); }
          this.lockObj = null; this.lockK = 0;
        } else { this.lockObj = null; this.lockK = 0; }
        if (!o && !this.grab && !this.assist && !ready) { // light gathers to the fingertips while it waits: let go now and nothing comes of it
          gatherLight(q, k, now);
        }
        this.grabInv = null; // remember how the hand and the galaxy were angled when the pinch began
        if (this.grab?.kind === 'galaxy' && this.hasQuat) { this.grabInv = this.quat.clone().invert(); this.grabQ.copy(this.grab.quat); }
      }
      if (this.grab) holdBody(this, this.grab, dt);
    } else if (g === 'point' && !sculpting && level === 3 && planetClimate(this, now, dt)) {
      // resting on a planet, the finger changes the weather rather than drawing
    } else if (g === 'point' && !sculpting) {
      const tip = this.tips[1], n = 14;
      for (let k = 0; k < n; k++) { // interpolate so fast strokes stay continuous
        _v.lerpVectors(this.prevTip, tip, k / n);
        pickColor(0.25);
        spawn(_v.x + rnd(0.04), _v.y + rnd(0.04), _v.z, rnd(0.25), rnd(0.25), rnd(0.25), cr, cg, cb,
          1.6 + Math.random() * 1.6, 0.05 + Math.random() * 0.05);
      }
    } else if (g === 'peace' && level === 3) {
      planetPeace(this, now);
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
    h.size = Math.max(Math.hypot(h.joints[9].x - h.joints[0].x, h.joints[9].y - h.joints[0].y), 1.25 * Math.hypot(h.joints[17].x - h.joints[5].x, h.joints[17].y - h.joints[5].y));
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
  keepAwake(); applySound(); legendBtn.hidden = false; setPalette(0); introEl.classList.add('hidden'); hudEl.classList.add('on'); paletteEl.classList.add('on');
  loadUniverse(); entered = true; whereEl.classList.add('on'); refreshChrome();
}

// a short message in the middle of the screen: what you are growing, where you have arrived, why nothing happened
function note(msg, secs = 3.5) {
  if (noteEl.textContent !== msg) { noteEl.textContent = msg; chime(); }
  noteEl.classList.add('on'); noteT = secs;
}

// the gesture guide and the "where am I" line change with the level
const LEGEND = { // one line per level: universe, galaxy, solar system, a world with ground, a giant, standing on the ground
  'fist open': ['<b>Fist</b>gather, then <b class="in">open</b> for a supernova; on a galaxy it destroys it',
    '<b>Fist</b>gather, then <b class="in">open</b> on a star to blow it up',
    '<b>Fist</b>gather, then <b class="in">open</b> on a planet to smash it',
    '<b>Fist</b>on the land sinks it; gathered out in space, then <b class="in">opened</b> over it, a meteor; on a moon or the rings, destroys them',
    '<b>Fist</b>gather, then <b class="in">open</b> on the planet to scar its clouds; on a moon or the rings, destroys them',
    '<b>Fist</b>gather, then <b class="in">open</b> for lightning'],
  pinch: ['<b>Pinch</b>hold still a second to gather light, then keep holding to grow a galaxy. Rest it on a galaxy to lock on, then drag or twist',
    '<b>Pinch</b>hold still a second to gather light, then keep holding to grow a star. Rest it on a star to lock on, then drag',
    '<b>Pinch</b>hold still a second to gather light, then keep holding to grow a planet. Rest it on a planet to lock on, then drag to move its orbit',
    '<b>Pinch</b>on the land, hold to swell it or drag for mountains; beside the planet, hold still for a moon, or rest on a moon to move it',
    '<b>Pinch</b>hold on the planet to brew a storm; beside it, hold still for a moon, or rest on a moon to move it',
    '<b>Pinch</b>take hold of the sun and move it: day, dusk, night'],
  zoom: ['<b>Open palm</b>push it at the screen over a galaxy to dive in',
    '<b>Open palm</b>push it at the screen over a star to visit; touch and rest both hands together to leave',
    '<b>Open palm</b>push it at the screen over a planet to go there; touch and rest both hands together to leave',
    '<b>Open hand</b>holds or turns the planet; push it at a spot to go down there; touch and rest both together to leave',
    '<b>Open hand</b>holds or turns the planet; touch and rest both together to leave',
    '<b>Open hand</b>sweep sideways to turn and look around; touch and rest both together to leave'],
  point: ['<b>Point</b>draw with light', '<b>Point</b>draw with light', '<b>Point</b>draw with light',
    '<b>Point</b>rest on a spot to freeze it, or to thaw it if it is frozen', '<b>Point</b>draw with light', '<b>Point</b>hold to change the weather: storms water the land, clear skies dry it'],
  peace: ['<b>Peace sign</b>change colors', '<b>Peace sign</b>change colors', '<b>Peace sign</b>change colors',
    '<b>Two fingers</b>rest on a spot for a second to go down and stand there', '<b>Peace sign</b>change colors', '<b>Two fingers</b>nothing down here yet'],
  nebula: ['<b>Two fingertips</b>touch, then pull apart for a nebula',
    '<b>Two fingertips</b>touch, then pull apart for a dust cloud',
    '<b>Two fingertips</b>rings and moons are made at the planet itself: go there first',
    '<b>Two fingertips</b>on the planet, spread or close to raise or drain the sea; touch beside it and pull apart for rings',
    '<b>Two fingertips</b>on the planet, spread or close for faster or calmer winds; touch beside it and pull apart for rings',
    '<b>Two fingertips</b>nothing down here yet'],
};
const ARRIVE = ['Back in the universe', 'Inside the galaxy. Pinch and hold to light a star.', 'A solar system. Pinch and hold to grow a planet.',
  'One open hand holds the planet, the other shapes it', 'On the surface'];
function refreshChrome() {
  const row = level < 3 ? level : level === 4 ? 5 : focusP && !isSolid(focusP) ? 4 : 3;
  for (const k in LEGEND) if (chips[k]) chips[k].innerHTML = LEGEND[k][row];
  whereEl.textContent = whereText();
  upBtn.hidden = !entered || level === 0;
  savesBtn.hidden = !entered;
  const world = entered && level >= 3 && focusP && isSolid(focusP);
  document.body.classList.toggle('land', entered && level === 4);
  document.getElementById('landBar').hidden = !(entered && level === 4);
  document.getElementById('histBtn').hidden = !world;
  if (!world) { document.getElementById('chron').hidden = true; document.getElementById('histBtn').classList.remove('lit'); }
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
          life: p.life && (p.life.s || p.life.t > 0 || p.life.ev || p.life.hist.length > 1 || p.life.ruin > 0) ? { s: p.life.s, t: r(p.life.t), g: r(p.life.g), c: r(p.life.c), f: r(p.life.f), ev: p.life.ev ? [p.life.ev.k, Math.round(p.life.ev.left)] : undefined,
            y: Math.round(p.life.y), h: p.life.hist, ru: r(p.life.ruin), b: [p.life.temple, p.life.mon, p.life.fb, p.life.dt, p.life.help, p.life.harm, p.life.gen], sp: r(p.life.sp), o: p.life.o || undefined } : undefined,
          scars: p.scars.length ? p.scars.map(q => q.map(r)) : undefined,
          moons: p.moons.map(m => ({ d: r(m.d), a: r(m.a), seed: m.seed, col: m.col ? 1 : undefined })) })) })) })),
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
  nebula = null; sculpt = null; nextId = 1; ships.length = 0;
  level = 0; depth = 0; zoomNudge = 0; zoomHeld = 0; zoomOn = false; zoomKey = null; zoomLock = false; focusG = focusS = focusP = null; land = null; terrainOf = null; terrainDirty = false;
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
        p.map = b.map || null; p.sea = b.sea ?? null; p.wind = b.wind ?? 1; p.spots = (b.spots || []).map(q => [...q]); p.scars = (b.scars || []).map(q => [...q]);
        if (b.life) Object.assign(lifeOf(p), { s: b.life.s | 0, t: +b.life.t || 0, g: +b.life.g || 0, c: +b.life.c || 0, f: +b.life.f || 0, ev: b.life.ev ? { k: b.life.ev[0] % DISASTERS.length, left: b.life.ev[1] } : null,
          y: +b.life.y || 0, hist: Array.isArray(b.life.h) ? b.life.h.filter(e => Array.isArray(e) && typeof e[1] === 'string').map(e => [+e[0] || 0, e[1]]) : [], ruin: +b.life.ru || 0, sp: +b.life.sp || 0, o: b.life.o | 0,
          tier: tierOf(+b.life.c || 0), ...Object.fromEntries(['temple', 'mon', 'fb', 'dt', 'help', 'harm', 'gen'].map((k, i) => [k, (b.life.b && b.life.b[i]) | 0])) });
        return p; });
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
  if (on) document.getElementById('settings').hidden = true;
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
window.addEventListener('keydown', e => { if (e.target instanceof HTMLInputElement) { if (e.key === 'Escape') { showSaves(false); document.getElementById('settings').hidden = true; } e.stopImmediatePropagation(); } }, true);
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
video.addEventListener('click', () => { if (video.classList.contains('on')) { toggleCam(); note('Camera view hidden. The camera button brings it back.', 3); } }); // tap the preview itself to put it away
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

// ---------------------------------------------------------------- sound
// Off until asked for. A low hum under everything, and a soft note whenever a message appears.
let audio = null;
function applySound() {
  if (settings.sound && !audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC(), master = ctx.createGain(), hum = ctx.createGain(), low = ctx.createBiquadFilter();
    low.type = 'lowpass'; low.frequency.value = 420; master.connect(ctx.destination); hum.connect(master); low.connect(hum);
    for (const [f, g] of [[55, 0.5], [82.6, 0.3], [110.4, 0.22], [164.2, 0.1]]) {
      const o = ctx.createOscillator(), og = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
      o.frequency.value = f; og.gain.value = g; lfo.frequency.value = 0.03 + Math.random() * 0.06; lg.gain.value = g * 0.5;
      lfo.connect(lg); lg.connect(og.gain); o.connect(og); og.connect(low); o.start(); lfo.start();
    }
    audio = { ctx, master, hum };
  }
  if (!audio) return;
  if (settings.sound) audio.ctx.resume?.(); else audio.ctx.suspend?.();
  audio.master.gain.value = settings.volume; audio.hum.gain.value = settings.hum ? 0.35 : 0;
}
function chime() {
  if (!audio || !settings.sound || !settings.chimes) return;
  const { ctx, master } = audio, t = ctx.currentTime;
  for (const [f, d] of [[659.3, 0], [987.8, 0.09]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.09, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0005, t + d + 0.9);
    o.connect(g); g.connect(master); o.start(t + d); o.stop(t + d + 1);
  }
}

// ---------------------------------------------------------------- the settings window
const setEl = document.getElementById('settings'), setBtn = document.getElementById('setBtn');
// the surface is the one place worked by mouse and keyboard
const SURFACE_KEYS = [['Drag', 'turn on the spot and look around'], ['A / D or ← / →', 'turn left and right'], ['Drag the sun', 'move it across the sky: day, dusk, night'],
  ['Scroll or ↑ / ↓', 'raise and lower the sun'], ['1 2 3 4', 'clear skies, clouds, storm, mist. Storms water the land; clear skies you chose dry it'], ['Space', 'the next kind of weather'],
  ['Double-click or L', 'lightning, where the pointer is'], ['C', 'the history of this world'], ['B or Backspace', 'leave, back up to the planet']];
const VIEWS = [['Universe view', [0]], ['Galaxy view', [1]], ['Solar system view', [2]], ['Planet view', [3, 4]], ['Surface view', [5]]];
function renderControls(v) {
  const [, rows] = VIEWS[v], box = document.getElementById('ctlList');
  if (v === 4) box.innerHTML = '<p class="fine" style="margin:0 0 10px">Down on the surface your hands can rest: it is worked with the mouse and keyboard, or the buttons along the bottom.</p><ul>' + SURFACE_KEYS.map(([k, t]) => `<li><b>${k}</b>${t}</li>`).join('') + '</ul>';
  else box.innerHTML = rows.map(r => (rows.length > 1 ? `<h3>${r === 3 ? 'A world with ground' : 'A gas or ice giant'}</h3>` : '') + '<ul>'
    + Object.values(LEGEND).map(l => l[r]).filter(t => !/nothing down here/.test(t)).map(t => `<li>${t}</li>`).join('') + '</ul>').join('');
  document.querySelectorAll('#ctlTabs button').forEach((b, i) => b.classList.toggle('sel', i === v));
}
document.getElementById('ctlTabs').innerHTML = VIEWS.map(([n], i) => `<button type="button" data-v="${i}">${n}</button>`).join('');
document.getElementById('ctlTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) renderControls(+b.dataset.v); });
function showTab(name) {
  document.querySelectorAll('#setTabs button').forEach(b => b.classList.toggle('sel', b.dataset.tab === name));
  document.querySelectorAll('#settings section').forEach(x => { x.hidden = x.dataset.tab !== name; });
  if (name === 'controls') renderControls(level < 3 ? level : level === 4 ? 4 : 3); // open on the view you are in
  if (name === 'main') document.getElementById('setWhere').textContent = entered ? whereText() : 'Not started yet';
}
document.getElementById('setTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
function applySettings(save = true) {
  T.lifeSpeed = settings.pace;
  const want = settings.res === 'auto' ? null : Math.min(2, +settings.res || 1);
  if (want && Math.abs(want - pixelRatio) > 0.01) { landCost = 0; setRatio(want); }
  applySound();
  for (const el of document.querySelectorAll('#settings [data-k]')) {
    const v = settings[el.dataset.k];
    if (el.type === 'checkbox') el.checked = v; else el.value = String(v);
  }
  document.getElementById('setCam').checked = video.classList.contains('on'); document.getElementById('setCam').disabled = mode !== 'camera';
  document.getElementById('setGuide').checked = !hudEl.classList.contains('min');
  if (save) try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch {}
}
setEl.addEventListener('input', e => {
  const el = e.target, k = el.dataset.k;
  if (el.id === 'setCam') { if (el.checked !== video.classList.contains('on')) toggleCam(); return; }
  if (el.id === 'setGuide') { setLegend(el.checked); return; }
  if (!k) return;
  const was = settings.res;
  settings[k] = el.type === 'checkbox' ? el.checked : typeof SET_DEFAULT[k] === 'number' ? +el.value : el.value;
  if (k === 'res' && settings.res === 'auto' && was !== 'auto') { landCost = 0; setRatio(autoRatio()); }
  applySettings();
});
function showSettings(on, tab = 'main') {
  setEl.hidden = !on;
  if (on) { showSaves(false); applySettings(false); showTab(tab); }
}
setBtn.addEventListener('click', e => { showSettings(setEl.hidden); e.currentTarget.blur(); });
setEl.addEventListener('pointerdown', e => { if (e.target === setEl) showSettings(false); });
document.getElementById('setClose').addEventListener('click', () => showSettings(false));
document.getElementById('setUniverses').addEventListener('click', () => { showSettings(false); if (entered) showSaves(true); });
document.getElementById('setUp').addEventListener('click', () => { if (entered) surface(); showTab('main'); });
document.getElementById('setFs').addEventListener('click', () => toggleFullscreen());
document.getElementById('setReset').addEventListener('click', () => { const was = settings.res; Object.assign(settings, SET_DEFAULT); if (was !== 'auto') { landCost = 0; setRatio(autoRatio()); } applySettings(); });
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 's' || e.key === 'S') showSettings(setEl.hidden); else if (e.key === 'Escape') showSettings(false);
});
T.lifeSpeed = settings.pace;

// ---------------------------------------------------------------- a world's history, to read
const chronEl = document.getElementById('chron'), histBtn = document.getElementById('histBtn');
function renderChron(list = true) {
  const p = focusP, L = p && p.life;
  if (!p || !L || level < 3 || !isSolid(p)) return showChron(false);
  const F = L.s === 4 ? folk(p) : null, n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  document.getElementById('chronTitle').textContent = `History of ${properName(p.seed)}`;
  document.getElementById('chronFolk').textContent = `Year ${Math.round(L.y).toLocaleString()}. ` + (F ? `The ${F.name}, ${F.traitText}, live here in ${TIERS[L.tier]}. ${mood(L.f)}.`
    + (L.help || L.harm ? ` They remember ${[L.help ? n(L.help, 'kindness', 'kindnesses') : '', L.harm ? n(L.harm, 'injury', 'injuries') : ''].filter(Boolean).join(' and ')} from you.` : '')
    + (L.sp >= 1 ? ' They have taken to the sky.' : '') : L.s ? `${STAGE_SHORT[L.s]} live here. ${L.gen ? 'Its people are gone.' : 'No people yet.'}` : 'Nothing lives here yet.');
  if (!list) return;
  histDirty = false;
  document.getElementById('chronList').replaceChildren(...L.hist.slice().reverse().map(([y, t]) => {
    const li = document.createElement('li'), b = document.createElement('b');
    b.textContent = `Year ${y.toLocaleString()}`; li.append(b, t);
    return li;
  }));
}
function showChron(on) {
  if (on && !(entered && level >= 3 && focusP && isSolid(focusP))) { if (entered) note('Every world keeps its own history. Go to a planet with ground to read it.', 4); on = false; }
  chronEl.hidden = !on; histBtn.classList.toggle('lit', on);
  if (on) renderChron();
}
histBtn.addEventListener('click', e => { showChron(chronEl.hidden); e.currentTarget.blur(); });
document.getElementById('chronClose').addEventListener('click', () => showChron(false));

// ---------------------------------------------------------------- the surface, by mouse and keyboard
const landKeys = new Set(), stageEl = document.getElementById('stage');
let landDrag = null, landMouse = 0;
const landOn = () => entered && level === 4 && !!land;
const landPt = e => ({ x: (e.clientX / innerWidth - 0.5) * viewW / (viewH * LAND_M), y: 0.5 + (0.5 - e.clientY / innerHeight) / LAND_M }); // the pointer, in the picture's own measure
stageEl.addEventListener('pointerdown', e => {
  if (!landOn() || e.button) return;
  const q = landPt(e);
  landDrag = { sun: Math.hypot(q.x - wrapTurn(land.sunX - land.pan), q.y - land.sunY) < 0.1, x: q.x, t: performance.now() / 1000 }; // on the sun: move the sun. Anywhere else: look around
  stageEl.setPointerCapture(e.pointerId); stageEl.classList.add('drag');
});
stageEl.addEventListener('pointermove', e => {
  if (!landOn()) return;
  const q = landPt(e), now = performance.now() / 1000;
  landMouse = q.x;
  if (!landDrag) return;
  if (landDrag.sun) { land.sunX = land.pan + q.x; land.sunY = THREE.MathUtils.clamp(q.y, 0.12, 0.95); }
  else { const dx = q.x - landDrag.x; land.pan -= dx; land.panV = THREE.MathUtils.clamp(land.panV + (-dx / Math.max(0.008, now - landDrag.t) - land.panV) * 0.5, -3, 3); land.panAt = now; }
  landDrag.x = q.x; landDrag.t = now;
});
const landDrop = () => { if (landDrag && land && performance.now() / 1000 - landDrag.t > 0.08) land.panV = 0; landDrag = null; stageEl.classList.remove('drag'); }; // let go while moving and it carries on round a little
stageEl.addEventListener('pointerup', landDrop); stageEl.addEventListener('pointercancel', landDrop);
stageEl.addEventListener('wheel', e => { if (!landOn()) return; land.sunY = THREE.MathUtils.clamp(land.sunY - e.deltaY * 0.0005, 0.12, 0.95); e.preventDefault(); }, { passive: false });
stageEl.addEventListener('dblclick', e => { if (landOn()) bolt(landPt(e).x); });
document.getElementById('landBar').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  if (b.dataset.w) setWeather(+b.dataset.w); else if (b.dataset.a === 'bolt') bolt((Math.random() - 0.5) * 0.9); else if (b.dataset.a === 'hist') showChron(chronEl.hidden); else surface();
});
window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'c' && entered) return showChron(chronEl.hidden);
  if (k === 'Escape') showChron(false);
  if (!landOn() || !setEl.hidden || !savesEl.hidden) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'd'].includes(k)) { // held, it turns steadily; tapped, it gives a nudge
    if (!e.repeat && k !== 'ArrowUp' && k !== 'ArrowDown') { land.panV += (k === 'ArrowRight' || k === 'd' ? 0.7 : -0.7); land.panAt = performance.now() / 1000; }
    if (!e.repeat && (k === 'ArrowUp' || k === 'ArrowDown')) land.sunY = THREE.MathUtils.clamp(land.sunY + (k === 'ArrowUp' ? 0.02 : -0.02), 0.12, 0.95);
    landKeys.add(k); e.preventDefault();
  }
  else if (k >= '1' && k <= '4') setWeather(+k - 1);
  else if (k === ' ') { setWeather((land.weather + 1) % WEATHER.length); e.preventDefault(); }
  else if (k === 'l' && !e.repeat) bolt(landMouse);
});
window.addEventListener('keyup', e => landKeys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
window.addEventListener('blur', () => landKeys.clear());

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
let onLand = false, landCost = 0;
function setRatio(r) { pixelRatio = r; renderer.setPixelRatio(r); composer.setPixelRatio(r); resize(); perfT = perfN = 0; }
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, rawDt = now - last, dt = Math.min(0.05, rawDt);
  last = now;
  // on a device that cannot keep up, trade resolution for smoothness
  if (mode === 'camera' && rawDt < 0.25 && settings.res === 'auto') {
    perfT += rawDt; perfN++;
    if (perfT >= 2) {
      if (perfN / perfT < 38 && pixelRatio > 0.75) {
        const to = Math.max(0.75, pixelRatio - 0.25);
        if (onLand) landCost += pixelRatio - to; // the landscape is far heavier to draw than space: what it costs is given back on leaving
        setRatio(to);
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
  updateLand(dt, now);
  updateLife(dt);
  updateShips(dt, now);
  if (onLand !== (E4 > 0.5)) { onLand = !onLand; if (landCost && settings.res === 'auto') setRatio(onLand ? Math.max(0.75, pixelRatio - landCost) : pixelRatio + landCost); }
  bloom.strength = (0.85 - 0.6 * E3 - 0.07 * E4) * settings.glow; // close to a planet the glow would wash its surface out
  updateParticles(dt);
  updateAmbient(dt);

  for (const g in chips) {
    const names = g.split(' ');
    chips[g].classList.toggle('active', g === 'nebula' ? drawing : g === 'zoom' ? zoomShow
      : !(drawing && g === 'point') && ((L.active && names.includes(L.gesture)) || (R.active && names.includes(R.gesture))));
  }

  // name the star or planet being grown, as it passes from one kind to the next
  const maker = [L, R].find(h => h.active && h.grab && h.grab.growing);
  if (maker) note(titleOf(maker.grab), 0.5);
  else if (noteT > 0 && (noteT -= dt) <= 0) noteEl.classList.remove('on');
  if (saveT > 0 && (saveT -= dt) <= 0) saveUniverse();

  // gentle parallax toward the hands
  let tx = 0, ty = 0, n = 0;
  if (level < 4) for (const h of [L, R]) if (h.active) { tx += h.pos.x; ty += h.pos.y; n++; }
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
  get mode() { return mode; }, get level() { return level; }, get depth() { return depth; }, get focusG() { return focusG; }, get focusS() { return focusS; }, get focusP() { return focusP; }, properName, titleOf, get land() { return land; }, get E4() { return E4; }, enterLand, landMat, lifeMat, lifeMesh, artCanvas, folk, chron, ships, launch, reach, setWeather, bolt, updateLife, showChron, T, lifeOf, measureLife, get terrainOf() { return terrainOf; }, get globeR() { return globeR; }, globePoint, mapH,
  get at() { return at; },
  go(gi, si, pi) { focusG = galaxies[gi]; focusS = focusG.stars[si]; focusP = pi == null ? null : focusS.planets[pi]; setLevel(pi == null ? 2 : 3); depth = level; }, // straight to a star or a planet
  pose(key, x, y, gesture, tipX = x, tipY = y, size = 1) {
    const h = hands[key], fresh = !h.active; h.size = size;
    h.prevPos.copy(h.pos); h.pos.set(x, y, 0); h.hasJoints = false; h.pinchPt.set(x, y, 0);
    for (const t of h.tips) t.set(tipX, tipY, 0);
    h.setPose(performance.now() / 1000, 1 / 60, gesture, fresh);
  } };
