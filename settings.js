// Settings — player-configurable options with sensible defaults. Everything
// works out of the box; the values persist in localStorage so a choice made
// once sticks around. `applySettings()` pushes the current values into the
// systems that care about them (camera FOV, audio volume, weapon FOV, mouse
// sensitivity).
import { camera } from './world.js';
import { setMasterVolume } from './sound.js';
import { setWeaponFov } from './weapon.js';

// Sensible defaults — match the game's original hard-coded behaviour.
export const DEFAULTS = {
  pvp: true,         // players can damage each other in a multiplayer room
  spawn: 'center',   // 'center' | 'random' — where a player spawns
  volume: 0.9,       // master audio volume, 0..1
  sensitivity: 1.0,  // mouse look speed multiplier
  fov: 72,           // base field of view in degrees
};

const KEY = 'deadarena-settings';

// The live settings object (loaded from storage over the defaults).
export const settings = { ...DEFAULTS };

let controlsRef = null;   // main.js sets the PointerLockControls instance

// Clamp each key to a safe range/type so a corrupt stored value can't break
// the game.
function sanitize(s) {
  const out = { ...DEFAULTS };
  out.pvp = s.pvp !== false;                    // default true
  out.spawn = s.spawn === 'random' ? 'random' : 'center';
  out.volume = Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : DEFAULTS.volume;
  out.sensitivity = Number.isFinite(s.sensitivity) ? Math.min(3, Math.max(0.2, s.sensitivity)) : DEFAULTS.sensitivity;
  out.fov = Number.isFinite(s.fov) ? Math.min(100, Math.max(55, s.fov)) : DEFAULTS.fov;
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(settings, sanitize(JSON.parse(raw)));
    else Object.assign(settings, DEFAULTS);
  } catch {
    Object.assign(settings, DEFAULTS);
  }
  return settings;
}

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
}

// main.js: give us the controls so sensitivity can be applied.
export function setControls(c) { controlsRef = c; }

// Push the current settings into the live systems. Call once at startup and
// after any change.
export function applySettings() {
  setWeaponFov(settings.fov);
  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
  setMasterVolume(settings.volume);
  if (controlsRef) controlsRef.pointerSpeed = settings.sensitivity;
}
