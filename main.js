// Dead Arena — a tiny 3D first-person zombie survival game.
// main.js only wires the modules together: world, player, zombie, weapon, ui.
// Pure Three.js from a pinned CDN (see index.html import map). No build step,
// no npm, no external asset files — every mesh is generated at runtime.

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

import { renderer, scene, camera, skyDome } from './world.js';
import { player, updatePlayer, resetPlayer } from './player.js';
import {
  ZOMBIE_HP, ZOMBIE_HIT_DAMAGE, ZOMBIE_KNOCKBACK, WAVE_CLEAR_DELAY,
  zombies, spawnWave, cleanupWave, animateZombies, animateIdleZombies,
} from './zombie.js';
import {
  tryFire, updateRecoil, updateWeaponRig, decayFlashlight,
  updateWeaponEffects, resetRecoil, resetFire, setFireNet,
} from './weapon.js';
import {
  setDead, hideOverlay, showOverlay, showBanner, updateHUD, showDeath,
  onModePick, onRoomAction, showMultiLobby, hideMultiLobby, setRoomCode,
  setRoomStatus, showPlayWaiting,
  vignette, overlay, formatTime,
} from './ui.js';
import {
  hostRoom, joinRoom, sendState, sendFire, sendHit,
  getId, disconnect as netDisconnect,
} from './net.js';
import {
  onPeer, onLeft, onState, onFire, updateRemotes, clearRemotes, remoteCount,
  applyShot,
} from './remotes.js';
import {
  ensureAudio, sfxStart, sfxHit, sfxWave, sfxDeath,
  startAmbient, stopAmbient,
} from './sound.js';

// ---------------------------------------------------------------------------
// Controls — PointerLockControls gives us mouse look for free.
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);

// Click to fire (only while the pointer is locked and the game is live).
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  ensureAudio(); // unlock the AudioContext on the first user gesture
  if (!controls.isLocked || !playing || dead) return;
  if (mode === 'multi') {
    // PvP: raycast against the other players and broadcast the damage.
    tryFire(null, () => {
      const hit = applyShot(camera);
      if (hit) sendHit(hit.id, hit.dmg);
    });
  } else {
    tryFire(() => { kills++; });
  }
});

// Start-screen mode picker (Solo / Multiplayer).
onModePick((m) => { mode = m; if (m === 'multi') showMultiLobby(); else hideMultiLobby(); });

// Multiplayer lobby actions: create a room / join by code / back.
onRoomAction(async (action, code) => {
  if (action === 'back') { hideMultiLobby(); mode = 'solo'; netDisconnect(); return; }
  if (!window.Peer) { setRoomStatus('Multiplayer unavailable — check your internet connection.'); return; }
  if (action === 'create') {
    setRoomStatus('Creating room…');
    try {
      const res = await hostRoom(netHandler);
      setRoomCode(res.code);
      showPlayWaiting();
    } catch (e) {
      setRoomStatus('Could not create a room. Check your connection and try again.');
    }
  } else if (action === 'join') {
    const c = String(code || '').trim();
    if (!c) { setRoomStatus('Enter a room code first.'); return; }
    setRoomStatus('Joining…');
    try {
      await joinRoom(c, netHandler);
      hideMultiLobby();
      beginMulti();
    } catch (e) {
      setRoomStatus((e && e.message) || 'Could not join that room.');
    }
  }
});

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let playing = false;
let dead = false;
let everStarted = false;   // true once the player has entered the game at least once
let survived = 0;          // seconds of survival
let wave = 1;
let kills = 0;
let waveDelay = 0;         // counts up while the current wave is fully cleared
let lastTime = performance.now();
const _forward = new THREE.Vector3();

// --- Multiplayer state ---
let mode = 'solo';        // 'solo' | 'multi'
let mpActive = false;     // true while we're connected + playing multi
const _fireDir = new THREE.Vector3();

// Shared net event router (used by both host and joiner).
function netHandler(t, d) {
  if (t === 'peer') onPeer(d.id);
  else if (t === 'left') onLeft(d.id);
  else if (t === 'state') onState(d);
  else if (t === 'fire') onFire(d);
  else if (t === 'hit') applyLocalHit(d);
  else if (t === 'error') setRoomStatus(d.message || 'Connection problem.');
  else if (t === 'disconnected') { setRoomStatus('Connection lost to host.'); }
}

// ---------------------------------------------------------------------------
// Flow — start / die / reset
// ---------------------------------------------------------------------------
function die() {
  dead = true;
  playing = false;
  setDead(true);
  sfxDeath();
  stopAmbient();
  controls.unlock();
  showDeath({ wave, kills, survivedLabel: formatTime(survived) });
}

function startGame() {
  dead = false;
  playing = true;
  everStarted = true;
  setDead(false);
  player.hp = ZOMBIE_HP;
  resetPlayer();
  resetRecoil();
  resetFire();
  wave = 1;
  kills = 0;
  waveDelay = 0;
  cleanupWave();
  spawnWave(wave);
  survived = 0;
  vignette.style.opacity = 0;
  hideOverlay();
  showBanner('WAVE 1');
  ensureAudio();
  sfxStart();
  startAmbient();
  controls.lock();
}

// --- Multiplayer flow ---
function start() {
  if (mode !== 'multi') exitMulti(); // clean up any previous multi session
  if (mode === 'multi') beginMulti();
  else startGame();
}

function enterMulti() {
  mode = 'multi';
  mpActive = true;
  const ps = document.getElementById('players-stat');
  if (ps) ps.style.display = '';
  cleanupWave(); // no zombies in multiplayer
  // (networking is already connected via hostRoom/joinRoom before we get here)
}

