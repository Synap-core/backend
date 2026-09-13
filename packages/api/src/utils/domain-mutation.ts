/**
 * recordDomainMutation — the ONE door for a completed domain mutation.
 *
 * A mutation to a first-class subject (entity / relation / role / facet …) has
 * to reach TWO pipes, and until now each door wired them by hand:
 *
 *   1. the immutable event log   — `auditLog({ …, phase: "completed" })`
 *      (feeds the per-record timeline / activity feed / agent-run observability)
 *   2. the side-effect fan-out   — `emitSideEffects({ … })`
 *      (feeds search indexing, webhooks, and — load-bearing — the automation
 *       trigger matcher)
 *
 * Both are keyed on the SAME `event-types.ts` vocabulary: a `.completed` event
 * of `${subjectType}.${action}` in the log, and the trigger eventType
 * `${subjectType}.${action}.completed` in the fan-out. Wiring them separately at
 * ~30 doors means a door can log a change the timeline shows but no automation
 * ever sees (or fire an automation with no timeline row). This helper collapses
 * the pair into one call so the two can never drift apart.
 *
 * Behaviour-preserving contract (do NOT change without updating callers):
 *   - `data`    → the side-effect payload (what the automation matcher + webhooks
 *                 read). This is the automation-visible shape.
 *   - `logData` → the event-log row's `data`. Defaults to `data` when omitted —
 *                 pass it only when the log payload legitimately differs from the
 *                 fan-out payload (e.g. relations log `sourceEntityId` but the
 *                 matcher expects `fromEntityId`).
 *   - The log append is awaited (its EventRecord is returned); the side-effect
 *     fan-out is fire-and-forget (it only enqueues pg-boss jobs and every reactor
 *     self-isolates), matching the dominant hand-wired pattern.
 *
 * This does NOT own the `.requested` / `.validated` governance phases (those
 * remain direct `auditLog` calls — they are not a timeline+automation pair), nor
 * the bare `emitSideEffects` calls that fire WITHOUT a matching log row on
 * purpose (e.g. a facet change's parent-entity refresh, document re-indexing).
 */

import { auditLog } from "./audit-log.js";
import { emitSideEffects, type SideEffectPayload } from "@synap/events";
import { isConnectionSyncProposal, type EventRecord } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "domain-mutation" });

/**
 * proposalId → "is it a connection-sync proposal". Approving one import graph
 * materializes up to hundreds of entities, each naming the same proposal, so the
 * in-flight PROMISE is memoized (one read per proposal, not per entity). Only
 * settled-true/false results are kept; a failed read is evicted so the next
 * mutation retries. Bounded; entries expire.
 */
const SYNC_PROPOSAL_TTL_MS = 5 * 60_000;
const SYNC_PROPOSAL_MAX = 500;
const syncProposalMemo = new Map<
  string,
  { at: number; value: Promise<boolean> }
>();

function lookupSyncProposal(proposalId: string): Promise<boolean> {
  const now = Date.now();
  const hit = syncProposalMemo.get(proposalId);
  if (hit && now - hit.at < SYNC_PROPOSAL_TTL_MS) return hit.value;
  if (syncProposalMemo.size >= SYNC_PROPOSAL_MAX) syncProposalMemo.clear();
  const value = isConnectionSyncProposal(proposalId);
  syncProposalMemo.set(proposalId, { at: now, value });
  value.catch(() => syncProposalMemo.delete(proposalId));
  return value;
}

/**
 * The fan-out origin for this mutation. An explicit `opts.origin` wins. Otherwise
 * a write that names a proposal carrying `data.connectionSync` (an approved sync
 * import being materialized) is `"sync"` — this is how the approval path gets
 * origin without knowing about sync.
 *
 * A FAILED lookup is logged at error level and resolves to no origin: the write
 * already happened, and an automation firing on it is the pre-sync behaviour, so
 * the failure is visible in logs rather than silently re-labelled.
 */
export async function resolveFanOutOrigin(
  opts: Pick<DomainMutationOpts, "origin" | "proposalId" | "subjectType">
): Promise<SideEffectPayload["origin"]> {
  if (opts.origin) return opts.origin;
  const proposalId = opts.proposalId;
  if (!proposalId) return undefined;
  const lookup = async () =>
    (await lookupSyncProposal(proposalId)) ? ("sync" as const) : undefined;
  try {
    return await lookup();
  } catch {
    // ONE retry: a failed read is evicted from the memo, so this is a fresh read.
    try {
      return await lookup();
    } catch (err) {
      logger.error(
        { err, proposalId, subjectType: opts.subjectType },
        "connection-sync proposal lookup failed twice — emitting without origin (automations may fire)"
      );
      return undefined;
    }
  }
}

