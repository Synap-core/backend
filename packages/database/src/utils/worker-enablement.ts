/**
 * STAGE WORKER reads (work model L4) — what one ENABLEMENT has in flight.
 *
 * An enablement is one compiled rule; its automation is the run's
 * `automationId`, stamped top-level on every session the worker starts
 * (`buildRunSessionMetadata`, api `run-playbook.ts`) and on every propose-mode
 * `playbook/run` proposal it files (`proposeRulePlaybookRun`, jobs). Both the
 * api runner and the jobs step read these, which is why they live here.
 *
 * The pod's copy of the target edge role: `@synap-core/types/workers`
 * `WORKER_TARGET_ROLE` (types imports this package, so the pod cannot import
 * it). `types/src/workers/pod-parity.contract.ts` pins the two EQUAL at
 * compile time.
 */

import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { proposals } from "../schema/proposals.js";
import { focusSessions, FocusSessionStatus } from "../schema/focus-sessions.js";
import { links } from "../schema/links.js";
import { automationRuns, automationStepRuns } from "../schema/automations.js";
import { events } from "../schema/events.js";

/** `links.metadata.role` of a worker's `session --targets--> entity` edge. */
export const WORKER_TARGET_LINK_ROLE = "worker_target" as const;

/**
 * THE "in flight" rule for a worker session (backend F9): its targets are
 * still being worked. One list, read by the batch exclusion here and by
 * process-sync's settle (`worker-target-result.ts`) — two lists disagreed on
 * `stale`, so a reaped session kept its things out of every later batch while
 * a person's move no longer settled them.
 *
 * `stale` is NOT in flight: the reaper marks a session that went quiet, and
 * its unsettled things become workable again for a batch. (The per_thing
 * run's subject reuse keeps `stale` on purpose — `IDEMPOTENCY_*` in api
 * run-playbook.ts — so a stuck run is not re-dispatched daily; that is the
 * one-run-per-subject rule, not this one.) `scheduled` is not either: it is
 * an appointment that has executed nothing, and a worker never starts one.
 * Listed positively, so a status added later reads "not in flight" — the
 * side where a thing is worked twice rather than dropped.
 */
export const WORKER_IN_FLIGHT_SESSION_STATUSES = [
  FocusSessionStatus.ACTIVE,
  FocusSessionStatus.PAUSED,
  FocusSessionStatus.FORMING,
] as const;

/**
 * The irreversible-send proposal types a worker's daily ceiling counts — the
 * two proposal-type-only executor keys that SEND outside the pod
 * (`@synap/governance-policy` `isReversibleWrite` answers false for both).
 */
export const WORKER_IRREVERSIBLE_PROPOSAL_TYPES = [
  "messaging.external.send",
  "provider.action",
] as const;

/** Sessions this enablement's automation started (by the top-level stamp). */
function enablementSessions(automationId: string) {
  return db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(sql`${focusSessions.metadata}->>'automationId' = ${automationId}`);
}

/**
 * Pending approvals this enablement is waiting on a person for: proposals
 * filed INSIDE its sessions, plus the `playbook/run` proposals its propose
 * mode filed (which carry `data.automationId`, no session).
 */
export async function countWorkerPendingApprovals(
  automationId: string
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`cast(count(*) as integer)` })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, "pending"),
        or(
          inArray(proposals.sessionId, enablementSessions(automationId)),
          sql`${proposals.data}->>'automationId' = ${automationId}`
        )
      )
    );
  return Number(row?.n ?? 0);
}

/**
 * {@link countWorkerPendingApprovals} for MANY enablements in one read (the
 * worker list, backend F13). Same population: a pending proposal filed inside
 * one of the enablement's sessions, or a propose-mode `playbook/run` naming
 * it — one proposal counted once per enablement it belongs to. Every asked id
 * is in the result (0 when none).
 */
