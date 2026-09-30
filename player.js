// Player — camera rig (feet position + velocity), WASD movement and arena clamp.
import * as THREE from 'three';
import { EYE_HEIGHT, PLAYER_RADIUS, ARENA_HALF } from './world.js';
import { ZOMBIE_HP } from './zombie.js';

const WALK_SPEED = 5.5;
const SPRINT_SPEED = 9.5;

const player = {
  feet: new THREE.Vector3(0, 0, 0), // camera = feet + (0, EYE_HEIGHT, 0)
  velocity: new THREE.Vector3(),
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
  camera.position.set(player.feet.x, EYE_HEIGHT, player.feet.z);
}

function resetPlayer() {
  player.feet.set(0, 0, 0);
  player.velocity.set(0, 0, 0);
}

export { player, keys, updatePlayer, resetPlayer };
