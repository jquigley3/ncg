#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_PORT="${NCG_PORT:-3100}"
API_URL="http://127.0.0.1:${PROXY_PORT}"
NETWORK="ncg-internal"

case "${1:-}" in
  build)
    echo "==> Building proxy image..."
    docker build -t ncg-proxy:latest "$SCRIPT_DIR"
    ;;
  build-test)
    echo "==> Building test image..."
    docker build -t ncg-test:latest -f "$SCRIPT_DIR/Dockerfile.test" "$SCRIPT_DIR"
    ;;
  build-worker)
    echo "==> Building worker image..."
    docker build -t ncg-worker:latest -f "$SCRIPT_DIR/Dockerfile.worker" "$SCRIPT_DIR"
    ;;
  up)
    echo "==> Starting (nano)clawgate stack..."
    docker network inspect "$NETWORK" &>/dev/null || docker network create --internal "$NETWORK"
    if ! docker container inspect ncg-proxy &>/dev/null 2>&1; then
      docker run -d --name ncg-proxy -p "${PROXY_PORT}:3100" \
        ${ANTHROPIC_API_KEY:+-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"} \
        ncg-proxy:latest
      docker network connect "$NETWORK" ncg-proxy
    else
      docker start ncg-proxy 2>/dev/null || true
    fi
    echo "Proxy running at $API_URL"
    ;;
  down)
    echo "==> Stopping (nano)clawgate stack..."
    docker stop ncg-proxy 2>/dev/null || true
    docker rm ncg-proxy 2>/dev/null || true
    docker network rm "$NETWORK" 2>/dev/null || true
    echo "Stack stopped"
    ;;
  launch)
    NAME=""
    MOUNT=""
    CMD_ARGS=()
    shift
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) NAME="$2"; shift 2 ;;
        --mount) MOUNT="$2"; shift 2 ;;
        --) shift; CMD_ARGS+=("$@"); break ;;
        *) CMD_ARGS+=("$1"); shift ;;
      esac
    done
    if [[ -z "$NAME" ]]; then
      echo "Usage: ./ncg.sh launch --name <name> [--mount path] [command...]"
      exit 1
    fi
    MOUNT_ARGS=()
    [[ -n "$MOUNT" ]] && MOUNT_ARGS=(-v "$(cd "$MOUNT" 2>/dev/null && pwd):/workspace/project")
    docker run -it --rm --name "$NAME" --network "$NETWORK" \
      -e ANTHROPIC_BASE_URL="http://ncg-proxy:3001" \
      -e ANTHROPIC_API_KEY="placeholder" \
      "${MOUNT_ARGS[@]}" \
      ncg-worker:latest "${CMD_ARGS[@]}"
    ;;
  register)
    CONTAINER=""
    shift
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --container) CONTAINER="$2"; shift 2 ;;
        *) CONTAINER="${CONTAINER:-$1}"; shift ;;
      esac
    done
    if [[ -z "$CONTAINER" ]]; then
      echo "Usage: ./ncg.sh register <container_name>"
      exit 1
    fi
    if ! docker container inspect "$CONTAINER" &>/dev/null 2>&1; then
      echo "Container '$CONTAINER' not found. Is it running?"
      exit 1
    fi
    CONTAINER_ID=$(docker inspect -f '{{.Id}}' "$CONTAINER")
    CONTAINER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER")
    SESSION_RESP=$(curl -s -X POST "$API_URL/api/sessions" -H "Content-Type: application/json" \
      -d "{\"name\":\"$CONTAINER\"}")
    SESSION_ID=$(echo "$SESSION_RESP" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    if [[ -z "$SESSION_ID" ]]; then
      echo "Failed to create session. Is the proxy running? ($API_URL)"
      exit 1
    fi
    curl -s -X PATCH "$API_URL/api/sessions/$SESSION_ID" -H "Content-Type: application/json" \
      -d "{\"container_id\":\"$CONTAINER_ID\",\"container_name\":\"$CONTAINER\",\"container_ip\":\"$CONTAINER_IP\"}" >/dev/null
    echo "Session $SESSION_ID registered for container $CONTAINER"
    ;;
  route)
    shift
    case "${1:-}" in
      add)
        NAME="${2:-}"; TYPE="${3:-}"; shift 3
        if [[ -z "$NAME" || -z "$TYPE" ]]; then
          echo "Usage: ./ncg.sh route add <name> reverse <path_prefix> <upstream_url>"
          echo "       ./ncg.sh route add <name> forward <domain_pattern>"
          exit 1
        fi
        if [[ "$TYPE" == "reverse" ]]; then
          PREFIX="${1:-}"; URL="${2:-}"
          [[ -z "$PREFIX" || -z "$URL" ]] && { echo "Usage: route add <name> reverse <path_prefix> <upstream_url>"; exit 1; }
          BODY="{\"name\":\"$NAME\",\"type\":\"reverse\",\"path_prefix\":\"$PREFIX\",\"upstream_url\":\"$URL\"}"
        elif [[ "$TYPE" == "forward" ]]; then
          PATTERN="${1:-}"
          [[ -z "$PATTERN" ]] && { echo "Usage: route add <name> forward <domain_pattern>"; exit 1; }
          BODY="{\"name\":\"$NAME\",\"type\":\"forward\",\"domain_pattern\":\"$PATTERN\"}"
        else
          echo "Type must be reverse or forward"; exit 1
        fi
        curl -s -X POST "$API_URL/api/routes" -H "Content-Type: application/json" -d "$BODY"
        ;;
      rm|delete)
        NAME="${2:-}"
        [[ -z "$NAME" ]] && { echo "Usage: ./ncg.sh route rm <name>"; exit 1; }
        curl -s -X DELETE "$API_URL/api/routes/$NAME"
        ;;
      ls|"")
        curl -s "$API_URL/api/routes" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/api/routes"
        ;;
      *) echo "Usage: ./ncg.sh route add|rm|ls"; exit 1 ;;
    esac
    ;;
  session)
    shift
    case "${1:-}" in
      add)
        NAME="${2:-}"
        [[ -z "$NAME" ]] && { echo "Usage: ./ncg.sh session add <name>"; exit 1; }
        curl -s -X POST "$API_URL/api/sessions" -H "Content-Type: application/json" -d "{\"name\":\"$NAME\"}"
        ;;
      ls|"")
        curl -s "$API_URL/api/sessions" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/api/sessions"
        ;;
      *)
        ID="$1"; CMD="${2:-}"
        if [[ -z "$CMD" ]]; then
          curl -s "$API_URL/api/sessions/$ID" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/api/sessions/$ID"
        elif [[ "$CMD" == "allow" || "$CMD" == "deny" ]]; then
          curl -s -X PATCH "$API_URL/api/sessions/$ID" -H "Content-Type: application/json" -d "{\"default_policy\":\"$CMD\"}"
        elif [[ "$CMD" == "start" || "$CMD" == "stop" ]]; then
          VAL=$([[ "$CMD" == "start" ]] && echo "active" || echo "stopped")
          curl -s -X PATCH "$API_URL/api/sessions/$ID" -H "Content-Type: application/json" -d "{\"status\":\"$VAL\"}"
        else
          echo "Usage: ./ncg.sh session <id> [allow|deny|start|stop]"; exit 1
        fi
        ;;
    esac
    ;;
  allow)
    SESSION="${2:-}"; ROUTE="${3:-}"
    [[ -z "$SESSION" || -z "$ROUTE" ]] && { echo "Usage: ./ncg.sh allow <session_id|*> <route_name>"; exit 1; }
    SID="$SESSION"
    [[ "$SESSION" == "*" ]] && SID="%2A"
    curl -s -X POST "$API_URL/api/sessions/$SID/permissions" -H "Content-Type: application/json" -d "{\"route_name\":\"$ROUTE\"}"
    ;;
  deny)
    SESSION="${2:-}"; ROUTE="${3:-}"
    [[ -z "$SESSION" || -z "$ROUTE" ]] && { echo "Usage: ./ncg.sh deny <session_id|*> <route_name>"; exit 1; }
    ROUTES=$(curl -s "$API_URL/api/routes")
    ROUTE_ID=$(echo "$ROUTES" | python3 -c "import sys,json; r=[x for x in json.load(sys.stdin) if x.get('name')==sys.argv[1]]; print(r[0]['id'] if r else '')" "$ROUTE" 2>/dev/null)
    [[ -z "$ROUTE_ID" ]] && { echo "Route '$ROUTE' not found"; exit 1; }
    SID="$SESSION"
    [[ "$SESSION" == "*" ]] && SID="%2A"
    curl -s -X DELETE "$API_URL/api/sessions/$SID/permissions/$ROUTE_ID"
    ;;
  perms)
    SESSION="${2:-}"
    [[ -z "$SESSION" ]] && { echo "Usage: ./ncg.sh perms <session_id|*>"; exit 1; }
    SID="$SESSION"
    [[ "$SESSION" == "*" ]] && SID="%2A"
    curl -s "$API_URL/api/sessions/$SID/permissions" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/api/sessions/$SID/permissions"
    ;;
  injector)
    shift
    case "${1:-}" in
      add)
        NAME="${2:-}"; shift 2 || true
        ROUTE="" HEADER="" VALUE=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --route) ROUTE="$2"; shift 2 ;;
            --header) HEADER="$2"; shift 2 ;;
            --value) VALUE="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        [[ -z "$NAME" || -z "$ROUTE" || -z "$HEADER" || -z "$VALUE" ]] && {
          echo "Usage: ./ncg.sh injector add <name> --route <route_name> --header <header> --value <value>"
          exit 1
        }
        curl -s -X POST "$API_URL/api/injectors" -H "Content-Type: application/json" \
          -d "{\"name\":\"$NAME\",\"route_name\":\"$ROUTE\",\"inject_header\":\"$HEADER\",\"inject_value\":\"$VALUE\"}"
        ;;
      rm|delete)
        NAME="${2:-}"
        [[ -z "$NAME" ]] && { echo "Usage: ./ncg.sh injector rm <name>"; exit 1; }
        curl -s -X DELETE "$API_URL/api/injectors/$NAME"
        ;;
      ls|"")
        curl -s "$API_URL/api/injectors" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/api/injectors"
        ;;
      assign)
        INJ="${2:-}"; SESSION="${3:-}"
        [[ -z "$INJ" || -z "$SESSION" ]] && { echo "Usage: ./ncg.sh injector assign <injector_name> <session_id|*>"; exit 1; }
        SID="$SESSION"
        [[ "$SESSION" == "*" ]] && SID="*"
        curl -s -X POST "$API_URL/api/injectors/$INJ/assignments" -H "Content-Type: application/json" \
          -d "{\"session_id\":\"$SID\"}"
        ;;
      unassign)
        INJ="${2:-}"; SESSION="${3:-}"
        [[ -z "$INJ" || -z "$SESSION" ]] && { echo "Usage: ./ncg.sh injector unassign <injector_name> <session_id|*>"; exit 1; }
        SID="$SESSION"
        [[ "$SESSION" == "*" ]] && SID="%2A"
        curl -s -X DELETE "$API_URL/api/injectors/$INJ/assignments/$SID"
        ;;
      assignments)
        INJ="${2:-}"
        [[ -z "$INJ" ]] && { echo "Usage: ./ncg.sh injector assignments <injector_name>"; exit 1; }
        curl -s "$API_URL/api/injectors/$INJ/assignments" | python3 -m json.tool 2>/dev/null || curl -s "$API_URL/api/injectors/$INJ/assignments"
        ;;
      *) echo "Usage: ./ncg.sh injector add|rm|ls|assign|unassign|assignments"; exit 1 ;;
    esac
    ;;
  *)
    echo "Usage: ./ncg.sh <command> [args...]"
    echo "  build        Build proxy Docker image"
    echo "  build-test   Build test Docker image"
    echo "  build-worker Build worker Docker image"
    echo "  up           Start proxy container and network"
    echo "  down         Stop proxy and remove network"
    echo "  launch       Start worker: launch --name NAME [--mount path]"
    echo "  register     Register container as session: register CONTAINER"
    echo ""
    echo "  route add <name> reverse <path_prefix> <upstream_url>"
    echo "  route add <name> forward <domain_pattern>"
    echo "  route rm <name>"
    echo "  route ls"
    echo ""
    echo "  injector add <name> --route <route_name> --header <header> --value <value>"
    echo "  injector rm <name>"
    echo "  injector ls"
    echo "  injector assign <injector_name> <session_id|*>"
    echo "  injector unassign <injector_name> <session_id|*>"
    echo "  injector assignments <injector_name>"
    echo ""
    echo "  session add <name>"
    echo "  session ls"
    echo "  session <id> [allow|deny|start|stop]"
    echo ""
    echo "  allow <session_id|*> <route_name>    (bare access, no injection)"
    echo "  deny <session_id|*> <route_name>"
    echo "  perms <session_id|*>"
    exit 1
    ;;
esac
