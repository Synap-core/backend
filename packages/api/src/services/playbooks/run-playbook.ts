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
  inArray,
  notInArray,
  channels,
  entities,
  focusSessions,
  playbooks,
  playbookRuns,
  playbookEnrollments,
  recordSessionSpawn,
  drizzleSql,
  countWorkerIrreversibleSendsToday,
  countWorkerPendingApprovals,
  listWorkerTargetsInFlight,
  type PlaybookRunWorkerSpec,
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
  ChannelMemberKind,
  ChannelMemberRole,
  FocusSessionStatus,
} from "@synap/database/schema";
import { enrollRoomMember } from "../messaging/enroll-room-member.js";
import { notifySessionNeedsYou } from "../focus-sessions/notify-needs-you.js";
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
  createLinks,
} from "../links/links-service.js";
import { workerIrreversibleSendCeiling } from "./worker-send-ceiling.js";
import {
  WORKER_BATCH_LIMIT,
  WORKER_SKIP_REASONS,
  WORKER_TARGET_ROLE,
  type WorkerSkipReason,
} from "@synap-core/types/workers";
import { resolveExecutor } from "./executors/registry.js";
import { assertRunSubjectMatchesPlaybook } from "./assert-subject-kind.js";
import { findUnenabledPlaybookSkills } from "./playbook-skill-preflight.js";
import { readPlaybookProcess } from "../../schemas/playbook-process.js";
import { proposeCapabilityEnable } from "../capabilities/propose-capability-enable.js";
import { createLogger } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import {
  AI_DISPATCH_GUARDRAILS,
  AUTOMATION_SKIP_REASONS,
} from "@synap-core/types/automations";
import {
  resolveWorkerMaxPending,
  settleParentAutomationRunFromChild,
} from "@synap/jobs";
import {
  decidePinnedSubject,
  fillSoleRequiredEntityParam,
  pickFirstEligible,
  readPinnedIds,
  readPinnedStrategy,
  subjectProfileSlug,
  type PinnedStrategy,
} from "./pinned-subject.js";
import {
  findFallbackSubject,
  loadVisibleEntityIds,
} from "./pinned-subject-query.js";

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
  /**
   * The `automation_step_runs` row that dispatched this run. Stamped nested
   * under `automationChainContext` so a child failure flips THAT step
   * (`settleParentAutomationRunFromChild`, @synap/jobs).
   */
  stepRunId?: string;
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
  /**
   * What to do when the playbook declares a `required` param this call did not
   * answer. Forwarded verbatim to the ONE funnel (`instantiateSession`), whose
   * `InstantiateInput.onMissingRequired` docblock owns the contract.
   *
   * ABSENT ⇒ `"refuse"` (the funnel's fail-closed default), which is right for
   * `playbooks.run` driven by a person with a form. Every HEADLESS caller —
   * the MCP/Hub run door, the automation `playbook_run` step — passes `"owe"`
   * explicitly, because there is nobody to show a form to.
   */
  onMissingRequired?: "refuse" | "owe";
  /** Extra agent members to add to the run channel. */
  agentIds?: string[];
  /**
   * The agent that STARTED this run directly (no proposal). The run is still
   * the PERSON's (`userId`): the agent rides first on the roster and the
   * session waits as a triage DRAFT (`origin: "agent"`) for the person to
   * accept, like every agent-started session (`draft-asks.ts`, B6 2026-10-21).
   * An APPROVED run passes no `agentUserId` — the approval was the acceptance
   * — and carries the asker in `agentIds` instead (`executors/playbook.ts`).
   */
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
  /**
   * The session this run was started FROM — an agent working in session A that
   * runs a playbook. Recorded as `run session --spawned_from--> A` through the
   * one producer (`recordSessionSpawn`), so the work map and the resume packet
   * can say what the run was spawned to do. Absent ⇒ no edge (every
   * pre-existing caller is unchanged).
   */
  parentSessionId?: string;
  /**
   * The PROJECT this run is filed into (`focus_sessions.project_id`). Must be
   * visible to `userId`; refused otherwise.
   */
  projectId?: string | null;
  /**
   * The TRACK (`project_tracks`, 0272) this run is born inside — work that
   * advances one method of a project. Validated here, on every door, by
   * `resolveTrackFiling`: the track must be visible and not archived, and
   * `projectId` (when given) must be the track's project. Absent `projectId`
   * is DERIVED from the track, never guessed.
   */
  trackId?: string | null;
  /**
   * The stage of that track the run is filed at (0274). Absent ⇒ the track's
   * current stage; an explicit one must be pinned by the track (refused).
   */
  trackStage?: string | null;
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
  /**
   * STAGE WORKER (work model L4): this run was fired by an enabled worker —
   * the node's `worker` spec plus the enablement's automation. Decides
   * whether to start at all (backlog, ceiling, stale transition, threshold)
   * and how big the run is (`per_moment` = ONE session over the things in
   * the status, each a `session --targets--> entity` edge). Absent ⇒ an
   * ordinary run, unchanged. See {@link gateWorkerRun}.
   */
  worker?: RunWorker;
}

