#!/usr/bin/env bash
# Restore a PandaNet backup.  Run as root:  bash restore.sh <backup.dump>
#
# --clean --if-exists drops existing objects first, so this is a genuine
# rollback rather than a merge into whatever is currently there. The service is
# stopped for the duration, because restoring under live writes would
# interleave the dump with new rows.
set -euo pipefail
# The safety dump below contains players.secret; never leave it world-readable.
umask 077
SRC="${1:?usage: restore.sh <backup.dump>}"
[ -f "$SRC" ] || { echo "no such backup: $SRC" >&2; exit 1; }

# Extract, do not source — see the note in backup.sh.
DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' /opt/pandanet/env)
: "${DATABASE_URL:?DATABASE_URL not found in /opt/pandanet/env}"

# Take the safety dump BEFORE stopping the service. pg_dump's snapshot is
# consistent whether or not the app is running, and doing it first means a
# failed dump leaves the API up and the data untouched, instead of stranding
# the service stopped having restored nothing.
mkdir -p /opt/pandanet/backups
KEEP="/opt/pandanet/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$KEEP"
echo "current data saved to $KEEP"

systemctl stop pandanet

pg_restore --dbname="$DATABASE_URL" --clean --if-exists --no-owner --no-privileges "$SRC"

# Fail loudly BEFORE restarting if the restore did not produce a usable schema.
psql "$DATABASE_URL" -c 'SELECT count(*) FROM players;' >/dev/null
echo "schema verified"

systemctl start pandanet
sleep 1
systemctl is-active --quiet pandanet && echo "restore complete; service is running"
