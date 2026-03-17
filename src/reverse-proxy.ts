import { IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getDb } from './db.js';
import { Route, Session } from './types.js';
import { hasPermission, getInjectionForPermission } from './permissions.js';
import { recordTrafficObservation } from './traffic.js';

export function findReverseRoute(path: string): Route | null {
  const routes = getDb().prepare(
    "SELECT * FROM routes WHERE type = 'reverse' ORDER BY length(path_prefix) DESC, created_at DESC"
  ).all() as Route[];
  for (const route of routes) {
    if (route.path_prefix && path.startsWith(route.path_prefix)) return route;
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleReverseProxy(
  req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  session: Session | null,
): void {
  const sessionId = session?.id ?? '*';
  if (!hasPermission(sessionId, route.id)) {
    json(res, 403, {
      error: 'no_permission',
      route_name: route.name,
      message: 'Session lacks permission for this route',
    });
    return;
  }

  const upstreamBase = new URL(route.upstream_url!);
  const strippedPath = req.url!.slice(route.path_prefix!.length) || '/';
  const isHttps = upstreamBase.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (session) {
      const bodyStr = body.toString();
      recordTrafficObservation(session.id, req.headers as Record<string, string | string[] | undefined>, bodyStr);
    }
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: upstreamBase.host,
      'content-length': body.length,
    };

    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    const injection = getInjectionForPermission(sessionId, route.id);
    if (injection) {
      (headers as Record<string, string>)[injection.inject_header] = injection.inject_value;
    }

    const port = upstreamBase.port
      ? parseInt(upstreamBase.port, 10)
      : isHttps
        ? 443
        : 80;

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const agent = (isHttps && proxyUrl) ? new HttpsProxyAgent(proxyUrl) : undefined;

    const upstream = makeRequest(
      {
        hostname: upstreamBase.hostname,
        port,
        path: strippedPath,
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
      console.error('Reverse proxy upstream error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  });
}
