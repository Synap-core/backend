/**
 * CONTINUATION PACKET — the one unit a new AI (or a returning human) reads to
 * pick up a session: what the user must decide, what the AI can do, what is
 * blocked, what was produced, and the one next move.
 *
 * Built ONCE here and returned verbatim by every session read (tRPC
 * `focusSessions.get`, MCP `synap_get_session`, Hub `GET /focus-sessions/:id`).
 * A door that assembled its own copy would be the per-door drift this codebase
 * keeps paying for, so the doors only attach this function's result.
 *
 * COMPOSES EXISTING DOORS ONLY — it re-derives nothing:
 *   - owed slots      → `projectOwedSlots` (the owed-slot predicate's own
 *                        per-row projection; NOT `listOwedSlots`, which is a
 *                        pod-wide page and would under-report after filtering)
 *   - outputs         → `listSessionOutputs`
 *   - run manifest    → `readSessionRunManifest`
 *   - rerun           → `assessRerunAvailability`
 *   - proposal titles → `buildObjectActionTitle` + `extractProposalName`
 *
 * ── A FAILED READ IS NOT AN EMPTY ONE ──────────────────────────────────────
 * Each part that needs a query is a {@link PacketSection}: `ok` with a total and
 * the top items, or `unavailable` with a reason. Never `[]` on a failure — an
 * agent told "no pending proposals" when the read failed would close a session
 * with work still waiting. `nextMove` refuses to say "ready to close" while a
 * section it depends on is unavailable.
 *
 * Bounded: every list carries at most {@link PACKET_TOP_N} items plus its total.
 */

