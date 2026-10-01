// Weapon — first-person viewmodels + the shooting system (knife, pistol,
// rifle, sniper, shotgun, RPG). Raycast / pellet hits, tracers, muzzle flash,
// hit sparks, RPG rocket + explosion VFX, recoil, ammo + reload, sniper zoom.
import * as THREE from 'three';
import { camera, scene, ARENA_HALF, obstacles } from './world.js';
import { zombies } from './zombie.js';
import { playerMeshes, damageRemote } from './remotes.js';
import {
  sfxShot, sfxKnife, sfxShotgun, sfxSniper, sfxRPG, sfxExplosion, sfxReload, sfxKill,
} from './sound.js';

// --- Weapon definitions (fired in this order; index == 1-based hotkey) ---
// kind drives the fire path: 'melee' (knife) or a projectile. `spread` is the
// horizontal cone in radians; `pellets` fires that many bullets per shot
// (shotgun). `zoom` narrows the FOV while aiming (sniper).
const WEAPONS = [
  { id: 'knife',   name: 'KNIFE',    kind: 'melee',  dmg: 45,  speed: 2.6, range: 2.8, arc: 1.0, ammo: null, reload: 0 },
  { id: 'pistol',  name: 'PISTOL',   kind: 'bullet', dmg: 34,  speed: 4.4, cooldown: 0.18, ammo: 12, reload: 1.0, recoil: 0.03, spread: 0 },
  { id: 'rifle',   name: 'RIFLE',    kind: 'bullet', dmg: 22,  speed: 4.4, cooldown: 0.08, ammo: 30, reload: 1.6, recoil: 0.02, spread: 0.008, auto: true },
  { id: 'sniper',  name: 'SNIPER',   kind: 'bullet', dmg: 120, speed: 4.8, cooldown: 1.4,  ammo: 6,  reload: 2.4, recoil: 0.06, spread: 0, zoom: 22 },
  { id: 'shotgun', name: 'SHOTGUN',  kind: 'bullet', dmg: 16,  speed: 4.6, cooldown: 0.85, ammo: 8,  reload: 2.0, recoil: 0.05, spread: 0.06, pellets: 6 },
  { id: 'rpg',     name: 'RPG',      kind: 'rocket', dmg: 70,  speed: 9,   cooldown: 2.2,  ammo: 2,  reload: 2.6, recoil: 0.08, blast: 4.5 },
];
export const WEAPON_COUNT = WEAPONS.length;

const LIGHT_BASE = 8;         // resting flashlight intensity

// Ammo + reload + current-weapon state (reset on (re)start / respawn).
let current = 1;                              // default to the pistol (index 1)
const ammo = WEAPONS.map((w) => (w.ammo != null ? w.ammo : 0));
let reload = 0;                              // seconds remaining of a reload (0 = ready)

let fireNet = null;                          // (tracers, wId) => void — broadcast shot visuals
let netZombieDamage = false;                 // true in multi: host applies zombie damage
let pvpEnabled = true;                       // settings: allow player-vs-player damage
let fireCb = null;                           // async fire results (RPG blast) → routing
export function setFireCallback(fn) { fireCb = fn; }

const curW = () => WEAPONS[current];
const curAmmo = () => ammo[current];

const raycaster = new THREE.Raycaster();
const centerNDC = new THREE.Vector2(0, 0);
const glowTex = makeGlowTexture();
const tracerGeo = (() => {
  const g = new THREE.BoxGeometry(0.035, 0.035, 1);
  g.translate(0, 0, 0.5); // extend along +Z so lookAt(to) aims the far end at the target
  return g;
})();
const effects = [];
const rockets = [];           // in-flight RPG rockets
let BASE_FOV = camera.fov;          // base field of view (settings.js can retune it)
const _shootDir = new THREE.Vector3();

// settings.js: retune the base FOV the camera eases toward when not scoped.
export function setWeaponFov(v) {
  if (typeof v === 'number' && v > 0) BASE_FOV = v;
}

// --- Flashlight + lamp glow (parented to the camera so it follows look) ---
const flashlight = new THREE.SpotLight(0xfff2cf, LIGHT_BASE, 55, Math.PI / 5.5, 0.5, 1.2);
scene.add(flashlight);
scene.add(flashlight.target);
const lampGlow = new THREE.PointLight(0xffd9a0, 0.6, 6, 2);
scene.add(lampGlow);

