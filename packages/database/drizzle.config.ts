/**
 * Drizzle Kit Configuration - PostgreSQL Only
 * 
 * Used for:
 * - drizzle-kit generate: Generate migration files from schema
 * - drizzle-kit push: Push schema directly to database (dev only)
 * - drizzle-kit studio: Launch Drizzle Studio UI
 */

import type { Config } from 'drizzle-kit';

const config: Config = {
  // PostgreSQL with pgvector
  schema: './src/schema/index.ts', // Use source directly with tsx
  out: './migrations-drizzle', // Auto-generated migrations
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
  verbose: true,
  strict: true,
};

export default config;
