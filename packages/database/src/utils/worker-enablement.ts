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

import { and, eq, gte, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { proposals } from "../schema/proposals.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { links } from "../schema/links.js";
import { automationRuns, automationStepRuns } from "../schema/automations.js";

/** `links.metadata.role` of a worker's `session --targets--> entity` edge. */
export const WORKER_TARGET_LINK_ROLE = "worker_target" as const;

/** Session statuses that are done: their targets are no longer being worked. */
const CLOSED_SESSION_STATUSES = ["closed", "failed", "cancelled"] as const;

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
 * Things this enablement is ALREADY working: worker targets with no result
 * yet, of its sessions that are still open. A per_moment run excludes them, so
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
        notInArray(focusSessions.status, [...CLOSED_SESSION_STATUSES])
      )
    );
  return [...new Set(rows.map((r) => r.toId))];
}

/**
 * Irreversible sends this enablement's sessions asked for since the start of
 * the UTC day — every such proposal that sent or still may (pending ones
 * count: approving them would spend the ceiling; rejected, withdrawn,
 * expired and failed ones sent nothing).
 *
 * LIMIT, measured by reading the doors: an agent whose sends a person widened
 * to auto-execute files NO proposal, so its sends are not counted here. The
 * per-send audit row (`recordExternalAction`) carries no session id to count
 * by. Until it does, the ceiling holds every send that goes through review —
 * the default for an irreversible key (rung 9).
 */
export async function countWorkerIrreversibleSendsToday(
  automationId: string,
  now: Date = new Date()
): Promise<number> {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const [row] = await db
    .select({ n: sql<number>`cast(count(*) as integer)` })
    .from(proposals)
    .where(
      and(
        inArray(proposals.proposalType, [
          ...WORKER_IRREVERSIBLE_PROPOSAL_TYPES,
        ]),
        notInArray(proposals.status, [
          "rejected",
          "withdrawn",
          "expired",
          "approval_failed",
        ]),
        gte(proposals.createdAt, dayStart),
        inArray(proposals.sessionId, enablementSessions(automationId))
      )
    );
  return Number(row?.n ?? 0);
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
