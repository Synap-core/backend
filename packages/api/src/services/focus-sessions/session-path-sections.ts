/**
 * SESSION PATH SECTIONS — the per-row continuation sections (blocked-by,
 * unblocks, lineage counts, outputs, next move) for a whole PAGE of sessions,
 * in a fixed number of queries whatever the page size.
 *
 * Lifted out of `projects/project-path.ts` (2026-09-22) when the work map
 * needed the same `nextMove` on `focusSessions.list` rows. Two readers of the
 * one rule must not each gather its inputs their own way — that is how a
 * session reads "waiting on you" on the path and "AI's move" on the map.
 *
 * ── ONE DERIVATION, BATCHED INPUTS ──────────────────────────────────────────
 * `nextMove` is THE packet rule (`deriveNextMove`), called per row. Only its
 * INPUTS are gathered differently: the continuation packet reads them for one
 * session; here the same inputs are read for the whole page. Per-session top-N
 * is cut in SQL with a window (`row_number() over (partition by session …)`),
 * with the orderings the packet readers use — oldest pending proposal first,
 * OPEN linked sessions first — because the rule only sees the top items.
 *
 * Outputs: the rule reads only `outputs.total > 0`, so this read asks only for
 * PRESENCE (any artifact row or `produced` edge — every `listSessionOutputs`
 * output comes from one of those two ledgers). It is exposed as `hasOutputs`,
 * never as a count.
 *
 * ── THE COUNTS ARE THE NEEDS-YOU HEADLINE ─────────────────────────────────
 * `unitFacts` counts what NEEDS the person by THE rule (decision E,
 * `@synap-core/types/needs-you/rule`): owed asks the rule classes
 * `needs_you`, and pending proposals it classes `needs_you`. A Stopped,
 * Working, Review later or system ask, and a change to review, never make a
 * card, a pill or the graph say "Needs you" (rv-ui-ux U1): the same classes
 * `signals.count` counts, so the two numbers are one. The section items
 * (`owedSlots`, `pendingProposals`) still list everything owed: they are
 * what the next move reads.
 *
 * ── A FAILED READ IS NOT AN EMPTY ONE ───────────────────────────────────────
 * A batched section that fails marks that section `unavailable` on every row
 * (the rule then answers `unknown`), never `[]`.
 */

