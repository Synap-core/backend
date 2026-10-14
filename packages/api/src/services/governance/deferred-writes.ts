/**
 * DEFERRED WRITES — replay after a workspace join is approved (#6).
 *
 * The gate keeps an agent's writes into a space it has not joined on the join
 * proposal (`data.deferredWrites`, `utils/permission-check.ts`
 * `maybeCreateWorkspaceJoinProposal`). Once the `workspace/join` executor has
 * inserted the membership, this replays each one through ITS OWN DOOR, AS THE
 * AGENT: acting agent, session and key grant restored, the person it wrote for
 * as the caller. The door's own gate then runs the normal ladder — the write
 * executes, or files its own proposal. Approving access is never approving
 * content. What each replay did lands on `data.deferredOutcomes[ref]` as it
 * happens.
 *
 * Never `ctx.governanceProposalId` here: that channel says "a person already
 * decided this write", which is exactly what a join approval does NOT say.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  drizzleSql,
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import type { GovernedWriteDoor } from "@synap/governance-policy";
import {
  REPLAYABLE_DEFERRED_PAIRS,
  readDeferredOutcomes,
  readDeferredWrites,
  replayableDeferredPair,
  type DeferredWrite,
  type ReplayableDeferredPair,
  type StoredDeferredOutcome,
} from "@synap-core/types/proposals/deferred-writes";
import { isItemRejected } from "@synap-core/types/proposals/item-pack";
import type { Context } from "../../context.js";
import { entitiesRouter } from "../../routers/entities.js";
import { documentsRouter } from "../../routers/hub-protocol/documents.js";
import { createHubProtocolCallerContext } from "../../routers/hub-protocol/utils.js";
import { createFocusSession } from "../focus-sessions/create-session.js";

const logger = createLogger({ module: "deferred-writes" });

// Every replayable pair is a declared governed door — a pair outside the door
// vocabulary does not compile.
const _pairsAreGovernedDoors: readonly GovernedWriteDoor[] =
  REPLAYABLE_DEFERRED_PAIRS;
void _pairsAreGovernedDoors;

/** What one door answered, before it becomes a stored outcome. */
type DoorAnswer =
  | { outcome: "applied"; id?: string }
  | { outcome: "proposed"; proposalId: string }
  | { outcome: "refused"; reason: string };

type ReplayDoor = (w: DeferredWrite, workspaceId: string) => Promise<unknown>;

/** Drop null/undefined so optional zod fields accept the replayed input. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null)
  ) as Partial<T>;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** The hub caller context the agent's own doors run under. */
function agentCallerContext(w: DeferredWrite, workspaceId: string) {
  return createHubProtocolCallerContext(
    w.userId,
    ["hub-protocol.read", "hub-protocol.write"],
    workspaceId,
    w.sourceMessageId ?? null,
    w.sessionId,
    w.agentUserId
  );
}

/**
 * THE REPLAY TABLE — one door per replayable pair. A `Record` over the pair
 * union: a pair added to `REPLAYABLE_DEFERRED_PAIRS` without a door here does
 * not compile. Each door rebuilds its input from the payload it handed the
 * gate (the same payload the pair's approval executor reads).
 */
