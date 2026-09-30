// Zombies — the horde. Building, spawning waves, chasing, dying and cleanup.
import * as THREE from 'three';
import { ARENA_HALF, scene, obstacles } from './world.js';

// --- Tunable constants (zombies) ---
const ZOMBIE_RADIUS = 0.6;
const ZOMBIE_SPEED = 3.2;
const ZOMBIE_ACCEL = 2.2;       // how quickly the zombie speeds up (chase)
export const ZOMBIE_HP = 100;
const HIT_RANGE = 1.5;          // horizontal distance within which a zombie can hit
const HIT_COOLDOWN = 0.8;      // seconds between a zombie's bites
export const ZOMBIE_HIT_DAMAGE = 12;
export const ZOMBIE_KNOCKBACK = 12;  // player push when a zombie reaches you

// --- Waves ---
const WAVE_CLEAR_DELAY = 1.8;   // pause before the next wave spawns (seconds)
const MAX_WAVE_ZOMBIES = 8;     // cap on simultaneous zombies

// Materials are shared across all zombies for performance; geometry is
// per-zombie and disposed when a wave is cleared.
const ZOMBIE_MAT = {
  skin: new THREE.MeshStandardMaterial({ color: 0x4f6b45, roughness: 0.95 }),
  tunic: new THREE.MeshStandardMaterial({ color: 0x2f3a30, roughness: 1.0 }),
  bone: new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.8 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x1a0000, emissive: 0xff2a2a, emissiveIntensity: 3 }),
};
const zombies = []; // all zombies in the current wave
const _toZombie = new THREE.Vector3();
let zidCounter = 0; // stable ids so the host can stream + joiners can track zombies

// Push a zombie out of any obstacle: a circle ({r}) or an axis-aligned box
// ({box:true, halfX, halfZ}) so the horde slides around cover.
function resolveZombieObstacles(pos) {
  for (const o of obstacles) {
    if (o.box) {
      const nx = Math.max(o.x - o.halfX, Math.min(pos.x, o.x + o.halfX));
      const nz = Math.max(o.z - o.halfZ, Math.min(pos.z, o.z + o.halfZ));
      const dx = pos.x - nx, dz = pos.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 < ZOMBIE_RADIUS * ZOMBIE_RADIUS) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          pos.x = nx + (dx / d) * ZOMBIE_RADIUS;
          pos.z = nz + (dz / d) * ZOMBIE_RADIUS;
        } else {
          const dw = pos.x - (o.x - o.halfX), de = (o.x + o.halfX) - pos.x;
          const dn = pos.z - (o.z - o.halfZ), ds = (o.z + o.halfZ) - pos.z;
          const m = Math.min(dw, de, dn, ds);
          if (m === dw) pos.x = o.x - o.halfX - ZOMBIE_RADIUS;
          else if (m === de) pos.x = o.x + o.halfX + ZOMBIE_RADIUS;
          else if (m === dn) pos.z = o.z - o.halfZ - ZOMBIE_RADIUS;
          else pos.z = o.z + o.halfZ + ZOMBIE_RADIUS;
        }
      }
      continue;
    }
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;
    const min = o.r + ZOMBIE_RADIUS;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 1e-4;
      pos.x = o.x + (dx / d) * min;
      pos.z = o.z + (dz / d) * min;
    }
  }
}

function createZombieGroup() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.42), ZOMBIE_MAT.tunic);
  body.position.y = 1.05;
  body.castShadow = true;

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), ZOMBIE_MAT.skin);
  head.position.y = 1.75;
  head.castShadow = true;

  const armGeo = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  const armL = new THREE.Mesh(armGeo, ZOMBIE_MAT.skin);
  armL.position.set(-0.45, 1.15, 0);
  armL.castShadow = true;
  const armR = new THREE.Mesh(armGeo, ZOMBIE_MAT.skin);
  armR.position.set(0.45, 1.15, 0);
  armR.castShadow = true;

  const legGeo = new THREE.BoxGeometry(0.2, 0.8, 0.2);
  const legL = new THREE.Mesh(legGeo, ZOMBIE_MAT.tunic);
  legL.position.set(-0.18, 0.4, 0);
  legL.castShadow = true;
  const legR = new THREE.Mesh(legGeo, ZOMBIE_MAT.tunic);
  legR.position.set(0.18, 0.4, 0);
  legR.castShadow = true;

  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), ZOMBIE_MAT.eye);
  eye.position.set(0, 1.78, 0.24);

  group.add(body, head, armL, armR, legL, legR, eye);
  group.userData.parts = { armL, armR, legL, legR, head, body };
  return group;
}

// Billboarded health bar for one zombie.
function createHealthBar() {
  const group = new THREE.Group();
  const W = 0.95, H = 0.13;
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshBasicMaterial({ color: 0x11141a, transparent: true, opacity: 0.85 })
  );
  const fillGeo = new THREE.PlaneGeometry(W, H);
  fillGeo.translate(W / 2, 0, 0); // anchor the fill at the left edge
  const fill = new THREE.Mesh(
    fillGeo,
    new THREE.MeshBasicMaterial({ color: 0x58f0a0, transparent: true })
  );
  fill.position.set(-W / 2, 0, 0.002);
  group.add(back, fill);
  group.position.set(0, 2.35, 0);
  return { group, back, fill };
}

