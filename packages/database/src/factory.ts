/**
 * Database Factory - PostgreSQL Client
 * 
 * Simplified for PostgreSQL-only architecture.
 * 
 * @deprecated This file is kept for backward compatibility.
 * Prefer importing directly from './client.js' instead.
 */

import { db, setCurrentUser, clearCurrentUser } from './client-pg.js';

export type DatabaseClient = typeof db;

/**
 * Create database client
 * 
 * @returns PostgreSQL database client
 * @throws Error if DATABASE_URL is not set
 * 
 * @deprecated Import { db } from '@synap/database' instead
 */
export async function createDatabaseClient(): Promise<DatabaseClient> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return db;
}

/**
 * Get database client synchronously
 * 
 * @deprecated Import { db } from '@synap/database' instead
 */
export function getDatabaseClient(): DatabaseClient {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return db;
}

/**
 * Get setCurrentUser function (PostgreSQL RLS)
 * 
 * @deprecated Import { setCurrentUser } from '@synap/database' instead
 */
export async function getSetCurrentUserFunction(): Promise<(userId: string) => Promise<void>> {
  return setCurrentUser;
}

/**
 * Get clearCurrentUser function (PostgreSQL RLS)
 * 
 * @deprecated Import { clearCurrentUser } from '@synap/database' instead
 */
export async function getClearCurrentUserFunction(): Promise<() => Promise<void>> {
  return clearCurrentUser;
}
