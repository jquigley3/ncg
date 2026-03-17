#!/usr/bin/env bash
# Add 3 test sessions via the REST API.
# Usage: ./scripts/add-sessions.sh [base_url]
# Default base_url: http://localhost:3100

BASE_URL="${1:-http://localhost:3100}"

for name in session-1 session-2 session-3; do
  res=$(curl -s -X POST "$BASE_URL/api/sessions" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$name\"}")
  if echo "$res" | grep -q '"id"'; then
    id=$(echo "$res" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    echo "Created $name (id: $id)"
  else
    echo "Failed to create $name: $res"
  fi
done
