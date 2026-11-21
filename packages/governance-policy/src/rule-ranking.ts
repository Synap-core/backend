/**
 * THE ranking of approval rows (`governance_rules`) for a tool run: which row
 * decides when several match. One spelling, read by the resolver the gate
 * runs (`resolveGovernanceRule`, `@synap/database`), by the pod-wide action
 * mode read (`readActionModes`, the API) and by pod admin's tool page. A
 * reader that ranked rows its own way would show a verdict the gate does not
 * apply: `readActionModes` broke an auto/asks-first tie toward "runs on its
 * own" while the gate asked first (finding ac28928c).
 *
 * A row's rank is the sum of how specific it is (decision b387ca45, D2/D3):
 *   - WHO: one agent 2 > a class of agents 1 > every AI 0;
 *   - WHERE: a space 2 > the whole pod 0;
 *   - WHAT: one action 3 > the whole tool (its container) 2.
 * The highest rank decides. On a tie the STRICTER verdict wins, whatever the
 * age: never > asks first > runs on its own. Pure: no I/O, safe in a browser.
 */

export type RuleVerdict = "auto" | "propose" | "deny";
export type RulePrincipalKind = "agent" | "class" | "any";
export type RuleScopeKind = "workspace" | "pod";

/** How specific a row's principal is: one agent 2, a class 1, every AI 0. */
export function principalSpecificity(principalKind: RulePrincipalKind): number {
  return principalKind === "agent" ? 2 : principalKind === "class" ? 1 : 0;
}

/** How specific a row's place is: a space 2, the whole pod 0. */
export function scopeSpecificity(scopeKind: RuleScopeKind | string): number {
  return scopeKind === "workspace" ? 2 : 0;
}

/**
 * How specific a capability row's target is: a row naming the ACTION (its
 * verb name or its row id) outranks a row naming the TOOL it is a member of.
 */
export const CAPABILITY_TARGET_SPECIFICITY = {
  action: 3,
  tool: 2,
} as const;
export type CapabilityTargetLevel = keyof typeof CAPABILITY_TARGET_SPECIFICITY;

/** Ask before run, refuse before ask: the stricter verdict wins a tool run's tie. */
export function verdictStrictness(verdict: RuleVerdict): number {
  return verdict === "deny" ? 2 : verdict === "propose" ? 1 : 0;
}

/** A capability row's rank: who + where + what. */
export function capabilityRuleRank(
  rule: { principalKind: RulePrincipalKind; scopeKind: RuleScopeKind | string },
  target: CapabilityTargetLevel
): number {
  return (
    principalSpecificity(rule.principalKind) +
    scopeSpecificity(rule.scopeKind) +
    CAPABILITY_TARGET_SPECIFICITY[target]
  );
}

/**
 * The row that decides a tool run among rows that match it, each with its
 * rank: the highest rank, and on a tie the stricter verdict. `undefined` when
 * none matches (a tool run then asks first).
 */
export function decidingCapabilityRule<R extends { verdict: RuleVerdict }>(
  candidates: ReadonlyArray<{ rule: R; rank: number }>
): R | undefined {
  let best: { rule: R; rank: number } | undefined;
  for (const c of candidates) {
    if (
      !best ||
      c.rank > best.rank ||
      (c.rank === best.rank &&
        verdictStrictness(c.rule.verdict) >
          verdictStrictness(best.rule.verdict))
    )
      best = c;
  }
  return best?.rule;
}
