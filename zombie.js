// Zombies — the horde. Building, spawning waves, chasing, dying and cleanup.
import * as THREE from 'three';
import { ARENA_HALF, scene, obstacles, towers } from './world.js';

// --- Tunable constants (zombies) ---
const ZOMBIE_RADIUS = 0.6;
const ZOMBIE_SPEED = 3.2;
const ZOMBIE_ACCEL = 2.2;       // how quickly the zombie speeds up (chase)
// Obstacle avoidance / stuck detection.
const AVOID_RAMP = 1.6;         // how fast the avoidance angle grows while blocked (rad/s)
const AVOID_MAX = 1.5;         // max avoidance angle (~86 deg) — a wide arc around cover
const AVOID_DECAY = 2.2;       // how fast it unwinds once the path is clear (rad/s)
const STUCK_KILL_TIME = 60;    // seconds with no forward progress before a zombie gives up and dies
export const ZOMBIE_HP = 100;
const HIT_RANGE = 1.5;          // horizontal distance within which a zombie can hit
const HIT_COOLDOWN = 0.8;      // seconds between a zombie's bites
const BITE_REACH = 2.2;        // max vertical distance to the target for a bite
export const ZOMBIE_HIT_DAMAGE = 12;
export const ZOMBIE_KNOCKBACK = 12;  // player push when a zombie reaches you

// --- Waves ---
const WAVE_CLEAR_DELAY = 1.8;   // pause before the next wave spawns (seconds)
const MAX_WAVE_ZOMBIES = 8;     // cap on simultaneous zombies

// Materials are shared per-type for performance; geometry is per-zombie and
// disposed when a wave is cleared.
const SHARED_ZMAT = {
  bone: new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.8 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x1a0000, emissive: 0xff2a2a, emissiveIntensity: 3 }),
};

// The three archetypes. Each trades speed / bulk / damage / toughness for a
// distinct role in the horde:
//   small  (Scout)  — fast, swarms, dies to one or two shots, weak bites.
//   medium (Walker) — the balanced default.
//   large  (Brute)  — slow & tanky, hits and shoves hard, climbs sluggishly.
const ZOMBIE_TYPES = {
  small:  { name: 'Scout',  scale: 0.72, speed: 4.6, hp: 55,  damage: 8,  knockback: 8,  climb: 3.2, radius: 0.42, hitRange: 1.5, skin: 0x6f8f4f, tunic: 0x4a5a3a },
  medium: { name: 'Walker', scale: 1.0,  speed: 3.2, hp: 100, damage: 12, knockback: 12, climb: 2.2, radius: 0.6,  hitRange: 1.9, skin: 0x4f6b45, tunic: 0x2f3a30 },
  large:  { name: 'Brute',  scale: 1.55, speed: 2.1, hp: 240, damage: 26, knockback: 22, climb: 1.4, radius: 0.95, hitRange: 2.3, skin: 0x5a3b3b, tunic: 0x3a2222 },
  // Flier: glides at height (never touches the ground), so towers give you no
  // air safety from it; it's fragile-ish but relentless and can't be blocked by cover.
  flier:  { name: 'Flier',  scale: 0.9,  speed: 4.0, hp: 90,  damage: 14, knockback: 14, climb: 2.2, radius: 0.5,  hitRange: 2.1, skin: 0x4a6a70, tunic: 0x2a3f45, fly: true, hover: 2.2 },
};
const TYPE_MAT = {};
function typeMaterials(type) {
  if (TYPE_MAT[type]) return TYPE_MAT[type];
  const c = ZOMBIE_TYPES[type];
  TYPE_MAT[type] = {
    skin: new THREE.MeshStandardMaterial({ color: c.skin, roughness: 0.95 }),
    tunic: new THREE.MeshStandardMaterial({ color: c.tunic, roughness: 1.0 }),
    bone: SHARED_ZMAT.bone,
    eye: SHARED_ZMAT.eye,
  };
  return TYPE_MAT[type];
}
const zombies = []; // all zombies in the current wave
const _toZombie = new THREE.Vector3();
let zidCounter = 0; // stable ids so the host can stream + joiners can track zombies

