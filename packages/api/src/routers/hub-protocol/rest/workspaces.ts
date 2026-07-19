/**
 * Hub Protocol REST — workspaces & per-user context
 */

import { z } from "zod";
import { z as zOpenapi } from "@hono/zod-openapi";
import {
  db,
  getDb,
  users,
  entities,
  workspaces,
  workspaceMembers,
  views,
  eq,
  and,
  isNull,
  inArray,
  desc,
  eventRepository,
  WorkspaceRepository,
  type AgentMetadata,
} from "@synap/database";
import { sql as drizzleSql } from "drizzle-orm";
import { emitSideEffects } from "@synap/events";
import { storage } from "@synap/storage";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  EveProviderRoutingResponseSchema,
  EveProviderRoutingSchema,
  ListWorkspacesResponseSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  createWorkspaceFromDefinitionIdempotent,
  isAgentTypeAllowedToCreateWorkspaces,
  WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST,
} from "../../../services/workspace-creation-service.js";
import { enrollAgentInWorkspace } from "../../../services/enroll-agent-in-workspace.js";
import {
  buildDigestSummary,
  getCaller,
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  verifyWorkspaceReadAccess,
  type HubHono,
} from "./_shared.js";

const eveProviderIdSchema = z.enum([
  "ollama",
  "openrouter",
  "anthropic",
  "openai",
]);

/**
 * Optional dry-run params on `GET /workspaces/:workspaceId/governance`
 * (AI Teaching Substrate). All fields are individually optional — the route
 * only runs the dry-run when `agentUserId` + `subjectType` + `action` are
 * ALL present; a partial set (e.g. `door` alone) is accepted here but ignored
 * by the route, not rejected.
 */
const DryRunGovernanceQuerySchema = z.object({
  agentUserId: z.string().min(1).optional(),
  subjectType: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  profileSlug: z.string().min(1).optional(),
  door: z.enum(["chat", "automation"]).optional(),
});

/**
 * Resolve the calling user's agentType (if any).
 *
 * The auth middleware sets `userId` on the Hono context but does NOT load
 * the user row — looking it up here is cheap (single PK fetch) and avoids
 * widening the middleware contract for a single endpoint.
 *
 * Returns:
 *   - the agentType string when the user is `userType="agent"` and has an
 *     `agentType` field in their metadata
 *   - null otherwise (human user, missing metadata, etc.)
 */
async function resolveCallerAgentType(userId: string): Promise<string | null> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { userType: true, agentMetadata: true },
  });
  if (!row || row.userType !== "agent") return null;
  const metadata = row.agentMetadata as AgentMetadata | null;
  return metadata?.agentType ?? null;
}

/**
 * Body schema for `POST /workspaces/from-definition`.
 *
 * Mirrors the `WorkspaceProposal` shape used by the frontend
 * (`apps/devplane/lib/devplaneWorkspaceDefinition.ts`) plus the registry
 * format consumed by `createWorkspaceFromDefinition`. Both formats are
 * normalized server-side. We use `passthrough()` so unknown fields propagate
 * — definition shapes evolve faster than this schema.
 */
const WorkspaceFromDefinitionBodySchema = z
  .object({
    /**
     * Stable caller-supplied idempotency key. Same key + same user → same
     * workspace. Eve / Coder generate this from a template id.
     */
    proposalId: z.string().min(1).optional(),
    /** Optional override for the workspace's display name. */
    workspaceName: z.string().optional(),
    /** Optional template provenance (audited, not used for idempotency). */
    templateId: z.string().optional(),
    templateName: z.string().optional(),
    workspaceType: z
      .enum(["personal", "agent", "project", "operational"])
      .optional(),
    /**
     * Provision on behalf of a beneficiary. A trusted agent/service key (e.g.
     * the IS system key) sets this so the workspace is OWNED BY — and the
     * membership row created for — the human user, not the calling service
     * identity. Omit to own as the caller. Validated to be a real user.
     */
    ownerUserId: z.string().optional(),
    /** WorkspaceProposal fields — accepted with `passthrough()` for forward-compat. */
  })
  .passthrough();

const eveProviderRoutingPolicySchema = z.object({
  mode: z.enum(["local", "provider", "hybrid"]).optional(),
  defaultProvider: eveProviderIdSchema.optional(),
  fallbackProvider: eveProviderIdSchema.optional(),
  providers: z
    .array(
      z.object({
        id: eveProviderIdSchema,
        enabled: z.boolean().optional(),
        baseUrl: z.string().optional(),
        defaultModel: z.string().optional(),
      })
    )
    .optional(),
  syncToSynap: z.boolean().optional(),
});