// --- Viewmodel materials (shared, cheap) ---
const matDark = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.5, metalness: 0.6 });
const matSteel = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.4, metalness: 0.7 });
const matWood = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85 });
const matGreen = new THREE.MeshStandardMaterial({ color: 0x3c5240, roughness: 0.7, metalness: 0.2 });
const matMuzzle = new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffcf87, emissiveIntensity: 1.4 });
const matSkin = new THREE.MeshStandardMaterial({ color: 0xc9a07a, roughness: 0.9 });
const matBrass = new THREE.MeshStandardMaterial({ color: 0x8a6a2a, roughness: 0.5, metalness: 0.4 });
const matSight = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.4, metalness: 0.5 });
const matGlow = new THREE.MeshBasicMaterial({ color: 0xffb347 });

function box(w, h, d, mat) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }
function cyl(r, len, mat, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.rotation.x = Math.PI / 2; // barrel axis along -Z (forward in camera space)
  return m;
}

// --- Per-weapon viewmodel builders (camera space; -Z is forward) ---
function buildKnife() {
  const g = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.42), matSteel);
  blade.position.set(0, -0.02, -0.25);
  const guard = box(0.08, 0.05, 0.03, matBrass); guard.position.set(0, -0.02, -0.04);
  const grip = cyl(0.02, 0.12, matWood, 8); grip.position.set(0, -0.02, 0.06);
  const hand = box(0.12, 0.14, 0.12, matSkin); hand.position.set(0, -0.02, 0.02);
  g.add(blade, guard, grip, hand);
  return g;
}
function buildPistol() {
  const g = new THREE.Group();
  const muzzle = cyl(0.045, 0.05, matMuzzle); muzzle.position.set(0, 0, -0.4);
  const slide = box(0.09, 0.1, 0.36, matDark); slide.position.set(0, 0.02, -0.2);
  const grip = box(0.08, 0.16, 0.09, matWood); grip.position.set(0, -0.12, -0.02);
  const hand = box(0.12, 0.14, 0.14, matSkin); hand.position.set(0, -0.08, 0.04);
  g.add(muzzle, slide, grip, hand);
  return g;
}
function buildRifle() {
  const g = new THREE.Group();
  const muzzle = cyl(0.03, 0.05, matMuzzle); muzzle.position.set(0, 0.02, -0.82);
  const barrel = cyl(0.035, 0.6, matDark); barrel.position.set(0, 0.02, -0.5);
  const body = box(0.09, 0.12, 0.5, matGreen); body.position.set(0, 0, -0.2);
  const mag = box(0.06, 0.22, 0.1, matSteel); mag.position.set(0, -0.14, -0.2);
  const stock = box(0.07, 0.12, 0.2, matWood); stock.position.set(0, 0, 0.15);
  const front = box(0.02, 0.05, 0.02, matSight); front.position.set(0, 0.09, -0.6);
  const rear = box(0.02, 0.05, 0.02, matSight); rear.position.set(0, 0.09, -0.05);
  const hand = box(0.12, 0.14, 0.14, matSkin); hand.position.set(0, -0.1, -0.15);
  const hand2 = box(0.1, 0.12, 0.12, matSkin); hand2.position.set(0, -0.08, -0.5);
  g.add(muzzle, barrel, body, mag, stock, front, rear, hand, hand2);
  return g;
}
function buildSniper() {
  const g = new THREE.Group();
  const muzzle = cyl(0.035, 0.08, matMuzzle); muzzle.position.set(0, 0, -1.05);
  const barrel = cyl(0.04, 0.9, matDark); barrel.position.set(0, 0, -0.6);
  const body = box(0.1, 0.14, 0.6, matGreen); body.position.set(0, 0, -0.1);
  const stock = box(0.08, 0.14, 0.3, matWood); stock.position.set(0, 0, 0.25);
  const scope = cyl(0.05, 0.22, matSight); scope.position.set(0, 0.12, -0.2);
  const scopeL = cyl(0.055, 0.03, matSight); scopeL.position.set(0, 0.12, -0.08);
  const scopeR = cyl(0.055, 0.03, matSight); scopeR.position.set(0, 0.12, -0.32);
  const mag = box(0.06, 0.18, 0.1, matSteel); mag.position.set(0, -0.12, -0.2);
  const hand = box(0.1, 0.12, 0.12, matSkin); hand.position.set(0, -0.1, 0.2);
  const hand2 = box(0.1, 0.12, 0.12, matSkin); hand2.position.set(0, -0.08, -0.5);
  g.add(muzzle, barrel, body, stock, scope, scopeL, scopeR, mag, hand, hand2);
  return g;
}
function buildShotgun() {
  const g = new THREE.Group();
  const muzzle = cyl(0.05, 0.05, matMuzzle); muzzle.position.set(0, 0.03, -0.86);
  const barrel = cyl(0.05, 0.7, matDark); barrel.position.set(0, 0.03, -0.5);
  const barrel2 = cyl(0.045, 0.6, matSteel); barrel2.position.set(0, -0.03, -0.48);
  const body = box(0.1, 0.12, 0.3, matWood); body.position.set(0, 0, -0.1);
  const pump = box(0.09, 0.09, 0.2, matDark); pump.position.set(0, -0.04, -0.45);
  const stock = box(0.08, 0.13, 0.28, matWood); stock.position.set(0, 0, 0.16);
  const hand = box(0.12, 0.14, 0.14, matSkin); hand.position.set(0, -0.08, -0.4);
  const hand2 = box(0.12, 0.14, 0.14, matSkin); hand2.position.set(0, -0.08, 0.1);
  g.add(muzzle, barrel, barrel2, body, pump, stock, hand, hand2);
  return g;
}
function buildRPG() {
  const g = new THREE.Group();
  const muzzle = cyl(0.07, 0.08, matMuzzle); muzzle.position.set(0, 0, -1.0);
  const tube = cyl(0.08, 1.0, matDark); tube.position.set(0, 0, -0.5);
  const body = box(0.14, 0.14, 0.3, matGreen); body.position.set(0, 0, 0.05);
  const stock = box(0.1, 0.14, 0.25, matWood); stock.position.set(0, 0, 0.28);
  const grip = box(0.06, 0.14, 0.08, matDark); grip.position.set(0, -0.12, -0.15);
  const sight = box(0.05, 0.08, 0.05, matSight); sight.position.set(0, 0.1, -0.35);
  const rocket = cyl(0.07, 0.22, matSteel); rocket.position.set(0, 0, -1.12);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.1, 10), matGlow);
  nose.rotation.x = -Math.PI / 2; // apex forward (-Z)
  nose.position.set(0, 0, -1.26);
  const hand = box(0.12, 0.14, 0.14, matSkin); hand.position.set(0, -0.1, -0.15);
  const hand2 = box(0.12, 0.14, 0.14, matSkin); hand2.position.set(0, -0.08, 0.25);
  g.add(muzzle, tube, body, stock, grip, sight, rocket, nose, hand, hand2);
  return g;
}

