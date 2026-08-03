# Security policy

## Reporting a vulnerability

Please report privately — **do not open a public issue** for a security bug.

Use GitHub's [private vulnerability reporting](https://github.com/PandaCatz/PandaNet-Postgres/security/advisories/new)
on this repository. That opens a private advisory only the maintainer can see.

Please include the affected file and line, a concrete failure scenario
(inputs and state → wrong outcome), and a proof-of-concept if you have one. A
runnable repro is worth far more than a description.

Expect an initial response within about a week. This is a reference
implementation maintained by one person, not a funded product — that is the
honest service level.

## Scope

In scope: `server.js`, `db.js`, `mp.js`, `client-sdk.js`, and the `deploy/`
scripts — remote crashes, authentication and authorization bypasses, SQL
injection, score forgery or cross-player writes, cross-game data leaks,
resource exhaustion, and deploy configurations that expose the service or its
database.

Out of scope, because they are documented, accepted design limits:

- A modified game client lying about its own play. No client-side game can
  prevent this. The mitigation path is server-side re-simulation of flagged
  runs from their stored input logs.
- **Single-node operation.** PostgreSQL removes the single-writer limit, but
  multiplayer rooms, tickets and countdowns are in-memory in `mp.js`. Running
  two app instances splits players across processes. Run one, or give the relay
  a shared backplane first.
- The static `X-Proxy-Key` shared secret, which is documented as pilot-only.
- Relay race results being informational rather than authoritative. Ranked
  scoring only ever comes from the signed or proxy-vouched HTTP finish flow.

## Threat model in one paragraph

Clients are untrusted. Every scoring write requires either an HMAC signature
over a canonical string containing a fresh timestamp, or a request from the
platform proxy authenticated with a shared key. Runs require a server-issued
one-time token, are closed atomically so two concurrent finishes cannot both be
accepted, are bound to the leaderboard day they were minted for, and are capped
by per-game plausibility limits; implausible runs are stored but flagged off
the leaderboard so a false positive never destroys a legitimate run. WebSocket
access requires a single-use ticket that expires in 60 seconds. The server
never executes or simulates game code — multiplayer state blobs are opaque and
relayed, never interpreted.

## Database notes

Every query is parameterised; no SQL is built by string concatenation
anywhere. `DATABASE_URL` carries credentials and must live only in the
service's environment file (`chmod 600`), never in the repository — CI fails
the build if a connection string with a password appears in tracked files.
Append `?sslmode=require` for managed providers.

## Verifying a change

`node test.js` must print `65 passed, 0 failed`. The suite runs against a real
PostgreSQL — downloaded automatically, or an existing server via
`TEST_DATABASE_URL` — and covers every rejection path, not just happy paths:
malformed WebSocket frames, ping floods, prototype-pollution message types,
expired run tokens, tampered signatures, and non-object JSON bodies. CI runs it
on every push and pull request, asserts the exact assertion count, verifies the
schema migration is idempotent, and runs `npm audit`.

## Audit history

The shared codebase has been through four adversarial review passes, the last a
48-agent audit whose 26 surviving findings are all fixed and pinned by
regression tests. The PostgreSQL port additionally fixed two latent issues that
SQLite's flexible typing had hidden: millisecond timestamps stored in a column
too narrow to hold them, and an all-time leaderboard query whose `rooms` value
was not guaranteed to belong to the run that owned the score.
