/**
 * SQLite Database Client
 * For local single-user development
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema/index.js';
import path from 'path';

// Database path
const dbPath = process.env.SQLITE_DB_PATH || path.join(process.cwd(), 'data', 'synap.db');

// Ensure directory exists
import { mkdirSync } from 'fs';
mkdirSync(path.dirname(dbPath), { recursive: true });

// Create SQLite connection
const sqlite = new Database(dbPath);

// Enable foreign keys
sqlite.pragma('foreign_keys = ON');

// Create Drizzle instance with better-sqlite3 methods
const drizzleDb = drizzle(sqlite, { schema });

// Add raw query method for updates
export const db = Object.assign(drizzleDb, {
  run: (sql: string, params?: any[]) => {
    return sqlite.prepare(sql).run(...(params || []));
  }
});

console.log(`📦 SQLite database: ${dbPath}`);

