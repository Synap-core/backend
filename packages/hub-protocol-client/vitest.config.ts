import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@synap/core': path.resolve(__dirname, '../core/src'),
      '@synap/hub-protocol': path.resolve(__dirname, '../hub-protocol/src'),
      '@synap/api': path.resolve(__dirname, '../api/src'),
    },
  },
});