export async function countWorkerPendingApprovalsBulk(
  automationIds: readonly string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>(automationIds.map((id) => [id, 0]));
  if (automationIds.length === 0) return out;
  const ids = [...out.keys()];
  const viaSession = sql<
    string | null
  >`${focusSessions.metadata}->>'automationId'`;
  const viaData = sql<string | null>`${proposals.data}->>'automationId'`;
  const rows = await db
    .select({ viaSession, viaData })
    .from(proposals)
    .leftJoin(focusSessions, eq(focusSessions.id, proposals.sessionId))
    .where(
      and(
        eq(proposals.status, "pending"),
        or(inArray(viaSession, ids), inArray(viaData, ids))
      )
    );
  for (const r of rows) {
    for (const id of new Set([r.viaSession, r.viaData])) {
      if (id && out.has(id)) out.set(id, out.get(id)! + 1);
    }
  }
  return out;
}

/**
 * Things this enablement is ALREADY working: worker targets with no result
 * yet, of its sessions still in flight (`WORKER_IN_FLIGHT_SESSION_STATUSES`). A per_moment run excludes them, so
 * a thing is never in two of one worker's batches at once.
 */
export async function listWorkerTargetsInFlight(
  automationId: string
): Promise<string[]> {
  const rows = await db
    .select({ toId: links.toId })
    .from(links)
    // `links.from_id` is text (polymorphic), `focus_sessions.id` a uuid.
    .innerJoin(focusSessions, sql`${links.fromId} = ${focusSessions.id}::text`)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "entity"),
        eq(links.linkType, "targets"),
        sql`${links.metadata}->>'role' = ${WORKER_TARGET_LINK_ROLE}`,
        sql`${links.metadata}->>'result' IS NULL`,
        sql`${focusSessions.metadata}->>'automationId' = ${automationId}`,
        inArray(focusSessions.status, [...WORKER_IN_FLIGHT_SESSION_STATUSES])
      )
    );
  return [...new Set(rows.map((r) => r.toId))];
}

/**
 * `events.source` of every external-dispatch audit row — the api's
 * `EXTERNAL_DISPATCH_SOURCE` (`connectors/external-dispatch-constants.ts`),
 * which this package cannot import. The send-ceiling test pins them equal.
 */
export const WORKER_SEND_EVENT_SOURCE = "external-dispatch" as const;

function utcDayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/**
 * Irreversible sends this enablement's sessions MADE since the start of the
 * UTC day: the external-dispatch audit rows (`recordExternalAction`, api)
 * stamped with one of its sessions. That row is written for every send that
 * reached the far side — an auto-executed one and an approved one alike, as
 * long as the door was handed the session (the approval executors pass the
 * proposal's). A messaging send always counts; a provider call counts unless
 * its HTTP method is a read (GET/HEAD/OPTIONS). LIMIT: a GraphQL query is a
 * POST, so it counts as a send — the over-count is the safe side of a ceiling.
 */
export async function countWorkerIrreversibleSentToday(
  automationId: string,
  now: Date = new Date()
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`cast(count(*) as integer)` })
    .from(events)
    .where(
      and(
        eq(events.source, WORKER_SEND_EVENT_SOURCE),
        gte(events.timestamp, utcDayStart(now)),
        sql`${events.data}->>'status' = 'sent'`,
        or(
          sql`${events.type} LIKE '%.send.completed'`,
          sql`(${events.type} LIKE '%.action.completed' AND upper(coalesce(${events.data}->>'method', '')) NOT IN ('GET', 'HEAD', 'OPTIONS'))`
        ),
        inArray(events.sessionId, enablementSessions(automationId))
      )
    );
  return Number(row?.n ?? 0);
}

/**
 * Irreversible sends that spend this enablement's ceiling for today: those
 * already made today ({@link countWorkerIrreversibleSentToday}) plus those
 * still waiting on a person (a pending irreversible proposal filed by one of
 * its sessions, whenever it was filed — approving it would send today).
 * Rejected, withdrawn, expired and failed proposals sent nothing; an approved
 * one is counted by the send it made.
 *
 * What a new send must stay under: the run-start gate and the send door ask
 * this. An approval replay asks the SENT count only — its own proposal is one
 * of the pending ones.
 */
