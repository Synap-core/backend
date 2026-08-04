/**
 * Diff-only materialization for the ONE governance-rules store (Governance
 * Convergence Plan, D2): the `DEFAULT_AUTO_APPROVE` whitelist is the CODE FLOOR
 * (decideAgentPolicy rung 8), NOT a set of rows to seed. A `governance_rules`
 * row that merely restates a floor pattern changes NO enforcement outcome for a
 * normal-governance agent (rung 8 already auto-approves it) — it is pure flood.
 *
 * Both the boot backfill (`backfill-governance-rules.ts`) and the write-mirror
 * (`syncAutoApproveRules`) run their incoming action lists through
 * {@link filterUncoveredActions} so a floor-equal pattern is NEVER inserted as a
 * rule. Only GENUINE widenings — action patterns the floor does not already
 * cover (e.g. `channel.create`, `relation.update`, `playbook.create`,
 * `tool.create`, `skill.create`, or a broad glob like `entity.*` / `*`) — become
 * rows. Capability/profile-target rules are unaffected (this only concerns
 * `target_kind: "action"` patterns).
 *
 * "Covered" reuses the ENGINE's own glob matcher (`matchesActionPattern`, the
 * same one every `autoApproveFor` check uses) so it means exactly what rung 8
 * means at decision time — no re-implemented glob semantics to drift.
 */

import {
  DEFAULT_AUTO_APPROVE,
  matchesActionPattern,
} from "@synap/governance-policy";

/**
 * True if an action pattern is ALREADY covered by the `DEFAULT_AUTO_APPROVE`
 * code floor — an exact member (`entity.create`) OR matched by a floor glob
 * (`search.*` covers `search.entities`; the floor glob `search.*` also covers
 * the identical incoming glob `search.*`, since `"search.*".startsWith("search.")`).
 *
 * Passing the pattern itself as the `eventKey` to `matchesActionPattern` is
 * deliberate and correct for every case that occurs here:
 *   - a concrete key subsumed by a floor member/glob → covered (filtered out);
 *   - a floor-equal glob (`search.*`, `context.*`) → covered (filtered out);
 *   - a broader glob than the floor (`entity.*`, `*`) → matches NOTHING in the
 *     floor → NOT covered → kept as a genuine widening rule.
 */
export function isFloorCoveredAction(
  pattern: string,
  floor: readonly string[] = DEFAULT_AUTO_APPROVE
): boolean {
  return matchesActionPattern(pattern, floor);
}

/**
 * The subset of `patterns` NOT already covered by the code floor — i.e. the
 * GENUINE widenings worth materializing as `governance_rules` rows. Non-string /
 * empty entries are dropped (defence-in-depth; callers already pre-validate).
 * Order-preserving, does not de-duplicate (callers handle uniqueness).
 */
export function filterUncoveredActions(
  patterns: readonly string[],
  floor: readonly string[] = DEFAULT_AUTO_APPROVE
): string[] {
  return patterns.filter(
    (p): p is string =>
      typeof p === "string" && p.length > 0 && !isFloorCoveredAction(p, floor)
  );
}
