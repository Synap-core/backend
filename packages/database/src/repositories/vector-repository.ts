import { sql } from '../client-pg.js';
import pgvector from 'pgvector';

export interface VectorSearchParams {
  userId: string;
  embedding: number[];
  limit: number;
}

export interface VectorSearchRow {
  entityId: string;
  userId: string;
  entityType: string;
  title: string | null;
  preview: string | null;
  fileUrl: string | null;
  relevanceScore: number;
}

export interface VectorRepositoryDatabase {
  [key: string]: unknown;
}

export async function searchEntityVectorsRaw(
  _database: VectorRepositoryDatabase,
  params: VectorSearchParams
): Promise<VectorSearchRow[] | null> {
  // Use raw postgres.js directly, bypassing Drizzle
  // Drizzle's SQL builder unwraps pgvector.toSql() values and re-parameterizes them,
  // which breaks the postgres.js type serialization
  
  const embeddingWrapped = pgvector.toSql(params.embedding);
  
  console.log('[DEBUG] embeddingWrapped type:', typeof embeddingWrapped);
  console.log('[DEBUG] embeddingWrapped value (first 50):', String(embeddingWrapped).substring(0, 50));
  console.log('[DEBUG] Using postgres.js sql instance:', sql.constructor.name);
  
  const results = await sql<VectorSearchRow[]>`
    SELECT
      entity_id as "entityId",
      user_id as "userId",
      entity_type as "entityType",
      title,
      preview,
      file_url as "fileUrl",
      (1 - (embedding <-> ${embeddingWrapped})) AS "relevanceScore"
    FROM entity_vectors
    WHERE user_id = ${params.userId}
    ORDER BY embedding <-> ${embeddingWrapped}
    LIMIT ${params.limit}
  `;

  console.log('[DEBUG] Query returned:', results.length, 'rows');
  return results;
}
