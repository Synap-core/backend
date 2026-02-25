/**
 * Ensure Default Relation Definitions
 *
 * Seeds the 12 domain-level relation types into a workspace's relation_defs table.
 * Called during workspace-init (same pattern as ensureDefaultViews, ensureDefaultCommands).
 * Uses upsert so it's safe to call multiple times.
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

    let created = 0;
    for (const def of DEFAULT_RELATION_DEFS) {
      await relDefRepo.create({
        slug: def.slug,
        displayName: def.displayName,
        description: def.description,
        workspaceId,
        userId,
        uiHints: def.uiHints,
        isDirectional: def.isDirectional,
      });
      created++;
    }

    return {
      status: "created",
      message: `Seeded ${created} default relation definitions`,
      defsCreated: created,
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
