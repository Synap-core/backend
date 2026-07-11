/**
 * Rebuild Property Index — projection recompute
 *
 * INVARIANT: `entity_property_index` and `entity_identity_signals` are
 * PROJECTIONS derived from `entities`, never a source of truth. This script
 * recomputes them from the entity rows so a drifted (corrupted, partially
 * migrated, or hand-edited) index can be restored deterministically.
 *
 *   - entity_property_index: reindexEntity() DELETEs the entity's rows and
 *     re-derives them from the entity's `properties` through the effective-
 *     property lens (a destructive-per-entity rebuild — the projection is
 *     wholly replaced from truth).
 *   - entity_identity_signals: registerIdentitySignals() — the idempotent
 *     one-door (onConflictDoNothing). Additive by design: it re-registers every
 *     strong atom the entity's properties currently imply; it does not prune
 *     signals a prior value once implied (that stays a deliberate resolver
 *     concern, not a blind rebuild).
 *
 * Usage:
 *   tsx src/scripts/rebuild-property-index.ts
 */

import { isNull } from "drizzle-orm";
import { db, sql } from "../client-pg.js";
import { entities } from "../schema/entities.js";
import { PropertyIndexService } from "../services/property-index-service.js";
import {
  extractIdentitySignals,
  registerIdentitySignals,
} from "../services/identity-resolution-service.js";

/** The minimal entity shape the projection rebuild reads. */
export interface RebuildableEntity {
  id: string;
  profileId: string | null;
  properties: Record<string, unknown> | null;
  workspaceId: string | null;
}

/**
 * Recompute BOTH projections for ONE entity from its own row. Exported so the
 * drift test drives the exact path the operator script runs.
 */
export async function rebuildEntityProjections(
  entity: RebuildableEntity
): Promise<void> {
  const properties = entity.properties ?? {};

  // 1. Property index — needs a profile to resolve which props are effective
  //    (and thus indexable). Legacy rows without a profile carry no index.
  if (entity.profileId) {
    const indexService = new PropertyIndexService(db);
    await indexService.reindexEntity(
      entity.id,
      properties,
      entity.profileId,
      entity.workspaceId
    );
  }

  // 2. Identity signals — idempotent door, keyed off the entity's own props.
  const signals = extractIdentitySignals(properties);
  if (signals.length > 0) {
    await registerIdentitySignals(db, entity.id, signals, "rebuild");
  }
}

/** Recompute the projections for every live entity. */
export async function rebuildPropertyIndex(): Promise<{
  scanned: number;
  indexed: number;
}> {
  const all = await db.query.entities.findMany({
    where: isNull(entities.deletedAt),
  });

  let indexed = 0;
  for (const entity of all) {
    await rebuildEntityProjections({
      id: entity.id,
      profileId: entity.profileId ?? null,
      properties: (entity.properties as Record<string, unknown> | null) ?? null,
      workspaceId: entity.workspaceId ?? null,
    });
    if (entity.profileId) indexed += 1;
  }

  return { scanned: all.length, indexed };
}

// Run if called directly (tsx), not when imported by the drift test.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("🔁 Rebuilding property-index + identity-signal projections...\n");
  rebuildPropertyIndex()
    .then(async (r) => {
      console.log(
        `✅ Done — scanned ${r.scanned} live entities, reindexed ${r.indexed} with a profile.\n`
      );
      await sql.end();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("❌ Fatal error:", error);
      await sql.end().catch(() => {});
      process.exit(1);
    });
}
