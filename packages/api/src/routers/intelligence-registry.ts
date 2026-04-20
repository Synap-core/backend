/**
 * Intelligence Registry Router
 *
 * Manages registration and discovery of external intelligence services
 */

import { z } from "zod";
import {
  router,
  protectedProcedure,
  publicProcedure,
  workspaceProcedure,
  podProcedure,
} from "../trpc.js";
import {
  db,
  intelligenceServices,
  workspaces,
  eq,
  and,
  getDb,
  EventRepository,
  WorkspaceRepository,
  ApiKeyRepository,
  sql,
  drizzleSql,
} from "@synap/database";
import {
  users,
  workspaceMembers,
  apiKeys,
  secrets,
} from "@synap/database/schema";
import { isNull } from "@synap/database";
import { verifyPermission } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { randomUUID, randomBytes } from "crypto";
import { encryptServiceKey } from "../utils/service-key-crypto.js";
import { auditLog } from "../utils/audit-log.js";
import { getServiceEntry } from "../utils/agent-services/index.js";
import { scopedProcedure } from "../middleware/api-key-auth.js";
import { SecretsVaultRepository } from "@synap/database";
import {
  encryptConfig,
  decryptConfig,
  isServerVaultAvailable,
} from "../utils/server-vault.js";

const logger = createLogger({ module: "intelligence-registry" });

