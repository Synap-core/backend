import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  isNull,
  entities,
  links,
  workspaces,
  getWorkspaceMembership,
  relations,
  ProfileResolutionService,
  mergeEntities,
  PropertyIndexService,
  type MergeMaterializedStamp,
  type LinkEndpointType,
  type LinkType,
  resolveMaterializedEntityWorkspaceId,
  isDomainHomeWorkspace,
  DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  isEntityMergeProposalData,
  type ProposalMaterializedRecord,
} from "@synap-core/types";
import { createLogger } from "@synap-core/core";
import {
  entitiesRouter as regularEntitiesRouter,
  mergeSystemData,
} from "../../entities.js";
import { reconcileApprovedProperties } from "../../../services/proposals/reconcile-proposal-properties.js";
import { completeKnowledgeProposalProperties } from "../../../services/proposals/complete-knowledge-proposal.js";
import { emitSideEffects } from "@synap/events";
import type { Context } from "../../../context.js";
import {
  registerProposalExecutor,
  type StoredProposalData,
} from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import { assertWorkspaceWrite } from "../../../utils/workspace-write-access.js";
import {
  attachSourceBlob,
  stagedSourceBlobFrom,
} from "../../../utils/store-entity-source-blob.js";

const logger = createLogger({ module: "proposal-approve-executors-entity" });