import {
  db,
  proposals,
  focusSessions,
  links,
  and,
  eq,
  asc,
  desc,
  inArray,
  count,
  drizzleSql,
  ProposalStatus,
} from "@synap/database";
import {
  buildObjectActionTitle,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { ExpectedOutput } from "@synap/playbooks";
import { projectOwedSlots, type OwedSlot } from "./owed-outputs.js";
import { listSessionOutputs } from "./session-outputs.js";
import {
  assessRerunAvailability,
  type RerunAvailability,
} from "./rerun-session.js";
import { readSessionRunManifest } from "../intake/record-session-run-manifest.js";
import { extractProposalName } from "../proposals/fingerprint.js";
import {
  isTerminalSessionStatus,
  OPEN_SESSION_STATUSES,
} from "./session-statuses.js";
import { projectSessionKind, type SessionKind } from "./session-kind.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "continuation-packet" });

/** Items per section. Totals are always exact; only the item list is cut. */
export const PACKET_TOP_N = 5;

export type PacketSection<T> =
  | { status: "ok"; total: number; items: T[] }
  | { status: "unavailable"; reason: string };

export interface PacketSlotItem {
  label: string;
  kind: string;
  blockedReason?: string;
  why?: string;
  owedSince?: string;
  /** Agent type the slot was delegated to, when it was. */
  delegatedTo?: string;
}

export interface PacketProposalItem {
  id: string;
  /** Imperative — what approving it WILL do. */
  title: string;
  proposalType: string;
  createdAt: string | null;
}

export interface PacketOutputItem {
  kind: string;
  refId: string;
  title: string;
  state?: "working" | "kept" | "swept";
  /** The declared deliverable this output satisfies, when one matched. */
  expectedLabel?: string;
}

/** A child session — `child --spawned_from--> this`. */
export interface PacketChildItem {
  id: string;
  /** Display name via `resolveSessionTitle` — title, else the goal's first line. */
  title: string;
  status: string;
  statusLabel: string;
}

export type NextMoveKind =
  | "owed_slot"
  | "pending_proposal"
  | "waiting_on_session"
  | "agent_slot"
  | "undeclared"
  | "ready_to_close"
  | "none"
  | "unknown";

export interface ContinuationNextMove {
  kind: NextMoveKind;
  /** Who acts: the person, the AI, or nobody. */
  actor: "user" | "ai" | "none";
  /** One line naming the move. */
  label: string;
  /** One line saying why this is the move. */
  reason: string;
  /** The proposal id, for `pending_proposal`. */
  proposalId?: string;
  /** The blocking session's id, for `waiting_on_session`. */
  sessionId?: string;
}

export interface ContinuationPacket {
  version: 1;
  session: {
    id: string;
    /** The stored name, `null` when untitled. */
    title: string | null;
    /** What to show: `resolveSessionTitle` — the ONE rule relay and browser share. */
    displayTitle: string;
    goal: string;
    status: string;
    statusLabel: string;
    kind: SessionKind;
    currentStage: string | null;
    progress: number | null;
  };
  userMustDecide: {
    owedSlots: PacketSection<PacketSlotItem>;
    pendingProposals: PacketSection<PacketProposalItem>;
  };
  aiCanDo: PacketSection<PacketSlotItem>;
  blockers: PacketSection<PacketSlotItem>;
  outputs: PacketSection<PacketOutputItem>;
  /**
   * Child sessions (detours and planned sub-sessions), oldest first. A parent
   * never auto-closes: it shows these, and closing stays explicit.
   */
  children: PacketSection<PacketChildItem>;
  /**
   * The session this one was spawned from (`this --spawned_from--> parent`).
   * `session: null` means NO parent; a failed read is `unavailable`, never
   * folded into "no parent".
   */
  parent:
    | { status: "ok"; session: PacketChildItem | null }
    | { status: "unavailable"; reason: string };
  /**
   * Sessions this one waits on (`this --blocked_by--> blocker`), closed ones
   * included — `status` says which still block. Distinct from `blockers`,
   * which is owed SLOTS, not session edges.
   */
  blockedBy: PacketSection<PacketChildItem>;
  /** `null` when the session recorded no run manifest. */
  run: {
    sourcesCount: number;
    engine: string;
    model: string | null;
    provider?: string | null;
    promptVersion: string;
    guidelines: Array<{ id: string; version: number }>;
    guidelineStatus?: "ok" | "unavailable";
  } | null;
  rerun: RerunAvailability;
  /** `null` when the session never recorded a completion/verification. */
  lastCompletion: {
    closedAt: string | null;
    summary?: string;
    unfinishedOutputs?: number;
  } | null;
  nextMove: ContinuationNextMove;
}

type SessionRow = typeof focusSessions.$inferSelect;

export interface ProjectContinuationPacketCtx {
  database?: typeof db;
  /** Owner floor for the outputs read. The row itself must already be owner-checked. */
  userId: string;
}

function slots(row: SessionRow): ExpectedOutput[] {
  return Array.isArray(row.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[]).filter(
        (s) => !!s && typeof s === "object"
      )
    : [];
}

function section<T>(all: T[]): PacketSection<T> {
  return { status: "ok", total: all.length, items: all.slice(0, PACKET_TOP_N) };
}

/**
 * A failed section read: the error is LOGGED here, and the packet carries only a
 * fixed sentence. The raw `err.message` can be driver/SQL text, and this packet
 * reaches tRPC, MCP `synap_get_session`, Hub GET and the IS prompt verbatim.
 */
function unavailable(
  sessionId: string,
  section: string,
  reason: string
): (err: unknown) => { status: "unavailable"; reason: string } {
  return (err) => {
    logger.warn(
      { err, sessionId, section },
      "continuation packet: section read failed"
    );
    return { status: "unavailable", reason };
  };
}

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

/**
 * Agent-owned slots nobody has claimed: not the human's, not done, not
 * retired, and no claim of delivery. Absent `owner` means `agent`
 * (`ExpectedOutput.owner` docblock).
 */
export function isOpenAgentSlot(slot: ExpectedOutput): boolean {
  return (
    slot.owner !== "human" &&
    slot.status !== "done" &&
    slot.retiredAt == null &&
    slot.claimedDone !== true
  );
}

async function readPendingProposals(
  database: typeof db,
  sessionId: string
): Promise<PacketSection<PacketProposalItem>> {
  const where = and(
    eq(proposals.sessionId, sessionId),
    eq(proposals.status, ProposalStatus.PENDING)
  );
  const [[totalRow], rows] = await Promise.all([
    database.select({ n: count() }).from(proposals).where(where),
    database
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        data: proposals.data,
        createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(where)
      // Oldest first: the one waiting longest is the next move.
      .orderBy(asc(proposals.createdAt))
      .limit(PACKET_TOP_N),
  ]);
  return {
    status: "ok",
    total: Number(totalRow?.n ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      title: buildObjectActionTitle({
        action: r.proposalType,
        objectKind: r.targetType,
        objectName: extractProposalName(r.data) ?? null,
        mood: "imperative",
      }),
      proposalType: r.proposalType,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    })),
  };
}

