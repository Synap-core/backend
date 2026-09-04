/**
 * The WIRE schema for a rule's structured sentence.
 *
 * ── Why a schema at all ─────────────────────────────────────────────────────
 * `RuleSentenceValue` is the editor's in-memory value-model, and it arrives at
 * the rule door across THREE untrusted boundaries: a tRPC input, a stored
 * proposal payload replayed at approval, and (later) Hub REST. Every one of
 * those is `unknown` at runtime. `compileRuleSentence` is a pure function over
 * a TYPED sentence — hand it a half-parsed blob and it produces a plausible
 * automation out of garbage, which is the failure mode this whole wave exists
 * to stop.
 *
 * ── Why this is not a hand-maintained mirror ────────────────────────────────
 * TWO mechanisms, because one is not enough and the gap between them was a real
 * hole this file's own header used to paper over.
 *
 * 1. `ruleSentenceSchema: z.ZodType<RuleSentenceValue>` catches a new or removed
 *    FIELD — "Property 'x' is missing in type … but required in type" — so the
 *    object shape cannot drift.
 *
 * 2. It does NOT catch a widened UNION, and the earlier version of this comment
 *    claimed it did. Measured against this repo's zod: a schema whose enum is
 *    NARROWER than the type is still assignable to `z.ZodType<T>` (the output
 *    type sits in a covariant position), and `tsc` exits 0. So adding
 *    `"send_email"` to `ActionType` would typecheck green here while every rule
 *    using it was refused at the door as "the rule sentence did not match the
 *    expected shape" — the wrong cause, permanently, which is worse than a
 *    crash. The `AssertExact` guards at the bottom of this file close that:
 *    they resolve to `never` on drift in EITHER direction, so the `: true`
 *    assignment fails `tsc`. Same guard, same reason, as
 *    `services/automations/validate-flow.ts:156`.
 *
 * Keep BOTH. Do not relax the annotation to `z.ZodType<unknown>`, and do not
 * delete an `AssertExact` line because "the annotation already covers it" — it
 * does not, and that assumption is exactly what was wrong here before.
 */

import { z } from "zod";
import type {
  ConditionRow,
  RuleSentenceValue,
  SentenceAction,
  SentenceTrigger,
} from "@synap-core/types/automations";

const actionTypeSchema = z.enum([
  "notify",
  "update_entity",
  "create_entity",
  "run_command",
  "post_message",
  "call_webhook",
]);

const actionVerbSchema = z.enum([
  "created",
  "updated",
  "deleted",
  "received",
  "completed",
  "approved",
  "rejected",
]);

const subjectCategorySchema = z.enum([
  "entity",
  "external_message",
  "capture",
  "notification",
  "feed_item",
  "inbox_item",
]);

const cronFrequencySchema = z.enum([
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "custom",
]);

const conditionOperatorSchema = z.enum([
  "is",
  "is_not",
  "contains",
  "starts_with",
  "greater_than",
  "less_than",
  "changed_to",
  "is_true",
  "is_false",
]);

const conditionRowSchema = z.object({
  id: z.string(),
  key: z.string(),
  operator: conditionOperatorSchema,
  value: z.string(),
});

const sentenceTriggerSchema = z.object({
  triggerType: z.enum(["event", "cron"]),
  // event
  subjectCategory: subjectCategorySchema.optional(),
  profileSlug: z.string().optional(),
  actionVerb: actionVerbSchema.optional(),
  conditions: z.array(conditionRowSchema).optional(),
  // cron
  cronFrequency: cronFrequencySchema.optional(),
  cronTime: z.string().optional(),
  cronDays: z.array(z.number()).optional(),
  cronDayOfMonth: z.number().optional(),
  cronTimezone: z.string().optional(),
});

const sentenceActionSchema = z.object({
  type: actionTypeSchema.nullable(),
  // Deliberately open: a THEN action's `config` is per-action-type and is
  // validated by the flow-node contract (`validateFlowDefinition`) once the
  // compiler has turned it into a node — not twice, in two vocabularies.
  config: z.record(z.string(), z.unknown()),
});

/**
 * Bound to `RuleSentenceValue` at compile time — see the file header. The
 * annotation is the drift guard; removing it removes the guarantee.
 */
export const ruleSentenceSchema: z.ZodType<RuleSentenceValue> = z.object({
  trigger: sentenceTriggerSchema.nullable(),
  conditions: z.array(conditionRowSchema),
  actions: z.array(sentenceActionSchema),
});

// ── Union parity: the half `z.ZodType<RuleSentenceValue>` cannot see ────────
// Each resolves to `never` if the schema's enum and the shared union disagree in
// EITHER direction, so the `: true` assignment fails to compile. Teaching the
// grammar a new member therefore fails HERE, loudly, instead of silently turning
// every rule using it into an unparseable sentence.
type AssertExact<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _actionTypesInSync: AssertExact<
  NonNullable<z.infer<typeof actionTypeSchema>>,
  NonNullable<SentenceAction["type"]>
> = true;
const _actionVerbsInSync: AssertExact<
  NonNullable<z.infer<typeof actionVerbSchema>>,
  NonNullable<SentenceTrigger["actionVerb"]>
> = true;
const _subjectCategoriesInSync: AssertExact<
  NonNullable<z.infer<typeof subjectCategorySchema>>,
  NonNullable<SentenceTrigger["subjectCategory"]>
> = true;
const _conditionOperatorsInSync: AssertExact<
  z.infer<typeof conditionOperatorSchema>,
  ConditionRow["operator"]
> = true;
const _cronFrequenciesInSync: AssertExact<
  NonNullable<z.infer<typeof cronFrequencySchema>>,
  NonNullable<SentenceTrigger["cronFrequency"]>
> = true;
void _actionTypesInSync;
void _actionVerbsInSync;
void _subjectCategoriesInSync;
void _conditionOperatorsInSync;
void _cronFrequenciesInSync;

/**
 * Parse a sentence off an UNTRUSTED blob (a stored proposal payload, a REST
 * body). Returns null when the value is absent or not a sentence — the caller
 * decides whether absence is legitimate (a prose-only `fact` rule) or a
 * refusal (a behavioural rule with nothing to compile).
 *
 * Never throws: a stored blob is DATA, and a read door that throws on a
 * hand-edited payload is a read door that can be bricked.
 */
export function readRuleSentence(raw: unknown): RuleSentenceValue | null {
  if (raw === undefined || raw === null) return null;
  const parsed = ruleSentenceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
