// Dead Arena — a tiny 3D first-person zombie survival game.
// main.js only wires the modules together: world, player, zombie, weapon, ui.
// Pure Three.js from a pinned CDN (see index.html import map). No build step,
// no npm, no external asset files — every mesh is generated at runtime.

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

import { renderer, scene, camera, skyDome } from './world.js';
import { player, updatePlayer, resetPlayer, applySpawn, towerInRange } from './player.js';
import {
  ZOMBIE_HP, ZOMBIE_HIT_DAMAGE, ZOMBIE_KNOCKBACK, WAVE_CLEAR_DELAY,
  zombies, spawnWave, cleanupWave, animateZombies, animateIdleZombies,
  updateZombieHealthBar, killZombie, animateRemoteZombies,
  makeZombieNet, removeZombie, findZombie,
} from './zombie.js';
import {
  tryFire, updateRecoil, updateWeaponRig, decayFlashlight,
  updateWeaponEffects, resetRecoil, setFireNet, setNetZombieDamage,
  setAiming, isAutoFire, scopeProgress, selectWeapon, switchWeapon, requestReload,
  resetWeapon, getWeaponName, getAmmo, setFireCallback, WEAPON_COUNT,
  setPvpEnabled, setWeaponFov,
} from './weapon.js';
import {
  setDead, hideOverlay, showOverlay, showBanner, updateHUD, showDeath,
  onModePick, onRoomAction, showMultiLobby, hideMultiLobby,
  setRoomName, setRoomStatus, showPlayWaiting,
  onSettingsChange, onSettingsReset, setSettingsValues,
  vignette, overlay, formatTime, setClimbHint,
} from './ui.js';
import {
  connectLobby, createRoom, joinRoom, leaveRoom,
  sendState, sendFire, sendHit, sendZState, sendWave,
  sendBite, sendZombieHit, sendBoom, sendKartMove, sendKartState,
  getRole, getId,
  disconnect as netDisconnect,
} from './net.js';
import {
  onLeft, onState, onFire, onBoom, updateRemotes, clearRemotes, remoteCount,
  positions as remotePositions,
} from './remotes.js';
import {
  spawnKarts, updateKarts, toggleKart, ejectPlayer,
  KART_CRUSH_DAMAGE, localKartNetState, hostKartsPayload,
  applyKartStates, receiveKartMove, dropKartForDriver,
} from './karts.js';
import {
  ensureAudio, sfxStart, sfxHit, sfxWave, sfxDeath, sfxKill,
  sfxKartEnter, sfxKartExit,
  startAmbient, stopAmbient,
} from './sound.js';
import {
  settings, loadSettings, saveSettings, applySettings, setControls, DEFAULTS,
} from './settings.js';

// ---------------------------------------------------------------------------
// Controls — PointerLockControls gives us mouse look for free.
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);

// Sniper scope overlay (CSS in index.html); its opacity tracks scopeProgress()
// each frame so the iron sight fades in as the FOV zooms and out as it relaxes.
const scopeEl = document.getElementById('scope');
const _biteDir = new THREE.Vector3();

// --- Weapon input: click to fire (auto weapons fire while held), R to reload,
// 1-6 / wheel to switch, right-click to aim the sniper. ---
let mouseDown = false;   // left mouse held — drives auto-fire
let aimHeld = false;     // right mouse held — sniper zoom

