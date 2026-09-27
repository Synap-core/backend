/**
 * DROPPED SUBMISSIONS — how many guest submissions a form refused since its
 * owner last looked.
 *
 * At the form's pending cap the guest door still answers the constant 202 (a
 * flooder must not learn the cap), so the only place a lost lead can surface is
 * the owner's form row. The count lives beside the definition, in
 * `tools.metadata.formStats` (never inside `metadata.form`, whose schema is
 * strict), and is written with one atomic JSONB merge so concurrent drops
 * cannot lose an increment.
 *
 * "Since the owner last looked" is measured, not stored: a decision (approve or
 * reject) on any of the form actor's proposals after the last drop means the
 * owner reviewed the queue, so the count reads 0 and the next drop starts again
 * at 1. Raising the cap resets it explicitly (`form-service.ts`).
 */

import { db, and, drizzleSql, eq, inArray, isNotNull } from "@synap/database";
import { proposals, tools } from "@synap/database/schema";

export const FORM_STATS_KEY = "formStats";
/** The key as a SQL literal (a constant, never input). */
const STATS = drizzleSql.raw(`'${FORM_STATS_KEY}'`);

export interface FormStats {
  droppedSinceReview: number;
  lastDroppedAt: string | null;
}

/** Read the stored counter; anything unreadable is "nothing dropped". */
export function readStoredFormStats(metadata: unknown): FormStats {
  const raw =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)[FORM_STATS_KEY]
      : undefined;
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const n = rec.droppedSinceReview;
  const at = rec.lastDroppedAt;
  return {
    droppedSinceReview:
      typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0,
    lastDroppedAt: typeof at === "string" ? at : null,
  };
}

/** SQL: true when the actor has a proposal decided after `since`. */
function reviewedSince(
  actorUserId: string,
  since: ReturnType<typeof drizzleSql>
) {
  return drizzleSql`exists (
    select 1 from proposals p
    where p.agent_user_id = ${actorUserId}
      and p.reviewed_at is not null
      and p.reviewed_at > ${since}
  )`;
}

/** Count one refused submission on the form row (atomic). */
export async function recordFormDrop(input: {
  formId: string;
  actorUserId: string;
  now: Date;
}): Promise<void> {
  const last = drizzleSql`(${tools.metadata}->${STATS}->>'lastDroppedAt')::timestamptz`;
  const prior = drizzleSql`coalesce((${tools.metadata}->${STATS}->>'droppedSinceReview')::int, 0)`;
  await db
    .update(tools)
    .set({
      metadata: drizzleSql`coalesce(${tools.metadata}, '{}'::jsonb) || jsonb_build_object(
        ${STATS},
        jsonb_build_object(
          'droppedSinceReview',
          case when ${last} is not null and ${reviewedSince(input.actorUserId, last)}
            then 1 else ${prior} + 1 end,
          'lastDroppedAt', ${input.now.toISOString()}::text
        )
      )`,
    })
    .where(eq(tools.id, input.formId));
}

/**
 * The owner-facing count for each form: the stored count, or 0 when a decision
 * on the actor's proposals came after the last drop. One query for the page.
 */
export async function droppedSinceReview(
  forms: ReadonlyArray<{ actorUserId: string; metadata: unknown }>
): Promise<number[]> {
  const stats = forms.map((f) => readStoredFormStats(f.metadata));
  const actors = forms
    .filter((_, i) => stats[i]!.droppedSinceReview > 0)
    .map((f) => f.actorUserId);
  if (actors.length === 0) return stats.map(() => 0);
  const list = await db
    .select({
      actor: proposals.agentUserId,
      reviewedAt: drizzleSql<
        string | Date | null
      >`max(${proposals.reviewedAt})`,
    })
    .from(proposals)
    .where(
      and(
        inArray(proposals.agentUserId, actors),
        isNotNull(proposals.reviewedAt)
      )
    )
    .groupBy(proposals.agentUserId);
  const reviewedAt = new Map(
    list.map((r) => [
      r.actor,
      r.reviewedAt ? new Date(r.reviewedAt).getTime() : null,
    ])
  );
  return forms.map((f, i) => {
    const s = stats[i]!;
    if (s.droppedSinceReview === 0) return 0;
    const reviewed = reviewedAt.get(f.actorUserId) ?? null;
    const last = s.lastDroppedAt ? Date.parse(s.lastDroppedAt) : NaN;
    if (reviewed !== null && Number.isFinite(last) && reviewed > last) return 0;
    return s.droppedSinceReview;
  });
}
