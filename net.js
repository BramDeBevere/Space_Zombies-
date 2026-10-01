// net.js — multiplayer transport, 100% in the browser (no server needed).
//
// Uses WebRTC over the free public PeerJS cloud. The "room" is just a shared
// 5-letter code:
//   - the HOST reserves the peer id `deadarena-<CODE>` and waits for peers;
//   - each JOINER connects to that id.
// The host relays every game message it gets from a joiner to all the *other*
// joiners (a star), so everyone in the room sees the same shared horde, shots
// and explosions. Signal exchange uses PeerJS's public broker; the actual game
// data flows peer-to-peer, which is why this deploys to static hosts (Netlify)
// with no backend to run.
//
// One onEvent router (connectLobby) receives everything:
//   lobby: 'created'{roomId,name}, 'error'{message}, 'disconnected'
//   game : 'left'{id}, 'state', 'fire', 'hit',
//          'zstate', 'wave', 'bite', 'zhit', 'boom'
//
// 'left' carries a player's stable in-game id (conn._myId); remote meshes are
// otherwise created lazily by remotes.js from the first 'state', so no 'peer'
// event is emitted.
//
// PeerJS is loaded as a plain <script> in index.html (it sets `window.Peer`),
// which keeps the game's module graph simple and works on any static host.

const APP_ID = 'deadarena';        // host peer id = `${APP_ID}-${CODE}`
const PEER_OPTS = { debug: 1 };
const getPeerCtor = () => (typeof window !== 'undefined' && window.Peer) || null;

/** Build a Peer, or report that the connection library failed to load. */
function makePeer(...args) {
  const Ctor = getPeerCtor();
  if (!Ctor) return null;
  return new Ctor(...args);
}

let peer = null;
let myId = null;          // our player id (stable per session)
let role = null;          // 'host' | 'joiner' | null
let roomId = null;        // room code (null while just looking)
let handlers = null;      // the single onEvent(t, d) router
let remotes = null;       // Map peerId -> dataConn (open, in-room peers)
let lastState = 0;
let closed = false;
let pending = null;       // connectLobby resolver, until the peer id is ready

// --- Room-code helpers -----------------------------------------------------
// 5 letters from an unambiguous set (no 0/O, 1/I/L) so codes read cleanly.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export function makeRoomCode(len = 5) {
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[arr[i] % CODE_CHARS.length];
  return s;
}
const hostIdFor = (code) => `${APP_ID}-${code}`;
const normalize = (c) => (c || '').trim().toUpperCase().replace(/\s+/g, '');

// --- Internal plumbing -----------------------------------------------------
function emit(t, d) { if (handlers) handlers(t, d); }
function sendToRoom(d) {
  if (!remotes) return;
  for (const c of remotes.values()) { if (c.open) { try { c.send(d); } catch {} } }
}
function fail(err) { emit('error', { message: err.message || String(err) }); }

// Route an in-game message from the wire to the onEvent router.
function routeGame(d) {
  if (!d || typeof d !== 'object') return;
  const t = d.t;
  if (t === 'state') emit('state', d);
  else if (t === 'fire') emit('fire', d);
  else if (t === 'hit') emit('hit', d);
  else if (t === 'zstate') emit('zstate', d);
  else if (t === 'wave') emit('wave', d);
  else if (t === 'bite') emit('bite', d);
  else if (t === 'zhit') emit('zhit', d);
  else if (t === 'boom') emit('boom', d);
}

// Shared behaviour for a data channel from an in-room peer. (Mesh creation is
// handled lazily by remotes.js onState, keyed by the sender's stable myId, so
// we only need to forward game messages.)
function onPeerData(d) { if (d && d.t) routeGame(d); }

/**
 * Open the signalling connection (idempotent). Resolves { id } once our peer id
 * is ready to host or join. `onEvent` is the router for every later message.
 */
