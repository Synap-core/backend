/**
 * Where a capture stands — the ONE derivation, folded from its room's messages.
 *
 * A capture is a session and its room carries every fact: the note, the pod's
 * `capture_question` / `capture_answer` / `capture_result` / `capture_filed`
 * parts, and the owner's comments. The pod (Needs-you, the captures list, the
 * comment turn, the re-read), the capture pipeline and relay all read the same
 * room; this fold is what they share, so "is this row filed", "is the question
 * still open" and "does this capture still owe the person something" have one
 * answer on every surface.
 *
 * The rules, each pinned by a fixture that would fail under the alternative:
 *  - The chips come from the LATEST result: the highest round, and of equal
 *    rounds the later message.
 *  - A row's receipt is the `capture_filed` row with the same ROUND and tempId.
 *    The pod reuses `t1`, `t2` in every round, so a tempId alone names
 *    different records in different rounds.
 *  - A record an earlier round filed or holds for review is the same record
 *    when a later round proposes the same kind + title again (under any
 *    tempId): it stays filed / held, or — changed by the person's comments —
 *    becomes an update of that entity. An earlier settled record the latest
 *    round no longer mentions is still listed (`carried`): a re-read never
 *    unfiles anything.
 *  - A question is open while it is `open`, unanswered, and no result came
 *    after it (the read has moved past it).
 *  - The note is the first plain owner message before any capture part (or the
 *    message a client marked `captureNote`). Comments are the owner's plain
 *    messages AFTER the first capture part, never the note.
 *  - A capture OWES the person a decision while its question is open, or a
 *    suggested (or failed) row is `certain` or `likely`; `unsure` rows fold and
 *    never keep a capture unfinished.
 *
 * PURE: no clock, no I/O, no kind-specific branch (`profileSlug` is opaque).
 */

import {
  readCapturePart,
  type CaptureFiledPart,
  type CaptureFiledRow,
  type CaptureQuestionPart,
  type CaptureResultPart,
  type CaptureResultRow,
} from "./index.js";

/** Where one suggested record stands. Words: `resolveCaptureChipStateLabel`. */
export const CAPTURE_ROW_STATES = [
  "suggested",
  "awaiting_approval",
  "filed",
  "rejected",
  "failed",
] as const;
export type CaptureRowState = (typeof CAPTURE_ROW_STATES)[number];

/** The subset of a room message the fold reads. */
export interface CaptureRoomMessage {
  id: string;
  role?: string | null;
  /** The author. Compared with `ownerId` when both are known. */
  userId?: string | null;
  content?: string | null;
  metadata?: unknown;
  /** The wire field is `timestamp`; `createdAt` is accepted for normalised rows. */
  timestamp?: string | number | Date | null;
  createdAt?: string | number | Date | null;
  ephemeral?: boolean | null;
}

/** A receipt row as the fold reads it — a `capture_filed` row, or a client's own copy. */
export type CaptureReceiptRow = Pick<
  CaptureFiledRow,
  "tempId" | "entityId" | "proposalId" | "outcome" | "title"
>;

export interface CaptureRowView {
  /** The round the row was proposed in (an earlier one when `carried`). */
  round: number;
  row: CaptureResultRow;
  state: CaptureRowState;
  /** The record the row became, when `filed`. */
  entityId: string | null;
  /** The review that holds the row, when `awaiting_approval` and known. */
  proposalId: string | null;
  /**
   * A `suggested` row that is a record an earlier round already FILED, changed
   * since: filing it updates this entity, never creates a second one.
   */
  updatesEntityId: string | null;
  /** An earlier round's settled record the latest round did not mention. */
  carried: boolean;
  /** This row keeps the capture unfinished (see the header). */
  owed: boolean;
}

export interface CaptureRoomComment {
  messageId: string;
  text: string;
}

export type CaptureOwedStatus = "needs_answer" | "suggested";

export interface CaptureRoomState {
  /** The room holds a capture part. The ONE "is a capture room" test. */
  isCaptureRoom: boolean;
  note: { messageId: string; text: string } | null;
  /** The latest result (see the header), or null before any. */
  result: { messageId: string; part: CaptureResultPart } | null;
  /** The latest round's rows, then the carried ones. */
  rows: CaptureRowView[];
  /** The newest question, and whether it is still open. */
  question: {
    messageId: string;
    part: CaptureQuestionPart;
    open: boolean;
  } | null;
  /** The owner's comments after the first capture part, oldest first. */
  comments: CaptureRoomComment[];
  /** The comments after the latest result — what "Update suggestions" folds in. */
  commentsSinceResult: CaptureRoomComment[];
  /** What the capture still owes the person. `status` null = nothing. */
  owed: { question: boolean; rows: number; status: CaptureOwedStatus | null };
  /** The newest `capture_filed` receipt: where the filed rows went. */
  receipt: {
    round: number;
    workspaceId: string | null;
    projectId: string | null;
  } | null;
}