// The viewmodel root (positioned by updateWeaponRig); each weapon group is a
// child and only the current one is visible.
const handGroup = new THREE.Group();
const builders = { knife: buildKnife, pistol: buildPistol, rifle: buildRifle, sniper: buildSniper, shotgun: buildShotgun, rpg: buildRPG };
const allViews = {};
for (const w of WEAPONS) {
  const g = builders[w.id]();
  g.visible = w.id === 'pistol'; // default weapon shows at load
  handGroup.add(g);
  allViews[w.id] = g;
}
handGroup.position.set(0.34, -0.34, -0.6);
handGroup.rotation.y = -0.12;
camera.add(handGroup);
scene.add(camera); // ensure camera (and its children) is part of the scene

// Muzzle world-space anchor per weapon (camera-local front of the barrel).
const MUZZLE = {
  knife: [0.30, -0.32, -0.55], pistol: [0.34, -0.34, -0.85], rifle: [0.32, -0.33, -1.05],
  sniper: [0.0, -0.28, -1.3], shotgun: [0.34, -0.33, -1.05], rpg: [0.36, -0.30, -1.25],
};
for (const w of WEAPONS) w._muzzle = new THREE.Vector3(...MUZZLE[w.id]);

// Show only the active weapon's viewmodel.
function applyView() {
  for (const w of WEAPONS) allViews[w.id].visible = (w === curW());
}

