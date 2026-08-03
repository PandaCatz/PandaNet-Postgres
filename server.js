#!/usr/bin/env node
// PandaNet — multi-game online backend for browser arcade games.
// PostgreSQL edition. See README.md + INTEGRATION.md.
//
//   DATABASE_URL=postgres://user:pass@host:5432/pandanet \
//   PORT=8324 ADMIN_KEY=x SEED_KEY=x PROXY_KEY=x node server.js
//
// Two trust modes, same endpoints:
//   Direct mode — clients hold a {playerId, secret} identity and HMAC-sign
//     scoring requests. For games talking straight to this server.
//   Proxy mode — the platform's server calls us with X-Proxy-Key and vouches
//     for identity via X-Player-Id / X-Player-Name headers. No client secrets
//     anywhere. This is the integration shape described in INTEGRATION.md.
//
// Endpoints (JSON; CORS * for direct mode):
//   POST /api/hello        {game, name?} | {playerId, secret}     -> identity
//   GET  /api/daily?game=                                         -> {date, seed, event}
//   POST /api/run/start    {game, playerId, ts, sig}              -> {runId}
//   POST /api/run/finish   {playerId, runId, score, rooms, durMs, ts, sig, log?}
//   GET  /api/board?game=&scope=daily|alltime&day=&around=playerId
//   GET  /api/ghost?game=&day=                                    -> best run's input log
//   POST /api/name         {playerId, ts, sig, name}
//   POST /api/admin/game   {game, cfg}                 (X-Admin-Key)
//   POST /api/admin/event  {game, startDay, endDay, data}  (X-Admin-Key)
//   GET  /api/health

'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const mp = require('./mp');
const { makeDb } = require('./db');

const PORT = +(process.env.PORT || 8324);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PROXY_KEY = process.env.PROXY_KEY || '';
const SEED_KEY = process.env.SEED_KEY || 'dev-seed-key';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

if (!DATABASE_URL) {
  console.error('PandaNet needs DATABASE_URL, e.g. postgres://user:pass@host:5432/pandanet');
  process.exit(1);
}

const MAX_BODY = 256 * 1024;        // finish + ghost log fits comfortably
const MAX_LOG_BYTES = 64 * 1024;    // gzipped input log cap
const SIG_WINDOW_MS = 90 * 1000;    // signed-request timestamp tolerance
const RUN_TTL_MS = 24 * 3600e3;     // abandoned open runs are swept after this

// Per-game tuning; override via POST /api/admin/game.
const CFG_DEFAULT = {
  scoreMax: 999999,   // absolute clamp — reject above this
  minMs: 4000,        // shortest believable run
  maxMs: 92000,       // clock + grace
  capBase: 5000,      // plausibility: score > capBase + rooms*capPerRoom -> flagged
  capPerRoom: 6000,
};

