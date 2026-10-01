// Sound — all audio is synthesised with the Web Audio API (no asset files,
// matching the project's "no external assets" rule). A tiny ambient drone
// loops in the background and short SFX fire on shots, kills, bites and waves.
// Browsers require a user gesture before audio can start, so the AudioContext
// is created/resumed lazily on the first interaction.

let ctx = null;        // AudioContext
let master = null;     // master gain (overall volume + soft mute)
let noiseBuf = null;   // pre-rendered white noise (for shots / drones)

// Ambient drone voices (created on start, stopped on pause/death).
let ambientNodes = [];

const MASTER_LEVEL = 0.9;   // overall volume (0..1)

/** Lazily create (or resume) the AudioContext. Call on any user gesture. */
export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = MASTER_LEVEL;
    master.connect(ctx.destination);
    noiseBuf = makeNoiseBuffer(ctx);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

/** Set the overall master volume (0..1). No-op until the context exists. */
export function setMasterVolume(v) {
  if (!master) return;
  const level = Math.min(1, Math.max(0, Number.isFinite(v) ? v : MASTER_LEVEL));
  master.gain.value = level;
}

function makeNoiseBuffer(c) {
  const len = Math.floor(c.sampleRate * 1.0);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

// --- Small helper: schedule a gain envelope (attack -> decay) on a node ---
function env(gainNode, t0, peak, attack, decay) {
  gainNode.gain.cancelScheduledValues(t0);
  gainNode.gain.setValueAtTime(0.0001, t0);
  gainNode.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

// ---------------------------------------------------------------------------
// SFX
// ---------------------------------------------------------------------------

/** Gun shot: a short filtered noise burst + a low "thump". */
export function sfxShot() {
  if (!ctx) return;
  const t = ctx.currentTime;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(1600, t);
  bp.frequency.exponentialRampToValueAtTime(500, t + 0.12);
  bp.Q.value = 0.9;
  const g = ctx.createGain();
  env(g, t, 0.5, 0.004, 0.12);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.16);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(160, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
  const og = ctx.createGain();
  env(og, t, 0.35, 0.004, 0.12);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.16);
}

/** Knife slash: a fast, high whoosh (short filtered noise with a rising sweep). */
export function sfxKnife() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.08);
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  env(g, t, 0.35, 0.004, 0.09);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.12);
}

/** Shotgun blast: a big, crackly, very close noise burst. */
export function sfxShotgun() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3200, t);
  lp.frequency.exponentialRampToValueAtTime(300, t + 0.22);
  const g = ctx.createGain();
  env(g, t, 0.9, 0.003, 0.24);
  src.connect(lp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.28);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(110, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.22);
  const og = ctx.createGain();
  env(og, t, 0.5, 0.003, 0.22);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.26);
}

/** Sniper crack: a sharp, distant, powerful crack with a long low tail. */
export function sfxSniper() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(4000, t);
  bp.frequency.exponentialRampToValueAtTime(300, t + 0.3);
  bp.Q.value = 1.5;
  const g = ctx.createGain();
  env(g, t, 0.7, 0.002, 0.32);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.36);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(70, t);
  osc.frequency.exponentialRampToValueAtTime(32, t + 0.5);
  const og = ctx.createGain();
  env(og, t, 0.55, 0.004, 0.5);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.55);
}

/** RPG launch: a deep, whooshy thump that rolls into the engine. */
export function sfxRPG() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.exponentialRampToValueAtTime(160, t + 0.6);
  const g = ctx.createGain();
  env(g, t, 0.5, 0.02, 0.55);
  src.connect(lp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 0.65);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(50, t + 0.5);
  const og = ctx.createGain();
  env(og, t, 0.4, 0.02, 0.5);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 0.55);
}

/** Explosion: a huge low boom + a decaying noise wash. */
export function sfxExplosion() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(2600, t);
  lp.frequency.exponentialRampToValueAtTime(90, t + 0.9);
  const g = ctx.createGain();
  env(g, t, 1.0, 0.004, 0.95);
  src.connect(lp).connect(g).connect(master);
  src.start(t);
  src.stop(t + 1.0);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(90, t);
  osc.frequency.exponentialRampToValueAtTime(30, t + 0.9);
  const og = ctx.createGain();
  env(og, t, 0.8, 0.005, 0.9);
  osc.connect(og).connect(master);
  osc.start(t);
  osc.stop(t + 1.0);
}

/** Reload: two short mechanical clicks (mag in, bolt back). */
export function sfxReload() {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const [off, f] of [[0, 900], [0.22, 700]]) {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f, t + off);
    const g = ctx.createGain();
    env(g, t + off, 0.12, 0.001, 0.05);
    osc.connect(g).connect(master);
    osc.start(t + off);
    osc.stop(t + off + 0.08);
  }
}

