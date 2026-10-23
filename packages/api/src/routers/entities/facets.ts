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
  or,
  isNull,
  getDb,
  getRequestGrant,
  eventRepository,
  FacetRepository,
  ProfileResolutionService,
  resolveWorkspacePlacement,
  FacetProfileKindError,
  FacetKindMismatchError,
  roleFacetIsPodWide,
  WORKSPACE_MEMBERSHIP_ROLE_CATEGORY,
} from "@synap/database";
import { entities, profiles } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { lifecycleConflictError } from "../../services/lifecycle/conflict.js";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { auditLog } from "../../utils/audit-log.js";
import {
  grantRequestForWrite,
  grantWriteDenial,
} from "../../utils/grant-write-check.js";
import { roleInSpacesWhere } from "../../utils/project-scope.js";
import { grantReadPredicate } from "../../access/grant-read.js";
import { permits } from "@synap/governance-policy/grants";
import {
  moveStatus,
  statusMoveActorFor,
  type MoveStatusResult,
} from "../../services/lifecycle/move-status.js";
import { initialStatusFloor } from "../../services/lifecycle/initial-status-floor.js";
import { randomUUID } from "crypto";
import { canWriteFacet } from "../../utils/facet-write-gate.js";
import {
  entityWriteVisibleWhere,
  emitFacetSideEffects,
  resolveFacetProfileSlug,
  FACET_SOURCE_ENUM,
  AUTOMATION_CONTEXT_INPUT,
} from "./helpers.js";

/**
 * D1 (review rv-model M3, 2026-10-23; DRAFT for the founder): a role write is
 * bounded by the calling key's grant in the ROLE's space only. The role IS the
 * space lens, so "make Ada a lead in CRM" is a write in CRM, whatever Ada's own
 * workspace is. Supersedes D2 (S7, 2026-10-20), which also checked the PARENT
 * entity's workspace: that refused every role on a pod-wide person (null), so
 * no app could make a contact a lead or move a lead's stage.
 *
 *  - `facetWorkspaceId` is where the facet row is STORED. null = a shared or
 *    system role: ONE row, seen in every space the role is granted to, so a
 *    write from S changes what the other spaces see. A key limited to spaces
 *    cannot write it (the grant refuses null; the message says why).
 *  - Under a scope limited to spaces, the parent must already be in that
 *    space's reach: stored in it, or wearing a live role there (the read rule,
 *    `roleInSpacesWhere`), and readable by the key. A role never pulls a record
 *    the space could not see into it.
 *
 * Runs before anything is written or filed; a no-op without a grant (a
 * signed-in session, an approval replayed by the person).
 */