function spawnEffect(obj, ttl, fade = true) {
  obj.userData.ttl = ttl;
  obj.userData.maxLife = ttl;
  obj.userData.fade = fade;
  scene.add(obj);
  effects.push(obj);
}
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.userData.ttl -= dt;
    if (e.userData.ttl <= 0) {
      scene.remove(e);
      if (e.geometry) e.geometry.dispose();
      if (e.material) e.material.dispose();
      effects.splice(i, 1);
      continue;
    }
    const life = e.userData.ttl / e.userData.maxLife;
    if (e.userData.expand) e.scale.set(e.scale.x + e.userData.grow * dt, e.scale.y + e.userData.grow * dt, 1);
    if (e.userData.isLight) e.intensity = 30 * life;
    else if (e.userData.fade && e.material) e.material.opacity = life;
  }
}
function spawnTracer(from, to, color = 0xfff0c0, thick = false) {
  const dir = to.clone().sub(from);
  const mesh = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthTest: false,
  }));
  const s = thick ? 3.2 : 1; // rockets get a much fatter trail
  mesh.position.copy(from);
  mesh.scale.set(s, s, Math.max(0.001, dir.length()));
  mesh.lookAt(to);
  spawnEffect(mesh, 0.08);
}
function spawnMuzzleFlash(pos, scale = 0.6, color = 0xffe0a0) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthTest: false,
  }));
  s.position.copy(pos);
  s.scale.set(scale, scale, 1);
  spawnEffect(s, 0.07);
}
function spawnHitSpark(pos) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xff5a3a, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthTest: false,
  }));
  s.position.copy(pos);
  s.scale.set(0.45, 0.45, 1);
  spawnEffect(s, 0.12);
}
// Big fireball for the RPG: an additive flash + a decaying point light.
function spawnExplosion(pos, radius) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffb040, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthTest: false,
  }));
  s.position.copy(pos);
  s.scale.set(radius * 2.2, radius * 2.2, 1);
  s.userData.expand = true;
  s.userData.grow = radius * 4;
  spawnEffect(s, 0.35);
  const light = new THREE.PointLight(0xff9a3c, 30, radius * 5, 2);
  light.position.copy(pos);
  scene.add(light);
  light.userData = { ttl: 0.32, maxLife: 0.32, fade: true, isLight: true };
  effects.push(light);
}
// In-flight RPG rocket (a small glowing mesh that flies then detonates).
function spawnRpgRocket(muzzle, end, onImpact) {
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.42, 8),
    new THREE.MeshStandardMaterial({ color: 0x9aa2ac, roughness: 0.4, metalness: 0.6, emissive: 0x2a1608 })
  );
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xff9a3c, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthTest: false,
  }));
  flame.scale.set(0.5, 0.5, 1);
  const grp = new THREE.Group();
  grp.add(body);
  body.rotation.x = -Math.PI / 2; // nose forward
  grp.add(flame);
  grp.position.copy(muzzle);
  grp.lookAt(end);
  scene.add(grp);
  // Distance-based flight: the rocket advances at a constant speed and
  // detonates on the first thing it touches (see updateRockets), instead of
  // always flying the full pre-aimed distance.
  const total = muzzle.distanceTo(end);
  rockets.push({
    grp, from: muzzle.clone(), end: end.clone(),
    dir: end.clone().sub(muzzle).normalize(),
    dist: 0, total: Math.max(total, 1e-3),
    speed: Math.max(total, 1e-3) * 0.6,   // ~1.6s of travel, as before
    onImpact,
  });
}

// 2D (top-down) "did the rocket hit anything at point p?" — arena walls, world
// obstacles (same circle/box colliders the player uses), and live entities.
function rocketHit(p) {
  // Arena boundary walls.
  if (Math.abs(p.x) > ARENA_HALF - 0.5 || Math.abs(p.z) > ARENA_HALF - 0.5) return true;
  for (const o of obstacles) {
    if (o.box) {
      const nx = Math.max(o.x - o.halfX, Math.min(p.x, o.x + o.halfX));
      const nz = Math.max(o.z - o.halfZ, Math.min(p.z, o.z + o.halfZ));
      if (Math.hypot(p.x - nx, p.z - nz) < 0.15) return true;
    } else if (Math.hypot(p.x - o.x, p.z - o.z) < o.r + 0.15) {
      return true;
    }
  }
  const R = 0.9; // entity touch radius
  for (const z of zombies) {
    if (z.dead) continue;
    const zp = z.group.position;
    if (Math.hypot(p.x - zp.x, p.z - zp.z) < R) return true;
  }
  if (pvpEnabled) for (const r of playerMeshes()) {
    const gp = r.group.position;
    if (Math.hypot(p.x - gp.x, p.z - gp.z) < R) return true;
  }
  return false;
}

