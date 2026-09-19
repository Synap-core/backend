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
  focusSessions,
  EventRepository,
  isFacetVisibleForLens,
} from "@synap/database";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";
import { proposalClassFields } from "../../services/proposals/proposal-class.js";
import { entityFacets, profiles, documents } from "@synap/database/schema";
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
  isPlanBatch,
  opRef,
  PRIMARY_REF,
} from "@synap-core/types/proposals";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { planSessionEdges } from "../../services/capture-agent/capture-plan.js";
import type {
  UpdateRequest,
  ProposalReviewGraph,
  CompositeProposalData,
  CompositeCreateEntityOp,
  CompositeCreateRelationOp,
} from "@synap-core/types/proposals";
import type { FlowDefinition } from "@synap/database";
import { proposals } from "@synap/database";
import {
  labelFromOperations,
  withRemainder,
} from "../../services/proposals/composite-summary.js";
import {
  humanizeToken,
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";
import { buildProposalChanges } from "./changes.js";
import { assertEveryOperationRendered } from "./renderable-ops.js";

type ProposalRow = typeof proposals.$inferSelect;

/**
 * The three states of "is a human's identity behind this agent's act?", read
 * off `proposals.subjectUserId` (RFC 8693 delegation).
 *
 *   unresolved — the row predates migration 0248; the column is NULL. NOT the
 *                same as "no delegation" — we simply never recorded it, and a
 *                surface must say so rather than render a blank.
 *   global     — `subjectUserId === agentUserId`: the agent's key is pod-wide
 *                (`linkedUserId: null`), so it acted AS ITSELF. No human
 *                delegated this.
 *   delegated  — the effective user is somebody else: a human's identity is
 *                behind the act, and `name` is theirs (absent only when that
 *                user row is unreadable).
 *
 * ── IT CARRIES NO USER ID, BY CONSTRUCTION ─────────────────────────────────
 * This type is a LABEL and must never become a FILTER. The `delegated` branch
 * deliberately carries a `name` and NOT the `subjectUserId` it was derived
 * from, and that omission is load-bearing, not an oversight.
 *
 * A principal carrying a resolved user id would look irresistibly like the
 * right input to `routers/proposals/review-authority.ts:220-223`:
 *
 *     if (!isOwner && proposal.agentUserId) {
 *       isOwner = facts.agentCreatedByUserId === userId;
 *     }
 *
 * It is not. `subjectUserId` is the EFFECTIVE user of the acting principal, so
 * on a POD-WIDE agent (`apiKeys.linkedUserId === null`) it resolves to THE
 * AGENT ITSELF — feeding it into an owner check would let an agent's own id
 * satisfy the owner floor and re-open the self-approval hole closed in
 * `1ce38ef0`. The one-line defence is that the type STRUCTURALLY CANNOT be
 * used as a filter: there is no id on it to compare.
 *
 * Pinned by `src/__tripwires__/principal-is-a-label-not-a-filter.test.ts`.
 * Do not add an id-shaped member here. If a surface needs to FILTER by the
 * delegating human, it must read the column through the authority path, not
 * through this display label.
 */
export type ProposalPrincipal =
  | { kind: "unresolved" }
  | { kind: "global" }
  | { kind: "delegated"; name?: string };

/**
 * The principal reading of `proposals.subjectUserId` — PURE, so the branch that
 * used to be a false delegation claim is testable without a database.
 *
 * `resolveName` is the caller's already-batched user lookup; it is consulted
 * ONLY on the delegated branch, because that is the only branch that names a
 * person. `global` deliberately carries no name: naming the agent's creator
 * there is precisely the collapse this replaces.
 *
 * Returns `undefined` when no agent acted — a human-authored proposal has no
 * principal question to answer.
 */
export function deriveProposalPrincipal(input: {
  agentUserId: string | null;
  subjectUserId: string | null;
  resolveName: (userId: string) => string | undefined;
}): ProposalPrincipal | undefined {
  const { agentUserId, subjectUserId, resolveName } = input;
  if (!agentUserId) return undefined;
  if (!subjectUserId) return { kind: "unresolved" };
  if (subjectUserId === agentUserId) return { kind: "global" };
  const name = resolveName(subjectUserId);
  return name ? { kind: "delegated", name } : { kind: "delegated" };
}
type DisplayEnrichedProposal = ProposalRow & {
  request: UpdateRequest;
  /**
   * LEGACY, and a COALESCE: `agentUserId ?? createdBy ?? sourceId`. It answers
   * "a name to show" and deliberately cannot say WHICH role that name plays.
   * Prefer the three below for anything that attributes an action to a person.
   */
  authorName?: string;
  /** ACTOR — the agent that authored this proposal. Absent for human authors. */
  agentActorName?: string;
  /**
   * @deprecated MIRROR ONLY — read `principal` instead.
   *
   * The human the acting agent belongs to (`users.createdByUserId` on the
   * agent's row). That column is the ACCOUNTABILITY anchor — who CREATED this
   * agent — and every agent has one, delegated or not. Rendering it as
   * "on behalf of" asserted a delegation that never happened for a pod-wide
   * agent, which is the exact claim the governance surface exists to disprove.
   * Kept so existing consumers keep compiling while they move to `principal`.
   */
  onBehalfOfName?: string;
  /**
   * PRINCIPAL — whether a human's identity is actually behind this agent's act,
   * discriminated rather than collapsed. Present iff there IS an agent actor.
   *
   * Derived from `proposals.subjectUserId`, the one column that carries the
   * LINKAGE fact (`apiKeys.linkedUserId ?? apiKeys.userId`); see the column
   * contract in `@synap/database` `schema/proposals.ts`. `createdByUserId`
   * cannot answer this — it is defined for every agent, so it can only ever
   * say "delegated".
   *
   * `unresolved` is a VALUE, not an absence: pre-0248 rows have a NULL column
   * and the honest answer is "we do not know", which the surface must SAY.
   *
   * A LABEL, never a filter.
   */
  principal?: ProposalPrincipal;
  /** APPROVER — the human who reviewed it. Absent while the proposal is pending. */
  approverName?: string;
  targetName?: string;
  /**
   * The NAME of the focus session that produced this proposal (its title, else
   * its goal's first line — `resolveSessionTitle`), when there is one and the
   * viewer may see it. Keyed `sessionGoal` for wire compatibility. A resolved display label exactly like
   * `authorName` — the review spine groups by `sessionId` and had nothing but
   * the raw uuid to head the group with.
   */
  sessionGoal?: string;
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
  /**
   * DOCUMENT titles — the target type with no path to a name at all.
   *
   * The `targetName` chain resolves an entity via the batch-joined `entities`
   * table, a `property_def` via TITLE_FIELD_OVERRIDES, and anything else via a
   * `title`/`name` field on the payload. A document proposal has none of those:
   * its target id is a `documents` PK (not an entity id) and its payload carries
   * only `changes` / `proposedContent`. So every document proposal fell through
   * to the generic fallback title — the founder's own example ("AI edit
   * documents" instead of the document's name).
   *
   * One batched query for the whole page, floored by `ownerPrivateVisibleWhere`:
   * `documents` is an ownerPrivate table (a NULL workspace means "personal to
   * the owner"), so a plain userVisibleWhere would hand another user's private
   * document title to every reviewer. A document the viewer may not see simply
   * resolves to no name and the fallback title is kept — never fabricated.
   */
  const documentIds = uniqueStrings(
    requests
      .filter((request) => request.targetType === "document")
      .map((request) => request.targetId)
      .filter(isLikelyUUID)
  );
  const uniqueFacetIds = uniqueStrings(facetIds);
  const uniqueRoleEntityIds = uniqueStrings(existingRoleEntityIds);
  const userIds = uniqueStrings(
    rows.flatMap((row, idx) => [
      row.agentUserId ?? undefined,
      row.createdBy ?? undefined,
      requests[idx]?.sourceId || undefined,
      // The APPROVER. `reviewedBy` has been persisted since the review spine
      // shipped but was never resolved to a name here, so every surface over
      // this projection could say WHO PROPOSED and never WHO APPROVED.
      row.reviewedBy ?? undefined,
    ])
  );
  // correlation_id is a uuid column — clamp to valid uuids so the batch query's
  // ::uuid[] cast can't throw on a legacy non-uuid value.
  const correlationIds = uniqueStrings(
    requests.map((request) => request.correlationId)
  ).filter(isLikelyUUID);
  // Session GOALS for the `sessionId` FK — one batched query for the whole page
  // (never per row). Most proposals carry no session, so the common case pays
  // nothing.
  const sessionIds = uniqueStrings(
    rows.map((row) => row.sessionId ?? undefined)
  ).filter(isLikelyUUID);

  const eventRepo = new EventRepository(sql);
  const [
    entityRows,
    userRows,
    traceEntries,
    facetRows,
    roleFacetRows,
    viewerIsPodMember,
    sessionRows,
    documentRows,
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
            // The agent's OWNER — the human it acts FOR (RFC 8693 `may_act`).
            // Read here so the three delegation roles can be projected without a
            // second shape: actor (this row, when userType='agent'), on-behalf-of
            // (this column), approver (`proposals.reviewedBy`).
            createdByUserId: users.createdByUserId,
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
    // Session goals, floored by `ownerPrivateVisibleWhere` — focus_sessions is
    // an ownerPrivate table (a NULL workspace means "personal to the owner"), so
    // a plain userVisibleWhere would hand another user's private session goal to
    // every reviewer. A session the viewer may not see simply resolves to no
    // label, and the spine falls back to the id.
    sessionIds.length > 0
      ? db
          .select({
            id: focusSessions.id,
            title: focusSessions.title,
            goal: focusSessions.goal,
          })
          .from(focusSessions)
          .where(
            and(
              inArray(focusSessions.id, sessionIds),
              ownerPrivateVisibleWhere(
                focusSessions.workspaceId,
                focusSessions.userId,
                userId
              )
            )
          )
      : Promise.resolve(
          [] as Array<{ id: string; title: string | null; goal: string }>
        ),
    // Document titles for `targetType: "document"` proposals — see the
    // `documentIds` note above. Owner-floored, batched, skipped entirely when
    // the page carries no document proposal.
    documentIds.length > 0
      ? db
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(
            and(
              inArray(documents.id, documentIds),
              ownerPrivateVisibleWhere(
                documents.workspaceId,
                documents.userId,
                userId
              )
            )
          )
      : Promise.resolve([] as Array<{ id: string; title: string }>),
  ]);

  const entityById = new Map(entityRows.map((row) => [row.id, row]));
  const userById = new Map(userRows.map((row) => [row.id, row]));

  /**
   * DELEGATION NAMES (RFC 8693) — the second, small batched lookup that resolves
   * the humans the acting AGENTS act for.
   *
   * It cannot be folded into the query above: an agent's owner id is
   * `users.createdByUserId` on the AGENT's own row, so it is unknown until that
   * row has been read. One extra round-trip for the whole page (not per row),
   * skipped entirely when no proposal on the page has an agent actor — which is
   * every human-authored page.
   */
  const ownerIds = uniqueStrings([
    ...rows.map((row) => {
      if (!row.agentUserId) return undefined;
      const agentRow = userById.get(row.agentUserId);
      if (!agentRow || userById.has(agentRow.createdByUserId ?? "")) {
        return undefined;
      }
      return agentRow.createdByUserId ?? undefined;
    }),
    // PRINCIPAL (0248): the DELEGATED human is `subjectUserId` — the effective
    // user of the acting principal — NOT `createdByUserId` above. The two are
    // the same person on a single-owner pod and different the moment an agent
    // acts for someone who did not create it, so both ids are resolved. Only
    // fetched when an agent actually acted and the id is neither the agent
    // itself (that is the `global` reading, which needs no name) nor already
    // loaded.
    ...rows.map((row) => {
      if (!row.agentUserId || !row.subjectUserId) return undefined;
      if (row.subjectUserId === row.agentUserId) return undefined;
      if (userById.has(row.subjectUserId)) return undefined;
      return row.subjectUserId;
    }),
  ]);
  if (ownerIds.length > 0) {
    const ownerRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        userType: users.userType,
        agentMetadata: users.agentMetadata,
        createdByUserId: users.createdByUserId,
      })
      .from(users)
      .where(inArray(users.id, ownerIds));
    for (const row of ownerRows) userById.set(row.id, row);
  }
  const traceByCorrelationId = new Map<string, EventRecord[]>(traceEntries);
  const facetById = new Map(facetRows.map((row) => [row.id, row]));
  const sessionGoalById = new Map(
    sessionRows.map((row) => [row.id, resolveSessionTitle(row)])
  );
  const documentTitleById = new Map(
    documentRows.map((row) => [row.id, row.title])
  );
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
      (request.targetType === "document"
        ? documentTitleById.get(request.targetId)
        : undefined) ??
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

    // ── THE THREE DELEGATION ROLES, projected separately ────────────────────
    // `authorName` above is a COALESCE — `agentUserId ?? createdBy ?? sourceId`
    // — so it renders ONE name for what are three different people, and a
    // surface reading it cannot tell which one it got. That is the collapse the
    // founder objected to: "an agent never does something under my identity —
    // it should be an agent, possibly linked to me."
    //
    // RFC 8693 names them, and Synap already persists all three:
    //   actor        — the agent (`proposals.agent_user_id`)
    //   on-behalf-of — the human it acts FOR (`users.created_by_user_id` on the
    //                  agent's own row; the same human the agent KEY links to)
    //   approver     — the human who authorized it (`proposals.reviewed_by`)
    //
    // `authorName` is left exactly as it was: it has existing consumers, and
    // narrowing it would be a behaviour change disguised as a rename. These
    // three are ADDITIVE and each is `undefined` when the role does not apply —
    // a human-authored proposal has no actor and no on-behalf-of; a pending
    // proposal has no approver. Absent means ABSENT; nothing falls back to
    // another role's name, because a fallback here is how one name came to
    // stand for three in the first place.
    const agentActorRow = row.agentUserId
      ? userById.get(row.agentUserId)
      : undefined;
    const agentActorName = agentActorRow
      ? displayNameForUser(agentActorRow)
      : undefined;
    const onBehalfOfRow = agentActorRow?.createdByUserId
      ? userById.get(agentActorRow.createdByUserId)
      : undefined;
    const onBehalfOfName = onBehalfOfRow
      ? displayNameForUser(onBehalfOfRow)
      : undefined;
    // ── PRINCIPAL — the delegation question, ANSWERED rather than assumed ────
    // `onBehalfOfName` above reads `users.createdByUserId`, which is defined for
    // EVERY agent. So it can only ever say "delegated", and it said it for
    // pod-wide agents too: "Scout · for Antoine" on an act Antoine never
    // delegated — a false claim on the surface built to prove it cannot happen.
    //
    // `subjectUserId` is the only column on this row that carries the linkage
    // (it is stamped `ctx.userId` = `linkedUserId ?? keyOwner`), so it — and
    // only it — can distinguish the two. Three outcomes, all named; nothing
    // falls back to another role's name.
    const principal = deriveProposalPrincipal({
      agentUserId: row.agentUserId,
      subjectUserId: row.subjectUserId,
      resolveName: (id) => {
        const subjectRow = userById.get(id);
        return subjectRow ? displayNameForUser(subjectRow) : undefined;
      },
    });
    const approverRow = row.reviewedBy
      ? userById.get(row.reviewedBy)
      : undefined;
    const approverName = approverRow
      ? displayNameForUser(approverRow)
      : undefined;
    // ── A GENERIC STORED SUMMARY LOSES TO A DERIVATION THAT NAMES THE OBJECT ──
    // `request.summary ?? buildFallbackTitle(...)` meant the stored string ALWAYS
    // won, forever. Two rows on the founder's pod (2026-09-03) carry
    // `summary: "Create entity"` while their own `operations[]` carry
    // `title: "Raycast V1 focus lens (product decision Focus A)"` — everything
    // needed to name the object was in the payload; nothing looked, because a
    // string was present. The producer has since been fixed
    // (`buildProposalSummary` reads `operations[]`), but a stored summary is
    // durable: those rows would read "Create entity" for the rest of their life.
    //
    // The test is `summaryNamesTheObject` — derived from the vocabulary door, NOT
    // a blocklist of strings. A summary made only of this proposal's own action
    // verb and kind noun carries no object identity, so a derivation that DOES
    // name the object is strictly more informative and wins. Anything else — a
    // human-written summary, the JOIN-gate sentence, a rule's intent — carries a
    // word the derivation could not have produced and is kept untouched.
    const compositeLabel = labelFromOperations(
      (payload as { operations?: unknown } | undefined)?.operations
    );
    const derivedName = targetName ?? compositeLabel?.objectName;
    const derivedSummary = withRemainder(
      buildFallbackTitle({
        changeType: request.changeType,
        proposalType: row.proposalType,
        profileSlug: profileSlug ?? compositeLabel?.objectKind,
        targetType: request.targetType,
        targetName: derivedName,
      }),
      compositeLabel?.extraCount ?? 0
    );
    const storedSummary = request.summary;
    const summary =
      storedSummary &&
      // Only ever REPLACED by something strictly richer: the stored string must
      // name no object AND the derivation must name one.
      !(
        derivedName &&
        !summaryNamesTheObject(storedSummary, {
          changeType: request.changeType,
          proposalType: row.proposalType,
          profileSlug: profileSlug ?? compositeLabel?.objectKind,
          targetType: request.targetType,
        })
      )
        ? storedSummary
        : derivedSummary;

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
      // Decision CLASS + its lifetime, derived (never stored) from
      // proposalType × targetType. Serialized here so `proposals.list` and
      // `proposals.get` — and every surface over them — can render the
      // ephemeral countdown without a second call or a second copy of the
      // lifetime table. ONE door: `proposalClassFields`.
      ...proposalClassFields(row.proposalType, row.targetType),
      authorName,
      // The three roles, each absent when it does not apply (see above).
      ...(agentActorName ? { agentActorName } : {}),
      ...(onBehalfOfName ? { onBehalfOfName } : {}),
      ...(principal ? { principal } : {}),
      ...(approverName ? { approverName } : {}),
      targetName,
      ...(row.sessionId && sessionGoalById.has(row.sessionId)
        ? { sessionGoal: sessionGoalById.get(row.sessionId)! }
        : {}),
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
        proposalType: row.proposalType,
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
 *
 * REFUSAL GUARD: both passes MARK the index of every op they render into
 * `renderedOpIndexes`, and `assertEveryOperationRendered` refuses the whole
 * graph if any op went unrendered (see `renderable-ops.ts` for the why). A new
 * pass that renders a further op kind must mark its indexes the same way — that
 * is what makes the renderable set DERIVED from this code rather than declared
 * beside it.
 */
