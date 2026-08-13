/**
 * Proposal DISPLAY enrichment — batch-joins entity/user/facet/event context
 * onto raw proposal rows and builds the reviewable diff/graph model
 * (`ProposalReviewModel`/`ProposalReviewGraph`) the frontend renders.
 * Extracted verbatim from proposals.ts (Wave 5 router-decomposition).
 */

import {
  db,
  eq,
  and,
  inArray,
  isNull,
  sql,
  entities,
  users,
  podMembers,
  EventRepository,
  isFacetVisibleForLens,
} from "@synap/database";
import { entityFacets, profiles } from "@synap/database/schema";
import type { EventRecord } from "@synap/database";
import type {
  ProposalReviewEvent,
  ProposalReviewModel,
  StoredProposalData,
} from "@synap-core/types";
import {
  isCompositeProposalData,
  isRequestShapedProposalData,
  buildRequestFromProposal,
  buildFallbackTitle,
  isLikelyUUID,
  opRef,
  PRIMARY_REF,
} from "@synap-core/types/proposals";
import type {
  UpdateRequest,
  ProposalReviewGraph,
  CompositeProposalData,
  CompositeCreateEntityOp,
  CompositeCreateRelationOp,
} from "@synap-core/types/proposals";
import type { FlowDefinition } from "@synap/database";
import { proposals } from "@synap/database";
import { buildProposalChanges } from "./changes.js";

type ProposalRow = typeof proposals.$inferSelect;
type DisplayEnrichedProposal = ProposalRow & {
  request: UpdateRequest;
  authorName?: string;
  targetName?: string;
  review: ProposalReviewModel;
};

