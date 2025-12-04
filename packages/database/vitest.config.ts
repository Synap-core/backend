import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load .env.test for test environment
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./src/__tests__/setup.ts'],
      env: {
        // Ensure DATABASE_URL is available for tests
        DATABASE_URL: env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/synap',
        OPENAI_API_KEY: env.OPENAI_API_KEY || 'test-key',
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
      testTimeout: 30000, // 30s for database operations
      hookTimeout: 30000,
    },
  };
});