export function buildProposalGraph(
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
  /** Indexes of the ops these passes actually rendered — the guard's evidence. */
  const renderedOpIndexes = new Set<number>();

  data.operations.forEach((op, index) => {
    if (op.op !== "create_entity") return;
    renderedOpIndexes.add(index);
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
      // The real id of a LINKED pre-existing record. `ref` above is symbolic by
      // construction, so this is the only thing that lets a review surface open
      // the entity. We already read this value for roles and ref-aliasing above;
      // not emitting it is what made every graph node unopenable on relay.
      ...(entityOp.existingEntityId
        ? { existingEntityId: entityOp.existingEntityId }
        : {}),
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
  data.operations.forEach((op, index) => {
    if (op.op !== "create_relation") return;
    renderedOpIndexes.add(index);
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
  });

  // ── CONNECTED PLAN steps ───────────────────────────────────────────────
  // Typed nodes + ONE edge list, so no client re-derives parent / blocker
  // lines from session fields. Additive: a graph with no plan op gets none of
  // these keys and renders byte-identically.
  const plan = buildPlanReviewGraph(data, renderedOpIndexes);

  // REFUSE a composite whose ops this pipeline cannot fully render — no member
  // may reach a reviewer invisibly (and then apply undeniably).
  assertEveryOperationRendered(data.operations, renderedOpIndexes);

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
    ...plan,
  };
}

/**
 * The CONNECTED-PLAN half of the review graph: typed project / session /
 * document nodes and ONE session-edge list, derived by `planSessionEdges` —
 * the same function the preflight validates and the materializer applies, so
 * a reviewer sees exactly the edges approval would write. Marks every plan op
 * it renders (the refusal guard's evidence). Returns `{}` for a composite with
 * no plan op, which keeps an entity/relation graph byte-identical.
 */
function buildPlanReviewGraph(
  data: CompositeProposalData,
  renderedOpIndexes: Set<number>
): Partial<ProposalReviewGraph> {
  if (!isPlanBatch(data.operations)) return {};
  const projects: NonNullable<ProposalReviewGraph["projects"]> = [];
  const sessions: NonNullable<ProposalReviewGraph["sessions"]> = [];
  const documents: NonNullable<ProposalReviewGraph["documents"]> = [];
  const sessionLabelByRef = new Map<string, string>();

  data.operations.forEach((op, index) => {
    switch (op.op) {
      case "create_project":
        renderedOpIndexes.add(index);
        projects.push({
          ref: op.ref,
          name: op.name,
          ...(op.description ? { description: op.description } : {}),
          ...(op.subjectRef ? { subjectRef: op.subjectRef } : {}),
          ...(op.subjectEntityId
            ? { subjectEntityId: op.subjectEntityId }
            : {}),
          ...(op.evidence ? { evidence: op.evidence } : {}),
        });
        return;
      case "create_session": {
        renderedOpIndexes.add(index);
        const displayTitle = resolveSessionTitle({
          title: op.title ?? null,
          goal: op.goal,
        });
        sessionLabelByRef.set(op.ref, displayTitle);
        sessions.push({
          ref: op.ref,
          title: op.title ?? null,
          displayTitle,
          goal: op.goal,
          ...(op.projectRef ? { projectRef: op.projectRef } : {}),
          ...(op.projectId ? { projectId: op.projectId } : {}),
          ...(op.subjectRef ? { subjectRef: op.subjectRef } : {}),
          ...(op.subjectEntityId
            ? { subjectEntityId: op.subjectEntityId }
            : {}),
        });
        return;
      }
      case "create_document":
        renderedOpIndexes.add(index);
        documents.push({
          ref: op.ref,
          title: op.title,
          ...(op.entityRef ? { entityRef: op.entityRef } : {}),
          ...(op.entityId ? { entityId: op.entityId } : {}),
          ...(op.sessionRef ? { sessionRef: op.sessionRef } : {}),
          ...(op.sessionId ? { sessionId: op.sessionId } : {}),
          ...(op.expectedLabel ? { expectedLabel: op.expectedLabel } : {}),
        });
        return;
      case "create_link":
        renderedOpIndexes.add(index);
        return;
      default:
        return;
    }
  });

  const endpoint = (end: { ref: string } | { sessionId: string }) =>
    "ref" in end
      ? {
          ref: end.ref,
          label: sessionLabelByRef.get(end.ref) ?? end.ref,
        }
      : {
          sessionId: end.sessionId,
          label: `session ${end.sessionId.slice(0, 8)}`,
        };
  const links: NonNullable<ProposalReviewGraph["links"]> = planSessionEdges(
    data.operations
  ).map((edge, ordinal) => {
    const from = endpoint(edge.from);
    const to = endpoint(edge.to);
    return {
      type: edge.type,
      ...("ref" in from
        ? { fromRef: from.ref }
        : { fromSessionId: from.sessionId }),
      ...("ref" in to ? { toRef: to.ref } : { toSessionId: to.sessionId }),
      fromLabel: from.label,
      toLabel: to.label,
      itemRef: `$link${ordinal}`,
    };
  });

  return {
    isPlan: true,
    planStepCount:
      projects.length +
      sessions.length +
      documents.length +
      data.operations.filter((op) => op.op === "create_link").length,
    projects,
    sessions,
    documents,
    links,
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

/**
 * Does a stored proposal summary NAME the object it is about, or does it only
 * restate the action and the kind?
 *
 * ── Why this is not a list of bad strings ──────────────────────────────────
 * The obvious "fix" is `if (summary === "Create entity") …`. That is a second
 * label table: it rots the moment a producer spells one differently, and it can
 * only ever catch the two strings someone happened to see on a live pod.
 *
 * The principled test is a PROPERTY of the string: a summary that carries no
 * object identity is made ENTIRELY of words the proposal's own metadata could
 * have produced — its action verb (either mood) and its kind noun (curated,
 * pluralised, humanized, or raw). Nothing else. If even one word survives that
 * subtraction, the summary says something the metadata alone could not, and it
 * must be kept: a human wrote it, or it names the object, or it is a sentence
 * ({@link JOIN_GATE_SUMMARY}, a rule's `intent`) that a computed title would
 * destroy.
 *
 * Every word it subtracts comes from `@synap-core/types/vocabulary` — the same
 * SSOT that BUILDS the title — so the comparison can never drift from the
 * builder's own output. Both moods are subtracted because a producer may have
 * written either ("Create entity" / "Created entity"), and the raw token is
 * subtracted because older producers interpolated `subjectType` verbatim.
 *
 * Deliberately conservative in one direction only: an object whose real name
 * happens to be its own kind (an entity titled "Task") is judged identity-free
 * and the derivation replaces it — with the identical string, since the
 * derivation resolves that same name. There is no case where this loses a word.
 */
export function summaryNamesTheObject(
  summary: string,
  parts: {
    changeType?: string;
    proposalType?: string;
    profileSlug?: string;
    targetType?: string;
  }
): boolean {
  const wordsOf = (value: string): string[] =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  // "Proposal" is the builder's own no-action head (`buildFallbackTitle`), so it
  // is metadata too — not a name.
  const identityFree = new Set<string>(["proposal"]);
  const subtract = (phrase: string | undefined | null): void => {
    if (!phrase) return;
    for (const word of wordsOf(phrase)) identityFree.add(word);
  };

  for (const action of [parts.proposalType, parts.changeType]) {
    if (!action) continue;
    subtract(resolveActionLabel(action, "imperative"));
    subtract(resolveActionLabel(action, "past"));
    subtract(action);
  }
  for (const kind of [
    parts.profileSlug,
    parts.targetType,
    parts.proposalType,
  ]) {
    if (!kind) continue;
    subtract(resolveObjectNoun(kind));
    subtract(resolveObjectNounPlural(kind));
    subtract(humanizeToken(kind));
    subtract(kind);
  }

  return wordsOf(summary).some((word) => !identityFree.has(word));
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
