/**
 * Seed Property ↔ Relation Mappings
 *
 * Links entity_id property_defs to their corresponding relation_defs,
 * enabling the unified auto-sync (property writes ↔ relation rows).
 *
 * Must run AFTER ensureSystemProfiles() and ensureDefaultRelationDefs()
 * so that both the property_defs and relation_defs exist in the database.
 *
 * Current mappings:
 *   - task.assignee (entity_id) → assigned_to relation def, target: person profile
 *
 * Idempotent — skips if already set.
 */

import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../client-pg.js";
import { propertyDefs, PropertyValueType } from "../schema/property-defs.js";
import { relationDefs } from "../schema/relation-defs.js";
import { profiles } from "../schema/profiles.js";

export interface SeedMappingsResult {
  status: "updated" | "skipped" | "error";
  message: string;
  mappingsUpdated: number;
  error?: string;
}

/**
 * Property → Relation mapping definitions.
 * Each entry links a property_def to a relation_def and target profile.
 */
const PROPERTY_RELATION_MAPPINGS = [
  {
    propertySlug: "assignee",
    relationDefSlug: "assigned_to",
    targetProfileSlug: "person",
  },
];

export async function seedPropertyRelationMappings(
  workspaceId: string
): Promise<SeedMappingsResult> {
  try {
    const db = await getDb();
    let mappingsUpdated = 0;

    for (const mapping of PROPERTY_RELATION_MAPPINGS) {
      // Find the global property_def (profileId IS NULL = system-level def)
      const propDef = await db.query.propertyDefs.findFirst({
        where: and(
          eq(propertyDefs.slug, mapping.propertySlug),
          eq(propertyDefs.valueType, PropertyValueType.ENTITY_ID),
          isNull(propertyDefs.profileId)
        ),
      });
      if (!propDef) continue;

      // Skip if already mapped
      if (propDef.relationDefId) continue;

      // Find the relation_def in this workspace
      const relDef = await db.query.relationDefs.findFirst({
        where: and(
          eq(relationDefs.slug, mapping.relationDefSlug),
          eq(relationDefs.workspaceId, workspaceId)
        ),
      });
      if (!relDef) continue;

      // Find the target profile
      const targetProfile = await db.query.profiles.findFirst({
        where: eq(profiles.slug, mapping.targetProfileSlug),
      });

      // Update the property_def with the mapping
      await db
        .update(propertyDefs)
        .set({
          relationDefId: relDef.id,
          targetProfileId: targetProfile?.id ?? null,
          updatedAt: new Date(),
        })
        .where(eq(propertyDefs.id, propDef.id));

      mappingsUpdated++;
    }

    if (mappingsUpdated === 0) {
      return {
        status: "skipped",
        message: "All property↔relation mappings already set",
        mappingsUpdated: 0,
      };
    }

    return {
      status: "updated",
      message: `Set ${mappingsUpdated} property↔relation mapping(s)`,
      mappingsUpdated,
    };
  } catch (error) {
    return {
      status: "error",
      message: "Failed to seed property↔relation mappings",
      mappingsUpdated: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
