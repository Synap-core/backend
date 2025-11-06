/**
 * PostgreSQL Database Client
 * For cloud multi-tenant deployment (Phase 2)
 */

import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';
import * as schema from './schema/index.js';

// Create connection pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Create Drizzle instance
export const db = drizzle(pool, { schema });

// Helper to set current user for RLS (for multi-tenant mode)
export async function setCurrentUser(userId: string) {
  await pool.query(`SET app.current_user_id = '${userId}'`);
}

// Helper to clear current user
export async function clearCurrentUser() {
  await pool.query(`RESET app.current_user_id`);
}

console.log('🐘 PostgreSQL database connected');

