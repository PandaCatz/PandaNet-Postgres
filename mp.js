'use strict';
// PandaNet realtime multiplayer — WebSocket relay + room manager, zero deps.
// The server never simulates gameplay: clients on the same seed exchange small
// opaque state blobs (position/form/score) and the relay fans them out. Room
// results are informational; ranked scoring still uses the signed HTTP finish.
//
// Protocol (JSON text frames, <= 2 KB):
//   client -> server: {t:'host'} | {t:'join', code?} | {t:'ready'} |
//                     {t:'state', d:<opaque, <=512 B>} | {t:'finish', score} | {t:'leave'}
//   server -> client: {t:'room', id, mode, code, seed, day, you, peers:[{id,name,ready}]}
//                       (seed: daily rooms expose the daily seed; private rooms
//                        are null until 'start' — the 'start' seed is authoritative)
//                     {t:'peer', id, name, joined|left|ready}
//                     {t:'start', at, in, seed}  — synchronized countdown
//                     {t:'state', id, d}         — a rival's live state
//                     {t:'finish', id, score}
//                     {t:'result', board:[{id,name,score}]}
//                     {t:'error', error}
// Connect: GET /ws?ticket=<one-time ticket from POST /api/mp/ticket>

const crypto = require('node:crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 2048;          // inbound frame cap
const MAX_STATE = 512;         // opaque state blob cap (serialized)
const MAX_ROOM = 4;
const COUNTDOWN_MS = 3000;
const IDLE_KILL_MS = 60e3;     // no frames/pong for this long -> drop
const ROOM_TTL_MS = 3600e3;    // stale room sweep
const MSG_RATE = 30;           // msgs/sec/client (state at 15 Hz fits)
const WRITE_HIGH = 64 * 1024;  // drop server->client writes past this backlog
const MAX_SCORE = 1e9;         // relay board is informational; keep it a number
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------- ws codec
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.from([0x80 | op, len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
const textFrame = obj => frame(1, Buffer.from(JSON.stringify(obj)));

// Streaming parser; handles split/coalesced TCP chunks. No fragmentation, no
// binary — our messages are tiny JSON, anything else closes the socket.
function makeParser(h) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; const n = buf.readBigUInt64BE(2); if (n > BigInt(MAX_MSG)) return h.fail(1009); len = Number(n); off = 10; }
      if (len > MAX_MSG) return h.fail(1009);
      // RFC 6455 §5.5: control frames carry <=125 bytes and are never
      // fragmented. Without this the server would both accept an oversized
      // ping and echo an equally illegal oversized pong.
      if (op >= 8 && (len > 125 || !fin)) return h.fail(1002);
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (masked) { const m = buf.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      buf = buf.subarray(off + maskLen + len);
      if (!fin || op === 0 || op === 2) return h.fail(1003);
      if (op === 1) h.msg(payload.toString('utf8'));
      else if (op === 8) return h.closed();
      else if (op === 9) h.ping(payload);
      else if (op === 10) h.pong();
      else return h.fail(1003);
    }
  };
}

