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
import {
  OWN_ORGANISE_CLASS_PATTERN,
  REVERSIBLE_CLASS_PATTERN,
} from "@synap/governance-policy";
import { governanceRules } from "../schema/governance-rules.js";
import { authoredCreatedBy } from "./governance-rule-provenance.js";

type DbHandle = typeof import("../client-pg.js").db;

/** `created_by` of the seeded row (machine namespace — see governance-rule-provenance). */
export const REVERSIBLE_DEFAULT_CREATED_BY = "system:reversible-default";

/**
 * The pod-wide CLASS defaults — each ONE `governance_rules` row of this shape,
 * switched from Settings › Approvals. `@reversible` (2026-09-28) and
 * `@own-organise` (FB1020 B3, 2026-10-21: an agent's organisational moves on
 * its own fresh work act directly). Same store, same rung, same switch logic.
 */
export type PodClassPattern =
  typeof REVERSIBLE_CLASS_PATTERN | typeof OWN_ORGANISE_CLASS_PATTERN;

const podClassRow = (pattern: PodClassPattern) =>
  and(
    eq(governanceRules.principalKind, "any"),
    eq(governanceRules.scopeKind, "pod"),
    eq(governanceRules.targetKind, "action"),
    eq(governanceRules.targetPattern, pattern),
    isNull(governanceRules.revokedAt)
  );

export interface ReversibleDefaultState {
  enabled: boolean;
  /** The active row, so a surface can open it; null when off. */
  ruleId: string | null;
}

export async function readPodClassDefault(
  db: DbHandle,
  pattern: PodClassPattern
): Promise<ReversibleDefaultState> {
  const [row] = await db
    .select({ id: governanceRules.id, verdict: governanceRules.verdict })
    .from(governanceRules)
    .where(podClassRow(pattern))
    .limit(1);
  // A `propose` row on the class is not "on" — it would only tighten.
  const on = row !== undefined && row.verdict === "auto";
  return { enabled: on, ruleId: on ? row.id : null };
}

export function readReversibleDefault(
  db: DbHandle
): Promise<ReversibleDefaultState> {
  return readPodClassDefault(db, REVERSIBLE_CLASS_PATTERN);
}

/** FB1020 B3 — is "organising its own fresh work acts directly" on? */
export function readOwnOrganiseDefault(
  db: DbHandle
): Promise<ReversibleDefaultState> {
  return readPodClassDefault(db, OWN_ORGANISE_CLASS_PATTERN);
}

/**
 * Switch the pod default. Idempotent. The caller authorizes (pod admin —
 * a pod-scope rule, same gate as `governanceRules.create`).
 */
export async function setPodClassDefault(
  db: DbHandle,
  input: { pattern: PodClassPattern; enabled: boolean; userId: string }
): Promise<ReversibleDefaultState> {
  await db.transaction(async (tx) => {
    await tx
      .update(governanceRules)
      .set({ revokedAt: new Date() })
      .where(podClassRow(input.pattern));
    if (input.enabled) {
      await tx.insert(governanceRules).values({
        principalKind: "any",
        scopeKind: "pod",
        targetKind: "action",
        targetPattern: input.pattern,
        verdict: "auto",
        createdBy: authoredCreatedBy(input.userId),
      });
    }
  });
  return readPodClassDefault(db, input.pattern);
}

export function setReversibleDefault(
  db: DbHandle,
  input: { enabled: boolean; userId: string }
): Promise<ReversibleDefaultState> {
  return setPodClassDefault(db, {
    ...input,
    pattern: REVERSIBLE_CLASS_PATTERN,
  });
}

/** FB1020 B3 — switch "organising its own fresh work acts directly". */
export function setOwnOrganiseDefault(
  db: DbHandle,
  input: { enabled: boolean; userId: string }
): Promise<ReversibleDefaultState> {
  return setPodClassDefault(db, {
    ...input,
    pattern: OWN_ORGANISE_CLASS_PATTERN,
  });
}