const REPLAY_DOORS: Record<ReplayableDeferredPair, ReplayDoor> = {
  "entity/create": async (w, workspaceId) => {
    const d = w.data;
    const caller = entitiesRouter.createCaller(
      (await agentCallerContext(w, workspaceId)) as unknown as Context
    );
    return caller.create(
      defined({
        profileSlug: str(d.profileSlug),
        title: str(d.title),
        description: str(d.description),
        properties: d.properties as Record<string, unknown> | undefined,
        documentId: str(d.documentId),
        content: str(d.content),
        global: typeof d.global === "boolean" ? d.global : undefined,
        // The placement the first attempt resolved; null (pod-wide) is left
        // to resolve again from the kind, as it did then.
        targetWorkspaceId: str(d.resolvedWorkspaceId),
        facets: d.facets as
          Array<{ profileSlug: string; status?: string }> | undefined,
        projectId: w.projectId ?? undefined,
        reasoning: w.reasoning,
        expectedLabel: w.expectedLabel,
        source: "intelligence" as const,
        agentUserId: w.agentUserId,
      })
    );
  },
  "entity/update": async (w, workspaceId) => {
    const d = w.data;
    const caller = entitiesRouter.createCaller(
      (await agentCallerContext(w, workspaceId)) as unknown as Context
    );
    return caller.update({
      id: String(d.id),
      ...defined({
        title: str(d.title),
        description: str(d.description),
        properties: d.properties as Record<string, unknown> | undefined,
        deleteProperties: d.deleteProperties as string[] | undefined,
        documentId: str(d.documentId),
        profileSlug: str(d.profileSlug),
        reasoning: w.reasoning,
        source: "intelligence" as const,
        agentUserId: w.agentUserId,
      }),
    });
  },
  "focus_session/create": async (w, workspaceId) => {
    const d = w.data;
    return createFocusSession({
      userId: w.userId,
      agentUserId: w.agentUserId,
      workspaceId,
      goal: String(d.goal ?? ""),
      ...defined({
        projectId: w.projectId,
        title: str(d.title),
        templateId: str(d.templateId),
        subjectEntityId: str(d.subjectEntityId),
        channelId: str(d.channelId),
        expectedOutputs: d.expectedOutputs as never,
        agentIds: d.agentIds as string[] | undefined,
        parentSessionId: str(d.parentSessionId),
        suspendedIntent: str(d.suspendedIntent),
        blockedBySessionIds: d.blockedBySessionIds as string[] | undefined,
        criteria: d.criteria as never,
        trackId: str(d.trackId),
        trackStage: str(d.trackStage),
        params: (d.params ?? d.trackParams) as
          Record<string, unknown> | undefined,
      }),
    });
  },
  "document/create": async (w, workspaceId) => {
    const d = w.data;
    const caller = documentsRouter.createCaller(
      (await agentCallerContext(w, workspaceId)) as unknown as Context
    );
    return caller.createDocument({
      // The document door gates as the agent and carries its person in data.
      userId: str(d.userId) ?? w.userId,
      workspaceId: str(d.workspaceId) ?? workspaceId,
      title: String(d.title ?? ""),
      ...defined({
        content: str(d.content),
        type: d.type as "markdown" | undefined,
        url: str(d.url),
        idempotencyKey: str(d.idempotencyKey),
        reasoning: w.reasoning,
        expectedLabel: w.expectedLabel,
        agentUserId: w.agentUserId,
      }),
    });
  },
};

/** Read a door's answer: proposed (its own proposal), or what it wrote. */
function readDoorAnswer(result: unknown): DoorAnswer {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.status === "proposed") {
    if (r.proposalType === "join") {
      // Membership is inserted before any replay, so this is a broken
      // invariant, never a second join to keep the write on.
      return {
        outcome: "refused",
        reason: "The agent is still not a member of this workspace.",
      };
    }
    return typeof r.proposalId === "string"
      ? { outcome: "proposed", proposalId: r.proposalId }
      : { outcome: "refused", reason: "The door proposed without an id." };
  }
  const session = r.session as { id?: unknown } | undefined;
  const id =
    str(r.id) ??
    str(r.documentId) ??
    str(session?.id) ??
    str((r.entity as { id?: unknown } | undefined)?.id);
  return { outcome: "applied", ...(id ? { id } : {}) };
}

/** Run one kept write through its door as the agent. Never throws. */
async function replayOne(
  w: DeferredWrite,
  workspaceId: string
): Promise<DoorAnswer> {
  const pair = replayableDeferredPair(w.subjectType, w.action);
  if (!pair) {
    return {
      outcome: "refused",
      reason: `${w.subjectType}/${w.action} cannot be replayed.`,
    };
  }
  try {
    const result = await runWithActingAgent(w.agentUserId, () =>
      runWithGrant(w.grant as unknown as KeyGrant | undefined, () =>
        REPLAY_DOORS[pair](w, workspaceId)
      )
    );
    return readDoorAnswer(result);
  } catch (err) {
    // A door's refusal (FORBIDDEN, CONFLICT, a validation error) is the
    // ladder's answer for this write; anything else is a failed replay. Both
    // are recorded with their reason — neither is folded into success.
    const reason =
      err instanceof TRPCError || (err as { code?: unknown })?.code
        ? (err as Error).message
        : `The replay failed: ${err instanceof Error ? err.message : String(err)}`;
    if (!(err instanceof TRPCError)) {
      logger.warn(
        { err, ref: w.ref, pair },
        "deferred write replay threw — recorded as refused"
      );
    }
    return { outcome: "refused", reason };
  }
}

