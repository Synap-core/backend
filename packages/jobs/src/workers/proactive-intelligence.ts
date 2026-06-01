/**
 * Proactive Intelligence Workers (Feature C, Phase 2)
 *
 * Event-driven proactive AI backend pipeline. Two queues:
 *
 *   proactive.evaluate  — cheap per-event gate. Loads the entity, applies the
 *                         loop guard, reads the workspace's proactiveAi prefs,
 *                         maps the event to a trigger type, and (if the trigger
 *                         is opted-in) schedules a DEBOUNCED scan.
 *
 *   proactive.scan      — debounced cluster assembly. Gathers recent entities of
 *                         the same profile in the workspace into a compact
 *                         candidate list, then hands it to the intelligence
 *                         service (POST /api/proactive-scan) which runs the agent
 *                         and emits a proposal or a proactive_post nudge.
 *
 * Dispatch: setup-event-broadcasting.ts "Hook 5" enqueues `proactive.evaluate`
 * on entity.create.validated / entity.update.validated only.
 *
 * The validated event carries only { id, type, title } (see EntityEvents in
 * event-helpers.ts) — no profileSlug / workspaceId / status — so the worker
 * loads the entity to recover everything it needs.
 */

import type PgBoss from "pg-boss";
import {
  db,
  eq,
  and,
  gte,
  desc,
  isNull,
  drizzleSql,
  entities,
  workspaces,
  users,
  events,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import type { ProactiveAiPreferences } from "@synap/database/schema";

const logger = createLogger({ module: "proactive-intelligence" });

// ── Queue names ──────────────────────────────────────────────────────────────

export const PROACTIVE_EVALUATE_QUEUE = "proactive.evaluate";
export const PROACTIVE_SCAN_QUEUE = "proactive.scan";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Debounce window for scans. Many qualifying events for the same
 * (workspace, triggerType) within 15 minutes collapse into a single scan via
 * the pg-boss singletonKey/singletonSeconds mechanism.
 */
const SCAN_DEBOUNCE_SECONDS = 15 * 60; // 900s

/** Cluster lookback window for scan assembly. */
const CLUSTER_LOOKBACK_DAYS = 7;

/** Max candidates assembled per scan (compact list for the IS). */
const CLUSTER_LIMIT = 25;

/**
 * Task status values that count as "done/completed". The task profile enum is
 * ["todo", "in-progress", "done", "cancelled"]; "completed" is accepted too as a
 * defensive synonym for non-system task profiles.
 */
const DONE_STATUSES = new Set(["done", "completed"]);

/**
 * The trigger types Feature C reacts to. Keyed identically to
 * ProactiveAiTriggers in the workspace schema.
 */
type TriggerType =
  | "captureCluster"
  | "taskCompleted"
  | "questionCreated"
  | "decisionCreated";

// ── Job payloads ─────────────────────────────────────────────────────────────

interface EvaluatePayload {
  entityId: string;
  /** "entity" — subject type from the event (kept for forward-compat). */
  eventType: string;
  /** "create" | "update" — the event action. */
  action: string;
  userId: string;
  correlationId?: string;
}

interface ScanPayload {
  workspaceId: string;
  triggerType: TriggerType;
  userId: string;
  seedEntityId: string;
}

// ── proactive.evaluate ───────────────────────────────────────────────────────

export async function handleProactiveEvaluate(
  job: PgBoss.Job<EvaluatePayload>
): Promise<void> {
  // Non-fatal wrapper: evaluate runs on EVERY entity create/update, so a
  // transient DB error must never throw — that would trigger a pg-boss retry
  // storm across the whole event stream. A missed evaluation is acceptable.
  try {
    await evaluateEntity(job);
  } catch (err) {
    logger.warn(
      { err, entityId: job.data.entityId },
      "proactive.evaluate failed (non-fatal)"
    );
  }
}

async function evaluateEntity(job: PgBoss.Job<EvaluatePayload>): Promise<void> {
  const { entityId, action, userId } = job.data;

  // 1. Load the entity. The validated event only carries { id, type, title },
  //    so everything the gate needs (profileSlug=type, workspaceId, properties)
  //    comes from the row.
  const [entity] = await db
    .select({
      id: entities.id,
      userId: entities.userId,
      workspaceId: entities.workspaceId,
      profileSlug: entities.type, // `type` is populated from profile.slug
      properties: entities.properties,
      systemData: entities.systemData,
    })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);

  if (!entity) {
    logger.debug(
      { entityId },
      "proactive.evaluate: entity not found, skipping"
    );
    return;
  }

  // 2. LOOP GUARD — never let a proactively/AI-created entity re-trigger.
  //
  //    Without this, an AI-created Question (questionCreated trigger) or any
  //    agent-materialised entity would emit entity.create.validated, which would
  //    enqueue another evaluate, which could trigger another agent run, ad
  //    infinitum. We block at the source by detecting AI/agent provenance from
  //    two independent signals (either one is sufficient to skip):
  //
  //    (a) The entity's owning user is an agent (users.userType === 'agent').
  //    (b) Any create/update event for this subject is AI-sourced
  //        ('ai'|'intelligence'|'agent') OR came from an APPROVED PROPOSAL
  //        (event data carries `approvedBy`). (b)'s proposal case is essential:
  //        a human-approved AI proposal materialises the entity under the human
  //        approver's userId with event source 'api' — so without the
  //        approved-proposal check, an AI-proposed Question/Decision would look
  //        human and re-enter the pipeline (cross-trigger amplification).
  if (await isAiOrigin(entity.userId, entityId)) {
    logger.debug(
      { entityId },
      "proactive.evaluate: AI/agent-origin entity, skipping (loop guard)"
    );
    return;
  }

  const workspaceId = entity.workspaceId;
  if (!workspaceId) {
    // Global (cross-workspace) entities have no proactiveAi lens to consult.
    logger.debug(
      { entityId },
      "proactive.evaluate: entity has no workspace, skipping"
    );
    return;
  }

  // 3. Load workspace proactiveAi settings.
  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const proactiveAi = ws?.settings?.proactiveAi as
    | ProactiveAiPreferences
    | undefined;

  if (!proactiveAi || !proactiveAi.enabled) {
    return;
  }
  if (
    proactiveAi.mutedUntil &&
    new Date(proactiveAi.mutedUntil).getTime() > Date.now()
  ) {
    return; // snoozed
  }

  // 4. Map (profileSlug, action) → trigger type.
  const triggerType = resolveTriggerType(
    entity.profileSlug,
    action,
    (entity.properties as Record<string, unknown>) ?? {}
  );
  if (!triggerType) {
    return;
  }

  // 5. Honour the per-trigger opt-in (all default OFF).
  if (proactiveAi.triggers?.[triggerType] !== true) {
    return;
  }

  // 6. Schedule a DEBOUNCED scan. `singletonKey` + `singletonSeconds` admit at
  //    most one scan per (workspace, trigger) per window; `startAfter` delays it
  //    by the same window so a burst of qualifying events settles BEFORE the
  //    scan runs — and the scan re-reads the full (warm) cluster at execution
  //    time. Net effect: trailing-edge debounce, one scan per burst.
  const payload: ScanPayload = {
    workspaceId,
    triggerType,
    userId,
    seedEntityId: entityId,
  };
  await getBoss().send(PROACTIVE_SCAN_QUEUE, payload, {
    singletonKey: `${workspaceId}:${triggerType}`,
    singletonSeconds: SCAN_DEBOUNCE_SECONDS,
    startAfter: SCAN_DEBOUNCE_SECONDS,
  });

  logger.info(
    { workspaceId, triggerType, seedEntityId: entityId },
    "proactive.evaluate: scan scheduled (debounced)"
  );
}

