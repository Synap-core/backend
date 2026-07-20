/**
 * Profiles Router - Profile Management API
 *
 * Event-driven CRUD with 3-phase lifecycle for entity type profiles.
 * Profiles define entity types as configuration, not code.
 */

import { z } from "zod";
import {
  router,
  workspaceProcedure,
  protectedProcedure,
  podProcedure,
  assertPodAdmin,
} from "../trpc.js";
import {
  changedPodWideProfileFields,
  profileOwnershipRequirement,
} from "../utils/profile-pod-wide-fields.js";
import {
  getDb,
  ProfileRepository,
  ProfilePropertyRepository,
  ProfileResolutionService,
  ProfileScope,
  ViewRepository,
  WorkspaceRepository,
  eventRepository,
  workspaces,
  eq,
} from "@synap/database";
import type { RendererRef } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import {
  setProfileRenderer,
  type RendererSlot,
} from "../services/profiles/set-profile-renderer.js";
import { auditLog } from "../utils/audit-log.js";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "profiles-router" });

const ProfileScopeSchema = z.enum(["system", "shared", "workspace", "user"]);

/**
 * Zod schema for RendererRef.
 *
 * Mirrors RendererTarget from @synap-core/renderer-runtime. Discriminated union
 * by `kind`. Used to validate JSONB payloads written into:
 *   - profiles.default_(list|detail)_renderer (system default)
 *   - workspaces.settings.profileRenderers[slug][slot] (workspace overlay)
 *
 * Two paths are encoded by kind:
 *   - config path → 'cell' | 'view'
 *   - file path   → 'iframe-srcdoc' | 'external-app'
 *   - 'url' is a passthrough used by some link-style surfaces
 *
 * Spec: synap-team-docs/content/team/platform/profile-renderer.mdx
 */
const RendererRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cell"),
    cellKey: z.string(),
    props: z.record(z.string(), z.unknown()),
    title: z.string().optional(),
    displayMode: z.string().optional(),
    rendererHint: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("view"),
    viewId: z.string(),
    title: z.string().optional(),
    displayMode: z.string().optional(),
  }),
  z.object({
    kind: z.literal("iframe-srcdoc"),
    appId: z.string(),
    srcdoc: z.string(),
    title: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("external-app"),
    appId: z.string(),
    url: z.string(),
    title: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string(),
    external: z.boolean().optional(),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("view-adapter"),
    adapterKey: z.string(),
    props: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
  }),
]);

/**
 * The ContentKinds a profile assigns a renderer to — the canonical taxonomy
 * that replaced the old list/detail/dashboard "slots".
 *   collection      ← old `list`
 *   entity-detail   ← old `detail`
 *   entity-profile  ← old `dashboard`
 */
const ProfileContentKindSchema = z.enum([
  "entity-detail",
  "entity-profile",
  "collection",
]);
type ProfileContentKind = z.infer<typeof ProfileContentKindSchema>;

const PROFILE_CONTENT_KIND_TO_SLOT: Record<ProfileContentKind, RendererSlot> = {
  collection: "list",
  "entity-detail": "detail",
  "entity-profile": "dashboard",
};

