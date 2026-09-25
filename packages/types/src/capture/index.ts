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
import {
  cleanFieldKey,
  isSensitiveField,
  redactSecretValues,
  SECRET_TYPE_FIELDS,
} from "../vault/index.js";

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

/**
 * The secret-form-value rule (the tagged `{kind:"new"|"existing"}` shape and
 * its redaction) lives in ONE zero-import home, `@synap-core/types/vault`, so
 * the pod, the property renderer, the capture pipeline and relay all apply the
 * same rule. Re-exported here because the answer schema below applies it at
 * parse time and callers of this leaf expect it beside the schema.
 */
export {
  REDACTED_SECRET,
  redactSecretValues,
  isSecretFieldValue,
  isSecretValueEmpty,
} from "../vault/index.js";
export type { SecretFieldValue } from "../vault/index.js";

/**
 * Field types an AI may NOT author on the capture wire.
 *
 * Credential prompts come from a capability MANIFEST
 * (`installParamsToFormSpec`, client-side), never from a model, and a value
 * typed into a room message is persisted into `messages.metadata.capturePart`
 * and fed back as refine context. `type` is a FREE STRING here, which is the
 * whole reason a dropped-set exists — but the set held only `"secret"`, so an
 * AI that wrote `type: "password"` got a masked credential prompt anyway, with
 * the same consequence. The other spellings a model reaches for are here too.
 *
 * Deliberately a DROPPED-SET and not a strict enum: `type` stays open so a new
 * NON-credential type (`"date"`, `"slider"`, whatever a future spec adds) keeps
 * working without a release. Only credential-ish types are refused.
 *
 * Matched case-insensitively, `-`/`_`/space-insensitively, so `"API_KEY"`,
 * `"api-key"` and `"apiKey"` are one entry, not three.
 *
 * ## DERIVED, not hand-written (round-2 review)
 *
 * The hand list missed `secret-key`, `apisecret`, `sshkey`, `totp`/`otp`,
 * `pin`, `cvv`, `cardnumber` and `connectionstring` — and there was nothing to
 * stop the next spelling being missed too. `@synap-core/types/vault` already
 * owns the sensitivity table: every `!`-prefixed key in `SECRET_TYPE_FIELDS`
 * is, by that module's own definition, a credential. So a field name the vault
 * calls sensitive joins this set BY EXISTING.
 */

/** Lowercase, `-`/`_`/space-insensitive. The ONE normalisation for this set. */
function normaliseFieldType(type: string): string {
  return type.toLowerCase().replace(/[-_\s]+/g, "");
}

/**
 * The two `!`-fields that are too GENERIC to refuse as a form `type`.
 *
 * `env_variable: ["key", "!value", …]` makes `value` sensitive as a vault FIELD
 * (it is the variable's content) — but a capture field of type `"value"` is
 * ordinary, and refusing it would silently drop legitimate forms. Same for
 * `note`'s `content`. Sensitivity is contextual in the vault; the context does
 * not survive the move to a form-field type, so these two are named and
 * excluded rather than quietly inherited.
 */
const NOT_A_CREDENTIAL_TYPE = new Set(["value", "content"]);

/**
 * Spellings a MODEL reaches for that are not vault field names: form-only
 * synonyms and the bare stems of compound `!`-fields (`cardCvv` → `cvv`).
 * Small, explicit, and the only hand-maintained part.
 */
const CAPTURE_EXTRA_REFUSED_TYPES = [
  "secret",
  "secretkey",
  "token",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "apikey",
  "apisecret",
  "sshkey",
  "passwd",
  "credential",
  "credentials",
  "otp",
  "pin",
  "cvv",
] as const;

/** Every `!`-prefixed key in the vault's sensitivity table, normalised. */
const VAULT_SENSITIVE_TYPES = Object.values(SECRET_TYPE_FIELDS)
  .flat()
  .filter(isSensitiveField)
  .map((f) => normaliseFieldType(cleanFieldKey(f)))
  .filter((f) => !NOT_A_CREDENTIAL_TYPE.has(f));

export const CAPTURE_REFUSED_FIELD_TYPES: readonly string[] = [
  ...new Set([...VAULT_SENSITIVE_TYPES, ...CAPTURE_EXTRA_REFUSED_TYPES]),
];

const refusedTypes = new Set<string>(CAPTURE_REFUSED_FIELD_TYPES);

/** Is this authored `type` a credential prompt? (normalised, never exact-match) */
export function isRefusedCaptureFieldType(type: unknown): boolean {
  if (typeof type !== "string") return false;
  return refusedTypes.has(normaliseFieldType(type));
}

