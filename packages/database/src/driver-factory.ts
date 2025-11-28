/**
 * Universal Database Driver Factory
 * 
 * Automatically selects the optimal driver based on:
 * - Environment (NODE_ENV)
 * - Database URL (neon.tech, vercel, supabase, localhost)
 * - Runtime (Node.js, Edge, Deno, Bun)
 */

import type { DriverConfig, DatabaseDriver, Runtime, Deployment } from './types.js';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'driver-factory' });

export async function createDriver(config: DriverConfig): Promise<DatabaseDriver> {
  const dbUrl = config.url || process.env.DATABASE_URL || '';
  const runtime = detectRuntime();
  const deployment = detectDeployment(dbUrl);
  
  logger.info({ runtime, deployment }, 'Creating database driver');
  
  // Decision matrix
  if (deployment === 'serverless' || runtime === 'edge') {
    // Use Neon serverless driver
    logger.info('Using @neondatabase/serverless driver (WebSocket/HTTP)');
    return createNeonDriver(config);
  } else {
    // Use postgres.js (local, traditional cloud)
    logger.info('Using postgres.js driver (TCP)');
    return createPostgresJsDriver(config);
  }
}

function detectRuntime(): Runtime {
  // @ts-ignore - Global check
  if (typeof Deno !== 'undefined') return 'deno';
  // @ts-ignore - Global check
  if (typeof Bun !== 'undefined') return 'bun';
  // @ts-ignore - Global check
  if (typeof EdgeRuntime !== 'undefined') return 'edge';
  return 'node';
}

function detectDeployment(url: string): Deployment {
  const lowerUrl = url.toLowerCase();
  
  // Local development
  if (lowerUrl.includes('localhost') || lowerUrl.includes('127.0.0.1')) {
    return 'local';
  }
  
  // Serverless providers
  if (lowerUrl.includes('neon.tech') || 
      lowerUrl.includes('vercel-postgres') || 
      lowerUrl.includes('vercel-storage') ||
      lowerUrl.includes('supabase')) {
    return 'serverless';
  }
  
  // Traditional cloud (OVH, AWS, DigitalOcean, etc.)
  return 'traditional';
}

async function createPostgresJsDriver(config: DriverConfig): Promise<DatabaseDriver> {
  const postgres = (await import('postgres')).default;
  const { drizzle } = await import('drizzle-orm/postgres-js');
  
  const sql = postgres(config.url, {
    max: config.poolSize || 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}, // Suppress NOTICE messages
  });
  
  const db = drizzle(sql, { schema: config.schema });
  
  logger.info({ poolSize: config.poolSize || 10 }, 'postgres.js driver initialized');
  
  return {
    db,
    sql,
    cleanup: async () => {
      await sql.end();
      logger.info('postgres.js driver cleaned up');
    },
  };
}

async function createNeonDriver(config: DriverConfig): Promise<DatabaseDriver> {
  const { Pool } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-serverless');
  
  const pool = new Pool({ 
    connectionString: config.url,
    // Serverless optimizations
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 20000,
  });
  
  const db = drizzle(pool, { schema: config.schema });
  
  logger.info('Neon serverless driver initialized');
  
  return {
    db,
    pool,
    cleanup: async () => {
      await pool.end();
      logger.info('Neon serverless driver cleaned up');
    },
  };
}