function updateRockets(dt) {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    r.dist += r.speed * dt;
    const segStart = Math.min(r.total, r.dist - r.speed * dt); // distance covered before this frame
    const step = Math.min(r.total, r.dist);
    // March only this frame's segment (segStart → step) in sub-steps so a fast
    // rocket can't tunnel through a thin wall; detonate at first contact.
    let hitAt = null;
    const n = Math.max(1, Math.ceil((step - segStart) / 0.2));
    for (let s = 1; s <= n; s++) {
      const d = segStart + (step - segStart) * (s / n);
      const px = r.from.x + r.dir.x * d;
      const pz = r.from.z + r.dir.z * d;
      if (rocketHit({ x: px, z: pz })) { hitAt = new THREE.Vector3(px, r.from.y + r.dir.y * d, pz); break; }
    }
    const done = step >= r.total;
    const boom = hitAt || (done ? r.end.clone() : null);
    r.grp.position.set(r.from.x + r.dir.x * step, r.from.y + r.dir.y * step, r.from.z + r.dir.z * step);
    r.grp.lookAt(r.end);
    // Faint smoke trail behind the rocket.
    if (Math.random() < 0.7) {
      const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
        color: 0xffd0a0, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthTest: false,
      }));
      m.position.copy(r.grp.position);
      m.scale.set(1.6, 1.6, 0.6);
      m.lookAt(r.from);
      spawnEffect(m, 0.2);
    }
    if (boom) {
      scene.remove(r.grp);
      r.grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      rockets.splice(i, 1);
      if (r.onImpact) r.onImpact(boom);
    }
  }
}

// --- State shared with the main loop (recoil impulse + fire throttle) ---
let recoilImpulse = 0;   // decaying camera pitch kick (radians)
export let recoilApplied = 0;   // recoil currently baked into the camera
const _recEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let nextFireTime = 0;
let aiming = false;      // right-mouse held with the sniper: narrow the FOV

// --- Viewmodel sway/bob — the gun eases with movement instead of staying rigid ---
const HAND_BASE = { x: 0.34, y: -0.34, z: -0.6 }; // resting offset from the camera
let swayX = 0, swayY = 0, swayZ = 0, swayRoll = 0;
let bobPhase = 0;

/**
 * Attach the flashlight + lamp glow to the current view direction and ease the
 * hand toward its rest position with a subtle sway/bob driven by movement.
 * forward: world-oriented, y=0, normalised Vector3.
 * lateral/forward: camera-relative horizontal velocity (units/s), speed its magnitude.
 */
export function updateWeaponRig(forward, lateral = 0, forwardMove = 0, speed = 0, dt = 0, onGround = true) {
  flashlight.position.copy(camera.position);
  flashlight.target.position.copy(forward);
  flashlight.target.position.addScaledVector(forward, 10);
  flashlight.target.position.y -= 0.2;
  lampGlow.position.copy(camera.position).addScaledVector(forward, 0.3);
  lampGlow.position.y -= 0.2;

  // Targets for the sway: the gun drifts away from the direction of travel
  // and sinks a touch when moving — a small, natural-looking lag.
  const tx = -lateral * 0.012;
  const ty = -forwardMove * 0.012 - Math.min(speed, 10) * 0.006;
  const tz = -forwardMove * 0.004;
  const roll = lateral * 0.012;
  const k = 1 - Math.exp(-dt * 12); // frame-rate-independent easing
  swayX += (tx - swayX) * k;
  swayY += (ty - swayY) * k;
  swayZ += (tz - swayZ) * k;
  swayRoll += (roll - swayRoll) * k;

  // Step bob: a gentle vertical/longitudinal bob while walking on the ground.
  let bobY = 0, bobX = 0;
  if (onGround && speed > 0.4) {
    bobPhase += dt * (5 + speed * 0.8);
    bobY = Math.sin(bobPhase * 2) * 0.012 * Math.min(1, speed / 4);
    bobX = Math.cos(bobPhase) * 0.008 * Math.min(1, speed / 4);
  } else if (speed <= 0.4) {
    // Still: ease the bob phase out so it doesn't resume mid-swing.
    bobPhase *= 1 - k;
  }

  handGroup.position.set(HAND_BASE.x + swayX + bobX, HAND_BASE.y + swayY + bobY, HAND_BASE.z + swayZ);
  handGroup.rotation.z = swayRoll;

  // Sniper zoom: ease the FOV to the scope value while aiming, else rest.
  const w = curW();
  const targetFov = (aiming && w.zoom) ? w.zoom : BASE_FOV;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
    camera.updateProjectionMatrix();
  }
}