function makeZombie(x, z, speed, id) {
  const group = createZombieGroup();
  const bar = createHealthBar();
  group.position.set(x, 0, z);
  resolveZombieObstacles(group.position); // never spawn inside cover
  group.rotation.set(0, Math.atan2(-x, -z), 0);
  scene.add(group);
  scene.add(bar.group);
  const zo = {
    id: id || ('z' + (zidCounter++)),
    group,
    healthBar: bar,
    velocity: new THREE.Vector3(),
    hp: ZOMBIE_HP,
    speed,
    hitTimer: 0,
    dead: false,
    deathT: 0,
  };
  // Back-reference each mesh to its zombie so raycasts can resolve the target.
  group.traverse((o) => { if (o.isMesh) o.userData.zombie = zo; });
  zombies.push(zo);
  return zo;
}

function zombieCountFor(w) { return Math.min(w, MAX_WAVE_ZOMBIES); }
function zombieSpeedFor(w) { return ZOMBIE_SPEED * (1 + (w - 1) * 0.08); }

export function spawnWave(w) {
  const count = zombieCountFor(w);
  const speed = zombieSpeedFor(w);
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + Math.random() * 0.6;
    const r = ARENA_HALF - 4;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    makeZombie(x, z, speed);
  }
}

export function updateZombieHealthBar(z) {
  const pct = Math.max(0, z.hp) / ZOMBIE_HP;
  z.healthBar.fill.scale.x = pct;
  z.healthBar.fill.material.color.set(pct > 0.5 ? 0x58f0a0 : pct > 0.25 ? 0xffd36e : 0xff5a5e);
}

// Flip a zombie to its death state. The caller (main) tracks the kill count.
export function killZombie(z) {
  if (z.dead) return;
  z.dead = true;
  z.deathT = 0;
  z.hp = 0;
  z.hitTimer = 0;
  updateZombieHealthBar(z);
}

// Remove every zombie in the current wave (used before spawning the next one
// and on restart). Shared materials are kept; per-instance geometry is freed.
export function cleanupWave() {
  for (const z of zombies) {
    scene.remove(z.group);
    scene.remove(z.healthBar.group);
    z.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    z.healthBar.back.geometry.dispose();
    z.healthBar.fill.geometry.dispose();
  }
  zombies.length = 0;
}

/**
 * Drive all zombies for one frame: chase, shuffle, billboard health bars,
 * bite the player, and topple the fallen.
 * ctx = { player, camera, vignette, onZombieHit(dir, zombie) }
 * Returns true if at least one zombie is alive.
 */
export function animateZombies(dt, ctx) {
  let anyAlive = false;
  for (let i = 0; i < zombies.length; i++) {
    const z = zombies[i];
    if (!z.dead) {
      anyAlive = true;
      let tx, tz, tid;
      if (ctx.targets && ctx.targets.length) {
        // Multiplayer (host): chase the nearest player.
        let best = Infinity;
        for (const p of ctx.targets) {
          const ddx = p.x - z.group.position.x, ddz = p.z - z.group.position.z;
          const dd = ddx * ddx + ddz * ddz;
          if (dd < best) { best = dd; tx = p.x; tz = p.z; tid = p.id; }
        }
      } else {
        tx = ctx.player.feet.x; tz = ctx.player.feet.z; tid = 'me';
      }
      _toZombie.set(tx - z.group.position.x, 0, tz - z.group.position.z);
      const dist = _toZombie.length();
      _toZombie.normalize();

      // Accelerate up to this zombie's speed while chasing.
      const targetSpeed = z.speed * Math.min(1, dist / 6 + 0.4);
      z.velocity.addScaledVector(_toZombie, ZOMBIE_ACCEL * dt * targetSpeed);
      if (z.velocity.length() > targetSpeed) z.velocity.setLength(targetSpeed);

      z.group.position.addScaledVector(z.velocity, dt);

      // Face the player while moving.
      if (z.velocity.lengthSq() > 0.01) {
        const targetAngle = Math.atan2(_toZombie.x, _toZombie.z);
        const cur = z.group.rotation.y;
        let delta = targetAngle - cur;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        z.group.rotation.y = cur + delta * Math.min(1, dt * 6);
      }

      // Simple limb shuffle (per-zombie phase so they don't move in unison).
      const t = performance.now() * 0.004 + i * 1.7;
      const p = z.group.userData.parts;
      p.armL.rotation.x = Math.sin(t) * 0.7;
      p.armR.rotation.x = -Math.sin(t) * 0.7;
      p.legL.rotation.x = -Math.sin(t) * 0.5;
      p.legR.rotation.x = Math.sin(t) * 0.5;
      p.head.rotation.x = Math.sin(t * 0.5) * 0.15;

      // Keep the zombie inside the arena and out of cover (crates / posts).
      const zlim = ARENA_HALF - ZOMBIE_RADIUS;
      z.group.position.x = Math.max(-zlim, Math.min(zlim, z.group.position.x));
      z.group.position.z = Math.max(-zlim, Math.min(zlim, z.group.position.z));
      resolveZombieObstacles(z.group.position);

      // Health bar follows and billboards toward the camera.
      z.healthBar.group.visible = true;
      z.healthBar.group.position.set(z.group.position.x, 2.35, z.group.position.z);
      z.healthBar.group.quaternion.copy(ctx.camera.quaternion);

      // Attack: bite when close.
      z.hitTimer = Math.max(0, z.hitTimer - dt);
      if (dist < HIT_RANGE && z.hitTimer <= 0) {
        z.hitTimer = HIT_COOLDOWN;
        if (ctx.onBite) ctx.onBite(tid, _toZombie, z);
        else ctx.onZombieHit(_toZombie, z);
      }
    } else {
      // Death: topple over and sink.
      z.deathT += dt;
      const fall = Math.min(1, z.deathT / 0.6);
      z.group.rotation.x = (-Math.PI / 2) * fall;
      z.group.position.y = -0.4 * fall;
      z.healthBar.group.visible = false;
    }
  }
  if (!anyAlive && ctx.player && ctx.vignette) {
    ctx.vignette.style.opacity = Math.max(0, 1 - ctx.player.hp / ZOMBIE_HP) * 0.5;
  }
  return anyAlive;
}

