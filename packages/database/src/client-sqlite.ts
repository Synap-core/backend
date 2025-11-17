/**
 * SQLite Database Client
 * For local single-user development
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema/index.js';
import path from 'path';
import { createLogger } from '@synap/core';
import { mkdirSync } from 'fs';

const dbLogger = createLogger({ module: 'database-sqlite' });

// Database path - use process.env to avoid circular dependency with config
// Config can be used in higher-level packages, but database client should be low-level
const dbPath = process.env.SQLITE_DB_PATH || path.join(process.cwd(), 'data', 'synap.db');

// Ensure directory exists
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

dbLogger.info({ dbPath }, 'SQLite database connected');

