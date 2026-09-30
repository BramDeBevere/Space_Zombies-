// net.js — multiplayer transport (PeerJS / WebRTC) with shareable room codes.
//
// Fully static: no server of our own. Signaling uses the free public PeerJS
// cloud server, so this deploys to Netlify/Vercel as plain files.
//
// Topology is a star: one HOST is the hub and every other player connects to
// the host by room code. The host relays peer messages and handles join/leave.
// The host's Peer id IS the room (deadarena-<code>), so a joiner just needs
// the short code.
//
// Wire messages (JSON objects over the data connection):
//   everyone -> host : { t:'state'|'fire'|'hit', id, ... }
//   host -> joiner   : { t:'joined', id, host } , { t:'peers', ids:[...] }
//   host -> others   : { t:'peer', id } , { t:'left', id }
//   host relays any peer's state/fire/hit to every other peer.
//
// The onEvent callback receives: 'peer'{id}, 'left'{id}, 'state'd, 'fire'd,
// 'hit'd, 'error'{message}, 'disconnected'.

let peer = null;
const conns = new Set();   // open data connections (host: all peers; joiner: the host)
let role = null;           // 'host' | 'joiner'
let myId = null;
let handlers = null;
let closed = false;
let lastState = 0;
let code = null;

// --- room code helpers ---
const CODE_CHARS = 'abcdefghijkmnopqrstuvwxyz23456789';
function makeCode(len = 5) {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[a[i] % CODE_CHARS.length];
  return s;
}
const roomPeerId = (c) => 'deadarena-' + String(c).toLowerCase().trim();

// Apply an inbound state/fire/hit to our local view (via the remotes module).
function routeLocal(d) {
  if (!handlers || !d || typeof d !== 'object') return;
  if (d.t === 'state') handlers('state', d);
  else if (d.t === 'fire') handlers('fire', d);
  else if (d.t === 'hit') handlers('hit', d);
  else if (d.t === 'zstate') handlers('zstate', d);
  else if (d.t === 'wave') handlers('wave', d);
  else if (d.t === 'bite') handlers('bite', d);
  else if (d.t === 'zhit') handlers('zhit', d);
}

// Send to every open connection (our own messages).
function send(obj) {
  for (const c of conns) if (c.open) { try { c.send(obj); } catch {} }
}
// Forward a message to every peer EXCEPT the one that sent it (host relay).
function relayExcept(src, obj) {
  for (const c of conns) if (c !== src && c.open) { try { c.send(obj); } catch {} }
}

// Host-side: one data connection per joined player.
function wireHostConn(conn) {
  conns.add(conn);
  conn.on('data', (d) => {
    routeLocal(d);
    relayExcept(conn, d);
  });
  conn.on('close', () => {
    conns.delete(conn);
    if (!handlers) return;
    handlers('left', { id: conn.peer });
    relayExcept(conn, { t: 'left', id: conn.peer });
  });
  conn.on('error', () => {});
}

/** Host a new room. Resolves { id, code } once the room is live. */
export function hostRoom(onEvent) {
  handlers = onEvent; closed = false; role = 'host';
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      code = makeCode();
      const p = new Peer(roomPeerId(code), { debug: 0 });
      peer = p;
      p.on('open', (id) => {
        myId = id;
        p.on('connection', (conn) => {
          wireHostConn(conn);
          handlers && handlers('peer', { id: conn.peer });
          for (const c of conns) if (c !== conn && c.open) { try { c.send({ t: 'peer', id: conn.peer }); } catch {} }
          // Defer the roster until the DataChannel is actually open on the
          // joiner's side — sending before that is silently dropped, which is
          // why the joiner used to never learn the host's id.
          conn.on('open', () => {
            conn.send({ t: 'joined', id: conn.peer, host: myId });
            const others = [...conns].filter((c) => c !== conn).map((c) => c.peer);
            conn.send({ t: 'peers', ids: [myId, ...others] });
          });
        });
        p.on('disconnected', () => { try { p.reconnect(); } catch {} });
        resolve({ id: myId, code });
      });
      p.on('error', (err) => {
        const type = err && err.type;
        if (type === 'unavailable-id') { if (n < 6) { p.destroy(); attempt(n + 1); } else reject(err); }
        else if (myId) handlers && handlers('error', { message: (err && err.message) || type || 'peer error' });
        else reject(err);
      });
    };
    attempt(0);
  });
}

