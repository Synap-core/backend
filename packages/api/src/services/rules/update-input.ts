/**
 * The ONE wire shape of a rule EDIT, and the ONE hop from that shape into
 * `updateRuleGoverned`.
 *
 * ── WHY THIS IS A MODULE AND NOT AN INLINE `z.object` ───────────────────────
 * A rule edit has two doors: `skills.updateRule` (the app's session door) and
 * Hub REST `PATCH /rules/:id` (the API-key door an agent reaches). The create
 * pair (`skills.createRule` / `POST /rules`) shows what a hand copy becomes: two
 * literal `z.object`s that agree today and have nothing making them agree
 * tomorrow. That is the fork class this codebase keeps paying for, so the edit
 * pair declares its fields ONCE and each door `.extend`s with only what is its
 * own (`id` on tRPC, the attribution fields on REST).
 * `update-input.parity.test.ts` pins that both doors hold these very schema
 * objects, by identity.
 *
 * The mapper exists for the same reason, one step later: `expiresAt` and
 * `sentence` each have THREE states (set / clear with `null` / absent = leave
 * alone), and the hop into the door is where a `?? undefined` or a truthiness
 * check silently collapses two of them. One implementation, two callers.
 */

import { z } from "zod";
import { ruleSentenceSchema } from "./sentence-schema.js";
import type { UpdateRuleGovernedInput } from "./update.js";

export const ruleEditFieldsSchema = z.object({
  intent: z.string().min(1),
  scope: z.object({
    kind: z.enum(["pod", "workspace", "user"]),
    workspaceId: z.string().uuid().optional(),
    /** Cross-cutting project lens — composes with the workspace lens. */
    projectId: z.string().uuid().optional(),
  }),
  /**
   * THREE states, deliberately: an ISO instant SETS the review date, `null`
   * CLEARS it, and ABSENT leaves it alone. `renewRule` already distinguishes
   * set-from-clear for the same reason — they are different acts and must be
   * spelled differently — and this door adds the third because an edit that
   * only changes the sentence must not silently strip an expiry the author
   * never mentioned.
   */
  expiresAt: z.string().datetime({ offset: true }).nullish(),
  factSkillId: z.string().uuid().optional(),
  automationIds: z.array(z.string().uuid()).default([]),
  /**
   * THREE states again: a sentence REPLACES the behaviour, `null` REMOVES it,
   * ABSENT leaves the stored one alone (and it is recompiled). The middle state
   * has to be spellable — without it, "make this rule prose-only" would be
   * unexpressible; without the third, editing the prose alone would retire the
   * automation.
   */
  sentence: ruleSentenceSchema.nullish(),
  /** `true` keeps/returns the rule to draft; `false` ACTIVATES it. */
  draft: z.boolean().default(false),
});

export type RuleEditFields = z.infer<typeof ruleEditFieldsSchema>;

/**
 * The edit's fields as `updateRuleGoverned` takes them. Identity, lens and
 * audit source stay with each door — they are the door's, not the edit's.
 */
export function ruleEditToGovernedInput(
  input: RuleEditFields
): Pick<
  UpdateRuleGovernedInput,
  | "intent"
  | "scope"
  | "expiresAt"
  | "factSkillId"
  | "automationIds"
  | "sentence"
  | "draft"
> {
  return {
    intent: input.intent,
    scope: input.scope,
    // `undefined` (absent) and `null` (clear) must both survive the hop — a
    // `?? undefined` here would turn "clear the date" into "leave it".
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.factSkillId ? { factSkillId: input.factSkillId } : {}),
    automationIds: input.automationIds,
    // `undefined` (leave alone) and `null` (remove) must BOTH survive the hop
    // — a truthiness check here would collapse them into one.
    ...(input.sentence !== undefined ? { sentence: input.sentence } : {}),
    ...(input.draft ? { draft: true } : {}),
  };
}
