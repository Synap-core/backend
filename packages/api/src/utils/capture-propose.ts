/**
 * Anchored-capture propose routing.
 *
 * Powers the "Capture updates on this entity" flow: instead of writing an
 * anchored capture's extracted changes directly, file each as a reviewable,
 * user-owned proposal through the ONE governed door (`checkPermissionOrPropose`)
 * on its `forcePropose` path. Reuse-only — NO new proposal storage, renderer, or
 * composite op type. This never writes; the caller returns early on the propose
 * path so it stays strictly XOR with the direct-write path.
 *
 * Routing:
 *   - an entity op that targets an EXISTING entity (`existingEntityId` — the
 *     anchor the caller linked, or an identity-strong match) → its property patch
 *     files an `entity.update` proposal (before→after diff via
 *     `captureEntityPreviousData`), and each declared role files a `facet.attach`
 *     proposal on that same entity;
 *   - genuinely-new entities (no `existingEntityId`) + the relations that touch
 *     them (incl. anchor→new links) file ONE composite `entity.create` proposal —
 *     the SAME graph shape the capture door already proposes;
 *   - a relation whose BOTH endpoints are existing entities files a standalone
 *     `relation.create` proposal.
 *
 * Ownership: every call passes `forcePropose: true` + `source: "intelligence"`
 * and NO `agentUserId`, so the write is parked for the authenticated human's
 * review. `forcePropose` guarantees a proposal even for the whitelisted
 * `entity.create` / `entity.update` / `relation.create` actions (the legacy-AI
 * branch of the gate honors it). All proposals share one `correlationId` so the
 * UI can present them as a single set. (The gate may stamp the operator's own
 * personal agent as the proposal's attribution — its established self-hosted-IS
 * behavior — but the proposal is still filed into, and reviewed from, the
 * calling human's queue; we never set `agentUserId` ourselves.)
 */

import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";
import { deriveGatePairFromOperations } from "@synap/governance-policy";
import {
  checkPermissionOrPropose,
  type PermissionResult,
} from "./permission-check.js";
import type { StagedSourceBlob } from "./store-entity-source-blob.js";

const logger = createLogger({ module: "capture-propose" });

export interface CaptureProposeFacet {
  profileSlug: string;
  status?: string;
  properties?: Record<string, unknown>;
  /** References another op's tempId (the disambiguating context entity). */
  contextTempId?: string;
}

export interface CaptureProposeEntity {
  tempId: string;
  profileSlug: string;
  title: string;
  description?: string;
  properties?: Record<string, unknown>;
  content?: string;
  /** When set, this op targets an EXISTING entity (the anchor / a match). */
  existingEntityId?: string;
  facets?: CaptureProposeFacet[];
}

export interface CaptureProposeRelation {
  sourceTempId: string;
  targetTempId: string;
  relationType: string;
}

export interface FileAnchoredCaptureProposalsParams {
  userId: string;
  workspaceId: string | null | undefined;
  /** Shared id grouping every proposal this capture files (the captureId). */
  correlationId: string;
  projectId?: string | null;
  sessionId?: string;
  entities: CaptureProposeEntity[];
  relations: CaptureProposeRelation[];
  /** Validate/normalize a relation slug (falls back to a generic type). */
  resolveRelationType: (type: string) => string;
  /**
   * A source blob the caller already STAGED (bytes + `documents` row exist, no
   * entity touched). Its small reference rides in `data.sourceFile` on exactly
   * ONE of the proposals this call files — the one whose approval materializes
   * the entity the file belongs to — and `attachSourceBlob` binds it there on
   * approval. NEVER the bytes: proposal LIST reads select `data`, so inlining a
   * 7MB base64 payload would drag it through every list.
   *
   * The carrier is chosen to mirror the direct-write path's "primary entity"
   * rule (`created.find(c => !c.linked) ?? created[0]`): if this capture creates
   * any NEW entity the composite `entity.create` proposal carries the file;
   * otherwise the first existing-entity `entity.update` proposal does.
   */
  sourceFile?: StagedSourceBlob;
}

