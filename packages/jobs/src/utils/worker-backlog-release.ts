/**
 * WORKER BACKLOG RELEASE (work model L4, arch F12).
 *
 * A worker's `maxPendingApprovals` THROTTLES; it must not lose work. A fire
 * skipped by the backlog is HELD (`steps/playbook-run.ts` stamps the step
 * output, `listHeldWorkerRuns` reads it back). When a person decides one of
 * that enablement's proposals, the backlog may have drained: each held fire
 * that nothing superseded is re-run ONCE with its own trigger, oldest first,
 * up to the room the backlog now has.
 *
 * The re-run goes through the executor like any fire, so every gate runs
 * again: the backlog (still full ⇒ held again, offered at the next drain),
 * the ceiling, and the stale check (the thing left the status ⇒
 * `stale_transition`, nothing starts). "The things still in the status that
 * have no run of this enablement" is exactly that: a held fire whose thing
 * moved on is answered by the stale check, and one already run again is
 * superseded by its later run.
 *
 * Exactly once per held fire: the release claims the held run id in
 * `automation_claims` (namespace `worker-release`, the same unique boundary
 * the event matcher claims on). A concurrent release loses the claim and
 * marks its own run skipped, the matcher's own shape.
 *
 * A per_moment fire covers its whole set, so only the newest held one is
 * released. LIMIT: a proposal decided outside a workspace emits no
 * `proposal.*.completed` side-effect, so it releases nothing; neither does a
 * withdrawal or an expiry. The next decided proposal releases them.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  automations,
  automationRuns,
  automationClaims,
  focusSessions,
  proposals,
  drizzleSql,
  countWorkerPendingApprovals,
  listHeldWorkerRuns,
  type PlaybookRunWorkerSpec,
} from "@synap/database";
import { getBoss } from "@synap/events";
import {
  limitWithOwnValue,
  resolveCeiling,
} from "@synap/database/agent-governance";
import { WORKER_MAX_PENDING_APPROVALS_CEILING } from "@synap-core/types/workers";
import { AUTOMATION_SKIP_REASONS } from "@synap-core/types/automations";

const logger = createLogger({ module: "worker-backlog-release" });

/** `automation_claims.namespace` of a release (one per held run). */
export const WORKER_RELEASE_CLAIM_NAMESPACE = "worker-release" as const;

/** The worker spec of an automation's `playbook_run` node, if it has one. */
export function workerSpecOfFlow(
  flowDefinition: unknown
): PlaybookRunWorkerSpec | null {
  const nodes = (flowDefinition as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    const node = n as { type?: unknown; data?: { worker?: unknown } };
    if (node.type !== "playbook_run") continue;
    const w = node.data?.worker as PlaybookRunWorkerSpec | undefined;
    if (w && typeof w.key === "string") return w;
  }
  return null;
}

/**
 * THE effective "sends waiting on a person" cap of ONE worker enablement (the
 * caps fold, W1c): the enablement's own `maxPendingApprovals`, which a
 * `governance_ceilings` row (axis `worker_pending_approvals`, for this
 * automation or pod-wide) can only TIGHTEN; with no own value, the row; else
 * the default. Clamped to
 * 1..WORKER_MAX_PENDING_APPROVALS_CEILING. Shared by the run gate
 * (`gateWorkerRun`) and the backlog release — one rule.
 */
export async function resolveWorkerMaxPending(
  automationId: string,
  declared: number | undefined
): Promise<number> {
  const ceiling = await resolveCeiling({
    db,
    axis: "worker_pending_approvals",
    subject: { type: "automation", id: automationId },
  });
  const own =
    typeof declared === "number" && Number.isInteger(declared)
      ? declared
      : null;
  const n = limitWithOwnValue(own, ceiling);
  return Math.min(Math.max(n, 1), WORKER_MAX_PENDING_APPROVALS_CEILING);
}