// Push a zombie out of any obstacle: a circle ({r}) or an axis-aligned box
// ({box:true, halfX, halfZ}) so the horde slides around cover.
function resolveZombieObstacles(pos, radius = ZOMBIE_RADIUS) {
  for (const o of obstacles) {
    if (o.box) {
      const nx = Math.max(o.x - o.halfX, Math.min(pos.x, o.x + o.halfX));
      const nz = Math.max(o.z - o.halfZ, Math.min(pos.z, o.z + o.halfZ));
      const dx = pos.x - nx, dz = pos.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 < radius * radius) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          pos.x = nx + (dx / d) * radius;
          pos.z = nz + (dz / d) * radius;
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
    const min = o.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 1e-4;
      pos.x = o.x + (dx / d) * min;
      pos.z = o.z + (dz / d) * min;
    }
  }
}

// A winged flier: hunched body, big spread arm-wings, dangling legs.
function createFlyingZombieGroup(type) {
  const M = typeMaterials(type);
  const scale = ZOMBIE_TYPES[type].scale;
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.7, 0.5), M.tunic);
  body.position.y = 1.5;
  body.rotation.x = 0.3; // hunched forward
  body.castShadow = true;

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), M.skin);
  head.position.set(0, 1.95, 0.12);
  head.rotation.x = 0.2;
  head.castShadow = true;

  // Arm-wings held out and up, flapping in animateZombies.
  const wingGeo = new THREE.BoxGeometry(0.18, 0.95, 0.2);
  const wingL = new THREE.Mesh(wingGeo, M.skin);
  wingL.position.set(-0.5, 1.65, 0);
  wingL.rotation.z = 0.5;
  wingL.castShadow = true;
  const wingR = new THREE.Mesh(wingGeo, M.skin);
  wingR.position.set(0.5, 1.65, 0);
  wingR.rotation.z = -0.5;
  wingR.castShadow = true;

  // Legs dangle from the hunched body.
  const legGeo = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  const legL = new THREE.Mesh(legGeo, M.tunic);
  legL.position.set(-0.16, 0.85, 0);
  legL.rotation.x = -0.4;
  legL.castShadow = true;
  const legR = new THREE.Mesh(legGeo, M.tunic);
  legR.position.set(0.16, 0.85, 0);
  legR.rotation.x = -0.4;
  legR.castShadow = true;

  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), M.eye);
  eye.position.set(0, 1.98, 0.34);

  group.add(body, head, wingL, wingR, legL, legR, eye);
  group.scale.setScalar(scale);
  // wingL/wingR double as the armL/armR flaps in the animation code.
  group.userData.parts = { armL: wingL, armR: wingR, legL, legR, head, body };
  return group;
}

function createZombieGroup(type) {
  const M = typeMaterials(type);
  const scale = ZOMBIE_TYPES[type].scale;
  if (ZOMBIE_TYPES[type].fly) return createFlyingZombieGroup(type);
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.42), M.tunic);
  body.position.y = 1.05;
  body.castShadow = true;

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), M.skin);
  head.position.y = 1.75;
  head.castShadow = true;

  const armGeo = new THREE.BoxGeometry(0.18, 0.7, 0.18);
  const armL = new THREE.Mesh(armGeo, M.skin);
  armL.position.set(-0.45, 1.15, 0);
  armL.castShadow = true;
  const armR = new THREE.Mesh(armGeo, M.skin);
  armR.position.set(0.45, 1.15, 0);
  armR.castShadow = true;

  const legGeo = new THREE.BoxGeometry(0.2, 0.8, 0.2);
  const legL = new THREE.Mesh(legGeo, M.tunic);
  legL.position.set(-0.18, 0.4, 0);
  legL.castShadow = true;
  const legR = new THREE.Mesh(legGeo, M.tunic);
  legR.position.set(0.18, 0.4, 0);
  legR.castShadow = true;

  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), M.eye);
  eye.position.set(0, 1.78, 0.24);

  group.add(body, head, armL, armR, legL, legR, eye);
  group.scale.setScalar(scale);
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

