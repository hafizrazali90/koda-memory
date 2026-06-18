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

export function openDatabase(): Database.Database {
  const dbPath = getDbPath();
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