async function readOutputs(
  database: typeof db,
  userId: string,
  sessionId: string
): Promise<PacketSection<PacketOutputItem>> {
  const result = await listSessionOutputs({ db: database, userId, sessionId });
  if (!result) {
    return {
      status: "unavailable",
      reason: "session not found for outputs read",
    };
  }
  return section(
    result.outputs.map((o) => ({
      kind: o.kind,
      refId: o.refId,
      title: o.title,
      ...(o.state ? { state: o.state } : {}),
      ...(o.expected?.label ? { expectedLabel: o.expected.label } : {}),
    }))
  );
}

/**
 * `child --spawned_from--> sessionId`, owner-floored on the child. The producer
 * (`recordSessionSpawn`) already floors both ends on one user; the floor here is
 * so this read never depends on that staying true.
 */
async function readChildren(
  database: typeof db,
  userId: string,
  sessionId: string
): Promise<PacketSection<PacketChildItem>> {
  const join = eq(drizzleSql`${focusSessions.id}::text`, links.fromId);
  const where = and(
    eq(links.fromType, "session"),
    eq(links.toType, "session"),
    eq(links.linkType, "spawned_from"),
    eq(links.toId, sessionId),
    eq(focusSessions.userId, userId)
  );
  // Exact total + only the top items — never every child row sliced in JS.
  const [[totalRow], rows] = await Promise.all([
    database
      .select({ n: count() })
      .from(links)
      .innerJoin(focusSessions, join)
      .where(where),
    database
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        status: focusSessions.status,
      })
      .from(links)
      .innerJoin(focusSessions, join)
      .where(where)
      // Open first, for the same reason as `readOutboundSessions`: the rule
      // sees only the top items, and an open child must not fall past the cut.
      .orderBy(
        desc(inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])),
        asc(focusSessions.createdAt)
      )
      .limit(PACKET_TOP_N),
  ]);
  return {
    status: "ok",
    total: Number(totalRow?.n ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      title: resolveSessionTitle(r),
      status: r.status,
      statusLabel: resolveStatusLabel(r.status),
    })),
  };
}

/**
 * `sessionId --linkType--> other` — the OUTBOUND twin of `readChildren`, for
 * `spawned_from` (the parent) and `blocked_by` (the blockers). Owner-floored on
 * the linked session for the same reason: the producers already floor both
 * ends on one user, and this read must not depend on that staying true.
 *
 * OPEN sessions sort first. `deriveNextMove` sees only the top items, so a
 * still-open blocker created after {@link PACKET_TOP_N} closed ones would
 * otherwise fall past the cut and the session would read as unblocked.
 */
async function readOutboundSessions(
  database: typeof db,
  userId: string,
  sessionId: string,
  linkType: "spawned_from" | "blocked_by"
): Promise<PacketSection<PacketChildItem>> {
  const join = eq(drizzleSql`${focusSessions.id}::text`, links.toId);
  const where = and(
    eq(links.fromType, "session"),
    eq(links.toType, "session"),
    eq(links.linkType, linkType),
    eq(links.fromId, sessionId),
    eq(focusSessions.userId, userId)
  );
  const [[totalRow], rows] = await Promise.all([
    database
      .select({ n: count() })
      .from(links)
      .innerJoin(focusSessions, join)
      .where(where),
    database
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        status: focusSessions.status,
      })
      .from(links)
      .innerJoin(focusSessions, join)
      .where(where)
      .orderBy(
        desc(inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])),
        asc(focusSessions.createdAt)
      )
      .limit(PACKET_TOP_N),
  ]);
  return {
    status: "ok",
    total: Number(totalRow?.n ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      title: resolveSessionTitle(r),
      status: r.status,
      statusLabel: resolveStatusLabel(r.status),
    })),
  };
}

