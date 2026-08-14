/**
 * runPlaybook — the executor-spine runner (Phase 3).
 *
 * Turns a Playbook (config) into a live run:
 *   1. instantiateSession  — config → runtime focus_session (REUSED; no channel).
 *   2. create a channel    — the run's room, per playbook.channelSpec.
 *   3. wire session.channelId.
 *   4. insert playbook_runs — the ledger row (status "running").
 *   5. resolveExecutor(...).run(...) — dispatch to is-agent | external-agent | hybrid.
 *   6. record the result on the run row.
 *
 * This is a pure DOMAIN service — it performs NO governance. The CALLER (the
 * `playbooks.run` tRPC mutation / a scheduled job) MUST run
 * `checkPermissionOrPropose` before invoking it.
 *
 * Provenance NOTE: `session → used → capability` links are written when the
 * agent actually USES a capability, not here — so this runner records only the
 * run + its channel, never premature `used` edges.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.3-4.4).
 */

import {
  getDb,
  eq,
  and,
  desc,
  isNull,
  notInArray,
  channels,
  entities,
  focusSessions,
  playbooks,
  playbookRuns,
  playbookEnrollments,
} from "@synap/database";
import type {
  FocusSession,
  PlaybookRun,
  Playbook,
} from "@synap/database/schema";
import {
  ChannelType,
  ChannelScope,
  ChannelStatus,
} from "@synap/database/schema";
import type {
  ChannelSpec,
  RunResult,
  InputStrategy,
  PlaybookStage,
} from "@synap/playbooks";
import { instantiateSession } from "./playbook-lifecycle.js";
import {
  resolveGrantedCapabilities,
  getLinksFor,
} from "../links/links-service.js";
import { resolveExecutor } from "./executors/registry.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "run-playbook" });

/**
 * The chain context of the automation run that spawned this playbook (F2 depth
 * floor). Stamped onto the session so the agent's downstream Hub writes — which
 * carry the session but no automationContext — re-derive their true chain depth
 * in the trigger matcher, closing the depth-guard hole across the agent boundary.
 * Only the scheduled (automation) path supplies it.
 */
export interface RunChainContext {
  automationRunId: string;
  automationId: string;
  chainDepth: number;
  rootRunId: string;
  chainAutomationIds: string[];
}

export interface RunPlaybookInput {
  /** Resolve the playbook by id; when absent, `playbookName` is used. */
  playbookId?: string;
  /**
   * Resolve the playbook by NAME within this workspace, then a pod-wide (NULL
   * workspace) playbook. The template-friendly form: a capability seeds a
   * playbook + an automation together, and the automation references the playbook
   * by its stable name rather than a runtime id it can't know at author time.
   */
  playbookName?: string;
  workspaceId: string;
  /** The acting principal — used for session.userId, run.createdBy, channel.userId. */
  userId: string;
  params?: Record<string, unknown>;
  /** Extra agent members to add to the run channel. */
  agentIds?: string[];
  /** AI attribution — when set, the run is owned by the agent-user. */
  agentUserId?: string;
  /**
   * Idempotency by subject: when true AND `subjectId` is set, reuse the existing
   * active session for this playbook+subject instead of starting a new run. Makes
   * a scheduled playbook_run safe (start-if-missing, no-op-if-present). Manual
   * runs leave this false so each click starts a fresh run.
   */
  idempotentBySubject?: boolean;
  /**
   * Resolve the goal from the playbook's goalTemplate. The scheduled path passes
   * a resolver closing over the automation StepContext (so `{{trigger.payload.*}}`
   * / `{{steps.*}}` interpolate). Absent ⇒ the template is substituted against
   * `params` (the manual-run behavior) inside instantiateSession.
   */
  goalResolver?: (goalTemplate: string) => string;
  /** Automation chain context — stamped onto the session (F2 depth floor). */
  chainContext?: RunChainContext;
  /** The entity this run is about (e.g. a contact, deal, or document).
   * Stored as focus_sessions.subjectEntityId and forwarded in RunContext. */
  subjectId?: string;
  /**
   * Route the run's external output to this existing channel instead of creating
   * a new playbook channel. When set, the channel-create step is skipped and the
   * existing channel is used as the run room. Intended for delivering playbook
   * output to a client entity's team channel (branchPurpose='team') rather than
   * a throwaway playbook-scoped channel.
   *
   * The caller is responsible for ensuring the channel exists and is accessible
   * to the acting principal.
   */
  targetChannelId?: string;
}

