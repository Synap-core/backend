import { sql } from '../client-pg.js';

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
  // Use JSON.stringify with ::vector cast (proven pattern from repository tests)
  // This is the same approach used in all 10 passing repository tests
  // See: packages/database/src/__tests__/vector-repository.test.ts
  
  const results = await sql<VectorSearchRow[]>`
    SELECT
      entity_id as "entityId",
      user_id as "userId",
      entity_type as "entityType",
      title,
      preview,
      file_url as "fileUrl",
      (1 - (embedding <=> ${JSON.stringify(params.embedding)}::vector)) AS "relevanceScore"
    FROM entity_vectors
    WHERE user_id = ${params.userId}
    ORDER BY embedding <=> ${JSON.stringify(params.embedding)}::vector
    LIMIT ${params.limit}
  `;

  return results;
}
