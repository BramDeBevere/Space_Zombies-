// Player — camera rig (feet position + velocity), WASD movement, arena +
// obstacle collision, and climbing the watchtowers (E) up onto the deck.
import * as THREE from 'three';
import { EYE_HEIGHT, PLAYER_RADIUS, ARENA_HALF, obstacles, towers } from './world.js';
import { ZOMBIE_HP } from './zombie.js';

const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;
const CROUCH_SPEED = 2.6;  // m/s while crouching (about half of walk speed)
const CROUCH_EYE = 1.05;   // camera height above the feet while crouched
const GRAVITY = 26;        // downward acceleration (units/s^2)
const JUMP_VELOCITY = 8.5; // initial upward velocity when jumping
const CLIMB_SPEED = 4.2;   // m/s up/down the ladder

const player = {
  feet: new THREE.Vector3(0, 0, 0), // camera = feet + (0, EYE_HEIGHT + feet.y, 0)
  velocity: new THREE.Vector3(),    // horizontal (x,z) movement only
  vy: 0,          // vertical velocity
  onGround: true, // true while standing on the floor
  onTower: null,  // the watchtower deck we're standing on (null when on the ground)
  climb: null,    // { tower, mode:'up'|'down' } while riding the ladder
  eyeH: EYE_HEIGHT, // current (eased) camera height above the feet
  kartDriver: null,  // index of the kart being driven (karts.js owns the sim)
  hp: ZOMBIE_HP,
};

const keys = {};
window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
let eHeld = false; // previous frame's E state, for edge-detected climb presses

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();

function clampToArena(p) {
  const lim = ARENA_HALF - PLAYER_RADIUS;
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
}

// Push the player out of any obstacle: a circle ({r}) or an axis-aligned box
// ({box:true, halfX, halfZ}) in top-down (x, z). Low obstacles tagged with a
// `top` height are ignored while the player's feet are above that height, so
// crates / barrels can be hopped over instead of always blocking the path.
function resolveObstacles(p) {
  for (const o of obstacles) {
    if (o.top != null && p.y >= o.top) continue; // airborne over this obstacle
    if (o.box) {
      const nx = Math.max(o.x - o.halfX, Math.min(p.x, o.x + o.halfX));
      const nz = Math.max(o.z - o.halfZ, Math.min(p.z, o.z + o.halfZ));
      const dx = p.x - nx, dz = p.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 < PLAYER_RADIUS * PLAYER_RADIUS) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          p.x = nx + (dx / d) * PLAYER_RADIUS;
          p.z = nz + (dz / d) * PLAYER_RADIUS;
        } else {
          // Centre is inside the box: push out through the nearest face.
          const dw = p.x - (o.x - o.halfX), de = (o.x + o.halfX) - p.x;
          const dn = p.z - (o.z - o.halfZ), ds = (o.z + o.halfZ) - p.z;
          const m = Math.min(dw, de, dn, ds);
          if (m === dw) p.x = o.x - o.halfX - PLAYER_RADIUS;
          else if (m === de) p.x = o.x + o.halfX + PLAYER_RADIUS;
          else if (m === dn) p.z = o.z - o.halfZ - PLAYER_RADIUS;
          else p.z = o.z + o.halfZ + PLAYER_RADIUS;
        }
      }
      continue;
    }
    const dx = p.x - o.x;
    const dz = p.z - o.z;
    const min = o.r + PLAYER_RADIUS;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min) {
      const d = Math.sqrt(d2) || 1e-4;
      p.x = o.x + (dx / d) * min;
      p.z = o.z + (dz / d) * min;
    }
  }
}

/**
 * Integrate player movement for one frame, keeping the camera in sync.
 * camera.up is assumed to stay (0,1,0), so the standard forward/right basis
 * gives the same WASD-relative motion the game always had. The watchtowers can
 * be climbed (E) up onto the deck and back down.
 */
