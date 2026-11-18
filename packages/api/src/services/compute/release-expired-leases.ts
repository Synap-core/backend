/**
 * THE TTL SWEEPER — releases every compute machine whose time to live is up
 * (plan a640c5bb B3; founder, 18 Nov 2026: "the automatic destroy at TTL is
 * pre-approved by the start").
 *
 * Each active lease past `expires_at` gets its declared release verb run in
 * mode `destroy`, as the identity the start ran as, through the same
 * connection, with NO gate: approving the start approved this destroy (its
 * review card says so: `describeComputeStart`). The release is recorded on
 * the lease and, when the start was proposed, on that proposal
 * (`data.computeRelease`), where its reviewer reads what happened.
 *
 * A release that fails stays `active` with its error and attempt count, and
 * is tried again on the next tick: a machine nobody ends keeps costing.
 * Run by the `compute-lease-sweeper` cron (@synap/jobs, every 5 min, one at a
 * time), filled at boot by apps/api.
 */
import {
  db,
  and,
  eq,
  lte,
  asc,
  drizzleSql,
  computeLeases,
  proposals,
  type ComputeLease,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { runResolvedSkill } from "../capabilities/execute-capability.js";
import { resolveReleaseVerb } from "./compute-leases.js";

const logger = createLogger({ module: "compute-lease-sweeper" });

/** How many leases one tick releases at most. */
export const COMPUTE_SWEEP_BATCH = 25;

export interface ReleaseExpiredResult {
  due: number;
  released: number;
  failed: number;
}

/** Record the release on the start's proposal, where its reviewer reads it. */
async function recordOnProposal(
  lease: ComputeLease,
  record: Record<string, unknown>
): Promise<void> {
  if (!lease.proposalId) return;
  await db
    .update(proposals)
    .set({
      data: drizzleSql`coalesce(${proposals.data}, '{}'::jsonb) || jsonb_build_object('computeRelease', ${JSON.stringify(record)}::jsonb)`,
    })
    .where(eq(proposals.id, lease.proposalId));
}

async function releaseOne(lease: ComputeLease): Promise<boolean> {
  const at = new Date();
  // Claim this attempt; another tick that already ended it finds no row.
  const [claimed] = await db
    .update(computeLeases)
    .set({
      releaseAttempts: drizzleSql`${computeLeases.releaseAttempts} + 1`,
      updatedAt: at,
    })
    .where(and(eq(computeLeases.id, lease.id), eq(computeLeases.state, "active")))
    .returning({ id: computeLeases.id });
  if (!claimed) return false;

  const fail = async (message: string): Promise<false> => {
    await db
      .update(computeLeases)
      .set({ lastReleaseError: message, updatedAt: new Date() })
      .where(eq(computeLeases.id, lease.id));
    await recordOnProposal(lease, {
      status: "failed",
      at: at.toISOString(),
      mode: "destroy",
      resourceId: lease.resourceId,
      error: message,
      attempts: lease.releaseAttempts + 1,
    }).catch(() => undefined);
    logger.error(
      { leaseId: lease.id, resourceId: lease.resourceId, message },
      "compute release at TTL failed; tried again next tick"
    );
    return false;
  };

  const verb = await resolveReleaseVerb(
    lease.userId,
    lease.workspaceId,
    lease.releaseVerb
  );
  if (!verb.ok) return fail(verb.message);

  let outcome: Awaited<ReturnType<typeof runResolvedSkill>>;
  try {
    outcome = await runResolvedSkill(
      verb.skill,
      { resourceId: lease.resourceId, mode: "destroy" },
      {
        userId: lease.userId,
        workspaceId: lease.workspaceId,
        connectionSelector:
          (lease.connectionSelector as {
            connectionId?: string;
            contextObjectId?: string;
          } | null) ?? null,
        sessionId: lease.sessionId,
        provenance: { agentUserId: null, proposalId: lease.proposalId },
      }
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (outcome.kind !== "run") {
    return fail(
      outcome.kind === "deny"
        ? outcome.reason
        : outcome.kind === "error" || outcome.kind === "not_found"
          ? outcome.message
          : "the release did not run"
    );
  }

  await db
    .update(computeLeases)
    .set({
      state: "released",
      releasedAt: new Date(),
      releaseResult: (outcome.result ?? null) as never,
      lastReleaseError: null,
      updatedAt: new Date(),
    })
    .where(eq(computeLeases.id, lease.id));
  await recordOnProposal(lease, {
    status: "released",
    at: at.toISOString(),
    mode: "destroy",
    resourceId: lease.resourceId,
    releaseVerb: lease.releaseVerb,
    reason: "ttl",
  }).catch((err: unknown) =>
    logger.warn(
      { err, leaseId: lease.id },
      "compute release recorded on the lease, not on its proposal"
    )
  );
  return true;
}

/** One sweep: release every active lease past its TTL (a batch per tick). */
export async function releaseExpiredComputeLeases(opts?: {
  now?: Date;
  limit?: number;
}): Promise<ReleaseExpiredResult> {
  const now = opts?.now ?? new Date();
  const due = await db
    .select()
    .from(computeLeases)
    .where(
      and(eq(computeLeases.state, "active"), lte(computeLeases.expiresAt, now))
    )
    .orderBy(asc(computeLeases.expiresAt))
    .limit(opts?.limit ?? COMPUTE_SWEEP_BATCH);
  let released = 0;
  let failed = 0;
  for (const lease of due) {
    if (await releaseOne(lease)) released += 1;
    else failed += 1;
  }
  return { due: due.length, released, failed };
}