import {
  db,
  focusSessions,
  proposals,
  links,
  artifacts,
  and,
  eq,
  asc,
  inArray,
  lte,
  drizzleSql,
  ProposalStatus,
  sessionLastAgentActivitySql,
  sessionLastAgentWorkSql,
  sessionTurnInFlightSql,
  listHolds,
} from "@synap/database";
import {
  buildObjectActionTitle,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import type { SessionReader } from "../../access/session-visibility.js";
import {
  resolveSessionTitle,
  sessionStatusCategory,
  type SessionVerdict,
} from "@synap-core/types/focus-sessions";
import type { ExpectedOutput } from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import {
  deriveNextMove,
  isOpenAgentSlot,
  PACKET_TOP_N,
  type ContinuationNextMove,
  type NextMoveBlockers,
  type NextMoveCriteria,
  type NextMoveInbox,
  type PacketChildItem,
  type PacketProposalItem,
  type PacketSection,
  type PacketSlotFacts,
  withPullRequestStatesFor,
  workUnitsSection,
} from "./continuation-packet.js";
import { projectOwedSlots, type OwedSlot } from "./owed-outputs.js";
import { attachSessionVerdicts } from "./evaluations/record.js";
import { isNeedsYou } from "@synap-core/types/needs-you/rule";
import { owedSlotClassOf } from "../signals/needs-you-union.js";
import { classifyPendingProposals } from "../proposals/proposal-needs-you.js";
import { readDependencyFacts } from "../links/dependency-links.js";
import { readOpenInboxes } from "./session-inbox.js";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { projectTriage } from "./triage.js";
import { extractProposalName } from "../proposals/fingerprint.js";

const logger = createLogger({ module: "session-path-sections" });

type Unavailable = { status: "unavailable"; reason: string };

export type PathCount = { status: "ok"; total: number } | Unavailable;

export type Settled<T> = { status: "ok"; value: T } | Unavailable;

/** What a row must carry for its sections to be derived. */
export interface PathSourceRow {
  id: string;
  goal: string;
  status: string;
  workspaceId: string | null;
  projectId: string | null;
  expectedOutputs: unknown;
  /**
   * REQUIRED (not optional) — `unitFacts.draft` is derived from them through
   * `projectTriage`, the one triage rule. Optional here would let a narrowed
   * select silently read every draft as accepted work.
   */
  origin: string | null;
  metadata: unknown;
  /**
   * REQUIRED, like `origin`: the next move's rung 6b reads the session's
   * verdict (`attachSessionVerdicts`, owner-floored on `userId`). Optional
   * here would let a narrowed select read every row as declaring no criteria
   * — "ready to close" with its contract unmet.
   */
  userId: string;
  criteria: unknown;
  /**
   * THE verdict, when the caller already attached it (`focusSessions.list`
   * rows come through `attachSessionVerdicts`): reused, never read twice.
   * Absent on a row with criteria ⇒ read here.
   */
  verdict?: Pick<SessionVerdict, "state" | "requiredUnmet">;
}

/** The sections every path/map row carries. */
export interface SessionPathSections {
  /** `this --blocked_by--> other`, OPEN ones first. */
  blockedBy: PacketSection<PacketChildItem>;
  /** `other --blocked_by--> this`, OPEN ones first. */
  unblocks: PacketSection<PacketChildItem>;
  parentCount: PathCount;
  childrenCount: PathCount;
  hasOutputs: { status: "ok"; value: boolean } | Unavailable;
  nextMove: ContinuationNextMove;
  /**
   * The facts a state mark and THE needs-you rule read, shaped exactly as
   * `SessionUnitFacts` and `NeedsYouFacts` (`@synap-core/types/units`) read
   * them: the needs-you HEADLINE only (see the header). `null` means that
   * read FAILED — not zero.
   */
  unitFacts: SessionUnitCounts;
}

/**
 * A row's `unitFacts`. Structurally a `NeedsYouFacts` (`needs-you.ts`): feed it
 * to `sessionNeedsYou` / `tallyNeedsYou` unchanged.
 */
export interface SessionUnitCounts {
  /** Owed asks the needs-you rule classes `needs_you`. */
  owedFromYou: number | null;
  /** Pending proposals the needs-you rule classes `needs_you`. */
  pendingDecisions: number | null;
  /**
   * Finished and awaiting the person's review / close — this row's
   * `nextMove.kind === "ready_to_close"`, projected so no reader re-derives it.
   */
  awaitingReview: boolean;
  /** An agent/automation draft still in triage (`projectTriage(row).pending`). */
  draft: boolean;
}

/**
 * Log the cause; hand consumers only a fixed sentence (never driver text).
 * `context` names the caller's anchor (a project, the map) in the log line.
 */
export function settle<T>(
  context: Record<string, unknown>,
  part: string,
  reason: string,
  read: () => Promise<T>
): Promise<Settled<T>> {
  return read().then(
    (value) => ({ status: "ok" as const, value }),
    (err: unknown) => {
      logger.warn(
        { err, ...context, section: part },
        "session path sections: section read failed"
      );
      return { status: "unavailable" as const, reason };
    }
  );
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

function slotsOf(row: { expectedOutputs: unknown }): ExpectedOutput[] {
  return Array.isArray(row.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[]).filter(
        (s) => !!s && typeof s === "object"
      )
    : [];
}

function section<T>(all: T[]): PacketSection<T> {
  return { status: "ok", total: all.length, items: all.slice(0, PACKET_TOP_N) };
}

const emptySection = <T>(): PacketSection<T> => ({
  status: "ok",
  total: 0,
  items: [],
});

function owedItem(slot: OwedSlot): PacketSlotFacts {
  return {
    label: slot.label,
    kind: slot.kind,
    ...(slot.blockedReason !== undefined
      ? { blockedReason: slot.blockedReason }
      : {}),
    ...(slot.why !== undefined ? { why: slot.why } : {}),
    owedSince: slot.owedSince,
  };
}

/** Group window-ranked rows (already cut to PACKET_TOP_N) into sections. */
function groupSections<R extends { total: number }, T>(
  rows: R[],
  keyOf: (r: R) => string,
  itemOf: (r: R) => T
): Map<string, PacketSection<T>> {
  const out = new Map<string, { status: "ok"; total: number; items: T[] }>();
  for (const r of rows) {
    const key = keyOf(r);
    const s = out.get(key) ?? {
      status: "ok",
      total: Number(r.total),
      items: [],
    };
    s.items.push(itemOf(r));
    out.set(key, s);
  }
  return out;
}

/**
 * Session-to-session edges (`blocked_by`, `spawned_from`) for the whole page in
 * ONE query. `anchor` is the page session, the joined row the OTHER end,
 * owner-floored like the packet's readers. `outbound` reads
 * `anchor --type--> other`; `inbound` reads `other --type--> anchor`.
 */
async function readEdges(
  database: typeof db,
  userId: string,
  ids: string[],
  direction: "outbound" | "inbound"
): Promise<Map<string, PacketSection<PacketChildItem>>> {
  const anchor = direction === "outbound" ? links.fromId : links.toId;
  const other = direction === "outbound" ? links.toId : links.fromId;
  // The packet readers' orderings, mirrored (they are module-private there).
  // Outbound (blockers, parent): OPEN first. Inbound (children, unblocks): OPEN,
  // then CLOSED, then the rest — a closed child is the rule's evidence of work
  // and must not hide behind PACKET_TOP_N cancelled ones. The seam test pins
  // both against the real packet.
  const open = inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]);
  const statusOrder =
    direction === "inbound"
      ? drizzleSql`${open} desc, ${eq(focusSessions.status, "closed")} desc`
      : drizzleSql`${open} desc`;
  const ranked = database
    .select({
      anchor: drizzleSql<string>`${anchor}`.as("anchor"),
      linkType: links.linkType,
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      rn: drizzleSql<number>`row_number() over (partition by ${anchor}, ${links.linkType} order by ${statusOrder}, ${focusSessions.createdAt} asc)`.as(
        "rn"
      ),
      total:
        drizzleSql<number>`count(*) over (partition by ${anchor}, ${links.linkType})`.as(
          "total"
        ),
    })
    .from(links)
    .innerJoin(focusSessions, eq(drizzleSql`${focusSessions.id}::text`, other))
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        inArray(links.linkType, ["blocked_by", "spawned_from"]),
        inArray(anchor, ids),
        eq(focusSessions.userId, userId)
      )
    )
    .as("ranked");
  const rows = await database
    .select()
    .from(ranked)
    .where(lte(ranked.rn, PACKET_TOP_N))
    .orderBy(asc(ranked.anchor), asc(ranked.linkType), asc(ranked.rn));
  return groupSections(
    rows,
    (r) => `${r.anchor}|${r.linkType}`,
    (r) => ({
      id: r.id,
      title: resolveSessionTitle(r),
      status: r.status,
      statusLabel: resolveStatusLabel(r.status),
    })
  );
}

