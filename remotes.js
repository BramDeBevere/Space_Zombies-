// remotes.js — renders and animates the OTHER players we see over the network.
// Each remote is a distinct blue character with a health bar; we smooth their
// network positions and locally draw their tracers so they look like you do.
import * as THREE from 'three';
import { scene } from './world.js';
import { playRemoteShotSfx, vfxRemoteBoom } from './weapon.js';
import { kartOfDriver, kartTransform } from './karts.js';

const remotes = new Map(); // id -> remote
const _dir = new THREE.Vector3();

// Deterministic colour per player: hash the (stable) peer id into a hue so the
// same player always renders in the same colour on every client.
const _tmpColor = new THREE.Color();
function colorForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const hue = ((h >>> 0) % 360) / 360;
  const base = _tmpColor.setHSL(hue, 0.62, 0.52).getHex();
  const skin = _tmpColor.setHSL(hue, 0.60, 0.70).getHex();
  const accent = _tmpColor.setHSL(hue, 0.95, 0.55).getHex();
  return { base, skin, accent, emissive: accent };
}

export function remoteCount() { return remotes.size; }

// World positions of the other players — the host uses these as horde targets.
export function positions() {
  const out = [];
  for (const r of remotes.values()) out.push({ id: r.id, x: r.group.position.x, y: r.group.position.y, z: r.group.position.z, hp: r.hp });
  return out;
}

// Every remote character as { id, group } — used by the weapon raycaster.
export function playerMeshes() {
  const out = [];
  for (const r of remotes.values()) out.push({ id: r.id, group: r.group });
  return out;
}

// Apply damage to a specific remote player (a shot that lands on them).
export function damageRemote(id, dmg) {
  const r = remotes.get(id);
  if (!r) return;
  r.hp = Math.max(0, r.hp - dmg);
  updateRemoteBar(r);
}

// Shared transient-effect list for remote tracers.
const effects = [];

// --- One remote player -----------------------------------------------------
function makeRemote(id) {
  const group = new THREE.Group();
  const c = colorForId(id);
  const mat = new THREE.MeshStandardMaterial({ color: c.base, roughness: 0.6, metalness: 0.1 });
  const skin = new THREE.MeshStandardMaterial({ color: c.skin, roughness: 0.7 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x0b1220, emissive: c.emissive, emissiveIntensity: 2.4 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.42), mat);
  body.position.y = 1.05; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), skin);
  head.position.y = 1.75; head.castShadow = true;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), accent);
  visor.position.set(0, 1.78, 0.22);
  const legGeo = new THREE.BoxGeometry(0.2, 0.8, 0.2);
  const legL = new THREE.Mesh(legGeo, mat); legL.position.set(-0.18, 0.4, 0);
  const legR = new THREE.Mesh(legGeo, mat); legR.position.set(0.18, 0.4, 0);

  group.add(body, head, visor, legL, legR);
  group.traverse((o) => { o.userData.remote = id; });  // weapon.js: attribute hits to this player
  scene.add(group);

  // A head that sits in the kart's seat while this player is driving; the
  // body stays parked (hidden) so they read as "in the kart" to everyone.
  const seat = new THREE.Group();
  const sHead = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.46), skin);
  sHead.castShadow = true;
  const sVisor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), accent);
  sVisor.position.set(0, 0.03, 0.22);
  seat.add(sHead, sVisor);
  seat.visible = false;
  scene.add(seat);

  const bar = makeHealthBar();
  bar.fill.material.color.set(c.base);
  scene.add(bar.group);

  return {
    id,
    color: c.base,
    group,
    seat,
    healthBar: bar,
    target: new THREE.Vector3(group.position.x, 0, group.position.z),
    prev: new THREE.Vector3(),
    ay: 0, // last reported facing (yaw)
    hp: 100,
    lastSeen: performance.now(),
    fade: 1,
  };
}

// Billboarded health bar (same shape as the zombies', so it reads the same).
function makeHealthBar() {
  const group = new THREE.Group();
  const W = 0.95, H = 0.13;
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshBasicMaterial({ color: 0x11141a, transparent: true, opacity: 0.85 })
  );
  const fillGeo = new THREE.PlaneGeometry(W, H);
  fillGeo.translate(W / 2, 0, 0);
  const fill = new THREE.Mesh(
    fillGeo,
    new THREE.MeshBasicMaterial({ color: 0x5fb6ff, transparent: true })
  );
  fill.position.set(-W / 2, 0, 0.002);
  group.add(back, fill);
  group.position.set(0, 2.35, 0);
  return { group, back, fill };
}

// --- Network event handlers ------------------------------------------------
export function onPeer(id) {
  if (!remotes.has(id)) {
    const r = makeRemote(id);
    // Appear at the arena centre; first state message will place them.
    r.group.position.set(0, 0, 0);
    r.prev.copy(r.group.position);
    remotes.set(id, r);
  }
}

export function onLeft(id) {
  const r = remotes.get(id);
  if (r) { disposeRemote(r); remotes.delete(id); }
}

