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
const aSize = new Float32Array(AMB), aFade = new Float32Array(AMB);
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
  for (let i = 0; i < AMB; i++) {
    const j = i * 3, x = aPos[j], y = aPos[j + 1], z = aPos[j + 2];
    let ax = (aHome[j] - x) * k, ay = (aHome[j + 1] - y) * k, az = (aHome[j + 2] - z) * k;
    for (let w = 0; w < nw; w++) {
      const W = wells[w], dx = W.x - x, dy = W.y - y, dz = W.z - z;
      if (W.g < 0) { // repel (open hand): stars part around it
        const d2 = dx * dx + dy * dy + dz * dz + 0.3, a = W.g / (d2 * Math.sqrt(d2));
        ax += dx * a; ay += dy * a; az += dz * a;
        continue;
      }
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-3;
      if (W.range && d > W.range) continue;
      // pull onto a ring of radius r0 around the well, flatten into its plane, and swirl
      const m = Math.max(W.g * (d - W.r0) / ((d + 0.5) * d), -W.g * 0.5), s = W.swirl / (d + 0.6);
      ax += (dx * m - dy * s) / d; ay += (dy * m + dx * s) / d; az += dz * 1.5;
    }
    const vx = (aVel[j] + ax * dt) * drag, vy = (aVel[j + 1] + ay * dt) * drag, vz = (aVel[j + 2] + az * dt) * drag;
    aVel[j] = vx; aVel[j + 1] = vy; aVel[j + 2] = vz;
    aPos[j] = x + vx * dt; aPos[j + 1] = y + vy * dt; aPos[j + 2] = z + vz * dt;
    aFade[i] = Math.min(2, 0.55 + Math.sqrt(vx * vx + vy * vy + vz * vz) * 0.12); // moving stars glow
  }
  aGeo.attributes.position.needsUpdate = true;
  aGeo.attributes.aFade.needsUpdate = true;
}

// ---------------------------------------------------------------- effects
function burst(p, power, vel) {
  const sp = 6 + 15 * power;
  for (let i = 0; i < AMB; i++) { // fling the background stars
    const j = i * 3, dx = aPos[j] - p.x, dy = aPos[j + 1] - p.y, dz = aPos[j + 2] - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 7) continue;
    const k = sp * (0.6 + Math.random() * 0.8) / (d + 0.4) / (d + 0.05);
    aVel[j] += dx * k; aVel[j + 1] += dy * k; aVel[j + 2] += dz * k * 0.5;
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
  const n = Math.floor(1500 + 5000 * power);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, z = Math.random() * 2 - 1, s = Math.sqrt(1 - z * z);
    const dx = s * Math.cos(a), dy = s * Math.sin(a), dz = z * 0.6;
    const v = sp * (0.12 + 0.88 * Math.cbrt(Math.random()));
    pickColor(Math.random() < 0.15 ? 0.7 : 0);
    spawn(p.x + dx * 0.1, p.y + dy * 0.1, p.z + dz * 0.1, dx * v + vel.x * 0.3, dy * v + vel.y * 0.3, dz * v,
      cr, cg, cb, 1.2 + Math.random() * 2.8, 0.05 + Math.random() * 0.1);
  }
  ring(p, 500 + 1500 * power, sp * 1.3, 0.6);
}

function ring(p, n, speed, whiten) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.96 + Math.random() * 0.08);
    pickColor(whiten);
    spawn(p.x, p.y, p.z, Math.cos(a) * v, Math.sin(a) * v, (Math.random() - 0.5) * 0.4,
      cr, cg, cb, 0.8 + Math.random() * 0.6, 0.07);
  }
}

// --- galaxies (GPU-animated spiral, one draw call each)
const GALAXY_N = 5000;
const galaxyGeo = (() => {
  const data = new Float32Array(GALAXY_N * 4);
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  for (let i = 0; i < GALAXY_N; i++) {
    let r, ang, h;
    if (Math.random() < 0.18) { r = Math.random() * 0.2; ang = Math.random() * 6.283; h = gauss() * 0.07; }
    else {
      r = 0.05 + Math.pow(Math.random(), 1.5) * 0.95;
      ang = ((i % 3) / 3) * 6.283 + r * 4.5 + gauss() * 0.45 * (1 - r * 0.5);
      h = gauss() * 0.035;
    }
    data.set([r, ang, h, Math.random()], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GALAXY_N * 3), 3));
  g.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  return g;
})();

