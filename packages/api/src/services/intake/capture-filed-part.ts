/**
 * Capture FILED part — what `capture.execute` did with the rows a person
 * accepted, written into the capture room so every device reads one receipt.
 *
 * The "Filed" state used to live only in the accepting device's local storage:
 * another device (or a reinstall) showed filed rows as still proposed, and an
 * edited re-accept created a duplicate. The pod knows the outcome; this puts it
 * where the rest of the conversation already is.
 *
 * ONE WRITER: `capture.execute`, once per accept, on every outcome it returns
 * (applied, governance-proposed, propose mode). Best-effort — a failed write is
 * logged by the caller and never fails the capture.
 *
 * ONLY INTO A CAPTURE ROOM. `execute`'s session may be a work session the
 * capture was filed under (event mode); its room is not a capture thread, so a
 * receipt is written only where a `capture_result` already exists.
 *
 * Contract + bounds: `@synap-core/types/capture` (`CaptureFiledPartSchema`).
 */

import {
  db,
  messages,
  focusSessions,
  and,
  eq,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  CAPTURE_RESULT_LIMITS,
  CaptureFiledPartSchema,
  readCapturePart,
  type CaptureFiledPart,
  type CaptureFiledRow,
  type CaptureRowAction,
} from "@synap-core/types/capture";
import { deterministicUuidFromKey } from "../../utils/write-door-idempotency.js";
import { stableStringify } from "../../utils/stable-stringify.js";
import type { CaptureUpdateResult } from "../../utils/capture-update-arm.js";
import { recordCapturePartMessage } from "./record-capture-part-message.js";

/** The execute ops the receipt reads: the join key and the title that was SENT. */
export interface CaptureFiledOp {
  tempId: string;
  title: string;
}

/** What execute returned, per path. */
export type CaptureFiledOutcomeInput =
  | {
      /** Applied: `created[]` echoes every row that became or linked a record. */
      kind: "applied";
      created: ReadonlyArray<CaptureAppliedEcho & { entityId: string }>;
      updated?: ReadonlyArray<CaptureUpdateResult>;
    }
  | {
      /**
       * Nothing was written; a review holds the rows. `proposalId` is the ONE
       * review that holds every non-update row, or `null` when the pod filed
       * several and cannot say which holds which.
       */
      kind: "proposed";
      proposalId: string | null;
      updated?: ReadonlyArray<CaptureUpdateResult>;
    };

/** The materializer's echo of one applied op, as execute returns it. */
export interface CaptureAppliedEcho {
  tempId: string;
  linked: boolean;
  /** The pod linked it through a strong identity match, not the caller's pick. */
  deduplicated?: true;
}

/**
 * What an applied row did — the ONE derivation behind both `created[].action`
 * on execute's response and the filed row's `outcome`. An applied patch
 * outranks the echo (the materializer LINKS an update op); a patch that did not
 * land leaves the row merely linked.
 */
export function captureRowAction(
  echo: Omit<CaptureAppliedEcho, "tempId">,
  update?: Pick<CaptureUpdateResult, "status">
): CaptureRowAction {
  if (update?.status === "applied") return "updated";
  if (!echo.linked) return "created";
  return echo.deduplicated ? "matched" : "linked";
}

const L = CAPTURE_RESULT_LIMITS;
const boundId = (v: string | null | undefined): string | null =>
  typeof v === "string" && v.length > 0
    ? v.slice(0, L.routingIdMaxChars)
    : null;

/**
 * Execute's outcome → one receipt row per accepted op. PURE.
 *
 * An update-arm entry outranks the materializer's echo for the same tempId
 * (the patch is what happened to it). An applied op the pod did not echo is
 * `failed` — never assumed filed.
 */
