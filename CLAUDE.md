# (nano)clawgate

Transparent dual-mode HTTP proxy with credential injection for sandboxed Claude Code sessions.

## Managing Routes

Routes define how traffic is routed (no secrets — secrets live on injectors).

- **UI**: Open http://localhost:3100 for the admin dashboard.
- **API**: `POST /api/routes` with `{ name, type, domain_pattern?, path_prefix?, upstream_url? }`
- **Delete**: `DELETE /api/routes/:name`

## Managing Injectors

Injectors are named bundles of `{route, header, value}`. Assigning an injector to a session grants route access and injects the secret.

- **Create**: `POST /api/injectors { name, route_name, inject_header, inject_value }`
- **List**: `GET /api/injectors`
- **Delete**: `DELETE /api/injectors/:name`
- **Assign**: `POST /api/injectors/:name/assignments { session_id }` — grants route access + injection
- **Unassign**: `DELETE /api/injectors/:name/assignments/:sessionId`
- **List assignments**: `GET /api/injectors/:name/assignments`

## Managing Sessions

- **Create**: `POST /api/sessions { name }`
- **List**: `GET /api/sessions`
- **Update**: `PATCH /api/sessions/:id` with `{ container_id, container_name, container_ip, default_policy, status }`

## Managing Permissions

- **Grant (bare access, no injection)**: `POST /api/sessions/:id/permissions { route_name }`
- **Global**: `POST /api/sessions/%2A/permissions { route_name }` (use `%2A` for `*`)
- **Revoke**: `DELETE /api/sessions/:id/permissions/:routeId`
- **Migrate**: `POST /api/sessions/:toId/migrate-from/:fromId`

## CLI

- `./ncg.sh build` — Build proxy image
- `./ncg.sh up` / `down` — Start/stop proxy
- `./ncg.sh launch --name NAME [--mount PATH]` — Start interactive worker container
- `./ncg.sh register CONTAINER` — Register a running container as a session

**Routes:** `route add <name> reverse <path_prefix> <upstream_url>` | `route add <name> forward <domain_pattern>` | `route rm <name>` | `route ls`

**Injectors:** `injector add <name> --route <route_name> --header <header> --value <value>` | `injector rm <name>` | `injector ls` | `injector assign <name> <session_id|*>` | `injector unassign <name> <session_id|*>` | `injector assignments <name>`

**Sessions:** `session add <name>` | `session ls` | `session <id>` | `session <id> allow|deny|start|stop`

**Permissions:** `allow <session_id|*> <route_name>` | `deny <session_id|*> <route_name>` | `perms <session_id|*>`

## Agent-facing

For agents running inside (nano)clawgate containers, see [developer/permissions.md](developer/permissions.md).
