/**
 * Domain Package Test Setup
 */
import { beforeAll, afterAll, vi } from 'vitest';

// Global mock for @synap/ai-embeddings to prevent API calls
vi.mock('@synap/ai-embeddings', () => {
  return {
    generateEmbedding: async (text: string) => {
      // Generate a simple hash-based embedding to create different vectors for different texts
      // This allows semantic similarity tests to work properly
      const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const baseValue = (hash % 100) / 100; // 0.00 to 0.99
      
      // Create a 1536-dimensional vector with some variation
      return Array(1536).fill(0).map((_, i) => {
        // Add some variation based on position and text hash
        return baseValue + (i % 10) * 0.01;
      });
    },
    generateEmbeddings: async (texts: string[]) => {
      const { generateEmbedding } = await import('@synap/ai-embeddings');
      return Promise.all(texts.map(text => generateEmbedding(text)));
    },
  };
});

beforeAll(() => {
  // Global setup if needed
});

afterAll(() => {
  // Global teardown if needed
});
