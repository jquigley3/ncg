import crypto from 'crypto';
import { getDb, nextAvailablePort } from './db.js';
import { Route } from './types.js';

export interface CreateRouteInput {
  name: string;
  type: 'forward' | 'reverse' | 'port';
  domain_pattern?: string;
  path_prefix?: string;
  upstream_url?: string;
  port?: number;
  description?: string;
}

export function createRoute(input: CreateRouteInput): string {
  if (input.type !== 'forward' && input.type !== 'reverse' && input.type !== 'port') {
    throw new Error('type must be forward, reverse, or port');
  }
  if (input.type === 'forward') {
    if (!input.domain_pattern) {
      throw new Error('domain_pattern is required for forward routes');
    }
    try {
      new RegExp(input.domain_pattern);
    } catch {
      throw new Error('domain_pattern must be a valid regex');
    }
  }

  if (input.type === 'reverse') {
    if (!input.path_prefix || !input.path_prefix.startsWith('/')) {
      throw new Error('path_prefix is required and must start with /');
    }
    if (!input.upstream_url) {
      throw new Error('upstream_url is required for reverse routes');
    }
    try {
      new URL(input.upstream_url);
    } catch {
      throw new Error('upstream_url must be a valid URL');
    }
  }

  if (input.type === 'port') {
    if (!input.upstream_url) {
      throw new Error('upstream_url is required for port routes');
    }
    try {
      new URL(input.upstream_url);
    } catch {
      throw new Error('upstream_url must be a valid URL');
    }
    if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
      throw new Error('port must be an integer between 1 and 65535');
    }
  }

  const assignedPort = input.type === 'port'
    ? (input.port ?? nextAvailablePort())
    : null;

  const id = crypto.randomUUID();
  const db = getDb();
  try {
    db.prepare(
      `INSERT INTO routes (id, name, type, domain_pattern, path_prefix, upstream_url, port, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.name,
      input.type,
      input.type === 'forward' ? input.domain_pattern : null,
      input.type === 'reverse' ? input.path_prefix : null,
      input.type !== 'forward' ? input.upstream_url : null,
      assignedPort,
      input.description ?? null,
    );
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const msg = (err as { message?: string }).message ?? '';
      if (msg.includes('routes.port')) {
        throw new Error(`Port ${assignedPort} is already in use`);
      }
      throw new Error(`Route with name "${input.name}" already exists`);
    }
    throw err;
  }
  return id;
}

export function getRoute(id: string): Route | undefined {
  const row = getDb().prepare('SELECT * FROM routes WHERE id = ?').get(id);
  return row as Route | undefined;
}

export function getRouteByName(name: string): Route | undefined {
  const row = getDb().prepare('SELECT * FROM routes WHERE name = ?').get(name);
  return row as Route | undefined;
}

export function listRoutes(type?: string): Route[] {
  const db = getDb();
  if (type) {
    return db.prepare('SELECT * FROM routes WHERE type = ? ORDER BY name').all(type) as Route[];
  }
  return db.prepare('SELECT * FROM routes ORDER BY name').all() as Route[];
}

export interface UpdateRouteInput {
  domain_pattern?: string;
  path_prefix?: string;
  upstream_url?: string;
  description?: string;
}

export function updateRoute(nameOrId: string, input: UpdateRouteInput): boolean {
  const route = getRouteByName(nameOrId) ?? getRoute(nameOrId);
  if (!route) return false;
  const db = getDb();
  if (input.domain_pattern !== undefined && route.type === 'forward') {
    try { new RegExp(input.domain_pattern); } catch { throw new Error('domain_pattern must be a valid regex'); }
    db.prepare('UPDATE routes SET domain_pattern = ? WHERE id = ?').run(input.domain_pattern, route.id);
  }
  if (input.path_prefix !== undefined && route.type === 'reverse') {
    if (!input.path_prefix.startsWith('/')) throw new Error('path_prefix must start with /');
    db.prepare('UPDATE routes SET path_prefix = ? WHERE id = ?').run(input.path_prefix, route.id);
  }
  if (input.upstream_url !== undefined && route.type === 'reverse') {
    try { new URL(input.upstream_url); } catch { throw new Error('upstream_url must be a valid URL'); }
    db.prepare('UPDATE routes SET upstream_url = ? WHERE id = ?').run(input.upstream_url, route.id);
  }
  if (input.description !== undefined) {
    db.prepare('UPDATE routes SET description = ? WHERE id = ?').run(input.description || null, route.id);
  }
  return true;
}

export function deleteRoute(nameOrId: string): boolean {
  const db = getDb();
  const route = getRouteByName(nameOrId) ?? getRoute(nameOrId);
  if (!route) return false;
  db.prepare('DELETE FROM permissions WHERE route_id = ?').run(route.id);
  db.prepare('DELETE FROM injectors WHERE route_id = ?').run(route.id);
  db.prepare('DELETE FROM routes WHERE id = ?').run(route.id);
  return true;
}

export function findForwardRoutes(hostname: string): Route[] {
  const routes = getDb()
    .prepare("SELECT * FROM routes WHERE type = 'forward'")
    .all() as Route[];
  return routes.filter((r) => {
    if (!r.domain_pattern) return false;
    try {
      return new RegExp(r.domain_pattern).test(hostname);
    } catch {
      return false;
    }
  });
}