export async function enrichProposalsForDisplay(
  rows: ProposalRow[],
  userId: string
): Promise<DisplayEnrichedProposal[]> {
  const requests = rows.map((row) => buildRequestFromProposal(row));

  // B2: entity ids referenced as RELATION ENDPOINTS — for standalone relation
  // proposals (`data.sourceEntityId`/`targetEntityId`) and for composite
  // `create_relation` ops whose source/target ref is a real (pre-existing) entity
  // UUID. Joined below so the graph / link preview can render real titles instead
  // of `entity <8hex>` shortIds.
  // B4: facet ids for facet-UPDATE proposals — so the live-current before-state
  // of the role's properties can be diffed against the proposed values.
  const relationEndpointIds: string[] = [];
  const facetIds: string[] = [];
  // Roles v2: entity ids for which the graph needs the entity's CURRENT roles
  // (isNew:false) — composite create_entity ops that link a PRE-EXISTING entity
  // (`existingEntityId`) rather than minting a new one. Batch-joined below.
  const existingRoleEntityIds: string[] = [];
  rows.forEach((row, idx) => {
    const request = requests[idx]!;
    const payload =
      request.data && typeof request.data === "object"
        ? (request.data as Record<string, unknown>)
        : undefined;
    const src = stringProp(payload, "sourceEntityId");
    const tgt = stringProp(payload, "targetEntityId");
    if (src && isLikelyUUID(src)) relationEndpointIds.push(src);
    if (tgt && isLikelyUUID(tgt)) relationEndpointIds.push(tgt);
    const raw = row.data as StoredProposalData | null | undefined;
    if (isCompositeProposalData(raw)) {
      for (const op of raw.operations) {
        if (op.op === "create_relation") {
          if (isLikelyUUID(op.sourceRef))
            relationEndpointIds.push(op.sourceRef);
          if (isLikelyUUID(op.targetRef))
            relationEndpointIds.push(op.targetRef);
        } else if (
          op.op === "create_entity" &&
          op.existingEntityId &&
          isLikelyUUID(op.existingEntityId)
        ) {
          existingRoleEntityIds.push(op.existingEntityId);
        }
      }
    }
    if (row.targetType === "facet" && row.proposalType === "update") {
      const fid = stringProp(payload, "facetId");
      if (fid && isLikelyUUID(fid)) facetIds.push(fid);
    }
  });

  const entityIds = uniqueStrings([
    ...requests
      .filter((request) => request.targetType === "entity")
      .map((request) => request.targetId)
      .filter(isLikelyUUID),
    ...relationEndpointIds,
  ]);
  const uniqueFacetIds = uniqueStrings(facetIds);
  const uniqueRoleEntityIds = uniqueStrings(existingRoleEntityIds);
  const userIds = uniqueStrings(
    rows.flatMap((row, idx) => [
      row.agentUserId ?? undefined,
      row.createdBy ?? undefined,
      requests[idx]?.sourceId || undefined,
    ])
  );
  // correlation_id is a uuid column — clamp to valid uuids so the batch query's
  // ::uuid[] cast can't throw on a legacy non-uuid value.
  const correlationIds = uniqueStrings(
    requests.map((request) => request.correlationId)
  ).filter(isLikelyUUID);

  const eventRepo = new EventRepository(sql);
  const [
    entityRows,
    userRows,
    traceEntries,
    facetRows,
    roleFacetRows,
    viewerIsPodMember,
  ] = await Promise.all([
    entityIds.length > 0
      ? db
          .select({
            id: entities.id,
            title: entities.title,
            preview: entities.preview,
            type: entities.type,
            properties: entities.properties,
            workspaceId: entities.workspaceId,
          })
          .from(entities)
          .where(inArray(entities.id, entityIds))
      : Promise.resolve([]),
    userIds.length > 0
      ? db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            userType: users.userType,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    // ONE batched query for ALL correlation ids on this page (was N+1: one
    // round-trip per proposal → pool exhaustion). Grouped in memory below.
    correlationIds.length > 0
      ? eventRepo
          .getCorrelatedEventsBatch(correlationIds, userId)
          .then((events) => {
            const grouped = new Map<string, EventRecord[]>();
            for (const ev of events) {
              const key = ev.correlationId;
              if (!key) continue;
              const bucket = grouped.get(key);
              if (bucket) bucket.push(ev);
              else grouped.set(key, [ev]);
            }
            return Array.from(grouped.entries()) as Array<
              readonly [string, EventRecord[]]
            >;
          })
      : Promise.resolve([] as Array<readonly [string, EventRecord[]]>),
    // B4: current role-facet state for facet-UPDATE proposals (live-current
    // before→after). One batched query for every facetId on the page.
    uniqueFacetIds.length > 0
      ? db
          .select({
            id: entityFacets.id,
            status: entityFacets.status,
            properties: entityFacets.properties,
            workspaceId: entityFacets.workspaceId,
            userId: entityFacets.userId,
          })
          .from(entityFacets)
          .where(inArray(entityFacets.id, uniqueFacetIds))
      : Promise.resolve(
          [] as Array<{
            id: string;
            status: string | null;
            properties: unknown;
            workspaceId: string | null;
            userId: string;
          }>
        ),
    // Roles v2: CURRENT live role-facets of every pre-existing entity a composite
    // op links (`existingEntityId`), joined to profiles for the role slug. ONE
    // batched query for the whole page; the per-proposal workspace lens (MF2) is
    // applied in memory below so a role in another workspace can't leak.
    uniqueRoleEntityIds.length > 0
      ? db
          .select({
            entityId: entityFacets.entityId,
            profileSlug: profiles.slug,
            status: entityFacets.status,
            workspaceId: entityFacets.workspaceId,
            userId: entityFacets.userId,
          })
          .from(entityFacets)
          .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
          .where(
            and(
              inArray(entityFacets.entityId, uniqueRoleEntityIds),
              isNull(entityFacets.deletedAt)
            )
          )
      : Promise.resolve(
          [] as Array<{
            entityId: string;
            profileSlug: string;
            status: string | null;
            workspaceId: string | null;
            userId: string;
          }>
        ),
    // B4/Roles v2: resolve the viewer's pod membership ONCE for the whole page
    // (mirrors AccessContext.podMembership()'s single indexed lookup) so the
    // `isFacetVisibleForLens` calls below can admit a legitimately pod-shared
    // facet/role to a pod-member reviewer, not just its own owner — only run
    // when a facet/role is actually being visibility-checked below.
    uniqueFacetIds.length > 0 || uniqueRoleEntityIds.length > 0
      ? db
          .select({ userId: podMembers.userId })
          .from(podMembers)
          .where(eq(podMembers.userId, userId))
          .limit(1)
          .then((rows) => rows.length > 0)
      : Promise.resolve(false),
  ]);

  const entityById = new Map(entityRows.map((row) => [row.id, row]));
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const traceByCorrelationId = new Map<string, EventRecord[]>(traceEntries);
  const facetById = new Map(facetRows.map((row) => [row.id, row]));
  // Roles v2: group live role-facets by their entity id (unfiltered — the
  // workspace lens is applied per-proposal below via `rolesForLens`).
  const roleFacetsByEntityId = new Map<
    string,
    Array<{
      profileSlug: string;
      status: string | null;
      workspaceId: string | null;
      userId: string;
    }>
  >();
  for (const rf of roleFacetRows) {
    const bucket = roleFacetsByEntityId.get(rf.entityId);
    if (bucket) bucket.push(rf);
    else roleFacetsByEntityId.set(rf.entityId, [rf]);
  }
  // B2 + MF2 (workspace scoping): resolve a batch-joined entity title by id, but
  // ONLY when the endpoint entity is visible under the proposal's own workspace
  // lens — same workspace as the proposal, or pod-wide (workspaceId null, visible
  // everywhere). A composite `create_relation` can name a pre-existing entity in a
  // DIFFERENT workspace the viewer cannot see; resolving its title here would leak
  // it. Cross-workspace endpoints return undefined → caller falls back to the
  // `entity <8hex>` shortId. The viewer is already authorized for the proposal's
  // workspace (list/get access-check it), so same-workspace + pod-wide is safe.
  const resolveEntityTitle = (
    entityId: string,
    allowedWorkspaceId: string | null
  ): string | undefined => {
    const meta = entityById.get(entityId);
    if (!meta) return undefined;
    if (meta.workspaceId !== null && meta.workspaceId !== allowedWorkspaceId) {
      return undefined;
    }
    return meta.title ?? meta.preview ?? undefined;
  };

  return rows.map((row, idx) => {
    const request = requests[idx]!;
    const payload =
      request.data && typeof request.data === "object"
        ? request.data
        : undefined;
    const entityMeta = entityById.get(request.targetId);
    const targetName =
      request.targetName ??
      titleFieldOverrideValue(request.targetType, payload) ??
      displayLabelFromRecord(payload) ??
      entityMeta?.title ??
      entityMeta?.preview ??
      undefined;
    const profileSlug =
      stringProp(payload, "profileSlug") ??
      stringProp(payload, "type") ??
      entityMeta?.type ??
      undefined;
    const authorRow = userById.get(
      row.agentUserId ?? row.createdBy ?? request.sourceId
    );
    const authorName = authorRow ? displayNameForUser(authorRow) : undefined;
    const summary =
      request.summary ??
      buildFallbackTitle({
        changeType: request.changeType,
        profileSlug,
        targetType: request.targetType,
        targetName,
      });

    // MF2: bind the workspace-scoped resolver to THIS proposal's workspace lens
    // so an endpoint/facet in another workspace can never leak its title/props.
    const resolveEntityTitleScoped = (entityId: string): string | undefined =>
      resolveEntityTitle(entityId, row.workspaceId);

    // B2: for a standalone relation proposal, resolve the endpoint titles onto
    // the enriched payload. The frontend link preview prefers data.sourceLabel /
    // data.targetLabel over the raw UUID, so populating them here kills the
    // `entity <8hex>` shortId without any contract change.
    let enrichedData = request.data;
    const srcId = stringProp(payload, "sourceEntityId");
    const tgtId = stringProp(payload, "targetEntityId");
    if (payload && (srcId || tgtId)) {
      const srcLabel = srcId ? resolveEntityTitleScoped(srcId) : undefined;
      const tgtLabel = tgtId ? resolveEntityTitleScoped(tgtId) : undefined;
      if (srcLabel || tgtLabel) {
        enrichedData = {
          ...payload,
          ...(srcLabel ? { sourceLabel: srcLabel } : {}),
          ...(tgtLabel ? { targetLabel: tgtLabel } : {}),
        };
      }
    }

    // B4: for a facet-UPDATE proposal, the live-current before-state is the
    // role-facet's CURRENT properties (fetched batched above), not the parent
    // entity's columns. Feed it through the same `current` slot the entity-update
    // diff uses so property changes render before→after. MF2: only when the facet
    // sits under the proposal's own workspace lens (or pod-wide) — a facet in
    // another workspace must not leak its properties into this review.
    let reviewCurrent:
      | {
          title?: string | null;
          preview?: string | null;
          type?: string | null;
          properties?: unknown;
        }
      | undefined = entityMeta;
    if (row.targetType === "facet" && row.proposalType === "update") {
      const fid = stringProp(payload, "facetId");
      const facetRow = fid ? facetById.get(fid) : undefined;
      if (
        facetRow &&
        isFacetVisibleForLens(
          facetRow,
          row.workspaceId,
          userId,
          viewerIsPodMember
        )
      ) {
        reviewCurrent = { properties: facetRow.properties };
      }
    }

    // Roles v2: the CURRENT roles of every pre-existing entity this composite
    // links, filtered to THIS proposal's workspace lens + owner floor via the
    // shared `isFacetVisibleForLens` predicate (the in-memory twin of
    // `facetVisibilityConditions()` — SSOT, no hand-copied rule). Keyed by
    // entity id → `buildProposalGraph` attaches them to the matching
    // `existingEntityId` op as `isNew:false` roles.
    let existingRolesByEntityId:
      | Map<string, Array<{ profileSlug: string; status?: string | null }>>
      | undefined;
    if (
      roleFacetsByEntityId.size > 0 &&
      isCompositeProposalData(row.data as StoredProposalData | null | undefined)
    ) {
      const lensWorkspaceId = row.workspaceId;
      const scoped = new Map<
        string,
        Array<{ profileSlug: string; status?: string | null }>
      >();
      for (const [eid, facets] of roleFacetsByEntityId) {
        const visible = facets.filter((f) =>
          isFacetVisibleForLens(f, lensWorkspaceId, userId, viewerIsPodMember)
        );
        if (visible.length > 0) {
          scoped.set(
            eid,
            visible.map((f) => ({
              profileSlug: f.profileSlug,
              status: f.status,
            }))
          );
        }
      }
      if (scoped.size > 0) existingRolesByEntityId = scoped;
    }

    return {
      ...row,
      authorName,
      targetName,
      request: {
        ...request,
        data: enrichedData,
        targetName,
        summary,
      },
      review: buildProposalReviewModel({
        row,
        request: {
          ...request,
          data: enrichedData,
          targetName,
          summary,
        },
        authorName,
        targetName,
        current: reviewCurrent,
        resolveEntityTitle: resolveEntityTitleScoped,
        existingRolesByEntityId,
        events: request.correlationId
          ? (traceByCorrelationId.get(request.correlationId) ?? [])
          : [],
      }),
    };
  });
}

