/**
 * Property ↔ Relation Auto-Sync
 *
 * Bridges entity_id properties with the relations table:
 *
 * Forward: entity property changes → auto-create/delete relation rows
 *   Called after entityRepo.update() when properties change.
 *
 * Reverse: relation create/delete → auto-set/clear entity properties
 *   Called after relationRepo.create() or .delete() in the relations router.
 *
 * No infinite loops because:
 *   - Forward sync writes directly to the relations table (bypasses relations router)
 *   - Reverse sync writes directly to the entities table (bypasses entity router)
 *   - Neither path triggers the other's sync hook
 */

import { getDb, drizzleSql, eq, and, isNotNull } from "@synap/database";
import {
  propertyDefs,
  relations,
  entities,
  relationDefs,
  PropertyValueType,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "property-relation-sync" });

// ─── Forward Sync: Property → Relation ────────────────────────────────────

/**
 * After an entity's properties change, sync entity_id property values
 * to the relations table.
 *
 * For each property_def with a relationDefId:
 *   - Value changed from A to B → delete relation to A, create relation to B
 *   - Value cleared → delete relation
 *   - Value set (was null) → create relation
 */
export async function syncPropertyToRelations(
  entityId: string,
  profileId: string,
  workspaceId: string,
  userId: string,
  oldProperties: Record<string, unknown>,
  newProperties: Record<string, unknown>
): Promise<void> {
  const db = await getDb();

  // Find property_defs for this profile with auto-sync enabled
  const syncableDefs = await db
    .select({
      slug: propertyDefs.slug,
      relationDefId: propertyDefs.relationDefId,
    })
    .from(propertyDefs)
    .where(
      and(
        eq(propertyDefs.profileId, profileId),
        eq(propertyDefs.valueType, PropertyValueType.ENTITY_ID),
        isNotNull(propertyDefs.relationDefId)
      )
    );

  if (syncableDefs.length === 0) return;

  // Fetch relation def slugs for all mapped defs
  const relDefIds = [...new Set(syncableDefs.map((d) => d.relationDefId!))];
  const relDefSlugMap = new Map<string, string>();

  for (const id of relDefIds) {
    const rd = await db.query.relationDefs.findFirst({
      where: eq(relationDefs.id, id),
      columns: { id: true, slug: true },
    });
    if (rd) relDefSlugMap.set(rd.id, rd.slug);
  }

  for (const propDef of syncableDefs) {
    const relTypeSlug = relDefSlugMap.get(propDef.relationDefId!);
    if (!relTypeSlug) continue;

    const oldValue = (oldProperties[propDef.slug] as string) ?? null;
    const newValue = (newProperties[propDef.slug] as string) ?? null;

    if (oldValue === newValue) continue;

    // Remove old relation if value changed or cleared
    if (oldValue) {
      try {
        await db
          .delete(relations)
          .where(
            and(
              eq(relations.sourceEntityId, entityId),
              eq(relations.targetEntityId, oldValue),
              eq(relations.type, relTypeSlug)
            )
          );
      } catch (err) {
        logger.warn(
          { entityId, oldValue, relTypeSlug, err },
          "Failed to delete synced relation"
        );
      }
    }

    // Create new relation if value set
    if (newValue) {
      // Check for existing to avoid duplicates (no unique constraint on relations)
      const existing = await db.query.relations.findFirst({
        where: and(
          eq(relations.sourceEntityId, entityId),
          eq(relations.targetEntityId, newValue),
          eq(relations.type, relTypeSlug)
        ),
      });

      if (!existing) {
        try {
          await db.insert(relations).values({
            userId,
            workspaceId,
            sourceEntityId: entityId,
            targetEntityId: newValue,
            type: relTypeSlug,
            metadata: { source: "property_sync", propertySlug: propDef.slug },
          });
        } catch (err) {
          logger.warn(
            { entityId, newValue, relTypeSlug, err },
            "Failed to create synced relation"
          );
        }
      }
    }
  }
}

// ─── Reverse Sync: Relation → Property ────────────────────────────────────

/**
 * After a relation is created, check if it maps to an entity_id property
 * and auto-set the property on the source entity.
 */
export async function syncRelationToPropertyOnCreate(
  sourceEntityId: string,
  targetEntityId: string,
  relationType: string,
  workspaceId: string
): Promise<void> {
  const mapped = await findMappedProperty(
    sourceEntityId,
    relationType,
    workspaceId
  );
  if (!mapped) return;

  const db = await getDb();

  try {
    await db.execute(
      drizzleSql`
        UPDATE entities
        SET properties = coalesce(properties, '{}'::jsonb) || jsonb_build_object(${mapped.propertySlug}::text, to_jsonb(${targetEntityId}::text)),
            updated_at = now()
        WHERE id = ${sourceEntityId}
      `
    );

    logger.info(
      { sourceEntityId, targetEntityId, propertySlug: mapped.propertySlug },
      "Reverse-synced relation to entity property"
    );
  } catch (err) {
    logger.warn(
      { sourceEntityId, targetEntityId, err },
      "Failed to reverse-sync relation to property"
    );
  }
}

/**
 * After a relation is deleted, check if it maps to an entity_id property
 * and auto-clear the property on the source entity (only if it still points
 * to the deleted target).
 */
export async function syncRelationToPropertyOnDelete(
  sourceEntityId: string,
  targetEntityId: string,
  relationType: string,
  workspaceId: string
): Promise<void> {
  const mapped = await findMappedProperty(
    sourceEntityId,
    relationType,
    workspaceId
  );
  if (!mapped) return;

  const db = await getDb();

  try {
    // Only clear if the property still points to the deleted target
    const entity = await db.query.entities.findFirst({
      where: eq(entities.id, sourceEntityId),
      columns: { properties: true },
    });

    const currentValue = (entity?.properties as Record<string, unknown>)?.[
      mapped.propertySlug
    ];
    if (currentValue !== targetEntityId) return;

    await db.execute(
      drizzleSql`
        UPDATE entities
        SET properties = properties - ${mapped.propertySlug}::text,
            updated_at = now()
        WHERE id = ${sourceEntityId}
      `
    );

    logger.info(
      { sourceEntityId, propertySlug: mapped.propertySlug },
      "Reverse-synced relation deletion to entity property"
    );
  } catch (err) {
    logger.warn(
      { sourceEntityId, err },
      "Failed to reverse-sync relation deletion to property"
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface MappedProperty {
  propertySlug: string;
  propertyDefId: string;
}

/**
 * Find a property_def that is mapped to the given relation type
 * for the source entity's profile.
 */
async function findMappedProperty(
  sourceEntityId: string,
  relationType: string,
  workspaceId: string
): Promise<MappedProperty | null> {
  const db = await getDb();

  // Get the entity's profile
  const entity = await db.query.entities.findFirst({
    where: eq(entities.id, sourceEntityId),
    columns: { profileId: true },
  });
  if (!entity?.profileId) return null;

  // Find the relation def by slug + workspace
  const relDef = await db.query.relationDefs.findFirst({
    where: and(
      eq(relationDefs.slug, relationType),
      eq(relationDefs.workspaceId, workspaceId)
    ),
  });
  if (!relDef) return null;

  // Find a property_def on this profile with this relationDefId
  const propDef = await db.query.propertyDefs.findFirst({
    where: and(
      eq(propertyDefs.profileId, entity.profileId),
      eq(propertyDefs.relationDefId, relDef.id)
    ),
  });
  if (!propDef) return null;

  return { propertySlug: propDef.slug, propertyDefId: propDef.id };
}