export interface DeriveCaptureRoomOptions {
  /** Whose plain messages are the note and comments. Absent = any user message. */
  ownerId?: string | null;
  /**
   * Receipts the room does not carry (a client's own copy from before the pod
   * wrote `capture_filed`). A pod receipt for the same row always wins.
   */
  fallbackReceipts?: ReadonlyArray<{
    round: number;
    rows: ReadonlyArray<CaptureReceiptRow>;
  }>;
  /**
   * The capture already produced records. With NO receipt anywhere, it was
   * filed before receipts existed and the room cannot tell which rows — so
   * no row is owed rather than every old capture resurfacing as unfinished.
   */
  producedRecords?: boolean;
}

/** The receipts of one round, by tempId; a later receipt of a row wins. */
export function captureReceiptsOfRound<R extends { tempId: string }>(
  parts: ReadonlyArray<{ round: number; rows: ReadonlyArray<R> }>,
  round: number
): Map<string, R> {
  const out = new Map<string, R>();
  for (const part of parts) {
    if (part.round !== round) continue;
    for (const row of part.rows) out.set(row.tempId, row);
  }
  return out;
}

/** The same record across rounds: same kind, same title. */
export function captureRecordKey(profileSlug: string, title: string): string {
  return `${profileSlug}\u0000${title.trim().toLowerCase()}`;
}

/** True when a message carries a capture part — a capture room holds one. */
export function isCapturePartMessage(metadata: unknown): boolean {
  return readCapturePart(metadata) !== null;
}

function timeOf(m: CaptureRoomMessage): number {
  const raw = m.timestamp ?? m.createdAt;
  if (raw === null || raw === undefined) return 0;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

function hasNoteMark(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const note = (metadata as { captureNote?: unknown }).captureNote;
  return note !== undefined && note !== null;
}

function hasPartKey(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as { capturePart?: unknown }).capturePart != null
  );
}

function stateOfReceipt(r: CaptureReceiptRow): CaptureRowState {
  if (r.outcome === "proposed") return "awaiting_approval";
  if (r.outcome === "failed") return "failed";
  return "filed";
}

function samePayload(a: CaptureResultRow, b: CaptureResultRow): boolean {
  return (
    JSON.stringify(a.properties ?? {}) === JSON.stringify(b.properties ?? {}) &&
    (a.content ?? "") === (b.content ?? "")
  );
}

const isSettled = (s: CaptureRowState) =>
  s === "filed" || s === "awaiting_approval";

