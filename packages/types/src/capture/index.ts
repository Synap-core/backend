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
  ASK_LIMITS,
  ASK_REFUSED_FIELD_TYPES,
  AskFormValuesSchema,
  AskOptionSchema,
  atMostOneRecommended,
  DynamicFormSpecSchema,
  isRefusedAskFieldType,
} from "../ask/index.js";
import {
  CAPTURE_PROJECT_OUTCOMES,
  type CapturePlacement,
  type CaptureProjectOutcome,
} from "../capture-routing-types.js";

/**
 * The chip, form and answer-value schemas live in the shared ASK leaf
 * (`../ask`) — capture follow-ups and a session slot's ask are one contract.
 * Re-exported under their capture names so nothing downstream moves.
 */
export {
  atMostOneRecommended,
  DynamicFormFieldSchema,
  DynamicFormSpecSchema,
} from "../ask/index.js";

/** Bounds shared by every door that writes or reads a part. */
export const CAPTURE_PART_LIMITS = {
  questionMaxChars: 500,
  chipsMax: ASK_LIMITS.optionsMax,
  chipLabelMaxChars: ASK_LIMITS.optionLabelMaxChars,
  answerTextMaxChars: ASK_LIMITS.answerTextMaxChars,
  /** JSON-serialized form values, in UTF-8 bytes. */
  formValuesMaxBytes: ASK_LIMITS.formValuesMaxBytes,
  formFieldsMax: ASK_LIMITS.formFieldsMax,
  /** A chip's one-line imperative consequence ("→ creates a positioning note"). */
  chipDescriptionMaxChars: ASK_LIMITS.optionDescriptionMaxChars,
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

/**
 * A capture chip = the shared {@link AskOptionSchema} plus capture's own APPLY
 * fields (what choosing it does to the structured result). `value` is required
 * here: a capture chip is always applied by value.
 */
export const FollowUpChipSchema = AskOptionSchema.extend({
  value: z.string().max(500),
  action: z.enum(FOLLOW_UP_CHIP_ACTIONS),
  entityId: z.string().max(200).optional(),
  propertyKey: z.string().max(200).optional(),
});
export type CaptureFollowUpChip = z.infer<typeof FollowUpChipSchema>;

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
 * Field types an AI may NOT author on the capture wire — the ask leaf's
 * {@link ASK_REFUSED_FIELD_TYPES} (derived from the vault's sensitivity table;
 * see its docblock), under capture's name.
 */
export const CAPTURE_REFUSED_FIELD_TYPES: readonly string[] =
  ASK_REFUSED_FIELD_TYPES;

/** Is this authored `type` a credential prompt? (normalised, never exact-match) */
export const isRefusedCaptureFieldType: (type: unknown) => boolean =
  isRefusedAskFieldType;

export const CAPTURE_QUESTION_STATUSES = [
  "open",
  "answered",
  "skipped",
  "superseded",
] as const;
export type CaptureQuestionStatus = (typeof CAPTURE_QUESTION_STATUSES)[number];

/** The answer a person gives — also the input of `capture.answerFollowUp`. */
export const CaptureAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chip"), chip: FollowUpChipSchema }),
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(CAPTURE_PART_LIMITS.answerTextMaxChars),
  }),
  // Bounded at 8KB, then secret values redacted — the shared ask rule.
  z.object({ type: z.literal("form"), values: AskFormValuesSchema }),
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
  /** Entity properties a row may carry (bounded: parts live in message metadata). */
  propertiesMaxKeys: 16,
  /** A string property value, or the JSON.stringify length of a non-string one. */
  propertyValueMaxChars: 500,
  /** The long-form body a row may carry. */
  contentMaxChars: 2048,
  /** Whole serialised row; past it the writer drops properties/content first. */
  rowMaxBytes: 6144,
  /** Relations one part may carry (same budget as rows). */
  relationsMax: 40,
  relationTypeMaxChars: 200,
  /** A workspace / project id carried on the part's routing blocks. */
  routingIdMaxChars: 200,
  /** A workspace name on the placement block. */
  workspaceNameMaxChars: 200,
  /** The AI's reason for a workspace or project pick. */
  routingReasonMaxChars: 500,
  /** The proposed record's own one-line description (D10). */
  descriptionMaxChars: 280,
  /** Roles (facet profile slugs) a row proposes attaching (D10). */
  rolesMax: 6,
  /** Next steps the part offers before anything is filed (D6). */
  suggestionsMax: 6,
  /** A next step's one-line reason. */
  suggestionReasonMaxChars: 280,
  /** "Why?" rows on a placement suggestion — the contract says at most 3. */
  placementAlternativesMax: 3,
} as const;