// ---------------------------------------------------------------- database
const db = makeDb(DATABASE_URL);
setInterval(() => {
  db.runSweep(Date.now() - RUN_TTL_MS)
    .catch(e => console.error(new Date().toISOString(), 'run sweep failed', e.message));
}, 3600e3).unref();

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const utcDay = (t = now()) => new Date(t).toISOString().slice(0, 10);
const rid = n => crypto.randomBytes(n).toString('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');
const dailySeed = (game, day) => hmac(SEED_KEY, `daily|${game}|${day}`);
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function gameId(s) {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return t || null;
}
// Per-game config is read on every score submission and — critically — by the
// multiplayer room manager from inside a synchronous timer callback, where
// awaiting a query is not possible. It is therefore cached in memory, loaded
// once at boot and refreshed whenever an admin writes. The table is tiny (one
// row per game), so this is a full-table cache, not an eviction problem.
const cfgCache = new Map();
async function loadCfgCache() {
  cfgCache.clear();
  for (const row of await db.gameAll()) cfgCache.set(row.id, coerceCfg(row.cfg));
}
function coerceCfg(raw) {
  const cfg = { ...CFG_DEFAULT };
  // JSONB comes back already parsed; tolerate a string for older rows.
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { obj = null; } }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(CFG_DEFAULT)) {
      if (Number.isFinite(+obj[k])) cfg[k] = +obj[k];
    }
  }
  return cfg;
}
function gameCfg(game) { return cfgCache.get(game) || CFG_DEFAULT; }
function cleanName(s) {
  // Printable ASCII only, and no HTML-special characters — boards get rendered
  // by many consumers and a name must never be able to smuggle markup.
  const t = String(s ?? '').replace(/[^\x20-\x7E]/g, '').replace(/[<>&"'`]/g, '').trim().slice(0, 16);
  return t || 'player-' + rid(2);
}

function sigOk(secret, msg, sig) {
  if (typeof sig !== 'string' || sig.length !== 64) return false;
  const want = Buffer.from(hmac(secret, msg), 'hex');
  let got; try { got = Buffer.from(sig, 'hex'); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(want, got);
}
function keyOk(header, key) {
  if (!key || typeof header !== 'string') return false;
  const a = Buffer.from(hmac(key, 'k|' + header), 'hex');
  const b = Buffer.from(hmac(key, 'k|' + key), 'hex');
  return crypto.timingSafeEqual(a, b);
}

// Platform-proxy identity: the caller proved itself with the shared key, so its
// player headers are trusted outright. Auto-provisions a player row.
async function proxyPlayer(req) {
  if (!keyOk(req.headers['x-proxy-key'], PROXY_KEY)) return null;
  const id = String(req.headers['x-player-id'] || '').slice(0, 64);
  if (!/^[\w:-]{1,64}$/.test(id)) return null;
  let p = await db.playerGet(id);
  if (!p) {
    const name = cleanName(req.headers['x-player-name']);
    // ON CONFLICT DO NOTHING: two concurrent first-requests for the same new
    // player would otherwise race and one would fail the primary key.
    await db.playerNew(id, rid(16), name, now(), now());
    p = await db.playerGet(id);
    if (!p) return null;
  } else if (req.headers['x-player-name']) {
    const name = cleanName(req.headers['x-player-name']);
    if (name !== p.name) { await db.playerName(name, p.id); p.name = name; }
  }
  await db.playerTouch(now(), p.id);
  return p;
}

// Signed request (direct mode) OR proxied identity (platform mode).
async function auth(req, body, canonical) {
  const viaProxy = await proxyPlayer(req);
  if (viaProxy) return { player: viaProxy, proxied: true };
  if (PROXY_KEY && req.headers['x-proxy-key']) return { err: 'bad proxy key' };
  const p = (body && typeof body.playerId === 'string') ? await db.playerGet(body.playerId) : null;
  if (!p) return { err: 'unknown player' };
  const ts = +body.ts;
  if (!Number.isFinite(ts) || Math.abs(now() - ts) > SIG_WINDOW_MS) return { err: 'stale timestamp' };
  if (!sigOk(p.secret, canonical, body.sig)) return { err: 'bad signature' };
  await db.playerTouch(now(), p.id);
  return { player: p };
}

// Per-IP token bucket: 60 req/min. Small map, pruned on the hour.
const buckets = new Map();
function rateOk(ip) {
  const t = now();
  let b = buckets.get(ip);
  if (!b) {
    // Hard cap so an address-rotating client can't grow the map without bound
    // between hourly prunes. Clearing briefly resets limits; that beats OOM.
    if (buckets.size >= 50000) buckets.clear();
    b = { tokens: 60, at: t }; buckets.set(ip, b);
  }
  b.tokens = Math.min(60, b.tokens + (t - b.at) / 1000);
  b.at = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.at > 3600e3) buckets.delete(k); }, 3600e3).unref();

// One-time WebSocket tickets: issued over authed HTTP, redeemed by /ws within 60 s.
const mpTickets = new Map();
function issueTicket(player, game) {
  const tok = rid(16);
  mpTickets.set(tok, { id: player.id, name: player.name, game, exp: now() + 60e3 });
  return tok;
}
function redeemTicket(tok) {
  const t = tok && mpTickets.get(tok);
  if (t) mpTickets.delete(tok);
  return t && t.exp > now() ? t : null;
}
setInterval(() => { const t = now(); for (const [k, v] of mpTickets) if (v.exp < t) mpTickets.delete(k); }, 60e3).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '?';
}

