#!/usr/bin/env bash
# Runs ON THE SERVER (called over SSH by the GitHub Actions deploy job).
# Pulls the new images, restarts the stack, waits until every container is healthy,
# and automatically rolls back to the previous image tag if anything goes wrong.
#
# Required env: DOCKERHUB_USERNAME, IMAGE_TAG
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DOCKERHUB_USERNAME:?}"
: "${IMAGE_TAG:?}"

./scripts/init-env.sh

set_env() { # set_env KEY VALUE
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

cp .env .env.previous
set_env DOCKERHUB_USERNAME "$DOCKERHUB_USERNAME"
set_env IMAGE_TAG "$IMAGE_TAG"

echo "[deploy] pulling images for tag ${IMAGE_TAG}"
if docker compose pull && docker compose up -d --remove-orphans --wait --wait-timeout 180; then
  echo "[deploy] stack is healthy"
  docker image prune -f >/dev/null
  docker compose ps
  exit 0
fi

echo "[deploy] FAILED - rolling back to the previous configuration" >&2
docker compose logs --tail=40 >&2 || true
cp .env.previous .env
docker compose up -d --remove-orphans --wait --wait-timeout 180 || true
exit 1
