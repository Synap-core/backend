/**
 * VectorService Tests
 * 
 * Tests for semantic search functionality using pgvector.
 * Validates embedding storage, search, and user isolation.
 */

// Set DATABASE_URL for tests if not present
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/synap';
}

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from '@synap/database';
import { vectorService } from '../src/services/vectors.js';
import { generateEmbedding } from '@synap/ai-embeddings';

// Helper to generate test user ID
const generateTestUserId = () => `test-vector-${crypto.randomUUID().slice(0, 8)}`;

// Cleanup function
async function cleanTestVectors() {
  await sql`DELETE FROM entity_vectors WHERE user_id LIKE 'test-vector-%'`;
  await sql`DELETE FROM entities WHERE user_id LIKE 'test-vector-%'`;
}

describe('VectorService', () => {
  beforeEach(async () => {
    await cleanTestVectors();
  });

  afterAll(async () => {
    await cleanTestVectors();
    await sql.end();
  });

  describe('upsertEntityEmbedding', () => {
    it('should store embedding successfully', async () => {
      const userId = generateTestUserId();
      const entityId = crypto.randomUUID();
      const embedding = await generateEmbedding('Test document');

      await vectorService.upsertEntityEmbedding({
        entityId,
        userId,
        entityType: 'note',
        title: 'Test Note',
        preview: 'This is a test note',
        embedding,
        embeddingModel: 'text-embedding-3-small',
      });

      const [stored] = await sql`
        SELECT * FROM entity_vectors WHERE entity_id = ${entityId}
      `;

      expect(stored).toBeDefined();
      expect(stored.user_id).toBe(userId);
      expect(stored.entity_type).toBe('note');
      expect(stored.title).toBe('Test Note');
    });

    it('should update existing embedding on conflict', async () => {
      const userId = generateTestUserId();
      const entityId = crypto.randomUUID();
      const embedding1 = await generateEmbedding('First version');
      const embedding2 = await generateEmbedding('Second version');

      await vectorService.upsertEntityEmbedding({
        entityId,
        userId,
        entityType: 'note',
        title: 'Original Title',
        embedding: embedding1,
        embeddingModel: 'text-embedding-3-small',
      });

      await vectorService.upsertEntityEmbedding({
        entityId,
        userId,
        entityType: 'note',
        title: 'Updated Title',
        embedding: embedding2,
        embeddingModel: 'text-embedding-3-small',
      });

      const stored = await sql`
        SELECT * FROM entity_vectors WHERE entity_id = ${entityId}
      `;

      expect(stored.length).toBe(1);
      expect(stored[0].title).toBe('Updated Title');
    });
  });

  describe('searchByEmbedding', () => {
    it('should find semantically similar entities', async () => {
      const userId = generateTestUserId();

      // Create test entities with embeddings
      const docs = [
        { id: crypto.randomUUID(), text: 'Machine learning and artificial intelligence' },
        { id: crypto.randomUUID(), text: 'Cooking recipes and food preparation' },
        { id: crypto.randomUUID(), text: 'Deep learning neural networks' },
      ];

      for (const doc of docs) {
        const embedding = await generateEmbedding(doc.text);
        await vectorService.upsertEntityEmbedding({
          entityId: doc.id,
          userId,
          entityType: 'note',
          title: doc.text,
          embedding,
          embeddingModel: 'text-embedding-3-small',
        });
      }

      // Search for AI-related content
      const queryEmbedding = await generateEmbedding('AI and neural networks');
      const results = await vectorService.searchByEmbedding({
        userId,
        embedding: queryEmbedding,
        limit: 2,
      });

      expect(results.length).toBe(2);
      // Most similar should be docs[2] (deep learning) and docs[0] (ML/AI)
      // Cooking should not be in top 2
      const resultIds = results.map(r => r.entityId);
      expect(resultIds).toContain(docs[0].id); // ML/AI doc
      expect(resultIds).toContain(docs[2].id); // Deep learning doc
      expect(resultIds).not.toContain(docs[1].id); // Cooking doc
    });

    it('should enforce user isolation in search', async () => {
      const user1 = generateTestUserId();
      const user2 = generateTestUserId();
      const embedding = await generateEmbedding('Shared content');

      // User 1 document
      await vectorService.upsertEntityEmbedding({
        entityId: crypto.randomUUID(),
        userId: user1,
        entityType: 'note',
        title: 'User 1 document',
        embedding,
        embeddingModel: 'text-embedding-3-small',
      });

      // User 2 document
      await vectorService.upsertEntityEmbedding({
        entityId: crypto.randomUUID(),
        userId: user2,
        entityType: 'note',
        title: 'User 2 document',
        embedding,
        embeddingModel: 'text-embedding-3-small',
      });

      // User 1 search should only return their documents
      const user1Results = await vectorService.searchByEmbedding({
        userId: user1,
        embedding,
        limit: 10,
      });

      expect(user1Results.every(r => r.userId === user1)).toBe(true);
    });

    it('should return empty array when no similar entities found', async () => {
      const userId = generateTestUserId();
      const queryEmbedding = await generateEmbedding('Non-existent content');

      const results = await vectorService.searchByEmbedding({
        userId,
        embedding: queryEmbedding,
        limit: 5,
      });

      expect(results).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      const userId = generateTestUserId();
      const baseEmbedding = await generateEmbedding('Test document');

      // Create 10 similar documents
      for (let i = 0; i < 10; i++) {
        await vectorService.upsertEntityEmbedding({
          entityId: crypto.randomUUID(),
          userId,
          entityType: 'note',
          title: `Document ${i}`,
          embedding: baseEmbedding,
          embeddingModel: 'text-embedding-3-small',
        });
      }

      const results = await vectorService.searchByEmbedding({
        userId,
        embedding: baseEmbedding,
        limit: 3,
      });

      expect(results.length).toBe(3);
    });
  });

  describe('relevance scoring', () => {
    it('should return results with relevance scores', async () => {
      const userId = generateTestUserId();
      const embedding = await generateEmbedding('Test content');

      await vectorService.upsertEntityEmbedding({
        entityId: crypto.randomUUID(),
        userId,
        entityType: 'note',
        title: 'Test document',
        embedding,
        embeddingModel: 'text-embedding-3-small',
      });

      const results = await vectorService.searchByEmbedding({
        userId,
        embedding,
        limit: 1,
      });

      expect(results[0].relevanceScore).toBeDefined();
      expect(typeof results[0].relevanceScore).toBe('number');
      expect(results[0].relevanceScore).toBeGreaterThan(0);
      expect(results[0].relevanceScore).toBeLessThanOrEqual(1);
    });
  });
});
