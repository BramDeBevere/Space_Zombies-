// Dead Arena — a tiny 3D first-person zombie survival game.
// Pure Three.js from a pinned CDN (see index.html import map). No build step,
// no npm, no external asset files — every mesh is generated at runtime.

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------
const ARENA_HALF = 42;          // arena is [-42, 42] on X and Z
const WALL_HEIGHT = 5;
const EYE_HEIGHT = 1.7;         // camera height above the player's feet
const PLAYER_RADIUS = 0.6;
const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;
const ZOMBIE_RADIUS = 0.6;
const ZOMBIE_SPEED = 3.2;
const ZOMBIE_ACCEL = 2.2;       // how quickly the zombie speeds up (chase)
const ZOMBIE_KNOCKBACK = 12;    // player push when a zombie reaches you
const ZOMBIE_HP = 100;
const HIT_RANGE = 1.5;          // horizontal distance within which the zombie can hit
const HIT_COOLDOWN = 0.8;      // seconds between zombie bites
const ZOMBIE_HIT_DAMAGE = 12;

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const vignette = document.getElementById('vignette');
const healthFill = document.getElementById('healthfill');
const hpValue = document.getElementById('hpvalue');
const timerValue = document.getElementById('timer');
const distanceValue = document.getElementById('distance');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = makeSkyTexture();
scene.fog = new THREE.FogExp2(0x0b1119, 0.022);

const camera = new THREE.PerspectiveCamera(
  72, window.innerWidth / window.innerHeight, 0.1, 500
);
camera.position.set(0, EYE_HEIGHT, 0);

// ---------------------------------------------------------------------------
// Controls — PointerLockControls gives us mouse look for free.
// Movement is handled manually so we can do WASD + sprint + collision.
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
const keys = {};

window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});

// ---------------------------------------------------------------------------
// Lights — a single cool moonlight + a warm flashlight the player carries.
// ---------------------------------------------------------------------------
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

const flashlight = new THREE.SpotLight(0xfff2cf, 6, 55, Math.PI / 5.5, 0.5, 1.2);
scene.add(flashlight);
scene.add(flashlight.target);

// A tiny point light on the flashlight barrel so the hand is readable.
const lampGlow = new THREE.PointLight(0xffd9a0, 0.6, 6, 2);
scene.add(lampGlow);

// ---------------------------------------------------------------------------
// Arena floor (generated grid texture — no external assets)
// ---------------------------------------------------------------------------
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
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
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

// Arena walls (one ring, built from 4 boxes) + corner pillars.
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

  // A few low crates to break up the open space (also visual only).
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

// A ring of dim "street lights" for atmosphere (no real lighting cost).
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

// ---------------------------------------------------------------------------
// Player (camera rig) — we track feet position for movement + collision.
// ---------------------------------------------------------------------------
const player = {
  feet: new THREE.Vector3(0, 0, 0), // camera = feet + (0, EYE_HEIGHT, 0)
  velocity: new THREE.Vector3(),
  hp: ZOMBIE_HP,
};

// ---------------------------------------------------------------------------
// The zombie — a small group of boxes shaped like a shambling figure.
// ---------------------------------------------------------------------------
const zombie = createZombie();
zombie.group.position.set(28, 0, 28); // start far from the player
zombie.velocity = new THREE.Vector3();
zombie.hp = ZOMBIE_HP;
zombie.hitTimer = 0;
scene.add(zombie.group);

function createZombie() {
  const group = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({ color: 0x4f6b45, roughness: 0.95 });
  const tunic = new THREE.MeshStandardMaterial({ color: 0x2f3a30, roughness: 1.0 });
  const bone = new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.42), tunic);
  body.position.y = 1.05;
  body.castShadow = true;

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), skin);
  head.position.y = 1.75;
  head.castShadow = true;

  const armGeo = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  const armL = new THREE.Mesh(armGeo, skin);
  armL.position.set(-0.45, 1.15, 0);
  armL.castShadow = true;
  const armR = new THREE.Mesh(armGeo, skin);
  armR.position.set(0.45, 1.15, 0);
  armR.castShadow = true;

  const legGeo = new THREE.BoxGeometry(0.2, 0.8, 0.2);
  const legL = new THREE.Mesh(legGeo, tunic);
  legL.position.set(-0.18, 0.4, 0);
  legL.castShadow = true;
  const legR = new THREE.Mesh(legGeo, tunic);
  legR.position.set(0.18, 0.4, 0);
  legR.castShadow = true;

  // A single glowing red "eye" so it reads as hostile in the dark.
  const eye = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x1a0000, emissive: 0xff2a2a, emissiveIntensity: 3 })
  );
  eye.position.set(0, 1.78, 0.24);

  group.add(body, head, armL, armR, legL, legR, eye);
  group.userData.parts = { armL, armR, legL, legR, head, body };
  return group;
}

