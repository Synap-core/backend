/**
 * Knowledge Repository - Knowledge Facts Management
 * 
 * Uses shared postgres.js client from client-pg.ts
 */

import { sql } from '../client-pg.js';
import { randomUUID } from 'crypto';
import type { KnowledgeFactRow } from '../schema/knowledge-facts.js';

export interface SaveKnowledgeFactInput {
  userId: string;
  fact: string;
  confidence: number;
  embedding: number[];
  sourceEntityId?: string;
  sourceMessageId?: string;
}

export interface KnowledgeFactRecord {
  id: string;
  userId: string;
  fact: string;
  confidence: number;
  sourceEntityId?: string;
  sourceMessageId?: string;
  createdAt: Date;
}

export interface SearchKnowledgeFactsInput {
  userId: string;
  query: string;
  limit?: number;
}

type MemoryStore = Map<string, KnowledgeFactRecord[]>;

export class KnowledgeRepository {
  private readonly useDatabase: boolean;
  private readonly memoryStore?: MemoryStore;

  constructor(useDatabase: boolean = true) {
    this.useDatabase = useDatabase;
    if (!useDatabase) {
      this.memoryStore = new Map();
    }
  }

  async saveFact(input: SaveKnowledgeFactInput): Promise<KnowledgeFactRecord> {
    this.ensureEmbeddingDimensions(input.embedding);

    if (this.useDatabase) {
      const embeddingVector = this.embedToPgVector(input.embedding);

      const result = await sql`
        INSERT INTO knowledge_facts (
          user_id,
          fact,
          confidence,
          source_entity_id,
          source_message_id,
          embedding
        ) VALUES (
          ${input.userId}, 
          ${input.fact}, 
          ${input.confidence}, 
          ${input.sourceEntityId || null}, 
          ${input.sourceMessageId || null}, 
          ${embeddingVector}::vector
        )
        RETURNING *
      `;

      return this.mapRow(result[0]);
    }

    if (!this.memoryStore) {
      throw new Error('Knowledge repository not initialised.');
    }

    const factRecord: KnowledgeFactRecord = {
      id: randomUUID(),
      userId: input.userId,
      fact: input.fact,
      confidence: input.confidence,
      sourceEntityId: input.sourceEntityId,
      sourceMessageId: input.sourceMessageId,
      createdAt: new Date(),
    };

    const store = this.memoryStore.get(input.userId) ?? [];
    store.unshift(factRecord);
    this.memoryStore.set(input.userId, store);

    return factRecord;
  }

  async searchFacts(input: SearchKnowledgeFactsInput): Promise<KnowledgeFactRecord[]> {
    const { userId, query, limit = 10 } = input;

    const facts = await this.fetchFacts(userId, Math.max(limit * 3, limit));

    if (facts.length === 0) {
      return [];
    }

    const scored = facts
      .map((fact) => ({
        fact,
        score: this.computeRelevanceScore(query, fact.fact),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return facts.slice(0, Math.min(limit, facts.length));
    }

    return scored.slice(0, limit).map((entry) => entry.fact);
  }

  private async fetchFacts(userId: string, limit: number): Promise<KnowledgeFactRecord[]> {
    if (this.useDatabase) {
      const dbResult = await sql`
        SELECT * FROM knowledge_facts
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      return dbResult.map((row) => this.mapRow(row));
    }

    if (!this.memoryStore) {
      return [];
    }

    const entries = this.memoryStore.get(userId) ?? [];
    return entries.slice(0, limit);
  }

  private ensureEmbeddingDimensions(embedding: number[]) {
    if (embedding.length !== 1536) {
      throw new Error(`Knowledge embeddings must have 1536 dimensions. Received ${embedding.length}.`);
    }
  }

  private embedToPgVector(embedding: number[]): string {
    const formatted = embedding.map((value) => value.toFixed(6)).join(',');
    return `[${formatted}]`;
  }

  private computeRelevanceScore(query: string, fact: string): number {
    const queryTokens = this.tokenize(query);
    if (queryTokens.size === 0) {
      return 0;
    }

    const factTokens = this.tokenize(fact);
    let overlap = 0;
    for (const token of queryTokens) {
      if (factTokens.has(token)) {
        overlap += 1;
      }
    }

    return overlap / queryTokens.size;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9àâçéèêëîïôûùüÿñæœ]+/u)
        .filter(Boolean)
    );
  }

  private mapRow(row: KnowledgeFactRow | Record<string, unknown>): KnowledgeFactRecord {
    const raw = row as Record<string, unknown>;

    const id = (raw.id ?? raw['id']) as string;
    const userId = (raw.userId ?? raw['user_id']) as string;
    const fact = (raw.fact ?? raw['fact']) as string;
    const confidenceValue = raw.confidence ?? raw['confidence'];
    const confidence = typeof confidenceValue === 'number' ? confidenceValue : Number(confidenceValue ?? 0);
    const sourceEntityId = (raw.sourceEntityId ?? raw['source_entity_id']) as string | null | undefined;
    const sourceMessageId = (raw.sourceMessageId ?? raw['source_message_id']) as string | null | undefined;
    const createdAtRaw = raw.createdAt ?? raw['created_at'];
    const createdAt = createdAtRaw instanceof Date ? createdAtRaw : new Date(createdAtRaw as string | number | Date);

    return {
      id,
      userId,
      fact,
      confidence,
      sourceEntityId: sourceEntityId ?? undefined,
      sourceMessageId: sourceMessageId ?? undefined,
      createdAt,
    };
  }
}

let _knowledgeRepository: KnowledgeRepository | null = null;

export function getKnowledgeRepository(): KnowledgeRepository {
  if (!_knowledgeRepository) {
    const isPostgres = process.env.DB_DIALECT === 'postgres';
    const connectionString = process.env.DATABASE_URL;

    if (isPostgres && connectionString) {
      _knowledgeRepository = new KnowledgeRepository(true);
    } else {
      _knowledgeRepository = new KnowledgeRepository(false);
    }
  }

  return _knowledgeRepository;
}

export const knowledgeRepository = getKnowledgeRepository();
