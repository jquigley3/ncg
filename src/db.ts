import Database from 'better-sqlite3-multiple-ciphers';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || './data/ncg.db';
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function initDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('forward', 'reverse')),

      domain_pattern TEXT,
      path_prefix TEXT,
      upstream_url TEXT,

      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS injectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      route_id TEXT NOT NULL REFERENCES routes(id),
      inject_header TEXT NOT NULL,
      inject_value TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      container_id TEXT,
      container_name TEXT,
      container_ip TEXT,
      project_dir TEXT,
      default_policy TEXT NOT NULL DEFAULT 'deny',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      stopped_at TEXT
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      route_id TEXT NOT NULL REFERENCES routes(id),
      injector_id TEXT REFERENCES injectors(id),
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, route_id)
    );

    CREATE TABLE IF NOT EXISTS session_links (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      claude_session_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, claude_session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_container_ip ON sessions(container_ip);
    CREATE INDEX IF NOT EXISTS idx_permissions_session_id ON permissions(session_id);
    CREATE INDEX IF NOT EXISTS idx_permissions_route_id ON permissions(route_id);
    CREATE INDEX IF NOT EXISTS idx_injectors_route_id ON injectors(route_id);
  `);

  migrateSchema(db);

  console.log(`Database initialized: ${DB_PATH}`);
}

/**
 * Handle schema migration for existing databases that predate the injector model.
 * - Adds injector_id column to permissions if missing
 * - Creates injectors table if missing
 * - Migrates inject_header/inject_value from routes into injectors
 */
function migrateSchema(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('permissions')").all() as Array<{ name: string }>;
  const hasInjectorId = cols.some((c) => c.name === 'injector_id');
  if (hasInjectorId) return;

  // Existing DB — add injector_id to permissions
  db.exec(`ALTER TABLE permissions ADD COLUMN injector_id TEXT REFERENCES injectors(id)`);

  // Migrate routes that have inject_header/inject_value into injectors
  const routeCols = db.prepare("PRAGMA table_info('routes')").all() as Array<{ name: string }>;
  if (!routeCols.some((c) => c.name === 'inject_header')) return;

  const routes = db.prepare(
    `SELECT id, name, inject_header, inject_value FROM routes WHERE inject_header IS NOT NULL AND inject_value IS NOT NULL`
  ).all() as Array<{ id: string; name: string; inject_header: string; inject_value: string }>;

  const crypto = require('crypto');
  for (const route of routes) {
    const injId = crypto.randomUUID();
    const injName = `${route.name}-default`;
    db.prepare(
      `INSERT OR IGNORE INTO injectors (id, name, route_id, inject_header, inject_value, description)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(injId, injName, route.id, route.inject_header, route.inject_value, 'Auto-migrated from route');

    const inj = db.prepare(`SELECT id FROM injectors WHERE name = ?`).get(injName) as { id: string } | undefined;
    if (inj) {
      db.prepare(`UPDATE permissions SET injector_id = ? WHERE route_id = ? AND injector_id IS NULL`)
        .run(inj.id, route.id);
    }
  }

  console.log(`Migration: added injector_id to permissions, migrated ${routes.length} route(s) to injectors`);
}
