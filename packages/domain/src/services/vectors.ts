import { db, entityVectors, searchEntityVectorsRaw } from '@synap/database';
import type { NewEntityVector, VectorRepositoryDatabase, VectorSearchRow } from '@synap/database';
import { createLogger } from '@synap/core';
import {
  UpsertEntityEmbeddingInputSchema,
  VectorSearchInputSchema,
  VectorSearchResultSchema,
  type UpsertEntityEmbeddingInput,
  type VectorSearchInput,
  type VectorSearchResult,
} from '../types.js';

const logger = createLogger({ module: 'vector-service' });

export class VectorService {
  constructor(private readonly database: typeof db = db) {}

  async upsertEntityEmbedding(input: UpsertEntityEmbeddingInput): Promise<void> {
    const parsed = UpsertEntityEmbeddingInputSchema.parse(input);
    const timestamp = new Date();

    const baseRecord: NewEntityVector = {
      entityId: parsed.entityId,
      userId: parsed.userId,
      entityType: parsed.entityType,
      title: parsed.title ?? null,
      preview: parsed.preview ?? null,
      fileUrl: parsed.fileUrl ?? null,
      embeddingModel: parsed.embeddingModel,
      embedding: parsed.embedding as NewEntityVector['embedding'],
      indexedAt: timestamp,
      updatedAt: timestamp,
    };

    await this.database
      .insert(entityVectors)
      .values(baseRecord)
      .onConflictDoUpdate({
        target: entityVectors.entityId,
        set: {
          embedding: parsed.embedding as NewEntityVector['embedding'],
          title: parsed.title ?? null,
          preview: parsed.preview ?? null,
          fileUrl: parsed.fileUrl ?? null,
          embeddingModel: parsed.embeddingModel,
          updatedAt: timestamp,
          userId: parsed.userId,
        },
      });
    logger.debug({ entityId: parsed.entityId }, 'Upserted entity embedding');
  }

  async searchByEmbedding(input: VectorSearchInput): Promise<VectorSearchResult[]> {
    const parsed = VectorSearchInputSchema.parse(input);

    // Use pgvector for fast semantic search
    const rawRows = await searchEntityVectorsRaw(this.database as unknown as VectorRepositoryDatabase, {
      userId: parsed.userId,
      embedding: parsed.embedding,
      limit: parsed.limit,
    });

    if (rawRows && rawRows.length > 0) {
      return rawRows.map((row: VectorSearchRow) => VectorSearchResultSchema.parse(row));
    }

    logger.warn('Vector repository search returned no results');
    return [];
  }
}

export const vectorService = new VectorService();


