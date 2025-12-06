/**
 * Domain Package Test Setup
 */
import { beforeAll, afterAll, vi } from 'vitest';

// Global mock for @synap/ai-embeddings to prevent API calls
vi.mock('@synap/ai-embeddings', () => {
  return {
    generateEmbedding: async (text: string) => {
      return Array(1536).fill(0.1);
    },
    generateEmbeddings: async (texts: string[]) => {
      return texts.map(() => Array(1536).fill(0.1));
    },
  };
});

beforeAll(() => {
  // Global setup if needed
});

afterAll(() => {
  // Global teardown if needed
});
