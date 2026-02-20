/**
 * Entity Embedding Worker
 *
 * Generates and stores embeddings for entities.
 * Ported from Inngest function: entity-embedding.ts
 */

import type PgBoss from "pg-boss";
import { sql } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "entity-embedding-worker" });

const INTELLIGENCE_HUB_URL =
  process.env.INTELLIGENCE_HUB_URL || "http://localhost:3001";
const INTELLIGENCE_HUB_API_KEY = process.env.INTELLIGENCE_HUB_API_KEY || "";

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${INTELLIGENCE_HUB_URL}/api/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": INTELLIGENCE_HUB_API_KEY,
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error(`Failed to generate embedding: ${response.statusText}`);
  }

  const data = await response.json();
  return (data as { embedding: number[] }).embedding;
}

export async function handleEntityEmbedding(
  job: PgBoss.Job<{
    entityId: string;
    userId: string;
    workspaceId?: string;
    entityType?: string;
    title?: string;
    preview?: string;
  }>
): Promise<void> {
  const { entityId, userId, entityType, title, preview } = job.data;

  // If title not provided, fetch from DB
  let entityTitle = title;
  let entityPreview = preview;
  let type = entityType;

  if (!entityTitle) {
    const { entities, eq } = await import("@synap/database");
    const { db } = await import("@synap/database");
    const [entity] = await db
      .select({ title: entities.title, type: entities.type, preview: entities.preview })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    if (entity) {
      entityTitle = entity.title || "";
      entityPreview = entity.preview || "";
      type = entity.type;
    }
  }

  if (!entityTitle) {
    logger.warn({ entityId }, "Entity not found or has no title, skipping embedding");
    return;
  }

  const textToEmbed = `${entityTitle} ${entityPreview || ""}`.trim();
  const embedding = await generateEmbedding(textToEmbed);
  const embeddingStr = `[${embedding.join(",")}]`;

  await sql`
    INSERT INTO entity_vectors (entity_id, user_id, embedding, entity_type, title, preview)
    VALUES (${entityId}, ${userId}, ${embeddingStr}::vector, ${type || "entity"}, ${entityTitle}, ${entityPreview || null})
    ON CONFLICT (entity_id) DO UPDATE SET
      embedding = ${embeddingStr}::vector,
      title = ${entityTitle},
      preview = ${entityPreview || null},
      updated_at = NOW()
  `;

  logger.info({ entityId }, "Entity embedding generated");
}
