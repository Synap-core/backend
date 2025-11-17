import { sql } from 'drizzle-orm';

type VectorQuery = ReturnType<typeof sql>;

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
  execute?: (query: VectorQuery) => Promise<{ rows: VectorSearchRow[] }>;
  [key: string]: unknown;
}

export async function searchEntityVectorsRaw(
  database: VectorRepositoryDatabase,
  params: VectorSearchParams
): Promise<VectorSearchRow[] | null> {
  if (!database.execute) {
    return null;
  }

  const result = await database.execute(
    sql`
      SELECT
        entity_id as "entityId",
        user_id as "userId",
        entity_type as "entityType",
        title,
        preview,
        file_url as "fileUrl",
        (1 / (1 + (embedding <-> ${params.embedding}))) AS "relevanceScore"
      FROM entity_vectors
      WHERE user_id = ${params.userId}
      ORDER BY embedding <-> ${params.embedding}
      LIMIT ${params.limit}
    `
  );

  return result.rows;
}