/**
 * Bake this frame's recoil into the camera pitch and decay the impulse.
 */
export function updateRecoil(dt) {
  _recEuler.setFromQuaternion(camera.quaternion, 'YXZ');
  const cleanX = _recEuler.x - recoilApplied;
  recoilImpulse = Math.max(0, recoilImpulse - dt * 3.0);
  recoilApplied = recoilImpulse;
  _recEuler.x = THREE.MathUtils.clamp(cleanX + recoilApplied, -Math.PI / 2, Math.PI / 2);
  camera.quaternion.setFromEuler(_recEuler);
}

// --- Hit resolution + per-weapon firing -----------------------------------
const _ray2 = new THREE.Raycaster();

// Random unit direction within a cone of half-angle `spread` around `fwd`.
function spreadDir(fwd, spread) {
  if (!spread) return fwd.clone().normalize();
  const cosA = 1 - Math.random() * (1 - Math.cos(spread));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const theta = Math.random() * Math.PI * 2;
  const z = fwd.clone().normalize();
  const tmp = new THREE.Vector3(1, 0, 0);
  if (Math.abs(z.x) > 0.9) tmp.set(0, 1, 0);
  const xAxis = new THREE.Vector3().crossVectors(z, tmp).normalize();
  const yAxis = new THREE.Vector3().crossVectors(z, xAxis);
  return xAxis.multiplyScalar(sinA * Math.cos(theta))
    .addScaledVector(yAxis, sinA * Math.sin(theta))
    .addScaledVector(z, cosA)
    .normalize();
}

// Raycast from an arbitrary origin along `dir` (maxDist) against live enemies.
function rayDirHit(origin, dir, maxDist) {
  _ray2.set(origin, dir.clone().normalize(), 0, maxDist);
  const targets = [];
  for (const z of zombies) if (!z.dead) z.group.traverse((o) => { if (o.isMesh) targets.push(o); });
  if (pvpEnabled) for (const r of playerMeshes()) r.group.traverse((o) => { if (o.isMesh) targets.push(o); });
  if (!targets.length) return null;
  const hits = _ray2.intersectObjects(targets, false);
  return hits.length ? hits[0] : null;
}

function playShotSfx(w) {
  if (w.id === 'sniper') sfxSniper();
  else if (w.id === 'shotgun') sfxShotgun();
  else sfxShot(); // pistol + rifle
}

