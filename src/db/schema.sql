-- Koda Memory Database Schema
-- SQLite with FTS5 + sqlite-vec extensions

-- Core memory storage
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('decision', 'lesson', 'rule', 'preference', 'fact')),
  content TEXT NOT NULL,
  why TEXT,
  source TEXT DEFAULT 'auto-captured' CHECK (source IN ('user-stated', 'auto-captured', 'correction')),
  confidence TEXT DEFAULT 'inferred' CHECK (confidence IN ('confirmed', 'inferred', 'outdated')),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0
);

-- Full-text search index (standalone FTS5 with Porter stemmer)
-- Managed manually (not content-synced) because it includes tags from a separate table
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id,
  content,
  why,
  tags,
  tokenize='porter unicode61'
);

-- Vector embeddings (sqlite-vec)
-- Note: This table is created programmatically after loading sqlite-vec extension
-- CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
--   memory_id TEXT PRIMARY KEY,
--   embedding float[1536]
-- );

-- Tags for filtering
CREATE TABLE IF NOT EXISTS tags (
  memory_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- Graph relationships between memories
CREATE TABLE IF NOT EXISTS relationships (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('relates-to', 'supersedes', 'contradicts', 'depends-on')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type),
  FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- Session tracking
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  branch TEXT,
  commit_count INTEGER DEFAULT 0
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(project, category);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, datetime('now'));
