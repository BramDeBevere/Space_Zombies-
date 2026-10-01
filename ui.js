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
