/**
 * Capture clarification — the pod half of "one conversation, two views".
 *
 * `capture.structure` persists a follow-up QUESTION into the session's room
 * (`persistCaptureQuestion`); `capture.answerFollowUp` claims it and records the
 * ANSWER (`claimCaptureQuestion`), then re-runs structure through the same
 * procedure. The contract is `@synap-core/types/capture`.
 *
 * Why the session room (`ensureSessionChannel`) and not a RUN channel: it is
 * the session's one room, a GROUP with `aiReactionMode = only_mentioned` (free
 * text never wakes an agent unless it @-mentions one on the roster), and its
 * visibility is roster-only (`channelVisibilityWhere`). A question/answer part
 * never wakes an agent at all — `triggerAutoRespond` refuses `capturePart`
 * whatever the room type, pinned in `trigger-auto-respond.capture-part.pglite`.
 *
 * Status moves only by COMPARE-AND-SET on `capturePart.status = 'open'`, so two
 * answers can never both win and an answer never resolves a superseded
 * question. Refine inputs stay SERVER-ONLY on the session
 * (`metadata.intake.clarification`) — never in a message a client could edit.
 *
 * No agent turn and no proposal: every insert goes through
 * `recordCapturePartMessage`.
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
  CAPTURE_PART_LIMITS,
  CaptureQuestionPartSchema,
  readCapturePart,
  redactSecretValues,
  type CaptureAnswer,
  type CaptureAnswerPart,
  type CaptureFollowUpChip,
  type CaptureQuestionPart,
} from "@synap-core/types/capture";
import { ensureSessionChannel } from "../focus-sessions/ensure-session-channel.js";
import { deterministicUuidFromKey } from "../../utils/write-door-idempotency.js";
import { stableStringify } from "../../utils/stable-stringify.js";
import { recordCapturePartMessage } from "./record-capture-part-message.js";
import {
  readIntakeClarification,
  rememberIntakeClarification,
  type IntakeClarificationRefine,
} from "./ensure-intake-session.js";

/** Appended to a skip's re-run; a residual followUp is then dropped. */
export const SKIP_FOLLOW_UP_INSTRUCTION =
  "Do not ask a follow-up; proceed with the best interpretation";

export function captureQuestionMessageId(sessionId: string, round: number) {
  return deterministicUuidFromKey(`capture_question:${sessionId}:${round}`);
}

export function captureAnswerMessageId(questionMessageId: string) {
  return deterministicUuidFromKey(`capture_answer:${questionMessageId}`);
}

// ── Context serialisers ────────────────────────────────────────────────────
// MIRRORS of `@synap-core/capture-pipeline` (`chipToContext` in followup.ts,
// `formValuesToContext` from useStructureCapture's submitForm). synap-backend
// cannot depend on a synap-app source package, so the pod keeps a copy and
// `__tests__/capture-clarification-serialisers.test.ts` pins the exact outputs
// both sides produce. Change BOTH or neither.

export function chipToContext(chip: CaptureFollowUpChip): string {
  const parts: string[] = [chip.action];
  if (chip.entityId) parts.push(`entityId=${chip.entityId}`);
  if (chip.propertyKey) parts.push(`propertyKey=${chip.propertyKey}`);
  const answer = `Answer: ${chip.label} (${parts.join(", ")})`;
  return typeof chip.description === "string" && chip.description !== ""
    ? `${answer} — ${chip.description}`
    : answer;
}

/**
 * Prefix an answer body with the question it answers, so the ONE re-run knows
 * what was asked. A blank / absent question leaves the body byte-identical; an
 * empty body is still prefixed (no special case). Mirrors
 * `answerContextWithQuestion` in capture-pipeline's `clarification.ts`.
 */
export function answerContextWithQuestion(
  question: string | undefined | null,
  body: string
): string {
  return typeof question === "string" && question.trim() !== ""
    ? `Question: ${question}\n${body}`
    : body;
}

export function formValuesToContext(values: Record<string, unknown>): string {
  return Object.entries(redactSecretValues(values))
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(
      ([k, v]) =>
        `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`
    )
    .join("; ");
}

