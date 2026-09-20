/**
 * Capture RESULT part — the pod half of "the report is a projection".
 *
 * `capture.structure` used to hand its rows back to the CALLER and nowhere
 * else. `useAnswerFollowUp`'s own docblock says it plainly — "the sheet applies
 * it, a room can ignore it" — so answering a follow-up from the session room
 * threw the refined result away, and nothing could get it back: the capture
 * router is all writes with no read door. This file persists that result as a
 * message part in the session's room, so both views read ONE fact.
 *
 * ONE WRITER. `persistCaptureResult` is called from exactly one place — the
 * terminal (post-dedup) return of `capture.structure`. That is deliberate and
 * it was VERIFIED rather than assumed: `capture.answerFollowUp` delegates to
 * `structure` with `suppressFollowUp: true`, so a re-run after an answer can
 * never take the followUp branch and always lands on the terminal return. A
 * write placed next to `persistCaptureQuestion` would therefore have covered
 * the QUESTION path only — i.e. everything except the refined result that is
 * the whole point.
 *
 * The follow-up path writes NO result part on purpose: its rows are partial by
 * definition and the question part already reports how many (`partialCount`).
 *
 * Contract + bounds: `@synap-core/types/capture`
 * (`CaptureResultPartSchema`, `CAPTURE_RESULT_LIMITS`).
 */

import { TRPCError } from "@trpc/server";
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
  CaptureResultPartSchema,
  readCapturePart,
  type CaptureResultPart,
  type CaptureResultRow,
} from "@synap-core/types/capture";
import { createLogger } from "@synap-core/core";
import { ensureSessionChannel } from "../focus-sessions/ensure-session-channel.js";
import { deterministicUuidFromKey } from "../../utils/write-door-idempotency.js";
import { stableStringify } from "../../utils/stable-stringify.js";
import { recordCapturePartMessage } from "./record-capture-part-message.js";

const logger = createLogger({ module: "intake/capture-result-part" });

/**
 * The sentence a reader needs when the pod could not run dedup (Typesense down
 * or a search threw). Without it `updatesExisting: false` on every row reads as
 * "all new" — an EMPTY dedup result and a FAILED one are different facts.
 */
export const DEDUP_SKIPPED_NOTICE =
  "Duplicate check did not run, so some of these may already exist.";

/** The proposal fields the projection reads. Nothing else is needed or taken. */
export interface CaptureResultProposal {
  tempId: string;
  profileSlug?: string | null;
  title?: string | null;
}

/**
 * Project structure proposals onto the part's rows. PURE — no db, no clock.
 *
 * `truncated` is REPORTED, never applied in silence: past `rowsMax` the extra
 * rows are dropped and the flag says so, because "4 things" when there were
 * fifty is a calm, confident, wrong screen.
 *
 * `why` is always `null` today and that is not an oversight: no per-row reason
 * exists anywhere on the structure wire (`IntelligenceHubClient.structure`'s
 * entity carries tempId/profileSlug/title/description/properties/confidence/
 * facets and no reason). `description` is the entity's own description, not the
 * pod's reason for proposing it, so using it would INVENT one. The field stays
 * on the contract for when the IS emits a real reason.
 */
export function projectCaptureResultRows(input: {
  proposals: ReadonlyArray<CaptureResultProposal>;
  /** tempIds the pod's own dedup matched to an existing record. */
  matchedTempIds: ReadonlySet<string>;
  /** tempIds the user had already dismissed on an earlier part (carried over). */
  dismissedTempIds: ReadonlySet<string>;
}): { rows: CaptureResultRow[]; truncated: boolean } {
  const usable = input.proposals.filter(
    (p) => typeof p.tempId === "string" && p.tempId.length > 0
  );
  const rows = usable.slice(0, CAPTURE_RESULT_LIMITS.rowsMax).map((p) => ({
    tempId: p.tempId.slice(0, 200),
    profileSlug: (p.profileSlug || "item").slice(0, 200),
    title: (p.title || "Untitled").slice(
      0,
      CAPTURE_RESULT_LIMITS.titleMaxChars
    ),
    why: null,
    updatesExisting: input.matchedTempIds.has(p.tempId),
    dismissed: input.dismissedTempIds.has(p.tempId),
  }));
  return { rows, truncated: usable.length > CAPTURE_RESULT_LIMITS.rowsMax };
}

/** The readable line the result message carries in the room. */
export function resultSummary(rowCount: number, truncated: boolean): string {
  const n = `${rowCount} record${rowCount === 1 ? "" : "s"}`;
  return truncated ? `Structured ${n} (more were found)` : `Structured ${n}`;
}

/**
 * How many clarification questions this room has asked. The result's `round`
 * is derived from the SAME count `persistCaptureQuestion` uses (which adds one
 * because it is about to insert), so a result written after round-N's answer
 * carries round N. A run that never asked has no question and still needs a
 * round ≥ 1 by contract, hence the floor.
 */
async function captureRound(channelId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' = 'capture_question'`
      )
    );
  return Math.max(1, Number(n));
}

/** The newest result part in a room, with the message id that holds it. */
async function latestResult(
  channelId: string
): Promise<{ id: string; part: CaptureResultPart } | null> {
  const rows = await db
    .select({ id: messages.id, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' = 'capture_result'`
      )
    )
    .orderBy(drizzleSql`${messages.timestamp} desc, ${messages.id} desc`)
    .limit(1);
  const part = readCapturePart(rows[0]?.metadata);
  return part?.kind === "capture_result" && rows[0]
    ? { id: rows[0].id, part }
    : null;
}

