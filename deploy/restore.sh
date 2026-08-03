#!/usr/bin/env bash
# Restore a PandaNet backup.  Run as root:  bash restore.sh <backup.dump>
#
# --clean --if-exists drops existing objects first, so this is a genuine
# rollback rather than a merge into whatever is currently there. The service is
# stopped for the duration, because restoring under live writes would
# interleave the dump with new rows.
set -euo pipefail
SRC="${1:?usage: restore.sh <backup.dump>}"
[ -f "$SRC" ] || { echo "no such backup: $SRC" >&2; exit 1; }

# shellcheck disable=SC1091
set -a; . /opt/pandanet/env; set +a
: "${DATABASE_URL:?DATABASE_URL not set in /opt/pandanet/env}"

systemctl stop pandanet

# Keep a dump of the CURRENT data before overwriting it — a restore is not a
# delete, and the operator may have picked the wrong file.
mkdir -p /opt/pandanet/backups
KEEP="/opt/pandanet/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$KEEP"
echo "current data saved to $KEEP"

pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$SRC"

# Fail loudly BEFORE restarting if the restore did not produce a usable schema.
psql "$DATABASE_URL" -c 'SELECT count(*) FROM players;' >/dev/null
echo "schema verified"

systemctl start pandanet
sleep 1
systemctl is-active --quiet pandanet && echo "restore complete; service is running"
