/**
 * Workspaces Router - Multi-user workspace management
 *
 * Handles:
 * - Workspace CRUD (synchronous)
 * - Member management (synchronous)
 * - Invitation system
 */

import { z } from "zod";
import {
  router,
  protectedProcedure,
  publicProcedure,
  podAdminProcedure,
} from "../trpc.js";
import {
  db,
  eq,
  and,
  desc,
  inArray,
  or,
  gt,
  workspaces,
  workspaceMembers,
  podMembers,
  invites,
  intelligenceServices,
  entities,
  getDb,
  eventRepository,
  ProfileResolutionService,
  WorkspaceRepository,
  WorkspaceMemberRepository,
  EntityBodyService,
  EntityRepository,
  RelationRepository,
  RelationDefRepository,
  drizzleSql,
  users,
  createWorkspaceFromDefinition,
  reconcileWorkspaceFromDefinition,
  ensureTeamPersonForMember,
  detachTeamMemberFacet,
  backfillTeamPersonBridge as runBackfillTeamPersonBridge,
  type WorkspaceDefinitionInput,
  type ReconcileReport,
} from "@synap/database";
import { verifyCpJwt } from "../utils/jwks-client.js";
import type {
  WorkspaceSettings,
  McpServerConfig,
} from "@synap/database/schema";
import { cpCatalogCache } from "@synap/database/schema";
import { resolveWorkspaceTemplate } from "../services/capabilities/resolve-workspace-template.js";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
// import { WorkspaceMemberEvents } from "../lib/event-helpers.js"; // unused — reserved for future member event hooks
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { inheritRelationWorkspaceId } from "../lib/relation-workspace-inherit.js";
import { findUnsafeAutoApproveEntries } from "@synap/governance-policy";
import { auditLog } from "../utils/audit-log.js";
import { assertPackageTierAccess } from "../utils/tier-check.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { storage } from "@synap/storage";
import { kratosAdmin } from "@synap/auth";
import { config, createLogger } from "@synap-core/core";
import {
  ensureAgentThread,
  ensureWorkspaceGroupChannel,
  ensureProactiveFeedChannel,
  getAgentIdBySlug,
} from "../utils/personal-channel.js";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import {
  withWorkspaceProposalIdLock,
  reconcileWorkspaceIfStale,
} from "../services/workspace-creation-service.js";
import { resolveWorkspaceExtends } from "../services/workspace-composition.js";
import type { ResolvedPackageDependency } from "../services/package-dependency-resolver.js";
import {
  materializeWorkspaceCore,
  type MaterializeCoreResult,
  ComposeBaseUnavailableError,
  DependencyResolutionError,
  ComposeBaseNotFoundError,
} from "../services/workspace-materialization-service.js";
// Loop materialization (playbooks + automation triggers) flows through the ONE
// shared loop applier — the same one the standalone POST /loops/apply door uses.
import {
  applyPackagePostWorkspace,
  type PackagePostWorkspaceBody,
} from "../services/package-apply-post-workspace.js";
import type { LoopDefinition, LoopPlaybookDef } from "@synap/playbooks";
import { workspacePrimarySurfaceSchema } from "../schemas/workspace-primary-surface.js";

const logger = createLogger({ module: "workspaces" });

/**
 * The `definition` fields the post-workspace body-builder reads. A structural
 * slice of `createFromDefinition`'s zod input — the two disagreed silently
 * before: `definition.automations` here is the LOOP-style
 * `{trigger, action:{playbookSlug}}` shape (materialized as a loop TRIGGER),
 * NOT the graph-flow `PackagePostWorkspaceBody['automations']`
 * (`{triggerType, flowDefinition}`). The compose-overlay caller used to
 * `input.definition as unknown as PackagePostWorkspaceBody`, which fed loop-style
 * automations into the graph-automation applier step → every one threw
 * (undefined `triggerType`) and was silently swallowed. Building the body HERE,
 * the same way the normal-create branch does, is the one door both use.
 */
interface CreateDefinitionPostWorkspaceSlice {
  playbooks?: Array<{
    name: string;
    goalTemplate?: string;
    description?: string;
    params?: unknown;
    executor?: LoopPlaybookDef["executor"];
    expectedOutputs?: unknown;
    subjectProfile?: LoopPlaybookDef["subjectProfile"];
    /** Scheduled cadence (e.g. a radar's weekly scan) — forwarded to the loop applier. */
    schedule?: LoopPlaybookDef["schedule"];
    /**
     * Authored either as bare NAMES (the Hub door's form, what templates write)
     * or as `{kind, ref}` objects. Only the object form carries a resolvable id
     * for the loop applier — see the narrowing in the body builder.
     */
    grants?: Array<string | { kind: string; ref: string }>;
  }>;
  automations?: Array<{
    name: string;
    description?: string;
    trigger: {
      type: "cron" | "event" | "manual";
      cron?: string;
      eventType?: string;
    };
    action: {
      type: "playbook_run";
      playbookSlug: string;
      params?: Record<string, unknown>;
    };
  }>;
  /**
   * Graph-flow automations from workspace templates. This stays separate from
   * `automations` above: that historical field represents LOOP playbook
   * triggers and has a different wire contract.
   */
  flowAutomations?: PackagePostWorkspaceBody["automations"];
  capabilities?: PackagePostWorkspaceBody["capabilities"];
  actionPlacements?: PackagePostWorkspaceBody["actionPlacements"];
}

/**
 * Build the shared `applyPackagePostWorkspace` body from a
 * `createFromDefinition` definition: capabilities install alongside a single
 * autonomy `loops[]` entry carrying playbooks + their loop-style automation
 * triggers, plus `actionPlacements` merged into settings. Used by BOTH the
 * normal-create and compose-overlay branches so a loop-style definition can
 * never be misrouted into the graph-automation applier step.
 */
function buildPostWorkspaceBodyFromDefinition(
  definition: CreateDefinitionPostWorkspaceSlice,
  targetWorkspaceId: string
): PackagePostWorkspaceBody {
  const playbookDefs = definition.playbooks;
  const automationDefs = definition.automations;
  const hasLoop =
    (playbookDefs && playbookDefs.length > 0) ||
    (automationDefs && automationDefs.length > 0);
  const loopDef: LoopDefinition | undefined = hasLoop
    ? {
        key: `workspace-${targetWorkspaceId}`,
        name: "Workspace loop",
        // Loop playbook defs are "stored loosely, validated at the boundary"
        // (see LoopPlaybookDef) — cast the mapped array once rather than field
        // by field. Mirrors the pre-extraction inline literal's contextual typing.
        playbooks: (playbookDefs ?? []).map((pb) => ({
          ref: pb.name,
          name: pb.name,
          goalTemplate: pb.goalTemplate,
          description: pb.description,
          params: pb.params,
          executor: pb.executor,
          expectedOutputs: pb.expectedOutputs,
          // Carry the subject kind → `createLoopFromDefinition` forwards it to
          // `playbooksRouter.create`, landing on `subject_profile`.
          subjectProfile: pb.subjectProfile,
          // Carry the schedule through — `LoopPlaybookDef` and the loop applier
          // both support it, and without it a template-authored radar cadence
          // (`schedule: {cron, enabled:false}`) is silently dropped on this door.
          schedule: pb.schedule,
          // Grants may be authored as bare NAMES (the Hub door's form) or as
          // `{kind, ref}`. The loop applier writes `toId: g.id` straight into a
          // link row, so it needs a real row id — a NAME cannot be resolved
          // here (this is a pure function with no db). Objects pass through;
          // names are left to the Hub / approve-executor door, which resolves
          // them properly via `resolveGrantRefs`. Dropping them here keeps the
          // install succeeding instead of writing link rows pointing at a name.
          grants: pb.grants
            ?.filter(
              (g): g is { kind: "tool" | "skill" | "command"; ref: string } =>
                typeof g !== "string"
            )
            .map((g) => ({ kind: g.kind, id: g.ref })),
        })) as unknown as LoopPlaybookDef[],
        triggers: (automationDefs ?? []).map((auto) => ({
          name: auto.name,
          description: auto.description,
          trigger: {
            type: auto.trigger.type,
            cron: auto.trigger.cron,
            eventType: auto.trigger.eventType,
          },
          playbookRef: auto.action.playbookSlug,
          params: auto.action.params,
        })),
      }
    : undefined;
  return {
    automations: definition.flowAutomations,
    capabilities: definition.capabilities,
    loops: loopDef
      ? [{ definition: loopDef as unknown as Record<string, unknown> }]
      : undefined,
    actionPlacements: definition.actionPlacements,
  };
}

function getWorkspaceVisibility(settings: unknown): string {
  if (!settings || typeof settings !== "object") return "members";
  const visibility = (settings as Record<string, unknown>).workspaceVisibility;
  return typeof visibility === "string" ? visibility : "members";
}

function isPodReadableWorkspace(settings: unknown): boolean {
  const visibility = getWorkspaceVisibility(settings);
  return visibility === "pod_visible" || visibility === "pod_joinable";
}

/**
 * CLIENT-SAFE `workspaces.settings` keys — the ONE allowlist for every
 * user-facing read door (`workspaces.list`, `workspaces.get`).
 *
 * WHY AN ALLOWLIST (not a denylist): `settings` is an unencrypted JSONB blob
 * that anything can write via `as Record<string, unknown>` casts. It had
 * accumulated SEVEN plaintext credentials — `nango.secretKey`,
 * `messaging.unipile{ApiKey,Dsn,WebhookSecret}`, `enrichment.{apifyToken,
 * apolloApiKey}`, `controlPlane.telegramBotToken` — and NOT ONE of them is
 * declared in the `WorkspaceSettings` type. A denylist would have missed every
 * single one, and would fail open for the next key someone adds. So: every key
 * must be opt-in, justified by a real consumer read.
 *
 * Deliberately NOT allowlisted (and why):
 *   - `nango` / `messaging` / `enrichment` / `controlPlane` — credential bags.
 *   - `mcpServers` — command/args/url/env (arbitrary secret bag). Has its own
 *     membership-gated door: `getMcpServers`.
 *   - `corsAllowedOrigins` / `rolePermissions` / `validationRules` — security
 *     policy, zero client consumers.
 *
 * Mirrors the Hub REST allowlist (`hub-protocol/rest/workspaces.ts:489-509`)
 * plus the keys the browser/app genuinely read (each verified by grepping
 * consumers in `browser/`, `synap-app/`, `relay-app/`).
 *
 * NOTE: pod-admin doors (`adminGet`, `adminListAll`) intentionally return the
 * blob unprojected — a pod admin already has direct DB access, so projecting
 * there would buy no confidentiality while hiding config from the admin UI.
 */
const CLIENT_SAFE_SETTINGS_KEYS = [
  // ── Hub REST parity (workspace directory / capability source contract) ──
  "workspaceSubtype",
  "onboarding",
  "workspaceVisibility",
  "workspaceCapabilities",
  "sourceRoles",
  "defaultSources",
  "appId",
  "packageSlug",
  "systemSlug",
  // ── UI layout / view-id caches (non-sensitive ids + layout config) ──
  "layout", // browser useTemplateIntegration, workspace-proposal
  "mainWhiteboardId", // whiteboard resolution (workspaces.get documents this)
  "profileBentoViewIds", // ActivityBar → profile bento view
  "profileEntityBentoTemplates", // seeds entity bento on first open
  "profileRenderers", // CellStudioApp / DeskKeepMenu renderer overlay
  "sidebarItems", // telegram SidebarDrawer
  "installedPacks", // ProfilePackBrowserCell / WorkspaceSection badges
  // ── Agent / governance config surfaced in the settings UI ──
  "intelligenceServiceId", // AgentSystemsSection, AgentsTab, WorkspaceIntelligenceTabs
  "agentPersonality", // AgentsTab, WorkspaceIntelligenceTabs
  "agentModelPreferences", // intelligence ModelsTab
  "governanceMode", // WorkspaceIntelligenceTabs
  "aiGovernance", // governance settings tabs (policy config, NOT a credential)
  "proactiveAi", // proactive AI preferences
  // ── App-specific, non-sensitive ──
  "devplane", // devplane hooks: localTerminalEnabled
  "crm_4_entity_migration_v1", // crm migration marker
  "proposalId", // use-workspace-setup matches a workspace to its proposal
] as const;

/**
 * Keys whose VALUE needs its own allowlist rather than being shipped whole.
 *
 * `settings` is written by raw SQL in places (see `devplane.ts`), so a subtree
 * can carry fields the `WorkspaceSettings` type never declares — checking the
 * type is not enough, and allowlisting the container would ship them.
 */
const CLIENT_SAFE_SETTINGS_SUBKEYS: Record<string, readonly string[]> = {
  // `devplane.userProviders.{userId}.{provider}.apiKeyVaultRef` is raw-SQL
  // written and undeclared: it maps every member to the AI providers they
  // configured, plus the secret UUIDs. Only the terminal flag is client-safe.
  devplane: ["localTerminalEnabled"],
};

/**
 * Project a workspace row's `settings` down to `CLIENT_SAFE_SETTINGS_KEYS`.
 * Returns the row with `settings` replaced — never mutates the input.
 */
function projectWorkspaceSettings<T extends { settings?: unknown }>(
  workspace: T
): T {
  const raw = workspace.settings;
  if (!raw || typeof raw !== "object") return workspace;
  const source = raw as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of CLIENT_SAFE_SETTINGS_KEYS) {
    if (!(key in source)) continue;
    const leaves = CLIENT_SAFE_SETTINGS_SUBKEYS[key];
    const value = source[key];
    if (leaves && value && typeof value === "object" && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const leaf of leaves) if (leaf in inner) picked[leaf] = inner[leaf];
      safe[key] = picked;
      continue;
    }
    safe[key] = value;
  }
  return { ...workspace, settings: safe };
}

async function notifyCpInviteSync(input: {
  type: "workspace" | "pod";
  inviteToken: string;
  email: string;
  role: string;
  workspaceId?: string | null;
  workspaceName?: string | null;
  invitedByUserId?: string | null;
  expiresAt: Date;
}) {
  const cpUrl = config.server.controlPlaneUrl;
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  const podSubdomain =
    process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
  if (!cpUrl || !internalKey || !podSubdomain) return;
  const backendOrigin =
    process.env.PUBLIC_BACKEND_URL || process.env.SYNAP_INSTANCE_URL;
  const body = {
    podSubdomain,
    inviteToken: input.inviteToken,
    type: input.type,
    workspaceId: input.workspaceId ?? null,
    workspaceName: input.workspaceName ?? null,
    email: input.email,
    role: input.role,
    invitedByUserId: input.invitedByUserId ?? null,
    backendOrigin,
    expiresAt: input.expiresAt.toISOString(),
  };
  fetch(`${cpUrl}/internal/invites/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": internalKey,
    },
    body: JSON.stringify(body),
  }).catch((err) =>
    logger.warn({ err }, "Failed to sync invite to control plane")
  );
}

async function notifyCpInviteLifecycle(input: {
  inviteToken: string;
  event: "accepted" | "rejected" | "revoked" | "expired";
  actorEmail?: string;
  actorUserId?: string;
  reason?: string;
}) {
  const cpUrl = config.server.controlPlaneUrl;
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  const podSubdomain =
    process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
  if (!cpUrl || !internalKey || !podSubdomain) return;
  const body = {
    podSubdomain,
    inviteToken: input.inviteToken,
    event: input.event,
    actorEmail: input.actorEmail,
    actorUserId: input.actorUserId,
    reason: input.reason,
  };
  fetch(`${cpUrl}/internal/invites/lifecycle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": internalKey,
    },
    body: JSON.stringify(body),
  }).catch((err) =>
    logger.warn({ err }, "Failed to sync invite lifecycle to control plane")
  );
}

/**
 * Workspace CRUD operations
 */