function exitMulti() {
  mpActive = false;
  setFireNet(null);
  netDisconnect();
  clearRemotes();
  const ps = document.getElementById('players-stat');
  if (ps) ps.style.display = 'none';
}

// Begin a multiplayer session (host: click "play" while in their lobby;
// joiner: right after joining). Networking is already live at this point.
function beginMulti() {
  dead = false;
  everStarted = true;
  setDead(false);
  player.hp = ZOMBIE_HP;
  resetPlayer();
  resetRecoil();
  resetFire();
  survived = 0;
  vignette.style.opacity = 0;
  hideMultiLobby();
  hideOverlay();
  ensureAudio();
  sfxStart();
  startAmbient();
  setFireNet((muzzle, end) => sendFire(muzzle.x, muzzle.y, muzzle.z, end.x, end.y, end.z));
  enterMulti();
  showBanner('MULTIPLAYER');
  controls.lock();
}

// A peer shot landed on us.
function applyLocalHit(d) {
  if (d.target !== getId()) return;
  player.hp -= d.dmg;
  sfxHit();
  vignette.style.opacity = 0.9;
  setTimeout(() => {
    if (!dead) vignette.style.opacity = Math.max(0, 1 - player.hp / ZOMBIE_HP) * 0.5;
  }, 120);
  if (player.hp <= 0) respawnMulti();
}

function respawnMulti() {
  player.hp = ZOMBIE_HP;
  resetPlayer();
  showBanner('YOU RESPAWNED');
}

controls.addEventListener('lock', () => {
  playing = true; // resume on (re)lock; safe to set again from startGame()
  if (!dead) hideOverlay();
});
controls.addEventListener('unlock', () => {
  playing = false;
  if (!dead) showOverlay(
    'DEAD<span class="sub"> ARENA</span>',
    'Paused. Click to resume.'
  );
});

// First click starts the game; afterwards the overlay click just re-locks
// (resume) or restarts after death.
overlay.addEventListener('click', () => {
  ensureAudio(); // first user gesture — unlock the AudioContext
  if (dead) start();
  else if (!everStarted) start();
  else if (!controls.isLocked) controls.lock();
});

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------
function update(dt) {
  // --- Player movement (WASD relative to camera yaw) ---
  updatePlayer(dt, camera);

  // Forward (pre-recoil) for the weapon rig — matches the original, which
  // captured the view direction before the recoil kick was baked in.
  _forward.set(0, 0, 0);
  camera.getWorldDirection(_forward);
  _forward.y = 0;
  _forward.normalize();

  // --- Recoil: strip last frame's baked pitch, decay, re-bake the kick ---
  updateRecoil(dt);

  // --- Flashlight + hand rig (follows look, eases with movement) ---
  // Decompose the player's horizontal velocity into camera-relative axes so the
  // gun can sway subtly as we walk.
  const vx = player.velocity.x, vz = player.velocity.z;
  const lateral = vx * (-_forward.z) + vz * _forward.x; // strafe (right+)
  const forwardMove = vx * _forward.x + vz * _forward.z; // walk (forward+)
  const speed = Math.hypot(vx, vz);
  updateWeaponRig(_forward, lateral, forwardMove, speed, dt, player.onGround);

  // --- Solo mode: zombies chase, attack, die; waves advance ---
  if (mode === 'solo') {
    const anyAlive = animateZombies(dt, {
      player, camera, vignette,
      onZombieHit: (dir) => {
        player.hp -= ZOMBIE_HIT_DAMAGE;
        player.velocity.addScaledVector(dir, -ZOMBIE_KNOCKBACK);
        sfxHit();
        vignette.style.opacity = 0.9;
        setTimeout(() => {
          if (!dead) vignette.style.opacity = Math.max(0, 1 - player.hp / ZOMBIE_HP) * 0.5;
        }, 120);
      },
    });

    if (player.hp <= 0 && !dead) die();

    // Wave transition: when the wave is cleared, spawn a bigger, faster one.
    if (anyAlive) {
      waveDelay = 0;
    } else {
      waveDelay += dt;
      if (waveDelay >= WAVE_CLEAR_DELAY) {
        waveDelay = 0;
        wave++;
        cleanupWave();
        spawnWave(wave);
        showBanner('WAVE ' + wave);
        sfxWave();
      }
    }
  }

  // --- Multiplayer: broadcast our transform + update the other players ---
  if (mpActive) {
    // _forward is the horizontal look direction (computed earlier this frame).
    const yaw = Math.atan2(_forward.x, _forward.z);
    sendState(player.feet.x, player.feet.y, player.feet.z, yaw, player.hp);
    updateRemotes(dt, camera);
  }

  // --- Weapon housekeeping ---
  decayFlashlight(dt);
  updateWeaponEffects(dt);

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
  else if (!dead) animateIdleZombies();

  // --- HUD ---
  let nearest = Infinity;
  let alive = 0;
  for (const z of zombies) {
    if (z.dead) continue;
    alive++;
    const d = Math.hypot(z.group.position.x - player.feet.x, z.group.position.z - player.feet.z);
    if (d < nearest) nearest = d;
  }
  updateHUD({
    hp: player.hp, maxHp: ZOMBIE_HP, survived, wave, nearest, alive,
    players: mode === 'multi' ? remoteCount() + 1 : undefined,
  });

  // Keep the sky dome centred on the player: follow position only, never
  // rotation, so the sky stays fixed in world space.
  if (skyDome) skyDome.position.copy(camera.position);

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

// Let the non-module fallback in index.html know the app finished loading.
window.__appReady = true;
