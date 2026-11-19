/**
 * The Rules page's rules (founder, 19 Nov 2026, document b387ca45 §9), pure:
 * which skills are rules (`isRuleSkill`, the one predicate Tools reads too),
 * where each one is pushed (its scope), and how the one filter row narrows
 * them. A rule is a guideline pushed into every piece of work in its scope;
 * its "when" is that scope, never an event. A rule that came with an
 * automation (the rule loop) shows the automation as a second, linked object.
 */

import { isRuleSkill, type RuleSkillLike } from "../../../../lib/rule-skill";

/** The `skills.list` fields this page reads (structural). */
export interface RuleSourceLike extends RuleSkillLike {
  id: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  approved: boolean;
  /** `pod` (everyone's) · `user` (one person's) · `workspace` (one space's). */
  scope?: string | null;
  workspaceId?: string | null;
}

export interface RuleRow {
  id: string;
  name: string;
  /** The ref agents load it by (`rules/ui-rules`), when it has one. */
  slug: string | null;
  description: string | null;
  scope: "pod" | "user" | "workspace";
  workspaceId: string | null;
  approved: boolean;
}

function scopeOf(s: RuleSourceLike): RuleRow["scope"] {
  if (s.scope === "user" || s.scope === "workspace") return s.scope;
  return s.workspaceId ? "workspace" : "pod";
}

/** Every rule among the skills, in the read's order (newest first). */
export function rulesOf(skills: readonly RuleSourceLike[]): RuleRow[] {
  return skills.filter(isRuleSkill).map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug?.trim() || null,
    description: s.description?.trim() || null,
    scope: scopeOf(s),
    workspaceId: s.workspaceId ?? null,
    approved: s.approved,
  }));
}

/** The scope filter's value of a row: "pod", "user", or the space's id. */
export function ruleScopeKey(row: Pick<RuleRow, "scope" | "workspaceId">) {
  if (row.scope === "workspace" && row.workspaceId) return row.workspaceId;
  return row.scope === "user" ? "user" : "pod";
}

/** Does the row match the search? Every word in its name, slug or description. */
export function ruleMatchesSearch(row: RuleRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [row.name, row.slug ?? "", row.description ?? ""]
    .join("\n")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * The automations a rule came with, by rule id, from `skills.listRules`
 * (the `activates` edge, read by the pod). A rule with none is absent.
 */
export function automationsByRule(
  rules: ReadonlyArray<{ id: string; automationIds?: readonly string[] }>
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const r of rules)
    if (r.automationIds && r.automationIds.length > 0)
      out.set(r.id, r.automationIds);
  return out;
}
