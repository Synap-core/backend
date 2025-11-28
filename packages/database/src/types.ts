/**
 * Database Driver Types
 */

export interface DriverConfig {
  url: string;
  schema: Record<string, unknown>;
  poolSize?: number;
}

export interface DatabaseDriver {
  db: any; // Drizzle instance
  sql?: any; // postgres.js instance (if applicable)
  pool?: any; // Neon pool (if applicable)
  cleanup: () => Promise<void>;
}

export type Runtime = 'node' | 'edge' | 'deno' | 'bun';
export type Deployment = 'local' | 'traditional' | 'serverless';
