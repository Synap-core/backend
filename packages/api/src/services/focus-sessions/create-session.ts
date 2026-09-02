/**
 * createFocusSession — shared service behind both Hub REST and MCP adapter.
 *
 * Creates a focus session (goal-bound work session) with governance gating.
 * Idempotent by correlationId. Emits realtime events for browser mirroring.
 */
import {
  db,
  focusSessions,
  playbooks,
  playbookRuns,
  eq,
  and,
  recordSessionSpawn,
} from "@synap/database";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { ensureSessionChannel } from "./ensure-session-channel.js";

/** RFC-4122 UUID shape — templateId may be a legacy free-text template name. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key of a playbook's first stage, or null for a stageless playbook.
 * Stages are stored as JSONB, so this stays defensive about shape rather than
 * trusting the row to be well-formed.
 */
export function firstStageKey(stages: unknown): string | null {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  const first = stages[0] as { key?: unknown } | null;
  const key = first && typeof first === "object" ? first.key : undefined;
  return typeof key === "string" && key.length > 0 ? key : null;
}

export interface CreateFocusSessionParams {
  userId: string;
  /**
   * Workspace the session belongs to. Optional — a session may instead be
   * anchored to a project or live on the user floor. When null/undefined the governance membrane
   * treats it as a personal resource and auto-grants (no membership needed).
   */
  workspaceId?: string | null;
  projectId?: string | null;
  /**
   * The entity this session is "about" — the subject-spine anchor. Written on
   * the ad-hoc start path so a session can be tied to a person/company/deal.
   */
  subjectEntityId?: string | null;
  goal: string;
  agentUserId?: string;
  correlationId?: string;
  channelId?: string | null;
  agentIds?: string[];
  templateId?: string | null;
  expectedOutputs?: Array<{
    kind: string;
    label: string;
    icon?: string;
    status?: "pending" | "done";
  }>;
  /**
   * The session this one was PUSHED FROM — a detour. Recorded as
   * `session --spawned_from--> session` (the edge, never a column: see
   * `schema/links.ts`). The parent must belong to the same user; an unowned or
   * unknown parent drops the edge rather than failing the create.
   *
   * The child NEVER inherits the parent's `metadata` — least of all
   * `metadata.governance`, which `deriveSessionForceProposeGovernance` reads to
   * force-propose every AI write in the session.
   */
  parentSessionId?: string | null;
  /**
   * "What were you about to do" — one line captured at SUSPENSION and written
   * onto the PARENT's `metadata.suspended`, so popping back restates the goal.
   * Only meaningful together with `parentSessionId`.
   */
  suspendedIntent?: string | null;
}

export type CreateFocusSessionResult =
  | { status: "created"; session: typeof focusSessions.$inferSelect }
  | {
      status: "proposed";
      proposalId: string;
      message: string;
      summary?: string;
      reasoning?: string;
      reviewPath?: string;
      reviewUrl?: string;
    };