/** A worker run's input: the node spec + the enablement's automation. */
export interface RunWorker extends PlaybookRunWorkerSpec {
  /** The enablement's automation (null = fired outside one: nothing to count). */
  automationId: string | null;
}

type PlaybookRunStarted = {
  /** The ledger row for this run — NULL when an existing session was reused
   *  (idempotency-by-subject): a reuse starts no new run. */
  run: PlaybookRun | null;
  session: FocusSession;
  /** True when idempotency-by-subject reused an existing active session. */
  reused?: boolean;
  /**
   * Whether the `spawned_from` edge to `parentSessionId` landed. Present only
   * when a parent was asked for. Best-effort by contract (the run already
   * exists), but never silent — the same shape `createFocusSession` reports.
   */
  parentLink?:
    | { status: "linked"; parentSessionId: string }
    | { status: "failed"; parentSessionId: string; reason: string };
  /** Present only on the no-subject branch, so both union members share the key. */
  skipped?: undefined;
};

export type RunPlaybookResult =
  | PlaybookRunStarted
  | {
      /** A pinned playbook had nobody eligible and the fallback matched nothing.
       *  No session, no run, no event stamp. */
      run: null;
      session: null;
      /**
       * `no-subject` — a pinned playbook had nobody eligible.
       * `cooling_down` — the subject-idempotent path found this subject's
       * latest run of the playbook FAILED within the cooldown window
       * (`AI_DISPATCH_GUARDRAILS.failedSubjectCooldownHours`).
       */
      skipped:
        | "no-subject"
        | typeof AUTOMATION_SKIP_REASONS.coolingDown
        | WorkerSkipReason;
      reused?: undefined;
      parentLink?: undefined;
    };

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
            ...(opts.chainContext.stepRunId
              ? { stepRunId: opts.chainContext.stepRunId }
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
  requiredIntents: unknown;
  subjectProfile: unknown;
} {
  return {
    version: playbook.version,
    goalTemplate: playbook.goalTemplate,
    stages: playbook.stages,
    params: playbook.params,
    expectedOutputs: playbook.expectedOutputs,
    criteria: playbook.criteria,
    // WHAT THIS RUN ASKED THE POD TO BE ABLE TO DO. Snapshotted with the rest
    // so "what ran" includes the requirements the run was launched under, not
    // only the template it was launched from — a run whose playbook has since
    // been re-declared must still read as what it actually needed.
    requiredIntents: playbook.requiredIntents,
    // The kind the run's subject must be (the subject-kind floor).
    subjectProfile: playbook.subjectProfile,
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

/**
 * Max runs a single `static`/`query` fan-out may spawn. Each run is an agent
 * kickoff, so this IS the per-trigger AI dispatch cap — read from the ONE
 * guardrails config, never restated here.
 */
const MAX_INPUT_FANOUT = AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerRun;

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
  const pinned = readPinnedStrategy(value);
  if (pinned) return pinned;
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
 *   - pinned  → exactly ONE run. The subject is chosen before this function
 *     (caller, else the pin list, else one fallback row). No fan-out.
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

    case "pinned":
      return [baseParams];

    default:
      return [baseParams];
  }
}

/**
 * Ids on the pin list that can run now: visible, of the playbook's kind when
 * it names one, and not already in flight for this playbook. An in-flight
 * first pin is skipped so the next pin can start — two sessions of the same
 * playbook may be open on two subjects.
 */
