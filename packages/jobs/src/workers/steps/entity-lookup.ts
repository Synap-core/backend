/**
 * `entity_read` / `related_entities` / `claim` step executors — the workspace-
 * floored entity + relation lookups, plus the CAS claim primitive.
 */
import {
  db,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  entities,
  entityFacets,
  profiles,
  relations,
  automationClaims,
  drizzleSql,
} from "@synap/database";
import { resolveTemplate, resolveBoundValue } from "../template-resolve.js";
import type { StepContext } from "../automation-executor-types.js";

export async function executeEntityReadStep(
  data: { entityId: string },
  context: StepContext,
  workspaceId: string,
  viewerUserId: string
): Promise<Record<string, unknown>> {
  const entityId = resolveTemplate(data.entityId, context);
  if (!entityId) throw new Error("entity_read node: entityId is required");

  const [entity] = await db
    .select({
      id: entities.id,
      type: entities.type,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      workspaceId: entities.workspaceId,
      createdAt: entities.createdAt,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId))
      )
    )
    .limit(1);
  if (!entity)
    throw new Error(
      "entity_read node: entity is not visible in this workspace"
    );

  const facets = await db
    .select({
      id: entityFacets.id,
      slug: profiles.slug,
      status: entityFacets.status,
      properties: entityFacets.properties,
      contextEntityId: entityFacets.contextEntityId,
    })
    .from(entityFacets)
    .innerJoin(profiles, eq(profiles.id, entityFacets.profileId))
    .where(
      and(
        eq(entityFacets.entityId, entity.id),
        isNull(entityFacets.deletedAt),
        // Role facets follow the same workspace/pod lens as the entity. A
        // workspace-local role must not influence a run elsewhere in the pod.
        or(
          eq(entityFacets.workspaceId, workspaceId),
          isNull(entityFacets.workspaceId)
        ),
        // Pod-wide facets have a private owner floor; workspace-local facets
        // are visible to members of this already-authorized workspace lens.
        or(
          isNotNull(entityFacets.workspaceId),
          eq(entityFacets.userId, viewerUserId)
        )
      )
    );

  return {
    entity: {
      ...entity,
      facets,
      facetSlugs: facets.map((facet) => facet.slug),
    },
  };
}

export async function executeRelatedEntitiesStep(
  data: {
    entityId: string;
    direction?: "outbound" | "inbound" | "both";
    relationTypes?: string[];
    propertyEquals?: Record<string, unknown>;
    propertyAnyEquals?: Record<string, unknown[]>;
    excludeEntityId?: string;
    limit?: number;
  },
  context: StepContext,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const entityId = resolveTemplate(data.entityId, context);
  if (!entityId) throw new Error("related_entities node: entityId is required");
  const direction = data.direction ?? "both";
  const limit = Math.min(Math.max(Number(data.limit ?? 50), 1), 100);
  const endpointPredicate =
    direction === "outbound"
      ? eq(relations.sourceEntityId, entityId)
      : direction === "inbound"
        ? eq(relations.targetEntityId, entityId)
        : or(
            eq(relations.sourceEntityId, entityId),
            eq(relations.targetEntityId, entityId)
          );
  const relationRows = await db
    .select({
      id: relations.id,
      type: relations.type,
      sourceEntityId: relations.sourceEntityId,
      targetEntityId: relations.targetEntityId,
      metadata: relations.metadata,
    })
    .from(relations)
    .where(
      and(
        endpointPredicate,
        or(
          eq(relations.workspaceId, workspaceId),
          isNull(relations.workspaceId)
        ),
        data.relationTypes?.length
          ? inArray(relations.type, data.relationTypes)
          : undefined
      )
    )
    .limit(limit);
  const relatedIds = [
    ...new Set(
      relationRows
        .map((relation) =>
          relation.sourceEntityId === entityId
            ? relation.targetEntityId
            : relation.sourceEntityId
        )
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const excludedEntityId = data.excludeEntityId
    ? String(resolveTemplate(data.excludeEntityId, context) ?? "")
    : "";
  const visibleRelatedIds = excludedEntityId
    ? relatedIds.filter((id) => id !== excludedEntityId)
    : relatedIds;
  if (visibleRelatedIds.length === 0)
    return { entities: [], relations: [], count: 0 };

  const conditions = [
    inArray(entities.id, visibleRelatedIds),
    or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId)),
  ];
  for (const [key, rawValue] of Object.entries(data.propertyEquals ?? {})) {
    const value = resolveBoundValue(rawValue, context);
    conditions.push(
      drizzleSql`${entities.properties}->>${key} = ${String(value)}`
    );
  }
  const anyPropertyMatches = Object.entries(
    data.propertyAnyEquals ?? {}
  ).flatMap(([key, rawValues]) =>
    rawValues.map((rawValue) => {
      const value = resolveBoundValue(rawValue, context);
      return drizzleSql`${entities.properties}->>${key} = ${String(value)}`;
    })
  );
  if (anyPropertyMatches.length > 0)
    conditions.push(or(...anyPropertyMatches)!);
  const related = await db
    .select({
      id: entities.id,
      type: entities.type,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      workspaceId: entities.workspaceId,
    })
    .from(entities)
    .where(and(...conditions))
    .limit(limit);
  return { entities: related, relations: relationRows, count: related.length };
}

/**
 * Atomically reserve a durable key for the current run. It is intentionally a
 * domain-agnostic primitive: templates decide what the key means; the Pod only
 * guarantees one winner and makes retries by that same run safe.
 */
export async function executeClaimStep(
  data: { namespace: string; key: string },
  context: StepContext,
  workspaceId: string,
  runId: string
): Promise<Record<string, unknown>> {
  const namespace = String(
    resolveTemplate(data.namespace, context) ?? ""
  ).trim();
  const claimKey = String(resolveTemplate(data.key, context) ?? "").trim();
  if (!namespace || !claimKey) {
    throw new Error("claim node requires a non-empty namespace and key");
  }

  const [inserted] = await db
    .insert(automationClaims)
    .values({ workspaceId, namespace, claimKey, ownerRunId: runId })
    .onConflictDoNothing()
    .returning({ id: automationClaims.id });
  if (inserted)
    return { claimed: true, claimId: inserted.id, ownerRunId: runId };

  const [existing] = await db
    .select({
      id: automationClaims.id,
      ownerRunId: automationClaims.ownerRunId,
    })
    .from(automationClaims)
    .where(
      and(
        eq(automationClaims.namespace, namespace),
        eq(automationClaims.claimKey, claimKey),
        or(
          eq(automationClaims.workspaceId, workspaceId),
          isNull(automationClaims.workspaceId)
        )
      )
    )
    .limit(1);
  if (!existing)
    throw new Error("claim node could not read the conflicting claim");
  // A restarted delivery of the winning run keeps its original decision.
  return {
    claimed: existing.ownerRunId === runId,
    claimId: existing.id,
    ownerRunId: existing.ownerRunId,
  };
}
