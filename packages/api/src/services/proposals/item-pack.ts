/**
 * The approval half of an ITEM PACK — one proposal, N independent items
 * (`pod_hygiene/cleanup_pack`, `entity/update_pack`). The model (refs,
 * dispositions, outcomes) is `@synap-core/types/proposals/item-pack`; this is
 * the one loop that applies it:
 *
 *   - an item the reviewer rejected (`data.dispositions[ref]`) is skipped;
 *   - an item a previous, interrupted approve already APPLIED is not run
 *     again (its door would now refuse and overwrite a true record);
 *   - every other item goes through the pack's own `apply` — a throw refuses
 *     THAT item only, never its siblings;
 *   - each outcome is written to `data.outcomes[ref]` as it happens, so a
 *     crash midway leaves a true partial record.
 */

import { db, eq, drizzleSql, proposals, ProposalStatus } from "@synap/database";
import {
  isItemRejected,
  readItemOutcomes,
  type StoredItemOutcome,
} from "@synap-core/types/proposals/item-pack";

/**
 * Write ONE item's outcome into the pack row. A legacy v1 `outcomes` array is
 * replaced by the keyed object.
 */
async function recordItemOutcome(
  packId: string,
  ref: string,
  stored: StoredItemOutcome
): Promise<void> {
  await db
    .update(proposals)
    .set({
      data: drizzleSql`jsonb_set(
        COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(
          'outcomes',
          CASE WHEN jsonb_typeof(${proposals.data}->'outcomes') = 'object'
            THEN ${proposals.data}->'outcomes' ELSE '{}'::jsonb END
        ),
        ARRAY['outcomes', ${ref}::text],
        ${JSON.stringify(stored)}::jsonb,
        true
      )`,
    })
    .where(eq(proposals.id, packId));
}

/** Apply a pack's items in order; returns each item with its outcome. */
export async function applyItemPack<T extends { ref: string }>(params: {
  packId: string;
  /** The stored `proposals.data` (dispositions and prior outcomes live here). */
  data: unknown;
  items: readonly T[];
  apply: (item: T) => Promise<void>;
}): Promise<Array<{ item: T; outcome: StoredItemOutcome }>> {
  const prior = readItemOutcomes(params.data);
  const results: Array<{ item: T; outcome: StoredItemOutcome }> = [];
  for (const item of params.items) {
    const previous = prior[item.ref];
    if (previous?.outcome === "applied") {
      results.push({ item, outcome: previous });
      continue;
    }
    const at = new Date().toISOString();
    let outcome: StoredItemOutcome;
    if (isItemRejected(params.data, item.ref)) {
      outcome = { outcome: "skipped_by_reviewer", at };
    } else {
      try {
        await params.apply(item);
        outcome = { outcome: "applied", at };
      } catch (err) {
        outcome = {
          outcome: "refused",
          reason: err instanceof Error ? err.message : String(err),
          at,
        };
      }
    }
    await recordItemOutcome(params.packId, item.ref, outcome);
    results.push({ item, outcome });
  }
  return results;
}

/** True when the pack was already approved (an approve retried): do nothing twice. */
export async function itemPackAlreadyApproved(
  packId: string
): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, packId));
  return row?.status === ProposalStatus.APPROVED;
}

/** Flip the pack APPROVED once its items have run (their outcomes are on the row). */
export async function markItemPackApproved(
  packId: string,
  approverUserId: string
): Promise<void> {
  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: approverUserId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, packId));
}