function makeZombie(x, z, speed, id, type = 'medium') {
  const c = ZOMBIE_TYPES[type];
  const group = createZombieGroup(type);
  const bar = createHealthBar();
  group.position.set(x, 0, z);
  resolveZombieObstacles(group.position, c.radius); // never spawn inside cover
  group.rotation.set(0, Math.atan2(-x, -z), 0);
  scene.add(group);
  scene.add(bar.group);
  const zo = {
    id: id || ('z' + (zidCounter++)),
    type,
    group,
    healthBar: bar,
    velocity: new THREE.Vector3(),
    hp: c.hp,
    maxHp: c.hp,
    damage: c.damage,
    knockback: c.knockback,
    speed,
    radius: c.radius,
    hitRange: c.hitRange,
    climbSpeed: c.climb,
    barY: 2.35 * c.scale,
    hitTimer: 0,
    dead: false,
    deathT: 0,
    climb: null,   // { tower, t } — riding the tower stairs (t: 0 foot -> 1 deck)
    onTower: null, // the tower deck the zombie is standing on (null on ground)
    fly: !!c.fly,  // airborne archetype: chases through the air, no ground physics
    hoverBase: c.hover || 2.2,
    vy: 0,
    // Obstacle avoidance: when a zombie is wedged behind cover it steers
    // around it instead of pushing straight in. stuckTimer is the cumulative
    // seconds the zombie has been blocked; avoidAngle is the lateral offset
    // applied to its chase direction; avoidDir is which side it's currently
    // steering toward (flips if still stuck after a couple of seconds).
    stuckTimer: 0,
    avoidAngle: 0,
    avoidDir: Math.random() < 0.5 ? 1 : -1,
    prevPX: x,  // last frame's position (for stuck detection)
    prevPZ: z,
  };
  // Back-reference each mesh to its zombie so raycasts can resolve the target.
  group.traverse((o) => { if (o.isMesh) o.userData.zombie = zo; });
  zombies.push(zo);
  return zo;
}

function zombieCountFor(w) { return Math.min(w, MAX_WAVE_ZOMBIES); }

// Which archetype spawns in a given slot. Brutes start appearing from wave 2,
// fliers from wave 3, and both get more common as the waves grow; scouts stay
// a steady third.
function pickType(w) {
  if (w >= 2 && Math.random() < Math.min(0.4, 0.05 + 0.05 * w)) return 'large';
  if (w >= 3 && Math.random() < Math.min(0.25, 0.08 + 0.03 * w)) return 'flier';
  return Math.random() < 0.4 ? 'small' : 'medium';
}

export function spawnWave(w) {
  const count = zombieCountFor(w);
  const waveMul = 1 + (w - 1) * 0.08; // difficulty speed factor, per type
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + Math.random() * 0.6;
    const r = ARENA_HALF - 4;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const type = pickType(w);
    makeZombie(x, z, ZOMBIE_TYPES[type].speed * waveMul, undefined, type);
  }
}

