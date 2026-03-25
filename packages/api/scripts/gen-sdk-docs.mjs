/**
 * gen-sdk-docs.mjs
 *
 * Generates a markdown API reference for the Synap SDK by scanning tRPC router files.
 * Extracts procedure names (query/mutation), JSDoc descriptions, and input shapes.
 *
 * Output: users-docs/docs/reference/api-reference.md (relative to monorepo root)
 *
 * Usage:
 *   node scripts/gen-sdk-docs.mjs
 *   # or from monorepo root:
 *   pnpm --filter @synap/api gen-docs
 */

import { readFileSync, writeFileSync, readdirSync, realpathSync } from "fs";
import { resolve, join, basename } from "path";

const ROUTERS_DIR = resolve("src/routers");
const REAL_SCRIPT_DIR = realpathSync(resolve("."));
// synap-backend/packages/api → packages → synap-backend → synap root → users-docs
const OUT_FILE = join(REAL_SCRIPT_DIR, "../../..", "users-docs/docs/reference/api-reference.md");

// Routers to document (excludes internal/hub/test files)
const EXCLUDED = new Set([
  "hub-protocol-rest.ts",
  "hub-protocol.ts",
  "hub-transform.ts",
  "hub-utils.ts",
  "hub.ts",
  "hub.test.ts",
  "webhooks.test.ts",
]);

const EXCLUDED_PREFIXES = ["hub-protocol/", "intelligence/", "n8n/"];

// Friendly labels for each router
const ROUTER_LABELS = {
  "entities.ts": "Entities",
  "entities-data.ts": "Entity Data",
  "views.ts": "Views",
  "channels.ts": "Channels",
  "chat.ts": "Chat & Messages",
  "profiles.ts": "Profiles",
  "property-defs.ts": "Property Definitions",
  "relation-defs.ts": "Relation Definitions",
  "relations.ts": "Relations",
  "workspaces.ts": "Workspaces",
  "users.ts": "Users",
  "api-keys.ts": "API Keys",
  "search.ts": "Search",
  "files.ts": "Files",
  "file-upload.ts": "File Upload",
  "documents.ts": "Documents",
  "proposals.ts": "Proposals",
  "automations.ts": "Automations",
  "skills.ts": "Skills & Commands",
  "intelligence.ts": "Intelligence (AI)",
  "agent-users.ts": "Agent Users",
  "agent-configs.ts": "Agent Configs",
  "notif-center.ts": "Notifications",
  "preferences.ts": "Preferences",
  "secrets-vault.ts": "Vault",
  "connectors-trpc.ts": "Connectors",
  "webhooks.ts": "Webhooks",
  "templates.ts": "Templates",
  "capabilities.ts": "Capabilities & Cells",
  "widget-definitions.ts": "Widget Definitions",
  "content.ts": "Content",
  "capture.ts": "Quick Capture",
  "inbox.ts": "Inbox",
  "events.ts": "Events",
  "graph.ts": "Graph",
  "whiteboards.ts": "Whiteboards",
  "projects.ts": "Projects",
  "roles.ts": "Roles",
  "sharing.ts": "Sharing",
  "setup.ts": "Workspace Setup",
  "system.ts": "System",
  "health.ts": "Health",
  "suggestions.ts": "Suggestions",
  "message-links.ts": "Message Links",
  "typesense.ts": "Search Index",
  "mcp-servers.ts": "MCP Servers",
  "import.ts": "Import",
  "background-tasks.ts": "Background Tasks",
  "channel-gateway.ts": "Channel Gateway",
  "profile-properties.ts": "Profile Properties",
  "profile-relations.ts": "Profile Relations",
};

/**
 * Extract the first JSDoc block comment before a procedure definition.
 */
function extractJsDoc(lines, lineIndex) {
  const comments = [];
  let i = lineIndex - 1;
  while (i >= 0 && (lines[i].trim().startsWith("*") || lines[i].trim() === "*/")) {
    comments.unshift(lines[i].trim().replace(/^\*+\s?/, "").replace(/^\/\*\*/, "").trim());
    i--;
  }
  if (i >= 0 && lines[i].trim().startsWith("/**")) {
    comments.unshift("");
  }
  return comments
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\/\s*$/, "")   // strip trailing slash from */
    .replace(/^[*\/]+/, "")
    .trim();
}