/**
 * The refine context an answer contributes, prefixed with the question it
 * answers (chip / text / form alike); `null` for a skip, whose instruction
 * stands alone.
 */
export function answerToContext(
  answer: CaptureAnswer,
  question?: string | null
): string | null {
  switch (answer.type) {
    case "chip":
      return answerContextWithQuestion(question, chipToContext(answer.chip));
    case "text":
      return answerContextWithQuestion(question, answer.text);
    case "form":
      return answerContextWithQuestion(
        question,
        formValuesToContext(answer.values)
      );
    case "skip":
      return null;
  }
}

/** The readable line an answer message carries in the room. */
export function answerSummary(answer: CaptureAnswer): string {
  switch (answer.type) {
    case "chip":
      return answer.chip.label;
    case "text":
      return answer.text;
    case "form":
      return formValuesToContext(answer.values) || "Form submitted";
    case "skip":
      return "Skipped";
  }
}

/**
 * Whether a structure result's followUp is ASKED (persisted, dedup skipped) or
 * dropped. A skip re-run suppresses it so the capture continues to dedup.
 */
export function followUpIsAsked(
  followUp: unknown,
  suppressFollowUp: boolean | undefined
): boolean {
  return Boolean(followUp) && suppressFollowUp !== true;
}

// ── (a) persist the question ───────────────────────────────────────────────

type FollowUpInput =
  | string
  | {
      question: string;
      why?: string | null;
      suggestions?: CaptureFollowUpChip[] | null;
    };

/**
 * The IS follow-up NORMALIZED to the part contract, so a persist never fails
 * on the model's output: bounds truncated, blank `why`/`description` dropped,
 * and at most ONE `recommended` chip — the first one marked; later flags are
 * removed. (The IS normalizes the same way; `CaptureQuestionPartSchema`
 * REJECTS a part with two, so this is what keeps persistence total.)
 */
export function questionFromFollowUp(followUp: FollowUpInput): {
  question: string;
  why?: string;
  chips: CaptureFollowUpChip[];
} {
  const raw =
    typeof followUp === "string"
      ? { question: followUp, suggestions: [] }
      : followUp;
  let recommendedTaken = false;
  const why =
    typeof raw.why === "string"
      ? raw.why.trim().slice(0, CAPTURE_PART_LIMITS.whyMaxChars)
      : "";
  return {
    question: raw.question.slice(0, CAPTURE_PART_LIMITS.questionMaxChars),
    ...(why ? { why } : {}),
    chips: (raw.suggestions ?? [])
      .slice(0, CAPTURE_PART_LIMITS.chipsMax)
      .map(({ recommended, description, ...c }) => {
        const keep = recommended === true && !recommendedTaken;
        if (keep) recommendedTaken = true;
        const desc = description
          ?.trim()
          .slice(0, CAPTURE_PART_LIMITS.chipDescriptionMaxChars);
        return {
          ...c,
          label: c.label.slice(0, CAPTURE_PART_LIMITS.chipLabelMaxChars),
          ...(keep ? { recommended: true } : {}),
          ...(desc ? { description: desc } : {}),
        };
      }),
  };
}