function updatePlayer(dt, camera) {
  // While driving a kart, karts.js owns the camera + feet: skip the on-foot
  // sim entirely (movement, climb, crouch) for this frame.
  if (player.kartDriver != null) {
    eHeld = false;
    return;
  }

  _forward.set(0, 0, 0);
  camera.getWorldDirection(_forward);
  _forward.y = 0;
  _forward.normalize();

  _right.set(0, 0, 0);
  _right.crossVectors(_forward, camera.up).normalize();

  const ePressed = !!keys['KeyE'] && !eHeld;
  const crouching = keys['KeyC'] || keys['ControlLeft'] || keys['ControlRight'];

  if (player.climb) updateClimb(dt);
  else if (player.onTower) updateOnTower(dt, ePressed, crouching);
  else updateGround(dt, ePressed, crouching);

  eHeld = !!keys['KeyE'];

  // Ease the camera between standing and crouched height, then place it.
  const targetEye = crouching ? CROUCH_EYE : EYE_HEIGHT;
  player.eyeH += (targetEye - player.eyeH) * Math.min(1, dt * 12);
  camera.position.set(player.feet.x, player.eyeH + player.feet.y, player.feet.z);
}

// --- On the ground: normal WASD + gravity + jump, and E to start a climb ---
function updateGround(dt, ePressed, crouching) {
  _move.set(0, 0, 0);
  if (keys['KeyW']) _move.add(_forward);
  if (keys['KeyS']) _move.sub(_forward);
  if (keys['KeyD']) _move.add(_right);
  if (keys['KeyA']) _move.sub(_right);

  // Crouching slows you down and cancels sprint — you can't do both at once.
  const sprinting = !crouching && (keys['ShiftLeft'] || keys['ShiftRight']);
  const speed = crouching ? CROUCH_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED;
  if (_move.lengthSq() > 0) {
    _move.normalize().multiplyScalar(speed);
  }

  // Smoothly approach target velocity (slight inertia).
  player.velocity.lerp(_move, 1 - Math.pow(0.0001, dt));

  player.feet.addScaledVector(player.velocity, dt);
  clampToArena(player.feet);
  resolveObstacles(player.feet);

  // --- Vertical: gravity + jump (Space) — no jumping while crouching ---
  if (player.onGround && keys['Space'] && !crouching) {
    player.vy = JUMP_VELOCITY;
    player.onGround = false;
  }
  player.vy -= GRAVITY * dt;
  player.feet.y += player.vy * dt;
  if (player.feet.y <= 0) {
    player.feet.y = 0;
    player.vy = 0;
    player.onGround = true;
  }

  // --- Start climbing a nearby watchtower (E, while grounded) ---
  if (ePressed && player.onGround && !keys['Space']) {
    const t = nearestTower(player.feet);
    if (t) beginClimb(t, 'up');
  }
}

// --- Standing on a watchtower deck: walk within the railings, E to descend ---
function updateOnTower(dt, ePressed, crouching) {
  const t = player.onTower;
  player.onGround = true;

  _move.set(0, 0, 0);
  if (keys['KeyW']) _move.add(_forward);
  if (keys['KeyS']) _move.sub(_forward);
  if (keys['KeyD']) _move.add(_right);
  if (keys['KeyA']) _move.sub(_right);
  if (_move.lengthSq() > 0) _move.normalize().multiplyScalar(crouching ? CROUCH_SPEED : WALK_SPEED);

  player.velocity.lerp(_move, 1 - Math.pow(0.0001, dt));
  player.feet.addScaledVector(player.velocity, dt);

  // Keep the player on the deck (inside the railings).
  const dx = player.feet.x - t.x, dz = player.feet.z - t.z;
  const d = Math.hypot(dx, dz);
  if (d > t.walkR) {
    const s = t.walkR / d;
    player.feet.x = t.x + dx * s;
    player.feet.z = t.z + dz * s;
  }
  player.feet.y = t.deckTop;

  if (ePressed) beginClimb(t, 'down');
}

// --- Riding the ladder: locked to its slanted line, moving up/down ---
// The climb parameter t goes 0 (foot, on the ground) -> 1 (top, on the deck).
// The ladder leans inward, so the player slides along that same line.
function updateClimb(dt) {
  const t = player.climb.tower;
  const step = (CLIMB_SPEED * dt) / t.deckTop; // deckTop = vertical rise of the ladder
  let ct = player.climb.t + (player.climb.mode === 'up' ? step : -step);
  ct = Math.max(0, Math.min(1, ct));
  player.climb.t = ct;

  const r = t.footR + (t.topR - t.footR) * ct;
  player.feet.x = t.x + t.ux * r;
  player.feet.z = t.z + t.uz * r;
  player.feet.y = t.deckTop * ct;
  player.velocity.set(0, 0, 0);
  player.onGround = false;

  if (ct >= 1) {           // reached the deck
    player.climb = null;
    player.onTower = t;
    player.onGround = true;
  } else if (ct <= 0) {    // back on the ground
    player.climb = null;
    player.onTower = null;
    player.onGround = true;
  }
}