/** The parent, from the ONE outbound reader (a session has at most one). */
async function readParent(
  database: typeof db,
  userId: string,
  sessionId: string
): Promise<ContinuationPacket["parent"]> {
  const found = await readOutboundSessions(
    database,
    userId,
    sessionId,
    "spawned_from"
  );
  return {
    status: "ok",
    session: found.status === "ok" ? (found.items[0] ?? null) : null,
  };
}

function readLastCompletion(
  row: SessionRow
): ContinuationPacket["lastCompletion"] {
  const report =
    row.verificationReport && typeof row.verificationReport === "object"
      ? (row.verificationReport as Record<string, unknown>)
      : null;
  if (!report && !row.closedAt) return null;
  return {
    closedAt: row.closedAt ? new Date(row.closedAt).toISOString() : null,
    ...(typeof report?.summary === "string" ? { summary: report.summary } : {}),
    ...(typeof report?.unfinishedOutputs === "number"
      ? { unfinishedOutputs: report.unfinishedOutputs }
      : {}),
  };
}

const isOpenStatus = (status: string): boolean =>
  (OPEN_SESSION_STATUSES as readonly string[]).includes(status);

/**
 * THE next-move rule. Pure. In order:
 *
 *  1. the oldest owed human slot, else the oldest pending proposal — what the
 *     user can do NOW always wins, blocked or not;
 *  2. `waiting_on_session` while an OPEN session blocks this one (closed,
 *     cancelled, failed and stale blockers have settled). It OUTRANKS open agent
 *     slots: a `blocked_by` edge says this session's work depends on the
 *     blocker's outcome, so producing its deliverables now would build on inputs
 *     that are not settled — presenting them as the next move is the lie this
 *     kind exists to stop. Skipped for a terminal session (nothing left to wait for);
 *  3. the first open agent slot — this session's own work stays actionable
 *     while its sub-sessions run;
 *  4. `none` for a terminal session;
 *  5. `waiting_on_session` while a sub-session is still OPEN: a parent never
 *     auto-closes, and its children are still producing;
 *  6. `ready_to_close` ONLY when there is evidence of work — a declared,
 *     un-retired deliverable, a produced output, or a (settled) sub-session —
 *     and nothing above remains; with no evidence at all it is `undeclared`:
 *     an empty session is unplanned, not finished. A retired slot is neither
 *     owed nor produced, so it declares nothing.
 *
 * Never claims a move from a section it could not read: an `unavailable`
 * section it would have consulted yields `unknown`.
 */