/** Fold a capture room's messages into where the capture stands. PURE. */
export function deriveCaptureRoomState(
  messages: ReadonlyArray<CaptureRoomMessage>,
  options: DeriveCaptureRoomOptions = {}
): CaptureRoomState {
  const ordered = messages
    .map((m, i) => ({ m, i, t: timeOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);

  const filedParts: CaptureFiledPart[] = [];
  const answered = new Set<string>();
  // The last result part of each round, with its position.
  const resultByRound = new Map<
    number,
    { part: CaptureResultPart; at: number; messageId: string }
  >();
  let question: {
    part: CaptureQuestionPart;
    at: number;
    messageId: string;
  } | null = null;
  let firstPartAt = -1;

  ordered.forEach((m, at) => {
    const part = readCapturePart(m.metadata);
    if (!part) return;
    if (firstPartAt < 0) firstPartAt = at;
    if (part.kind === "capture_result") {
      resultByRound.set(part.round, { part, at, messageId: m.id });
    } else if (part.kind === "capture_filed") {
      filedParts.push(part);
    } else if (part.kind === "capture_question") {
      question = { part, at, messageId: m.id };
    } else if (part.kind === "capture_answer") {
      answered.add(part.questionMessageId);
    }
  });

  const rounds = [...resultByRound.keys()].sort((a, b) => a - b);
  const latest =
    rounds.length > 0 ? resultByRound.get(rounds[rounds.length - 1]!)! : null;

  const fallback = options.fallbackReceipts ?? [];
  const receiptFor = (
    round: number,
    tempId: string
  ): CaptureReceiptRow | null =>
    captureReceiptsOfRound(filedParts, round).get(tempId) ??
    captureReceiptsOfRound(fallback, round).get(tempId) ??
    null;

  const viewOf = (
    row: CaptureResultRow,
    round: number,
    receipt: CaptureReceiptRow | null
  ): CaptureRowView => {
    const state: CaptureRowState = receipt
      ? stateOfReceipt(receipt)
      : row.dismissed
        ? "rejected"
        : "suggested";
    return {
      round,
      row,
      state,
      entityId: state === "filed" ? (receipt?.entityId ?? null) : null,
      proposalId:
        state === "awaiting_approval" ? (receipt?.proposalId ?? null) : null,
      updatesEntityId: null,
      carried: false,
      owed: false,
    };
  };

  // Earlier rounds' settled records, by record key — oldest round first, so
  // a newer round's word on the same record wins and a chain carries.
  const settled = new Map<string, CaptureRowView>();
  const keysOf = (view: CaptureRowView, receipt: CaptureReceiptRow | null) => {
    const keys = [captureRecordKey(view.row.profileSlug, view.row.title)];
    if (receipt && receipt.title.trim() !== view.row.title.trim()) {
      keys.push(captureRecordKey(view.row.profileSlug, receipt.title));
    }
    return keys;
  };
  const carry = (
    row: CaptureResultRow,
    round: number,
    receipt: CaptureReceiptRow | null,
    earlier: CaptureRowView | undefined
  ): CaptureRowView => {
    const own = viewOf(row, round, receipt);
    if (receipt || !earlier) return own;
    if (earlier.state === "awaiting_approval") {
      return {
        ...own,
        state: "awaiting_approval",
        proposalId: earlier.proposalId,
      };
    }
    if (earlier.entityId && !samePayload(row, earlier.row)) {
      return {
        ...own,
        state: "suggested",
        updatesEntityId: earlier.entityId,
      };
    }
    return { ...own, state: "filed", entityId: earlier.entityId };
  };

  for (const round of rounds) {
    if (latest && round === latest.part.round) continue;
    const { part } = resultByRound.get(round)!;
    for (const row of part.rows) {
      const receipt = receiptFor(round, row.tempId);
      const earlier = settled.get(captureRecordKey(row.profileSlug, row.title));
      const view = carry(row, round, receipt, earlier);
      if (!isSettled(view.state)) continue;
      for (const key of keysOf(view, receipt)) settled.set(key, view);
    }
  }

  const rows: CaptureRowView[] = [];
  const used = new Set<CaptureRowView>();
  if (latest) {
    const round = latest.part.round;
    for (const row of latest.part.rows) {
      const receipt = receiptFor(round, row.tempId);
      const key = captureRecordKey(row.profileSlug, row.title);
      const earlier = settled.get(key);
      if (earlier) used.add(earlier);
      rows.push(carry(row, round, receipt, earlier));
    }
  }
  for (const view of new Set(settled.values())) {
    if (!used.has(view)) rows.push({ ...view, carried: true });
  }

  const legacyFiled =
    options.producedRecords === true &&
    filedParts.length === 0 &&
    fallback.length === 0;
  for (const view of rows) {
    view.owed =
      !legacyFiled &&
      !view.carried &&
      (view.state === "suggested" || view.state === "failed") &&
      view.row.label !== "unsure";
  }

  const q = question as {
    part: CaptureQuestionPart;
    at: number;
    messageId: string;
  } | null;
  const questionOpen =
    q !== null &&
    q.part.status === "open" &&
    !answered.has(q.messageId) &&
    !(latest && latest.at > q.at);

  const ownerId = options.ownerId ?? null;
  const isPlainOwner = (m: CaptureRoomMessage) =>
    m.role !== "assistant" &&
    m.role !== "system" &&
    m.ephemeral !== true &&
    !hasPartKey(m.metadata) &&
    (ownerId === null || !m.userId || m.userId === ownerId) &&
    (m.content ?? "").trim() !== "";

  let noteAt = ordered.findIndex(
    (m) => hasNoteMark(m.metadata) && isPlainOwner(m)
  );
  if (noteAt < 0) {
    noteAt = ordered.findIndex(
      (m, at) => (firstPartAt < 0 || at < firstPartAt) && isPlainOwner(m)
    );
  }
  const note =
    noteAt >= 0
      ? {
          messageId: ordered[noteAt]!.id,
          text: (ordered[noteAt]!.content ?? "").trim(),
        }
      : null;

  const comments: CaptureRoomComment[] = [];
  const commentsSinceResult: CaptureRoomComment[] = [];
  if (firstPartAt >= 0) {
    ordered.forEach((m, at) => {
      if (at <= firstPartAt || at === noteAt || !isPlainOwner(m)) return;
      const comment = { messageId: m.id, text: (m.content ?? "").trim() };
      comments.push(comment);
      if (latest && at > latest.at) commentsSinceResult.push(comment);
    });
  }

  const owedRows = rows.filter((r) => r.owed).length;
  const newestFiled = filedParts[filedParts.length - 1];
  const projectId =
    [...filedParts].reverse().find((p) => p.projectId)?.projectId ?? null;

  return {
    isCaptureRoom: firstPartAt >= 0,
    note,
    result: latest ? { messageId: latest.messageId, part: latest.part } : null,
    rows,
    question: q
      ? { messageId: q.messageId, part: q.part, open: questionOpen }
      : null,
    comments,
    commentsSinceResult,
    owed: {
      question: questionOpen,
      rows: owedRows,
      status: questionOpen ? "needs_answer" : owedRows > 0 ? "suggested" : null,
    },
    receipt: newestFiled
      ? {
          round: newestFiled.round,
          workspaceId: newestFiled.workspaceId,
          projectId,
        }
      : null,
  };
}
