/**
 * Entities Router — Kind + Facets writes (Wave 3 router-decomposition).
 *
 * `attachFacet` / `updateFacet` / `detachFacet` — the ONE facet write door
 * (`FacetRepository`), never a direct `entity_facets` insert.
 */

import { z } from "zod";
import { podProcedure } from "../../trpc.js";
import {
  db,
  eq,
  and,
  isNull,
  getDb,
  eventRepository,
  FacetRepository,
  resolveWorkspacePlacement,
  FacetProfileKindError,
  FacetKindMismatchError,
} from "@synap/database";
import {
  entities,
  profiles,
  profileWorkspaceAccess,
} from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { auditLog } from "../../utils/audit-log.js";
import { randomUUID } from "crypto";
import { canWriteFacet } from "../../utils/facet-write-gate.js";
import {
  entityWriteVisibleWhere,
  emitFacetSideEffects,
  resolveFacetProfileSlug,
  FACET_SOURCE_ENUM,
  AUTOMATION_CONTEXT_INPUT,
} from "./helpers.js";

export const facetProcs = {
  attachFacet: podProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        profileSlug: z.string().optional(),
        profileId: z.string().uuid().optional(),
        /** Facet visibility lens. null = pod-wide; omitted = inherit parent. */
        workspaceId: z.string().uuid().nullable().optional(),
        /** Disambiguator when the same role attaches in multiple contexts. */
        contextEntityId: z.string().uuid().nullable().optional(),
        status: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        source: FACET_SOURCE_ENUM,
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        automationContext: AUTOMATION_CONTEXT_INPUT,
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!input.profileSlug && !input.profileId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either profileSlug or profileId must be provided",
        });
      }
      const correlationId = randomUUID();

      // Load the parent entity through the visibility floor — confirms it exists
      // and resolves its workspace for the governance + emit lens.
      const parent = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          isNull(entities.deletedAt),
          entityWriteVisibleWhere(ctx.userId)
        ),
        columns: { id: true, workspaceId: true, type: true, title: true },
      });
      if (!parent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Entity not found: ${input.entityId}`,
        });
      }

      // Best-effort readable label for the context entity (disambiguator) —
      // surfaced on proposal cards alongside entityTitle.
      let contextEntityTitle: string | undefined;
      if (input.contextEntityId) {
        const contextEntity = await db.query.entities.findFirst({
          where: and(
            eq(entities.id, input.contextEntityId),
            isNull(entities.deletedAt),
            entityWriteVisibleWhere(ctx.userId)
          ),
          columns: { title: true },
        });
        if (!contextEntity) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Context entity not found: ${input.contextEntityId}`,
          });
        }
        contextEntityTitle = contextEntity.title ?? undefined;
      }

      // Facet lens follows the parent by default. But when the parent is
      // pod-wide (workspaceId null) and the caller didn't pin a lens, the role
      // itself may be enabled in exactly one workspace — derive that through the
      // one door (rung 2) so a pod-wide entity's role-hat still lands in the
      // domain that enabled it. Deterministic-only: no aiHint / no ASK, so an
      // ambiguous or unimplied role keeps the parent's pod-wide null lens (never
      // a silent guess on a governed write).
      let facetWorkspaceId: string | null;
      if (input.workspaceId !== undefined) {
        facetWorkspaceId = input.workspaceId;
      } else if (parent.workspaceId != null) {
        facetWorkspaceId = parent.workspaceId;
      } else {
        // Resolve the role-profile ROW ONCE, and make the lens decision against
        // THAT row.
        //
        // When the caller pinned `profileId`, the pinned row IS the answer —
        // fetching its slug and then re-querying BY SLUG could decide against a
        // DIFFERENT row, because one slug can be carried by several rows
        // (`profile-repository.ts:164-170`). When only a slug is given, resolve
        // it through `profileRepo.getBySlug`, which applies the caller's
        // visibility floor AND the deterministic specificity sort — an
        // ORDER BY-less `findFirst` let an arbitrary twin win.
        let roleProfile: {
          id: string;
          slug: string;
          scope: string;
          profileKind: string | null;
          isActive: boolean;
        } | null = null;
        if (input.profileId) {
          roleProfile =
            (await db.query.profiles.findFirst({
              where: eq(profiles.id, input.profileId),
              columns: {
                id: true,
                slug: true,
                scope: true,
                profileKind: true,
                isActive: true,
              },
            })) ?? null;
        } else {
          const profileRepo = new (
            await import("@synap/database")
          ).ProfileRepository(db);
          roleProfile = await profileRepo.getBySlug(
            input.profileSlug!,
            undefined,
            ctx.userId
          );
        }
        const facetSlug = roleProfile?.slug ?? input.profileSlug;
        // Only an ACTIVE role-profile drives the ontology pin; anything else
        // (a kind, a soft-deleted row) leaves the decision to placement below.
        const activeRole =
          roleProfile &&
          roleProfile.profileKind === "role" &&
          roleProfile.isActive
            ? roleProfile
            : null;
        // A CROSS-LENS role (a shared/system role-profile surfaced in MANY
        // workspaces) is pod-wide by nature — pinning it to the single lens the
        // caller happens to be a member of would defeat "visible in both". Keep
        // such a role pod-wide (workspace_id = NULL). Only a role that is
        // genuinely single-workspace (workspace-scoped, or shared+granted to
        // exactly one ws) is eligible for the rung-2 ontology pin.
        let stayPodWide = false;
        if (activeRole?.scope === "system") {
          stayPodWide = true;
        } else if (activeRole?.scope === "shared") {
          const grants = await db.query.profileWorkspaceAccess.findMany({
            where: eq(profileWorkspaceAccess.profileId, activeRole.id),
            columns: { workspaceId: true },
          });
          if (grants.length > 1) stayPodWide = true;
        }
        if (stayPodWide || !facetSlug) {
          facetWorkspaceId = null;
        } else {
          const facetPlacement = await resolveWorkspacePlacement(db, {
            userId: ctx.userId,
            facetSlugs: [facetSlug],
            ambientWorkspaceId: null,
          });
          // Only a definitive ontology pick (rung 2, single survivor) moves the
          // facet off pod-wide; candidates / no-signal keep the null lens.
          facetWorkspaceId =
            facetPlacement.rung === 2 ? facetPlacement.workspaceId : null;
        }
      }
      const governanceWorkspaceId = facetWorkspaceId ?? ctx.workspaceId ?? null;

      // Fast-fail BEFORE governance: a structurally impossible attach (target
      // profile isn't a role, or the role doesn't apply to this kind) must be
      // rejected here, not parked as a proposal that can never materialize.
      // FacetRepository remains the validation SSOT — this pre-check throws
      // the repository's own error classes so messages stay single-sourced.
      {
        const candidates = await db.query.profiles.findMany({
          where: input.profileId
            ? eq(profiles.id, input.profileId)
            : eq(profiles.slug, input.profileSlug!),
          columns: {
            id: true,
            slug: true,
            profileKind: true,
            applicableKinds: true,
          },
        });
        if (candidates.length > 0) {
          const roleCandidates = candidates.filter(
            (p) => p.profileKind === "role"
          );
          if (roleCandidates.length === 0) {
            throw new FacetProfileKindError(
              candidates[0].id,
              candidates[0].slug
            );
          }
          const applies = roleCandidates.some(
            (p) =>
              !p.applicableKinds ||
              p.applicableKinds.length === 0 ||
              p.applicableKinds.includes(parent.type)
          );
          if (!applies) {
            throw new FacetKindMismatchError(
              roleCandidates[0].slug,
              parent.type,
              roleCandidates[0].applicableKinds ?? []
            );
          }
        }
        // No candidates → fall through; the repository reports NOT_FOUND with
        // workspace-aware resolution on the granted path.
      }

      // 1. .requested
      const requestedEvent = await auditLog({
        subjectType: "entity_facet",
        action: "attach",
        phase: "requested",
        subjectId: input.entityId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: {
          entityId: input.entityId,
          profileSlug: input.profileSlug,
          profileId: input.profileId,
          contextEntityId: input.contextEntityId,
          status: input.status,
        },
      });

      // 2. Permission → subjectType "facet", action "attach" so the proposal row
      // gets targetType="facet"/proposalType="attach" (the executor's key).
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "facet",
        action: "attach",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          entityId: input.entityId,
          entityTitle: parent.title,
          profileSlug: input.profileSlug,
          profileId: input.profileId,
          workspaceId: facetWorkspaceId,
          // I3: the facet lens follows the parent entity (facetWorkspaceId is
          // parent.workspaceId when the caller didn't override). Persist it as
          // the resolved placement — may be an explicit null for a pod-wide
          // parent — so the materializer never re-pins the facet to the ambient
          // governance workspace (the four-door bug, facet flavour).
          resolvedWorkspaceId: facetWorkspaceId,
          contextEntityId: input.contextEntityId ?? null,
          ...(contextEntityTitle ? { contextEntityTitle } : {}),
          status: input.status,
          properties: input.properties,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Facet attach proposed for review",
          facet: null as Record<string, unknown> | null,
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Write — the ONE door.
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const facetRepo = new FacetRepository(database, eventRepo);
      const facet = await facetRepo.attach(
        {
          entityId: input.entityId,
          profileId: input.profileId,
          profileSlug: input.profileSlug,
          userId: ctx.userId,
          workspaceId: facetWorkspaceId,
          contextEntityId: input.contextEntityId ?? null,
          status: input.status,
          properties: input.properties,
          agentUserId: input.agentUserId,
          correlationId,
        },
        ctx.userId
      );

      // 4. .completed + emit chain
      await auditLog({
        subjectType: "entity_facet",
        action: "attach",
        phase: "completed",
        subjectId: facet.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        // Governance linkage (0231): auto-approve receipt (perm is granted here).
        proposalId: "granted" in perm ? perm.autoApprovedProposalId : undefined,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { entityId: input.entityId, facetId: facet.id },
      });

      const profileSlug =
        input.profileSlug ?? (await resolveFacetProfileSlug(facet.profileId));
      emitFacetSideEffects({
        action: "attach",
        entityId: input.entityId,
        facetId: facet.id,
        profileSlug,
        status: facet.status,
        userId: ctx.userId,
        workspaceId: facet.workspaceId ?? governanceWorkspaceId,
        sessionId: ctx.sessionId ?? null,
        entityTitle: parent.title,
        contextEntityTitle,
        automationContext: input.automationContext,
      });

      return {
        status: "attached" as const,
        message: "Facet attached",
        facetId: facet.id,
        facet,
      };
    }),

  /**
   * Update a facet's status/properties — Kind + Facets (Wave 1C).
   */
  updateFacet: podProcedure
    .input(
      z.object({
        facetId: z.string().uuid(),
        status: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        /** Overlay lens for property validation (defaults to the facet's stored ws). */
        workspaceId: z.string().uuid().nullable().optional(),
        source: FACET_SOURCE_ENUM,
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        automationContext: AUTOMATION_CONTEXT_INPUT,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const facetRepo = new FacetRepository(database, eventRepo);

      // A workspace-scoped role is shared operational state (owner/admin/editor
      // of that workspace); a pod-wide role answers to the pod owner/admins.
      const existing = await facetRepo.getById(input.facetId);
      if (!existing || !(await canWriteFacet(existing, ctx.userId))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Facet not found: ${input.facetId}`,
        });
      }
      const governanceWorkspaceId =
        existing.workspaceId ?? ctx.workspaceId ?? null;

      // Best-effort readable label for the parent entity — surfaced on
      // proposal/notification cards (which otherwise show raw entity ids).
      const parentForUpdate = await db.query.entities.findFirst({
        where: eq(entities.id, existing.entityId),
        columns: { title: true },
      });

      // 1. .requested
      const requestedEvent = await auditLog({
        subjectType: "entity_facet",
        action: "update",
        phase: "requested",
        subjectId: input.facetId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { facetId: input.facetId, status: input.status },
      });

      // 2. Permission → targetType="facet"/proposalType="update".
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "facet",
        action: "update",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          // entityId drives the proposal targetId (points the review card at the
          // parent entity); facetId is what the executor re-runs against.
          entityId: existing.entityId,
          entityTitle: parentForUpdate?.title,
          facetId: input.facetId,
          status: input.status,
          properties: input.properties,
          workspaceId: input.workspaceId ?? null,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Facet update proposed for review",
          facet: null as Record<string, unknown> | null,
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Write
      const facet = await facetRepo.update(
        input.facetId,
        {
          status: input.status,
          properties: input.properties,
          workspaceId: input.workspaceId ?? undefined,
        },
        ctx.userId,
        existing.userId
      );

      // 4. .completed + emit
      await auditLog({
        subjectType: "entity_facet",
        action: "update",
        phase: "completed",
        subjectId: facet.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
      });

      const changedKeys = [
        ...(input.status !== undefined ? ["status"] : []),
        ...(input.properties ? Object.keys(input.properties) : []),
      ];
      emitFacetSideEffects({
        action: "update",
        entityId: existing.entityId,
        facetId: facet.id,
        profileSlug: await resolveFacetProfileSlug(facet.profileId),
        status: facet.status,
        changedKeys,
        userId: ctx.userId,
        workspaceId: facet.workspaceId ?? governanceWorkspaceId,
        sessionId: ctx.sessionId ?? null,
        entityTitle: parentForUpdate?.title,
        automationContext: input.automationContext,
      });

      return { status: "updated" as const, message: "Facet updated", facet };
    }),

  /**
   * Detach a facet (soft-delete) — Kind + Facets (Wave 1C).
   */
  detachFacet: podProcedure
    .input(
      z.object({
        facetId: z.string().uuid(),
        source: FACET_SOURCE_ENUM,
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        automationContext: AUTOMATION_CONTEXT_INPUT,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const facetRepo = new FacetRepository(database, eventRepo);

      const existing = await facetRepo.getById(input.facetId);
      if (!existing || !(await canWriteFacet(existing, ctx.userId))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Facet not found: ${input.facetId}`,
        });
      }
      const governanceWorkspaceId =
        existing.workspaceId ?? ctx.workspaceId ?? null;

      // Best-effort readable label for the parent entity — surfaced on
      // proposal/notification cards (which otherwise show raw entity ids).
      const parentForDetach = await db.query.entities.findFirst({
        where: eq(entities.id, existing.entityId),
        columns: { title: true },
      });

      // 1. .requested
      const requestedEvent = await auditLog({
        subjectType: "entity_facet",
        action: "detach",
        phase: "requested",
        subjectId: input.facetId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { facetId: input.facetId, entityId: existing.entityId },
      });

      // 2. Permission → targetType="facet"/proposalType="detach".
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        subjectType: "facet",
        action: "detach",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sessionId: ctx.sessionId ?? undefined,
        data: {
          entityId: existing.entityId,
          entityTitle: parentForDetach?.title,
          facetId: input.facetId,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          message: "Facet detach proposed for review",
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
        };
      }

      // 3. Write (soft-delete)
      await facetRepo.detach(input.facetId, ctx.userId, existing.userId);

      // 4. .completed + emit
      await auditLog({
        subjectType: "entity_facet",
        action: "detach",
        phase: "completed",
        subjectId: input.facetId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: governanceWorkspaceId,
        correlationId,
      });

      emitFacetSideEffects({
        action: "detach",
        entityId: existing.entityId,
        facetId: input.facetId,
        profileSlug: await resolveFacetProfileSlug(existing.profileId),
        userId: ctx.userId,
        workspaceId: existing.workspaceId ?? governanceWorkspaceId,
        sessionId: ctx.sessionId ?? null,
        entityTitle: parentForDetach?.title,
        automationContext: input.automationContext,
      });

      return { status: "detached" as const, message: "Facet detached" };
    }),
};
