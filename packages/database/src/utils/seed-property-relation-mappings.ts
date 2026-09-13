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
 *   - task.assignee (entity_id)   → assigned_to relation def,      target: person profile
 *   - task.projectId (entity_id)  → belongs_to_project relation def, target: project profile
 *   - contact.companyId (entity_id) → works_at relation def,        target: company profile
 *   - deal.contactId (entity_id)  → deal_for relation def,          target: contact profile
 *
 * Idempotent — skips if already set.
 */

import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../client-pg.js";
import { propertyDefs, PropertyValueType } from "../schema/property-defs.js";
import {
  RelationDefRepository,
  pickDefForWorkspace,
} from "../repositories/relation-def-repository.js";
import { ProfileRepository } from "../repositories/profile-repository.js";

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
  {
    propertySlug: "projectId",
    relationDefSlug: "belongs_to_project",
    targetProfileSlug: "project",
  },
  {
    propertySlug: "companyId",
    relationDefSlug: "works_at",
    targetProfileSlug: "company",
  },
  {
    propertySlug: "contactId",
    relationDefSlug: "deal_for",
    targetProfileSlug: "contact",
  },
];

export async function seedPropertyRelationMappings(
  workspaceId: string
): Promise<SeedMappingsResult> {
  try {
    const db = await getDb();
    const relDefRepo = new RelationDefRepository(db);
    const profileRepo = new ProfileRepository(db);
    // ONE read of everything visible from this workspace — its own rows PLUS the
    // pod-wide base rows — then resolve precedence in JS via the shared SSOT.
    const visibleDefs = await relDefRepo.list(workspaceId);
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

      // Resolve the relation_def through the ONE door: workspace row first,
      // pod-wide (workspace_id IS NULL) base row second. A strictly
      // workspace-scoped lookup here was a silent-skip cascade: once the 22
      // defaults exist pod-wide, ensureDefaultRelationDefs creates ZERO
      // workspace rows for a new workspace (correctly — the base layer covers
      // it), and this lookup would then find nothing and leave
      // property_defs.relation_def_id unset FOREVER, with no error anywhere,
      // because relations still resolve via the same fallback at the capture door.
      const relDef = pickDefForWorkspace(
        visibleDefs,
        mapping.relationDefSlug,
        workspaceId
      );
      if (!relDef) {
        // Neither a workspace row nor a pod-wide base row exists.
        console.warn(
          `[seed-property-relation-mappings] relation_def "${mapping.relationDefSlug}" not found for workspace ${workspaceId} ` +
            "or pod-wide. Run ensureDefaultRelationDefs() first."
        );
        continue;
      }

      // Find the target profile. The property_def being stamped is GLOBAL
      // (profileId IS NULL, visible from every workspace), so its target must
      // be a POD-WIDE concept: `getBySlug` with no workspace/user resolves only
      // active SYSTEM + SHARED rows (at most one — they share a unique index),
      // never a workspace/user twin. The old `findFirst(eq(slug))` had no scope
      // filter, no is_active filter and no ORDER BY, so a workspace-scope twin
      // or a retired row (e.g. the 0151-deactivated `project`) could be stamped
      // onto a def every workspace reads.
      const targetProfile = await profileRepo.getBySlug(
        mapping.targetProfileSlug
      );

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
