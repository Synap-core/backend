/**
 * Entity reads for a pin list. The decision of WHICH id wins stays in
 * `pinned-subject.ts`. This file only answers "which of these ids can this
 * person see?" and "what is the one fallback row?".
 *
 * The filter and order are the automation query DSL. Copying that grammar
 * here is how a pin fallback and a query node would start to disagree.
 */
import {
  getDb,
  eq,
  and,
  asc,
  desc,
  inArray,
  entities,
  drizzleSql,
} from "@synap/database";
import { entityQueryVisibilityWhere } from "@synap/jobs/workers/entity-query-scope.js";
import {
  numericPropertyExpr,
  parseQueryFilterConditions,
  parseQueryOrderBy,
  queryConditionSql,
} from "@synap/jobs/workers/query-dsl.js";
import type { StepContext } from "@synap/jobs/workers/automation-executor-types.js";
import type { PinnedFallback } from "@synap/playbooks";

/**
 * Object filters do not read templates. The empty context exists so the
 * shared parser can be called without an automation run.
 */
const BARE_CONTEXT: StepContext = {
  trigger: { payload: {}, subject: null },
  steps: {},
  automation: { id: "", state: {} },
};

function visibilityFor(workspaceId: string | null, ownerId: string) {
  if (workspaceId) {
    return entityQueryVisibilityWhere({ workspaceId, ownerId });
  }
  // A playbook with no workspace only sees the owner's pod-wide records.
  // `podOnly` does not read `workspaceId`; the owner floor is the guard.
  return entityQueryVisibilityWhere({
    workspaceId: ownerId,
    ownerId,
    podOnly: true,
  });
}

/** Visible rows for a write check. Kind is NOT filtered — the caller names a mismatch. */
export async function loadVisibleEntitiesById(args: {
  ids: readonly string[];
  workspaceId: string | null;
  ownerId: string;
}): Promise<Array<{ id: string; type: string }>> {
  if (args.ids.length === 0) return [];
  const db = await getDb();
  return db
    .select({ id: entities.id, type: entities.type })
    .from(entities)
    .where(
      and(
        inArray(entities.id, [...args.ids]),
        visibilityFor(args.workspaceId, args.ownerId)
      )
    );
}

/** Visible ids of the playbook's kind. An empty slug keeps every visible type. */
export async function loadVisibleEntityIds(args: {
  ids: readonly string[];
  workspaceId: string | null;
  ownerId: string;
  profileSlug: string | null;
}): Promise<string[]> {
  if (args.ids.length === 0) return [];
  const db = await getDb();
  const conditions = [
    inArray(entities.id, [...args.ids]),
    visibilityFor(args.workspaceId, args.ownerId),
  ];
  if (args.profileSlug) conditions.push(eq(entities.type, args.profileSlug));
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(...conditions));
  return rows.map((row) => row.id);
}

/**
 * One fallback subject. Not added to the pin list. No profile slug is the
 * caller's problem — this function requires one, because a filter with no
 * kind would scan every record the person can see.
 */
export async function findFallbackSubject(args: {
  profileSlug: string;
  workspaceId: string | null;
  ownerId: string;
  fallback: PinnedFallback;
}): Promise<string | null> {
  const db = await getDb();
  const conditions = [
    eq(entities.type, args.profileSlug),
    visibilityFor(args.workspaceId, args.ownerId),
  ];
  for (const condition of parseQueryFilterConditions(
    args.fallback.filter,
    BARE_CONTEXT
  )) {
    conditions.push(queryConditionSql(condition));
  }

  const base = db
    .select({ id: entities.id })
    .from(entities)
    .where(and(...conditions));

  const orderBy = parseQueryOrderBy({
    orderBy: args.fallback.orderBy,
    orderDir: args.fallback.orderDir,
  });
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

  const rows = orderTerms
    ? await base.orderBy(...orderTerms).limit(1)
    : await base.limit(1);
  return rows[0]?.id ?? null;
}
