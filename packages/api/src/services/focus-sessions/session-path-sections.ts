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
} from "@synap/database";
import {
  buildObjectActionTitle,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { ExpectedOutput } from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import {
  deriveNextMove,
  isOpenAgentSlot,
  PACKET_TOP_N,
  type ContinuationNextMove,
  type PacketChildItem,
  type PacketProposalItem,
  type PacketSection,
  type PacketSlotItem,
} from "./continuation-packet.js";
import { projectOwedSlots, type OwedSlot } from "./owed-outputs.js";
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
   * them, from the SAME reads as `nextMove` so the mark, the rule and the next
   * move cannot disagree. `pendingDecisions: null` means the proposals read
   * FAILED — not zero.
   */
  unitFacts: SessionUnitCounts;
}

/**
 * A row's `unitFacts`. Structurally a `NeedsYouFacts` (`needs-you.ts`): feed it
 * to `sessionNeedsYou` / `tallyNeedsYou` unchanged.
 */
export interface SessionUnitCounts {
  owedFromYou: number;
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

function owedItem(slot: OwedSlot): PacketSlotItem {
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
 * Attach the continuation sections to a page of session rows. Four batched
 * reads for the page (proposals, outbound edges, inbound edges, outputs),
 * each settled on its own so one failure marks one section `unavailable`.
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
  }
): Promise<Array<R & SessionPathSections>> {
  if (rows.length === 0) return [];
  const database = opts.database ?? db;
  const ctx = opts.logContext ?? {};
  const ids = rows.map((r) => r.id);

  const [proposalsBy, outbound, inbound, outputsWith] = await Promise.all([
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
  ]);

  /** A section from a settled page-wide map, or that read's `unavailable`. */
  const pick = <T>(
    s: Settled<Map<string, PacketSection<T>>>,
    key: string
  ): PacketSection<T> =>
    s.status === "ok" ? (s.value.get(key) ?? emptySection<T>()) : s;
  const countOf = (s: PacketSection<unknown>): PathCount =>
    s.status === "ok" ? { status: "ok", total: s.total } : s;

  return rows.map((row) => {
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

    const nextMove = deriveNextMove({
      status: row.status,
      owedSlots,
      pendingProposals,
      aiCanDo,
      blockedBy,
      expectedOutputs: all,
      outputs,
      children,
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
        // Projected from the row itself — there is no read here to fail.
        owedFromYou: owedList.length,
        pendingDecisions:
          pendingProposals.status === "ok" ? pendingProposals.total : null,
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
