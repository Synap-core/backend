/**
 * Hub Protocol REST — skills
 */

import fs from "fs";
import path from "path";

import { createRoute, z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { hasScope, type HubHono } from "./_shared.js";

// ── System skill packages (static documentation served to text agents) ────────

const FALLBACK_SYNAP = `# synap — Core Data, Memory & Governance

Auth header on every request: \`Authorization: Bearer $SYNAP_API_KEY\`
Base URL: \`$HUB_BASE_URL/api/hub\`

---

## Orientation (call first)

### GET /users/me
Who am I and what scopes do I have.

### GET /workspaces
List all workspaces accessible to the authenticated user.

### GET /profiles
List entity types. Built-in slugs: \`task\`, \`note\`, \`person\`, \`company\`, \`event\`,
\`contact\`, \`deal\`, \`project\`, \`bookmark\`, \`capture\`, \`website\`, \`article\`,
\`file\`, \`anchor\` — plus any custom profiles created in this workspace.

---

## Entities

### POST /entities
Create an entity.

\`\`\`json
{
  "profileSlug": "task",
  "name": "Finish the proposal",
  "properties": { "status": "todo", "priority": "high" },
  "workspaceId": "ws_abc"
}
\`\`\`

Supports \`Idempotency-Key\` header. Returns the created entity with its \`id\`.

### GET /entities?q=&profileSlug=&workspaceId=&limit=
Search / list entities. Params:
- \`q\` — full-text query (optional)
- \`profileSlug\` — filter by entity type (optional)
- \`workspaceId\` — scope to workspace (optional; omit for pod-wide types)
- \`limit\` — max results (default 20)

### GET /entities/:id
Fetch a single entity by ID.

### PUT /entities/:id
Merge-patch entity properties.

\`\`\`json
{ "properties": { "status": "done" } }
\`\`\`

### GET /entities/:id/connections
List relations connected to this entity.

---

## Memory (episodic facts)

### POST /memory
Save a fact about the user or the world.

\`\`\`json
{ "fact": "Alice prefers async standups", "confidence": 0.9 }
\`\`\`

\`embedding\` (number[1536]) is optional — a zero vector is used when omitted.
Dual-writes to the linked human user automatically.

### GET /memory?query=&limit=
Full-text search facts. Params: \`query\` (or \`q\`), \`limit\`.

### POST /memory/search
Semantic search by embedding vector.

\`\`\`json
{ "embedding": [0.1, ...], "limit": 10 }
\`\`\`

### DELETE /memory/:id
Delete a fact by ID.

---

## Relations

### POST /relations
Link two entities.

\`\`\`json
{ "fromEntityId": "ent_1", "toEntityId": "ent_2", "type": "blocks", "workspaceId": "ws_abc" }
\`\`\`

### GET /relations?entityId=&type=
List relations for an entity.

### DELETE /relations/:id
Remove a relation link.

### GET /graph/traverse?startEntityId=&maxDepth=&relationshipTypes=
BFS graph traversal from a starting entity.
Params: \`startEntityId\`, \`maxDepth\` (default 2), \`relationshipTypes\` (comma-separated, optional).

---

## Documents

### POST /documents
Create a markdown document.

\`\`\`json
{ "title": "Q3 Plan", "content": "## Goals\\n...", "entityId": "ent_abc" }
\`\`\`

Supports \`Idempotency-Key\` header.

### GET /documents/:id
Fetch a document with its full content.

### POST /documents/proposals
Submit a document edit as a governance proposal.

\`\`\`json
{ "documentId": "doc_abc", "content": "## Updated\\n...", "type": "ai_edit" }
\`\`\`

---

## Search

### GET /search?q=&collections=&workspaceId=
Cross-collection Typesense search.
- \`collections\` — comma-separated: \`entities\`, \`documents\`, \`views\`, \`projects\`, \`agents\`
- \`workspaceId\` — scope (optional)

---

## Capture (unstructured → structured)

### POST /capture/structure
Parse unstructured text into entity proposals.

\`\`\`json
{ "text": "Meeting with Bob tomorrow at 3pm re: Q3 budget", "profileSlug": "event" }
\`\`\`

### POST /capture/execute
Execute a capture result returned by \`/capture/structure\`.

---

## Governance & Proposals

### GET /workspaces/:id/governance
Read the workspace auto-approve whitelist and policies.

### GET /proposals?workspaceId=&status=pending
List proposals awaiting human review.

### PATCH /proposals/:id
Revise a pending proposal after user feedback.

\`\`\`json
{ "summary": "Updated summary", "reasoning": "Revised because..." }
\`\`\`

### IMPORTANT: Proposal flow

When an agent write action requires human approval the backend responds **HTTP 200** with:

\`\`\`json
{
  "granted": false,
  "proposalId": "uuid",
  "summary": "...",
  "reasoning": "...",
  "reviewPath": "/proposals/uuid",
  "reviewUrl": "https://..."
}
\`\`\`

**Always check the \`granted\` field on write responses.**
If \`false\`, inform the user to review at \`reviewUrl\`. Do NOT retry the same call — wait for approval.

---

## Notifications

### POST /notifications
Create a notification for a user.

\`\`\`json
{ "userId": "usr_abc", "type": "system", "title": "Task done", "body": "...", "data": {} }
\`\`\`

---

## Knowledge (procedural)

### GET /knowledge/:key
Fetch a procedural document by key (URL-encode the key).

### PUT /knowledge/:key
Upsert a procedural document.

\`\`\`json
{ "content": "# How to deploy\\n...", "namespace": "ops", "metadata": {} }
\`\`\`

### GET /knowledge/search?q=&namespace=
Search knowledge entries.

---

## Channels

### GET /channels/personal
Get the current user's personal AI channel.

### POST /channels/by-context
Resolve or create an AI channel scoped to an entity or document.

\`\`\`json
{ "contextObjectType": "entity", "contextObjectId": "ent_abc", "workspaceId": "ws_abc" }
\`\`\`

### GET /channels?workspaceId=&type=
List channels. Type filter: \`ai_thread\`, \`branch\`, \`entity_comments\`, \`direct\`, etc.

### POST /channels/trigger-ai
Trigger an AI response in a channel.

\`\`\`json
{ "channelId": "ch_abc", "message": "Summarise the project", "systemPromptOverride": null }
\`\`\`

---

## Threads & Messages

### POST /threads
Create a thread.

\`\`\`json
{ "channelId": "ch_abc", "title": "Sprint planning" }
\`\`\`

### GET /threads/:id/messages
List messages in a thread.

### POST /threads/:id/messages
Post a message.

\`\`\`json
{ "content": "Let's start with the backlog review.", "role": "user" }
\`\`\`

---

## Automations

### GET /automations
List automations in the workspace.

### POST /automations/create
Create an automation.

### POST /automations/:id/trigger
Manually trigger an automation by ID.

---

## Background Tasks

### POST /background-tasks
Create a long-running task.

\`\`\`json
{ "title": "Sync CRM contacts", "description": "Pull latest from HubSpot", "agentUserId": "agt_abc" }
\`\`\`

### GET /background-tasks/:id
Poll task status. \`status\` field: \`pending\` | \`running\` | \`done\` | \`failed\`.
`;

const FALLBACK_SYNAP_SCHEMA = `# synap-schema — Profiles, Property Definitions & Workspaces

Auth header on every request: \`Authorization: Bearer $SYNAP_API_KEY\`
Base URL: \`$HUB_BASE_URL/api/hub\`

---

## Profiles (entity type definitions)

### GET /profiles
List all profiles visible in the current workspace.
Returns slug, name, parentSlug, icon, color, entityScope, propertyDefs.

### POST /profiles
Create a custom profile (entity type).

\`\`\`json
{
  "name": "Blog Post",
  "slug": "blog-post",
  "parentSlug": "note",
  "icon": "file-text",
  "color": "purple",
  "entityScope": "workspace"
}
\`\`\`

\`entityScope\`: \`"pod"\` (visible across all workspaces) or \`"workspace"\` (scoped to creator workspace).

---

## Property Definitions

### GET /property-defs?profileId=&workspaceId=
List property definitions for a profile.
Thread \`workspaceId\` to get the correct three-layer scope (global ∪ profile-base ∪ workspace-overlay).

### POST /property-defs
Create a property definition.

\`\`\`json
{
  "profileId": "prof_abc",
  "name": "Publish Date",
  "slug": "publishDate",
  "type": "date",
  "required": false
}
\`\`\`

Supported types: \`text\` | \`number\` | \`boolean\` | \`date\` | \`select\` | \`multi_select\` | \`relation\` | \`url\` | \`email\`.
For \`select\` / \`multi_select\` pass \`options: [{ label, value }]\`.

---

## Workspaces

### GET /workspaces
List workspaces accessible to the authenticated user.

### POST /workspaces/from-definition
Provision a workspace from a JSON definition (used by automations and the CLI).

\`\`\`json
{
  "name": "Sales Pipeline",
  "definition": {
    "profiles": [...],
    "views": [...],
    "properties": [...]
  }
}
\`\`\`

---

## Agent Users & Configs

### GET /agent-users
List AI agent users registered in this workspace.

### GET /agent-configs
Read per-workspace agent configuration overrides (model, temperature, auto-approve list).
`;

const FALLBACK_SYNAP_UI = `# synap-ui — Views, Dashboards & Widgets

Auth header on every request: \`Authorization: Bearer $SYNAP_API_KEY\`
Base URL: \`$HUB_BASE_URL/api/hub\`

---

## Views

### GET /views?workspaceId=&type=
List views in a workspace.

Available \`type\` values:
\`table\` | \`kanban\` | \`bento\` | \`list\` | \`grid\` | \`gallery\` | \`calendar\` |
\`matrix\` | \`masonry\` | \`flow\` | \`branch_tree\` | \`whiteboard\`

### POST /views
Create a view.

\`\`\`json
{
  "name": "Active Tasks",
  "type": "kanban",
  "workspaceId": "ws_abc",
  "profileId": "prof_task",
  "config": {
    "groupBy": "status",
    "filters": [{ "field": "status", "op": "neq", "value": "cancelled" }]
  }
}
\`\`\`

### PATCH /views/:id
Update a view's name or config (merge patch).

\`\`\`json
{ "name": "My Renamed View", "config": { "groupBy": "priority" } }
\`\`\`

### POST /views/:id/arrange
Reorder or resize bento widgets on a \`bento\` view.

\`\`\`json
{
  "layout": [
    { "i": "block_1", "x": 0, "y": 0, "w": 6, "h": 4 },
    { "i": "block_2", "x": 6, "y": 0, "w": 6, "h": 4 }
  ]
}
\`\`\`

---

## Widget Definitions

### GET /widget-definitions
List all available widget types (built-in + custom).
Returns kind, name, description, configSchema, defaultConfig.

### POST /cells/define
Define a new ViewFrame cell (idempotent upsert). Prefer this over \`/widget-definitions\` for agent-generated cells.

\`\`\`json
{
  "name": "Revenue Gauge",
  "rendererSource": "<!DOCTYPE html>…</html>",
  "typeKey": "revenue-gauge",
  "description": "MRR gauge widget",
  "defaultSize": { "w": 6, "h": 4 },
  "deps": { "recharts": "2.12.0" }
}
\`\`\`

- \`deps\` keys are npm package names; values are version strings (max 30 entries). React 19 is always injected — never include it in \`deps\`.
- Omit \`workspaceId\` for pod-global cells (visible in all workspaces, no proposal required).
- Full in-frame API (queries, mutations, shell actions) — see \`synap\` skill ViewFrame Cells section.

### POST /widget-definitions
Internal/admin path for built-in widgets. Use \`/cells/define\` for agent-generated cells.

---

## Bento Grid Layout

A \`bento\` view's grid is 12 columns wide. Each block references a cell by \`kind\`:

\`\`\`json
{
  "blocks": [
    { "id": "block_1", "kind": "view", "viewId": "view_abc", "x": 0, "y": 0, "w": 8, "h": 6 },
    { "id": "block_2", "kind": "widget", "widgetKind": "stat-card", "config": { "label": "Open Tasks", "metricKey": "tasks.open" }, "x": 8, "y": 0, "w": 4, "h": 3 }
  ]
}
\`\`\`

Block \`kind\` values: \`view\` | \`entity\` | \`widget\`.

---

## Whiteboard Placement

Whiteboards are spatial layouts over existing resources. Create or update the
resource first, then propose board placement.

### POST /whiteboards/:viewId/placements/propose
Proposal-gated placement on a whiteboard view.

\`\`\`json
{
  "workspaceId": "workspace_uuid",
  "resources": [
    { "kind": "entity", "entityId": "entity_uuid" },
    { "kind": "view", "viewId": "view_uuid" },
    { "kind": "automation", "automationId": "automation_uuid", "mode": "flow" }
  ],
  "options": { "layout": "grid" },
  "reasoning": "Place the research materials together for review"
}
\`\`\`

Resource \`kind\` values: \`entity\` | \`view\` | \`cellInstance\` |
\`cellDefinition\` | \`html\` | \`automation\` | \`url\`.
`;

export type SkillFile = { path: string; content: string };
export type SkillPackage = { slug: string; files: SkillFile[] };

const FALLBACK_SKILL_PACKAGES: SkillPackage[] = [
  {
    slug: "synap",
    files: [{ path: "SKILL.md", content: FALLBACK_SYNAP }],
  },
  {
    slug: "synap-schema",
    files: [{ path: "SKILL.md", content: FALLBACK_SYNAP_SCHEMA }],
  },
  {
    slug: "synap-ui",
    files: [{ path: "SKILL.md", content: FALLBACK_SYNAP_UI }],
  },
];

/**
 * Read the deliverable skill slugs from skills/manifest.json (baseline +
 * workflow). The manifest is the single source of truth shared with the CLI
 * installer + sync-skills.sh. Falls back to the three baseline slugs if the
 * manifest is absent or malformed, so a missing file degrades gracefully.
 */
function readManifestSlugs(skillsDir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(skillsDir, "manifest.json"), "utf-8");
    const m = JSON.parse(raw) as { baseline?: string[]; workflow?: string[] };
    const slugs = [...(m.baseline ?? []), ...(m.workflow ?? [])];
    if (slugs.length) return slugs;
  } catch {
    /* fall through to the baseline default */
  }
  return ["synap", "synap-schema", "synap-ui"];
}

