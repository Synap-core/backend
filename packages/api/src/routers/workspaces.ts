/**
 * Workspaces Router - Multi-user workspace management
 *
 * Handles:
 * - Workspace CRUD (synchronous)
 * - Member management (synchronous)
 * - Invitation system
 *
 * Thin(ner) barrel: the workspace-CRUD cluster (create/list/get/update/
 * setPrimarySurface/setIntelligenceService/delete/archive/admin*) stays
 * PHYSICALLY in this file — it owns the client-safe settings projection that
 * `__tripwires__/settings-projection.test.ts` reads straight out of this
 * source file. The membership+invite cluster (`workspaces/invites.ts`), the
 * workspace-definition engine (`workspaces/definition-engine.ts` —
 * createFromDefinition/reconcileFromDefinition/applyDefinition/
 * resetEntities), and the MCP-server config cluster
 * (`workspaces/mcp-servers.ts`) were extracted verbatim during
 * router-decomposition Wave 6 — no logic changed. `workspacesRouter` below
 * is assembled by explicit property reference, in the ORIGINAL key order, so
 * the generated `workspaces:` type in api-types stays byte-identical.
 */

import { z } from "zod";
import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import {
  db,
  eq,
  and,
  desc,
  inArray,
  workspaces,
  workspaceMembers,
  podMembers,
  intelligenceServices,
  getDb,
  eventRepository,
  ProfileResolutionService,
  WorkspaceRepository,
  WorkspaceMemberRepository,
  drizzleSql,
  projectWorkspaceSettings,
} from "@synap/database";
import { cpCatalogCache } from "@synap/database/schema";
import { resolveWorkspaceTemplate } from "../services/capabilities/resolve-workspace-template.js";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { materializePodAdminsIntoWorkspace } from "../utils/workspace-role.js";
import { findUnsafeAutoApproveEntries } from "@synap/governance-policy";
import { auditLog } from "../utils/audit-log.js";
import { assertPackageTierAccess } from "../utils/tier-check.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { storage } from "@synap/storage";
import { workspaceRuntimePrimarySurfaceSchema } from "../schemas/workspace-primary-surface.js";
import { logger, isPodReadableWorkspace } from "./workspaces/helpers.js";
import { inviteProcedures } from "./workspaces/invites.js";
import { definitionEngineProcedures } from "./workspaces/definition-engine.js";
import { mcpServersProcedures } from "./workspaces/mcp-servers.js";

export { isPodReadableWorkspace } from "./workspaces/helpers.js";