// Fire one round of the current weapon. Returns a result describing tracers,
// the enemies hit, any kills and (for the RPG) the explosion point.
function doFire() {
  const w = curW();
  camera.updateMatrixWorld();
  const m = w._muzzle.clone().applyMatrix4(camera.matrixWorld);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  const result = { wId: w.id, tracers: [], zHits: [], kills: [], remoteHits: [], boom: null, melee: w.kind === 'melee' };

  // --- Knife: swing the blade and slash everything in the arc ---
  if (w.kind === 'melee') {
    const end = m.clone().addScaledVector(fwd, w.range);
    spawnTracer(m, end, 0xcfe8ff);
    result.tracers.push({ from: m.clone(), to: end.clone() });
    sfxKnife();
    for (const z of zombies) {
      if (z.dead) continue;
      const zp = z.group.position;
      // Judge the slash on the horizontal plane only: the camera sits ~1.6m
      // above a zombie's ground-anchored group, so a 3D distance shrinks the
      // cone dot below threshold and makes close zombies you're pointing at
      // get missed. Use horizontal reach + facing.
      const dx = zp.x - m.x, dz = zp.z - m.z;
      const hdist = Math.hypot(dx, dz);
      if (hdist < w.range + 0.5) {
        const inv = 1 / (hdist || 1);
        const dot = (dx * inv) * fwd.x + (dz * inv) * fwd.z;
        if (dot >= Math.cos(w.arc / 2)) {
          result.zHits.push({ id: z.id, dmg: w.dmg });
        }
      }
    }
    if (fireNet) fireNet(result);
    return result;
  }

  // --- RPG: launch a rocket that detonates with a blast ---
  if (w.kind === 'rocket') {
    // The rocket flies to the first thing in its path (a zombie or a remote
    // player) and detonates there, instead of always landing a fixed 90 units
    // out — which meant the blast almost never actually clipped a target.
    _ray2.set(m, fwd.clone().normalize(), 0, 90);
    const rt = [];
    for (const z of zombies) if (!z.dead) z.group.traverse((o) => { if (o.isMesh) rt.push(o); });
    if (pvpEnabled) for (const r of playerMeshes()) r.group.traverse((o) => { if (o.isMesh) rt.push(o); });
    const rh = rt.length ? _ray2.intersectObjects(rt, false) : [];
    const end = rh.length ? rh[0].point : m.clone().addScaledVector(fwd, 90);
    spawnTracer(m, end, 0xffc080, true);
    spawnMuzzleFlash(m, 1.5, 0xffc080);
    sfxRPG();
    recoilImpulse = Math.min(0.16, recoilImpulse + w.recoil);
    flashlight.intensity = LIGHT_BASE + 8;
    result.tracers.push({ from: m.clone(), to: end.clone() });
    if (fireNet) fireNet(result);
    spawnRpgRocket(m, end, (pt) => {
      sfxExplosion();
      spawnExplosion(pt, w.blast);
      const blast = { wId: w.id, tracers: [], zHits: [], kills: [], remoteHits: [], boom: pt.clone(), blastR: w.blast, melee: false };
      for (const z of zombies) {
        if (z.dead) continue;
        const d = z.group.position.distanceTo(pt);
        if (d < w.blast + 0.5) {
          const dmg = Math.round(w.dmg * THREE.MathUtils.clamp(1 - (d / w.blast) * 0.55, 0.35, 1));
          blast.zHits.push({ id: z.id, dmg });
        }
      }
      if (pvpEnabled) for (const r of playerMeshes()) {
        const d = r.group.position.distanceTo(pt);
        if (d < w.blast + 0.5) {
          const dmg = Math.round(w.dmg * THREE.MathUtils.clamp(1 - (d / w.blast) * 0.5, 0.4, 0.85));
          damageRemote(r.id, dmg);
          blast.remoteHits.push({ id: r.id, dmg });
        }
      }
      if (fireCb) fireCb(blast);   // main.js: apply/host damage + kill credit
      if (fireNet) fireNet(blast);
    });
    return result;
  }

  // --- Straight projectiles (pistol/rifle/sniper/shotgun pellets) ---
  const pellets = w.pellets || 1;
  for (let i = 0; i < pellets; i++) {
    const dir = spreadDir(fwd, w.spread);
    const end = m.clone().addScaledVector(dir, 60);
    const hit = rayDirHit(m, dir, 60);
    const to = hit ? hit.point : end;
    spawnTracer(m, to);
    result.tracers.push({ from: m.clone(), to: to.clone() });
    if (hit) {
      spawnHitSpark(hit.point);
      const rd = hit.object.userData.remote;
      const zd = hit.object.userData.zombie;
      if (rd) { damageRemote(rd, w.dmg); result.remoteHits.push({ id: rd.id, dmg: w.dmg }); }
      else if (zd) { result.zHits.push({ id: zd.id, dmg: w.dmg }); }
    }
  }
  spawnMuzzleFlash(m, w.id === 'sniper' ? 1.3 : 0.6);
  playShotSfx(w);
  recoilImpulse = Math.min(0.16, recoilImpulse + (w.recoil || 0.03));
  flashlight.intensity = LIGHT_BASE + 6;

  if (fireNet) fireNet(result);
  return result;
}

// --- Ammo + reload ---------------------------------------------------------
function startReload() {
  if (reload > 0) return;
  const w = curW();
  if (w.ammo == null || ammo[current] >= w.ammo) return;
  reload = w.reload;
  sfxReload();
}

