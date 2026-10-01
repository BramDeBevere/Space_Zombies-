// UI — overlay, banner, vignette and the HUD. Pure DOM; the game loop passes
// in the current stats. `dead` is a getter so the CTA label stays in sync with
// the main module's death state.
const overlay = document.getElementById('overlay');
const vignette = document.getElementById('vignette');
const healthFill = document.getElementById('healthfill');
const hpValue = document.getElementById('hpvalue');
const timerValue = document.getElementById('timer');
const distanceValue = document.getElementById('distance');
const waveValue = document.getElementById('wave');
const zombiesValue = document.getElementById('zombies');
const playersValue = document.getElementById('players');
const weaponName = document.getElementById('weapon-name');
const weaponAmmo = document.getElementById('weapon-ammo');
const banner = document.getElementById('banner');
const climbHint = document.getElementById('climb-hint');
const modeSolo = document.querySelector('#overlay [data-mode="solo"]');
const modeMulti = document.querySelector('#overlay [data-mode="multi"]');
const modeRow = document.getElementById('mode-row');
const overlayDesc = document.getElementById('overlay-desc');
const cta = document.getElementById('cta');
const multi = document.getElementById('multi');
const roomOpts = document.getElementById('room-opts');
const roomReady = document.getElementById('room-ready');
const roomCode = document.getElementById('room-code');
const roomHint = document.getElementById('room-hint');
const roomStatus = document.getElementById('room-status');
const roomJoinCode = document.getElementById('room-join-code');
const roomJoin = document.getElementById('room-join');

let isDead = false;
let modePickCb = null;   // set by main.js: picks solo/multi on the start screen
let roomActionCb = null; // set by main.js: handles create / join-code / back

export function setDead(dead) { isDead = dead; }
export function onModePick(fn) { modePickCb = fn; }
export function onRoomAction(fn) { roomActionCb = fn; }
if (modeSolo) modeSolo.addEventListener('click', (e) => { e.stopPropagation(); modePickCb && modePickCb('solo'); });
if (modeMulti) modeMulti.addEventListener('click', (e) => { e.stopPropagation(); modePickCb && modePickCb('multi'); });
if (document.getElementById('room-create')) document.getElementById('room-create').addEventListener('click', (e) => { e.stopPropagation(); roomActionCb && roomActionCb('create'); });
if (roomJoin) roomJoin.addEventListener('click', (e) => { e.stopPropagation(); roomActionCb && roomActionCb('join-code', roomJoinCode ? roomJoinCode.value : ''); });
if (roomJoinCode) roomJoinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); roomActionCb && roomActionCb('join-code', roomJoinCode.value); } });
if (document.getElementById('room-back')) document.getElementById('room-back').addEventListener('click', (e) => { e.stopPropagation(); roomActionCb && roomActionCb('back'); });

// --- Settings panel --------------------------------------------------------
const settingsPanel = document.getElementById('settings');
const settingsToggle = document.getElementById('settings-toggle');
const setPvp = document.getElementById('set-pvp');
const setSpawn = document.getElementById('set-spawn');
const setVolume = document.getElementById('set-volume');
const setSensitivity = document.getElementById('set-sensitivity');
const setFov = document.getElementById('set-fov');
const setVolumeVal = document.getElementById('set-volume-val');
const setSensitivityVal = document.getElementById('set-sensitivity-val');
const setFovVal = document.getElementById('set-fov-val');
const setReset = document.getElementById('set-reset');

let settingsChangeCb = null;  // (key, value) => void — main.js updates + persists
let settingsResetCb = null;   // () => void — restore defaults
export function onSettingsChange(fn) { settingsChangeCb = fn; }
export function onSettingsReset(fn) { settingsResetCb = fn; }

// Populate the controls from a settings object (call after load / on reset).
export function setSettingsValues(s) {
  if (setPvp) setPvp.checked = !!s.pvp;
  if (setSpawn) setSpawn.value = s.spawn === 'random' ? 'random' : 'center';
  if (setVolume) setVolume.value = Math.round(s.volume * 100);
  if (setVolumeVal) setVolumeVal.textContent = Math.round(s.volume * 100) + '%';
  if (setSensitivity) setSensitivity.value = Math.round(s.sensitivity * 100);
  if (setSensitivityVal) setSensitivityVal.textContent = s.sensitivity.toFixed(2);
  if (setFov) setFov.value = Math.round(s.fov);
  if (setFovVal) setFovVal.textContent = Math.round(s.fov) + '\u00B0';
}

// The whole panel lives inside the start-overlay, whose click starts the game.
// Swallow clicks here so the controls work without launching/resuming.
if (settingsToggle) settingsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (settingsPanel) settingsPanel.classList.toggle('hidden');
});
if (settingsPanel) settingsPanel.addEventListener('click', (e) => e.stopPropagation());

