#!/usr/bin/env bash
# Nightly logical backup with 14-day rotation. Reads DATABASE_URL from the
# service env file so credentials live in exactly one place.
set -euo pipefail
# Dumps contain players.secret (bearer credentials), so they must never be
# created group/world readable, not even for the moment before a chmod.
umask 077
OUT=/opt/pandanet/backups
mkdir -p "$OUT"

# Extract, do not source. systemd parses this file as key=value, but `.` parses
# it as SHELL — a managed URL containing `&` would background the assignment
# and leave DATABASE_URL unset, failing every night unseen under cron.
DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' /opt/pandanet/env)
: "${DATABASE_URL:?DATABASE_URL not found in /opt/pandanet/env}"

STAMP=$(date -u +%Y-%m-%d)
# Custom format (-Fc) so pg_restore can do selective or parallel restores. It
# is already compressed, so there is no separate gzip step.
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges \
        --file="$OUT/pandanet-$STAMP.dump"

chown -R pandanet:pandanet "$OUT"
chmod 600 "$OUT"/pandanet-*.dump
find "$OUT" -name 'pandanet-*.dump' -mtime +14 -delete

# Offsite (optional): rclone copy "$OUT" remote:pandanet-backups