/** Test seam: drop memoized proposal lookups. */
export function __resetSyncProposalMemo(): void {
  syncProposalMemo.clear();
}

export interface DomainMutationOpts {
  subjectType: string;
  action: string;
  subjectId: string;
  userId: string;
  /** Pass null for workspace-less (pod-wide) operations. */
  workspaceId?: string | null;
  /** AI-agent identity when this write is agent-attributed (→ event `is_agent`). */
  agentUserId?: string | null;
  /** Force the agent flag independently of an agent-user row (legacy AI paths). */
  isAgent?: boolean;
  /**
   * The proposal an AGENT write went through (auto-approved OR pending→approved)
   * → stamped onto the event's `proposal_id` column (0231). Absent → the write
   * executed with no proposal, so the `.completed` event reads as an "ungoverned
   * AI write" (`is_agent = true AND proposal_id IS NULL`). Only the log event
   * carries it — the side-effect fan-out is unchanged.
   */
  proposalId?: string | null;
  correlationId?: string;
  source?: string;
  /**
   * Focus session that produced this mutation. Reaches the automation matcher
   * (+ the F2 chain floor) AND — since 0241 — the `events.session_id` column, so
   * the event spine can answer "which session produced this" and not only "which
   * agent / which proposal". It was already in scope here and went only to the
   * matcher; that gap is what made the why-spine unanswerable.
   */
  sessionId?: string | null;
  /** Automation chain context → the cycle / depth guard. */
  automationContext?: SideEffectPayload["automationContext"];
  /**
   * `"sync"` for a bulk mirror of an external source. Fan-out only: event
   * automations skip it unless they opted in; index/embedding still run. See
   * `SideEffectPayload.origin`.
   */
  origin?: SideEffectPayload["origin"];
  /** Side-effect / automation-matcher / webhook payload. */
  data?: Record<string, unknown>;
  /** Event-log payload. Defaults to `data`. */
  logData?: Record<string, unknown>;
  /**
   * Re-throw a failed log append instead of swallowing it. Only for
   * governance-critical appends whose success gates downstream state.
   */
  throwOnError?: boolean;
}

/**
 * Record a completed domain mutation: append the immutable log event AND fan out
 * its side-effects, both keyed on the same `${subjectType}.${action}` vocabulary.
 * Returns the log EventRecord (or null if the best-effort append failed).
 */
export async function recordDomainMutation(
  opts: DomainMutationOpts
): Promise<EventRecord | null> {
  const record = await auditLog({
    subjectType: opts.subjectType,
    action: opts.action,
    phase: "completed",
    subjectId: opts.subjectId,
    userId: opts.userId,
    agentUserId: opts.agentUserId,
    isAgent: opts.isAgent,
    proposalId: opts.proposalId,
    workspaceId: opts.workspaceId,
    correlationId: opts.correlationId,
    sessionId: opts.sessionId,
    source: opts.source,
    data: opts.logData ?? opts.data,
    throwOnError: opts.throwOnError,
  });

  // Fire-and-forget fan-out. The origin lookup runs INSIDE the chain: it must
  // resolve before the matcher job is enqueued, but the caller never waits on it.
  // `resolveFanOutOrigin` never rejects and emitSideEffects self-isolates every
  // reactor, so the .catch is belt-and-braces.
  void resolveFanOutOrigin(opts)
    .then((origin) =>
      emitSideEffects({
        subjectType: opts.subjectType,
        action: opts.action,
        subjectId: opts.subjectId,
        userId: opts.userId,
        workspaceId: opts.workspaceId,
        // PROVENANCE — the `events` row id this fan-out is about. THIS is the door
        // that makes `automation_runs.trigger_event_id` (0256) non-NULL: the log
        // append above is already awaited, so its `EventRecord` is in hand here and
        // naming it costs no extra query. Nothing else on the first-party path
        // could supply it — `emitSideEffects` has no events row of its own, which
        // is exactly why the column read NULL for every event-fired run.
        //
        // `null` when the best-effort append failed: an emit with no log row must
        // claim no event rather than a stale or guessed one.
        //
        // ⚠️ TOP-LEVEL, never `data.eventId` — that key is the first thing
        // `resolveAutomationEventFingerprintId` reads, so a unique id there would
        // give every event a unique fingerprint and silently disable the
        // exactly-once claim. See `SideEffectPayload.eventId`.
        eventId: record?.id ?? null,
        sessionId: opts.sessionId ?? null,
        automationContext: opts.automationContext,
        ...(origin ? { origin } : {}),
        data: opts.data,
      })
    )
    .catch(() => {
      /* reactors log their own failures; nothing to do here */
    });

  return record;
}
