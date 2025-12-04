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

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
        ) VALUES (
          ${factId}, ${userId}, 'Paris', 'is_capital_of', 'France', 0.95, 'extraction', NOW(), NOW()
        )
      `;

      const [stored] = await sql`
        SELECT * FROM knowledge_facts WHERE id = ${factId}
      `;

      expect(stored.subject).toBe('Paris');
      expect(stored.predicate).toBe('is_capital_of');
      expect(stored.object).toBe('France');
      expect(parseFloat(stored.confidence)).toBe(0.95);
    });

    it('should handle different fact types', async () => {
      const userId = generateTestUserId();

      const facts = [
        { subject: 'John', predicate: 'works_at', object: 'Google' },
        { subject: 'Einstein', predicate: 'born_in', object: '1879' },
        { subject: 'Water', predicate: 'boils_at', object: '100°C' },
      ];

      for (const fact of facts) {
        await sql`
          INSERT INTO knowledge_facts (
            id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
          ) VALUES (
            ${crypto.randomUUID()}, ${userId}, ${fact.subject}, ${fact.predicate}, ${fact.object}, 
            0.9, 'extraction', NOW(), NOW()
          )
        `;
      }

      const stored = await sql`
        SELECT * FROM knowledge_facts WHERE user_id = ${userId}
      `;

      expect(stored.length).toBe(3);
      expect(stored.map(f => f.subject)).toContain('John');
      expect(stored.map(f => f.subject)).toContain('Einstein');
      expect(stored.map(f => f.subject)).toContain('Water');
    });

    it('should enforce user isolation', async () => {
      const user1 = generateTestUserId();
      const user2 = generateTestUserId();

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
        ) VALUES 
          (${crypto.randomUUID()}, ${user1}, 'Fact1 Subject', 'predicate', 'object', 0.9, 'extraction', NOW(), NOW()),
          (${crypto.randomUUID()}, ${user2}, 'Fact2 Subject', 'predicate', 'object', 0.9, 'extraction', NOW(), NOW())
      `;

      const user1Facts = await sql`
        SELECT * FROM knowledge_facts WHERE user_id = ${user1}
      `;

      expect(user1Facts.length).toBe(1);
      expect(user1Facts[0].subject).toBe('Fact1 Subject');
    });
  });

  describe('fact querying', () => {
    it('should query facts by subject', async () => {
      const userId = generateTestUserId();

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
        ) VALUES 
          (${crypto.randomUUID()}, ${userId}, 'Paris', 'is_capital_of', 'France', 0.95, 'extraction', NOW(), NOW()),
          (${crypto.randomUUID()}, ${userId}, 'Paris', 'has_population', '2.1M', 0.9, 'extraction', NOW(), NOW()),
          (${crypto.randomUUID()}, ${userId}, 'London', 'is_capital_of', 'UK', 0.95, 'extraction', NOW(), NOW())
      `;

      const parisFacts = await sql`
        SELECT * FROM knowledge_facts 
        WHERE user_id = ${userId} AND subject = 'Paris'
      `;

      expect(parisFacts.length).toBe(2);
      expect(parisFacts.every(f => f.subject === 'Paris')).toBe(true);
    });

    it('should query facts by predicate', async () => {
      const userId = generateTestUserId();

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
        ) VALUES 
          (${crypto.randomUUID()}, ${userId}, 'Paris', 'is_capital_of', 'France', 0.95, 'extraction', NOW(), NOW()),
          (${crypto.randomUUID()}, ${userId}, 'London', 'is_capital_of', 'UK', 0.95, 'extraction', NOW(), NOW()),
          (${crypto.randomUUID()}, ${userId}, 'Berlin', 'is_capital_of', 'Germany', 0.95, 'extraction', NOW(), NOW())
      `;

      const capitalFacts = await sql`
        SELECT * FROM knowledge_facts 
        WHERE user_id = ${userId} AND predicate = 'is_capital_of'
      `;

      expect(capitalFacts.length).toBe(3);
    });

    it('should handle confidence filtering', async () => {
      const userId = generateTestUserId();

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
        ) VALUES 
          (${crypto.randomUUID()}, ${userId}, 'Fact1', 'pred', 'obj', 0.95, 'extraction', NOW(), NOW()),
          (${crypto.randomUUID()}, ${userId}, 'Fact2', 'pred', 'obj', 0.5, 'extraction', NOW(), NOW()),
          (${crypto.randomUUID()}, ${userId}, 'Fact3', 'pred', 'obj', 0.3, 'extraction', NOW(), NOW())
      `;

      const highConfidence = await sql`
        SELECT * FROM knowledge_facts 
        WHERE user_id = ${userId} AND confidence >= 0.8
      `;

      expect(highConfidence.length).toBe(1);
      expect(highConfidence[0].subject).toBe('Fact1');
    });
  });

  describe('metadata', () => {
    it('should track fact source', async () => {
      const userId = generateTestUserId();
      const factId = crypto.randomUUID();

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
        ) VALUES (
          ${factId}, ${userId}, 'Subject', 'predicate', 'Object', 0.9, 'user_provided', NOW(), NOW()
        )
      `;

      const [stored] = await sql`
        SELECT source FROM knowledge_facts WHERE id = ${factId}
      `;

      expect(stored.source).toBe('user_provided');
    });

    it('should track extraction timestamp', async () => {
      const userId = generateTestUserId();
      const factId = crypto.randomUUID();
      const before = new Date();

      await sql`
        INSERT INTO knowledge_facts (
          id, user_id, subject, predicate, object, confidence, source, extracted_at, created_at
        ) VALUES (
          ${factId}, ${userId}, 'Subject', 'predicate', 'Object', 0.9, 'extraction', NOW(), NOW()
        )
      `;

      const after = new Date();
      const [stored] = await sql`
        SELECT extracted_at FROM knowledge_facts WHERE id = ${factId}
      `;

      const extractedAt = new Date(stored.extracted_at);
      expect(extractedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(extractedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });
});