export function setFireNet(fn) { fireNet = fn; }
export function setNetZombieDamage(b) { netZombieDamage = b; }
export function setPvpEnabled(b) { pvpEnabled = !!b; }
// Fire if allowed. Returns the fire result, or null if it couldn't fire
// (on cooldown / out of ammo — the latter also starts a reload).
export function tryFire() {
  if (reload > 0) return null;
  const w = curW();
  const now = performance.now();
  if (now < nextFireTime) return null;
  if (w.kind !== 'melee') {
    if (curAmmo() <= 0) { startReload(); return null; }
    ammo[current] -= 1;
    nextFireTime = now + w.cooldown * 1000;
    if (ammo[current] === 0) startReload(); // auto-reload an empty clip
  } else {
    nextFireTime = now + (1 / w.speed) * 1000;
  }
  return doFire();
}

// --- Weapon switching ------------------------------------------------------
export function selectWeapon(i) {
  if (i < 0 || i >= WEAPONS.length) return;
  current = i;
  reload = 0; // cancelling a reload to swap is fine
  applyView();
}
export function switchWeapon(delta) {
  selectWeapon((current + delta + WEAPONS.length) % WEAPONS.length);
}
export function getCurrentIndex() { return current; }
export function getWeaponName() { return curW().name; }
export function getAmmo() {
  const w = curW();
  if (w.ammo == null) return null;
  return { mag: ammo[current], max: w.ammo, reloading: reload > 0 };
}
export function setAiming(b) { aiming = !!b; }
export function isAutoFire() { return !!curW().auto; }
export function requestReload() { startReload(); }

// How zoomed-in the sniper's scope currently is: 0 (fully out) → 1 (locked on).
// Derived from the eased FOV so the iron sight fades in/out in lockstep with
// the zoom (see updateWeaponRig). Non-sniper weapons report 0.
export function scopeProgress() {
  const w = curW();
  if (!w.zoom || !aiming) return 0;
  const span = BASE_FOV - w.zoom;
  if (span <= 0) return camera.fov <= w.zoom ? 1 : 0;
  return THREE.MathUtils.clamp((BASE_FOV - camera.fov) / span, 0, 1);
}
export function getCurrentWeapon() { return curW(); }

// Reset to a fresh state (start / respawn).
export function resetWeapon() {
  current = 1;
  for (let i = 0; i < WEAPONS.length; i++) if (WEAPONS[i].ammo != null) ammo[i] = WEAPONS[i].ammo;
  reload = 0;
  nextFireTime = 0;
  aiming = false;
  for (const r of rockets) { scene.remove(r.grp); }
  rockets.length = 0;
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
  applyView();
}
export function resetRecoil() { recoilImpulse = 0; recoilApplied = 0; }

/** Ease the flashlight back to its resting brightness after a shot. */
export function decayFlashlight(dt) {
  flashlight.intensity += (LIGHT_BASE - flashlight.intensity) * Math.min(1, dt * 25);
}

/** Advance the reload timer, update in-flight rockets, and cull effects. */
export function updateWeaponEffects(dt) {
  if (reload > 0) {
    reload -= dt;
    if (reload <= 0) { reload = 0; ammo[current] = curW().ammo; }
  }
  updateRockets(dt);
  updateEffects(dt);
}

// --- VFX helpers so peers can render each other's shots identically --------
// Play the right gun sound for a remote player's shot.
export function playRemoteShotSfx(wId, melee) {
  if (melee) return sfxKnife();
  if (wId === 'sniper') return sfxSniper();
  if (wId === 'shotgun') return sfxShotgun();
  if (wId === 'rpg') return sfxRPG();
  sfxShot();
}
// Draw one tracer from a remote shot (a, b are world-space THREE.Vector3).
export function vfxRemoteTracer(a, b, wId) {
  const color = wId === 'knife' ? 0xcfe8ff : wId === 'rpg' ? 0xffc080 : 0xfff0c0;
  const thick = wId === 'rpg';
  spawnTracer(a, b, color, thick);
}
// Draw a remote RPG explosion.
export function vfxRemoteBoom(x, y, z, r) {
  sfxExplosion();
  spawnExplosion(new THREE.Vector3(x, y, z), r);
}

export { flashlight, lampGlow };

// --- Soft radial glow sprite (for muzzle flash and hit sparks) — generated, no asset ---
function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
