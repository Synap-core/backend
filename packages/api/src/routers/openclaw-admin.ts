import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { podAdminProcedure, router } from "../trpc.js";
import {
  and,
  db,
  drizzleSql,
  eq,
  intelligenceServices,
  sqlDrizzle,
} from "@synap/database";
import { apiKeys } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "openclaw-admin" });

const OPENCLAW_SERVICE_TYPE = "openclaw";
const OPENCLAW_CAPABILITIES = ["shell", "browser", "filesystem", "messaging"];

export const openclawAdminRouter = router({
  /**
   * Aggregated control-center state used by the admin UI.
   */
  getOverview: podAdminProcedure.query(async () => {
    const [workspace, registryService, agentUser] = await Promise.all([
      db.query.workspaces.findFirst({
        columns: { id: true, name: true, settings: true },
      }),
      db.query.intelligenceServices.findFirst({
        where: and(
          eq(intelligenceServices.enabled, true),
          eq(intelligenceServices.status, "active"),
          drizzleSql`${intelligenceServices.capabilities} ?| ${OPENCLAW_CAPABILITIES}`
        ),
        columns: {
          id: true,
          serviceId: true,
          name: true,
          version: true,
          webhookUrl: true,
          mcpEndpoint: true,
          mcpApproved: true,
          lastHealthCheck: true,
          lastHealthStatus: true,
          metadata: true,
          updatedAt: true,
        },
      }),
      findAnyAgentUser(),
    ]);

    if (!workspace) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace not found",
      });
    }

    const settings = (workspace.settings as Record<string, unknown>) ?? {};
    const controlPlane =
      (settings.controlPlane as Record<string, unknown>) ?? {};
    const links = extractOpenClawLinks(controlPlane, registryService?.metadata);
    const activeKeyCount = await countActiveAgentKeys(agentUser?.id ?? null);

    return {
      workspace: { id: workspace.id, name: workspace.name },
      deploymentModel: "hybrid-explicit" as const,
      lifecycleDomains: {
        infra: "synap-cli" as const,
        runtime: "openclaw-cli" as const,
      },
      openclaw: {
        provisioned: !!agentUser,
        registered: !!registryService,
        serviceType: OPENCLAW_SERVICE_TYPE,
        agentUserId: agentUser?.id ?? null,
        agentEmail: agentUser?.email ?? null,
        activeHubKeys: activeKeyCount,
        serviceId: registryService?.serviceId ?? null,
        displayName: registryService?.name ?? "OpenClaw",
        version: registryService?.version ?? null,
        webhookUrl: registryService?.webhookUrl ?? null,
        mcpEndpoint: registryService?.mcpEndpoint ?? null,
        mcpApproved: registryService?.mcpApproved ?? false,
        health: {
          lastCheckAt: registryService?.lastHealthCheck ?? null,
          status: registryService?.lastHealthStatus ?? "unknown",
        },
        links,
      },
      controlPlane: {
        url: typeof controlPlane.url === "string" ? controlPlane.url : null,
        podId:
          typeof controlPlane.podId === "string" ? controlPlane.podId : null,
        tier: typeof controlPlane.tier === "string" ? controlPlane.tier : null,
      },
      operations: {
        supportsManagedOps: false,
        notes:
          "Runtime restart/update/rollback are not automated in this pod API yet. Use Synap/OpenClaw CLI commands below.",
        commands: [
          "npx @synap-core/cli --help",
          "synap profiles enable openclaw",
          "synap services add openclaw",
          "synap services status openclaw",
          "synap services rotate openclaw",
          "npx @synap-core/cli openclaw doctor",
          "npx @synap-core/cli openclaw logs",
          "npx @synap-core/cli openclaw restart",
        ],
      },
    };
  }),

  validateConnection: podAdminProcedure.mutation(async () => {
    const service = await db.query.intelligenceServices.findFirst({
      where: and(
        eq(intelligenceServices.enabled, true),
        eq(intelligenceServices.status, "active"),
        drizzleSql`${intelligenceServices.capabilities} ?| ${OPENCLAW_CAPABILITIES}`
      ),
      columns: {
        id: true,
        serviceId: true,
        webhookUrl: true,
      },
    });

    if (!service) {
      return {
        ok: false,
        status: "not_registered" as const,
        checkedAt: new Date().toISOString(),
        message: "OpenClaw service is not registered in intelligence_services.",
      };
    }

    const checkedAt = new Date();
    const ping = await pingServiceHealth(service.webhookUrl);

    await db
      .update(intelligenceServices)
      .set({
        lastHealthCheck: checkedAt,
        lastHealthStatus: ping.ok ? "healthy" : "unhealthy",
        updatedAt: checkedAt,
      })
      .where(eq(intelligenceServices.id, service.id));

    logger.info(
      {
        serviceId: service.serviceId,
        ok: ping.ok,
      },
      "OpenClaw validateConnection executed"
    );

    return {
      ok: ping.ok,
      status: ping.ok ? ("healthy" as const) : ("unhealthy" as const),
      checkedAt: checkedAt.toISOString(),
      serviceId: service.serviceId,
      message: ping.message,
    };
  }),

  runDiagnostics: podAdminProcedure.mutation(async () => {
    const [service, provisionedAgent] = await Promise.all([
      db.query.intelligenceServices.findFirst({
        where: and(
          eq(intelligenceServices.enabled, true),
          eq(intelligenceServices.status, "active"),
          drizzleSql`${intelligenceServices.capabilities} ?| ${OPENCLAW_CAPABILITIES}`
        ),
        columns: {
          serviceId: true,
          webhookUrl: true,
          mcpEndpoint: true,
          mcpApproved: true,
          version: true,
          lastHealthStatus: true,
          lastHealthCheck: true,
        },
      }),
      findAnyAgentUser(),
    ]);

    const health = service
      ? await pingServiceHealth(service.webhookUrl)
      : { ok: false, message: "Service not registered" };

    return {
      checkedAt: new Date().toISOString(),
      checks: {
        agentProvisioned: !!provisionedAgent,
        serviceRegistered: !!service,
        webhookReachable: health.ok,
        mcpEndpointPresent: !!service?.mcpEndpoint,
        mcpApproved: service?.mcpApproved ?? false,
      },
      metadata: {
        serviceId: service?.serviceId ?? null,
        version: service?.version ?? null,
        webhookUrl: service?.webhookUrl ?? null,
        lastHealthStatus: service?.lastHealthStatus ?? null,
        lastHealthCheck: service?.lastHealthCheck ?? null,
      },
      message: health.message,
    };
  }),

  getHostedUiLink: podAdminProcedure.query(async () => {
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });

    const settings = (ws?.settings as Record<string, unknown>) ?? {};
    const controlPlane =
      (settings.controlPlane as Record<string, unknown>) ?? {};
    const openclawUi =
      typeof controlPlane.openclawUiUrl === "string"
        ? controlPlane.openclawUiUrl
        : null;

    return {
      url: openclawUi,
      available: !!openclawUi,
      fallback:
        "Use `npx @synap-core/cli openclaw open` or your configured OpenClaw dashboard URL.",
    };
  }),

  /**
   * Operational actions not yet automated in this API.
   * We return explicit guidance so UI can provide a deterministic operator path.
   */
  runRuntimeAction: podAdminProcedure
    .input(
      z.object({
        action: z.enum(["restart", "safe_update", "rollback"]),
      })
    )
    .mutation(async ({ input }) => {
      const actionToCommands: Record<
        "restart" | "safe_update" | "rollback",
        string[]
      > = {
        restart: [
          "npx @synap-core/cli openclaw restart",
          "synap restart openclaw",
          "synap logs openclaw",
        ],
        safe_update: [
          "synap update --with-openclaw",
          "npx @synap-core/cli openclaw doctor",
          "npx @synap-core/cli openclaw logs",
        ],
        rollback: [
          "docker compose logs openclaw",
          "synap services rotate openclaw",
          "npx @synap-core/cli openclaw configure",
        ],
      };

      return {
        automated: false,
        action: input.action,
        commands: actionToCommands[input.action],
        message:
          "This action is not automated by backend API yet; run the suggested command sequence.",
      };
    }),
});

