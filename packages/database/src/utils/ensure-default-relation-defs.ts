/**
 * Ensure Default Relation Definitions
 *
 * Seeds the domain-level relation types into a workspace's relation_defs table.
 * Called during workspace-init (same pattern as ensureDefaultViews, ensureDefaultCommands).
 * Checks existing defs first to avoid unnecessary upserts and report accurate counts.
 */

import { getDb } from "../client-pg.js";
import { RelationDefRepository } from "../repositories/relation-def-repository.js";
import { DEFAULT_RELATION_DEFS } from "./default-relation-defs.js";

export interface EnsureDefaultRelationDefsResult {
  status: "created" | "skipped" | "error";
  message: string;
  defsCreated: number;
  /**
   * How many default slugs a workspace call found covered ONLY by a pod-wide
   * (workspace_id IS NULL) row. Non-zero means the "skipped" status is real
   * coverage by the base layer, not a silent miss — see
   * seed-property-relation-mappings, which resolves through the same fallback.
   */
  podWideCovered: number;
  error?: string;
}

/**
 * Seed the default relation defs.
 *
 * `workspaceId = null` seeds the POD-WIDE base layer (one row per slug, guarded
 * by migration 0118's `UNIQUE (slug) WHERE workspace_id IS NULL`). Called once
 * at worker boot. A workspace call still wins by slug at resolution time
 * (`RelationDefRepository.getBySlug` prefers the workspace row), so the base
 * layer can never overwrite or shadow a workspace override.
 */
export async function ensureDefaultRelationDefs(
  workspaceId: string | null,
  userId: string
): Promise<EnsureDefaultRelationDefsResult> {
  try {
    const dbConn = await getDb();
    const relDefRepo = new RelationDefRepository(dbConn);

    // Check which defs already exist
    // list(workspaceId) returns this workspace's rows PLUS pod-wide globals;
    // list(null) returns globals only. Coverage by a global row is real coverage
    // (getBySlug falls back to it), so it counts as present — but we report how
    // much of the coverage is pod-wide so a "skipped" is never mistaken for a
    // workspace that was actually seeded.
    const existing = await relDefRepo.list(workspaceId);
    const existingSlugs = new Set(existing.map((d) => d.slug));
    const ownSlugs = new Set(
      existing.filter((d) => d.workspaceId === workspaceId).map((d) => d.slug)
    );

    const missing = DEFAULT_RELATION_DEFS.filter(
      (def) => !existingSlugs.has(def.slug)
    );
    const podWideCovered = DEFAULT_RELATION_DEFS.filter(
      (def) => existingSlugs.has(def.slug) && !ownSlugs.has(def.slug)
    ).length;

    if (missing.length === 0) {
      return {
        status: "skipped",
        message:
          podWideCovered > 0
            ? `All ${DEFAULT_RELATION_DEFS.length} default relation definitions resolve (${podWideCovered} via the pod-wide base layer)`
            : `All ${DEFAULT_RELATION_DEFS.length} default relation definitions already exist`,
        defsCreated: 0,
        podWideCovered,
      };
    }

    for (const def of missing) {
      await relDefRepo.create({
        slug: def.slug,
        displayName: def.displayName,
        description: def.description,
        workspaceId,
        userId,
        uiHints: def.uiHints,
        isDirectional: def.isDirectional,
      });
    }

    return {
      status: "created",
      message: `Seeded ${missing.length} default relation definitions (${existingSlugs.size} already existed)`,
      defsCreated: missing.length,
      podWideCovered,
    };
  } catch (error) {
    return {
      status: "error",
      message: "Failed to seed default relation definitions",
      defsCreated: 0,
      podWideCovered: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