export const profilesRouter = router({
  /**
   * List accessible profiles (system + workspace + user)
   */
  list: podProcedure
    .input(
      z
        .object({
          /** When true, excludes profiles marked hideFromCreate in uiHints (file, capture, anchor, etc.) */
          creatableOnly: z.boolean().optional(),
          /** Narrow an already-oriented read to these profile slugs. */
          profileSlugs: z.array(z.string().min(1).max(100)).optional(),
        })
        .optional()
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);

      // podProcedure tolerates a workspace-less caller (pod-wide / cross-workspace
      // surfaces, onboarding). `?? ""` routes through getAccessibleProfiles'
      // workspace-less branch (SYSTEM + USER profiles) instead of binding null
      // into a uuid column. NOTE: this pod-wide path does NOT yet union the
      // caller's member-workspace / shared profiles (that broader floor is what
      // `listMulti` does) — broadening it is a deliberate follow-up, kept out
      // here so the documented workspace-less contract is unchanged.
      let profiles = await profileRepo.getAccessibleProfiles(
        ctx.userId,
        ctx.workspaceId ?? "",
        input?.profileSlugs ? { slugs: input.profileSlugs } : undefined
      );

      if (input?.creatableOnly) {
        profiles = profiles.filter(
          (p) =>
            !(p.uiHints as Record<string, unknown> | null)?.hideFromCreate &&
            // Kind + Facets: an entity is never created AS a role — roles are
            // attached to an existing entity via attachFacet. Excluding them
            // here covers every creatable-profile consumer in one place.
            p.profileKind !== "role"
        );
      }

      return { profiles };
    }),

  /**
   * Get profile by slug or ID
   */
  get: podProcedure
    .input(
      z.object({
        identifier: z.string(), // slug or ID
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // podProcedure: ctx.workspaceId may be null (pod-wide / onboarding). Both
      // resolveProfile and getEffectiveProperties tolerate a null workspace lens
      // (null → base props, no workspace overlay) — same contract the workspace-
      // less `getEffectiveRenderers` already relies on.
      const profile = await resolutionService.resolveProfile(
        input.identifier,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.identifier}`,
        });
      }

      // Get effective properties through this workspace's lens
      // (base props + this workspace's overlays, no other workspace's overlays)
      const effectiveProperties =
        await resolutionService.getEffectiveProperties(
          profile.id,
          ctx.workspaceId
        );

      return {
        profile,
        effectiveProperties,
      };
    }),

  /**
   * Create a new profile
   */
  create: workspaceProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9-]+$/),
        displayName: z.string().min(1).max(200),
        parentProfileId: z.string().uuid().optional(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        /** Default property values applied to new entities of this type. */
        defaultValues: z.record(z.string(), z.unknown()).optional(),
        scope: ProfileScopeSchema.default("workspace"),
        /**
         * For scope="shared": list of workspace IDs to grant access to immediately.
         * The calling workspace is always included automatically.
         */
        allowedWorkspaceIds: z.array(z.string().uuid()).optional(),
        /** Whether entities of this type are pod-wide or workspace-scoped */
        entityScope: z.enum(["pod", "workspace"]).optional(),
        source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
        /**
         * Kind vs role profile. Omit → 'kind' (a normal entity type). 'role'
         * mints an attachable facet type (Kind + Facets) — requires
         * applicableKinds to declare which base kinds it can attach to.
         */
        profileKind: z.enum(["kind", "role"]).optional(),
        /** For profileKind='role': base-kind slugs this role can attach to. */
        applicableKinds: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();
      const profileId = randomUUID();

      const db = await getDb();
      const profileRepo = new ProfileRepository(db);

      // Check for slug conflict within this workspace context.
      // Returns workspace-owned profile first, then shared/system if accessible.
      const existing = await profileRepo.getBySlug(input.slug, ctx.workspaceId);
      if (existing) {
        logger.info(
          { slug: input.slug, existingId: existing.id },
          "Profile slug exists, returning existing"
        );
        // Grant access if this workspace doesn't already have it
        if (
          existing.scope === ProfileScope.SHARED ||
          input.scope === "shared"
        ) {
          await profileRepo.grantAccess(existing.id, ctx.workspaceId);
        }
        return { profile: existing, existing: true };
      }

      // A role profile (attachable facet type) MUST declare which base kinds it
      // can attach to — otherwise it could never be attached to anything.
      if (
        input.profileKind === "role" &&
        (!input.applicableKinds || input.applicableKinds.length === 0)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A role profile requires a non-empty applicableKinds (the base kinds it can attach to)",
        });
      }

      // Validate parent profile if provided
      if (input.parentProfileId) {
        const parent = await profileRepo.getById(input.parentProfileId);
        if (!parent) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Parent profile not found: ${input.parentProfileId}`,
          });
        }

        // Check for inheritance cycles
        const resolutionService = new ProfileResolutionService(db);
        const hierarchy = await resolutionService.getProfileHierarchy(
          input.parentProfileId
        );
        const cycle = hierarchy.find((p) => p.slug === input.slug);
        if (cycle) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Inheritance cycle detected: ${input.slug} would create a cycle`,
          });
        }
      }

      // 1. Emit .requested event
      const requestedEvent = await auditLog({
        subjectType: "profile",
        action: "create",
        phase: "requested",
        subjectId: profileId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: {
          slug: input.slug,
          displayName: input.displayName,
          parentProfileId: input.parentProfileId,
          scope: input.scope,
        },
      });

      // 2. Permission check (may create proposal)
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: ctx.workspaceId,
        subjectType: "profile",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        data: {
          id: profileId,
          slug: input.slug,
          displayName: input.displayName,
          parentProfileId: input.parentProfileId,
          uiHints: input.uiHints,
          defaultValues: input.defaultValues,
          scope: input.scope,
          entityScope: input.entityScope,
          profileKind: input.profileKind,
          applicableKinds: input.applicableKinds,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          profile: null as Record<string, unknown> | null,
          status: "proposed",
          message: "Profile creation proposed for review",
          proposalId: perm.proposalId,
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      let userId: string | undefined;
      let workspaceId: string | undefined;

      if (input.scope === "system") {
        userId = undefined;
        workspaceId = undefined;
      } else if (input.scope === "shared") {
        // Shared profiles are owned by the creating workspace
        workspaceId = ctx.workspaceId;
      } else if (input.scope === "workspace") {
        workspaceId = ctx.workspaceId;
      } else if (input.scope === "user") {
        userId = ctx.userId;
      }

      const profile = await profileRepo.create({
        id: profileId,
        slug: input.slug,
        displayName: input.displayName,
        parentProfileId: input.parentProfileId,
        uiHints: input.uiHints,
        defaultValues: input.defaultValues,
        scope: input.scope as ProfileScope,
        entityScope: input.entityScope,
        userId,
        workspaceId,
        ...(input.profileKind ? { profileKind: input.profileKind } : {}),
        ...(input.applicableKinds
          ? { applicableKinds: input.applicableKinds }
          : {}),
      });

      // For shared profiles, grant access to the creating workspace + any extra workspaces
      if (input.scope === "shared") {
        await profileRepo.grantAccess(profile.id, ctx.workspaceId);
        for (const wsId of input.allowedWorkspaceIds ?? []) {
          if (wsId !== ctx.workspaceId) {
            await profileRepo.grantAccess(profile.id, wsId);
          }
        }
      }

      // Side effects for workspace-scoped profiles: auto-create bento view + register in settings
      if (input.scope === "workspace") {
        try {
          // Shared singleton — a fresh EventRepository has no registered
          // hooks, so its emitCompleted() append would silently never reach
          // the realtime/materialization/sync hooks.
          const eventRepo = eventRepository;
          const viewRepo = new ViewRepository(db, eventRepo);
          const workspaceRepo = new WorkspaceRepository(db, eventRepo);

          // Build default bento layout for this profile
          const icon = input.uiHints?.icon as string | undefined;
          const color =
            (input.uiHints?.color as string | undefined) ?? "#6366F1";
          const iconPascal = icon
            ? icon
                .split("-")
                .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
                .join("")
            : "Database";
          const slug = input.slug;
          const blocks = [
            {
              id: `${slug}-header`,
              kind: "widget",
              widgetType: "section-header",
              pos: { x: 0, y: 0, w: 12, h: 2 },
              config: {
                title: input.displayName,
                icon: iconPascal,
                profileSlug: slug,
                color,
              },
            },
            {
              id: `${slug}-count`,
              kind: "widget",
              widgetType: "stat-card",
              pos: { x: 0, y: 2, w: 3, h: 3 },
              config: {
                label: `Total ${input.displayName}s`,
                aggregation: "count",
                profileSlug: slug,
                icon: iconPascal,
                color,
              },
            },
            {
              id: `${slug}-table`,
              kind: "widget",
              widgetType: "view-table",
              pos: { x: 0, y: 5, w: 12, h: 9 },
              config: { profileSlug: slug },
            },
          ];

          const bentoView = await viewRepo.create(
            {
              name: input.displayName,
              type: "bento",
              workspaceId: ctx.workspaceId,
              userId: ctx.userId,
              scopeProfileIds: [profile.id],
              config: { layout: "bento", blocks },
              metadata: { isProfileBento: true, profileSlug: slug },
            },
            ctx.userId
          );

          // Store bentoViewId in workspace.settings.profileBentoViewIds (atomic patch)
          await workspaceRepo.mergeSettings(
            ctx.workspaceId,
            { profileBentoViewIds: { [slug]: bentoView.id } },
            ctx.userId
          );

          // Append sidebar item (kind:'profile') — needs a read to check idempotency and append to array
          const workspace = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, ctx.workspaceId),
          });
          if (workspace) {
            const settingsRecord = (workspace.settings ?? {}) as Record<
              string,
              unknown
            >;
            const currentLayout = (settingsRecord.layout ?? {}) as Record<
              string,
              unknown
            >;
            const existingItems = (currentLayout.sidebarItems ?? []) as Array<
              Record<string, unknown>
            >;
            const alreadyPresent = existingItems.some(
              (item) => item.kind === "profile" && item.profileSlug === slug
            );
            if (!alreadyPresent) {
              const newItem = {
                kind: "profile",
                profileSlug: slug,
                label: input.displayName,
                icon,
              };
              await workspaceRepo.mergeSettings(
                ctx.workspaceId,
                {
                  layout: {
                    ...currentLayout,
                    sidebarItems: [...existingItems, newItem],
                  },
                } as Record<string, unknown>,
                ctx.userId
              );
            }
          }

          logger.info(
            { profileId: profile.id, slug, bentoViewId: bentoView.id },
            "Auto-created bento view and sidebar item for profile"
          );
        } catch (sideEffectErr) {
          // Non-fatal — profile was created successfully; log and continue
          logger.warn(
            { err: sideEffectErr, profileId: profile.id },
            "Failed to auto-create bento view or sidebar item (non-fatal)"
          );
        }
      }

      // 4. Emit .completed event + side-effects
      auditLog({
        subjectType: "profile",
        action: "create",
        phase: "completed",
        subjectId: profile.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        correlationId,
        data: {
          slug: profile.slug,
          displayName: profile.displayName,
          scope: input.scope,
        },
      });

      logger.info(
        { profileId: profile.id, slug: profile.slug, userId: ctx.userId },
        "Profile created"
      );

      return { profile };
    }),

  /**
   * Update a profile
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        displayName: z.string().min(1).max(200).optional(),
        parentProfileId: z.string().uuid().optional().nullable(),
        uiHints: z.record(z.string(), z.unknown()).optional(),
        /** Default property values applied to new entities of this type. */
        defaultValues: z.record(z.string(), z.unknown()).optional(),
        /**
         * Change the profile scope. Caller must own the profile (workspaceId matches).
         * Changing to "shared" requires owning workspace context.
         * Changing from "shared" → other automatically revokes all existing grants.
         */
        scope: ProfileScopeSchema.optional(),
        /**
         * When changing scope to "shared": additional workspace IDs to grant access.
         * The owning workspace always keeps access.
         */
        allowedWorkspaceIds: z.array(z.string().uuid()).optional(),
        /** Whether entities of this type are pod-wide or workspace-scoped */
        entityScope: z.enum(["pod", "workspace"]).optional(),
        /**
         * System-default renderer for the LIST slot of this profile.
         * Pass `null` to clear the default (so the resolver returns the
         * hardcoded system fallback). See Profile Renderer North Star.
         */
        defaultListRenderer: RendererRefSchema.nullable().optional(),
        /** System-default renderer for the DETAIL slot. */
        defaultDetailRenderer: RendererRefSchema.nullable().optional(),
        /** System-default renderer for the DASHBOARD slot (per-profile bento). */
        defaultDashboardRenderer: RendererRefSchema.nullable().optional(),
        /**
         * Per-kind AI behavioral posture (base layer). `null` clears back to
         * code defaults. Workspace overlay: workspaces.settings.profileAiPosture.
         */
        aiPosture: z
          .object({
            explainWhy: z.boolean().optional(),
            openAfterCreate: z.boolean().optional(),
            attachOutputs: z.boolean().optional(),
            directives: z.array(z.string()).optional(),
          })
          .nullable()
          .optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile exists and is accessible
      const existing = await resolutionService.resolveProfile(
        input.id,
        ctx.userId,
        ctx.workspaceId
      );

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.id}`,
        });
      }

      // POD-WIDE FIELD GATE. A profile row is shared across the whole pod, so
      // `scope`, `entityScope`, `aiPosture` and the three default renderers
      // change behaviour for EVERY workspace — see profile-pod-wide-fields.ts
      // for exactly which fields are gated, which are not, and why. Previously
      // only `scope` was checked here; the rest were written below with no gate
      // at all, so any member of any workspace that could see a shared/system
      // profile could flip pod-wide entity placement and agent posture.
      const changedPodWide = changedPodWideProfileFields(input, existing);
      if (changedPodWide.length > 0) {
        const fieldList = changedPodWide.join(", ");
        const requirement = profileOwnershipRequirement(existing);
        if (
          requirement.kind === "owning-workspace" &&
          requirement.workspaceId !== ctx.workspaceId
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Only the owning workspace can change a profile's ${fieldList}`,
          });
        }
        if (
          requirement.kind === "owning-user" &&
          requirement.userId !== ctx.userId
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Only the owning user can change a profile's ${fieldList}`,
          });
        }
        if (requirement.kind === "pod-admin") {
          // System/shared profile — owned by the pod itself. Throws FORBIDDEN
          // "Pod admin access required" through the SAME check
          // podAdminProcedure uses.
          await assertPodAdmin(ctx.userId);
        }
      }

      if (input.scope !== undefined && input.scope !== existing.scope) {
        // Downgrading from "shared" → revoke all existing grants
        if (existing.scope === "shared") {
          const grantedWorkspaces = await profileRepo.getGrantedWorkspaces(
            input.id
          );
          for (const wsId of grantedWorkspaces) {
            await profileRepo.revokeAccess(input.id, wsId);
          }
        }
      }

      // Check for inheritance cycles if parent is being changed
      if (input.parentProfileId !== undefined) {
        if (input.parentProfileId) {
          const parent = await profileRepo.getById(input.parentProfileId);
          if (!parent) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Parent profile not found: ${input.parentProfileId}`,
            });
          }

          // Check for cycles
          const hierarchy = await resolutionService.getProfileHierarchy(
            input.parentProfileId
          );
          const cycle = hierarchy.find((p) => p.id === input.id);
          if (cycle) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Inheritance cycle detected`,
            });
          }
        }
      }

      const updated = await profileRepo.update(input.id, {
        displayName: input.displayName,
        parentProfileId: input.parentProfileId ?? undefined,
        uiHints: input.uiHints,
        defaultValues: input.defaultValues,
        scope: input.scope as ProfileScope | undefined,
        entityScope: input.entityScope,
        defaultListRenderer: input.defaultListRenderer,
        defaultDetailRenderer: input.defaultDetailRenderer,
        defaultDashboardRenderer: input.defaultDashboardRenderer,
        aiPosture: input.aiPosture,
      });

      // Invalidate entityScope cache when changed
      if (input.entityScope !== undefined) {
        ProfileResolutionService.invalidateEntityScopeCache(existing.slug);
      }
      if (input.aiPosture !== undefined) {
        ProfileResolutionService.invalidateAiPostureCache(existing.slug);
      }

      // When upgrading to "shared" — grant access to owning workspace + extras
      if (input.scope === "shared") {
        await profileRepo.grantAccess(input.id, ctx.workspaceId);
        for (const wsId of input.allowedWorkspaceIds ?? []) {
          if (wsId !== ctx.workspaceId) {
            await profileRepo.grantAccess(input.id, wsId);
          }
        }
      }

      logger.info(
        { profileId: updated.id, userId: ctx.userId, scope: updated.scope },
        "Profile updated"
      );

      return { profile: updated };
    }),

  /**
   * Delete a profile (soft delete)
   */
  delete: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile exists and is accessible
      const existing = await resolutionService.resolveProfile(
        input.id,
        ctx.userId,
        ctx.workspaceId
      );

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.id}`,
        });
      }

      // Don't allow deleting system profiles
      if (existing.scope === "system") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot delete system profiles",
        });
      }

      await profileRepo.delete(input.id);

      // Invalidate entityScope cache for deleted profile
      ProfileResolutionService.invalidateEntityScopeCache(existing.slug);

      logger.info(
        { profileId: input.id, userId: ctx.userId },
        "Profile deleted"
      );

      return { success: true };
    }),

  /**
   * Get effective properties for a profile (with inheritance)
   */
  getEffectiveProperties: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile is accessible
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }

      const effectiveProperties =
        await resolutionService.getEffectiveProperties(
          input.profileId,
          ctx.workspaceId
        );

      return { properties: effectiveProperties };
    }),

  /**
   * Get profile hierarchy (root → leaf)
   */
  getHierarchy: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Verify profile is accessible
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }

      const hierarchy = await resolutionService.getProfileHierarchy(
        input.profileId
      );

      return { hierarchy };
    }),

  /**
   * Grant a workspace access to a shared profile.
   * Idempotent — safe to call multiple times.
   */
  grantAccess: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        targetWorkspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      // Verify the profile exists and the calling workspace can see it
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }
      if (profile.scope !== "shared") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only shared profiles can have workspace access grants",
        });
      }
      // Only the workspace that owns the profile can grant access to others
      if (profile.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the owning workspace can grant access to a shared profile",
        });
      }

      await profileRepo.grantAccess(input.profileId, input.targetWorkspaceId);

      logger.info(
        {
          profileId: input.profileId,
          targetWorkspaceId: input.targetWorkspaceId,
        },
        "Profile access granted"
      );

      return { success: true };
    }),

  /**
   * List profiles across multiple workspaces.
   *
   * Unlike `list` (single-workspace header), this endpoint accepts an explicit
   * `workspaceIds` array and works without an active workspace header.
   * Always includes system profiles and the caller's user profiles.
   *
   * Security: `workspaceIds` filtered to workspaces the caller is a member of.
   * Omitting returns profiles from ALL user's workspaces.
   */
  listMulti: protectedProcedure
    .input(
      z.object({
        workspaceIds: z.array(z.string().uuid()).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { validateWorkspaceAccess } =
        await import("../utils/workspace-membership.js");

      const validatedIds = await validateWorkspaceAccess(
        ctx.userId,
        input.workspaceIds
      );

      const db = await getDb();
      const profileRepo = new ProfileRepository(db);

      // Union accessible profiles across all validated workspaces
      const seen = new Set<string>();
      const allProfiles = [];

      for (const wsId of validatedIds) {
        const profiles = await profileRepo.getAccessibleProfiles(
          ctx.userId,
          wsId
        );
        for (const p of profiles) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            allProfiles.push(p);
          }
        }
      }

      // If no workspace IDs available, still return system + user profiles
      if (validatedIds.length === 0) {
        const systemProfiles = await profileRepo.getAccessibleProfiles(
          ctx.userId,
          "" // empty string won't match workspace profiles, only system+user
        );
        for (const p of systemProfiles) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            allProfiles.push(p);
          }
        }
      }

      return { profiles: allProfiles };
    }),

  /**
   * Get all profiles sharing a given semantic slug across workspaces.
   *
   * Returns every workspace-scoped (or shared/system) profile tagged with
   * `semanticSlug`, filtered to workspaces the caller is a member of.
   * Use this to power cross-workspace views: "all tasks", "all projects", etc.
   */
  getBySemanticSlug: protectedProcedure
    .input(
      z.object({
        semanticSlug: z.string(),
        workspaceIds: z.array(z.string().uuid()).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { validateWorkspaceAccess } =
        await import("../utils/workspace-membership.js");

      const validatedIds = await validateWorkspaceAccess(
        ctx.userId,
        input.workspaceIds
      );

      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const matchingProfiles = await profileRepo.getBySemanticSlug(
        input.semanticSlug,
        validatedIds.length > 0 ? validatedIds : undefined
      );

      return { profiles: matchingProfiles };
    }),

  /**
   * Revoke a workspace's access to a shared profile.
   */
  revokeAccess: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        targetWorkspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${input.profileId}`,
        });
      }
      if (profile.scope !== "shared") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only shared profiles can have workspace access revoked",
        });
      }
      if (profile.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the owning workspace can revoke access to a shared profile",
        });
      }

      await profileRepo.revokeAccess(input.profileId, input.targetWorkspaceId);

      logger.info(
        {
          profileId: input.profileId,
          targetWorkspaceId: input.targetWorkspaceId,
        },
        "Profile access revoked"
      );

      return { success: true };
    }),

  /**
   * Reorder the properties of a profile by updating their displayOrder.
   * Accepts the full ordered list of property def IDs for the profile.
   */
  reorderProperties: workspaceProcedure
    .input(
      z.object({
        profileId: z.string().uuid(),
        /** Property def IDs in the desired display order */
        orderedPropertyDefIds: z.array(z.string().uuid()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profilePropertyRepo = new ProfilePropertyRepository(db);

      // Verify profile exists and is accessible to this workspace
      const resolutionService = new ProfileResolutionService(db);
      const profile = await resolutionService.resolveProfile(
        input.profileId,
        ctx.userId,
        ctx.workspaceId
      );
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profile not found",
        });
      }

      // Update displayOrder for each property def link
      for (let i = 0; i < input.orderedPropertyDefIds.length; i++) {
        await profilePropertyRepo.link({
          profileId: input.profileId,
          propertyDefId: input.orderedPropertyDefIds[i],
          displayOrder: i,
        });
      }

      logger.info(
        {
          profileId: input.profileId,
          count: input.orderedPropertyDefIds.length,
          userId: ctx.userId,
        },
        "Profile properties reordered"
      );

      return { success: true };
    }),

  /**
   * Get the effective renderer for a profile in this workspace, by slot.
   *
   * Resolves via ProfileResolutionService.getEffectiveRenderer through the
   * chain: workspace overlay → profile system default → hardcoded fallback.
   *
   * Uses `podProcedure` so callers without an active workspace (Eve OS,
   * cross-pod surfaces) can still resolve — they skip the workspace overlay
   * and receive `profile default → fallback`. Studio/CRM pass their workspace
   * header as usual and get the full three-layer resolution.
   *
   * Omit `slot` to receive both slots in one round-trip — typical for
   * `<EntityRenderer>` mounting.
   *
   * Spec: synap-team-docs/content/team/platform/profile-renderer.mdx
   */
  getEffectiveRenderers: podProcedure
    .input(
      z.object({
        profileSlug: z.string(),
        contentKind: ProfileContentKindSchema.optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Accept UUID or human-readable slug — resolve to canonical slug first.
      const resolved = await resolutionService.resolveProfile(
        input.profileSlug,
        ctx.userId,
        ctx.workspaceId
      );
      const profileSlug = resolved?.slug ?? input.profileSlug;

      // Always return the full ContentKind-keyed map; when `contentKind` is
      // given, only that one is resolved (the rest stay null).
      const base: Record<ProfileContentKind, RendererRef | null> = {
        "entity-detail": null,
        "entity-profile": null,
        collection: null,
      };

      if (input.contentKind) {
        const target = await resolutionService.getEffectiveRenderer(
          profileSlug,
          ctx.workspaceId,
          input.contentKind
        );
        return { ...base, [input.contentKind]: target };
      }

      const [entityDetail, entityProfile, collection] = await Promise.all([
        resolutionService.getEffectiveRenderer(
          profileSlug,
          ctx.workspaceId,
          "entity-detail"
        ),
        resolutionService.getEffectiveRenderer(
          profileSlug,
          ctx.workspaceId,
          "entity-profile"
        ),
        resolutionService.getEffectiveRenderer(
          profileSlug,
          ctx.workspaceId,
          "collection"
        ),
      ]);
      return {
        "entity-detail": entityDetail,
        "entity-profile": entityProfile,
        collection,
      };
    }),

  /**
   * Set the per-workspace renderer override for a profile in this workspace.
   *
   * Edits `workspaces.settings.profileRenderers[slug][slot]`. Pass `ref: null`
   * to clear the overlay (so the resolver falls back to the profile default).
   *
   * This is the workspace-level write path. To change the profile's own
   * system default (visible to every workspace using it), use `update` with
   * `defaultListRenderer` / `defaultDetailRenderer`.
   *
   * Governance follows the authenticated actor from context. Trusted operators
   * apply immediately; agent/AI and under-authorized writes become the existing
   * `profile/renderer.set` proposal and materialize through the same service
   * after approval.
   */
  setProfileRendererOverride: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string(),
        contentKind: ProfileContentKindSchema,
        ref: RendererRefSchema.nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const slot = PROFILE_CONTENT_KIND_TO_SLOT[input.contentKind];
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: ctx.agentUserId ?? undefined,
        workspaceId: ctx.workspaceId,
        subjectType: "profile",
        action: "renderer.set",
        source: ctx.source ?? undefined,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        sessionId: ctx.sessionId ?? undefined,
        projectId: ctx.projectId ?? undefined,
        data: {
          profileSlug: input.profileSlug,
          slot,
          scope: "workspace",
          ref: input.ref,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          success: false,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      await setProfileRenderer({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        profileSlug: input.profileSlug,
        slot,
        ref: input.ref,
        scope: "workspace",
      });

      logger.info(
        {
          profileSlug: input.profileSlug,
          contentKind: input.contentKind,
          cleared: input.ref === null,
          workspaceId: ctx.workspaceId,
        },
        "Profile renderer override updated"
      );

      return {
        success: true,
        status: "applied" as const,
        proposalId: null,
      };
    }),

  /**
   * Resolve a profile's dashboard — the ONE canonical READ path.
   *
   * Defaults are GENERATED by the host (never persisted). A backend view is
   * born lazily on the FIRST user edit (see `saveDashboard`), and only then
   * does it win. So this resolve is get-if-exists, NEVER get-or-create:
   *
   *   1. The resolved `entity-profile` renderer, when it's a view ref → return it.
   *   2. A legacy `workspace.settings.profileBentoViewIds[id]` view → adopt +
   *      promote it (one-time migration of pre-existing user layouts).
   *   3. No view exists → return `{ viewId: null, config: null }`. The host
   *      then GENERATES a default via `resolveDefaultBento` and renders it
   *      WITHOUT saving — the empty/generator branch of override→generator→empty.
   *
   * `userAuthored` reflects `metadata.userAuthored` on the resolved view: true
   * once the user has edited it (so the host renders it as the OVERRIDE rather
   * than re-generating). A view adopted from the legacy path is treated as
   * user-authored (it only existed because the user built it).
   */
  resolveDashboard: workspaceProcedure
    .input(z.object({ profileSlug: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      const profile = await resolutionService.resolveProfile(
        input.profileSlug,
        ctx.userId,
        ctx.workspaceId
      );
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile '${input.profileSlug}' not found`,
        });
      }

      const loadView = (viewId: string) =>
        db.query.views.findFirst({ where: (v, { eq }) => eq(v.id, viewId) });

      const promote = async (viewId: string) => {
        const ref = { kind: "view" as const, viewId };
        // `default_renderers['entity-profile']` is the source of truth; also
        // write the deprecated `default_dashboard_renderer` column for
        // back-compat during the ContentKind transition.
        const existingRenderers = (
          profile as {
            defaultRenderers?: Record<string, unknown> | null;
          }
        ).defaultRenderers;
        await profileRepo.update(profile.id, {
          defaultRenderers: {
            ...(existingRenderers ?? {}),
            "entity-profile": ref,
          },
          defaultDashboardRenderer: ref,
        });
      };

      // 1. Canonical: the resolved entity-profile renderer, when it's a view ref.
      const eff = await resolutionService.getEffectiveRenderer(
        input.profileSlug,
        ctx.workspaceId,
        "entity-profile"
      );
      if (eff && (eff as RendererRef).kind === "view") {
        const viewId = (eff as { viewId: string }).viewId;
        const view = await loadView(viewId);
        // A view pinned as the profile's `entity-profile` renderer exists only
        // because the user built it → it's user-authored (mirrors the legacy
        // branch below). The host renders it as the OVERRIDE, not the generator.
        if (view)
          return {
            viewId,
            config: view.config,
            userAuthored: true,
          };
      }

      // 2. Legacy adoption: workspace.settings.profileBentoViewIds[id].
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId),
        columns: { settings: true },
      });
      // The `create` mutation writes this map keyed by SLUG
      // (`{ [slug]: bentoView.id }`), so read by slug first; fall back to the
      // profile id for any older data that may have used the id as the key.
      const legacyMap = (
        ws?.settings as
          { profileBentoViewIds?: Record<string, string> } | null | undefined
      )?.profileBentoViewIds;
      const legacyId = legacyMap?.[profile.slug] ?? legacyMap?.[profile.id];
      if (legacyId) {
        const view = await loadView(legacyId);
        if (view) {
          await promote(legacyId);
          // A legacy view only existed because the user built it → it wins.
          return { viewId: legacyId, config: view.config, userAuthored: true };
        }
      }

      // 3. No persisted view → the host generates the default and renders it
      //    without saving. The view is born lazily on the first `saveDashboard`.
      return { viewId: null, config: null, userAuthored: false };
    }),

  /**
   * Persist a profile dashboard — the ONE canonical WRITE path (fired only by a
   * real user edit). Creates the profile-scoped bento view if it doesn't exist
   * yet (lazy birth), promotes it to the profile's `entity-profile` renderer,
   * and marks `metadata.userAuthored = true` so the resolve above renders it as
   * the OVERRIDE instead of re-generating a default.
   *
   * Scope mirrors the profile: pod-wide profile → workspace_id NULL (shared
   * across all workspaces); workspace profile → this workspace.
   */
  saveDashboard: workspaceProcedure
    .input(
      z.object({
        profileSlug: z.string(),
        config: z.record(z.string(), z.any()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      // Shared singleton — see note above.
      const eventRepo = eventRepository;
      const viewRepo = new ViewRepository(db, eventRepo);
      const profileRepo = new ProfileRepository(db);
      const resolutionService = new ProfileResolutionService(db);

      const profile = await resolutionService.resolveProfile(
        input.profileSlug,
        ctx.userId,
        ctx.workspaceId
      );
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile '${input.profileSlug}' not found`,
        });
      }

      const promote = async (viewId: string) => {
        const ref = { kind: "view" as const, viewId };
        const existingRenderers = (
          profile as { defaultRenderers?: Record<string, unknown> | null }
        ).defaultRenderers;
        await profileRepo.update(profile.id, {
          defaultRenderers: {
            ...(existingRenderers ?? {}),
            "entity-profile": ref,
          },
          defaultDashboardRenderer: ref,
        });
      };

      // Find an existing profile-scoped view via the renderer ref.
      const eff = await resolutionService.getEffectiveRenderer(
        input.profileSlug,
        ctx.workspaceId,
        "entity-profile"
      );
      const existingViewId =
        eff && (eff as RendererRef).kind === "view"
          ? (eff as { viewId: string }).viewId
          : null;
      const existingView = existingViewId
        ? await db.query.views.findFirst({
            where: (v, { eq }) => eq(v.id, existingViewId),
          })
        : null;

      if (existingView) {
        const mergedMetadata = {
          ...((existingView.metadata as Record<string, unknown> | null) ?? {}),
          isProfileBento: true,
          profileSlug: input.profileSlug,
          userAuthored: true,
        };
        // Key the UPDATE on the view's OWN creator id, not ctx.userId. The view
        // may be a shared/pod-scoped profile dashboard (workspaceId NULL) first
        // authored by a different member; ViewRepository.update filters
        // `WHERE id = ? AND userId = ?`, so gating on ctx.userId would match no
        // row and silently drop a co-member's edit. Authorization is already
        // established: this is a workspaceProcedure (caller is a member of
        // ctx.workspaceId) and resolveProfile confirmed the profile is visible
        // in that workspace.
        const updated = await viewRepo.update(
          existingView.id,
          {
            config: input.config as Record<string, unknown>,
            metadata: mergedMetadata,
          },
          existingView.userId
        );
        return { viewId: updated.id, config: updated.config };
      }

      // Lazy birth: create the profile-scoped bento view from the edited config.
      const viewWorkspaceId =
        profile.entityScope === "pod" ? null : ctx.workspaceId;
      const name = profile.displayName ?? input.profileSlug;
      const created = await viewRepo.create(
        {
          name,
          type: "bento",
          workspaceId: viewWorkspaceId,
          userId: ctx.userId,
          scopeProfileIds: [profile.id],
          config: input.config as Record<string, unknown>,
          metadata: {
            isProfileBento: true,
            profileSlug: input.profileSlug,
            userAuthored: true,
          },
        },
        ctx.userId
      );
      await promote(created.id);
      return { viewId: created.id, config: created.config };
    }),
});
