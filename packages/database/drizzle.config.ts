/**
 * Drizzle Kit Configuration - PostgreSQL Only
 *
 * Used for:
 * - drizzle-kit generate: Generate migration files from schema
 * - drizzle-kit push: Push schema directly to database (dev only)
 * - drizzle-kit studio: Launch Drizzle Studio UI
 */

import type { Config } from "drizzle-kit";
import * as dotenv from "dotenv";

// Load environment variables from parent directory
dotenv.config({ path: "../../.env" });

const config: Config = {
  // PostgreSQL with pgvector
  schema: "./dist/schema/index.js", // Use compiled JS to avoid TSX import resolution issues with .js extensions
  out: "./migrations-drizzle", // Auto-generated migrations
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
  verbose: true,
  strict: true,
};

export default config;
