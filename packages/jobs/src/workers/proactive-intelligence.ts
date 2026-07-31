/**
 * Proactive Intelligence — Scan (cluster assembly → IS brain)
 *
 *   proactive.scan — debounced cluster assembly. Gathers recent entities of the
 *                    same profile in the workspace into a compact candidate list,
 *                    then hands it to the intelligence service (POST
 *                    /api/proactive-scan) which runs the agent and emits a
 *                    proposal or a proactive_post nudge.
 *
 * This is the proactive *delivery/aggregation* primitive. It is reachable as an
 * action a loop or automation can invoke — it is no longer auto-fired by a
 * hardcoded entity create/update hook. The parallel `proactive.evaluate` gate
 * (per-event trigger map) was retired; proactive triggering is now expressed as
 * automations/loops over the unified spine.
 */

import type PgBoss from "pg-boss";
import { db, eq, and, gte, desc, isNull, entities } from "@synap/database";
import { createLogger } from "@synap-core/core";
// Type-only: the VALUE side of @synap/intelligence-client is loaded via dynamic
// import below (this module's existing pattern), and a type import is erased.
import type { ISCallContext } from "@synap/intelligence-client";

const logger = createLogger({ module: "proactive-intelligence" });

// ── Queue names ──────────────────────────────────────────────────────────────

export const PROACTIVE_SCAN_QUEUE = "proactive.scan";

// ── Constants ────────────────────────────────────────────────────────────────

/** Cluster lookback window for scan assembly. */
const CLUSTER_LOOKBACK_DAYS = 7;

/** Max candidates assembled per scan (compact list for the IS). */
const CLUSTER_LIMIT = 25;

/**
 * The trigger types a proactive scan clusters around. Keyed identically to
 * ProactiveAiTriggers in the workspace schema.
 */
type TriggerType =
  "captureCluster" | "taskCompleted" | "questionCreated" | "decisionCreated";

// ── Job payload ──────────────────────────────────────────────────────────────

interface ScanPayload {
  workspaceId: string;
  triggerType: TriggerType;
  userId: string;
  seedEntityId: string;
}

// ── proactive.scan ───────────────────────────────────────────────────────────

interface Candidate {
  id: string;
  title: string;
  profileSlug: string;
}

/**
 * Profile slug each trigger clusters around. captureCluster/questionCreated/
 * decisionCreated cluster around their own profile; taskCompleted clusters the
 * recent tasks so the IS can connect a finished task back to its peers.
 */
const TRIGGER_PROFILE: Record<TriggerType, string> = {
  captureCluster: "capture",
  taskCompleted: "task",
  questionCreated: "question",
  decisionCreated: "decision",
};

export async function handleProactiveScan(
  job: PgBoss.Job<ScanPayload>
): Promise<void> {
  const { workspaceId, triggerType, seedEntityId, userId } = job.data;

  const profileSlug = TRIGGER_PROFILE[triggerType];
  const since = new Date(
    Date.now() - CLUSTER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );

  // Gather the cluster: recent, non-deleted entities of the same profile in the
  // workspace. The seed is naturally included if it falls in-window.
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      profileSlug: entities.type,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.type, profileSlug),
        isNull(entities.deletedAt),
        gte(entities.createdAt, since)
      )
    )
    .orderBy(desc(entities.createdAt))
    .limit(CLUSTER_LIMIT);

  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
    title: r.title ?? "",
    profileSlug: r.profileSlug,
  }));

  logger.info(
    { workspaceId, triggerType, seedEntityId, clusterSize: candidates.length },
    "proactive.scan: cluster assembled"
  );

  // ── Hand the cluster to the intelligence-service "brain" ───────────────────
  // Resolve the workspace's IS, then POST the cluster to POST /api/proactive-scan.
  // The IS runs the orchestrator agent once (reframed via SECTION_EVENT_CONTEXT)
  // and emits at most ONE side effect: a single-entity proposal, or a
  // proactive_post nudge. Wholly non-fatal — a proactive miss must never crash
  // the worker or trigger a pg-boss retry.
  await callProactiveScanBrain({
    workspaceId,
    triggerType,
    seedEntityId,
    userId,
    candidates,
  });
}

/**
 * Hand the assembled cluster to the intelligence-service.
 *
 * Auth mirrors the a2ai-response-trigger convention: resolve the workspace's IS
 * via the intelligence-client and authenticate with the resolved customer API
 * key (Bearer). That lets the IS resolve the pod URL + Hub Protocol key from the
 * customer record, which the agent's write tools (create_entity → proposal,
 * proactive_post) require. The intelligence-client is dynamically imported to
 * keep the @synap/jobs → @synap/api boundary clean (same pattern as ai-workers).
 *
 * Never throws — every failure path logs and returns cleanly.
 */
async function callProactiveScanBrain(args: {
  workspaceId: string;
  triggerType: TriggerType;
  seedEntityId: string;
  userId: string;
  candidates: Candidate[];
}): Promise<void> {
  const { workspaceId, triggerType, seedEntityId, userId, candidates } = args;

  // Set just before the fetch so the catch below can attribute a failure
  // (side / elapsed / budget / endpoint / payload size) instead of logging a
  // bare "aborted due to timeout" with no way to tell a pod-side abort from an
  // IS crash. Null while we are still resolving the service.
  let callCtx: ISCallContext | null = null;

  try {
    const { resolveIntelligenceService, isCallBudgetMs } =
      await import("@synap/intelligence-client");

    const service = await resolveIntelligenceService({
      userId,
      workspaceId,
      capability: "default",
    });

    if (!service?.endpoint) {
      logger.info(
        { workspaceId, triggerType },
        "proactive.scan: no intelligence service resolved — skipping brain"
      );
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (service.serviceApiKey) {
      headers["Authorization"] = `Bearer ${service.serviceApiKey}`;
    }

    const endpoint = `${service.endpoint.replace(/\/$/, "")}/api/proactive-scan`;
    const body = JSON.stringify({
      workspaceId,
      triggerType,
      seedEntityId,
      candidates,
      userId,
      // Agent-user authorship for any proposal the IS creates (optional).
      agentUserId: service.agentUserId,
    });
    // `generation` budget, not a literal: /api/proactive-scan invokes a model,
    // so it has the same reasoning-model exposure that made the bare 60_000
    // here bite in the 2026-07-31 incident. See is-call-budget.ts.
    const budgetMs = isCallBudgetMs("generation");
    callCtx = {
      kind: "generation",
      endpoint,
      budgetMs,
      payloadChars: body.length,
      startedAt: Date.now(),
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(budgetMs),
    });

    if (!res.ok) {
      logger.warn(
        { workspaceId, triggerType, status: res.status },
        "proactive.scan: brain call returned non-OK (non-fatal)"
      );
      return;
    }

    logger.info(
      { workspaceId, triggerType, clusterSize: candidates.length },
      "proactive.scan: brain invoked"
    );
  } catch (err) {
    // Non-fatal: a proactive miss must never crash the worker. But non-fatal is
    // not the same as unattributed — this path swallowed the 2026-07-31 incident
    // shape (a bare 60s abort) into a warn that named neither side nor elapsed.
    // If we got as far as the fetch, describe it in the same one-line format the
    // executor writes to `automation_step_runs.error_message`, so ONE grep finds
    // an IS timeout regardless of which surface it happened on.
    const { describeISFailure } = await import("@synap/intelligence-client");
    logger.warn(
      {
        err,
        workspaceId,
        triggerType,
        attribution: callCtx
          ? describeISFailure(callCtx, err).message
          : undefined,
      },
      "proactive.scan: brain call failed (non-fatal)"
    );
  }
}
