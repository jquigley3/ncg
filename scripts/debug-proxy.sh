#!/bin/bash
# Run inside the worker container to verify proxy setup.
# Usage: ./scripts/debug-proxy.sh (from host) or just run the curl commands inside the container.

set -e
echo "=== Proxy debug (run inside worker container) ==="
echo ""
echo "1. Env check (HTTP_PROXY should be unset so Claude uses ANTHROPIC_BASE_URL):"
echo "   ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-<not set>}"
echo "   HTTP_PROXY=${HTTP_PROXY:-<unset (expected)>}"
echo ""
echo "2. Reverse proxy test (should return 200/400/401, NOT 403/404/503):"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST http://ncg-proxy:3100/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null || echo "FAIL")
echo "   HTTP status: $STATUS"
if [[ "$STATUS" =~ ^(200|400|401|429)$ ]]; then
  echo "   OK - reverse proxy works"
elif [[ "$STATUS" == "403" ]]; then
  echo "   FAIL - Session not registered or no permission. Run: ./ncg.sh register <container_name>"
elif [[ "$STATUS" == "404" ]]; then
  echo "   FAIL - Proxy may need rebuild. Run: ./ncg.sh down && ./ncg.sh build && ./ncg.sh up"
elif [[ "$STATUS" == "503" ]]; then
  echo "   FAIL - CONNECT request. Unset HTTP_PROXY/HTTPS_PROXY if set."
else
  echo "   FAIL - Unexpected. Check proxy logs: docker logs ncg-proxy"
fi