// Rate-limit key. In platform-proxy mode every request arrives from the SAME
// source address, so an IP bucket would throttle the entire multi-tenant
// service to one player's budget. A request that proved itself with PROXY_KEY
// is therefore keyed on the player the platform vouched for instead.
function rateKey(req) {
  if (PROXY_KEY && keyOk(req.headers['x-proxy-key'], PROXY_KEY)) {
    const id = String(req.headers['x-player-id'] || '');
    if (id) return 'p:' + id.slice(0, 64);
  }
  return clientIp(req);
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        // Must be a plain object: the literal `null`, a bare array, or a scalar
        // would reach handlers that dereference body.* and turn into a 500.
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new Error('bad json'));
        resolve(v);
      } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- handlers
const routes = {
  'POST /api/hello': async (body, _url, req) => {
    const viaProxy = await proxyPlayer(req);
    if (viaProxy) return [200, { playerId: viaProxy.id, name: viaProxy.name }];
    if (PROXY_KEY && req.headers['x-proxy-key']) return [403, { error: 'bad proxy key' }];
    // Refresh path: known identity proves itself with its secret. Any refresh
    // attempt with malformed credentials is a 403, never a fresh identity.
    if (body.playerId || body.secret) {
      if (typeof body.playerId !== 'string' || typeof body.secret !== 'string')
        return [403, { error: 'bad credentials' }];
      const p = await db.playerGet(String(body.playerId));
      if (p && sigOk(p.secret, 'hello|' + p.id, hmac(body.secret, 'hello|' + p.id))) {
        await db.playerTouch(now(), p.id);
        if (body.name) { const nm = cleanName(body.name); await db.playerName(nm, p.id); p.name = nm; }
        return [200, { playerId: p.id, secret: p.secret, name: p.name }];
      }
      return [403, { error: 'bad credentials' }];
    }
    const id = rid(8), secret = rid(16), name = cleanName(body.name);
    await db.playerNew(id, secret, name, now(), now());
    return [200, { playerId: id, secret, name }];
  },

  'GET /api/daily': async (_b, url) => {
    const game = gameId(url.searchParams.get('game'));
    if (!game) return [400, { error: 'bad game' }];
    const day = url.searchParams.get('day') || utcDay();
    if (!isDay(day)) return [400, { error: 'bad day' }];
    const ev = await db.eventFor(game, day);
    return [200, { game, date: day, seed: dailySeed(game, day), event: ev ? ev.data : null }];
  },

  'POST /api/run/start': async (body, _url, req) => {
    const game = gameId(body.game);
    // Reject rather than normalize: the client signs the id it sent, so
    // silently rewriting it yields a permanent, unexplainable 'bad signature'
    // — and would quietly merge distinct ids into one tenant namespace.
    if (!game || game !== body.game) return [400, { error: 'bad game' }];
    const a = await auth(req, body, `start|${game}|${body.playerId}|${body.ts}`);
    if (a.err) return [403, { error: a.err }];
    const runId = rid(12);
    const day = utcDay();
    await db.runNew(runId, game, a.player.id, day, now());
    // Hand back the day and seed this run is filed under, so a run that spans
    // UTC midnight plays the board it will actually be scored against.
    return [200, { runId, day, seed: dailySeed(game, day) }];
  },

  'POST /api/run/finish': async (body, _url, req) => {
    const a = await auth(req, body, `finish|${body.runId}|${body.score}|${body.rooms}|${body.ts}`);
    if (a.err) return [403, { error: a.err }];
    const run = await db.runGet(String(body.runId || ''));
    if (!run || run.player !== a.player.id) return [404, { error: 'unknown run' }];
    if (run.status !== 'open') return [409, { error: 'run already finished' }];
    const cfg = gameCfg(run.game);

    const score = Math.floor(+body.score), rooms = Math.floor(+body.rooms), durMs = Math.floor(+body.durMs);
    if (!Number.isFinite(score) || score < 0 || score > cfg.scoreMax) return [400, { error: 'bad score' }];
    if (!Number.isFinite(rooms) || rooms < 0 || rooms > 200) return [400, { error: 'bad rooms' }];
    if (!Number.isFinite(durMs) || durMs < cfg.minMs || durMs > cfg.maxMs) return [400, { error: 'bad duration' }];

    const elapsed = now() - run.startedAt;
    // A run token is only good for the day it was minted (plus enough grace for
    // a genuine run to cross UTC midnight). Without this, a token banked before
    // midnight can be cashed hours later to overwrite an already-closed board
    // with a score chosen after reading the final standings.
    if (run.day !== utcDay() && elapsed > cfg.maxMs) return [409, { error: 'run expired' }];
    // Wall clock must at least roughly cover the claimed play time (pauses only add).
    let flagged = false;
    if (elapsed < durMs * 0.8) flagged = true;
    if (score > cfg.capBase + rooms * cfg.capPerRoom) flagged = true;

    // Atomic close: the UPDATE only matches while the run is still open, so two
    // concurrent finishes cannot both be accepted. SQLite got this for free
    // from its single writer; Postgres has real concurrency and needs the
    // guard stated in the statement itself.
    const closed = await db.runFinish(now(), score, rooms, flagged, run.id);
    if (!closed) return [409, { error: 'run already finished' }];
    let best = false, rank = null, total = null;
    if (!flagged) {
      await db.scorePut(run.game, run.day, a.player.id, score, rooms, run.id, now());
      const cur = await db.scoreGet(run.game, run.day, a.player.id);
      best = !!cur && cur.runId === run.id;
      // Rank the score the player actually HOLDS, not the one just submitted —
      // otherwise a run that failed to beat your own best reports a placement
      // you don't have, and can even exceed `total` ("rank 3 of 2").
      rank = (await db.rankDaily(run.game, run.day, cur ? cur.score : score)).n + 1;
      total = (await db.countDaily(run.game, run.day)).n;
      // Ghost: keep the day's best input log if one was sent.
      if (best && typeof body.log === 'string' && body.log.length) {
        let buf; try { buf = Buffer.from(body.log, 'base64'); } catch { buf = null; }
        if (buf && buf.length && buf.length <= MAX_LOG_BYTES) {
          await db.ghostPut(run.game, run.day, a.player.id, score, zlib.gzipSync(buf), now());
        }
      }
    }
    return [200, { ok: true, flagged, best, rank, total }];
  },

  'GET /api/board': async (_b, url) => {
    const game = gameId(url.searchParams.get('game'));
    if (!game) return [400, { error: 'bad game' }];
    const scope = url.searchParams.get('scope') || 'daily';
    const day = url.searchParams.get('day') || utcDay();
    if (!isDay(day)) return [400, { error: 'bad day' }];
    const rows = scope === 'alltime' ? await db.boardTopAll(game, 50) : await db.boardTop(game, day, 50);
    // Competition ranking (ties share a rank), matching rankDaily's
    // COUNT(score > x) + 1 definition — a positional index would contradict
    // `me.rank` inside this same response whenever two scores tie.
    let prev = null, prevRank = 0;
    const out = {
      game, scope, day,
      top: rows.map((r, i) => {
        const rank = (r.score === prev) ? prevRank : (prev = r.score, prevRank = i + 1);
        return { rank, name: r.name, score: r.score, rooms: r.rooms };
      }),
    };
    const around = url.searchParams.get('around');
    if (around && scope !== 'alltime') {
      const mine = await db.scoreGet(game, day, around);
      if (mine) out.me = { rank: (await db.rankDaily(game, day, mine.score)).n + 1, score: mine.score, rooms: mine.rooms };
    }
    return [200, out];
  },

  'GET /api/ghost': async (_b, url) => {
    const game = gameId(url.searchParams.get('game'));
    if (!game) return [400, { error: 'bad game' }];
    const day = url.searchParams.get('day') || utcDay();
    if (!isDay(day)) return [400, { error: 'bad day' }];
    const g = await db.ghostGet(game, day);
    if (!g) return [404, { error: 'no ghost yet' }];
    return [200, { game, day, name: g.name, score: g.score, log: zlib.gunzipSync(g.log).toString('base64') }];
  },

  'POST /api/name': async (body, _url, req) => {
    const a = await auth(req, body, `name|${body.playerId}|${body.name}|${body.ts}`);
    if (a.err) return [403, { error: a.err }];
    const nm = cleanName(body.name);
    await db.playerName(nm, a.player.id);
    return [200, { name: nm }];
  },

  'POST /api/mp/ticket': async (body, _url, req) => {
    const game = gameId(body.game);
    if (!game || game !== body.game) return [400, { error: 'bad game' }];
    const a = await auth(req, body, `mp|${game}|${body.playerId}|${body.ts}`);
    if (a.err) return [403, { error: a.err }];
    return [200, { ticket: issueTicket(a.player, game) }];
  },

  'POST /api/admin/game': async (body, _url, req) => {
    if (!ADMIN_KEY || !keyOk(req.headers['x-admin-key'], ADMIN_KEY)) return [403, { error: 'nope' }];
    const game = gameId(body.game);
    if (!game) return [400, { error: 'bad game' }];
    const cfg = {};
    for (const k of Object.keys(CFG_DEFAULT)) {
      if (body.cfg && Number.isFinite(+body.cfg[k])) cfg[k] = +body.cfg[k];
    }
    await db.gamePut(game, cfg);
    // Keep the in-memory cache (which mp.js reads synchronously) in step.
    cfgCache.set(game, { ...CFG_DEFAULT, ...cfg });
    return [200, { game, cfg: { ...CFG_DEFAULT, ...cfg } }];
  },

  'POST /api/admin/event': async (body, _url, req) => {
    if (!ADMIN_KEY || !keyOk(req.headers['x-admin-key'], ADMIN_KEY)) return [403, { error: 'nope' }];
    const game = gameId(body.game);
    if (!game) return [400, { error: 'bad game' }];
    if (!isDay(body.startDay) || !isDay(body.endDay)) return [400, { error: 'bad days' }];
    await db.eventNew(game, body.startDay, body.endDay, body.data ?? {});
    return [200, { ok: true }];
  },

  'GET /api/health': async () => [200, {
    ok: true, day: utcDay(), players: (await db.nPlayers()).n, games: (await db.nGames()).n,
    ...live.stats(),
  }],
};
let live = { stats: () => ({ sockets: 0, rooms: 0 }) };

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  if (!rateOk(rateKey(req))) return send(res, 429, { error: 'slow down' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  // An absolute-form request target ("GET http://[:: HTTP/1.1") reaches here
  // verbatim and would make new URL() throw — that must be a 400, not a crash.
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return send(res, 400, { error: 'bad url' }); }
  const statics = {
    '/': ['demo.html', 'text/html; charset=utf-8'],
    '/demo.html': ['demo.html', 'text/html; charset=utf-8'],
    '/client-sdk.js': ['client-sdk.js', 'text/javascript; charset=utf-8'],
  };
  if (req.method === 'GET' && statics[url.pathname]) {
    const [file, type] = statics[url.pathname];
    try {
      const data = fs.readFileSync(path.join(__dirname, file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(data);
    } catch { return send(res, 404, { error: 'missing static file' }); }
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(res, 404, { error: 'not found' });
  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  try {
    const [code, obj] = await route(body, url, req);
    send(res, code, obj);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, url.pathname, e);
    send(res, 500, { error: 'server error' });
  }
});

live = mp.attach(server, {
  redeemTicket,
  dailySeed,
  utcDay,
  maxMs: game => gameCfg(game).maxMs,
});

// Loopback by default — the documented deploy puts Caddy in front, and binding
// every interface would expose the app port to anything ufw ever lets through.
// Set HOST=0.0.0.0 deliberately (containers, or a proxy on another host).
// Managed Postgres usually lives on another host, so a platform deploy will
// normally set both HOST=0.0.0.0 and DATABASE_URL.
const HOST = process.env.HOST || '127.0.0.1';

// Boot is async now: the schema has to exist and the per-game config cache has
// to be warm BEFORE the first request lands, because mp.js reads that cache
// synchronously from timer callbacks.
async function boot() {
  await db.migrate();
  await loadCfgCache();
  if (process.argv.includes('--migrate-only')) {
    console.log('schema up to date; ' + cfgCache.size + ' game config(s) loaded');
    await db.close();
    return;
  }
  await new Promise(res => server.listen(PORT, HOST, res));
  const where = DATABASE_URL.replace(/\/\/[^@]*@/, '//***@');
  console.log(`pandanet listening on ${HOST}:${PORT} · db ${where} · proxy mode ${PROXY_KEY ? 'on' : 'off'}`);
}

// Shut down cleanly so in-flight queries finish and the pool is released;
// systemd sends SIGTERM on restart and stop.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => db.close().then(() => process.exit(0), () => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

boot().catch(e => {
  console.error('startup failed:', e.message);
  process.exit(1);
});
