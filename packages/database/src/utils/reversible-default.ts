/**
 * The POD DEFAULT "agents act directly on easily-reversible writes" —
 * founder decision 2026-09-28.
 *
 * NOT a second store and NOT a second engine: the setting IS one row in
 * `governance_rules` — principal `any`, scope `pod`, target `action`, pattern
 * `@reversible` (`REVERSIBLE_CLASS_PATTERN`), verdict `auto`. Rung 2.8 of
 * `decideAgentPolicy` consumes it like any rule, so:
 *   - every floor (admin, human gate, schema, structure, forcePropose,
 *     destructive, untrusted origin, daily ceiling) still returns first;
 *   - any MORE specific rule (an agent's own, a workspace's, an exact action)
 *     outranks it — the class ranks like a glob;
 *   - an anonymous write never matches it (`resolveGovernanceRule`).
 *
 * ON  = an active row exists. OFF = every such row revoked. Migration 0282
 * seeds it once per pod; switching it off leaves a revoked row, which is what
 * stops the seed from ever switching it back on.
 */

import { and, eq, isNull } from "drizzle-orm";
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
import { governanceRules } from "../schema/governance-rules.js";
import { authoredCreatedBy } from "./governance-rule-provenance.js";

type DbHandle = typeof import("../client-pg.js").db;

/** `created_by` of the seeded row (machine namespace — see governance-rule-provenance). */
export const REVERSIBLE_DEFAULT_CREATED_BY = "system:reversible-default";

const podDefaultRow = and(
  eq(governanceRules.principalKind, "any"),
  eq(governanceRules.scopeKind, "pod"),
  eq(governanceRules.targetKind, "action"),
  eq(governanceRules.targetPattern, REVERSIBLE_CLASS_PATTERN),
  isNull(governanceRules.revokedAt)
);

export interface ReversibleDefaultState {
  enabled: boolean;
  /** The active row, so a surface can open it; null when off. */
  ruleId: string | null;
}

export async function readReversibleDefault(
  db: DbHandle
): Promise<ReversibleDefaultState> {
  const [row] = await db
    .select({ id: governanceRules.id, verdict: governanceRules.verdict })
    .from(governanceRules)
    .where(podDefaultRow)
    .limit(1);
  // A `propose` row on the class is not "on" — it would only tighten.
  const on = row !== undefined && row.verdict === "auto";
  return { enabled: on, ruleId: on ? row.id : null };
}

/**
 * Switch the pod default. Idempotent. The caller authorizes (pod admin —
 * a pod-scope rule, same gate as `governanceRules.create`).
 */
export async function setReversibleDefault(
  db: DbHandle,
  input: { enabled: boolean; userId: string }
): Promise<ReversibleDefaultState> {
  await db.transaction(async (tx) => {
    await tx
      .update(governanceRules)
      .set({ revokedAt: new Date() })
      .where(podDefaultRow);
    if (input.enabled) {
      await tx.insert(governanceRules).values({
        principalKind: "any",
        scopeKind: "pod",
        targetKind: "action",
        targetPattern: REVERSIBLE_CLASS_PATTERN,
        verdict: "auto",
        createdBy: authoredCreatedBy(input.userId),
      });
    }
  });
  return readReversibleDefault(db);
}
