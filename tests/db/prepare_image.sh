#!/usr/bin/env bash
# Reuse a local/restored image; bound registry retries without hiding failure.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="$(cat "$HERE/postgres-image.txt")"

if docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "Using local database proof image: $IMG"
  exit 0
fi

for attempt in 1 2 3; do
  if docker pull "$IMG"; then
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "Database image pull failed (attempt $attempt/3); retrying." >&2
    sleep "$((attempt * 15))"
  fi
done
echo "Cannot obtain $IMG; database proof has NOT run." >&2
exit 1
