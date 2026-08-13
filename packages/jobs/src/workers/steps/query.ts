/**
 * `query` step executor — queries entities by profile slug with the shared
 * query-DSL filter/orderBy.
 */
import { db, eq, and, asc, desc, entities, drizzleSql } from "@synap/database";
import { entityQueryVisibilityWhere } from "../entity-query-scope.js";
import {
  resolveQueryProfileSlug,
  parseQueryFilterConditions,
  parseQueryOrderBy,
  queryConditionSql,
  numericPropertyExpr,
} from "../query-dsl.js";
import type { StepContext } from "../automation-executor-types.js";

/**
 * Execute a query step: queries entities by profile slug with optional
 * filter + orderBy.
 */
export async function executeQueryStep(
  data: {
    profileSlug?: string;
    filter?: string | Record<string, unknown>;
    limit: number;
    scope?: string;
    orderBy?: string;
    orderDir?: string;
  },
  context: StepContext,
  workspaceId: string,
  ownerId?: string
): Promise<Record<string, unknown>> {
  const profileSlug = resolveQueryProfileSlug(data, context);
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  if (!profileSlug) throw new Error("query node: profileSlug is required");

  // Visibility lens = this workspace's rows ∪ pod-wide rows (owner-floored).
  // Pod-scoped kinds (company/person/bookmark…) live at `workspace_id IS NULL`,
  // so a plain `workspace_id = X` read missed them ALL — the bug that made every
  // per-client daily loop fan out over ZERO rows. `entityQueryVisibilityWhere`
  // is the @synap/jobs-local mirror of the canonical `accessScopeWhere` door
  // (packages/api/src/utils/project-scope.ts); see that file for the SSOT.
  // scope "pod" narrows to ONLY pod-wide rows.
  const conditions = [
    eq(entities.type, profileSlug),
    entityQueryVisibilityWhere({
      workspaceId,
      ownerId,
      podOnly: data.scope === "pod",
    }),
  ];

  for (const condition of parseQueryFilterConditions(data.filter, context)) {
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
