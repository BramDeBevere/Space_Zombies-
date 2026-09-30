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
const banner = document.getElementById('banner');

let isDead = false;

export function setDead(dead) { isDead = dead; }

export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function showOverlay(title, sub) {
  overlay.querySelector('h1').innerHTML = title;
  const p = overlay.querySelector('p');
  if (p) p.innerHTML = sub;
  overlay.querySelector('.cta').textContent = isDead ? 'Click to try again' : 'Click to play';
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
