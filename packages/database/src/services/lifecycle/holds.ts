/**
 * THE CURRENT HOLD (status-flow plan W4) — read off the transition log, the
 * hold's only store.
 *
 * A hold travels in the transition that entered (or carried) the pause
 * (`TransitionBase.hold`, the rule in `decideMoveHold`). The log read here is
 * `lifecycle_transition_outbox`: every transition is written there in the SAME
 * transaction as the status it records (0324) and is kept after delivery, so a
 * pause's hold is readable the moment the pause commits — unlike the `events`
 * row, which a goal's or a session's move gets only when the sweeper delivers
 * it. A hold is CURRENT when its transition is the subject's latest and the
 * subject still stands in that status (a status written outside the doors —
 * born, merged, synced — has no transition, so it carries no hold).
 *
 * ONE helper, five questions: the holds of given subjects (a read, the
 * carried hold of a `paused → paused` move), the holds whose `until.date` has
 * come (the hourly resume sweep), the holds waiting on a thing that just
 * moved (the `until.moves` resume), the holds waiting on a dev fact
 * (`pr:` / `main:` / `job:`, the hourly sweep's second half), and the holds
 * whose `reviewBy` has passed (the status watcher, W6). A passed `reviewBy`
 * never moves anything.
 */
import { and, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { ISO_STAMP_PATTERN } from "@synap-core/types/needs-you/rule";
import type {
  MoveHoldDecision,
  RecordedHold,
  TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import type * as schema from "../../schema/index.js";
import { lifecycleTransitionOutbox } from "../../schema/lifecycle-transition-outbox.js";
import { entities } from "../../schema/entities.js";
import { entityFacets } from "../../schema/entity-facets.js";
import { projectTracks } from "../../schema/project-tracks.js";
import { focusSessions } from "../../schema/focus-sessions.js";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A thing that can be held: an entity (kind lifecycle, or a role's facet), a goal, a session. */
export interface HoldSubjectRef {
  subjectType: TransitionSubjectType;
  subjectId: string;
  /** A role's lifecycle lives on its facet; null for the kind's own. */
  facetId?: string | null;
}

export interface CurrentHold extends Required<HoldSubjectRef> {
  role: string | null;
  /** The paused status it stands in. */
  status: string;
  hold: RecordedHold;
  transitionId: string;
  /** The person the paused thing's move was attributed to. */
  userId: string;
  workspaceId: string | null;
  /** `until.date` has come: the hourly sweep resumes it. */
  resumeDue: boolean;
  /** `reviewBy` has passed: a signal for the watcher, never a move. */
  reviewDue: boolean;
}

/**
 * A move refused by the hold rule (`decideMoveHold`): thrown inside a writer's
 * transaction so nothing lands; each door turns it into its own refusal
 * (BAD_REQUEST on the wire, `refused` from `moveStatus`).
 */
export class HoldRefusedError extends Error {
  /** A refusal of the caller's input: the api maps it to 400 (`isSynapLikeError`). */
  readonly statusCode = 400;
  readonly code: Extract<MoveHoldDecision, { ok: false }>["code"];
  constructor(decision: Extract<MoveHoldDecision, { ok: false }>) {
    super(decision.message);
    this.name = "HoldRefusedError";
    this.code = decision.code;
  }
}

export type HoldFilter =
  | { subjects: readonly HoldSubjectRef[] }
  | { resumeDueBy: Date }
  | { reviewDueBy: Date }
  | { awaiting: { subjectType: string; subjectId: string } }
  /** Every hold whose `until.moves` names a dev fact (`HoldDevRef`). */
  | { awaitingDevFacts: true }
  /** Every current hold (the status watcher's wait episodes ask about each). */
  | { current: true };

/** A row owed before W1 has no subject fields: it is an entity's. */
const SUBJECT_TYPE = (a: string) =>
  sql.raw(`coalesce(${a}.transition->>'subjectType', 'entity')`);
const SUBJECT_ID = (a: string) =>
  sql.raw(
    `coalesce(${a}.transition->>'subjectId', ${a}.transition->>'entityId')`
  );
/** Order of record: stamped at the move (W4), else the row's own time. */
const RECORDED = (a: string) =>
  sql.raw(
    `coalesce((${a}.transition->>'recordedAt')::timestamptz, ${a}.created_at)`
  );

function filterSql(filter: HoldFilter): SQL {
  if ("subjects" in filter) {
    const ids = [...new Set(filter.subjects.map((s) => s.subjectId))];
    return sql`${SUBJECT_ID("o")} IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `
    )})`;
  }
  if ("resumeDueBy" in filter) {
    return sql`(o.transition->'hold'->'until'->>'date')::timestamptz <= ${filter.resumeDueBy.toISOString()}::timestamptz`;
  }
  if ("reviewDueBy" in filter) {
    // Compared as TEXT in the one stamp shape `recordHold` writes: a stored
    // value in any other shape is skipped, never cast (a bad row must not
    // fail the watcher's whole read).
    return sql`(o.transition->'hold'->>'reviewBy') ~ ${ISO_STAMP_PATTERN} AND (o.transition->'hold'->>'reviewBy') <= ${filter.reviewDueBy.toISOString()}`;
  }
  if ("current" in filter) return sql`TRUE`;
  if ("awaitingDevFacts" in filter) {
    return sql`(o.transition->'hold'->'until'->>'moves') ~ '^(pr|main|job):'`;
  }
  return sql`o.transition->'hold'->'until'->>'moves' = ${`${filter.awaiting.subjectType}:${filter.awaiting.subjectId}`}`;
}

interface HeldTransition {
  transitionId: string;
  subjectType: TransitionSubjectType;
  subjectId: string;
  facetId?: string | null;
  role?: string | null;
  to: string;
  userId: string;
  workspaceId: string | null;
  hold: RecordedHold;
}

/** The current holds matching `filter` (see the header). */
export async function listHolds(
  db: Db | Tx,
  filter: HoldFilter,
  now: Date = new Date()
): Promise<CurrentHold[]> {
  if ("subjects" in filter && filter.subjects.length === 0) return [];
  const res = await db.execute(sql`
    SELECT o.transition AS "transition"
      FROM ${lifecycleTransitionOutbox} o
     WHERE o.transition->>'category' = 'paused'
       AND jsonb_typeof(o.transition->'hold') = 'object'
       AND ${filterSql(filter)}
       AND NOT EXISTS (
         SELECT 1 FROM ${lifecycleTransitionOutbox} n
          WHERE ${SUBJECT_ID("n")} = ${SUBJECT_ID("o")}
            AND ${SUBJECT_TYPE("n")} = ${SUBJECT_TYPE("o")}
            AND (n.transition->>'facetId') IS NOT DISTINCT FROM (o.transition->>'facetId')
            -- latest by record time, then row time, then id: one winner, always
            AND (${RECORDED("n")}, n.created_at, n.transition_id)
              > (${RECORDED("o")}, o.created_at, o.transition_id)
       )`);
  // postgres.js returns the rows; the PGlite driver (tests) wraps them.
  const raw = (
    Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ transition: HeldTransition | string }>;
  let held = raw.map((r) =>
    typeof r.transition === "string"
      ? (JSON.parse(r.transition) as HeldTransition)
      : r.transition
  );
  if ("subjects" in filter) {
    const wanted = new Set(
      filter.subjects.map(
        (s) => `${s.subjectType}:${s.subjectId}:${s.facetId ?? ""}`
      )
    );
    held = held.filter((t) =>
      wanted.has(`${t.subjectType}:${t.subjectId}:${t.facetId ?? ""}`)
    );
  }
  const standing = await statusesNow(db, held);
  const nowMs = now.getTime();
  return held
    .filter((t) => standing.get(keyOf(t)) === t.to)
    .map((t) => {
      const until = t.hold.until;
      return {
        subjectType: t.subjectType,
        subjectId: t.subjectId,
        facetId: t.facetId ?? null,
        role: t.role ?? null,
        status: t.to,
        hold: t.hold,
        transitionId: t.transitionId,
        userId: t.userId,
        workspaceId: t.workspaceId ?? null,
        resumeDue:
          until != null && "date" in until && Date.parse(until.date) <= nowMs,
        reviewDue:
          t.hold.reviewBy != null && Date.parse(t.hold.reviewBy) <= nowMs,
      };
    });
}

function keyOf(t: {
  subjectType: string;
  subjectId: string;
  facetId?: string | null;
}) {
  return `${t.subjectType}:${t.facetId ?? t.subjectId}`;
}

/**
 * Where each held thing stands NOW, read from its own table — a hold is
 * current only while the thing still stands in the status its transition
 * moved it to.
 */
async function statusesNow(
  db: Db | Tx,
  held: readonly HeldTransition[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = (pick: (t: HeldTransition) => string | null) => [
    ...new Set(held.map(pick).filter((v): v is string => v != null)),
  ];
  const kinds = ids((t) =>
    t.subjectType === "entity" && !t.facetId ? t.subjectId : null
  );
  const facets = ids((t) =>
    t.subjectType === "entity" ? (t.facetId ?? null) : null
  );
  const tracks = ids((t) => (t.subjectType === "track" ? t.subjectId : null));
  const sessions = ids((t) =>
    t.subjectType === "focus_session" ? t.subjectId : null
  );
  if (kinds.length) {
    for (const r of await db
      .select({ id: entities.id, status: entities.status })
      .from(entities)
      .where(and(inArray(entities.id, kinds), isNull(entities.deletedAt))))
      out.set(`entity:${r.id}`, r.status);
  }
  if (facets.length) {
    for (const r of await db
      .select({ id: entityFacets.id, status: entityFacets.status })
      .from(entityFacets)
      .where(
        and(inArray(entityFacets.id, facets), isNull(entityFacets.deletedAt))
      ))
      out.set(`entity:${r.id}`, r.status);
  }
  if (tracks.length) {
    for (const r of await db
      .select({ id: projectTracks.id, status: projectTracks.status })
      .from(projectTracks)
      .where(inArray(projectTracks.id, tracks)))
      out.set(`track:${r.id}`, r.status);
  }
  if (sessions.length) {
    for (const r of await db
      .select({ id: focusSessions.id, status: focusSessions.status })
      .from(focusSessions)
      .where(inArray(focusSessions.id, sessions)))
      out.set(`focus_session:${r.id}`, r.status);
  }
  return out;
}
