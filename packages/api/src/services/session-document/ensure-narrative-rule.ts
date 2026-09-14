/**
 * Seed the D10 rule: `document.session_narrative_update` → auto, for any
 * principal, pod-wide.
 *
 * WHY A RULE ROW AND NOT A CODE DEFAULT: founder decision D10 — an AI update to
 * a narrative section of its own session's document applies immediately
 * "through a governance rule, not a floor bypass". A row in `governance_rules`
 * is user-editable: a person can revoke it, scope a `propose` rule over it for
 * one workspace, or let it stand. `DEFAULT_AUTO_APPROVE` is code nobody can
 * edit.
 *
 * NON-RESURRECTING: the guard looks for ANY row (active OR revoked) for this
 * (principal, scope, target) — so a person who revoked the rule never finds it
 * back after a reboot. Diff-only through `filterUncoveredActions` like every
 * other seeder (`governance-floor-not-seeded` tripwire): if the code floor ever
 * absorbs this key, nothing is seeded.
 *
 * Idempotent, safe on every boot, serialized across racing boots by an
 * advisory transaction lock.
 */

import {
  db,
  and,
  eq,
  drizzleSql,
  governanceRules,
  filterUncoveredActions,
} from "@synap/database";
import {
  SESSION_NARRATIVE_EVENT_KEY,
  SESSION_NARRATIVE_RULE_CREATED_BY,
} from "./governance-keys.js";

const LOCK_KEY = "synap:session-narrative-rule";

export async function ensureSessionNarrativeRule(): Promise<{
  inserted: boolean;
}> {
  const [pattern] = filterUncoveredActions([SESSION_NARRATIVE_EVENT_KEY]);
  if (!pattern) return { inserted: false };

  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`
    );
    const [existing] = await tx
      .select({ id: governanceRules.id })
      .from(governanceRules)
      .where(
        and(
          eq(governanceRules.principalKind, "any"),
          eq(governanceRules.scopeKind, "pod"),
          eq(governanceRules.targetKind, "action"),
          eq(governanceRules.targetPattern, pattern)
        )
      )
      .limit(1);
    if (existing) return { inserted: false };

    await tx.insert(governanceRules).values({
      principalKind: "any",
      scopeKind: "pod",
      targetKind: "action",
      targetPattern: pattern,
      verdict: "auto",
      createdBy: SESSION_NARRATIVE_RULE_CREATED_BY,
    });
    return { inserted: true };
  });
}