export interface PersistCaptureResultInput {
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
  proposals: ReadonlyArray<CaptureResultProposal>;
  /** Pod dedup output, keyed by tempId — the ONLY matched-ness signal here. */
  dedupCandidates: Record<string, ReadonlyArray<unknown>>;
  /** True when a dedup search threw: "not checked", never "no duplicates". */
  dedupSkipped: boolean;
}

export interface PersistedCaptureResult {
  messageId: string;
  channelId: string;
  round: number;
}

/**
 * Persist the structure result into the session's room. Idempotent: the message
 * id is derived from the part itself, so an identical re-run inserts nothing
 * and a changed re-run appends a new, newest part.
 *
 * Dismissals are CARRIED FORWARD by `tempId` (the contract calls that stability
 * load-bearing): re-structuring must not silently re-tick a row the user had
 * unticked.
 */
export async function persistCaptureResult(
  input: PersistCaptureResultInput
): Promise<PersistedCaptureResult> {
  const channelId = await ensureSessionChannel({
    sessionId: input.sessionId,
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
  });
  if (!channelId) throw new Error("capture result: the session has no room");

  const round = await captureRound(channelId);
  const previous = await latestResult(channelId);
  const dismissedTempIds = new Set(
    (previous?.part.rows ?? []).filter((r) => r.dismissed).map((r) => r.tempId)
  );
  // A SKIPPED dedup is not an empty one: claim nothing, and say so in `notice`.
  const matchedTempIds = new Set(
    input.dedupSkipped
      ? []
      : Object.entries(input.dedupCandidates)
          .filter(([, c]) => Array.isArray(c) && c.length > 0)
          .map(([tempId]) => tempId)
  );

  const { rows, truncated } = projectCaptureResultRows({
    proposals: input.proposals,
    matchedTempIds,
    dismissedTempIds,
  });

  const part: CaptureResultPart = CaptureResultPartSchema.parse({
    kind: "capture_result",
    v: 1,
    sessionId: input.sessionId,
    round,
    rows,
    truncated,
    notice: input.dedupSkipped ? DEDUP_SKIPPED_NOTICE : null,
  } satisfies CaptureResultPart);

  const id = deterministicUuidFromKey(
    `capture_result:${input.sessionId}:${stableStringify(part)}`
  );
  await recordCapturePartMessage({
    id,
    channelId,
    userId: input.userId,
    role: "assistant",
    content: resultSummary(rows.length, truncated),
    part,
  });
  return { messageId: id, channelId, round };
}

// ── dismiss / restore one row ──────────────────────────────────────────────

function notFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Result row not found" });
}

export interface DismissCaptureResultRowResult {
  messageId: string;
  round: number;
  tempId: string;
  dismissed: boolean;
  /** False when the row was already in the requested state (idempotent no-op). */
  changed: boolean;
}

/**
 * Toggle one row's `dismissed` on the room's NEWEST result part.
 *
 * Owner-floored exactly like `claimCaptureQuestion`: the session is loaded
 * `WHERE userId = ctx.userId`, and every miss — foreign session, no room, no
 * result part, no such row — is the same NOT_FOUND, so the door is never an
 * existence oracle. Idempotent, and the write is a compare-and-set on the whole
 * part so two concurrent dismissals cannot lose one another.
 */
export async function dismissCaptureResultRow(input: {
  userId: string;
  sessionId: string;
  tempId: string;
  dismissed: boolean;
}): Promise<DismissCaptureResultRowResult> {
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
  if (!session?.channelId) notFound();

  const current = await latestResult(session.channelId);
  if (!current) notFound();
  const target = current.part.rows.find((r) => r.tempId === input.tempId);
  if (!target) notFound();

  const done = (changed: boolean): DismissCaptureResultRowResult => ({
    messageId: current.id,
    round: current.part.round,
    tempId: input.tempId,
    dismissed: input.dismissed,
    changed,
  });
  if (target.dismissed === input.dismissed) return done(false);

  const next: CaptureResultPart = {
    ...current.part,
    rows: current.part.rows.map((r) =>
      r.tempId === input.tempId ? { ...r, dismissed: input.dismissed } : r
    ),
  };
  const updated = await db
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(${messages.metadata}, '{capturePart}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, current.id),
        drizzleSql`${messages.metadata} -> 'capturePart' = ${JSON.stringify(current.part)}::jsonb`
      )
    )
    .returning({ id: messages.id });

  if (updated.length === 0) {
    // Someone else wrote the part between our read and our CAS. If the row
    // already reads the way the caller asked, that IS the outcome; otherwise
    // say so rather than pretending.
    const after = await latestResult(session.channelId);
    const row = after?.part.rows.find((r) => r.tempId === input.tempId);
    if (row?.dismissed === input.dismissed) return done(false);
    logger.warn(
      { userId: input.userId, sessionId: input.sessionId },
      "capture.dismissResultRow: the result part changed under the compare-and-set"
    );
    throw new TRPCError({
      code: "CONFLICT",
      message: "The result changed — reload and try again",
    });
  }
  return done(true);
}
