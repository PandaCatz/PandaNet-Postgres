// PandaNet client SDK — drop-in module for a game IF/WHEN the platform allows
// network access (direct mode), and the reference client for the API. NOT part
// of the TipTap build: today's validator bans fetch, so this file must never be
// concatenated into index.html.
//
// FAILURE CONTRACT: every method RESOLVES — never rejects — so nothing here can
// throw into a game loop. A failed or unavailable call returns null; offline
// play is always the fallback. Use PandaNet.onError(cb) to see what failed, and
// PandaNet.pendingRun to detect a run whose score has not been accepted yet.
//
// Usage:
//   PandaNet.configure('https://api.example.com', 'pandacat');
//   PandaNet.onError(e => console.warn('pandanet:', e.message));
//   await PandaNet.hello(saved);          // pass {playerId, secret} from saveState
//   const d = await PandaNet.daily();     // {date, seed, event} | null
//   const r = await PandaNet.startRun();  // {runId, day, seed} | null
//   await PandaNet.finishRun({score, rooms, durMs, log});   // log: Uint8Array|null
//   if (PandaNet.pendingRun) { /* retry finishRun later — score not banked */ }
//   const b = await PandaNet.board({around: true});
//   const g = await PandaNet.ghost();     // {name, score, log: Uint8Array} | null

