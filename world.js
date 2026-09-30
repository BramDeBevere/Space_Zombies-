// World — renderer, scene, camera, lights and the night arena.
import * as THREE from 'three';

// --- Tunable constants (arena / player) ---
export const ARENA_HALF = 42;          // arena is [-42, 42] on X and Z
const WALL_HEIGHT = 5;
export const EYE_HEIGHT = 1.7;         // camera height above the player's feet
export const PLAYER_RADIUS = 0.6;

// --- Renderer ---
const app = document.getElementById('app');
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
app.appendChild(renderer.domElement);

// --- Scene ---
export const scene = new THREE.Scene();
scene.background = makeSkyTexture();
scene.fog = new THREE.FogExp2(0x0b1119, 0.022);

// --- Camera ---
export const camera = new THREE.PerspectiveCamera(
  72, window.innerWidth / window.innerHeight, 0.1, 500
);
camera.position.set(0, EYE_HEIGHT, 0);

// --- Moonlight (single cool directional + soft hemisphere fill) ---
scene.add(new THREE.HemisphereLight(0x243049, 0x05070a, 0.7));
const moon = new THREE.DirectionalLight(0x8fb2ff, 1.1);
moon.position.set(-30, 50, 20);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
moon.shadow.camera.near = 1;
moon.shadow.camera.far = 140;
moon.shadow.camera.left = -ARENA_HALF;
moon.shadow.camera.right = ARENA_HALF;
moon.shadow.camera.top = ARENA_HALF;
moon.shadow.camera.bottom = -ARENA_HALF;
moon.shadow.bias = -0.0008;
scene.add(moon);
scene.add(moon.target);

// --- Arena floor (generated grid texture — no external assets) ---
{
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const base = ctx.createLinearGradient(0, 0, 0, size);
  base.addColorStop(0, '#161b22');
  base.addColorStop(1, '#10151b');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // faint speckle for texture
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const s = Math.random() * 2;
    ctx.fillStyle = `rgba(${255 + Math.floor(Math.random() * 40)},${255 + Math.floor(Math.random() * 40)},255,${Math.random() * 0.05})`;
    ctx.fillRect(x, y, s, s);
  }

  ctx.strokeStyle = 'rgba(120,150,190,0.10)';
  ctx.lineWidth = 2;
  const step = size / 16;
  for (let i = 0; i <= 16; i++) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(p, size); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
    new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.92, metalness: 0.0,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}

// --- Arena walls (one ring of 4 boxes) + crates to break up the space ---
{
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x2a3340, roughness: 0.85, metalness: 0.1,
  });
  const wallGeo = new THREE.BoxGeometry(ARENA_HALF * 2, WALL_HEIGHT, 1);

  const walls = [
    { pos: [0, WALL_HEIGHT / 2, -ARENA_HALF], rot: 0 },
    { pos: [0, WALL_HEIGHT / 2, ARENA_HALF], rot: 0 },
    { pos: [-ARENA_HALF, WALL_HEIGHT / 2, 0], rot: Math.PI / 2 },
    { pos: [ARENA_HALF, WALL_HEIGHT / 2, 0], rot: Math.PI / 2 },
  ];
  for (const w of walls) {
    const m = new THREE.Mesh(wallGeo, wallMat);
    m.position.set(...w.pos);
    m.rotation.y = w.rot;
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }

  // A few low crates (also visual only).
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x4a4136, roughness: 0.9 });
  const cratePositions = [
    [-14, -10], [18, 6], [-6, 22], [10, -24], [-26, 14], [24, 24],
  ];
  for (const [x, z] of cratePositions) {
    const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), crateMat);
    crate.position.set(x, 1, z);
    crate.rotation.y = Math.random() * Math.PI;
    crate.castShadow = true;
    crate.receiveShadow = true;
    scene.add(crate);
  }
}

// --- Ring of dim "street lights" for atmosphere (no real lighting cost) ---
{
  const postMat = new THREE.MeshStandardMaterial({ color: 0x1c222b, roughness: 0.7 });
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x11131a, emissive: 0xffcf87, emissiveIntensity: 2.2,
  });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * (ARENA_HALF - 3);
    const z = Math.sin(a) * (ARENA_HALF - 3);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 6, 8), postMat);
    post.position.set(x, 3, z);
    post.castShadow = true;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 12), bulbMat);
    bulb.position.set(x, 6, z);
    scene.add(post, bulb);
  }
}

// --- Sky texture (gradient + a moon) — generated, no asset file ---
function makeSkyTexture() {
  const w = 256, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#05070c');
  g.addColorStop(0.5, '#0a1020');
  g.addColorStop(1, '#101a2c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // a soft moon
  const mx = w * 0.72, my = h * 0.28, r = 22;
  const moon = ctx.createRadialGradient(mx, my, 2, mx, my, r);
  moon.addColorStop(0, 'rgba(230,238,255,0.95)');
  moon.addColorStop(0.5, 'rgba(180,200,240,0.5)');
  moon.addColorStop(1, 'rgba(120,150,200,0)');
  ctx.fillStyle = moon;
  ctx.fillRect(0, 0, w, h);

  // stars
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h * 0.7;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.8})`;
    const s = Math.random() * 1.6 + 0.2;
    ctx.fillRect(x, y, s, s);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