// Idle (menu / pause) limb animation so the scene still feels alive.
export function animateIdleZombies() {
  const t = performance.now() * 0.004;
  for (let i = 0; i < zombies.length; i++) {
    const p = zombies[i].group.userData.parts;
    const ph = t * 0.4 + i * 1.7;
    p.armL.rotation.x = Math.sin(ph) * 0.3;
    p.armR.rotation.x = -Math.sin(ph) * 0.3;
  }
}

// --- Multiplayer (shared horde) helpers -------------------------------------

// Create a render-only zombie from a network snapshot (joiner side).
export function makeZombieNet(id, x, z) {
  const z = makeZombie(x, z, 0, id);
  z.group.position.set(x, 0, z);
  return z;
}

// Dispose and remove one zombie (joiner reconciliation).
export function removeZombie(z) {
  const i = zombies.indexOf(z);
  if (i >= 0) zombies.splice(i, 1);
  scene.remove(z.group);
  scene.remove(z.healthBar.group);
  z.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  z.healthBar.back.geometry.dispose();
  z.healthBar.fill.geometry.dispose();
}

export function findZombie(id) {
  for (const z of zombies) if (z.id === id) return z;
  return null;
}

// Raycast from the camera centre at our local zombies. Returns { id, point }
// for the first hit, or null. Damage is applied by the authoritative host.
const _zNDC = new THREE.Vector2(0, 0);
const _zRay = new THREE.Raycaster();
export function applyZombieShot(camera) {
  _zRay.setFromCamera(_zNDC, camera);
  const targets = [];
  for (const z of zombies) z.group.traverse((o) => { if (o.isMesh) { o.userData.zombie = z; targets.push(o); } });
  if (!targets.length) return null;
  const hits = _zRay.intersectObjects(targets, false);
  if (!hits.length) return null;
  const z = hits[0].object.userData.zombie;
  if (!z) return null;
  return { id: z.id, point: hits[0].point };
}

// Joiner: smooth our render zombies toward the host's streamed positions and
// animate their limbs / death.
export function animateRemoteZombies(dt, camera) {
  const lerp = 1 - Math.pow(0.0001, dt);
  const step = Math.min(1, lerp * 1.5);
  for (let i = 0; i < zombies.length; i++) {
    const z = zombies[i];
    if (!z.net) continue;
    z.group.position.x += (z.net.x - z.group.position.x) * step;
    z.group.position.z += (z.net.z - z.group.position.z) * step;
    z.group.position.y = 0;
    let diff = z.net.ry - z.group.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    z.group.rotation.y += diff * Math.min(1, lerp * 2);
    const p = z.group.userData.parts;
    if (!z.netDead) {
      const t = performance.now() * 0.004 + i * 1.7;
      p.armL.rotation.x = Math.sin(t) * 0.7;
      p.armR.rotation.x = -Math.sin(t) * 0.7;
      p.legL.rotation.x = -Math.sin(t) * 0.5;
      p.legR.rotation.x = Math.sin(t) * 0.5;
      p.head.rotation.x = Math.sin(t * 0.5) * 0.15;
      z.healthBar.group.visible = true;
      z.healthBar.group.position.set(z.group.position.x, 2.35, z.group.position.z);
      z.healthBar.group.quaternion.copy(camera.quaternion);
      updateZombieHealthBar(z);
    } else {
      const fall = Math.min(1, z.deathT / 0.6);
      z.group.rotation.x = (-Math.PI / 2) * fall;
      z.group.position.y = -0.4 * fall;
      z.healthBar.group.visible = false;
    }
  }
}

export { zombies, WAVE_CLEAR_DELAY };
