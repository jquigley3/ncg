import crypto from 'crypto';
import { getDb } from './db.js';
import type { Permission } from './types.js';

export function grantPermission(sessionId: string, routeId: string, injectorId?: string): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO permissions (id, session_id, route_id, injector_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, route_id) DO UPDATE SET injector_id = excluded.injector_id`
    )
    .run(id, sessionId, routeId, injectorId ?? null);
  return id;
}

export function revokePermission(sessionId: string, routeId: string): void {
  getDb()
    .prepare('DELETE FROM permissions WHERE session_id = ? AND route_id = ?')
    .run(sessionId, routeId);
}

export function getSessionPermissions(
  sessionId: string
): Array<Permission & { route_name: string; injector_name: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT p.*, r.name as route_name, i.name as injector_name
       FROM permissions p
       JOIN routes r ON p.route_id = r.id
       LEFT JOIN injectors i ON p.injector_id = i.id
       WHERE p.session_id = ?
       ORDER BY r.name`
    )
    .all(sessionId) as Array<Permission & { route_name: string; injector_name: string | null }>;
  return rows;
}

export function hasPermission(sessionId: string, routeId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM permissions
       WHERE route_id = ? AND (session_id = ? OR session_id = '*')
       LIMIT 1`
    )
    .get(routeId, sessionId);
  return !!row;
}

/**
 * Returns injection details for a given session+route, preferring the session-specific
 * permission over the global ('*') one.
 */
export function getInjectionForPermission(
  sessionId: string,
  routeId: string
): { inject_header: string; inject_value: string } | null {
  const row = getDb()
    .prepare(
      `SELECT i.inject_header, i.inject_value
       FROM permissions p
       JOIN injectors i ON p.injector_id = i.id
       WHERE p.route_id = ? AND (p.session_id = ? OR p.session_id = '*')
       ORDER BY CASE WHEN p.session_id = '*' THEN 1 ELSE 0 END
       LIMIT 1`
    )
    .get(routeId, sessionId) as { inject_header: string; inject_value: string } | undefined;
  return row ?? null;
}

export function migratePermissions(
  fromSessionId: string,
  toSessionId: string
): number {
  const fromPerms = getDb()
    .prepare('SELECT route_id, injector_id FROM permissions WHERE session_id = ?')
    .all(fromSessionId) as Array<{ route_id: string; injector_id: string | null }>;
  let count = 0;
  for (const { route_id, injector_id } of fromPerms) {
    try {
      grantPermission(toSessionId, route_id, injector_id ?? undefined);
      count++;
    } catch {
      /* skip duplicate */
    }
  }
  return count;
}