/** Register the entity/* + facet/* approve executors. */
export function registerEntityExecutors(): void {
  // ── entity / create ────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "entity/create",
    async execute({ proposal, payload, userId, input, deps }) {
      // NESTED-FIRST with a FLAT fallback (same posture as `channel/bind`).
      // The canonical envelope is request-shaped (`proposal.data.data`), which
      // the automation door now also emits (jobs/src/utils/automation-governance.ts).
      // Proposals that were already PENDING when that fix landed carry the old
      // FLAT payload — without this fallback they would stay permanently
      // un-approvable ("missing profileSlug").
      const outerData = (proposal.data ?? {}) as Record<string, unknown>;
      const innerData = (outerData.data ?? outerData) as Record<
        string,
        unknown
      >;
      const profileSlug = innerData.profileSlug as string | undefined;
      if (!profileSlug) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Entity proposal is missing profileSlug",
        });
      }

      const proposalWorkspaceId = proposal.workspaceId || null;

      // I3 (resolve-early-and-persist): land where the create door already
      // resolved (`data.resolvedWorkspaceId`), never re-derived from ambient /
      // getEntityScope alone. Same helper as jobs materializer.
      const entityHome = resolveMaterializedEntityWorkspaceId(
        innerData,
        proposalWorkspaceId
      );

      if (entityHome) {
        const filingTarget = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, entityHome),
          columns: {
            workspaceType: true,
            systemSlug: true,
            settings: true,
          },
        });
        if (
          filingTarget &&
          !isDomainHomeWorkspace({
            workspaceType: filingTarget.workspaceType,
            systemSlug: filingTarget.systemSlug,
            settings: filingTarget.settings as {
              surfaceClass?: string | null;
              systemSlug?: string | null;
            } | null,
          })
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
          });
        }
      }

      let entityCallerCtx: {
        db: typeof db;
        authenticated: true;
        userId: string;
        workspaceId: string | null;
        workspaceRole: string;
      };

      if (entityHome === null) {
        // Pod-wide home (persisted null, or legacy global): null ctx is OK.
        entityCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: null,
          workspaceRole: "owner",
        };
      } else {
        const membership = await getWorkspaceMembership(db, entityHome, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        entityCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: entityHome,
          workspaceRole: membership.role,
        };
      }

      const entityCaller = regularEntitiesRouter.createCaller(
        entityCallerCtx as unknown as Context
      );
      const storedEntityId = innerData.id as string | undefined;

      // Property reconciliation (approve-side): match each proposed property key
      // against the target kind's def slugs. Un-modeled free-form keys the AI
      // invented (e.g. `Geo`, `Funding`) are remapped onto a close def slug,
      // or promoted to a first-class def so they become queryable/rendered —
      // instead of being stored verbatim and invisible. Honors the reviewer's
      // per-field `propertyDecisions`. Best-effort: on def-create failure the
      // value is still stored verbatim (no data loss). See
      // services/proposals/reconcile-proposal-properties.ts.
      const profileService = new ProfileResolutionService(db);
      const reconciledProfile = await profileService.resolveProfile(
        profileSlug,
        userId,
        entityCallerCtx.workspaceId
      );
      const reconciledCreate = await reconcileApprovedProperties({
        properties: innerData.properties as Record<string, unknown> | undefined,
        profileId: reconciledProfile?.id ?? profileSlug,
        workspaceId: entityCallerCtx.workspaceId,
        userId,
        decisions: input.propertyDecisions,
      });
      const properties = completeKnowledgeProposalProperties({
        profileSlug: reconciledProfile?.slug ?? profileSlug,
        properties: reconciledCreate.properties,
        title: innerData.title,
        description: innerData.description,
        content: innerData.content,
      });

      // `proposedEntityId` is the id minted at PROPOSE time. `entities.create`
      // honors it when nothing matches, but its identity-first dedup may return
      // a DIFFERENT, pre-existing entity (strong email/phone/url match) with
      // `deduplicated: true` — the whole point of routing approval through the
      // one create door. Read the RETURNED id below for every downstream write.
      //
      // I3 pin: when entityHome is set, pass it as rung-1 `targetWorkspaceId`
      // so create does not re-derive from ambient. Null home → no pin (pod).
      const createdEntity = (await entityCaller.create({
        proposedEntityId: storedEntityId,
        profileSlug,
        title: (innerData.title as string) || "Untitled",
        description: innerData.description as string | undefined,
        properties,
        content: innerData.content as string | undefined,
        // `entities.create` persists `documentId` into the proposal data
        // (entities.ts) but this replay historically dropped it — so an approved
        // entity-with-document proposal (a proposed file upload, or any
        // long-content entity that proposed) lost its document link. Forward it.
        documentId: innerData.documentId as string | undefined,
        ...(entityHome ? { targetWorkspaceId: entityHome } : {}),
        source: "system",
      })) as { id?: string; deduplicated?: boolean };

      // Approve-time FACET channel (single-entity twin of the composite path):
      // Prefer facets stored on the proposal at propose time (R2 — entities.create
      // persists data.facets). Approver can still pass/override via input.facets.
      // Domain-agnostic; duplicate slugs collapsed. Best-effort — never aborts.
      // `entityCaller` is human-approved ctx → attachFacet lands directly.
      type FacetSpec = {
        profileSlug: string;
        status?: string;
        properties?: Record<string, unknown>;
        contextEntityId?: string | null;
      };
      const proposedFacets = Array.isArray(innerData.facets)
        ? (innerData.facets as FacetSpec[])
        : [];
      const approveFacets = input.facets ?? [];
      // Merge: proposal facets first, then approve-time facets (later wins slug).
      const facetBySlug = new Map<string, FacetSpec>();
      for (const f of [...proposedFacets, ...approveFacets]) {
        if (!f?.profileSlug) continue;
        facetBySlug.set(f.profileSlug, f);
      }
      if (createdEntity?.id && facetBySlug.size > 0) {
        for (const facet of facetBySlug.values()) {
          try {
            await entityCaller.attachFacet({
              entityId: createdEntity.id,
              profileSlug: facet.profileSlug,
              ...(facet.status ? { status: facet.status } : {}),
              ...(facet.properties ? { properties: facet.properties } : {}),
              ...(facet.contextEntityId
                ? { contextEntityId: facet.contextEntityId }
                : {}),
              // Do NOT force proposal.workspaceId as the facet lens — for
              // pod-wide parents that may be ambient Admin / non-domain.
              // attachFacet derives role home from ontology (rung 2) or parent.
              source: "system",
            });
          } catch (err) {
            logger.warn(
              {
                err,
                entityId: createdEntity.id,
                profileSlug: facet.profileSlug,
              },
              "Skipping single-entity approve facet (entity kept)"
            );
          }
        }
      }

      // Did this approval MERGE onto an entity that already existed independently
      // of this proposal? `deduplicated` alone isn't enough: a retry (re-approve,
      // or an approve after APPROVAL_FAILED) re-runs this executor and dedups onto
      // the row the FIRST attempt created — same id as the pre-minted one, and
      // ours to own. A merge onto a DIFFERENT id is a pre-existing entity.
      const mergedOntoExisting =
        createdEntity?.deduplicated === true &&
        !!createdEntity.id &&
        createdEntity.id !== storedEntityId;

      // Mirror the composite path (proposals.ts): only entities this proposal
      // actually CREATED are ours to undo / to claim as session output / to file
      // into the proposal's project. A merged-onto entity is recorded nowhere, so
      // `revert` can never delete (nor `belongs_to_project`-widen) a row this
      // proposal did not create. Revert of a merged approval consequently fails
      // loud ("could not undo") rather than destroying the pre-existing subject —
      // the same stance planProposalRevert takes for update proposals.
      const createMaterialized: ProposalMaterializedRecord =
        createdEntity?.id && !mergedOntoExisting
          ? { entityIds: [createdEntity.id] }
          : {};
      const createPayload: StoredProposalData = {
        ...(payload as StoredProposalData),
        materialized: createMaterialized,
      };

      if (proposal.sessionId && createdEntity?.id && !mergedOntoExisting) {
        await db
          .insert(links)
          .values({
            workspaceId: proposal.workspaceId ?? null,
            fromType: "session" as LinkEndpointType,
            fromId: proposal.sessionId,
            toType: "entity" as LinkEndpointType,
            toId: createdEntity.id,
            linkType: "produced" as LinkType,
            metadata: {},
          })
          .onConflictDoNothing();
      }
      if (createdEntity?.id && !mergedOntoExisting) {
        await deps.stampProjectMembership(proposal, [createdEntity.id], userId);
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: createPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── entity / renderer.set ───────────────────────────────────────────────────
  registerProposalExecutor({
    /**
     * Apply a per-ENTITY renderer override that was routed through review.
     *
     * WHY THIS MUST EXIST. Executors resolve on the composite key
     * `${targetType}/${proposalType}`. `entities.setEntityRenderer` proposes
     * with `subjectType: "entity"` + `action: "renderer.set"`, and there was no
     * `entity/renderer.set` entry and no entity-wide wildcard — so the proposal
     * fell through to the catch-all executor, which emits a `.validated` audit
     * event and flips the row to APPROVED **without writing anything**.
     *
     * `entity.renderer.set` is NOT in DEFAULT_AUTO_APPROVE, so that is the
     * ordinary path for an AI/MCP caller and for any workspace with
     * `forcePropose`: the reviewer approves, sees success, and the renderer
     * never changes. The door's docstring claimed parity with the profile door;
     * this is what makes that claim true.
     */
    key: "entity/renderer.set",
    async execute({ proposal, input }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const entityId = innerData.entityId as string | undefined;
      const ref = innerData.ref as
        { kind: "cell"; cellKey: string } | null | undefined;
      if (!entityId || ref === undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Entity renderer proposal is missing entityId/ref",
        });
      }

      // Idempotency, mirroring the profile executor: an already-APPROVED
      // proposal must not be applied twice.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const [row] = await db
        .select({ systemData: entities.systemData })
        .from(entities)
        .where(and(eq(entities.id, entityId), isNull(entities.deletedAt)))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Entity no longer exists",
        });
      }

      // The SAME merge the direct door uses — siblings (`viewMode`,
      // `bentoViewId`, `onboardingScaffold`, `mergedInto`) must survive, and a
      // null ref deletes the key rather than leaving a tombstone.
      await db
        .update(entities)
        .set({
          systemData: mergeSystemData(row.systemData, { renderer: ref }),
          updatedAt: new Date(),
        })
        .where(eq(entities.id, entityId));

      return { success: true, primaryId: entityId };
    },
  });

  // ── entity / update ────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "entity/update",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      // Nested-first with a flat fallback — see `entity/create` for why.
      const outerUpdateData = (proposal.data ?? {}) as Record<string, unknown>;
      const innerData = (outerUpdateData.data ?? outerUpdateData) as Record<
        string,
        unknown
      >;
      const entityId = (innerData.id as string) || proposal.targetId;
      // Workspace-scoped: verify the approver's membership + role. Pod-wide
      // (`proposal.workspaceId === null`) runs at pod scope — the SAME branch
      // `entity/create`'s pod-wide home and `entity/delete` already take.
      //
      // The `proposal.workspaceId!` this replaces was not a type nicety: for a
      // pod-wide entity (`entities.workspaceId` NULL = global, the documented
      // doctrine) it made `eq(workspace_members.workspace_id, NULL)` — a
      // predicate that can never match — so EVERY pod-wide entity/update
      // approval threw FORBIDDEN "No workspace access" and the proposal was
      // stuck pending forever. Approve-authority is NOT weakened by dropping
      // it: `computeCanReviewApproval` has already gated this call upstream
      // (pod-wide ⇒ proposal owner / agent-owner / pod-admin ONLY), and the
      // `entities.update` podProcedure below re-applies its own floor
      // (`entityWriteVisibleWhere(userId)`), which is what actually authorizes
      // the write. The membership row was a THIRD, redundant gate that only
      // ever spoke workspace.
      const wsId = proposal.workspaceId ?? null;
      let workspaceRole = "owner";
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        workspaceRole = membership.role;
      }
      const entityCallerCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: wsId,
        workspaceRole,
      };
      const entityCaller = regularEntitiesRouter.createCaller(
        entityCallerCtx as unknown as Context
      );

      // Property reconciliation (approve-side) — same contract as entity/create:
      // resolve the entity's kind, then match/remap/promote each proposed property
      // key against that kind's def slugs (honoring `propertyDecisions`). Best-effort;
      // verbatim fallback on def-create failure. See entity/create for the rationale.
      let reconciledUpdateProps = innerData.properties as
        Record<string, unknown> | undefined;
      if (
        reconciledUpdateProps &&
        Object.keys(reconciledUpdateProps).length > 0
      ) {
        const targetEntity = await db.query.entities.findFirst({
          where: eq(entities.id, entityId),
          columns: { profileId: true, workspaceId: true },
        });
        if (targetEntity?.profileId) {
          const reconciled = await reconcileApprovedProperties({
            properties: reconciledUpdateProps,
            profileId: targetEntity.profileId,
            workspaceId:
              proposal.workspaceId ?? targetEntity.workspaceId ?? null,
            userId,
            decisions: input.propertyDecisions,
          });
          reconciledUpdateProps = reconciled.properties;
        }
      }

      await entityCaller.update({
        id: entityId,
        title: innerData.title as string | undefined,
        description: innerData.description as string | undefined,
        properties: reconciledUpdateProps,
        deleteProperties: innerData.deleteProperties as string[] | undefined,
        source: "system",
      });

      // A governed source-file attach: the bytes were STAGED before this
      // proposal was filed (`stageSourceBlob`) and only the small reference
      // rides in `data.sourceFile`. The property patch above already replayed
      // the `sourceFile*` provenance keys; `attachSourceBlob` is still required
      // because it ALSO takes the `entities.document_id` link (under its
      // `IS NULL` no-clobber guard) — the column the embedding worker, the
      // retrieval join and Typesense enrichment all key off. Without this the
      // approval wrote five properties and the file stayed invisible.
      // Best-effort: the entity update is already committed.
      const stagedFile = stagedSourceBlobFrom(innerData);
      if (stagedFile) {
        try {
          await attachSourceBlob({
            database: db,
            userId,
            entityId,
            staged: stagedFile,
          });
        } catch (err) {
          logger.warn(
            { err, proposalId: input.proposalId, entityId },
            "entity/update: source blob attach failed (update kept)"
          );
        }
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── entity / delete ──────────────────────────────────────────────────────
  // Materialize an approved delete proposal (agents can't delete directly —
  // their role gates auto-execution, so a delete is proposed; this executor is
  // what makes approval actually delete). The APPROVER (userId) authorizes it
  // with their own role; the delete procedure re-checks and soft-deletes inline
  // (owner holds `delete`). Without this, an approved delete proposal was a
  // silent no-op.
  registerProposalExecutor({
    key: "entity/delete",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const entityId = (innerData.id as string) || proposal.targetId;
      // Workspace-scoped: verify the approver's membership + role. Pod-wide
      // (null workspace): the approver owns the pod, run at pod scope.
      const wsId = proposal.workspaceId ?? undefined;
      let workspaceRole = "owner";
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        workspaceRole = membership.role;
      }
      const entityCaller = regularEntitiesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        ...(wsId ? { workspaceId: wsId } : {}),
        workspaceRole,
      } as unknown as Context);
      await entityCaller.delete({ id: entityId, source: "system" });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── entity / merge ───────────────────────────────────────────────────────
  // Pod Hygiene W0: near-duplicate → glass-box merge. ALWAYS proposal-gated
  // (`merge` ∈ DESTRUCTIVE_ACTIONS). Materializes via EntityMergeService only
  // (one door). Stamps data.materialized.merge + full snapshots for unmerge.
  registerProposalExecutor({
    key: "entity/merge",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const raw = proposal.data;
      if (!isEntityMergeProposalData(raw)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "entity/merge proposal data is missing winnerId/loserId/confidence/method",
        });
      }

      // Membership: workspace-scoped proposals require access; pod-wide (null)
      // runs as the approver who owns the entities (mergeEntities checks userId).
      const wsId = proposal.workspaceId ?? undefined;
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
      }

      // mergeEntities asserts entity.userId === input.userId. Run as the
      // DATA OWNER (sourceId / winner row), not the approver — admins may
      // review but the data plane is still the owner's graph.
      const winnerRow = await db.query.entities.findFirst({
        where: eq(entities.id, raw.winnerId),
        columns: {
          id: true,
          userId: true,
          profileId: true,
          workspaceId: true,
          properties: true,
        },
      });
      if (!winnerRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Winner entity not found",
        });
      }
      const ownerUserId =
        (typeof raw.sourceId === "string" && raw.sourceId) || winnerRow.userId;

      let result;
      try {
        result = await mergeEntities(db, {
          winnerId: raw.winnerId,
          loserId: raw.loserId,
          userId: ownerUserId,
        });
      } catch (err) {
        logger.warn(
          {
            proposalId: input.proposalId,
            err: err instanceof Error ? err.message : String(err),
          },
          "entity/merge executor failed"
        );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Couldn't apply — the merge could not be completed.",
        });
      }

      // Winner properties may have grown (fill-null) — reindex hot props
      // (email etc.) so identity/filter paths stay correct.
      if (winnerRow.profileId) {
        try {
          const indexService = new PropertyIndexService(db);
          const winnerAfter = await db.query.entities.findFirst({
            where: eq(entities.id, result.winnerId),
            columns: { properties: true, profileId: true, workspaceId: true },
          });
          if (winnerAfter?.profileId) {
            await indexService.reindexEntity(
              result.winnerId,
              (winnerAfter.properties as Record<string, unknown>) ?? {},
              winnerAfter.profileId,
              winnerAfter.workspaceId
            );
          }
        } catch (err) {
          // Best-effort — merge already committed; search side-effects still run.
          void err;
        }
      }

      // Invertibility stamp for full unmerge (mirrors MergeMaterializedStamp).
      const m = result.materialized;
      const mergeStamp: NonNullable<ProposalMaterializedRecord["merge"]> &
        MergeMaterializedStamp & { winnerId: string; loserId: string } = {
        winnerId: result.winnerId,
        loserId: result.loserId,
        movedSignalIds: m.movedSignalIds,
        movedExternalLinkIds: m.movedExternalLinkIds,
        movedFacetIds: m.movedFacetIds,
        rewiredRelations: m.rewiredRelations,
        documentMoved: m.documentMoved,
        // Also stamp bare ids for older clients that still read rewiredRelationIds.
        rewiredRelationIds: m.rewiredRelations.map((r) => r.id),
      };
      if (m.winnerFacetIds?.length)
        mergeStamp.winnerFacetIds = m.winnerFacetIds;
      if (m.rewiredMessageLinkIds?.length) {
        mergeStamp.rewiredMessageLinkIds = m.rewiredMessageLinkIds;
      }
      if (m.rewiredLinkIds?.length)
        mergeStamp.rewiredLinkIds = m.rewiredLinkIds;
      if (m.deletedRelationIds?.length) {
        mergeStamp.deletedRelationIds = m.deletedRelationIds;
      }

      // Full pre-merge snapshots from mergeEntities (title/preview/properties/
      // documentId/systemData). Overlay detector snapshots so review UI fields
      // (profileSlug etc.) are preserved while unmerge always has enough.
      const fullWinnerSnapshot = {
        title: result.previousWinnerSnapshot.title,
        preview: result.previousWinnerSnapshot.preview,
        properties: result.previousWinnerSnapshot.properties,
        documentId: result.previousWinnerSnapshot.documentId,
        systemData: result.previousWinnerSnapshot.systemData,
      };
      const fullLoserSnapshot = {
        title: result.previousLoserSnapshot.title,
        preview: result.previousLoserSnapshot.preview,
        properties: result.previousLoserSnapshot.properties,
        documentId: result.previousLoserSnapshot.documentId,
        systemData: result.previousLoserSnapshot.systemData,
      };

      const nextData = {
        ...raw,
        sourceId: raw.sourceId ?? ownerUserId,
        // Detector fields (profileSlug etc.) first; merge-time projection
        // overwrites title/preview/properties/documentId/systemData so unmerge
        // restores the exact pre-merge entity state.
        previousWinnerSnapshot: {
          ...(raw.previousWinnerSnapshot ?? {}),
          ...fullWinnerSnapshot,
        },
        previousLoserSnapshot: {
          ...(raw.previousLoserSnapshot ?? {}),
          ...fullLoserSnapshot,
        },
        materialized: {
          ...(typeof raw.materialized === "object" && raw.materialized
            ? raw.materialized
            : {}),
          merge: mergeStamp,
        },
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          data: nextData as unknown as Record<string, unknown>,
        })
        .where(eq(proposals.id, input.proposalId));

      // Search/embeddings/realtime — mergeEntities is data-plane only.
      const governanceWorkspaceId = proposal.workspaceId ?? null;
      emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: result.winnerId,
        userId: ownerUserId,
        workspaceId: governanceWorkspaceId,
        data: { reason: "entity.merge", loserId: result.loserId },
      });
      emitSideEffects({
        subjectType: "entity",
        action: "delete",
        subjectId: result.loserId,
        userId: ownerUserId,
        workspaceId: governanceWorkspaceId,
        data: { reason: "entity.merge", winnerId: result.winnerId },
      });

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── facet / attach ───────────────────────────────────────────────────────
  // Kind + Facets (Wave 1C). Approval re-runs the FULL attachFacet door (incl.
  // the facet emit chain) as the approver, mirroring entity/update. Pod-wide
  // facets (null workspace) run at pod scope like entity/delete.
  registerProposalExecutor({
    key: "facet/attach",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const entityId = innerData.entityId as string | undefined;
      if (!entityId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Facet attach proposal is missing entityId",
        });
      }
      const wsId = proposal.workspaceId ?? undefined;
      let workspaceRole = "owner";
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        workspaceRole = membership.role;
      }
      const entityCaller = regularEntitiesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        ...(wsId ? { workspaceId: wsId } : {}),
        workspaceRole,
      } as unknown as Context);
      await entityCaller.attachFacet({
        entityId,
        profileSlug: innerData.profileSlug as string | undefined,
        profileId: innerData.profileId as string | undefined,
        workspaceId:
          (innerData.workspaceId as string | null | undefined) ?? undefined,
        contextEntityId:
          (innerData.contextEntityId as string | null | undefined) ?? undefined,
        status: innerData.status as string | undefined,
        properties: innerData.properties as Record<string, unknown> | undefined,
        source: "system",
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── facet / update ─────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "facet/update",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const facetId = innerData.facetId as string | undefined;
      if (!facetId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Facet update proposal is missing facetId",
        });
      }
      const wsId = proposal.workspaceId ?? undefined;
      let workspaceRole = "owner";
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        workspaceRole = membership.role;
      }
      const entityCaller = regularEntitiesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        ...(wsId ? { workspaceId: wsId } : {}),
        workspaceRole,
      } as unknown as Context);
      await entityCaller.updateFacet({
        facetId,
        status: innerData.status as string | undefined,
        properties: innerData.properties as Record<string, unknown> | undefined,
        workspaceId:
          (innerData.workspaceId as string | null | undefined) ?? undefined,
        source: "system",
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── facet / detach ─────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "facet/detach",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const facetId = innerData.facetId as string | undefined;
      if (!facetId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Facet detach proposal is missing facetId",
        });
      }
      const wsId = proposal.workspaceId ?? undefined;
      let workspaceRole = "owner";
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        workspaceRole = membership.role;
      }
      const entityCaller = regularEntitiesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        ...(wsId ? { workspaceId: wsId } : {}),
        workspaceRole,
      } as unknown as Context);
      await entityCaller.detachFacet({ facetId, source: "system" });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
  // ── relation / delete ────────────────────────────────────────────────────
  // Lives in this file because a relation is an entity-graph edge — there is no
  // `executors/relation.ts`, and adding one would mean editing the aggregator.
  //
  // `relations.delete` (routers/relations.ts:1437) sits on the rung-2.5
  // DESTRUCTIVE floor, which no rung can widen, so an agent unlinking two
  // entities ALWAYS proposes. With no executor, approval fell to the `*​/*`
  // catch-all and the edge survived while the reviewer was told "approved".
  // The materializer is not a backstop here: `materializeRelation` handles only
  // `"create"`, so a `relation.delete.validated` event dies at its INNER guard.
  //
  // PAYLOAD: the gate stores FLAT `data: { id }` (nested as `data.data.id`);
  // `proposal.targetId` holds the same id. All three shapes are read.
  //
  // SECOND EFFECT: the direct path is FOUR effects, not one —
  // `RelationRepository.delete` (row + `relation.delete.completed`, which must
  // carry the workspaceId or the realtime bridge drops it), the
  // `belongs_to_project` AI-CORRECTION feedback signal (`emitAiCorrection` —
  // how the project-placement recommender learns it was wrong), the
  // relation→property REVERSE SYNC (`syncRelationToPropertyOnDelete`, which
  // clears the mirrored entity_id property), and `recordDomainMutation`
  // (audit + reactor bus). Writing the row delete here would have silently
  // dropped three of them. So this replays through `relationsRouter.delete`.
  //
  // IDENTITY: acts as the relation's OWNER. `RelationRepository.delete` gates
  // `.where(and(eq(relations.id, …), eq(relations.userId, userId)))` — an
  // OWNERSHIP predicate that throws a RAW `Error("Relation not found")` (a 500)
  // for any other caller, before the status update, stranding the proposal
  // PENDING forever. The APPROVER's own floor is asserted first against the
  // LOADED row and is same-or-stricter than the router's own
  // `assertWorkspaceWrite` (it additionally pins the pod-wide case to the
  // owner), so no authority is widened.
  registerProposalExecutor({
    key: "relation/delete",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const relationId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!relationId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Relation delete proposal is missing the relation id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const relation = await db.query.relations.findFirst({
        where: eq(relations.id, relationId),
        columns: { id: true, userId: true, workspaceId: true },
      });
      if (!relation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Relation to delete no longer exists",
        });
      }

      await assertWorkspaceWrite(db, userId, {
        workspaceId: relation.workspaceId,
        ownerId: relation.userId,
      });

      const { relationsRouter } = await import("../../relations.js");
      const relationCaller = relationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: relation.userId,
        workspaceId: relation.workspaceId ?? undefined,
      } as unknown as Context);

      // Pass the ROW's workspace explicitly: `delete` derives
      // `effectiveWorkspaceId` from input/ctx, and that value is what the
      // reverse-sync and the audit/reactor emit key off.
      assertApplied(
        await relationCaller.delete({
          id: relationId,
          ...(relation.workspaceId
            ? { workspaceId: relation.workspaceId }
            : {}),
        })
      );

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── relation / update ─────────────────────────────────────────────────────
  // Before the payload widening this gate stored `{ id }` alone — it described
  // NO CHANGE, so an approved relation-update proposal had nothing to apply.
  // It now carries the two fields `relationRepo.update` actually reads.
  //
  // SECOND EFFECT: the direct path is `assertWorkspaceWrite` →
  // `relationRepo.update` (row + the `relation.update` event through the SHARED
  // `eventRepository` singleton, whose hooks drive realtime/materialization) →
  // `recordDomainMutation` (audit + reactor bus). A direct `db.update(relations)`
  // here would drop the event hooks and the reactor — the same trap
  // `relation/delete` above documents.
  //
  // IDENTITY: acts as the relation's OWNER, for the SAME reason as
  // `relation/delete` — `RelationRepository.update` gates on
  // `and(eq(relations.id, …), eq(relations.userId, userId))`, an OWNERSHIP
  // predicate, so an approver who is not the owner would silently match zero
  // rows. The APPROVER's own floor is asserted first against the LOADED row
  // (workspace + ownerId), which is same-or-stricter than the router's
  // `assertWorkspaceWrite`, so no authority is widened.
  registerProposalExecutor({
    key: "relation/update",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const relationId =
        (inner.id as string | undefined) ??
        (raw.id as string | undefined) ??
        proposal.targetId;
      if (!relationId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Relation update proposal is missing the relation id",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const relation = await db.query.relations.findFirst({
        where: eq(relations.id, relationId),
        columns: { id: true, userId: true, workspaceId: true },
      });
      if (!relation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Relation to update no longer exists",
        });
      }

      await assertWorkspaceWrite(db, userId, {
        workspaceId: relation.workspaceId,
        ownerId: relation.userId,
      });

      // The patch must carry ONLY what was proposed: the procedure copies a
      // field into `updateData` solely when it is `!== undefined`, so an
      // omitted key stays omitted and the column is untouched. Spreading
      // conditionally reproduces that; passing `type: undefined` explicitly
      // would be equivalent here, but building the object this way keeps the
      // "only patch what was sent" contract visible at the call site.
      const type = inner.type as string | undefined;
      const metadata = inner.metadata as Record<string, unknown> | undefined;
      if (type === undefined && metadata === undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Relation update proposal describes no change (no `type`, no `metadata`).",
        });
      }

      const { relationsRouter } = await import("../../relations.js");
      const relationCaller = relationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: relation.userId,
        workspaceId: relation.workspaceId ?? undefined,
      } as unknown as Context);

      // Pass the ROW's workspace explicitly — `update` derives
      // `effectiveWorkspaceId` from input/ctx, and that value is what the
      // audit/reactor emit keys off (same reason as `relation/delete`).
      assertApplied(
        await relationCaller.update({
          id: relationId,
          ...(type !== undefined ? { type } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(relation.workspaceId
            ? { workspaceId: relation.workspaceId }
            : {}),
        })
      );

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}
