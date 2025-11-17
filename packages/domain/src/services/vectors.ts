import { db, entityVectors, searchEntityVectorsRaw } from '@synap/database';
import type { EntityVector, NewEntityVector, VectorRepositoryDatabase, VectorSearchRow } from '@synap/database';
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

const DIALECT = (process.env.DB_DIALECT ?? 'sqlite').toLowerCase();
const isPostgres = DIALECT === 'postgres';

const hasUserIdColumn = () => 'userId' in (entityVectors as Record<string, unknown>);

const toStoredEmbedding = (embedding: number[]) =>
  isPostgres ? embedding : JSON.stringify(embedding);

const computeCosineSimilarity = (a: number[], b: number[]): number => {
  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let index = 0; index < a.length && index < b.length; index += 1) {
    const aValue = a[index];
    const bValue = b[index];
    dot += aValue * bValue;
    aMagnitude += aValue * aValue;
    bMagnitude += bValue * bValue;
  }

  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
};

export class VectorService {
  constructor(private readonly database: typeof db = db) {}

  async upsertEntityEmbedding(input: UpsertEntityEmbeddingInput): Promise<void> {
    const parsed = UpsertEntityEmbeddingInputSchema.parse(input);
    const timestamp = new Date();

    const baseRecord: NewEntityVector = {
      entityId: parsed.entityId,
      entityType: parsed.entityType,
      title: parsed.title ?? null,
      preview: parsed.preview ?? null,
      fileUrl: parsed.fileUrl ?? null,
      embeddingModel: parsed.embeddingModel,
      embedding: toStoredEmbedding(parsed.embedding) as NewEntityVector['embedding'],
      indexedAt: timestamp,
      updatedAt: timestamp,
      ...(hasUserIdColumn() ? { userId: parsed.userId } : {}),
    } as NewEntityVector;

    await this.database
      .insert(entityVectors)
      .values(baseRecord)
      .onConflictDoUpdate({
        target: (entityVectors as { entityId: unknown }).entityId as never,
        set: {
          embedding: toStoredEmbedding(parsed.embedding) as NewEntityVector['embedding'],
          title: parsed.title ?? null,
          preview: parsed.preview ?? null,
          fileUrl: parsed.fileUrl ?? null,
          embeddingModel: parsed.embeddingModel,
          updatedAt: timestamp,
          ...(hasUserIdColumn() ? { userId: parsed.userId } : {}),
        },
      });
    logger.debug({ entityId: parsed.entityId }, 'Upserted entity embedding');
  }

  async searchByEmbedding(input: VectorSearchInput): Promise<VectorSearchResult[]> {
    const parsed = VectorSearchInputSchema.parse(input);

    if (isPostgres) {
      const rawRows = await searchEntityVectorsRaw(this.database as unknown as VectorRepositoryDatabase, {
        userId: parsed.userId,
        embedding: parsed.embedding,
        limit: parsed.limit,
      });

      if (rawRows && rawRows.length > 0) {
        return rawRows.map((row: VectorSearchRow) => VectorSearchResultSchema.parse(row));
      }

      logger.warn('Vector repository search unavailable; falling back to in-memory similarity search.');
    }

    const allRows = (await this.database.select().from(entityVectors).limit(500)) as EntityVector[];
    const filteredRows = hasUserIdColumn()
      ? allRows.filter((row) => (row as Partial<EntityVector> & { userId?: string }).userId === parsed.userId)
      : allRows;

    const scored = filteredRows
      .map((row) => {
        const storedEmbedding = typeof row.embedding === 'string'
          ? (JSON.parse(row.embedding) as number[])
          : (row.embedding as number[]);

        const score = computeCosineSimilarity(parsed.embedding, storedEmbedding);

        return VectorSearchResultSchema.parse({
          entityId: row.entityId,
          userId: parsed.userId,
          entityType: row.entityType,
          title: row.title ?? null,
          preview: row.preview ?? null,
          fileUrl: row.fileUrl ?? null,
          relevanceScore: score,
        });
      })
      .filter((item) => item.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, parsed.limit);

    return scored;
  }
}

export const vectorService = new VectorService();


