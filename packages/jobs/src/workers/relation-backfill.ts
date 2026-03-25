/**
 * Relation Backfill Worker
 *
 * One-time job that creates relation rows for existing entity_id property values
 * that have a relationDefId mapping. This bridges the gap for data created before
 * the unified relation sync was implemented.
 *
 * Idempotent — checks for existing relations before inserting.
 *
 * Job data: { workspaceId: string, userId: string }
 */

import type PgBoss from "pg-boss";
import { eq, and, isNotNull } from "drizzle-orm";
import { getDb } from "@synap/database";
import {
  propertyDefs,
  entities,
  relations,
  relationDefs,
  PropertyValueType,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "relation-backfill" });

export async function handleRelationBackfill(
  job: PgBoss.Job<{ workspaceId: string; userId: string }>
): Promise<void> {
  const { workspaceId, userId } = job.data;
  const db = await getDb();

  logger.info({ workspaceId }, "Starting relation backfill");

  // Find all property_defs with entity_id type AND a relationDefId mapping
  const syncableDefs = await db
    .select({
      id: propertyDefs.id,
      slug: propertyDefs.slug,
      profileId: propertyDefs.profileId,
      relationDefId: propertyDefs.relationDefId,
    })
    .from(propertyDefs)
    .where(
      and(
        eq(propertyDefs.valueType, PropertyValueType.ENTITY_ID),
        isNotNull(propertyDefs.relationDefId)
      )
    );

  if (syncableDefs.length === 0) {
    logger.info(
      { workspaceId },
      "No syncable property defs found, skipping backfill"
    );
    return;
  }

  // Build a map of relationDefId → slug for relation creation
  const relDefIds = [...new Set(syncableDefs.map((d) => d.relationDefId!))];
  const relDefSlugMap = new Map<string, string>();

  for (const id of relDefIds) {
    const rd = await db.query.relationDefs.findFirst({
      where: eq(relationDefs.id, id),
      columns: { id: true, slug: true },
    });
    if (rd) relDefSlugMap.set(rd.id, rd.slug);
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const propDef of syncableDefs) {
    const relTypeSlug = relDefSlugMap.get(propDef.relationDefId!);
    if (!relTypeSlug) continue;

    // Find all entities with this profile that have a value for this property
    const matchingEntities = await db.query.entities.findMany({
      where: and(
        eq(entities.profileId, propDef.profileId!),
        eq(entities.workspaceId, workspaceId)
      ),
      columns: { id: true, properties: true },
    });

    for (const entity of matchingEntities) {
      const props = entity.properties as Record<string, unknown> | null;
      if (!props) continue;

      const targetEntityId = props[propDef.slug];
      if (!targetEntityId || typeof targetEntityId !== "string") continue;

      // Check if relation already exists
      const existing = await db.query.relations.findFirst({
        where: and(
          eq(relations.sourceEntityId, entity.id),
          eq(relations.targetEntityId, targetEntityId),
          eq(relations.type, relTypeSlug)
        ),
      });

      if (existing) {
        skipped++;
        continue;
      }

      // Create the relation
      try {
        await db.insert(relations).values({
          userId,
          workspaceId,
          sourceEntityId: entity.id,
          targetEntityId,
          type: relTypeSlug,
          metadata: { source: "backfill", propertySlug: propDef.slug },
        });
        created++;
      } catch (err) {
        errors++;
        logger.warn(
          { entityId: entity.id, targetEntityId, relTypeSlug, err },
          "Failed to create backfill relation"
        );
      }
    }
  }

  logger.info(
    { workspaceId, created, skipped, errors },
    "Relation backfill complete"
  );
}
