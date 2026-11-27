/**
 * Is this skill a RULE? (founder, 19 Nov 2026, document b387ca45 §9). A rule
 * is a guideline, always / never, PUSHED into every piece of work in its
 * scope; a skill is know-how an agent PULLS when its task needs it. Both are
 * `skills` rows, so this one predicate decides what a row is called: Rule,
 * never Tool. Every surface that lists or names skills reads it (pod admin's
 * Tools list, its Rules page, a skill's own page, and the pod's proposal
 * titles), so a rule cannot be a "Tool" on one of them and a "Rule" on
 * another.
 *
 * Moved here from pod admin (`apps/pod-admin/lib/rule-skill.ts`, 27 Nov 2026):
 * a rule edit was filed as "Update Tool" (proposal 0a641510) because the pod's
 * proposal titles could not reach a predicate that lived only in pod admin.
 *
 * A skill is a rule when it carries ANY of:
 *   - `category: "rule"` — the store's mark (`services/rules`);
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

/** The `skills.category` of a rule (decision D1: one store, `skills`). */
export const RULE_CATEGORY = "rule" as const;

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

/**
 * The object kind a skill row is named as, for the noun door
 * (`resolveObjectNoun`): `"rule"` ("Rule") for a rule, else `"skill"`
 * ("Tool", founder D2).
 */
export function skillObjectKind(skill: RuleSkillLike): "rule" | "skill" {
  return isRuleSkill(skill) ? "rule" : "skill";
}

/**
 * The name a sentence quotes a skill by. A rule kept under `rules/<ref>` is
 * called by its ref (`work-units`), the name agents load it by and the one
 * its rendered file carries; its stored `name` is often a machine token
 * (`rules_work_units`) that the title door drops, which left the founder
 * reading a bare "Update Tool". Any other skill: its name.
 */
export function skillTitleName(
  skill: RuleSkillLike & { name?: string | null }
): string | undefined {
  const slug = (skill.slug ?? "").trim();
  if (slug.startsWith(RULES_SLUG_PREFIX)) {
    const ref = slug.slice(RULES_SLUG_PREFIX.length).trim();
    if (ref) return ref;
  }
  const name = (skill.name ?? "").trim();
  return name || undefined;
}