// ---------------------------------------------------------------------------
// First-person flashlight + hand (parented to the camera so it follows look).
// ---------------------------------------------------------------------------
const handGroup = new THREE.Group();
{
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.07, 0.42, 14),
    new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.5, metalness: 0.6 })
  );
  barrel.rotation.x = Math.PI / 2; // point forward (-Z in camera space)
  const muzzle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.06, 14),
    new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffcf87, emissiveIntensity: 1.4 })
  );
  muzzle.position.z = -0.24;
  muzzle.rotation.x = Math.PI / 2;

  const hand = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.16, 0.12),
    new THREE.MeshStandardMaterial({ color: 0xc9a07a, roughness: 0.9 })
  );
  hand.position.set(0.02, -0.06, 0.02);

  handGroup.add(barrel, muzzle, hand);
  handGroup.position.set(0.34, -0.34, -0.6);
  handGroup.rotation.y = -0.12;
  lampGlow.position.copy(handGroup.position); // place glow with the barrel
  camera.add(handGroup);
}
scene.add(camera); // ensure camera (and its children) is part of the scene

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let playing = false;
let dead = false;
let survived = 0;          // seconds of survival
let lastTime = performance.now();

// ---------------------------------------------------------------------------
// Overlay / pointer-lock flow
// ---------------------------------------------------------------------------
function showOverlay(title, sub) {
  overlay.querySelector('h1').innerHTML = title;
  const p = overlay.querySelector('p');
  if (p) p.innerHTML = sub;
  overlay.querySelector('.cta').textContent = dead ? 'Click to try again' : 'Click to play';
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
}

function startGame() {
  dead = false;
  playing = true;
  player.hp = ZOMBIE_HP;
  player.feet.set(0, 0, 0);
  player.velocity.set(0, 0, 0);
  zombie.group.position.set(28, 0, 28);
  zombie.velocity.set(0, 0, 0);
  zombie.hp = ZOMBIE_HP;
  survived = 0;
  vignette.style.opacity = 0;
  hideOverlay();
  controls.lock();
}

controls.addEventListener('lock', () => {
  if (!dead) hideOverlay();
});
controls.addEventListener('unlock', () => {
  playing = false;
  if (!dead) showOverlay(
    'DEAD<span class="sub"> ARENA</span>',
    'Paused. Click to resume.'
  );
});

overlay.addEventListener('click', () => {
  if (dead) resetAndPlay();
  else if (!controls.isLocked) controls.lock();
});

function resetAndPlay() {
  startGame();
}

