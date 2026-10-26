/**
 * WHAT COUNTS as speaking to someone (CRM recall C-W2, founder answers R3/R4,
 * 2026-10-26), read from the graph — ONE rule for the reactor, the daily sweep
 * and the operator recompute, so the three can never disagree.
 *
 * Counts (all DATED, all in the past):
 *   - a meeting that happened: an `attended_by` edge from a dated record
 *     (an event's `startDate`) → its attendee;
 *   - `met_at`: a person → the dated record they met at;
 *   - a dated conversation: a `discussed_with` edge (undirected) between a
 *     dated record (a note carrying an explicit `date`) and the other end;
 *   - sent outreach: an `outreach-touch` whose status says it went out →
 *     its `sent_to` person, dated by `sentDate`, else by its move to `sent`;
 *     a move to `replied` is a later interaction of its own.
 * Never: mentions, edits, drafts, a bounced touch, an undated record (an
 * imported note's `createdAt` is the import day, not the day you talked), a
 * meeting that has not happened yet (the sweep counts it once it has).
 * Gmail threads and the company rollup are C-W3.
 */
import {
  and,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import { entities } from "../../schema/entities.js";
import { events } from "../../schema/events.js";
import { relations } from "../../schema/relations.js";
import {
  LAST_INTERACTION_PROPERTY,
  noteInteraction,
} from "./note-interaction.js";
import {
  ATTENDED_BY,
  DISCUSSED_WITH,
  INTERACTION_RELATION_TYPES,
  MET_AT,
  OUTREACH_INTERACTION_MOVES,
  OUTREACH_TOUCH_KIND,
  OUTREACH_WENT_OUT_STATUSES,
  SENT_TO,
} from "./interaction-kinds.js";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * When a record happened: `startDate` (an event; a meeting is the hat an event
 * wears), else `date` (a dated note, a life event). First parseable wins.
 */
export const RECORD_DATE_KEYS = ["startDate", "date"] as const;

const TRANSITION_EVENT_TYPE = "entity.transition.completed";

export type InteractionSource = "meeting" | "conversation" | "outreach";

export interface InteractionEvidence {
  entityId: string;
  at: Date;
  source: InteractionSource;
}

/** Which edges to read. */
export type EvidenceScope =
  /** These edges (the reactor on an edge's creation). */
  | { relationIds: readonly string[] }
  /** The `sent_to` edges of these touches (the reactor on a touch's move). */
  | { touchIds: readonly string[] }
  /** Edges whose record date falls on or after this day (the daily sweep). */
  | { recordDatesFrom: Date }
  /** Every interaction edge in the pod (the operator recompute). */
  | { all: true };

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function recordDate(
  props: { startDate: string | null; date: string | null },
  now: Date
): Date | null {
  for (const key of RECORD_DATE_KEYS) {
    const d = parseDate(props[key]);
    if (d) return now ? d : null; // NEGCTL: future meetings count
  }
  return null;
}

/** The latest of the given dates that is not in the future. */
function latestPast(dates: (Date | null)[], now: Date): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (!d || d.getTime() > now.getTime()) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

/** `YYYY-MM-DD`, comparable as text with an ISO date property's prefix. */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function collectInteractionEvidence(
  db: Db,
  scope: EvidenceScope,
  now: Date = new Date()
): Promise<InteractionEvidence[]> {
  const s = alias(entities, "s");
  const t = alias(entities, "t");
  // `properties->>key` of either endpoint (the two aliases differ in type).
  const prop = (properties: SQLWrapper, key: string) =>
    sql<string | null>`${properties}->>${key}`;

  const where: SQL[] = [
    inArray(relations.type, [...INTERACTION_RELATION_TYPES]),
    sql`${s.deletedAt} IS NULL`,
    sql`${t.deletedAt} IS NULL`,
  ];
  if ("relationIds" in scope) {
    if (scope.relationIds.length === 0) return [];
    where.push(inArray(relations.id, [...scope.relationIds]));
  } else if ("touchIds" in scope) {
    if (scope.touchIds.length === 0) return [];
    where.push(
      eq(relations.type, SENT_TO),
      inArray(relations.sourceEntityId, [...scope.touchIds])
    );
  } else if ("recordDatesFrom" in scope) {
    // A text prefilter on the ISO day (an exact parse follows in TS): a
    // malformed date string never reaches a `::timestamptz` cast.
    const day = isoDay(scope.recordDatesFrom);
    const dated = (properties: SQLWrapper) =>
      [...RECORD_DATE_KEYS, "sentDate"].map(
        (k) => sql`left(${prop(properties, k)}, 10) >= ${day}`
      );
    where.push(or(...dated(s.properties), ...dated(t.properties))!);
  }

  const rows = await db
    .select({
      type: relations.type,
      sourceId: s.id,
      sourceKind: s.type,
      sourceStatus: s.status,
      sourceStartDate: prop(s.properties, "startDate"),
      sourceDate: prop(s.properties, "date"),
      sourceSentDate: prop(s.properties, "sentDate"),
      targetId: t.id,
      targetStartDate: prop(t.properties, "startDate"),
      targetDate: prop(t.properties, "date"),
    })
    .from(relations)
    .innerJoin(s, eq(s.id, relations.sourceEntityId))
    .innerJoin(t, eq(t.id, relations.targetEntityId))
    .where(and(...where));

  // A touch's moves to `sent` / `replied`, from the transition log (the move
  // time, when no `sentDate` was recorded; a reply has no date of its own).
  const touchIds = [
    ...new Set(
      rows
        .filter(
          (r) => r.type === SENT_TO && r.sourceKind === OUTREACH_TOUCH_KIND
        )
        .map((r) => r.sourceId)
    ),
  ];
  const moves = new Map<string, { sent?: Date; replied?: Date }>();
  if (touchIds.length > 0) {
    const moveRows = await db
      .select({
        touchId: events.subjectId,
        to: sql<string>`${events.data}->>'to'`,
        at: sql<Date | string>`max(${events.timestamp})`,
      })
      .from(events)
      .where(
        and(
          eq(events.type, TRANSITION_EVENT_TYPE),
          inArray(events.subjectId, touchIds),
          inArray(sql`${events.data}->>'to'`, [...OUTREACH_INTERACTION_MOVES]),
          // The KIND's lifecycle, never a role's status on the same row.
          sql`${events.data}->>'role' IS NULL`
        )
      )
      .groupBy(events.subjectId, sql`${events.data}->>'to'`);
    for (const m of moveRows) {
      const at = m.at instanceof Date ? m.at : parseDate(m.at);
      if (!at) continue;
      const entry = moves.get(m.touchId) ?? {};
      entry[m.to as "sent" | "replied"] = at;
      moves.set(m.touchId, entry);
    }
  }

  const out: InteractionEvidence[] = [];
  const push = (
    entityId: string,
    at: Date | null,
    source: InteractionSource
  ) => {
    if (at) out.push({ entityId, at, source });
  };
  for (const r of rows) {
    const sourceAt = recordDate(
      { startDate: r.sourceStartDate, date: r.sourceDate },
      now
    );
    const targetAt = recordDate(
      { startDate: r.targetStartDate, date: r.targetDate },
      now
    );
    switch (r.type) {
      case ATTENDED_BY:
        push(r.targetId, sourceAt, "meeting");
        break;
      case MET_AT:
        push(r.sourceId, targetAt, "meeting");
        break;
      case DISCUSSED_WITH:
        push(r.targetId, sourceAt, "conversation");
        push(r.sourceId, targetAt, "conversation");
        break;
      case SENT_TO: {
        if (r.sourceKind !== OUTREACH_TOUCH_KIND) break;
        if (
          !(OUTREACH_WENT_OUT_STATUSES as readonly string[]).includes(
            r.sourceStatus ?? ""
          )
        )
          break;
        const m = moves.get(r.sourceId);
        const sentAt = parseDate(r.sourceSentDate) ?? m?.sent ?? null;
        push(
          r.targetId,
          latestPast([sentAt, m?.replied ?? null], now),
          "outreach"
        );
        break;
      }
    }
  }
  return out;
}

/** The latest evidence per entity. */
function latestPerEntity(
  evidence: readonly InteractionEvidence[]
): Map<string, InteractionEvidence> {
  const best = new Map<string, InteractionEvidence>();
  for (const e of evidence) {
    const cur = best.get(e.entityId);
    if (!cur || e.at.getTime() > cur.at.getTime()) best.set(e.entityId, e);
  }
  return best;
}

/** Group ids by one timestamp, so each distinct value is one statement. */
function byTimestamp(entries: Iterable<[string, Date]>): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const [id, at] of entries) {
    const k = at.getTime();
    groups.set(k, [...(groups.get(k) ?? []), id]);
  }
  return groups;
}

