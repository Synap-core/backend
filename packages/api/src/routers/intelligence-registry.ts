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
} from "../trpc.js";
import {
  db,
  intelligenceServices,
  workspaces,
  eq,
  and,
  getDb,
  EventRepository,
  eventRepository,
  WorkspaceRepository,
  sql,
} from "@synap/database";
import { apiKeys, secrets } from "@synap/database/schema";
import { isNull, isNotNull } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";
import { encryptServiceKey } from "@synap/database";
import { scopedProcedure } from "../middleware/api-key-auth.js";
import {
  setDefaultIntelligenceService,
  selectPodDefaultService,
} from "../utils/intelligence-routing.js";
import { SecretsVaultRepository } from "@synap/database";
import {
  encryptConfig,
  decryptConfig,
  isServerVaultAvailable,
} from "@synap/database";

const logger = createLogger({ module: "intelligence-registry" });

/**
 * The user that OWNS the calling API key (`api_keys.user_id`). For an agent key
 * this is the agent, whereas `ctx.userId` is the linked human after the identity
 * remap — so anything that belongs to the key itself must be keyed by this.
 */
async function resolveKeyPrincipalUserId(ctx: {
  apiKeyId?: string | null;
}): Promise<string> {
  const keyId = ctx.apiKeyId;
  if (!keyId)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Hub Protocol key required.",
    });
  const key = await db.query.apiKeys.findFirst({
    columns: { userId: true },
    where: eq(apiKeys.id, keyId),
  });
  if (!key)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Hub Protocol key required.",
    });
  return key.userId;
}

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
  /**
   * Human-readable provider type. Also carries the agent-system "kind"
   * (synap | remote | local) — represented WITHOUT a new column via the
   * existing provider_type column + metadata.kind. No migration required.
   */
  providerType: z
    .enum(["openai", "anthropic", "self-hosted", "custom"])
    .optional(),
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

      const id = generateId();
      const [service] = await db
        .insert(intelligenceServices)
        .values({
          id,
          serviceId: input.serviceId,
          name: input.name,
          description: input.description,
          version: input.version,
          webhookUrl: input.webhookUrl,
          apiKey: encryptServiceKey(input.apiKey, {
            column: "intelligence_services.api_key",
            rowId: id,
          }),
          capabilities: input.capabilities,
          pricing: input.pricing || "free",
          providerType: input.providerType ?? "custom",
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
   * Switch the pod's default intelligence service — flips the `is_default` flag
   * the resolver picks when no workspace/user preference applies.
   */
  setDefault: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ input }) => {
      await setDefaultIntelligenceService(input.serviceId);
      return { success: true, serviceId: input.serviceId };
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

      const [services, podDefault] = await Promise.all([
        db.query.intelligenceServices.findMany({
          where: conditions.length > 0 ? and(...conditions) : undefined,
          orderBy: (services, { desc }) => [desc(services.createdAt)],
        }),
        // The row a space with no pin routes to — the resolver's OWN pod-default
        // selector (is_default, else failover), never a re-derived flag read.
        // `null` = the env service (step 5), which is no registered row, so
        // every row is then honestly not the default.
        selectPodDefaultService(),
      ]);

      // Don't expose API keys in list
      return services.map((s) => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        description: s.description,
        version: s.version,
        capabilities: s.capabilities,
        pricing: s.pricing,
        providerType: s.providerType,
        /** Agent-system kind lives in metadata.kind (synap | remote | local) */
        metadata: s.metadata,
        status: s.status,
        enabled: s.enabled,
        /** The pod default: what a space with no pinned service routes to. */
        isDefault: podDefault !== null && podDefault.id === s.id,
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
      const safe = Object.fromEntries(
        Object.entries(service).filter(([k]) => k !== "_apiKey")
      ) as typeof service;
      return safe;
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
          apiKey: encryptServiceKey(input.newApiKey, {
            column: "intelligence_services.api_key",
            rowId: input.id,
          }),
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
      // Owner/admin only — the SAME floor `workspaces.setIntelligenceService`
      // applies to the same `settings.intelligenceServiceId` key. Without it any
      // member could re-route a space's AI. `ctx.workspaceRole` is the role
      // `workspaceProcedure` already read from the membership row.
      if (ctx.workspaceRole !== "owner" && ctx.workspaceRole !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only workspace owner or admin can change intelligence service",
        });
      }

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

      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
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
            Record<string, string> | undefined) ?? {};
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
            Record<string, string> | undefined) ?? {};
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
      // Shared singleton — see note above.
      const disconnectEventRepo = eventRepository;
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
   * this workspace, allowing the AI to call tools exposed by the service.
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

  /**
   * Service Config Pull — called by an intelligence service on startup.
   *
   * The service authenticates with its Hub Protocol API key. This endpoint
   * decrypts and returns the bootstrap environment variables stored for that
   * key by storeServiceSecret, so the container only needs SYNAP_HUB_API_KEY to start.
   *
   * Auth: Hub Protocol API key (hub-protocol.read scope)
   */
  getServiceConfig: scopedProcedure(["hub-protocol.read"]).query(
    async ({ ctx }) => {
      // The service config belongs to the KEY PRINCIPAL — never `ctx.userId`,
      // which `resolveKeyIdentity` remaps to the linked HUMAN for an agent key.
      // Reading by `ctx.userId` handed any /setup/agent key its human's latest
      // decrypted vault secret.
      const agentUserId = await resolveKeyPrincipalUserId(ctx);

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
          // Only a service bootstrap blob (stored with its serviceId by
          // storeServiceSecret), never any other secret.
          isNotNull(secrets.serviceId),
          isNull(secrets.deletedAt)
        ),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      if (!secret) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No service config found for this Hub Protocol key. None was stored via intelligenceRegistry.storeServiceSecret, or VAULT_SERVER_KEY may have changed.",
        });
      }

      const config = decryptConfig(
        {
          encryptedData: secret.encryptedData,
          iv: secret.iv,
          authTag: secret.authTag,
        },
        { column: "secrets.encrypted_data", rowId: secret.id }
      );

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
        /** Registered service ID */
        serviceId: z.string().min(1),
        /** The full config map to encrypt and store */
        config: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Stored under the KEY PRINCIPAL, the same owner getServiceConfig reads —
      // never `ctx.userId`, which is the linked human for an agent key.
      const agentUserId = await resolveKeyPrincipalUserId(ctx);

      if (!isServerVaultAvailable()) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "VAULT_SERVER_KEY is not configured — cannot store service secret.",
        });
      }

      const secretId = randomUUID();
      const blob = encryptConfig(input.config as Record<string, string>, {
        column: "secrets.encrypted_data",
        rowId: secretId,
      });
      const database = await getDb();
      const vaultRepo = new SecretsVaultRepository(
        database,
        new EventRepository(sql)
      );

      const secret = await vaultRepo.upsertServerSide(
        {
          id: secretId,
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
