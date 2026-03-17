#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Building..."
./ncg.sh build

echo "==> Stopping stack..."
./ncg.sh down 2>/dev/null || true

echo "==> Starting stack..."
./ncg.sh up

echo "==> Waiting for proxy..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3100/health >/dev/null 2>&1; then
    echo "Proxy is up."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Proxy failed to start."
    exit 1
  fi
  sleep 1
done

echo "==> Verifying API..."
ROUTES=$(curl -sf http://127.0.0.1:3100/api/routes)
echo "Routes: $ROUTES"

SESSIONS=$(curl -sf http://127.0.0.1:3100/api/sessions)
echo "Sessions: $SESSIONS"

echo "==> Rebuild and verify complete."
