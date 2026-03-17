# Permissions (Agent-facing)

This document is for agents running inside (nano)clawgate worker containers.

## How It Works

All HTTP traffic from your container goes through the (nano)clawgate proxy. You do not handle secrets. The proxy injects credentials based on route permissions.

- **Forward proxy**: `HTTP_PROXY` and `http_proxy` are set. Requests with absolute URLs (e.g. `curl http://api.github.com/...`) go through the proxy.
- **Reverse proxy**: `ANTHROPIC_BASE_URL` points at the proxy. Anthropic SDK requests use relative paths and go through the proxy.

## 403 Responses

If a request returns 403:

- `no_permission` — Your session lacks permission for the matching route. Ask the user to grant the route in the admin UI.
- `policy_denied` — No route matches and the session policy is `deny`. Ask the user to add a route or change the policy to `allow`.

## What You Should Not Do

- Do not expect to receive or use API keys directly. The proxy injects them.
- Do not assume all URLs are allowed. Unmatched URLs may be blocked by policy.
