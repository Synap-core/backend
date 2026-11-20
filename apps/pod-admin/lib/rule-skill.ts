/**
 * Is this skill a RULE? (founder, 19 Nov 2026, document b387ca45 §9). A rule
 * is a guideline, always / never, PUSHED into every piece of work in its
 * scope; a skill is know-how an agent PULLS when its task needs it. Both are
 * `skills` rows, so this one predicate decides where a row is listed: Rules,
 * never Tools. Every pod admin surface that lists skills reads it (Tools'
 * list, the Rules page, a skill's own page), so a rule cannot be a "Tool" on
 * one of them and a "Rule" on another.
 *
 * A skill is a rule when it carries ANY of:
 *   - `category: "rule"` — the store's mark (`services/rules`, `RULE_CATEGORY`);
 *   - `metadata.rule` — a rule-loop rule or a reaction rule (its intent,
 *     scope and lineage);
 *   - a slug in the `rules/` namespace — the rules agents are held to
 *     (`rules/ui-rules`, rendered into `.claude/rules/`). These were written
 *     as plain instruction skills with no category, which is how
 *     `rules/ui-rules` came to be listed as a Tool.
 *
 * Pure and structural: any row with these optional fields fits.
 */

/** The slug namespace of the rules agents are held to. */
export const RULES_SLUG_PREFIX = "rules/";

/** The `skills.category` of a rule (`RULE_CATEGORY` in `@synap/api`). */
export const RULE_CATEGORY = "rule";

export interface RuleSkillLike {
  category?: string | null;
  metadata?: unknown;
  slug?: string | null;
}

export function isRuleSkill(skill: RuleSkillLike): boolean {
  if (skill.category === RULE_CATEGORY) return true;
  const m = skill.metadata;
  if (
    typeof m === "object" &&
    m !== null &&
    (m as Record<string, unknown>).rule != null
  )
    return true;
  return (skill.slug ?? "").trim().startsWith(RULES_SLUG_PREFIX);
}