/**
 * A property value on a result row: a scalar, or an array/object whose JSON
 * form fits `propertyValueMaxChars`. A too-big structure is DROPPED by the
 * writer, never cut mid-JSON.
 */
const ResultPropertyValueSchema = z.unknown().refine(
  (v) => {
    if (v === null || typeof v === "boolean" || typeof v === "number") {
      return true;
    }
    if (typeof v === "string") {
      return v.length <= CAPTURE_RESULT_LIMITS.propertyValueMaxChars;
    }
    if (typeof v !== "object") return false;
    try {
      return (
        JSON.stringify(v).length <= CAPTURE_RESULT_LIMITS.propertyValueMaxChars
      );
    } catch {
      return false;
    }
  },
  { message: "property value out of bounds" }
);

/** A row's decision label (D2), from the structurer's confidence. */
export const CAPTURE_ROW_LABELS = ["certain", "likely", "unsure"] as const;
export type CaptureRowLabel = (typeof CAPTURE_ROW_LABELS)[number];

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
  /**
   * The proposed entity's fields, so a client rebuilding the report from the
   * room can show/edit them. OPTIONAL: parts written before this field existed
   * still parse. Bounded + secret-keyed entries skipped by the writer.
   */
  properties: z
    .record(z.string().max(200), ResultPropertyValueSchema)
    .refine(
      (o) => Object.keys(o).length <= CAPTURE_RESULT_LIMITS.propertiesMaxKeys,
      { message: "too many properties" }
    )
    .optional(),
  /** The proposed entity's long-form body. OPTIONAL, same reason. */
  content: z.string().max(CAPTURE_RESULT_LIMITS.contentMaxChars).optional(),
  /**
   * The enriched decision for this row — the SAME vocabulary as the capture
   * pipeline's `autoDecideAction` (`CaptureProposal.action`). OPTIONAL and, as
   * of this change, WRITTEN BY NOBODY on the pod: the decision lives in the
   * client (`synap-app/packages/core/capture-pipeline/src/state.ts`), and a
   * pod-side copy would be a second rule. The field exists so a client that
   * owns the decision can persist it; readers must treat absence as "decide".
   */
  action: z.enum(["create", "update", "link"]).optional(),
  /** Dedup target when `action` is update/link. Same status as `action`. */
  existingEntityId: z.string().uuid().optional(),
  /**
   * The proposed record's own description (NOT the pod's reason — that is
   * `why`). Optional: absent = this part does not say.
   */
  description: z
    .string()
    .max(CAPTURE_RESULT_LIMITS.descriptionMaxChars)
    .optional(),
  /** Role profile slugs (facets) the row proposes attaching — client, investor… */
  roles: z
    .array(z.string().min(1).max(200))
    .max(CAPTURE_RESULT_LIMITS.rolesMax)
    .optional(),
  /** The structurer's confidence in this record, 0..1. */
  confidence: z.number().min(0).max(1).optional(),
  /**
   * How sure the structurer is the person wants this record: `certain` rows
   * are filed by "File all", `likely` ones need a tap, `unsure` ones fold.
   */
  label: z.enum(CAPTURE_ROW_LABELS).optional(),
  /**
   * The pod's top fuzzy duplicate for this row (D9): what it would UPDATE.
   * The client keeps the update-vs-create rule (`autoDecideAction`); this only
   * names the candidate. Absent = no candidate, or dedup did not run (`notice`).
   */
  candidate: z
    .object({
      entityId: z.string().min(1).max(CAPTURE_RESULT_LIMITS.routingIdMaxChars),
      title: z.string().max(CAPTURE_RESULT_LIMITS.titleMaxChars),
      score: z.number().min(0).max(1),
    })
    .optional(),
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
  "properties",
  "content",
  "action",
  "existingEntityId",
  "description",
  "roles",
  "confidence",
  "label",
  "candidate",
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

/** An edge between two rows of the part, by tempId (what `execute` takes). */
export const CaptureResultRelationSchema = z.object({
  sourceTempId: z.string().min(1).max(200),
  targetTempId: z.string().min(1).max(200),
  relationType: z
    .string()
    .min(1)
    .max(CAPTURE_RESULT_LIMITS.relationTypeMaxChars),
});
export type CaptureResultRelation = z.infer<typeof CaptureResultRelationSchema>;

