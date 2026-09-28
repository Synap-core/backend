/**
 * The TARGET of a core entity-verb run (`entity.delete`, `entity.update`), for
 * its proposal title — `Delete Question "GRP #3: Numbers"`.
 *
 * FLOORED to what the proposer can already read: the entity `VisibilityRule`
 * via `scopedDb(access).predicate(entities)` — the same predicate the proposal
 * display batch uses for every entity name it resolves
 * (`enrichProposalsForDisplay`, `display.name-floor.pglite.test.ts`). A run
 * naming an entity the proposer cannot see yields no subject, so the stored
 * title can never become a name oracle (file a run on a guessed id, read the
 * name back off your own proposal).
 *
 * Feeds the SUMMARY only; the replayed `parameters` are untouched. A failed
 * read is LOGGED and yields no subject — the title then says "Delete entity",
 * which is true, never a guessed name.
 */
import { db, entities, eq, and } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type {
  EntityVerbRunSubject,
  EntityVerbRunTarget,
} from "@synap-core/types/proposals/capability-run";
import { AccessContext, scopedDb } from "../../access/index.js";

const logger = createLogger({ module: "capability-run-subject" });

export async function resolveEntityVerbRunSubject(
  target: EntityVerbRunTarget | null,
  userId: string
): Promise<EntityVerbRunSubject | undefined> {
  if (!target) return undefined;
  try {
    const access = scopedDb(AccessContext.operator({ userId }));
    const [row] = await db
      .select({
        title: entities.title,
        preview: entities.preview,
        type: entities.type,
      })
      .from(entities)
      .where(and(eq(entities.id, target.entityId), access.predicate(entities)))
      .limit(1);
    if (!row) return undefined;
    return { kind: row.type, name: row.title ?? row.preview ?? null };
  } catch (err) {
    logger.warn(
      { err, entityId: target.entityId },
      "capability-run title: could not resolve the target entity (title names the action only)"
    );
    return undefined;
  }
}
