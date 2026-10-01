// Karts — small driveable go-karts parked around the arena. Press F near one
// to jump in and drive (WASD + mouse), ploughing through the horde.
//
// Every client builds the same karts (identical positions), so a kart's array
// index is a shared id used on the wire. Driving is local: each player simulates
// only their own kart and broadcasts its position/heading. In multiplayer the
// host is authoritative for crush damage and streams all kart positions to the
// joiners, who lerp-render the karts they aren't driving.
import * as THREE from 'three';
import { scene, camera, ARENA_HALF, obstacles } from './world.js';
import { player, keys } from './player.js';
import { zombies } from './zombie.js';

const KART_SPEED_MAX = 14;      // forward top speed — a bit faster than running, not twitchy
const KART_REVERSE_MAX = -6;    // reverse top speed
const KART_ACCEL = 30;          // forward acceleration
const KART_TURN_RATE = 2.0;     // turn rate at full speed (rad/s)
const KART_RADIUS = 1.3;        // collision radius
export const KART_CRUSH_DAMAGE = 95;   // damage dealt when the kart hits a zombie
const KART_SEAT_EYE = 1.35;     // camera height in the driver's seat
const CRUSH_RADIUS = 2.3;       // how close a zombie must be to be crushed

const karts = [];
let playerKart = null;          // index of the kart the local player is driving

// Latest known position/heading of each remote kart, as reported by its driver
// (used by the host for crush + streaming; by joiners to render remote karts).
const netKarts = new Map();     // kart index -> { x, z, ry }

// Reused temporaries for the kart's first-person camera (heading-follow +
// mouse-look compose, see updateKarts).
const _kartUp = new THREE.Vector3(0, 1, 0);
const _kartTurnQ = new THREE.Quaternion();

// --- Build one kart mesh ---------------------------------------------------
// A simple toy go-kart (think race-day kart): red body, a white centre stripe,
// a low steering wheel, a bucket seat, four small wheels and a tiny roll cage.
// The kart's local +Z is its forward (matches the drive/heading math below).
function buildKart() {
  const g = new THREE.Group();
  const red = new THREE.MeshStandardMaterial({ color: 0xc8322b, roughness: 0.5, metalness: 0.12 });
  const white = new THREE.MeshStandardMaterial({ color: 0xeef0f2, roughness: 0.55, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.9 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xc7ccd4, roughness: 0.35, metalness: 0.7 });

  // Low body pan, a little longer than it is wide.
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.34, 2.5), red);
  body.position.y = 0.34;
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  // White centre stripe down the top, front to back.
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 2.35), white);
  stripe.position.y = 0.52;
  g.add(stripe);

  // A slightly raised nose at the front (+Z).
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.18, 0.5), red);
  nose.position.set(0, 0.5, 1.15);
  nose.castShadow = true;
  g.add(nose);

  // Bucket seat (dark) with a low back, behind the wheel.
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.16, 0.72), dark);
  seat.position.set(0, 0.5, -0.15);
  seat.castShadow = true;
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.5, 0.14), dark);
  back.position.set(0, 0.72, -0.48);
  back.castShadow = true;
  g.add(seat, back);

  // Steering wheel (dark torus) in front of the seat, leaned toward the driver.
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.045, 8, 18), dark);
  wheel.rotation.x = Math.PI / 2 - 0.45;
  wheel.position.set(0, 0.62, 0.28);
  g.add(wheel);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), dark);
  stem.position.set(0, 0.42, 0.3);
  g.add(stem);

  // Four small wheels.
  const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.16, 14);
  const wx = 0.72, wz = 1.0, wy = 0.24;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.rotation.z = Math.PI / 2;
    w.position.set(sx * wx, wy, sz * wz);
    w.castShadow = true;
    g.add(w);
  }

  // Small roll cage / headrest frame (metal tubes) behind the seat.
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.55, 0.07), metal);
    post.position.set(sx * 0.34, 0.75, -0.42);
    post.castShadow = true;
    g.add(post);
  }
  const cageTop = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.07, 0.07), metal);
  cageTop.position.set(0, 1.03, -0.42);
  g.add(cageTop);

  scene.add(g);
  return g;
}

// Park three karts in open ground, spread out and away from the centre.
export function spawnKarts() {
  const spots = [{ x: -20, z: -16 }, { x: 20, z: 14 }, { x: -6, z: 30 }];
  spots.forEach((s, i) => {
    const k = {
      id: i, group: buildKart(),
      x: s.x, z: s.z, ry: Math.random() * Math.PI * 2, vy: 0,
    };
    karts.push(k);
    k.group.position.set(s.x, 0, s.z);
    k.group.rotation.y = k.ry;
  });
}

