/**
 * COMPUTE LEASES — the record every compute start leaves (0431), written by
 * the one post-gate runner (`runResolvedSkill`) around the provider call:
 *
 *   open    BEFORE the provider is called: no lease, no start. The TTL clock
 *           starts here (`expires_at` = now + ttlMinutes).
 *   settle  AFTER: `active` with the machine's id, `not_started` when the
 *           start did not run, `unknown` when it ran but returned no id (or
 *           was queued or proposed again downstream): a person must look.
 *   close   a `release_compute` run in mode destroy ends the lease of the
 *           machine it names, whoever ran it.
 *
 * The TTL sweeper (`release-expired-leases.ts`) releases the rest.
 */
import {
  db,
  and,
  eq,
  isNull,
  computeLeases,
  skills,
  type ComputeLeaseState,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { ResolvedSkillRow } from "../capabilities/execute-capability.js";
import {
  answeringSkillOrder,
  answeringSkillsWhere,
} from "../capabilities/verb-skill.js";
import {
  readComputeRun,
  RELEASE_COMPUTE_INTENT,
  resourceIdOf,
  type ComputeStart,
} from "./compute-contract.js";

const logger = createLogger({ module: "compute-leases" });

/** What a start's result says about its lease (`result.computeLease`). */
export interface ComputeLeaseReport {
  leaseId: string;
  state: ComputeLeaseState;
  expiresAt: string;
  resourceId: string | null;
}

/**
 * The release verb a start names, as the runner loads a verb: answering in
 * the starter's lens, approved first. Refused (a sentence) when it is not
 * there, is not a `release_compute` verb, is not enabled, or does not
 * destroy: nothing could then release the machine at its TTL.
 */
export async function resolveReleaseVerb(
  userId: string,
  workspaceId: string | null,
  releaseVerb: string
): Promise<
  { ok: true; skill: ResolvedSkillRow } | { ok: false; message: string }
> {
  const [row] = await db
    .select({
      id: skills.id,
      name: skills.name,
      approved: skills.approved,
      kind: skills.kind,
      providerSpec: skills.providerSpec,
      metadata: skills.metadata,
      parameters: skills.parameters,
      executionMode: skills.executionMode,
      intent: skills.intent,
      inputMap: skills.inputMap,
    })
    .from(skills)
    .where(
      and(answeringSkillsWhere(userId, workspaceId), eq(skills.name, releaseVerb))
    )
    .orderBy(...answeringSkillOrder())
    .limit(1);
  if (!row) {
    return {
      ok: false,
      message: `The release verb "${releaseVerb}" is not installed here, so nothing could release this machine at its time to live.`,
    };
  }
  if (row.intent !== RELEASE_COMPUTE_INTENT) {
    return {
      ok: false,
      message: `"${releaseVerb}" is not a release_compute verb, so it cannot release this machine.`,
    };
  }
  if (row.approved === false) {
    return {
      ok: false,
      message: `The release verb "${releaseVerb}" is installed but not enabled; enable it before starting a machine it must release.`,
    };
  }
  const check = readComputeRun(row, { resourceId: "probe", mode: "destroy" });
  if (check.kind !== "release") {
    return {
      ok: false,
      message: `The release verb "${releaseVerb}" does not destroy a machine (metadata.compute.modes), so it cannot end one at its time to live.`,
    };
  }
  const { approved: _approved, ...skill } = row;
  void _approved;
  return { ok: true, skill: skill as ResolvedSkillRow };
}

/** Write the lease of a start, before the provider is called. */
export async function openComputeLease(input: {
  skill: { id: string; name: string };
  start: ComputeStart;
  userId: string;
  workspaceId: string | null;
  agentUserId: string | null;
  proposalId: string | null;
  sessionId: string | null;
  connectionSelector: unknown;
  now?: Date;
}): Promise<{ id: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.start.ttlMinutes * 60_000);
  const [row] = await db
    .insert(computeLeases)
    .values({
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentUserId: input.agentUserId,
      proposalId: input.proposalId,
      sessionId: input.sessionId,
      provisionSkillId: input.skill.id,
      provisionVerb: input.skill.name,
      releaseVerb: input.start.releaseVerb,
      connectionSelector: (input.connectionSelector ?? null) as never,
      ttlMinutes: input.start.ttlMinutes,
      maxSpendCents: input.start.maxSpendCents,
      state: "starting",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: computeLeases.id, expiresAt: computeLeases.expiresAt });
  if (!row) throw new Error("compute lease insert returned no row");
  return row;
}

/**
 * Settle a start's lease from the runner's outcome. `delivered` = the run
 * did the work (not a queued or re-proposed envelope).
 */
export async function settleComputeLease(
  lease: { id: string; expiresAt: Date },
  outcome:
    | { ran: false }
    | { ran: true; delivered: boolean; result: unknown }
): Promise<ComputeLeaseReport> {
  const resourceId =
    outcome.ran && outcome.delivered ? resourceIdOf(outcome.result) : null;
  const state: ComputeLeaseState = !outcome.ran
    ? "not_started"
    : resourceId
      ? "active"
      : "unknown";
  await db
    .update(computeLeases)
    .set({ state, resourceId, updatedAt: new Date() })
    .where(eq(computeLeases.id, lease.id));
  if (state === "unknown") {
    logger.error(
      { leaseId: lease.id },
      "compute start ran but returned no resourceId: the machine cannot be released at its TTL"
    );
  }
  return {
    leaseId: lease.id,
    state,
    expiresAt: lease.expiresAt.toISOString(),
    resourceId,
  };
}

/**
 * A destroy ends the lease of the machine it names (the starter's own,
 * through the same release verb). Returns how many leases it closed.
 */
export async function closeComputeLeaseOnRelease(input: {
  userId: string;
  releaseVerb: string;
  resourceId: string;
  result: unknown;
}): Promise<number> {
  const closed = await db
    .update(computeLeases)
    .set({
      state: "released",
      releasedAt: new Date(),
      releaseResult: (input.result ?? null) as never,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(computeLeases.userId, input.userId),
        eq(computeLeases.resourceId, input.resourceId),
        eq(computeLeases.releaseVerb, input.releaseVerb),
        eq(computeLeases.state, "active"),
        isNull(computeLeases.releasedAt)
      )
    )
    .returning({ id: computeLeases.id });
  return closed.length;
}
