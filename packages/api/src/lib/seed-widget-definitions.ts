/**
 * Seed Widget Definitions
 *
 * Ensures all built-in widget types are present in the widget_definitions table.
 * Called once at backend startup after migrations.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE so re-running is always safe (idempotent).
 * workspaceId = null means system-wide (available in every workspace).
 */

import { getDb } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "seed-widget-definitions" });

interface BuiltinWidgetSeed {
  typeKey: string;
  name: string;
  description: string;
  icon?: string;
  category: string;
  configSchema: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  defaultSize: { w: number; h: number };
}

/**
 * Built-in widget catalog — mirrors BENTO_CELL_CATALOG in the IS tool
 * and the cellRegistry entries in the frontend.
 */
const BUILTIN_WIDGETS: BuiltinWidgetSeed[] = [
  {
    typeKey: "welcome-header",
    name: "Welcome Header",
    description:
      "Full-width welcome banner with workspace name, subtitle, and current date. Always place at the top of a dashboard.",
    icon: "home",
    category: "core",
    configSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Workspace name or greeting" },
        subtitle: { type: "string", description: "Optional tagline" },
        showDate: {
          type: "boolean",
          description: "Show current date",
          default: true,
        },
      },
      required: [],
    },
    defaultConfig: { showDate: true },
    defaultSize: { w: 12, h: 2 },
  },
  {
    typeKey: "entity-count",
    name: "Entity Count",
    description:
      "Compact count card for a profile type. Shows total entities or filtered subset.",
    icon: "hash",
    category: "data",
    configSchema: {
      type: "object",
      properties: {
        profileSlug: {
          type: "string",
          description: "Profile slug to count (e.g. 'deal')",
        },
        label: {
          type: "string",
          description: "Display label (e.g. 'Open Deals')",
        },
        icon: { type: "string", description: "Lucide icon name" },
        filter: {
          type: "object",
          description: "Optional property filter { field, operator, value }",
        },
      },
      required: ["profileSlug", "label"],
    },
    defaultSize: { w: 3, h: 2 },
  },
  {
    typeKey: "entity-list",
    name: "Entity List",
    description:
      "Scrollable list of entities with optional title and sort/filter.",
    icon: "list",
    category: "data",
    configSchema: {
      type: "object",
      properties: {
        profileSlug: {
          type: "string",
          description: "Profile slug (e.g. 'task')",
        },
        title: { type: "string", description: "Widget header label" },
        limit: {
          type: "number",
          description: "Max items to show",
          default: 10,
        },
        sort: {
          type: "object",
          description: "{ field: string, direction: 'asc' | 'desc' }",
        },
        filter: { type: "object", description: "Property filter" },
      },
      required: ["profileSlug"],
    },
    defaultConfig: { limit: 10 },
    defaultSize: { w: 6, h: 4 },
  },
  {
    typeKey: "feed",
    name: "Activity Feed",
    description:
      "Activity feed showing recent changes, creations, and events across the workspace.",
    icon: "activity",
    category: "core",
    configSchema: { type: "object", properties: {} },
    defaultSize: { w: 4, h: 4 },
  },
  {
    typeKey: "calendar",
    name: "Calendar",
    description: "Mini calendar view showing entities with date properties.",
    icon: "calendar",
    category: "data",
    configSchema: {
      type: "object",
      properties: {
        profileSlug: {
          type: "string",
          description: "Filter to a specific profile",
        },
        dateField: {
          type: "string",
          description: "Property name to use as the date",
        },
        title: { type: "string", description: "Widget header label" },
      },
    },
    defaultSize: { w: 4, h: 4 },
  },
  {
    typeKey: "quick-access",
    name: "Quick Access",
    description: "Row of shortcut chips linking to views or profiles.",
    icon: "zap",
    category: "core",
    configSchema: {
      type: "object",
      properties: {
        links: {
          type: "array",
          description: "Array<{ label, viewId?, profileSlug?, icon? }>",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              viewId: { type: "string" },
              profileSlug: { type: "string" },
              icon: { type: "string" },
            },
            required: ["label"],
          },
        },
      },
      required: ["links"],
    },
    defaultSize: { w: 12, h: 2 },
  },
  {
    typeKey: "metrics-summary",
    name: "Metrics Summary",
    description:
      "Aggregated metric card (count, sum, or average) for a numeric property.",
    icon: "bar-chart-3",
    category: "data",
    configSchema: {
      type: "object",
      properties: {
        profileSlug: { type: "string", description: "Profile to aggregate" },
        property: { type: "string", description: "Numeric property slug" },
        aggregation: {
          type: "string",
          enum: ["count", "sum", "average"],
          description: "Aggregation function",
        },
        title: { type: "string", description: "Metric label" },
        filter: { type: "object", description: "Optional property filter" },
      },
      required: ["profileSlug", "property", "aggregation", "title"],
    },
    defaultSize: { w: 3, h: 2 },
  },
  {
    typeKey: "recent-documents",
    name: "Recent Documents",
    description: "List of recently modified or viewed documents.",
    icon: "file-text",
    category: "core",
    configSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Widget header",
          default: "Recent Documents",
        },
        limit: { type: "number", description: "Max items", default: 8 },
      },
    },
    defaultConfig: { limit: 8 },
    defaultSize: { w: 6, h: 4 },
  },
];

/**
 * Seed all built-in widget definitions.
 * Uses ON CONFLICT DO UPDATE to keep name/description/schema in sync.
 */
export async function seedWidgetDefinitions(): Promise<void> {
  try {
    const db = await getDb();

    for (const seed of BUILTIN_WIDGETS) {
      await db
        .insert(widgetDefinitions)
        .values({
          typeKey: seed.typeKey,
          workspaceId: null,
          name: seed.name,
          description: seed.description,
          icon: seed.icon,
          category: seed.category,
          rendererType: "builtin",
          rendererSource: null,
          configSchema: seed.configSchema,
          defaultConfig: seed.defaultConfig ?? {},
          defaultSize: seed.defaultSize,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
          set: {
            name: seed.name,
            description: seed.description,
            icon: seed.icon ?? null,
            category: seed.category,
            configSchema: seed.configSchema,
            defaultConfig: seed.defaultConfig ?? {},
            defaultSize: seed.defaultSize,
            updatedAt: new Date(),
          },
        });
    }

    logger.info(
      { count: BUILTIN_WIDGETS.length },
      "Widget definitions seeded successfully"
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Failed to seed widget definitions (non-fatal)"
    );
  }
}
