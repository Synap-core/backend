/**
 * Governance-rule PROVENANCE — the ONE vocabulary for "how did this rule come
 * to exist", shared by the writer side (`syncAutoApproveRules`, the rules
 * editor) and the reader side (`classifyRuleProvenance`, consumed by
 * `getEffectiveGovernance` → `synap_governance` / Hub REST).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THE PREFIXES EXIST — a provenance signal that cannot tell a MACHINE
 *    using your id from YOU is worse than no signal at all.
 * ─────────────────────────────────────────────────────────────────────────────
 * `governance_rules.created_by` is free-form TEXT. Before this module, the
 * classifier inferred:
 *     sourceProposalId ⇒ "earned" · created_by "system:*" ⇒ "machine"
 *     · anything else (a real user id) ⇒ "authored"
 * That last inference was FALSE ASSURANCE. `syncAutoApproveRules` — the mirror
 * job behind `PATCH /agent-users/:id/governance` and
 * `POST /workspaces/provision-agent` — stamps a CALLER-SUPPLIED `created_by`,
 * and both callers pass the acting HUMAN's user id. Verified live (pod
 * `c145cc92`, 2026-08-15): 32 pod-wide `principal_kind:'agent'`,
 * `verdict:'auto'` rows — `profile.create`, `property_def.update`,
 * `skill.create`, `channel.create`, … every one of them deliberately EXCLUDED
 * from the platform floor — all carrying one human's uuid, one identical
 * `created_at`, `source_proposal_id: null`. Every one reported
 * `provenance: "authored"`. An operator triaging what to revoke would read
 * "I did this on purpose" and keep all 32.
 *
 * THE FIX: both writer doors now stamp a namespaced prefix that still CARRIES
 * the human's id (so "whose settings did this mirror" is never lost), and the
 * classifier fails toward SUSPICION — an unprefixed `created_by` is reported as
 * `"unknown"`, never `"authored"`.
 *
 * 🔴 THIS DOES NOT RETRO-FIX HISTORY. Rows written before this module shipped
 * carry a bare uuid and are, on the stored data alone, genuinely
 * indistinguishable — they now classify as `"unknown"` (honest) rather than
 * `"authored"` (a lie). Only rows written from here on are precisely
 * classifiable.
 *
 * NOT AN ENFORCEMENT INPUT. Nothing here is read by `decideAgentPolicy` or
 * `resolveGovernanceRule`; `created_by` has never participated in a governance
 * decision and must not start.
 */

/**
 * A rule the operator authored deliberately, at a human-only door (the Rules
 * editor / `governanceRules.create`, a Kratos-authenticated
 * `protectedProcedure`). Format: `user:<userId>`.
 */
export const AUTHORED_CREATED_BY_PREFIX = "user:";

/**
 * A rule minted by the settings MIRROR (`syncAutoApproveRules`) from an
 * `autoApproveFor` list. The acting human's id is retained after the prefix so
 * the "whose settings" question is still answerable — but the row is no longer
 * mistakable for something that human typed into the Rules editor.
 * Format: `system:settings-mirror:<userId>`.
 */
export const SETTINGS_MIRROR_CREATED_BY_PREFIX = "system:settings-mirror:";

/** Any machine author. `system:governance-backfill`, `system:ensure-capture-agent`
 *  and `system:settings-mirror:*` all live under this namespace. */
export const MACHINE_CREATED_BY_PREFIX = "system:";

/** Stamp for the human-authored door. Idempotent: never double-prefixes. */
export function authoredCreatedBy(userId: string): string {
  return userId.startsWith(AUTHORED_CREATED_BY_PREFIX)
    ? userId
    : `${AUTHORED_CREATED_BY_PREFIX}${userId}`;
}

/**
 * Stamp for the settings mirror. Applied INSIDE `syncAutoApproveRules` rather
 * than at each call site: a future third caller cannot reintroduce the
 * ambiguity by forgetting it. An already-`system:`-namespaced author (a system
 * seeder driving the mirror) is passed through unchanged.
 */
export function settingsMirrorCreatedBy(createdBy: string): string {
  return createdBy.startsWith(MACHINE_CREATED_BY_PREFIX)
    ? createdBy
    : `${SETTINGS_MIRROR_CREATED_BY_PREFIX}${createdBy}`;
}

/**
 * Recover the human id from either stamp — for display ("mirrored from Alice's
 * settings"). Returns null when the author is a pure system seeder or a legacy
 * bare value (which is unknowable, not a user id we may assert).
 */
export function createdByUserId(createdBy: string): string | null {
  if (createdBy.startsWith(AUTHORED_CREATED_BY_PREFIX)) {
    return createdBy.slice(AUTHORED_CREATED_BY_PREFIX.length) || null;
  }
  if (createdBy.startsWith(SETTINGS_MIRROR_CREATED_BY_PREFIX)) {
    return createdBy.slice(SETTINGS_MIRROR_CREATED_BY_PREFIX.length) || null;
  }
  return null;
}

/**
 * How a rule came to exist.
 *   - `earned`   — a human approved a `governance.widen_lane` proposal
 *                  (`source_proposal_id` set): reviewed lineage.
 *   - `machine`  — a machine minted it under a `system:*` author (boot
 *                  backfill, capture-agent seeder, or the settings MIRROR).
 *                  NO ONE typed this rule into the editor.
 *   - `authored` — a human created it at the Rules editor door (`user:<id>`).
 *   - `unknown`  — the stored author carries no provenance marker (a legacy
 *                  pre-prefix row). We CANNOT tell a mirror from an author, so
 *                  we say so. Never silently upgraded to `authored`.
 */
export type RuleProvenance = "earned" | "machine" | "authored" | "unknown";

export function classifyRuleProvenance(rule: {
  createdBy: string | null | undefined;
  sourceProposalId: string | null;
}): RuleProvenance {
  if (rule.sourceProposalId) return "earned";
  const by = rule.createdBy;
  // Fail toward suspicion: absent/empty author is not evidence of authorship.
  if (!by) return "unknown";
  if (by.startsWith(MACHINE_CREATED_BY_PREFIX)) return "machine";
  if (by.startsWith(AUTHORED_CREATED_BY_PREFIX)) return "authored";
  return "unknown";
}