/** A question in this room was already ANSWERED or SKIPPED (one per capture). */
async function roomHasAnsweredQuestion(channelId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' = 'capture_question'`,
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'status' IN ('answered', 'skipped')`
      )
    )
    .limit(1);
  return Boolean(row);
}

/**
 * ONE QUESTION PER CAPTURE: true when the caller's session already had its
 * question answered or skipped. `capture.structure` reads it BEFORE the
 * followUp branch so a later followUp is dropped and the capture still reaches
 * dedup. Owner-floored; an unknown / foreign session is `false` (nothing asked).
 */
export async function captureClarificationAnswered(args: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const [session] = await db
    .select({ channelId: focusSessions.channelId })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  return session?.channelId
    ? roomHasAnsweredQuestion(session.channelId)
    : false;
}

export interface PersistCaptureQuestionInput {
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
  followUp: FollowUpInput;
  formSpec?: unknown;
  partialCount: number;
  refine: IntakeClarificationRefine;
}

export type PersistCaptureQuestionResult =
  | {
      status: "persisted";
      followUpMessageId: string;
      channelId: string;
      round: number;
    }
  | { status: "refused"; reason: "already_answered"; channelId: string };

export async function persistCaptureQuestion(
  input: PersistCaptureQuestionInput
): Promise<PersistCaptureQuestionResult> {
  const channelId = await ensureSessionChannel({
    sessionId: input.sessionId,
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
  });
  if (!channelId) {
    throw new Error("capture question: the session has no room");
  }

  // Defense in depth for ONE QUESTION PER CAPTURE: once this run's question was
  // answered or skipped, no later question is persisted (an unanswered open
  // question can still be superseded by a re-structure).
  if (await roomHasAnsweredQuestion(channelId)) {
    return { status: "refused", reason: "already_answered", channelId };
  }

  const [{ n: asked } = { n: 0 }] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' = 'capture_question'`
      )
    );
  const round = Number(asked) + 1;
  const id = captureQuestionMessageId(input.sessionId, round);

  const { question, why, chips } = questionFromFollowUp(input.followUp);
  const formSpec = CaptureQuestionPartSchema.shape.formSpec.safeParse(
    input.formSpec ?? undefined
  );
  const part: CaptureQuestionPart = CaptureQuestionPartSchema.parse({
    kind: "capture_question",
    v: 1,
    sessionId: input.sessionId,
    round,
    question,
    ...(why ? { why } : {}),
    chips,
    ...(formSpec.success && formSpec.data ? { formSpec: formSpec.data } : {}),
    partialCount: input.partialCount,
    status: "open",
    resolvedByMessageId: null,
  });

  // Supersede whatever is still open in this room (compare-and-set).
  await db
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(jsonb_set(${messages.metadata}, '{capturePart,status}', '"superseded"'::jsonb), '{capturePart,resolvedByMessageId}', to_jsonb(${id}::text))`,
    })
    .where(
      and(
        eq(messages.channelId, channelId),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' = 'capture_question'`,
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'status' = 'open'`,
        drizzleSql`${messages.id} <> ${id}::uuid`
      )
    );

  await recordCapturePartMessage({
    id,
    channelId,
    userId: input.userId,
    role: "assistant",
    content: question,
    part,
  });

  await rememberIntakeClarification({
    sessionId: input.sessionId,
    userId: input.userId,
    clarification: { questionMessageId: id, round, refine: input.refine },
  });

  return { status: "persisted", followUpMessageId: id, channelId, round };
}

// ── (b) claim a question with an answer ────────────────────────────────────

export interface ClaimCaptureQuestionResult {
  /** `retry` = the same answer already claimed it; the re-run continues. */
  outcome: "claimed" | "retry";
  answerMessageId: string;
  channelId: string;
  /** The stored refine inputs, plus the CLAIMED question's text. */
  refine: RestructureRefine;
}

/**
 * What a re-run is built from: the server-only refine inputs stored on the
 * session, plus the question that was actually answered (read from the claimed
 * question row, never stored or client-supplied) so the re-run's context names
 * what was asked.
 */
export type RestructureRefine = IntakeClarificationRefine & {
  question?: string | null;
};

function notFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Question not found" });
}

/**
 * CONFLICT with a machine-readable status: the cause is an `Error` (tRPC keeps
 * it as-is) carrying `captureQuestionStatus`, which the pod's `errorFormatter`
 * (`init-trpc.ts`) projects to `error.data.captureQuestionStatus`.
 */
function conflict(status: string, message: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message,
    cause: Object.assign(new Error(message), { captureQuestionStatus: status }),
  });
}

export async function claimCaptureQuestion(input: {
  userId: string;
  sessionId: string;
  questionMessageId: string;
  answer: CaptureAnswer;
}): Promise<ClaimCaptureQuestionResult> {
  // 1. Authorize — every miss is the same NOT_FOUND (no existence oracle).
  const [session] = await db
    .select({
      channelId: focusSessions.channelId,
      metadata: focusSessions.metadata,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, input.sessionId),
        eq(focusSessions.userId, input.userId)
      )
    )
    .limit(1);
  if (!session?.channelId) notFound();
  const channelId = session.channelId;

  const loadQuestion = async () => {
    const [row] = await db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.questionMessageId),
          eq(messages.channelId, channelId),
          isNull(messages.deletedAt)
        )
      )
      .limit(1);
    const part = readCapturePart(row?.metadata);
    return part?.kind === "capture_question" &&
      part.sessionId === input.sessionId
      ? part
      : null;
  };
  const question = await loadQuestion();
  if (!question) notFound();

  const clarification = readIntakeClarification(session.metadata);
  if (clarification?.questionMessageId !== input.questionMessageId) {
    // Refine inputs belong to a newer question (or were never stored).
    if (question.status !== "open") {
      conflict(question.status, `Question is ${question.status}`);
    }
    notFound();
  }

  const answerMessageId = captureAnswerMessageId(input.questionMessageId);
  const nextStatus = input.answer.type === "skip" ? "skipped" : "answered";

  // 2. Compare-and-set open → answered | skipped.
  const claimed = await db
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(jsonb_set(${messages.metadata}, '{capturePart,status}', to_jsonb(${nextStatus}::text)), '{capturePart,resolvedByMessageId}', to_jsonb(${answerMessageId}::text))`,
    })
    .where(
      and(
        eq(messages.id, input.questionMessageId),
        eq(messages.channelId, channelId),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'status' = 'open'`
      )
    )
    .returning({ id: messages.id });

  let outcome: ClaimCaptureQuestionResult["outcome"] = "claimed";
  if (claimed.length === 0) {
    const current = await loadQuestion();
    const [prior] = await db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, answerMessageId))
      .limit(1);
    const priorAnswer = readCapturePart(prior?.metadata);
    const sameAnswer =
      !prior ||
      (priorAnswer?.kind === "capture_answer" &&
        stableStringify(priorAnswer.answer) === stableStringify(input.answer));
    const isRetry =
      current?.status === nextStatus &&
      current.resolvedByMessageId === answerMessageId &&
      sameAnswer;
    if (!isRetry) {
      const status = current?.status ?? "unknown";
      conflict(status, `Question is already ${status}`);
    }
    outcome = "retry";
  }

  // 3. The answer message (idempotent on its deterministic id).
  const answerPart: CaptureAnswerPart = {
    kind: "capture_answer",
    v: 1,
    sessionId: input.sessionId,
    questionMessageId: input.questionMessageId,
    answer: input.answer,
  };
  await recordCapturePartMessage({
    id: answerMessageId,
    channelId,
    userId: input.userId,
    role: "user",
    content: answerSummary(input.answer),
    part: answerPart,
  });

  return {
    outcome,
    answerMessageId,
    channelId,
    refine: { ...clarification.refine, question: question.question },
  };
}

/**
 * The structure input a claimed answer re-runs with (§2b step 4-5, §2d).
 * ONE QUESTION PER CAPTURE: every answer type — chip, text, form, skip — sets
 * `suppressFollowUp`, so the re-run can never ask again (the original text is
 * re-sent and would otherwise re-trigger the same question).
 */
export function restructureInput(
  refine: RestructureRefine,
  answer: CaptureAnswer,
  sessionId: string
) {
  const answerContext = answerToContext(answer, refine.question);
  const context =
    [refine.context, answerContext]
      .filter((s): s is string => !!s)
      .join("\n") || undefined;
  const instructions =
    answer.type === "skip"
      ? [refine.instructions, SKIP_FOLLOW_UP_INSTRUCTION]
          .filter((s): s is string => !!s)
          .join("\n")
      : refine.instructions;
  return {
    ...(refine.text !== undefined ? { text: refine.text } : {}),
    ...(refine.url ? { url: refine.url } : {}),
    ...(refine.anchorEntityId ? { anchorEntityId: refine.anchorEntityId } : {}),
    ...(refine.previousEntities?.length
      ? { previousEntities: refine.previousEntities }
      : {}),
    ...(context ? { context } : {}),
    ...(instructions ? { instructions } : {}),
    sessionId,
    suppressFollowUp: true as const,
  };
}
