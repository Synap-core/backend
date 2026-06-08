/**
 * Provision Agent Script
 *
 * Directly provisions an agent service user + Hub Protocol API key.
 * Workspace membership is an **RBAC anchor** for the agent user (required by schema);
 * Hub key scopes (see SERVICE_CATALOG) define what the agent can call on the pod.
 * Bypasses tRPC — talks to the DB directly via @synap/database.
 * Idempotent: prints existing agent info if already provisioned.
 *
 * Usage:
 *   SERVICE_TYPE=openclaw WORKSPACE_ID=<uuid> node dist/scripts/provision-agent.js
 *   SERVICE_TYPE=openclaw ADMIN_EMAIL=admin@example.com node dist/scripts/provision-agent.js
 *
 * Actions (ACTION env var):
 *   (default)  Provision the agent (idempotent)
 *   status     Print provisioning status
 *   remove     Deprovision (revoke keys + delete agent user)
 *   rotate     Rotate the Hub Protocol API key
 */

import "dotenv/config";
import { randomUUID, randomBytes } from "crypto";
import {
  getDb,
  EventRepository,
  ApiKeyRepository,
  sql,
  drizzleSql,
  and,
  eq,
} from "@synap/database";
import {
  users,
  workspaceMembers,
  apiKeys,
  workspaces,
  intelligenceServices,
  type AgentMetadata,
} from "@synap/database/schema";
import { SERVICE_CATALOG } from "../utils/agent-services/index.js";

const serviceType = process.env.SERVICE_TYPE;
const workspaceIdEnv = process.env.WORKSPACE_ID;
const adminEmail = process.env.ADMIN_EMAIL;
const action = process.env.ACTION || "provision";

// "list" action doesn't need SERVICE_TYPE — validated below for other actions
const entry = serviceType ? SERVICE_CATALOG[serviceType] : undefined;

if (action !== "list") {
  if (!serviceType) {
    console.error("❌ ERROR: SERVICE_TYPE environment variable is required");
    console.error("");
    console.error("Usage:");
    console.error(
      "  SERVICE_TYPE=openclaw WORKSPACE_ID=<uuid> node dist/scripts/provision-agent.js"
    );
    console.error(
      "  SERVICE_TYPE=openclaw ADMIN_EMAIL=admin@example.com node dist/scripts/provision-agent.js"
    );
    console.error("");
    console.error(
      `Known service types: ${Object.keys(SERVICE_CATALOG).join(", ")}`
    );
    process.exit(1);
  }

  if (!entry) {
    console.error(`❌ ERROR: Unknown service type "${serviceType}"`);
    console.error(`Known types: ${Object.keys(SERVICE_CATALOG).join(", ")}`);
    process.exit(1);
  }
}

// WORKSPACE_ID or ADMIN_EMAIL are optional — falls back to first workspace in DB.
// Fresh installs using token bootstrap have **no workspace** until /admin/bootstrap completes.

async function resolveWorkspaceId(
  db: Awaited<ReturnType<typeof getDb>>
): Promise<string> {
  if (workspaceIdEnv) return workspaceIdEnv;

  // Try ADMIN_EMAIL lookup first (user must have logged in at least once)
  if (adminEmail) {
    const [member] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(eq(users.email, adminEmail))
      .limit(1);

    if (member) {
      console.log(
        `ℹ️  Resolved workspace: ${member.workspaceId} (from user ${adminEmail})`
      );
      return member.workspaceId;
    }

    // On fresh installs the admin user is in Kratos but not yet in the local DB
    // (they appear after first login). Fall through to first-workspace fallback.
    console.warn(
      `⚠️  User "${adminEmail}" not found in local DB (not logged in yet). Falling back to first workspace.`
    );
  }

  // Last resort: pick the first workspace in the DB (single-tenant self-hosted)
  const [first] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .limit(1);

  if (!first) {
    const base = (process.env.PUBLIC_URL || "http://localhost:4000").replace(
      /\/$/,
      ""
    );
    console.error(
      "❌ ERROR: No workspaces found in the database yet — cannot attach the agent user."
    );
    console.error("");
    console.error("Typical causes:");
    console.error(
      "  • Admin bootstrap is still on token mode — finish the UI flow first, then retry."
    );
    console.error(`    Open: ${base}/admin/bootstrap`);
    console.error(
      "  • Or switch to pre-seed install (synap install …) so a first admin + workspace is created during install."
    );
    console.error("");
    console.error("After at least one workspace exists, run again:");
    console.error("  synap services add openclaw");
    process.exit(1);
  }
  console.log(
    `ℹ️  Resolved workspace: ${first.id} ("${first.name}") — first workspace fallback`
  );
  return first.id;
}