function die() {
  dead = true;
  playing = false;
  controls.unlock();
  vignette.style.opacity = 1;
  const t = formatTime(survived);
  showOverlay(
    '<span id="dead-title">YOU DIED</span>',
    `The zombie got you after <b>${t}</b> of survival.`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _toZombie = new THREE.Vector3();

function clampToArena(p) {
  const lim = ARENA_HALF - PLAYER_RADIUS;
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function updateHUD() {
  const pct = Math.max(0, player.hp) / ZOMBIE_HP;
  healthFill.style.width = `${pct * 100}%`;
  healthFill.style.background =
    pct > 0.5 ? 'linear-gradient(90deg,#28d17a,#58f0a0)'
      : pct > 0.25 ? 'linear-gradient(90deg,#e0a83a,#ffd36e)'
        : 'linear-gradient(90deg,#c0392b,#ff6b5e)';
  hpValue.textContent = `${Math.max(0, Math.round(player.hp))} / ${ZOMBIE_HP}`;
  timerValue.textContent = formatTime(survived);
  const dx = zombie.group.position.x - player.feet.x;
  const dz = zombie.group.position.z - player.feet.z;
  const dist = Math.hypot(dx, dz);
  distanceValue.textContent = `${dist.toFixed(1)}m`;
}

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------
function update(dt) {
  // --- Player movement (WASD relative to camera yaw) ---
  _forward.set(0, 0, 0);
  camera.getWorldDirection(_forward);
  _forward.y = 0;
  _forward.normalize();

  _right.set(0, 0, 0);
  _right.crossVectors(_forward, camera.up).normalize();

  _move.set(0, 0, 0);
  if (keys['KeyW']) _move.add(_forward);
  if (keys['KeyS']) _move.sub(_forward);
  if (keys['KeyD']) _move.add(_right);
  if (keys['KeyA']) _move.sub(_right);

  const sprinting = keys['ShiftLeft'] || keys['ShiftRight'];
  const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;
  if (_move.lengthSq() > 0) {
    _move.normalize().multiplyScalar(speed);
  }

  // Smoothly approach target velocity (slight inertia).
  player.velocity.lerp(_move, 1 - Math.pow(0.0001, dt));

  player.feet.addScaledVector(player.velocity, dt);
  clampToArena(player.feet);
  camera.position.set(player.feet.x, EYE_HEIGHT, player.feet.z);

  // --- Attach the flashlight to the camera (follows look + hand) ---
  flashlight.position.copy(camera.position);
  flashlight.target.position.copy(_forward);
  flashlight.target.position.addScaledVector(_forward, 10);
  flashlight.target.position.y -= 0.2;
  lampGlow.position.copy(camera.position).addScaledVector(_forward, 0.3);
  lampGlow.position.y -= 0.2;

  // --- Zombie chase ---
  _toZombie.set(
    player.feet.x - zombie.group.position.x,
    0,
    player.feet.z - zombie.group.position.z
  );
  const dist = _toZombie.length();
  _toZombie.normalize();

  // Zombie slowly accelerates up to ZOMBIE_SPEED while it has line of chase.
  const targetSpeed = ZOMBIE_SPEED * Math.min(1, dist / 6 + 0.4);
  zombie.velocity.addScaledVector(_toZombie, ZOMBIE_ACCEL * dt * targetSpeed);
  const vmax = Math.max(zombie.velocity.length(), targetSpeed);
  if (zombie.velocity.length() > vmax) zombie.velocity.setLength(vmax);
  // cap the speed
  if (zombie.velocity.length() > targetSpeed) zombie.velocity.setLength(targetSpeed);

  zombie.group.position.addScaledVector(zombie.velocity, dt);

  // Face the player while moving.
  if (zombie.velocity.lengthSq() > 0.01) {
    const targetAngle = Math.atan2(_toZombie.x, _toZombie.z);
    const cur = zombie.group.rotation.y;
    let delta = targetAngle - cur;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    zombie.group.rotation.y = cur + delta * Math.min(1, dt * 6);
  }

  // Simple limb shuffle.
  const t = performance.now() * 0.004;
  const p = zombie.group.userData.parts;
  p.armL.rotation.x = Math.sin(t) * 0.7;
  p.armR.rotation.x = -Math.sin(t) * 0.7;
  p.legL.rotation.x = -Math.sin(t) * 0.5;
  p.legR.rotation.x = Math.sin(t) * 0.5;
  p.head.rotation.x = Math.sin(t * 0.5) * 0.15;

  // Keep the zombie inside the arena too.
  const zlim = ARENA_HALF - ZOMBIE_RADIUS;
  zombie.group.position.x = Math.max(-zlim, Math.min(zlim, zombie.group.position.x));
  zombie.group.position.z = Math.max(-zlim, Math.min(zlim, zombie.group.position.z));

  // --- Attack: if the zombie is close enough, bite ---
  zombie.hitTimer = Math.max(0, zombie.hitTimer - dt);
  if (dist < HIT_RANGE && zombie.hitTimer <= 0) {
    player.hp -= ZOMBIE_HIT_DAMAGE;
    zombie.hitTimer = HIT_COOLDOWN;
    // Knock the player back.
    player.velocity.addScaledVector(_toZombie, -ZOMBIE_KNOCKBACK);
    // Flash the vignette.
    vignette.style.opacity = 0.9;
    setTimeout(() => { if (!dead) vignette.style.opacity = Math.max(0, 1 - player.hp / ZOMBIE_HP) * 0.5; }, 120);
  } else {
    vignette.style.opacity = Math.max(0, 1 - player.hp / ZOMBIE_HP) * 0.5;
  }

  if (player.hp <= 0 && !dead) die();

  // --- Survival timer ---
  if (playing && !dead) survived += dt;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  // Clamp dt to avoid big jumps after a tab switch / pause.
  dt = Math.min(dt, 0.05);

  if (controls.isLocked && playing) update(dt);
  else if (!dead) {
    // Idle: still animate the zombie's limbs so the scene feels alive.
    const t = performance.now() * 0.004;
    const p = zombie.group.userData.parts;
    p.armL.rotation.x = Math.sin(t * 0.4) * 0.3;
    p.armR.rotation.x = -Math.sin(t * 0.4) * 0.3;
  }

  updateHUD();
  renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// ---------------------------------------------------------------------------
// Sky texture (gradient + a moon) — generated, no asset file.
// ---------------------------------------------------------------------------
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