/**
 * Map an entity event to a Feature C trigger type, or null if it doesn't qualify.
 *
 *   capture  + create                          → captureCluster
 *   task     + update where status is done/*   → taskCompleted
 *   question + create                          → questionCreated
 *   decision + create                          → decisionCreated
 */
function resolveTriggerType(
  profileSlug: string,
  action: string,
  properties: Record<string, unknown>
): TriggerType | null {
  if (action === "create") {
    if (profileSlug === "capture") return "captureCluster";
    if (profileSlug === "question") return "questionCreated";
    if (profileSlug === "decision") return "decisionCreated";
    return null;
  }
  if (action === "update" && profileSlug === "task") {
    const status =
      typeof properties.status === "string"
        ? properties.status.toLowerCase()
        : undefined;
    if (status && DONE_STATUSES.has(status)) return "taskCompleted";
    return null;
  }
  return null;
}

/**
 * Loop guard. Returns true if the entity is of AI/agent provenance (full
 * rationale at the call site in handleProactiveEvaluate). Two non-fatal signals:
 * (a) owner is an agent user; (b) any create/update event is AI-sourced or
 * proposal-approved. On query failure we fall through to "not AI" rather than
 * block a real user's nudge.
 */
async function isAiOrigin(
  entityUserId: string,
  entityId: string
): Promise<boolean> {
  try {
    const [owner] = await db
      .select({ userType: users.userType })
      .from(users)
      .where(eq(users.id, entityUserId))
      .limit(1);
    if (owner?.userType === "agent") return true;
  } catch (err) {
    logger.warn(
      { err, entityId },
      "loop guard: owner lookup failed (non-fatal)"
    );
  }

  try {
    // Treat as AI/agent origin if ANY create/update event for this subject is
    // either (i) AI-sourced, or (ii) carries an approved-proposal marker.
    //
    // (ii) is the important case: a HUMAN-approved AI proposal materialises the
    // entity under the human approver's userId with event source 'api' — so the
    // source check alone misses it — but the .validated event carries
    // `data.approvedBy` (see proposals.ts). Anything that came from an approved
    // proposal was AI/agent-authored and must never re-trigger a scan.
    // Checking for ANY matching event (not just the latest) is robust against a
    // later non-AI event re-stamping the subject.
    const [hit] = await db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.subjectId, entityId),
          drizzleSql`${events.type} IN ('entity.create.validated', 'entity.update.validated')`,
          drizzleSql`(${events.source} IN ('ai', 'intelligence', 'agent') OR ${events.data} ->> 'approvedBy' IS NOT NULL)`
        )
      )
      .limit(1);
    if (hit) return true;
  } catch (err) {
    logger.warn(
      { err, entityId },
      "loop guard: event provenance lookup failed (non-fatal)"
    );
  }

  return false;
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

  // ── Phase 3: hand the cluster to the intelligence-service "brain" ──────────
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

  try {
    const { resolveIntelligenceService } =
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

    const res = await fetch(
      `${service.endpoint.replace(/\/$/, "")}/api/proactive-scan`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          workspaceId,
          triggerType,
          seedEntityId,
          candidates,
          userId,
          // Agent-user authorship for any proposal the IS creates (optional).
          agentUserId: service.agentUserId,
        }),
        signal: AbortSignal.timeout(60_000),
      }
    );

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
    // Non-fatal: a proactive miss must never crash the worker.
    logger.warn(
      { err, workspaceId, triggerType },
      "proactive.scan: brain call failed (non-fatal)"
    );
  }
}
