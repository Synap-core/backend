/**
 * `query` step executor — queries entities by profile slug and/or role
 * category with the shared query-DSL filter/orderBy.
 */
import {
  db,
  and,
  asc,
  desc,
  entities,
  drizzleSql,
  listableEntityWhere,
  profileScopeConditions,
  profileSlugRows,
  profileSlugScopeConditionFromRows,
  profilesByRoleCategory,
} from "@synap/database";
import type { SQL } from "@synap/database";
import { entityQueryVisibilityWhere } from "../entity-query-scope.js";
import {
  resolveQueryProfileSlug,
  resolveQueryRoleCategory,
  parseQueryFilterConditions,
  parseQueryOrderBy,
  queryConditionSql,
  numericPropertyExpr,
} from "../query-dsl.js";
import type { StepContext } from "../automation-executor-types.js";

/**
 * Execute a query step: queries entities by profile slug and/or role category,
 * with optional filter + orderBy.
 *
 * Both selectors go through the pod's polymorphic profile scope, the doors
 * `entity.query` and views use: a slug that names a ROLE (`proof-point`)
 * selects the entities wearing it (facet-EXISTS), a kind keeps the plain
 * `entities.type` match; a role category selects every entity wearing any
 * role tagged with it. Until 2026-10-28 the step matched `entities.type`
 * only, so a role could never be queried: the weekly announcement flow
 * (automation bdb99e5d, `roleCategory: announcement-material`) failed on its
 * first step and never drafted a post (finding 1c2dfe3d).
 */
export async function executeQueryStep(
  data: {
    profileSlug?: string;
    roleCategory?: string;
    filter?: string | Record<string, unknown>;
    limit: number;
    scope?: string;
    orderBy?: string;
    orderDir?: string;
  },
  context: StepContext,
  workspaceId: string,
  ownerId?: string,
  /**
   * The project the automation's rule is scoped to (`triggerConfig.projectId`).
   * A rule built for the demo project lists that project's demo records;
   * every other run leaves demo rows out (THE listing rule).
   */
  ruleProjectId?: string | null
): Promise<Record<string, unknown>> {
  const profileSlug = resolveQueryProfileSlug(data, context);
  const roleCategory = resolveQueryRoleCategory(data, context);
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  if (!profileSlug && !roleCategory)
    throw new Error("query node: profileSlug or roleCategory is required");
  // An unreadable filter fails the step before anything is read (it throws).
  const filterConditions = parseQueryFilterConditions(data.filter, context);

  // Facets are read under the automation's own space and owner (the facet
  // lens + owner floor, `facetVisibilityConditions`). No owner = only
  // space facets pass: it fails closed, never open.
  const facetScope = { userId: ownerId ?? "", workspaceId };
  const scope: SQL[] = [];
  if (profileSlug) {
    scope.push(
      profileSlugScopeConditionFromRows(
        db,
        profileSlug,
        await profileSlugRows(db, profileSlug),
        facetScope
      )
    );
  }
  if (roleCategory) {
    const roleScope = profileScopeConditions(
      db,
      await profilesByRoleCategory(db, roleCategory),
      facetScope
    );
    // No profile carries the category: an honest empty cohort, not a failure.
    if (!roleScope) return { entities: [], count: 0 };
    scope.push(roleScope);
  }

  // Visibility lens = this workspace's rows ∪ pod-wide rows (owner-floored).
  // Pod-scoped kinds (company/person/bookmark…) live at `workspace_id IS NULL`,
  // so a plain `workspace_id = X` read missed them ALL — the bug that made every
  // per-client daily loop fan out over ZERO rows. `entityQueryVisibilityWhere`
  // is the @synap/jobs-local mirror of the canonical `accessScopeWhere` door
  // (packages/api/src/utils/project-scope.ts); see that file for the SSOT.
  // scope "pod" narrows to ONLY pod-wide rows.
  const conditions = [
    ...scope,
    entityQueryVisibilityWhere({
      workspaceId,
      ownerId,
      podOnly: data.scope === "pod",
    }),
    // THE listing rule (FB1020 B5): a scheduled loop ("each deal in
    // negotiation → draft a follow-up") never works on probe or demo rows,
    // unless the rule is scoped to that demo project.
    listableEntityWhere({ revealSampleOf: ruleProjectId }),
  ];

  for (const condition of filterConditions) {
    conditions.push(queryConditionSql(condition));
  }

  const baseQuery = db
    .select({
      id: entities.id,
      type: entities.type,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      createdAt: entities.createdAt,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(and(...conditions));

  const orderBy = parseQueryOrderBy(data);
  // A real column orders by ONE key. A jsonb property needs TWO — numeric-first
  // so "9" doesn't rank above "30", then text for the rows where the value
  // isn't a number. Keeping the two shapes separate is why `QueryOrderBy` is a
  // discriminated union rather than a string with a flag.
  const orderTerms = !orderBy
    ? null
    : orderBy.kind === "column"
      ? [orderBy.dir === "asc" ? asc(orderBy.column) : desc(orderBy.column)]
      : [
          orderBy.dir === "asc"
            ? asc(numericPropertyExpr(orderBy.propKey))
            : desc(numericPropertyExpr(orderBy.propKey)),
          orderBy.dir === "asc"
            ? asc(drizzleSql`${entities.properties}->>${orderBy.propKey}`)
            : desc(drizzleSql`${entities.properties}->>${orderBy.propKey}`),
        ];
  const results = orderTerms
    ? await baseQuery.orderBy(...orderTerms).limit(limit)
    : await baseQuery.limit(limit);

  return { entities: results, count: results.length };
}
