/**
 * UNDO A RUN — revert everything a session applied, or only some of it.
 *
 * A run IS a session: its proposals carry `sessionId`, so "everything this run
 * did" is the session's approved and auto-approved proposals. Each one is
 * reverted through the SAME door a single revert uses (`proposals.revert`) —
 * authority, the planner, the one undo engine, the status flip and the audit
 * trail are that door's, never a second copy here. That includes a proposal
 * that dispatched an external side effect: the door undoes its local rows and
 * says the send is permanent, and this walk reports what the door said — one
 * rule for one proposal and for a whole session.
 *
 * NEWEST FIRST. A later proposal may have linked to what an earlier one
 * created; reverting the later one first removes that link, so the earlier
 * entity reads as untouched instead of "in use". Removing that link can itself
 * bump the earlier entity's `updated_at` (the relation → property reverse
 * sync); the whole walk is ONE `RevertPass`, carried to the door on the typed
 * server ctx (`Context.revertPass`), so such a bump reads as the pass's own
 * write and never as an edit.
 *
 * Every proposal gets an outcome, never a swallowed error:
 *   reverted       — everything it made is undone
 *   partial        — some items were changed since and are still there (named)
 *   skipped        — nothing undone: every remaining item was changed since
 *   permanent      — it dispatched an external side effect: its local rows were
 *                    undone (any still standing are named), the send was not
 *   unsupported    — the planner has no inverse for its kind (e.g. an update)
 *   failed         — the revert threw; the message says why
 *   not_applicable — asked for by id, but not an applied proposal of this session
 *
 * Reusable: a rerun in `replace` mode calls this before starting over.
 */