export function onState(d) {
  // If we haven't been told about this peer yet (roster message lost, or the
  // peer joined after us), create the remote now so the first state renders it.
  if (!remotes.has(d.id)) onPeer(d.id);
  const r = remotes.get(d.id);
  if (!r) return;
  r.target.set(d.x, d.y || 0, d.z);
  if (typeof d.ay === 'number') r.ay = d.ay;
  r.hp = d.hp == null ? r.hp : d.hp;
  r.lastSeen = performance.now();
  r.fade = 1;
  updateRemoteBar(r);
}

// A peer fired: draw their tracers + play their gun sound (weapon-aware).
export function onFire(d) {
  if (!d) return;
  const wId = d.wId || 'pistol';
  for (const t of d.tr || []) {
    if (typeof t.fx === 'number') {
      const a = new THREE.Vector3(t.fx, t.fy, t.fz);
      const b = new THREE.Vector3(t.tx, t.ty, t.tz);
      spawnRemoteTracer(a, b, wId);
    } else if (t.from && t.to) {
      spawnRemoteTracer(t.from, t.to, wId);
    }
  }
  playRemoteShotSfx(wId, d.melee);
}

// A peer's RPG detonated: show the blast VFX.
export function onBoom(d) {
  if (!d) return;
  vfxRemoteBoom(d.x, d.y, d.z, d.r);
}

/** Remove every remote (used when the connection drops). */
export function clearRemotes() {
  for (const r of [...remotes.values()]) disposeRemote(r);
  remotes.clear();
}

function disposeRemote(r) {
  scene.remove(r.group);
  scene.remove(r.healthBar.group);
  if (r.seat) scene.remove(r.seat);
  r.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  if (r.seat) r.seat.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

function updateRemoteBar(r) {
  const pct = Math.max(0, r.hp) / 100;
  r.healthBar.fill.scale.x = pct;
  r.healthBar.fill.material.color.set(pct > 0.5 ? r.color : pct > 0.25 ? 0xffd36e : 0xff5a5e);
}

// --- Per-frame update (called from the game loop) --------------------------
export function updateRemotes(dt, camera) {
  const now = performance.now();
  for (const r of [...remotes.values()]) {
    // Fade out peers that stopped sending (silent disconnect / tab closed).
    if (now - r.lastSeen > 3500) {
      r.fade = Math.max(0, r.fade - dt * 1.5);
      setRemoteOpacity(r, r.fade);
      if (r.fade <= 0.02) { disposeRemote(r); remotes.delete(r.id); continue; }
    }

    // While this player is driving a kart, park the body (hidden) and show a
    // head in the seat, tracking the kart's streamed position/heading.
    const kartId = kartOfDriver(r.id);
    if (kartId != null) {
      r.group.visible = false;
      r.seat.visible = true;
      const t = kartTransform(kartId);
      if (t) {
        r.seat.position.set(t.x, 0.95, t.z); // just above the seat back
        r.seat.rotation.y = t.ry;
        r.healthBar.group.position.set(t.x, 1.5, t.z);
      }
    } else {
      r.group.visible = true;
      r.seat.visible = false;

      // Smoothly move toward the latest network position.
      const lerp = 1 - Math.pow(0.0001, dt);
      _dir.copy(r.target).sub(r.group.position);
      r.group.position.addScaledVector(_dir, Math.min(1, lerp * 1.4));

      // Face the last reported look direction, smoothly.
      let diff = r.ay - r.group.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      r.group.rotation.y += diff * Math.min(1, lerp * 2.2);
      r.prev.copy(r.group.position);

      // Keep the health bar centred above the character.
      r.healthBar.group.position.set(r.group.position.x, r.group.position.y + 2.35, r.group.position.z);
    }
    // Billboard the health bar in both cases.
    r.healthBar.group.quaternion.copy(camera.quaternion);
  }
  updateEffects(dt);
}

function setRemoteOpacity(r, o) {
  r.group.traverse((obj) => {
    if (obj.material) { obj.material.transparent = true; obj.material.opacity = o; }
  });
  r.healthBar.back.material.opacity = 0.85 * o;
  r.healthBar.fill.material.opacity = o;
}

// --- Remote tracers (look identical to local shots) ------------------------
// (a, b) are world-space THREE.Vector3; wId picks the tracer tint/weight.
function spawnRemoteTracer(a, b, wId) {
  const len = a.distanceTo(b);
  if (len < 0.1) return;
  const color = wId === 'knife' ? 0xcfe8ff : wId === 'rpg' ? 0xffc080 : 0xbfe8ff;
  const thick = wId === 'rpg' ? 2.6 : 1;
  const geo = new THREE.BoxGeometry(0.04 * thick, 0.04 * thick, len);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, toneMapped: false });
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  scene.add(m);
  effects.push({ mesh: m, life: 0.09, max: 0.09 });
}

function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    if (e.life <= 0) {
      scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
      effects.splice(i, 1);
    } else {
      e.mesh.material.opacity = 0.9 * (e.life / e.max);
    }
  }
}
