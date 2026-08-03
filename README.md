<div align="center">

# 🐼 PandaNet — PostgreSQL edition

### The online layer for arcade games — leaderboards, ghosts, live events, and realtime races

[![CI](https://github.com/PandaCatz/PandaNet-Postgres/actions/workflows/ci.yml/badge.svg)](https://github.com/PandaCatz/PandaNet-Postgres/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-72%20passing-brightgreen.svg)](test.js)
[![Postgres](https://img.shields.io/badge/postgres-%E2%89%A5%2013-336791.svg?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

**Same API, same behaviour, same 72 tests — backed by PostgreSQL instead of SQLite.**

Sibling of [PandaCatz/PandaNet](https://github.com/PandaCatz/PandaNet) (the zero-dependency SQLite edition).

</div>

---

## Why this edition exists

The [SQLite edition](https://github.com/PandaCatz/PandaNet) is dependency-free and stores everything in one
file, which makes it perfect for a VPS you control. It is a poor fit for
platforms that give you a **managed Postgres and an ephemeral filesystem** —
there, a SQLite file is wiped on every redeploy.

This edition is a drop-in replacement for exactly that case. Nothing about the
HTTP API, the WebSocket protocol, the client SDK, or the anti-cheat rules
changed; only storage did.

| | SQLite edition | PostgreSQL edition |
|---|---|---|
| Dependencies | none | `pg` (one) |
| Storage | one file on disk | any Postgres ≥ 13 |
| Deploy target | VPS with persistent disk | VPS, or any PaaS with managed Postgres |
| Concurrency | one writer | real concurrent writes |
| Backups | `sqlite3 .backup` | `pg_dump` / provider snapshots |
| API + tests | identical | identical (72 assertions) |

## Quick start

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/pandanet npm start
npm test          # spins up a real PostgreSQL and runs all 72 assertions
```

`npm test` needs no database of its own — it downloads and runs a real
PostgreSQL via `embedded-postgres`, so the suite exercises the same engine
production does rather than an emulator. Point `TEST_DATABASE_URL` at an
existing server to use that instead (which is what CI should do).

## Configuration

| Var | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | **yes** | `postgres://user:pass@host:5432/db`. Append `?sslmode=require` for managed providers; the pool then connects with TLS without demanding a publicly-verifiable chain. |
| `PORT` | no (8324) | HTTP + WebSocket listen port |
| `HOST` | no (127.0.0.1) | Bind address. Loopback by default so the app sits behind a proxy; set `0.0.0.0` on a PaaS. |
| `ADMIN_KEY` | yes | Bearer for `/api/admin/*`. Empty disables admin endpoints. |
| `SEED_KEY` | yes | HMAC key every daily seed derives from. Set once; changing it changes every seed. |
| `PROXY_KEY` | platform mode | Shared secret for the platform proxy's `X-Proxy-Key`. |
| `TRUST_PROXY` | `1` behind a proxy | Use the first `X-Forwarded-For` entry for rate limiting. |
| `RATE_PER_MIN` | no (60) | Requests per minute per key. The key is the client IP, or — when a request authenticates with `PROXY_KEY` — the vouched player, since behind a proxy every request shares one address. Raise it if one proxy fronts many games. |

Run `node server.js --migrate-only` to create or update the schema and exit —
useful as a release/deploy step. It is idempotent.

## What changed from the SQLite edition

Storage moved into **`db.js`**, which exposes one async method per query so no
caller builds SQL. Beyond the mechanical `?` → `$1` and `await` conversion,
five things needed real attention:

- **Timestamps are `BIGINT`, not `INTEGER`.** `Date.now()` is ~1.7×10¹² and
  overflows Postgres's 32-bit `INTEGER`. SQLite's flexible typing hid this
  completely; on Postgres it would have thrown on the first write.
- **`int8` is parsed back to a number.** `pg` returns `BIGINT` as a *string* by
  default, because 64 bits do not always fit a JS number. Every `BIGINT` here
  is a millisecond timestamp or a score, so the type parser is set globally in
  `db.js` — without it, `now() - run.startedAt` becomes string arithmetic and
  the board returns `"score":"8800"` instead of `8800`.
- **Finishing a run is atomic.** `UPDATE … WHERE status='open' RETURNING id`
  means two concurrent finishes cannot both be accepted. SQLite got this free
  from its single writer; real concurrency needs it stated.
- **The all-time board uses `DISTINCT ON`.** The old `MAX(score)` with a bare
  `rooms` column is not valid Postgres, and in SQLite it silently returned an
  arbitrary row's `rooms`. Now `rooms` provably belongs to the run that owns
  the max score.
- **Per-game config is cached in memory.** `mp.js` reads it synchronously from
  a timer callback where awaiting is impossible. The cache loads at boot and
  refreshes on admin write — and it also removes a database read from every
  score submission.

`ON CONFLICT … DO UPDATE … WHERE` — the trickiest SQL in the project — ported
unchanged; Postgres and SQLite share that syntax.

## Deploy to a hosting platform

If your platform builds from the repo and provides managed Postgres (Nixpacks,
Heroku-style buildpacks, Render, Railway, breezedeploy, …), there is nothing to
install — it runs `npm start`. Set these and you are done:

| | |
|---|---|
| `DATABASE_URL` | from the platform's managed database |
| **`HOST=0.0.0.0`** | **required.** The default is loopback, which is right behind a local reverse proxy but makes the app **unreachable** when the router lives outside the container — a completely silent failure. The server prints a reminder at boot when it binds loopback. |
| `PORT` | usually injected by the platform; honoured automatically |
| `ADMIN_KEY`, `SEED_KEY` | generate your own; `SEED_KEY` must never change once live |
| `PROXY_KEY` | only if a platform proxy will vouch for player identity |

The schema is created and updated automatically on every boot, so no release
or migration step is needed.

Two requirements to check with your provider before committing:

- **WebSocket upgrades must be proxied**, or multiplayer will not work.
  Leaderboards, seeds, events and ghosts are unaffected.
- **A single instance.** Rooms, tickets and countdowns are in memory (see
  [Still single-node](#still-single-node)), so two replicas split players
  across processes. An always-on, non-scaling single container is the right
  shape; scale-to-zero would destroy live lobbies.

## Deploy to your own VPS

```bash
cd deploy && bash setup.sh api.yourdomain.tld
```

Installs Node, Caddy (automatic TLS) and PostgreSQL, creates a database and
role with a generated password, installs dependencies, **runs the migration
before starting the service** so a database problem surfaces immediately rather
than as a crash-loop, and sets up nightly `pg_dump` backups with rotation.

For a managed database, skip the local install:

```bash
MANAGED_DB='postgres://user:pass@db.example.com/pandanet?sslmode=require' \
  bash setup.sh api.yourdomain.tld
```

Because all state now lives in Postgres, the systemd unit runs with a fully
read-only filesystem — there is no `ReadWritePaths` exception at all.

Restores use `deploy/restore.sh <backup.dump>`, which dumps the current data
first, restores with `--clean --if-exists` so it is a true rollback rather than
a merge, verifies the schema, and only then restarts the service.

## Still single-node

Postgres removes the single-writer limit, but **multiplayer rooms, tickets and
countdowns are in-memory in `mp.js`**. Two app instances means two players can
land on different processes and never see each other. Run one instance, or
give the relay a shared backplane first.

## Security

See [SECURITY.md](SECURITY.md) for the threat model, the documented accepted
limits, and how to report a vulnerability privately.

## API and everything else

Unchanged — see the [SQLite edition's README](https://github.com/PandaCatz/PandaNet#readme),
[AGENT_HANDOFF.md](https://github.com/PandaCatz/PandaNet/blob/main/AGENT_HANDOFF.md) and
[INTEGRATION.md](https://github.com/PandaCatz/PandaNet/blob/main/INTEGRATION.md). Every endpoint, the WebSocket
protocol, the client SDK contract, and the anti-cheat behaviour are identical,
which is why the same 72-assertion suite passes against both.
