/**
 * orient's `startHere.looseEnds` (W-B2) — what THE CALLING AGENT left open,
 * each row with the exact call that ends it. Agents keep the books: the pod
 * never asked them to, so a person's queue filled with an agent's leftovers.
 *
 * Four populations, all the calling agent's OWN (never another agent's, never
 * the person's):
 *   - sessions it opened (`origin: 'agent'`, on its roster) idle over
 *     {@link LOOSE_END_IDLE_DAYS} days. Closing one is the agent's to do when
 *     no person touched it and it owes the person nothing (founder Q-B1);
 *     otherwise its asks are withdrawn or handed over first (Q-B2);
 *   - asks it left owed by the person on its ENDED sessions (closed, failed):
 *     nothing retires them, so they wait in the person's queue forever;
 *   - its proposals pending over {@link LOOSE_END_IDLE_DAYS} days;
 *   - automations it created that never fired — the automation-health
 *     warden's ONE rule (`detectZeroRunAutomations`, manual and draft excluded).
 *
 * Each section reads on its own; one that cannot be read is
 * `{ status: "unavailable" }`, never an empty list or a zero.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  lt,
  asc,
  drizzleSql,
  focusSessions,
  proposals,
  automations,
  ProposalStatus,
  owedSlotWhere,
  personTouchedSubjectIds,
} from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { ExpectedOutput } from "@synap/playbooks";
import { openLink } from "../../utils/deep-links.js";
import { isOwedSlot } from "../focus-sessions/owed-outputs.js";
import { slotKeyAt } from "../focus-sessions/slot-keys.js";
import {
  detectZeroRunAutomations,
  FIRING_STATUSES,
  PRODUCER_BACKED_TRIGGERS,
} from "../proposals/automation-health-predicate.js";
import { loadRunCounts } from "../proposals/automation-health.js";

/** Idle this long, a session or a pending proposal is a loose end. */
export const LOOSE_END_IDLE_DAYS = 7;
/** Rows listed per section; `count` is the whole population. */
export const LOOSE_ENDS_ITEMS = 5;
/** Ended sessions read for their leftover asks before "at least this many". */
const ENDED_SESSIONS_READ_CAP = 100;
/** Statuses of a session still running (`stale` = running, idle 24 h). */
const RUNNING_STATUSES = ["active", "paused", "forming", "stale"] as const;
/** Ended without retiring its asks (`cancelled` retires them). */
const ENDED_STATUSES = ["closed", "failed"] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const logger = createLogger({ module: "discover/loose-ends" });

type Unavailable = { status: "unavailable" };
const UNAVAILABLE: Unavailable = { status: "unavailable" };

/** A section that could not be read: logged, and reported as such. */
function unavailable(section: string, err: unknown): Unavailable {
  logger.warn({ err, section }, "orient: loose ends NOT read — unavailable");
  return UNAVAILABLE;
}

export interface LooseEnds {
  /** The population: the calling agent's own work, never anyone else's. */
  lens: "yours";
  idleDays: number;
  sessions:
    | {
        count: number;
        items: Array<{
          id: string;
          title: string;
          status: string;
          idleDays: number;
          /** Asks on it the person still owes. */
          owedByPerson: number;
          /** A person made a write on it: not yours alone to close. */
          personTouched: boolean;
          /** The call (or the step before it) that ends it. */
          close: string;
        }>;
      }
    | Unavailable;
  asks:
    | {
        count: number;
        /** True when the ended sessions read hit its cap. */
        countIsLowerBound: boolean;
        items: Array<{
          sessionId: string;
          sessionTitle: string;
          key: string;
          label: string;
          owedSince: string | null;
          close: string;
        }>;
      }
    | Unavailable;
  proposals:
    | {
        count: number;
        oldestDays: number | null;
        items: Array<{
          id: string;
          summary: string | null;
          ageDays: number;
          link: string;
          close: string;
        }>;
      }
    | Unavailable;
  automations:
    | {
        count: number;
        items: Array<{
          id: string;
          name: string;
          triggerType: string;
          ageDays: number;
          close: string;
        }>;
      }
    | Unavailable;
}

const wholeDays = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);

/** Sessions this agent OPENED for this person. */
function ownAgentSessionsWhere(userId: string, agentUserId: string) {
  return and(
    eq(focusSessions.userId, userId),
    eq(focusSessions.origin, "agent"),
    drizzleSql`${agentUserId} = ANY(${focusSessions.agentIds})`
  );
}

function readSlots(raw: unknown): ExpectedOutput[] {
  return Array.isArray(raw) ? (raw as ExpectedOutput[]) : [];
}