export function registerWorkspacesRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/workspaces",
    tags: ["Workspaces"],
    summary: "List accessible workspaces",
    responses: {
      200: {
        description: "Workspaces accessible to the authenticated user",
        schema: ListWorkspacesResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/workspaces/{workspaceId}/eve-provider-routing",
    tags: ["Workspaces"],
    summary: "Update Eve provider routing policy",
    description:
      "Persists the workspace's AI provider routing policy. Owner/admin role required.",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
      body: EveProviderRoutingSchema,
    },
    responses: {
      200: {
        description: "Updated policy",
        schema: EveProviderRoutingResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: {
        description: "Forbidden — must be owner/admin",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/workspaces/{workspaceId}/source-edges",
    tags: ["Workspaces"],
    summary: "Declare workspace data edges (sourceRoles / defaultSources)",
    description:
      "Set/merge the workspace-EDGE fields on an existing workspace: " +
      "`sourceRoles` (domain → provider|consumer|provider-consumer) and " +
      "`defaultSources` (domain → source workspace to read from). Merges " +
      "per-domain — existing domains and all other settings are preserved, " +
      "never clobbered. Editor+ membership required. GOVERNED: rewiring " +
      "cross-workspace read routing goes through review — an agent caller " +
      "gets `{ status: 'proposed', proposalId }` (applied on approval); an " +
      "operator-authority caller applies immediately (`{ status: 'updated' }`).",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
      body: zOpenapi.object({
        sourceRoles: zOpenapi
          .record(
            zOpenapi.string(),
            zOpenapi.enum(["provider", "consumer", "provider-consumer"])
          )
          .optional(),
        defaultSources: zOpenapi
          .record(
            zOpenapi.string(),
            zOpenapi.object({
              workspaceId: zOpenapi.string(),
              capability: zOpenapi.string().optional(),
              profileSlug: zOpenapi.string().optional(),
              label: zOpenapi.string().optional(),
            })
          )
          .optional(),
      }),
    },
    responses: {
      200: {
        description: "Merged edge fields",
        schema: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: {
        description: "Forbidden — not an editor+ member",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/workspaces/{workspaceId}/governance",
    tags: ["Workspaces", "Governance"],
    summary: "Read workspace governance policy",
    description:
      "Returns the effective RBAC + auto-approve list for the workspace. Membership required.",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
    },
    responses: {
      200: {
        description: "Governance policy",
        schema: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden — not a member", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/workspaces/{workspaceId}/digest",
    tags: ["Workspaces"],
    summary: "Workspace data digest",
    description:
      "Deterministic briefing of a workspace's existing data so an agent can " +
      "understand it before acting: entity counts per profileSlug, the most " +
      "recently-updated entities, and a one-line prose summary (no LLM).",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
    },
    responses: {
      200: {
        description: "Workspace digest",
        schema: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden — not a member", schema: ErrorSchema },
      404: { description: "Workspace not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/workspaces/{workspaceId}/eve-provider-routing",
    tags: ["Workspaces"],
    summary: "Read Eve provider routing policy",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
    },
    responses: {
      200: {
        description: "Provider routing policy",
        schema: EveProviderRoutingResponseSchema,
      },
      403: { description: "Forbidden — not a member", schema: ErrorSchema },
      404: { description: "Workspace not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/users/{userId}/context",
    tags: ["Workspaces"],
    summary: "Get a user's context",
    description:
      "Returns workspaces + active workspace for a given user (used by IS to bootstrap session context).",
    request: {
      params: zOpenapi.object({ userId: zOpenapi.string() }),
    },
    responses: {
      200: {
        description: "User context",
        schema: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/workspaces/enroll-agent",
    tags: ["Workspaces"],
    summary: "Enroll an agent user into the caller's workspaces",
    description:
      "Adds the given agent user as a member to all workspaces the calling " +
      "user belongs to (or just one, when workspaceId is supplied). " +
      "Idempotent — safe to call on reconnect. Used by `synap connect` " +
      "when 'All workspaces' is selected to give the agent key pod-wide access.",
    request: {
      body: zOpenapi.object({
        agentUserId: zOpenapi.string().uuid(),
        workspaceId: zOpenapi.string().uuid().optional(),
        role: zOpenapi.enum(["viewer", "editor", "admin"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "List of workspace IDs the agent was enrolled into",
        schema: zOpenapi.object({
          enrolled: zOpenapi.array(zOpenapi.string()),
          skipped: zOpenapi.array(zOpenapi.string()),
        }),
      },
      400: {
        description: "Invalid body or agentUserId not an agent user",
        schema: ErrorSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/workspaces/provision-agent",
    tags: ["Workspaces"],
    summary: "Provision an agent-owned workspace (idempotent)",
    description:
      "Idempotently provisions a workspace owned by an agent user. " +
      "Sets wide autoApproveFor so the agent can write freely within it. " +
      "The calling user is added as admin so they can see the agent's work. " +
      "Requires hub-protocol.write scope.",
    request: {
      body: zOpenapi.object({
        agentUserId: zOpenapi.string().uuid(),
        workspaceName: zOpenapi.string().optional(),
        idempotencyKey: zOpenapi.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Workspace id and creation outcome",
        schema: zOpenapi.object({
          workspaceId: zOpenapi.string(),
          created: zOpenapi.boolean(),
        }),
      },
      400: {
        description: "Invalid body or agentUserId not an agent user",
        schema: ErrorSchema,
      },
      403: {
        description: "Forbidden — insufficient scope",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/workspaces/from-definition",
    tags: ["Workspaces"],
    summary: "Create a workspace from a WorkspaceProposal definition",
    description:
      "Idempotently provisions a workspace from a WorkspaceProposal-shaped " +
      "definition. Restricted to agent users whose agentType is in the " +
      "allowlist (currently `eve`, `coder`). Pass a stable `proposalId` " +
      "to make retries idempotent — the same id for the same user returns " +
      "the existing workspace with `created: false`.",
    request: {
      body: WorkspaceFromDefinitionBodySchema,
    },
    responses: {
      200: {
        description: "Workspace id and creation outcome",
        schema: zOpenapi.object({
          workspaceId: zOpenapi.string(),
          created: zOpenapi.boolean(),
        }),
      },
      400: { description: "Invalid definition", schema: ErrorSchema },
      403: {
        description:
          "Forbidden — agentType not in allowlist or insufficient scope",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /workspaces — list workspaces accessible to the authenticated user.
   */
  app.get("/workspaces", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    try {
      const memberRows = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.userId, userId),
        columns: { workspaceId: true, role: true, joinedAt: true },
      });
      const membershipByWorkspace = new Map(
        memberRows.map((row) => [row.workspaceId, row])
      );
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      // Per-workspace live entity counts + pod-global count, so agent
      // orientation (`synap orient`) reports the truth instead of "empty".
      const [rows, countRows, podCountRows] = await Promise.all([
        wsIds.length > 0
          ? db
              .select({
                id: workspaces.id,
                name: workspaces.name,
                description: workspaces.description,
                settings: workspaces.settings,
                workspaceType: workspaces.workspaceType,
                archivedAt: workspaces.archivedAt,
              })
              .from(workspaces)
              .where(inArray(workspaces.id, wsIds))
          : Promise.resolve([]),
        wsIds.length > 0
          ? db
              .select({
                workspaceId: entities.workspaceId,
                count: drizzleSql<number>`cast(count(*) as integer)`,
              })
              .from(entities)
              .where(
                and(
                  inArray(entities.workspaceId, wsIds),
                  isNull(entities.deletedAt)
                )
              )
              .groupBy(entities.workspaceId)
          : Promise.resolve([]),
        db
          .select({ count: drizzleSql<number>`cast(count(*) as integer)` })
          .from(entities)
          .where(and(isNull(entities.workspaceId), isNull(entities.deletedAt))),
      ]);
      const entityCountByWorkspace = new Map(
        countRows.map((row) => [row.workspaceId, row.count])
      );
      const podEntityCount = podCountRows[0]?.count ?? 0;
      const list = rows
        .filter((workspace) => workspace.archivedAt == null)
        .map((workspace) => {
          const settings = (workspace.settings ?? {}) as Record<
            string,
            unknown
          >;
          const membership = membershipByWorkspace.get(workspace.id);
          return {
            id: workspace.id,
            name: workspace.name,
            description: workspace.description,
            role: membership?.role ?? "viewer",
            accessKind: membership ? "member" : "pod_visible",
            workspaceType: workspace.workspaceType,
            workspaceSubtype: settings.workspaceSubtype ?? null,
            onboarding: settings.onboarding ?? null,
            workspaceVisibility: settings.workspaceVisibility ?? "members",
            workspaceCapabilities: settings.workspaceCapabilities ?? [],
            sourceRoles: settings.sourceRoles ?? {},
            defaultSources: settings.defaultSources ?? {},
            appId: settings.appId ?? null,
            packageSlug: settings.packageSlug ?? null,
            // CP content-hash stamp ("h-<hash>") — the CLI/agent install door
            // (Hub `/packages/apply`) needs this to detect template drift
            // client-side, mirroring `packageSlug`'s projection above.
            packageVersion: settings.packageVersion ?? null,
            // Additive-pack installs (profile/view/bento) never set
            // `packageSlug` — they carry their own identity here instead. The
            // CLI unions this with `packageSlug` to match the browser's
            // `useInstalledPackageSlugs` "installed" set (see that hook's doc).
            installedPacks: settings.installedPacks ?? [],
            systemSlug: settings.systemSlug ?? null,
            entityCount: entityCountByWorkspace.get(workspace.id) ?? 0,
          };
        });
      return c.json({ workspaces: list, podEntityCount });
    } catch (err) {
      logger.error({ err }, "GET /workspaces failed");
      return c.json({ error: "Failed to list workspaces" }, 500);
    }
  });

  /**
   * POST /workspaces/enroll-agent
   *
   * Adds an agent user as a member of all workspaces the calling user belongs
   * to (or one specific workspace). Idempotent. Called by `synap connect` when
   * the user picks "All workspaces" so the agent key sees every workspace.
   *
   * Registered BEFORE /:workspaceId dynamic routes.
   */
  app.post("/workspaces/enroll-agent", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const callerId = c.get("userId") as string;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = z
      .object({
        agentUserId: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
        role: z.enum(["viewer", "editor", "admin"]).default("editor"),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }

    const { agentUserId, workspaceId, role } = parsed.data;

    // Verify agentUserId is a real agent user
    const agentRow = await db.query.users.findFirst({
      where: eq(users.id, agentUserId),
      columns: { id: true, userType: true },
    });
    if (!agentRow || agentRow.userType !== "agent") {
      return c.json(
        {
          error: `agentUserId '${agentUserId}' is not an agent user on this pod`,
        },
        400
      );
    }

    try {
      // Resolve target workspaces: one specific workspace or all caller's workspaces
      const targetIds = workspaceId
        ? [workspaceId]
        : await getUserAccessibleWorkspaceIds(callerId);

      const enrolled: string[] = [];
      const skipped: string[] = [];

      for (const wsId of targetIds) {
        // Verify caller is a member (skip workspaces they don't belong to)
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, wsId),
            eq(workspaceMembers.userId, callerId)
          ),
          columns: { id: true },
        });
        if (!membership) {
          skipped.push(wsId);
          continue;
        }

        await enrollAgentInWorkspace({ workspaceId: wsId, agentUserId, role });
        enrolled.push(wsId);
      }

      return c.json({ enrolled, skipped }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, callerId, agentUserId },
        "POST /workspaces/enroll-agent failed"
      );
      return c.json({ error: `Enroll failed: ${message}` }, 500);
    }
  });

  /**
   * POST /workspaces/provision-agent
   *
   * Idempotently provisions an agent-owned workspace. The agent user owns it
   * with a wide autoApproveFor list; the calling human is added as admin.
   * Registered BEFORE /workspaces/from-definition and /:workspaceId routes.
   */
  app.post("/workspaces/provision-agent", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const callerId = c.get("userId") as string;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = z
      .object({
        agentUserId: z.string().uuid("agentUserId must be a valid UUID"),
        workspaceName: z.string().optional(),
        idempotencyKey: z.string().optional(),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }

    const { agentUserId, workspaceName, idempotencyKey } = parsed.data;

    // Verify target is a real agent user on this pod
    const agentRow = await db.query.users.findFirst({
      where: eq(users.id, agentUserId),
      columns: { id: true, userType: true, agentMetadata: true },
    });
    if (!agentRow || agentRow.userType !== "agent") {
      return c.json(
        {
          error: `agentUserId '${agentUserId}' is not an agent user on this pod`,
        },
        400
      );
    }

    const metadata = agentRow.agentMetadata as AgentMetadata | null;
    const agentType = metadata?.agentType ?? "agent";
    const proposalId = idempotencyKey ?? `agent-workspace-${agentUserId}`;
    const name = workspaceName ?? `${agentType} Knowledge Base`;

    try {
      const result = await createWorkspaceFromDefinitionIdempotent({
        definition: {} as Parameters<
          typeof createWorkspaceFromDefinitionIdempotent
        >[0]["definition"],
        userId: agentUserId,
        proposalId,
        workspaceName: name,
        workspaceType: "agent",
        createdBy: "provisioning",
      });

      // Always apply settings (upsert): workspace may have been created before
      // autoApproveFor was introduced, so re-provisioning must fix existing workspaces.
      await db
        .update(workspaces)
        .set({
          workspaceType: "agent",
          settings: {
            workspaceType: "agent",
            linkedAgentId: agentUserId,
            governanceMode: "standard",
            aiGovernance: {
              autoApproveFor: [
                "search.*",
                "memory.recall",
                "entity.read",
                "entity.create",
                "entity.update",
                "relation.create",
                "relation.update",
                "document.create",
                "document.read",
                "view.create",
                "profile.create",
                "profile.update",
                "property_def.create",
                "property_def.update",
                "bento.arrange",
                "context.*",
                "channel.create",
                "terminal.read_logs",
              ],
            },
          } as never,
        })
        .where(eq(workspaces.id, result.workspaceId));

      // Add calling user as admin so they see the agent's work (idempotent)
      if (callerId !== agentUserId) {
        await db
          .insert(workspaceMembers)
          .values({
            workspaceId: result.workspaceId,
            userId: callerId,
            role: "admin",
          })
          .onConflictDoNothing();
      }

      return c.json(
        { workspaceId: result.workspaceId, created: result.created },
        200
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, callerId, agentUserId, proposalId },
        "POST /workspaces/provision-agent failed"
      );
      return c.json({ error: `Provision failed: ${message}` }, 500);
    }
  });

  /**
   * POST /workspaces/from-definition
   *
   * Restricted to allowlisted agentTypes (Eve, Coder). Idempotent on
   * caller-supplied `proposalId`.
   *
   * Registered BEFORE the `:workspaceId` dynamic routes below to ensure
   * Hono's first-match dispatcher does not interpret "from-definition" as a
   * workspace id.
   */
  app.post("/workspaces/from-definition", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;

    // ── agentType allowlist gate ───────────────────────────────────────────
    // Look up the calling user's agentType from `users.agentMetadata`. Only
    // agent users with an allowlisted agentType (e.g. `eve`, `coder`,
    // `the-arch`) or users with `hub-protocol.write` scope may call this
    // endpoint. This covers both pre-provisioned agent users and service
    // tokens that need to bootstrap a workspace on first run.
    const agentType = await resolveCallerAgentType(userId);
    if (
      !isAgentTypeAllowedToCreateWorkspaces(agentType) &&
      !hasScope(scopes, "hub-protocol.write")
    ) {
      return c.json(
        {
          error:
            "Forbidden — workspace creation via Hub Protocol is restricted to allowlisted agentTypes or users with hub-protocol.write scope.",
          allowedAgentTypes: WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST,
          callerAgentType: agentType,
        },
        403
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = WorkspaceFromDefinitionBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid workspace definition body",
          details: parsed.error.issues,
        },
        400
      );
    }

    const {
      proposalId,
      workspaceName,
      templateId,
      templateName,
      workspaceType,
      ownerUserId,
      // The remaining fields are the WorkspaceProposal definition itself —
      // strip the wrapper meta fields above and pass the rest through.
      ...definition
    } = parsed.data;

    // "Provision on behalf of": when a trusted service key supplies ownerUserId,
    // the workspace is owned by — and the membership row created for — that human
    // user instead of the calling service identity (c.get("userId")). Without
    // this, the beneficiary gets no workspace_members row and their
    // workspace-scoped reads/writes fail the membership check. Validate the
    // target is a real user so a caller can't mint workspaces for arbitrary ids.
    let ownerId = userId;
    if (ownerUserId && ownerUserId !== userId) {
      const target = await db.query.users.findFirst({
        where: eq(users.id, ownerUserId),
        columns: { id: true },
      });
      if (!target) {
        return c.json(
          { error: `ownerUserId not found on this pod: ${ownerUserId}` },
          400
        );
      }
      ownerId = ownerUserId;
    }

    try {
      const result = await createWorkspaceFromDefinitionIdempotent({
        // The definition object accepts `passthrough()` fields — cast to the
        // shape the database util expects. Validation happens inside
        // createWorkspaceFromDefinition (validateDefinition).
        definition: definition as Parameters<
          typeof createWorkspaceFromDefinitionIdempotent
        >[0]["definition"],
        userId: ownerId,
        proposalId,
        workspaceName,
        templateId,
        templateName,
        workspaceType,
        // Always "provisioning" — this endpoint is gated to agent users only,
        // never humans. Audit trail must distinguish machine-provisioned rows.
        createdBy: "provisioning",
      });
      return c.json(
        {
          workspaceId: result.workspaceId,
          created: result.created,
        },
        200
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, userId, agentType, proposalId },
        "POST /workspaces/from-definition failed"
      );
      // Definition-validation errors are 400; everything else is 500.
      const isValidationError = message.startsWith(
        "Definition validation failed"
      );
      return c.json(
        {
          error: isValidationError ? message : "Failed to create workspace",
          ...(isValidationError ? {} : { reason: message }),
        },
        isValidationError ? 400 : 500
      );
    }
  });

  /**
   * POST /workspaces/:workspaceId/purge
   *
   * DESTRUCTIVE owner maintenance. Hard-purges ALL workspace-scoped content
   * (entities/relations/proposals/documents) and then deletes the workspace row
   * (config tables — views/profiles/property_defs/members — FK-cascade). Pod-wide
   * rows (`workspaceId IS NULL`) are intentionally left untouched.
   *
   * This DELIBERATELY bypasses the soft-delete / proposal flow: it is an explicit,
   * confirm-gated OWNER action, not an agent mutation — so it does NOT call
   * `checkPermissionOrPropose()` and never returns `{ status: "proposed" }`. It
   * mirrors the safety rails of `workspaces.adminDelete` (tRPC) but is gated on
   * OWNERSHIP (owner/admin membership) rather than pod-admin.
   *
   * Registered as a 3-segment literal-suffix route (`/:workspaceId/purge`), so it
   * never collides with the static `/workspaces/*` POST routes above.
   */
  app.post("/workspaces/:workspaceId/purge", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = z.object({ confirm: z.string() }).safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }

    // 404 — workspace must exist.
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { id: true, name: true, settings: true },
    });
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    // 403 — ownership. Same predicate as the workspace write routes
    // (eve-provider-routing / delivery-preferences): owner/admin membership.
    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);
    if (membership.role !== "owner" && membership.role !== "admin") {
      return c.json(
        { error: "Owner/admin role required to purge a workspace." },
        403
      );
    }

    // 403 — refuse system workspaces (mirror adminDelete).
    const settings = (workspace.settings ?? {}) as Record<string, unknown>;
    if (settings.systemSlug) {
      return c.json({ error: "System workspaces cannot be purged." }, 403);
    }

    // 400 — confirm must equal the workspace name exactly.
    if (parsed.data.confirm !== workspace.name) {
      return c.json(
        {
          error: "confirm does not match the workspace name. Purge cancelled.",
        },
        400
      );
    }

    try {
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      // Hard-purge workspace-scoped rows in a tx (returns storageKeys + ids for
      // post-commit cleanup), then delete the workspace row.
      const purged = await workspaceRepo.purgeWorkspaceData(workspaceId);
      await workspaceRepo.delete(workspaceId, userId);

      // Post-commit, best-effort cleanup of out-of-DB state (never block delete).
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
          userId,
          workspaceId,
        });
      }
      for (const id of purged.documentIds) {
        void emitSideEffects({
          subjectType: "document",
          action: "delete",
          subjectId: id,
          userId,
          workspaceId,
        });
      }

      logger.warn(
        {
          workspaceId,
          purgedBy: userId,
          entities: purged.entityIds.length,
          documents: purged.documentIds.length,
          relations: purged.relationsDeleted,
          proposals: purged.proposalsDeleted,
          blobs: blobsDeleted,
        },
        "Workspace HARD-PURGED via Hub Protocol"
      );

      return c.json({
        purged: true,
        workspaceId,
        entitiesDeleted: purged.entityIds.length,
        blobsDeleted,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "POST /workspaces/:workspaceId/purge failed"
      );
      return c.json({ error: "Failed to purge workspace" }, 500);
    }
  });

  /**
   * PATCH /workspaces/:workspaceId/eve-provider-routing
   */
  app.patch("/workspaces/:workspaceId/eve-provider-routing", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);
    if (membership.role !== "owner" && membership.role !== "admin") {
      return c.json(
        { error: "Owner/admin role required to sync provider routing" },
        403
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = eveProviderRoutingPolicySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid provider routing payload",
          details: parsed.error.issues,
        },
        400
      );
    }

    try {
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.mergeSettings(
        workspaceId,
        { eveProviderRouting: parsed.data },
        userId
      );

      return c.json({
        ok: true,
        workspaceId,
        eveProviderRouting: parsed.data,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "PATCH /workspaces/:workspaceId/eve-provider-routing failed"
      );
      return c.json({ error: "Failed to sync provider routing" }, 500);
    }
  });

  /**
   * PATCH /workspaces/:workspaceId/delivery-preferences
   *
   * Set the signal delivery routing (`settings.deliveryPreferences`) — the config
   * that lets routeSignal() reach a surface. To make the agent post PROACTIVELY
   * into Discord, route a domain (e.g. `ai_insight`) to an `external` target
   * `{ kind:"external", provider:"discord", channelRef:"<discord channel id>" }`.
   * Merges per-domain into the existing preferences (does not clobber others).
   * Owner/admin only — same membership gate as eve-provider-routing.
   */
  app.patch("/workspaces/:workspaceId/delivery-preferences", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);
    if (membership.role !== "owner" && membership.role !== "admin") {
      return c.json(
        { error: "Owner/admin role required to set delivery preferences" },
        403
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // A delivery rule: { surfaces: (string | { kind, provider?, channelRef? })[] }.
    const SurfaceTargetSchema = zOpenapi.object({
      kind: zOpenapi.string(),
      provider: zOpenapi.string().optional(),
      channelRef: zOpenapi.string().optional(),
    });
    const RuleSchema = zOpenapi.object({
      surfaces: zOpenapi.array(
        zOpenapi.union([zOpenapi.string(), SurfaceTargetSchema])
      ),
    });
    const parsed = zOpenapi
      .object({
        deliveryPreferences: zOpenapi.record(zOpenapi.string(), RuleSchema),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid deliveryPreferences payload",
          details: parsed.error.issues,
        },
        400
      );
    }

    try {
      // Merge per-domain so we never clobber existing delivery rules.
      const existing = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { settings: true },
      });
      const currentPrefs =
        ((existing?.settings ?? {}) as Record<string, unknown>)
          .deliveryPreferences ?? {};
      const mergedPrefs = {
        ...(currentPrefs as Record<string, unknown>),
        ...parsed.data.deliveryPreferences,
      };

      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);
      await workspaceRepo.mergeSettings(
        workspaceId,
        { deliveryPreferences: mergedPrefs },
        userId
      );

      return c.json({
        ok: true,
        workspaceId,
        deliveryPreferences: mergedPrefs,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "PATCH /workspaces/:workspaceId/delivery-preferences failed"
      );
      return c.json({ error: "Failed to set delivery preferences" }, 500);
    }
  });

  /**
   * PATCH /workspaces/:workspaceId/source-edges
   *
   * Agnostic edge-declaration door (Enterprise-OS Wave 0). Set/merge the two
   * workspace-EDGE fields — `sourceRoles` + `defaultSources` — on an existing
   * workspace, so an agent can DECLARE a data edge ("Marketing consumes Comms")
   * without template authoring or the tRPC UI. Reuses the canonical
   * non-clobbering `mergeSettings` path (via `mergeWorkspaceSourceEdges`) and
   * ONLY exposes the two edge fields — no other settings key is writable here.
   * Governed by `assertWorkspaceWrite` (editor+ membership on the row).
   *
   * `/:workspaceId/source-edges` is a distinct literal suffix, so it never
   * collides with the static `/workspaces/*` routes registered above.
   */
  app.patch("/workspaces/:workspaceId/source-edges", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { WorkspaceSourceEdgeInputSchema, mergeWorkspaceSourceEdges } =
      await import("../../../services/workspace-edge-service.js");
    const parsed = WorkspaceSourceEdgeInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid edge fields", details: parsed.error.issues },
        400
      );
    }
    if (!parsed.data.sourceRoles && !parsed.data.defaultSources) {
      return c.json(
        { error: "Provide at least one of: sourceRoles, defaultSources" },
        400
      );
    }

    // GOVERNED write (Enterprise-OS Wave 0): declaring a data edge rewires
    // pod-wide cross-workspace read routing, so it goes through the review
    // membrane, not immediate apply. `checkPermissionOrPropose` runs the
    // canonical RBAC floor (action `declare_source` → "write" permission = the
    // same editor+ floor `assertWorkspaceWrite` enforced) and then the
    // agent-governance ladder: an IS/agent caller (agentUserId set) routes to a
    // PROPOSAL, applied on approval by the `workspace/declare_source` executor;
    // an operator-authority caller is GRANTED and applies immediately here
    // (byte-identical to the pre-governance path). agentUserId is the acting
    // agent identity set on an agent-key request (never a body field).
    const agentUserId = c.get("agentUserId") as string | undefined;
    const { checkPermissionOrPropose } =
      await import("../../../utils/permission-check.js");
    const perm = await checkPermissionOrPropose({
      userId,
      agentUserId,
      workspaceId,
      subjectType: "workspace",
      action: "declare_source",
      source: "intelligence",
      data: {
        sourceRoles: parsed.data.sourceRoles,
        defaultSources: parsed.data.defaultSources,
      },
    });
    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({
        status: "proposed",
        workspaceId,
        proposalId: perm.proposalId,
        summary: perm.summary,
        reviewPath: perm.reviewPath,
        reviewUrl: perm.reviewUrl,
      });
    }

    // Granted (operator authority) → apply immediately.
    try {
      const result = await mergeWorkspaceSourceEdges(
        workspaceId,
        parsed.data,
        agentUserId ?? userId
      );
      return c.json({ ok: true, status: "updated", workspaceId, ...result });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "PATCH /workspaces/:workspaceId/source-edges failed"
      );
      return c.json({ error: "Failed to declare workspace edges" }, 500);
    }
  });

  /**
   * GET /workspaces/:workspaceId/governance
   */
  app.get("/workspaces/:workspaceId/governance", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);

    // Optional dry-run params (AI Teaching Substrate): when agentUserId +
    // subjectType + action are all present, the response also includes a
    // `verdict` — a side-effect-free preview of whether this write would
    // auto-apply or propose. Same auth/scope as the base governance read;
    // this is a pure query, never a write.
    const dryRunQuery = DryRunGovernanceQuerySchema.safeParse({
      agentUserId: c.req.query("agentUserId"),
      subjectType: c.req.query("subjectType"),
      action: c.req.query("action"),
      profileSlug: c.req.query("profileSlug"),
      door: c.req.query("door"),
    });
    if (!dryRunQuery.success) {
      return c.json(
        {
          error: "Invalid dry-run query params",
          issues: dryRunQuery.error.issues,
        },
        400
      );
    }
    const dryRun = dryRunQuery.data;

    try {
      const { getEffectiveGovernance } =
        await import("../../../utils/permission-check.js");
      const policy = await getEffectiveGovernance(workspaceId);

      if (dryRun.agentUserId && dryRun.subjectType && dryRun.action) {
        const { dryRunAgentGovernanceDecision } =
          await import("@synap/database/agent-governance");
        const verdict = await dryRunAgentGovernanceDecision({
          db,
          agentUserId: dryRun.agentUserId,
          workspaceId,
          subjectType: dryRun.subjectType,
          action: dryRun.action,
          profileSlug: dryRun.profileSlug,
          door: dryRun.door ?? "chat",
        });
        return c.json({ ...policy, verdict });
      }

      return c.json(policy);
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "GET /workspaces/:workspaceId/governance failed"
      );
      return c.json({ error: "Failed to read governance policy" }, 500);
    }
  });

  /**
   * GET /workspaces/:workspaceId/eve-provider-routing
   */
  app.get("/workspaces/:workspaceId/eve-provider-routing", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);

    try {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { settings: true },
      });
      if (!workspace) return c.json({ error: "Workspace not found" }, 404);
      const settings = (workspace.settings ?? {}) as Record<string, unknown>;
      return c.json({
        ok: true,
        workspaceId,
        eveProviderRouting:
          (settings.eveProviderRouting as
            | Record<string, unknown>
            | undefined) ?? null,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "GET /workspaces/:workspaceId/eve-provider-routing failed"
      );
      return c.json({ error: "Failed to read provider routing" }, 500);
    }
  });

  /**
   * GET /workspaces/:workspaceId/home
   *
   * Returns the workspace's home bento layout so agents can see the current
   * UI state before proposing changes. Looks up the view with
   * type='bento' and metadata.homeScope set (the canonical home view),
   * then returns its config (blocks array) plus a block summary for agents.
   *
   * Registered BEFORE /:workspaceId dynamic route catch-alls.
   */
  app.get("/workspaces/:workspaceId/home", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);

    try {
      // Find the canonical home bento view for this workspace.
      // It is the view with type='bento' whose metadata.homeScope is set.
      const wsViews = await db
        .select({
          id: views.id,
          name: views.name,
          config: views.config,
          metadata: views.metadata,
        })
        .from(views)
        .where(
          and(eq(views.workspaceId, workspaceId), eq(views.type, "bento"))
        );

      const homeView =
        wsViews.find((v) => {
          const meta = (v.metadata ?? {}) as Record<string, unknown>;
          return meta.homeScope != null;
        }) ??
        wsViews[0] ??
        null;

      if (!homeView) {
        return c.json({
          workspaceId,
          homeViewId: null,
          blocks: [],
          blockSummary: [],
        });
      }

      const config = (homeView.config ?? {}) as Record<string, unknown>;
      const blocks = (config.blocks ?? config.layout ?? []) as Array<
        Record<string, unknown>
      >;

      // Compact summary for agents — just what's present, not full block data
      const blockSummary = blocks.map((b) => ({
        kind: b.kind ?? b.type ?? "unknown",
        typeKey: b.typeKey ?? b.widgetType ?? b.viewType ?? null,
        label: b.label ?? b.title ?? b.name ?? null,
        id: b.id ?? null,
      }));

      return c.json({
        workspaceId,
        homeViewId: homeView.id,
        homeViewName: homeView.name,
        blocks,
        blockSummary,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "GET /workspaces/:workspaceId/home failed"
      );
      return c.json({ error: "Failed to read home layout" }, 500);
    }
  });

  /**
   * GET /workspaces/:workspaceId/digest
   *
   * Deterministic "understand existing data before acting" briefing for one
   * workspace. Counts are grouped by profileSlug (entities.type) and scoped to
   * the exact workspace — the SAME per-workspace count semantics as the entity
   * count in GET /workspaces (do NOT leak cross-user/cross-workspace). The
   * summary is pure string assembly (no LLM).
   *
   * `/:workspaceId/digest` is a distinct literal suffix, so it never collides
   * with the static `/workspaces/*` routes registered above.
   */
  app.get("/workspaces/:workspaceId/digest", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const parsed = z
      .object({ workspaceId: z.string().uuid() })
      .safeParse({ workspaceId: c.req.param("workspaceId") });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid workspaceId", details: parsed.error.issues },
        400
      );
    }
    const { workspaceId } = parsed.data;

    const hasAccess = await verifyWorkspaceReadAccess(userId, workspaceId);
    if (!hasAccess) return c.json({ error: "Access denied" }, 403);

    try {
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { name: true },
      });
      if (!ws) return c.json({ error: "Workspace not found" }, 404);

      const baseWhere = and(
        eq(entities.workspaceId, workspaceId),
        isNull(entities.deletedAt)
      );

      const [countRows, recentRows] = await Promise.all([
        db
          .select({
            profileSlug: entities.type,
            count: drizzleSql<number>`cast(count(*) as integer)`,
          })
          .from(entities)
          .where(baseWhere)
          .groupBy(entities.type),
        db
          .select({
            id: entities.id,
            title: entities.title,
            profileSlug: entities.type,
            updatedAt: entities.updatedAt,
          })
          .from(entities)
          .where(baseWhere)
          .orderBy(desc(entities.updatedAt))
          .limit(10),
      ]);

      const counts: Record<string, number> = {};
      for (const row of countRows) counts[row.profileSlug] = row.count;
      const total = countRows.reduce((sum, r) => sum + r.count, 0);
      const keyEntities = recentRows.map((r) => ({
        id: r.id,
        title: r.title,
        profileSlug: r.profileSlug,
        updatedAt: r.updatedAt,
      }));
      const summary = buildDigestSummary(
        `Workspace '${ws.name}'`,
        total,
        counts,
        keyEntities
      );

      return c.json({
        workspaceId,
        name: ws.name,
        total,
        counts,
        keyEntities,
        summary,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "GET /workspaces/:workspaceId/digest failed"
      );
      return c.json({ error: "Failed to build workspace digest" }, 500);
    }
  });

  /**
   * GET /users/:userId/context
   */
  app.get("/users/:userId/context", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.req.param("userId");
    try {
      const caller = await getCaller(c);
      const result = await caller.context.getUserContext({ userId });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "getUserContext failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
