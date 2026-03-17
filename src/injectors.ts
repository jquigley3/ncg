import crypto from 'crypto';
import { getDb } from './db.js';
import type { Injector } from './types.js';

export interface CreateInjectorInput {
  name: string;
  route_id: string;
  inject_header: string;
  inject_value: string;
  description?: string;
}

export function createInjector(input: CreateInjectorInput): string {
  if (!input.name) throw new Error('name is required');
  if (!input.route_id) throw new Error('route_id is required');
  if (!input.inject_header) throw new Error('inject_header is required');
  if (!input.inject_value) throw new Error('inject_value is required');

  const db = getDb();
  const route = db.prepare('SELECT id FROM routes WHERE id = ?').get(input.route_id);
  if (!route) throw new Error('Route not found');

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO injectors (id, name, route_id, inject_header, inject_value, description)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.name, input.route_id, input.inject_header, input.inject_value, input.description ?? null);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error(`Injector with name "${input.name}" already exists`);
    }
    throw err;
  }
  return id;
}

export function getInjector(id: string): Injector | undefined {
  return getDb().prepare('SELECT * FROM injectors WHERE id = ?').get(id) as Injector | undefined;
}

export function getInjectorByName(name: string): Injector | undefined {
  return getDb().prepare('SELECT * FROM injectors WHERE name = ?').get(name) as Injector | undefined;
}

export function listInjectors(): Array<Injector & { route_name: string }> {
  return getDb().prepare(
    `SELECT i.*, r.name as route_name
     FROM injectors i
     JOIN routes r ON i.route_id = r.id
     ORDER BY i.name`
  ).all() as Array<Injector & { route_name: string }>;
}

export interface UpdateInjectorInput {
  inject_header?: string;
  inject_value?: string;
  description?: string;
}

export function updateInjector(nameOrId: string, input: UpdateInjectorInput): boolean {
  const injector = getInjectorByName(nameOrId) ?? getInjector(nameOrId);
  if (!injector) return false;
  const db = getDb();
  if (input.inject_header !== undefined) {
    db.prepare('UPDATE injectors SET inject_header = ? WHERE id = ?').run(input.inject_header, injector.id);
  }
  if (input.inject_value !== undefined) {
    db.prepare('UPDATE injectors SET inject_value = ? WHERE id = ?').run(input.inject_value, injector.id);
  }
  if (input.description !== undefined) {
    db.prepare('UPDATE injectors SET description = ? WHERE id = ?').run(input.description, injector.id);
  }
  return true;
}

export function deleteInjector(nameOrId: string): boolean {
  const db = getDb();
  const injector = getInjectorByName(nameOrId) ?? getInjector(nameOrId);
  if (!injector) return false;
  db.prepare('DELETE FROM permissions WHERE injector_id = ?').run(injector.id);
  db.prepare('DELETE FROM injectors WHERE id = ?').run(injector.id);
  return true;
}

/**
 * Assign an injector to a session — grants route access and sets the injection.
 * Upserts: if the session already has a permission for this route, the injector is updated.
 */
export function assignInjector(injectorNameOrId: string, sessionId: string): string {
  const db = getDb();
  const injector = getInjectorByName(injectorNameOrId) ?? getInjector(injectorNameOrId);
  if (!injector) throw new Error('Injector not found');

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO permissions (id, session_id, route_id, injector_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, route_id) DO UPDATE SET injector_id = excluded.injector_id`
  ).run(id, sessionId, injector.route_id, injector.id);
  return id;
}

/**
 * Unassign an injector from a session — revokes the permission entirely.
 */
export function unassignInjector(injectorNameOrId: string, sessionId: string): boolean {
  const db = getDb();
  const injector = getInjectorByName(injectorNameOrId) ?? getInjector(injectorNameOrId);
  if (!injector) throw new Error('Injector not found');

  const result = db.prepare(
    'DELETE FROM permissions WHERE session_id = ? AND route_id = ? AND injector_id = ?'
  ).run(sessionId, injector.route_id, injector.id);
  return result.changes > 0;
}

/**
 * List sessions assigned to an injector.
 */
export function getInjectorAssignments(injectorNameOrId: string): Array<{ session_id: string; session_name: string; granted_at: string }> {
  const db = getDb();
  const injector = getInjectorByName(injectorNameOrId) ?? getInjector(injectorNameOrId);
  if (!injector) throw new Error('Injector not found');

  return db.prepare(
    `SELECT p.session_id, COALESCE(s.name, p.session_id) as session_name, p.granted_at
     FROM permissions p
     LEFT JOIN sessions s ON p.session_id = s.id
     WHERE p.injector_id = ?
     ORDER BY p.granted_at`
  ).all(injector.id) as Array<{ session_id: string; session_name: string; granted_at: string }>;
}