function makeGalaxy() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPx, uTime: { value: 0 }, uAlpha: { value: 0 }, uSize: { value: 1 },
      uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() } },
    vertexShader: /* glsl */`
      attribute vec4 aData;
      uniform float uPx, uTime, uAlpha, uSize; uniform vec3 uA, uB;
      varying vec3 vColor;
      void main() {
        float r = aData.x;
        float ang = aData.y + uTime * (0.35 + 0.25 / (0.3 + r));
        vec3 p = vec3(cos(ang) * r, aData.z, sin(ang) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.025 + 0.05 * aData.w) * uSize * uPx / max(0.1, -mv.z);
        vec3 arm = mix(uA, uB, aData.w);
        vColor = mix(vec3(1.0, 0.92, 0.75), arm, smoothstep(0.05, 0.45, r)) * uAlpha * (0.2 + 0.35 * aData.w);
      }`,
    fragmentShader: SPRITE_FRAG,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
  });
  const points = new THREE.Points(galaxyGeo, mat);
  points.frustumCulled = false; points.visible = false;
  scene.add(points);
  return { points, mat, alive: false, held: false, age: 0, grow: 0, vel: new THREE.Vector3() };
}
const galaxies = Array.from({ length: 5 }, makeGalaxy);

function acquireGalaxy(p) {
  let g = galaxies.find(x => !x.alive);
  if (!g) g = galaxies.filter(x => !x.held).sort((a, b) => b.age - a.age)[0];
  if (!g) return null;
  g.alive = true; g.held = true; g.age = 0; g.grow = 0; g.vel.set(0, 0, 0);
  g.points.visible = true; g.points.position.copy(p);
  g.points.rotation.set(0.7 + Math.random() * 0.5, 0, (Math.random() - 0.5) * 1.0);
  g.mat.uniforms.uA.value.copy(palette[0]); g.mat.uniforms.uB.value.copy(palette[1 + ((Math.random() * 2) | 0)]);
  return g;
}

const GALAXY_LIFE = 16;
function updateGalaxies(dt) {
  for (const g of galaxies) {
    if (!g.alive) continue;
    g.age += dt;
    if (g.held) { g.grow += dt; g.age = 0; }
    else {
      g.points.position.addScaledVector(g.vel, dt);
      g.vel.multiplyScalar(Math.exp(-0.6 * dt));
      if (g.age > GALAXY_LIFE) { g.alive = false; g.points.visible = false; continue; }
    }
    const scale = 0.25 + 2.3 * (1 - Math.exp(-g.grow / 1.6));
    g.points.scale.setScalar(scale);
    g.mat.uniforms.uSize.value = 0.6 + scale * 0.5;
    g.mat.uniforms.uTime.value += dt * (g.held ? 2.2 : 1);
    const fadeIn = Math.min(1, g.grow * 3), fadeOut = g.held ? 1 : Math.min(1, (GALAXY_LIFE - g.age) / 3);
    g.mat.uniforms.uAlpha.value = fadeIn * fadeOut;
  }
}