/** Pending proposals for the whole page, the oldest PACKET_TOP_N per session. */
async function readPendingProposals(
  database: typeof db,
  ids: string[]
): Promise<Map<string, PacketSection<PacketProposalItem>>> {
  const ranked = database
    .select({
      sessionId: proposals.sessionId,
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      data: proposals.data,
      createdAt: proposals.createdAt,
      rn: drizzleSql<number>`row_number() over (partition by ${proposals.sessionId} order by ${proposals.createdAt} asc)`.as(
        "rn"
      ),
      total:
        drizzleSql<number>`count(*) over (partition by ${proposals.sessionId})`.as(
          "total"
        ),
    })
    .from(proposals)
    .where(
      and(
        inArray(proposals.sessionId, ids),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .as("ranked");
  const rows = await database
    .select()
    .from(ranked)
    .where(lte(ranked.rn, PACKET_TOP_N))
    .orderBy(asc(ranked.sessionId), asc(ranked.rn));
  return groupSections(
    rows,
    (r) => String(r.sessionId),
    (r) => ({
      id: r.id,
      title: buildObjectActionTitle({
        action: r.proposalType,
        objectKind: r.targetType,
        objectName: extractProposalName(r.data) ?? null,
        mood: "imperative",
      }),
      proposalType: r.proposalType,
      createdAt: iso(r.createdAt),
    })
  );
}

/** Per session: how many owed asks and pending proposals NEED the person. */
interface PageNeedsYou {
  owed: Map<string, number>;
  decisions: Map<string, number>;
}

/**
 * THE needs-you rule over the page (decision E): the rule's session facts,
 * measured by the SQL twin's own fragments (the needs-you reader's measure),
 * classify each row's owed slots; `classifyPendingProposals` (the groups
 * door's) classifies its pending proposals. Two reads plus the proposal
 * classification's own; a failure THROWS, so `settle` marks the counts
 * unavailable rather than zero.
 */
async function readPageNeedsYou<R extends PathSourceRow>(
  database: typeof db,
  userId: string,
  rows: readonly R[],
  now: Date
): Promise<PageNeedsYou> {
  const ids = rows.map((r) => r.id);
  const [facts, pending] = await Promise.all([
    database
      .select({
        id: focusSessions.id,
        startedAt: focusSessions.startedAt,
        turnInFlight: drizzleSql<boolean>`${sessionTurnInFlightSql("focus_sessions")}`,
        lastAgentActivityAt: drizzleSql<
          Date | string | null
        >`${sessionLastAgentActivitySql("focus_sessions")}`,
        lastAgentWorkAt: drizzleSql<
          Date | string | null
        >`${sessionLastAgentWorkSql("focus_sessions")}`,
      })
      .from(focusSessions)
      .where(inArray(focusSessions.id, ids)),
    database
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        status: proposals.status,
        sessionId: proposals.sessionId,
        data: proposals.data,
        createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.sessionId, ids),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      ),
  ]);
  const factsOf = new Map(facts.map((f) => [f.id, f]));
  const owed = new Map<string, number>();
  for (const row of rows) {
    const f = factsOf.get(row.id);
    const slots = projectOwedSlots(
      {
        id: row.id,
        goal: row.goal,
        status: row.status,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        expectedOutputs: row.expectedOutputs,
        startedAt: f?.startedAt ?? null,
        turnInFlight: f?.turnInFlight === true,
        lastAgentActivityAt: f?.lastAgentActivityAt ?? null,
        lastAgentWorkAt: f?.lastAgentWorkAt ?? null,
      },
      now
    );
    owed.set(
      row.id,
      slots.filter((s) =>
        isNeedsYou({ needsYouClass: owedSlotClassOf(s, now) })
      ).length
    );
  }
  const classes = await classifyPendingProposals(pending, { userId }, now);
  const decisions = new Map<string, number>();
  for (const p of pending) {
    const cls = classes.get(p.id);
    if (!p.sessionId || !cls || !isNeedsYou({ needsYouClass: cls })) continue;
    decisions.set(p.sessionId, (decisions.get(p.sessionId) ?? 0) + 1);
  }
  return { owed, decisions };
}

