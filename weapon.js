// Weapon — first-person flashlight + hand, and the shooting system
// (raycast, tracer, muzzle flash, hit sparks, recoil impulse).
import * as THREE from 'three';
import { camera, scene } from './world.js';
import { zombies, updateZombieHealthBar, killZombie } from './zombie.js';
import { sfxShot, sfxKill } from './sound.js';

// --- Tunable constants (shooting) ---
export const FIRE_COOLDOWN = 0.18;   // seconds between shots
export const BULLET_DAMAGE = 34;
export const RECOIL = 0.03;          // camera pitch kick per shot
export const LIGHT_BASE = 8;         // resting flashlight intensity

const raycaster = new THREE.Raycaster();
const centerNDC = new THREE.Vector2(0, 0);
const glowTex = makeGlowTexture();
const tracerGeo = (() => {
  const g = new THREE.BoxGeometry(0.035, 0.035, 1);
  g.translate(0, 0, 0.5); // extend along +Z so lookAt(to) aims the far end at the target
  return g;
})();
const effects = [];
const muzzleLocal = new THREE.Vector3(0.34, -0.34, -0.9);
const _shootDir = new THREE.Vector3();

// --- Flashlight + hand (parented to the camera so it follows look) ---
const flashlight = new THREE.SpotLight(0xfff2cf, LIGHT_BASE, 55, Math.PI / 5.5, 0.5, 1.2);
scene.add(flashlight);
scene.add(flashlight.target);

// A tiny point light on the flashlight barrel so the hand is readable.
const lampGlow = new THREE.PointLight(0xffd9a0, 0.6, 6, 2);
scene.add(lampGlow);

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
    if (e.userData.fade && e.material) {
      e.material.opacity = e.userData.ttl / e.userData.maxLife;
    }
  }
}
function spawnTracer(from, to) {
  const dir = to.clone().sub(from);
  const mesh = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
    color: 0xfff0c0, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthTest: false,
  }));
  mesh.position.copy(from);
  mesh.scale.z = Math.max(0.001, dir.length());
  mesh.lookAt(to);
  spawnEffect(mesh, 0.07);
}
function spawnMuzzleFlash(pos) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffe0a0, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthTest: false,
  }));
  s.position.copy(pos);
  s.scale.set(0.6, 0.6, 1);
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

// --- State shared with the main loop (recoil impulse + fire throttle) ---
let recoilImpulse = 0;   // decaying camera pitch kick (radians)
export let recoilApplied = 0;   // recoil currently baked into the camera
const _recEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let nextFireTime = 0;

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

/**
 * Fire a raycast from the screen centre and apply hits + recoil.
 * onKill is invoked exactly when this shot puts a zombie over the edge.
 */
export function shoot(onKill) {
  // Muzzle world position (front of the barrel, in camera space).
  const muzzle = muzzleLocal.clone().applyMatrix4(camera.matrixWorld);

  raycaster.setFromCamera(centerNDC, camera);
  const targets = [];
  for (const z of zombies) z.group.traverse((o) => { if (o.isMesh) targets.push(o); });
  const hits = raycaster.intersectObjects(targets, false);
  const firstHit = hits.length ? hits[0] : null;

  const end = firstHit
    ? firstHit.point
    : camera.getWorldDirection(_shootDir).clone().multiplyScalar(80).add(camera.position);
  spawnTracer(muzzle, end);
  spawnMuzzleFlash(muzzle);
  sfxShot();
  if (fireNet) fireNet(muzzle, end);

  // Recoil impulse + light spike (the kick is baked into the camera per-frame).
  recoilImpulse = Math.min(0.14, recoilImpulse + RECOIL);
  flashlight.intensity = LIGHT_BASE + 6;

  if (firstHit) {
    const z = firstHit.object.userData.zombie;
    if (z && !z.dead) {
      z.hp -= BULLET_DAMAGE;
      updateZombieHealthBar(z);
      spawnHitSpark(firstHit.point);
      if (z.hp <= 0) { killZombie(z); sfxKill(); if (onKill) onKill(); }
    }
  }
}

// --- Fire throttling + recoil reset (called by the input handler / on start) ---
let fireNet = null; // optional callback(ox,oy,oz,ex,ey,ez) — broadcast the shot
export function setFireNet(fn) { fireNet = fn; }

export function tryFire(onKill, shootOverride) {
  const now = performance.now();
  if (now < nextFireTime) return false;
  nextFireTime = now + FIRE_COOLDOWN * 1000;
  shoot(onKill); // local visuals + (if wired) broadcast via setFireNet
  if (shootOverride) shootOverride();
  return true;
}
export function resetFire() { nextFireTime = 0; }
export function resetRecoil() { recoilImpulse = 0; recoilApplied = 0; }

/** Ease the flashlight back to its resting brightness after a shot. */
export function decayFlashlight(dt) {
  flashlight.intensity += (LIGHT_BASE - flashlight.intensity) * Math.min(1, dt * 25);
}

/** Update (and cull) transient effects. */
export function updateWeaponEffects(dt) { updateEffects(dt); }

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
