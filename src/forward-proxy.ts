import { IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import type { Session } from './types.js';
import { findForwardRoutes } from './routes.js';
import { hasPermission, getInjectionForPermission } from './permissions.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleForwardProxy(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session | null,
): void {
  const targetUrl = new URL(req.url!);
  const hostname = targetUrl.hostname;
  const matchingRoutes = findForwardRoutes(hostname);
  const sessionId = session?.id ?? '*';

  if (matchingRoutes.length > 0) {
    const route = matchingRoutes[0];
    if (!hasPermission(sessionId, route.id)) {
      json(res, 403, {
        error: 'no_permission',
        route_name: route.name,
        message: 'Session lacks permission for this route',
      });
      return;
    }
  // TODO: replace this with a catch-all "allow" rule that can be toggled in the UI,
  // so the default forward proxy behavior is the last rule in the chain rather than hardcoded.
  } else if (session?.default_policy === 'deny') {
    json(res, 403, { error: 'policy_denied', message: 'No matching route and policy is deny' });
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: targetUrl.host,
      'content-length': body.length,
    };

    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];

    if (matchingRoutes.length > 0 && hasPermission(sessionId, matchingRoutes[0].id)) {
      const injection = getInjectionForPermission(sessionId, matchingRoutes[0].id);
      if (injection) {
        (headers as Record<string, string>)[injection.inject_header] = injection.inject_value;
      }
    }

    const isLocalhost =
      targetUrl.hostname === 'localhost' || targetUrl.hostname === '127.0.0.1';
    const isHttps = !isLocalhost;
    const makeRequest = isHttps ? httpsRequest : httpRequest;
    const port = targetUrl.port
      ? parseInt(targetUrl.port, 10)
      : isHttps
        ? 443
        : 80;

    const upstream = makeRequest(
      {
        hostname: targetUrl.hostname,
        port,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
      } as RequestOptions,
      (upRes) => {
        res.writeHead(upRes.statusCode!, upRes.headers);
        upRes.pipe(res);
      }
    );

    upstream.on('error', (err) => {
      console.error('Forward proxy upstream error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    upstream.write(body);
    upstream.end();
  });
}