(function (root) {
  'use strict';
  let BASE = '', GAME = '';
  let ID = null, SECRET = null, RUN = null;
  const enc = new TextEncoder();

  // Chunked — spreading a whole 64 KB log as arguments overflows the arg limit.
  const b64 = buf => {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function hmacHex(secret, msg) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Diagnostics hook. Every public method resolves rather than rejects (see
  // `safe` below), so this is the only way to see what went wrong.
  let onError = null;

  // Read the body as TEXT first: an error response is not always JSON (a proxy
  // 502 is usually HTML or empty), and calling r.json() before checking r.ok
  // would throw a parse error instead of reporting the HTTP status.
  async function req(pathname, init) {
    const r = await fetch(BASE + pathname, init);
    const txt = await r.text();
    let j = null, parsed = true;
    try { j = txt ? JSON.parse(txt) : null; } catch { parsed = false; }
    if (!r.ok || !parsed) {
      const e = new Error((parsed && j && j.error) || ('http ' + r.status));
      e.status = r.status;
      throw e;
    }
    return j;
  }
  const post = (pathname, body) => req(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const get = pathname => req(pathname);

  // Fail-soft: a game loop must never take an exception from the network layer.
  // Every public method returns null on any failure and reports via onError.
  async function safe(fn) {
    try { return await fn(); }
    catch (e) { try { onError && onError(e); } catch {} return null; }
  }

  const PandaNet = {
    configure(base, game) {
      BASE = String(base || '').replace(/\/$/, '');
      GAME = String(game || '');
    },
    get online() { return !!(BASE && GAME && typeof fetch === 'function' && crypto?.subtle); },
    get identity() { return ID ? { playerId: ID, secret: SECRET } : null; },
    // True while a started run has not been successfully finished. Lets a game
    // retry finishRun() (e.g. on the next screen) instead of losing the score.
    get pendingRun() { return !!RUN; },
    // onError(cb) — receives every swallowed failure. Optional.
    onError(cb) { onError = typeof cb === 'function' ? cb : null; },

    // Establish or refresh identity. `saved` comes from the game's saveState blob.
    async hello(saved, name) {
      if (!this.online) return null;
      return safe(async () => {
        const body = saved?.playerId ? { playerId: saved.playerId, secret: saved.secret, name } : { name };
        const j = await post('/api/hello', body);
        ID = j.playerId; SECRET = j.secret;
        return j; // persist {playerId, secret} back into saveState
      });
    },

    async daily(day) {
      if (!this.online) return null;
      const p = new URLSearchParams({ game: GAME });
      if (day) p.set('day', day);
      return safe(() => get('/api/daily?' + p));
    },

    // Returns {runId, day, seed} — play the seed this run is filed under, so a
    // run that crosses UTC midnight races the board it will be scored against.
    async startRun() {
      if (!ID) return null;
      return safe(async () => {
        const ts = Date.now();
        const sig = await hmacHex(SECRET, `start|${GAME}|${ID}|${ts}`);
        const j = await post('/api/run/start', { game: GAME, playerId: ID, ts, sig });
        RUN = j.runId;
        return j;
      });
    },

    // Call at the terminal state, same place submitScore fires. The run token
    // is kept until the server confirms, so a transport failure can be retried
    // (check `pendingRun`) rather than silently losing the player's score.
    async finishRun({ score, rooms, durMs, log }) {
      if (!ID || !RUN) return null;
      const runId = RUN;
      return safe(async () => {
        const ts = Date.now();
        const sig = await hmacHex(SECRET, `finish|${runId}|${score}|${rooms}|${ts}`);
        try {
          const j = await post('/api/run/finish', {
            playerId: ID, runId, score, rooms, durMs, ts, sig,
            log: log ? b64(log) : undefined,
          });
          RUN = null;
          return j;
        } catch (e) {
          // 409 means the server already recorded this run — that is success
          // for our purposes. Any other 4xx is permanent, so stop retrying.
          if (e.status === 409) { RUN = null; return { ok: true, alreadyFinished: true }; }
          if (e.status >= 400 && e.status < 500) RUN = null;
          throw e;
        }
      });
    },

    async board({ scope = 'daily', day, around } = {}) {
      if (!this.online) return null;
      const p = new URLSearchParams({ game: GAME, scope });
      if (day) p.set('day', day);
      if (around && ID) p.set('around', ID);
      return safe(() => get('/api/board?' + p));
    },

    // null when no ghost exists yet (the normal case on a game's first day).
    async ghost(day) {
      if (!this.online) return null;
      const p = new URLSearchParams({ game: GAME });
      if (day) p.set('day', day);
      return safe(async () => {
        const j = await get('/api/ghost?' + p);
        return { ...j, log: unb64(j.log) };
      });
    },

    async rename(name) {
      if (!ID) return null;
      return safe(async () => {
        const ts = Date.now();
        const sig = await hmacHex(SECRET, `name|${ID}|${name}|${ts}`);
        return post('/api/name', { playerId: ID, ts, sig, name });
      });
    },

    // --- realtime multiplayer -------------------------------------------
    // Opens the relay socket; onEvent receives every server message
    // ({t:'room'|'peer'|'start'|'state'|'finish'|'result'|'error'|'closed'}).
    // Returns a controller for the client half of the protocol.
    async connect(onEvent, { timeoutMs = 8000 } = {}) {
      if (!ID) return null;
      return safe(async () => {
        const ts = Date.now();
        const sig = await hmacHex(SECRET, `mp|${GAME}|${ID}|${ts}`);
        const { ticket } = await post('/api/mp/ticket', { game: GAME, playerId: ID, ts, sig });
        const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?ticket=' + ticket);
        // Bound the handshake and clean up on every reject path: a black-holed
        // upgrade would otherwise hang the caller forever and leak the socket.
        await new Promise((res, rej) => {
          const fail = msg => { try { ws.close(); } catch {} rej(new Error(msg)); };
          const timer = setTimeout(() => fail('ws connect timeout'), timeoutMs);
          ws.onopen = () => { clearTimeout(timer); res(); };
          ws.onerror = () => { clearTimeout(timer); fail('ws connect failed'); };
          ws.onclose = () => { clearTimeout(timer); fail('ws closed during handshake'); };
        });
        ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onEvent(m); };
        ws.onclose = () => onEvent({ t: 'closed' });
        // Returns false when the socket is not open, so a caller can tell that
        // a terminal call (finish) did not actually leave the machine.
        const send = obj => {
          if (ws.readyState !== 1) return false;
          ws.send(JSON.stringify(obj));
          return true;
        };
        return {
          get alive() { return ws.readyState === 1; },
          host: () => send({ t: 'host' }),                 // private room, get a code
          join: code => send(code ? { t: 'join', code } : { t: 'join' }),  // code or quickmatch
          ready: () => send({ t: 'ready' }),
          sendState: d => send({ t: 'state', d }),         // <=512 B opaque blob, ~10-15 Hz
          finish: score => send({ t: 'finish', score }),
          leave: () => send({ t: 'leave' }),
          close: () => ws.close(),
        };
      });
    },
  };

  root.PandaNet = PandaNet;
})(typeof window !== 'undefined' ? window : globalThis);