/**
 * Release the held fires of ONE enablement, if its backlog has room. Returns
 * the run ids it enqueued. Never throws for a per-run failure (logged).
 */
export async function releaseHeldWorkerRuns(
  automationId: string
): Promise<string[]> {
  const [automation] = await db
    .select({
      id: automations.id,
      status: automations.status,
      workspaceId: automations.workspaceId,
      flowDefinition: automations.flowDefinition,
    })
    .from(automations)
    .where(eq(automations.id, automationId))
    .limit(1);
  if (!automation || automation.status !== "active") return [];
  const spec = workerSpecOfFlow(automation.flowDefinition);
  if (!spec) return [];

  const room =
    (await resolveWorkerMaxPending(automationId, spec.maxPendingApprovals)) -
    (await countWorkerPendingApprovals(automationId));
  if (room <= 0) return [];
  const held = await listHeldWorkerRuns(
    automationId,
    spec.size === "per_moment" ? 50 : room
  );
  // A per_moment fire works its whole set: the newest held one stands for all.
  const toRelease = spec.size === "per_moment" ? held.slice(-1) : held;

  const released: string[] = [];
  for (const h of toRelease) {
    const workspaceId = h.workspaceId ?? automation.workspaceId;
    if (!workspaceId) continue;
    try {
      const [run] = await db
        .insert(automationRuns)
        .values({
          automationId,
          workspaceId,
          subjectEntityId: h.subjectEntityId ?? undefined,
          triggeredBy: "system",
          triggerEventId: h.triggerEventId ?? undefined,
          triggerPayload: h.triggerPayload,
          replayOf: h.runId,
          status: "running",
        })
        .returning({ id: automationRuns.id });
      const [claimed] = await db
        .insert(automationClaims)
        .values({
          workspaceId,
          namespace: WORKER_RELEASE_CLAIM_NAMESPACE,
          claimKey: h.runId,
          ownerRunId: run!.id,
        })
        .onConflictDoNothing()
        .returning({ id: automationClaims.id });
      if (!claimed) {
        await db
          .update(automationRuns)
          .set({
            status: "skipped",
            errorMessage: AUTOMATION_SKIP_REASONS.eventClaimAlreadyHeld,
            completedAt: new Date(),
          })
          .where(eq(automationRuns.id, run!.id));
        continue;
      }
      await getBoss().send("automation-execute", {
        runId: run!.id,
        automationId,
        workspaceId,
        automationContext: {
          automationRunId: run!.id,
          automationId,
          chainDepth: 0,
          rootRunId: run!.id,
          chainAutomationIds: [automationId],
          ...(h.triggerEventId ? { triggerEventId: h.triggerEventId } : {}),
        },
        producerAgentUserId: h.producerAgentUserId,
      });
      released.push(run!.id);
    } catch (err) {
      logger.warn(
        { err, automationId, heldRunId: h.runId },
        "held worker fire not released (non-fatal) — the next drain retries"
      );
    }
  }
  if (released.length > 0) {
    logger.info(
      { automationId, released: released.length },
      "worker backlog drained — held fires released"
    );
  }
  return released;
}

/**
 * The enablement a decided proposal counted against: a propose-mode
 * `playbook/run` proposal names it (`data.automationId`); a proposal filed
 * inside a worker session names it through the session's stamp. Null = not a
 * worker's proposal.
 */
export async function workerAutomationOfProposal(
  proposalId: string
): Promise<string | null> {
  const [row] = await db
    .select({
      direct: drizzleSql<string | null>`${proposals.data}->>'automationId'`,
      viaSession: drizzleSql<
        string | null
      >`${focusSessions.metadata}->>'automationId'`,
    })
    .from(proposals)
    .leftJoin(focusSessions, eq(focusSessions.id, proposals.sessionId))
    .where(eq(proposals.id, proposalId))
    .limit(1);
  return row?.direct ?? row?.viaSession ?? null;
}
