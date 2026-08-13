/**
 * Governance Ceilings — the store for NUMERIC governance limits (0236).
 *
 * Sibling to `governance_rules`: where a RULE stores an auto/propose VERDICT, a
 * CEILING stores a numeric LIMIT. First slice ships ONE axis —
 * `daily_write_count`: a per-agent (or pod-wide) cap on how many writes an agent
 * may AUTO-EXECUTE per UTC day. Over the resolved limit, a would-be-auto write is
 * downgraded to a reviewable proposal at rung 2.56 (tighten-only — a ceiling can
 * NEVER widen or deny, only downgrade execute→propose).
 *
 * Scoping MIRRORS governance_rules exactly: it reuses the SAME
 * `governance_principal` (agent | any) and `governance_scope` (workspace | pod)
 * enums (defined in ./governance-rules.ts), and the resolver ranks matching rows
 * by the same specificity (agent > any, workspace > pod). There is no
 * "verdict"/"target" here — the axis IS the target, and the value is numeric.
 *
 * DEFAULT: there is intentionally NO SQL/Drizzle default on `limitValue`. The
 * ONE source of the fallback default is the TS constant
 * `DEFAULT_DAILY_WRITE_CEILING` (@synap/governance-policy), consulted by the
 * resolver when NO row matches (the same "absence → code floor" shape
 * governance_rules uses).
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  governancePrincipalEnum,
  governanceScopeEnum,
} from "./governance-rules.js";

export const governanceCeilingAxisEnum = pgEnum("governance_ceiling_axis", [
  "daily_write_count",
]);
export const GOVERNANCE_CEILING_AXES = governanceCeilingAxisEnum.enumValues;
export type GovernanceCeilingAxis = (typeof GOVERNANCE_CEILING_AXES)[number];

export const governanceCeilings = pgTable(
  "governance_ceilings",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    axis: governanceCeilingAxisEnum("axis").notNull(),

    principalKind: governancePrincipalEnum("principal_kind").notNull(),
    // Set when principalKind = 'agent'.
    agentUserId: text("agent_user_id"),

    scopeKind: governanceScopeEnum("scope_kind").notNull(),
    // Set when scopeKind = 'workspace'.
    workspaceId: uuid("workspace_id"),

    // The numeric limit for this axis (e.g. max writes/UTC-day). No default —
    // the fallback lives ONLY in DEFAULT_DAILY_WRITE_CEILING (see file header).
    limitValue: integer("limit_value").notNull(),

    sourceProposalId: uuid("source_proposal_id"),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    // Resolver's primary lookup: active ceilings for an (axis, scope, workspace,
    // principal) tuple, ranked by specificity in application code.
    axisScopePrincipalIdx: index("governance_ceilings_axis_scope_principal_idx")
      .on(
        table.axis,
        table.scopeKind,
        table.workspaceId,
        table.principalKind,
        table.agentUserId
      )
      .where(sql`${table.revokedAt} IS NULL`),
    agentActiveIdx: index("governance_ceilings_agent_active_idx")
      .on(table.agentUserId)
      .where(sql`${table.revokedAt} IS NULL`),
    sourceProposalIdx: index("governance_ceilings_source_proposal_idx").on(
      table.sourceProposalId
    ),
  })
);

export type GovernanceCeiling = typeof governanceCeilings.$inferSelect;
export type NewGovernanceCeiling = typeof governanceCeilings.$inferInsert;