/**
 * Exported so `ensureSystemSkills()` (the DB-seeding startup hook, see
 * `services/capabilities/ensure-system-skills.ts`) reuses this one disk loader
 * instead of duplicating the manifest/topic-file-discovery logic.
 */
export function loadSkillPackagesFromDisk(): SkillPackage[] | null {
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../../../../skills"
    ),
  ];
  const skillsDir = candidates.find((d) => fs.existsSync(d));
  if (!skillsDir) return null;

  // Which packages to serve: read the shared skills manifest (skills/manifest.json,
  // the single source of truth shared with the CLI installer + sync-skills.sh).
  // baseline = always-on, workflow = intent-triggered; both are delivered to
  // agents. Topic files are the source of truth and the monolithic SKILL.md is a
  // generated build artifact (see skills/build.mjs). Enumerate every `*.md` in
  // each package dynamically so adding a topic file does not require editing a
  // list. SKILL.md is always served first (the `?scope=core` payload); the
  // remaining topic files follow, sorted.
  const SKILL_SLUGS = readManifestSlugs(skillsDir);

  const packages: SkillPackage[] = [];
  for (const slug of SKILL_SLUGS) {
    const pkgDir = path.join(skillsDir, slug);
    if (!fs.existsSync(pkgDir)) continue;

    let mdFiles: string[];
    try {
      mdFiles = fs
        .readdirSync(pkgDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch {
      continue;
    }
    // SKILL.md first (the assembled monolith / core scope), then the rest.
    // Exclude README.md (a packaging/marketing file, not a skill topic — matches
    // the IS sync-baseline-skills EXCLUDE set so both paths agree what a topic is).
    mdFiles = mdFiles.filter((f) => f !== "SKILL.md" && f !== "README.md");
    if (fs.existsSync(path.join(pkgDir, "SKILL.md"))) {
      mdFiles.unshift("SKILL.md");
    }

    const loaded: SkillFile[] = [];
    for (const file of mdFiles) {
      const filePath = path.join(pkgDir, file);
      try {
        loaded.push({
          path: file,
          content: fs.readFileSync(filePath, "utf-8"),
        });
      } catch {
        /* skip unreadable */
      }
    }
    if (loaded.length) packages.push({ slug, files: loaded });
  }
  return packages.length ? packages : null;
}

// Loaded once at startup — synchronous read, cheap
let _cachedSkillPackages: SkillPackage[] | null = null;

function getSkillPackages(): SkillPackage[] {
  if (_cachedSkillPackages === null) {
    _cachedSkillPackages =
      loadSkillPackagesFromDisk() ?? FALLBACK_SKILL_PACKAGES;
  }
  return _cachedSkillPackages;
}

const SystemSkillFileSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .openapi("SystemSkillFile");

const SystemSkillPackageSchema = z
  .object({
    slug: z.string(),
    files: z.array(SystemSkillFileSchema),
  })
  .openapi("SystemSkillPackage");

// ── Register function ─────────────────────────────────────────────────────────

export function registerSkillsRoutes(app: HubHono): void {
  // ── GET /skills/system — STATIC, must come before /skills/:id ─────────────
  const getSystemSkillsRoute = createRoute({
    method: "get",
    path: "/skills/system",
    tags: ["Skills"],
    summary: "List system skill packages",
    description:
      "Returns static SKILL.md documentation for the built-in skill packages " +
      "listed in skills/manifest.json (baseline + workflow). Called by " +
      "ensureEveSkillsLayout() to populate ~/.eve/skills/ for Claude Code and " +
      "other text-based agents. Requires hub-protocol.read scope.",
    responses: {
      200: {
        description: "Array of skill packages with file contents",
        content: {
          "application/json": {
            schema: z.array(SystemSkillPackageSchema),
          },
        },
      },
      403: {
        description: "Forbidden",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(getSystemSkillsRoute, async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    // ?scope=core  → SKILL.md only per package (minimal, ~300 lines total)
    // ?scope=full  → all files (default, backward compat)
    // ?sections=synap:capture,synap-ui:view-types → specific files only
    const scope = c.req.query("scope");
    const sectionsParam = c.req.query("sections");
    const allPackages = getSkillPackages();

    if (sectionsParam) {
      // Parse "pkg:file,pkg:file" → filter to requested files
      const requested = sectionsParam.split(",").map((s) => s.trim());
      const filtered = allPackages
        .map((pkg) => ({
          ...pkg,
          files: pkg.files.filter(
            (f) =>
              requested.includes(
                `${pkg.slug}:${f.path.replace(/\.md$/, "")}`
              ) || requested.includes(`${pkg.slug}:${f.path}`)
          ),
        }))
        .filter((pkg) => pkg.files.length > 0);
      return c.json(filtered, 200);
    }

    if (scope === "core") {
      // Return only SKILL.md from each package
      const corePackages = allPackages
        .map((pkg) => ({
          ...pkg,
          files: pkg.files.filter((f) => f.path === "SKILL.md"),
        }))
        .filter((pkg) => pkg.files.length > 0);
      return c.json(corePackages, 200);
    }

    return c.json(allPackages, 200);
  });

  // NOTE: the legacy camelCase `/skills/getSkills`, `/skills/getSkill`, and
  // `POST /skills/createSkill` routes were removed in WAVE 4. The executable
  // `skills`-table operations now live under `/agent-skills/executable*` (see
  // agent-skills.ts). `/skills/system` above stays — it is the on-disk baseline
  // skill-package distribution endpoint that external/Claude-Code agents use.
}
