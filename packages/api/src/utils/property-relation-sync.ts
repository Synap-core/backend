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

import { getDb, drizzleSql, eq, and } from "@synap/database";
import {
  propertyDefs,
  relations,
  entities,
  profiles,
  relationDefs,
  PropertyValueType,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { EXPOSURE_RELATION_TYPES } from "./project-scope.js";

const logger = createLogger({ module: "property-relation-sync" });

// ─── Forward Sync: Property → Relation ────────────────────────────────────

/** An entity_id property whose value is written as a `relations` row. */
export interface SyncedRelationDef {
  /** The property's slug (the key in `entities.properties`). */
  slug: string;
  /** The relation type its value syncs to (the relation_def's slug). */
  type: string;
  /** The kind its value points to (`targetProfileId`), when the def names one. */
  targetKind: string | null;
}

/**
 * The property defs of `profileId` that the forward sync writes as relations:
 * valueType ENTITY_ID with a relationDefId, exposure types left out (below).
 * Read by the sync and by the create door's required-link check, so the check
 * counts exactly the edges the sync writes.
 */
export async function readSyncedRelationDefs(
  profileId: string,
  database?: Awaited<ReturnType<typeof getDb>>
): Promise<SyncedRelationDef[]> {
  const db = database ?? (await getDb());
  const rows = await db
    .select({
      slug: propertyDefs.slug,
      type: relationDefs.slug,
      targetKind: profiles.slug,
    })
    .from(propertyDefs)
    .innerJoin(relationDefs, eq(relationDefs.id, propertyDefs.relationDefId))
    .leftJoin(profiles, eq(profiles.id, propertyDefs.targetProfileId))
    .where(
      and(
        eq(propertyDefs.profileId, profileId),
        eq(propertyDefs.valueType, PropertyValueType.ENTITY_ID)
      )
    );
  // A property must never mint or drop ANY exposure edge — `visible_to`
  // (would share a record with a project's guests without the share door) or
  // `belongs_to_project` (would file a record into a project, exposing it to
  // every project member, without `linkEntityToProject`'s existence and
  // visibility checks or the governed filing door). The set is IMPORTED, never
  // re-listed, so a third exposure type is skipped here by existing.
  //
  // The PROPERTY VALUE itself is left as written: it is plain data and grants
  // nothing. Filing is `projects.fileEntities` / MCP `synap_file_into_project`.
  return rows.filter(
    (r) => !(EXPOSURE_RELATION_TYPES as readonly string[]).includes(r.type)
  );
}

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
  workspaceId: string | null,
  userId: string,
  oldProperties: Record<string, unknown>,
  newProperties: Record<string, unknown>
): Promise<void> {
  const db = await getDb();

  // The property_defs of this profile with auto-sync enabled
  const syncableDefs = await readSyncedRelationDefs(profileId, db);

  for (const propDef of syncableDefs) {
    const relTypeSlug = propDef.type;

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
  workspaceId: string | null
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
  workspaceId: string | null
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
  workspaceId: string | null
): Promise<MappedProperty | null> {
  const db = await getDb();

  // Get the entity's profile
  const entity = await db.query.entities.findFirst({
    where: eq(entities.id, sourceEntityId),
    columns: { profileId: true },
  });
  if (!entity?.profileId) return null;

  // Relation defs are workspace-scoped — skip when workspace-less.
  if (!workspaceId) return null;

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
