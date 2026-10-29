/**
 * The facts every status read draws from (status-flow plan W0b): when a thing
 * entered its status (the transition log), what it waits on (owed slots,
 * pending proposals, `blocked_by` edges), and the read-side category of a
 * playbook run. Shared by the per-object read (`status-read.ts`) and the
 * rollups (`status-rollup.ts`), so the two cannot disagree.
 *
 * Every reader here THROWS on a failed read; the caller says `unavailable`.
 */
import {
  and,
  db,
  drizzleSql,
  eq,
  events,
  inArray,
  or,
  proposals,
  ProposalStatus,
} from "@synap/database";
import type { PlaybookRunStatus } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import type {
  LifecycleCategory,
  TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import {
  deriveWaitingOn,
  type WaitingOnMark,
  type WaitingOnSource,
} from "@synap-core/types/units";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { listOwedSlots } from "../focus-sessions/owed-outputs.js";
import type { SessionSubject } from "../focus-sessions/session-subject-where.js";
import type { ResolvedScope } from "../../utils/scope-filter.js";

/** Counts per lifecycle category; a category with none is left out. */
export type CategoryCounts = Partial<Record<LifecycleCategory, number>>;

/**
 * A playbook run's status, read as the RUN base lifecycle (status-flow plan
 * §3: runs are mapped when read, never moved through a door). Keyed by every
 * stored status, so a new one stops the build until it is classified.
 */
export const RUN_STATUS_DECLARATION = {
  proposed: { category: "open" },
  running: { category: "active" },
  waiting_on_you: { category: "paused" },
  stale: { category: "paused" },
  completed: { category: "done" },
  failed: { category: "lost" },
  cancelled: { category: "lost" },
} as const satisfies Record<PlaybookRunStatus, { category: LifecycleCategory }>;

export function runStatusCategory(status: string): LifecycleCategory | null {
  return Object.hasOwn(RUN_STATUS_DECLARATION, status)
    ? RUN_STATUS_DECLARATION[status as PlaybookRunStatus].category
    : null;
}

export function addCount(
  counts: CategoryCounts,
  category: LifecycleCategory | null,
  n: number
): void {
  if (category && n > 0) counts[category] = (counts[category] ?? 0) + n;
}

/**
 * When each subject last ENTERED its status: its latest transition event
 * (`<subject>.transition.completed`), an entity's own lifecycle only (a role's
 * move is the facet's). A subject with none is absent: the caller falls back
 * to a stored date and says the time was not measured. Goal and session
 * events carry their DELIVERY time (the sweeper, up to ~90 s after the move).
 */
export async function lastTransitionAt(
  refs: ReadonlyArray<{ type: TransitionSubjectType; id: string }>
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (refs.length === 0) return out;
  const { TRANSITION_EVENT_TYPES } = await import("@synap/events");
  const rows = await db
    .select({
      subjectType: events.subjectType,
      subjectId: events.subjectId,
      at: drizzleSql<Date | string>`max(${events.timestamp})`,
    })
    .from(events)
    .where(
      and(
        inArray(events.type, Object.values(TRANSITION_EVENT_TYPES)),
        inArray(events.subjectId, [...new Set(refs.map((r) => r.id))]),
        drizzleSql`(${events.subjectType} <> 'entity' OR ${events.data}->>'role' IS NULL)`
      )
    )
    .groupBy(events.subjectType, events.subjectId);
  for (const r of rows) {
    out.set(`${r.subjectType}:${r.subjectId}`, new Date(r.at));
  }
  return out;
}

/**
 * Status moves since `since` — of goals and sessions filed in `trackIds`
 * (grouped per goal), or of everything in one space or project. Counted from
 * the transition log; a move made before the door existed is not counted.
 */
export async function countMovesSince(
  since: Date,
  lens:
    | { trackIds: string[] }
    | { workspaceId: string }
    | { projectId: string; entityIds: SQL }
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if ("trackIds" in lens && lens.trackIds.length === 0) return out;
  const { TRANSITION_EVENT_TYPES } = await import("@synap/events");
  const after = drizzleSql`${events.timestamp} >= ${since.toISOString()}::timestamptz`;
  const workUnit = inArray(events.type, [
    TRANSITION_EVENT_TYPES.track,
    TRANSITION_EVENT_TYPES.focus_session,
  ]);
  if ("trackIds" in lens) {
    const trackId = drizzleSql<string>`${events.data}->>'trackId'`;
    const rows = await db
      .select({
        key: trackId,
        n: drizzleSql<number>`cast(count(*) as integer)`,
      })
      .from(events)
      .where(and(workUnit, after, inArray(trackId, lens.trackIds)))
      .groupBy(trackId);
    for (const r of rows) out.set(r.key, Number(r.n));
    return out;
  }
  const inLens =
    "workspaceId" in lens
      ? and(
          inArray(events.type, Object.values(TRANSITION_EVENT_TYPES)),
          eq(events.workspaceId, lens.workspaceId)
        )
      : or(
          and(
            workUnit,
            drizzleSql`${events.data}->>'projectId' = ${lens.projectId}`
          ),
          and(
            eq(events.type, TRANSITION_EVENT_TYPES.entity),
            drizzleSql`${events.subjectId} IN (${lens.entityIds})`
          )
        );
  const [row] = await db
    .select({ n: drizzleSql<number>`cast(count(*) as integer)` })
    .from(events)
    .where(and(inLens, after));
  out.set("all", Number(row?.n ?? 0));
  return out;
}

/**
 * What a set of things WAITS ON, in the goal's own vocabulary (R4,
 * `deriveWaitingOn`): slots the person owes (THE owed-slot read), proposals
 * pending about them, and their open `blocked_by` blockers (THE dependency
 * read). One mark list for the whole set.
 */
export async function readWaitingOn(input: {
  userId: string;
  /** Owed slots: of these sessions, of sessions about these things, or in a scope. */
  owed?:
    | { sessionIds: string[] }
    | { subject: SessionSubject }
    | { scope: ResolvedScope };
  /** Pending proposals filed by these sessions or targeting these things. */
  proposals?: { sessionIds?: string[]; targetIds?: string[] };
  /** Nodes whose open `blocked_by` blockers count. */
  blockedNodes?: Array<{ kind: "session" | "entity" | "track"; id: string }>;
}): Promise<WaitingOnMark[]> {
  const sources: WaitingOnSource[] = [];
  const sessionIds = input.proposals?.sessionIds ?? [];
  const targetIds = input.proposals?.targetIds ?? [];
  const nodes = input.blockedNodes ?? [];
  const { readDependencyFacts } = await import("../links/dependency-links.js");
  const [owed, pending, deps] = await Promise.all([
    input.owed &&
    !("sessionIds" in input.owed && input.owed.sessionIds.length === 0)
      ? listOwedSlots({
          userId: input.userId,
          scope:
            "scope" in input.owed
              ? input.owed.scope
              : { workspaceLens: undefined, projectLens: undefined },
          limit: WAITING_READ_CAP,
          ...("sessionIds" in input.owed
            ? { sessionIds: input.owed.sessionIds }
            : {}),
          ...("subject" in input.owed ? { subject: input.owed.subject } : {}),
        })
      : Promise.resolve([]),
    sessionIds.length + targetIds.length > 0
      ? db
          .select({ n: drizzleSql<number>`cast(count(*) as integer)` })
          .from(proposals)
          .where(
            and(
              eq(proposals.status, ProposalStatus.PENDING),
              userVisibleWhere(proposals.workspaceId, input.userId),
              or(
                sessionIds.length
                  ? inArray(proposals.sessionId, sessionIds)
                  : undefined,
                targetIds.length
                  ? inArray(proposals.targetId, targetIds)
                  : undefined
              )
            )
          )
      : Promise.resolve([{ n: 0 }]),
    nodes.length ? readDependencyFacts(nodes, input.userId) : null,
  ]);
  for (const s of owed) {
    sources.push({ kind: "owed_slot", blockedReason: s.blockedReason ?? null });
  }
  for (let i = 0; i < Number(pending[0]?.n ?? 0); i++) {
    sources.push({ kind: "pending_proposal" });
  }
  for (const facts of deps?.values() ?? []) {
    for (let i = 0; i < facts.openBlockers; i++) {
      sources.push({ kind: "blocked_by" });
    }
  }
  return deriveWaitingOn(sources);
}

/** Owed slots read per waiting-on question (a count past it is a floor). */
export const WAITING_READ_CAP = 100;