function buildProposalReviewModel(params: {
  row: ProposalRow;
  request: UpdateRequest;
  authorName?: string;
  targetName?: string;
  /** Current state of the target entity (for update before→after diffs). */
  current?: {
    title?: string | null;
    preview?: string | null;
    type?: string | null;
    properties?: unknown;
  };
  /** B2: resolve a real entity title by id for composite relation endpoints. */
  resolveEntityTitle?: (entityId: string) => string | undefined;
  /** Roles v2: CURRENT roles (lens-filtered) of pre-existing entities the graph
   * links, keyed by entity id — attached as `isNew:false` roles. */
  existingRolesByEntityId?: Map<
    string,
    Array<{ profileSlug: string; status?: string | null }>
  >;
  events: Awaited<ReturnType<EventRepository["getCorrelatedEvents"]>>;
}): ProposalReviewModel {
  const {
    row,
    request,
    authorName,
    targetName,
    current,
    resolveEntityTitle,
    existingRolesByEntityId,
    events,
  } = params;
  const requestData =
    request.data && typeof request.data === "object" ? request.data : {};
  // Composite (graph) proposals store `{ operations: [...] }` in row.data, which
  // the flat `changes` model can't express. Detect and build a `graph` instead.
  const rawData = row.data as StoredProposalData | null | undefined;
  const graph = isCompositeProposalData(rawData)
    ? buildProposalGraph(rawData, resolveEntityTitle, existingRolesByEntityId)
    : undefined;
  // Durable before-snapshot captured at proposal-creation time (entity updates).
  // Preferred over the live `current` entity so the diff survives approval and
  // concurrent edits. Absent on legacy proposals → falls back to `current`.
  // `previousData` is declared on RequestShapedProposalData in @synap-core/types
  // (src); read it via a local shape so this compiles against the published dist
  // until the types package rebuilds.
  const previousData = isRequestShapedProposalData(rawData)
    ? (rawData as ProposalPreviousDataCarrier).previousData
    : undefined;
  const reviewEvents = events.map(toProposalReviewEvent);
  const requestedEvent =
    reviewEvents.find((event) => event.phase === "requested") ??
    reviewEvents.find((event) => event.eventType.endsWith(".requested"));
  const validatedEvent =
    reviewEvents.find((event) => event.phase === "validated") ??
    reviewEvents.find((event) => event.eventType.endsWith(".validated"));
  const completedEvent =
    reviewEvents.find((event) => event.phase === "completed") ??
    reviewEvents.find((event) => event.eventType.endsWith(".completed"));

  return {
    summary:
      request.summary ??
      buildFallbackTitle({
        changeType: request.changeType,
        targetType: request.targetType,
        targetName,
      }),
    actorName: authorName,
    targetName,
    reasoning: request.reasoning,
    source: request.source,
    sourceId: request.sourceId,
    sourceMessageId: row.sourceMessageId,
    threadId: row.threadId,
    commandRunId: row.commandRunId,
    correlationId: request.correlationId,
    requestedEventId: request.requestedEventId ?? requestedEvent?.eventId,
    validatedEventId: request.validatedEventId ?? validatedEvent?.eventId,
    completedEventId: request.completedEventId ?? completedEvent?.eventId,
    changes: buildProposalChanges(
      requestData,
      request.changeType,
      current,
      previousData
    ),
    ...(graph ? { graph } : {}),
    events: reviewEvents,
  };
}