// The keybind grid is hidden by default; "Key bindings" toggles it on/off.
const keysToggle = document.getElementById('keys-toggle');
const keysRow = document.getElementById('keys-row');
if (keysToggle) keysToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (keysRow) keysRow.classList.toggle('hidden');
});
if (setPvp) setPvp.addEventListener('change', () => settingsChangeCb && settingsChangeCb('pvp', setPvp.checked));
if (setSpawn) setSpawn.addEventListener('change', () => settingsChangeCb && settingsChangeCb('spawn', setSpawn.value));
if (setVolume) setVolume.addEventListener('input', () => {
  if (setVolumeVal) setVolumeVal.textContent = setVolume.value + '%';
  settingsChangeCb && settingsChangeCb('volume', Number(setVolume.value) / 100);
});
if (setSensitivity) setSensitivity.addEventListener('input', () => {
  const v = Number(setSensitivity.value) / 100;
  if (setSensitivityVal) setSensitivityVal.textContent = v.toFixed(2);
  settingsChangeCb && settingsChangeCb('sensitivity', v);
});
if (setFov) setFov.addEventListener('input', () => {
  if (setFovVal) setFovVal.textContent = setFov.value + '\u00B0';
  settingsChangeCb && settingsChangeCb('fov', Number(setFov.value));
});
if (setReset) setReset.addEventListener('click', (e) => { e.stopPropagation(); settingsResetCb && settingsResetCb(); });

/** Show the multiplayer lobby (create a room, or type a code to join). */
export function showMultiLobby() {
  if (modeRow) modeRow.classList.add('hidden');
  if (multi) multi.classList.remove('hidden');
  if (overlayDesc) overlayDesc.innerHTML = 'Create a room to get a code, or type a friend&rsquo;s code to join.';
  if (roomOpts) roomOpts.classList.remove('hidden');
  if (roomReady) roomReady.classList.add('hidden');
  if (roomStatus) roomStatus.textContent = '';
  if (roomJoinCode) roomJoinCode.value = '';
  if (cta) cta.textContent = '';
}

/** Switch the lobby to the host's "your room code" view. */
export function setRoomName(code) {
  if (!roomCode) return;
  roomCode.textContent = code || '-----';
  if (roomReady) roomReady.classList.remove('hidden');
  if (roomOpts) roomOpts.classList.add('hidden');
  if (roomHint) roomHint.textContent = 'Share this code — friends pick Multiplayer and type it to join. Click to play when ready.';
}
export function setRoomStatus(msg) { if (roomStatus) roomStatus.textContent = msg || ''; }
export function showPlayWaiting() {
  if (cta) cta.textContent = 'Click to play';
  if (roomStatus) roomStatus.textContent = 'Waiting for friends to join…';
}
/** Hide the lobby and restore the normal start screen. */
export function hideMultiLobby() {
  if (multi) multi.classList.add('hidden');
  if (modeRow) modeRow.classList.remove('hidden');
  if (cta) cta.textContent = 'Click to play';
}

export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function showOverlay(title, sub) {
  overlay.querySelector('h1').innerHTML = title;
  const p = overlay.querySelector('p');
  if (p) p.innerHTML = sub;
  // Default the call-to-action to the normal label ("Click to play") unless
  // this is a genuine death screen, so callers (e.g. the multiplayer run
  // restart) don't have to remember to reset it themselves.
  const cta = overlay.querySelector('.cta');
  if (cta) cta.textContent = isDead ? 'Click to try again' : 'Click to play';
  overlay.classList.remove('hidden');
}

export function hideOverlay() {
  overlay.classList.add('hidden');
}

export function showBanner(text) {
  if (!banner) return;
  banner.textContent = text;
  banner.classList.remove('show');
  void banner.offsetWidth; // restart the CSS animation
  banner.classList.add('show');
}

/**
 * Refresh the HUD.
 * stats = { hp, maxHp, survived, wave, nearest, alive, onDeath() }
 * nearest: metres to the nearest live zombie (Infinity when none alive).
 */
export function updateHUD(stats) {
  const pct = Math.max(0, stats.hp) / stats.maxHp;
  healthFill.style.width = `${pct * 100}%`;
  healthFill.style.background =
    pct > 0.5 ? 'linear-gradient(90deg,#28d17a,#58f0a0)'
      : pct > 0.25 ? 'linear-gradient(90deg,#e0a83a,#ffd36e)'
        : 'linear-gradient(90deg,#c0392b,#ff6b5e)';
  hpValue.textContent = `${Math.max(0, Math.round(stats.hp))} / ${stats.maxHp}`;
  timerValue.textContent = formatTime(stats.survived);
  waveValue.textContent = `${stats.wave}`;
  distanceValue.textContent = stats.alive === 0 ? '—' : `${stats.nearest.toFixed(1)}m`;
  zombiesValue.textContent = `${stats.alive}`;
  if (stats.players != null) playersValue.textContent = `${stats.players}`;
  if (stats.weapon != null) weaponName.textContent = stats.weapon;
  if (stats.ammo != null) {
    weaponAmmo.textContent = stats.ammo;
    weaponAmmo.classList.toggle('reloading', String(stats.ammo).toUpperCase() === 'RELOADING');
  }
}

/**
 * Show/hide the contextual climb prompt near the crosshair. `html` may include
 * a <kbd> for the keycap; pass null to hide.
 */
export function setClimbHint(html) {
  if (!climbHint) return;
  if (!html) { climbHint.classList.remove('show'); return; }
  climbHint.innerHTML = html;
  climbHint.classList.add('show');
}

/**
 * Present the "you died" overlay.
 * ctx = { wave, kills, survivedLabel }
 */
export function showDeath(ctx) {
  vignette.style.opacity = 1;
  showOverlay(
    '<span id="dead-title">YOU DIED</span>',
    `The horde got you on <b>Wave ${ctx.wave}</b> after <b>${ctx.survivedLabel}</b>.<br/>You killed <b>${ctx.kills}</b> zombie${ctx.kills === 1 ? '' : 's'}.`
  );
}

export { vignette, overlay };