export function updateZombieHealthBar(z) {
  const pct = Math.max(0, z.hp) / z.maxHp;
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

// The climbable tower a zombie can grab (close to the base and on the stairs'
// side), or null. Mirrors the player's nearestTower.
function nearestTower(p) {
  let best = null, bestD = Infinity;
  for (const t of towers) {
    const dx = p.x - t.x, dz = p.z - t.z;
    const d = Math.hypot(dx, dz);
    if (d > t.baseR + ZOMBIE_RADIUS + 0.6) continue;
    const inv = 1 / (d || 1e-4);
    const facing = dx * inv * t.ux + dz * inv * t.uz;
    if (facing < 0.15) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// Slide a climbing zombie along its tower's stair centreline (foot -> deck).
function updateZombieClimb(z, dt) {
  const t = z.climb.tower;
  const step = (z.climbSpeed * dt) / t.deckTop;
  let ct = z.climb.t + step;            // zombies only climb up
  ct = Math.max(0, Math.min(1, ct));
  z.climb.t = ct;
  const r = t.footR + (t.topR - t.footR) * ct;
  z.group.position.x = t.x + t.ux * r;
  z.group.position.z = t.z + t.uz * r;
  z.group.position.y = t.deckTop * ct;
  if (ct >= 1) { z.climb = null; z.onTower = t; }
}

// A flier: glide horizontally toward the target at full speed and ease its
// height up to hover level above the target (works on the ground AND on tower
// decks). No ground physics — it flies straight over crates, barrels and the
// arena walls' obstacles.
function updateFlyingZombie(z, dt, tx, tz, ty, dir, dist) {
  const targetY = Math.max(z.hoverBase, ty + 0.5);
  z.vy += (targetY - z.group.position.y) * Math.min(1, dt * 3);
  z.group.position.y += z.vy * dt;
  const sp = z.speed * Math.min(1, dist / 6 + 0.4);
  z.velocity.addScaledVector(dir, ZOMBIE_ACCEL * dt * sp);
  if (z.velocity.length() > sp) z.velocity.setLength(sp);
  z.group.position.addScaledVector(z.velocity, dt);
  const lim = ARENA_HALF - z.radius;
  z.group.position.x = Math.max(-lim, Math.min(lim, z.group.position.x));
  z.group.position.z = Math.max(-lim, Math.min(lim, z.group.position.z));
  if (dist > 0.01) {
    const ta = Math.atan2(dir.x, dir.z);
    const cur = z.group.rotation.y;
    let delta = ta - cur;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    z.group.rotation.y = cur + delta * Math.min(1, dt * 6);
  }
}

// A zombie standing on a tower deck: step off (down) when its target drops to
// the ground, otherwise walk toward the target across the deck, then bite.
function updateZombieOnDeck(z, ty, dir, dt) {
  const t = z.onTower;
  if (ty <= 0) {
    z.group.position.y = 0; z.onTower = null; z.velocity.set(0, 0, 0);
    return;
  }
  z.group.position.addScaledVector(dir, Math.min(z.speed, 2.6) * dt);
  let dx = z.group.position.x - t.x, dz = z.group.position.z - t.z;
  const d = Math.hypot(dx, dz);
  if (d > t.walkR) {
    const s = t.walkR / (d || 1e-4);
    z.group.position.x = t.x + dx * s;
    z.group.position.z = t.z + dz * s;
  }
  z.group.position.y = t.deckTop;
}

/**
 * Drive all zombies for one frame: chase, shuffle, billboard health bars,
 * bite the player, and topple the fallen. Zombies will climb the watchtower
 * / crate-platform stairs to reach a player hiding up on the deck.
 * ctx = { player, camera, vignette, targets, onBite | onZombieHit }
 * Returns true if at least one zombie is alive.
 */
export function animateZombies(dt, ctx) {
  let anyAlive = false;
  for (let i = 0; i < zombies.length; i++) {
    const z = zombies[i];
    if (!z.dead) {
      anyAlive = true;
      let tx, tz, ty, tid;
      if (ctx.targets && ctx.targets.length) {
        // Multiplayer (host): chase the nearest player.
        let best = Infinity;
        for (const p of ctx.targets) {
          const ddx = p.x - z.group.position.x, ddz = p.z - z.group.position.z;
          const dd = ddx * ddx + ddz * ddz;
          if (dd < best) { best = dd; tx = p.x; tz = p.z; ty = p.y || 0; tid = p.id; }
        }
      } else {
        tx = ctx.player.feet.x; tz = ctx.player.feet.z; ty = ctx.player.feet.y; tid = 'me';
      }
      _toZombie.set(tx - z.group.position.x, 0, tz - z.group.position.z);
      const dist = _toZombie.length();
      _toZombie.normalize();

      // --- Climb / on-deck states (reach a player up on a tower) ---
      if (z.climb) {
        updateZombieClimb(z, dt);
        if (dist > 0.01) z.group.rotation.y = Math.atan2(_toZombie.x, _toZombie.z);
      } else if (z.onTower) {
        updateZombieOnDeck(z, ty, _toZombie, dt);
        if (dist > 0.01) z.group.rotation.y = Math.atan2(_toZombie.x, _toZombie.z);
      } else if (z.fly) {
        updateFlyingZombie(z, dt, tx, tz, ty, _toZombie, dist);
      } else {
        const pos = z.group.position;

        // Stuck detection: the zombie has real speed but is barely moving
        // (it keeps getting shoved back out of cover by resolveZombieObstacles).
        const speedNow = z.velocity.length();
        const moved = Math.hypot(pos.x - z.prevPX, pos.z - z.prevPZ);
        const blocked = speedNow > z.speed * 0.35 && moved < z.speed * dt * 0.5;
        if (blocked) {
          z.stuckTimer += dt;
          // Swing around the obstacle. A full arc that didn't free it means we
          // hit the far side too — flip and try the other direction.
          z.avoidAngle += AVOID_RAMP * dt;
          if (z.avoidAngle >= AVOID_MAX) { z.avoidDir *= -1; z.avoidAngle = 0; }
        } else {
          z.stuckTimer = 0;
          z.avoidAngle = Math.max(0, z.avoidAngle - AVOID_DECAY * dt);
          if (z.avoidAngle < 0.03) z.avoidAngle = 0;
        }

        // Steer around cover: rotate the raw chase direction by the avoidance
        // angle so a blocked zombie arcs around the obstacle instead of pushing
        // straight into it forever.
        const steer = z.avoidAngle * z.avoidDir;
        const cs = Math.cos(steer), sn = Math.sin(steer);
        const sx = _toZombie.x * cs - _toZombie.z * sn;
        const sz = _toZombie.x * sn + _toZombie.z * cs;

        const targetSpeed = z.speed * Math.min(1, dist / 6 + 0.4);
        z.velocity.x += sx * ZOMBIE_ACCEL * dt * targetSpeed;
        z.velocity.z += sz * ZOMBIE_ACCEL * dt * targetSpeed;
        if (z.velocity.length() > targetSpeed) z.velocity.setLength(targetSpeed);
        pos.addScaledVector(z.velocity, dt);

        // Face where we're actually heading.
        if (z.velocity.lengthSq() > 0.01) {
          const targetAngle = Math.atan2(z.velocity.x, z.velocity.z);
          const cur = z.group.rotation.y;
          let delta = targetAngle - cur;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          z.group.rotation.y = cur + delta * Math.min(1, dt * 6);
        }

        // Keep the zombie inside the arena and out of cover (crates / posts).
        const zlim = ARENA_HALF - ZOMBIE_RADIUS;
        pos.x = Math.max(-zlim, Math.min(zlim, pos.x));
        pos.z = Math.max(-zlim, Math.min(zlim, pos.z));
        pos.y = 0;
        resolveZombieObstacles(pos, z.radius);

        // Grab a nearby tower's stairs to climb up after an elevated target.
        const t = nearestTower(pos);
        if (t && ty > t.deckTop - 2.0) z.climb = { tower: t, t: 0 };

        // Safety net: a zombie that can't make progress for a long time gives up.
        if (z.stuckTimer > STUCK_KILL_TIME) killZombie(z);

        // Record position for next frame's stuck detection.
        z.prevPX = pos.x;
        z.prevPZ = pos.z;
      }

      // Simple limb shuffle (per-zombie phase so they don't move in unison).
      const t2 = performance.now() * 0.004 + i * 1.7;
      const p = z.group.userData.parts;
      if (z.fly) {
        // Fast wing flap + hover bob for the fliers.
        const flap = Math.sin(t2 * 3.2) * 0.9;
        p.armL.rotation.x = flap;
        p.armR.rotation.x = -flap;
        p.legL.rotation.x = -0.4 + Math.sin(t2 * 1.4) * 0.2;
        p.legR.rotation.x = -0.4 - Math.sin(t2 * 1.4) * 0.2;
        p.head.rotation.x = 0.2 + Math.sin(t2 * 0.5) * 0.1;
        z.group.position.y += Math.sin(t2 * 1.8) * 0.003;
      } else {
        p.armL.rotation.x = Math.sin(t2) * 0.7;
        p.armR.rotation.x = -Math.sin(t2) * 0.7;
        p.legL.rotation.x = -Math.sin(t2) * 0.5;
        p.legR.rotation.x = Math.sin(t2) * 0.5;
        p.head.rotation.x = Math.sin(t2 * 0.5) * 0.15;
      }

      // Health bar follows and billboards toward the camera (heights follow the
      // deck when the zombie is climbing or on top).
      z.healthBar.group.visible = true;
      z.healthBar.group.position.set(z.group.position.x, z.barY + z.group.position.y, z.group.position.z);
      z.healthBar.group.quaternion.copy(ctx.camera.quaternion);

      // Attack: bite when close (and the target is within vertical reach).
      const ddx = tx - z.group.position.x, ddz = tz - z.group.position.z;
      const reach = Math.hypot(ddx, ddz);
      z.hitTimer = Math.max(0, z.hitTimer - dt);
      if (reach < z.hitRange && Math.abs(ty - z.group.position.y) < BITE_REACH && z.hitTimer <= 0) {
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
export function makeZombieNet(id, x, zz, type) {
  const zo = makeZombie(x, zz, 0, id, type || 'medium');
  zo.group.position.set(x, 0, zz);
  return zo;
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
    z.group.position.y += ((z.net.y || 0) - z.group.position.y) * step;
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
      z.healthBar.group.position.set(z.group.position.x, z.barY + z.group.position.y, z.group.position.z);
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
