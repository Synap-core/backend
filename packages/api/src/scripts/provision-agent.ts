/**
 * Provision Agent Script
 *
 * Directly provisions an agent service user + Hub Protocol API key in a workspace.
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
import { getDb, EventRepository, ApiKeyRepository, sql, drizzleSql, and, eq } from "@synap/database";
import { users, workspaceMembers, apiKeys, workspaces } from "@synap/database/schema";
import { SERVICE_CATALOG } from "../utils/agent-services/index.js";

const serviceType = process.env.SERVICE_TYPE;
const workspaceIdEnv = process.env.WORKSPACE_ID;
const adminEmail = process.env.ADMIN_EMAIL;
const action = process.env.ACTION || "provision";

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
  console.error(`Known service types: ${Object.keys(SERVICE_CATALOG).join(", ")}`);
  process.exit(1);
}

const entry = SERVICE_CATALOG[serviceType];
if (!entry) {
  console.error(`❌ ERROR: Unknown service type "${serviceType}"`);
  console.error(`Known types: ${Object.keys(SERVICE_CATALOG).join(", ")}`);
  process.exit(1);
}

if (!workspaceIdEnv && !adminEmail) {
  console.error("❌ ERROR: Either WORKSPACE_ID or ADMIN_EMAIL must be provided");
  process.exit(1);
}

async function resolveWorkspaceId(db: Awaited<ReturnType<typeof getDb>>): Promise<string> {
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
      console.log(`ℹ️  Resolved workspace: ${member.workspaceId} (from user ${adminEmail})`);
      return member.workspaceId;
    }

    // On fresh installs the admin user is in Kratos but not yet in the local DB
    // (they appear after first login). Fall through to first-workspace fallback.
    console.warn(`⚠️  User "${adminEmail}" not found in local DB (not logged in yet). Falling back to first workspace.`);
  }

  // Last resort: pick the first workspace in the DB (single-tenant self-hosted)
  const [first] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .limit(1);

  if (!first) {
    console.error("❌ ERROR: No workspaces found in database. Run the backend at least once to create the default workspace.");
    process.exit(1);
  }
  console.log(`ℹ️  Resolved workspace: ${first.id} ("${first.name}") — first workspace fallback`);
  return first.id;
}

async function findAgent(db: Awaited<ReturnType<typeof getDb>>, workspaceId: string) {
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
    .where(
      and(
        eq(users.userType, "agent"),
        drizzleSql`${users.agentMetadata}->>'agentType' = ${serviceType}`
      )
    )
    .limit(1);
  return row;
}

async function run() {
  const db = await getDb();
  const workspaceId = await resolveWorkspaceId(db);
  const podUrl = process.env.PUBLIC_URL || "http://localhost:4000";

  // ── status ──────────────────────────────────────────────────────────────
  if (action === "status") {
    const agent = await findAgent(db, workspaceId);
    if (!agent) {
      console.log(`${entry.displayName}: NOT provisioned in workspace ${workspaceId}`);
    } else {
      console.log(`${entry.displayName}: provisioned`);
      console.log(`   Agent User ID: ${agent.id}`);
      console.log(`   Agent Email:   ${agent.email}`);
      console.log(`   Workspace ID:  ${workspaceId}`);
    }
    process.exit(0);
  }

  // ── remove ───────────────────────────────────────────────────────────────
  if (action === "remove") {
    const agent = await findAgent(db, workspaceId);
    if (!agent) {
      console.error(`❌ ${entry.displayName} is not provisioned in workspace ${workspaceId}`);
      process.exit(1);
    }

    await db
      .update(apiKeys)
      .set({ isActive: false, revokedAt: new Date(), revokedReason: "Deprovisioned via CLI" })
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

    console.log(`✅ ${entry.displayName} agent deprovisioned`);
    process.exit(0);
  }

  // ── rotate ───────────────────────────────────────────────────────────────
  if (action === "rotate") {
    const agent = await findAgent(db, workspaceId);
    if (!agent) {
      console.error(`❌ ${entry.displayName} is not provisioned in workspace ${workspaceId}`);
      process.exit(1);
    }

    await db
      .update(apiKeys)
      .set({ isActive: false, revokedAt: new Date(), revokedReason: "Key rotated via CLI" })
      .where(eq(apiKeys.userId, agent.id));

    const keyPrefix =
      process.env.NODE_ENV === "production" ? "synap_hub_live_" : "synap_hub_test_";
    const plainKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;

    const eventRepo = new EventRepository(sql);
    const apiKeyRepo = new ApiKeyRepository(db, eventRepo);

    await apiKeyRepo.create(
      {
        keyName: `${entry.displayName} — workspace ${workspaceId} (rotated)`,
        keyPrefix,
        key: plainKey,
        scope: entry.defaultScopes,
        userId: agent.id,
      },
      "system"
    );

    console.log(`✅ ${entry.displayName} API key rotated`);
    console.log(`   New SYNAP_HUB_API_KEY="${plainKey}"`);
    console.log("");
    console.log("Docker run command:");
    console.log(entry.buildDockerCommand({ podUrl, workspaceId, agentUserId: agent.id, apiKey: plainKey }));
    console.log("");
    console.log("⚠️  The new key is shown ONCE. Store it securely.");
    process.exit(0);
  }

  // ── provision (default) ─────────────────────────────────────────────────
  const existing = await findAgent(db, workspaceId);
  if (existing) {
    console.log(`ℹ️  ${entry.displayName} agent already provisioned`);
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
    name: `${entry.displayName} Agent`,
    emailVerified: true,
    userType: "agent",
    agentMetadata: {
      agentType: serviceType,
      description: entry.description,
      createdByUserId: "system",
      capabilities: entry.agentCapabilities,
    } as any,
    timezone: "UTC",
    locale: "en",
  });

  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: agentId,
    role: entry.agentRole,
    invitedBy: null,
  });

  const keyPrefix =
    process.env.NODE_ENV === "production" ? "synap_hub_live_" : "synap_hub_test_";
  const plainKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;

  const eventRepo = new EventRepository(sql);
  const apiKeyRepo = new ApiKeyRepository(db, eventRepo);

  await apiKeyRepo.create(
    {
      keyName: `${entry.displayName} — workspace ${workspaceId}`,
      keyPrefix,
      key: plainKey,
      scope: entry.defaultScopes,
      userId: agentId,
    },
    "system"
  );

  console.log(`✅ ${entry.displayName} agent provisioned`);
  console.log("");
  console.log("Required environment variables:");
  console.log(`  SYNAP_POD_URL="${podUrl}"`);
  console.log(`  SYNAP_HUB_API_KEY="${plainKey}"`);
  console.log(`  SYNAP_WORKSPACE_ID="${workspaceId}"`);
  console.log(`  SYNAP_AGENT_USER_ID="${agentId}"`);
  console.log("");
  console.log("Docker run command:");
  console.log(entry.buildDockerCommand({ podUrl, workspaceId, agentUserId: agentId, apiKey: plainKey }));
  console.log("");
  console.log("⚠️  The API key above is shown ONCE. Store it securely.");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Fatal error:", err.message || err);
  process.exit(1);
});