async function eligiblePinIds(
  playbook: Playbook,
  ids: readonly string[],
  workspaceId: string,
  ownerId: string
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const visible = await loadVisibleEntityIds({
    ids,
    workspaceId,
    ownerId,
    profileSlug: subjectProfileSlug(playbook.subjectProfile),
  });
  if (visible.length === 0) return new Set();
  const db = await getDb();
  const busy = await db
    .select({ subjectEntityId: focusSessions.subjectEntityId })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.playbookId, playbook.id),
        inArray(focusSessions.subjectEntityId, [...ids]),
        notInArray(focusSessions.status, [
          ...IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES,
        ])
      )
    );
  const busyIds = new Set(
    busy
      .map((row) => row.subjectEntityId)
      .filter((id): id is string => typeof id === "string")
  );
  return new Set(visible.filter((id) => !busyIds.has(id)));
}

/**
 * Choose the subject for a pinned playbook. Caller subject wins and does not
 * read the list. Otherwise the first eligible pin, otherwise one fallback
 * row (not written onto the list). `skip` means nothing was eligible.
 */
async function choosePinnedSubject(
  playbook: Playbook,
  input: RunPlaybookInput,
  strategy: PinnedStrategy
): Promise<ReturnType<typeof decidePinnedSubject>> {
  const caller =
    typeof input.subjectId === "string" ? input.subjectId.trim() : "";
  if (caller) {
    return decidePinnedSubject({
      callerSubjectId: caller,
      pinnedIds: [],
      eligibleIds: new Set(),
      fallbackId: null,
    });
  }
  const pinnedIds = readPinnedIds(playbook.metadata);
  const eligibleIds = await eligiblePinIds(
    playbook,
    pinnedIds,
    input.workspaceId,
    input.userId
  );
  const pin = pickFirstEligible(pinnedIds, (id) => eligibleIds.has(id));
  let fallbackId: string | null = null;
  const slug = subjectProfileSlug(playbook.subjectProfile);
  if (!pin && slug && strategy.fallback) {
    fallbackId = await findFallbackSubject({
      profileSlug: slug,
      workspaceId: input.workspaceId,
      ownerId: input.userId,
      fallback: strategy.fallback,
    });
  }
  return decidePinnedSubject({
    callerSubjectId: null,
    pinnedIds,
    eligibleIds,
    fallbackId,
  });
}

interface RunFiling {
  projectId: string | null;
  trackId: string | null;
  trackStage: string | null;
}

/**
 * Where a run is FILED. A track wins and names its own project (a mismatching
 * `projectId` is refused by `resolveTrackFiling`); a bare project must be one
 * the principal can see. Floored on the HUMAN (`input.userId`) — an agent's
 * run is filed on the person's behalf.
 */
