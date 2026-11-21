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
 *
 * A NEW POD'S SERVER (its start carried a pod registration code, plan
 * a640c5bb B1) is the exception: each tick asks the Control Plane whether
 * that code registered, and a registered one ends `kept` (the person's pod
 * now, never destroyed). At its TTL it is destroyed only when the Control
 * Plane answers "not registered": an unread answer is not a no, so it is
 * recorded as the attempt's error and asked again next tick.
 * Run by the `compute-lease-sweeper` cron (@synap/jobs, every 5 min, one at a
 * time), filled at boot by apps/api.
 */
import {
  db,
  and,
  eq,
  lte,
  asc,
  isNotNull,
  drizzleSql,
  computeLeases,
  proposals,
  type ComputeLease,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { runResolvedSkill } from "../capabilities/execute-capability.js";
import { keepComputeLease, resolveReleaseVerb } from "./compute-leases.js";
import {
  readPodRegistrationStatus,
  type PodRegistrationStatus,
} from "./pod-registration-status.js";

const logger = createLogger({ module: "compute-lease-sweeper" });

/** How many leases one tick releases at most. */
export const COMPUTE_SWEEP_BATCH = 25;

export interface ReleaseExpiredResult {
  due: number;
  released: number;
  failed: number;
  /** New pods' servers whose code registered this tick (kept, not destroyed). */
  kept: number;
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

/** Keep a new pod's server whose code registered; recorded on its proposal. */
async function keepOne(
  lease: ComputeLease,
  podId: string | null
): Promise<boolean> {
  const at = new Date();
  if (!(await keepComputeLease({ leaseId: lease.id, podId, at }))) return false;
  await recordOnProposal(lease, {
    status: "kept",
    at: at.toISOString(),
    reason: "pod_registered",
    resourceId: lease.resourceId,
    podId,
  }).catch((err: unknown) =>
    logger.warn(
      { err, leaseId: lease.id },
      "compute lease kept, not recorded on its proposal"
    )
  );
  return true;
}

/**
 * The keep pass: every active lease of a new pod's server asks whether its
 * code registered. Returns each lease's answer, read once per tick.
 */
async function keepRegisteredLeases(
  limit: number
): Promise<{ kept: number; answers: Map<string, PodRegistrationStatus> }> {
  const pending = await db
    .select()
    .from(computeLeases)
    .where(
      and(
        eq(computeLeases.state, "active"),
        isNotNull(computeLeases.registrationCodeHash)
      )
    )
    .orderBy(asc(computeLeases.expiresAt))
    .limit(limit);
  const answers = new Map<string, PodRegistrationStatus>();
  let kept = 0;
  for (const lease of pending) {
    const status = await readPodRegistrationStatus(lease.registrationCodeHash!);
    answers.set(lease.id, status);
    if (status.state === "registered" && (await keepOne(lease, status.podId))) {
      kept += 1;
    }
  }
  return { kept, answers };
}

async function releaseOne(
  lease: ComputeLease,
  answers: Map<string, PodRegistrationStatus>
): Promise<"released" | "kept" | "failed"> {
  const at = new Date();
  // Claim this attempt; another tick that already ended it finds no row.
  const [claimed] = await db
    .update(computeLeases)
    .set({
      releaseAttempts: drizzleSql`${computeLeases.releaseAttempts} + 1`,
      updatedAt: at,
    })
    .where(
      and(eq(computeLeases.id, lease.id), eq(computeLeases.state, "active"))
    )
    .returning({ id: computeLeases.id });
  if (!claimed) return "failed";

  const fail = async (message: string): Promise<"failed"> => {
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
    return "failed";
  };

  // A new pod's server is destroyed only on the Control Plane's "not
  // registered": registered keeps it, and an unread answer is not a no.
  if (lease.registrationCodeHash) {
    const status =
      answers.get(lease.id) ??
      (await readPodRegistrationStatus(lease.registrationCodeHash));
    if (status.state === "registered") {
      return (await keepOne(lease, status.podId)) ? "kept" : "failed";
    }
    if (status.state === "unread") {
      return fail(
        `Could not read whether this server registered as a pod (${status.reason}); it is not destroyed until the Control Plane answers.`
      );
    }
  }

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
  return "released";
}

/**
 * One sweep: keep every new pod's server whose code registered, then release
 * every active lease past its TTL (a batch each per tick).
 */
export async function releaseExpiredComputeLeases(opts?: {
  now?: Date;
  limit?: number;
}): Promise<ReleaseExpiredResult> {
  const now = opts?.now ?? new Date();
  const { kept, answers } = await keepRegisteredLeases(
    opts?.limit ?? COMPUTE_SWEEP_BATCH
  );
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
  let keptAtTtl = 0;
  for (const lease of due) {
    const outcome = await releaseOne(lease, answers);
    if (outcome === "released") released += 1;
    else if (outcome === "kept") keptAtTtl += 1;
    else failed += 1;
  }
  return { due: due.length, released, failed, kept: kept + keptAtTtl };
}
