import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load .env.test for test environment
  const env = loadEnv(mode, process.cwd(), '');
  
  return {
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./tests/setup.ts'],
      env: {
        // Ensure environment variables available for tests
        DATABASE_URL: (env.DATABASE_URL || 'postgresql://postgres:synap_dev_password@localhost:5432/synap').replace(/^'|'$/g, ''),
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
          '**/tests/**',
        ],
      },
    },
  };
});