/** The asks a session's person still owes, each named by the key that withdraws it. */
function owedAsks(raw: unknown): Array<{
  key: string;
  label: string;
  owedSince: string | null;
}> {
  const slots = readSlots(raw);
  return slots.flatMap((slot, i) =>
    isOwedSlot(slot)
      ? [
          {
            key: slotKeyAt(slots, i) ?? slot.label,
            label: slot.label,
            owedSince: slot.owedSince ?? null,
          },
        ]
      : []
  );
}

/** The call that withdraws one ask (Q-B2: withdraw, or hand it over). */
function withdrawAskCall(sessionId: string, key: string): string {
  return `synap_update_session {"sessionId":"${sessionId}","retireOutput":"${key}"} to withdraw it (the person confirms), or tell them in its room it is theirs now.`;
}

/**
 * What a close left owed by the person (`synap_complete_session`'s
 * `leftOwed`, W-B2). Only `cancelled` retires asks; any other close leaves
 * them in the person's queue, so the closer withdraws or hands each one over
 * (founder Q-B2). Undefined when nothing is owed.
 */
export function leftOwedAfterClose(session: {
  id: string;
  status: string;
  expectedOutputs: unknown;
}):
  | {
      count: number;
      items: Array<{ key: string; label: string; close: string }>;
    }
  | undefined {
  if (session.status === "cancelled") return undefined;
  const asks = owedAsks(session.expectedOutputs);
  if (asks.length === 0) return undefined;
  return {
    count: asks.length,
    items: asks.map((a) => ({
      key: a.key,
      label: a.label,
      close: withdrawAskCall(session.id, a.key),
    })),
  };
}

/** The closing call for an idle session, by Q-B1 / Q-B2. */
export function sessionCloseCall(s: {
  id: string;
  owedByPerson: number;
  personTouched: boolean;
}): string {
  if (s.owedByPerson > 0) {
    return (
      `It still owes the person ${s.owedByPerson} ask${s.owedByPerson === 1 ? "" : "s"}: ` +
      `withdraw each one you no longer need (synap_update_session {"sessionId":"${s.id}","retireOutput":"<key>"} — the person confirms), ` +
      `or tell them in its room it is theirs now; then synap_complete_session {"sessionId":"${s.id}"}.`
    );
  }
  if (s.personTouched) {
    return `A person worked in it: ask them in its room (synap_post_message) before you close it with synap_complete_session {"sessionId":"${s.id}"}.`;
  }
  return `synap_complete_session {"sessionId":"${s.id}"} — terminalStatus "cancelled" if the work was abandoned.`;
}

async function readIdleSessions(
  userId: string,
  agentUserId: string,
  now: Date
): Promise<LooseEnds["sessions"]> {
  try {
    const cutoff = new Date(now.getTime() - LOOSE_END_IDLE_DAYS * MS_PER_DAY);
    const where = and(
      ownAgentSessionsWhere(userId, agentUserId),
      inArray(focusSessions.status, [...RUNNING_STATUSES]),
      lt(focusSessions.updatedAt, cutoff)
    );
    const [[total], rows] = await Promise.all([
      db
        .select({ n: drizzleSql<number>`cast(count(*) as integer)` })
        .from(focusSessions)
        .where(where),
      db
        .select({
          id: focusSessions.id,
          title: focusSessions.title,
          goal: focusSessions.goal,
          status: focusSessions.status,
          updatedAt: focusSessions.updatedAt,
          expectedOutputs: focusSessions.expectedOutputs,
        })
        .from(focusSessions)
        .where(where)
        // SESSION-KIND-LENS-EXEMPT: the agent's own sessions, every kind.
        .orderBy(asc(focusSessions.updatedAt))
        .limit(LOOSE_ENDS_ITEMS),
    ]);
    const touched = await personTouchedSubjectIds(
      db,
      "focus_session",
      rows.map((r) => r.id)
    );
    return {
      count: Number(total?.n ?? 0),
      items: rows.map((r) => {
        const item = {
          id: r.id,
          title: resolveSessionTitle(r),
          status: r.status,
          idleDays: wholeDays(new Date(r.updatedAt), now),
          owedByPerson: owedAsks(r.expectedOutputs).length,
          personTouched: touched.has(r.id),
        };
        return { ...item, close: sessionCloseCall(item) };
      }),
    };
  } catch (err) {
    return unavailable("sessions", err);
  }
}

