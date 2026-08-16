/**
 * Compose widget catalog — the allowlist of cells an agent may place in a
 * generated bento.
 *
 * Two sources of truth used to drift:
 *   1. Teaching skill `widget-catalog.md` listed invented keys (`entity-count`)
 *      and claimed `view-table` works from `profileSlug` alone.
 *   2. `GET /widget-definitions` only returned DB rows. This pod's seeder never
 *      wrote builtins, so the "authoritative registry" was six generated cells
 *      and nothing the Browser can actually render.
 *
 * This module is the merge: curated builtins the Browser registers in code,
 * plus whatever `generated:*` frame cells the pod already has. Arrange
 * validates against it; MCP `synap_list_widgets` returns it.
 */

export interface ComposeWidgetDef {
  key: string;
  name: string;
  description: string;
  category: "core" | "data" | "ai" | "governance";
  defaultSize: { w: number; h: number };
  /** Config keys the widget will not render without. */
  requiredConfig: string[];
  notes: string;
  /** Hidden aliases stay placeable so old blocks keep working, but new layouts
   *  should use `prefer`. */
  aliasOf?: string;
}

export const COMPOSE_WIDGET_CATALOG: ComposeWidgetDef[] = [
  {
    key: "section-header",
    name: "Section header",
    description: "Title + optional subtitle. Use as the first row of a group.",
    category: "core",
    defaultSize: { w: 12, h: 2 },
    requiredConfig: ["title"],
    notes: "config.title, optional config.subtitle / config.color",
  },
  {
    key: "stat-card",
    name: "Stat card",
    description: "Single metric (count / sum / avg) over a profile.",
    category: "data",
    defaultSize: { w: 3, h: 3 },
    requiredConfig: ["profileSlug"],
    notes:
      "config.profileSlug is required. aggregation defaults to count. Optional: label, icon, color, chartType.",
  },
  {
    key: "entity-count",
    name: "Entity count (legacy)",
    description: "Legacy alias of stat-card. Prefer stat-card for new layouts.",
    category: "data",
    defaultSize: { w: 3, h: 3 },
    requiredConfig: ["profileSlug"],
    notes: "Same config as stat-card. Do not invent this key for new bentos.",
    aliasOf: "stat-card",
  },
  {
    key: "entity-list",
    name: "Entity list",
    description:
      "Scrollable list of entities for a profile. No saved view required.",
    category: "data",
    defaultSize: { w: 6, h: 6 },
    requiredConfig: ["profileSlug"],
    notes: "Use this when you have a profileSlug but no saved view UUID.",
  },
  {
    key: "entity-gallery",
    name: "Entity gallery",
    description: "Card grid of entities for a profile.",
    category: "data",
    defaultSize: { w: 6, h: 4 },
    requiredConfig: ["profileSlug"],
    notes: "config.profileSlug. Optional limit.",
  },
  {
    key: "entity-card",
    name: "Entity card",
    description: "One entity, rich rendering.",
    category: "data",
    defaultSize: { w: 4, h: 4 },
    requiredConfig: ["entityId"],
    notes: "Needs a real entity UUID, not a profile slug.",
  },
  {
    key: "entity-spotlight",
    name: "Entity spotlight",
    description: "Featured entity, large format.",
    category: "data",
    defaultSize: { w: 4, h: 4 },
    requiredConfig: ["entityId"],
    notes: "Needs a real entity UUID.",
  },
  {
    key: "view",
    name: "View",
    description: "Embed a saved view. Prefer this over the view-* aliases.",
    category: "data",
    defaultSize: { w: 12, h: 8 },
    requiredConfig: ["viewId"],
    notes:
      "config.viewId is a saved view UUID. Optional config.layout: table|list|kanban|calendar|grid. profileSlug is NOT enough.",
  },
  {
    key: "view-table",
    name: "Table view (legacy)",
    description: "Legacy alias of view with layout=table.",
    category: "data",
    defaultSize: { w: 12, h: 8 },
    requiredConfig: ["viewId"],
    notes:
      "Requires config.viewId (saved view UUID). profileSlug alone renders 'No Table selected'.",
    aliasOf: "view",
  },
  {
    key: "view-list",
    name: "List view (legacy)",
    description: "Legacy alias of view with layout=list.",
    category: "data",
    defaultSize: { w: 6, h: 8 },
    requiredConfig: ["viewId"],
    notes: "Requires config.viewId.",
    aliasOf: "view",
  },
  {
    key: "view-kanban",
    name: "Kanban view (legacy)",
    description: "Legacy alias of view with layout=kanban.",
    category: "data",
    defaultSize: { w: 12, h: 8 },
    requiredConfig: ["viewId"],
    notes: "Requires config.viewId.",
    aliasOf: "view",
  },
  {
    key: "view-calendar",
    name: "Calendar view (legacy)",
    description: "Legacy alias of view with layout=calendar.",
    category: "data",
    defaultSize: { w: 12, h: 8 },
    requiredConfig: ["viewId"],
    notes: "Requires config.viewId.",
    aliasOf: "view",
  },
  {
    key: "view-grid",
    name: "Grid view (legacy)",
    description: "Legacy alias of view with layout=grid.",
    category: "data",
    defaultSize: { w: 8, h: 8 },
    requiredConfig: ["viewId"],
    notes: "Requires config.viewId.",
    aliasOf: "view",
  },
  {
    key: "feed",
    name: "Feed",
    description: "Recent activity.",
    category: "core",
    defaultSize: { w: 4, h: 6 },
    requiredConfig: [],
    notes: "Optional config.limit.",
  },
  {
    key: "inbox",
    name: "Inbox",
    description: "Unread + actionable items.",
    category: "core",
    defaultSize: { w: 4, h: 6 },
    requiredConfig: [],
    notes: "No required config.",
  },
  {
    key: "quick-access",
    name: "Quick access",
    description: "Pinned shortcuts.",
    category: "core",
    defaultSize: { w: 6, h: 2 },
    requiredConfig: [],
    notes: "config.items[] of { kind: view|entity|url, ... }.",
  },
  {
    key: "calendar",
    name: "Calendar",
    description: "Mini calendar with events.",
    category: "core",
    defaultSize: { w: 4, h: 4 },
    requiredConfig: [],
    notes: "Key is calendar, not calendar-widget.",
  },
  {
    key: "proposals-list",
    name: "Proposals",
    description: "Pending proposals needing review.",
    category: "governance",
    defaultSize: { w: 6, h: 4 },
    requiredConfig: [],
    notes: "Optional config.status (pending).",
  },
];

