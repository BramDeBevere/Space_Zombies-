// Multiplayer server — dependency-free (Node built-ins only: http, crypto, fs, path).
//
//   node server.js            -> serves the game + relays players on :8010
//   PORT=8015 node server.js   -> custom port
//
// What it does:
//   1. Serves the static files (index.html, *.js) so you can play from a browser.
//   2. Upgrades HTTP -> WebSocket and relays JSON messages between players.
//
// Protocol (all JSON text frames, relayed to every OTHER client):
//   client -> server : { id, t: 'state', x,y,z, ay, ap, hp }
//                   : { id, t: 'fire',  x,y,z, dx,dy,dz }
//   server -> client : { t: 'joined', id }          (your own id)
//                   : { id, t: 'peer', id }         (someone else joined)
//                   : { id, t: 'left',  id }        (someone left)
//                   : raw player 'state'/'fire' messages (id already attached)

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8010);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
};

// --- WebSocket (RFC 6455) minimal implementation -------------------------
function acceptKey(s24) {
  return crypto.createHash('sha1').update(s24 + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function makeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}
const encodeFrame = (data) => makeFrame(0x1, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));

function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) return { out, rest: buf.slice(off) };
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) return { out, rest: buf.slice(off) };
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask;
    if (masked) {
      if (p + 4 > buf.length) return { out, rest: buf.slice(off) };
      mask = buf.slice(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) return { out, rest: buf.slice(off) };
    const payload = Buffer.from(buf.slice(p, p + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    out.push({ opcode, payload });
    off = p + len;
  }
  return { out, rest: buf.slice(off) };
}

function closeSocket(ws) {
  try { ws.socket.end(); } catch {}
  ws.closed = true;
}

// --- Client registry ------------------------------------------------------
let nextId = 1;
const clients = new Map(); // id -> ws object ({ send, closed, sock })
// `data` is a JS object (JSON-serialised) or a Buffer (relayed byte-for-byte).
function broadcastToOthers(id, data) {
  for (const [cid, c] of clients) if (cid !== id && !c.closed) c.send(data);
}

const server = http.createServer((req, res) => {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safe);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
    '\r\n'
  );

  const id = nextId++;
  const ws = { send: (d) => socket.write(encodeFrame(d)), closed: false, sock: socket };
  clients.set(id, ws);
  socket.write(encodeFrame(JSON.stringify({ t: 'joined', id })));
  broadcastToOthers(id, JSON.stringify({ t: 'peer', id }));

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { out, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const msg of out) {
      if (msg.opcode === 0x8) {
        try { socket.write(makeFrame(0x8, msg.payload)); } catch {}
        cleanup(); // remove from registry + tell the others, then close
        break;
      } else if (msg.opcode === 0x9) socket.write(makeFrame(0xA, msg.payload)); // ping -> pong
      else if (msg.opcode === 0x1 || msg.opcode === 0x2) {                      // text/binary -> relay
        broadcastToOthers(id, msg.payload);
      }
    }
  });
  function cleanup() {
    if (!clients.has(id)) return;
    clients.delete(id);
    for (const c of clients.values()) if (!c.closed) c.send(JSON.stringify({ t: 'left', id }));
    closeSocket(ws);
  }
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`\n  DEAD ARENA — serving + multiplayer relay`);
  console.log(`  Open:  http://localhost:${PORT}/   (choose "Multiplayer")`);
  console.log(`  Players can also join from the same machine/LAN using that address.\n`);
});