async function findAnyAgentUser() {
  const rows = await db.execute(sqlDrizzle`
    SELECT u.id, u.email
    FROM users u
    INNER JOIN workspace_members wm ON wm.user_id = u.id
    WHERE u.user_type = 'agent'
      AND u.agent_metadata->>'agentType' = ${OPENCLAW_SERVICE_TYPE}
    LIMIT 1
  `);

  const record = rows[0] as { id: string; email: string } | undefined;
  return record ?? null;
}

async function countActiveAgentKeys(
  agentUserId: string | null
): Promise<number> {
  if (!agentUserId) return 0;

  const rows = await db
    .select({ count: sqlDrizzle<number>`count(*)` })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, agentUserId), eq(apiKeys.isActive, true)));

  return Number(rows[0]?.count ?? 0);
}

async function pingServiceHealth(webhookUrl: string) {
  try {
    const healthUrl = `${webhookUrl.replace(/\/+$/, "")}/health`;
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `Health endpoint returned HTTP ${response.status}`,
      };
    }
    return { ok: true, message: "Service reachable" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Health check failed",
    };
  }
}

function extractOpenClawLinks(
  controlPlane: Record<string, unknown>,
  metadata?: Record<string, unknown> | null
) {
  const metadataUi =
    metadata && typeof metadata.dashboardUrl === "string"
      ? metadata.dashboardUrl
      : null;
  const controlPlaneUi =
    typeof controlPlane.openclawUiUrl === "string"
      ? controlPlane.openclawUiUrl
      : null;

  return {
    hostedUiUrl: controlPlaneUi ?? metadataUi,
    docsUrl: "https://docs.synap.ai/openclaw",
  };
}
