import crypto from 'crypto';
import { grantDefaultPermissions } from './bootstrap.js';
import { getDb } from './db.js';
import { Session } from './types.js';

export function createSession(name: string): Session {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, name, default_policy)
       VALUES (?, ?, 'allow')`
    )
    .run(id, name);
  grantDefaultPermissions(id);
  return getSession(id)!;
}

export function getSession(id: string): Session | undefined {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row as Session | undefined;
}

export function getSessionByIp(ip: string): Session | undefined {
  const normalized = ip.replace(/^::ffff:/, '');
  const row = getDb()
    .prepare(
      "SELECT * FROM sessions WHERE container_ip = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    )
    .get(normalized);
  return row as Session | undefined;
}

export function listSessions(status?: string): Session[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC').all(status) as Session[];
  }
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as Session[];
}

export function updateSession(
  id: string,
  updates: Partial<
    Pick<
      Session,
      | 'status'
      | 'container_id'
      | 'container_name'
      | 'container_ip'
      | 'default_policy'
      | 'project_dir'
      | 'stopped_at'
    >
  >,
): void {
  const db = getDb();
  const allowed = [
    'status',
    'container_id',
    'container_name',
    'container_ip',
    'default_policy',
    'project_dir',
    'stopped_at',
  ] as const;
  const setParts: string[] = [];
  const values: unknown[] = [];

  for (const key of allowed) {
    const val = updates[key];
    if (val !== undefined) {
      setParts.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (updates.status === 'stopped' && updates.stopped_at === undefined) {
    setParts.push("stopped_at = datetime('now')");
  }

  if (setParts.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE sessions SET ${setParts.join(', ')} WHERE id = ?`).run(
    ...values
  );
}
