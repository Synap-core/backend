/**
 * Hub Protocol REST — skills
 */

import fs from "fs";
import path from "path";

import { createRoute, z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  CreateSkillRequestSchema,
  GetSkillQuerySchema,
  GetSkillsQuerySchema,
  WireSkillSchema,
} from "./_codecs/skill.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

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

### POST /widget-definitions
Register a custom widget.

\`\`\`json
{
  "name": "Revenue Gauge",
  "kind": "revenue-gauge",
  "config": { "metricKey": "mrr", "target": 50000 },
  "source": "iframe",
  "bundleSource": "https://cdn.example.com/revenue-gauge.js"
}
\`\`\`

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

type SkillFile = { path: string; content: string };
type SkillPackage = { slug: string; files: SkillFile[] };

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

function loadSkillPackagesFromDisk(): SkillPackage[] | null {
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../../../../skills"
    ),
  ];
  const skillsDir = candidates.find((d) => fs.existsSync(d));
  if (!skillsDir) return null;

  const SKILL_FILES: { slug: string; files: string[] }[] = [
    {
      slug: "synap",
      files: ["SKILL.md", "capture.md", "linking.md", "governance.md"],
    },
    { slug: "synap-schema", files: ["SKILL.md"] },
    {
      slug: "synap-ui",
      files: [
        "SKILL.md",
        "bento-recipes.md",
        "widget-catalog.md",
        "view-types.md",
      ],
    },
  ];

  const packages: SkillPackage[] = [];
  for (const { slug, files } of SKILL_FILES) {
    const loaded: SkillFile[] = [];
    for (const file of files) {
      const filePath = path.join(skillsDir, slug, file);
      if (fs.existsSync(filePath)) {
        try {
          loaded.push({
            path: file,
            content: fs.readFileSync(filePath, "utf-8"),
          });
        } catch {
          /* skip unreadable */
        }
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
      "Returns static SKILL.md documentation for the built-in synap, synap-schema, " +
      "and synap-ui packages. Called by ensureEveSkillsLayout() to populate " +
      "~/.eve/skills/ for Claude Code and other text-based agents. " +
      "Requires hub-protocol.read scope.",
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
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/skills/getSkills",
    tags: ["Skills"],
    summary: "List available agent skills",
    request: {
      query: GetSkillsQuerySchema,
    },
    responses: {
      200: { description: "Skills", schema: z.array(WireSkillSchema) },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/skills/getSkill",
    tags: ["Skills"],
    summary: "Get a single skill",
    request: {
      query: GetSkillQuerySchema,
    },
    responses: {
      200: { description: "Skill", schema: WireSkillSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/skills/createSkill",
    tags: ["Skills"],
    summary: "Create a custom skill",
    request: {
      body: CreateSkillRequestSchema,
    },
    responses: {
      200: { description: "Created skill", schema: WireSkillSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /skills/getSkills?userId=...&workspaceId=...&status=...
   */
  app.get("/skills/getSkills", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const userId = c.req.query("userId") || (c.get("userId") as string);
    const workspaceId = c.req.query("workspaceId");
    const status = c.req.query("status");
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.getSkills({
        userId,
        workspaceId: workspaceId || undefined,
        status: (status as "active" | "inactive" | "error" | "all") || "all",
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "getSkills failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /skills/getSkill?userId=...&skillId=...
   */
  app.get("/skills/getSkill", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const userId = c.req.query("userId") || (c.get("userId") as string);
    const skillId = c.req.query("skillId");
    if (!skillId) {
      return c.json({ error: "skillId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.getSkill({ userId, skillId });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "getSkill failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /skills/createSkill
   */
  app.post("/skills/createSkill", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const body = await c.req.json<{
      userId: string;
      name: string;
      description?: string;
      code: string;
      parameters?: Record<string, unknown>;
      category?: "action" | "context" | "utility" | "custom";
      workspaceId?: string;
    }>();
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.createSkill(body);
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createSkill failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