export const DynamicFormSpecSchema = z.object({
  title: z.string().optional(),
  note: z.string().optional(),
  // Credential-ish fields are DROPPED, never persisted. See
  // `CAPTURE_REFUSED_FIELD_TYPES` for why the set is a set and not just
  // `"secret"`, and why `type` stays an open string.
  fields: z
    .array(DynamicFormFieldSchema)
    .max(CAPTURE_PART_LIMITS.formFieldsMax)
    .transform((fields) =>
      fields.filter((f) => !isRefusedCaptureFieldType(f.type))
    ),
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
      )
      // AFTER the size bound (measured on the original, so an oversized payload
      // cannot become acceptable by being redacted) and BEFORE it is persisted
      // into `messages.metadata.capturePart`, where a plaintext key would sit
      // in a JSONB column, readable by every agent, for the life of the row.
      .transform((v) => redactSecretValues(v)),
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

// ─── The RESULT part: what structuring produced ─────────────────────────────
//
// WHY THIS EXISTS. "One conversation, two views" (see the header) was true for
// the QUESTION and the ANSWER and false for the thing that matters — the rows
// structuring produced. Those lived only in the caller that triggered the run:
// `useAnswerFollowUp`'s own docblock says it plainly, "the sheet applies it, a
// room can ignore it". So answering in the room threw the refined result away,
// and nothing could recover it: the capture router is all writes
// (`structure`, `execute`, `answerFollowUp`, …) with NO read door.
//
// Persisting the result as a PART — not as a column on the session — is what
// makes the report a projection rather than a second copy: both views already
// read the room, `messages.metadata` is already JSONB (so no migration), and a
// result genuinely IS something the AI said in the conversation.
//
// ⚠️ THIS IS A PROJECTION, DELIBERATELY. A raw structure response carries dedup
// candidates, a workspace decision and a follow-up; a message part must stay
// bounded (that is what CAPTURE_PART_LIMITS is for). So the part carries the
// fields a REPORT needs and nothing else, `PROJECTED_RESULT_ROW_FIELDS` records
// that choice in the type system, and the row bound is reported rather than
// applied in silence — see `truncated`.

export const CAPTURE_RESULT_LIMITS = {
  /** Rows one part may carry. Past this, `truncated` says so. */
  rowsMax: 40,
  titleMaxChars: 300,
  /** The one-line WHY under a row — same budget as a question's. */
  whyMaxChars: 200,
  noticeMaxChars: 500,
} as const;

export const CaptureResultRowSchema = z.object({
  /**
   * STABLE ACROSS ROUNDS, and that is load-bearing: a follow-up chip addresses
   * a proposal by this id (`applyDismissChip` matches `p.tempId ===
   * chip.entityId`), so a user's dismissal survives a re-structure. Without
   * that stability, answering a question in the room would silently re-tick
   * every row the user had unticked.
   */
  tempId: z.string().min(1).max(200),
  profileSlug: z.string().min(1).max(200),
  title: z.string().min(1).max(CAPTURE_RESULT_LIMITS.titleMaxChars),
  /** The pod's reason. `null` when it gave none — never an invented one. */
  why: z.string().max(CAPTURE_RESULT_LIMITS.whyMaxChars).nullable(),
  /** True when this UPDATES an existing record rather than creating one. */
  updatesExisting: z.boolean(),
  /**
   * The user dropped this row.
   *
   * On the PART rather than in client state, because that is the whole point:
   * untick on the report and the room sees it; dismiss in the room and the
   * report sees it. One fact, one home.
   */
  dismissed: z.boolean(),
});
export type CaptureResultRow = z.infer<typeof CaptureResultRowSchema>;

/**
 * Every field the part projects, DERIVED from the row type.
 *
 * A projection in this repo has silently dropped fields twice, so the set is
 * classified in the type system instead of being remembered: a new key on
 * `CaptureResultRow` that is listed in neither array makes `_RowClassified`
 * resolve to `never` and STOPS THE BUILD.
 */
export const PROJECTED_RESULT_ROW_FIELDS = [
  "tempId",
  "profileSlug",
  "title",
  "why",
  "updatesExisting",
  "dismissed",
] as const satisfies ReadonlyArray<keyof CaptureResultRow>;

/** Withheld from the part, each with its reason — never merely forgotten. */
export const WITHHELD_RESULT_ROW_FIELDS = {} as const satisfies Partial<
  Record<keyof CaptureResultRow, string>
>;

type _RowClassified =
  Exclude<
    keyof CaptureResultRow,
    (typeof PROJECTED_RESULT_ROW_FIELDS)[number]
  > extends keyof typeof WITHHELD_RESULT_ROW_FIELDS
    ? true
    : never;
const _rowClassified: _RowClassified = true;
void _rowClassified;

export const CaptureResultPartSchema = z.object({
  kind: z.literal("capture_result"),
  v: z.literal(1),
  sessionId: z.string().uuid(),
  /** Which structuring round produced these rows. Matches the question's. */
  round: z.number().int().min(1),
  rows: z.array(CaptureResultRowSchema).max(CAPTURE_RESULT_LIMITS.rowsMax),
  /**
   * The pod produced MORE rows than the part may carry.
   *
   * An empty result and a bounded one are different facts. A reader that
   * cannot tell them apart shows "4 things" when there were fifty — a calm,
   * confident, wrong screen. Writers set this; readers must surface it.
   */
  truncated: z.boolean(),
  /** A sentence the pod said that the user needs (a degraded pass). */
  notice: z.string().max(CAPTURE_RESULT_LIMITS.noticeMaxChars).nullable(),
});
export type CaptureResultPart = z.infer<typeof CaptureResultPartSchema>;

export const CaptureClarificationPartSchema = z.discriminatedUnion("kind", [
  CaptureResultPartSchema,
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
export {
  isExplicitCapturePrefix,
  stripCapturePrefix,
} from "./capture-prefix.js";