// The watchtower within reach of `p` on the ground (close enough to grab the
// ladder, and on the ladder's side so we don't teleport around the tower), or
// null.
function nearestTower(p) {
  let best = null, bestD = Infinity;
  for (const t of towers) {
    const dx = p.x - t.x, dz = p.z - t.z;
    const d = Math.hypot(dx, dz);
    // Lenient reach: the ladder faces the arena centre, so allow approaching
    // from a wide arc (nearly the whole front hemisphere) and from a bit
    // further back than the base collider — climbing should never feel
    // finicky.
    if (d > t.baseR + PLAYER_RADIUS + 2.2) continue;
    const inv = 1 / (d || 1e-4);
    const facing = dx * inv * t.ux + dz * inv * t.uz;
    if (facing < -0.35) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

// The tower the player can act on right now (climb up from the ground, or
// descend from the deck they're standing on), or null. Drives both the climb
// prompt in the HUD and is what a fresh E-press looks up.
export function towerInRange(p) {
  if (player.onTower) return player.onTower;      // on a deck -> can descend
  if (!player.onGround) return null;             // mid-air / climbing -> nothing
  return nearestTower(p);                         // grounded -> nearest reachable
}

// Snap the player onto the ladder and start moving `mode` ('up' | 'down').
// climb.t is the position along the ladder: 0 = foot (ground), 1 = top (deck).
function beginClimb(t, mode) {
  player.climb = { tower: t, mode, t: mode === 'up' ? 0 : 1 };
  player.onTower = null;
  player.onGround = false;
  player.vy = 0;
  player.velocity.set(0, 0, 0);
  // Place the player at the ladder end immediately (the next frame advances it).
  player.feet.x = t.x + t.ux * (mode === 'up' ? t.footR : t.topR);
  player.feet.z = t.z + t.uz * (mode === 'up' ? t.footR : t.topR);
  player.feet.y = mode === 'up' ? 0 : t.deckTop;
}

function resetPlayer() {
  player.feet.set(0, 0, 0);
  player.velocity.set(0, 0, 0);
  player.vy = 0;
  player.onGround = true;
  player.onTower = null;
  player.climb = null;
  player.eyeH = EYE_HEIGHT; // stand tall on (re)spawn
  player.kartDriver = null; // never (re)spawn while seated in a kart
  eHeld = false;
}

// Pick a ground spawn point that isn't inside an obstacle or watchtower base.
// Returns null when the caller should fall back to the arena centre.
function isClearSpot(x, z) {
  for (const o of obstacles) {
    const d = o.box
      ? Math.max(Math.abs(x - o.x) - o.halfX, Math.abs(z - o.z) - o.halfZ, 0)
      : Math.hypot(x - o.x, z - o.z) - o.r;
    if (d < PLAYER_RADIUS + 0.3) return false;
  }
  for (const t of towers) {
    if (Math.hypot(x - t.x, z - t.z) < (t.baseR || 3) + PLAYER_RADIUS + 0.5) return false;
  }
  return true;
}

/**
 * Apply a spawn position to the player. `mode` is 'center' or 'random'; for
 * 'random' it samples open ground points until one clears (bounded attempts,
 * falling back to the centre).
 */
export function applySpawn(mode) {
  if (mode === 'random') {
    const lim = ARENA_HALF - PLAYER_RADIUS - 2;
    for (let i = 0; i < 40; i++) {
      const x = (Math.random() * 2 - 1) * lim;
      const z = (Math.random() * 2 - 1) * lim;
      if (isClearSpot(x, z)) { player.feet.x = x; player.feet.z = z; return; }
    }
  }
  player.feet.set(0, 0, 0);
}

export { player, keys, updatePlayer, resetPlayer };
