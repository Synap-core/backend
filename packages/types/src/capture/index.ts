/**
 * Capture clarification — the ONE contract for a capture follow-up question and
 * its answer, persisted as a message part in the capture session's room
 * (`messages.metadata.capturePart`). "One conversation, two views": the capture
 * sheet and the session room render the SAME rows.
 *
 * Owned by the pod's capture door (`capture.structure` persists the question,
 * `capture.answerFollowUp` records the answer). Clients read it through
 * `readCapturePart`; `@synap-core/capture-pipeline` mirrors it structurally and
 * tests sameness against `__fixtures__/capture-part.golden.json`.
 *
 * Pure and dependency-free apart from zod. Refine inputs (the text, previous
 * entities, …) are NEVER part of a message — they stay server-only on the
 * session (`metadata.intake.clarification`).
 */

import { z } from "zod";

/** Bounds shared by every door that writes or reads a part. */
export const CAPTURE_PART_LIMITS = {
  questionMaxChars: 500,
  chipsMax: 8,
  chipLabelMaxChars: 80,
  answerTextMaxChars: 2000,
  /** JSON-serialized form values, in UTF-8 bytes. */
  formValuesMaxBytes: 8 * 1024,
  formFieldsMax: 20,
  /** A chip's one-line imperative consequence ("→ creates a positioning note"). */
  chipDescriptionMaxChars: 140,
  /** A question's one-line WHY (what answering changes). */
  whyMaxChars: 200,
} as const;

export const FOLLOW_UP_CHIP_ACTIONS = [
  "link_entity",
  "set_property",
  "add_relation",
  "confirm",
  "dismiss",
] as const;

export const FollowUpChipSchema = z.object({
  label: z.string().min(1).max(CAPTURE_PART_LIMITS.chipLabelMaxChars),
  value: z.string().max(500),
  action: z.enum(FOLLOW_UP_CHIP_ACTIONS),
  icon: z.string().max(64).optional(),
  entityId: z.string().max(200).optional(),
  propertyKey: z.string().max(200).optional(),
  /** The AI's recommended answer — at most ONE per question. */
  recommended: z.boolean().optional(),
  /** One-line imperative consequence of choosing this answer. */
  description: z
    .string()
    .max(CAPTURE_PART_LIMITS.chipDescriptionMaxChars)
    .optional(),
});
export type CaptureFollowUpChip = z.infer<typeof FollowUpChipSchema>;

/** True when no more than one chip is marked `recommended`. */
export function atMostOneRecommended(
  chips: ReadonlyArray<{ recommended?: boolean }>
): boolean {
  return chips.filter((c) => c.recommended === true).length <= 1;
}

export const DynamicFormFieldSchema = z.object({
  key: z.string().min(1).max(200),
  label: z.string().max(200),
  type: z.string().max(64),
  constraints: z
    .object({
      enum: z.array(z.string()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
    })
    .optional(),
  required: z.boolean().optional(),
  help: z.string().optional(),
});

export const DynamicFormSpecSchema = z.object({
  title: z.string().optional(),
  note: z.string().optional(),
  fields: z
    .array(DynamicFormFieldSchema)
    .max(CAPTURE_PART_LIMITS.formFieldsMax),
});

export const CAPTURE_QUESTION_STATUSES = [
  "open",
  "answered",
  "skipped",
  "superseded",
] as const;
export type CaptureQuestionStatus = (typeof CAPTURE_QUESTION_STATUSES)[number];

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The answer a person gives — also the input of `capture.answerFollowUp`. */
export const CaptureAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chip"), chip: FollowUpChipSchema }),
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(CAPTURE_PART_LIMITS.answerTextMaxChars),
  }),
  z.object({
    type: z.literal("form"),
    values: z
      .record(z.string(), z.unknown())
      .refine(
        (v) =>
          utf8Bytes(JSON.stringify(v)) <=
          CAPTURE_PART_LIMITS.formValuesMaxBytes,
        { message: "form values exceed 8KB serialized" }
      ),
  }),
  z.object({ type: z.literal("skip") }),
]);
export type CaptureAnswer = z.infer<typeof CaptureAnswerSchema>;

export const CaptureQuestionPartSchema = z.object({
  kind: z.literal("capture_question"),
  v: z.literal(1),
  sessionId: z.string().uuid(),
  round: z.number().int().min(1),
  question: z.string().min(1).max(CAPTURE_PART_LIMITS.questionMaxChars),
  /** One line: what answering changes. */
  why: z.string().min(1).max(CAPTURE_PART_LIMITS.whyMaxChars).optional(),
  // "At most one recommended" is a CONTRACT rule enforced here (a reader
  // rejects a part that breaks it); writers NORMALIZE before persisting.
  chips: z
    .array(FollowUpChipSchema)
    .max(CAPTURE_PART_LIMITS.chipsMax)
    .refine(atMostOneRecommended, {
      message: "at most one chip may be recommended",
    }),
  /** Enrichment only — not rendered as a gate in v1. */
  formSpec: DynamicFormSpecSchema.optional(),
  partialCount: z.number().int().min(0),
  status: z.enum(CAPTURE_QUESTION_STATUSES),
  resolvedByMessageId: z.string().uuid().nullable().optional(),
});
export type CaptureQuestionPart = z.infer<typeof CaptureQuestionPartSchema>;

export const CaptureAnswerPartSchema = z.object({
  kind: z.literal("capture_answer"),
  v: z.literal(1),
  sessionId: z.string().uuid(),
  questionMessageId: z.string().uuid(),
  answer: CaptureAnswerSchema,
});
export type CaptureAnswerPart = z.infer<typeof CaptureAnswerPartSchema>;

export const CaptureClarificationPartSchema = z.discriminatedUnion("kind", [
  CaptureQuestionPartSchema,
  CaptureAnswerPartSchema,
]);
export type CaptureClarificationPart = z.infer<
  typeof CaptureClarificationPartSchema
>;

/**
 * The part on a message's metadata, or null when there is none OR it does not
 * satisfy the contract (a malformed part never renders as a question).
 */
export function readCapturePart(
  metadata: unknown
): CaptureClarificationPart | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as { capturePart?: unknown }).capturePart;
  if (raw === undefined || raw === null) return null;
  const parsed = CaptureClarificationPartSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export * from "./progress.js";