/**
 * Parse a router file and extract procedure definitions.
 */
function parseRouter(filePath) {
  const source = readFileSync(filePath, "utf-8");
  const lines = source.split("\n");
  const procedures = [];

  // Match: procedureName: procedure.query(...) or procedureName: procedure.mutation(...)
  const RE = /^\s{0,4}(\w+):\s*(workspaceProcedure|protectedProcedure|publicProcedure|procedure)\s*\.\s*(query|mutation|subscription)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(RE);
    if (!match) continue;
    const [, name, , type] = match;

    // Skip internal/system procedures
    if (name.startsWith("_")) continue;

    // Look for .input( on next few lines
    let inputShape = "";
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const inputMatch = lines[j].match(/\.input\(([^)]{1,80})/);
      if (inputMatch) {
        inputShape = inputMatch[1].trim();
        break;
      }
    }

    // Look for JSDoc above
    const doc = extractJsDoc(lines, i);

    procedures.push({ name, type, doc, inputShape });
  }

  return procedures;
}

/**
 * Determine the router key from the exported router name in the file.
 */
function getRouterKey(filePath) {
  const source = readFileSync(filePath, "utf-8");
  // e.g. export const entitiesRouter = router({
  const match = source.match(/export\s+const\s+(\w+Router)\s*=/);
  if (match) {
    // entitiesRouter → entities
    return match[1].replace(/Router$/, "");
  }
  return basename(filePath, ".ts").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function formatProcedure(proc, routerKey) {
  const call = `${routerKey}.${proc.name}`;
  const lines = [];
  lines.push(`#### \`${call}\` <span class="badge badge--${proc.type === "query" ? "info" : "warning"}">${proc.type}</span>`);
  lines.push("");
  if (proc.doc) {
    lines.push(proc.doc);
    lines.push("");
  }
  if (proc.inputShape) {
    lines.push("```typescript");
    lines.push(`useSynap().${call}.${proc.type === "query" ? "useQuery" : "useMutation"}(${proc.inputShape})`);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

// Main
const files = readdirSync(ROUTERS_DIR)
  .filter((f) => f.endsWith(".ts") && !EXCLUDED.has(f) && !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)));

const sections = [];

for (const file of files.sort()) {
  const filePath = join(ROUTERS_DIR, file);
  const procedures = parseRouter(filePath);
  if (procedures.length === 0) continue;

  const label = ROUTER_LABELS[file] || basename(file, ".ts");
  const routerKey = getRouterKey(filePath);

  const section = [
    `### ${label}`,
    "",
    `> Router key: \`${routerKey}\``,
    "",
    ...procedures.map((p) => formatProcedure(p, routerKey)),
  ].join("\n");

  sections.push(section);
}

const output = `---
sidebar_position: 1
---

# API Reference

> **Auto-generated** from tRPC router definitions. Do not edit manually — run \`pnpm gen-docs\` in \`synap-backend/packages/api\` to regenerate.

This page lists every tRPC procedure exposed by the Synap data pod. All procedures are callable via \`@synap/sdk\` (vanilla JS) or \`@synap/react\` hooks.

## How to read this page

- **query** — use \`.useQuery(input)\` (React) or \`.query(input)\` (vanilla)
- **mutation** — use \`.useMutation()\` (React) or \`.mutate(input)\` (vanilla)
- **Router key** — the first segment in the call chain, e.g. \`entities.list\`

\`\`\`typescript
// Vanilla JS
import { createSynapClient } from "@synap/sdk";
const synap = createSynapClient({ podUrl, apiKey, workspaceId });
const result = await synap.entities.list.query({ limit: 20 });

// React
import { useSynap } from "@synap/react";
const { data } = useSynap().entities.list.useQuery({ limit: 20 });
\`\`\`

---

${sections.join("\n\n---\n\n")}

---

*Generated ${new Date().toISOString().slice(0, 10)} from \`synap-backend/packages/api/src/routers/\`*
`;

writeFileSync(OUT_FILE, output, "utf-8");
console.log(`✅  API reference written to ${OUT_FILE} (${sections.length} routers, ${sections.reduce((n, s) => n + (s.match(/^####/gm) || []).length, 0)} procedures)`);