async function resolveRunFiling(input: RunPlaybookInput): Promise<RunFiling> {
  if (input.trackId) {
    const { resolveTrackFiling } = await import("../tracks/tracks-service.js");
    const filed = await resolveTrackFiling({
      trackId: input.trackId,
      projectId: input.projectId ?? null,
      trackStage: input.trackStage ?? null,
      actor: { userId: input.userId },
    });
    return {
      projectId: filed.projectId,
      trackId: filed.trackId,
      trackStage: filed.trackStage,
    };
  }
  if (input.projectId) {
    const { loadVisibleProject } =
      await import("../projects/load-visible-project.js");
    const project = await loadVisibleProject(
      await getDb(),
      input.projectId,
      input.userId
    );
    if (!project) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Project ${input.projectId} not found`,
      });
    }
    return { projectId: project.id, trackId: null, trackStage: null };
  }
  return { projectId: null, trackId: null, trackStage: null };
}

/**
 * D3 — the ONE unattended readiness rule. An unattended door (a scheduled run,
 * a propose-mode rule) has no caller to answer, so a playbook depending on
 * not-enabled skills files ONE enable request per pack on behalf of the owner
 * and returns the refusal sentence; `null` = ready. Both unattended doors call
 * this: `runPlaybook` (run mode) and {@link checkUnattendedPlaybookReadiness}
 * (propose mode, before a run proposal is filed that could only fail on
 * approval). Attended doors refuse up front instead (`playbooks.run`).
 */
export async function refuseUnattendedRunIfSkillsOff(input: {
  playbook: Pick<Playbook, "id" | "name" | "goalTemplate">;
  userId: string;
  workspaceId: string;
  agentUserId: string | null;
}): Promise<string | null> {
  const unenabled = await findUnenabledPlaybookSkills({
    playbook: input.playbook,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  if (unenabled.length === 0) return null;
  const offers = await proposeCapabilityEnable({
    refused: unenabled,
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentUserId: input.agentUserId,
  });
  const review = offers
    .filter((o) => o.status === "proposed")
    .map((o) => o.reviewUrl);
  const names = unenabled.map((s) => s.name).join(", ");
  return review.length > 0
    ? `Nothing ran: "${input.playbook.name}" uses skills that are not enabled yet (${names}). A request to enable them is waiting for the owner's review: ${review.join(" ")}`
    : `Nothing ran: "${input.playbook.name}" uses skills that are not enabled yet (${names}), and the request to enable them could not be filed. Enable them in Settings → Capabilities.`;
}

/**
 * The propose-mode rule's readiness gate (the `registerPlaybookReadinessGate`
 * slot, @synap/jobs): the same playbook resolution as {@link runPlaybook}, then
 * the same unattended rule. Without it an automation filed run proposals that
 * could only fail on approval while the owner's manual run was blocked.
 */
export async function checkUnattendedPlaybookReadiness(input: {
  playbookId?: string;
  playbookName?: string;
  workspaceId: string;
  userId: string;
}): Promise<{ ready: true } | { ready: false; message: string }> {
  const playbook = await resolveRunnablePlaybook({
    playbookId: input.playbookId,
    playbookName: input.playbookName,
    workspaceId: input.workspaceId,
  });
  const message = await refuseUnattendedRunIfSkillsOff({
    playbook,
    userId: input.userId,
    workspaceId: input.workspaceId,
    agentUserId: null,
  });
  return message ? { ready: false, message } : { ready: true };
}

/**
 * Run a playbook end-to-end. Caller MUST gate (checkPermissionOrPropose) first.
 *
 * Honors the playbook's `inputStrategy` (S9): `none` runs once; `static`/`query`
 * may fan one run per item (bounded); `rotating` advances a cursor and runs the
 * current item; `pinned` runs once for the caller subject, else the first
 * eligible pin, else one fallback row. A pinned playbook with nobody eligible
 * returns `skipped: "no-subject"` before any session exists. The PRIMARY
 * (first) run + session is returned for the stable single-result contract;
 * any additional fan-out runs execute as side effects.
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

  // FILING — the project/track this run lands in, resolved ONCE for every
  // fan-out item. Before any session, channel or run row exists, so a bad
  // handle refuses cleanly instead of leaving a half-filed run.
  const filing = await resolveRunFiling(input);

  // D3 — an UNATTENDED run (the scheduled path) has no caller to answer, so a
  // playbook depending on not-enabled skills files ONE enable request per pack
  // on behalf of the owner and FAILS the step with that reason, before any
  // session, channel, run row or input-cursor advance exists.
  if (input.unenabledSkillPreflight) {
    const refusal = await refuseUnattendedRunIfSkillsOff({
      playbook,
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentUserId: input.agentUserId ?? null,
    });
    if (refusal) throw new Error(refusal);
  }

  // STAGE WORKER: decide whether this fire starts anything, before any
  // session exists. A per_moment worker runs ONE session over its set and
  // returns here — it never fans out, pins, or binds a subject.
  if (input.worker) {
    const skipped = await gateWorkerRun(input, input.worker, {
      statusProperty: readPlaybookProcess(playbook.subjectProfile)
        .statusProperty,
    });
    if (skipped) return { run: null, session: null, skipped };
    if (input.worker.size === "per_moment") {
      return runWorkerBatch(playbook, input, input.worker, filing);
    }
  }

  // Pinned subject, BEFORE any session and before a rotating cursor could
  // advance (a pinned playbook has no cursor). Caller subject wins. The
  // resolved id is written onto the run input so idempotentBySubject can
  // see it — the automation path always sets that flag.
  let runInput: RunPlaybookInput = input;
  const strategy = readInputStrategy(playbook.inputStrategy);
  if (strategy.kind === "pinned") {
    const chosen = await choosePinnedSubject(playbook, input, strategy);
    if (chosen.outcome === "skip") {
      return { run: null, session: null, skipped: "no-subject" };
    }
    runInput = {
      ...input,
      subjectId: chosen.subjectId,
      params: fillSoleRequiredEntityParam(
        (input.params ?? {}) as Record<string, unknown>,
        playbook.params,
        chosen.subjectId
      ),
    };
  }

  // The subject must be the kind the playbook runs on: checked after the
  // subject is resolved, before any session is minted.
  await assertRunSubjectMatchesPlaybook({
    subjectId: runInput.subjectId,
    subjectProfile: playbook.subjectProfile,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });

  // S9: resolve the input strategy into per-run param payloads. The first item
  // is the primary (returned) run; the rest fan out as side effects.
  const runItems = await resolveInputItems(
    playbook,
    (runInput.params ?? {}) as Record<string, unknown>
  );

  const primary = await executeSingleRun(
    playbook,
    runInput,
    runItems[0] ?? {},
    filing
  );

  // Fan-out: additional items each get their own session/channel/run. Failures
  // are logged but never abort the primary result.
  for (let i = 1; i < runItems.length; i++) {
    try {
      await executeSingleRun(playbook, runInput, runItems[i], filing);
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
  params: Record<string, unknown>,
  filing: RunFiling,
  batch?: WorkerBatch
): Promise<RunPlaybookResult> {
  const db = await getDb();

  // The owning principal is ALWAYS the person. An agent-started run used to be
  // owned by the agent user, and session reads are owner-only, so the person
  // could not see it at all and the agent key (which reads as its person)
  // could not read it either (live 2026-10-20: `sessionPrivate: true`). The
  // agent that started it is the first on the roster — the starter every
  // surface names (`attachSessionParticipants`) — and the run waits as a draft.
  const actorId = input.userId;
  const startedByAgent = !!input.agentUserId;
  const rosterAgentIds = input.agentUserId
    ? [
        input.agentUserId,
        ...(input.agentIds ?? []).filter((id) => id !== input.agentUserId),
      ]
    : input.agentIds;

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

    // COOLDOWN — nothing in flight, but the subject's LATEST run of this
    // playbook failed recently: do not start another one yet. Without this a
    // subject whose run the reaper failed at 24h was re-dispatched on the very
    // next cron, every day, failing the same way each time.
    const cooling = await latestRunFailedWithinCooldown(
      playbook.id,
      input.subjectId
    );
    if (cooling) {
      logger.info(
        {
          playbookId: playbook.id,
          subjectId: input.subjectId,
          failedRunId: cooling.runId,
          cooldownHours: AI_DISPATCH_GUARDRAILS.failedSubjectCooldownHours,
        },
        "Subject is cooling down after a failed run — not starting another"
      );
      return {
        run: null,
        session: null,
        skipped: AUTOMATION_SKIP_REASONS.coolingDown,
      };
    }
  }

  // Propose-only governance (derived from the playbook) + the automation chain
  // context are stamped onto the session at creation. The write-side gate reads
  // governance.forceProposeWrites (→ every agent write becomes a proposal); the
  // trigger matcher reads automationChainContext (F2 depth floor).
  // A per_moment batch whose worker proposes makes EVERY agent write in it a
  // proposal: the batch card is the session's pending proposals.
  const forceProposeWrites =
    deriveForceProposeWrites(playbook.metadata) ||
    batch?.proposeWrites === true;
  const sessionMetadata = {
    ...buildRunSessionMetadata({
      chainContext: input.chainContext,
      forceProposeWrites,
    }),
    // `profileSlug` = the lifecycle the worker follows: process-sync settles
    // a target only on a move of THAT lifecycle (`listOpenWorkerTargetSessions`).
    ...(input.worker
      ? {
          worker: {
            key: input.worker.key,
            size: input.worker.size,
            profileSlug: input.worker.profileSlug,
          },
        }
      : {}),
  };

  // 1. Instantiate the runtime session (no channel yet — wired below). The goal
  // is resolved by the caller's resolver when provided (scheduled path resolves
  // against the automation StepContext), else substituted against `params`.
  const session = await instantiateSession({
    playbookId: playbook.id,
    workspaceId: input.workspaceId,
    userId: actorId,
    params,
    ...(input.onMissingRequired
      ? { onMissingRequired: input.onMissingRequired }
      : {}),
    agentIds: rosterAgentIds,
    // A run an agent started on its own is a DRAFT until the person accepts it
    // (`triage.ts`: origin agent, no acceptance receipt). Still a `run` by kind
    // (`playbookId` is set); accepted, it joins the person's work.
    ...(startedByAgent ? { origin: "agent" as const } : {}),
    subjectId: input.subjectId ?? null,
    projectId: filing.projectId,
    trackId: filing.trackId,
    trackStage: filing.trackStage,
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

  // The batch's TARGETS, born with the session (before any agent can act on
  // them): one `session --targets--> entity` edge per thing, no result yet.
  if (session && batch && batch.targetIds.length > 0) {
    await createLinks(
      batch.targetIds.map((entityId) => ({
        workspaceId: input.workspaceId,
        fromType: "session" as const,
        fromId: session.id,
        toType: "entity" as const,
        toId: entityId,
        linkType: "targets" as const,
        metadata: { role: WORKER_TARGET_ROLE },
      }))
    );
  }

  // A run born owing the person something (a playbook step declared
  // `owner: "human"`, an unanswered required param on the `owe` path) tells
  // them — once per session window — when nobody is in front of it: an agent
  // started it, or a HEADLESS door did (`owe` is declared exactly for those,
  // see `RunPlaybookInput.onMissingRequired`). The PERSON owns the run and is
  // the recipient.
  if (session) {
    await notifySessionNeedsYou({
      sessionId: session.id,
      byAgent: !!input.agentUserId || input.onMissingRequired === "owe",
      recipientUserId: input.userId,
      reason: { kind: "slots", before: [], after: session.expectedOutputs },
    });
  }

  // Lineage: the session this run was started FROM. AFTER the row exists and
  // outside any transaction — a bad parent handle must never cost the run. The
  // owner floor is the HUMAN principal (`input.userId`) — the run's owner too
  // since B6 (2026-10-21), and the owner of the session the agent was working
  // in.
  let parentLink: PlaybookRunStarted["parentLink"];
  if (input.parentSessionId && session) {
    try {
      const spawn = await recordSessionSpawn({
        childSessionId: session.id,
        parentSessionId: input.parentSessionId,
        userId: input.userId,
        workspaceId: session.workspaceId,
      });
      parentLink = spawn.linked
        ? { status: "linked", parentSessionId: input.parentSessionId }
        : {
            status: "failed",
            parentSessionId: input.parentSessionId,
            reason: spawn.reason,
          };
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id, parentSessionId: input.parentSessionId },
        "recordSessionSpawn failed — run kept, spawned_from edge not written"
      );
      parentLink = {
        status: "failed",
        parentSessionId: input.parentSessionId,
        reason: "error",
      };
    }
  }

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
    // A multiplayer run room (spec GROUP / AGENT_COLLAB) routes @mentions
    // against its roster, so the run's owner and staffed agents are enrolled —
    // otherwise no agent on the run could ever be summoned in its own room.
    // Spec-declared `members` + per-member caps remain the TODO above.
    if (
      channelType === ChannelType.GROUP ||
      channelType === ChannelType.AGENT_COLLAB
    ) {
      await enrollRoomMember(db, {
        channelId: created.id,
        userId: actorId,
        memberType: ChannelMemberKind.HUMAN,
        role: ChannelMemberRole.OWNER,
        addedBy: actorId,
      });
      for (const agentId of new Set(rosterAgentIds ?? [])) {
        if (!agentId || agentId === actorId) continue;
        await enrollRoomMember(db, {
          channelId: created.id,
          userId: agentId,
          memberType: ChannelMemberKind.AI_AGENT,
          addedBy: actorId,
        });
      }
    }
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
      // against (POST /api/hub/runs/{runId}/capture).
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

  // 6. Record the result on the run row (the ONE writer, shared with the
  //    re-dispatch after "Choose an agent" is answered).
  const updated = await recordExecutorResult(run.id, result);

  // Re-load the session so the returned row reflects the wired channelId.
  const refreshed = (await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, session.id),
  })) as FocusSession;

  return {
    run: updated,
    session: refreshed,
    ...(parentLink ? { parentLink } : {}),
  };
}

/** What a per_moment run carries into {@link executeSingleRun}. */
interface WorkerBatch {
  targetIds: string[];
  proposeWrites: boolean;
}

/**
 * Should this worker fire start anything? Returns the skip reason, or null to
 * go on. Checked BEFORE any session exists, in this order:
 *   1. `approvals_backlog` — the enablement already has `maxPendingApprovals`
 *      waiting on a person (the softer, earlier limit above the per-agent
 *      pending cap, so a batch never hits that refusal halfway);
 *   2. `volume_ceiling` — the enablement used today's irreversible-send
 *      ceiling (axis `worker_irreversible_sends_daily`, tighten-only): sent
 *      today plus still pending. This only stops a NEW run; every send inside
 *      one is checked again at the send door (`worker-send-ceiling.ts`);
 *   3. `stale_transition` — a per_thing worker on a status: the subject is no
 *      longer in it (it moved on between the event and this run). Where the
 *      status lives decides what is read: a DECLARED lifecycle's status
 *      column (the board's own read), else the playbook's `statusProperty`
 *      on the thing's properties — a kind with no declared lifecycle has a
 *      NULL column, and reading it skipped every fire. No property to read
 *      ⇒ the check passes.
 * Both counts need the enablement's automation; a worker fired outside one
 * (a manual test run) has nothing to count and skips them.
 */
export async function gateWorkerRun(
  input: RunPlaybookInput,
  worker: RunWorker,
  process: { statusProperty: string | null } = { statusProperty: null }
): Promise<WorkerSkipReason | null> {
  if (worker.automationId) {
    const max = await resolveWorkerMaxPending(
      worker.automationId,
      worker.maxPendingApprovals
    );
    if ((await countWorkerPendingApprovals(worker.automationId)) >= max) {
      return WORKER_SKIP_REASONS.approvalsBacklog;
    }
    if (
      (await countWorkerIrreversibleSendsToday(worker.automationId)) >=
      (await workerIrreversibleSendCeiling(worker.automationId))
    ) {
      return WORKER_SKIP_REASONS.volumeCeiling;
    }
  }
  if (worker.size === "per_thing" && worker.status && input.subjectId) {
    const { readSubjectProfile } = await import("./playbook-activators.js");
    const { lifecycleProperty } = await readSubjectProfile(
      worker.profileSlug,
      input.workspaceId
    );
    const statusProperty = process.statusProperty ?? lifecycleProperty;
    if (!lifecycleProperty || statusProperty !== lifecycleProperty) {
      if (!statusProperty) return null;
      const db = await getDb();
      const [thing] = await db
        .select({
          value: drizzleSql<
            string | null
          >`${entities.properties}->>${statusProperty}`,
        })
        .from(entities)
        .where(eq(entities.id, input.subjectId))
        .limit(1);
      return thing?.value === worker.status
        ? null
        : WORKER_SKIP_REASONS.staleTransition;
    }
    const { listThingsInStatus } = await loadStatusGroups();
    const still = await listThingsInStatus({
      profileSlug: worker.profileSlug,
      status: worker.status,
      userId: input.userId,
      workspaceId: input.workspaceId,
      limit: 1,
      onlyIds: [input.subjectId],
    });
    if (still.items.length === 0) return WORKER_SKIP_REASONS.staleTransition;
  }
  return null;
}

/**
 * The board's status read, loaded only by a worker run: it lives beside the
 * entity routers and pulls their module graph, which no other run needs.
 */
const loadStatusGroups = () => import("../lifecycle/status-groups.js");

/**
 * A per_moment worker run: the things in the worker's status under its scope
 * (the board's own set — `listThingsInStatus`), minus those this enablement
 * is already working, capped at `WORKER_BATCH_LIMIT`. ONE session, no
 * subject, one target edge per thing. Nothing in the set ⇒ `no-subject` (a
 * quiet moment, no session); a `count` worker under its threshold ⇒
 * `below_threshold` — the threshold counts the things in the status that
 * this enablement is NOT already working, so it gathers N fresh things
 * before it runs again.
 */
async function runWorkerBatch(
  playbook: Playbook,
  input: RunPlaybookInput,
  worker: RunWorker,
  filing: RunFiling
): Promise<RunPlaybookResult> {
  const inFlight = worker.automationId
    ? await listWorkerTargetsInFlight(worker.automationId)
    : [];
  const { listThingsInStatus } = await loadStatusGroups();
  const set = await listThingsInStatus({
    profileSlug: worker.profileSlug,
    status: worker.status ?? null,
    userId: input.userId,
    workspaceId: input.workspaceId,
    projectId: filing.projectId,
    limit: WORKER_BATCH_LIMIT,
    excludeIds: inFlight,
  });
  if (typeof worker.minCount === "number") {
    // The threshold counts the things NOT already being worked (backend F11):
    // once a batch over N runs, every later entry would otherwise find
    // total ≥ N and start a session over that one new thing. Things in flight
    // that are still in the status are taken off the status total.
    const busy = inFlight.length
      ? (
          await listThingsInStatus({
            profileSlug: worker.profileSlug,
            status: worker.status ?? null,
            userId: input.userId,
            workspaceId: input.workspaceId,
            projectId: filing.projectId,
            limit: 1,
            onlyIds: inFlight,
          })
        ).total
      : 0;
    if (set.total - busy < worker.minCount) {
      return {
        run: null,
        session: null,
        skipped: WORKER_SKIP_REASONS.belowThreshold,
      };
    }
  }
  if (set.items.length === 0) {
    return { run: null, session: null, skipped: "no-subject" };
  }
  const targets = set.items.map((i) => ({ id: i.id, name: i.name }));
  return executeSingleRun(
    playbook,
    { ...input, subjectId: undefined, idempotentBySubject: false },
    { ...((input.params ?? {}) as Record<string, unknown>), targets },
    filing,
    {
      targetIds: targets.map((t) => t.id),
      proposeWrites: worker.writes === "propose",
    }
  );
}

/**
 * The subject's LATEST run of this playbook, when it FAILED within
 * `AI_DISPATCH_GUARDRAILS.failedSubjectCooldownHours`; else null. "Latest" is
 * by run start, across every session of (playbook, subject) — a newer run that
 * did not fail ends the cooldown.
 */
async function latestRunFailedWithinCooldown(
  playbookId: string,
  subjectId: string
): Promise<{ runId: string } | null> {
  const db = await getDb();
  const [latest] = await db
    .select({
      id: playbookRuns.id,
      status: playbookRuns.status,
      recent: drizzleSql<boolean>`COALESCE(${playbookRuns.completedAt}, ${playbookRuns.startedAt}) > now() - (${AI_DISPATCH_GUARDRAILS.failedSubjectCooldownHours}::int * interval '1 hour')`,
    })
    .from(playbookRuns)
    .innerJoin(focusSessions, eq(focusSessions.id, playbookRuns.sessionId))
    .where(
      and(
        eq(playbookRuns.playbookId, playbookId),
        eq(focusSessions.subjectEntityId, subjectId)
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  return latest && latest.status === "failed" && latest.recent
    ? { runId: latest.id }
    : null;
}

/**
 * Record an executor's result on its run row — terminal statuses stamp
 * `completed_at`, a terminal child settles its parent automation run, and an
 * external-agent hand-off stores its `externalAgent` receipt. The ONE write
 * after `Executor.run`, for `runPlaybook` and for a re-dispatch of the same
 * run (`services/agent-dispatch/redispatch-on-choice.ts`).
 */
export async function recordExecutorResult(
  runId: string,
  result: RunResult
): Promise<PlaybookRun> {
  const db = await getDb();
  const terminal =
    result.status === "completed" ||
    result.status === "failed" ||
    result.status === "proposed";
  const externalAgentPatch = result.externalAgent
    ? { externalAgent: result.externalAgent }
    : {};
  const [updated] = await db
    .update(playbookRuns)
    .set({
      status: result.status,
      summary: result.summary ?? null,
      error: result.error ?? null,
      completedAt: terminal ? new Date() : null,
      // The hand-off receipt of an external-agent dispatch (0315) — what the
      // status poll and the cancel door read. Absent for every other executor.
      // (Built outside this literal: the terminal-settles tripwire parses a
      // brace-free `.set({...})`, and a nested object would blind it.)
      ...externalAgentPatch,
    })
    .where(eq(playbookRuns.id, runId))
    .returning();
  // A failed child of an automation run settles its parent (never throws).
  if (terminal)
    await settleParentAutomationRunFromChild({ playbookRunId: runId });
  return updated as PlaybookRun;
}