export const workspacesRouter = router({
  /**
   * Create a new workspace
   */
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
      const {
        ensureDefaultCommands,
        ensureDefaultRelationDefs,
        ensureReportAutomation,
      } = await import("@synap/database");

      const commandsResult = await ensureDefaultCommands(input.id, ctx.userId);
      console.log(
        `[workspaces.get] ensureDefaultCommands:`,
        commandsResult.status,
        commandsResult.message
      );
      if (commandsResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure default commands:`,
          commandsResult.message,
          commandsResult.error
        );
      }

      const relDefsResult = await ensureDefaultRelationDefs(
        input.id,
        ctx.userId
      );
      console.log(
        `[workspaces.get] ensureDefaultRelationDefs:`,
        relDefsResult.status,
        relDefsResult.message
      );
      if (relDefsResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure default relation defs:`,
          relDefsResult.message,
          relDefsResult.error
        );
      }

      // THE report automation. Seeded here too (not only in workspace-init) so
      // workspaces created BEFORE it existed get it — same backfill contract as
      // the two ensure* calls above. Manual trigger, so it never runs unasked.
      const reportAutomationResult = await ensureReportAutomation(
        input.id,
        ctx.userId
      );
      console.log(
        `[workspaces.get] ensureReportAutomation:`,
        reportAutomationResult.status,
        reportAutomationResult.message
      );
      if (reportAutomationResult.status === "error") {
        console.error(
          `[workspaces.get] Failed to ensure report automation:`,
          reportAutomationResult.message,
          reportAutomationResult.error
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
          settings: input.settings,
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

      await workspaceRepo.update(
        input.id,
        {
          name: input.name || undefined,
          settings: input.settings || undefined,
        },
        ctx.userId
      );

      // Workspace overlay of per-kind AI posture changed → drop cached merges
      if (input.settings && "profileAiPosture" in input.settings) {
        ProfileResolutionService.invalidateAiPostureCache();
      }

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
          settings: input.settings,
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
        // CLIENT_SAFE_SETTINGS_KEYS — a pod admin already has direct DB access,
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

  /**
   * Add member to workspace
   */
  addMember: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
        role: z.enum(["owner", "editor", "viewer"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaceMember",
        action: "add",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          role: input.role,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Member addition requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      const member = await memberRepo.add(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
          role: input.role,
        },
        ctx.userId
      );

      // Team roster → person bridge (best-effort; never blocks membership)
      void ensureTeamPersonForMember(dbConn, {
        memberUserId: input.userId,
        workspaceId: input.workspaceId,
        ownerUserId: ctx.userId,
      }).catch((err) => {
        logger.warn(
          { err, memberUserId: input.userId, workspaceId: input.workspaceId },
          "Failed to ensure team person for member"
        );
      });

      // 3. Audit log
      auditLog({
        subjectType: "workspaceMember",
        action: "add",
        phase: "completed",
        subjectId: member.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          role: input.role,
          memberId: member.id,
        },
      });

      // 4. Auto-provision per-agent thread + workspace group + proactive feed for new member (idempotent)
      getAgentIdBySlug("orchestrator")
        .then(async (orchestratorId) => {
          if (orchestratorId) {
            await ensureAgentThread(input.userId, orchestratorId);
          }
        })
        .catch((err) => {
          logger.warn(
            { err },
            "Failed to provision orchestrator thread on workspace join"
          );
        });
      ensureWorkspaceGroupChannel(input.userId, input.workspaceId).catch(
        (err) => {
          logger.warn(
            { err },
            "Failed to provision workspace group channel on workspace join"
          );
        }
      );
      ensureProactiveFeedChannel(input.userId, input.workspaceId).catch(
        (err) => {
          logger.warn(
            { err },
            "Failed to provision proactive feed channel on workspace join"
          );
        }
      );

      return {
        status: "added" as const,
        memberId: member.id,
        message: "Member added successfully.",
      };
    }),

  /**
   * List workspace members
   */
  listMembers: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // Check user has access to workspace
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      return await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, input.workspaceId),
        orderBy: [desc(workspaceMembers.joinedAt)],
        with: { user: true },
      });
    }),

  /**
   * Remove member from workspace
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaceMember",
        action: "remove",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Member removal requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      await memberRepo.remove(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
        },
        ctx.userId
      );

      // Team roster → person bridge: soft-detach team-member facet (best-effort)
      void detachTeamMemberFacet(dbConn, {
        memberUserId: input.userId,
        workspaceId: input.workspaceId,
        ownerUserId: ctx.userId,
      }).catch((err) => {
        logger.warn(
          {
            err,
            memberUserId: input.userId,
            workspaceId: input.workspaceId,
          },
          "Failed to detach team-member facet on member remove"
        );
      });

      // 3. Audit log
      auditLog({
        subjectType: "workspaceMember",
        action: "remove",
        phase: "completed",
        subjectId: `${input.workspaceId}-${input.userId}`,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
        },
      });

      return {
        status: "removed" as const,
        message: "Member removed successfully.",
      };
    }),

  /**
   * Backfill person entities + team-member facets for all human workspace members.
   * Owner/admin only. Idempotent (ensureTeamPersonForMember is safe to re-run).
   */
  backfillTeamPersonBridge: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
        columns: { role: true },
      });

      if (
        !membership ||
        (membership.role !== "owner" && membership.role !== "admin")
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Backfilling the team-person bridge requires owner or admin access.",
        });
      }

      const dbConn = await getDb();
      return runBackfillTeamPersonBridge(dbConn, {
        workspaceId: input.workspaceId,
        ownerUserId: ctx.userId,
      });
    }),

  /**
   * Update member role
   */
  updateMemberRole: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        userId: z.string(),
        role: z.enum(["admin", "editor", "viewer"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaceMember",
        action: "updateRole",
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          newRole: input.role,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          message: "Role update requires approval.",
        };
      }

      // 2. Direct DB operation
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      const member = await memberRepo.updateRole(
        {
          workspaceId: input.workspaceId,
          userId: input.userId,
          newRole: input.role as "owner" | "editor" | "viewer",
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "workspaceMember",
        action: "updateRole",
        phase: "completed",
        subjectId: member.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: {
          workspaceId: input.workspaceId,
          targetUserId: input.userId,
          newRole: input.role,
          memberId: member.id,
        },
      });

      return {
        status: "updated" as const,
        message: "Member role updated successfully.",
      };
    }),

  /**
   * Create an invite (workspace or pod-level).
   * - type='workspace': requires workspaceId, adds invitee to that workspace only.
   * - type='pod': no workspaceId required, adds invitee to ALL workspaces on accept.
   */
  createInvite: protectedProcedure
    .input(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("workspace"),
          workspaceId: z.string().uuid(),
          email: z.string().email(),
          role: z.enum(["admin", "editor", "viewer"]),
        }),
        z.object({
          type: z.literal("pod"),
          email: z.string().email(),
          role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      if (input.type === "workspace") {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });
        if (!membership || !["owner", "admin"].includes(membership.role)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only owners/admins can invite",
          });
        }
      } else {
        // Pod invite — must be an owner of at least one workspace
        const ownerMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, ctx.userId),
            eq(workspaceMembers.role, "owner")
          ),
        });
        if (!ownerMembership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only pod owners can send pod invites",
          });
        }
      }

      // If a stale account exists for this email (no workspace memberships),
      // clean it up so the new invite can be accepted without a Kratos 409.
      const staleUser = await db.query.users.findFirst({
        where: eq(users.email, input.email.trim().toLowerCase()),
        columns: { id: true },
      });
      if (staleUser) {
        const hasAnyMembership = await db.query.workspaceMembers.findFirst({
          where: eq(workspaceMembers.userId, staleUser.id),
          columns: { workspaceId: true },
        });
        if (!hasAnyMembership) {
          try {
            await kratosAdmin.deleteIdentity({ id: staleUser.id });
          } catch {
            // Identity may have already been removed — proceed with DB cleanup.
          }
          await db.delete(users).where(eq(users.id, staleUser.id));
        }
      }

      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const [invite] = await db
        .insert(invites)
        .values({
          type: input.type,
          workspaceId: input.type === "workspace" ? input.workspaceId : null,
          email: input.email,
          role: input.role,
          token,
          invitedBy: ctx.userId,
          expiresAt,
        })
        .returning();

      let workspaceNameForSync: string | null = null;
      if (input.type === "workspace") {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, input.workspaceId),
          columns: { name: true },
        });
        workspaceNameForSync = ws?.name ?? "Synap Workspace";
      }

      // Notify CP to send invite email (fire-and-forget)
      const cpUrl = config.server.controlPlaneUrl;
      if (cpUrl) {
        const inviter = await db.query.users.findFirst({
          where: eq(users.id, ctx.userId),
          columns: { name: true },
        });
        const inviterName = inviter?.name ?? "A Synap user";

        const podSubdomain =
          process.env.POD_SUBDOMAIN ?? process.env.SERVER_DOMAIN ?? "";
        const body: Record<string, string> = {
          type: input.type,
          email: input.email,
          inviterName,
          role: input.role,
          inviteToken: invite.token,
          podSubdomain,
          clientHint: "auto",
        };
        const backendOrigin =
          process.env.PUBLIC_BACKEND_URL || process.env.SYNAP_INSTANCE_URL;
        if (backendOrigin) {
          body.backendOrigin = backendOrigin;
        }
        if (workspaceNameForSync) {
          body.workspaceName = workspaceNameForSync;
        }

        const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
        fetch(`${cpUrl}/internal/invite-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(internalKey ? { "X-Internal-Key": internalKey } : {}),
          },
          body: JSON.stringify(body),
        }).catch((err) =>
          logger.warn({ err }, "Failed to send invite email (non-fatal)")
        );
      }

      void notifyCpInviteSync({
        type: input.type,
        inviteToken: invite.token,
        email: input.email,
        role: input.role,
        workspaceId: input.type === "workspace" ? input.workspaceId : null,
        workspaceName: workspaceNameForSync,
        invitedByUserId: ctx.userId,
        expiresAt: invite.expiresAt,
      });

      return {
        id: invite.id,
        token: invite.token,
        expiresAt: invite.expiresAt,
        emailSent: !!cpUrl,
      };
    }),

  /**
   * List invites addressed to the current user email (recipient inbox).
   */
  listMyInvites: protectedProcedure.query(async ({ ctx }) => {
    const me = await db.query.users.findFirst({
      where: eq(users.id, ctx.userId),
      columns: { email: true },
    });
    if (!me?.email) return [];
    return db.query.invites.findMany({
      where: eq(invites.email, me.email.toLowerCase()),
      with: { workspace: { columns: { name: true } } },
      orderBy: [desc(invites.createdAt)],
    });
  }),

  /**
   * List pending invites. Pass workspaceId to list workspace invites,
   * omit it (or pass type='pod') to list pod invites (owner only).
   */
  listInvites: protectedProcedure
    .input(
      z.object({
        type: z.enum(["workspace", "pod"]),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (input.type === "workspace") {
        if (!input.workspaceId)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "workspaceId required for workspace invites",
          });
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });
        if (!membership)
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });

        return db.query.invites.findMany({
          where: and(
            eq(invites.type, "workspace"),
            eq(invites.workspaceId, input.workspaceId),
            gt(invites.expiresAt, new Date())
          ),
          orderBy: [desc(invites.createdAt)],
        });
      } else {
        const ownerMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, ctx.userId),
            eq(workspaceMembers.role, "owner")
          ),
        });
        if (!ownerMembership) throw new TRPCError({ code: "FORBIDDEN" });

        return db.query.invites.findMany({
          where: and(
            eq(invites.type, "pod"),
            gt(invites.expiresAt, new Date())
          ),
          orderBy: [desc(invites.createdAt)],
        });
      }
    }),

  /**
   * Accept invitation (workspace or pod). Works for both types.
   */
  acceptInvite: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
      });
      if (!invite)
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      if (invite.expiresAt < new Date())
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invite expired" });
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.userId),
        columns: { email: true },
      });
      if (
        me?.email &&
        invite.email &&
        me.email.toLowerCase() !== invite.email.toLowerCase()
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This invite is addressed to another email",
        });
      }

      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      if (invite.type === "workspace") {
        if (!invite.workspaceId)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const member = await memberRepo.add(
          {
            workspaceId: invite.workspaceId,
            userId: ctx.userId,
            role: invite.role as "owner" | "editor" | "viewer",
            inviteId: invite.id,
          },
          ctx.userId
        );
        // Team roster → person bridge (best-effort; never blocks membership)
        void ensureTeamPersonForMember(dbConn, {
          memberUserId: ctx.userId,
          workspaceId: invite.workspaceId,
          ownerUserId: invite.invitedBy ?? ctx.userId,
        }).catch((err) => {
          logger.warn(
            {
              err,
              memberUserId: ctx.userId,
              workspaceId: invite.workspaceId,
            },
            "Failed to ensure team person for member on invite accept"
          );
        });
        auditLog({
          subjectType: "workspaceMember",
          action: "add",
          phase: "completed",
          subjectId: member.id,
          userId: ctx.userId,
          workspaceId: invite.workspaceId,
          data: {
            role: invite.role,
            invitedBy: invite.invitedBy,
            inviteId: invite.id,
          },
        });
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: me?.email ?? undefined,
          actorUserId: ctx.userId,
        });
        return {
          status: "accepted" as const,
          type: "workspace" as const,
          workspaceId: invite.workspaceId,
        };
      } else {
        // Pod invite. ADDITIVE (Membership → Visibility, Wave 1): record durable
        // pod-membership identity. The workspace fan-out below is KEPT — removing
        // it now would regress visibility before Wave 2's floor consults
        // pod_members. onConflictDoNothing: one row per user_id.
        await db
          .insert(podMembers)
          .values({
            userId: ctx.userId,
            podRole: "member",
            invitedBy: invite.invitedBy ?? null,
          })
          .onConflictDoNothing();
        // Pod invite — add to all workspaces
        const allWorkspaces = await db.query.workspaces.findMany();
        for (const ws of allWorkspaces) {
          const alreadyMember = await db.query.workspaceMembers.findFirst({
            where: and(
              eq(workspaceMembers.workspaceId, ws.id),
              eq(workspaceMembers.userId, ctx.userId)
            ),
          });
          if (alreadyMember) continue;
          await memberRepo.add(
            {
              workspaceId: ws.id,
              userId: ctx.userId,
              role: invite.role as "owner" | "editor" | "viewer",
            },
            ctx.userId
          );
          // Team roster → person bridge (best-effort; never blocks membership)
          void ensureTeamPersonForMember(dbConn, {
            memberUserId: ctx.userId,
            workspaceId: ws.id,
            ownerUserId: invite.invitedBy ?? ctx.userId,
          }).catch((err) => {
            logger.warn(
              { err, memberUserId: ctx.userId, workspaceId: ws.id },
              "Failed to ensure team person for member on pod invite accept"
            );
          });
        }
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: me?.email ?? undefined,
          actorUserId: ctx.userId,
        });
        return {
          status: "accepted" as const,
          type: "pod" as const,
          workspacesJoined: allWorkspaces.length,
        };
      }
    }),

  /**
   * Revoke an invite (workspace or pod).
   */
  revokeInvite: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await db.query.invites.findFirst({
        where: eq(invites.id, input.id),
      });
      if (!invite)
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });

      if (invite.type === "workspace" && invite.workspaceId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, invite.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });
        if (!membership || !["owner", "admin"].includes(membership.role)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only owners/admins can revoke invites",
          });
        }
      } else {
        const ownerMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, ctx.userId),
            eq(workspaceMembers.role, "owner")
          ),
        });
        if (!ownerMembership) throw new TRPCError({ code: "FORBIDDEN" });
      }

      await db.delete(invites).where(eq(invites.id, input.id));
      void notifyCpInviteLifecycle({
        inviteToken: invite.token,
        event: "revoked",
        actorUserId: ctx.userId,
      });
      return { success: true };
    }),

  /**
   * List ALL members across every workspace the caller has access to,
   * deduplicated by user. The operator's "pod-wide roster" view in
   * settings/members reads this — see Eve dashboard
   * `app/(os)/settings/members/page.tsx`.
   *
   * Permission model (intentionally permissive read):
   *   • Caller must be a member of at least one workspace.
   *   • Returned membership rows are restricted to workspaces the caller
   *     is also a member of — we never expose memberships from
   *     workspaces the caller can't see. (Conservative: this is the
   *     same surface listMembers already exposes per-workspace.)
   *
   * Shape:
   *   {
   *     id, email, name, avatarUrl,
   *     primaryRole: "owner" | "admin" | "editor" | "viewer",
   *     workspaceCount: number,
   *     workspaces: Array<{ id, name, role, joinedAt }>
   *   }
   *
   * `primaryRole` is the highest-precedence role across the user's
   * memberships in workspaces the caller can see. Order:
   *   owner > admin > editor > viewer
   */
  listPodMembers: protectedProcedure.query(async ({ ctx }) => {
    // 1. Find every workspace the caller belongs to.
    const myMemberships = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, ctx.userId),
      columns: { workspaceId: true },
    });
    const accessibleWorkspaceIds = myMemberships.map((m) => m.workspaceId);
    if (accessibleWorkspaceIds.length === 0) return [];

    // 2. Pull every membership row for those workspaces, joined with
    //    user + workspace metadata for display.
    const rows = await db.query.workspaceMembers.findMany({
      where: inArray(workspaceMembers.workspaceId, accessibleWorkspaceIds),
      with: {
        user: {
          columns: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            userType: true,
          },
        },
        workspace: { columns: { id: true, name: true } },
      },
    });

    // 3. Deduplicate by userId. Compute the highest role across the
    //    user's memberships (operator's lens).
    const roleRank: Record<string, number> = {
      owner: 4,
      admin: 3,
      editor: 2,
      viewer: 1,
    };
    type WorkspaceRef = {
      id: string;
      name: string;
      role: string;
      joinedAt: Date;
    };
    const byUser = new Map<
      string,
      {
        id: string;
        email: string;
        name: string | null;
        avatarUrl: string | null;
        userType: string;
        primaryRole: string;
        workspaces: WorkspaceRef[];
      }
    >();
    for (const r of rows) {
      // Skip rows whose user row is missing (orphaned membership) and
      // skip non-human users (agents) — they show up in
      // workspace_members for governance reasons but the operator
      // roster is for human teammates.
      if (!r.user) continue;
      if (r.user.userType !== "human") continue;
      const existing = byUser.get(r.user.id);
      const wsRef: WorkspaceRef = {
        id: r.workspace?.id ?? r.workspaceId,
        name: r.workspace?.name ?? "",
        role: r.role,
        joinedAt: r.joinedAt,
      };
      if (!existing) {
        byUser.set(r.user.id, {
          id: r.user.id,
          email: r.user.email,
          name: r.user.name,
          avatarUrl: r.user.avatarUrl,
          userType: r.user.userType,
          primaryRole: r.role,
          workspaces: [wsRef],
        });
      } else {
        existing.workspaces.push(wsRef);
        if ((roleRank[r.role] ?? 0) > (roleRank[existing.primaryRole] ?? 0)) {
          existing.primaryRole = r.role;
        }
      }
    }

    // 4. Stable sort: operator first, then by primaryRole desc, then
    //    by name/email asc.
    const list = [...byUser.values()].map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      primaryRole: u.primaryRole as "owner" | "admin" | "editor" | "viewer",
      workspaceCount: u.workspaces.length,
      workspaces: u.workspaces,
    }));
    list.sort((a, b) => {
      if (a.id === ctx.userId) return -1;
      if (b.id === ctx.userId) return 1;
      const dr =
        (roleRank[b.primaryRole] ?? 0) - (roleRank[a.primaryRole] ?? 0);
      if (dr !== 0) return dr;
      const an = (a.name ?? a.email).toLowerCase();
      const bn = (b.name ?? b.email).toLowerCase();
      return an.localeCompare(bn);
    });
    return list;
  }),

  /**
   * List ALL pending invites across every workspace the caller can
   * manage, plus pod-level invites if the caller is a pod owner.
   *
   * Used by the Eve members page to show a single "Pending invites"
   * table. Returns invites with workspace name (when applicable) so
   * the UI doesn't need a second round-trip per row.
   *
   * Permission model:
   *   • Workspace invites: returned only for workspaces where caller
   *     is owner or admin (matches createInvite/revokeInvite gates).
   *   • Pod invites: returned only when the caller owns at least one
   *     workspace (matches the pod-invite gate elsewhere).
   */
  listAllInvites: protectedProcedure.query(async ({ ctx }) => {
    const myMemberships = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, ctx.userId),
      columns: { workspaceId: true, role: true },
    });
    const manageableWorkspaceIds = myMemberships
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => m.workspaceId);
    const isPodOwner = myMemberships.some((m) => m.role === "owner");

    // Query workspace invites for manageable workspaces + pod invites
    // for pod owners. Empty arrays bail early so we don't issue empty
    // IN-clause queries.
    const conditions = [];
    if (manageableWorkspaceIds.length > 0) {
      conditions.push(
        and(
          eq(invites.type, "workspace"),
          inArray(invites.workspaceId, manageableWorkspaceIds)
        )
      );
    }
    if (isPodOwner) {
      conditions.push(eq(invites.type, "pod"));
    }
    if (conditions.length === 0) return [];

    const rows = await db.query.invites.findMany({
      where: conditions.length === 1 ? conditions[0] : or(...conditions),
      with: { workspace: { columns: { id: true, name: true } } },
      orderBy: [desc(invites.createdAt)],
    });

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      email: r.email,
      role: r.role,
      token: r.token,
      workspaceId: r.workspaceId,
      workspaceName: r.workspace?.name ?? null,
      invitedBy: r.invitedBy,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
  }),

  /**
   * Remove a user from EVERY workspace the caller can manage.
   * Pod-wide eviction in a single call.
   *
   * Why this exists (vs. iterating removeMember from the UI):
   *   • One permission check vs. N round-trips.
   *   • One audit-log row summarising the eviction.
   *   • Atomic "no-op when not allowed" semantics — if the caller
   *     can't manage ANY of the target's workspaces we throw
   *     FORBIDDEN, instead of partial removal.
   *
   * Permission model:
   *   • Caller must be owner or admin of at least one workspace
   *     containing the target user.
   *   • Removal happens for every workspace where:
   *       (a) caller is owner|admin, AND
   *       (b) target is currently a member.
   *   • Caller cannot remove themselves (use a per-workspace
   *     leaveWorkspace procedure for that — out of scope here).
   *   • Removal is blocked when it would leave a workspace with zero
   *     owners (last-owner guard).
   */
  removeFromPod: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can't remove yourself from the pod.",
        });
      }

      // Fetch the caller's manageable workspaces and the target's
      // workspaces in parallel.
      const [myMemberships, targetMemberships] = await Promise.all([
        db.query.workspaceMembers.findMany({
          where: eq(workspaceMembers.userId, ctx.userId),
          columns: { workspaceId: true, role: true },
        }),
        db.query.workspaceMembers.findMany({
          where: eq(workspaceMembers.userId, input.userId),
          columns: { workspaceId: true, role: true },
        }),
      ]);

      const manageableWs = new Set(
        myMemberships
          .filter((m) => m.role === "owner" || m.role === "admin")
          .map((m) => m.workspaceId)
      );
      const targetWs = new Map(
        targetMemberships.map((m) => [m.workspaceId, m.role])
      );

      // Intersection: workspaces where caller can act AND target is
      // currently a member.
      const toRemove = [...targetWs.keys()].filter((wid) =>
        manageableWs.has(wid)
      );
      if (toRemove.length === 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You don't have permission to remove this member from any workspace.",
        });
      }

      // Last-owner guard: if removing the target would leave any
      // workspace with zero owners, refuse the whole operation.
      // Cheaper to do it once with a single GROUP BY than one query
      // per workspace.
      for (const wid of toRemove) {
        if (targetWs.get(wid) !== "owner") continue;
        const owners = await db.query.workspaceMembers.findMany({
          where: and(
            eq(workspaceMembers.workspaceId, wid),
            eq(workspaceMembers.role, "owner")
          ),
          columns: { userId: true },
        });
        if (owners.length <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot remove the last owner of a workspace. Promote another member first.",
          });
        }
      }

      // Execute removals — best-effort serial; we collect failures so
      // a single broken workspace doesn't abort the rest. Audit-log
      // covers each removal for forensics.
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);
      const removed: string[] = [];
      const errors: Array<{ workspaceId: string; error: string }> = [];
      for (const wid of toRemove) {
        try {
          await memberRepo.remove(
            { workspaceId: wid, userId: input.userId },
            ctx.userId
          );
          removed.push(wid);
          // Team roster → person bridge: soft-detach team-member facet (best-effort)
          void detachTeamMemberFacet(dbConn, {
            memberUserId: input.userId,
            workspaceId: wid,
            ownerUserId: ctx.userId,
          }).catch((err) => {
            logger.warn(
              {
                err,
                memberUserId: input.userId,
                workspaceId: wid,
              },
              "Failed to detach team-member facet on removeFromPod"
            );
          });
        } catch (err) {
          errors.push({
            workspaceId: wid,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      // If user has no remaining memberships, clean up their pod identity
      // so the same email can be re-invited later.
      if (removed.length > 0) {
        const remainingMembership = await db.query.workspaceMembers.findFirst({
          where: eq(workspaceMembers.userId, input.userId),
          columns: { workspaceId: true },
        });
        if (!remainingMembership) {
          try {
            await kratosAdmin.deleteIdentity({ id: input.userId });
          } catch (err) {
            logger.warn(
              { err, userId: input.userId },
              "Failed to delete Kratos identity on pod removal — re-invite may not work"
            );
          }
          await db.delete(users).where(eq(users.id, input.userId));
        }
      }

      auditLog({
        subjectType: "workspaceMember",
        action: "removeFromPod",
        phase: "completed",
        subjectId: input.userId,
        userId: ctx.userId,
        data: {
          targetUserId: input.userId,
          removedFromWorkspaces: removed,
          errors,
        },
      });

      return {
        status: "removed" as const,
        removedFromWorkspaces: removed.length,
        totalWorkspaces: toRemove.length,
        errors,
      };
    }),

  /**
   * Create a complete workspace from a PackageDefinition in a single call.
   *
   * Server-side equivalent of the frontend's 9-step useCreateWorkspaceFromProposal.
   * Preferred path for template-based workspace creation (packages from registry).
   */
  createFromDefinition: protectedProcedure
    .input(
      z.object({
        definition: z
          .object({
            workspaceName: z.string().optional(),
            description: z.string().optional(),
            /**
             * Workspace composition (north star §10): import/extend bricks
             * (profiles + views) from another SHARED/PUBLIC/SYSTEM workspace.
             * Resolved + merged (COPY semantics) by `resolveWorkspaceExtends`
             * before materialization. Each `source` is a workspaceId or a
             * systemSlug; omit `import`/a key to import all. Reads are
             * access-gated — a caller can only import from a workspace they can
             * see (member / pod_visible / pod_joinable / system).
             */
            extends: z
              .array(
                z.object({
                  source: z.string().min(1),
                  import: z
                    .object({
                      profiles: z.array(z.string()).optional(),
                      views: z.array(z.string()).optional(),
                    })
                    .optional(),
                })
              )
              .optional(),
            profiles: z
              .array(
                z.object({
                  slug: z.string(),
                  displayName: z.string(),
                  // Proposal format: direct fields
                  icon: z.string().optional(),
                  color: z.string().optional(),
                  description: z.string().optional(),
                  scope: z.string().optional(),
                  entityScope: z.enum(["pod", "workspace"]).optional(),
                  semanticSlug: z.string().nullable().optional(),
                  // Profiles are either entity kinds (person, company) or
                  // attachable roles (lead, client). Keep this generic: the
                  // definition author, not the workspace router, owns the
                  // domain vocabulary.
                  profileKind: z.enum(["kind", "role"]).optional(),
                  applicableKinds: z.array(z.string()).optional(),
                  // Proposal format: flat property list
                  properties: z
                    .array(
                      z.object({
                        slug: z.string(),
                        label: z.string().optional(),
                        valueType: z.string(),
                        inputType: z.string().optional(),
                        placeholder: z.string().optional(),
                        enumValues: z.array(z.string()).optional(),
                        constraints: z
                          .record(z.string(), z.unknown())
                          .optional(),
                        // entity_id properties: which profile this field links to
                        targetProfileSlug: z.string().optional(),
                      })
                    )
                    .optional(),
                  // Registry format: nested uiHints (alternative to direct fields)
                  uiHints: z
                    .object({
                      icon: z.string().optional(),
                      color: z.string().optional(),
                      description: z.string().optional(),
                    })
                    .optional(),
                  // Registry format: propertyDefs with nested uiHints (alternative to properties[])
                  propertyDefs: z
                    .array(
                      z.object({
                        slug: z.string(),
                        valueType: z.string(),
                        required: z.boolean().optional(),
                        constraints: z
                          .object({
                            enum: z.array(z.string()).optional(),
                          })
                          .passthrough()
                          .optional(),
                        uiHints: z
                          .object({
                            label: z.string().optional(),
                            inputType: z.string().optional(),
                            placeholder: z.string().optional(),
                          })
                          .optional(),
                      })
                    )
                    .optional(),
                })
              )
              .optional(),
            views: z
              .array(
                z.object({
                  // Accept both "name" (proposal format) and "displayName" (registry format)
                  name: z.string().optional(),
                  displayName: z.string().optional(),
                  slug: z.string().optional(),
                  type: z.string(),
                  scopeProfileSlug: z.string().optional(),
                  scopeProfileSlugs: z.array(z.string()).optional(),
                  config: z.record(z.string(), z.unknown()).optional(),
                  // View configuration fields (merged into config during processing)
                  groupBy: z.string().optional(),
                  sortBy: z.string().optional(),
                  sortOrder: z.enum(["asc", "desc"]).optional(),
                  filterBy: z.record(z.string(), z.unknown()).optional(),
                  description: z.string().optional(),
                  defaultView: z.boolean().optional(),
                  hierarchyEdges: z
                    .array(
                      z.object({
                        parent: z.string(),
                        child: z.string(),
                        via: z.string().optional(),
                      })
                    )
                    .optional(),
                  startField: z.string().optional(),
                  endField: z.string().optional(),
                  colorBy: z.string().optional(),
                })
              )
              .optional(),
            /** Override the default "Home" name for the workspace home bento view */
            bentoViewName: z.string().optional(),
            bentoLayout: z
              .array(
                z.object({
                  widgetType: z.string(),
                  pos: z.object({
                    x: z.number(),
                    y: z.number(),
                    w: z.number(),
                    h: z.number(),
                  }),
                  config: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            bentoViewBlocks: z
              .array(
                z.object({
                  kind: z.literal("view").default("view"),
                  viewName: z.string(),
                  pos: z.object({
                    x: z.number(),
                    y: z.number(),
                    w: z.number(),
                    h: z.number(),
                  }),
                  overrides: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            suggestedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                })
              )
              .optional(),
            /** Alias for suggestedEntities (used by some template authors). Normalized server-side. */
            seedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                })
              )
              .optional(),
            suggestedRelations: z
              .array(
                z.object({
                  sourceRef: z.string(),
                  targetRef: z.string(),
                  type: z.string(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            displayTemplates: z
              .array(
                z.object({
                  name: z.string(),
                  description: z.string().optional(),
                  entityType: z.string().optional(),
                  targetType: z.string().optional(),
                  isDefault: z.boolean().optional(),
                  config: z.record(z.string(), z.unknown()),
                })
              )
              .optional(),
            layoutConfig: z
              .object({
                pinnedApps: z.array(z.string()).optional(),
                primarySurface: workspacePrimarySurfaceSchema.nullish(),
                /** Legacy compatibility input. New definitions author
                 *  `primarySurface`; null remains an explicit home fallback. */
                defaultApp: z.string().nullable().optional(),
                defaultView: z
                  .string()
                  .nullish()
                  .transform((v) => v ?? undefined),
                theme: z
                  .string()
                  .nullish()
                  .transform((v) => v ?? undefined),
                sidebarItems: z
                  .array(
                    z
                      .object({
                        // "profile" = navigate to profile bento view (new)
                        // "external" = third-party URL (legacy)
                        // "cell" = legacy side-panel shorthand; rich targets use surface.
                        kind: z.enum([
                          "app",
                          "view",
                          "profile",
                          "external",
                          "cell",
                        ]),
                        appId: z.string().optional(),
                        viewName: z.string().optional(),
                        viewId: z.string().optional(),
                        profileSlug: z.string().optional(),
                        url: z.string().optional(),
                        cellKey: z.string().optional(),
                        cellProps: z.record(z.string(), z.unknown()).optional(),
                        label: z.string().optional(),
                        icon: z.string().optional(),
                        section: z.string().optional(),
                        matchUrls: z.array(z.string()).optional(),
                        surface: z
                          .object({
                            kind: z.enum([
                              "cell",
                              "view",
                              "entity",
                              "document",
                              "channel",
                              "app",
                              "url",
                            ]),
                            cellKey: z.string().optional(),
                            viewId: z.string().optional(),
                            viewName: z.string().optional(),
                            entityId: z.string().optional(),
                            documentId: z.string().optional(),
                            channelId: z.string().optional(),
                            appId: z.string().optional(),
                            url: z.string().optional(),
                            srcdoc: z.string().optional(),
                            rendererType: z
                              .enum(["native", "external", "iframe-srcdoc"])
                              .optional(),
                            external: z.boolean().optional(),
                            placement: z
                              .enum([
                                "main",
                                "side",
                                "floating",
                                "modal",
                                "popover",
                                "embed",
                              ])
                              .optional(),
                            displayMode: z
                              .enum(["compact", "medium", "full"])
                              .optional(),
                            props: z.record(z.string(), z.unknown()).optional(),
                            title: z.string().optional(),
                            workspaceId: z.string().nullable().optional(),
                            meta: z.record(z.string(), z.unknown()).optional(),
                          })
                          .passthrough()
                          .optional(),
                      })
                      .passthrough()
                  )
                  .optional(),
              })
              .optional(),
            /** Per-profile default entity bento layout; stored in workspace.settings */
            profileEntityBentoTemplates: z
              .record(
                z.string(),
                z.object({ blocks: z.array(z.record(z.string(), z.unknown())) })
              )
              .optional(),
            workspaceSubtype: z.string().optional(),
            workspaceVisibility: z
              .enum([
                "private",
                "members",
                "pod_visible",
                "pod_joinable",
                "public_link",
              ])
              .optional(),
            workspaceCapabilities: z.array(z.string()).optional(),
            sourceRoles: z
              .record(
                z.string(),
                z.enum(["provider", "consumer", "provider-consumer"])
              )
              .optional(),
            defaultSources: z
              .record(
                z.string(),
                z.object({
                  workspaceId: z.string().uuid(),
                  capability: z.string().optional(),
                  profileSlug: z.string().optional(),
                  label: z.string().optional(),
                })
              )
              .optional(),
            entityLinks: z
              .array(
                z.object({
                  sourceProfileSlug: z.string(),
                  targetProfileSlug: z.string(),
                  type: z.string(),
                  label: z.string().optional(),
                })
              )
              .optional(),
            /** Playbook templates (session templates with goal + capabilities) */
            playbooks: z
              .array(
                z.object({
                  name: z.string().min(1).max(500),
                  goalTemplate: z.string().min(1).max(5000),
                  description: z.string().optional(),
                  params: z
                    .array(
                      z.object({
                        name: z.string(),
                        type: z.enum(["string", "number", "boolean"]),
                        default: z
                          .union([z.string(), z.number(), z.boolean()])
                          .optional(),
                        description: z.string().optional(),
                      })
                    )
                    .optional(),
                  executor: z
                    .enum(["is-agent", "external-agent", "hybrid"])
                    .optional(),
                  /**
                   * Scheduled cadence (`{cron, enabled}`) — e.g. a radar's
                   * weekly scan. Undeclared here, zod STRIPPED it and the
                   * template's schedule never reached the DB on this door.
                   */
                  schedule: z
                    .object({
                      cron: z.string(),
                      enabled: z.boolean().optional(),
                    })
                    .nullable()
                    .optional(),
                  /**
                   * Entity kind the playbook operates over → persisted to
                   * `playbooks.subject_profile`, making it matchable by
                   * `playbooks.matchForEntity`. Forwarded into the LoopDefinition
                   * below and materialized by `createLoopFromDefinition`.
                   */
                  subjectProfile: z
                    .object({
                      profileSlug: z.string(),
                      filter: z.record(z.string(), z.unknown()).optional(),
                    })
                    .optional(),
                  /**
                   * Workspace templates author grants as BARE NAMES
                   * (`grants: [exa_search, entity.create]`) — the same form the
                   * Hub door already accepts (`PackagePostWorkspaceBody
                   * .playbooks[].grants: string[]`). Requiring only the
                   * `{kind, ref}` object form made this door REJECT the whole
                   * mutation for any template carrying playbook grants, so a
                   * browser install 400'd outright. Accept both shapes here;
                   * `buildPostWorkspaceBodyFromDefinition` narrows them.
                   */
                  grants: z
                    .array(
                      z.union([
                        z.string(),
                        z.object({
                          kind: z.enum(["tool", "skill", "command"]),
                          ref: z.string(),
                        }),
                      ])
                    )
                    .optional(),
                  expectedOutputs: z
                    .array(
                      z.object({
                        description: z.string(),
                        type: z.enum(["document", "entities", "csv", "report"]),
                      })
                    )
                    .optional(),
                })
              )
              .optional(),
            /** Automation templates (event/cron/manual triggers for playbook runs) */
            automations: z
              .array(
                z.object({
                  key: z.string().min(1).optional(),
                  name: z.string().min(1),
                  description: z.string().optional(),
                  trigger: z.object({
                    type: z.enum(["cron", "event", "manual"]),
                    cron: z.string().optional(),
                    eventType: z.string().optional(),
                  }),
                  action: z.object({
                    type: z.literal("playbook_run"),
                    playbookSlug: z.string(),
                    params: z.record(z.string(), z.unknown()).optional(),
                  }),
                })
              )
              .optional(),
            /**
             * Graph-flow template automations. This is deliberately not the
             * legacy `automations` field above, which seeds LOOP playbook
             * triggers with a different schema.
             */
            flowAutomations: z
              .array(
                z.object({
                  key: z.string().min(1).optional(),
                  name: z.string().min(1),
                  description: z.string().optional(),
                  triggerType: z.enum(["event", "cron", "webhook", "manual"]),
                  triggerConfig: z.record(z.string(), z.unknown()).optional(),
                  flowDefinition: z
                    .object({
                      nodes: z.array(z.unknown()),
                      edges: z.array(z.unknown()),
                      precondition: z.string().optional(),
                    })
                    .optional(),
                  status: z.enum(["draft", "active", "paused"]).optional(),
                })
              )
              .optional(),
            /** Tool templates (registered integrations available to AI agents) */
            tools: z
              .array(
                z.object({
                  name: z.string().min(1),
                  kind: z.enum([
                    "api",
                    "mcp",
                    "provider",
                    "external",
                    "script",
                    "builtin",
                  ]),
                  description: z.string().optional(),
                  credentialRequired: z.boolean().optional(),
                  inputSchema: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            /**
             * Capability integrations (→ tools + skills + vault + capability-
             * embedded automations/playbooks). This is the operational bundle:
             * `toPackageDefinition` emits it from a template's `integrations:`
             * list. Installed via the SHARED `applyPackagePostWorkspace` door
             * (same as Hub `/packages/apply`) so the browser install path carries
             * capabilities too — before this it installed none.
             */
            capabilities: z
              .array(
                z.object({
                  templateKey: z.string().optional(),
                  definition: z.record(z.string(), z.unknown()).optional(),
                  params: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            /**
             * Template-composition dependencies — resolved BEFORE the workspace
             * step, mirroring PackageApplySchema in the Hub packages route
             * (`POST /packages/apply`). A `compose` dependency layers this
             * package ADDITIVELY onto its base workspace (no second workspace
             * is created); `require` deps are installed/surfaced. The browser
             * marketplace forwards these verbatim in `options.definition`.
             */
            dependencies: z
              .array(
                z.object({
                  slug: z.string().min(1),
                  kind: z
                    .enum(["workspace", "capability", "automation"])
                    .default("workspace"),
                  relation: z.enum(["compose", "require"]).default("require"),
                  reason: z.string().optional(),
                })
              )
              .optional(),
            /**
             * Entity-detail action placements → merged into
             * `settings.actionPlacements` by the shared
             * `applyPackagePostWorkspace` door (Phase 4 GAP C). A plain
             * `z.object` would STRIP this even under `.passthrough()` typing, so
             * declare it to carry it typed through to the applier.
             */
            actionPlacements: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  surface: z.string(),
                  kind: z.enum(["capability", "playbook", "automation"]),
                  ref: z.string(),
                  label: z.string(),
                  when: z
                    .object({
                      requiredFacetSlugs: z
                        .array(z.string().min(1))
                        .min(1)
                        .optional(),
                      propertyEquals: z
                        .record(z.string(), z.unknown())
                        .optional(),
                      propertyAnyEquals: z
                        .record(z.string(), z.array(z.unknown()).min(1))
                        .optional(),
                      propertyNotEquals: z
                        .record(z.string(), z.unknown())
                        .optional(),
                    })
                    .optional(),
                  confirmation: z
                    .object({
                      title: z.string().min(1),
                      description: z.string().optional(),
                      confirmLabel: z.string().min(1).optional(),
                    })
                    .optional(),
                })
              )
              .optional(),
          })
          .passthrough(),
        packageSlug: z.string().optional(),
        packageVersion: z.string().optional(),
        /** ID of the template from the control plane registry (stored in workspace settings). */
        templateId: z.string().optional(),
        /** Human-readable name of the template (for workspace-init + settings). */
        templateName: z.string().optional(),
        workspaceName: z.string().optional(),
        workspaceType: z
          .enum(["personal", "agent", "project", "operational"])
          .optional(),
        linkedAgentId: z.string().optional(),
        /**
         * Optional: populate an existing workspace instead of creating a new one.
         * Used by the chat-first onboarding flow where a minimal workspace is
         * created first, then the AI proposes a definition to populate it.
         */
        workspaceId: z.string().uuid().optional(),
        /**
         * Optional: caller-supplied stable identifier for idempotent re-creates.
         * If a workspace with this proposalId already exists for the user, it
         * is returned untouched. Stamped into `settings.proposalId`.
         * Used by Eve (Builder Workspace = "builder-workspace-v1") and DevPlane.
         */
        proposalId: z.string().optional(),
        /**
         * Optional: app identifier stamped into `settings.appId`.
         * Enables filtering workspaces.list by app (e.g. "crm", "studio", "canvas").
         * Separates the app-ownership concern from the proposalId idempotency key.
         */
        appId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // CRM workspace creation is an explicit Pod-owner action. The frontend
      // also hides the action for members, but this server gate is the source
      // of truth and prevents direct API calls from bypassing that policy.
      if (input.appId === "crm" && !input.workspaceId) {
        const podAdminWorkspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.systemSlug, "pod-admin"),
          columns: { id: true },
        });
        const podAdminMembership = podAdminWorkspace
          ? await db.query.workspaceMembers.findFirst({
              where: and(
                eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
                eq(workspaceMembers.userId, ctx.userId),
                inArray(workspaceMembers.role, ["owner", "admin"])
              ),
              columns: { id: true },
            })
          : null;
        if (!podAdminMembership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only a Pod owner can create a CRM workspace.",
          });
        }
      }

      // Enforce tier access before creating. Self-hosted pods (no CP configured)
      // are always allowed. Throws FORBIDDEN if tier is insufficient.
      if (input.packageSlug) {
        await assertPackageTierAccess(ctx.userId, input.packageSlug);
      }

      // Additive template sync for an ALREADY-provisioned workspace. When a
      // caller re-runs createFromDefinition and hits the idempotent "already
      // exists" path, bring the live workspace up to the CURRENT template
      // NON-DESTRUCTIVELY: add missing profiles / property-defs / entityLinks
      // (e.g. an older CRM workspace gaining the `partner` profile + its links),
      // never delete or mutate existing data. This is the automatic re-apply
      // trigger — every consumer that provisions on launch/signup picks up
      // template drift for free. Best-effort: a reconcile failure must never
      // break the (successful) idempotent return, so it is caught + logged.
      //
      // VERSION-AWARE (W2b): the actual compare-and-reconcile lives in the ONE
      // shared `reconcileWorkspaceIfStale` (workspace-creation-service.ts) —
      // the SAME entry point the Hub-door idempotent-create path
      // (`createWorkspaceFromDefinitionIdempotent`) now also calls, so neither
      // door reimplements the hash compare. When it can't compare (no
      // `packageSlug`, or the resolved template carries no version signal —
      // e.g. bundle fallback), fall back to the prior unconditional behavior
      // (reconcile against the caller-supplied `input.definition`) — no
      // regression for that edge.
      const reconcileExisting = async (
        workspaceId: string,
        currentSettings: WorkspaceSettings | null
      ) => {
        // ── 1. Additive profiles / property-defs / views / entityLinks sync.
        const outcome = await reconcileWorkspaceIfStale({
          workspaceId,
          packageSlug: input.packageSlug,
          currentSettings,
          userId: ctx.userId,
        });
        let report: ReconcileReport | undefined;
        // Sync the post-workspace layers only when the template ACTUALLY drifted
        // (a fresh reconcile happened) or when we couldn't version-compare —
        // never on an in-sync no-op, so a reconnect re-trigger stays cheap.
        let syncLayers: boolean;
        if (outcome.checked) {
          report = outcome.report; // in sync (undefined) or freshly reconciled
          // Read the field that MEANS "a reconcile write happened" rather than
          // inferring it from the report's presence (equivalent today, but the
          // report is a payload, not the signal).
          syncLayers = outcome.reconciled;
        } else {
          try {
            report = await reconcileWorkspaceFromDefinition({
              workspaceId,
              userId: ctx.userId,
              definition:
                input.definition as unknown as WorkspaceDefinitionInput,
            });
          } catch (err) {
            logger.warn(
              { err, workspaceId },
              "createFromDefinition: additive template reconcile failed (non-fatal)"
            );
          }
          syncLayers = true;
        }
        // ── 2. Additive playbooks / capabilities / automations / actionPlacements
        // sync — the post-workspace layers reconcileWorkspaceFromDefinition does
        // NOT cover (it only touches profiles/views/entityLinks). The applier is
        // idempotent by (name, workspaceId), so a re-install ADDS playbooks the
        // template gained since first install (e.g. radars) WITHOUT duplicating
        // existing ones. Mirrors the compose-overlay branch; non-fatal.
        //
        // SOURCE MUST MATCH LAYER 1: when the version-aware path resolved a
        // fresh template server-side, build from THAT — not the caller's
        // `input.definition`, which may be a stale cached copy missing exactly
        // the playbook the new version added.
        //
        // ADAPT, DON'T CAST: the resolved value is a PackageDefinitionOutput,
        // whose wire shape differs from the WorkspaceDefinitionOutput this door
        // otherwise receives — graph automations are `automations` there but
        // `flowAutomations` here. Casting silently (a) dropped every
        // template-authored graph automation, and (b) fed flow-shaped rows into
        // the LOOP-trigger mapping, where `auto.trigger` is undefined → TypeError
        // → the whole layer-2 sync (playbooks + capabilities + placements) was
        // swallowed by the catch below. Map the fields explicitly instead.
        if (syncLayers) {
          try {
            const pkg = outcome.packageDefinition;
            const postWorkspaceSource: CreateDefinitionPostWorkspaceSlice = pkg
              ? {
                  playbooks:
                    pkg.playbooks as CreateDefinitionPostWorkspaceSlice["playbooks"],
                  capabilities:
                    pkg.capabilities as CreateDefinitionPostWorkspaceSlice["capabilities"],
                  actionPlacements:
                    pkg.actionPlacements as CreateDefinitionPostWorkspaceSlice["actionPlacements"],
                  // The rename the old cast erased.
                  flowAutomations:
                    pkg.automations as CreateDefinitionPostWorkspaceSlice["flowAutomations"],
                }
              : (input.definition as CreateDefinitionPostWorkspaceSlice);
            await applyPackagePostWorkspace({
              workspaceId,
              body: buildPostWorkspaceBodyFromDefinition(
                postWorkspaceSource,
                workspaceId
              ),
              userId: ctx.userId,
              agentUserId: (ctx as { agentUserId?: string }).agentUserId,
              scopes: [],
            });
          } catch (err) {
            logger.warn(
              { err, workspaceId },
              "createFromDefinition: post-workspace layer reconcile failed (non-fatal)"
            );
          }
        }
        return report;
      };

      // Serialise concurrent calls with the same (userId, proposalId) so a
      // hung retry can't race the original. No-op when proposalId is missing.
      return withWorkspaceProposalIdLock(
        ctx.userId,
        input.proposalId,
        async () => {
          // Idempotency by proposalId — caller-supplied stable key. If a workspace
          // with this proposalId already exists for the user → return it. Mirrors
          // the Hub REST path so DevPlane and Eve see the same row when they ask
          // for "builder-workspace-v1".
          if (input.proposalId) {
            const existingByProposal =
              await db.query.workspaceMembers.findFirst({
                where: and(
                  eq(workspaceMembers.userId, ctx.userId),
                  drizzleSql`EXISTS (
              SELECT 1 FROM workspaces w
              WHERE w.id = ${workspaceMembers.workspaceId}
                AND w.provisioning_proposal_id = ${input.proposalId}
            )`
                ),
                with: { workspace: true },
              });
            if (existingByProposal?.workspace) {
              const ws = existingByProposal.workspace;
              const wsSettings = ws.settings as WorkspaceSettings | null;
              const provStatus = wsSettings?.provisioningStatus;

              if (provStatus === "failed") {
                logger.warn(
                  {
                    userId: ctx.userId,
                    proposalId: input.proposalId,
                    workspaceId: ws.id,
                    failedStep: wsSettings?.failedStep,
                    completedSteps: wsSettings?.completedSteps,
                  },
                  "createFromDefinition: resuming failed workspace (by proposalId)"
                );
                emitChatEvent({
                  event: "workspace:creation_progress",
                  data: {
                    step: "resume",
                    pct: 5,
                    label: `Resuming from step '${wsSettings?.failedStep ?? "unknown"}'`,
                    status: "progress",
                  },
                  userId: ctx.userId,
                });
                const resumeResult = await createWorkspaceFromDefinition({
                  definition: input.definition,
                  userId: ctx.userId,
                  workspaceName: input.workspaceName,
                  createdBy: "user",
                  workspaceType: input.workspaceType,
                  linkedAgentId: input.linkedAgentId,
                  resumeFrom: {
                    workspaceId: ws.id,
                    completedSteps: wsSettings?.completedSteps ?? [],
                  },
                  onProgress: (step, pct, label) => {
                    emitChatEvent({
                      event: "workspace:creation_progress",
                      data: { step, pct, label, status: "progress" },
                      userId: ctx.userId,
                    });
                  },
                });
                return {
                  status: "created" as const,
                  outcome: "created" as const,
                  workspaceId: resumeResult.workspaceId,
                  profileIds: resumeResult.profileIds,
                  viewIds: resumeResult.viewIds,
                };
              }

              logger.info(
                {
                  userId: ctx.userId,
                  proposalId: input.proposalId,
                  workspaceId: ws.id,
                },
                "createFromDefinition: returning existing workspace by proposalId"
              );
              // Opportunistically stamp appId if the caller provides one and
              // the workspace doesn't have it yet (migration path for pre-Phase-1 workspaces).
              if (input.appId && !wsSettings?.appId) {
                try {
                  await db
                    .update(workspaces)
                    .set({
                      settings: {
                        ...(wsSettings ?? {}),
                        appId: input.appId,
                      } satisfies WorkspaceSettings,
                    })
                    .where(eq(workspaces.id, ws.id));
                } catch {
                  /* non-fatal */
                }
              }
              // Active workspace already exists → additively sync it to the
              // current template (add-only). Skipped for non-active (pending)
              // workspaces to avoid racing an in-flight provisioning build.
              const reconciled =
                provStatus === "active"
                  ? await reconcileExisting(ws.id, wsSettings)
                  : undefined;
              return {
                workspaceId: ws.id,
                entityIds: [],
                reconciled,
                // E4 fix: explicit discriminator alongside `reconciled` so a
                // caller doesn't have to infer "reused vs freshly reconciled"
                // from presence/absence of the report.
                outcome: reconciled
                  ? ("reconciled" as const)
                  : ("unchanged" as const),
              };
            }
          }

          // Idempotency: if the user already has a workspace with this packageSlug, return it.
          // "pending" workspaces (creation in progress) are returned as-is so the client can
          // subscribe to progress events. "failed" workspaces are returned with status "failed"
          // so the client can offer a retry button.
          // Prevents duplicate workspaces when the browser re-triggers onboarding on reconnect.
          if (input.packageSlug) {
            const existingMembership =
              await db.query.workspaceMembers.findFirst({
                where: and(
                  eq(workspaceMembers.userId, ctx.userId),
                  drizzleSql`EXISTS (
              SELECT 1 FROM workspaces w
              WHERE w.id = ${workspaceMembers.workspaceId}
                AND w.package_slug = ${input.packageSlug}
            )`
                ),
                with: { workspace: true },
              });
            if (existingMembership?.workspace) {
              const ws = existingMembership.workspace;
              const wsSettings = ws.settings as WorkspaceSettings | null;
              const provStatus = wsSettings?.provisioningStatus;

              if (provStatus === "failed") {
                // Automatically resume from where the previous attempt failed.
                logger.warn(
                  {
                    userId: ctx.userId,
                    packageSlug: input.packageSlug,
                    workspaceId: ws.id,
                    failedStep: wsSettings?.failedStep,
                    completedSteps: wsSettings?.completedSteps,
                  },
                  "createFromDefinition: resuming failed workspace"
                );
                emitChatEvent({
                  event: "workspace:creation_progress",
                  data: {
                    step: "resume",
                    pct: 5,
                    label: `Resuming from step '${wsSettings?.failedStep ?? "unknown"}'`,
                    status: "progress",
                  },
                  userId: ctx.userId,
                });
                // Fall through to createWorkspaceFromDefinition with resumeFrom set
                const resumeResult = await createWorkspaceFromDefinition({
                  definition: input.definition,
                  userId: ctx.userId,
                  packageSlug: input.packageSlug,
                  packageVersion: input.packageVersion,
                  templateId: input.templateId,
                  templateName: input.templateName,
                  workspaceName: input.workspaceName,
                  createdBy: "user",
                  workspaceType: input.workspaceType,
                  linkedAgentId: input.linkedAgentId,
                  resumeFrom: {
                    workspaceId: ws.id,
                    completedSteps: wsSettings?.completedSteps ?? [],
                  },
                  onProgress: (step, pct, label) => {
                    emitChatEvent({
                      event: "workspace:creation_progress",
                      data: { step, pct, label, status: "progress" },
                      userId: ctx.userId,
                    });
                  },
                });
                return {
                  status: "created" as const,
                  outcome: "created" as const,
                  workspaceId: resumeResult.workspaceId,
                  profileIds: resumeResult.profileIds,
                  viewIds: resumeResult.viewIds,
                };
              }

              logger.info(
                {
                  userId: ctx.userId,
                  packageSlug: input.packageSlug,
                  workspaceId: ws.id,
                  provisioningStatus: provStatus,
                },
                "createFromDefinition: returning existing workspace (idempotent)"
              );
              // Active workspace already exists → additively sync it to the
              // current template (add-only). Skipped for pending workspaces to
              // avoid racing an in-flight provisioning build.
              const reconciled =
                provStatus === "active"
                  ? await reconcileExisting(ws.id, wsSettings)
                  : undefined;
              return {
                status:
                  provStatus === "active"
                    ? ("created" as const)
                    : ("pending" as const),
                workspaceId: ws.id,
                reconciled,
                // E4 fix: `status:"created"` above is the pre-existing
                // (overloaded) field, kept for backward-compat. `outcome` is
                // the honest discriminator: this branch is ALWAYS an
                // idempotent re-hit of an already-existing workspace, never a
                // fresh materialization — "reconciled" when drift was synced,
                // "unchanged" when already current OR still pending (no
                // version check was run for a pending workspace).
                outcome: reconciled
                  ? ("reconciled" as const)
                  : ("unchanged" as const),
              };
            }
          }

          // ── Steps 0-0b: Resolve dependencies + compose overlay (shared core)
          // The SAME `materializeWorkspaceCore` the Hub `POST /packages/apply`
          // door drives — so the BROWSER install path composes overlays exactly
          // like the CLI/agent path. Placed AFTER both idempotency short-circuits
          // above (a proposalId/packageSlug re-install returns the existing
          // workspace WITHOUT re-resolving) and BEFORE resolveWorkspaceExtends +
          // the normal create below. `deferCreate:true` keeps THIS door's own
          // richer create path (onProgress/resumeFrom/seed-docs) for the
          // no-compose case — the shared core only resolves + (maybe) composes.
          // The compose reconcile intentionally receives the PRE-extends
          // `input.definition`, preserving the pre-refactor behavior (extends is
          // resolved only for the create path below).
          let resolvedDependencies: ResolvedPackageDependency[] = [];
          if (input.definition.dependencies?.length) {
            let core: MaterializeCoreResult;
            try {
              core = await materializeWorkspaceCore({
                definition:
                  input.definition as unknown as WorkspaceDefinitionInput,
                userId: ctx.userId,
                // The package's own identity for the cycle guard — NOT its
                // subtype (overlays set subtype = base slug). tRPC input carries
                // no `_meta`, so pass the packageSlug explicitly.
                selfSlug: input.packageSlug,
                deferCreate: true,
              });
            } catch (err) {
              // A compose was requested but its base could not be resolved. Do
              // NOT fall through to creating a rogue standalone overlay workspace
              // — surface the reason (mirrors the Hub 422).
              if (err instanceof ComposeBaseUnavailableError) {
                const unresolved = err.dependencies.find(
                  (d) => d.relation === "compose"
                );
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message:
                    unresolved?.message ??
                    "compose base not available — the base template must be installed on the pod first",
                });
              }
              // Resolver failures (cycle, >1 compose dep, wrong-kind) → clean 400.
              if (err instanceof DependencyResolutionError) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: `Dependency resolution failed: ${err.message}`,
                });
              }
              // Resolved compose base vanished before load → 404 (as before).
              if (err instanceof ComposeBaseNotFoundError) {
                throw new TRPCError({
                  code: "NOT_FOUND",
                  message: "compose base workspace not found",
                });
              }
              // A compose-overlay reconcile/assert failure → propagate (500),
              // matching the pre-refactor path (which let it throw).
              throw err;
            }
            if (core.status === "composed") {
              // A compose overlay does not create a second workspace, but it
              // still owns post-workspace layers such as playbooks. Apply them
              // to the resolved base before returning; the shared applier is
              // idempotent, so retries and already-installed overlays are safe.
              // Build the body via the SAME converter the normal-create branch
              // uses — the previous `as unknown as PackagePostWorkspaceBody` cast
              // fed loop-style `definition.automations` into the graph-automation
              // applier step, where each threw on an undefined `triggerType` and
              // was silently swallowed (install-path parity bug, Phase 4 4.T1).
              try {
                await applyPackagePostWorkspace({
                  workspaceId: core.composeTargetWorkspaceId,
                  body: buildPostWorkspaceBodyFromDefinition(
                    input.definition as CreateDefinitionPostWorkspaceSlice,
                    core.composeTargetWorkspaceId
                  ),
                  userId: ctx.userId,
                  agentUserId: (ctx as { agentUserId?: string }).agentUserId,
                  scopes: [],
                });
              } catch (err) {
                logger.warn(
                  {
                    err,
                    workspaceId: core.composeTargetWorkspaceId,
                    packageSlug: input.packageSlug,
                  },
                  "compose overlay post-workspace layers failed (non-fatal)"
                );
              }
              auditLog({
                subjectType: "workspaces",
                subjectId: core.composeTargetWorkspaceId,
                action: "update",
                phase: "completed",
                userId: ctx.userId,
                data: { templateSlug: input.packageSlug, composed: true },
              });
              return {
                status: "composed" as const,
                workspaceId: core.composeTargetWorkspaceId,
                composed: true as const,
                dependencies: core.dependencies,
              };
            }
            // status "resolved" — no compose base. Fall through to the normal
            // extends-resolve + create path below with the resolved graph.
            resolvedDependencies = core.dependencies;
          }

          // Workspace composition (north star §10): resolve `definition.extends`
          // into copied profiles/views BEFORE materialization. Cross-workspace
          // reads inside the resolver are access-gated (member / pod_visible /
          // pod_joinable / system) via validateWorkspaceAccess — a caller can
          // only import from a workspace they can see. Best-effort: unreadable
          // or missing sources are skipped, never fatal.
          const { definition: composedDefinition, provenance: composedFrom } =
            await resolveWorkspaceExtends(input.definition, ctx.userId);

          let result: Awaited<ReturnType<typeof createWorkspaceFromDefinition>>;
          try {
            result = await createWorkspaceFromDefinition({
              definition: composedDefinition,
              userId: ctx.userId,
              packageSlug: input.packageSlug,
              packageVersion: input.packageVersion,
              templateId: input.templateId,
              templateName: input.templateName,
              workspaceName: input.workspaceName,
              createdBy: "user",
              workspaceType: input.workspaceType,
              linkedAgentId: input.linkedAgentId,
              // When workspaceId is provided, populate the existing workspace
              // instead of creating a new one (chat-first onboarding flow).
              // "workspace" is in completedSteps to skip the CREATE step.
              ...(input.workspaceId
                ? {
                    resumeFrom: {
                      workspaceId: input.workspaceId,
                      completedSteps: ["workspace"],
                    },
                  }
                : {}),
              onProgress: (step, pct, label) => {
                emitChatEvent({
                  event: "workspace:creation_progress",
                  data: { step, pct, label, status: "progress" },
                  userId: ctx.userId,
                });
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Extract step name from structured error message ("...at step 'X': ...")
            const stepMatch = message.match(/at step '([^']+)'/);
            const failedStep = stepMatch?.[1];
            logger.error(
              {
                err,
                userId: ctx.userId,
                packageSlug: input.packageSlug,
                failedStep,
              },
              "createFromDefinition failed"
            );
            // Emit error progress event so the frontend loading state can show
            // what went wrong instead of spinning indefinitely.
            emitChatEvent({
              event: "workspace:creation_progress",
              data: {
                step: failedStep ?? "error",
                pct: 0,
                label: failedStep
                  ? `Failed at step '${failedStep}': ${message}`
                  : `Creation failed: ${message}`,
                status: "error",
              },
              userId: ctx.userId,
            });
            // Stamp proposalId onto the failed workspace so the next retry can
            // find it via the idempotency check and resume rather than creating
            // a new workspace. Best-effort — a lookup failure here is non-fatal.
            if (input.proposalId) {
              try {
                const failedWs = await db.query.workspaceMembers.findFirst({
                  where: and(
                    eq(workspaceMembers.userId, ctx.userId),
                    drizzleSql`EXISTS (
                      SELECT 1 FROM workspaces w
                      WHERE w.id = ${workspaceMembers.workspaceId}
                        AND w.name = ${input.workspaceName ?? ""}
                        AND w.provisioning_status = 'failed'
                        AND (w.provisioning_proposal_id IS NULL OR w.provisioning_proposal_id = '')
                    )`
                  ),
                  with: { workspace: true },
                });
                if (failedWs?.workspace) {
                  const existingSettings = (failedWs.workspace.settings ??
                    {}) as WorkspaceSettings;
                  await db
                    .update(workspaces)
                    .set({
                      settings: {
                        ...existingSettings,
                        proposalId: input.proposalId,
                        ...(input.appId ? { appId: input.appId } : {}),
                      } satisfies WorkspaceSettings,
                      provisioningProposalId: input.proposalId,
                    })
                    .where(eq(workspaces.id, failedWs.workspace.id));
                }
              } catch {
                // non-fatal
              }
            }

            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: failedStep
                ? `Workspace creation failed at step '${failedStep}': ${message}`
                : `Workspace creation failed: ${message}`,
            });
          }

          // Stamp caller-supplied proposalId/appId + composition provenance into
          // settings. Best-effort: a failure here just means the next call may
          // create a duplicate (proposalId), the workspace won't appear in
          // app-filtered list queries (appId), or imported bricks won't carry a
          // "from <source>" tag (composedFrom).
          if (input.proposalId || input.appId || composedFrom.length > 0) {
            try {
              const ws = await db.query.workspaces.findFirst({
                where: eq(workspaces.id, result.workspaceId),
                columns: { settings: true },
              });
              const existingSettings = (ws?.settings ??
                {}) as WorkspaceSettings;
              await db
                .update(workspaces)
                .set({
                  settings: {
                    ...existingSettings,
                    ...(input.proposalId
                      ? { proposalId: input.proposalId }
                      : {}),
                    ...(input.appId ? { appId: input.appId } : {}),
                    ...(composedFrom.length > 0 ? { composedFrom } : {}),
                  } satisfies WorkspaceSettings,
                  ...(input.proposalId
                    ? { provisioningProposalId: input.proposalId }
                    : {}),
                })
                .where(eq(workspaces.id, result.workspaceId));
            } catch (err) {
              logger.warn(
                {
                  err,
                  workspaceId: result.workspaceId,
                  proposalId: input.proposalId,
                  appId: input.appId,
                },
                "Failed to stamp proposalId/appId/composedFrom into workspace settings (non-fatal)"
              );
            }
          }

          // Seed entity bodies through the canonical body door (EntityBodyService).
          const entitiesWithContent = (input.definition.suggestedEntities ?? [])
            .map((entity, idx) => ({ entity, entityId: result.entityIds[idx] }))
            .filter(
              (e): e is typeof e & { entity: { content: string } } =>
                !!e.entity.content && !!e.entityId
            );

          if (entitiesWithContent.length > 0) {
            const database = await getDb();
            // Shared singleton, not a fresh hookless instance — see note above.
            const evRepo = eventRepository;
            const entityBodyService = new EntityBodyService(database, evRepo);
            const entRepo = new EntityRepository(database, evRepo);

            for (const { entity, entityId } of entitiesWithContent) {
              try {
                // B4 FIX: this loop used to materialize EVERY seed body into a
                // document unconditionally (and never wrote a v1 snapshot). It
                // now runs the SAME heuristic as every other writer — long-form
                // → a versioned document (with a real v1 snapshot), short →
                // inline properties.content. Provisioning write → `system`
                // provenance.
                const body = await entityBodyService.setBody({
                  entityId,
                  userId: ctx.userId,
                  workspaceId: result.workspaceId,
                  title: entity.title,
                  provenance: {
                    createdByKind: "system",
                    createdByUserId: ctx.userId,
                  },
                  text: entity.content,
                });
                if (body.documentId) {
                  // Link entity → document (single direction — no backlink needed)
                  await entRepo.update(
                    entityId,
                    { documentId: body.documentId },
                    ctx.userId
                  );
                } else if (body.inlineContent !== undefined) {
                  // Short seed body stays inline (merged into properties).
                  await entRepo.update(
                    entityId,
                    { properties: { content: body.inlineContent } },
                    ctx.userId
                  );
                }
              } catch (err) {
                logger.warn(
                  { err, entityId, title: entity.title },
                  "Failed to seed body for entity (non-fatal)"
                );
              }
            }
          }

          // ── Post-workspace layers (capabilities + the autonomy loop) ────────────
          // ONE shared door with Hub `POST /packages/apply` — `applyPackagePostWorkspace`.
          // The `{playbooks · automations}` sub-contract IS an autonomy loop, so it is
          // passed as ONE `loops[]` entry (the shared door runs the SAME governed
          // `createLoopFromDefinition` primitive) — preserving the playbook-trigger
          // semantics — while `capabilities` (→ tools + skills + vault + capability-
          // embedded automations/playbooks) install alongside. Before this the tRPC/
          // browser door installed NO capabilities and hand-rolled the loop inline; now
          // both doors converge on the one door. `definition.tools` is intentionally
          // dropped: tools arrive through capabilities (the governed substrate) — the old
          // inline `tools` TODO is retired here.
          // The `{playbooks · automations}` sub-contract is built into the shared
          // body by `buildPostWorkspaceBodyFromDefinition` — the ONE builder the
          // compose-overlay branch uses too, so loop-style automations can never
          // be misrouted into the graph-automation applier step.
          const postBody = buildPostWorkspaceBodyFromDefinition(
            input.definition as CreateDefinitionPostWorkspaceSlice,
            result.workspaceId
          );
          const hasPostWork = Boolean(
            postBody.capabilities?.length ||
            postBody.loops?.length ||
            postBody.automations?.length ||
            postBody.actionPlacements?.length
          );
          if (hasPostWork) {
            try {
              const post = await applyPackagePostWorkspace({
                workspaceId: result.workspaceId,
                body: postBody,
                userId: ctx.userId,
                agentUserId: (ctx as { agentUserId?: string }).agentUserId,
                scopes: [],
              });
              logger.info(
                { workspaceId: result.workspaceId, layers: Object.keys(post) },
                "createFromDefinition: post-workspace layers applied (shared door)"
              );
            } catch (err) {
              logger.error(
                { err, workspaceId: result.workspaceId },
                "Failed to apply declared post-workspace layers"
              );
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message:
                  "Workspace was created but its declared workflow setup could not be completed. Reconcile it before use.",
              });
            }
          }

          // Enqueue workspace-init for default whiteboard/commands
          // (skips default views when packageSlug is set)
          try {
            const boss = getBoss();
            await boss.send("workspace-init", {
              workspaceId: result.workspaceId,
              userId: ctx.userId,
              packageSlug: input.packageSlug,
            });
          } catch (err) {
            logger.warn(
              { err, workspaceId: result.workspaceId },
              "Failed to enqueue workspace-init (non-fatal)"
            );
          }

          auditLog({
            subjectType: "workspaces",
            action: "create",
            phase: "completed",
            subjectId: result.workspaceId,
            userId: ctx.userId,
            data: {
              id: result.workspaceId,
              packageSlug: input.packageSlug,
              createdBy: "user",
            },
          });

          emitSideEffects({
            subjectType: "workspace",
            action: "create",
            subjectId: result.workspaceId,
            userId: ctx.userId,
          });

          return {
            status: "created" as const,
            outcome: "created" as const,
            workspaceId: result.workspaceId,
            profileIds: result.profileIds,
            viewIds: result.viewIds,
            entityIds: result.entityIds,
            // Surface any resolved `require`/non-workspace deps so the browser
            // post-install confirmation can show what was installed alongside.
            dependencies: resolvedDependencies,
          };
        }
      ); // close withWorkspaceProposalIdLock
    }),

  /**
   * Reconcile an EXISTING workspace's definition to a template — non-destructively.
   * Counterpart to createFromDefinition: adds missing profiles, property-defs
   * (as overlays for reused pod-wide profiles), and views (find-or-create);
   * merges capabilities/subtype. NEVER deletes or mutates a property-def type
   * (type conflicts are reported, not changed). `dryRun` previews the diff.
   * Owner/admin only. The caller resolves the template → definition (e.g.
   * toWorkspaceDefinition('crm')) and passes it, mirroring createFromDefinition.
   */
  reconcileFromDefinition: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        dryRun: z.boolean().optional(),
        definition: z.object({
          workspaceSubtype: z.string().optional(),
          workspaceVisibility: z.string().optional(),
          workspaceCapabilities: z.array(z.string()).optional(),
          profiles: z
            .array(
              z.object({
                slug: z.string(),
                displayName: z.string(),
                icon: z.string().optional(),
                color: z.string().optional(),
                description: z.string().optional(),
                scope: z.string().optional(),
                entityScope: z.enum(["pod", "workspace"]).optional(),
                semanticSlug: z.string().nullable().optional(),
                // Preserve generic kind/role metadata for reconciled
                // definitions. The materializer validates the combination.
                profileKind: z.enum(["kind", "role"]).optional(),
                applicableKinds: z.array(z.string()).optional(),
                properties: z
                  .array(
                    z.object({
                      slug: z.string(),
                      label: z.string().optional(),
                      valueType: z.string(),
                      inputType: z.string().optional(),
                      placeholder: z.string().optional(),
                      enumValues: z.array(z.string()).optional(),
                      constraints: z.record(z.string(), z.unknown()).optional(),
                      targetProfileSlug: z.string().optional(),
                    })
                  )
                  .optional(),
                uiHints: z
                  .object({
                    icon: z.string().optional(),
                    color: z.string().optional(),
                    description: z.string().optional(),
                  })
                  .optional(),
                propertyDefs: z
                  .array(
                    z.object({
                      slug: z.string(),
                      valueType: z.string(),
                      constraints: z
                        .object({ enum: z.array(z.string()).optional() })
                        .passthrough()
                        .optional(),
                      uiHints: z
                        .object({
                          label: z.string().optional(),
                          inputType: z.string().optional(),
                          placeholder: z.string().optional(),
                        })
                        .optional(),
                    })
                  )
                  .optional(),
              })
            )
            .optional(),
          views: z
            .array(
              z.object({
                name: z.string().optional(),
                displayName: z.string().optional(),
                slug: z.string().optional(),
                type: z.string(),
                scopeProfileSlug: z.string().optional(),
                scopeProfileSlugs: z.array(z.string()).optional(),
                config: z.record(z.string(), z.unknown()).optional(),
                groupBy: z.string().optional(),
                sortBy: z.string().optional(),
                sortOrder: z.enum(["asc", "desc"]).optional(),
                filterBy: z.record(z.string(), z.unknown()).optional(),
                description: z.string().optional(),
                defaultView: z.boolean().optional(),
                colorBy: z.string().optional(),
              })
            )
            .optional(),
          entityLinks: z
            .array(
              z.object({
                sourceProfileSlug: z.string(),
                targetProfileSlug: z.string(),
                type: z.string(),
                label: z.string().optional(),
              })
            )
            .optional(),
          /** Post-workspace layers are reconciled through the same generic door. */
          capabilities: z.array(z.record(z.string(), z.unknown())).optional(),
          playbooks: z.array(z.record(z.string(), z.unknown())).optional(),
          /** Graph-flow templates, routed to the shared post-workspace applier. */
          flowAutomations: z
            .array(
              z.object({
                key: z.string().min(1).optional(),
                name: z.string().min(1),
                description: z.string().optional(),
                triggerType: z.enum(["event", "cron", "webhook", "manual"]),
                triggerConfig: z.record(z.string(), z.unknown()).optional(),
                flowDefinition: z
                  .object({
                    nodes: z.array(z.unknown()),
                    edges: z.array(z.unknown()),
                    precondition: z.string().optional(),
                  })
                  .optional(),
                status: z.enum(["draft", "active", "paused"]).optional(),
              })
            )
            .optional(),
          /**
           * Entity-detail action placements → re-asserted into
           * `settings.actionPlacements` via the shared
           * `buildPostWorkspaceBodyFromDefinition` builder (which reads
           * `definition.actionPlacements`). Without this zod field the placements
           * are STRIPPED before the builder sees them, so a reconcile could never
           * re-assert them. Mirrors the createFromDefinition shape (line 2904).
           */
          actionPlacements: z
            .array(
              z.object({
                profileSlug: z.string(),
                surface: z.string(),
                kind: z.enum(["capability", "playbook", "automation"]),
                ref: z.string(),
                label: z.string(),
                when: z
                  .object({
                    requiredFacetSlugs: z
                      .array(z.string().min(1))
                      .min(1)
                      .optional(),
                    propertyEquals: z
                      .record(z.string(), z.unknown())
                      .optional(),
                    propertyAnyEquals: z
                      .record(z.string(), z.array(z.unknown()).min(1))
                      .optional(),
                    propertyNotEquals: z
                      .record(z.string(), z.unknown())
                      .optional(),
                  })
                  .optional(),
                confirmation: z
                  .object({
                    title: z.string().min(1),
                    description: z.string().optional(),
                    confirmLabel: z.string().min(1).optional(),
                  })
                  .optional(),
              })
            )
            .optional(),
        }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Owner/admin only — this is a structural workspace change, not a data
      // mutation, so it runs directly (never proposed). Reuse the same RBAC gate
      // as workspaces.update; if it would only be granted via a proposal, the
      // caller isn't an owner/admin → reject.
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
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Reconciling a workspace definition requires owner/admin access.",
        });
      }

      const report = await reconcileWorkspaceFromDefinition({
        workspaceId: input.workspaceId,
        userId: ctx.userId,
        definition: input.definition as unknown as WorkspaceDefinitionInput,
        dryRun: input.dryRun,
      });
      if (
        !input.dryRun &&
        (input.definition.capabilities?.length ||
          input.definition.playbooks?.length ||
          input.definition.flowAutomations?.length ||
          input.definition.actionPlacements?.length)
      ) {
        try {
          // Same builder as the create/compose branches — reconcile definitions
          // carry LOOP-style playbooks (grants as {kind, ref}[]), so the raw
          // cast fed them into the graph-shaped applier where grants silently
          // resolved to nothing. One builder = install and reconcile stay in
          // lockstep (same loop routing, same grant materialization).
          await applyPackagePostWorkspace({
            workspaceId: input.workspaceId,
            body: buildPostWorkspaceBodyFromDefinition(
              input.definition as unknown as CreateDefinitionPostWorkspaceSlice,
              input.workspaceId
            ),
            userId: ctx.userId,
            agentUserId: (ctx as { agentUserId?: string }).agentUserId,
            scopes: [],
          });
        } catch (err) {
          logger.error(
            { err, workspaceId: input.workspaceId },
            "reconcileFromDefinition post-workspace layers failed"
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Workflow reconciliation did not complete. Earlier additive layers may have applied; after resolving the error, retry safely to finish the idempotent reconciliation.",
          });
        }
      }
      return report;
    }),

  /**
   * Seed a plugin workspace (provisioning-level auth via token header)
   *
   * Called by the control plane during pod provisioning to auto-create
   * a workspace for an enabled plugin (e.g., agent-os).
   */
  seedPlugin: publicProcedure
    .input(
      z.object({
        pluginId: z.string(),
        definition: z.unknown().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Authenticate via provisioning token
      const providedToken = ctx.req?.headers.get("X-Provisioning-Token");
      const expectedToken = process.env.PROVISIONING_TOKEN;

      if (!expectedToken || !providedToken || providedToken !== expectedToken) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Valid provisioning token required",
        });
      }

      const systemUserId = "00000000-0000-0000-0000-000000000000";

      // Idempotency: if a provisioned workspace with this pluginId already exists, return it.
      // Prevents duplicate workspaces when provisioning retries or the CP re-calls seedPlugin.
      const existingPluginWorkspace = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.packageSlug, input.pluginId),
            drizzleSql`${workspaces.settings}->>'createdBy' = 'provisioning'`
          )
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existingPluginWorkspace) {
        logger.info(
          { workspaceId: existingPluginWorkspace.id, pluginId: input.pluginId },
          "seedPlugin: returning existing provisioned workspace (idempotent)"
        );
        return {
          status: "existing" as const,
          workspaceId: existingPluginWorkspace.id,
        };
      }

      // Generic path: use definition from control plane registry
      if (input.definition) {
        const definition = input.definition as WorkspaceDefinitionInput;

        // Resolve template-composition dependencies + compose overlays through
        // the SAME shared core the in-app `createFromDefinition` door drives, so
        // a COMPOSED template (`dependencies[]` — e.g. openclaw's "the Arch"
        // enterprise overlays) provisioned via this M2M door resolves its deps
        // instead of materializing a rogue standalone. `deferCreate:true` keeps
        // THIS door's own create + workspace-init enqueue for the no-compose
        // case (the shared core never enqueues under `deferCreate`, so there is
        // NO double-enqueue). Only runs when deps are declared — a plain plugin
        // template skips it and behaves byte-for-byte as before.
        if ((definition as { dependencies?: unknown[] }).dependencies?.length) {
          let core: MaterializeCoreResult;
          try {
            core = await materializeWorkspaceCore({
              definition,
              userId: systemUserId,
              // The package's own identity for the cycle guard.
              selfSlug: input.pluginId,
              deferCreate: true,
            });
          } catch (err) {
            // A compose was requested but its base could not be resolved — do
            // NOT fall through to creating a rogue standalone overlay.
            if (err instanceof ComposeBaseUnavailableError) {
              const unresolved = err.dependencies.find(
                (d) => d.relation === "compose"
              );
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  unresolved?.message ??
                  "compose base not available — the base template must be installed on the pod first",
              });
            }
            if (err instanceof DependencyResolutionError) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Dependency resolution failed: ${err.message}`,
              });
            }
            if (err instanceof ComposeBaseNotFoundError) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "compose base workspace not found",
              });
            }
            throw err;
          }
          if (core.status === "composed") {
            // A compose overlay layered onto its existing base — no new
            // workspace, so no workspace-init enqueue (the base already has its
            // defaults). Return the base's id.
            logger.info(
              {
                workspaceId: core.composeTargetWorkspaceId,
                pluginId: input.pluginId,
              },
              "Plugin workspace composed onto base (provisioning)"
            );
            return {
              status: "created" as const,
              workspaceId: core.composeTargetWorkspaceId,
            };
          }
          // status "resolved" — deps installed, no compose base. Fall through to
          // this door's own create + enqueue below.
        }

        const result = await createWorkspaceFromDefinition({
          definition,
          userId: systemUserId,
          packageSlug: input.pluginId,
          createdBy: "provisioning",
        });

        // Enqueue workspace-init (whiteboard + commands, skips default views)
        try {
          const boss = getBoss();
          await boss.send("workspace-init", {
            workspaceId: result.workspaceId,
            userId: systemUserId,
            packageSlug: input.pluginId,
          });
        } catch (err) {
          logger.warn(
            { err, workspaceId: result.workspaceId },
            "Failed to enqueue workspace-init (non-fatal)"
          );
        }

        logger.info(
          { workspaceId: result.workspaceId, pluginId: input.pluginId },
          "Plugin workspace seeded via definition"
        );

        return {
          status: "created" as const,
          workspaceId: result.workspaceId,
        };
      }

      // Legacy fallback: hardcoded zeroclaw config (backward compat)
      if (input.pluginId !== "zeroclaw") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown plugin: ${input.pluginId}. Pass a definition for generic plugins.`,
        });
      }

      const { randomUUID } = await import("crypto");
      const workspaceId = randomUUID();

      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.create(
        {
          id: workspaceId,
          name: "Agent OS",
          ownerId: systemUserId,
          settings: {
            layout: {
              pinnedApps: ["home", "data", "views", "intelligence"],
              defaultView: "home",
            },
            createdBy: "provisioning",
            provisionedAt: new Date().toISOString(),
            provisioningStatus: "active",
            packageSlug: "zeroclaw",
          },
        },
        systemUserId
      );

      logger.info(
        { workspaceId, pluginId: input.pluginId },
        "Plugin workspace seeded (legacy)"
      );

      return {
        status: "created" as const,
        workspaceId,
      };
    }),

  /**
   * Preview invite details (public — no auth required).
   * Returns type so the landing page can adapt its UI.
   */
  previewInvite: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
        with: { workspace: { columns: { name: true } } },
      });
      if (!invite) return null;
      if (invite.expiresAt < new Date()) return { expired: true as const };

      const inviter = await db.query.users.findFirst({
        where: eq(users.id, invite.invitedBy),
        columns: { name: true, email: true },
      });
      const inviterName = inviter?.name ?? inviter?.email ?? "A Synap user";

      // The token already grants the holder permission to consume this
      // invite, so echoing the canonical email back is not a leak — the
      // invitee needs it to lock the signup form to the right address.
      // Anyone with the token can already see workspace name + role.
      if (invite.type === "workspace") {
        return {
          expired: false as const,
          type: "workspace" as const,
          workspaceName: invite.workspace?.name ?? "Unknown Workspace",
          inviterName,
          role: invite.role,
          email: invite.email,
          expiresAt: invite.expiresAt,
        };
      } else {
        return {
          expired: false as const,
          type: "pod" as const,
          inviterName,
          role: invite.role,
          email: invite.email,
          expiresAt: invite.expiresAt,
        };
      }
    }),

  /**
   * Accept an invite via the CP API proxy (no Kratos session needed).
   * The CP signs a short-lived JWT containing the invitee's email.
   * The pod looks up the local user by email and accepts on their behalf.
   * Works for both workspace and pod invites.
   */
  acceptInviteViaCp: publicProcedure
    .input(z.object({ token: z.string(), cpToken: z.string() }))
    .mutation(async ({ input }) => {
      const cpUrl = config.server.controlPlaneUrl;
      const payload = await verifyCpJwt<{
        sub: string;
        email: string;
        type: string;
      }>(input.cpToken, cpUrl);
      if (!payload || payload.type !== "invite-accept") {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid CP token",
        });
      }

      const podUser = await db.query.users.findFirst({
        where: eq(users.email, payload.email),
      });
      if (!podUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No pod account found for this email. Please sign in to this pod first.",
        });
      }

      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
      });
      if (!invite)
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      if (invite.expiresAt < new Date())
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invite expired" });
      if (
        invite.email &&
        payload.email &&
        invite.email.toLowerCase() !== payload.email.toLowerCase()
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invite email does not match CP principal",
        });
      }

      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);

      if (invite.type === "workspace") {
        if (!invite.workspaceId)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const member = await memberRepo.add(
          {
            workspaceId: invite.workspaceId,
            userId: podUser.id,
            role: invite.role as "owner" | "editor" | "viewer",
            inviteId: invite.id,
          },
          podUser.id
        );
        // Team roster → person bridge (best-effort; never blocks membership)
        void ensureTeamPersonForMember(dbConn, {
          memberUserId: podUser.id,
          workspaceId: invite.workspaceId,
          ownerUserId: invite.invitedBy ?? podUser.id,
        }).catch((err) => {
          logger.warn(
            {
              err,
              memberUserId: podUser.id,
              workspaceId: invite.workspaceId,
            },
            "Failed to ensure team person for member on CP invite accept"
          );
        });
        auditLog({
          subjectType: "workspaceMember",
          action: "add",
          phase: "completed",
          subjectId: member.id,
          userId: podUser.id,
          workspaceId: invite.workspaceId,
          data: { source: "cp-proxy", email: payload.email },
        });
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: payload.email,
          actorUserId: podUser.id,
        });
        return {
          status: "accepted" as const,
          type: "workspace" as const,
          workspaceId: invite.workspaceId,
        };
      } else {
        // Pod invite via CP proxy. ADDITIVE (Membership → Visibility, Wave 1):
        // record durable pod-membership identity. The workspace fan-out below is
        // KEPT — removing it now would regress visibility before Wave 2's floor
        // consults pod_members. onConflictDoNothing: one row per user_id.
        await db
          .insert(podMembers)
          .values({
            userId: podUser.id,
            podRole: "member",
            invitedBy: invite.invitedBy ?? null,
          })
          .onConflictDoNothing();
        const allWorkspaces = await db.query.workspaces.findMany();
        for (const ws of allWorkspaces) {
          const alreadyMember = await db.query.workspaceMembers.findFirst({
            where: and(
              eq(workspaceMembers.workspaceId, ws.id),
              eq(workspaceMembers.userId, podUser.id)
            ),
          });
          if (alreadyMember) continue;
          await memberRepo.add(
            {
              workspaceId: ws.id,
              userId: podUser.id,
              role: invite.role as "owner" | "editor" | "viewer",
            },
            podUser.id
          );
          // Team roster → person bridge (best-effort; never blocks membership)
          void ensureTeamPersonForMember(dbConn, {
            memberUserId: podUser.id,
            workspaceId: ws.id,
            ownerUserId: invite.invitedBy ?? podUser.id,
          }).catch((err) => {
            logger.warn(
              { err, memberUserId: podUser.id, workspaceId: ws.id },
              "Failed to ensure team person for member on CP pod invite accept"
            );
          });
        }
        await db.delete(invites).where(eq(invites.id, invite.id));
        void notifyCpInviteLifecycle({
          inviteToken: invite.token,
          event: "accepted",
          actorEmail: payload.email,
          actorUserId: podUser.id,
        });
        return {
          status: "accepted" as const,
          type: "pod" as const,
          workspacesJoined: allWorkspaces.length,
        };
      }
    }),

  /**
   * Reject invite via CP proxy token when no pod session exists in browser context.
   */
  rejectInviteViaCp: publicProcedure
    .input(
      z.object({
        token: z.string(),
        cpToken: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const cpUrl = config.server.controlPlaneUrl;
      const payload = await verifyCpJwt<{
        sub: string;
        email: string;
        type: string;
      }>(input.cpToken, cpUrl);
      if (!payload || payload.type !== "invite-accept") {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid CP token",
        });
      }

      const invite = await db.query.invites.findFirst({
        where: eq(invites.token, input.token),
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }
      if (invite.email.toLowerCase() !== payload.email.toLowerCase()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invite is not addressed to CP principal email",
        });
      }

      await db.delete(invites).where(eq(invites.id, invite.id));
      void notifyCpInviteLifecycle({
        inviteToken: invite.token,
        event: "rejected",
        actorEmail: payload.email,
        actorUserId: payload.sub,
        reason: input.reason,
      });
      return { success: true };
    }),

  /**
   * Reject an invite addressed to the current user (recipient decline).
   */
  rejectInvite: protectedProcedure
    .input(z.object({ id: z.string().uuid(), reason: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const me = await db.query.users.findFirst({
        where: eq(users.id, ctx.userId),
        columns: { email: true },
      });
      if (!me?.email) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No email found for current user",
        });
      }
      const invite = await db.query.invites.findFirst({
        where: eq(invites.id, input.id),
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
      }
      if (invite.email.toLowerCase() !== me.email.toLowerCase()) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invite is not addressed to current user",
        });
      }
      await db.delete(invites).where(eq(invites.id, input.id));
      void notifyCpInviteLifecycle({
        inviteToken: invite.token,
        event: "rejected",
        actorEmail: me.email,
        actorUserId: ctx.userId,
        reason: input.reason,
      });
      auditLog({
        subjectType: "invite",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: invite.workspaceId ?? undefined,
        data: {
          type: invite.type,
          reason: input.reason ?? null,
          disposition: "rejected_by_recipient",
        },
      });
      return { success: true };
    }),

  /**
   * Get workspace-level MCP server configurations.
   * These are user-added MCP servers applied to all AI requests in this workspace.
   */
  getMcpServers: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input, ctx }) => {
      // Verify member access
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
        columns: { settings: true },
      });
      return ((ws?.settings as WorkspaceSettings)?.mcpServers ??
        []) as McpServerConfig[];
    }),

  /**
   * Update workspace-level MCP server configurations.
   * Replaces the entire mcpServers array. Requires editor+ role.
   */
  updateMcpServers: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        servers: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            transport: z.enum(["stdio", "http"]),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            url: z.string().url().optional(),
            env: z.record(z.string(), z.string()).optional(),
            enabled: z.boolean().optional().default(true),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Require editor+ role
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });
      if (!["editor", "admin", "owner"].includes(member.role ?? "")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Editor role required to manage MCP servers",
        });
      }

      // Merge mcpServers into JSONB settings (preserves other settings fields)
      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`settings || ${JSON.stringify({ mcpServers: input.servers })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, input.workspaceId));

      return { count: input.servers.length };
    }),

  /**
   * Apply a comprehensive workspace definition in a single call.
   *
   * Orchestrates:
   * 1. Profiles + views via createWorkspaceFromDefinition
   * 2. Relation definitions (auto-created from relation defs in definition)
   * 3. Entities (batch create with auto-profile creation)
   * 4. Relations (batch create with auto-relationDef creation)
   *
   * Supports two modes:
   * - "create": creates a new workspace (delegates to createFromDefinition)
   * - "update": populates/updates an existing workspace (skips workspace/profiles/views creation)
   *
   * Idempotent: entities and relations are upserted by their natural keys.
   */
  applyDefinition: protectedProcedure
    .input(
      z.object({
        /** Reuse the full WorkspaceDefinitionInput schema */
        definition: z
          .object({
            workspaceName: z.string().optional(),
            description: z.string().optional(),
            profiles: z
              .array(
                z.object({
                  slug: z.string(),
                  displayName: z.string(),
                  icon: z.string().optional(),
                  color: z.string().optional(),
                  description: z.string().optional(),
                  scope: z.string().optional(),
                  properties: z
                    .array(
                      z.object({
                        slug: z.string(),
                        label: z.string().optional(),
                        valueType: z.string(),
                        inputType: z.string().optional(),
                        placeholder: z.string().optional(),
                        enumValues: z.array(z.string()).optional(),
                        constraints: z
                          .record(z.string(), z.unknown())
                          .optional(),
                        targetProfileSlug: z.string().optional(),
                      })
                    )
                    .optional(),
                  uiHints: z
                    .object({
                      icon: z.string().optional(),
                      color: z.string().optional(),
                      description: z.string().optional(),
                    })
                    .optional(),
                  propertyDefs: z
                    .array(
                      z.object({
                        slug: z.string(),
                        valueType: z.string(),
                        required: z.boolean().optional(),
                        constraints: z
                          .object({ enum: z.array(z.string()).optional() })
                          .passthrough()
                          .optional(),
                        uiHints: z
                          .object({
                            label: z.string().optional(),
                            inputType: z.string().optional(),
                            placeholder: z.string().optional(),
                          })
                          .optional(),
                      })
                    )
                    .optional(),
                })
              )
              .optional(),
            views: z.array(z.record(z.string(), z.unknown())).optional(),
            bentoLayout: z.array(z.record(z.string(), z.unknown())).optional(),
            bentoViewBlocks: z
              .array(z.record(z.string(), z.unknown()))
              .optional(),
            bentoViewName: z.string().optional(),
            suggestedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                  refKey: z.string().optional(), // stable reference for relations
                })
              )
              .optional(),
            seedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                  refKey: z.string().optional(),
                })
              )
              .optional(),
            suggestedRelations: z
              .array(
                z.object({
                  sourceRef: z.string(), // refKey or "profileSlug:title"
                  targetRef: z.string(),
                  type: z.string(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            /** Additional relation definitions to ensure exist */
            relationDefs: z
              .array(
                z.object({
                  slug: z.string(),
                  displayName: z.string(),
                  description: z.string().optional(),
                  isDirectional: z.boolean().optional(),
                  uiHints: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            entityLinks: z.array(z.record(z.string(), z.unknown())).optional(),
            displayTemplates: z
              .array(z.record(z.string(), z.unknown()))
              .optional(),
            layoutConfig: z
              .object({
                primarySurface: workspacePrimarySurfaceSchema.nullish(),
              })
              .catchall(z.unknown())
              .optional(),
            profileEntityBentoTemplates: z
              .record(z.string(), z.unknown())
              .optional(),
          })
          .passthrough(),
        /** "create" = new workspace, "update" = populate existing workspace */
        mode: z.enum(["create", "update"]).default("update"),
        /** Required for "update" mode: which workspace to populate */
        workspaceId: z.string().uuid().optional(),
        /** Optional: stable idempotency key for "create" mode */
        proposalId: z.string().optional(),
        /** Optional: app identifier for workspace filtering */
        appId: z.string().optional(),
      })
    )
    .output(
      z.object({
        workspaceId: z.string(),
        profilesCreated: z.number(),
        entitiesCreated: z.number(),
        entitiesSkipped: z.number(),
        relationsCreated: z.number(),
        relationsSkipped: z.number(),
        relationDefsCreated: z.number(),
        entityIds: z.record(z.string(), z.string()),
        errors: z.array(
          z.object({
            stage: z.string(),
            refKey: z.string().optional(),
            error: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const errors: Array<{ stage: string; refKey?: string; error: string }> =
        [];

      // ── UPDATE mode: populate existing workspace ────────────────────────
      if (input.mode === "update") {
        if (!input.workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "workspaceId is required for update mode",
          });
        }

        // Verify membership
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });
        if (!membership) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }

        const database = await getDb();
        // Shared singleton — a fresh EventRepository has no registered hooks, so
        // its emitCompleted() append would silently never reach the
        // realtime/materialization/sync hooks.
        const eventRepo = eventRepository;

        // 1. Ensure relation definitions exist
        const relDefRepo = new RelationDefRepository(database);
        let relationDefsCreated = 0;
        const existingDefs = await relDefRepo.list(input.workspaceId);
        const existingDefSlugs = new Set(existingDefs.map((d) => d.slug));

        for (const rd of input.definition.relationDefs ?? []) {
          if (existingDefSlugs.has(rd.slug)) continue;
          try {
            await relDefRepo.create({
              slug: rd.slug,
              displayName: rd.displayName,
              description: rd.description,
              workspaceId: input.workspaceId,
              userId: ctx.userId,
              uiHints: rd.uiHints,
              isDirectional: rd.isDirectional ?? true,
            });
            existingDefSlugs.add(rd.slug);
            relationDefsCreated++;
          } catch (err) {
            errors.push({
              stage: "relationDefs",
              refKey: rd.slug,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 2. Batch create entities
        const { ProfileRepository } = await import("@synap/database");
        const profileRepo = new ProfileRepository(database);
        const profileCache = new Map<string, string>();

        // Pre-load existing profiles
        const existingProfiles = await profileRepo.getAccessibleProfiles(
          ctx.userId,
          input.workspaceId
        );
        for (const p of existingProfiles) {
          profileCache.set(p.slug, p.id);
        }

        // Auto-create missing profiles
        let profilesCreated = 0;
        const profileHintsMap = new Map<
          string,
          {
            displayName?: string;
            icon?: string;
            color?: string;
            description?: string;
          }
        >();
        const allEntities =
          input.definition.suggestedEntities ??
          input.definition.seedEntities ??
          [];
        for (const e of allEntities) {
          const profileDef = input.definition.profiles?.find(
            (p) => p.slug === e.profileSlug
          );
          if (profileDef && !profileHintsMap.has(e.profileSlug)) {
            profileHintsMap.set(e.profileSlug, {
              displayName:
                profileDef.displayName ??
                (profileDef.uiHints as any)?.displayName,
              icon: profileDef.icon ?? (profileDef.uiHints as any)?.icon,
              color: profileDef.color ?? (profileDef.uiHints as any)?.color,
              description:
                profileDef.description ??
                (profileDef.uiHints as any)?.description,
            });
          }
        }

        for (const e of allEntities) {
          if (profileCache.has(e.profileSlug)) continue;
          const hints = profileHintsMap.get(e.profileSlug) ?? {};
          try {
            const newProfile = await profileRepo.create({
              slug: e.profileSlug,
              displayName: hints.displayName ?? e.profileSlug,
              uiHints: {
                icon: hints.icon,
                color: hints.color,
                description: hints.description,
              },
              scope: "workspace" as any,
              workspaceId: input.workspaceId,
              userId: ctx.userId,
            });
            profileCache.set(e.profileSlug, newProfile.id);
            profilesCreated++;
          } catch (err) {
            errors.push({
              stage: "profiles",
              refKey: e.profileSlug,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Check existing entities for idempotency
        const existingEntities = await database.query.entities.findMany({
          where: and(
            eq(entities.userId, ctx.userId),
            eq(entities.workspaceId, input.workspaceId)
          ),
          columns: { id: true, type: true, title: true },
        });
        const existingEntityKeys = new Map<string, string>();
        for (const e of existingEntities) {
          existingEntityKeys.set(`${e.type}:${e.title}`, e.id);
        }

        // Create entities
        const entityIds: Record<string, string> = {};
        let entitiesCreated = 0;
        let entitiesSkipped = 0;
        const entityRepo = new EntityRepository(database, eventRepo);

        for (const e of allEntities) {
          const cacheKey = `${e.profileSlug}:${e.title}`;
          const refKey = e.refKey ?? cacheKey;

          if (existingEntityKeys.has(cacheKey)) {
            entityIds[refKey] = existingEntityKeys.get(cacheKey)!;
            entitiesSkipped++;
            continue;
          }

          const profileId = profileCache.get(e.profileSlug);
          if (!profileId) {
            errors.push({
              stage: "entities",
              refKey,
              error: `Profile ${e.profileSlug} not found`,
            });
            continue;
          }

          try {
            const result = await entityRepo.create(
              {
                profileId,
                title: e.title,
                properties: e.properties,
                workspaceId: input.workspaceId,
                userId: ctx.userId,
                skipValidation: true,
              },
              ctx.userId
            );
            entityIds[refKey] = result.id;
            entitiesCreated++;
          } catch (err) {
            errors.push({
              stage: "entities",
              refKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 3. Batch create relations
        const relationRepo = new RelationRepository(database, eventRepo);
        // D4: placement is a function of the endpoints, not the ambient
        // workspace — an idempotency check filtered to this workspace can't
        // see a pod-wide (NULL) duplicate of the same (source,target,type)
        // triple, so it would re-create it. Same fix as relations.batchCreate.
        const seededEntityIds = Object.values(entityIds);
        const endpointRows = seededEntityIds.length
          ? await database.query.entities.findMany({
              where: inArray(entities.id, seededEntityIds),
              columns: { id: true, workspaceId: true },
            })
          : [];
        const endpointWorkspaceById = new Map(
          endpointRows.map((e) => [e.id, e.workspaceId])
        );
        const existingRelations = await database.query.relations.findMany({
          columns: { sourceEntityId: true, targetEntityId: true, type: true },
        });
        const existingRelKeys = new Set<string>();
        for (const r of existingRelations) {
          existingRelKeys.add(
            `${r.sourceEntityId}:${r.targetEntityId}:${r.type}`
          );
        }

        let relationsCreated = 0;
        let relationsSkipped = 0;

        for (const rel of input.definition.suggestedRelations ?? []) {
          const sourceId = entityIds[rel.sourceRef];
          const targetId = entityIds[rel.targetRef];
          if (!sourceId || !targetId) {
            errors.push({
              stage: "relations",
              refKey: `${rel.sourceRef}->${rel.targetRef}`,
              error: `Source or target entity not found: ${rel.sourceRef}=${sourceId}, ${rel.targetRef}=${targetId}`,
            });
            continue;
          }

          const key = `${sourceId}:${targetId}:${rel.type}`;
          if (existingRelKeys.has(key)) {
            relationsSkipped++;
            continue;
          }

          try {
            const relationWorkspaceId = inheritRelationWorkspaceId(
              [
                endpointWorkspaceById.get(sourceId) ?? null,
                endpointWorkspaceById.get(targetId) ?? null,
              ],
              input.workspaceId
            );
            await relationRepo.create(
              {
                sourceEntityId: sourceId,
                targetEntityId: targetId,
                type: rel.type,
                workspaceId: relationWorkspaceId,
                userId: ctx.userId,
                metadata: rel.metadata,
              },
              ctx.userId
            );
            relationsCreated++;
          } catch (err) {
            errors.push({
              stage: "relations",
              refKey: `${rel.sourceRef}->${rel.targetRef}`,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return {
          workspaceId: input.workspaceId,
          profilesCreated,
          entitiesCreated,
          entitiesSkipped,
          relationsCreated,
          relationsSkipped,
          relationDefsCreated,
          entityIds,
          errors,
        };
      }

      // ── CREATE mode ─────────────────────────────────────────────────────
      const database = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;

      // Resolve template-composition dependencies + compose overlays through the
      // SAME shared core the in-app `createFromDefinition` door drives, so a
      // COMPOSED template (`dependencies[]`) applied via this devplane door
      // resolves its deps instead of skipping composition. `deferCreate:true`
      // keeps this door's own create for the no-compose case (whose entity tail
      // below reads `createResult.entityIds`). Only runs when deps are declared —
      // a plain definition skips it and creates byte-for-byte as before.
      let composedTarget: string | null = null;
      if (
        (input.definition as { dependencies?: unknown[] }).dependencies?.length
      ) {
        let core: MaterializeCoreResult;
        try {
          core = await materializeWorkspaceCore({
            definition: input.definition as unknown as WorkspaceDefinitionInput,
            userId: ctx.userId,
            deferCreate: true,
          });
        } catch (err) {
          if (err instanceof ComposeBaseUnavailableError) {
            const unresolved = err.dependencies.find(
              (d) => d.relation === "compose"
            );
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                unresolved?.message ??
                "compose base not available — the base template must be installed on the pod first",
            });
          }
          if (err instanceof DependencyResolutionError) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Dependency resolution failed: ${err.message}`,
            });
          }
          if (err instanceof ComposeBaseNotFoundError) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "compose base workspace not found",
            });
          }
          throw err;
        }
        if (core.status === "composed") {
          composedTarget = core.composeTargetWorkspaceId;
        }
      }

      let workspaceId: string;
      let createResult: Awaited<
        ReturnType<typeof createWorkspaceFromDefinition>
      > | null = null;
      if (composedTarget) {
        // Overlay layered onto its existing base — no new workspace.
        workspaceId = composedTarget;
      } else {
        createResult = await createWorkspaceFromDefinition({
          definition: input.definition as WorkspaceDefinitionInput,
          userId: ctx.userId,
          workspaceName: input.definition.workspaceName,
          createdBy: "user",
          workspaceType: "personal",
          onProgress: () => {},
        });
        workspaceId = createResult.workspaceId;
      }

      // After workspace is created/composed, apply entities and relations
      const relationRepo = new RelationRepository(database, eventRepo);
      const relDefRepo = new RelationDefRepository(database);

      // Entity IDs. On the create path they come back positionally from
      // createFromDefinition. On the compose path the shared reconcile is
      // schema-only (never seeds entity INSTANCES), so seed the definition's
      // entities onto the base workspace here via the canonical EntityRepository.
      const entityIds: Record<string, string> = {};
      const allEntities =
        input.definition.suggestedEntities ??
        input.definition.seedEntities ??
        [];
      if (composedTarget) {
        const { ProfileRepository } = await import("@synap/database");
        const profileRepo = new ProfileRepository(database);
        const entityRepo = new EntityRepository(database, eventRepo);
        const existingProfiles = await profileRepo.getAccessibleProfiles(
          ctx.userId,
          workspaceId
        );
        const profileCache = new Map<string, string>(
          existingProfiles.map((p) => [p.slug, p.id])
        );
        for (const e of allEntities) {
          const refKey = e.refKey ?? `${e.profileSlug}:${e.title}`;
          const profileId = profileCache.get(e.profileSlug);
          if (!profileId) {
            errors.push({
              stage: "entities",
              refKey,
              error: `Profile ${e.profileSlug} not found on compose base`,
            });
            continue;
          }
          try {
            const created = await entityRepo.create(
              {
                profileId,
                title: e.title,
                properties: e.properties,
                workspaceId,
                userId: ctx.userId,
                skipValidation: true,
              },
              ctx.userId
            );
            entityIds[refKey] = created.id;
          } catch (err) {
            errors.push({
              stage: "entities",
              refKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        const createEntityIds = (createResult as any)?.entityIds ?? [];
        for (
          let i = 0;
          i < allEntities.length && i < createEntityIds.length;
          i++
        ) {
          const e = allEntities[i];
          const refKey = e.refKey ?? `${e.profileSlug}:${e.title}`;
          entityIds[refKey] = createEntityIds[i];
        }
      }

      // Create relation definitions
      let relationDefsCreated = 0;
      const existingDefs = await relDefRepo.list(workspaceId);
      const existingDefSlugs = new Set(existingDefs.map((d) => d.slug));
      for (const rd of input.definition.relationDefs ?? []) {
        if (existingDefSlugs.has(rd.slug)) continue;
        await relDefRepo.create({
          slug: rd.slug,
          displayName: rd.displayName,
          description: rd.description,
          workspaceId,
          userId: ctx.userId,
          uiHints: rd.uiHints,
          isDirectional: rd.isDirectional ?? true,
        });
        relationDefsCreated++;
      }

      // Create relations
      let relationsCreated = 0;
      let relationsSkipped = 0;
      for (const rel of input.definition.suggestedRelations ?? []) {
        const sourceId = entityIds[rel.sourceRef];
        const targetId = entityIds[rel.targetRef];
        if (!sourceId || !targetId) continue;
        try {
          await relationRepo.create(
            {
              sourceEntityId: sourceId,
              targetEntityId: targetId,
              type: rel.type,
              workspaceId,
              userId: ctx.userId,
              metadata: rel.metadata,
            },
            ctx.userId
          );
          relationsCreated++;
        } catch {
          relationsSkipped++;
        }
      }

      return {
        workspaceId,
        profilesCreated: 0,
        entitiesCreated: allEntities.length,
        entitiesSkipped: 0,
        relationsCreated,
        relationsSkipped,
        relationDefsCreated,
        entityIds,
        errors,
      };
    }),

  // Delete all entities (and their relations via CASCADE) for a workspace.
  // Workspace itself, its metadata, profiles, views, and property_defs are preserved.
  resetEntities: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const dbConn = await getDb();

      // Verify caller is a member of this workspace
      const membership = await dbConn
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          )
        )
        .limit(1);

      if (!membership.length) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a member of this workspace",
        });
      }

      // Hard-delete all entities for the workspace.
      // relations rows cascade automatically (ON DELETE CASCADE on both FK columns).
      const deleted = await dbConn
        .delete(entities)
        .where(eq(entities.workspaceId, input.workspaceId))
        .returning({ id: entities.id });

      return { deletedCount: deleted.length };
    }),
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
