import crypto from 'crypto';
import { getDb } from './db.js';
import type { SessionLink } from './types.js';

const SESSION_HEADERS = ['x-session-id', 'anthropic-session-id'];

export function recordTrafficObservation(
  sessionId: string,
  headers: Record<string, string | string[] | undefined>,
  bodyStr: string,
): void {
  let claudeSessionId: string | null = null;

  for (const h of SESSION_HEADERS) {
    const val = headers[h.toLowerCase()];
    if (val && typeof val === 'string') {
      claudeSessionId = val.trim();
      break;
    }
    if (Array.isArray(val) && val[0]) {
      claudeSessionId = String(val[0]).trim();
      break;
    }
  }

  if (!claudeSessionId && bodyStr) {
    try {
      const body = JSON.parse(bodyStr) as Record<string, unknown>;
      const sid = body.session_id ?? (body.metadata as Record<string, unknown>)?.session_id;
      if (typeof sid === 'string') claudeSessionId = sid;
    } catch {
      /* ignore parse errors */
    }
  }

  if (!claudeSessionId) return;

  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO session_links (id, session_id, claude_session_id)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id, claude_session_id) DO UPDATE SET last_seen_at = datetime('now')`
  ).run(id, sessionId, claudeSessionId);
}


export function getSessionLinks(sessionId: string): SessionLink[] {
  return getDb()
    .prepare(
      'SELECT * FROM session_links WHERE session_id = ? ORDER BY last_seen_at DESC'
    )
    .all(sessionId) as SessionLink[];
}

export function findSessionsByClaudeId(
  claudeSessionId: string
): Array<{ session_id: string; first_seen_at: string; last_seen_at: string }> {
  return getDb()
    .prepare(
      'SELECT session_id, first_seen_at, last_seen_at FROM session_links WHERE claude_session_id = ?'
    )
    .all(claudeSessionId) as Array<{
      session_id: string;
      first_seen_at: string;
      last_seen_at: string;
    }>;
}
