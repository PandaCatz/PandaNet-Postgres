#!/usr/bin/env bash
# Nightly logical backup with 14-day rotation. Reads DATABASE_URL from the
# service env file so credentials live in exactly one place.
set -euo pipefail
OUT=/opt/pandanet/backups
mkdir -p "$OUT"

# shellcheck disable=SC1091
set -a; . /opt/pandanet/env; set +a
: "${DATABASE_URL:?DATABASE_URL not set in /opt/pandanet/env}"

STAMP=$(date -u +%Y-%m-%d)
# Custom format (-Fc) so pg_restore can do selective or parallel restores. It
# is already compressed, so there is no separate gzip step.
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-privileges \
        --file="$OUT/pandanet-$STAMP.dump"

chown -R pandanet:pandanet "$OUT"
chmod 600 "$OUT"/pandanet-*.dump
find "$OUT" -name 'pandanet-*.dump' -mtime +14 -delete

# Offsite (optional): rclone copy "$OUT" remote:pandanet-backups