export async function createFocusSession(
  params: CreateFocusSessionParams
): Promise<CreateFocusSessionResult> {
  const {
    userId,
    workspaceId = null,
    projectId = null,
    subjectEntityId = null,
    goal,
    agentUserId,
    correlationId,
    channelId = null,
    agentIds = [],
    templateId = null,
    expectedOutputs = [],
    parentSessionId = null,
    suspendedIntent = null,
  } = params;

  // Idempotency: correlationId returns the existing session for this user,
  // scoped to the same workspace when one is given.
  if (correlationId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.correlationId, correlationId),
        eq(focusSessions.userId, userId),
        ...(workspaceId ? [eq(focusSessions.workspaceId, workspaceId)] : [])
      ),
    });
    if (existing) return { status: "created", session: existing };
  }

  // Governance membrane — AI callers route through proposals. A session with no
  // workspace is a personal resource and auto-grants via checkPermissionOrPropose.
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: workspaceId ?? undefined,
    projectId: projectId ?? undefined,
    subjectType: "focus_session",
    action: "create",
    source: "intelligence",
    // Carry the non-goal fields through the proposal so the approve executor
    // (proposals/approve-executors.ts, focus_session/create) can materialize a
    // full session — otherwise they'd be lost on the PROPOSED path. Only include
    // when present to keep the persisted data lean.
    data: {
      goal,
      templateId,
      ...(subjectEntityId ? { subjectEntityId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(expectedOutputs.length > 0 ? { expectedOutputs } : {}),
      ...(agentIds.length > 0 ? { agentIds } : {}),
      // Detour lineage must survive the PROPOSED path too, or an agent-opened
      // detour silently loses its parent on approval (the plumbed-field-with-
      // no-producer shape this whole slice exists to retire). Applied by
      // `proposals/executors/focus-session.ts` after the row is inserted.
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(suspendedIntent ? { suspendedIntent } : {}),
    },
  });

  if ("denied" in perm && perm.denied) {
    throw Object.assign(new Error(perm.reason), { code: "FORBIDDEN" });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      message: "Focus session creation proposed for review",
      summary: perm.summary,
      reasoning: perm.reasoning,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }

  // If `templateId` is a real Playbook id, this session IS a playbook run: wire
  // the canonical `playbookId` + a `playbook_runs` ledger row so it surfaces in
  // the runs feed. Writing ONLY the deprecated `templateId` (legacy behavior, kept
  // below for compat) produced disconnected "ghost" sessions that ran forever with
  // no ledger row. A non-UUID / free-text templateId resolves to no playbook →
  // unchanged legacy behavior. (Guard the UUID first — comparing a uuid column to
  // free text throws in Postgres.)
  const playbook =
    templateId && UUID_RE.test(templateId)
      ? ((await db.query.playbooks.findFirst({
          where: eq(playbooks.id, templateId),
        })) ?? null)
      : null;

  // Session + its playbook_runs ledger row land in ONE transaction: the
  // correlationId idempotency check returns the existing session on retry, so
  // a partial state (session without its run row) could never be repaired.
  const created = await db.transaction(async (tx) => {
    const [session] = await tx
      .insert(focusSessions)
      .values({
        workspaceId,
        projectId,
        subjectEntityId,
        userId,
        goal,
        correlationId: correlationId ?? null,
        templateId,
        playbookId: playbook?.id ?? null,
        // Typed origin (migration 0240) — stamped from what this door already
        // resolved, never re-sniffed from metadata. A session created here is a
        // playbook run exactly when `templateId` resolved to a real playbook;
        // automation-origin sessions never come through here, they come through
        // `openRunSession`. Readers prefer this column and fall back to the
        // legacy metadata sniff only for rows a non-stamping writer produced.
        origin: playbook ? "playbook" : "agent",
        // `focus_sessions.current_stage` is documented as "seeded from the
        // playbook's first stage on instantiation" — but this door only ever
        // wired playbookId, so a session started from a staged playbook opened
        // with a NULL stage and every stage-aware surface read it as stageless.
        // Seed it here so the column matches its contract from birth; stageless
        // playbooks (stages: []) correctly stay NULL.
        currentStage: firstStageKey(playbook?.stages),
        expectedOutputs,
        channelId,
        agentIds,
        status: "active",
      })
      .returning();

    // The playbook_runs ledger row (status "running") so the runs feed sees the
    // session. Mirrors run-playbook.ts's executeSingleRun insert (executor +
    // definition snapshot), minus the executor dispatch — starting a session is
    // "I'm working on this playbook", not a full executor run.
    if (playbook) {
      await tx.insert(playbookRuns).values({
        workspaceId,
        playbookId: playbook.id,
        sessionId: session.id,
        executor: playbook.executor,
        status: "running",
        createdBy: agentUserId ?? userId,
        definitionSnapshot: {
          version: playbook.version,
          goalTemplate: playbook.goalTemplate,
          stages: playbook.stages,
          params: playbook.params,
          expectedOutputs: playbook.expectedOutputs,
        },
      });
    }
    return session;
  });

  // Gate 2: always mint a work channel when the caller did not supply one
  // (parity with runPlaybook). Re-load so the returned row includes channelId.
  let sessionOut = created;
  if (!created.channelId) {
    const channelId = await ensureSessionChannel({
      sessionId: created.id,
      userId,
      workspaceId: created.workspaceId,
      goal: created.goal,
    });
    if (channelId) {
      const reloaded = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, created.id),
      });
      if (reloaded) sessionOut = reloaded;
    }
  }

  // Detour lineage: `child --spawned_from--> parent` (+ the suspend note on the
  // parent). AFTER the session exists, and never inside the transaction — a bad
  // parent handle must not roll back a legitimate session. The producer owns the
  // owner floor and the "never inherit governance" invariant.
  if (parentSessionId) {
    await recordSessionSpawn({
      childSessionId: sessionOut.id,
      parentSessionId,
      userId,
      workspaceId: sessionOut.workspaceId,
      suspendedIntent,
    });
  }

  emitHubRealtimeEvent({
    eventType: "focus_session.create.completed",
    subjectId: sessionOut.id,
    userId,
    data: {
      id: sessionOut.id,
      workspaceId: sessionOut.workspaceId,
      status: sessionOut.status,
      goal: sessionOut.goal,
      progress: sessionOut.progress,
    },
  });

  return { status: "created", session: sessionOut };
}
