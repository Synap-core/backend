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
  FocusSessionStatus,
} from "@synap/database/schema";
import type {
  ChannelSpec,
  RunResult,
  InputStrategy,
  PlaybookStage,
} from "@synap/playbooks";
import {
  instantiateSession,
  runPromptFor,
  resolveRunnablePlaybook,
  resolveGoal,
} from "./playbook-lifecycle.js";
import {
  resolveGrantedCapabilities,
  getLinksFor,
} from "../links/links-service.js";
import { resolveExecutor } from "./executors/registry.js";
import { findUnenabledPlaybookSkills } from "./playbook-skill-preflight.js";
import { proposeCapabilityEnable } from "../capabilities/propose-capability-enable.js";
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
  /**
   * The `events` row that fired the automation whose run spawned this session
   * (`automation_runs.trigger_event_id`, 0256). Absent for a cron, manual or
   * webhook run — those have no triggering event.
   *
   * Carried through so the SESSION can answer "which fact am I here because
   * of", which `automationRunId` alone cannot: the run knows its trigger, the
   * session only knew its run. Stamped nested under `automationChainContext`
   * (never as a top-level metadata key — `session-kind.ts` reads the top-level
   * automation keys to classify a row as `kind:'run'`, and a new sibling there
   * is a classification hazard for no gain).
   */
  triggerEventId?: string;
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
  /**
   * Resolves the playbook's goalTemplate against the caller's own context.
   * Returning `undefined` means "I am not the right resolver for this grammar"
   * — the spine then falls back to resolveGoal(), which substitutes
   * `@{arg:name:type}` references against `params`.
   */
  goalResolver?: (goalTemplate: string) => string | undefined;
  /**
   * A goal template supplied by the CALLER that replaces the playbook's own
   * `goalTemplate` for this run (an automation `playbook_run` node's
   * `data.goalOverride`). Used ONLY when `goalResolver` declines the template
   * (returns undefined — "wrong resolver for this grammar"), so the
   * `@{arg:name:type}` fallback substitutes the caller's template against
   * `params` instead of the playbook's. Resolved with `resolveGoal`, the SAME
   * function `instantiateSession` uses — never a second interpolator.
   */
  goalTemplateOverride?: string;
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
  /**
   * AGENT SELECTOR — which agent should answer this run, as the `agents.slug`
   * (the string the IS calls `agentType`). Threaded straight through to the
   * executor's RunContext; the `is-agent` executor resolves it against the
   * `agents` catalog and FAILS the run on an unknown slug. Absent ⇒ the
   * dispatcher's default orchestrator ("meta"), i.e. today's behaviour.
   *
   * Deliberately a RUN PARAMETER, not a `playbooks` column: the selector is a
   * property of the CALL ("ask <agent> to do this"), the same playbook can be
   * run by different agents, and a column would cost a hand-written migration
   * plus a baseline + schema-coherence edit for no expressive gain.
   */
  agentType?: string | null;
  /**
   * UNATTENDED run (the scheduled path): when the playbook depends on skills
   * that are installed but not enabled, file the enable request on behalf of
   * the owner and THROW — the automation step then records the reason. Absent
   * for attended doors, which refuse up front (`playbooks.run` preflight).
   */
  unenabledSkillPreflight?: boolean;
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
 * (F2 depth floor, keyed by the agent's X-Session-Id in the trigger matcher),
 * the TOP-LEVEL `automationId`/`automationRunId` pair, and the propose-only
 * governance flag. Empty object when neither applies (session metadata column
 * default). Pure so it is unit-testable.
 *
 * The top-level pair duplicates `chainContext.automationId`/`automationRunId`
 * deliberately: `session-kind.ts` (`sessionAutomationWhere`,
 * `AUTOMATION_KEYS`/`projectSessionKind`) reads ONLY the top-level keys — it
 * has no reason to know about `automationChainContext`, which exists for the
 * trigger matcher's depth floor, a different consumer. Before this, a
 * playbook_run session opened from a scheduled automation carried the
 * automation ONLY nested under `automationChainContext`, so
 * `sessionAutomationWhere(automationId)` — the automation detail page's
 * "this automation's run sessions" filter — silently returned nothing for
 * every such run. `projectSessionKind`/`runSignalWhere` still classified the
 * row as `kind: "run"` correctly regardless (via `origin`/`playbookId`), so
 * the row never disappeared from the run POPULATION — only from the
 * automation-scoped FILTER.
 */
export function buildRunSessionMetadata(opts: {
  chainContext?: RunChainContext;
  forceProposeWrites: boolean;
}): Record<string, unknown> {
  return {
    ...(opts.chainContext
      ? {
          automationId: opts.chainContext.automationId,
          automationRunId: opts.chainContext.automationRunId,
          automationChainContext: {
            automationRunId: opts.chainContext.automationRunId,
            automationId: opts.chainContext.automationId,
            chainDepth: opts.chainContext.chainDepth ?? 0,
            rootRunId:
              opts.chainContext.rootRunId ?? opts.chainContext.automationRunId,
            chainAutomationIds: opts.chainContext.chainAutomationIds ?? [],
            // Provenance, not control flow: the matcher's depth floor
            // (`deriveSessionChainContext`) ignores it, so a chained run's
            // guard behaviour is unchanged. OMITTED when absent so a session
            // spawned by a cron/manual run does not carry a null claim.
            ...(opts.chainContext.triggerEventId
              ? { triggerEventId: opts.chainContext.triggerEventId }
              : {}),
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
  criteria: unknown;
} {
  return {
    version: playbook.version,
    goalTemplate: playbook.goalTemplate,
    stages: playbook.stages,
    params: playbook.params,
    expectedOutputs: playbook.expectedOutputs,
    criteria: playbook.criteria,
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
 * (playbook-run-reaper.ts). Reusing across every IN-FLIGHT state (active,
 * paused, stale, forming) means a stuck/in-flight subject is not re-dispatched
 * daily; only once the run is terminally failed/closed — session in ('closed' |
 * 'failed' | 'cancelled') — is a new run allowed, so a subject always has a
 * legitimate path back to eligibility and is never permanently locked out.
 * Exported so a test can lock the SHAPE of this decision.
 */
export const IDEMPOTENCY_TERMINAL_SESSION_STATUSES = [
  "closed",
  "failed",
  "cancelled",
] as const;

/**
 * The statuses subject-idempotency must NOT reuse: the terminal set above, plus
 * `scheduled`.
 *
 * `scheduled` is not terminal, but it is not in flight either — it is an
 * APPOINTMENT (`materializeScheduledSession`): a person's future slot that has
 * executed nothing. Reusing it returned `{ run: null, reused: true }` — a run
 * that reads as handled and never ran — and because an unopened appointment
 * rolls forward and stays `scheduled`, it could suppress that subject's run for
 * weeks. Appointments do not need this reuse to avoid duplicates: the
 * scheduler enforces one open appointment per calendar with its own lookup.
 */
export const IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES = [
  ...IDEMPOTENCY_TERMINAL_SESSION_STATUSES,
  FocusSessionStatus.SCHEDULED,
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
  // Resolve the playbook — by id, else by NAME within this workspace (then a
  // pod-wide NULL-workspace playbook), with the cross-workspace visibility guard.
  // The ONE door (playbook-lifecycle.ts): the appointment materializer resolves
  // through the same function, so the by-name fallback and the write-side IDOR
  // floor exist once, not once per scheduled door.
  const playbook = await resolveRunnablePlaybook({
    playbookId: input.playbookId,
    playbookName: input.playbookName,
    workspaceId: input.workspaceId,
  });

  // D3 — an UNATTENDED run (the scheduled path) has no caller to answer, so a
  // playbook depending on not-enabled skills files ONE enable request per pack
  // on behalf of the owner and FAILS the step with that reason, before any
  // session, channel, run row or input-cursor advance exists.
  if (input.unenabledSkillPreflight) {
    const unenabled = await findUnenabledPlaybookSkills({
      playbook,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    if (unenabled.length > 0) {
      const offers = await proposeCapabilityEnable({
        refused: unenabled,
        userId: input.userId,
        workspaceId: input.workspaceId,
        agentUserId: input.agentUserId ?? null,
      });
      const review = offers
        .filter((o) => o.status === "proposed")
        .map((o) => o.reviewUrl);
      const names = unenabled.map((s) => s.name).join(", ");
      throw new Error(
        review.length > 0
          ? `Nothing ran: "${playbook.name}" uses skills that are not enabled yet (${names}). A request to enable them is waiting for the owner's review: ${review.join(" ")}`
          : `Nothing ran: "${playbook.name}" uses skills that are not enabled yet (${names}), and the request to enable them could not be filed. Enable them in Settings → Capabilities.`
      );
    }
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
  // in-flight state (see IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES) so a stuck
  // subject the reaper aged active→'stale' is not re-dispatched daily. Opt-in;
  // manual runs leave `idempotentBySubject` false so each click starts fresh.
  if (input.idempotentBySubject && input.subjectId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.playbookId, playbook.id),
        eq(focusSessions.subjectEntityId, input.subjectId),
        // Reuse any IN-FLIGHT session (active/paused/stale/forming), not just
        // 'active': a stuck subject whose session the focus-session reaper aged
        // active→'stale' must NOT re-spawn a fresh run on the next daily cron.
        // Once the playbook-run reaper force-fails the run and closes the
        // session (→ closed|failed|cancelled), a new run is allowed again. A
        // `scheduled` appointment is never reused: it has executed nothing, so
        // it must not stand in for a run.
        notInArray(focusSessions.status, [
          ...IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES,
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
    // Two grammars, one resolution. `goalResolver` handles {{mustache}} against
    // the caller's own context; when it declines (a pure `@{arg:}` template) the
    // caller's override template is substituted here with `resolveGoal` — the
    // same function `instantiateSession` would otherwise apply to the
    // PLAYBOOK's template, which is what would have dropped the override.
    // No override + no resolver ⇒ undefined, i.e. every pre-existing caller is
    // byte-identical.
    goalOverride:
      (input.goalResolver
        ? input.goalResolver(
            input.goalTemplateOverride ?? playbook.goalTemplate
          )
        : undefined) ??
      (input.goalTemplateOverride
        ? resolveGoal(input.goalTemplateOverride, params, playbook.id)
        : undefined),
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
      // The agent's INSTRUCTION, not the row's title. `session.goal` is now
      // "<playbook> for <subject>" (a label every list renders); the rendered
      // goalTemplate lives on `metadata.prompt`. `runPromptFor` falls back to
      // `goal` so a session created before that split still dispatches its
      // paragraph unchanged.
      goal: runPromptFor(session),
      subjectId: input.subjectId,
      subjectName,
      subjectProfile,
      // First-class stages: the playbook's declared stages + the session's active
      // stage key (both empty/null for a stageless, progress-only playbook).
      stages: (playbook.stages as PlaybookStage[]) ?? [],
      currentStage: session.currentStage,
      // Agent selector — forwarded verbatim; the executor validates it.
      agentType: input.agentType ?? null,
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