export async function countWorkerIrreversibleSendsToday(
  automationId: string,
  now: Date = new Date()
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`cast(count(*) as integer)` })
    .from(proposals)
    .where(
      and(
        inArray(proposals.proposalType, [
          ...WORKER_IRREVERSIBLE_PROPOSAL_TYPES,
        ]),
        eq(proposals.status, "pending"),
        inArray(proposals.sessionId, enablementSessions(automationId))
      )
    );
  return (
    Number(row?.n ?? 0) +
    (await countWorkerIrreversibleSentToday(automationId, now))
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The enablement (automation id) whose worker started this session, or null
 * when the session is not a worker's — or is not a session id at all.
 */
export async function workerAutomationOfSession(
  sessionId: string
): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null;
  const [row] = await db
    .select({
      automationId: sql<
        string | null
      >`${focusSessions.metadata}->>'automationId'`,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  return row?.automationId ?? null;
}

/**
 * A worker fire HELD by its approvals backlog (arch F12): the `playbook_run`
 * step answered `{ status: "skipped", reason: "approvals_backlog", held:
 * true }`. A per_thing worker on an event has no next tick — its claim on
 * that event is spent — so the thing would be dropped for good. A held fire
 * is RELEASED (re-run once with its own trigger) when the backlog drains.
 */
export interface HeldWorkerRun {
  runId: string;
  workspaceId: string | null;
  subjectEntityId: string | null;
  triggerEventId: string | null;
  triggerPayload: Record<string, unknown>;
  /** The agent that produced the held trigger, carried to the release. */
  producerAgentUserId: string | null;
}

/** The step-output marker of a held fire (`steps/playbook-run.ts`, jobs). */
export const WORKER_HELD_OUTPUT_KEY = "held" as const;

/**
 * This enablement's held fires that nothing has superseded: no LATER run of
 * the same automation for the same subject (a release, or a fresh fire of the
 * same thing, is that later run). Oldest first. A released fire that is held
 * again is a new held run, so it is offered again at the next drain.
 */
export async function listHeldWorkerRuns(
  automationId: string,
  limit: number
): Promise<HeldWorkerRun[]> {
  if (limit <= 0) return [];
  const rows = await db
    .select({
      runId: automationRuns.id,
      workspaceId: automationRuns.workspaceId,
      subjectEntityId: automationRuns.subjectEntityId,
      triggerEventId: automationRuns.triggerEventId,
      triggerPayload: automationRuns.triggerPayload,
      producer: sql<
        string | null
      >`${automationStepRuns.output}->>'producerAgentUserId'`,
    })
    .from(automationStepRuns)
    .innerJoin(automationRuns, eq(automationRuns.id, automationStepRuns.runId))
    .where(
      and(
        eq(automationRuns.automationId, automationId),
        sql`${automationStepRuns.output}->>'reason' = 'approvals_backlog'`,
        sql`${automationStepRuns.output}->>${WORKER_HELD_OUTPUT_KEY} = 'true'`,
        sql`NOT EXISTS (
          SELECT 1 FROM automation_runs later
          WHERE later.automation_id = ${automationRuns.automationId}
            AND later.subject_entity_id IS NOT DISTINCT FROM ${automationRuns.subjectEntityId}
            AND later.started_at > ${automationRuns.startedAt}
        )`
      )
    )
    .orderBy(automationRuns.startedAt)
    .limit(limit);
  return rows.map((r) => ({
    runId: r.runId,
    workspaceId: r.workspaceId ?? null,
    subjectEntityId: r.subjectEntityId ?? null,
    triggerEventId: r.triggerEventId ?? null,
    triggerPayload: (r.triggerPayload ?? {}) as Record<string, unknown>,
    producerAgentUserId: r.producer ?? null,
  }));
}
