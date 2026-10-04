/**
 * SESSION ACTIVITY — "what did agents DO in this session, in order?" as ONE
 * bounded read. Served by `focusSessions.activity` (the session pages) and by
 * `runs.get` for session / playbook runs (run-detail's spine), so the two can
 * never tell a session's story differently.
 *
 * Before this, `runs.get` returned ONE lifecycle marker for exactly the runs
 * agents do ("the story is the channel"), and the session pages showed the
 * plan (intent) but never the record. Every source below was already durable;
 * nothing here needed a migration.
 *
 * ── Sources, merged by time ────────────────────────────────────────────────
 *   turns     — `chat_turns` in the session's room + their `chat_turn_events`
 *               (`step` → tool calls/results, through the ONE tool-run
 *               projection `projectToolRuns`; `error` frames). A turn whose
 *               status is `running` is the only "in flight" fact.
 *   events    — `events.session_id = :id` (0241 temporal spine) through
 *               `eventVisibleWhere`: every governed domain write by ANY agent,
 *               external MCP agents included. `.completed` phase only.
 *   proposals — `proposals.session_id = :id`: drafts awaiting, decided ones.
 *               Auto-approved receipts are skipped — the write event already
 *               says it; a human-approved decision REPLACES the write event it
 *               authorized (one row, not two).
 *   asks      — the session's owed slots (`isOwedSlot`): handed back to you.
 *   notes     — agent messages posted in the room that are not a turn's own
 *               reply (progress / questions via `post_message`).
 *
 * ── EMPTY vs FAILED ────────────────────────────────────────────────────────
 * Each source is read on its own. A source that throws is NAMED in
 * `unreadable` and the rest still render; it is never folded into "nothing
 * happened". A session the reader may not open returns `null` (the callers
 * turn that into NOT_FOUND / the private placeholder), never an empty list.
 *
 * ── Bounds ─────────────────────────────────────────────────────────────────
 * Every source has a cap; the merge keeps the newest `ACTIVITY_ITEM_CAP`.
 * Hitting any cap sets `truncated` — "Show all" then means "more exists".
 */

