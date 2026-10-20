/**
 * A record that LANDED leaves its other pending create copies stale.
 *
 * MEASURED DEFECT (live, 2026-10-18/19): one agent filed the same decision
 * create five times; the founder approved one (a45e9a3a → entity b0588fc6) and
 * the other four stayed pending. Each later approve could only fail the
 * entity door's same-name gate, and until then each one counted toward the
 * agent's pending cap (`AGENT_PENDING_PROPOSAL_CAP`).
 *
 * So when an entity create lands, the pending AGENT `entity/create` proposals
 * that propose the SAME record (`createdRecordIdentity` — the rule the dedup
 * hash applies) are EXPIRED, never rejected: `ProposalStatus.EXPIRED` is "never
 * decided, its moment passed" and is not scored, so the agent's track record is
 * not penalised for a copy a person never judged. Each row is stamped with what
 * superseded it. Precedent: `expireProposalsStaleAfterMove`
 * (`services/lifecycle/stale-proposals.ts`).
 *
 * Bounds, each a rule this does NOT widen:
 *  - same owner (`subject_user_id`, the human the agent acted for) — another
 *    person's pending work is never touched;
 *  - agent-authored only — a person may file the same create twice on purpose,
 *    exactly as the dedup hash never collapses human rows;
 *  - the SAME record, not a similar one: a same-name create with different
 *    content stays pending, so its reviewer keeps the identity verbs (fill
 *    empty / keep existing / use these values / keep both);
 *  - never the copy that IS the landing record (same minted `record.id`): on
 *    an approval replay that proposal is still pending while `entities.create`
 *    runs. Matched on the MINTED id, not the landed entity id — the repository
 *    does not reuse the minted id (live: a45e9a3a minted 00348b58, landed as
 *    b0588fc6).
 */
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";
import { createdRecordIdentity } from "./insert-pending-proposal.js";
import { stableStringify } from "./stable-stringify.js";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Expire the pending agent create copies of a record that landed; their ids. */
export async function expirePendingCreatesOfLandedRecord(
  input: {
    /** The record the create door was handed (`{ id, profileSlug, title, … }`). */
    record: Record<string, unknown>;
    /** The entity the record landed as. */
    entityId: string;
    /** The human whose data it is. */
    ownerUserId: string;
    /** The proposal that landed it, when one did. */
    landedByProposalId?: string | null;
  },
  executor: typeof db | DbTx = db
): Promise<string[]> {
  const { profileSlug, title, id: mintedId } = input.record;
  if (typeof profileSlug !== "string" || typeof title !== "string") return [];
  const identity = stableStringify(createdRecordIdentity(input.record));

  // Narrow by kind + exact title in SQL; the full record compares below.
  const candidates = await executor
    .select({ id: proposals.id, data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        eq(proposals.targetType, "entity"),
        eq(proposals.proposalType, "create"),
        isNotNull(proposals.agentUserId),
        eq(proposals.subjectUserId, input.ownerUserId),
        sql`${proposals.data}->'data'->>'profileSlug' = ${profileSlug}`,
        sql`${proposals.data}->'data'->>'title' = ${title}`,
        ...(typeof mintedId === "string"
          ? [sql`${proposals.data}->'data'->>'id' IS DISTINCT FROM ${mintedId}`]
          : []),
        ...(input.landedByProposalId
          ? [ne(proposals.id, input.landedByProposalId)]
          : [])
      )
    );

  const sameRecord = candidates
    .filter((row) => {
      const nested = (row.data as { data?: unknown } | null)?.data;
      return (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested) &&
        stableStringify(
          createdRecordIdentity(nested as Record<string, unknown>)
        ) === identity
      );
    })
    .map((row) => row.id);
  if (sameRecord.length === 0) return [];

  const expired = await executor
    .update(proposals)
    .set({
      status: ProposalStatus.EXPIRED,
      updatedAt: new Date(),
      data: sql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(
        'expiredBy', 'record_landed',
        'supersededByEntityId', ${input.entityId}::text,
        'supersededByProposalId', ${input.landedByProposalId ?? null}::text)`,
    })
    .where(
      and(
        inArray(proposals.id, sameRecord),
        // Re-checked at write: a copy decided between the read and here keeps
        // its decision.
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .returning({ id: proposals.id });
  return expired.map((row) => row.id);
}