import type { inferRouterOutputs } from "@trpc/server";
import {
  db,
  and,
  eq,
  desc,
  inArray,
  proposals,
  focusSessions,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import type { proposalsRouter } from "../../routers/proposals.js";
import type { revertSkipView } from "../proposals/revert-creations.js";
import type { RevertPass } from "../reversibility/safe-revert.js";
import type { Context } from "../../types/context.js";

const logger = createLogger({ module: "revert-session" });

/** What `proposals.revert` answers — inferred from the procedure, never mirrored. */
export type ProposalRevertOutput = inferRouterOutputs<
  typeof proposalsRouter
>["revert"];

export type SessionRevertSkipView = ReturnType<typeof revertSkipView>;

interface OutcomeBase {
  proposalId: string;
  proposalType: string;
}

export type SessionProposalRevertOutcome =
  | (OutcomeBase & { outcome: "reverted" })
  | (OutcomeBase & {
      outcome: "partial" | "skipped";
      skipped: SessionRevertSkipView[];
      stillThere: string[];
    })
  | (OutcomeBase & {
      outcome: "permanent";
      reason: "external_dispatched";
      at: string;
      /** Local items left standing because they were changed since. */
      skipped?: SessionRevertSkipView[];
      stillThere?: string[];
    })
  | (OutcomeBase & { outcome: "unsupported" | "failed"; reason: string })
  /** Asked for by id, but not an applied proposal of this session. */
  | (OutcomeBase & { outcome: "not_applicable"; reason: string });

export interface SessionRevertResult {
  sessionId: string;
  proposals: SessionProposalRevertOutcome[];
  counts: Record<SessionProposalRevertOutcome["outcome"], number>;
}

/** Revert ONE proposal; resolves to the `proposals.revert` result, or throws. */
export type RevertOneProposal = (
  proposalId: string
) => Promise<ProposalRevertOutput>;

export function classify(
  base: OutcomeBase,
  result: ProposalRevertOutput
): SessionProposalRevertOutcome {
  const skipped =
    "skipped" in result && Array.isArray(result.skipped) ? result.skipped : [];
  const stillThere =
    "partialFailures" in result && Array.isArray(result.partialFailures)
      ? result.partialFailures
      : [];
  if ("nothingReverted" in result && result.nothingReverted === true) {
    return { ...base, outcome: "skipped", skipped, stillThere };
  }
  // The door's own receipt: the local rows were undone, the send was not.
  if ("permanent" in result && result.permanent) {
    return {
      ...base,
      outcome: "permanent",
      reason: result.permanent.reason,
      at: result.permanent.at,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(stillThere.length > 0 ? { stillThere } : {}),
    };
  }
  if (stillThere.length > 0 || skipped.length > 0) {
    return { ...base, outcome: "partial", skipped, stillThere };
  }
  return { ...base, outcome: "reverted" };
}

export async function revertSession(args: {
  sessionId: string;
  userId: string;
  reason?: string;
  /**
   * Revert only these proposals of the session (still newest-first, still
   * through the same door). Omit for everything the session applied.
   */
  proposalIds?: string[];
  /**
   * The tRPC context the per-proposal door runs under (the router's own ctx,
   * or the Hub caller context). Defaults to a bare authenticated user.
   */
  callerContext?: Context;
  /** Injected for tests; defaults to `proposals.revert`. */
  revertOne?: RevertOneProposal;
  database?: typeof db;
}): Promise<
  { ok: false; reason: "not_found" } | ({ ok: true } & SessionRevertResult)
> {
  const database = args.database ?? db;

  // Owner-scoped, like every other session write door. Each proposal's own
  // review authority is still enforced by the per-proposal door.
  const [session] = await database
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  if (!session) return { ok: false, reason: "not_found" };

  const applied = await database
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.sessionId, args.sessionId),
        inArray(proposals.status, [
          ProposalStatus.APPROVED,
          ProposalStatus.AUTO_APPROVED,
        ]),
        ...(args.proposalIds ? [inArray(proposals.id, args.proposalIds)] : [])
      )
    )
    .orderBy(desc(proposals.createdAt));

  const pass: RevertPass = { startedAt: new Date(), entityIds: new Set() };
  const revertOne =
    args.revertOne ??
    (await defaultRevertOne(
      args.userId,
      args.reason,
      args.callerContext,
      pass
    ));

  const outcomes: SessionProposalRevertOutcome[] = [];
  // Named, never dropped: an id that is not an applied proposal of this session
  // (another session's, still pending, already reverted) says so.
  const appliedIds = new Set(applied.map((row) => row.id));
  for (const id of new Set(args.proposalIds ?? [])) {
    if (appliedIds.has(id)) continue;
    outcomes.push({
      proposalId: id,
      proposalType: "unknown",
      outcome: "not_applicable",
      reason: "not an applied proposal of this session",
    });
  }
  for (const row of applied) {
    const base = { proposalId: row.id, proposalType: row.proposalType };
    try {
      outcomes.push(classify(base, await revertOne(row.id)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown })?.code;
      if (code === "NOT_IMPLEMENTED") {
        outcomes.push({ ...base, outcome: "unsupported", reason: message });
      } else {
        logger.warn(
          { err, sessionId: args.sessionId, proposalId: row.id },
          "session revert: one proposal failed to revert (others continue)"
        );
        outcomes.push({ ...base, outcome: "failed", reason: message });
      }
    }
  }

  const counts: SessionRevertResult["counts"] = {
    reverted: 0,
    partial: 0,
    skipped: 0,
    permanent: 0,
    unsupported: 0,
    failed: 0,
    not_applicable: 0,
  };
  for (const o of outcomes) counts[o.outcome] += 1;

  return { ok: true, sessionId: args.sessionId, proposals: outcomes, counts };
}

async function defaultRevertOne(
  userId: string,
  reason: string | undefined,
  callerContext: Context | undefined,
  pass: RevertPass
): Promise<RevertOneProposal> {
  // Lazy: the proposals router imports back into services.
  const { proposalsRouter } = await import("../../routers/proposals.js");
  const base: Context = callerContext ?? { db, authenticated: true, userId };
  // The pass rides the SERVER ctx (`Context.revertPass`) — never the procedure
  // input, so no client can hand the door a set of entity ids to exempt from
  // the edit check.
  const caller = proposalsRouter.createCaller({ ...base, revertPass: pass });
  return (proposalId) =>
    caller.revert({ proposalId, ...(reason ? { reason } : {}) });
}