async function readLeftoverAsks(
  userId: string,
  agentUserId: string
): Promise<LooseEnds["asks"]> {
  try {
    const rows = await db
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        expectedOutputs: focusSessions.expectedOutputs,
      })
      .from(focusSessions)
      .where(
        and(
          ownAgentSessionsWhere(userId, agentUserId),
          inArray(focusSessions.status, [...ENDED_STATUSES]),
          owedSlotWhere()
        )
      )
      // SESSION-KIND-LENS-EXEMPT: the agent's own sessions, every kind.
      .orderBy(asc(focusSessions.updatedAt))
      .limit(ENDED_SESSIONS_READ_CAP);
    const asks = rows.flatMap((r) =>
      owedAsks(r.expectedOutputs).map((a) => ({
        sessionId: r.id,
        sessionTitle: resolveSessionTitle(r),
        ...a,
        close: withdrawAskCall(r.id, a.key),
      }))
    );
    return {
      count: asks.length,
      countIsLowerBound: rows.length >= ENDED_SESSIONS_READ_CAP,
      items: asks.slice(0, LOOSE_ENDS_ITEMS),
    };
  } catch (err) {
    return unavailable("asks", err);
  }
}

async function readOldProposals(
  agentUserId: string,
  now: Date
): Promise<LooseEnds["proposals"]> {
  try {
    const cutoff = new Date(now.getTime() - LOOSE_END_IDLE_DAYS * MS_PER_DAY);
    const where = and(
      eq(proposals.agentUserId, agentUserId),
      eq(proposals.status, ProposalStatus.PENDING),
      lt(proposals.createdAt, cutoff)
    );
    const [[total], rows] = await Promise.all([
      db
        .select({ n: drizzleSql<number>`cast(count(*) as integer)` })
        .from(proposals)
        .where(where),
      db
        .select({
          id: proposals.id,
          summary: drizzleSql<string | null>`${proposals.data}->>'summary'`,
          createdAt: proposals.createdAt,
        })
        .from(proposals)
        .where(where)
        .orderBy(asc(proposals.createdAt))
        .limit(LOOSE_ENDS_ITEMS),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      ageDays: wholeDays(new Date(r.createdAt), now),
      link: openLink(r.id),
      close: `If you no longer want it: synap_reject_proposal {"proposalId":"${r.id}","reason":"<why>"}. Otherwise it waits for the person.`,
    }));
    return {
      count: Number(total?.n ?? 0),
      oldestDays: items[0]?.ageDays ?? null,
      items,
    };
  } catch (err) {
    return unavailable("proposals", err);
  }
}

async function readNeverFiredAutomations(
  agentUserId: string,
  now: Date
): Promise<LooseEnds["automations"]> {
  try {
    const firing = await db
      .select({
        id: automations.id,
        name: automations.name,
        status: automations.status,
        triggerType: automations.triggerType,
        workspaceId: automations.workspaceId,
        createdBy: automations.createdBy,
        createdAt: automations.createdAt,
      })
      .from(automations)
      .where(
        and(
          eq(automations.createdBy, agentUserId),
          inArray(automations.status, FIRING_STATUSES),
          inArray(automations.triggerType, PRODUCER_BACKED_TRIGGERS)
        )
      );
    const findings = detectZeroRunAutomations({
      automations: firing,
      runCountsByAutomationId: await loadRunCounts(firing.map((a) => a.id)),
      now,
    });
    return {
      count: findings.length,
      items: findings.slice(0, LOOSE_ENDS_ITEMS).map((f) => ({
        id: f.automationId,
        name: f.name,
        triggerType: f.triggerType,
        ageDays: f.ageDays,
        close: `synap_run_capability {"verbId":"automation.archive","parameters":{"automationId":"${f.automationId}"}} archives it now (you made it and it never ran; the person can switch it back on).`,
      })),
    };
  } catch (err) {
    return unavailable("automations", err);
  }
}

/** The calling agent's loose ends. Never throws: each section reports itself. */
export async function readLooseEnds(p: {
  userId: string;
  agentUserId: string;
  now?: Date;
}): Promise<LooseEnds> {
  const now = p.now ?? new Date();
  const [sessions, asks, proposalsSection, automationsSection] =
    await Promise.all([
      readIdleSessions(p.userId, p.agentUserId, now),
      readLeftoverAsks(p.userId, p.agentUserId),
      readOldProposals(p.agentUserId, now),
      readNeverFiredAutomations(p.agentUserId, now),
    ]);
  return {
    lens: "yours",
    idleDays: LOOSE_END_IDLE_DAYS,
    sessions,
    asks,
    proposals: proposalsSection,
    automations: automationsSection,
  };
}