/** Which page sessions produced anything, from both output ledgers. */
async function readOutputPresence(
  database: typeof db,
  ids: string[]
): Promise<Set<string>> {
  const [artifactRows, producedRows] = await Promise.all([
    database
      .selectDistinct({ sessionId: artifacts.sessionId })
      .from(artifacts)
      .where(inArray(artifacts.sessionId, ids)),
    database
      .selectDistinct({ sessionId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          inArray(links.fromId, ids),
          eq(links.linkType, "produced")
        )
      ),
  ]);
  return new Set(
    [...artifactRows, ...producedRows]
      .map((r) => r.sessionId)
      .filter((id): id is string => !!id)
  );
}

/**
 * Attach the continuation sections to a page of session rows. Six batched
 * reads for the page (proposals, outbound edges, inbound edges, outputs,
 * THE dependency rule's blockers for the next move — `readDependencyFacts`,
 * the read the packet's `readDependencyState` batches — and the open inboxes,
 * `readOpenInboxes`, the packet's own reader) — plus the needs-you headline
 * and THE criteria verdict (`attachSessionVerdicts`, the packet's
 * `loadSessionEvaluationSummary` batched) — each settled on its own so one
 * failure marks one section `unavailable`.
 *
 * The rows must already be owner-floored by the caller: this reads edges and
 * proposals BY the page's ids, and the page is the authorization.
 */