export interface RunPlaybookResult {
  /** The ledger row for this run — NULL when an existing session was reused
   *  (idempotency-by-subject): a reuse starts no new run. */
  run: PlaybookRun | null;
  session: FocusSession;
  /** True when idempotency-by-subject reused an existing active session. */
  reused?: boolean;
}

/**
 * Derive the propose-only governance flag from a playbook's metadata. A
 * maintenance playbook (e.g. CRM hygiene) declares
 * `metadata.governance.forceProposeWrites: true`, which the run stamps onto the
 * session so the write-side gate routes EVERY agent write to a reviewable
 * proposal — the agent runs unattended, so nothing it does should auto-apply.
 * Pure so it is unit-testable. Applies to EVERY run of the playbook (manual or
 * scheduled) — the flag is a property of the playbook, not the trigger.
 */
export function deriveForceProposeWrites(metadata: unknown): boolean {
  const governance = (metadata as Record<string, unknown> | null | undefined)
    ?.governance as { forceProposeWrites?: unknown } | undefined;
  return governance?.forceProposeWrites === true;
}

/**
 * Build the session metadata stamped at creation: the automation chain context
 * (F2 depth floor, keyed by the agent's X-Session-Id in the trigger matcher) and
 * the propose-only governance flag. Empty object when neither applies (session
 * metadata column default). Pure so it is unit-testable.
 */
export function buildRunSessionMetadata(opts: {
  chainContext?: RunChainContext;
  forceProposeWrites: boolean;
}): Record<string, unknown> {
  return {
    ...(opts.chainContext
      ? {
          automationChainContext: {
            automationRunId: opts.chainContext.automationRunId,
            automationId: opts.chainContext.automationId,
            chainDepth: opts.chainContext.chainDepth ?? 0,
            rootRunId:
              opts.chainContext.rootRunId ?? opts.chainContext.automationRunId,
            chainAutomationIds: opts.chainContext.chainAutomationIds ?? [],
          },
        }
      : {}),
    ...(opts.forceProposeWrites
      ? { governance: { forceProposeWrites: true } }
      : {}),
  };
}

/**
 * Snapshot the resolved playbook definition onto the run row (D3c) so "what ran"
 * survives later edits to the playbook config and can be diffed. Pure.
 */
export function buildDefinitionSnapshot(playbook: Playbook): {
  version: number;
  goalTemplate: string;
  stages: unknown;
  params: unknown;
  expectedOutputs: unknown;
} {
  return {
    version: playbook.version,
    goalTemplate: playbook.goalTemplate,
    stages: playbook.stages,
    params: playbook.params,
    expectedOutputs: playbook.expectedOutputs,
  };
}

/**
 * Idempotency-by-subject reuses an existing (playbook, subject) session instead
 * of dispatching a fresh run — UNLESS that session is in one of these TERMINAL
 * states, in which case a new run is allowed again.
 *
 * The bug this closes (Stellar runaway): keying reuse on `status === 'active'`
 * alone re-spawned a fresh session+run on EVERY daily cron once a stuck session
 * aged out of 'active'. The focus-session reaper flips an idle session
 * active/paused → 'stale' at 24h (focus-session-reaper.ts), and the playbook-run
 * reaper later force-fails its orphaned run and flips the session → 'closed'
 * (playbook-run-reaper.ts). Reusing across EVERY non-terminal state (active,
 * paused, stale, forming, scheduled) means a stuck/in-flight subject is not
 * re-dispatched daily; only once the run is terminally failed/closed — session
 * in ('closed' | 'failed' | 'cancelled') — is a new run allowed, so a subject
 * always has a legitimate path back to eligibility and is never permanently
 * locked out. Exported so a test can lock the SHAPE of this decision.
 */