/** Merge one outcome into `data.deferredOutcomes` in one statement. */
async function recordOutcome(
  proposalId: string,
  ref: string,
  outcome: StoredDeferredOutcome
): Promise<void> {
  await db
    .update(proposals)
    .set({
      data: drizzleSql`jsonb_set(coalesce(${proposals.data}, '{}'::jsonb), '{deferredOutcomes}', coalesce(${proposals.data} -> 'deferredOutcomes', '{}'::jsonb) || jsonb_build_object(${ref}::text, ${JSON.stringify(outcome)}::jsonb), true)`,
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, proposalId));
}

/**
 * Replay every write kept on the APPROVED join `proposalId`, in the order the
 * agent made them. Call only once the membership row exists. Idempotent: a
 * write that already has an outcome is not run again. A write the reviewer
 * dropped (`rejectItem` → `data.dispositions[ref]`) is recorded as skipped.
 */
export async function replayDeferredWrites(args: {
  proposalId: string;
  workspaceId: string;
}): Promise<{
  outcomes: Record<string, StoredDeferredOutcome>;
  unreadable: number;
}> {
  const [row] = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(eq(proposals.id, args.proposalId))
    .limit(1);
  const { writes, unreadable } = readDeferredWrites(row?.data);
  if (unreadable > 0) {
    logger.warn(
      { proposalId: args.proposalId, unreadable },
      "join proposal holds deferred writes that do not parse — not replayed"
    );
  }
  const outcomes = readDeferredOutcomes(row?.data);
  for (const w of writes) {
    if (outcomes[w.ref]) continue;
    const at = new Date().toISOString();
    let stored: StoredDeferredOutcome;
    if (isItemRejected(row?.data, w.ref)) {
      stored = { outcome: "skipped_by_reviewer", at };
    } else {
      const answer = await replayOne(w, args.workspaceId);
      stored =
        answer.outcome === "proposed"
          ? { outcome: "proposed", proposalId: answer.proposalId, at }
          : answer.outcome === "applied"
            ? {
                outcome: "applied",
                ...(answer.id ? { id: answer.id } : {}),
                at,
              }
            : { outcome: "refused", reason: answer.reason, at };
    }
    await recordOutcome(args.proposalId, w.ref, stored);
    outcomes[w.ref] = stored;
  }
  return { outcomes, unreadable };
}

/**
 * A REJECTED join: every kept write without an outcome is recorded as
 * `rejected` — it never ran. Only touches a row that IS rejected.
 */
export async function recordRejectedDeferredWrites(
  proposalId: string
): Promise<void> {
  const [row] = await db
    .select({ data: proposals.data, status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (row?.status !== ProposalStatus.REJECTED) return;
  const { writes } = readDeferredWrites(row.data);
  const recorded = readDeferredOutcomes(row.data);
  const at = new Date().toISOString();
  const add: Record<string, StoredDeferredOutcome> = {};
  for (const w of writes) {
    if (!recorded[w.ref]) add[w.ref] = { outcome: "rejected", at };
  }
  if (Object.keys(add).length === 0) return;
  await db
    .update(proposals)
    .set({
      data: drizzleSql`jsonb_set(coalesce(${proposals.data}, '{}'::jsonb), '{deferredOutcomes}', coalesce(${proposals.data} -> 'deferredOutcomes', '{}'::jsonb) || ${JSON.stringify(add)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposals.id, proposalId),
        eq(proposals.status, ProposalStatus.REJECTED)
      )
    );
}
