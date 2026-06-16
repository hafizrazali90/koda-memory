import type Database from 'better-sqlite3';

export interface SessionStartResult {
  session_id: string;
  recent_sessions: { id: string; started_at: string; summary: string | null; branch: string | null }[];
  top_memories: { id: string; content: string; access_count: number }[];
  outdated_memories: { id: string; content: string }[];
}

export interface SessionEndResult {
  session_id: string;
  message: string;
}

export interface SessionListResult {
  sessions: {
    id: string;
    project: string;
    started_at: string;
    ended_at: string | null;
    summary: string | null;
    branch: string | null;
    commit_count: number;
  }[];
}

function generateSessionId(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `ses_${dateStr}_${timeStr}_${ms}${rand}`;
}

export function sessionStart(
  db: Database.Database,
  project: string,
  userId: string
): SessionStartResult {
  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO sessions (id, project, user_id, started_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, project, userId, now);

  // Recent sessions for this user + project
  const recentSessions = db.prepare(
    `SELECT id, started_at, summary, branch FROM sessions
     WHERE project = ? AND user_id = ? AND id != ?
     ORDER BY started_at DESC LIMIT 3`
  ).all(project, userId, sessionId) as SessionStartResult['recent_sessions'];

  // Most-accessed memories for this user (+ shared)
  const topMemories = db.prepare(
    `SELECT id, content, access_count FROM memories
     WHERE project = ? AND (user_id = ? OR user_id = ?) AND access_count > 0
     ORDER BY access_count DESC LIMIT 5`
  ).all(project, userId, 'shared') as SessionStartResult['top_memories'];

  // Outdated memories for this user
  const outdatedMemories = db.prepare(
    `SELECT id, content FROM memories
     WHERE project = ? AND user_id = ? AND confidence = 'outdated'
     LIMIT 5`
  ).all(project, userId) as SessionStartResult['outdated_memories'];

  return {
    session_id: sessionId,
    recent_sessions: recentSessions,
    top_memories: topMemories,
    outdated_memories: outdatedMemories,
  };
}

export function sessionEnd(
  db: Database.Database,
  sessionId: string,
  summary: string,
  branch?: string,
  commitCount?: number
): SessionEndResult {
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!existing) throw new Error(`Session ${sessionId} not found`);

  db.prepare(`
    UPDATE sessions SET ended_at = ?, summary = ?, branch = ?, commit_count = ?
    WHERE id = ?
  `).run(now, summary, branch ?? null, commitCount ?? 0, sessionId);

  return {
    session_id: sessionId,
    message: `Session ${sessionId} ended. Summary: ${summary}`,
  };
}

export function sessionList(
  db: Database.Database,
  project: string,
  limit: number = 10,
  userId?: string
): SessionListResult {
  const sessions = userId
    ? db.prepare(
        `SELECT id, project, started_at, ended_at, summary, branch, commit_count
         FROM sessions WHERE project = ? AND user_id = ?
         ORDER BY started_at DESC LIMIT ?`
      ).all(project, userId, limit)
    : db.prepare(
        `SELECT id, project, started_at, ended_at, summary, branch, commit_count
         FROM sessions WHERE project = ?
         ORDER BY started_at DESC LIMIT ?`
      ).all(project, limit);

  return { sessions: sessions as SessionListResult['sessions'] };
}
