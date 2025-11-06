import type { Config } from 'drizzle-kit';
import path from 'path';

const dialect = process.env.DB_DIALECT || 'sqlite';

const config: Config = dialect === 'sqlite' 
  ? {
      // SQLite configuration (local MVP)
      schema: './src/schema/index.ts',
      out: './migrations',
      dialect: 'sqlite',
      dbCredentials: {
        url: process.env.SQLITE_DB_PATH || 
          path.join(process.cwd(), '../../data/synap.db'),
      },
      verbose: true,
      strict: true,
    }
  : {
      // PostgreSQL configuration (cloud)
      schema: './src/schema/index.ts',
      out: './migrations',
      dialect: 'postgresql',
      dbCredentials: {
        url: process.env.DATABASE_URL!,
      },
      verbose: true,
      strict: true,
    };

export default config;

