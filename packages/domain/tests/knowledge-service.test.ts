import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KnowledgeService } from '../src/services/knowledge.js';
import type {
  KnowledgeFact,
  RecordKnowledgeFactInput,
  SearchKnowledgeFactsInput,
} from '../src/types.js';

vi.mock('@synap/database', () => ({
  knowledgeRepository: {
    saveFact: () => {
      throw new Error('knowledgeRepository mock should not be called in unit tests');
    },
    searchFacts: () => {
      throw new Error('knowledgeRepository mock should not be called in unit tests');
    },
  },
}));

class InMemoryKnowledgeRepo {
  private readonly store = new Map<string, KnowledgeFact[]>();

  async saveFact(input: RecordKnowledgeFactInput & { embedding: number[] }): Promise<KnowledgeFact> {
    const createdAt = new Date();
    const fact: KnowledgeFact = {
      id: randomUUID(),
      userId: input.userId,
      fact: input.fact,
      confidence: input.confidence,
      sourceEntityId: input.sourceEntityId,
      sourceMessageId: input.sourceMessageId,
      createdAt,
    };

    const collection = this.store.get(input.userId) ?? [];
    collection.unshift(fact);
    this.store.set(input.userId, collection);

    return fact;
  }

  async searchFacts(input: SearchKnowledgeFactsInput): Promise<KnowledgeFact[]> {
    const collection = this.store.get(input.userId) ?? [];
    const tokens = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    return collection
      .filter((fact) => tokens.every((token) => fact.fact.toLowerCase().includes(token)))
      .slice(0, input.limit ?? 5);
  }
}

const FACT_DIMENSIONS = 1536;

const buildEmbedding = (seed: number): number[] =>
  Array.from({ length: FACT_DIMENSIONS }, (_, index) => ((seed + index) % 17) / 16);

describe('KnowledgeService', () => {
  it('records a fact and returns a normalized domain object', async () => {
    const service = new KnowledgeService(new InMemoryKnowledgeRepo() as any);

    const result = await service.recordFact({
      userId: 'user-test',
      fact: 'Le fondateur préfère les réponses concises.',
      confidence: 0.9,
      embedding: buildEmbedding(3),
    });

    expect(result.id).toMatch(/[0-9a-f-]{36}/);
    expect(result.userId).toBe('user-test');
    expect(result.fact).toContain('réponses concises');
    expect(result.confidence).toBeCloseTo(0.9);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('returns previously saved facts when searching', async () => {
    const service = new KnowledgeService(new InMemoryKnowledgeRepo() as any);

    await service.recordFact({
      userId: 'user-search',
      fact: 'Le projet Focus est prioritaire cette semaine.',
      confidence: 0.8,
      embedding: buildEmbedding(5),
    });

    const results = await service.searchFacts({
      userId: 'user-search',
      query: 'prioritaire Focus',
      limit: 5,
    });

    expect(results.length).toBe(1);
    expect(results[0].fact).toContain('Focus');
  });
});


