/**
 * Governance Rules — the ONE store for agent/pod auto-approve policy
 * (Governance Convergence Plan, Phase A).
 *
 * A rule says: for this principal (a specific agent, or "any"), in this
 * scope (a workspace, or pod-wide), targeting this action/profile/capability
 * pattern — auto-execute or route to a proposal. `verdict` is NEVER 'deny':
 * denial stays a CBAC/floor concern (ADMIN, forcePropose, DESTRUCTIVE,
 * by-kind rungs), never a user-authored rule.
 *
 * Resolution (rung 2.8, `resolveAgentGovernanceDecision`) ranks matching rows
 * by specificity — agent > any, workspace > pod, exact action > profile >
 * glob > `*` — and takes the top-ranked active row. This schema file defines
 * storage only; the resolver and engine wiring are a separate wave.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const governancePrincipalEnum = pgEnum("governance_principal", [
  "agent",
  "any",
]);
export const GOVERNANCE_PRINCIPALS = governancePrincipalEnum.enumValues;
export type GovernancePrincipal = (typeof GOVERNANCE_PRINCIPALS)[number];

export const governanceScopeEnum = pgEnum("governance_scope", [
  "workspace",
  "pod",
]);
export const GOVERNANCE_SCOPES = governanceScopeEnum.enumValues;
export type GovernanceScope = (typeof GOVERNANCE_SCOPES)[number];

export const governanceTargetEnum = pgEnum("governance_target", [
  "action",
  "profile",
  "capability",
]);
export const GOVERNANCE_TARGETS = governanceTargetEnum.enumValues;
export type GovernanceTarget = (typeof GOVERNANCE_TARGETS)[number];

/**
 * 'auto' | 'propose' only — never 'deny'. A rule can widen the door
 * (auto-execute) or keep it reviewable (propose); it can never close a door
 * that a floor rung already opened for review or blocked outright.
 */
export const governanceVerdictEnum = pgEnum("governance_verdict", [
  "auto",
  "propose",
]);
export const GOVERNANCE_VERDICTS = governanceVerdictEnum.enumValues;
export type GovernanceVerdict = (typeof GOVERNANCE_VERDICTS)[number];

export const governanceRules = pgTable(
  "governance_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    principalKind: governancePrincipalEnum("principal_kind").notNull(),
    // Set when principalKind = 'agent'.
    agentUserId: text("agent_user_id"),

    scopeKind: governanceScopeEnum("scope_kind").notNull(),
    // Set when scopeKind = 'workspace'.
    workspaceId: uuid("workspace_id"),

    targetKind: governanceTargetEnum("target_kind").notNull(),
    // e.g. 'entity.create', 'entity.*', '*', or a capability/verb id.
    targetPattern: text("target_pattern").notNull(),
    // Entity profile slug when target_kind = 'profile'.
    targetProfile: text("target_profile"),

    verdict: governanceVerdictEnum("verdict").notNull(),

    sourceProposalId: uuid("source_proposal_id"),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    // Resolver's primary lookup: active rules for a (scope, workspace,
    // principal) tuple, ranked by specificity in application code.
    scopePrincipalIdx: index("governance_rules_scope_principal_idx")
      .on(
        table.scopeKind,
        table.workspaceId,
        table.principalKind,
        table.agentUserId
      )
      .where(sql`${table.revokedAt} IS NULL`),
    agentActiveIdx: index("governance_rules_agent_active_idx")
      .on(table.agentUserId)
      .where(sql`${table.revokedAt} IS NULL`),
    sourceProposalIdx: index("governance_rules_source_proposal_idx").on(
      table.sourceProposalId
    ),
  })
);

export type GovernanceRule = typeof governanceRules.$inferSelect;
export type NewGovernanceRule = typeof governanceRules.$inferInsert;