export async function attachPathSections<R extends PathSourceRow>(
  rows: readonly R[],
  opts: {
    userId: string;
    database?: typeof db;
    /** Names the caller in a failed-section log line. */
    logContext?: Record<string, unknown>;
    /** The clock the needs-you rule reads. Absent ⇒ now. */
    now?: Date;
    /** The caller's reader floor for the PR facts (`SessionReader`). */
    roster?: SessionReader["roster"];
    lens?: SessionReader["lens"];
  }
): Promise<Array<R & SessionPathSections>> {
  if (rows.length === 0) return [];
  const database = opts.database ?? db;
  const ctx = opts.logContext ?? {};
  const ids = rows.map((r) => r.id);

  const now = opts.now ?? new Date();
  const [
    proposalsBy,
    outbound,
    inbound,
    outputsWith,
    dependencies,
    inboxes,
    needsYou,
    verdicts,
    workUnits,
    holds,
  ] = await Promise.all([
    settle(
      ctx,
      "pendingProposals",
      "Pending proposals could not be read.",
      () => readPendingProposals(database, ids)
    ),
    settle(
      ctx,
      "outboundEdges",
      "The sessions these wait on could not be read.",
      () => readEdges(database, opts.userId, ids, "outbound")
    ),
    settle(
      ctx,
      "inboundEdges",
      "The sessions these unblock could not be read.",
      () => readEdges(database, opts.userId, ids, "inbound")
    ),
    settle(ctx, "outputs", "Session outputs could not be read.", () =>
      readOutputPresence(database, ids)
    ),
    settle(
      ctx,
      "dependencies",
      "Whether these sessions are blocked could not be read.",
      () =>
        readDependencyFacts(
          ids.map((id) => ({ kind: "session", id })),
          opts.userId
        )
    ),
    // The open inboxes (`message_waiting`) — the packet's own reader,
    // batched for the page.
    settle(
      ctx,
      "inbox",
      "The messages other sessions sent these could not be read.",
      () => readOpenInboxes(database, opts.userId, ids)
    ),
    settle(
      ctx,
      "needsYou",
      "What needs you in these sessions could not be read.",
      () => readPageNeedsYou(database, opts.userId, rows, now)
    ),
    // THE verdict per row (rung 6b of the next move) — the batch the list
    // door's `verdict` comes from. A row that already carries it is reused;
    // no query when no other row declares criteria.
    settle(
      ctx,
      "criteria",
      "Whether these sessions' criteria pass could not be read.",
      async () => {
        const read = await attachSessionVerdicts(
          rows.filter((r) => !r.verdict),
          database
        );
        return new Map(
          [...rows.filter((r) => r.verdict), ...read].map((r) => [
            r.id,
            r.verdict,
          ])
        );
      }
    ),
    // The page's pull requests with what the pod recorded (rung 3), in ONE
    // state read for every row — the packet's own rule and reader, uncapped:
    // the next move reads every PR, never the packet's top few. A failed
    // read marks each PR `unavailable` inside the section, never the page.
    withPullRequestStatesFor(
      rows.map((r) => workUnitsSection(slotsOf(r), { uncapped: true })),
      { userId: opts.userId, roster: opts.roster, lens: opts.lens },
      database
    ),
    // The current holds of the page's PAUSED sessions (rung 2c), one read.
    settle(
      ctx,
      "holds",
      "What these paused sessions wait on could not be read.",
      async () => {
        const paused = rows.filter(
          (r) => sessionStatusCategory(r.status) === "paused"
        );
        const current = paused.length
          ? await listHolds(database, {
              subjects: paused.map((r) => ({
                subjectType: "focus_session" as const,
                subjectId: r.id,
              })),
            })
          : [];
        return new Map(current.map((h) => [h.subjectId, h.hold]));
      }
    ),
  ]);

  /** A section from a settled page-wide map, or that read's `unavailable`. */
  const pick = <T>(
    s: Settled<Map<string, PacketSection<T>>>,
    key: string
  ): PacketSection<T> =>
    s.status === "ok" ? (s.value.get(key) ?? emptySection<T>()) : s;
  const countOf = (s: PacketSection<unknown>): PathCount =>
    s.status === "ok" ? { status: "ok", total: s.total } : s;

  return rows.map((row, rowIndex) => {
    const all = slotsOf(row);
    const owedList = projectOwedSlots({
      id: row.id,
      goal: row.goal,
      status: row.status,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      expectedOutputs: all,
    })
      .sort((a, b) =>
        a.owedSince < b.owedSince ? -1 : a.owedSince > b.owedSince ? 1 : 0
      )
      .map(owedItem);
    const owedSlots = section(owedList);
    const aiCanDo = section(
      all.filter(isOpenAgentSlot).map((s) => ({
        label: s.label,
        kind: s.kind,
        ...(s.delegatedTo ? { delegatedTo: s.delegatedTo } : {}),
      }))
    );
    const pendingProposals = pick(proposalsBy, row.id);
    const blockedBy = pick(outbound, `${row.id}|blocked_by`);
    const parent = pick(outbound, `${row.id}|spawned_from`);
    const unblocks = pick(inbound, `${row.id}|blocked_by`);
    const children = pick(inbound, `${row.id}|spawned_from`);
    const outputs: PacketSection<never> =
      outputsWith.status === "ok"
        ? {
            status: "ok",
            total: outputsWith.value.has(row.id) ? 1 : 0,
            items: [],
          }
        : outputsWith;

    const blockers: NextMoveBlockers =
      dependencies.status === "ok"
        ? {
            status: "ok",
            items: dependencies.value.get(`session:${row.id}`)?.blockers ?? [],
          }
        : dependencies;
    const inbox: NextMoveInbox =
      inboxes.status === "ok"
        ? (inboxes.value.get(row.id) ?? {
            status: "ok",
            total: 0,
            waiting: null,
          })
        : inboxes;
    // A row without a verdict declares no criteria (never "unknown").
    const criteria: NextMoveCriteria =
      verdicts.status === "ok"
        ? {
            status: "ok",
            verdict: verdicts.value.get(row.id) ?? {
              state: "none",
              requiredUnmet: 0,
            },
          }
        : verdicts;
    const nextMove = deriveNextMove({
      status: row.status,
      owedSlots,
      pendingProposals,
      aiCanDo,
      blockers,
      expectedOutputs: all,
      outputs,
      children,
      inbox,
      criteria,
      workUnits: workUnits[rowIndex]!,
      hold:
        holds.status === "ok"
          ? { status: "ok", hold: holds.value.get(row.id) ?? null }
          : holds,
    });
    return {
      ...row,
      blockedBy,
      unblocks,
      parentCount: countOf(parent),
      childrenCount: countOf(children),
      hasOutputs:
        outputsWith.status === "ok"
          ? { status: "ok", value: outputsWith.value.has(row.id) }
          : outputsWith,
      nextMove,
      unitFacts: {
        // The needs-you HEADLINE (see the header), never every owed slot.
        owedFromYou:
          needsYou.status === "ok"
            ? (needsYou.value.owed.get(row.id) ?? 0)
            : null,
        pendingDecisions:
          needsYou.status === "ok"
            ? (needsYou.value.decisions.get(row.id) ?? 0)
            : null,
        awaitingReview: nextMove.kind === "ready_to_close",
        draft: projectTriage(row).pending,
      },
    };
  });
}

/**
 * Only the `nextMove` (and its `unitFacts`) of each row — for a door whose rows already carry their
 * own edge projection under the same field names (`focusSessions.list`'s
 * `blockedBy` is an id list, not a section), so spreading every section would
 * overwrite it. Same reads, same rule; order is preserved.
 */
export async function attachNextMove<R extends PathSourceRow>(
  rows: readonly R[],
  opts: Parameters<typeof attachPathSections>[1]
): Promise<
  Array<R & { nextMove: ContinuationNextMove; unitFacts: SessionUnitCounts }>
> {
  const sectioned = await attachPathSections(rows, opts);
  return rows.map((row, i) => ({
    ...row,
    nextMove: sectioned[i]!.nextMove,
    unitFacts: sectioned[i]!.unitFacts,
  }));
}