// Simple ID generator (timestamp + random)
const generateId = () =>
  `svc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Validation schemas
const RegisterServiceSchema = z.object({
  serviceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  webhookUrl: z.string().url(),
  apiKey: z.string().min(1),
  capabilities: z.array(z.string()).min(1),
  pricing: z.enum(["free", "premium", "enterprise", "custom"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateServiceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  capabilities: z.array(z.string()).optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const intelligenceRegistryRouter = router({
  /**
   * Register a new intelligence service
   *
   * This allows external intelligence services to register with the Data Pod
   */
  register: protectedProcedure
    .input(RegisterServiceSchema)
    .mutation(async ({ input }) => {
      logger.info(
        { serviceId: input.serviceId },
        "Registering intelligence service"
      );

      // Check if service ID already exists
      const existing = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId),
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Service with ID "${input.serviceId}" already registered`,
        });
      }

      const [service] = await db
        .insert(intelligenceServices)
        .values({
          id: generateId(),
          serviceId: input.serviceId,
          name: input.name,
          description: input.description,
          version: input.version,
          webhookUrl: input.webhookUrl,
          apiKey: encryptServiceKey(input.apiKey),
          capabilities: input.capabilities,
          pricing: input.pricing || "free",
          status: "active",
          enabled: true,
          metadata: input.metadata || {},
        })
        .returning();

      logger.info(
        {
          serviceId: service.serviceId,
          capabilities: service.capabilities,
        },
        "Intelligence service registered"
      );

      return service;
    }),

  /**
   * List all registered intelligence services
   */
  list: publicProcedure
    .input(
      z
        .object({
          status: z.enum(["active", "inactive", "suspended"]).optional(),
          enabled: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const conditions = [];

      if (input?.status) {
        conditions.push(eq(intelligenceServices.status, input.status));
      }
      if (input?.enabled !== undefined) {
        conditions.push(eq(intelligenceServices.enabled, input.enabled));
      }

      const services = await db.query.intelligenceServices.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: (services, { desc }) => [desc(services.createdAt)],
      });

      // Don't expose API keys in list
      return services.map((s) => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        description: s.description,
        version: s.version,
        capabilities: s.capabilities,
        pricing: s.pricing,
        status: s.status,
        enabled: s.enabled,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }));
    }),

  /**
   * Get a specific service by ID
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const service = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.id, input.id),
      });

      if (!service) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      }

      // Don't expose API key
      const { apiKey, ...publicService } = service;
      return publicService;
    }),

  /**
   * Update an intelligence service
   */
  update: protectedProcedure
    .input(UpdateServiceSchema)
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      const [updated] = await db
        .update(intelligenceServices)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(intelligenceServices.id, id))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      }

      logger.info(
        { serviceId: updated.serviceId },
        "Intelligence service updated"
      );

      return updated;
    }),

  /**
   * Unregister an intelligence service
   */
  unregister: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db
        .delete(intelligenceServices)
        .where(eq(intelligenceServices.id, input.id));

      logger.info({ id: input.id }, "Intelligence service unregistered");

      return { success: true };
    }),

  /**
   * Rotate the API key for a registered service
   *
   * Separate from update() to make key rotation an explicit, auditable action.
   */
  rotateKey: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        newApiKey: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const [updated] = await db
        .update(intelligenceServices)
        .set({
          apiKey: encryptServiceKey(input.newApiKey),
          updatedAt: new Date(),
        })
        .where(eq(intelligenceServices.id, input.id))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      }

      logger.info(
        { serviceId: updated.serviceId },
        "Intelligence service API key rotated"
      );

      return { success: true, serviceId: updated.serviceId };
    }),

  /**
   * Connect a registered intelligence service to a workspace
   *
   * Sets workspace.settings.intelligenceServiceId so that requests from this
   * workspace are routed to the specified service instead of the default.
   */
  connectToWorkspace: workspaceProcedure
    .input(
      z.object({
        serviceId: z.string().min(1),
        capability: z.enum(["chat", "analysis"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify the service exists and is active
      const service = await db.query.intelligenceServices.findFirst({
        where: and(
          eq(intelligenceServices.serviceId, input.serviceId),
          eq(intelligenceServices.status, "active"),
          eq(intelligenceServices.enabled, true)
        ),
      });

      if (!service) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Intelligence service "${input.serviceId}" not found or not active`,
        });
      }

      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(db, eventRepo);

      if (input.capability) {
        // Capability-specific override — need to read existing overrides to merge sub-object
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, ctx.workspaceId),
        });
        if (!workspace) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Workspace not found",
          });
        }
        const existing = (workspace.settings as Record<string, unknown>) ?? {};
        const overrides =
          (existing.intelligenceServiceOverrides as
            | Record<string, string>
            | undefined) ?? {};
        await workspaceRepo.mergeSettings(
          ctx.workspaceId,
          {
            intelligenceServiceOverrides: {
              ...overrides,
              [input.capability]: input.serviceId,
            },
          },
          ctx.userId
        );
      } else {
        // Default service — single key, atomic patch
        await workspaceRepo.mergeSettings(
          ctx.workspaceId,
          { intelligenceServiceId: input.serviceId },
          ctx.userId
        );
      }

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          serviceId: input.serviceId,
          capability: input.capability ?? "default",
        },
        "Intelligence service connected to workspace"
      );

      return {
        success: true,
        workspaceId: ctx.workspaceId,
        serviceId: input.serviceId,
        capability: input.capability ?? "default",
      };
    }),

  /**
   * Disconnect the intelligence service from a workspace (revert to env default)
   */
  disconnectFromWorkspace: workspaceProcedure
    .input(
      z.object({
        capability: z.enum(["chat", "analysis"]).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId),
      });

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const existing = (workspace.settings as Record<string, unknown>) ?? {};
      let updatedSettings: Record<string, unknown>;

      if (input.capability) {
        const overrides =
          (existing.intelligenceServiceOverrides as
            | Record<string, string>
            | undefined) ?? {};
        const { [input.capability]: _removed, ...rest } = overrides;
        updatedSettings = {
          ...existing,
          intelligenceServiceOverrides: rest,
        };
      } else {
        const { intelligenceServiceId: _removed, ...rest } = existing;
        updatedSettings = rest;
      }

      // Disconnect removes a key — must use full settings replacement (not mergeSettings)
      const disconnectEventRepo = new EventRepository(sql);
      const wsRepo = new WorkspaceRepository(db, disconnectEventRepo);
      await wsRepo.update(
        ctx.workspaceId,
        { settings: updatedSettings },
        ctx.userId
      );

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          capability: input.capability ?? "default",
        },
        "Intelligence service disconnected from workspace"
      );

      return { success: true };
    }),

  /**
   * Approve a service's MCP endpoint for tool injection.
   *
   * Once approved, the service's mcpEndpoint is injected into LLM requests for
   * this workspace, allowing the AI to call tools exposed by the service (e.g.
   * ZeroClaw shell/browser, OpenClaw messaging/filesystem).
   *
   * Only workspace owners and admins can approve MCP tools — this is an explicit
   * security decision, not a default. Services registered via Hub Protocol (control
   * plane provisioning) are auto-approved at registration time.
   */
  approveMcp: workspaceProcedure
    .input(z.object({ serviceId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      // Require editor+ role to approve MCP tools
      if (!["editor", "admin", "owner"].includes(ctx.workspaceRole ?? "")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Editor role or higher required to approve MCP tools",
        });
      }

      const service = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId),
      });

      if (!service) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Service not found",
        });
      }

      if (!service.mcpEndpoint) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This service does not expose an MCP endpoint",
        });
      }

      await db
        .update(intelligenceServices)
        .set({
          mcpApproved: true,
          updatedAt: new Date(),
          metadata: {
            ...((service.metadata as Record<string, unknown>) ?? {}),
            mcpApprovedAt: new Date().toISOString(),
            mcpApprovedByUserId: ctx.userId,
            mcpApprovedInWorkspace: ctx.workspaceId,
          },
        })
        .where(eq(intelligenceServices.serviceId, input.serviceId));

      logger.info(
        {
          serviceId: input.serviceId,
          approvedBy: ctx.userId,
          workspaceId: ctx.workspaceId,
        },
        "MCP tools approved for intelligence service"
      );

      return { success: true, serviceId: input.serviceId };
    }),

  /**
   * Revoke MCP approval for a service.
   *
   * After revocation, the service's tools are no longer injected into LLM requests.
   * The service itself remains active — only MCP tool injection is disabled.
   */
  revokeMcp: workspaceProcedure
    .input(z.object({ serviceId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      if (!["editor", "admin", "owner"].includes(ctx.workspaceRole ?? "")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Editor role or higher required to revoke MCP approval",
        });
      }

      await db
        .update(intelligenceServices)
        .set({ mcpApproved: false, updatedAt: new Date() })
        .where(eq(intelligenceServices.serviceId, input.serviceId));

      logger.info(
        { serviceId: input.serviceId, revokedBy: ctx.userId },
        "MCP approval revoked for intelligence service"
      );

      return { success: true };
    }),

  /**
   * Find services by capability
   */
  findByCapability: publicProcedure
    .input(z.object({ capability: z.string() }))
    .query(async ({ input }) => {
      // Note: This requires PostgreSQL's JSONB operators
      const services = await db.query.intelligenceServices.findMany({
        where: and(
          eq(intelligenceServices.status, "active"),
          eq(intelligenceServices.enabled, true)
        ),
      });

      // Filter by capability (client-side for now)
      const filtered = services.filter((s) =>
        s.capabilities.includes(input.capability)
      );

      return filtered.map((s) => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        capabilities: s.capabilities,
        webhookUrl: s.webhookUrl,
      }));
    }),

  /**
   * Get MCP status for a specific intelligence service.
   * Returns the mcpEndpoint URL and whether MCP tools are approved for this workspace.
   */
  getMcpStatus: protectedProcedure
    .input(z.object({ serviceId: z.string().min(1) }))
    .query(async ({ input }) => {
      const svc = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId),
        columns: { mcpEndpoint: true, mcpApproved: true },
      });
      return {
        mcpEndpoint: svc?.mcpEndpoint ?? null,
        mcpApproved: svc?.mcpApproved ?? false,
      };
    }),

  // ===========================================================================================
  // Generic Agent Provisioning
  // ===========================================================================================

  /**
   * Provision an external agent service for this workspace.
   *
   * Creates a dedicated AI agent user + Hub Protocol API key for the requested
   * service type (e.g. "openclaw", "zeroclaw"). The API key is returned ONCE —
   * pass it to the container as SYNAP_HUB_API_KEY. Use rotateAgentKey to get a
   * fresh credential.
   *
   * Idempotent: if an agent of this type already exists, returns already_provisioned
   * without creating a new key.
   */
  provisionAgent: podProcedure
    .input(z.object({ serviceType: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      // Pod-wide provisioning: any authenticated user can provision (podProcedure handles auth check)
      // Throws if serviceType is not registered
      const entry = getServiceEntry(input.serviceType);

      // Check for existing agent user of this type (pod-wide search)
      const existing = await findProvisionedAgent(
        null, // null workspaceId = pod-wide search
        input.serviceType
      );
      if (existing) {
        logger.info(
          {
            agentUserId: existing.id,
            serviceType: input.serviceType,
          },
          "Agent already provisioned pod-wide — returning existing info"
        );
        const podUrl = process.env.PUBLIC_URL || "http://localhost:4000";
        return {
          status: "already_provisioned" as const,
          agentUserId: existing.id,
          agentEmail: existing.email,
          workspaceId: null,
          podUrl,
          configUrl: `${podUrl}/trpc/intelligenceRegistry.getServiceConfig`,
        };
      }

      // Create pod-wide agent user (no workspace membership)
      const agentId = randomUUID();
      const shortId = agentId.slice(0, 8);
      const email = `agent-${input.serviceType}-${shortId}@synap.agent`;

      await db.insert(users).values({
        id: agentId,
        email,
        name: `${entry.displayName} Agent`,
        emailVerified: true,
        userType: "agent",
        agentMetadata: {
          agentType: input.serviceType,
          description: entry.description,
          createdByUserId: ctx.userId,
          capabilities: entry.agentCapabilities,
        } satisfies NonNullable<(typeof users.$inferInsert)["agentMetadata"]>,
        timezone: "UTC",
        locale: "en",
      });

      // Create Hub Protocol API key
      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";
      const plainKey = generateApiKey(keyPrefix);

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      await apiKeyRepo.create(
        {
          keyName: `${entry.displayName} — pod-wide`,
          keyPrefix,
          key: plainKey,
          scope: entry.defaultScopes,
          userId: agentId,
          keyType: "hub_inbound",
          description: `Hub Protocol auth token for ${entry.displayName} agent service. Used by the ${entry.displayName} Docker container to authenticate inbound API calls to this Synap backend.`,
        },
        ctx.userId
      );

      auditLog({
        subjectType: "agent_user",
        action: "create",
        phase: "completed",
        subjectId: agentId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId ?? undefined,
        data: { agentType: input.serviceType, email },
      });

      logger.info(
        {
          agentUserId: agentId,
          serviceType: input.serviceType,
        },
        "Pod-wide agent provisioned"
      );

      auditLog({
        subjectType: "agent_user",
        action: "create",
        phase: "completed",
        subjectId: agentId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { agentType: input.serviceType, email },
      });

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          agentUserId: agentId,
          serviceType: input.serviceType,
        },
        "Agent provisioned"
      );

      const podUrl = process.env.PUBLIC_URL || "http://localhost:4000";
      const serviceId = `${input.serviceType}-${agentId.slice(0, 8)}`;
      const configUrl = `${podUrl}/trpc/intelligenceRegistry.getServiceConfig`;

      // Store service bootstrap credentials in the vault (server-side encrypted).
      // This replaces the "copy dockerCommand" UX: the service pulls its config
      // on startup via getServiceConfig using its Hub Protocol key.
      if (isServerVaultAvailable()) {
        try {
          const database = await getDb();
          const vaultRepo = new SecretsVaultRepository(
            database,
            new EventRepository(sql)
          );
          const blob = encryptConfig({
            SYNAP_POD_URL: podUrl,
            SYNAP_HUB_API_KEY: plainKey,
            SYNAP_WORKSPACE_ID: ctx.workspaceId ?? "pod-wide",
            SYNAP_AGENT_USER_ID: agentId,
            SYNAP_CONFIG_URL: configUrl,
          });
          await vaultRepo.upsertServerSide(
            {
              userId: agentId,
              serviceId,
              name: `${entry.displayName} — Service Config`,
              type: "api_key",
              category: "intelligence-services",
              description: `Bootstrap credentials for ${entry.displayName}. Fetched automatically on startup via Hub Protocol.`,
              ...blob,
            },
            ctx.userId
          );
          logger.info(
            { agentId, serviceId },
            "Service config stored in vault (server-side)"
          );
        } catch (err) {
          // Non-fatal: provisioning succeeds even if vault write fails.
          // The hub API key is still returned in the response as fallback.
          logger.warn(
            { err },
            "Failed to store service config in vault — returning plaintext key as fallback"
          );
        }
      } else {
        logger.warn(
          "VAULT_SERVER_KEY not configured — service credentials will not be stored in vault. Set VAULT_SERVER_KEY to enable automatic config pull."
        );
      }

      return {
        status: "provisioned" as const,
        agentUserId: agentId,
        agentEmail: email,
        serviceId,
        workspaceId: ctx.workspaceId,
        podUrl,
        configUrl,
        /**
         * Hub Protocol API key — still returned so the caller can bootstrap
         * the service if VAULT_SERVER_KEY is not configured. When the vault is
         * available the service should use configUrl instead.
         */
        apiKey: plainKey as string | null,
      };
    }),

  /**
   * Deprovision an agent service from this workspace.
   *
   * Revokes all Hub Protocol API keys, removes workspace membership, and deletes
   * the agent user record. The intelligence service registration (if any) is left
   * intact — the service deregisters itself on shutdown.
   */
  deprovisionAgent: workspaceProcedure
    .input(z.object({ serviceType: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: ctx.workspaceId },
        requiredPermission: "manage",
      });
      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            perm.reason ||
            "Owner or admin role required to deprovision agent services",
        });
      }

      // Validate service type (throws on unknown)
      getServiceEntry(input.serviceType);

      const agent = await findProvisionedAgent(
        ctx.workspaceId,
        input.serviceType
      );
      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `${input.serviceType} is not provisioned for this workspace`,
        });
      }

      // 1. Revoke all API keys
      await db
        .update(apiKeys)
        .set({
          isActive: false,
          revokedAt: new Date(),
          revokedReason: `Deprovisioned by user ${ctx.userId}`,
        })
        .where(eq(apiKeys.userId, agent.id));

      // 2. Remove workspace membership
      await db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, agent.id),
            eq(workspaceMembers.workspaceId, ctx.workspaceId)
          )
        );

      // 3. Delete agent user record
      await db.delete(users).where(eq(users.id, agent.id));

      auditLog({
        subjectType: "agent_user",
        action: "delete",
        phase: "completed",
        subjectId: agent.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { agentType: input.serviceType },
      });

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          agentUserId: agent.id,
          serviceType: input.serviceType,
          revokedBy: ctx.userId,
        },
        "Agent deprovisioned"
      );

      return { status: "deprovisioned" as const };
    }),

  /**
   * Rotate the Hub Protocol API key for a provisioned agent service.
   *
   * Revokes all existing keys and issues a new one. The new plaintext key is
   * returned ONCE — update the container's SYNAP_HUB_API_KEY.
   */
  rotateAgentKey: workspaceProcedure
    .input(z.object({ serviceType: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const perm = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: ctx.workspaceId },
        requiredPermission: "manage",
      });
      if (!perm.allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            perm.reason || "Owner or admin role required to rotate agent keys",
        });
      }

      const entry = getServiceEntry(input.serviceType);

      const agent = await findProvisionedAgent(
        ctx.workspaceId,
        input.serviceType
      );
      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `${input.serviceType} is not provisioned for this workspace`,
        });
      }

      // Revoke existing keys
      await db
        .update(apiKeys)
        .set({
          isActive: false,
          revokedAt: new Date(),
          revokedReason: `Key rotated by user ${ctx.userId}`,
        })
        .where(eq(apiKeys.userId, agent.id));

      // Issue new key
      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";
      const plainKey = generateApiKey(keyPrefix);

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      await apiKeyRepo.create(
        {
          keyName: `${entry.displayName} — workspace ${ctx.workspaceId} (rotated)`,
          keyPrefix,
          key: plainKey,
          scope: entry.defaultScopes,
          userId: agent.id,
          keyType: "hub_inbound",
          description: `Hub Protocol auth token for ${entry.displayName} agent service. Used by the ${entry.displayName} Docker container to authenticate inbound API calls to this Synap backend.`,
        },
        ctx.userId
      );

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          agentUserId: agent.id,
          serviceType: input.serviceType,
          rotatedBy: ctx.userId,
        },
        "Agent Hub Protocol API key rotated"
      );

      const podUrl = process.env.PUBLIC_URL || "http://localhost:4000";
      const serviceId = `${input.serviceType}-${agent.id.slice(0, 8)}`;
      const configUrl = `${podUrl}/trpc/intelligenceRegistry.getServiceConfig`;

      // Re-encrypt and overwrite vault entry with fresh key
      if (isServerVaultAvailable()) {
        try {
          const database = await getDb();
          const vaultRepo = new SecretsVaultRepository(
            database,
            new EventRepository(sql)
          );
          const blob = encryptConfig({
            SYNAP_POD_URL: podUrl,
            SYNAP_HUB_API_KEY: plainKey,
            SYNAP_WORKSPACE_ID: ctx.workspaceId,
            SYNAP_AGENT_USER_ID: agent.id,
            SYNAP_CONFIG_URL: configUrl,
          });
          await vaultRepo.upsertServerSide(
            {
              userId: agent.id,
              serviceId,
              name: `${entry.displayName} — Service Config`,
              type: "api_key",
              category: "intelligence-services",
              description: `Bootstrap credentials for ${entry.displayName} (rotated).`,
              ...blob,
            },
            ctx.userId
          );
        } catch (err) {
          logger.warn({ err }, "Failed to update vault after key rotation");
        }
      }

      return {
        status: "rotated" as const,
        serviceId,
        configUrl,
        /** New plaintext key — returned as fallback when vault is unavailable. */
        apiKey: plainKey,
      };
    }),

  /**
   * Get provisioning and registration status for an agent service type.
   *
   * Returns whether the agent user exists, whether the intelligence service has
   * self-registered, and the non-secret configuration.
   */
  getAgentStatus: workspaceProcedure
    .input(z.object({ serviceType: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const entry = getServiceEntry(input.serviceType);

      const [agent, service] = await Promise.all([
        findProvisionedAgent(ctx.workspaceId, input.serviceType),
        entry.matchCapability
          ? findRegisteredService(entry.matchCapability)
          : Promise.resolve(undefined),
      ]);

      const podUrl = process.env.PUBLIC_URL || "http://localhost:4000";

      if (!agent) {
        return {
          provisioned: false as const,
          serviceRegistered: false,
          mcpEndpoint: null as string | null,
          mcpApproved: false,
          agentUserId: null as string | null,
          agentEmail: null as string | null,
          podUrl,
          workspaceId: ctx.workspaceId,
        };
      }

      return {
        provisioned: true as const,
        serviceRegistered: !!service,
        mcpEndpoint: service?.mcpEndpoint ?? null,
        mcpApproved: service?.mcpApproved ?? false,
        agentUserId: agent.id,
        agentEmail: agent.email,
        podUrl,
        workspaceId: ctx.workspaceId,
      };
    }),

  /**
   * Service Config Pull — called by intelligence services (OpenClaw, ZeroClaw, …) on startup.
   *
   * The service authenticates with its Hub Protocol API key (the key created during
   * provisionAgent). This endpoint decrypts and returns the service's bootstrap
   * environment variables so the container only needs SYNAP_HUB_API_KEY to start.
   *
   * Auth: Hub Protocol API key (hub-protocol.read scope)
   */
  getServiceConfig: scopedProcedure(["hub-protocol.read"]).query(
    async ({ ctx }) => {
      // ctx.userId is the agent user (the Hub Protocol key belongs to the agent)
      const agentUserId = ctx.userId;
      if (!agentUserId)
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Hub Protocol key required.",
        });

      if (!isServerVaultAvailable()) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "VAULT_SERVER_KEY is not configured on this server. Service config pull is unavailable.",
        });
      }

      const database = await getDb();
      const vaultRepo = new SecretsVaultRepository(
        database,
        new EventRepository(sql)
      );

      // Find the most recent server-side secret for this agent user.
      // The agent only knows its Hub Protocol key (not its serviceId), so we
      // query by userId + encryptionMode and take the first non-deleted result.
      const secret = await database.query.secrets.findFirst({
        where: and(
          eq(secrets.userId, agentUserId),
          eq(secrets.encryptionMode, "server"),
          isNull(secrets.deletedAt)
        ),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      if (!secret) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No service config found for this Hub Protocol key. The service may not have been provisioned via intelligenceRegistry.provisionAgent, or VAULT_SERVER_KEY may have changed.",
        });
      }

      const config = decryptConfig({
        encryptedData: secret.encryptedData,
        iv: secret.iv,
        authTag: secret.authTag,
      });

      if (!config) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to decrypt service config. Check VAULT_SERVER_KEY.",
        });
      }

      // Log access for audit trail
      await vaultRepo.logAudit(secret.id, agentUserId, "read");

      logger.info(
        { agentUserId, secretId: secret.id },
        "Service config pulled via Hub Protocol"
      );

      return config;
    }
  ),

  /**
   * Store Service Secret — called by the control plane after provisioning a
   * cloud-managed intelligence service. Stores the Hub Protocol API key and
   * bootstrap config in the vault (server-side encrypted) so the service can
   * pull it via getServiceConfig.
   *
   * Auth: Hub Protocol API key with hub-protocol.write scope.
   *   The control plane uses the pod's intelligenceApiKey which has this scope.
   */
  storeServiceSecret: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        /** Registered service ID, e.g. "openclaw-abc12345" */
        serviceId: z.string().min(1),
        /** The full config map to encrypt and store */
        config: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // ctx.userId is the agent user — the Hub Protocol key issued during provisioning
      // belongs to the agent. No need to pass agentUserId separately.
      const agentUserId = ctx.userId;
      if (!agentUserId)
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Hub Protocol key required.",
        });

      if (!isServerVaultAvailable()) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "VAULT_SERVER_KEY is not configured — cannot store service secret.",
        });
      }

      const blob = encryptConfig(input.config as Record<string, string>);
      const database = await getDb();
      const vaultRepo = new SecretsVaultRepository(
        database,
        new EventRepository(sql)
      );

      const secret = await vaultRepo.upsertServerSide(
        {
          userId: agentUserId,
          serviceId: input.serviceId,
          name: `${input.serviceId} — Service Config`,
          type: "api_key",
          category: "intelligence-services",
          description: `Bootstrap credentials for service ${input.serviceId}. Stored by control plane provisioning.`,
          ...blob,
        },
        agentUserId
      );

      logger.info(
        { serviceId: input.serviceId, agentUserId, secretId: secret.id },
        "Service secret stored by control plane"
      );

      return { stored: true, secretId: secret.id };
    }),
});

// ============================================================================
// Shared helpers
// ============================================================================

function generateApiKey(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("hex")}`;
}

/**
 * Find an existing provisioned agent user of a given service type.
 * If workspaceId is null, searches pod-wide (no workspace membership required).
 */
async function findProvisionedAgent(
  workspaceId: string | null,
  serviceType: string
) {
  if (workspaceId) {
    // Workspace-scoped search (legacy)
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        agentMetadata: users.agentMetadata,
        role: workspaceMembers.role,
      })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId)
        )
      )
      .where(
        and(
          eq(users.userType, "agent"),
          drizzleSql`${users.agentMetadata}->>'agentType' = ${serviceType}`
        )
      )
      .limit(1);
    return row;
  } else {
    // Pod-wide search (no workspace membership required)
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        agentMetadata: users.agentMetadata,
      })
      .from(users)
      .where(
        and(
          eq(users.userType, "agent"),
          drizzleSql`${users.agentMetadata}->>'agentType' = ${serviceType}`
        )
      )
      .limit(1);
    return row;
  }
}

/**
 * Find the active intelligence service registration for a given capability.
 * Only matches services registered via Hub Protocol.
 */
async function findRegisteredService(matchCapability: string) {
  return db.query.intelligenceServices.findFirst({
    where: and(
      eq(intelligenceServices.status, "active"),
      drizzleSql`${intelligenceServices.capabilities} @> ${JSON.stringify([matchCapability])}::jsonb`,
      drizzleSql`${intelligenceServices.metadata}->>'registeredVia' = 'hub-protocol'`
    ),
  });
}
