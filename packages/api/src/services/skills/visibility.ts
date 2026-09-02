/**
 * Canonical skill visibility predicate.
 *
 * Keep every read surface on the same three-tier contract:
 * pod skills are shared, user skills belong to their owner, and workspace
 * skills require both the selected workspace and a live membership.
 *
 * ── RULE EXPIRY IS ENFORCED HERE, AND ONLY HERE ────────────────────────────
 * A RULE is a `skills` row (`kind:"instruction"`, `category:"rule"`), so every
 * door that can surface a rule goes through this predicate — the IS prompt path
 * (`/api/hub/agent-skills/executable` → hub `skills.getSkills` → tRPC
 * `skills.list`), `GET /api/hub/rules`, and `skills.listRules`. It is the
 * NARROWEST point all of them inherit, so ANDing `ruleNotExpiredWhere()` in
 * here is what makes `metadata.rule.expiresAt` mean something instead of being
 * a stored field with no consumer — and a fourth reader added later gets the
 * enforcement for free.
 *
 * It is a SQL predicate, not a post-fetch filter, so `limit`/`offset` and any
 * count stay honest. It is vacuously true for a row that is not a rule.
 */
import { and, eq, or, type SQL } from "@synap/database";
import { skills } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { ruleNotExpiredWhere } from "../rules/expiry.js";

export function visibleSkillsWhere(userId: string, workspaceId?: string): SQL {
  const tiers = !workspaceId
    ? or(
        eq(skills.scope, "pod"),
        and(eq(skills.scope, "user"), eq(skills.userId, userId))
      )!
    : or(
        eq(skills.scope, "pod"),
        and(eq(skills.scope, "user"), eq(skills.userId, userId)),
        and(
          eq(skills.scope, "workspace"),
          eq(skills.workspaceId, workspaceId),
          userVisibleWhere(skills.workspaceId, userId)
        )
      )!;

  return and(tiers, ruleNotExpiredWhere())!;
}