/**
 * The AI's PROJECT pick for this structure run — the same four facts the
 * `capture.structure` response carries as `targetProjectId` /
 * `targetProjectReason` / `targetProjectConfidence` / `targetProjectOutcome`,
 * persisted so a reader of the room (relay) can show and forward them.
 * `outcome` is {@link CaptureProjectOutcome} — the ONE derivation
 * (`deriveCaptureProjectOutcome`), never re-decided by a reader. Forward `id`
 * to execute as the ADVISORY `aiProjectId`, never as the `projectId` pin.
 */
export const CaptureResultProjectSchema = z.object({
  id: z.string().min(1).max(CAPTURE_RESULT_LIMITS.routingIdMaxChars).nullable(),
  reason: z
    .string()
    .max(CAPTURE_RESULT_LIMITS.routingReasonMaxChars)
    .nullable(),
  confidence: z.number().finite().nullable(),
  outcome: z.enum(CAPTURE_PROJECT_OUTCOMES).nullable(),
});
export type CaptureResultProject = z.infer<typeof CaptureResultProjectSchema>;

/**
 * WHERE the capture will land — the response's `placement` block
 * ({@link CapturePlacement}, the destination SSOT that
 * `deriveWorkspacePlacementView` reads), mirrored field for field. The legacy
 * `targetWorkspace*` fields are deliberately NOT persisted: they mix the AI's
 * pick with a deterministic placement and exist only for older clients.
 */
export const CaptureResultPlacementSchema = z.object({
  workspaceId: z
    .string()
    .min(1)
    .max(CAPTURE_RESULT_LIMITS.routingIdMaxChars)
    .nullable(),
  workspaceName: z
    .string()
    .max(CAPTURE_RESULT_LIMITS.workspaceNameMaxChars)
    .nullable(),
  deterministic: z.boolean(),
  suggestion: z
    .object({
      workspaceId: z
        .string()
        .min(1)
        .max(CAPTURE_RESULT_LIMITS.routingIdMaxChars),
      workspaceName: z
        .string()
        .max(CAPTURE_RESULT_LIMITS.workspaceNameMaxChars),
      reason: z
        .string()
        .max(CAPTURE_RESULT_LIMITS.routingReasonMaxChars)
        .nullable(),
      alternatives: z
        .array(
          z.object({
            workspaceId: z
              .string()
              .min(1)
              .max(CAPTURE_RESULT_LIMITS.routingIdMaxChars),
            workspaceName: z
              .string()
              .max(CAPTURE_RESULT_LIMITS.workspaceNameMaxChars),
            weight: z.number().finite(),
          })
        )
        .max(CAPTURE_RESULT_LIMITS.placementAlternativesMax),
    })
    .optional(),
});
export type CaptureResultPlacement = z.infer<
  typeof CaptureResultPlacementSchema
>;

// The persisted blocks ARE the response's types — a drift either way stops
// the build (a field added to `CapturePlacement` must be added here too).
type _Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _placementSame: _Same<CaptureResultPlacement, CapturePlacement> = true;
const _outcomeSame: _Same<
  NonNullable<CaptureResultProject["outcome"]>,
  CaptureProjectOutcome
> = true;
void _placementSame;
void _outcomeSame;

/**
 * A next step the pod found for this capture BEFORE anything is filed (D6): a
 * playbook to run or a propose-mode rule to keep, matched from the row's kind +
 * the note (`playbooks.matchForEntity` / `automations.matchForEntity`).
 * `forTempId` names the row it needs filed first (`null` = it needs none).
 */
export const CaptureResultSuggestionSchema = z.object({
  kind: z.enum(["playbook", "rule"]),
  id: z.string().min(1).max(CAPTURE_RESULT_LIMITS.routingIdMaxChars),
  title: z.string().min(1).max(CAPTURE_RESULT_LIMITS.titleMaxChars),
  forTempId: z.string().min(1).max(200).nullable(),
  reason: z
    .string()
    .max(CAPTURE_RESULT_LIMITS.suggestionReasonMaxChars)
    .optional(),
});
export type CaptureResultSuggestion = z.infer<
  typeof CaptureResultSuggestionSchema
>;