export function deriveNextMove(input: {
  status: string;
  owedSlots: PacketSection<PacketSlotItem>;
  pendingProposals: PacketSection<PacketProposalItem>;
  aiCanDo: PacketSection<PacketSlotItem>;
  /** Blocker sessions, OPEN ones first (`readOutboundSessions` orders them so). */
  blockedBy: PacketSection<PacketChildItem>;
  /** The session's declared `expectedOutputs`, retired ones included. */
  expectedOutputs: ExpectedOutput[];
  outputs: PacketSection<PacketOutputItem>;
  /** Sub-sessions, OPEN ones first (`readChildren` orders them so). */
  children: PacketSection<PacketChildItem>;
}): ContinuationNextMove {
  const { owedSlots, pendingProposals, aiCanDo, blockedBy } = input;
  const terminal = isTerminalSessionStatus(input.status);
  if (owedSlots.status === "ok" && owedSlots.items[0]) {
    const s = owedSlots.items[0];
    return {
      kind: "owed_slot",
      actor: "user",
      label: `Provide "${s.label}"`,
      reason: s.why
        ? `The agent handed this to you: ${s.why}`
        : "The agent handed this deliverable to you and is waiting on it.",
    };
  }
  if (pendingProposals.status === "ok" && pendingProposals.items[0]) {
    const p = pendingProposals.items[0];
    return {
      kind: "pending_proposal",
      actor: "user",
      label: `Review: ${p.title}`,
      reason: `${pendingProposals.total} proposal(s) from this session wait for your decision; this is the oldest.`,
      proposalId: p.id,
    };
  }
  const blind = [owedSlots, pendingProposals].find(
    (s) => s.status === "unavailable"
  );
  if (blind && blind.status === "unavailable") {
    return {
      kind: "unknown",
      actor: "none",
      label: "Next move unknown",
      reason: `Part of the session could not be read (${blind.reason}), so nothing is claimed as ready.`,
    };
  }
  if (!terminal) {
    if (blockedBy.status === "unavailable") {
      return {
        kind: "unknown",
        actor: "none",
        label: "Next move unknown",
        reason: `Whether this session is blocked could not be read (${blockedBy.reason}).`,
      };
    }
    const open = blockedBy.items.filter((b) => isOpenStatus(b.status));
    const first = open[0];
    if (first) {
      const others =
        open.length > 1 ? ` (and ${open.length - 1} more open blocker(s))` : "";
      return {
        kind: "waiting_on_session",
        actor: "none",
        label: `Waiting on "${first.title}"`,
        reason: `This session is blocked by "${first.title}", which is still ${first.statusLabel.toLowerCase()}${others}; its work waits until that settles.`,
        sessionId: first.id,
      };
    }
  }
  if (aiCanDo.status === "ok" && aiCanDo.items[0]) {
    const s = aiCanDo.items[0];
    return {
      kind: "agent_slot",
      actor: "ai",
      label: `Produce "${s.label}"`,
      reason:
        "Declared deliverable with no output yet; nothing is waiting on the user.",
    };
  }
  if (aiCanDo.status === "unavailable") {
    return {
      kind: "unknown",
      actor: "none",
      label: "Next move unknown",
      reason: `Open deliverables could not be read (${aiCanDo.reason}).`,
    };
  }
  if (terminal) {
    return {
      kind: "none",
      actor: "none",
      label: "Nothing waiting",
      reason: `The session is ${resolveStatusLabel(input.status).toLowerCase()} and nothing is owed or pending.`,
    };
  }
  const readyToClose: ContinuationNextMove = {
    kind: "ready_to_close",
    actor: "ai",
    label: "None: ready to close",
    reason: "Nothing is owed, pending review, or left to produce.",
  };
  if (input.children.status === "unavailable") {
    return {
      kind: "unknown",
      actor: "none",
      label: "Next move unknown",
      reason: `Whether a sub-session is still open could not be read (${input.children.reason}).`,
    };
  }
  const openChild = input.children.items.find((c) => isOpenStatus(c.status));
  if (openChild) {
    return {
      kind: "waiting_on_session",
      actor: "none",
      label: `Waiting on "${openChild.title}"`,
      reason: `A sub-session is still open: "${openChild.title}" is ${openChild.statusLabel.toLowerCase()}, and this session does not close while it is producing.`,
      sessionId: openChild.id,
    };
  }
  if (input.expectedOutputs.some((s) => s.retiredAt == null)) {
    return readyToClose;
  }
  // No live declared deliverables: only produced work or sub-sessions separate
  // a finished session from an empty one, so a failed outputs read is unknown.
  if (input.outputs.status === "unavailable") {
    return {
      kind: "unknown",
      actor: "none",
      label: "Next move unknown",
      reason: `Whether this session produced anything could not be read (${input.outputs.reason}).`,
    };
  }
  if (
    (input.outputs.status === "ok" && input.outputs.total > 0) ||
    (input.children.status === "ok" && input.children.total > 0)
  ) {
    return readyToClose;
  }
  return {
    kind: "undeclared",
    actor: "ai",
    label: "Declare what this session should produce",
    reason:
      "No deliverables are declared and nothing has been produced yet, so there is nothing to close; state the plan and its expected outputs first.",
  };
}

