import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export interface ConnectionOptions {
  projectPath: string;
}

export function getDbPath(projectPath: string): string {
  return path.join(projectPath, '.koda', 'brain.db');
}

export function openDatabase(options: ConnectionOptions): Database.Database {
  const dbDir = path.join(options.projectPath, '.koda');
  const dbPath = path.join(dbDir, 'brain.db');

  // Ensure .koda directory exists
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

  if (tableExists) {
    return;
  }

  // Read and execute schema SQL
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schemaSql);
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

// Singleton pattern for reusing connections within the same project
const connections = new Map<string, Database.Database>();

export function getConnection(projectPath: string): Database.Database {
  const resolved = path.resolve(projectPath);

  let db = connections.get(resolved);
  if (db) {
    // Verify connection is still open
    try {
      db.prepare('SELECT 1').get();
      return db;
    } catch {
      connections.delete(resolved);
    }
  }

  db = openDatabase({ projectPath: resolved });
  connections.set(resolved, db);
  return db;
}

export function closeConnection(projectPath: string): void {
  const resolved = path.resolve(projectPath);
  const db = connections.get(resolved);
  if (db) {
    db.close();
    connections.delete(resolved);
  }
}

export function closeAllConnections(): void {
  for (const [key, db] of connections) {
    db.close();
    connections.delete(key);
  }
}
