import { createServer, IncomingMessage, ServerResponse, Server, request as httpRequest, RequestOptions } from 'http';
import { request as httpsRequest } from 'https';
import { ensureDefaultRoutes } from './bootstrap.js';
import { initDb } from './db.js';
import { handleForwardProxy } from './forward-proxy.js';
import { findReverseRoute, handleReverseProxy } from './reverse-proxy.js';
import { hasPermission, getInjectionForPermission } from './permissions.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  createRoute,
  listRoutes,
  deleteRoute,
  updateRoute,
  getRouteByName,
  getRoute,
} from './routes.js';
import {
  grantPermission,
  revokePermission,
  getSessionPermissions,
  migratePermissions,
} from './permissions.js';
import {
  createSession,
  getSession,
  getSessionByIp,
  listSessions,
  updateSession,
} from './sessions.js';
import {
  createInjector,
  getInjectorByName,
  listInjectors,
  deleteInjector,
  updateInjector,
  assignInjector,
  unassignInjector,
  getInjectorAssignments,
} from './injectors.js';
import { emit, subscribe } from './events.js';
import type { Session } from './types.js';

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

async function handleApiRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  const parsed = new URL(url, `http://localhost`);
  const pathname = parsed.pathname;
  const pathParts = pathname.slice('/api'.length).split('/').filter(Boolean);

  if (pathParts[0] === 'sessions') {
    const sessionId = pathParts[1];
    if (req.method === 'GET' && !sessionId) {
      const status = parsed.searchParams.get('status') ?? undefined;
      const sessions = listSessions(status);
      json(res, 200, sessions);
      return;
    }
    if (req.method === 'POST' && !sessionId) {
      const body = JSON.parse(await readBody(req));
      const name = body.name ?? 'unnamed';
      const session = createSession(name);
      emit('sessions:changed');
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: session.id, name: session.name }));
      return;
    }
    if (sessionId && sessionId !== '*') {
      if (req.method === 'GET' && pathParts[2] !== 'permissions' && pathParts[2] !== 'migrate-from') {
        const session = getSession(sessionId);
        if (!session) {
          json(res, 404, { error: 'Session not found' });
          return;
        }
        json(res, 200, session);
        return;
      }
      if (req.method === 'PATCH' && pathParts[2] !== 'permissions') {
        const session = getSession(sessionId);
        if (!session) {
          json(res, 404, { error: 'Session not found' });
          return;
        }
        const raw = await readBody(req);
        const body =
          req.headers['content-type']?.includes('application/json')
            ? JSON.parse(raw)
            : Object.fromEntries(new URLSearchParams(raw));
        updateSession(sessionId, body);
        emit('sessions:changed');
        if (req.headers['hx-request']) {
          res.writeHead(200, { 'HX-Refresh': 'true' });
          res.end();
        } else {
          json(res, 200, { ok: true });
        }
        return;
      }
    }

    if (pathParts[0] === 'sessions' && pathParts[2] === 'permissions') {
      const permSessionId = pathParts[1];
      const routeId = pathParts[3];
      if (req.method === 'GET') {
        const perms = getSessionPermissions(permSessionId);
        json(res, 200, perms);
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const routeName = body.route_name;
        if (!routeName) {
          json(res, 400, { error: 'route_name required' });
          return;
        }
        const route = getRouteByName(routeName);
        if (!route) {
          json(res, 404, { error: 'Route not found' });
          return;
        }
        try {
          const id = grantPermission(permSessionId, route.id);
          emit('permissions:changed');
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, route_id: route.id }));
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
            json(res, 409, { error: 'Permission already granted' });
          } else {
            throw err;
          }
        }
        return;
      }
      if (req.method === 'DELETE' && routeId) {
        revokePermission(permSessionId, routeId);
        emit('permissions:changed');
        json(res, 200, { ok: true });
        return;
      }
    }

    if (pathParts[0] === 'sessions' && pathParts[2] === 'migrate-from') {
      const toSessionId = pathParts[1];
      const fromSessionId = pathParts[3];
      if (req.method === 'POST' && fromSessionId) {
        const session = getSession(toSessionId);
        if (!session) {
          json(res, 404, { error: 'Target session not found' });
          return;
        }
        const fromSession = getSession(fromSessionId);
        if (!fromSession) {
          json(res, 404, { error: 'Source session not found' });
          return;
        }
        const count = migratePermissions(fromSessionId, toSessionId);
        emit('permissions:changed');
        json(res, 200, { ok: true, migrated: count });
        return;
      }
    }
  }

  if (pathParts[0] === 'injectors') {
    const injectorName = pathParts[1] ? decodeURIComponent(pathParts[1]) : undefined;

    if (req.method === 'GET' && !injectorName) {
      json(res, 200, listInjectors());
      return;
    }

    if (req.method === 'POST' && !injectorName) {
      const body = JSON.parse(await readBody(req));
      const routeName = body.route_name;
      if (!routeName) {
        json(res, 400, { error: 'route_name is required' });
        return;
      }
      const route = getRouteByName(routeName);
      if (!route) {
        json(res, 404, { error: 'Route not found' });
        return;
      }
      try {
        const id = createInjector({
          name: body.name,
          route_id: route.id,
          inject_header: body.inject_header,
          inject_value: body.inject_value,
          description: body.description,
        });
        emit('injectors:changed');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, name: body.name }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already exists')) {
          json(res, 409, { error: msg });
        } else if (msg.includes('required') || msg.includes('not found')) {
          json(res, 400, { error: msg });
        } else {
          throw err;
        }
      }
      return;
    }

    if (injectorName && req.method === 'GET' && !pathParts[2]) {
      const injector = getInjectorByName(injectorName);
      if (!injector) {
        json(res, 404, { error: 'Injector not found' });
        return;
      }
      json(res, 200, injector);
      return;
    }

    if (injectorName && req.method === 'PATCH' && !pathParts[2]) {
      const injector = getInjectorByName(injectorName);
      if (!injector) {
        json(res, 404, { error: 'Injector not found' });
        return;
      }
      const body = JSON.parse(await readBody(req));
      const ok = updateInjector(injectorName, {
        inject_header: body.inject_header,
        inject_value: body.inject_value,
        description: body.description,
      });
      if (ok) {
        emit('injectors:changed');
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: 'Injector not found' });
      }
      return;
    }

    if (injectorName && req.method === 'DELETE' && !pathParts[2]) {
      const ok = deleteInjector(injectorName);
      if (ok) {
        emit('injectors:changed');
        emit('permissions:changed');
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: 'Injector not found' });
      }
      return;
    }

    if (injectorName && pathParts[2] === 'assignments') {
      if (req.method === 'GET') {
        try {
          json(res, 200, getInjectorAssignments(injectorName));
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : 'Not found' });
        }
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const sessionId = body.session_id;
        if (!sessionId) {
          json(res, 400, { error: 'session_id is required' });
          return;
        }
        try {
          const id = assignInjector(injectorName, sessionId);
          emit('permissions:changed');
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, ok: true }));
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : 'Not found' });
        }
        return;
      }
      if (req.method === 'DELETE' && pathParts[3]) {
        const sessionId = decodeURIComponent(pathParts[3]);
        try {
          const ok = unassignInjector(injectorName, sessionId);
          if (ok) emit('permissions:changed');
          json(res, 200, { ok });
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : 'Not found' });
        }
        return;
      }
    }
  }

  if (pathParts[0] === 'routes') {
    if (req.method === 'GET') {
      const type = parsed.searchParams.get('type') ?? undefined;
      const routes = listRoutes(type);
      json(res, 200, routes);
      return;
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        const id = createRoute(body);
        const route = listRoutes().find((r) => r.id === id);
        if (route?.type === 'port' && route.port !== null) {
          bindPortRoute(id, route.port);
        }
        emit('routes:changed');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, name: route?.name ?? body.name, port: route?.port ?? undefined }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already exists')) {
          json(res, 409, { error: msg });
        } else if (msg.includes('required') || msg.includes('valid') || msg.includes('must')) {
          json(res, 400, { error: msg });
        } else {
          throw err;
        }
      }
      return;
    }
    if (req.method === 'PATCH' && pathParts[1]) {
      const name = pathParts[1];
      const body = JSON.parse(await readBody(req));
      try {
        const ok = updateRoute(name, body);
        if (ok) {
          emit('routes:changed');
          json(res, 200, { ok: true });
        } else {
          json(res, 404, { error: 'Route not found' });
        }
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (req.method === 'DELETE' && pathParts[1]) {
      const name = pathParts[1];
      const existing = getRouteByName(name);
      const ok = deleteRoute(name);
      if (ok) {
        if (existing?.type === 'port' && existing.port !== null) {
          unbindPortRoute(existing.port);
        }
        emit('routes:changed');
        emit('injectors:changed');
        emit('permissions:changed');
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: 'Route not found' });
      }
      return;
    }
  }

  json(res, 404, { error: 'Unknown API endpoint' });
}

function handleSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const unsub = subscribe((event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      unsub();
    }
  });
  req.on('close', () => unsub());
}

function identifySession(req: IncomingMessage): Session | null {
  const ip = req.socket.remoteAddress;
  if (!ip) return null;
  return getSessionByIp(ip) ?? null;
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url || '/';

  // CONNECT (HTTPS tunneling) is not supported - credential injection requires HTTP reverse proxy.
  // Claude must use ANTHROPIC_BASE_URL=http://ncg-proxy:3100/anthropic, not HTTP_PROXY.
  if (req.method === 'CONNECT') {
    req.resume(); // drain the request body
    res.writeHead(503, {
      'content-type': 'application/json',
      'proxy-connection': 'close',
    });
    res.end(
      JSON.stringify({
        error: 'connect_not_supported',
        message:
          'This proxy does not support CONNECT (HTTPS tunneling). Use ANTHROPIC_BASE_URL=http://ncg-proxy:3100/anthropic instead of HTTP_PROXY for Claude API. Unset HTTP_PROXY/HTTPS_PROXY or ensure NO_PROXY=ncg-proxy.',
      }),
    );
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (url.startsWith('/api/')) {
    const pathname = url.split('?')[0];
    if (req.method === 'GET' && pathname === '/api/events') {
      handleSse(req, res);
      return;
    }
    void handleApiRoute(req, res);
    return;
  }

  if (req.method === 'GET' && url === '/') {
    json(res, 200, { error: 'Use /api/ endpoints or the ncg-monitor CLI tool' });
    return;
  }

  if (url.startsWith('http://')) {
    const session = identifySession(req);
    handleForwardProxy(req, res, session);
    return;
  }

  const reverseRoute = findReverseRoute(url);
  if (reverseRoute) {
    const session = identifySession(req);
    handleReverseProxy(req, res, reverseRoute, session);
    return;
  }

  json(res, 404, { error: 'No matching route' });
}

function handleCredentialProxy(req: IncomingMessage, res: ServerResponse): void {
  const upstreamUrl = new URL(process.env.UPSTREAM_ANTHROPIC_URL || 'https://api.anthropic.com');
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: upstreamUrl.host,
      'content-length': body.length,
    };
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    if (apiKey) {
      delete headers['x-api-key'];
      headers['x-api-key'] = apiKey;
    }

    const upstream = makeRequest(
      {
        hostname: upstreamUrl.hostname,
        port: parseInt(upstreamUrl.port, 10) || (isHttps ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      } as RequestOptions,
      (upRes) => {
        res.writeHead(upRes.statusCode!, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      console.error('Credential proxy upstream error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });
    upstream.write(body);
    upstream.end();
  });
}

// ── Port-per-service servers ──────────────────────────────────────────────────

let bindHost = '0.0.0.0';
const portServers = new Map<number, Server>();

function handlePortRequest(req: IncomingMessage, res: ServerResponse, routeId: string): void {
  const session = identifySession(req);
  const sessionId = session?.id ?? '*';

  if (!hasPermission(sessionId, routeId)) {
    json(res, 403, {
      error: 'no_permission',
      message: 'Session lacks permission for this route',
    });
    return;
  }

  // Look up route
  const route = getRoute(routeId);
  if (!route || !route.upstream_url) {
    json(res, 500, { error: 'route_not_found' });
    return;
  }

  const upstreamBase = new URL(route.upstream_url);
  const isHttps = upstreamBase.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: upstreamBase.host,
      'content-length': body.length,
    };
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    const injection = getInjectionForPermission(sessionId, routeId);
    if (injection) {
      (headers as Record<string, string>)[injection.inject_header] = injection.inject_value;
    }

    const upstreamPort = upstreamBase.port
      ? parseInt(upstreamBase.port, 10)
      : isHttps ? 443 : 80;

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const agent = (isHttps && proxyUrl) ? new HttpsProxyAgent(proxyUrl) : undefined;

    const upstream = makeRequest(
      {
        hostname: upstreamBase.hostname,
        port: upstreamPort,
        path: req.url || '/',
        method: req.method,
        headers,
        ...(agent ? { agent } : {}),
      } as RequestOptions,
      (upRes) => {
        res.writeHead(upRes.statusCode!, upRes.headers);
        upRes.pipe(res);
      }
    );

    upstream.on('error', (err) => {
      console.error(`Port proxy upstream error (route ${routeId}):`, err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  });
}

export function bindPortRoute(routeId: string, port: number): void {
  if (portServers.has(port)) return; // already bound
  const server = createServer((req, res) => handlePortRequest(req, res, routeId));
  server.listen(port, bindHost, () => {
    console.log(`Port route :${port} → route ${routeId} listening`);
  });
  server.on('error', (err) => {
    console.error(`Port server :${port} error:`, err.message);
    portServers.delete(port);
  });
  portServers.set(port, server);
}

export function unbindPortRoute(port: number): void {
  const server = portServers.get(port);
  if (!server) return;
  server.close(() => console.log(`Port route :${port} closed`));
  portServers.delete(port);
}

export function startServer(port: number, host: string): Promise<{ admin: Server; credential: Server }> {
  bindHost = host;
  initDb();
  ensureDefaultRoutes();

  // Restore any port routes that were persisted before restart
  for (const route of listRoutes('port')) {
    if (route.port !== null) {
      bindPortRoute(route.id, route.port);
    }
  }

  const credPort = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);

  return new Promise((resolve) => {
    const credential = createServer(handleCredentialProxy);
    credential.listen(credPort, host, () => {
      const credAddr = credential.address() as { port: number };
      console.log(`Credential proxy (anthropic) listening on ${host}:${credAddr.port}`);

      const admin = createServer(handleRequest);
      admin.listen(port, host, () => {
        const addr = admin.address() as { port: number };
        console.log(`Admin/forward proxy listening on ${host}:${addr.port}`);
        resolve({ admin, credential });
      });
    });
  });
}

const isMain =
  process.argv[1]?.endsWith('server.js') ||
  process.argv[1]?.endsWith('server.ts');
if (isMain) {
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (kept running):', err);
  });
  const PORT = parseInt(process.env.PORT || '3100', 10);
  const HOST = process.env.HOST || '0.0.0.0';
  startServer(PORT, HOST);
}