// --- portal
const portalMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uOpen: { value: 0 },
    uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    varying vec2 vUv; uniform float uTime, uOpen; uniform vec3 uA, uB, uC;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<5;i++){ v += a*noise(p); p = p*2.03 + 17.0; a *= 0.5; } return v; }
    void main(){
      vec2 p = (vUv - 0.5) * 2.8;           // rim sits at r = 1
      float r = length(p), a = atan(p.y, p.x);
      float sw = a + uTime * 0.9 + 2.2 * log(r + 0.08);
      float depth = 1.1 / (r + 0.22) + uTime * 0.8;
      float n = fbm(vec2(cos(sw), sin(sw)) * 1.7 + depth * vec2(0.8, 0.6));
      float inside = smoothstep(1.0, 0.86, r);
      vec3 tunnel = mix(uC, uA, smoothstep(0.0, 0.9, r)) * pow(n, 1.8) * 1.5 * inside;
      tunnel += vec3(1.0, 0.95, 0.9) * 0.004 / (r * r + 0.01) * inside;
      float flick = 0.55 + 0.9 * fbm(vec2(cos(a + uTime * 1.7), sin(a + uTime * 1.7)) * 3.0 + uTime * 0.5);
      float rim = exp(-pow((r - 1.0) / 0.055, 2.0)) * flick;
      float wisps = exp(-max(r - 1.0, 0.0) * 5.0) * step(1.0, r) * n * 0.9;
      vec3 col = tunnel + uB * rim * 1.5 + uA * wisps * 0.6;
      gl_FragColor = vec4(col * uOpen, 1.0);
    }`,
  blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
});
const portal = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), portalMat);
portal.visible = false;
scene.add(portal);
let portalOpen = 0, portalRadius = 1;

function updatePortal(dt, active, a, b) {
  portalOpen += ((active ? 1 : 0) - portalOpen) * Math.min(1, dt * (active ? 5 : 3.5));
  portal.visible = portalOpen > 0.01;
  if (active) {
    const target = Math.max(0.7, a.distanceTo(b) / 2);
    portalRadius += (target - portalRadius) * Math.min(1, dt * 8);
    portal.position.lerpVectors(a, b, 0.5); portal.position.z = -0.2;
    // background stars get drawn onto the rim and race around it
    wells.push({ x: portal.position.x, y: portal.position.y, z: 0, g: 16, r0: portalRadius * 1.05, swirl: 12, strong: true });
    // sparks racing around the rim
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), v = 3 + Math.random() * 3;
      pickColor(0.3);
      spawn(portal.position.x + c * portalRadius, portal.position.y + s * portalRadius, 0,
        -s * v + c * (Math.random() - 0.3) * 2, c * v + s * (Math.random() - 0.3) * 2, (Math.random() - 0.5),
        cr, cg, cb, 0.5 + Math.random() * 0.9, 0.04 + Math.random() * 0.05);
    }
  }
  if (!portal.visible) return;
  portal.scale.setScalar(portalRadius * (0.3 + 0.7 * portalOpen));
  portal.rotation.z += dt * 0.15;
  const u = portalMat.uniforms;
  u.uTime.value += dt; u.uOpen.value = portalOpen;
  u.uA.value.copy(palette[0]); u.uB.value.copy(palette[1]); u.uC.value.copy(palette[2]);
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
      this.gesture = this.cand = this.lastSolid = 'none'; this.candN = 0; this.charge = 0;
    }
    this.active = true; this.lastSeen = now;
    if (dt > 0) {
      _v.subVectors(this.pos, this.prevPos).divideScalar(dt);
      this.vel.lerp(_v, 0.35);
    }
    if (rawGesture === this.cand) this.candN++; else { this.cand = rawGesture; this.candN = 1; }
    this.prevGesture = this.gesture;
    if (this.candN >= T.holdFrames) this.gesture = this.cand;
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
      this.galaxy.held = false;
      this.galaxy.vel.copy(this.vel).multiplyScalar(0.35).clampLength(0, 5);
      this.galaxy = null;
    }
  }

  deactivate() { this.release(); this.active = false; this.gesture = 'none'; this.charge = 0; }

  act(now, dt, portalActive) {
    const g = this.gesture, p = this.pos;
    if (g !== 'pinch') this.release();
    if (g !== 'fist') this.charge = Math.max(0, this.charge - dt * 1.6);

    if (g === 'open') {
      if (this.lastSolid !== 'open' && now - this.lastBurst > 0.5) {
        if (!portalActive || this.charge > 0.3) burst(p, Math.max(0.12, this.charge), this.vel);
        this.lastBurst = now; this.charge = 0;
      }
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
      this.charge = Math.min(1, this.charge + dt / 2.2);
      // pulls the background stars (and any loose sparks) into a spinning disc around the fist
      wells.push({ x: p.x, y: p.y, z: p.z, g: 30 + 40 * this.charge, r0: 0.45 + 0.5 * this.charge, swirl: 12, strong: true, fist: true });
      pickColor(0.8); // hot core
      spawn(p.x + rnd(0.05), p.y + rnd(0.05), p.z, 0, 0, 0, cr * 0.4, cg * 0.4, cb * 0.4, 0.2, 0.3 + 0.6 * this.charge);
    } else if (g === 'pinch') {
      if (!this.galaxy) this.galaxy = acquireGalaxy(this.pinchPt);
      if (this.galaxy) {
        this.galaxy.points.position.lerp(this.pinchPt, Math.min(1, dt * 14));
        const q = this.pinchPt, r = this.galaxy.points.scale.x; // nearby stars fall into orbit
        wells.push({ x: q.x, y: q.y, z: q.z, g: 6, r0: r * 0.9, swirl: 5, range: 2 + r * 1.5 });
      }
    } else if (g === 'point') {
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
const _v = new THREE.Vector3();
const rnd = s => (Math.random() - 0.5) * 2 * s;
const hands = { Left: new Hand(), Right: new Hand() };

function setPalette(i) {
  paletteIndex = ((i % PALETTES.length) + PALETTES.length) % PALETTES.length;
  palette = PALETTES[paletteIndex].colors;
  paletteEl.textContent = PALETTES[paletteIndex].name;
}

// ---------------------------------------------------------------- gesture recognition
function classify(lm, aspect, wasPinch) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y, (lm[a].z - lm[b].z) * aspect);
  const size = d(0, 9) || 1e-6;
  const curl = [[8, 5], [12, 9], [16, 13], [20, 17]].map(([tip, mcp]) => d(tip, 0) / (d(mcp, 0) || 1e-6));
  const ext = curl.map(c => c > T.extended), bent = curl.map(c => c < T.curled);
  if (bent.every(Boolean)) return 'fist';
  if (d(4, 8) / size < (wasPinch ? T.pinchOff : T.pinchOn)) return 'pinch';
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
  hintEl.textContent = 'Stand back so the camera sees your hands · V toggles the camera preview';
}

function trackCamera(now, dt) {
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, performance.now());
  const sides = res.handedness || res.handednesses || [];
  const aspect = video.videoWidth / video.videoHeight || 16 / 9;
  const used = new Set();
  (res.landmarks || []).forEach((lm, i) => {
    let key = sides[i]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right';
    if (used.has(key)) key = key === 'Left' ? 'Right' : 'Left';
    if (used.has(key)) return;
    used.add(key);
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
    h.pinchPt.lerpVectors(h.joints[4], h.joints[8], 0.5);
    h.setPose(now, dt, classify(lm, aspect, h.gesture === 'pinch'), fresh);
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
setPalette(0);

// ---------------------------------------------------------------- main loop
let last = performance.now() / 1000, idleT = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000, dt = Math.min(0.05, now - last);
  last = now;
  wells.length = 0;

  if (mode === 'camera') trackCamera(now, dt);
  else { // attract mode behind the intro screen
    idleT += dt;
    if (idleT > 2.6) { idleT = 0; _v.set(rnd(viewW * 0.4), rnd(viewH * 0.35), -2); burst(_v, 0.1 + Math.random() * 0.25, new THREE.Vector3()); setPalette(paletteIndex + 1); }
  }

  const L = hands.Left, R = hands.Right;
  for (const h of [L, R]) {
    if (h.active && now - h.lastSeen > 0.35) h.deactivate();
  }
  const portalActive = L.active && R.active && L.gesture === 'open' && R.gesture === 'open';
  for (const h of [L, R]) { if (h.active) h.act(now, dt, portalActive); h.drawSkeleton(); }

  updatePortal(dt, portalActive, L.pos, R.pos);
  updateGalaxies(dt);
  updateParticles(dt);
  updateAmbient(dt);

  for (const g in chips) chips[g].classList.toggle('active',
    g === 'portal' ? portalActive : !portalActive && ((L.active && L.gesture === g) || (R.active && R.gesture === g)));

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

window.__universe = { hands, burst, setPalette, get mode() { return mode; } };