export function buildCaptureFiledRows(
  ops: ReadonlyArray<CaptureFiledOp>,
  outcome: CaptureFiledOutcomeInput
): { rows: CaptureFiledRow[]; truncated: boolean } {
  const updates = new Map(
    (outcome.updated ?? []).map((u) => [u.tempId, u] as const)
  );
  const created =
    outcome.kind === "applied"
      ? new Map(outcome.created.map((c) => [c.tempId, c] as const))
      : new Map<string, never>();
  const usable = ops.filter(
    (op) => typeof op.tempId === "string" && op.tempId.length > 0
  );
  const rows = usable.slice(0, L.rowsMax).map((op): CaptureFiledRow => {
    const title = (op.title?.trim() || "Untitled").slice(0, L.titleMaxChars);
    const base = { tempId: op.tempId.slice(0, 200), title };
    const update = updates.get(op.tempId);
    if (update) {
      if (update.status === "applied") {
        return {
          ...base,
          entityId: boundId(update.entityId),
          proposalId: null,
          outcome: captureRowAction({ linked: true }, update),
        };
      }
      if (update.status === "proposed") {
        // The record exists; the change to it waits for review.
        return {
          ...base,
          entityId: boundId(update.entityId),
          proposalId: boundId(update.proposalId),
          outcome: "proposed",
        };
      }
      return { ...base, entityId: null, proposalId: null, outcome: "failed" };
    }
    if (outcome.kind === "proposed") {
      return {
        ...base,
        entityId: null,
        proposalId: boundId(outcome.proposalId),
        outcome: "proposed",
      };
    }
    const hit = created.get(op.tempId);
    if (!hit) {
      return { ...base, entityId: null, proposalId: null, outcome: "failed" };
    }
    return {
      ...base,
      entityId: boundId(hit.entityId),
      proposalId: null,
      outcome: captureRowAction(hit),
    };
  });
  return { rows, truncated: usable.length > L.rowsMax };
}

/** The readable line the receipt message carries in the room. */
export function filedSummary(rows: ReadonlyArray<CaptureFiledRow>): string {
  const count = (pred: (r: CaptureFiledRow) => boolean) =>
    rows.filter(pred).length;
  const done = count((r) => r.outcome !== "proposed" && r.outcome !== "failed");
  const waiting = count((r) => r.outcome === "proposed");
  const failed = count((r) => r.outcome === "failed");
  const parts = [
    done > 0 ? `Filed ${done}` : null,
    waiting > 0 ? `${waiting} waiting for review` : null,
    failed > 0 ? `${failed} not filed` : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "Nothing filed";
}

/** The newest `capture_result` round in this room, or null when it holds none. */
async function latestResultRound(channelId: string): Promise<number | null> {
  const rows = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' = 'capture_result'`
      )
    )
    .orderBy(
      drizzleSql`(${messages.metadata} -> 'capturePart' ->> 'round')::int desc nulls last, ${messages.timestamp} desc, ${messages.id} desc`
    )
    .limit(1);
  const part = readCapturePart(rows[0]?.metadata);
  return part?.kind === "capture_result" ? part.round : null;
}

export interface PersistCaptureFiledInput {
  sessionId: string;
  userId: string;
  ops: ReadonlyArray<CaptureFiledOp>;
  outcome: CaptureFiledOutcomeInput;
  workspaceId: string | null;
  /** The project the rows were LINKED into — never an AI suggestion. */
  projectId: string | null;
  /** The result round the rows came from; absent ⇒ the room's newest. */
  round?: number;
  /** Execute's idempotency key: the same accept never posts twice. */
  idempotencyKey?: string;
}

export type PersistCaptureFiledResult =
  | { status: "written"; messageId: string; round: number; inserted: boolean }
  | { status: "skipped"; reason: "no_room" | "not_a_capture_room" };

/**
 * Write the receipt. Owner-floored (the session must be the caller's) and
 * idempotent on (session, round, idempotency key) — or on the receipt itself
 * when the caller sent no key, so an identical retry still inserts nothing.
 */
export async function persistCaptureFiled(
  input: PersistCaptureFiledInput
): Promise<PersistCaptureFiledResult> {
  const [session] = await db
    .select({ channelId: focusSessions.channelId })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, input.sessionId),
        eq(focusSessions.userId, input.userId)
      )
    )
    .limit(1);
  if (!session?.channelId) return { status: "skipped", reason: "no_room" };

  const resultRound = await latestResultRound(session.channelId);
  if (resultRound === null) {
    return { status: "skipped", reason: "not_a_capture_room" };
  }
  const round = input.round ?? resultRound;
  const { rows, truncated } = buildCaptureFiledRows(input.ops, input.outcome);

  const part: CaptureFiledPart = CaptureFiledPartSchema.parse({
    kind: "capture_filed",
    v: 1,
    sessionId: input.sessionId,
    round,
    rows,
    truncated,
    workspaceId: boundId(input.workspaceId),
    projectId: boundId(input.projectId),
  } satisfies CaptureFiledPart);

  const scope = input.idempotencyKey
    ? `key:${input.idempotencyKey}`
    : `part:${stableStringify(part)}`;
  const id = deterministicUuidFromKey(
    `capture_filed:${input.sessionId}:${round}:${scope}`
  );
  const { inserted } = await recordCapturePartMessage({
    id,
    channelId: session.channelId,
    userId: input.userId,
    role: "assistant",
    content: filedSummary(rows),
    part,
  });
  return { status: "written", messageId: id, round, inserted };
}