export const IDEMPOTENCY_TERMINAL_SESSION_STATUSES = [
  "closed",
  "failed",
  "cancelled",
] as const;

/** Max runs a single `query`/`rotating` fan-out may spawn (safety bound). */
const MAX_INPUT_FANOUT = 50;

/** Map a ChannelSpec.type to the channels.channelType enum (default THREAD). */
function channelTypeFromSpec(spec: ChannelSpec | undefined) {
  switch (spec?.type) {
    case "GROUP":
      return ChannelType.GROUP;
    case "AGENT_COLLAB":
      return ChannelType.AGENT_COLLAB;
    case "THREAD":
    default:
      return ChannelType.THREAD;
  }
}

/** Narrow the loosely-typed JSONB `inputStrategy` column. */
function readInputStrategy(value: unknown): InputStrategy {
  if (!value || typeof value !== "object") return { kind: "none" };
  const s = value as { kind?: string };
  if (
    s.kind === "static" ||
    s.kind === "rotating" ||
    s.kind === "query" ||
    s.kind === "none"
  ) {
    return value as InputStrategy;
  }
  return { kind: "none" };
}

/**
 * Resolve a playbook's InputStrategy into the set of run items to execute.
 *
 *   - none / static-empty → exactly ONE run with the caller's params (the
 *     baseline behavior; `static` with items fans one run per item).
 *   - static  → one run per declared item.
 *   - rotating → advance a cursor stored in `playbook.metadata.inputCursor`
 *     (NO new column) and run for the CURRENT item only.
 *   - query   → TODO(P-query): resolve `sourceSubscriptionId` into a live item
 *     set. Not yet implemented — runs ONCE with the caller's params so the
 *     playbook still fires (we do NOT fabricate items).
 *
 * Returns the per-run `input` payloads, capped at MAX_INPUT_FANOUT.
 */