/** Collect the evidence of `scope` and move each entity forward through the door. */
export async function noteInteractionsFrom(
  db: Db,
  scope: EvidenceScope,
  now: Date = new Date()
): Promise<{ evidence: number; moved: string[] }> {
  const evidence = await collectInteractionEvidence(db, scope, now);
  const latest = latestPerEntity(evidence);
  const moved: string[] = [];
  for (const [ms, ids] of byTimestamp(
    [...latest].map(([id, e]) => [id, e.at] as [string, Date])
  )) {
    const r = await noteInteraction(db, {
      entityIds: ids,
      at: new Date(ms),
      now,
    });
    moved.push(...r.moved);
  }
  return { evidence: evidence.length, moved };
}

export interface RebuildLastInteractionResult {
  /** Entities whose value the graph sets (new or different). */
  set: number;
  /** Of those, how many went BACKWARDS (repair: the evidence is gone). */
  lowered: number;
  /** Entities with a value the graph no longer supports → NULL. */
  cleared: number;
  unchanged: number;
  applied: boolean;
}

/**
 * The operator repair (script `recompute-last-interaction`): rebuild the
 * column and its projection EXACTLY from the graph — the one writer allowed to
 * lower the value (a deleted event, a removed attendee). Dry run unless
 * `apply`. An entity with no value and no evidence is never touched.
 */
