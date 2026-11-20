/**
 * Canonical skill visibility predicate.
 *
 * Keep every read surface on the same three-tier contract:
 * pod skills are shared, user skills belong to their owner, and workspace
 * skills require both the selected workspace and a live membership.
 *
 * ── RULE EXPIRY: ENFORCED BY DEFAULT, WAIVED EXPLICITLY ────────────────────
 * A RULE is a `skills` row (`kind:"instruction"`, `category:"rule"`), so every
 * door that can surface a rule inherits this predicate. Enforcing by DEFAULT is
 * deliberate and fail-safe: a door added later that forgets about expiry
 * over-filters (an expired rule is missing) rather than leaking a lapsed
 * standing permission into an agent's prompt. Defaults should fail in the
 * direction that is merely annoying, not the direction that is unsafe.
 *
 * ⚠️ BUT ENFORCEMENT IS NOT VISIBILITY, and conflating them here shipped a real
 * defect. Because the waiver did not exist, `GET /api/hub/rules`,
 * `skills.listRules`, `skills.getRule` and `skills.dryRunRule` all filtered
 * expired rules out — so a lapsed rule 404'd from every owner-facing door and
 * could not be seen, renewed or deleted. The product contract is the opposite:
 * an expired rule must stop ACTING and stay VISIBLE. Worse, the tripwire that
 * asserted `rules.ts` did NOT enforce was GREEN, because it grepped that file
 * for the literal `ruleNotExpiredWhere(` and the predicate arrives through this
 * import instead — a source scan asserting a token when the property is
 * behavioural.
 *
 * So an OWNER-FACING door passes `{ includeExpired: true }` and says why. An
 * AGENT-FACING door passes nothing. The distinction is now expressible, which
 * is the point: before, "forgot" and "decided" looked identical.
 *
 * It is a SQL predicate, not a post-fetch filter, so `limit`/`offset` and any
 * count stay honest. It is vacuously true for a row that is not a rule.
 */
import {
  and,
  db,
  eq,
  exists,
  inArray,
  isNotNull,
  or,
  usableInSpaceWhere,
  type SQL,
} from "@synap/database";
import { skills, workspaces } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { ruleNotExpiredWhere } from "../rules/expiry.js";

export interface SkillVisibilityOptions {
  /**
   * Keep EXPIRED rules in the result. Only for a door whose audience is the
   * rule's OWNER — a list they manage, a detail page, a dry run they asked for.
   * Never for a door that feeds an agent: that is the enforcement this flag
   * waives.
   */
  includeExpired?: boolean;
  /**
   * A second owner whose user-scope skills are visible too: the agent that
   * authored an automation, whose run resolves skills as its owner (the
   * person). Without it a skill the agent made for itself fails mid-run.
   */
  alsoUserId?: string | null;
  /**
   * The pod-wide lens: every workspace skill of every space the user can see
   * (with no workspace and no `allSpaces`, workspace skills are left out). A
   * pod-wide reader (the shadow detector, diagnose by id) needs it.
   */
  allSpaces?: boolean;
}

/**
 * Pod skills, the user's own, and workspace skills: of the selected workspace
 * (its own, or one homed elsewhere and shared with it through `space_access`),
 * or of every space the user can see (`allSpaces`).
 */
export function visibleSkillsWhere(
  userId: string,
  workspaceId?: string,
  options?: SkillVisibilityOptions
): SQL {
  const own = options?.alsoUserId
    ? inArray(skills.userId, [userId, options.alsoUserId])
    : eq(skills.userId, userId);
  const inSpace = options?.allSpaces
    ? userVisibleWhere(skills.workspaceId, userId)
    : workspaceId
      ? and(
          isNotNull(skills.workspaceId),
          usableInSpaceWhere(
            "skill",
            skills.id,
            skills.workspaceId,
            workspaceId
          ),
          exists(
            db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                and(
                  eq(workspaces.id, workspaceId),
                  userVisibleWhere(workspaces.id, userId)
                )
              )
          )
        )
      : undefined;
  const tiers = or(
    eq(skills.scope, "pod"),
    and(eq(skills.scope, "user"), own),
    inSpace ? and(eq(skills.scope, "workspace"), inSpace) : undefined
  )!;

  return options?.includeExpired ? tiers : and(tiers, ruleNotExpiredWhere())!;
}
