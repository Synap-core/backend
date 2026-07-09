/**
 * Entity Embedding Worker
 *
 * Generates and stores embeddings for entities.
 * Ported from Inngest function: entity-embedding.ts
 */

import type PgBoss from "pg-boss";
import { sql, resolveDefaultIntelligenceEndpoint } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  buildEntityEmbeddingText,
  type EntityEmbeddingFacet,
} from "@synap/ai-embeddings";

const logger = createLogger({ module: "entity-embedding-worker" });

async function generateEmbedding(text: string): Promise<number[]> {
  const { endpoint, apiKey } = await resolveDefaultIntelligenceEndpoint();
  const response = await fetch(`${endpoint}/api/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
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

  let entityTitle = title;
  let entityPreview = preview;
  let type = entityType;
  let entityProperties: Record<string, unknown> | null = null;
  let entityFacets: EntityEmbeddingFacet[] = [];

  // Always load the row for `properties` (and as fallback for title/type/preview)
  // so the embedding includes typed properties — not just title+preview — which
  // is what lets semantic recall match type/role/property queries.
  {
    const { entities, eq, db, getEffectiveFacets } =
      await import("@synap/database");
    const [entity] = await db
      .select({
        title: entities.title,
        type: entities.type,
        preview: entities.preview,
        properties: entities.properties,
      })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    if (entity) {
      entityTitle = entityTitle || entity.title || "";
      entityPreview = entityPreview || entity.preview || "";
      type = type || entity.type;
      entityProperties =
        (entity.properties as Record<string, unknown> | null) ?? null;
    }

    // Live facets (Kind+Facets) — unfiltered lens, all workspaces, so the
    // embedding reflects every role attached to the entity regardless of scope.
    const effectiveFacets = await getEffectiveFacets(db, entityId, {
      userId,
      workspaceId: undefined,
    });
    entityFacets = effectiveFacets.map((ef) => ({
      slug: ef.profile.slug,
      status: ef.facet.status,
      properties: ef.facet.properties as Record<string, unknown> | null,
    }));
  }

  if (!entityTitle) {
    logger.warn(
      { entityId },
      "Entity not found or has no title, skipping embedding"
    );
    return;
  }

  const textToEmbed = buildEntityEmbeddingText({
    type,
    title: entityTitle,
    preview: entityPreview,
    properties: entityProperties,
    facets: entityFacets,
  });
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
