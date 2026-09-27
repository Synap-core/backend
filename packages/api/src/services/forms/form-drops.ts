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
 * RETIRED TOKEN HASHES — so a submission to a form that stopped listening is
 * still counted for its owner.
 *
 * A rotated token's hash leaves `metadata.form.tokenHash`, and a disabled form
 * is not loaded by the guest door, so both used to fall into "unknown token":
 * the constant 202 went back to the old embed and the lead vanished with no
 * trace anywhere. The door must keep answering 202 (an anonymous caller must not
 * learn which tokens once existed), so the loss is surfaced to the OWNER
 * instead, on the same `droppedSinceReview` counter the pending cap uses.
 *
 * Only SHA-256 hashes of dead tokens are kept (the same storage the live token
 * already has — never plaintext), newest first, at most
 * {@link RETIRED_TOKEN_HASHES_MAX}. No door ever ACCEPTS a retired hash: the
 * lookup below only counts. Kept beside the definition, never inside
 * `metadata.form` (whose schema is strict).
 */
export const RETIRED_TOKEN_HASHES_KEY = "formRetiredTokenHashes";
export const RETIRED_TOKEN_HASHES_MAX = 10;
const RETIRED = drizzleSql.raw(`'${RETIRED_TOKEN_HASHES_KEY}'`);

/** The metadata's retired list with `tokenHash` put first (deduped, capped). */
export function withRetiredTokenHash(
  metadata: Record<string, unknown>,
  tokenHash: string | null
): Record<string, unknown> {
  if (!tokenHash) return metadata;
  const prior = Array.isArray(metadata[RETIRED_TOKEN_HASHES_KEY])
    ? (metadata[RETIRED_TOKEN_HASHES_KEY] as unknown[]).filter(
        (h): h is string => typeof h === "string" && h !== tokenHash
      )
    : [];
  return {
    ...metadata,
    [RETIRED_TOKEN_HASHES_KEY]: [tokenHash, ...prior].slice(
      0,
      RETIRED_TOKEN_HASHES_MAX
    ),
  };
}

/**
 * A guest submission whose token matches no LIVE form: if the hash belongs to a
 * form that still exists but stopped listening (disabled, or the token was
 * rotated away), count it as dropped on that form. Returns whether it counted.
 * A hash that matches nothing, or matches more than one row, counts nowhere.
 */
export async function recordClosedFormHit(input: {
  tokenHash: string;
  now: Date;
}): Promise<boolean> {
  const rows = await db
    .select({
      id: tools.id,
      actorUserId: drizzleSql<
        string | null
      >`${tools.metadata}->'form'->>'actorUserId'`,
    })
    .from(tools)
    .where(
      drizzleSql`(
        (${tools.metadata}->'form'->>'tokenHash' = ${input.tokenHash} and ${tools.status} <> 'active')
        or coalesce(${tools.metadata}->${RETIRED}, '[]'::jsonb) @> jsonb_build_array(${input.tokenHash}::text)
      )`
    )
    .limit(2);
  if (rows.length !== 1 || !rows[0]!.actorUserId) return false;
  await recordFormDrop({
    formId: rows[0]!.id,
    actorUserId: rows[0]!.actorUserId,
    now: input.now,
  });
  return true;
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