import {
  db,
  and,
  desc,
  eq,
  inArray,
  isNull,
  like,
  chatTurns,
  chatTurnEvents,
  events,
  focusSessions,
  messages,
  MessageAuthorType,
  proposals,
  users,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { isTerminalSessionStatus } from "@synap-core/types/focus-sessions";
import {
  projectToolRuns,
  type SessionActivityActor,
  type SessionActivityStatus,
  type SessionActivitySource,
  type SessionActivityItem,
  type SessionActivityWire,
  type ToolRunStep,
} from "@synap-core/types/run-activity";
import type { ExpectedOutput } from "@synap/playbooks";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { eventVisibleWhere } from "../../access/event-visibility.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { isOwedSlot } from "../focus-sessions/owed-outputs.js";
import { unreadableTargetSessionIds } from "../proposals/session-content-redaction.js";

const logger = createLogger({ module: "session-activity" });

/** The merged list a surface receives — newest kept. */
export const ACTIVITY_ITEM_CAP = 300;
const TURN_CAP = 25;
const TURN_EVENT_CAP = 800;
const EVENT_CAP = 200;
const PROPOSAL_CAP = 100;
const NOTE_CAP = 40;
/** A note is one line; the conversation pane owns the full message. */
const NOTE_TITLE_MAX = 140;

/** Session lifecycle verbs worth a bookend row. Progress updates are not. */
const LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set([
  "create",
  "start",
  "close",
  "complete",
  "cancel",
  "revert",
]);

const SESSION_SUBJECTS: ReadonlySet<string> = new Set([
  "focus_session",
  "session",
]);

export interface SessionActivityReader {
  userId: string;
  /** Honour the human-roster read branch (a human door). */
  roster: boolean;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function proposalStatus(status: string): SessionActivityStatus | null {
  switch (status) {
    case "pending":
      return "pending";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "approval_failed":
      return "failed";
    // auto_approved (a receipt — its write event tells it), reverted,
    // withdrawn, expired: not a decision anyone took in this session's story.
    default:
      return null;
  }
}

/** `entity.create.completed` → `{ subject: "entity", action: "create" }`. */
export function parseEventType(
  type: string
): { subject: string; action: string } | null {
  const parts = type.split(".");
  if (parts.length < 3 || parts[parts.length - 1] !== "completed") return null;
  return {
    subject: parts.slice(0, -2).join("."),
    action: parts[parts.length - 2]!,
  };
}

type ItemDraft = Omit<SessionActivityItem, "actor"> & {
  actorId: string | null;
  actorIsAgent: boolean;
};

function draft(
  over: Partial<ItemDraft> & Pick<ItemDraft, "id" | "at" | "kind">
): ItemDraft {
  return {
    status: null,
    turnId: null,
    action: null,
    objectKind: null,
    objectId: null,
    objectTitle: null,
    title: null,
    error: null,
    proposalId: null,
    actorId: null,
    actorIsAgent: false,
    ...over,
  };
}

/**
 * The session's activity, or `null` when the reader may not open the session.
 */
export async function loadSessionActivity(
  reader: SessionActivityReader,
  sessionId: string
): Promise<SessionActivityWire | null> {
  const { userId, roster } = reader;
  const [session] = await db
    .select({
      id: focusSessions.id,
      status: focusSessions.status,
      channelId: focusSessions.channelId,
      expectedOutputs: focusSessions.expectedOutputs,
      startedAt: focusSessions.startedAt,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, sessionId),
        sessionReadableWhere({ userId, roster })
      )
    )
    .limit(1);
  if (!session) return null;

  const unreadable: SessionActivitySource[] = [];
  let truncated = false;
  const drafts: ItemDraft[] = [];
  let turnInFlight = false;
  let inFlightSince: Date | null = null;

  const attempt = async (
    source: SessionActivitySource,
    read: () => Promise<void>
  ): Promise<void> => {
    try {
      await read();
    } catch (err) {
      logger.warn(
        { err, sessionId, source },
        "session activity sub-read failed"
      );
      unreadable.push(source);
    }
  };

  const channelId = session.channelId ?? null;
  const turnReplyIds = new Set<string>();

  // ── turns ────────────────────────────────────────────────────────────────
  await attempt("turns", async () => {
    if (!channelId) return;
    const turns = await db
      .select({
        id: chatTurns.id,
        status: chatTurns.status,
        startedAt: chatTurns.startedAt,
        assistantMessageId: chatTurns.assistantMessageId,
      })
      .from(chatTurns)
      .where(eq(chatTurns.channelId, channelId))
      .orderBy(desc(chatTurns.startedAt))
      .limit(TURN_CAP + 1);
    if (turns.length > TURN_CAP) {
      truncated = true;
      turns.length = TURN_CAP;
    }
    for (const t of turns) {
      turnReplyIds.add(t.assistantMessageId);
      if (t.status === "running") {
        turnInFlight = true;
        if (!inFlightSince || t.startedAt > inFlightSince)
          inFlightSince = t.startedAt;
      }
    }
    if (turns.length === 0) return;

    const rows = await db
      .select({
        turnId: chatTurnEvents.turnId,
        seq: chatTurnEvents.seq,
        type: chatTurnEvents.type,
        payload: chatTurnEvents.payload,
        createdAt: chatTurnEvents.createdAt,
      })
      .from(chatTurnEvents)
      .where(
        and(
          inArray(
            chatTurnEvents.turnId,
            turns.map((t) => t.id)
          ),
          inArray(chatTurnEvents.type, ["step", "error"])
        )
      )
      .orderBy(desc(chatTurnEvents.createdAt))
      .limit(TURN_EVENT_CAP + 1);
    if (rows.length > TURN_EVENT_CAP) {
      truncated = true;
      rows.length = TURN_EVENT_CAP;
    }

    const byTurn = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byTurn.get(r.turnId) ?? [];
      list.push(r);
      byTurn.set(r.turnId, list);
    }
    for (const [turnId, list] of byTurn) {
      list.sort((a, b) => a.seq - b.seq);
      const steps: ToolRunStep[] = [];
      const stepAt = new Map<string, Date>();
      for (const r of list) {
        const payload = rec(r.payload);
        if (r.type === "error") {
          // A cancellation is the person pressing Stop — terminal, not a fault.
          if (payload.code === "cancelled") continue;
          drafts.push(
            draft({
              id: `turn-error:${turnId}:${r.seq}`,
              at: r.createdAt,
              kind: "error",
              status: "failed",
              turnId,
              error: str(payload.message) ?? null,
            })
          );
          continue;
        }
        const step = rec(payload.step);
        const id = str(step.id);
        const type = str(step.type);
        if (!id || !type) continue;
        steps.push(step as unknown as ToolRunStep);
        stepAt.set(id, r.createdAt);
      }
      // THE one projection — the same rule relay's chat and the browser's
      // chat settle their tool rows by.
      for (const card of projectToolRuns(steps)) {
        drafts.push(
          draft({
            id: `tool:${turnId}:${card.id}`,
            at: stepAt.get(card.id) ?? list[0]!.createdAt,
            kind: "tool",
            status: card.status,
            turnId,
            action: card.toolName,
            title: card.label,
            error: card.status === "failed" ? (card.detail ?? null) : null,
            actorIsAgent: true,
          })
        );
      }
    }
  });

  // ── proposals (read BEFORE events: a decided one replaces its write) ─────
  const decidedProposalIds = new Set<string>();
  await attempt("proposals", async () => {
    const rows = await db
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        status: proposals.status,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        data: proposals.data,
        agentUserId: proposals.agentUserId,
        createdAt: proposals.createdAt,
        reviewedAt: proposals.reviewedAt,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.sessionId, sessionId),
          userVisibleWhere(proposals.workspaceId, userId)
        )
      )
      .orderBy(desc(proposals.createdAt))
      .limit(PROPOSAL_CAP + 1);
    if (rows.length > PROPOSAL_CAP) {
      truncated = true;
      rows.length = PROPOSAL_CAP;
    }
    // A proposal ABOUT another session the reader cannot open keeps its verb,
    // never that session's name (decision D1).
    const withheld = await unreadableTargetSessionIds(rows, { userId, roster });
    for (const r of rows) {
      const status = proposalStatus(r.status);
      if (!status) continue;
      const request = rec(r.data);
      const payload = rec(request.data);
      if (status !== "pending") decidedProposalIds.add(r.id);
      drafts.push(
        draft({
          id: `proposal:${r.id}`,
          // A decision sits where it was DECIDED; a pending one where it was filed.
          at:
            status === "pending" ? r.createdAt : (r.reviewedAt ?? r.createdAt),
          kind: "decision",
          status,
          action: r.proposalType,
          objectKind:
            str(payload.profileSlug) ?? str(payload.type) ?? r.targetType,
          objectId: r.targetId,
          objectTitle: withheld.has(r.targetId)
            ? null
            : (str(request.targetName) ??
              str(payload.title) ??
              str(payload.name)),
          proposalId: r.id,
          actorId: r.agentUserId ?? null,
          actorIsAgent: !!r.agentUserId,
        })
      );
    }
  });

  // ── events ───────────────────────────────────────────────────────────────
  await attempt("events", async () => {
    const rows = await db
      .select({
        id: events.id,
        at: events.timestamp,
        type: events.type,
        subjectId: events.subjectId,
        subjectType: events.subjectType,
        data: events.data,
        proposalId: events.proposalId,
        agentUserId: events.agentUserId,
        isAgent: events.isAgent,
      })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          like(events.type, "%.completed"),
          eventVisibleWhere({ userId, roster })
        )
      )
      .orderBy(desc(events.timestamp))
      .limit(EVENT_CAP + 1);
    if (rows.length > EVENT_CAP) {
      truncated = true;
      rows.length = EVENT_CAP;
    }
    for (const e of rows) {
      const parsed = parseEventType(e.type);
      if (!parsed) continue;
      const data = rec(e.data);
      const isSessionSubject =
        SESSION_SUBJECTS.has(parsed.subject) ||
        SESSION_SUBJECTS.has(e.subjectType);
      if (isSessionSubject) {
        if (!LIFECYCLE_ACTIONS.has(parsed.action)) continue;
        drafts.push(
          draft({
            id: `event:${e.id}`,
            at: e.at,
            kind: "lifecycle",
            status: "done",
            action: parsed.action,
            objectKind: "session",
            objectId: e.subjectId,
            actorId: e.agentUserId ?? null,
            actorIsAgent: !!e.isAgent,
          })
        );
        continue;
      }
      // The decision row already tells this write (approved by a person).
      if (e.proposalId && decidedProposalIds.has(e.proposalId)) continue;
      drafts.push(
        draft({
          id: `event:${e.id}`,
          at: e.at,
          kind: "write",
          status: "done",
          action: parsed.action,
          objectKind: str(data.profileSlug) ?? e.subjectType,
          objectId: e.subjectId,
          objectTitle: str(data.title) ?? str(data.name),
          proposalId: e.proposalId ?? null,
          actorId: e.agentUserId ?? null,
          actorIsAgent: !!e.isAgent,
        })
      );
    }
  });

  // ── asks (owed slots) ────────────────────────────────────────────────────
  await attempt("asks", async () => {
    const slots = Array.isArray(session.expectedOutputs)
      ? (session.expectedOutputs as ExpectedOutput[])
      : [];
    for (const slot of slots) {
      if (!slot || typeof slot !== "object" || !isOwedSlot(slot)) continue;
      const label = str(slot.label);
      if (!label) continue;
      const owedSince = str((slot as { owedSince?: unknown }).owedSince);
      drafts.push(
        draft({
          id: `ask:${label}`,
          at: owedSince ? new Date(owedSince) : session.startedAt,
          kind: "ask",
          status: "pending",
          title: label,
        })
      );
    }
  });

  // ── notes (agent messages that are not a turn's own reply) ───────────────
  await attempt("notes", async () => {
    if (!channelId) return;
    const rows = await db
      .select({
        id: messages.id,
        content: messages.content,
        at: messages.timestamp,
        routedTeammateId: messages.routedTeammateId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(messages.authorType, MessageAuthorType.AI_AGENT),
          isNull(messages.deletedAt)
        )
      )
      .orderBy(desc(messages.timestamp))
      .limit(NOTE_CAP + 1);
    if (rows.length > NOTE_CAP) {
      truncated = true;
      rows.length = NOTE_CAP;
    }
    for (const m of rows) {
      if (turnReplyIds.has(m.id)) continue;
      const firstLine =
        m.content
          .split("\n")
          .find((l) => l.trim())
          ?.trim() ?? "";
      if (!firstLine) continue;
      drafts.push(
        draft({
          id: `note:${m.id}`,
          at: m.at,
          kind: "note",
          status: "done",
          title:
            firstLine.length > NOTE_TITLE_MAX
              ? `${firstLine.slice(0, NOTE_TITLE_MAX - 1)}…`
              : firstLine,
          objectId: m.id,
          actorId: m.routedTeammateId ?? null,
          actorIsAgent: true,
        })
      );
    }
  });

  // ── merge: oldest first, newest ACTIVITY_ITEM_CAP kept ───────────────────
  drafts.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (drafts.length > ACTIVITY_ITEM_CAP) {
    truncated = true;
    drafts.splice(0, drafts.length - ACTIVITY_ITEM_CAP);
  }

  const actors = await resolveActors([
    ...new Set(drafts.map((d) => d.actorId).filter((x): x is string => !!x)),
  ]);
  const items: SessionActivityItem[] = drafts.map(
    ({ actorId, actorIsAgent, ...rest }) => ({
      ...rest,
      actor: actorId
        ? (actors.get(actorId) ?? {
            id: actorId,
            name: null,
            isAgent: actorIsAgent,
          })
        : null,
    })
  );
  const last = items[items.length - 1];

  return {
    sessionId,
    items,
    truncated,
    terminal: isTerminalSessionStatus(session.status),
    live: {
      turnInFlight,
      since: inFlightSince,
      lastAt: last ? last.at : null,
    },
    unreadable,
  };
}

/**
 * Names for the actors on the page — one batched read. A failure here costs
 * the NAMES only (each actor keeps its id), never the activity.
 */
async function resolveActors(
  ids: string[]
): Promise<Map<string, SessionActivityActor>> {
  const out = new Map<string, SessionActivityActor>();
  if (ids.length === 0) return out;
  try {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        userType: users.userType,
        agentType: users.agentType,
      })
      .from(users)
      .where(inArray(users.id, ids));
    for (const u of rows) {
      out.set(u.id, {
        id: u.id,
        name: u.name ?? u.agentType ?? null,
        isAgent: u.userType !== "human",
      });
    }
  } catch (err) {
    logger.warn({ err }, "session activity actor names unreadable");
  }
  return out;
}