export const CaptureResultPartSchema = z.object({
  kind: z.literal("capture_result"),
  v: z.literal(1),
  sessionId: z.string().uuid(),
  /** Which structuring round produced these rows. Matches the question's. */
  round: z.number().int().min(1),
  rows: z.array(CaptureResultRowSchema).max(CAPTURE_RESULT_LIMITS.rowsMax),
  /** Optional: parts written before this field existed still parse. */
  relations: z
    .array(CaptureResultRelationSchema)
    .max(CAPTURE_RESULT_LIMITS.relationsMax)
    .optional(),
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
  /**
   * The AI's project pick for this run. Optional AND nullable: parts written
   * before this field existed still parse. Absent is NOT
   * `outcome: "not_offered"` — absent means "this part does not say".
   */
  project: CaptureResultProjectSchema.nullable().optional(),
  /** Where the capture will land (`CapturePlacement`). Optional + nullable. */
  placement: CaptureResultPlacementSchema.nullable().optional(),
  /**
   * Next steps, ranked. ABSENT = not computed (an older pod, or the match read
   * failed); `[]` = computed, none found. Never conflate the two.
   */
  suggestions: z
    .array(CaptureResultSuggestionSchema)
    .max(CAPTURE_RESULT_LIMITS.suggestionsMax)
    .optional(),
});
export type CaptureResultPart = z.infer<typeof CaptureResultPartSchema>;

// ─── The FILED part: what accepting the rows did ────────────────────────────
//
// The result part says what the pod PROPOSED; this one says what `capture.execute`
// then DID with the rows a person accepted. Without it the "Filed" receipt lived
// only in the accepting device's local storage, so another device (or a
// reinstall) showed filed rows as still proposed, and an edited re-accept
// created a duplicate.
//
// Written by the pod only (`capture.execute`, one part per accept), into a room
// that already holds a `capture_result`. Execute's own response stays the
// caller's receipt; this is the room's copy of it.

/**
 * What an APPLIED row did: a new record, a patch to an existing one, a strong
 * identity match the pod resolved itself, or the record the person picked.
 * The same word on `capture.execute`'s `created[].action` and on a filed row.
 */
export const CAPTURE_ROW_ACTIONS = [
  "created",
  "updated",
  "matched",
  "linked",
] as const;
export type CaptureRowAction = (typeof CAPTURE_ROW_ACTIONS)[number];

export const CAPTURE_FILED_OUTCOMES = [
  ...CAPTURE_ROW_ACTIONS,
  "proposed",
  "failed",
] as const;
export type CaptureFiledOutcome = (typeof CAPTURE_FILED_OUTCOMES)[number];

export const CaptureFiledRowSchema = z.object({
  /** The result row's tempId — the join key back to `capture_result`. */
  tempId: z.string().min(1).max(200),
  /** The record the row became or touched. `null` when nothing exists yet. */
  entityId: z
    .string()
    .min(1)
    .max(CAPTURE_RESULT_LIMITS.routingIdMaxChars)
    .nullable(),
  /** The review that holds the row (`outcome: "proposed"`), when known. */
  proposalId: z
    .string()
    .min(1)
    .max(CAPTURE_RESULT_LIMITS.routingIdMaxChars)
    .nullable(),
  outcome: z.enum(CAPTURE_FILED_OUTCOMES),
  /** The title that was SENT (the person may have edited it). */
  title: z.string().min(1).max(CAPTURE_RESULT_LIMITS.titleMaxChars),
});
export type CaptureFiledRow = z.infer<typeof CaptureFiledRowSchema>;

export const CaptureFiledPartSchema = z.object({
  kind: z.literal("capture_filed"),
  v: z.literal(1),
  sessionId: z.string().uuid(),
  /** The `capture_result` round the accepted rows came from. */
  round: z.number().int().min(1),
  rows: z.array(CaptureFiledRowSchema).max(CAPTURE_RESULT_LIMITS.rowsMax),
  /** More rows were accepted than the part may carry — readers must say so. */
  truncated: z.boolean(),
  /** The workspace the rows were filed into (or proposed for). */
  workspaceId: z
    .string()
    .min(1)
    .max(CAPTURE_RESULT_LIMITS.routingIdMaxChars)
    .nullable(),
  /** The project the rows were LINKED into. `null` = none (an AI pick is never a link). */
  projectId: z
    .string()
    .min(1)
    .max(CAPTURE_RESULT_LIMITS.routingIdMaxChars)
    .nullable(),
});
export type CaptureFiledPart = z.infer<typeof CaptureFiledPartSchema>;

export const CaptureClarificationPartSchema = z.discriminatedUnion("kind", [
  CaptureFiledPartSchema,
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
export * from "./room-state.js";
export {
  isExplicitCapturePrefix,
  stripCapturePrefix,
} from "./capture-prefix.js";
