/**
 * Backfill embeddings for all memories that don't have one yet.
 * Usage: npx tsx scripts/backfill-embeddings.ts <path-to-brain.db>
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { generateEmbedding } from '../src/embeddings/openai.js';
import { insertEmbedding } from '../src/search/vector.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('Usage: npx tsx scripts/backfill-embeddings.ts <path-to-brain.db>');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set');
  process.exit(1);
}

const db = new Database(dbPath);
sqliteVec.load(db);

// Find memories without embeddings
const missing = db.prepare(`
  SELECT m.id, m.content, m.why
  FROM memories m
  LEFT JOIN memory_embeddings e ON e.memory_id = m.id
  WHERE e.memory_id IS NULL
`).all() as { id: string; content: string; why: string | null }[];

console.log(`Found ${missing.length} memories without embeddings`);

let success = 0;
let failed = 0;

for (const mem of missing) {
  try {
    const text = mem.why ? `${mem.content}\n${mem.why}` : mem.content;
    const embedding = await generateEmbedding(text);
    insertEmbedding(db, mem.id, embedding);
    success++;
    process.stdout.write(`\r  Embedded ${success}/${missing.length}`);
  } catch (err: any) {
    failed++;
    console.error(`\n  Failed ${mem.id}: ${err.message}`);
  }
}

console.log(`\nDone: ${success} embedded, ${failed} failed`);
db.close();
