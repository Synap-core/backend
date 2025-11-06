/**
 * Database Migration Script
 * 
 * Initializes SQLite database with all tables
 */

import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';

const dbPath = process.env.SQLITE_DB_PATH || path.join(process.cwd(), '../../data/synap.db');

// Ensure directory exists
mkdirSync(path.dirname(dbPath), { recursive: true });

// Create database
const db = new Database(dbPath);

console.log(`📦 Initializing database: ${dbPath}\n`);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Events table (source of truth)
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    source TEXT DEFAULT 'api',
    correlation_id TEXT
  );

  -- Entities table (knowledge graph nodes)
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT,
    preview TEXT,
    version INTEGER DEFAULT 1 NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );

  -- Content blocks (hybrid storage)
  CREATE TABLE IF NOT EXISTS content_blocks (
    entity_id TEXT PRIMARY KEY,
    storage_provider TEXT DEFAULT 'db' NOT NULL,
    storage_path TEXT,
    storage_url TEXT,
    content TEXT,
    content_type TEXT DEFAULT 'markdown' NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    checksum TEXT,
    embedding TEXT,
    embedding_model TEXT DEFAULT 'text-embedding-3-small',
    uploaded_at INTEGER NOT NULL,
    last_modified_at INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  );

  -- Task details (component)
  CREATE TABLE IF NOT EXISTS task_details (
    entity_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'todo' NOT NULL,
    due_date INTEGER,
    priority INTEGER DEFAULT 0 NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
  );

  -- Relations (knowledge graph edges)
  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL,
    target_entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
  );

  -- Tags
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    created_at INTEGER NOT NULL
  );

  -- Entity Tags (M2M)
  CREATE TABLE IF NOT EXISTS entity_tags (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
  CREATE INDEX IF NOT EXISTS idx_entities_created_at ON entities(created_at);
  CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
  CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_id);
  CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id);
`);

console.log('✅ Tables created successfully!\n');

// Verify
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('📊 Created tables:');
tables.forEach((table: any) => console.log(`  - ${table.name}`));

db.close();

console.log('\n🎉 Database initialization complete!');
console.log(`\nDatabase location: ${dbPath}`);
console.log('\nNext steps:');
console.log('  1. Start API: pnpm --filter api dev');
console.log('  2. Start Inngest: pnpm --filter jobs dev');
console.log('  3. Test: pnpm --filter core test:local\n');

