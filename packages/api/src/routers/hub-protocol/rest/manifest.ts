/**
 * Hub Protocol REST — /manifest
 *
 * Fast orientation endpoint for AI agents. Returns static capability metadata
 * so agents can understand the system's topology without calling multiple
 * endpoints. No DB queries — purely descriptive.
 *
 * An agent should call this once on startup (after orient) to know:
 *   - What view types exist and when to use each
 *   - What block kinds go in bento layouts
 *   - How to emit inline chips in Companion replies
 *   - Where to find live data (profiles, views, widget-definitions)
 */

import { registerOpenApi } from "./_codecs/_register.js";
import type { HubHono } from "./_shared.js";

const MANIFEST = {
  version: "1",
  description:
    "Static capability manifest for AI agents. Call this once on startup to understand system topology. For live workspace data call the discoveryEndpoints below.",

  // ----- ENTITY / SCHEMA LAYER --------------------------------------------------
  discoveryEndpoints: {
    profiles:
      "GET /api/hub/profiles?workspaceId={workspaceId}  →  entity type schemas (slug, name, properties)",
    views:
      "GET /api/hub/views?workspaceId={workspaceId}     →  saved views (id, name, type, profileSlug, config)",
    widgetDefinitions:
      "GET /api/hub/widget-definitions?workspaceId={workspaceId}  →  dashboard widget catalog (kind, configSchema)",
    capabilities:
      "GET /trpc/capabilities.list                      →  core features + intelligence services",
    me: "GET /api/hub/users/me                             →  current user (id, email, name)",
    workspaces:
      "GET /api/hub/workspaces                          →  workspaces the user belongs to",
  },

  // ----- VIEW TYPES -------------------------------------------------------------
  viewTypes: [
    {
      type: "table",
      implemented: true,
      when: "Dense data, many columns, sort/filter heavy",
      configKeys: ["columns", "filters", "sort"],
    },
    {
      type: "list",
      implemented: true,
      when: "Scan-friendly compact rows (tasks, notes)",
      configKeys: ["columns", "filters", "sort"],
    },
    {
      type: "grid",
      implemented: true,
      when: "Card grid, medium density",
      configKeys: ["cardFields", "filters"],
    },
    {
      type: "gallery",
      implemented: true,
      when: "Image-forward cards (articles, bookmarks, products)",
      configKeys: ["imageProperty", "titleProperty", "filters"],
    },
    {
      type: "kanban",
      implemented: true,
      when: "Status pipelines (tasks by status, deals by stage)",
      configKeys: ["groupBy", "columns", "filters"],
    },
    {
      type: "matrix",
      implemented: true,
      when: "2-axis grid (priority × urgency, effort × impact)",
      configKeys: ["xAxis", "yAxis", "filters"],
    },
    {
      type: "masonry",
      implemented: true,
      when: "Pinterest-style mixed-size cards; default for Library",
      configKeys: ["filters", "sort"],
    },
    {
      type: "calendar",
      implemented: true,
      when: "Date-indexed data (events, tasks by dueDate)",
      configKeys: ["dateProperty", "titleProperty", "filters"],
    },
    {
      type: "flow",
      implemented: true,
      when: "Node-edge diagrams (automations, mind maps)",
      configKeys: ["nodeType", "edgeType"],
    },
    {
      type: "bento",
      implemented: true,
      when: "Mixed composition — a dashboard-in-view",
      configKeys: ["blocks"],
    },
    {
      type: "branch_tree",
      implemented: true,
      when: "Hierarchical data (project → subtasks, threads → branches)",
      configKeys: ["rootId", "childProperty"],
    },
    {
      type: "whiteboard",
      implemented: true,
      when: "Free-form canvas",
      configKeys: [],
    },
    { type: "timeline", implemented: false, when: "Defer" },
    { type: "graph", implemented: false, when: "Defer" },
    { type: "gantt", implemented: false, when: "Defer" },
    { type: "mindmap", implemented: false, when: "Defer" },
  ],

  // ----- BENTO ------------------------------------------------------------------
  bentoBlockKinds: [
    {
      kind: "view",
      description: "Embeds a saved view by viewId",
      requiredFields: ["viewId"],
    },
    {
      kind: "entity",
      description: "Renders an entity card for a specific entityId",
      requiredFields: ["entityId"],
    },
    {
      kind: "widget",
      description:
        "Renders a registered widget by widgetKind with optional config. Call GET /api/hub/widget-definitions for available kinds.",
      requiredFields: ["widgetKind"],
    },
  ],

  // ----- WHITEBOARD PLACEMENT -----------------------------------------------------
  whiteboardPlacement: {
    endpoint: "POST /api/hub/whiteboards/{viewId}/placements/propose",
    governance: "proposal-gated",
    description:
      "Propose spatial placement of existing or newly-created resources on a whiteboard. Create resources first; the whiteboard stores placement only.",
    resourceKinds: [
      "entity",
      "view",
      "cellInstance",
      "cellDefinition",
      "html",
      "automation",
      "url",
    ],
    optionKeys: ["x", "y", "w", "h", "frameId", "layout"],
  },

  // ----- AI INLINE PATTERNS (Companion only) ------------------------------------
  inlinePatterns: {
    description:
      "Embed clickable chips in Companion replies. Only meaningful inside the browser AI Companion — ignored in documents, memory, and external channels.",
    syntax: [
      {
        pattern: "[[entity:UUID|Name]]",
        renders: "Purple entity chip",
        effect: "Opens entity detail in side panel",
      },
      {
        pattern: "[[view:UUID|Name]]",
        renders: "Blue view chip",
        effect: "Opens view",
      },
      {
        pattern: "[[open:side|view:UUID]]",
        renders: "Amber 'Open in side' button",
        effect: "Opens view in side panel",
      },
      {
        pattern: "[[open:main|view:UUID]]",
        renders: "Amber 'Open' button",
        effect: "Opens view in main panel",
      },
      {
        pattern: "[[open:side|entity:UUID]]",
        renders: "Amber 'Open in side' button",
        effect: "Opens entity in side panel",
      },
      {
        pattern: "[[run:UUID|Label]]",
        renders: "Green 'Run' button",
        effect: "Navigates to automation entity",
      },
      {
        pattern: "[[doc:UUID|Name]]",
        renders: "Gray doc chip",
        effect: "Opens document",
      },
    ],
    rules: [
      "Only emit patterns for real IDs — never hallucinate UUIDs",
      "Always emit after creating a view or entity so the user can jump there",
      "Prefer [[open:side|...]] to avoid disrupting the user's current view",
      "Combine with prose naturally — don't lead with a bare chip",
    ],
  },

  // ----- BROWSER-NATIVE CELLS (not in widget-definitions) -----------------------
  browserNativeCells: [
    {
      cellKey: "ai-companion",
      where: "Browser sidebar",
      notes:
        "The Companion chat panel itself — do not reference in bento blocks",
    },
    {
      cellKey: "iframe-widget",
      where: "Bento blocks",
      notes: "Sandboxed iframe for custom embeds; config requires 'src'",
    },
    {
      cellKey: "entity-detail",
      where: "Side panel / modal",
      notes: "Generic entity detail renderer — always available",
    },
    {
      cellKey: "entity-list",
      where: "Bento / views",
      notes: "List of entities for a given profile",
    },
  ],

  // ----- KEY BEHAVIORAL RULES ---------------------------------------------------
  rules: [
    "Call GET /api/hub/profiles first — never guess profileSlug values",
    "Call GET /api/hub/widget-definitions before referencing widgetKind in bento — never guess",
    "Workspaces are lenses, not silos — add views to existing workspaces before proposing new ones",
    "Always propose workspace creation before committing — workspace.create is proposal-gated",
    "bento.arrange is auto-approved — safe to call without hesitation for rearranges",
    "Whiteboard placement is proposal-gated — create resources first, then call /whiteboards/{viewId}/placements/propose",
    "Entity creation uses profileSlug, not type (deprecated)",
    "Drizzle enum: use TypeScript enum value, not string literal",
    "tRPC URL on pod: ${podUrl}/trpc (no /api prefix)",
    "Hub Protocol REST: /api/hub/* — not /trpc/*",
  ],
} as const;

export function registerManifestRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/manifest",
    tags: ["System"],
    summary: "AI agent capability manifest",
    description:
      "Static orientation document for AI agents. Returns view types, bento block kinds, AI inline pattern syntax, browser-native cell keys, and pointers to live discovery endpoints. No DB queries — safe to cache for the duration of an agent session.",
    // Public, no-auth (skip-listed in hub-protocol-rest.ts) — same posture as
    // /health and /openapi.json. Overrides the global bearerAuth requirement.
    security: [],
    responses: {
      200: { description: "Manifest payload" },
    },
  });

  app.get("/manifest", (c) => c.json(MANIFEST));
}
