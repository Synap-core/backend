/**
 * THE ONE DOOR for "when did we last speak to them" (CRM recall C-W2, 0359).
 *
 * `entities.last_interaction_at` is the truth; `properties.lastInteractionAt`
 * is its READ PROJECTION, written in the SAME statement so views, bento
 * recipes and the hygiene expression keep reading it.
 *
 * MONOTONIC: a write only moves the value forward. An older interaction
 * reported late (a past meeting linked today, a sweep re-reading last week)
 * can never pull "last spoke" back. The operator repair
 * `rebuildLastInteraction` (`interaction-evidence.ts`) is the only writer
 * allowed to lower it (a deleted event, a wrong attendee).
 *
 * NEVER THE FUTURE: a meeting that has not happened is not an interaction —
 * an `at` after `now` is refused, never clamped.
 *
 * NO `entity.update` EMIT, on purpose: a bump is not an edit. Through the
 * update door every bump would re-embed the person, reindex search and fire
 * webhooks and automations. `updated_at` and `version` are left alone too, so
 * "recently updated" keeps meaning edited and no editor sees a stale-version
 * conflict because a meeting was synced.
 */
import { and, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import { entities } from "../../schema/entities.js";

type Db = PostgresJsDatabase<typeof schema>;

/** The read projection's key: `properties.lastInteractionAt`. */
export const LAST_INTERACTION_PROPERTY = "lastInteractionAt";

export interface NoteInteractionInput {
  entityIds: readonly string[];
  at: Date;
  /** Injectable clock (tests). */
  now?: Date;
}

export interface NoteInteractionResult {
  /** The entities whose value moved forward. */
  moved: string[];
  /** Why nothing was written, when the input itself was refused. */
  refused?: "invalid-date" | "future";
}

export async function noteInteraction(
  db: Db,
  input: NoteInteractionInput
): Promise<NoteInteractionResult> {
  const at = input.at;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    return { moved: [], refused: "invalid-date" };
  }
  const now = input.now ?? new Date();
  if (at.getTime() > now.getTime()) return { moved: [], refused: "future" };
  const ids = [...new Set(input.entityIds)];
  if (ids.length === 0) return { moved: [] };

  const rows = await db
    .update(entities)
    .set({
      lastInteractionAt: at,
      properties: sql`${entities.properties} || jsonb_build_object(${LAST_INTERACTION_PROPERTY}::text, ${at.toISOString()}::text)`,
    })
    .where(
      and(
        inArray(entities.id, ids),
        isNull(entities.deletedAt),
        // Forward only: an equal or later value is already the answer.
        or(
          isNull(entities.lastInteractionAt),
          lt(entities.lastInteractionAt, at)
        )
      )
    )
    .returning({ id: entities.id });
  return { moved: rows.map((r) => r.id) };
}
