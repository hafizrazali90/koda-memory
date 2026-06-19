import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export function getDbPath(): string {
  return process.env.KODA_DB_PATH || path.join(process.cwd(), '.koda', 'brain.db');
}

export function openDatabase(options?: { dbPath?: string }): Database.Database {
  const dbPath = options?.dbPath || getDbPath();
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Enable WAL mode for crash safety and better concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Run schema if tables don't exist
  initializeSchema(db);

  // Create vector table (must be done after extension is loaded)
  createVectorTable(db);

  return db;
}

function initializeSchema(db: Database.Database): void {
  // Check if schema is already applied
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
  ).get();

  if (!tableExists) {
    // Fresh database — run full schema
    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schemaSql);
  }

  // Run incremental migrations on every startup (idempotent)
  runMigrations(db);
}

function runMigrations(db: Database.Database): void {
  // Migration 2 — per-user isolation
  // Add user_id to memories (default 'hafiz' preserves all existing memories as yours)
  const hasUserIdOnMemories = db.prepare(
    "SELECT 1 FROM pragma_table_info('memories') WHERE name='user_id'"
  ).get();
  if (!hasUserIdOnMemories) {
    db.exec(`
      ALTER TABLE memories ADD COLUMN user_id TEXT NOT NULL DEFAULT 'hafiz';
      CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
    `);
  }

  // Add user_id to sessions
  const hasUserIdOnSessions = db.prepare(
    "SELECT 1 FROM pragma_table_info('sessions') WHERE name='user_id'"
  ).get();
  if (!hasUserIdOnSessions) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'hafiz';
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
  }

  // Record migration
  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (2, datetime('now'))"
  ).run();

  // Migration 3 — human review tracking (separates "reviewed by a human" from
  // passive "last_accessed" so confirmed memories aren't auto-archived by search hits)
  const hasHumanReviewedAt = db.prepare(
    "SELECT 1 FROM pragma_table_info('memories') WHERE name='human_reviewed_at'"
  ).get();
  if (!hasHumanReviewedAt) {
    db.exec(`ALTER TABLE memories ADD COLUMN human_reviewed_at TEXT;`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (3, datetime('now'))"
  ).run();

  // Migration 4 — provenance + flag-as-outdated governance for project memories
  // created_by: original author (even when stored under the shared 'sifututor' user)
  // flagged_outdated_by/at: any team member can flag a shared memory for review
  const hasCreatedBy = db.prepare(
    "SELECT 1 FROM pragma_table_info('memories') WHERE name='created_by'"
  ).get();
  if (!hasCreatedBy) {
    db.exec(`
      ALTER TABLE memories ADD COLUMN created_by TEXT;
      ALTER TABLE memories ADD COLUMN flagged_outdated_by TEXT;
      ALTER TABLE memories ADD COLUMN flagged_outdated_at TEXT;
    `);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (4, datetime('now'))"
  ).run();

  // Migration 5 — bi-temporal supersession. superseded_at marks a memory whose
  // fact has been replaced by a newer one (via a 'supersedes' relationship).
  // Superseded memories are excluded from search/context by default but kept
  // for history and still retrievable by id.
  const hasSupersededAt = db.prepare(
    "SELECT 1 FROM pragma_table_info('memories') WHERE name='superseded_at'"
  ).get();
  if (!hasSupersededAt) {
    db.exec(`ALTER TABLE memories ADD COLUMN superseded_at TEXT;`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (5, datetime('now'))"
  ).run();

  // Migration 6 — soft delete: allows marking memories deleted without losing history.
  // deleted_at IS NULL in all queries to exclude soft-deleted rows from search/recall.
  const hasDeletedAt = db.prepare(
    "SELECT 1 FROM pragma_table_info('memories') WHERE name='deleted_at'"
  ).get();
  if (!hasDeletedAt) {
    db.exec(`ALTER TABLE memories ADD COLUMN deleted_at TEXT;`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (6, datetime('now'))"
  ).run();

  // Migration 7 — embedding model version: tracks which model generated each embedding
  // so we can detect and re-embed when the model changes (e.g. small → large).
  const hasEmbeddingModel = db.prepare(
    "SELECT 1 FROM pragma_table_info('memories') WHERE name='embedding_model'"
  ).get();
  if (!hasEmbeddingModel) {
    db.exec(`ALTER TABLE memories ADD COLUMN embedding_model TEXT DEFAULT 'text-embedding-3-small';`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (7, datetime('now'))"
  ).run();

  // Migration 8 — composite index for the most common query pattern: per-user per-project
  // memory lookups. Speeds up memory_search, memory_context, and session_start.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_user_project ON memories(user_id, project);
  `);

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (8, datetime('now'))"
  ).run();

  // Migration 9 — conflict tracking fields for the validation engine.
  // conflicts_with: comma-separated IDs of memories that contradict this one.
  // duplicate_of: ID of the canonical memory this one duplicates.
  // validation_checked_at: last time the validation pipeline processed this memory.
  const hasConflictsWith = db.prepare(
    "SELECT 1 FROM pragma_table_info('memories') WHERE name='conflicts_with'"
  ).get();
  if (!hasConflictsWith) {
    db.exec(`
      ALTER TABLE memories ADD COLUMN conflicts_with TEXT;
      ALTER TABLE memories ADD COLUMN duplicate_of TEXT;
      ALTER TABLE memories ADD COLUMN validation_checked_at TEXT;
    `);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (9, datetime('now'))"
  ).run();

  // Migration 10 — audit_log: append-only record of all mutations to memories.
  // Used by the dashboard to show history and by the validation engine for provenance.
  const hasAuditLog = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
  ).get();
  if (!hasAuditLog) {
    db.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_memory ON audit_log(memory_id);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
    `);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (10, datetime('now'))"
  ).run();

  // Migration 11 — validation_queue: async job queue for the background validation
  // pipeline (duplicate detection, contradiction detection, confidence propagation).
  // Status: pending → processing → done | failed.
  const hasValidationQueue = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='validation_queue'"
  ).get();
  if (!hasValidationQueue) {
    db.exec(`
      CREATE TABLE validation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_vq_status ON validation_queue(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_vq_memory ON validation_queue(memory_id);
    `);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (11, datetime('now'))"
  ).run();

  // Migration 12 — search_gaps: tracks queries that returned low-quality results
  // so the dashboard can surface "coverage holes" — topics the brain doesn't know well.
  const hasSearchGaps = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='search_gaps'"
  ).get();
  if (!hasSearchGaps) {
    db.exec(`
      CREATE TABLE search_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        top_score REAL,
        user_id TEXT,
        project TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sg_project ON search_gaps(project, created_at);
    `);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (12, datetime('now'))"
  ).run();

  // Migration 13 — validation retry backoff. next_attempt_at gates when a job
  // becomes eligible again after a transient failure. NULL = ready now.
  const hasNextAttempt = db.prepare(
    "SELECT 1 FROM pragma_table_info('validation_queue') WHERE name='next_attempt_at'"
  ).get();
  if (!hasNextAttempt) {
    db.exec(`ALTER TABLE validation_queue ADD COLUMN next_attempt_at TEXT;`);
  }

  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (13, datetime('now'))"
  ).run();
}

function createVectorTable(db: Database.Database): void {
  // Check if vector table already exists
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_embeddings'"
  ).get();

  if (tableExists) {
    return;
  }

  // Create sqlite-vec virtual table for 1536-dim embeddings (text-embedding-3-small)
  db.exec(`
    CREATE VIRTUAL TABLE memory_embeddings USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[1536]
    );
  `);
}

// Singleton connection
let connection: Database.Database | null = null;

export function getConnection(): Database.Database {
  if (connection) {
    try {
      connection.prepare('SELECT 1').get();
      return connection;
    } catch {
      connection = null;
    }
  }

  connection = openDatabase();
  return connection;
}

export function closeConnection(): void {
  if (connection) {
    connection.close();
    connection = null;
  }
}