/** Join an existing room by code. Resolves { id } once connected to the host. */
export function joinRoom(codeIn, onEvent) {
  handlers = onEvent; closed = false; role = 'joiner';
  code = String(codeIn).toLowerCase().trim();
  return new Promise((resolve, reject) => {
    const p = new Peer({ debug: 0 });
    peer = p;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { p.destroy(); reject(new Error('Timed out reaching the room host.')); }
    }, 9000);
    p.on('open', (id) => {
      myId = id;
      const conn = p.connect(roomPeerId(code), { reliable: true });
      conn.on('open', () => {
        settled = true; clearTimeout(timer);
        conns.add(conn);
        conn.on('data', (d) => {
          if (!d || typeof d !== 'object') return;
          if (d.t === 'joined') return;
          if (d.t === 'peers') { for (const rid of d.ids) handlers && handlers('peer', { id: rid }); return; }
          routeLocal(d);
        });
        conn.on('close', () => { conns.delete(conn); if (!closed) handlers && handlers('disconnected', {}); });
        conn.on('error', () => {});
        resolve({ id: myId });
      });
      conn.on('error', () => {});
    });
    p.on('error', (err) => {
      const type = err && err.type;
      if (type === 'peer-unavailable') {
        if (!settled) { clearTimeout(timer); p.destroy(); reject(new Error('Room not found — check the code.')); }
        else handlers && handlers('error', { message: 'Room host is offline.' });
      } else if (myId) {
        handlers && handlers('error', { message: (err && err.message) || type || 'peer error' });
      } else if (!settled) { clearTimeout(timer); p.destroy(); reject(err); }
    });
    p.on('disconnected', () => { try { p.reconnect(); } catch {} });
  });
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const z2 = (n) => Math.round(n * 100) / 100;

/** Broadcast my transform + health (throttled to ~20 Hz). */
export function sendState(x, y, z, ay, hp) {
  if (myId == null) return;
  const now = performance.now();
  if (now - lastState < 50) return;
  lastState = now;
  send({ t: 'state', id: myId, x: r3(x), y: r3(y), z: r3(z), ay: r3(ay), hp: Math.round(hp) });
}

/** Broadcast a shot (world-space start + end) so peers can draw the same tracer. */
export function sendFire(ox, oy, oz, ex, ey, ez) {
  if (myId == null) return;
  send({ t: 'fire', id: myId, ox: r3(ox), oy: r3(oy), oz: r3(oz), ex: r3(ex), ey: r3(ey), ez: r3(ez) });
}

/** Tell a peer they were hit for `dmg`. */
export function sendHit(target, dmg) {
  if (myId == null) return;
  send({ t: 'hit', id: myId, target, dmg: Math.round(dmg) });
}

/** Host -> peers: the current horde snapshot (shared zombies). */
export function sendZState(zs) {
  if (myId == null) return;
  send({ t: 'zstate', id: myId, zs });
}

/** Host -> peers: the active wave number. */
export function sendWave(n) {
  if (myId == null) return;
  send({ t: 'wave', id: myId, n });
}

/** Host -> peers: a zombie bit a player for `dmg`. */
export function sendBite(tid, pid, dmg) {
  if (myId == null) return;
  send({ t: 'bite', id: myId, tid, pid, dmg: Math.round(dmg) });
}

/** Player -> host: this player hit shared zombie `tid` (damage applied on host). */
export function sendZombieHit(tid) {
  if (myId == null) return;
  send({ t: 'zhit', id: myId, tid });
}

export function getId() { return myId; }
export function getRole() { return role; } // 'host' | 'joiner' | null
export function isConnected() { return !!(peer && peer.open); }
export function disconnect() {
  closed = true;
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
  conns.clear();
  myId = null;
  role = null;
  code = null;
}
