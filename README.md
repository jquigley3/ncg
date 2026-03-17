# ncg · nanoClawGate

Transparent dual-mode HTTP proxy with credential injection for sandboxed Claude Code sessions.

## What it does

ncg sits between Claude Code session containers and `api.anthropic.com`. It identifies sessions by source IP, injects the right credentials per session, and proxies all traffic transparently. No secrets are ever passed into containers — credentials live only in the proxy.

## Architecture

```
Claude Code container  →  ncg :3100/anthropic  →  api.anthropic.com
                       →  ncg :3100/...         →  any upstream route

Orchestrator           →  ncg :3100/api/...     →  admin API
```

ncg runs two listeners on the same port:

- **Admin API** (`/api/...`) — session and injector management for the orchestrator
- **Reverse proxy** (path-prefix routing) — receives plain HTTP from containers, injects credentials, forwards to upstream over HTTPS

A separate **credential proxy** listens on port 3001 for single-key scenarios where per-session injection is not needed.

Workers run on a Docker `--internal` network. They cannot reach the internet directly. ncg is dual-homed (internal + default bridge) and forwards traffic to configured upstreams, optionally through `HTTPS_PROXY`.

## Features

- Per-session credential injection keyed by source IP
- Named injectors: map any HTTP header/value pair onto any route
- Session lifecycle management via REST API
- Transparent reverse proxy — Claude Code only needs `ANTHROPIC_BASE_URL` pointed at ncg
- Hot-reload: update credentials with `PATCH /api/injectors/:name` without restarting sessions
- Forward proxy mode for non-API HTTP traffic (npm, curl, etc.)
- SSE event stream (`/api/events`) for real-time admin UI updates
- SQLite-backed state via `better-sqlite3`

## API Reference

All endpoints are on the admin server (default `:3100`).

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{"ok":true}` |

### Sessions

| Method | Path | Body / Notes |
|--------|------|--------------|
| POST | `/api/sessions` | `{"name":"..."}` — create session, returns `{id, name}` |
| GET | `/api/sessions` | List all sessions. Optional `?status=` filter |
| GET | `/api/sessions/:id` | Get session by ID |
| PATCH | `/api/sessions/:id` | Update `container_id`, `container_name`, `container_ip`, `default_policy`, `status` |
| DELETE | `/api/sessions/:id` | Delete session |

### Injectors

Injectors are named credential bundles: `{route, header, value}`. Assigning an injector to a session grants route access and enables injection for that session.

| Method | Path | Body / Notes |
|--------|------|--------------|
| POST | `/api/injectors` | `{"name","route_name","inject_header","inject_value","description?"}` |
| GET | `/api/injectors` | List all injectors (includes `route_name`) |
| GET | `/api/injectors/:name` | Get injector by name |
| PATCH | `/api/injectors/:name` | Update `inject_header`, `inject_value`, `description` |
| DELETE | `/api/injectors/:name` | Delete injector and all its assignments |
| POST | `/api/injectors/:name/assignments` | `{"session_id":"..."}` — assign to session (`"*"` for global) |
| GET | `/api/injectors/:name/assignments` | List sessions assigned to this injector |
| DELETE | `/api/injectors/:name/assignments/:sessionId` | Unassign |

### Routes

| Method | Path | Body / Notes |
|--------|------|--------------|
| GET | `/api/routes` | List routes. Optional `?type=reverse\|forward` filter |
| POST | `/api/routes` | `{"name","type":"reverse\|forward","path_prefix?","upstream_url?","domain_pattern?"}` |
| PATCH | `/api/routes/:name` | Update route fields |
| DELETE | `/api/routes/:name` | Delete route (also removes injectors and permissions) |

### Permissions

Bare permissions (route access without injection):

| Method | Path | Body / Notes |
|--------|------|--------------|
| GET | `/api/sessions/:id/permissions` | List permissions for session |
| POST | `/api/sessions/:id/permissions` | `{"route_name":"..."}` — grant access |
| DELETE | `/api/sessions/:id/permissions/:routeId` | Revoke |
| POST | `/api/sessions/:toId/migrate-from/:fromId` | Copy all permissions from one session to another |

Use `%2A` in place of `*` for global session (`session_id = '*'`).

### Events

`GET /api/events` — Server-sent events stream. Emits `sessions:changed`, `injectors:changed`, `permissions:changed`, `routes:changed` on state mutations.

## Quick Start

### Standalone

```bash
docker build -t ncg .
docker run -p 3100:3100 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v ncg-data:/app/data \
  ncg
```

On startup ncg auto-creates an `anthropic` reverse route (`/anthropic` → `https://api.anthropic.com`) and an `anthropic-default` injector using `ANTHROPIC_API_KEY`. Any session with access to that route will have the key injected automatically.

Point Claude Code at the proxy:

```bash
ANTHROPIC_BASE_URL=http://ncg-proxy:3100/anthropic claude
```

### With the clawback orchestrator

ncg is designed to be the credential proxy in the [clawback](https://github.com/[placeholder]/clawback) orchestration stack. See that repo for the full `docker-compose` setup and `sandbox.sh` CLI.

### Local dev

```bash
./ncg.sh build    # build proxy image
./ncg.sh up       # start proxy (reads ANTHROPIC_API_KEY from env)
./ncg.sh launch --name my-session --mount ./my-project
./ncg.sh register my-session   # register container as a session
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Admin + reverse proxy listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `CREDENTIAL_PROXY_PORT` | `3001` | Simple single-key credential proxy port |
| `ANTHROPIC_API_KEY` | — | Injected into the auto-created `anthropic` route |
| `UPSTREAM_ANTHROPIC_URL` | `https://api.anthropic.com` | Upstream for the credential proxy (port 3001) |
| `HTTPS_PROXY` / `HTTP_PROXY` | — | Outbound proxy for upstream requests |
| `DB_PATH` | `./data/ncg.db` | SQLite database path |

> **Note:** The Docker image references `docker-sandbox-ca.pem` (a local CA certificate for the sandbox proxy environment). For standalone use, remove or replace that `COPY` line in the Dockerfile with your own CA cert, or omit it entirely if you do not need a custom CA.

## Development

```bash
npm install
npm run build      # tsc compile
npm run dev        # run with tsx (no compile step)
npm test           # unit + integration tests
npm run monitor    # CLI monitor tool
```

Requires Node ≥ 22.

## License

MIT