export function connectLobby(onEvent) {
  handlers = onEvent;
  if (myId == null) myId = Math.random().toString(36).slice(2, 10);

  if (peer && peer.open) return Promise.resolve({ id: myId });

  const p = makePeer(PEER_OPTS);
  if (!p) { fail({ message: 'The connection service failed to load. Reload the page and try again.' }); return Promise.resolve({ id: myId }); }
  wirePeer(p, () => { /* anonymous: no room state yet */ });
  return new Promise((resolve) => {
    pending = resolve;
    setTimeout(() => { if (pending) { pending({ id: myId }); pending = null; } }, 2000);
  });
}

/** Attach the standard events to a Peer. `onOpen` fires once our id is usable. */
function wirePeer(p, onOpen) {
  peer = p;
  if (!remotes) remotes = new Map();
  p.on('open', () => {
    if (pending) { pending({ id: myId }); pending = null; }
    emit('connected', { id: myId });
    onOpen();
  });
  p.on('error', (err) => {
    const type = err && err.type;
    if (type === 'unavailable-id') fail({ message: 'That room code is already in use.' });
    else if (type === 'peer-unavailable') fail({ message: 'No room with that code — ask the host to share it, or create it.' });
    else if (type === 'network' || type === 'server-error' || type === 'socket-error')
      fail({ message: 'Could not reach the connection service. Check your internet and try again.' });
    else if (pending) { pending({ id: myId }); pending = null; } // stay usable
  });
  p.on('disconnected', () => { if (!closed) { try { p.reconnect(); } catch {} } });
  p.on('close', () => {
    if (!closed && (role != null || (remotes && remotes.size))) emit('disconnected', {});
  });
}

/** No-op kept for API symmetry — there is no server room list to fetch. */
export function listRooms() {}

/**
 * Host a new room. Reserves `deadarena-<CODE>` and waits for joiners.
 * Resolves { roomId } on success, or null on failure.
 */
export function createRoom(_name) {
  return new Promise((resolve) => {
    const code = makeRoomCode();
    if (peer) { try { peer.destroy(); } catch {} }
    closed = false;
    const p = makePeer(hostIdFor(code), PEER_OPTS);
    if (!p) { fail({ message: 'The connection service failed to load. Reload the page and try again.' }); resolve(null); return; }
    wirePeer(p, () => {});
    p.on('connection', (conn) => onHostConn(conn));
    p.on('open', () => {
      role = 'host'; roomId = code;
      emit('created', { roomId: code, name: 'My Room' });
      resolve({ roomId: code });
    });
    p.on('error', (err) => { if (err && err.type === 'unavailable-id') resolve(null); });
  });
}

/** Host: a joiner's data channel arrived. Keep it, announce the peer, and relay
 *  everything they send to every other joiner (the star). */
function onHostConn(conn) {
  conn.on('data', (d) => {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'state') conn._myId = d.id;          // remember their stable id
    routeGame(d);                  // we (the host) process it
    if (remotes) for (const c of remotes.values()) { if (c !== conn && c.open) { try { c.send(d); } catch {} } }
  });
  conn.on('open', () => { if (!remotes.has(conn.peer)) remotes.set(conn.peer, conn); });
  conn.on('close', () => {
    if (remotes) remotes.delete(conn.peer);
    if (conn._myId) emit('left', { id: conn._myId });   // drop their mesh by stable id
  });
  try { conn.send({ t: 'state', id: myId, x: 0, y: 0, z: 0, ay: 0, hp: 100 }); } catch {}
}

/**
 * Join an existing room by code. Resolves { roomId } on success, or null when
 * the code doesn't exist.
 */
