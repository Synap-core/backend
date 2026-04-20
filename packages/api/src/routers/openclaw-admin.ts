import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { podProcedure, router } from "../trpc.js";
import { db, sqlDrizzle } from "@synap/database";

const OPENCLAW_HUB_ID = "integration:openclaw";

export const openclawAdminRouter = router({
  /**
   * Aggregated control-center state used by the admin UI.
   * Checks for OpenClaw connection via api_keys (like raycast).
   */
  getOverview: podProcedure.query(async () => {
    const workspace = await db.query.workspaces.findFirst({
      columns: { id: true, name: true, settings: true },
    });

    if (!workspace) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace not found",
      });
    }

    const settings = (workspace.settings as Record<string, unknown>) ?? {};
    const controlPlane =
      (settings.controlPlane as Record<string, unknown>) ?? {};

    // Check BOTH: new api_keys approach AND old users table approach
    // New: hub_id = "integration:openclaw" in api_keys
    // Old: user_type = 'agent' AND agent_metadata->>'agentType' = 'openclaw' in users
    //       (the key is owned by that agent user)
    const newKeyRows = await db.execute(sqlDrizzle`
      SELECT k.id, k.user_id, k.created_at, k.last_used_at
      FROM api_keys k
      WHERE k.hub_id = ${OPENCLAW_HUB_ID}
        AND k.is_active = true
      ORDER BY k.created_at DESC
      LIMIT 1
    `);
    const newKey = newKeyRows[0] as
      | {
          id: string;
          user_id: string;
          created_at: Date;
          last_used_at: Date | null;
        }
      | undefined;

    // Check for old-style agent user (backwards compatibility)
    const oldAgentRows = await db.execute(sqlDrizzle`
      SELECT u.id, u.email
      FROM users u
      WHERE u.user_type = 'agent'
        AND u.agent_metadata->>'agentType' = 'openclaw'
      LIMIT 1
    `);
    const oldAgentUser = oldAgentRows[0] as
      | { id: string; email: string }
      | undefined;

    // If old agent exists, also check for their API key
    let oldAgentKey = null;
    if (oldAgentUser) {
      const oldKeyRows = await db.execute(sqlDrizzle`
        SELECT k.id, k.created_at, k.last_used_at
        FROM api_keys k
        WHERE k.user_id = ${oldAgentUser.id}
          AND k.key_type = 'hub_inbound'
          AND k.is_active = true
        ORDER BY k.created_at DESC
        LIMIT 1
      `);
      oldAgentKey = oldKeyRows[0];
    }

    const hasNewProvisioned = !!newKey;
    const hasOldProvisioned = !!oldAgentUser;
    const isProvisioned = hasNewProvisioned || hasOldProvisioned;

    const settingsLinks =
      typeof controlPlane.openclawUiUrl === "string"
        ? {
            hostedUiUrl: controlPlane.openclawUiUrl,
            docsUrl: "https://docs.synap.ai/openclaw",
          }
        : { hostedUiUrl: null, docsUrl: "https://docs.synap.ai/openclaw" };

    return {
      workspace: { id: workspace.id, name: workspace.name },
      deploymentModel: "hybrid-explicit" as const,
      lifecycleDomains: {
        infra: "synap-cli" as const,
        runtime: "openclaw-cli" as const,
      },
      openclaw: {
        provisioned: isProvisioned,
        registered: isProvisioned,
        serviceType: "openclaw",
        agentUserId: newKey?.user_id ?? oldAgentUser?.id ?? null,
        agentEmail: oldAgentUser?.email ?? null,
        activeHubKeys:
          (hasNewProvisioned ? 1 : 0) + (hasOldProvisioned ? 1 : 0),
        serviceId: null,
        displayName: "OpenClaw",
        version: null,
        webhookUrl: null,
        mcpEndpoint: null,
        mcpApproved: false,
        health: {
          lastCheckAt:
            newKey?.last_used_at ?? oldAgentKey?.last_used_at ?? null,
          status: isProvisioned ? "unknown" : "not_configured",
        },
        links: settingsLinks,
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

  /**
   * Validate/OpenClaw connection - checks both new and old provisioning.
   */
  validateConnection: podProcedure.mutation(async () => {
    // Check new approach
    const keys = await db.execute(sqlDrizzle`
      SELECT k.id FROM api_keys k
      WHERE k.hub_id = ${OPENCLAW_HUB_ID}
        AND k.is_active = true
      ORDER BY k.created_at DESC
      LIMIT 1
    `);

    // Check old approach (agent user)
    const oldAgent = await db.execute(sqlDrizzle`
      SELECT u.id FROM users u
      WHERE u.user_type = 'agent'
        AND u.agent_metadata->>'agentType' = 'openclaw'
      LIMIT 1
    `);

    if (!keys[0] && !oldAgent[0]) {
      return {
        ok: false,
        status: "not_provisioned" as const,
        checkedAt: new Date().toISOString(),
        message:
          "OpenClaw is not provisioned. Click 'Provision OpenClaw' to connect.",
      };
    }

    return {
      ok: true,
      status: "connected" as const,
      checkedAt: new Date().toISOString(),
      message: "OpenClaw is provisioned and connected.",
    };
  }),

  /**
   * Run diagnostics on OpenClaw setup.
   */
  runDiagnostics: podProcedure.mutation(async () => {
    // Check new approach
    const rows = await db.execute(sqlDrizzle`
      SELECT k.id, k.created_at, k.last_used_at, k.usage_count, k.scope
      FROM api_keys k
      WHERE k.hub_id = ${OPENCLAW_HUB_ID}
        AND k.is_active = true
      ORDER BY k.created_at DESC
      LIMIT 1
    `);
    const key = rows[0] as
      | {
          id: string;
          created_at: string;
          last_used_at: string | null;
          usage_count: number;
          scope: string[];
        }
      | undefined;

    // Check old approach
    const oldAgent = await db.execute(sqlDrizzle`
      SELECT u.id, u.email, u.created_at
      FROM users u
      WHERE u.user_type = 'agent'
        AND u.agent_metadata->>'agentType' = 'openclaw'
      LIMIT 1
    `);
    const oldUser = oldAgent[0] as
      | { id: string; email: string; created_at: string }
      | undefined;

    return {
      checkedAt: new Date().toISOString(),
      checks: {
        agentProvisioned: !!key || !!oldUser,
        serviceRegistered: !!key || !!oldUser,
        webhookReachable: false,
        mcpApproved: false,
      },
      metadata: {
        keyId: key?.id ?? null,
        createdAt: key?.created_at ?? null,
        lastUsedAt: key?.last_used_at ?? null,
        usageCount: key?.usage_count ?? 0,
        scopes: key?.scope ?? [],
      },
      message:
        key || oldUser ? "OpenClaw is configured." : "No OpenClaw key found.",
    };
  }),

  /**
   * Get the Docker run command for launching OpenClaw.
   */
  getDockerCommand: podProcedure.query(async () => {
    // Check new approach
    const keyRows = await db.execute(sqlDrizzle`
      SELECT k.id FROM api_keys k
      WHERE k.hub_id = ${OPENCLAW_HUB_ID}
        AND k.is_active = true
      ORDER BY k.created_at DESC
      LIMIT 1
    `);

    // Check old approach
    const oldAgent = await db.execute(sqlDrizzle`
      SELECT u.id FROM users u
      WHERE u.user_type = 'agent'
        AND u.agent_metadata->>'agentType' = 'openclaw'
      LIMIT 1
    `);

    if (!keyRows[0] && !oldAgent[0]) {
      return {
        status: "not_provisioned" as const,
        message:
          "OpenClaw is not provisioned. Click 'Provision OpenClaw' to generate an API key.",
        dockerCommand: null,
      };
    }

    const workspace = await db.query.workspaces.findFirst({
      columns: { id: true },
    });

    const workspaceId = workspace?.id ?? "pod-wide";
    const shortId = workspaceId.slice(0, 8);
    const podUrl = process.env.PUBLIC_URL || "http://localhost:4000";

    return {
      status: "provisioned" as const,
      message: oldAgent[0]
        ? "OpenClaw was provisioned with old method. Keys are managed via API Keys page."
        : "Copy and run the Docker command below. Replace YOUR_API_KEY with your OpenClaw API key.",
      dockerCommand: oldAgent[0]
        ? null
        : `# Run this command after provisioning OpenClaw:
docker run -d \\
  --name openclaw-${shortId} \\
  -e SYNAP_POD_URL="${podUrl}" \\
  -e SYNAP_HUB_API_KEY="YOUR_API_KEY" \\
  -e SYNAP_WORKSPACE_ID="${workspaceId}" \\
  ghcr.io/openclaw/openclaw:latest`,
      placeholderApiKey: oldAgent[0] ? null : "YOUR_API_KEY",
    };
  }),

  /**
   * Provision OpenClaw - redirects to Connections page for provisioning.
   */
  provisionOpenClaw: podProcedure.mutation(async () => {
    // Check both approaches
    const existingKeys = await db.execute(sqlDrizzle`
      SELECT k.id FROM api_keys k
      WHERE k.hub_id = ${OPENCLAW_HUB_ID}
        AND k.is_active = true
    `);
    const oldAgent = await db.execute(sqlDrizzle`
      SELECT u.id FROM users u
      WHERE u.user_type = 'agent'
        AND u.agent_metadata->>'agentType' = 'openclaw'
    `);

    if (existingKeys[0] || oldAgent[0]) {
      return {
        status: "already_provisioned" as const,
        message: "OpenClaw is already provisioned.",
        instructions:
          "View your API key on the API Keys page, or re-provision via Connections → Add Connection → OpenClaw.",
      };
    }

    return {
      status: "ready_to_provision" as const,
      message:
        "Go to Connections → Add Connection → select OpenClaw to generate your API key.",
    };
  }),

  getHostedUiLink: podProcedure.query(async () => {
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
  runRuntimeAction: podProcedure
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

  /**
   * ONE source of truth for OpenClaw status.
   */
  getStatus: podProcedure.query(async () => {
    const newKeyRows = await db.execute(sqlDrizzle`
      SELECT k.id, k.created_at, k.last_used_at
      FROM api_keys k
      WHERE k.hub_id = ${OPENCLAW_HUB_ID}
        AND k.is_active = true
      ORDER BY k.created_at DESC
      LIMIT 1
    `);
    const newKey = newKeyRows[0] as
      | { id: string; created_at: string; last_used_at: string | null }
      | undefined;

    const oldAgentRows = await db.execute(sqlDrizzle`
      SELECT u.id, u.email, u.created_at
      FROM users u
      WHERE u.user_type = 'agent'
        AND u.agent_metadata->>'agentType' = 'openclaw'
      LIMIT 1
    `);
    const oldAgent = oldAgentRows[0] as
      | { id: string; email: string; created_at: string }
      | undefined;

    let oldKey = null;
    if (oldAgent) {
      const oldKeyRows = await db.execute(sqlDrizzle`
        SELECT k.id, k.created_at, k.last_used_at
        FROM api_keys k
        WHERE k.user_id = ${oldAgent.id}
          AND k.key_type = 'hub_inbound'
          AND k.is_active = true
        LIMIT 1
      `);
      oldKey = oldKeyRows[0];
    }

    const isProvisioned = !!newKey || !!oldKey;

    return {
      provisioned: isProvisioned,
      method: newKey ? "new" : oldKey ? "old" : null,
      newKeyId: newKey?.id ?? null,
      oldAgentId: oldAgent?.id ?? null,
      oldAgentEmail: oldAgent?.email ?? null,
      message: isProvisioned ? "OpenClaw is provisioned." : "Not provisioned.",
    };
  }),
});
