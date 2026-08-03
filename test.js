#!/usr/bin/env node
// End-to-end test for server.js + mp.js. Spawns the server on a scratch port and
// DB, drives the whole HTTP API and a live two-socket multiplayer race, and
// asserts every guard. Exit 0 = all pass.
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PORT = 8399;
const PGPORT = 55433;
let PGDIR = path.join(__dirname, '.pgdata-test');   // per-run suffix added at startup
const DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PGPORT}/pandanet_test`;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('FAIL  ' + label); }
}

async function post(p, body, headers) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function get(p, headers) { const r = await fetch(BASE + p, { headers }); return { status: r.status, body: await r.json() }; }

// Signed-flow helpers (direct mode).
async function startRun(me, game) {
  const ts = Date.now();
  return post('/api/run/start', { game, playerId: me.playerId, ts, sig: hmac(me.secret, `start|${game}|${me.playerId}|${ts}`) });
}
async function finishRun(me, runId, score, rooms, durMs, log) {
  const ts = Date.now();
  return post('/api/run/finish', {
    playerId: me.playerId, runId, score, rooms, durMs, ts,
    sig: hmac(me.secret, `finish|${runId}|${score}|${rooms}|${ts}`), log,
  });
}
async function playRun(me, game, score, rooms, { durMs = 450, wait = 500, log } = {}) {
  const r = await startRun(me, game);
  await sleep(wait);
  return finishRun(me, r.body.runId, score, rooms, durMs, log);
}
// Raw WebSocket socket, already upgraded. The ticket is fetched BEFORE
// net.connect so the 'connect' event cannot fire during an await.
async function rawWs(me, game) {
  const tk = await wsTicket(me, game);
  const s = net.connect(PORT, '127.0.0.1');
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
  s.write(`GET /ws?ticket=${tk} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
    `Connection: Upgrade\r\nSec-WebSocket-Key: dGVzdGtleTEyMzQ1Ng==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise((res, rej) => {
    s.once('data', res);
    setTimeout(() => rej(new Error('no upgrade response')), 4000);
  });
  return s;
}

// Age an open run token so it looks like it was minted on a previous day and
// abandoned — the exact shape the day-boundary guard has to reject.
async function db_backdate(runId) {
  const yest = new Date(Date.now() - 26 * 3600e3).toISOString().slice(0, 10);
  await pgAdmin.query('UPDATE runs SET day = $1, "startedAt" = $2 WHERE id = $3',
    [yest, Date.now() - 26 * 3600e3, runId]);
}

async function wsTicket(me, game) {
  const ts = Date.now();
  const r = await post('/api/mp/ticket', { game, playerId: me.playerId, ts, sig: hmac(me.secret, `mp|${game}|${me.playerId}|${ts}`) });
  return r.body.ticket;
}

// Tiny WS test client on Node's built-in WebSocket: buffers events, lets the
// test await the next message of a given type.
function wsClient(ticket) {
  const ws = new WebSocket(`${WS}/ws?ticket=${ticket}`);
  const inbox = [];
  const waiters = [];
  // Capture open/error at construction — the caller may not await open() until
  // after further round-trips, by which time the event has already fired.
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws failed')));
    setTimeout(() => rej(new Error('ws open timeout')), 5000);
  });
  opened.catch(() => {});
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex(w => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].res(m);
    else inbox.push(m);
  };
  return {
    ws,
    open: () => opened,
    send: o => ws.send(JSON.stringify(o)),
    next(t, ms = 4000) {
      const i = inbox.findIndex(m => m.t === t);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { t, res };
        waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); rej(new Error(`timeout waiting for '${t}'`)); } }, ms);
      });
    },
    // Negative assertion: resolves true when the message does NOT arrive.
    none(t, ms = 600) { return this.next(t, ms).then(() => false, () => true); },
    close: () => ws.close(),
  };
}

let pg = null, pgAdmin = null, srv = null;

// Bring up a REAL PostgreSQL for the suite rather than an emulator, so the
// tests exercise the same engine production runs. Set TEST_DATABASE_URL to
// point at an existing server instead (that is what CI does).
async function startPostgres() {
  if (process.env.TEST_DATABASE_URL) {
    // This function DROPs the schema. Refuse to do that to a database whose
    // name does not announce itself as scratch — a TEST_DATABASE_URL pasted
    // from a staging env file would otherwise be destroyed as step one.
    const dbName = new URL(process.env.TEST_DATABASE_URL).pathname.replace(/^\//, '');
    if (!/test/i.test(dbName)) {
      throw new Error(`refusing to DROP SCHEMA on database "${dbName}" — its name must contain "test"`);
    }
    const { Client } = require('pg');
    pgAdmin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await pgAdmin.connect();
    // Start from a clean schema so counts in the assertions are deterministic.
    await pgAdmin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    return process.env.TEST_DATABASE_URL;
  }
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  // A per-run directory. Reusing one fixed path means a postgres left running
  // by an interrupted earlier run holds a lock on it, and the startup rmSync
  // dies with EBUSY before a single test executes. Stale dirs are swept
  // best-effort — one still locked must not fail the run.
  for (const name of fs.readdirSync(__dirname)) {
    if (name.startsWith('.pgdata-test')) {
      try { fs.rmSync(path.join(__dirname, name), { recursive: true, force: true }); } catch {}
    }
  }
  PGDIR = path.join(__dirname, `.pgdata-test-${process.pid}`);
  pg = new EmbeddedPostgres({
    databaseDir: PGDIR, user: 'postgres', password: 'postgres',
    port: PGPORT, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pandanet_test');
  const { Client } = require('pg');
  pgAdmin = new Client({ connectionString: DATABASE_URL });
  await pgAdmin.connect();
  return DATABASE_URL;
}

async function stopPostgres() {
  try { if (pgAdmin) await pgAdmin.end(); } catch {}
  try { if (pg) await pg.stop(); } catch {}
  try { fs.rmSync(PGDIR, { recursive: true, force: true }); } catch {}
}

async function main() {
  const url = await startPostgres();
  srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    // The whole suite drives one IP, so the production 60/min bucket would
    // throttle the tail of the run and report the 429s as unrelated failures.
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: url, ADMIN_KEY: 'test-admin', SEED_KEY: 'test-seed', PROXY_KEY: 'test-proxy', RATE_PER_MIN: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', d => { const s = String(d); if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write(s); });
  await new Promise((resolve, reject) => {
    srv.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
    srv.on('exit', c => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server never came up')), 20000);
  });

  const G = 'pandacat', G2 = 'othergame';
  try {
    // --- per-game config (also makes the rest of the suite fast: minMs 300)
    let r = await post('/api/admin/game', { game: G, cfg: { minMs: 300 } });
    ok(r.status === 403, 'admin game without key rejected');
    r = await post('/api/admin/game', { game: G, cfg: { minMs: 300 } }, { 'X-Admin-Key': 'test-admin' });
    ok(r.status === 200 && r.body.cfg.minMs === 300 && r.body.cfg.scoreMax === 999999, 'admin game config merged over defaults');
    await post('/api/admin/game', { game: G2, cfg: { minMs: 300 } }, { 'X-Admin-Key': 'test-admin' });
    await post('/api/admin/game', { game: 'tiegame', cfg: { minMs: 300 } }, { 'X-Admin-Key': 'test-admin' });

    // --- identity
    r = await post('/api/hello', { name: 'tester one!' });
    ok(r.status === 200 && r.body.playerId && r.body.secret, 'hello issues identity');
    const me = r.body;
    r = await post('/api/hello', { playerId: me.playerId, secret: me.secret });
    ok(r.status === 200 && r.body.playerId === me.playerId, 'hello refresh with good secret');
    r = await post('/api/hello', { playerId: me.playerId, secret: 'wrong' });
    ok(r.status === 403, 'hello refresh with bad secret rejected');
    r = await post('/api/hello', { playerId: me.playerId, secret: 12345 });
    ok(r.status === 403, 'hello refresh with non-string secret is 403, not 500');
    r = await post('/api/hello', { name: '<b>evil & "x"</b>' });
    ok(r.status === 200 && !/[<>&"'`]/.test(r.body.name), `names strip markup chars: "${r.body.name}"`);

    // --- daily
    r = await get('/api/daily');
    ok(r.status === 400, 'daily requires game');
    r = await get(`/api/daily?game=${G}`);
    ok(r.status === 200 && /^[0-9a-f]{64}$/.test(r.body.seed), 'daily seed is deterministic hex');
    const day = r.body.date, seedG = r.body.seed;
    const seedG2 = (await get(`/api/daily?game=${G2}`)).body.seed;
    ok(seedG !== seedG2, 'different games get different daily seeds');

    // --- run flow guards
    r = await startRun(me, G);
    const runId = r.body.runId;
    ok(r.status === 200 && runId, 'run start');
    r = await finishRun(me, runId, 4000, 3, 30000);
    ok(r.status === 200 && r.body.flagged === true, 'wall-clock cheat is flagged off-board');

    const log = Buffer.from(JSON.stringify([[0, 1], [60, 3], [120, 2]])).toString('base64');
    r = await playRun(me, G, 4200, 3, { log });
    ok(r.status === 200 && r.body.flagged === false && r.body.best === true && r.body.rank === 1,
      `honest run accepted, rank ${r.body.rank}/${r.body.total}`);
    const doneRun = (await get(`/api/board?game=${G}`)).body; // touch board once for later comparison
    ok(doneRun.top.length === 1, 'board has the run');

    r = await finishRun(me, runId, 9000, 5, 5000);
    ok(r.status === 409, 'runId replay rejected');

    r = await startRun(me, G);
    await sleep(500);
    { // tampered: sig covers a different score than the body claims
      const ts = Date.now();
      const t = await post('/api/run/finish', {
        playerId: me.playerId, runId: r.body.runId, score: 999000, rooms: 3, durMs: 450, ts,
        sig: hmac(me.secret, `finish|${r.body.runId}|4200|3|${ts}`),
      });
      ok(t.status === 403, 'tampered score signature rejected');
    }

    r = await playRun(me, G, 900000, 2);
    ok(r.status === 200 && r.body.flagged === true, 'implausible score/rooms flagged off-board');

    r = await playRun(me, G, 1000, 1, { durMs: 100, wait: 150 });
    ok(r.status === 400, 'durMs under per-game minimum rejected');

    { // stale timestamp
      const ts = Date.now() - 10 * 60e3;
      const t = await post('/api/run/start', { game: G, playerId: me.playerId, ts, sig: hmac(me.secret, `start|${G}|${me.playerId}|${ts}`) });
      ok(t.status === 403, 'stale signed request rejected');
    }

    // --- rival + boards + ghost
    const p2 = (await post('/api/hello', { name: 'rival' })).body;
    const log2 = Buffer.from(JSON.stringify([[0, 2], [30, 1]])).toString('base64');
    r = await playRun(p2, G, 8800, 4, { log: log2 });
    ok(r.body.rank === 1, 'rival takes rank 1');

    r = await get(`/api/board?game=${G}&around=${me.playerId}`);
    ok(r.body.top.length === 2 && r.body.top[0].name === 'rival' && r.body.top[0].score === 8800, 'daily board ordered');
    ok(r.body.me && r.body.me.rank === 2, 'around-me rank correct');
    r = await get(`/api/board?game=${G}&scope=alltime`);
    ok(r.body.top.length === 2, 'all-time board');

    r = await get(`/api/ghost?game=${G}`);
    ok(r.status === 200 && r.body.name === 'rival' && r.body.score === 8800, 'ghost is the day-best run');
    ok(Buffer.from(r.body.log, 'base64').toString() === JSON.stringify([[0, 2], [30, 1]]), 'ghost log round-trips');

    // --- cross-game isolation
    r = await playRun(me, G2, 777, 1);
    ok(r.body.rank === 1, 'score lands in second game');
    r = await get(`/api/board?game=${G2}`);
    ok(r.body.top.length === 1 && r.body.top[0].score === 777, 'second game board isolated');
    r = await get(`/api/board?game=${G}`);
    ok(r.body.top.length === 2 && r.body.top[0].score === 8800, 'first game board unaffected');
    r = await get(`/api/ghost?game=${G2}`);
    ok(r.status === 404, 'no cross-game ghost bleed');

    // --- rename + events
    { const ts = Date.now();
      r = await post('/api/name', { playerId: me.playerId, ts, name: 'renamed', sig: hmac(me.secret, `name|${me.playerId}|renamed|${ts}`) });
      ok(r.status === 200 && r.body.name === 'renamed', 'rename'); }
    r = await post('/api/admin/event', { game: G, startDay: day, endDay: day, data: { mod: 'double-coins' } }, { 'X-Admin-Key': 'test-admin' });
    ok(r.status === 200, 'admin event accepted');
    r = await get(`/api/daily?game=${G}`);
    ok(r.body.event && r.body.event.mod === 'double-coins', 'event served through /api/daily');
    r = await get(`/api/daily?game=${G2}`);
    ok(r.body.event === null, 'event scoped to its game');

    // --- platform proxy mode: no client secrets, identity from headers
    const prox = { 'X-Proxy-Key': 'test-proxy', 'X-Player-Id': 'tt:owner-1', 'X-Player-Name': 'Platform Cat' };
    r = await post('/api/hello', {}, prox);
    ok(r.status === 200 && r.body.playerId === 'tt:owner-1' && !r.body.secret, 'proxy hello: platform identity, no secret');
    r = await post('/api/run/start', { game: G }, prox);
    ok(r.status === 200 && r.body.runId, 'proxy run start without signature');
    await sleep(500);
    r = await post('/api/run/finish', { runId: r.body.runId, score: 9999, rooms: 4, durMs: 450 }, prox);
    ok(r.status === 200 && r.body.rank === 1, 'proxy finish accepted, takes rank 1');
    r = await get(`/api/board?game=${G}`);
    ok(r.body.top[0].name === 'Platform Cat', 'platform player on the board');
    r = await post('/api/run/start', { game: G }, { ...prox, 'X-Proxy-Key': 'wrong' });
    // Assert the REASON, not just the status: an unauthenticated request also
    // returns 403, so a status-only check passes even if the reject branch is
    // deleted and the request silently falls through to direct mode.
    ok(r.status === 403 && r.body.error === 'bad proxy key', 'bad proxy key rejected as such');

    // --- realtime multiplayer: two sockets, one private room, full race
    const a = wsClient(await wsTicket(me, G));
    const b = wsClient(await wsTicket(p2, G));
    await a.open(); await b.open();

    a.send({ t: 'host' });
    const roomA = await a.next('room');
    ok(roomA.code && roomA.mode === 'private' && roomA.peers.length === 1, `host got private room ${roomA.code}`);
    ok(roomA.seed === null, 'private lobby snapshot carries no seed (start is authoritative)');

    b.send({ t: 'join', code: roomA.code });
    const roomB = await b.next('room');
    ok(roomB.id === roomA.id && roomB.peers.length === 2, 'rival joined by code');
    const joinSeen = await a.next('peer');
    ok(joinSeen.joined === true, 'host notified of join');

    a.send({ t: 'ready' });
    b.send({ t: 'ready' });
    const startA = await a.next('start'), startB = await b.next('start');
    ok(startA.seed === startB.seed && startA.in > 0, 'synchronized start, same room seed');
    ok(startA.seed !== seedG, 'private room seed differs from the daily seed');

    await sleep(startA.in + 100); // let the room enter racing state
    a.send({ t: 'state', d: { x: 420, y: 690, form: 'cat', score: 500 } });
    const stateB = await b.next('state');
    ok(stateB.id === me.playerId && stateB.d.x === 420, 'live state relayed to the rival only');

    a.send({ t: 'finish', score: 5000 });
    b.send({ t: 'finish', score: 7000 });
    const resA = await a.next('result'), resB = await b.next('result');
    ok(resA.board[0].score === 7000 && resA.board[0].name === 'rival' && resB.board.length === 2,
      'race result ordered, delivered to both');

    // Rematch works: same room returns to lobby, both ready again.
    a.send({ t: 'ready' }); b.send({ t: 'ready' });
    const re = await a.next('start');
    ok(re.seed !== startA.seed, 'rematch rolls a fresh private seed');

    // Disconnect mid-race: survivor still gets a result.
    await sleep(re.in + 150); // let the countdown elapse into racing state
    b.ws.close();
    a.send({ t: 'finish', score: 1234 });
    const soloRes = await a.next('result');
    ok(soloRes.board.length === 1 && soloRes.board[0].score === 1234, 'disconnect mid-race still resolves the room');

    // One live socket per player: reconnecting displaces the old socket.
    const aClosed = new Promise(res => { a.ws.addEventListener('close', () => res(true)); setTimeout(() => res(false), 3000); });
    const a2 = wsClient(await wsTicket(me, G));
    await a2.open();
    ok(await aClosed, 'reconnect as same player displaces the old socket');
    a2.close();

    // Quickmatch: two fresh players joining with no code land in the same daily room.
    const q1p = (await post('/api/hello', { name: 'qm-one' })).body;
    const q2p = (await post('/api/hello', { name: 'qm-two' })).body;
    const c1 = wsClient(await wsTicket(q1p, G2));
    const c2 = wsClient(await wsTicket(q2p, G2));
    await c1.open(); await c2.open();
    c1.send({ t: 'join' });
    const qr1 = await c1.next('room');
    c2.send({ t: 'join' });
    const qr2 = await c2.next('room');
    ok(qr1.id === qr2.id && qr1.mode === 'daily', 'quickmatch pairs players in a daily room');
    ok(qr2.seed === seedG2, 'quickmatch room uses the daily seed');
    c1.close(); c2.close();

    // Bad ticket is refused at the door.
    const bad = new WebSocket(`${WS}/ws?ticket=nope`);
    const refused = await new Promise(res => { bad.onerror = () => res(true); bad.onopen = () => res(false); });
    ok(refused, 'bad ws ticket refused');

    // Malformed absolute-form request targets (new URL() would throw) must be
    // rejected, not crash the process — on both the HTTP and upgrade paths.
    const rawRequest = payload => new Promise(res => {
      const s = net.connect(PORT, '127.0.0.1', () => s.write(payload));
      let d = '';
      s.on('data', x => { d += x; });
      s.on('close', () => res(d));
      s.on('error', () => res(d));
      setTimeout(() => { s.destroy(); res(d); }, 2000);
    });
    await rawRequest('GET http://[:: HTTP/1.1\r\nHost: x\r\n\r\n');
    await rawRequest('GET http://[:: HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    r = await get('/api/health');
    ok(r.status === 200 && r.body.ok === true, 'malformed request targets did not crash the server');

    // ---- audit-4 regressions -------------------------------------------
    // Body shapes that used to reach handlers and 500.
    for (const raw of ['null', '[]', '"str"', '42']) {
      const rr = await fetch(BASE + '/api/run/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
      });
      if (rr.status !== 400) failed++, console.log(`FAIL  body ${raw} -> ${rr.status}, want 400`);
    }
    ok(true, 'non-object JSON bodies rejected as 400, not 500');

    // Rank must describe the score the player HOLDS, never the one just sent.
    const rk = (await post('/api/hello', { name: 'ranker' })).body;
    await playRun(rk, G, 30000, 5);                       // becomes their best
    r = await playRun(rk, G, 10, 0);                      // worse replay
    ok(r.body.best === false && r.body.rank <= r.body.total,
      `replay reports held rank ${r.body.rank}/${r.body.total}, not a phantom placement`);

    // Ties share a rank, and top[] must agree with me.rank.
    const t1 = (await post('/api/hello', { name: 'tie-a' })).body;
    const t2 = (await post('/api/hello', { name: 'tie-b' })).body;
    await playRun(t1, 'tiegame', 500, 1);
    await playRun(t2, 'tiegame', 500, 1);
    r = await get(`/api/board?game=tiegame&around=${t2.playerId}`);
    ok(r.body.top[0].rank === 1 && r.body.top[1].rank === 1 && r.body.me.rank === 1,
      'tied scores share rank 1 and top[] agrees with me.rank');

    // Signed routes reject a non-normalized game id instead of rewriting it.
    { const ts = Date.now(), bad = 'PandaCat';
      r = await post('/api/run/start', { game: bad, playerId: me.playerId, ts, sig: hmac(me.secret, `start|${bad}|${me.playerId}|${ts}`) });
      ok(r.status === 400, 'non-normalized game id rejected, not silently rewritten'); }

    // start now returns the day+seed the run is filed under.
    r = await startRun(me, G);
    ok(r.body.day && /^[0-9a-f]{64}$/.test(r.body.seed || ''), 'run/start returns its day and seed');
    const openRun = r.body.runId;

    // A run token from a previous day cannot be cashed after the board closed.
    await db_backdate(openRun);
    await sleep(500);
    r = await finishRun(me, openRun, 5000, 3, 450);
    ok(r.status === 409 && /expired/.test(r.body.error || ''), 'stale run token from a closed day is rejected');

    // --- multiplayer hardening
    const h1 = wsClient(await wsTicket(me, G));
    await h1.open();
    h1.send({ t: 'host' });
    const hr = await h1.next('room');
    h1.send({ t: 'join', code: 'ZZZZ' });                 // nonexistent
    const errMsg = await h1.next('error');
    h1.send({ t: 'ready' });                              // still hosting?
    const stillThere = await h1.next('peer');
    ok(errMsg.error === 'no such room' && stillThere.ready === true,
      'failed join leaves the caller in the room they were hosting');

    // Prototype keys must not dispatch as handlers.
    h1.send({ t: '__proto__' });
    h1.send({ t: 'constructor' });
    ok(await h1.none('error', 400), 'prototype-chain message types do not dispatch');

    // Oversized control frames are refused per RFC 6455 §5.5.
    {
      const s = await rawWs(p2, G);
      const body = Buffer.alloc(200);                      // > 125 => illegal
      const head = Buffer.from([0x89, 0x80 | 126]);        // masked ping, len 126
      const ext = Buffer.alloc(2); ext.writeUInt16BE(200);
      const mask = Buffer.from([1, 2, 3, 4]);
      const masked = Buffer.from(body.map((b, i) => b ^ mask[i & 3]));
      s.write(Buffer.concat([head, ext, mask, masked]));
      const closed = await new Promise(res => {
        s.once('data', d => res(d[0] === 0x88));           // close frame
        s.once('close', () => res(true));
        setTimeout(() => res(false), 1500);
      });
      s.destroy();
      ok(closed, 'oversized control frame closes the connection (RFC 6455 §5.5)');
    }

    // A ping flood must be rate-limited, not echoed 1:1.
    {
      const s = await rawWs(me, G);
      let pongs = 0;
      s.on('data', d => { for (let i = 0; i < d.length; i++) if ((d[i] & 0x0f) === 0x0a && (d[i] & 0x80)) pongs++; });
      const ping = Buffer.concat([Buffer.from([0x89, 0x80]), Buffer.from([1, 2, 3, 4])]);
      for (let i = 0; i < 200; i++) s.write(ping);
      await sleep(700);
      s.destroy();
      ok(pongs < 100, `ping flood rate-limited (${pongs} pongs for 200 pings, MSG_RATE=30/s)`);
    }

    // Non-finite relay scores cannot poison the result board.
    {
      const x1 = wsClient(await wsTicket(me, G2));
      const x2 = wsClient(await wsTicket(p2, G2));
      await x1.open(); await x2.open();
      x1.send({ t: 'host' });
      const xr = await x1.next('room');
      x2.send({ t: 'join', code: xr.code });
      await x2.next('room');
      x1.send({ t: 'ready' }); x2.send({ t: 'ready' });
      const st = await x1.next('start');
      await sleep(st.in + 150);
      x1.ws.send('{"t":"finish","score":1e999}');
      x2.send({ t: 'finish', score: 10 });
      const res2 = await x2.next('result');
      ok(res2.board.every(b => Number.isFinite(b.score)),
        `non-finite relay score neutralized (${JSON.stringify(res2.board.map(b => b.score))})`);
      x1.close(); x2.close();
    }

    // ---- postgres-port regressions ---------------------------------------
    // A NUL byte in any id reaches a TEXT parameter, which Postgres rejects
    // (22021). These must stay clean misses, not 500s with a driver error.
    {
      const NUL = String.fromCharCode(0);
      const bad = [];
      const probe = async (label, want, fn) => {
        const res = await fn();
        if (res.status !== want) bad.push(`${label}=${res.status}(want ${want})`);
        return res;
      };
      const bo = await probe('board', 200, () =>
        get(`/api/board?game=${G}&around=${encodeURIComponent(NUL + 'x')}`));
      if (bo.body && bo.body.me) bad.push('board returned me for a NUL id');
      await probe('hello', 403, () => post('/api/hello', { playerId: NUL + 'a', secret: 'b' }));
      await probe('finish', 404, () => {
        const ts = Date.now();
        return post('/api/run/finish', {
          playerId: me.playerId, runId: NUL + 'r', score: 10, rooms: 1, durMs: 450, ts,
          sig: hmac(me.secret, `finish|${NUL}r|10|1|${ts}`),
        });
      });
      await probe('start', 403, () => {
        const ts = Date.now();
        return post('/api/run/start', { game: G, playerId: NUL + 'p', ts, sig: 'x'.repeat(64) });
      });
      ok(bad.length === 0, `NUL bytes in ids stay clean 403/404/200, not 500${bad.length ? ' — ' + bad.join('; ') : ''}`);
    }

    // jsonb cannot hold U+0000 even as an escape, so this insert would 500.
    // (The guard walks the object structurally rather than scrubbing the
    // serialized JSON, which would also corrupt a legitimate literal
    // backslash-u-0000 string — that distinction is covered by code review,
    // not here, because shell/editor escaping makes it a brittle assertion.)
    r = await post('/api/admin/event', {
      game: G, startDay: day, endDay: day, data: { s: 'a' + String.fromCharCode(0) + 'b' },
    }, { 'X-Admin-Key': 'test-admin' });
    ok(r.status === 400, `event data containing a NUL is rejected as 400, not 500 (got ${r.status})`);

    // jsonb also cannot store a NUL inside a KEY, nor an unpaired surrogate —
    // the latter is what a naive JS truncation of an emoji leaves behind.
    {
      const keyNul = JSON.parse('{"bad\\u0000key":1}');
      const truncatedEmoji = { msg: 'Frost Festival \u{1F389}'.slice(0, 16) };
      const a1 = await post('/api/admin/event', { game: G, startDay: day, endDay: day, data: keyNul }, { 'X-Admin-Key': 'test-admin' });
      const a2 = await post('/api/admin/event', { game: G, startDay: day, endDay: day, data: truncatedEmoji }, { 'X-Admin-Key': 'test-admin' });
      ok(a1.status === 400 && a2.status === 400,
        `NUL in a key and a lone surrogate are both 400, not 500 (${a1.status}, ${a2.status})`);
    }

    // ---- real concurrency (the reason this edition exists) ---------------
    // Driven at the db layer: over HTTP the playerTouch row lock in auth()
    // incidentally serializes same-player requests, so an HTTP race would pass
    // even with the atomic guard removed.
    {
      const { makeDb } = require('./db');
      const cdb = makeDb(url);
      const rid2 = 'race-' + Date.now().toString(36);
      await cdb.runNew(rid2, G, me.playerId, day, Date.now());
      const both = await Promise.all([
        cdb.runFinish(Date.now(), 1000, 2, false, rid2),
        cdb.runFinish(Date.now(), 999999, 99, false, rid2),
      ]);
      const winners = both.filter(Boolean).length;
      const row = await cdb.runGet(rid2);
      ok(winners === 1 && row.status === 'done',
        `concurrent double-finish: exactly one wins (${winners} accepted, score ${row.score})`);

      // Two identical-score upserts must not both "win" the conflict clause.
      const pX = (await post('/api/hello', { name: 'racer' })).body;
      await Promise.all([
        cdb.scorePut('racegame', day, pX.playerId, 500, 3, 'r-a', Date.now()),
        cdb.scorePut('racegame', day, pX.playerId, 500, 7, 'r-b', Date.now()),
      ]);
      const sRow = await cdb.scoreGet('racegame', day, pX.playerId);
      ok(sRow && sRow.score === 500, `concurrent equal-score upserts converge (score ${sRow && sRow.score})`);

      // playerNew's ON CONFLICT (id) DO NOTHING. Driven at the db layer for the
      // same reason as the two above: over HTTP the pool plus the playerTouch
      // row lock serialize these, so an HTTP-level race passes even when the
      // conflict clause is removed.
      const dupId = 'dup-' + Date.now().toString(36);
      const dupes = await Promise.allSettled([1, 2, 3].map(() =>
        cdb.playerNew(dupId, 'sec', 'dupe', Date.now(), Date.now())));
      ok(dupes.every(d => d.status === 'fulfilled'),
        `concurrent inserts of one new player id do not raise duplicate-key (${dupes.map(d => d.status).join(',')})`);

      // The finish transaction: a failure must leave the run RETRYABLE, not
      // consumed. A consumed-but-unscored run answers the client's retry with
      // 409, which the SDK reads as success — losing the score silently.
      const txId = 'tx-' + Date.now().toString(36);
      await cdb.runNew(txId, G, me.playerId, day, Date.now());
      let threw = false;
      try {
        // rooms=NaN fails the INSERT into scores AFTER the run UPDATE has run,
        // which is precisely the half-succeeded shape the transaction prevents.
        await cdb.finishRunTx({ t: Date.now(), score: 10, rooms: NaN, flagged: false,
          id: txId, game: G, day, player: me.playerId, log: null });
      } catch { threw = true; }
      const txRun = await cdb.runGet(txId);
      ok(threw && txRun && txRun.status === 'open',
        `a failed finish rolls the run back to open, so the retry still works (threw=${threw}, status=${txRun && txRun.status})`);

      await cdb.close();
    }

    // Concurrent first contact for one NEW proxy player: without the
    // ON CONFLICT DO NOTHING in playerNew, one of these is a duplicate-key 500.
    {
      const p = { 'X-Proxy-Key': 'test-proxy', 'X-Player-Id': 'tt:race-new', 'X-Player-Name': 'Racer' };
      const rs = await Promise.all([1, 2, 3].map(() => post('/api/hello', {}, p)));
      ok(rs.every(x => x.status === 200), `concurrent first contact for one proxy player does not race (${rs.map(x => x.status).join(',')})`);
    }

    // ---- all-time board: DISTINCT ON must pair `rooms` with the max score --
    // Needs two days of scores for one player, which nothing else creates.
    {
      const ap = (await post('/api/hello', { name: 'alltimer' })).body;
      await post('/api/admin/game', { game: 'atgame', cfg: { minMs: 300 } }, { 'X-Admin-Key': 'test-admin' });
      await playRun(ap, 'atgame', 100, 1);                       // low score, rooms 1
      const yest = new Date(Date.now() - 26 * 3600e3).toISOString().slice(0, 10);
      await pgAdmin.query('UPDATE scores SET day = $1 WHERE game = $2 AND player = $3', [yest, 'atgame', ap.playerId]);
      await playRun(ap, 'atgame', 9000, 9);                      // high score, rooms 9
      r = await get('/api/board?game=atgame&scope=alltime');
      ok(r.body.top.length === 1 && r.body.top[0].score === 9000 && r.body.top[0].rooms === 9,
        `all-time board keeps rooms from the row owning the max score (score ${r.body.top[0] && r.body.top[0].score}, rooms ${r.body.top[0] && r.body.top[0].rooms})`);
    }

    // The suite runs with the limiter effectively disabled, which would hide a
    // broken limiter entirely. Prove it still works with a second server whose
    // budget is tiny.
    {
      const rlPort = PORT + 3;
      const rl = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        env: { ...process.env, PORT: String(rlPort), DATABASE_URL: url, ADMIN_KEY: 'x', SEED_KEY: 'y', RATE_PER_MIN: '3' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise((res, rej) => {
        rl.stdout.on('data', d => { if (String(d).includes('listening')) res(); });
        setTimeout(() => rej(new Error('rate-limit server never came up')), 20000);
      });
      let throttled = 0;
      for (let i = 0; i < 12; i++) {
        const rr = await fetch(`http://127.0.0.1:${rlPort}/api/health`);
        if (rr.status === 429) throttled++;
      }
      rl.kill();
      ok(throttled > 0, `rate limiter still enforces its budget (${throttled}/12 requests throttled at RATE_PER_MIN=3)`);
    }

    // --- health
    r = await get('/api/health');
    // typeof checks matter: these are the only COUNT(*)::bigint values in the
    // API, so they are where a missing int8 type parser would surface — and
    // `>= 2` is satisfied by the string "3" through numeric coercion.
    ok(r.body.ok === true && typeof r.body.players === 'number' && typeof r.body.games === 'number'
      && typeof r.body.sockets === 'number' && r.body.games >= 2,
      `health: ${r.body.players} players, ${r.body.games} games, ${r.body.sockets} sockets (all numbers)`);
  } finally {
    srv.kill();
    await stopPostgres();
  }

  // Floor check. CI greps this summary line, which already proves the run
  // reached the end (a thrown suite never prints it) — but not that assertions
  // still EXIST. Deleting tests would otherwise be silently green.
  const MIN_ASSERTIONS = 75;
  if (passed + failed < MIN_ASSERTIONS) {
    console.log(`\nFAIL  only ${passed + failed} assertions ran, expected at least ${MIN_ASSERTIONS}`);
    failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async e => {
  console.error(e);
  // Never leave an orphaned postgres or server process behind on failure.
  try { if (srv) srv.kill(); } catch {}
  await stopPostgres();
  process.exit(1);
});