async function findWorkspaceOwner(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string
): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "owner")
      )
    )
    .limit(1);
  return row?.id ?? null;
}

async function findAgent(
  db: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string
) {
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, users.id),
        eq(workspaceMembers.workspaceId, workspaceId)
      )
    )
    .where(and(eq(users.userType, "agent"), eq(users.agentType, serviceType!)))
    .limit(1);
  return row;
}

const hr = "─".repeat(68);
const check = (v: boolean) => (v ? "✅" : "❌");

async function run() {
  const db = await getDb();
  const podUrl = process.env.PUBLIC_URL || "http://localhost:4000";

  // ── list ─────────────────────────────────────────────────────────────────
  if (action === "list") {
    const allAgents = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        agentMetadata: users.agentMetadata,
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
      })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(eq(users.userType, "agent"));

    if (allAgents.length === 0) {
      console.log("No agent services provisioned.");
      console.log(
        `Known types: ${Object.keys(SERVICE_CATALOG).join(", ")}\n` +
          `Run: synap services add <type>`
      );
      process.exit(0);
    }

    console.log(`\n${hr}`);
    console.log(` Provisioned Agent Services (${allAgents.length})`);
    console.log(hr);

    for (const agent of allAgents) {
      const meta = agent.agentMetadata as Record<string, unknown> | null;
      const agentType = (meta?.agentType as string) || "unknown";
      const catalogEntry = SERVICE_CATALOG[agentType];
      const displayName = catalogEntry?.displayName ?? agentType;

      const [keyRow] = await db
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, agent.id), eq(apiKeys.isActive, true)));

      const keyCount = keyRow?.count ?? 0;
      const keyStatus = keyCount > 0 ? `${keyCount} active ✅` : "none ❌";

      console.log(`\n  ${displayName}`);
      console.log(`    Type:       ${agentType}`);
      console.log(`    Agent ID:   ${agent.id}`);
      console.log(`    Workspace:  ${agent.workspaceId}`);
      console.log(`    Role:       ${agent.role}`);
      console.log(`    API Keys:   ${keyStatus}`);
    }

    console.log(`\n${hr}\n`);
    process.exit(0);
  }

  const workspaceId = await resolveWorkspaceId(db);
  // At this point action is one of: status, remove, rotate, provision — all require entry
  const e = entry!;

  // ── status ──────────────────────────────────────────────────────────────
  if (action === "status") {
    const agent = await findAgent(db, workspaceId);
    if (!agent) {
      console.log(
        `${entry!.displayName}: NOT provisioned in workspace ${workspaceId}`
      );
      console.log(`  Run: synap services add ${serviceType}`);
      process.exit(0);
    }

    // Active API keys
    const activeKeys = await db
      .select({ id: apiKeys.id, keyName: apiKeys.keyName })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, agent.id), eq(apiKeys.isActive, true)));

    // Intelligence service registration
    let service:
      | {
          serviceId: string;
          webhookUrl: string;
          mcpEndpoint: string | null;
          mcpApproved: boolean;
          status: string;
          lastHealthCheck: Date | null;
          lastHealthStatus: string | null;
        }
      | undefined;

    if (entry!.matchCapability) {
      const [svc] = await db
        .select({
          serviceId: intelligenceServices.serviceId,
          webhookUrl: intelligenceServices.webhookUrl,
          mcpEndpoint: intelligenceServices.mcpEndpoint,
          mcpApproved: intelligenceServices.mcpApproved,
          status: intelligenceServices.status,
          lastHealthCheck: intelligenceServices.lastHealthCheck,
          lastHealthStatus: intelligenceServices.lastHealthStatus,
        })
        .from(intelligenceServices)
        .where(
          drizzleSql`${intelligenceServices.capabilities} @> ${JSON.stringify([entry!.matchCapability])}::jsonb`
        )
        .limit(1);
      service = svc;
    }

    console.log(`\n${hr}`);
    console.log(` ${entry!.displayName} — Status`);
    console.log(hr);
    console.log(`  Provisioned:    ✅`);
    console.log(`  Agent ID:       ${agent.id}`);
    console.log(`  Agent Email:    ${agent.email}`);
    console.log(`  Workspace:      ${workspaceId}`);
    console.log(
      `  API Keys:       ${
        activeKeys.length > 0
          ? `${activeKeys.length} active ✅`
          : `none ❌  →  run: synap services rotate ${serviceType}`
      }`
    );

    console.log("");

    if (service) {
      const healthIcon =
        service.lastHealthStatus === "healthy"
          ? "✅"
          : service.lastHealthStatus === "degraded"
            ? "⚠️ "
            : service.lastHealthStatus
              ? "❌"
              : "—";

      let healthStr = "not yet checked";
      if (service.lastHealthCheck) {
        const ago = Math.round(
          (Date.now() - new Date(service.lastHealthCheck).getTime()) / 1000 / 60
        );
        healthStr = `${service.lastHealthStatus || "unknown"} (checked ${ago}m ago)`;
      }

      console.log(`  Service Registration:`);
      console.log(`    Connected:    ✅`);
      console.log(`    Service ID:   ${service.serviceId}`);
      console.log(`    Webhook:      ${service.webhookUrl}`);
      console.log(
        `    Status:       ${service.status === "active" ? "✅ active" : "⚠️  " + service.status}`
      );
      console.log(`    Health:       ${healthIcon} ${healthStr}`);
      if (service.mcpEndpoint) {
        console.log(`    MCP Endpoint: ${service.mcpEndpoint}`);
        console.log(`    MCP Approved: ${check(service.mcpApproved)}`);
        if (!service.mcpApproved) {
          console.log(
            `      → Approve via: synap services approve-mcp ${serviceType}`
          );
        }
      } else {
        console.log(`    MCP Endpoint: — (not registered)`);
      }
    } else {
      console.log(`  Service Registration: ❌ not connected`);
      console.log(
        `    The ${entry!.displayName} container has not registered itself.`
      );
      console.log(
        `    Ensure it is running with the correct SYNAP_POD_URL and SYNAP_HUB_API_KEY.`
      );
      console.log(`    Pod URL (current): ${podUrl}`);
    }

    console.log(`\n${hr}\n`);
    process.exit(0);
  }

  // ── remove ───────────────────────────────────────────────────────────────
  if (action === "remove") {
    const agent = await findAgent(db, workspaceId);
    if (!agent) {
      console.error(
        `❌ ${e.displayName} is not provisioned in workspace ${workspaceId}`
      );
      process.exit(1);
    }

    await db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedReason: "Deprovisioned via CLI",
      })
      .where(eq(apiKeys.userId, agent.id));

    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, agent.id),
          eq(workspaceMembers.workspaceId, workspaceId)
        )
      );

    await db.delete(users).where(eq(users.id, agent.id));

    console.log(`✅ ${e.displayName} agent deprovisioned`);
    process.exit(0);
  }

  // ── rotate ───────────────────────────────────────────────────────────────
  if (action === "rotate") {
    const agent = await findAgent(db, workspaceId);
    if (!agent) {
      console.error(
        `❌ ${e.displayName} is not provisioned in workspace ${workspaceId}`
      );
      process.exit(1);
    }

    await db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedReason: "Key rotated via CLI",
      })
      .where(eq(apiKeys.userId, agent.id));

    const keyPrefix =
      process.env.NODE_ENV === "production"
        ? "synap_hub_live_"
        : "synap_hub_test_";
    const plainKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;

    const eventRepo = new EventRepository(sql);
    const apiKeyRepo = new ApiKeyRepository(db, eventRepo);

    const rotateLinkedUserId = await findWorkspaceOwner(db, workspaceId);

    await apiKeyRepo.create(
      {
        keyName: `${e.displayName} — workspace ${workspaceId} (rotated)`,
        keyPrefix,
        key: plainKey,
        scope: e.defaultScopes,
        userId: agent.id,
        keyType: "hub_inbound",
        linkedUserId: rotateLinkedUserId,
        description: `Hub Protocol auth token for ${e.displayName} agent service. Used by the ${e.displayName} Docker container to authenticate inbound API calls to this Synap backend.`,
      },
      "system"
    );

    console.log(`✅ ${e.displayName} API key rotated`);
    console.log(`   New SYNAP_HUB_API_KEY="${plainKey}"`);
    console.log("");
    if (e.buildDockerCommand) {
      console.log("Docker run command:");
      console.log(
        e.buildDockerCommand({
          podUrl,
          workspaceId,
          agentUserId: agent.id,
          apiKey: plainKey,
        })
      );
      console.log("");
    }
    console.log("⚠️  The new key is shown ONCE. Store it securely.");
    process.exit(0);
  }

  // ── provision (default) ─────────────────────────────────────────────────
  const existing = await findAgent(db, workspaceId);
  if (existing) {
    console.log(`ℹ️  ${e.displayName} agent already provisioned`);
    console.log(`   Agent User ID: ${existing.id}`);
    console.log(`   Agent Email:   ${existing.email}`);
    console.log(`   Workspace ID:  ${workspaceId}`);
    console.log("");
    console.log("To get a fresh API key, run:");
    console.log(`  synap services rotate ${serviceType}`);
    process.exit(0);
  }

  const agentId = randomUUID();
  const shortId = agentId.slice(0, 8);
  const email = `agent-${serviceType}-${shortId}@synap.agent`;

  await db.insert(users).values({
    id: agentId,
    email,
    name: `${e.displayName} Agent`,
    emailVerified: true,
    userType: "agent",
    agentType: serviceType,
    createdByUserId: null,
    agentMetadata: {
      agentType: serviceType,
      description: e.description,
      createdByUserId: "system",
      capabilities: e.agentCapabilities,
    } as AgentMetadata,
    timezone: "UTC",
    locale: "en",
  });

  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: agentId,
    role: e.agentRole,
    invitedBy: null,
  });

  const linkedUserId = await findWorkspaceOwner(db, workspaceId);

  const keyPrefix =
    process.env.NODE_ENV === "production"
      ? "synap_hub_live_"
      : "synap_hub_test_";
  const plainKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;

  const eventRepo = new EventRepository(sql);
  const apiKeyRepo = new ApiKeyRepository(db, eventRepo);

  await apiKeyRepo.create(
    {
      keyName: `${e.displayName} — workspace ${workspaceId}`,
      keyPrefix,
      key: plainKey,
      scope: e.defaultScopes,
      userId: agentId,
      keyType: "hub_inbound",
      linkedUserId,
      description: `Hub Protocol auth token for ${e.displayName} agent service. Used by the ${e.displayName} Docker container to authenticate inbound API calls to this Synap backend.`,
    },
    "system"
  );

  console.log(`✅ ${e.displayName} agent provisioned`);
  console.log("");
  console.log("Required environment variables:");
  console.log(`  SYNAP_POD_URL="${podUrl}"`);
  console.log(`  SYNAP_HUB_API_KEY="${plainKey}"`);
  console.log(`  SYNAP_WORKSPACE_ID="${workspaceId}"`);
  console.log(`  SYNAP_AGENT_USER_ID="${agentId}"`);
  console.log("");
  if (e.buildDockerCommand) {
    console.log("Docker run command:");
    console.log(
      e.buildDockerCommand({
        podUrl,
        workspaceId,
        agentUserId: agentId,
        apiKey: plainKey,
      })
    );
    console.log("");
  }
  console.log("⚠️  The API key above is shown ONCE. Store it securely.");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Fatal error:", err.message || err);
  process.exit(1);
});
