#!/usr/bin/env bash
# One-shot VPS setup for PandaNet (PostgreSQL edition).
# Target: Ubuntu 24.04 minimal, 1 vCPU / 1 GB. Run as root from deploy/:
#
#   bash setup.sh api.example.com                 # installs Postgres locally
#   MANAGED_DB=postgres://user:pass@host/db \
#     bash setup.sh api.example.com               # uses a managed database
set -euo pipefail
DOMAIN="${1:?usage: setup.sh <api.domain.tld>}"
MANAGED_DB="${MANAGED_DB:-}"
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg ufw

# Node 20+ via NodeSource — Ubuntu's own nodejs package is older than the
# engines floor in package.json.
if ! command -v node >/dev/null 2>&1 || \
   ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

# Caddy from its official repo (not in Ubuntu's default repos). Terminates TLS
# and proxies both HTTP and WebSocket traffic with no extra configuration.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

# A re-run WITHOUT MANAGED_DB on a box that uses a managed database would fall
# into the local branch, provision an empty database and repoint the service at
# it — health checks would pass while every leaderboard silently vanished.
if [ -z "$MANAGED_DB" ] && [ -f /opt/pandanet/env ] \
   && grep -q '^DATABASE_URL=' /opt/pandanet/env \
   && ! grep -q '^DATABASE_URL=postgres://pandanet:[^@]*@127\.0\.0\.1' /opt/pandanet/env; then
  echo "ERROR: this box is already configured against a non-local database." >&2
  echo "Re-run with MANAGED_DB set to that URL, or delete /opt/pandanet/env to start fresh." >&2
  exit 1
fi

# PostgreSQL. With MANAGED_DB set we install only the CLIENT tools, which the
# backup and restore scripts need.
if [ -n "$MANAGED_DB" ]; then
  # From PGDG, not Ubuntu: noble ships client 16, and pg_dump REFUSES to dump
  # from a server newer than itself. A managed PG 17/18 would fail every
  # nightly backup — silently, since cron has nowhere to mail the error.
  apt-get install -y --no-install-recommends postgresql-common
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  apt-get install -y --no-install-recommends postgresql-client-18
  DB_URL="$MANAGED_DB"
else
  apt-get install -y --no-install-recommends postgresql postgresql-client
  systemctl enable --now postgresql
  DB_PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  # Idempotent: create the role and database only if missing, and always reset
  # the password so a re-run cannot leave the env file holding a stale one.
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pandanet') THEN
    CREATE ROLE pandanet LOGIN;
  END IF;
END \$\$;
ALTER ROLE pandanet WITH PASSWORD '${DB_PASS}';
SELECT 'CREATE DATABASE pandanet OWNER pandanet'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pandanet')\gexec
SQL
  DB_URL="postgres://pandanet:${DB_PASS}@127.0.0.1:5432/pandanet"
fi

# App user + layout
id -u pandanet &>/dev/null || useradd --system --home /opt/pandanet --shell /usr/sbin/nologin pandanet
mkdir -p /opt/pandanet/backups
cp ../server.js ../db.js ../mp.js ../client-sdk.js ../demo.html ../package.json /opt/pandanet/
cp ../package-lock.json /opt/pandanet/ 2>/dev/null || true

# Runtime dependency (`pg`). npm ci when a lockfile came along, else install.
cd /opt/pandanet
if [ -f package-lock.json ]; then npm ci --omit=dev --no-fund --no-audit
else npm install --omit=dev --no-fund --no-audit; fi
cd - >/dev/null

# Secrets — generated once, kept out of git and out of the process list.
if [ ! -f /opt/pandanet/env ]; then
  cat > /opt/pandanet/env <<EOF
DATABASE_URL=${DB_URL}
ADMIN_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
SEED_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
PROXY_KEY=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
EOF
else
  # Re-run with a rotated local password: keep the keys, refresh the URL only.
  # Delete-then-append rather than sed substitution: an `&` in the replacement
  # means "the matched text", so a URL like `...?sslmode=require&timeout=10`
  # would be spliced into garbage — and a substitution is a silent no-op when
  # the line is missing entirely (an env file from the SQLite edition).
  sed -i '/^DATABASE_URL=/d' /opt/pandanet/env
  printf 'DATABASE_URL=%s\n' "$DB_URL" >> /opt/pandanet/env
fi
chmod 600 /opt/pandanet/env
chown -R pandanet:pandanet /opt/pandanet

# Create the schema before the service starts, so a database problem shows up
# here rather than as a crash-loop later.
# The URL is expanded INSIDE the child, where pandanet reads its own env file:
# passing it as an argument to sudo would write the password into sudo's
# authpriv log and into the process list for the duration.
sudo -u pandanet bash -c '
  cd /opt/pandanet
  DATABASE_URL=$(sed -n "s/^DATABASE_URL=//p" env) \
    node server.js --migrate-only'

# systemd + Caddy
cp pandanet.service /etc/systemd/system/
sed "s/api.example.com/${DOMAIN}/" Caddyfile > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable pandanet
systemctl restart pandanet
systemctl reload caddy || systemctl restart caddy

# Firewall: SSH + HTTP(S) only. The app binds loopback; Postgres is local.
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable

# Nightly backup + the restore helper
cp backup.sh restore.sh /opt/pandanet/
chmod +x /opt/pandanet/backup.sh /opt/pandanet/restore.sh
cat > /etc/cron.d/pandanet-backup <<'EOF'
15 4 * * * root /opt/pandanet/backup.sh
EOF

echo
echo "Done. Verify:"
echo "  systemctl status pandanet --no-pager"
echo "  curl -s https://${DOMAIN}/api/health"
