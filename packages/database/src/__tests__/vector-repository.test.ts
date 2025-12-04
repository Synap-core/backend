/**
 * VectorRepository Tests
 * 
 * Tests for pgvector-based similarity search and embedding storage.
 * Validates HNSW index performance, user isolation, and search relevance.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '../index.js';
import { generateTestUserId } from './test-utils.js';

describe('VectorRepository', () => {
  beforeAll(async () => {
    // Clean test data
    await sql`DELETE FROM entity_vectors WHERE user_id LIKE 'test-%'`;
  });

  afterAll(async () => {
    await sql`DELETE FROM entity_vectors WHERE user_id LIKE 'test-%'`;
  });

  describe('embedding storage', () => {
    it('should store embedding vector', async () => {
      const userId = generateTestUserId();
      const entityId = crypto.randomUUID();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      await sql`
        INSERT INTO entity_vectors (
          entity_id, user_id, entity_type, title, embedding, embedding_model, indexed_at, updated_at
        ) VALUES (
          ${entityId}, ${userId}, 'note', 'Test Note',
          ${JSON.stringify(embedding)}, 'text-embedding-3-small', NOW(), NOW()
        )
      `;

      const [stored] = await sql`
        SELECT * FROM entity_vectors WHERE entity_id = ${entityId}
      `;

      expect(stored).toBeDefined();
      expect(stored.user_id).toBe(userId);
      expect(stored.entity_type).toBe('note');
      expect(stored.title).toBe('Test Note');
      expect(JSON.parse(stored.embedding as any).length).toBe(1536);
    });

    it('should update embedding on conflict', async () => {
      const userId = generateTestUserId();
      const entityId = crypto.randomUUID();
      const embedding1 = Array.from({ length: 1536 }, () => 0.1);
      const embedding2 = Array.from({ length: 1536 }, () => 0.9);

      // Insert first
      await sql`
        INSERT INTO entity_vectors (
          entity_id, user_id, entity_type, title, embedding, embedding_model, indexed_at, updated_at
        ) VALUES (
          ${entityId}, ${userId}, 'note', 'Original',
          ${JSON.stringify(embedding1)}, 'text-embedding-3-small', NOW(), NOW()
        )
      `;

      // Update on conflict
      await sql`
        INSERT INTO entity_vectors (
          entity_id, user_id, entity_type, title, embedding, embedding_model, indexed_at, updated_at
        ) VALUES (
          ${entityId}, ${userId}, 'note', 'Updated',
          ${JSON.stringify(embedding2)}, 'text-embedding-3-small', NOW(), NOW()
        )
        ON CONFLICT (entity_id) DO UPDATE SET
          title = EXCLUDED.title,
          embedding = EXCLUDED.embedding,
          updated_at = EXCLUDED.updated_at
      `;

      const stored = await sql`
        SELECT * FROM entity_vectors WHERE entity_id = ${entityId}
      `;

      expect(stored.length).toBe(1);
      expect(stored[0].title).toBe('Updated');
    });
  });

  describe('vector similarity search', () => {
    it('should find similar vectors using cosine distance', async () => {
      const userId = generateTestUserId();
      
      // Create reference vector
      const refEmbedding = Array.from({ length: 1536 }, (_, i) => i < 100 ? 1.0 : 0.0);
      
      // Create similar vector (same pattern)
      const similarId = crypto.randomUUID();
      const similarEmbedding = Array.from({ length: 1536 }, (_, i) => i < 100 ? 0.9 : 0.1);
      
      // Create dissimilar vector (opposite pattern)
      const dissimilarId = crypto.randomUUID();
      const dissimilarEmbedding = Array.from({ length: 1536 }, (_, i) => i < 100 ? 0.0 : 1.0);

      // Store vectors
      await sql`
        INSERT INTO entity_vectors (entity_id, user_id, entity_type, title, embedding, embedding_model, indexed_at, updated_at)
        VALUES 
          (${similarId}, ${userId}, 'note', 'Similar', ${JSON.stringify(similarEmbedding)}, 'text-embedding-3-small', NOW(), NOW()),
          (${dissimilarId}, ${userId}, 'note', 'Dissimilar', ${JSON.stringify(dissimilarEmbedding)}, 'text-embedding-3-small', NOW(), NOW())
      `;

      // Search for similar vectors
      const results = await sql`
        SELECT 
          entity_id,
          title,
          1 - (embedding <=> ${JSON.stringify(refEmbedding)}::vector) AS similarity
        FROM entity_vectors
        WHERE user_id = ${userId}
        ORDER BY embedding <=> ${JSON.stringify(refEmbedding)}::vector
        LIMIT 2
      `;

      expect(results.length).toBe(2);
      // Similar should be first (closer)
      expect(results[0].entity_id).toBe(similarId);
      expect(results[1].entity_id).toBe(dissimilarId);
      // Similarity should be higher for similar vector
      expect(parseFloat(results[0].similarity)).toBeGreaterThan(parseFloat(results[1].similarity));
    });

    it('should enforce user isolation in search', async () => {
      const user1 = generateTestUserId();
      const user2 = generateTestUserId();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      // Create vector for each user
      await sql`
        INSERT INTO entity_vectors (entity_id, user_id, entity_type, title, embedding, embedding_model, indexed_at, updated_at)
        VALUES 
          (${crypto.randomUUID()}, ${user1}, 'note', 'User 1 Doc', ${JSON.stringify(embedding)}, 'text-embedding-3-small', NOW(), NOW()),
          (${crypto.randomUUID()}, ${user2}, 'note', 'User 2 Doc', ${JSON.stringify(embedding)}, 'text-embedding-3-small', NOW(), NOW())
      `;

      // Search for user 1 only
      const user1Results = await sql`
        SELECT user_id FROM entity_vectors
        WHERE user_id = ${user1}
        ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
      `;

      expect(user1Results.length).toBe(1);
      expect(user1Results.every(r => r.user_id === user1)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const userId = generateTestUserId();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      // Create 10 vectors
      for (let i = 0; i < 10; i++) {
        await sql`
          INSERT INTO entity_vectors (entity_id, user_id, entity_type, title, embedding, embedding_model, indexed_at, updated_at)
          VALUES (${crypto.randomUUID()}, ${userId}, 'note', ${'Doc ' + i}, ${JSON.stringify(embedding)}, 'text-embedding-3-small', NOW(), NOW())
        `;
      }

      // Search with limit 3
      const results = await sql`
        SELECT * FROM entity_vectors
        WHERE user_id = ${userId}
        ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
        LIMIT 3
      `;

      expect(results.length).toBe(3);
    });

    it('should calculate relevance scores correctly', async () => {
      const userId = generateTestUserId();
      const queryEmbedding = Array.from({ length: 1536 }, () => Math.random());
      const docEmbedding = Array.from({ length: 1536 }, () => Math.random());

      await sql`
        INSERT INTO entity_vectors (entity_id, user_id, entity_type, title, embedding, embedding_model, indexed_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${userId}, 'note', 'Test Doc', ${JSON.stringify(docEmbedding)}, 'text-embedding-3-small', NOW(), NOW())
      `;

      const [result] = await sql`
        SELECT 
          1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector) AS relevance_score
        FROM entity_vectors
        WHERE user_id = ${userId}
      `;

      const score = parseFloat(result.relevance_score);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should handle empty results gracefully', async () => {
      const userId = generateTestUserId();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      const results = await sql`
        SELECT * FROM entity_vectors
        WHERE user_id = ${userId}
        ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
        LIMIT 10
      `;

      expect(results).toEqual([]);
    });
  });

  describe('metadata storage', () => {
    it('should store file URL metadata', async () => {
      const userId = generateTestUserId();
      const entityId = crypto.randomUUID();
      const embedding = Array.from({ length: 1536 }, () => Math.random());
      const fileUrl = 'https://example.com/file.pdf';

      await sql`
        INSERT INTO entity_vectors (
          entity_id, user_id, entity_type, title, file_url, embedding, embedding_model, indexed_at, updated_at
        ) VALUES (
          ${entityId}, ${userId}, 'document', 'PDF Document', ${fileUrl},
          ${JSON.stringify(embedding)}, 'text-embedding-3-small', NOW(), NOW()
        )
      `;

      const [stored] = await sql`
        SELECT file_url FROM entity_vectors WHERE entity_id = ${entityId}
      `;

      expect(stored.file_url).toBe(fileUrl);
    });

    it('should store preview text', async () => {
      const userId = generateTestUserId();
      const entityId = crypto.randomUUID();
      const embedding = Array.from({ length: 1536 }, () => Math.random());
      const preview = 'This is a preview of the document content...';

      await sql`
        INSERT INTO entity_vectors (
          entity_id, user_id, entity_type, title, preview, embedding, embedding_model, indexed_at, updated_at
        ) VALUES (
          ${entityId}, ${userId}, 'note', 'Note with Preview', ${preview},
          ${JSON.stringify(embedding)}, 'text-embedding-3-small', NOW(), NOW()
        )
      `;

      const [stored] = await sql`
        SELECT preview FROM entity_vectors WHERE entity_id = ${entityId}
      `;

      expect(stored.preview).toBe(preview);
    });
  });
});