// ---------------------------------------------------------------- rooms
function attach(server, deps) {
  // deps: { redeemTicket(tok) -> {id, name, game}|null,
  //         dailySeed(game, day), utcDay(), maxMs(game) }
  const rooms = new Map();   // roomId -> room
  const clients = new Set();
  const rid = n => crypto.randomBytes(n).toString('hex');

  // Iterate a copy: handlers below can remove players from the room (leaveRoom
  // on a dead socket) while a broadcast is still walking the map.
  const roomMsg = room => obj => { for (const c of [...room.players.values()]) sendTo(c, obj); };
  function sendTo(c, obj) {
    if (c.sock.destroyed || c.sock.writableLength > WRITE_HIGH) return;
    c.sock.write(textFrame(obj));
  }
  // Spend one message token; false means the client is over its rate budget.
  // Used by inbound handling AND by the ping echo, which is attacker-triggered.
  function spendToken(c) {
    const t = Date.now();
    c.tokens = Math.min(MSG_RATE, c.tokens + (t - c.tokAt) * MSG_RATE / 1000);
    c.tokAt = t;
    if (c.tokens < 1) return false;
    c.tokens--;
    return true;
  }

  function newRoom(game, mode, code) {
    const room = {
      id: rid(6), game, mode, code: code || null,
      state: 'lobby', round: 0, seed: null, day: deps.utcDay(),
      players: new Map(), finishes: new Map(),
      startAt: 0, timer: null, touched: Date.now(),
    };
    rooms.set(room.id, room);
    return room;
  }
  function roomSeed(room) {
    return room.mode === 'daily'
      ? deps.dailySeed(room.game, room.day)
      : deps.dailySeed(room.game, `room|${room.id}|${room.round}`);
  }
  function snapshot(room, you) {
    // Private rooms roll a fresh seed each round (maybeStart), so a lobby
    // snapshot has no truthful seed to offer — 'start' is the authoritative
    // delivery. Daily rooms always race the daily seed, safe to expose early.
    const seed = room.mode === 'daily' ? roomSeed(room)
      : (room.state === 'lobby' ? null : room.seed);
    return {
      t: 'room', id: room.id, mode: room.mode, code: room.code,
      seed, day: room.day, you,
      peers: [...room.players.values()].map(c => ({ id: c.id, name: c.name, ready: c.ready })),
    };
  }
  function leaveRoom(c, quiet) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.players.delete(c.id);
    room.finishes.delete(c.id);
    room.touched = Date.now();
    if (!quiet) roomMsg(room)({ t: 'peer', id: c.id, name: c.name, left: true });
    if (!room.players.size) { clearTimeout(room.timer); rooms.delete(room.id); }
    else if (room.state === 'racing') maybeFinish(room);
    else if (room.state === 'lobby') maybeStart(room);
  }
  function maybeStart(room) {
    if (room.state !== 'lobby' || room.players.size < 2) return;
    for (const c of room.players.values()) if (!c.ready) return;
    room.state = 'countdown';
    room.round++;
    room.seed = roomSeed(room);
    room.startAt = Date.now() + COUNTDOWN_MS;
    room.finishes.clear();
    roomMsg(room)({ t: 'start', at: room.startAt, in: COUNTDOWN_MS, seed: room.seed });
    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      room.state = 'racing';
      // Force results even if someone never sends finish (deadline = clock + grace).
      room.timer = setTimeout(() => maybeFinish(room, true), deps.maxMs(room.game) + 10e3);
    }, COUNTDOWN_MS);
  }
  function maybeFinish(room, force) {
    if (room.state !== 'racing') return;
    if (!force) for (const c of room.players.values()) if (!room.finishes.has(c.id)) return;
    room.state = 'lobby';
    clearTimeout(room.timer);
    const board = [...room.players.values()]
      .map(c => ({ id: c.id, name: c.name, score: room.finishes.get(c.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
    for (const c of room.players.values()) c.ready = false;
    roomMsg(room)({ t: 'result', board });
  }

  const handlers = {
    host(c) {
      if (c.room) leaveRoom(c);
      let code;
      do { code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join(''); }
      while ([...rooms.values()].some(r => r.code === code));
      const room = newRoom(c.game, 'private', code);
      joinInto(c, room);
    },
    // Resolve AND validate the destination before surrendering the current
    // room: a mistyped code must never destroy the room the caller was hosting.
    join(c, m) {
      let room;
      if (m.code) {
        const code = String(m.code ?? '').toUpperCase();
        room = [...rooms.values()].find(r => r.game === c.game && r.code === code);
        if (!room) return sendTo(c, { t: 'error', error: 'no such room' });
        if (room === c.room) return sendTo(c, snapshot(room, c.id));
        if (room.players.size >= MAX_ROOM || room.state !== 'lobby')
          return sendTo(c, { t: 'error', error: 'room unavailable' });
      } else {
        room = [...rooms.values()].find(r =>
          r.game === c.game && r.mode === 'daily' && r.state === 'lobby' && r.players.size < MAX_ROOM);
        if (room === c.room) return sendTo(c, snapshot(room, c.id));
        if (!room) room = newRoom(c.game, 'daily', null);
      }
      if (c.room) leaveRoom(c);
      joinInto(c, room);
    },
    ready(c) {
      if (!c.room || c.room.state !== 'lobby') return;
      c.ready = true;
      c.room.touched = Date.now();
      roomMsg(c.room)({ t: 'peer', id: c.id, name: c.name, ready: true });
      maybeStart(c.room);
    },
    state(c, m) {
      const room = c.room;
      if (!room || (room.state !== 'racing' && room.state !== 'countdown')) return;
      if (JSON.stringify(m.d ?? null).length > MAX_STATE) return;
      room.touched = Date.now();
      for (const peer of room.players.values())
        if (peer !== c) sendTo(peer, { t: 'state', id: c.id, d: m.d });
    },
    finish(c, m) {
      const room = c.room;
      if (!room || room.state !== 'racing' || room.finishes.has(c.id)) return;
      // Number.isFinite is load-bearing: 1e999 parses to Infinity, survives
      // `|| 0`, sorts to the top of the board and serializes as JSON null.
      const n = Math.floor(+m.score);
      const score = Number.isFinite(n) ? Math.max(0, Math.min(n, MAX_SCORE)) : 0;
      room.finishes.set(c.id, score);
      room.touched = Date.now();
      roomMsg(room)({ t: 'finish', id: c.id, score });
      maybeFinish(room);
    },
    leave(c) { leaveRoom(c); },
  };
  function joinInto(c, room) {
    if (room.players.size >= MAX_ROOM || room.state !== 'lobby')
      return sendTo(c, { t: 'error', error: 'room unavailable' });
    room.players.set(c.id, c);
    c.room = room;
    c.ready = false;
    room.touched = Date.now();
    sendTo(c, snapshot(room, c.id));
    for (const peer of room.players.values())
      if (peer !== c) sendTo(peer, { t: 'peer', id: c.id, name: c.name, joined: true });
  }

  // -------------------------------------------------------------- upgrade
  server.on('upgrade', (req, sock, head) => {
    // Malformed absolute-form request targets make new URL() throw; an
    // exception here would crash the process, so it must become a rejection.
    let url;
    try { url = new URL(req.url, 'http://x'); }
    catch { sock.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return sock.destroy(); }
    const key = req.headers['sec-websocket-key'];
    const who = url.pathname === '/ws' && deps.redeemTicket(url.searchParams.get('ticket'));
    if (!who || !key || !/websocket/i.test(req.headers.upgrade || '')) {
      sock.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return sock.destroy();
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.setNoDelay(true);

    // One live socket per player id: a reconnect displaces the old socket.
    // Clean up synchronously — waiting for the old socket's async 'close' event
    // could evict the new connection's room membership (same player id).
    for (const old of clients) if (old.id === who.id) {
      clients.delete(old);
      leaveRoom(old);
      old.sock.destroy();
    }

    const c = { sock, id: who.id, name: who.name, game: who.game, room: null, ready: false, alive: Date.now(), tokens: MSG_RATE, tokAt: Date.now() };
    clients.add(c);

    const bye = () => {
      if (!clients.has(c)) return;
      clients.delete(c);
      leaveRoom(c);
      sock.destroy();
    };
    const feed = makeParser({
      msg: text => {
        c.alive = Date.now();
        if (!spendToken(c)) return;   // silently shed excess traffic
        let m; try { m = JSON.parse(text); } catch { return; }
        if (process.env.MP_DEBUG) console.error('[mp]', c.id, JSON.stringify(m));
        // Own-property lookup only: a bare read would let inherited keys like
        // "__proto__" or "constructor" dispatch as handlers.
        const h = (m && typeof m.t === 'string' && Object.hasOwn(handlers, m.t)) ? handlers[m.t] : null;
        // A handler exception would bubble through the socket's 'data' event
        // and kill the process for everyone; one bad message must never do that.
        try { if (h) h(c, m); }
        catch (e) { console.error(new Date().toISOString(), 'mp handler error', m?.t, e); }
      },
      // A ping echo is attacker-triggered work, so it obeys the same rate
      // budget and backpressure ceiling as every other server->client write.
      // Without the writableLength guard a peer that stops reading forces
      // unbounded userspace buffering and OOMs the process.
      ping: p => {
        c.alive = Date.now();
        if (!spendToken(c)) return;
        if (sock.destroyed || sock.writableLength > WRITE_HIGH) return;
        sock.write(frame(10, p));
      },
      pong: () => { c.alive = Date.now(); },
      closed: () => { try { sock.write(frame(8, Buffer.alloc(0))); } catch {} bye(); },
      fail: code => { try { const b = Buffer.alloc(2); b.writeUInt16BE(code); sock.write(frame(8, b)); } catch {} bye(); },
    });
    sock.on('data', feed);
    sock.on('error', bye);
    sock.on('close', bye);
    if (head?.length) feed(head);
  });

  // Heartbeat + sweeps.
  setInterval(() => {
    const t = Date.now();
    for (const c of clients) {
      if (t - c.alive > IDLE_KILL_MS) { c.sock.destroy(); clients.delete(c); leaveRoom(c); }
      else if (!c.sock.destroyed) c.sock.write(frame(9, Buffer.alloc(0)));
    }
    // A room with a live player in it is not stale — `touched` only advances on
    // activity, so an idle lobby would otherwise be deleted out from under
    // players who are still connected to it and left unable to start.
    for (const [id, room] of rooms) {
      if (room.players.size) continue;
      if (t - room.touched > ROOM_TTL_MS) { clearTimeout(room.timer); rooms.delete(id); }
    }
  }, 25e3).unref();

  return { stats: () => ({ sockets: clients.size, rooms: rooms.size }) };
}

module.exports = { attach };