async function resolveInputItems(
  playbook: Playbook,
  baseParams: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> {
  const strategy = readInputStrategy(playbook.inputStrategy);

  switch (strategy.kind) {
    case "none":
      return [baseParams];

    case "static": {
      const items = strategy.items ?? [];
      if (items.length === 0) return [baseParams];
      return items
        .slice(0, MAX_INPUT_FANOUT)
        .map((item) => ({ ...baseParams, item }));
    }

    case "rotating": {
      const items = strategy.items ?? [];
      if (items.length === 0) return [baseParams];
      const cursor = typeof strategy.cursor === "number" ? strategy.cursor : 0;
      const idx = ((cursor % items.length) + items.length) % items.length;
      const item = items[idx];

      // Persist the advanced cursor back into the strategy (JSONB, no new column).
      const db = await getDb();
      const nextStrategy: InputStrategy = {
        ...strategy,
        cursor: (idx + 1) % items.length,
      };
      await db
        .update(playbooks)
        .set({ inputStrategy: nextStrategy, updatedAt: new Date() })
        .where(eq(playbooks.id, playbook.id));

      return [{ ...baseParams, item }];
    }

    case "query": {
      // TODO(P-query): resolve strategy.sourceSubscriptionId → a live item set
      // (via the source_subscription's query) and fan ONE run per item, bounded
      // by MAX_INPUT_FANOUT. Until then, run once with the caller's params —
      // never fabricate items.
      logger.warn(
        {
          playbookId: playbook.id,
          sourceSubscriptionId: strategy.sourceSubscriptionId,
        },
        "inputStrategy 'query' not yet implemented — running once with caller params"
      );
      return [baseParams];
    }

    default:
      return [baseParams];
  }
}

/**
 * Run a playbook end-to-end. Caller MUST gate (checkPermissionOrPropose) first.
 *
 * Honors the playbook's `inputStrategy` (S9): `none` runs once; `static`/`query`
 * may fan one run per item (bounded); `rotating` advances a cursor and runs the
 * current item. The PRIMARY (first) run + session is returned for the stable
 * single-result contract; any additional fan-out runs execute as side effects.
 */
export async function runPlaybook(
  input: RunPlaybookInput
): Promise<RunPlaybookResult> {
  const db = await getDb();

  // Resolve the playbook — by id, else by NAME within this workspace (then a
  // pod-wide NULL-workspace playbook). By-name is the template-friendly form: a
  // capability seeds a playbook + an automation together, and the automation
  // references the playbook by its stable name rather than a runtime id it can't
  // know at author time (mirrors entity resolution by profileSlug).
  let playbook = input.playbookId
    ? ((await db.query.playbooks.findFirst({
        where: eq(playbooks.id, input.playbookId),
      })) as Playbook | undefined)
    : undefined;
  if (!playbook && input.playbookName) {
    playbook = ((await db.query.playbooks.findFirst({
      where: and(
        eq(playbooks.name, input.playbookName),
        eq(playbooks.workspaceId, input.workspaceId)
      ),
    })) ??
      (await db.query.playbooks.findFirst({
        where: and(
          eq(playbooks.name, input.playbookName),
          isNull(playbooks.workspaceId)
        ),
      }))) as Playbook | undefined;
  }
  if (!playbook) {
    throw new Error(
      `Playbook not found (${
        input.playbookId ?? input.playbookName ?? "no id/name given"
      })`
    );
  }

  // Cross-workspace guard: a run may only target a playbook from its own
  // workspace or a pod-wide (NULL) one. The scheduled path's playbookId is
  // editor-authored config, so defend in depth (the column has no FK).
  if (playbook.workspaceId && playbook.workspaceId !== input.workspaceId) {
    throw new Error(
      `runPlaybook: playbook ${playbook.id} not visible in workspace ${input.workspaceId}`
    );
  }

  // S9: resolve the input strategy into per-run param payloads. The first item
  // is the primary (returned) run; the rest fan out as side effects.
  const runItems = await resolveInputItems(
    playbook,
    (input.params ?? {}) as Record<string, unknown>
  );

  const primary = await executeSingleRun(playbook, input, runItems[0]);

  // Fan-out: additional items each get their own session/channel/run. Failures
  // are logged but never abort the primary result.
  for (let i = 1; i < runItems.length; i++) {
    try {
      await executeSingleRun(playbook, input, runItems[i]);
    } catch (err) {
      logger.error(
        { err, playbookId: playbook.id, itemIndex: i },
        "Input-strategy fan-out run failed (non-fatal)"
      );
    }
  }

  return primary;
}

/**
 * Execute ONE playbook run for a single resolved param payload: instantiate a
 * session, create the run channel, record the run ledger row, and dispatch to
 * the executor. Extracted so the input-strategy fan-out reuses identical logic.
 */
async function executeSingleRun(
  playbook: Playbook,
  input: RunPlaybookInput,
  params: Record<string, unknown>
): Promise<RunPlaybookResult> {
  const db = await getDb();

  // The owning principal: agent-user when an AI runs it, else the human.
  const actorId = input.agentUserId ?? input.userId;

  // 0. Idempotency by subject — if a NON-TERMINAL session for this playbook +
  // subject already exists, REUSE it rather than starting a duplicate. This makes
  // a playbook_run safe on a schedule (e.g. a daily client-sync that ensures every
  // client has a session): start-if-missing, no-op-if-present. Reuse spans every
  // non-terminal state (see IDEMPOTENCY_TERMINAL_SESSION_STATUSES) so a stuck
  // subject the reaper aged active→'stale' is not re-dispatched daily. Opt-in;
  // manual runs leave `idempotentBySubject` false so each click starts fresh.
  if (input.idempotentBySubject && input.subjectId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.playbookId, playbook.id),
        eq(focusSessions.subjectEntityId, input.subjectId),
        // Reuse ANY non-terminal session (active/paused/stale/forming/scheduled),
        // not just 'active': a stuck subject whose session the focus-session
        // reaper aged active→'stale' must NOT re-spawn a fresh run on the next
        // daily cron. Once the playbook-run reaper force-fails the run and closes
        // the session (→ closed|failed|cancelled), a new run is allowed again.
        notInArray(focusSessions.status, [
          ...IDEMPOTENCY_TERMINAL_SESSION_STATUSES,
        ])
      ),
      orderBy: [desc(focusSessions.startedAt)],
    });
    if (existing) {
      return { run: null, session: existing as FocusSession, reused: true };
    }
  }

  // Propose-only governance (derived from the playbook) + the automation chain
  // context are stamped onto the session at creation. The write-side gate reads
  // governance.forceProposeWrites (→ every agent write becomes a proposal); the
  // trigger matcher reads automationChainContext (F2 depth floor).
  const forceProposeWrites = deriveForceProposeWrites(playbook.metadata);
  const sessionMetadata = buildRunSessionMetadata({
    chainContext: input.chainContext,
    forceProposeWrites,
  });

  // 1. Instantiate the runtime session (no channel yet — wired below). The goal
  // is resolved by the caller's resolver when provided (scheduled path resolves
  // against the automation StepContext), else substituted against `params`.
  const session = await instantiateSession({
    playbookId: playbook.id,
    workspaceId: input.workspaceId,
    userId: actorId,
    params,
    agentIds: input.agentIds,
    subjectId: input.subjectId ?? null,
    goalOverride: input.goalResolver
      ? input.goalResolver(playbook.goalTemplate)
      : undefined,
    metadata: sessionMetadata,
  });

  // 2. Create the run channel per channelSpec, OR reuse an existing channel when
  // the caller specifies targetChannelId (e.g. to route output to a client entity's
  // team channel instead of a throwaway playbook channel).
  // TODO(P3): full channelSpec member wiring (channel_members rows + per-member
  // caps from spec.members) — for now we create the channel and seed agentIds
  // onto the session; explicit member rows are a follow-up.
  let channel: typeof channels.$inferSelect;
  if (input.targetChannelId) {
    const existing = await db.query.channels.findFirst({
      where: eq(channels.id, input.targetChannelId),
    });
    if (!existing) {
      throw new Error(
        `targetChannelId ${input.targetChannelId} not found — cannot run playbook against a non-existent channel`
      );
    }
    channel = existing;
  } else {
    const spec = (playbook.channelSpec ?? {}) as ChannelSpec;
    const channelType = channelTypeFromSpec(spec);
    const [created] = await db
      .insert(channels)
      .values({
        userId: actorId,
        workspaceId: input.workspaceId,
        channelType,
        scope: ChannelScope.WORKSPACE,
        status: ChannelStatus.ACTIVE,
        title: playbook.name,
        contextObjectType: "playbook",
        contextObjectId: playbook.id,
        metadata: { origin: "playbook-run", playbookId: playbook.id },
      })
      .returning();
    channel = created;
  }

  // 3. Wire focus_sessions.channelId = the new channel.
  await db
    .update(focusSessions)
    .set({ channelId: channel.id })
    .where(eq(focusSessions.id, session.id));

  // 4. Insert the run ledger row (status "running"). Snapshot the resolved
  // definition (D3c) so "what ran" survives later edits to the playbook config.
  const [run] = await db
    .insert(playbookRuns)
    .values({
      workspaceId: input.workspaceId,
      playbookId: playbook.id,
      sessionId: session.id,
      executor: playbook.executor,
      status: "running",
      input: params,
      createdBy: actorId,
      definitionSnapshot: buildDefinitionSnapshot(playbook),
    })
    .returning();

  // 4b. Enroll the subject entity in the playbook so running a playbook FOR an
  // entity also populates its funnel/cohort. Only when the playbook actually has
  // a funnel (stages) — an operational playbook (scheduled sync, etc.) with no
  // stages must not create enrollment rows. Idempotent by unique(playbookId,
  // entityId); re-enroll after unenroll reactivates. Best-effort side-write — an
  // enrollment failure must never fail the run.
  const stages = (playbook.stages as PlaybookStage[]) ?? [];
  const firstStageKey = stages[0]?.key ?? null;
  if (input.subjectId && stages.length > 0) {
    try {
      await db
        .insert(playbookEnrollments)
        .values({
          playbookId: playbook.id,
          entityId: input.subjectId,
          status: "active",
          stepState: firstStageKey ? { currentStep: firstStageKey } : {},
        })
        .onConflictDoUpdate({
          target: [
            playbookEnrollments.playbookId,
            playbookEnrollments.entityId,
          ],
          set: { status: "active", updatedAt: new Date() },
        });
    } catch (err) {
      logger.warn(
        { err, playbookId: playbook.id, entityId: input.subjectId },
        "playbook run: enrollment upsert failed (non-fatal)"
      );
    }
  }

  // 5. Resolve the playbook's granted capabilities (its `grants` links) into
  //    CapabilityRef[] and dispatch to the executor.
  const playbookLinks = await getLinksFor(actorId, "playbook", playbook.id);
  const capabilities = await resolveGrantedCapabilities(playbookLinks, {
    linkType: "grants",
    fromType: "playbook",
  });

  // Resolve the subject's name + profile so the executor can tell the agent WHAT
  // it is working on (subjectId alone is opaque). Visibility was already enforced
  // by the caller (resolveVisibleSubjectId) before this runs.
  let subjectName: string | undefined;
  let subjectProfile: string | undefined;
  if (input.subjectId) {
    const subj = await db.query.entities.findFirst({
      columns: { title: true, type: true },
      where: eq(entities.id, input.subjectId),
    });
    subjectName = subj?.title ?? undefined;
    subjectProfile = subj?.type ?? undefined;
  }

  let result: RunResult;
  try {
    result = await resolveExecutor(playbook.executor).run({
      workspaceId: input.workspaceId,
      userId: actorId,
      playbookId: playbook.id,
      sessionId: session.id,
      channelId: channel.id,
      goal: session.goal,
      subjectId: input.subjectId,
      subjectName,
      subjectProfile,
      // First-class stages: the playbook's declared stages + the session's active
      // stage key (both empty/null for a stageless, progress-only playbook).
      stages: (playbook.stages as PlaybookStage[]) ?? [],
      currentStage: session.currentStage,
      // Thread the run id so an external agent knows which run to capture back
      // against (POST /api/hub/runs/{runId}/capture); webhookUrl rides params.
      input: { ...params, runId: run.id },
      capabilities,
    });
  } catch (err) {
    logger.error(
      { err, sessionId: session.id, channelId: channel.id },
      "Executor run failed"
    );

    result = {
      status: "failed",
      error: err instanceof Error ? err.message : "Executor threw",
    };
  }

  // 6. Record the result on the run row. Terminal statuses stamp completed_at.
  const terminal =
    result.status === "completed" ||
    result.status === "failed" ||
    result.status === "proposed";
  const [updated] = await db
    .update(playbookRuns)
    .set({
      status: result.status,
      summary: result.summary ?? null,
      error: result.error ?? null,
      completedAt: terminal ? new Date() : null,
    })
    .where(eq(playbookRuns.id, run.id))
    .returning();

  // Re-load the session so the returned row reflects the wired channelId.
  const refreshed = (await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, session.id),
  })) as FocusSession;

  return { run: updated as PlaybookRun, session: refreshed };
}
