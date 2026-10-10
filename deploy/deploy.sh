#!/usr/bin/env bash
# Deploy the committed HEAD to the server: the image is built on the server
# (no local Docker needed), only the b2b-parcer container is recreated.
# Other containers on the host (indapt, VPN, ...) are not touched.
#
#   deploy/deploy.sh                 # deploy
#   deploy/deploy.sh --rollback      # back to the previous image
set -euo pipefail

HOST="${DEPLOY_HOST:-root@178.17.50.107}"
DIR="/opt/b2b-parcer"
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--rollback" ]]; then
  ssh "$HOST" "cd $DIR && docker tag b2b-parcer:rollback b2b-parcer:latest && docker compose up -d --force-recreate b2b-parcer"
  exit 0
fi

if ! git diff --quiet HEAD; then
  echo "Внимание: есть незакоммиченные изменения — на сервер уйдёт только закоммиченный HEAD." >&2
fi
REV="$(git rev-parse --short HEAD)"
ARCHIVE="$(mktemp -t b2b-parcer).tar.gz"
git archive --format=tar.gz -o "$ARCHIVE" HEAD
scp -q "$ARCHIVE" "$HOST:/tmp/b2b-parcer.tar.gz"
rm -f "$ARCHIVE"

ssh "$HOST" bash -s -- "$DIR" "$REV" <<'REMOTE'
set -euo pipefail
DIR="$1"; REV="$2"
mkdir -p "$DIR"
rm -rf "$DIR/src" && mkdir "$DIR/src"
tar -xzf /tmp/b2b-parcer.tar.gz -C "$DIR/src" && rm -f /tmp/b2b-parcer.tar.gz
cp "$DIR/src/deploy/docker-compose.yml" "$DIR/docker-compose.yml"
cd "$DIR"
if docker image inspect b2b-parcer:latest >/dev/null 2>&1; then docker tag b2b-parcer:latest b2b-parcer:rollback; fi
docker build -q --label "rev=$REV" -t b2b-parcer:latest src
docker compose up -d --force-recreate b2b-parcer
sleep 5
docker ps --filter name=b2b-parcer --format "{{.Names}}: {{.Status}}"
curl -fsS -o /dev/null -w "UI: HTTP %{http_code}\n" http://127.0.0.1:5180/ || { docker logs --tail 40 b2b-parcer; exit 1; }
REMOTE
echo "Готово: $REV. Открыть: ssh -N -L 5180:127.0.0.1:5180 ${HOST} и http://localhost:5180"