/**
 * Project the packet for a session row the caller has ALREADY loaded under the
 * owner floor (every door loads it anyway; re-reading it here would be a second
 * query answering the same question).
 */
export async function projectContinuationPacket(
  row: SessionRow,
  ctx: ProjectContinuationPacketCtx
): Promise<ContinuationPacket> {
  const database = ctx.database ?? db;
  const all = slots(row);

  const owed = projectOwedSlots({
    id: row.id,
    goal: row.goal,
    status: row.status,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    expectedOutputs: all,
  }).sort((a, b) =>
    a.owedSince < b.owedSince ? -1 : a.owedSince > b.owedSince ? 1 : 0
  );
  const owedSlots = section(owed.map(owedItem));
  const blockers = section(
    owed.filter((s) => s.blockedReason !== undefined).map(owedItem)
  );
  const aiCanDo = section(
    all.filter(isOpenAgentSlot).map((s) => ({
      label: s.label,
      kind: s.kind,
      ...(s.delegatedTo ? { delegatedTo: s.delegatedTo } : {}),
    }))
  );

  const [pendingProposals, outputs, rerun, children, parent, blockedBy] =
    await Promise.all([
      readPendingProposals(database, row.id).catch(
        unavailable(
          row.id,
          "pendingProposals",
          "This session's pending proposals could not be read."
        )
      ),
      readOutputs(database, ctx.userId, row.id).catch(
        unavailable(
          row.id,
          "outputs",
          "This session's outputs could not be read."
        )
      ),
      // A failed read is its OWN state — `availability_unknown`, never folded
      // into `no_manifest` — and it must not fail the whole session read.
      assessRerunAvailability(database, row).catch((err): RerunAvailability => {
        logger.warn(
          { err, sessionId: row.id, section: "rerun" },
          "continuation packet: section read failed"
        );
        return { available: false, reason: "availability_unknown" };
      }),
      readChildren(database, ctx.userId, row.id).catch(
        unavailable(
          row.id,
          "children",
          "This session's sub-sessions could not be read."
        )
      ),
      readParent(database, ctx.userId, row.id).catch(
        unavailable(
          row.id,
          "parent",
          "This session's parent session could not be read."
        )
      ),
      readOutboundSessions(database, ctx.userId, row.id, "blocked_by").catch(
        unavailable(
          row.id,
          "blockedBy",
          "The sessions this one waits on could not be read."
        )
      ),
    ]);

  const manifest = readSessionRunManifest(row.metadata);

  return {
    version: 1,
    session: {
      id: row.id,
      title: row.title ?? null,
      displayTitle: resolveSessionTitle(row),
      goal: row.goal,
      status: row.status,
      statusLabel: resolveStatusLabel(row.status),
      kind: projectSessionKind(row),
      currentStage: row.currentStage ?? null,
      progress: row.progress ?? null,
    },
    userMustDecide: { owedSlots, pendingProposals },
    aiCanDo,
    blockers,
    outputs,
    children,
    parent,
    blockedBy,
    run: manifest
      ? {
          sourcesCount: manifest.sourceDocumentIds.length,
          engine: manifest.engine,
          model: manifest.model,
          ...(manifest.provider !== undefined
            ? { provider: manifest.provider }
            : {}),
          promptVersion: manifest.promptVersion,
          guidelines: manifest.guidelines.map((g) => ({
            id: g.id,
            version: g.version,
          })),
          ...(manifest.guidelineStatus
            ? { guidelineStatus: manifest.guidelineStatus }
            : {}),
        }
      : null,
    rerun,
    lastCompletion: readLastCompletion(row),
    nextMove: deriveNextMove({
      status: row.status,
      owedSlots,
      pendingProposals,
      aiCanDo,
      blockedBy,
      expectedOutputs: all,
      outputs,
      children,
    }),
  };
}