renderer.domElement.addEventListener('mousedown', (e) => {
  ensureAudio(); // unlock the AudioContext on the first user gesture
  if (!controls.isLocked || !playing || dead) return;
  if (e.button === 0) { mouseDown = true; fireOnce(); }
  else if (e.button === 2) { aimHeld = true; setAiming(true); }
});
renderer.domElement.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown = false;
  else if (e.button === 2) { aimHeld = false; setAiming(false); }
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Hotkeys 1-6 select a weapon; R starts a reload; F jumps in/out of a kart.
window.addEventListener('keydown', (e) => {
  if (!controls.isLocked || !playing || dead) return;
  if (e.code.startsWith('Digit')) {
    const n = parseInt(e.code.slice(5), 10);
    if (n >= 1 && n <= WEAPON_COUNT) selectWeapon(n - 1);
  } else if (e.code === 'KeyR') {
    requestReload();
  } else if (e.code === 'KeyF') {
    const r = toggleKart();
    if (r === 'enter') sfxKartEnter();
    else if (r === 'exit') sfxKartExit();
  }
});
// Mouse wheel cycles weapons.
window.addEventListener('wheel', (e) => {
  if (!controls.isLocked || !playing || dead) return;
  switchWeapon(e.deltaY > 0 ? 1 : -1);
}, { passive: true });

// Fire the current weapon once and route the result (kills / net).
function fireOnce() {
  if (!controls.isLocked || !playing || dead) return;
  if (mpActive && mpDead) return; // downed: no shooting until we respawn next wave
  const res = tryFire();
  if (res) routeFire(res);
}

// Route a fire result: apply + count kills (solo) or apply/report per-weapon
// damage + PvP hits + explosions (multiplayer, host-authoritative).
function routeFire(res) {
  if (mode === 'multi') {
    if (getRole() === 'host') {
      for (const zh of res.zHits) { const z = findZombie(zh.id); if (z) hostZombieDamage(z, zh.dmg); }
    } else {
      for (const zh of res.zHits) sendZombieHit(zh.id, zh.dmg);
    }
    for (const rh of res.remoteHits) sendHit(rh.id, rh.dmg);
    if (res.boom) sendBoom(res.boom.x, res.boom.y, res.boom.z, res.blastR);
  } else {
    for (const zh of res.zHits) if (applyZombieHit(zh.id, zh.dmg)) kills++;
  }
}

// Solo: apply damage to a local zombie; returns true if this shot killed it.
function applyZombieHit(id, dmg) {
  const z = findZombie(id);
  if (!z || z.dead) return false;
  z.hp = Math.max(0, z.hp - dmg);
  updateZombieHealthBar(z);
  if (z.hp <= 0) { killZombie(z); sfxKill(); return true; }
  return false;
}

// A kart ploughed through a zombie: apply heavy crush damage (mode-aware).
// Only ever called from updateKarts when we're crush-authoritative (solo or
// multi host). Solo mutates the local horde; the host applies it authoritatively
// and streams the result. A joiner never calls this (doCrush=false; the host
// crushes its kart), so the mode==='multi' joiner case is unreachable.
function handleKartCrush(z) {
  if (!z || z.dead) return;
  if (mode === 'multi') {
    hostZombieDamage(z, KART_CRUSH_DAMAGE); // host (authoritative)
    return;
  }
  // Solo
  z.hp = Math.max(0, z.hp - KART_CRUSH_DAMAGE);
  updateZombieHealthBar(z);
  if (z.hp <= 0) { killZombie(z); sfxKill(); kills++; }
}

// The RPG detonates asynchronously inside weapon.js; route that blast here too.
setFireCallback(routeFire);

// Start-screen mode picker (Solo / Multiplayer).
onModePick(async (m) => {
  mode = m;
  if (m === 'multi') {
    showMultiLobby();
    try { await connectLobby(netHandler); }  // open the WebRTC signalling peer
    catch { setRoomStatus('Could not open a connection. Reload and try again.'); }
  } else {
    hideMultiLobby();
  }
});