export async function rebuildLastInteraction(
  db: Db,
  opts: { apply: boolean; now?: Date }
): Promise<RebuildLastInteractionResult> {
  const now = opts.now ?? new Date();
  const latest = latestPerEntity(
    await collectInteractionEvidence(db, { all: true }, now)
  );
  const current = await db
    .select({ id: entities.id, at: entities.lastInteractionAt })
    .from(entities)
    .where(
      and(
        isNotNull(entities.lastInteractionAt),
        sql`${entities.deletedAt} IS NULL`
      )
    );
  const currentById = new Map(current.map((r) => [r.id, r.at]));

  const toSet: [string, Date][] = [];
  let lowered = 0;
  let unchanged = 0;
  for (const [id, e] of latest) {
    const cur = currentById.get(id) ?? null;
    if (cur && cur.getTime() === e.at.getTime()) {
      unchanged++;
      continue;
    }
    if (cur && cur.getTime() > e.at.getTime()) lowered++;
    toSet.push([id, e.at]);
  }
  const toClear = current.filter((r) => !latest.has(r.id)).map((r) => r.id);

  if (opts.apply) {
    for (const [ms, ids] of byTimestamp(toSet)) {
      const at = new Date(ms);
      await db
        .update(entities)
        .set({
          lastInteractionAt: at,
          properties: sql`${entities.properties} || jsonb_build_object(${LAST_INTERACTION_PROPERTY}::text, ${at.toISOString()}::text)`,
        })
        .where(inArray(entities.id, ids));
    }
    if (toClear.length > 0) {
      await db
        .update(entities)
        .set({
          lastInteractionAt: null,
          properties: sql`${entities.properties} - ${LAST_INTERACTION_PROPERTY}::text`,
        })
        .where(inArray(entities.id, toClear));
    }
  }
  return {
    set: toSet.length,
    lowered,
    cleared: toClear.length,
    unchanged,
    applied: opts.apply,
  };
}
