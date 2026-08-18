import {
  db,
  eq,
  and,
  isNull,
  inArray,
  resolveWorkspacePlacement,
  acceptDeterministicGraphWorkspace,
} from "@synap/database";
import { entities, entityFacets, profiles } from "@synap/database/schema";
import { checkPermissionOrPropose } from "./permission-check.js";

/**
 * Shared core for the `channel/bind` governance flow — the SINGLE source of truth
 * for the proposal DATA SHAPE the `channel/bind` approve-executor reads. Called by
 * BOTH transports: the tRPC `bindChannel` procedure and the REST
 * `POST /api/hub/channels/:channelId/bind` route (the door the IS agent uses).
 * Keep the `data` object below in sync with the executor in
 * routers/proposals/approve-executors.ts (key "channel/bind").
 *
 * Binds an ALREADY-EXISTING channel to a context object (usually a client entity)
 * and optionally stamps the firewall role (branchPurpose). ALWAYS proposes unless a
 * workspace explicitly opted "channel.bind" into autoApproveFor — "channel.bind" is
 * deliberately NOT in DEFAULT_AUTO_APPROVE. branchPurpose is carried as explicit data
 * a human confirms; NEVER default-forced (client-comms is immutable once set).
 */
export interface ProposeChannelBindInput {
  /** The human user who should approve this (agent acts on behalf of). */
  userId: string;
  workspaceId: string;
  /** The already-existing channel to bind. */
  channelId: string;
  /** A channel binds to an entity/document/view (default: entity). */
  contextObjectType: "entity" | "document" | "view";
  /** The object (usually a client entity) to point the channel at. */
  contextObjectId: string;
  /** Optional firewall role label ("client-comms" | "team"). Never default-forced. */
  branchPurpose?: string;
  /** Optional provenance: platform-native channel id (for the review card). */
  externalChannelId?: string;
  /** Optional agent reasoning shown in the proposal inbox item. */
  reasoning?: string;
}

/**
 * Pod-wide bind derivation (pod-wide bridge model, item 5).
 *
 * ROUTING ⊥ BINDING: a channel binds to the ENTITY; the governance/home
 * workspace is DERIVED from that entity's role, never supplied by the pod-wide
 * caller. When a bind arrives with NO workspace (an unbound bridge/service key),
 * we resolve the bound entity's kind + facet role slugs through the ONE
 * placement door (`resolveWorkspacePlacement`) — config-first (role-profile
 * scope + declared feeds edges), never a hardcoded map.
 *
 * - Deterministic single winner (rung ≤4, no ambiguity) → auto-derive that
 *   workspace and file the proposal there.
 * - Ambiguous (>1 candidate) or no ontology signal (pod-scope-only entity) →
 *   `ok:false` with candidates, so the caller PROPOSES the choice to the human
 *   rather than silently misfiling. Governance is untouched — the bind still
 *   becomes a `channel/bind` proposal once a home workspace is known.
 */
export type PodWideBindDerivation =
  | { ok: true; workspaceId: string }
  | {
      ok: false;
      reason: string;
      candidates: { id: string; name: string }[];
    };

export async function derivePodWideBindWorkspace(args: {
  userId: string;
  /** The bound entity (contextObjectId, contextObjectType 'entity'). */
  contextObjectId: string;
}): Promise<PodWideBindDerivation> {
  const entity = await db.query.entities.findFirst({
    where: and(
      eq(entities.id, args.contextObjectId),
      isNull(entities.deletedAt)
    ),
    columns: { id: true, type: true },
  });
  if (!entity) {
    return { ok: false, reason: "bound entity not found", candidates: [] };
  }

  // The entity's role/facet slugs (rung-2 ontology signal) — the config-first
  // routing key. `entities.type` is the kind slug.
  const facetRows = await db.query.entityFacets.findMany({
    where: and(
      eq(entityFacets.entityId, entity.id),
      isNull(entityFacets.deletedAt)
    ),
    columns: { profileId: true },
  });
  let facetSlugs: string[] = [];
  if (facetRows.length > 0) {
    const profRows = await db.query.profiles.findMany({
      where: inArray(
        profiles.id,
        facetRows.map((f) => f.profileId)
      ),
      columns: { slug: true },
    });
    facetSlugs = profRows.map((p) => p.slug);
  }

  const placement = await resolveWorkspacePlacement(db, {
    userId: args.userId,
    ...(entity.type ? { kindSlug: entity.type } : {}),
    ...(facetSlugs.length ? { facetSlugs } : {}),
  });

  // Same accept policy as the create/import doors: only a deterministic single
  // winner auto-places; anything else is surfaced for a human decision.
  const deterministic = acceptDeterministicGraphWorkspace(placement);
  if (deterministic) {
    return { ok: true, workspaceId: deterministic };
  }
  return {
    ok: false,
    reason: placement.reason,
    candidates: placement.candidates,
  };
}

export async function proposeChannelBind(input: ProposeChannelBindInput) {
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    workspaceId: input.workspaceId,
    subjectType: "channel",
    action: "bind",
    source: "intelligence",
    data: {
      // `id` IS the subject of this proposal — the channel being bound. It is what
      // permission-check derives `proposals.targetId` from (`data.documentId ||
      // data.entityId || data.id || randomUUID()`), so it MUST be the real channel
      // id: a fresh randomUUID per call made the row un-addressable by its subject
      // AND made the pending-proposal dedup guard (which narrows on targetId and
      // hashes the payload) structurally unable to ever match — every repeated
      // sweep filed another pending bind for the same channel. The approve
      // executor reads `data.channelId`, never `data.id`, so execution is
      // unaffected. Two DIFFERENT binds for the same channel still coexist: the
      // dedup is exact-match on the normalized payload, so a different
      // contextObjectId/branchPurpose hashes differently.
      id: input.channelId,
      channelId: input.channelId,
      contextObjectType: input.contextObjectType,
      contextObjectId: input.contextObjectId,
      ...(input.branchPurpose !== undefined
        ? { branchPurpose: input.branchPurpose }
        : {}),
      ...(input.externalChannelId !== undefined
        ? { externalChannelId: input.externalChannelId }
        : {}),
    },
    reasoning: input.reasoning,
  });

  if ("denied" in perm && perm.denied) {
    return { status: "denied" as const, reason: perm.reason };
  }

  if ("proposalId" in perm) {
    return {
      status: "proposed" as const,
      proposalId: perm.proposalId,
      summary: perm.summary,
      reasoning: perm.reasoning,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
      message: `Proposal created — user must approve binding this channel to ${input.contextObjectType} ${input.contextObjectId}.`,
    };
  }

  // Auto-approved (only if a workspace explicitly opted "channel.bind" into
  // autoApproveFor). The bind itself is applied by the channel/bind executor.
  return {
    status: "approved" as const,
    channelId: input.channelId,
    message: "Channel bind auto-approved.",
  };
}