export function joinRoom(code) {
  code = normalize(code);
  if (code.length < 3) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (peer) { try { peer.destroy(); } catch {} }
    closed = false;
    const p = makePeer(PEER_OPTS);
    if (!p) { fail({ message: 'The connection service failed to load. Reload the page and try again.' }); resolve(null); return; }
    wirePeer(p, () => {});
    p.on('open', () => {
      const conn = p.connect(hostIdFor(code), { reliable: true });
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; fail({ message: 'No room with that code.' }); resolve(null); } }, 4500);
      conn.on('open', () => {
        if (done) return;
        done = true; clearTimeout(timer);
        role = 'joiner'; roomId = code;
        remotes.set(conn.peer, conn);
        conn.on('data', (d) => { if (d && d.t === 'state') conn._myId = d.id; onPeerData(d); });
        conn.on('close', () => {
          if (remotes) remotes.delete(conn.peer);
          if (conn._myId) emit('left', { id: conn._myId });
        });
        resolve({ roomId: code });
      });
      conn.on('error', () => { if (!done) { done = true; clearTimeout(timer); fail({ message: 'No room with that code.' }); resolve(null); } });
    });
  });
}

/** Leave the current room (e.g. backing out of a hosted lobby). */
export function leaveRoom() {
  roomId = null; role = null;
  if (remotes) for (const c of remotes.values()) { try { c.close(); } catch {} }
  if (remotes) remotes.clear();
}

export function isLobbyConnected() { return !!(peer && peer.open); }

// --- Game message senders (broadcast to every peer in our room) ------------
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Broadcast my transform + health (throttled to ~20 Hz). */
export function sendState(x, y, z, ay, hp) {
  if (myId == null) return;
  const now = performance.now();
  if (now - lastState < 50) return;
  lastState = now;
  sendToRoom({ t: 'state', id: myId, x: r3(x), y: r3(y), z: r3(z), ay: r3(ay), hp: Math.round(hp) });
}

/**
 * Broadcast a shot so peers draw the same tracers and play the same SFX.
 * `res` is the weapon result: { wId, melee, tracers: [{from,to}], ... }.
 */
export function sendFire(res) {
  if (myId == null) return;
  const tr = (res.tracers || []).map((t) => ({
    fx: r3(t.from.x), fy: r3(t.from.y), fz: r3(t.from.z),
    tx: r3(t.to.x), ty: r3(t.to.y), tz: r3(t.to.z),
  }));
  sendToRoom({ t: 'fire', id: myId, wId: res.wId, melee: !!res.melee, tr });
}

/** Tell every peer they may have been hit for `dmg` (target checks its id). */
export function sendHit(target, dmg) {
  if (myId == null) return;
  sendToRoom({ t: 'hit', id: myId, target, dmg: Math.round(dmg) });
}

/** Host -> room: the current horde snapshot (shared zombies). */
export function sendZState(zs) {
  if (myId == null) return;
  sendToRoom({ t: 'zstate', id: myId, zs });
}

/** Host -> room: the active wave number. */
export function sendWave(n) {
  if (myId == null) return;
  sendToRoom({ t: 'wave', id: myId, n });
}

/** Host -> room: a zombie bit player `pid` for `dmg` (with knockback `kb`
 * and push direction `dir`). */
export function sendBite(tid, pid, dmg, kb = 0, dir = null) {
  if (myId == null) return;
  sendToRoom({
    t: 'bite', id: myId, tid, pid, dmg: Math.round(dmg),
    kb: Math.round(kb),
    dx: dir ? Math.round(dir.x * 1000) / 1000 : 0,
    dz: dir ? Math.round(dir.z * 1000) / 1000 : 0,
  });
}

/** Player -> room: this player hit shared zombie `tid` (host applies it). */
export function sendZombieHit(tid, dmg) {
  if (myId == null) return;
  sendToRoom({ t: 'zhit', id: myId, tid, dmg: Math.round(dmg) });
}

/** Broadcast an RPG explosion so every peer sees the blast + damage. */
export function sendBoom(x, y, z, radius) {
  if (myId == null) return;
  sendToRoom({ t: 'boom', id: myId, x: r3(x), y: r3(y), z: r3(z), r: r3(radius) });
}

export function getId() { return myId; }
export function getRole() { return role; }        // 'host' | 'joiner' | null
export function getRoomId() { return roomId; }
export function peerCount() { return remotes ? remotes.size : 0; }

export function disconnect() {
  closed = true;
  leaveRoom();
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
  myId = null; role = null; roomId = null; handlers = null; remotes = null;
}