async function assertRoleWriteGrant(
  action: "attach" | "update" | "detach",
  entityId: string,
  facetWorkspaceId: string | null
): Promise<void> {
  const grant = getRequestGrant();
  if (!grant) return;
  const write = {
    subjectType: "facet",
    action,
    workspaceId: facetWorkspaceId,
    data: { entityId },
  };
  const denial = await grantWriteDenial(write, grant);
  if (denial) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        facetWorkspaceId === null
          ? `${denial} A shared role is stored pod-wide and shows in every space it is granted to, so a key limited to spaces cannot write it.`
          : denial,
    });
  }
  // Only a scope NOT limited to spaces can have permitted a pod-wide row.
  if (facetWorkspaceId === null) return;
  const req = await grantRequestForWrite(write);
  if (grant.scopes.some((s) => !s.workspaceIds && permits(s, req))) return;
  const [inReach] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        isNull(entities.deletedAt),
        grantReadPredicate(entities),
        or(
          eq(entities.workspaceId, facetWorkspaceId),
          roleInSpacesWhere(entities.workspaceId, entities.id, [
            facetWorkspaceId,
          ])
        )
      )
    )
    .limit(1);
  if (!inReach) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This key's grant does not allow "facet.${req.action}" on a record outside workspace ${facetWorkspaceId}: a role goes only on a record that space already reaches (stored in it, or wearing a role there).`,
    });
  }
}

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
          roleCategory?: string | null;
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
                roleCategory: true,
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
        //
        // W2b ROLE PRINCIPLE: one role per name, pod-wide. A shared role (any
        // grant count — a grant added later must reach existing facets) or a
        // system role is pod-wide REGARDLESS of the parent's workspace: pinning
        // it to the parent's lens hid a client hat worn in CRM from Operations.
        // `FacetRepository.attach` enforces the same rule on the stored row
        // (storedFacetWorkspaceId); deciding it here too keeps the persisted
        // `resolvedWorkspaceId` and the governance lens honest.
        // Same rule as the write door (roleFacetIsPodWide): a per-workspace
        // membership role (team-member) follows its lens instead.
        const stayPodWide = roleFacetIsPodWide(activeRole);
        if (stayPodWide) {
          facetWorkspaceId = null;
        } else if (
          activeRole?.roleCategory === WORKSPACE_MEMBERSHIP_ROLE_CATEGORY
        ) {
          // Membership of a workspace: the lens IS the meaning — the parent's
          // workspace, else the caller's.
          facetWorkspaceId = parent.workspaceId ?? ctx.workspaceId ?? null;
        } else if (parent.workspaceId != null) {
          // A workspace-private role (or a non-role row) follows its parent.
          facetWorkspaceId = parent.workspaceId;
        } else if (!facetSlug) {
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
      //
      // It judges the SAME ROW the executor will attach: `FacetRepository
      // .attach` resolves `resolveProfile(profileId ?? profileSlug, userId,
      // workspaceId ?? "")`, and this is that exact call. The old pre-check
      // read EVERY row carrying the slug (no visibility floor, no is_active,
      // no ORDER BY) and passed if ANY twin applied — so it could wave through
      // an attach the executor then refused, or name an arbitrary twin in the
      // error. Mirroring the executor keeps the two from disagreeing, whatever
      // tie-break `getBySlug` applies.
      // Lifecycle floor for a role BORN in a closing / person-only status
      // (tighten-only — `initial-status-floor.ts`).
      let initialLifecycleMove:
        { intoTerminal: boolean; humanOnly: boolean } | undefined;
      // Where `FacetRepository.attach` will STORE the row (a shared/system
      // role is pod-wide whatever lens was asked) — the grant's second target.
      let storedFacetWorkspaceId = facetWorkspaceId;
      {
        const target = await new ProfileResolutionService(db).resolveProfile(
          input.profileId ?? input.profileSlug!,
          ctx.userId,
          facetWorkspaceId ?? ""
        );
        if (target) {
          if (roleFacetIsPodWide(target)) storedFacetWorkspaceId = null;
          initialLifecycleMove = await initialStatusFloor({
            profileId: target.id,
            workspaceId: facetWorkspaceId,
            status: input.status,
            properties: input.properties,
          });
          if (target.profileKind !== "role") {
            throw new FacetProfileKindError(target.id, target.slug);
          }
          const applicableKinds = target.applicableKinds ?? [];
          if (
            applicableKinds.length > 0 &&
            (!parent.type || !applicableKinds.includes(parent.type))
          ) {
            throw new FacetKindMismatchError(
              target.slug,
              parent.type ?? "(unknown)",
              applicableKinds
            );
          }
        }
        // Not resolvable → fall through; the repository reports NOT_FOUND from
        // the same resolution.
      }

      // The ACTOR, resolved once for this door.
      //
      // `input.agentUserId` is the agent's own inline door (hub/MCP).
      // `ctx.agentUserId` is the DELEGATED door: `applyProposalApproval` wires
      // `facetCaller: entityCaller`, i.e. the composite caller whose `userId`
      // is the APPROVER and whose `agentUserId` is the agent that authored the
      // proposal. Reading `input` alone made the two AUDIT EVENTS attribute an
      // agent's facet attach to the approving human — while the facet ROW below
      // named the agent. A row and its own events disagreeing about who acted
      // is exactly the fork this wave exists to close: fixed for relations,
      // missed here.
      //
      // ATTRIBUTION ONLY — deliberately NOT substituted into the permission
      // gate, where a re-gate would re-propose an already-approved write (the
      // same split `entities/create.ts` documents).
      const actingAgentUserId =
        input.agentUserId ?? ctx.agentUserId ?? undefined;

      await assertRoleWriteGrant(
        "attach",
        input.entityId,
        storedFacetWorkspaceId
      );

      // 1. .requested
      const requestedEvent = await auditLog({
        subjectType: "entity_facet",
        action: "attach",
        phase: "requested",
        subjectId: input.entityId,
        userId: ctx.userId,
        agentUserId: actingAgentUserId,
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
        // D1: the grant is checked where the role row is STORED, never on the
        // parent's own (possibly pod-wide) workspace.
        grantWorkspaceId: storedFacetWorkspaceId,
        subjectType: "facet",
        action: "attach",
        source: input.source,
        lifecycleMove: initialLifecycleMove,
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
          message: proposedMessageFor(
            perm.proposalType,
            "Facet attach proposed for review"
          ),
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
          // Provenance (Wave B3) — the ACTOR, resolved from the input (the
          // agent's own inline door, which names itself) OR the context (the
          // DELEGATED door: `applyProposalApproval`'s composite caller, whose
          // `userId` is the APPROVER and whose `agentUserId` is the agent that
          // authored the proposal). Reading `input` alone stamped every
          // approved facet attach `created_by_kind = 'human'`, which is the
          // approver impersonating the agent. Attribution only — the governance
          // gate above deliberately keeps reading `input.agentUserId`, since
          // re-gating an already-approved write would re-propose it.
          agentUserId: actingAgentUserId,
          sourceProposalId: ctx.governanceProposalId,
          correlationId,
          // The door announces a NEW attach itself (`notifyFacetAttached` →
          // `emitFacetSideEffects`, wired at boot) — every attach path, not
          // only this router. This is what it cannot know on its own.
          emitContext: {
            sessionId: ctx.sessionId ?? null,
            origin: ctx.origin,
            proposalId: ctx.governanceProposalId,
            automationContext: input.automationContext,
            entityTitle: parent.title,
            contextEntityTitle: contextEntityTitle ?? null,
            fallbackWorkspaceId: governanceWorkspaceId,
          },
        },
        ctx.userId
      );

      // 4. .completed (the emit chain is the door's — see above)
      await auditLog({
        subjectType: "entity_facet",
        action: "attach",
        phase: "completed",
        subjectId: facet.id,
        userId: ctx.userId,
        agentUserId: actingAgentUserId,
        // Governance linkage (0231): auto-approve receipt (perm is granted here).
        proposalId: "granted" in perm ? perm.autoApprovedProposalId : undefined,
        workspaceId: governanceWorkspaceId,
        correlationId,
        data: { entityId: input.entityId, facetId: facet.id },
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
        /** The role status the caller SAW — `expectedFrom` of the status move. */
        expectedStatus: z.string().nullable().optional(),
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
      await assertRoleWriteGrant(
        "update",
        existing.entityId,
        existing.workspaceId ?? null
      );

      // LIFECYCLE SPLIT (work model L2): a ROLE's status — `status`, or its
      // lifecycle property — is MOVED through the one door (`moveStatus`:
      // compare-and-set, the lifecycle floor, the transition event), first, so
      // a stale move rejects the whole call before anything is written.
      let statusMove: MoveStatusResult | undefined;
      const roleLifecycle = await new ProfileResolutionService(
        db
      ).getEffectiveLifecycle(
        existing.profileId,
        input.workspaceId ?? existing.workspaceId ?? null
      );
      if (roleLifecycle) {
        const slug = roleLifecycle.propertySlug;
        const fromProps = input.properties?.[slug];
        const to = input.status ?? fromProps;
        if (
          input.status !== undefined &&
          fromProps !== undefined &&
          fromProps !== input.status
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `"status" and "${slug}" disagree; send the role's status once.`,
          });
        }
        if (input.properties && slug in input.properties) {
          const { [slug]: _moved, ...rest } = input.properties;
          input.properties = Object.keys(rest).length > 0 ? rest : undefined;
        }
        input.status = undefined;
        if (to !== undefined && to !== existing.status) {
          if (typeof to !== "string" || to === "") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `"${slug}" is this role's status and needs one of its status values.`,
            });
          }
          // The DELEGATED door (an approved proposal replayed through the
          // composite caller) carries the agent on `ctx` for ATTRIBUTION and an
          // approved proposal id: it is replayed, never re-governed.
          const mover = statusMoveActorFor(ctx, input);
          statusMove = await moveStatus({
            entityId: existing.entityId,
            facetId: existing.id,
            to,
            expectedFrom: input.expectedStatus,
            approvedProposalId: mover.approvedProposalId,
            actor: mover.actor,
            sessionId: ctx.sessionId ?? null,
            reason: input.reasoning ?? null,
            workspaceId: governanceWorkspaceId,
          });
          if (statusMove.status === "conflict") {
            throw lifecycleConflictError(
              statusMove.expectedFrom,
              statusMove.actual
            );
          }
          if (statusMove.status === "refused") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: statusMove.reason,
            });
          }
          if (statusMove.status === "denied") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: statusMove.reason,
            });
          }
        }
        if (input.properties === undefined) {
          const facetNow = await facetRepo.getById(input.facetId);
          if (statusMove?.status === "proposed") {
            return {
              status: "proposed" as const,
              message: proposedMessageFor(
                statusMove.proposalType,
                "Status change proposed for review"
              ),
              facet: null as Record<string, unknown> | null,
              proposalId: statusMove.proposalId,
              proposalType: statusMove.proposalType,
              reviewUrl: statusMove.reviewUrl,
              statusMove,
            };
          }
          return {
            status: "updated" as const,
            message: "Facet updated",
            facet: facetNow ?? existing,
            ...(statusMove ? { statusMove } : {}),
          };
        }
      }

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
        grantWorkspaceId: existing.workspaceId ?? null,
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
          message: proposedMessageFor(
            perm.proposalType,
            "Facet update proposed for review"
          ),
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
        origin: ctx.origin,
        proposalId: ctx.governanceProposalId,
      });

      return {
        status: "updated" as const,
        message: "Facet updated",
        facet,
        ...(statusMove ? { statusMove } : {}),
      };
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
      await assertRoleWriteGrant(
        "detach",
        existing.entityId,
        existing.workspaceId ?? null
      );

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
        grantWorkspaceId: existing.workspaceId ?? null,
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
          message: proposedMessageFor(
            perm.proposalType,
            "Facet detach proposed for review"
          ),
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
        origin: ctx.origin,
        proposalId: ctx.governanceProposalId,
      });

      return { status: "detached" as const, message: "Facet detached" };
    }),
};