const coreProcedures = {
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        description: z.string().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { randomUUID } = await import("crypto");
      const workspaceId = randomUUID();

      // 1. Permission check (no workspaceId yet → auto-granted for personal)
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        subjectType: "workspaces",
        action: "create",
        data: {
          id: workspaceId,
          name: input.name,
          description: input.description,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Workspace creation requires approval.",
        };
      }

      // 2. Tier check for package-based workspaces
      const packageSlug = input.settings?.packageSlug as string | undefined;
      if (packageSlug) {
        await assertPackageTierAccess(ctx.userId, packageSlug);
      }

      // 3. Direct DB operation
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      const created = await workspaceRepo.create(
        {
          id: workspaceId,
          name: input.name,
          ownerId: ctx.userId,
          settings: input.settings || {},
        },
        ctx.userId
      );

      // 2b. Auto-add creator as owner member
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);
      await memberRepo.add(
        {
          workspaceId,
          userId: ctx.userId,
          role: "owner",
        },
        ctx.userId
      );

      // 2c. Materialize pod owner/admins so they can administer this workspace's
      // shared entities inline. GATED to pod_visible/pod_joinable ONLY — a
      // private workspace is skipped (materializing there would widen its
      // reads). Best-effort: on failure the 0217 backfill / next trigger
      // reconciles, and the creator's owner row (above) already stands.
      if (isPodReadableWorkspace(input.settings)) {
        try {
          await materializePodAdminsIntoWorkspace(workspaceId);
        } catch (err) {
          logger.warn(
            { err, workspaceId },
            "Failed to materialize pod admins into new pod-visible workspace (non-fatal)"
          );
        }
      }

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "create",
        phase: "completed",
        subjectId: workspaceId,
        userId: ctx.userId,
        data: {
          id: workspaceId,
          name: input.name,
          description: input.description,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "create",
        subjectId: workspaceId,
        userId: ctx.userId,
      });

      // 5. Enqueue workspace-init for default whiteboard/views/commands
      try {
        const boss = getBoss();
        const templateName = input.settings?.templateName as string | undefined;
        const packageSlug = input.settings?.packageSlug as string | undefined;
        await boss.send("workspace-init", {
          workspaceId,
          userId: ctx.userId,
          templateName,
          packageSlug,
        });
      } catch (err) {
        console.warn(
          "[workspaces.create] Failed to enqueue workspace-init (non-fatal):",
          err
        );
      }

      return {
        status: "created" as const,
        workspaceId: created.id,
        message: "Workspace created successfully.",
      };
    }),

  /**
   * List user's workspaces
   *
   * Filters out soft-archived workspaces by default. Pass `includeArchived: true`
   * to surface them (e.g. for the pod admin "archived" tab).
   */
  list: protectedProcedure
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
          /** When provided, only return workspaces whose settings.appId matches. */
          appId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const memberships = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.userId, ctx.userId),
        with: {
          workspace: true,
        },
      });

      const includeArchived = input?.includeArchived === true;
      const appIdFilter = input?.appId;
      type WorkspaceListItem = NonNullable<
        (typeof memberships)[number]["workspace"]
      > & {
        role?: string;
        joinedAt?: Date;
        accessKind?: "member" | "pod_visible";
      };
      const byId = new Map<string, WorkspaceListItem>();

      for (const m of memberships) {
        const workspace = m.workspace;
        if (!workspace) continue;
        if (!includeArchived && workspace.archivedAt != null) continue;
        if (appIdFilter) {
          const s = (workspace.settings ?? {}) as Record<string, unknown>;
          if (s.appId !== appIdFilter) continue;
        }
        byId.set(workspace.id, {
          // `with: { workspace: true }` hydrates EVERY column — project the
          // settings blob down to the client-safe allowlist before it ships.
          ...projectWorkspaceSettings(workspace),
          role: m.role,
          joinedAt: m.joinedAt,
          accessKind: "member",
        });
      }

      const podReadable = await db.query.workspaces.findMany({
        where: drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`,
      });

      for (const workspace of podReadable) {
        if (byId.has(workspace.id)) continue;
        if (!includeArchived && workspace.archivedAt != null) continue;
        if (appIdFilter) {
          const s = (workspace.settings ?? {}) as Record<string, unknown>;
          if (s.appId !== appIdFilter) continue;
        }
        byId.set(workspace.id, {
          // Pod-visible path: the caller is a NON-MEMBER. This query has no
          // `columns:` filter, so without the projection a stranger got the
          // whole settings blob (credentials included) plus role "viewer".
          ...projectWorkspaceSettings(workspace),
          role: "viewer",
          joinedAt: undefined,
          accessKind: "pod_visible",
        });
      }

      return Array.from(byId.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    }),

  /**
   * Whether the caller is a pod member — a single `pod_members` existence
   * lookup for `ctx.userId`.
   *
   * This is the CANONICAL pod-membership signal and the durable replacement for
   * the pod-admin-membership PROXY the CRM Operations nav derived from
   * `workspaces.list` (a pod member holds a member row on the `pod-admin` system
   * workspace). Exposed as a dedicated boolean procedure rather than folded into
   * `workspaces.list`: that endpoint returns a bare array consumed as an array by
   * ~30 call sites, so it cannot carry a top-level sibling boolean without
   * breaking all of them. Read-only, fail-closed (false when no row).
   */
  isPodMember: protectedProcedure.query(async ({ ctx }) => {
    const row = await db.query.podMembers.findFirst({
      where: eq(podMembers.userId, ctx.userId),
      columns: { id: true },
    });
    return !!row;
  }),

  /**
   * Get workspace details
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.id),
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      // Check user has access
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.id),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      const podReadable = isPodReadableWorkspace(workspace.settings);

      if (!membership && !podReadable) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      if (workspace.archivedAt != null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This workspace has been archived.",
        });
      }

      if (!membership && podReadable) {
        return {
          ...projectWorkspaceSettings(workspace),
          role: "viewer",
          accessKind: "pod_visible",
        };
      }
      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      // Ensure default workspace setup (for existing workspaces created before these features)
      // These are one-time operations per workspace.
      // Default views are NOT auto-created — the frontend renders views ephemerally.
      //
      // The default WHITEBOARD is NOT auto-created here anymore. There is exactly
      // ONE canonical whiteboard per pod, resolved lazily via the single door
      // `views.resolveScopedSurface` ({ type: 'whiteboard' }, no scope) on first
      // open. Per-workspace auto-created boards produced a graveyard of empty
      // `isMain` boards the canonical door never reached.
      // Universal operational defaults — the report automation, default commands
      // and relation defs — come from the first-party `base` template through the
      // ONE reconcile door. The automation step is VERSION-AWARE (a content-hash
      // over base's flow): a prompt change to base overwrites the stale row on the
      // next read, which self-heals the seed-version freeze the old hardcoded
      // seeder suffered (a workspace only reconciled when someone opened Settings).
      // Legacy `ensure*` seeders are the fallback ONLY if `base` is somehow
      // unresolvable (should not happen with the bundled 0.10.0 template).
      const { reconcileWorkspaceFromDefinition } =
        await import("@synap/database");
      const { resolveWorkspaceTemplate } =
        await import("../services/capabilities/resolve-workspace-template.js");
      const baseTemplate = await resolveWorkspaceTemplate("base");
      if (baseTemplate) {
        try {
          // Pass ONLY base's operational carriers — never its workspace-shell
          // fields. base declares `workspaceVisibility: "pod_visible"` (+ name
          // "Base"), and the door's settings step OVERWRITES visibility/subtype
          // unconditionally — so handing it base's full definition would flip
          // every reconciled workspace pod-visible and clobber a domain
          // workspace's template stamp. base is an operational OVERLAY (its
          // profiles/views/home are empty by design), so only the automation +
          // commands + relation defs may cross into an existing workspace. No
          // packageSlug/packageVersion either: base is not the workspace's
          // template identity.
          const baseDef = baseTemplate.workspaceDefinition;
          const baseReport = await reconcileWorkspaceFromDefinition({
            workspaceId: input.id,
            userId: ctx.userId,
            definition: {
              flowAutomations: baseDef.flowAutomations ?? [],
              commands: baseDef.commands ?? [],
              relationDefs: baseDef.relationDefs ?? [],
            } as unknown as Parameters<
              typeof reconcileWorkspaceFromDefinition
            >[0]["definition"],
          });
          console.log(
            `[workspaces.get] base reconcile:`,
            "automations",
            baseReport.automations,
            "commands",
            baseReport.commands,
            "relationDefs",
            baseReport.relationDefs
          );
        } catch (err) {
          console.error(`[workspaces.get] base reconcile failed:`, err);
        }
      } else {
        // Fallback: `base` unresolvable — seed commands + relation defs via the
        // legacy hardcoded utilities. The report automation is NOT seeded here:
        // its only source is base.yaml (reconciled above), so if `base` is
        // unresolvable the automation simply waits for the next `get` once the
        // template resolves. There is no hardcoded report flow to fall back to
        // anymore — that duplicate copy was retired (base.yaml is the SSOT).
        const { ensureDefaultCommands, ensureDefaultRelationDefs } =
          await import("@synap/database");
        await ensureDefaultCommands(input.id, ctx.userId);
        await ensureDefaultRelationDefs(input.id, ctx.userId);
        console.warn(
          `[workspaces.get] base template unresolved — used legacy seeders (commands + relation defs only)`
        );
      }

      // Return workspace. The pod-canonical whiteboard is resolved lazily on
      // first open (views.resolveScopedSurface), not eagerly stamped here.
      return {
        ...projectWorkspaceSettings(workspace),
        role: membership.role,
        accessKind: "member",
      };
    }),

  /**
   * Update workspace
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 0. Reject an autoApproveFor grant that could silently auto-approve a
      // destructive action (delete/archive/purge). The decideAgentPolicy()
      // hard floor is the read-side backstop; this keeps the persisted
      // settings.aiGovernance.autoApproveFor itself honest.
      const autoApproveFor = (
        input.settings?.aiGovernance as Record<string, unknown> | undefined
      )?.autoApproveFor;
      if (Array.isArray(autoApproveFor)) {
        if (!autoApproveFor.every((entry) => typeof entry === "string")) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "settings.aiGovernance.autoApproveFor must be a string[]",
          });
        }
        const unsafe = findUnsafeAutoApproveEntries(autoApproveFor as string[]);
        if (unsafe.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "settings.aiGovernance.autoApproveFor may not auto-approve " +
              "destructive actions (delete/archive/purge). Rejected entries: " +
              unsafe.join(", "),
          });
        }
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.id,
        subjectType: "workspaces",
        action: "update",
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          settings: input.settings
            ? projectWorkspaceSettings({ settings: input.settings }).settings
            : undefined,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Workspace update requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      // CONTRACT PHASE (Governance Convergence): never persist the
      // `settings.aiGovernance.autoApproveFor` JSONB sub-key. Strip it from what
      // we store while preserving every OTHER aiGovernance dial (governanceMode,
      // proposalApprovalPolicy, navigationPermissions, …) and every other
      // setting. The auto-approve grant lives ONLY in `governance_rules`, which
      // is written through its own doors (the Governance › Rules editor /
      // `governanceRules.create`, agent provisioning, the agent-users PATCH) —
      // NEVER through this workspace-settings path.
      let settingsToPersist = input.settings;
      const aiGovIn = input.settings?.aiGovernance;
      if (settingsToPersist && aiGovIn && typeof aiGovIn === "object") {
        const aiGov = { ...(aiGovIn as Record<string, unknown>) };
        delete aiGov.autoApproveFor;
        settingsToPersist = { ...settingsToPersist, aiGovernance: aiGov };
      }

      await workspaceRepo.update(
        input.id,
        {
          name: input.name || undefined,
          settings: settingsToPersist || undefined,
        },
        ctx.userId
      );

      // Workspace overlay of per-kind AI posture changed → drop cached merges
      if (input.settings && "profileAiPosture" in input.settings) {
        ProfileResolutionService.invalidateAiPostureCache();
      }

      // NOTE: there is deliberately NO `syncAutoApproveRules` mirror here. Post
      // W1.1 the JSONB `autoApproveFor` is display-only and is stripped above,
      // and no legitimate caller sends an auto-approve grant through
      // `workspaces.update` settings — the workspace rules are owned by the
      // Governance › Rules editor (`governanceRules.create`) and agent
      // provisioning. A REPLACE-semantics mirror here re-asserted whatever the
      // UI round-tripped from the frozen JSONB, silently clobbering rules
      // edited since via the rules door. `autoApproveFor` in the incoming
      // settings is validated (rung 0 above) then ignored.

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          settings: input.settings
            ? projectWorkspaceSettings({ settings: input.settings }).settings
            : undefined,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
      });

      return {
        status: "updated" as const,
        message: "Workspace updated successfully.",
      };
    }),

  /**
   * Change only what opens first for a workspace.
   *
   * This deliberately avoids the generic settings replacement door: the
   * settings returned to clients omit server-only keys and cannot safely be
   * written back as a whole object.
   */
  setPrimarySurface: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        primarySurface: workspaceRuntimePrimarySurfaceSchema.nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspace",
        action: "update",
        data: {
          id: input.workspaceId,
          operation: "set_primary_surface",
          primarySurface: input.primarySurface,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Workspace start change requires approval.",
        };
      }

      const dbConn = await getDb();
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
      await workspaceRepo.setPrimarySurface(
        input.workspaceId,
        input.primarySurface,
        ctx.userId
      );

      auditLog({
        subjectType: "workspaces",
        action: "update",
        phase: "completed",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          id: input.workspaceId,
          operation: "set_primary_surface",
          primarySurface: input.primarySurface,
        },
      });
      emitSideEffects({
        subjectType: "workspace",
        action: "update",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "updated" as const,
        message: "Workspace start updated.",
      };
    }),

  /**
   * Set intelligence service for workspace (owner/admin only)
   */
  setIntelligenceService: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        serviceId: z.string().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied",
        });
      }

      if (membership.role !== "owner" && membership.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only workspace owner or admin can change intelligence service",
        });
      }

      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      if (input.serviceId && input.serviceId !== "default") {
        const service = await db.query.intelligenceServices.findFirst({
          where: and(
            eq(intelligenceServices.serviceId, input.serviceId),
            eq(intelligenceServices.status, "active")
          ),
        });
        if (!service) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Intelligence service not found or not active",
          });
        }
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaces",
        action: "update",
        data: { id: input.workspaceId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Intelligence service update requires approval.",
        };
      }

      // 2. Atomic settings patch — no read needed
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.mergeSettings(
        input.workspaceId,
        { intelligenceServiceId: input.serviceId ?? undefined },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "update",
        phase: "completed",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          id: input.workspaceId,
          intelligenceServiceId: input.serviceId,
        },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "update",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "updated" as const,
        message: "Intelligence service updated successfully.",
      };
    }),

  /**
   * Delete workspace
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.id,
        subjectType: "workspaces",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Workspace deletion requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.delete(input.id, ctx.userId);

      // 3. Audit log
      auditLog({
        subjectType: "workspaces",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "workspace",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.id,
      });

      return {
        status: "deleted" as const,
        message: "Workspace deleted successfully.",
      };
    }),

  /**
   * Soft-archive a workspace.
   *
   * Sets `workspaces.archived_at = now()`. The row stays in the DB and is
   * filtered out of `list` queries unless `includeArchived: true` is passed.
   * Restore by calling `archive` again with `restore: true`.
   *
   * Authorization: pod admin OR the workspace owner. (Workspace admins do
   * NOT qualify — owners-only matches the pod-admin destructive-action gate.)
   */
  archive: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        restore: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
      });
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      // System workspaces (pod-admin, etc.) must never be archived.
      const settingsRecord = (workspace.settings ?? {}) as Record<
        string,
        unknown
      >;
      if (settingsRecord.systemSlug) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "System workspaces cannot be archived.",
        });
      }

      // Authorization: workspace owner OR pod admin.
      const isOwner = workspace.ownerId === ctx.userId;
      let isPodAdmin = false;
      if (!isOwner) {
        const podAdminWs = await db.query.workspaces.findFirst({
          where: eq(workspaces.systemSlug, "pod-admin"),
          columns: { id: true },
        });
        if (podAdminWs) {
          const membership = await db.query.workspaceMembers.findFirst({
            where: and(
              eq(workspaceMembers.workspaceId, podAdminWs.id),
              eq(workspaceMembers.userId, ctx.userId),
              inArray(workspaceMembers.role, ["admin", "owner"])
            ),
          });
          isPodAdmin = !!membership;
        }
      }
      if (!isOwner && !isPodAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only the workspace owner or a pod admin can archive a workspace.",
        });
      }

      const archivedAt = input.restore ? null : new Date();
      const [updated] = await db
        .update(workspaces)
        .set({ archivedAt, updatedAt: new Date() })
        .where(eq(workspaces.id, input.workspaceId))
        .returning();

      auditLog({
        subjectType: "workspaces",
        action: input.restore ? "unarchive" : "archive",
        phase: "completed",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          id: input.workspaceId,
          archivedAt: archivedAt?.toISOString() ?? null,
        },
      });

      return updated;
    }),

  /**
   * Admin: get any workspace by ID (pod-admin only, no membership required)
   */
  adminGet: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.id),
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const memberCount = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, input.id));

      return {
        // podAdminProcedure: settings intentionally NOT projected through
        // Client-safe settings allowlist — a pod admin already has direct DB access,
        // so projecting buys no confidentiality and would hide config from the
        // admin UI. The projection guards the USER-facing doors (list/get).
        ...workspace,
        memberCount: memberCount[0]?.count ?? 0,
        // Admins have no role in the workspace (they're managing it externally)
        role: "admin" as const,
      };
    }),

  /**
   * Admin: list ALL workspaces on the pod (pod-admin only)
   */
  adminListAll: podAdminProcedure.query(async () => {
    const allWorkspaces = await db.query.workspaces.findMany({
      orderBy: [desc(workspaces.createdAt)],
    });

    const counts = await db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        count: drizzleSql<number>`count(*)::int`,
      })
      .from(workspaceMembers)
      .groupBy(workspaceMembers.workspaceId);

    const countMap = new Map(counts.map((c) => [c.workspaceId, c.count]));

    // podAdminProcedure: settings intentionally NOT projected — see adminGet.
    return allWorkspaces.map((ws) => ({
      ...ws,
      memberCount: countMap.get(ws.id) ?? 0,
    }));
  }),

  /**
   * Admin: force-delete any workspace (pod-admin only)
   *
   * Blocked for system workspaces (systemSlug set in settings).
   * Requires the caller to pass the workspace name for confirmation
   * (verified server-side to prevent accidental bulk deletions).
   */
  adminDelete: podAdminProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        confirmName: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
        columns: { id: true, name: true, settings: true },
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const settings = (workspace.settings ?? {}) as Record<string, unknown>;
      if (settings.systemSlug) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "System workspaces cannot be deleted from the admin panel.",
        });
      }

      if (workspace.name !== input.confirmName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace name does not match. Deletion cancelled.",
        });
      }

      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      // Purge workspace-scoped content (entities/relations/proposals/documents)
      // BEFORE deleting the workspace row — those tables have no FK to
      // workspaces, so cascade alone would orphan them. Pod-wide rows
      // (workspaceId IS NULL) are intentionally left untouched.
      const purged = await workspaceRepo.purgeWorkspaceData(input.workspaceId);

      await workspaceRepo.delete(input.workspaceId, ctx.userId);

      // Post-commit cleanup of out-of-DB state (best-effort; never block delete).
      let blobsDeleted = 0;
      for (const key of purged.storageKeys) {
        try {
          await storage.delete(key);
          blobsDeleted++;
        } catch (err) {
          logger.warn(
            { err, key },
            "Workspace purge: MinIO blob delete failed"
          );
        }
      }
      // De-index removed entities + documents from Typesense.
      for (const id of purged.entityIds) {
        void emitSideEffects({
          subjectType: "entity",
          action: "delete",
          subjectId: id,
          userId: ctx.userId,
          workspaceId: input.workspaceId,
        });
      }
      for (const id of purged.documentIds) {
        void emitSideEffects({
          subjectType: "document",
          action: "delete",
          subjectId: id,
          userId: ctx.userId,
          workspaceId: input.workspaceId,
        });
      }

      auditLog({
        subjectType: "workspaces",
        action: "admin_delete",
        phase: "completed",
        subjectId: input.workspaceId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          id: input.workspaceId,
          name: workspace.name,
          adminForced: true,
          purged: {
            entities: purged.entityIds.length,
            documents: purged.documentIds.length,
            relations: purged.relationsDeleted,
            proposals: purged.proposalsDeleted,
            blobs: blobsDeleted,
          },
        },
      });

      logger.warn(
        {
          workspaceId: input.workspaceId,
          deletedBy: ctx.userId,
          purged: {
            entities: purged.entityIds.length,
            documents: purged.documentIds.length,
            relations: purged.relationsDeleted,
            proposals: purged.proposalsDeleted,
            blobs: blobsDeleted,
          },
        },
        "Admin force-deleted workspace + purged scoped content"
      );

      return {
        status: "deleted" as const,
        message: "Workspace deleted.",
        purged: {
          entities: purged.entityIds.length,
          documents: purged.documentIds.length,
          relations: purged.relationsDeleted,
          proposals: purged.proposalsDeleted,
          blobs: blobsDeleted,
        },
      };
    }),
};

export const workspacesRouter = router({
  create: coreProcedures.create,
  list: coreProcedures.list,
  isPodMember: coreProcedures.isPodMember,
  get: coreProcedures.get,
  update: coreProcedures.update,
  setPrimarySurface: coreProcedures.setPrimarySurface,
  setIntelligenceService: coreProcedures.setIntelligenceService,
  delete: coreProcedures.delete,
  archive: coreProcedures.archive,
  adminGet: coreProcedures.adminGet,
  adminListAll: coreProcedures.adminListAll,
  adminDelete: coreProcedures.adminDelete,
  addMember: inviteProcedures.addMember,
  listMembers: inviteProcedures.listMembers,
  removeMember: inviteProcedures.removeMember,
  backfillTeamPersonBridge: inviteProcedures.backfillTeamPersonBridge,
  updateMemberRole: inviteProcedures.updateMemberRole,
  createInvite: inviteProcedures.createInvite,
  listMyInvites: inviteProcedures.listMyInvites,
  listInvites: inviteProcedures.listInvites,
  acceptInvite: inviteProcedures.acceptInvite,
  revokeInvite: inviteProcedures.revokeInvite,
  listPodMembers: inviteProcedures.listPodMembers,
  listAllInvites: inviteProcedures.listAllInvites,
  removeFromPod: inviteProcedures.removeFromPod,
  createFromDefinition: definitionEngineProcedures.createFromDefinition,
  reconcileFromDefinition: definitionEngineProcedures.reconcileFromDefinition,
  seedPlugin: inviteProcedures.seedPlugin,
  previewInvite: inviteProcedures.previewInvite,
  acceptInviteViaCp: inviteProcedures.acceptInviteViaCp,
  rejectInviteViaCp: inviteProcedures.rejectInviteViaCp,
  rejectInvite: inviteProcedures.rejectInvite,
  getMcpServers: mcpServersProcedures.getMcpServers,
  updateMcpServers: mcpServersProcedures.updateMcpServers,
  applyDefinition: definitionEngineProcedures.applyDefinition,
  resetEntities: definitionEngineProcedures.resetEntities,
});

/**
 * Workspace CATALOG router — browse + slug-install the ONE marketplace catalog
 * of WORKSPACE templates, for pod-connected SDK / embedded apps that hold a
 * catalog slug rather than a hand-built definition.
 *
 * Kept a SEPARATE router (merged into the `workspaces` namespace in `root.ts`)
 * purely so `installFromCatalog` can delegate to `workspacesRouter`'s own
 * `createFromDefinition` via `createCaller` — a reference to `workspacesRouter`
 * from INSIDE its own initializer would make TypeScript infer the whole router
 * as `any`. Splitting the caller-side procedure into this after-defined router
 * breaks that self-reference cycle while keeping the install on the ONE shared
 * create engine (no forked provisioning path).
 */
export const workspaceCatalogRouter = router({
  /**
   * Browse the pod's installable WORKSPACE templates — read from the pod-local
   * `cp_catalog_cache` (kind='template'), the SAME stale-while-revalidate store
   * `resolveWorkspaceTemplate` resolves an install from (synced every ~10 min by
   * the `cp-catalog-sync` job) — NOT a second catalog store. Metadata only: the
   * CP list route omits the (large) definition body by design, so the full body
   * is resolved cache-first at install time by `installFromCatalog`.
   */
  listInstallableTemplates: protectedProcedure
    .input(
      z
        .object({
          /** Case-insensitive substring match over slug / name / description. */
          query: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const rows = await db
        .select({
          slug: cpCatalogCache.slug,
          name: cpCatalogCache.name,
          description: cpCatalogCache.description,
          version: cpCatalogCache.version,
          tier: cpCatalogCache.tier,
          vendor: cpCatalogCache.vendor,
          tags: cpCatalogCache.tags,
        })
        .from(cpCatalogCache)
        .where(eq(cpCatalogCache.kind, "template"))
        .orderBy(desc(cpCatalogCache.syncedAt));

      const q = input?.query?.trim().toLowerCase();
      const filtered = q
        ? rows.filter(
            (r) =>
              r.slug.toLowerCase().includes(q) ||
              r.name.toLowerCase().includes(q) ||
              (r.description ?? "").toLowerCase().includes(q)
          )
        : rows;

      return {
        templates: input?.limit ? filtered.slice(0, input.limit) : filtered,
      };
    }),

  /**
   * Install a WORKSPACE template BY SLUG — the slug-based counterpart to
   * `createFromDefinition` for callers (the SDK / an embedded app) that hold a
   * catalog slug, not a hand-built definition. Resolves the FRESHEST definition
   * cache-first via `resolveWorkspaceTemplate` (the SAME resolver the Hub adopt /
   * approve paths use), then installs through the EXISTING shared engine by
   * delegating to `createFromDefinition` — no forked provisioning path, same
   * tier-gating, idempotency, post-workspace (capabilities/playbooks) layers and
   * governance semantics as the in-app door.
   */
  installFromCatalog: protectedProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        /** Install ONTO an existing workspace instead of creating a new one. */
        workspaceId: z.string().uuid().optional(),
        /** Stable idempotency key, forwarded verbatim to the shared engine. */
        proposalId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const resolved = await resolveWorkspaceTemplate(input.slug);
      if (!resolved) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Unknown workspace template: ${input.slug}`,
        });
      }
      // Delegate to the ONE shared create engine — never a second provisioning
      // path. `createFromDefinition` re-runs the protected middleware + tier gate
      // against this same ctx, so an SDK caller gets identical governance.
      const caller = workspacesRouter.createCaller(ctx);
      return caller.createFromDefinition({
        definition: resolved.packageDefinition as unknown as Parameters<
          typeof caller.createFromDefinition
        >[0]["definition"],
        packageSlug: input.slug,
        packageVersion: resolved.version,
        workspaceId: input.workspaceId,
        proposalId: input.proposalId,
      });
    }),
});
