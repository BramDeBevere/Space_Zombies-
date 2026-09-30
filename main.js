// Dead Arena — a tiny 3D first-person zombie survival game.
// main.js only wires the modules together: world, player, zombie, weapon, ui.
// Pure Three.js from a pinned CDN (see index.html import map). No build step,
// no npm, no external asset files — every mesh is generated at runtime.

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

import { renderer, scene, camera } from './world.js';
import { player, updatePlayer, resetPlayer } from './player.js';
import {
  ZOMBIE_HP, ZOMBIE_HIT_DAMAGE, ZOMBIE_KNOCKBACK, WAVE_CLEAR_DELAY,
  zombies, spawnWave, cleanupWave, animateZombies, animateIdleZombies,
} from './zombie.js';
import {
  tryFire, updateRecoil, updateWeaponRig, decayFlashlight,
  updateWeaponEffects, resetRecoil, resetFire,
} from './weapon.js';
import {
  setDead, hideOverlay, showOverlay, showBanner, updateHUD, showDeath,
  vignette, overlay, formatTime,
} from './ui.js';

// ---------------------------------------------------------------------------
// Controls — PointerLockControls gives us mouse look for free.
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);

// Click to fire (only while the pointer is locked and the game is live).
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (!controls.isLocked || !playing || dead) return;
  tryFire(() => { kills++; });
});

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let playing = false;
let dead = false;
let survived = 0;          // seconds of survival
let wave = 1;
let kills = 0;
let waveDelay = 0;         // counts up while the current wave is fully cleared
let lastTime = performance.now();
const _forward = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Flow — start / die / reset
// ---------------------------------------------------------------------------
function die() {
  dead = true;
  playing = false;
  setDead(true);
  controls.unlock();
  showDeath({ wave, kills, survivedLabel: formatTime(survived) });
}

function startGame() {
  dead = false;
  playing = true;
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

// Start / resume / restart on overlay click.
overlay.addEventListener('click', () => {
  if (dead) startGame();
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

  // --- Flashlight + hand rig (follows look) ---
  updateWeaponRig(_forward);

  // --- Zombies: chase, attack, die ---
  const anyAlive = animateZombies(dt, {
    player, camera, vignette,
    onZombieHit: (dir) => {
      player.hp -= ZOMBIE_HIT_DAMAGE;
      player.velocity.addScaledVector(dir, -ZOMBIE_KNOCKBACK);
      vignette.style.opacity = 0.9;
      setTimeout(() => {
        if (!dead) vignette.style.opacity = Math.max(0, 1 - player.hp / ZOMBIE_HP) * 0.5;
      }, 120);
    },
  });

  if (player.hp <= 0 && !dead) die();

  // --- Wave transition: when the wave is cleared, spawn a bigger, faster one ---
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
    }
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
  updateHUD({ hp: player.hp, maxHp: ZOMBIE_HP, survived, wave, nearest, alive });

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