export async function fileAnchoredCaptureProposals(
  params: FileAnchoredCaptureProposalsParams
): Promise<{
  proposalIds: string[];
  /**
   * False when a `sourceFile` was supplied but NO proposal was filed that could
   * carry it (e.g. every op was empty). The caller MUST then discard the staged
   * blob — otherwise the bytes and their `documents` row outlive every decision
   * anyone can make about them, which is precisely the orphan this design
   * exists to prevent.
   */
  sourceFileAttached: boolean;
}> {
  const {
    userId,
    workspaceId,
    correlationId,
    projectId,
    sessionId,
    entities,
    relations,
    resolveRelationType,
    sourceFile,
  } = params;

  const proposalIds: string[] = [];
  // The file rides the composite create when this capture creates anything new;
  // otherwise the first update proposal actually filed takes it. Decided up
  // front, claimed lazily — an existing-entity op with no properties and no
  // description files NO proposal, so "the first op" is not the same as "the
  // first proposal".
  const compositeCarriesFile =
    Boolean(sourceFile) && entities.some((e) => !e.existingEntityId);
  let sourceFileAttached = false;

  // Shared gate options for every change. NO agentUserId (the human is the
  // reviewer); `source: "intelligence"` routes through the legacy-AI branch and
  // `forcePropose` guarantees a proposal there even for whitelisted actions.
  const gateBase = {
    userId,
    workspaceId: workspaceId ?? null,
    source: "intelligence" as const,
    forcePropose: true as const,
    correlationId,
    sessionId,
    projectId: projectId ?? undefined,
  };

  const collect = (perm: PermissionResult): void => {
    if ("denied" in perm && perm.denied) {
      // A hard RBAC/CBAC denial — surface it (mirrors every governed door).
      throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
    }
    if ("proposalId" in perm) {
      proposalIds.push(perm.proposalId);
    }
    // `granted: true` cannot occur on the forcePropose + intelligence path once
    // RBAC passes; if it somehow did, the change is simply not proposed — and it
    // is NEVER written here (propose XOR apply).
  };

  // tempId → real existing entity id (anchor / linked / identity-matched).
  const existingIdByTempId = new Map<string, string>();
  for (const e of entities) {
    if (e.existingEntityId)
      existingIdByTempId.set(e.tempId, e.existingEntityId);
  }

  // 1. Existing-entity ops → update (property patch) + facet.attach (roles).
  for (const e of entities) {
    if (!e.existingEntityId) continue;
    const targetId = e.existingEntityId;

    const props = Object.fromEntries(
      Object.entries(e.properties ?? {}).filter(
        ([, v]) => v !== undefined && v !== null && v !== ""
      )
    );
    const hasDescription = Boolean(e.description && e.description.trim());
    if (Object.keys(props).length > 0 || hasDescription) {
      // Claim the staged file for THIS update proposal when no new entity will
      // be created (so no composite is filed to carry it). First claimer wins.
      const takesFile =
        Boolean(sourceFile) && !compositeCarriesFile && !sourceFileAttached;
      if (takesFile) sourceFileAttached = true;
      collect(
        await checkPermissionOrPropose({
          ...gateBase,
          subjectType: "entity",
          action: "update",
          reasoning: `Capture — update ${e.title || "entity"}`,
          data: {
            // `data.id` becomes the proposal targetId AND drives
            // captureEntityPreviousData → a durable before→after field diff.
            id: targetId,
            ...(hasDescription ? { description: e.description } : {}),
            ...(Object.keys(props).length > 0 ? { properties: props } : {}),
            // Read back on approval by `stagedSourceBlobFrom` in the
            // `entity/update` executor, and on rejection by
            // `discardProposalSourceBlob`.
            ...(takesFile ? { sourceFile } : {}),
          },
        })
      );
    }

    for (const f of e.facets ?? []) {
      const contextEntityId = f.contextTempId
        ? existingIdByTempId.get(f.contextTempId)
        : undefined;
      collect(
        await checkPermissionOrPropose({
          ...gateBase,
          subjectType: "facet",
          action: "attach",
          reasoning: `Capture — add role "${f.profileSlug}" to ${e.title || "entity"}`,
          data: {
            entityId: targetId,
            profileSlug: f.profileSlug,
            ...(f.status ? { status: f.status } : {}),
            ...(f.properties ? { properties: f.properties } : {}),
            ...(contextEntityId ? { contextEntityId } : {}),
          },
        })
      );
    }
  }

  // 2. New entities + the relations touching them → ONE composite create proposal.
  const newEntityTempIds = new Set(
    entities.filter((e) => !e.existingEntityId).map((e) => e.tempId)
  );
  const compositeOps: CompositeProposalOperation[] = [];
  for (const e of entities) {
    if (e.existingEntityId) continue;
    compositeOps.push({
      op: "create_entity",
      ref: e.tempId,
      profileSlug: e.profileSlug,
      title: e.title,
      ...(e.description ? { description: e.description } : {}),
      ...(e.content ? { content: e.content } : {}),
      properties: e.properties ?? {},
      ...(e.facets && e.facets.length
        ? {
            // Rename the capture wire's `contextTempId` → the composite op's
            // `contextRef` so the context resolves at approval time.
            facets: e.facets.map((f) => ({
              profileSlug: f.profileSlug,
              ...(f.status ? { status: f.status } : {}),
              ...(f.properties ? { properties: f.properties } : {}),
              ...(f.contextTempId ? { contextRef: f.contextTempId } : {}),
            })),
          }
        : {}),
    });
  }

  // Both-endpoints-existing relations become standalone relation.create
  // proposals; a relation touching a new entity rides in the composite (an
  // existing endpoint is rewritten to its real id — resolveCompositeRef passes
  // UUIDs through, so it resolves alongside the new-entity ref at approval).
  const standaloneRelations: Array<{
    sourceEntityId: string;
    targetEntityId: string;
    type: string;
  }> = [];
  for (const r of relations) {
    const srcNew = newEntityTempIds.has(r.sourceTempId);
    const tgtNew = newEntityTempIds.has(r.targetTempId);
    const srcExisting = existingIdByTempId.get(r.sourceTempId);
    const tgtExisting = existingIdByTempId.get(r.targetTempId);
    const type = resolveRelationType(r.relationType);

    if (srcNew || tgtNew) {
      const sourceRef = srcNew ? r.sourceTempId : srcExisting;
      const targetRef = tgtNew ? r.targetTempId : tgtExisting;
      if (!sourceRef || !targetRef) {
        logger.warn(
          { relation: r },
          "capture propose: dropping relation with an unresolved endpoint"
        );
        continue;
      }
      compositeOps.push({ op: "create_relation", type, sourceRef, targetRef });
    } else if (srcExisting && tgtExisting) {
      standaloneRelations.push({
        sourceEntityId: srcExisting,
        targetEntityId: tgtExisting,
        type,
      });
    } else {
      logger.warn(
        { relation: r },
        "capture propose: dropping relation with an unresolved endpoint"
      );
    }
  }

  // File the composite ONLY when it carries ≥1 create_entity (the composite
  // predicate requires the first op to be a create_entity). Since a composite
  // relation exists only when it touches a new entity, this always holds.
  if (compositeOps.some((o) => o.op === "create_entity")) {
    if (compositeCarriesFile) sourceFileAttached = true;
    collect(
      await checkPermissionOrPropose({
        ...gateBase,
        // DERIVED, never declared — same rule as the capture door: a composite
        // batch gates at its strictest member, so a new op arm can never be
        // scored by the floors as a plain `entity.create`.
        ...deriveGatePairFromOperations(compositeOps),
        reasoning: "Capture — create related entities",
        // No top-level profileSlug: the gate's create-profile guardrail fires on
        // entity + create + data.profileSlug and would hard-deny a composite.
        data: {
          operations: compositeOps,
          source: "capture",
          // Read back on approval by `stagedSourceBlobFrom` in the composite
          // branch of `applyProposalApproval` (attached to the materialized
          // primary entity), and on rejection by `discardProposalSourceBlob`.
          ...(compositeCarriesFile ? { sourceFile } : {}),
        },
      })
    );
  }

  // 3. Both-endpoints-existing relations → standalone relation.create proposals.
  for (const rel of standaloneRelations) {
    collect(
      await checkPermissionOrPropose({
        ...gateBase,
        subjectType: "relation",
        action: "create",
        reasoning: "Capture — link entities",
        data: {
          id: randomUUID(),
          sourceEntityId: rel.sourceEntityId,
          targetEntityId: rel.targetEntityId,
          type: rel.type,
          // Persisted placement the relation materializer reads back verbatim.
          resolvedWorkspaceId: workspaceId ?? null,
        },
      })
    );
  }

  return { proposalIds, sourceFileAttached };
}