/**
 * Build the reviewable graph for a composite proposal.
 *
 * Pass 1: walk the create_entity ops, assigning each a stable ref (its own `ref`
 * or the positional `$opN`) and recording ref→title so relations can show human
 * labels. ROLES v2: each entity carries its `roles[]` — a KIND wears its roles.
 * Inline `op.facets` become `isNew:true` roles (this proposal ATTACHES them);
 * for an op that links a PRE-EXISTING entity (`existingEntityId`), that entity's
 * CURRENT live roles (looked up in the lens-filtered `existingRolesByEntityId`
 * map built in `enrichProposalsForDisplay`) become `isNew:false` roles — showing
 * the entity's existing roles as context beside the new one.
 * Pass 2: map each create_relation's source/target refs to those titles; a ref
 * that is a real, pre-existing entity UUID resolves to that entity's real title
 * via `resolveEntityTitle` (B2 — was a bare `entity <8hex>` shortId). When an
 * endpoint is one of THIS proposal's entities, its canonical entity ref is also
 * emitted (`sourceRef`/`targetRef`) so the UI can link the row to the entity.
 *
 * `resolveEntityTitle` looks up a batch-joined entity title by id (populated in
 * `enrichProposalsForDisplay` for every UUID referenced as a relation endpoint).
 * Absent → falls back to the short `entity <8hex>` label as before.
 *
 * Emits the PINNED ProposalReviewGraph contract — keep in sync with the frontend.
 */
