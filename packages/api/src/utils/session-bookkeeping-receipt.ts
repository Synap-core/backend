/**
 * THE RECEIPT OF A SESSION'S OWN BOOKKEEPING goes to the event spine, not the
 * proposals table (plan 527996fa, wave 0 item 0.7).
 *
 * WHY. Every auto-approved write leaves an AUTO_APPROVED `proposals` row (the
 * receipt, `permission-check.ts`). For a session updating ITSELF — progress, a
 * stage, an outcome recorded or claimed, a status — that row is bookkeeping,
 * not a decision anyone takes: on 1–2 Nov 2026, 964 of the 1,000 newest
 * auto-approved rows were `focus_session.update` receipts (usage review
 * 1b7ca379 §4.2), and every proposals reader (the review queue, counts, the
 * "already done" ledger, cancel's "already landed") had to filter them back
 * out by hand.
 *
 * WHAT REPLACES IT. One `focus_session.update.completed` event on the
 * session (`events.session_id`), through `auditLog`: who wrote it (the agent,
 * or the AI-sourced key with no agent row), which fields the patch carried
 * (names only, never values: the row holds them), and the governance verdict
 * that let it through (`autoApproved`). The session's activity reads the spine
 * (`session-activity.ts`, which shows a session update only as a lifecycle
 * step), so nothing it drew is lost.
 *
 * WHEN A RECEIPT IS STILL A PROPOSALS ROW. An update an Undo can restore
 * (`isUndoableSessionPatch`) keeps its receipt: the row patch that Undo replays
 * is stamped on it (`stampSessionUpdate`), and revert reads it from there. The
 * door decides that BEFORE the gate and asks for this event only when there is
 * nothing to undo. A session update the gate PROPOSES is a decision and stays a
 * pending row, whatever the door asked.
 *
 * NOT A PERSON'S EDIT. `isOwnFreshWork` reads a `focus_session.*.completed`
 * event that carries no agent as "a person touched this session". The
 * AI-sourced key with no agent row is not a person, so its event is marked
 * `isAgent: true` (the flag `auditLog` keeps for exactly that legacy path).
 *
 * NOT A SPENT WRITE. The daily ceiling counts an agent's events with no
 * proposal; this event is the agent's own-session bookkeeping, which
 * `auditLog` stamps `ceiling_exempt` from the session row
 * (`isOwnSessionBookkeeping`). The agent path only takes this door when that
 * proof holds (`permission-check.ts`), so the two agree.
 */
import { createLogger } from "@synap-core/core";
import { auditLog } from "./audit-log.js";

const logger = createLogger({ module: "session-bookkeeping-receipt" });

/** Keys of a session-update gate payload that name the session, not a change. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "sessionId",
  "sessionName",
  "previousGoal",
  "userId",
  "agentUserId",
]);

/** The fields a session-update payload carried: names only, sorted. */
export function sessionUpdateFields(data: Record<string, unknown>): string[] {
  return Object.keys(data)
    .filter((k) => !IDENTITY_KEYS.has(k) && data[k] !== undefined)
    .sort();
}

/** May this write's receipt go to the spine? Only a session updating a session. */
export function isSessionUpdateReceipt(
  subjectType: string,
  action: string
): boolean {
  return subjectType === "focus_session" && action === "update";
}

export interface SessionBookkeepingReceiptInput {
  sessionId: string;
  /** The person the write was made for. */
  userId: string;
  /** The acting agent; null for an AI-sourced key with no agent row. */
  agentUserId: string | null;
  workspaceId: string | null | undefined;
  /** The gate payload (what the patch carried). */
  data: Record<string, unknown>;
  /** The verdict that let it through — the receipt's `_autoApprove`. */
  autoApproved: Record<string, unknown>;
}

/**
 * Record the receipt on the event spine. Best-effort, like the proposals
 * receipt it replaces: a failed append is logged, never fails a write that was
 * already granted. Returns the event id, or null when the append failed.
 */
export async function recordSessionBookkeepingReceipt(
  input: SessionBookkeepingReceiptInput
): Promise<string | null> {
  const event = await auditLog({
    subjectType: "focus_session",
    action: "update",
    phase: "completed",
    subjectId: input.sessionId,
    userId: input.userId,
    agentUserId: input.agentUserId,
    // AI-sourced either way: never read as a person's edit (header).
    isAgent: true,
    workspaceId: input.workspaceId ?? null,
    sessionId: input.sessionId,
    source: "intelligence",
    data: {
      fields: sessionUpdateFields(input.data),
      autoApproved: input.autoApproved,
    },
  });
  if (!event) {
    logger.error(
      { sessionId: input.sessionId, agentUserId: input.agentUserId },
      "Session bookkeeping receipt not appended (write still granted)"
    );
    return null;
  }
  return event.id;
}