export const COMPOSE_WIDGET_BY_KEY: Record<string, ComposeWidgetDef> =
  Object.fromEntries(COMPOSE_WIDGET_CATALOG.map((w) => [w.key, w]));

export function isGeneratedTypeKey(key: string): boolean {
  return key.startsWith("generated:");
}

/** Error string if this key/config must not be arranged; null if ok. */
export function composeWidgetError(
  key: string,
  config: Record<string, unknown> | undefined,
  knownGenerated: ReadonlySet<string> = new Set()
): string | null {
  if (isGeneratedTypeKey(key)) {
    if (knownGenerated.size > 0 && !knownGenerated.has(key)) {
      return `Unknown generated cell "${key}". Call synap_list_widgets / GET /widget-definitions first.`;
    }
    return null;
  }
  const def = COMPOSE_WIDGET_BY_KEY[key];
  if (!def) {
    const known = COMPOSE_WIDGET_CATALOG.map((w) => w.key).join(", ");
    return `Unknown widget "${key}". Use one of: ${known}. Or a generated:<slug> cell from synap_list_widgets.`;
  }
  const missing = def.requiredConfig.filter((field) => {
    const value = config?.[field];
    return value == null || value === "";
  });
  if (missing.length > 0) {
    return `Widget "${key}" needs config.${missing.join(", ")}. ${def.notes}`;
  }
  return null;
}

/** Synthetic widget_definitions-shaped rows so GET /widget-definitions is not empty of builtins. */
export function composeCatalogAsDefinitionRows(): Array<
  Record<string, unknown>
> {
  return COMPOSE_WIDGET_CATALOG.map((w) => ({
    id: `catalog:${w.key}`,
    typeKey: w.key,
    name: w.name,
    description: w.description,
    category: w.category,
    rendererType: "builtin",
    rendererSource: null,
    workspaceId: null,
    isActive: true,
    defaultSize: w.defaultSize,
    configSchema: {
      type: "object",
      required: w.requiredConfig,
      properties: Object.fromEntries(
        w.requiredConfig.map((field) => [field, { type: "string" }])
      ),
    },
    defaultConfig: {},
    aliasOf: w.aliasOf ?? null,
    source: "compose-catalog",
    notes: w.notes,
  }));
}