function buildProposalGraph(
  data: CompositeProposalData,
  resolveEntityTitle?: (entityId: string) => string | undefined,
  existingRolesByEntityId?: Map<
    string,
    Array<{ profileSlug: string; status?: string | null }>
  >
): ProposalReviewGraph {
  const refToTitle = new Map<string, string>();
  // Every ref alias ($opN / op `ref` / $primary / a linked entity's UUID) → the
  // CANONICAL entity ref (the value in `entities[].ref`), so a relation endpoint
  // that is one of this proposal's entities resolves to that entity's ref.
  const refAliasToCanonical = new Map<string, string>();
  const entities: ProposalReviewGraph["entities"] = [];
  let firstEntitySeen = false;

  data.operations.forEach((op, index) => {
    if (op.op !== "create_entity") return;
    const entityOp = op as CompositeCreateEntityOp;
    const ref = entityOp.ref ?? opRef(index);
    const title = entityOp.title ?? "Untitled";
    refToTitle.set(ref, title);
    // Positional ref always resolves too (a relation may reference $opN even
    // when the op carries its own ref).
    refToTitle.set(opRef(index), title);
    // Canonical-ref aliases: positional, own ref, $primary (first entity only),
    // and a linked pre-existing entity's UUID all point at this entity's ref.
    refAliasToCanonical.set(ref, ref);
    refAliasToCanonical.set(opRef(index), ref);
    if (entityOp.ref) refAliasToCanonical.set(entityOp.ref, ref);
    if (!firstEntitySeen) refAliasToCanonical.set(PRIMARY_REF, ref);
    if (entityOp.existingEntityId)
      refAliasToCanonical.set(entityOp.existingEntityId, ref);
    firstEntitySeen = true;

    // ROLES v2: a KIND carries its roles ON the entity. Existing roles first
    // (isNew:false, from live entity_facets of a linked pre-existing entity),
    // then the roles this proposal attaches (isNew:true, from inline op.facets).
    const roles: NonNullable<ProposalReviewGraph["entities"][number]["roles"]> =
      [];
    if (entityOp.existingEntityId) {
      for (const existing of existingRolesByEntityId?.get(
        entityOp.existingEntityId
      ) ?? []) {
        roles.push({
          profileSlug: existing.profileSlug,
          isNew: false,
          ...(existing.status ? { status: existing.status } : {}),
        });
      }
    }
    for (const facet of entityOp.facets ?? []) {
      roles.push({
        profileSlug: facet.profileSlug,
        isNew: true,
        ...(facet.status ? { status: facet.status } : {}),
      });
    }

    entities.push({
      ref,
      profileSlug: entityOp.profileSlug,
      title,
      propertyCount: Object.keys(entityOp.properties ?? {}).length,
      hasContent: !!entityOp.content,
      ...(roles.length > 0 ? { roles } : {}),
    });
  });

  const labelForRef = (ref: string): string => {
    const known = refToTitle.get(ref);
    if (known) return known;
    // A ref that is a real UUID is a pre-existing entity linked into the graph.
    // Resolve its real title from the batch join (B2); fall back to the shortId.
    if (isLikelyUUID(ref)) {
      const resolved = resolveEntityTitle?.(ref);
      if (resolved) return resolved;
      return `entity ${ref.slice(0, 8)}`;
    }
    return ref;
  };

  const relations: ProposalReviewGraph["relations"] = [];
  // $relN ordinal — the stable per-item address for a relation (N counts
  // create_relation ops in operations order). `approve` recomputes this exact
  // ordinal to map a `$relN` disposition back to the Nth create_relation op, so
  // the counter MUST increment per create_relation op (matching the same
  // iteration order over data.operations).
  let relOrdinal = 0;
  for (const op of data.operations) {
    if (op.op !== "create_relation") continue;
    const relOp = op as CompositeCreateRelationOp;
    const itemRef = `$rel${relOrdinal}`;
    relOrdinal++;
    const sourceRef = refAliasToCanonical.get(relOp.sourceRef);
    const targetRef = refAliasToCanonical.get(relOp.targetRef);
    relations.push({
      type: relOp.type,
      sourceLabel: labelForRef(relOp.sourceRef),
      targetLabel: labelForRef(relOp.targetRef),
      ...(sourceRef ? { sourceRef } : {}),
      ...(targetRef ? { targetRef } : {}),
      itemRef,
    });
  }

  // facetCount = number of NEWLY-attached roles across all entities (isNew).
  const facetCount = entities.reduce(
    (sum, entity) =>
      sum + (entity.roles?.filter((role) => role.isNew).length ?? 0),
    0
  );

  return {
    entities,
    relations,
    entityCount: entities.length,
    relationCount: relations.length,
    facetCount,
  };
}

