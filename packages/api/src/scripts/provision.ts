/**
 * Provision Script — Control Plane Connection Manager
 *
 * Manages the connection between this pod and the Synap Control Plane.
 * Talks to the DB directly (no HTTP server required) — same pattern as provision-agent.ts.
 *
 * Actions:
 *   status     — Show current Control Plane connection status
 *   connect    — Initiate device authorization flow (open URL, approve in browser)
 *   disconnect — Remove Control Plane connection from DB
 *
 * Usage:
 *   ACTION=connect    CP_URL=https://control.synap.live node dist/scripts/provision.js
 *   ACTION=status     node dist/scripts/provision.js
 *   ACTION=disconnect node dist/scripts/provision.js
 *
 * Optional env vars:
 *   CP_URL       Control Plane URL (default: https://control.synap.live)
 */

import "dotenv/config";
import { getDb, eq } from "@synap/database";
import { workspaces } from "@synap/database/schema";

const action = process.env.ACTION ?? "status";
const cpUrl =
  process.env.CP_URL?.replace(/\/$/, "") ?? "https://control.synap.live";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getWorkspace() {
  const db = await getDb();
  const ws = await db.query.workspaces.findFirst();
  if (!ws) throw new Error("No workspace found on this pod");
  return ws;
}

function getControlPlaneSettings(
  ws: Awaited<ReturnType<typeof getWorkspace>>
): Record<string, unknown> | undefined {
  const settings = (ws.settings as Record<string, unknown>) ?? {};
  return settings.controlPlane as Record<string, unknown> | undefined;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function runStatus() {
  const ws = await getWorkspace();
  const cp = getControlPlaneSettings(ws);

  if (!cp) {
    console.log("⚪  Not connected to Control Plane.");
    console.log("");
    console.log("Run with ACTION=connect to establish the connection.");
    return;
  }

  console.log("✅  Connected to Control Plane");
  console.log(`   URL:          ${cp.url}`);
  console.log(`   Pod ID:       ${cp.podId}`);
  console.log(`   Connected at: ${cp.connectedAt}`);
  console.log(`   Last ping:    ${cp.lastPingAt ?? "never"}`);
}

async function runConnect() {
  console.log(`\n🔗  Connecting pod to Control Plane Intelligence...`);
  console.log("");

  const cpApiKey = process.env.CP_API_KEY;
  const podId = process.env.POD_ID;

  if (!cpApiKey) {
    console.log("ℹ️   Two ways to connect:");
    console.log("");
    console.log("  Option 1 — Browser (recommended):");
    console.log("    Open the Browser → Settings → Intelligence → Connect");
    console.log(
      "    Your Control Plane account will provision intelligence access."
    );
    console.log("");
    console.log("  Option 2 — CLI with API key:");
    console.log(
      "    Set CP_API_KEY=<your-control-plane-api-key> and POD_ID=<your-pod-id>"
    );
    console.log(
      `    Then run: ACTION=connect CP_URL=${cpUrl} CP_API_KEY=<key> POD_ID=<id> pnpm provision`
    );
    console.log("");
    return;
  }

  if (!podId) {
    console.error(
      "❌  POD_ID environment variable is required (your pod's ID in the Control Plane)."
    );
    process.exit(1);
  }

  console.log(`   Calling Control Plane at: ${cpUrl}`);
  console.log(`   Pod ID: ${podId}`);
  console.log("");

  // Call CP to provision intelligence for this pod
  let provisionResp: {
    success?: boolean;
    keyPrefix?: string;
    hubUrl?: string;
    error?: string;
  };
  try {
    const res = await fetch(
      `${cpUrl}/intelligence/provisioning/provision-pod/${podId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cpApiKey}`,
        },
      }
    );
    provisionResp = (await res.json()) as typeof provisionResp;
    if (!res.ok) {
      throw new Error(provisionResp.error ?? `HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("❌  Failed to provision intelligence:");
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("✅  Intelligence service connected!");
  if (provisionResp.keyPrefix)
    console.log(`   Key prefix: ${provisionResp.keyPrefix}`);
  if (provisionResp.hubUrl) console.log(`   Hub URL: ${provisionResp.hubUrl}`);
  console.log("");
  console.log("The backend will receive the configuration automatically.");
  console.log("Restart the backend server to pick up the new credentials.");
}

async function runDisconnect() {
  const ws = await getWorkspace();
  const cp = getControlPlaneSettings(ws);

  if (!cp) {
    console.log("⚪  Not connected to Control Plane — nothing to disconnect.");
    return;
  }

  const db = await getDb();
  const settings = (ws.settings as Record<string, unknown>) ?? {};
  const { controlPlane: _removed, ...rest } = settings;

  await db
    .update(workspaces)
    .set({ settings: rest })
    .where(eq(workspaces.id, ws.id));

  console.log("✅  Disconnected from Control Plane.");
  console.log(`   Was connected to: ${cp.url as string}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const ACTIONS: Record<string, () => Promise<void>> = {
  status: runStatus,
  connect: runConnect,
  disconnect: runDisconnect,
};

const handler = ACTIONS[action];

if (!handler) {
  console.error(`❌  Unknown action: '${action}'`);
  console.error(`   Valid actions: ${Object.keys(ACTIONS).join(", ")}`);
  process.exit(1);
}

handler().catch((err: unknown) => {
  console.error(
    "❌  Unhandled error:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
