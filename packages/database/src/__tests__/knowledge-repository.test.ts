/**
 * KnowledgeRepository Tests
 * 
 * Tests for knowledge fact storage and retrieval.
 * Validates fact creation, querying, and user isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '../index.js';
import { generateTestUserId } from './test-utils.js';

describe('KnowledgeRepository', () => {
  beforeAll(async () => {
    await sql`DELETE FROM knowledge_facts WHERE user_id LIKE 'test-%'`;
  });

  afterAll(async () => {
    await sql`DELETE FROM knowledge_facts WHERE user_id LIKE 'test-%'`;
  });

  describe('fact storage', () => {
    it('should store knowledge fact successfully', async () => {
      const userId = generateTestUserId();
      const factId = crypto.randomUUID();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, fact, confidence, embedding, created_at
        ) VALUES (
          ${factId}, ${userId}, 'Paris is the capital of France', 0.95, ${JSON.stringify(embedding)}, NOW()
        )
      `;

      const [stored] = await sql`
        SELECT * FROM knowledge_facts WHERE id = ${factId}
      `;

      expect(stored.fact).toBe('Paris is the capital of France');
      expect(parseFloat(stored.confidence)).toBe(0.95);
    });

    it('should handle different fact types', async () => {
      const userId = generateTestUserId();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      const facts = [
        'John works at Google',
        'Einstein was born in 1879',
        'Water boils at 100°C'
      ];

      for (const fact of facts) {
        await sql`
          INSERT INTO knowledge_facts (
            id, user_id, fact, confidence, embedding, created_at
          ) VALUES (
            ${crypto.randomUUID()}, ${userId}, ${fact}, 
            0.9, ${JSON.stringify(embedding)}, NOW()
          )
        `;
      }

      const stored = await sql`
        SELECT * FROM knowledge_facts WHERE user_id = ${userId}
      `;

      expect(stored.length).toBe(3);
      const storedFacts = stored.map(f => f.fact);
      expect(storedFacts).toContain('John works at Google');
      expect(storedFacts).toContain('Einstein was born in 1879');
      expect(storedFacts).toContain('Water boils at 100°C');
    });

    it('should enforce user isolation', async () => {
      const user1 = generateTestUserId();
      const user2 = generateTestUserId();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, fact, confidence, embedding, created_at
        ) VALUES 
          (${crypto.randomUUID()}, ${user1}, 'Fact1 Subject', 0.9, ${JSON.stringify(embedding)}, NOW()),
          (${crypto.randomUUID()}, ${user2}, 'Fact2 Subject', 0.9, ${JSON.stringify(embedding)}, NOW())
      `;

      const user1Facts = await sql`
        SELECT * FROM knowledge_facts WHERE user_id = ${user1}
      `;

      expect(user1Facts.length).toBe(1);
      expect(user1Facts[0].fact).toBe('Fact1 Subject');
    });
  });

  describe('fact querying', () => {
    it('should query facts by keyword', async () => {
      const userId = generateTestUserId();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, fact, confidence, embedding, created_at
        ) VALUES 
          (${crypto.randomUUID()}, ${userId}, 'Paris is the capital of France', 0.95, ${JSON.stringify(embedding)}, NOW()),
          (${crypto.randomUUID()}, ${userId}, 'Paris has population 2.1M', 0.9, ${JSON.stringify(embedding)}, NOW()),
          (${crypto.randomUUID()}, ${userId}, 'London is the capital of UK', 0.95, ${JSON.stringify(embedding)}, NOW())
      `;

      const parisFacts = await sql`
        SELECT * FROM knowledge_facts 
        WHERE user_id = ${userId} AND fact LIKE '%Paris%'
      `;

      expect(parisFacts.length).toBe(2);
      expect(parisFacts.every(f => f.fact.includes('Paris'))).toBe(true);
    });

    it('should handle confidence filtering', async () => {
      const userId = generateTestUserId();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, fact, confidence, embedding, created_at
        ) VALUES 
          (${crypto.randomUUID()}, ${userId}, 'Fact1', 0.95, ${JSON.stringify(embedding)}, NOW()),
          (${crypto.randomUUID()}, ${userId}, 'Fact2', 0.5, ${JSON.stringify(embedding)}, NOW()),
          (${crypto.randomUUID()}, ${userId}, 'Fact3', 0.3, ${JSON.stringify(embedding)}, NOW())
      `;

      const highConfidence = await sql`
        SELECT * FROM knowledge_facts 
        WHERE user_id = ${userId} AND confidence >= 0.8
      `;

      expect(highConfidence.length).toBe(1);
      expect(highConfidence[0].fact).toBe('Fact1');
    });
  });

  describe('metadata', () => {
    it('should track source entity', async () => {
      const userId = generateTestUserId();
      const factId = crypto.randomUUID();
      const sourceEntityId = crypto.randomUUID();
      const embedding = Array.from({ length: 1536 }, () => Math.random());

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, fact, confidence, source_entity_id, embedding, created_at
        ) VALUES (
          ${factId}, ${userId}, 'Subject', 0.9, ${sourceEntityId}, ${JSON.stringify(embedding)}, NOW()
        )
      `;

      const [stored] = await sql`
        SELECT source_entity_id FROM knowledge_facts WHERE id = ${factId}
      `;

      expect(stored.source_entity_id).toBe(sourceEntityId);
    });
  });
});