// ---------------------------------------------------------------------------

function toProposalReviewEvent(event: {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  timestamp: Date;
  userId: string;
  source?: string;
  correlationId?: string;
}): ProposalReviewEvent {
  const parts = event.eventType.split(".");
  return {
    eventId: event.id,
    eventType: event.eventType,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    action: parts.length >= 2 ? parts[1] : undefined,
    phase: parts.length >= 3 ? parts[2] : undefined,
    timestamp: event.timestamp.toISOString(),
    userId: event.userId,
    source: event.source,
    correlationId: event.correlationId,
  };
}

/** Before-snapshot persisted on an UPDATE proposal's stored data. Mirrors the
 * `previousData` field declared on RequestShapedProposalData in @synap-core/types. */
export interface ProposalPreviousData {
  title?: string | null;
  description?: string | null;
  profileSlug?: string | null;
  documentId?: string | null;
  properties?: Record<string, unknown>;
}
/** Local read-shape so the persisted snapshot is accessible against the published
 * @synap-core/types dist before it rebuilds with the new field. */
type ProposalPreviousDataCarrier = { previousData?: ProposalPreviousData };

/**
 * Per-subjectType override for which flat payload field names the proposal card.
 * Consulted when resolving a proposal's `targetName` so a non-entity subject
 * (e.g. a flat `property_def` payload that carries no title/name) still gets a
 * human title (its slug) instead of falling through to "Untitled". Backend-local
 * — deliberately NOT a new published type field (reuses existing plumbing).
 */
