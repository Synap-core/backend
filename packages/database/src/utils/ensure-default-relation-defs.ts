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
  error?: string;
}

export async function ensureDefaultRelationDefs(
  workspaceId: string,
  userId: string
): Promise<EnsureDefaultRelationDefsResult> {
  try {
    const dbConn = await getDb();
    const relDefRepo = new RelationDefRepository(dbConn);

    // Check which defs already exist
    const existing = await relDefRepo.list(workspaceId);
    const existingSlugs = new Set(existing.map((d) => d.slug));

    const missing = DEFAULT_RELATION_DEFS.filter(
      (def) => !existingSlugs.has(def.slug)
    );

    if (missing.length === 0) {
      return {
        status: "skipped",
        message: `All ${DEFAULT_RELATION_DEFS.length} default relation definitions already exist`,
        defsCreated: 0,
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
    };
  } catch (error) {
    return {
      status: "error",
      message: "Failed to seed default relation definitions",
      defsCreated: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