/** Zombie kill: a descending "groan" (two detuned low oscillators) + a soft thud. */
export function sfxKill() {
  if (!ctx) return;
  const t = ctx.currentTime;

  for (const det of [0, 8]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.4);
    osc.detune.value = det;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.4);
    const g = ctx.createGain();
    env(g, t, 0.18, 0.01, 0.35);
    osc.connect(lp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(90, t);
  osc2.frequency.exponentialRampToValueAtTime(40, t + 0.18);
  const g2 = ctx.createGain();
  env(g2, t, 0.3, 0.005, 0.16);
  osc2.connect(g2).connect(master);
  osc2.start(t);
  osc2.stop(t + 0.2);
}

/** Player is bitten: a harsh, short sting + low hit. */
export function sfxHit() {
  if (!ctx) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(180, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.15);
  const g = ctx.createGain();
  env(g, t, 0.28, 0.005, 0.18);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.2);

  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 500;
  const ng = ctx.createGain();
  env(ng, t, 0.2, 0.004, 0.14);
  src.connect(lp).connect(ng).connect(master);
  src.start(t);
  src.stop(t + 0.18);
}

/** New wave: a rising two-note alarm blip. */
export function sfxWave() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const notes = [330, 494]; // D4 -> B4
  notes.forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const start = t + i * 0.13;
    osc.frequency.setValueAtTime(f, start);
    const g = ctx.createGain();
    env(g, start, 0.22, 0.01, 0.22);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + 0.28);
  });
}

/** Player death: a slow, sad descending chord. */
export function sfxDeath() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const freqs = [220, 165, 110];
  freqs.forEach((f) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.5, t + 1.1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const g = ctx.createGain();
    env(g, t, 0.16, 0.02, 1.0);
    osc.connect(lp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 1.2);
  });
}

/** Starting the game: a soft, warm "power on" sweep. */
export function sfxStart() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(320, t + 0.3);
  const g = ctx.createGain();
  env(g, t, 0.25, 0.02, 0.3);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.36);
}

/** Jumping into a kart: a short engine "rev" — rising sawtooth with a rumble. */
export function sfxKartEnter() {
  if (!ctx) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(70, t);
  osc.frequency.exponentialRampToValueAtTime(340, t + 0.18);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.exponentialRampToValueAtTime(2200, t + 0.18);
  const g = ctx.createGain();
  env(g, t, 0.4, 0.02, 0.22);
  osc.connect(lp).connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.28);

  // Low rumble under the rev.
  const th = ctx.createOscillator();
  th.type = 'sine';
  th.frequency.setValueAtTime(90, t);
  th.frequency.exponentialRampToValueAtTime(50, t + 0.24);
  const tg = ctx.createGain();
  env(tg, t, 0.35, 0.02, 0.24);
  th.connect(tg).connect(master);
  th.start(t);
  th.stop(t + 0.28);
}

/** Hopping out of a kart: a low engine "cut-off" clunk. */
export function sfxKartExit() {
  if (!ctx) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.18);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1200, t);
  lp.frequency.exponentialRampToValueAtTime(400, t + 0.18);
  const g = ctx.createGain();
  env(g, t, 0.35, 0.005, 0.2);
  osc.connect(lp).connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.24);

  // A small mechanical clunk.
  const cl = ctx.createOscillator();
  cl.type = 'square';
  cl.frequency.setValueAtTime(140, t);
  const cg = ctx.createGain();
  env(cg, t, 0.18, 0.002, 0.08);
  cl.connect(cg).connect(master);
  cl.start(t);
  cl.stop(t + 0.1);
}

// ---------------------------------------------------------------------------
// Ambient drone — a subtle looping hum so the arena doesn't feel dead silent.
// ---------------------------------------------------------------------------

/** Start the ambient drone (idempotent). */
export function startAmbient() {
  if (!ctx || ambientNodes.length) return;
  const t = ctx.currentTime;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 320;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.06, t + 2.5); // slow fade-in

  // Two low detuned oscillators for a warm, slightly unsettling hum.
  const o1 = ctx.createOscillator();
  o1.type = 'sine';
  o1.frequency.value = 55;
  const o2 = ctx.createOscillator();
  o2.type = 'sine';
  o2.frequency.value = 55 * 1.005; // slight detune -> beating

  // A very quiet, filtered noise layer for "air".
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const nlp = ctx.createBiquadFilter();
  nlp.type = 'lowpass';
  nlp.frequency.value = 240;
  const ng = ctx.createGain();
  ng.gain.value = 0.05;
  src.connect(nlp).connect(ng).connect(lp);

  o1.connect(lp);
  o2.connect(lp);
  lp.connect(g).connect(master);

  o1.start(t);
  o2.start(t);
  src.start(t);

  ambientNodes = [o1, o2, src, g, lp];
}

/** Stop the ambient drone (fade out then disconnect). */
export function stopAmbient() {
  if (!ctx || !ambientNodes.length) return;
  const [o1, o2, src, g] = ambientNodes;
  const t = ctx.currentTime;
  try { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4); } catch (e) { /* ignore */ }
  const stop = (n) => { try { n.stop(t + 0.45); } catch (e) { /* ignore */ } };
  stop(o1); stop(o2); stop(src);
  setTimeout(() => {
    ambientNodes.forEach((n) => { try { n.disconnect(); } catch (e) { /* ignore */ } });
    ambientNodes = [];
  }, 450);
}