const TITLE_FIELD_OVERRIDES: Record<string, string> = {
  property_def: "slug",
};

/** Resolve the title-override field value for a proposal's target type, if any. */
function titleFieldOverrideValue(
  targetType: string | undefined,
  payload: Record<string, unknown> | undefined
): string | undefined {
  if (!targetType) return undefined;
  const field = TITLE_FIELD_OVERRIDES[targetType];
  if (!field) return undefined;
  return stringProp(payload, field);
}

export function uniqueStrings(
  values: Array<string | null | undefined>
): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

export function stringProp(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function displayLabelFromRecord(
  record: Record<string, unknown> | undefined
): string | undefined {
  return (
    stringProp(record, "title") ??
    stringProp(record, "name") ??
    stringProp(record, "displayName") ??
    stringProp(record, "label")
  );
}

export function displayNameForUser(row: {
  name: string | null;
  email: string;
  userType: string;
  agentMetadata: { agentType?: string; description?: string } | null;
}): string | undefined {
  if (row.name) return row.name;
  if (row.userType === "agent") {
    return row.agentMetadata?.agentType ?? row.agentMetadata?.description;
  }
  return row.email || undefined;
}

/**
 * Find a flow node by id in an automation's live definition. Tolerant of a
 * missing/partial definition or an unknown nodeId (returns null). Used by
 * `proposals.source` to read the producing node's skill / playbook ref.
 */
export function findFlowNode(
  flowDefinition: FlowDefinition | null | undefined,
  nodeId: string | undefined
): { type: string; data?: unknown } | null {
  if (!nodeId) return null;
  const nodes = flowDefinition?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n && typeof n === "object" && (n as { id?: unknown }).id === nodeId) {
      return n as { type: string; data?: unknown };
    }
  }
  return null;
}

export function labelFromPath(path: string): string {
  return path
    .replace(/^properties\./, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function valueTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
