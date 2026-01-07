/**
 * Vitest Configuration for E2E Tests
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    name: 'e2e',
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120000, // 2 minutes for E2E tests
    hookTimeout: 300000, // 5 minutes for setup/teardown
    setupFiles: ['./tests/e2e/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.test.ts',
        '**/__tests__/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@synap-core/core': path.resolve(__dirname, '../packages/core/src'),
      '@synap/api': path.resolve(__dirname, '../packages/api/src'),
      '@synap/database': path.resolve(__dirname, '../packages/database/src'),
      '@synap/domain': path.resolve(__dirname, '../packages/domain/src'),
      '@synap/types': path.resolve(__dirname, '../packages/types/src'),
      '@synap/auth': path.resolve(__dirname, '../packages/auth/src'),
      '@synap/hub-protocol': path.resolve(__dirname, '../packages/hub-protocol/src'),
      '@synap/hub-protocol-client': path.resolve(__dirname, '../packages/hub-protocol-client/src'),
    },
  },
});