// Multiplayer lobby actions: create a room, join by code, or back.
// 'create' fires the 'created' event (netHandler) with the fresh code;
// 'join-code' resolves once the WebRTC data channel to the host is open.
onRoomAction((action, code) => {
  if (action === 'back') { multiReady = false; leaveRoom(); hideMultiLobby(); mode = 'solo'; return; }
  if (action === 'create') {
    setRoomStatus('Creating room…');
    createRoom('My Room').then(() => setRoomStatus('')); // code shown via 'created'
  } else if (action === 'join-code') {
    const c = (code || '').trim().toUpperCase();
    if (c.length < 3) { setRoomStatus('Type the 5-letter code the host shared.'); return; }
    setRoomStatus('Joining…');
    joinRoom(c).then((r) => {
      if (r && r.roomId) {
        multiReady = true;
        hideMultiLobby();
        showOverlay('DEAD<span class="sub"> ARENA</span>', `In room <b>${r.roomId}</b>. Click to play.`);
      } else {
        setRoomStatus('Could not join that room. Check the code and try again.');
      }
    });
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
let multiReady = false;   // in a room, waiting to click "play" (host or joiner)
let mpWave = 0;           // shared wave number (host authoritative; joiner mirrors)
let mpDead = false;       // multi: we're down, waiting for the next wave to respawn
let mpAllDownCooldown = 0; // host: pause before restarting after everyone died
const _fireDir = new THREE.Vector3();

// Single net event router (lobby + game messages). Lobby events drive the
// room list / host-ready / joiner-ready transitions; game events drive the
// shared horde and remote players.
function netHandler(t, d) {
  // --- lobby ---
  if (t === 'created') {
    // We are the host. Show the room code and wait in our own room until we
    // click "Click to play".
    multiReady = true;
    setRoomName(d.roomId);
    showPlayWaiting();
    return;
  }
  if (t === 'disconnected') {
    // The signalling link dropped (e.g. the host's tab closed, or the network
    // dropped). Return to the lobby if we were mid-game; otherwise just note it.
    if (mpActive) {
      exitMulti(false);
      playing = false;
      controls.unlock();
      showMultiLobby();
    } else if (mode === 'multi') {
      setRoomStatus('Connection lost. Try again.');
    }
    return;
  }
  // --- game ---
  if (t === 'left') { onLeft(d.id); dropKartForDriver(d.id); }
  else if (t === 'state') onState(d);
  else if (t === 'fire') onFire(d);
  else if (t === 'hit') applyLocalHit(d);
  else if (t === 'zstate') applyRemoteZombies(d.zs);
  else if (t === 'wave') {
    mpWave = d.n;
    if (!mpActive) return;
    if (d.n === 1) restartRunLocal();      // everyone went down: run reset (joiner side)
    else { if (mpDead) respawnMulti(); showBanner('WAVE ' + d.n); }
  }
  else if (t === 'bite') applyLocalBite(d);
  else if (t === 'zhit' && getRole() === 'host') hostZombieHit(d);
  else if (t === 'boom') onBoom(d);
  else if (t === 'kartmove' && getRole() === 'host' && d.driver !== getId()) receiveKartMove(d.k, d.x, d.z, d.dx, d.dz, d.driver);
  else if (t === 'kartstate' && getRole() !== 'host') applyKartStates(d.ks);
  else if (t === 'error') setRoomStatus(d.message || 'Connection problem.');
  else if (t === 'disconnected') { setRoomStatus('Connection lost to the server.'); }
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
  ejectPlayer(); // don't stay seated in a kart while dead
  showDeath({ wave, kills, survivedLabel: formatTime(survived) });
}

function startGame() {
  dead = false;
  playing = true;
  everStarted = true;
  setDead(false);
  player.hp = ZOMBIE_HP;
  ejectPlayer();
  resetPlayer();
  applySpawn(settings.spawn);
  resetRecoil();
  resetWeapon();
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
  mpWave = 0;
  waveDelay = 0;
  hostZStateTimer = 0;
  setNetZombieDamage(true);   // the host/joiner net path handles shared-zombie damage
  cleanupWave();              // start with no local horde; the host streams it
  if (getRole() === 'host') { wave = 1; spawnWave(1); sendWave(1); }
  const ps = document.getElementById('players-stat');
  if (ps) ps.style.display = '';
  // (the lobby WebSocket is already open and we're in a room by the time we get here)
}

function exitMulti(full) {
  mpActive = false;
  mpWave = 0;
  setFireNet(null);
  setNetZombieDamage(false);
  if (full) netDisconnect();   // full teardown (back to solo / connection lost)
  clearRemotes();
  cleanupWave();
  const ps = document.getElementById('players-stat');
  if (ps) ps.style.display = 'none';
}

// --- Shared horde (multiplayer) -------------------------------------------
// The HOST is authoritative: it simulates the horde (each zombie chasing the
// nearest player) and streams positions to the joiners. Joiners render that
// stream and report their shots back to the host so a kill drops for everyone.

let hostZStateTimer = 0;

// Who the horde should chase: us, plus (host only) the other players. The y
// height lets the host know when a player is up on a watchtower deck (out of
// the horde's bite reach).
function multiTargets() {
  const t = [{ id: 'me', x: player.feet.x, z: player.feet.z, y: player.feet.y }];
  if (getRole() === 'host') for (const p of remotePositions()) t.push(p);
  return t;
}

// Host: run the horde this frame and stream it.
function hostMulti(dt, camera) {
  const anyAlive = animateZombies(dt, {
    player, camera, targets: multiTargets(),
    onBite: (tid, dir, z) => {
      const dmg = z ? z.damage : ZOMBIE_HIT_DAMAGE;
      const kb = z ? z.knockback : ZOMBIE_KNOCKBACK;
      if (tid === 'me') {
        player.hp -= dmg;
        player.velocity.addScaledVector(dir, -kb);
        sfxHit();
        vignette.style.opacity = 0.9;
        if (player.hp <= 0) downInPlace();
      }
      sendBite(tid, tid, dmg, kb, dir);
    },
  });
  if (anyAlive) waveDelay = 0;
  else {
    waveDelay += dt;
    if (waveDelay >= WAVE_CLEAR_DELAY) {
      // Wave cleared: advance (or, after a run restart, start fresh on wave 2).
      // Anyone still downed respawns at full HP for the new wave.
      waveDelay = 0; wave++; cleanupWave(); spawnWave(wave); sendWave(wave);
      showBanner('WAVE ' + wave); sfxWave();
      if (mpDead) respawnMulti();
    }
  }
  // Everyone down: pause a beat, then reset the whole run to Wave 1.
  if (allPlayersDown()) {
    mpAllDownCooldown += dt;
    if (mpAllDownCooldown >= 2) { mpAllDownCooldown = 0; respawnAll(); }
  } else mpAllDownCooldown = 0;
  hostZStateTimer += dt;
  if (hostZStateTimer >= 0.05) {
    hostZStateTimer = 0;
    sendZState(zombies.map((z) => ({
      id: z.id, type: z.type, x: z.group.position.x, z: z.group.position.z,
      y: z.group.position.y, ry: z.group.rotation.y, hp: Math.round(z.hp), dead: z.dead,
    })));
    // Stream the shared karts (positions + who's driving) on the same cadence.
    sendKartState(hostKartsPayload(getId()));
  }
}

// Host: a shot/blast landed on a shared zombie (from the host or any joiner).
function hostZombieDamage(z, dmg) {
  if (!z || z.dead) return;
  z.hp = Math.max(0, z.hp - dmg);
  updateZombieHealthBar(z);
  if (z.hp <= 0) killZombie(z);
}
function hostZombieHit(d) { const z = findZombie(d.tid); if (z) hostZombieDamage(z, d.dmg || 22); }

// Joiner: reconcile our render zombies with the host's streamed snapshot.
function applyRemoteZombies(zs) {
  if (!Array.isArray(zs)) return;
  const seen = new Set();
  for (const s of zs) {
    seen.add(s.id);
    let z = findZombie(s.id);
    if (!z) z = makeZombieNet(s.id, s.x, s.z, s.type);
    z.net = { x: s.x, z: s.z, y: s.y || 0, ry: s.ry };
    z.netDead = !!s.dead;
    z.hp = s.hp;
    if (s.dead && !z.dead) killZombie(z);
  }
  for (const z of [...zombies]) if (!seen.has(z.id)) removeZombie(z);
}

// Joiner: the shared horde bit us.
function applyLocalBite(d) {
  if (d.pid !== getId()) return;
  player.hp -= d.dmg;
  const bdx = d.dx || 0, bdz = d.dz || 0;
  if (bdx || bdz) player.velocity.addScaledVector(_biteDir.set(bdx, 0, bdz), -(d.kb || ZOMBIE_KNOCKBACK));
  sfxHit();
  vignette.style.opacity = 0.9;
  if (player.hp <= 0) downInPlace();
}

// Begin a multiplayer session (host: click "play" while in their lobby;
// joiner: right after joining). Networking is already live at this point.
function beginMulti() {
  dead = false;
  multiReady = false;
  everStarted = true;
  setDead(false);
  player.hp = ZOMBIE_HP;
  ejectPlayer();
  resetPlayer();
  applySpawn(settings.spawn);
  resetRecoil();
  resetWeapon();
  survived = 0;
  vignette.style.opacity = 0;
  hideMultiLobby();
  hideOverlay();
  ensureAudio();
  sfxStart();
  startAmbient();
  setFireNet((res) => sendFire(res));
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
  if (player.hp <= 0) downInPlace();
}

// Respawn at full health for a (new) wave. Called when we were down and a
// wave starts; the player is teleported to a spawn point and re-armed.
function respawnMulti() {
  player.hp = ZOMBIE_HP;
  mpDead = false;
  ejectPlayer();
  resetPlayer();
  applySpawn(settings.spawn);
  resetWeapon();   // fresh ammo + no stray rockets / reloads
  showBanner('YOU RESPAWNED');
}

// We died in multiplayer: stand down in place until the next wave. The player
// is locked here (see the updatePlayer guard in update()) rather than
// teleported, so the death reads as "down until the round ends."
function downInPlace() {
  player.hp = 0;
  mpDead = true;
  ejectPlayer();          // out of any kart
  player.velocity.set(0, 0, 0);
  vignette.style.opacity = 1;
}

// True when everyone in the room is dead this round (us + every connected peer
// at 0 hp). The host uses this to restart the run after a brief pause.
function allPlayersDown() {
  if (!mpDead) return false;
  for (const p of remotePositions()) if (p.hp > 0) return false;
  return true;
}

// Everyone down: the host resets the shared horde to Wave 1 and tells the room,
// then respawns itself. Joiners react to the 'wave:1' broadcast by calling
// restartRunLocal() (no re-broadcast, so no loop). The session/room is kept.
function respawnAll() {
  wave = 1;
  cleanupWave();
  spawnWave(1);        // host is authoritative; joiners render this stream
  sendWave(1);         // broadcast the reset to the joiners
  restartRunLocal();
}

// The local half of a run reset: put *this* player back up for Wave 1. Called
// by the host from respawnAll() and by joiners from the 'wave' handler. The
// pointer stays locked (death never unlocks it), so a banner — not an overlay —
// signals the restart and play resumes straight into Wave 1.
function restartRunLocal() {
  wave = 1;
  mpDead = false;
  player.hp = ZOMBIE_HP;
  resetPlayer();
  resetWeapon();
  vignette.style.opacity = 0;
  hideMultiLobby();
  hideOverlay();
  showBanner('NEW RUN — WAVE 1');
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
// (resume) or restarts after death. `multiReady` covers "in a room, waiting to
// play" for both host and (re)joiners of a new room.
overlay.addEventListener('click', () => {
  // The settings panel (and its controls) swallow their own clicks, so reaching
  // here means the user clicked an empty part of the overlay. If settings are
  // open, close them instead of launching — the next click starts the game.
  const settingsEl = document.getElementById('settings');
  if (settingsEl && !settingsEl.classList.contains('hidden')) { settingsEl.classList.add('hidden'); return; }
  ensureAudio(); // first user gesture — unlock the AudioContext
  applySettings(); // master gain just (re)created — push the saved volume in
  if (multiReady) start();
  else if (dead) start();
  else if (!everStarted) start();
  else if (!controls.isLocked) controls.lock();
});

// --- Settings --------------------------------------------------------------
loadSettings();
setControls(controls);
applySettings();          // camera FOV, weapon FOV, audio volume, sensitivity
setPvpEnabled(settings.pvp);
setSettingsValues(settings);

// Park the driveable karts in the arena (shared by solo + multi).
spawnKarts();

// A control changed: update state, persist, and apply the live systems.
onSettingsChange((key, value) => {
  settings[key] = value;
  saveSettings();
  if (key === 'pvp') setPvpEnabled(value);
  else applySettings();
});
// Reset: restore defaults, reflect in the UI, persist, apply.
onSettingsReset(() => {
  Object.assign(settings, DEFAULTS);
  saveSettings();
  setPvpEnabled(settings.pvp);
  applySettings();
  setSettingsValues(settings);
});

// ---------------------------------------------------------------------------
// Per-frame update
// ---------------------------------------------------------------------------
function update(dt) {
  // --- Player movement (WASD relative to camera yaw) ---
  // A downed player (multiplayer) is locked in place until the next wave.
  if (!mpDead) updatePlayer(dt, camera);

  // --- Karts: drive + collide + crush; the host also simulates remote karts
  //     and joiners lerp them toward the host's stream (see karts.js).
  //     Crush authority = solo or host (a joiner's kart is crushed by the host).
  const isHostRole = mpActive && getRole() === 'host';
  updateKarts(dt, {
    isHost: isHostRole,
    doCrush: !mpActive || isHostRole,
    onKartCrush: handleKartCrush,
  });

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

  // Sniper scope: fade the iron sight in/out in lockstep with the zoom.
  if (scopeEl) {
    const p = scopeProgress();
    scopeEl.style.opacity = playing && !dead ? (p > 0 ? (0.2 + 0.8 * p).toFixed(3) : '0') : '0';
  }

  // --- Solo mode: zombies chase, attack, die; waves advance ---
  if (mode === 'solo') {
    const anyAlive = animateZombies(dt, {
      player, camera, vignette,
      onZombieHit: (dir, z) => {
        player.hp -= z ? z.damage : ZOMBIE_HIT_DAMAGE;
        player.velocity.addScaledVector(dir, -(z ? z.knockback : ZOMBIE_KNOCKBACK));
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
    sendState(player.feet.x, player.feet.y, player.feet.z, yaw, mpDead ? 0 : player.hp);
    updateRemotes(dt, camera);
    // Shared horde: the host simulates + streams; joiners render the stream.
    if (getRole() === 'host') hostMulti(dt, camera);
    else animateRemoteZombies(dt, camera);
    // Joiners report where their kart is so the host can hold/crush it; the
    // host instead streams the shared kart snapshot (see hostMulti above).
    if (getRole() !== 'host') {
      const ks = localKartNetState();
      if (ks) sendKartMove(ks.kartId, ks.x, ks.z, ks.rx, ks.rz, getId());
    }
  }

  // --- Auto-fire: full-auto weapons fire continuously while held ---
  if (mouseDown && isAutoFire()) fireOnce();

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
  const ammo = getAmmo();
  updateHUD({
    hp: player.hp, maxHp: ZOMBIE_HP, survived, wave, nearest, alive,
    players: mode === 'multi' ? remoteCount() + 1 : undefined,
    weapon: getWeaponName(),
    ammo: ammo ? (ammo.reloading ? 'RELOADING' : `${ammo.mag}/${ammo.max}`) : '∞',
  });

  // Climb / descend prompt: show the E keycap when the player is in range of
  // a ladder (grounded and near a tower, or standing on a deck).
  const inTowerRange = (playing && !dead) ? towerInRange(player.feet) : null;
  setClimbHint(inTowerRange
    ? (player.onTower ? '<kbd>E</kbd> descend' : '<kbd>E</kbd> climb')
    : null);

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
