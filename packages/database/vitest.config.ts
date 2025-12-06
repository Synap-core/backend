import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  
  return {
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./src/__tests__/setup.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],  // Exclude compiled files
      env: {
        DATABASE_URL: (process.env.DATABASE_URL || env.DATABASE_URL || 'postgresql://postgres:synap_dev_password@localhost:5432/synap').replace(/^'|'$/g, ''),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || 'test-key',
        NODE_ENV: 'test',
      },
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        exclude: [
          'node_modules/',
          'dist/',
          '**/*.test.ts',
          '**/__tests__/**',
          'migrations-custom/**',
          'drizzle.config.ts',
        ],
      },
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  };
});
