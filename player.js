// Player — camera rig (feet position + velocity), WASD movement, arena + obstacle collision.
import * as THREE from 'three';
import { EYE_HEIGHT, PLAYER_RADIUS, ARENA_HALF, obstacles } from './world.js';
import { ZOMBIE_HP } from './zombie.js';

const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;
const GRAVITY = 26;        // downward acceleration (units/s^2)
const JUMP_VELOCITY = 8.5; // initial upward velocity when jumping

const player = {
  feet: new THREE.Vector3(0, 0, 0), // camera = feet + (0, EYE_HEIGHT + feet.y, 0)
  velocity: new THREE.Vector3(),    // horizontal (x,z) movement only
  vy: 0,          // vertical velocity
  onGround: true, // true while standing on the floor
  hp: ZOMBIE_HP,
};

const keys = {};
window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();

function clampToArena(p) {
  const lim = ARENA_HALF - PLAYER_RADIUS;
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
}

// Push the player out of any obstacle: a circle ({r}) or an axis-aligned box
// ({box:true, halfX, halfZ}) in top-down (x, z).
function resolveObstacles(p) {
  for (const o of obstacles) {
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
 * gives the same WASD-relative motion the game always had.
 */
function updatePlayer(dt, camera) {
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
  resolveObstacles(player.feet);

  // --- Vertical: gravity + jump (Space) ---
  if (player.onGround && keys['Space']) {
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

  camera.position.set(player.feet.x, EYE_HEIGHT + player.feet.y, player.feet.z);
}

function resetPlayer() {
  player.feet.set(0, 0, 0);
  player.velocity.set(0, 0, 0);
  player.vy = 0;
  player.onGround = true;
}

export { player, keys, updatePlayer, resetPlayer };
