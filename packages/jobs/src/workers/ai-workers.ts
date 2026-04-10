/**
 * AI Analysis Worker
 *
 * Classifies entities that were created with profileSlug="capture" and
 * upgrades them to the correct typed profile (note, task, bookmark, etc.)
 * using the Intelligence Service via the Hub Protocol client.
 *
 * Triggered by: entities.create when profileSlug === "capture"
 * Queue name: "ai-analysis"
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "ai-workers" });

export async function handleAiAnalysis(
  job: PgBoss.Job<{
    entityId: string;
    workspaceId: string;
    userId: string;
  }>
): Promise<void> {
  const { entityId, userId, workspaceId } = job.data;

  logger.info({ entityId }, "AI entity classification job received");

  // 1. Fetch entity via Drizzle ORM
  const { db, entities, eq, and, getDb, EventRepository, EntityRepository } =
    await import("@synap/database");
  const { sql: dbSql } = await import("@synap/database");

  const [entity] = await db
    .select({
      id: entities.id,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      profileId: entities.profileId,
      type: entities.type,
    })
    .from(entities)
    .where(and(eq(entities.id, entityId), eq(entities.userId, userId)))
    .limit(1);

  if (!entity) {
    logger.warn({ entityId }, "Entity not found, skipping classification");
    return;
  }

  // Only enrich if still tagged as "capture" — avoids re-classifying
  if (entity.type !== "capture") {
    logger.debug(
      { entityId, type: entity.type },
      "Entity already classified, skipping"
    );
    return;
  }

  // 2. Build text for classification
  const props = (entity.properties ?? {}) as Record<string, unknown>;
  const url = typeof props.url === "string" ? props.url : undefined;
  const text = (entity.title || entity.preview || "").trim();

  if (!text && !url) {
    logger.warn({ entityId }, "Entity has no text or URL, skipping");
    return;
  }

  // 3. Call IS /api/structure via Hub Protocol client (not raw fetch)
  const { resolveIntelligenceService } =
    await import("@synap/intelligence-client");

  let structureResult: {
    entities: Array<{
      tempId: string;
      profileSlug: string;
      title: string;
      properties?: Record<string, unknown>;
      confidence: number;
    }>;
  } | null = null;

  try {
    const { client } = await resolveIntelligenceService({
      userId,
      workspaceId,
      capability: "default",
    });
    structureResult = await client.structure({ text: text || url!, url });
  } catch (err) {
    logger.warn({ err, entityId }, "IS structure call failed, skipping update");
    return;
  }

  const classified = structureResult?.entities?.[0];
  if (!classified || classified.profileSlug === "capture") {
    logger.debug(
      { entityId },
      "Classification unchanged or unavailable, skipping update"
    );
    return;
  }

  // 4. Update entity via EntityRepository (handles profile resolution + event chain)
  const mergedProperties = {
    ...props,
    ...(classified.properties ?? {}),
  };

  const database = await getDb();
  const eventRepo = new EventRepository(dbSql);
  const entityRepo = new EntityRepository(database, eventRepo);

  await entityRepo.update(
    entityId,
    {
      title: classified.title || undefined,
      properties: mergedProperties,
      profileSlug: classified.profileSlug,
      // Thread workspace lens so overlay props validate/index correctly
      workspaceId,
    },
    userId
  );

  logger.info(
    {
      entityId,
      profileSlug: classified.profileSlug,
      confidence: classified.confidence,
    },
    "Entity classified and profile upgraded"
  );
}
