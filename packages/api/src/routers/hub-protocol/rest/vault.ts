/**
 * Hub Protocol REST — vault (AI requests vault access via proposal)
 */

import { db } from "@synap/database";

import { NotificationService } from "../../../notifications/NotificationService.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  VaultRequestRequestSchema,
  VaultRequestResponseSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

export function registerVaultRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/vault/request",
    tags: ["Vault"],
    summary: "Request a secret from the Vault",
    description:
      "AI requests access to a vault secret — creates a pending proposal and emits an urgent notification for user approval.",
    request: {
      body: VaultRequestRequestSchema,
    },
    responses: {
      200: {
        description: "Pending proposal id",
        schema: VaultRequestResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /vault/request
   * AI requests access to a vault secret — creates a proposal for user approval.
   */
  app.post("/vault/request", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json()) as {
      workspaceId?: string;
      agentUserId?: string;
      channelId?: string;
      sourceMessageId?: string;
      secretType: string;
      service: string;
      purpose: string;
      accessLevel?: string;
      ttl?: number;
    };

    if (!body.secretType || !body.service || !body.purpose) {
      return c.json(
        { error: "secretType, service, and purpose are required" },
        400
      );
    }

    const userId = (body.agentUserId as string) ?? (c.get("userId") as string);
    const workspaceId =
      (body.workspaceId as string | null | undefined) ??
      c.req.header("x-workspace-id") ??
      null;

    const accessLevel = body.accessLevel ?? "read";
    const ttl = body.ttl ?? 60;

    try {
      const { proposals, ProposalStatus } =
        await import("@synap/database/schema");
      const { randomUUID } = await import("crypto");
      const id = randomUUID();
      const [row] = await db
        .insert(proposals)
        .values({
          id,
          workspaceId,
          targetType: "vault",
          targetId: `${body.service}:${body.secretType}`,
          proposalType: "vault.request",
          data: {
            secretType: body.secretType,
            service: body.service,
            purpose: body.purpose,
            accessLevel,
            ttl,
            requestedBy: "ai",
            _summary: `AI requests ${body.secretType} for ${body.service}: ${body.purpose}`,
          },
          status: ProposalStatus.PENDING,
          agentUserId: userId ?? null,
          threadId: body.channelId ?? null,
          sourceMessageId: body.sourceMessageId ?? null,
          createdBy: userId ?? null,
        })
        .returning({ id: proposals.id });

      // Emit urgent notification — shows as banner (not toast) in the UI
      NotificationService.create({
        workspaceId: workspaceId ?? null,
        userId,
        type: "ai_request.vault_access",
        sourceType: "proposal",
        sourceId: row.id,
        data: {
          secretType: body.secretType,
          service: body.service,
          purpose: body.purpose,
          proposalId: row.id,
        },
      }).catch(() => {});

      return c.json({
        status: "pending",
        proposalId: row.id,
        message: `Vault secret request created. Awaiting user approval.`,
      });
    } catch (err) {
      logger.error({ err, workspaceId }, "vault.request failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
