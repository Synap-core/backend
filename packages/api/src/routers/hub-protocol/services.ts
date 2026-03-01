/**
 * Hub Protocol — Services Router
 *
 * Allows external intelligence services (OpenClaw, ZeroClaw, custom agents)
 * to self-register as intelligence services on this Data Pod using only a
 * Hub Protocol API key — no Kratos session required.
 *
 * This solves the control plane provisioning gap: the old intelligenceRegistry.register
 * procedure required Kratos session auth, which the control plane cannot provide when
 * calling from server-to-server with a Hub Protocol API key.
 *
 * Security model:
 * - Requires hub-protocol.write scope
 * - The registering service is auto-approved for MCP (mcpApproved: true) because
 *   it is authenticating with a key that was provisioned by Synap's own control plane
 *   or the workspace owner — this is a trusted provisioning path.
 * - For externally-registered services (manual key creation), use intelligenceRegistry.register
 *   + the admin approveMcp procedure to explicitly approve MCP tools after review.
 * - SSRF guard: webhookUrl and mcpEndpoint are validated before storing.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { TRPCError } from "@trpc/server";
import { db, eq } from "@synap/database";
import { intelligenceServices } from "@synap/database/schema";
import { validateExternalUrl } from "../../utils/validate-url.js";
import { createLogger } from "@synap-core/core";
import { encryptServiceKey } from "../../utils/service-key-crypto.js";

const logger = createLogger({ module: "hub-protocol-services" });

/** Simple ID generator matching intelligence-registry.ts pattern */
const generateId = () =>
  `svc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const servicesRouter = router({
  /**
   * Register or update an intelligence service on this Data Pod.
   *
   * Called by the Synap control plane during OpenClaw/ZeroClaw provisioning.
   * Idempotent: if the serviceId already exists, it is updated in-place.
   *
   * The service is auto-approved for MCP tool injection (mcpApproved: true)
   * because registration via Hub Protocol implies the key was issued by a
   * trusted provisioner (control plane or workspace owner).
   */
  register: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        serviceId: z.string().min(1).max(128),
        name: z.string().min(1).max(255),
        description: z.string().max(1024).optional(),
        /** URL where this service receives chat stream requests */
        webhookUrl: z.string().url(),
        /** Optional MCP server URL — tools exposed to Synap AI via MCP */
        mcpEndpoint: z.string().url().optional(),
        capabilities: z.array(z.string()).min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // SSRF guard on webhookUrl
      const webhookCheck = validateExternalUrl(input.webhookUrl);
      if (!webhookCheck.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `webhookUrl is not safe: ${webhookCheck.reason}`,
        });
      }

      // SSRF guard on mcpEndpoint if provided
      if (input.mcpEndpoint) {
        const mcpCheck = validateExternalUrl(input.mcpEndpoint);
        if (!mcpCheck.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `mcpEndpoint is not safe: ${mcpCheck.reason}`,
          });
        }
      }

      const existing = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId),
      });

      if (existing) {
        // Idempotent update — re-registration on pod redeploy or service restart
        await db
          .update(intelligenceServices)
          .set({
            name: input.name,
            description: input.description,
            webhookUrl: input.webhookUrl,
            mcpEndpoint: input.mcpEndpoint ?? existing.mcpEndpoint,
            capabilities: input.capabilities,
            status: "active",
            enabled: true,
            // Keep mcpApproved as-is (preserves admin decisions on re-registration).
            // First-time Hub Protocol registration already set it to true — preserve that.
            metadata: {
              ...((existing.metadata as Record<string, unknown>) ?? {}),
              ...(input.metadata ?? {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(intelligenceServices.serviceId, input.serviceId));

        logger.info(
          { serviceId: input.serviceId, callerUserId: ctx.userId },
          "Intelligence service updated via Hub Protocol"
        );

        return { serviceId: input.serviceId, status: "updated" as const };
      }

      // New registration — trusted Hub Protocol path auto-approves MCP
      const id = generateId();
      await db.insert(intelligenceServices).values({
        id,
        serviceId: input.serviceId,
        name: input.name,
        description: input.description,
        webhookUrl: input.webhookUrl,
        mcpEndpoint: input.mcpEndpoint,
        // Placeholder key — the service authenticates TO us via Hub Protocol key,
        // the apiKey column here is for callbacks from Synap to the service.
        apiKey: encryptServiceKey(ctx.apiKeyId ?? id),
        capabilities: input.capabilities,
        pricing: "free",
        status: "active",
        enabled: true,
        // Hub Protocol registration = trusted provisioning path → auto-approve MCP tools
        mcpApproved: true,
        metadata: {
          ...(input.metadata ?? {}),
          registeredVia: "hub-protocol",
          registeredByUserId: ctx.userId,
          registeredAt: new Date().toISOString(),
        },
      });

      logger.info(
        {
          serviceId: input.serviceId,
          callerUserId: ctx.userId,
          capabilities: input.capabilities,
        },
        "Intelligence service registered via Hub Protocol"
      );

      return { serviceId: input.serviceId, status: "registered" as const };
    }),
});