// --- Enter / exit ----------------------------------------------------------
function nearestFreeKart(x, z, max) {
  let best = null, bd = max;
  for (let i = 0; i < karts.length; i++) {
    const d = Math.hypot(karts[i].x - x, karts[i].z - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function tryEnter() {
  if (playerKart != null) return false;
  if (!player.onGround || player.onTower || player.climb) return false; // ground only
  const i = nearestFreeKart(player.feet.x, player.feet.z, 3.4);
  if (i == null) return false;
  const k = karts[i];
  playerKart = i;
  player.kartDriver = i;
  player.feet.set(k.x, 0, k.z);      // keep the feet in sync (distance/HUD)
  player.velocity.set(0, 0, 0);
  // Sit the camera in the seat, facing the nose — resets any mouse-look offset
  // so driving starts clean. updateKarts then only *rotates* the view by the
  // kart's heading change each frame, keeping mouse look on top.
  const fx0 = Math.sin(k.ry), fz0 = Math.cos(k.ry);
  camera.position.set(k.x + fx0 * 0.2, KART_SEAT_EYE, k.z + fz0 * 0.2);
  camera.lookAt(k.x + fx0, KART_SEAT_EYE, k.z + fz0);
  return true;
}

function tryExit() {
  if (playerKart == null) return false;
  const k = karts[playerKart];
  playerKart = null;
  player.kartDriver = null;
  // Step out to the kart's left.
  const fx = Math.sin(k.ry), fz = Math.cos(k.ry);
  player.feet.set(k.x - fz * 1.9, 0, k.z + fx * 1.9);
  player.velocity.set(0, 0, 0);
  return true;
}

/** main.js (F key): jump in or out. Returns 'enter' | 'exit' | null. */
export function toggleKart() {
  if (playerKart == null) return tryEnter() ? 'enter' : null;
  return tryExit() ? 'exit' : null;
}

/** Death / respawn: if we're driving, eject and free the kart. */
export function ejectPlayer() {
  if (playerKart == null) return;
  playerKart = null;
  player.kartDriver = null;
}

// --- Physics helpers -------------------------------------------------------
function lerpAngle(a, b, t) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}

function resolveKartCollision(k) {
  const lim = ARENA_HALF - KART_RADIUS;
  k.x = Math.max(-lim, Math.min(lim, k.x));
  k.z = Math.max(-lim, Math.min(lim, k.z));
  for (const o of obstacles) {
    const nx = o.box ? Math.max(o.x - o.halfX, Math.min(k.x, o.x + o.halfX)) : o.x;
    const nz = o.box ? Math.max(o.z - o.halfZ, Math.min(k.z, o.z + o.halfZ)) : o.z;
    const dx = k.x - nx, dz = k.z - nz;
    const d = Math.hypot(dx, dz);
    const min = o.box ? KART_RADIUS : o.r + KART_RADIUS;
    if (d < min) {
      if (d > 1e-4) {
        const push = min - d;
        k.x += (dx / d) * push;
        k.z += (dz / d) * push;
        k.vy *= 0.35; // take a hit off the obstacle
      } else if (o.box) {
        const dw = k.x - (o.x - o.halfX), de = (o.x + o.halfX) - k.x;
        const dn = k.z - (o.z - o.halfZ), ds = (o.z + o.halfZ) - k.z;
        const m = Math.min(dw, de, dn, ds);
        if (m === dw) k.x = o.x - o.halfX - KART_RADIUS;
        else if (m === de) k.x = o.x + o.halfX + KART_RADIUS;
        else if (m === dn) k.z = o.z - o.halfZ - KART_RADIUS;
        else k.z = o.z + o.halfZ + KART_RADIUS;
        k.vy *= 0.35;
      }
    }
  }
}

// Damage the zombies a kart at (x, z) is ploughing through.
function crush(x, z, onKartCrush) {
  for (const zom of zombies) {
    if (zom.dead) continue;
    const d = Math.hypot(zom.group.position.x - x, zom.group.position.z - z);
    if (d < CRUSH_RADIUS && onKartCrush) onKartCrush(zom);
  }
}

// --- Per-frame update ------------------------------------------------------
/**
 * Simulate the local player's kart and crush damage; host holds remote karts at
 * their reported spots (and crushes from them); joiners lerp remote karts toward
 * the host's stream.
 *   isHost  — we are the multiplayer host (hold + stream remote karts).
 *   doCrush — we're authoritative for crush damage (solo or host; NOT joiner,
 *             whose kart is crushed by the host to avoid double damage).
 */
export function updateKarts(dt, { isHost, doCrush, onKartCrush }) {
  // --- Local player's kart: always driven here ---
  if (playerKart != null) {
    const k = karts[playerKart];
    const throttle = (keys['KeyW'] ? 1 : 0) + (keys['KeyS'] ? -1 : 0);
    const steer = (keys['KeyD'] ? 1 : 0) + (keys['KeyA'] ? -1 : 0);
    if (throttle > 0) k.vy += KART_ACCEL * dt;
    else if (throttle < 0) k.vy -= KART_ACCEL * 0.7 * dt;
    else k.vy *= Math.pow(0.05, dt);
    k.vy = Math.max(KART_REVERSE_MAX, Math.min(KART_SPEED_MAX, k.vy));

    const prevRy = k.ry;
    const moving = Math.min(1, Math.abs(k.vy) / (KART_SPEED_MAX * 0.35));
    // The heading angle grows the opposite way the nose appears to turn (the
    // view's right axis is -X when facing +Z), so negate `steer`: D swings the
    // nose right, A swings it left. The (vy>=0) term keeps steering realistic
    // while reversing.
    k.ry -= steer * KART_TURN_RATE * moving * (k.vy >= 0 ? 1 : -1) * dt;

    const fx = Math.sin(k.ry), fz = Math.cos(k.ry);
    k.x += fx * k.vy * dt;
    k.z += fz * k.vy * dt;
    resolveKartCollision(k);
    player.feet.set(k.x, 0, k.z); // keep feet in sync for distance/HUD
    if (doCrush) crush(k.x, k.z, onKartCrush);

    // First-person seat. Move the camera with the seat, then rotate the view
    // only by the kart's heading *change* this frame (around world-up) instead
    // of hard-locking to the nose. The view still turns with the kart through
    // corners, but the mouse-look offset from PointerLockControls persists on
    // top, so you can look around while driving.
    camera.position.set(k.x + fx * 0.2, KART_SEAT_EYE, k.z + fz * 0.2);
    if (k.ry !== prevRy) {
      _kartTurnQ.setFromAxisAngle(_kartUp, k.ry - prevRy);
      camera.quaternion.premultiply(_kartTurnQ);
    }
  }

  // --- Other karts: follow the streamed position of whoever is driving ---
  for (let i = 0; i < karts.length; i++) {
    if (i === playerKart) continue;
    const k = karts[i];
    const nd = netKarts.get(i);
    if (!nd) continue;
    if (isHost) {
      // Host: hold the kart where its driver reported and crush from there.
      k.x = nd.x; k.z = nd.z;
      k.ry = lerpAngle(k.ry, nd.ry, Math.min(1, dt * 8));
      if (doCrush) crush(k.x, k.z, onKartCrush);
    } else {
      // Joiner: glide toward the streamed position (no crush; the host does it).
      const l = 1 - Math.pow(0.0001, dt);
      k.x += (nd.x - k.x) * Math.min(1, l * 4);
      k.z += (nd.z - k.z) * Math.min(1, l * 4);
      k.ry = lerpAngle(k.ry, nd.ry, Math.min(1, l * 4));
    }
  }

  for (const k of karts) {
    k.group.position.set(k.x, 0, k.z);
    k.group.rotation.y = k.ry;
  }
}

// --- Networking ------------------------------------------------------------

/** A driver reports where its kart is + heading (and who drives it). The host
 *  uses this for crush + to stream positions; everyone uses `driverOfKart` to
 *  show that player's head in the seat. */
export function receiveKartMove(kartId, x, z, dx, dz, driverId) {
  if (!karts[kartId]) return;
  netKarts.set(kartId, { x, z, ry: Math.atan2(dx, dz), driverId });
}

/** The id of the remote player currently driving kart `kartId` (or null). */
export function driverOfKart(kartId) {
  const nd = netKarts.get(kartId);
  return nd ? nd.driverId : null;
}

/** main.js: build the per-frame own-kart net state to broadcast (or null). */
export function localKartNetState() {
  if (playerKart == null) return null;
  const k = karts[playerKart];
  return { kartId: k.id, x: k.x, z: k.z, rx: Math.sin(k.ry), rz: Math.cos(k.ry) };
}

/** main.js (on 'left'): forget a remote driver's kart. */
export function dropKart(kartId) {
  netKarts.delete(kartId);
}

/** main.js (on 'left'): forget whichever kart `driverId` was riding. */
export function dropKartForDriver(driverId) {
  for (const [kartId, nd] of netKarts) if (nd.driverId === driverId) netKarts.delete(kartId);
}

/**
 * Host: snapshot every kart's position + who drives it, to stream to the
 * joiners. `myId` tags the host's own kart.
 */
export function hostKartsPayload(myId) {
  return karts.map((k, i) => {
    const driver =
      i === playerKart ? myId : (netKarts.get(i) ? netKarts.get(i).driverId : null);
    return { id: k.id, x: k.x, z: k.z, ry: k.ry, driver };
  });
}

/** Joiner: apply the host's kart snapshot (positions + drivers). */
export function applyKartStates(states) {
  if (!Array.isArray(states)) return;
  for (const s of states) {
    if (!karts[s.id]) continue;
    netKarts.set(s.id, { x: s.x, z: s.z, ry: s.ry, driverId: s.driver || null });
  }
}

/** The index of the kart `driverId` (a peer id) is riding in (or null). */
export function kartOfDriver(driverId) {
  if (driverId == null) return null;
  for (const [kartId, nd] of netKarts) if (nd.driverId === driverId) return kartId;
  return null;
}

/** World transform of a kart (for placing a driver's head in remotes.js). */
export function kartTransform(kartId) {
  const k = karts[kartId];
  return k ? { x: k.x, z: k.z, ry: k.ry } : null;
}

export const KART_NET_INTERVAL = 0.1; // seconds between kartmove broadcasts
