#!/usr/bin/env node
/**
 * Hub Protocol drift detector
 *
 * Compares REST routes declared in the backend against methods in HubRestClient.
 * Exit 0 = no actionable gaps, Exit 1 = uncovered non-infra routes found.
 *
 * Usage: node check-drift.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REST_DIR = join(__dirname, "../api/src/routers/hub-protocol/rest");
const CLIENT_FILE = join(__dirname, "src/client.ts");

// Routes that are intentionally server-only and don't need a client method.
// These are infra, internal, or push-only endpoints not called from surfaces.
const SERVER_ONLY = new Set([
  "/health",
  "/manifest",
  "/auth/status",
  "/events",
  "/events/stream",
  "/background-tasks",
  "/background-tasks/{id}",
  "/compacted-states",
  "/compacted-states/latest",
  "/compacted-states/{stateId}",
  "/sessions",
  "/sessions/getOrCreate",
  "/sessions/{sessionId}",
  "/sessions/{sessionId}/close",
  "/terminal/logs",
  "/mcp-servers",
  "/agents/sync",
  "/entity-share/deliver",
  "/webhooks",
  "/webhooks/{id}",
  // Messaging routes are consumed by Eve/Hestia CLI which has its own typed client
  "/messaging/accounts",
  "/messaging/accounts/sync",
  "/messaging/accounts/{accountId}",
  "/messaging/auth-url",
  "/messaging/conversations",
  "/messaging/linked-unread",
  "/messaging/service-config",
  "/messaging/service-config/migrate",
  // Skills are internal IS orchestration — not called from external surfaces
  "/skills/createSkill",
  "/skills/getSkill",
  "/skills/getSkills",
  "/skills/system",
  // Security vault — server-to-server only
  "/vault/request",
  // Widget definitions are fetched by the UI layer (synap-app) directly via tRPC
  "/widget-definitions",
  // Knowledge base is queried via IS hub tools, not directly from surfaces
  "/knowledge",
  "/knowledge/{key}",
  // Connectors are managed through the synap-app UI, not CLI/Raycast surfaces
  "/connectors/actions",
]);

// ── Collect all declared REST paths ──────────────────────────────────────────
const routeFiles = readdirSync(REST_DIR).filter((f) => f.endsWith(".ts"));
const allPaths = new Set();

for (const file of routeFiles) {
  const src = readFileSync(join(REST_DIR, file), "utf-8");
  for (const m of src.matchAll(/path:\s*"(\/[^"]+)"/g)) {
    allPaths.add(m[1]);
  }
}

// ── Collect all public async method names from client ────────────────────────
const clientSrc = readFileSync(CLIENT_FILE, "utf-8");
const clientMethods = new Set(
  [...clientSrc.matchAll(/^\s+async ([a-zA-Z]+)\(/gm)].map((m) => m[1].toLowerCase())
);

// ── Coverage heuristic ────────────────────────────────────────────────────────
// Extract significant segments from a path; normalize plural → singular.
function normalize(s) {
  return s.toLowerCase().replace(/-/g, "").replace(/s$/, "");
}

function pathKeywords(path) {
  return path
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .flatMap((s) => s.split("-"))
    .filter((s) => s.length >= 3)
    .map(normalize);
}

function isCovered(path) {
  const keywords = pathKeywords(path);
  if (keywords.length === 0) return true;
  return keywords.some((kw) => {
    for (const method of clientMethods) {
      if (method.includes(kw)) return true;
    }
    return false;
  });
}

const serverOnly = [];
const covered = [];
const uncovered = [];

for (const path of [...allPaths].sort()) {
  if (SERVER_ONLY.has(path)) {
    serverOnly.push(path);
  } else if (isCovered(path)) {
    covered.push(path);
  } else {
    uncovered.push(path);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const clientCount = [...allPaths].filter((p) => !SERVER_ONLY.has(p)).length;
console.log("\nHub Protocol Drift Report");
console.log("=========================");
console.log(`Routes: ${allPaths.size} total | ${serverOnly.length} server-only | ${covered.length} client-covered | ${uncovered.length} gaps\n`);

if (uncovered.length > 0) {
  console.log("Uncovered routes (consider adding to HubRestClient):");
  for (const p of uncovered) console.log(`  ! ${p}`);
  console.log(
    "\nACTION: Add a method to HubRestClient for each '!' route, or add it to SERVER_ONLY in check-drift.mjs if it's infra-only."
  );
  process.exit(1);
} else {
  console.log(`✓ No drift detected — all ${covered.length} client-facing routes are covered.`);
  console.log(`  (${serverOnly.length} server-only infra routes intentionally excluded)`);
  process.exit(0);
}
