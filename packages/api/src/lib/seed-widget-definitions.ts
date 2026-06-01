/**
 * Seed Widget Definitions
 *
 * Syncs the widget_definitions table with the capabilities manifest generated
 * by @synap/capabilities (the single source of truth for all widget types).
 *
 * Called at backend startup after migrations. Reads the manifest from:
 *   1. CAPABILITIES_MANIFEST_PATH env var (override for production deploys)
 *   2. ../../../synap-app/packages/core/capabilities/dist/capabilities.json (dev)
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE so re-running is always safe (idempotent).
 * workspaceId = null means system-wide (available in every workspace).
 *
 * Any frontend can register its OWN set of widgets (via cellRegistry) — the backend
 * catalog is the ecosystem-wide registry. Frontends that don't support a widget
 * gracefully show "Widget not available in this app".
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "seed-widget-definitions" });

// ─── Manifest types (matches @synap/capabilities output) ─────────────────────

interface ManifestWidget {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  displayModes: string[];
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  configSchema: Array<{
    key: string;
    label: string;
    type: string;
    required?: boolean;
    defaultValue?: unknown;
    options?: Array<{ value: string; label: string }>;
    description?: string;
  }>;
  requiresWorkspace?: boolean;
  aliasOf?: string;
}

interface CapabilitiesManifest {
  version: string;
  /**
   * Structural CONTRACT version of the manifest shape. Optional here for
   * backward-compat with an older capabilities.json that predates the field.
   */
  schemaVersion?: number;
  generatedAt: string;
  widgets: ManifestWidget[];
  views: unknown[];
}

// ─── Manifest loading ────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the path to capabilities.json */
function resolveManifestPath(): string {
  // 1. Env override (production: mount the JSON wherever you want)
  if (process.env.CAPABILITIES_MANIFEST_PATH) {
    return process.env.CAPABILITIES_MANIFEST_PATH;
  }

  // 2. Dev: relative to this file → synap-app/packages/core/capabilities/dist/
  return path.resolve(
    __dirname,
    "../../../../..", // → synap root
    "synap-app/packages/core/capabilities/dist/capabilities.json"
  );
}

function loadManifest(): CapabilitiesManifest | null {
  const manifestPath = resolveManifestPath();

  if (!fs.existsSync(manifestPath)) {
    logger.warn(
      { path: manifestPath },
      "capabilities.json not found — run `pnpm --filter @synap/capabilities build` to generate it. Widget definitions will not be seeded."
    );
    return null;
  }

  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as CapabilitiesManifest;
  } catch (err) {
    logger.error(
      { err, path: manifestPath },
      "Failed to parse capabilities.json"
    );
    return null;
  }
}

// ─── Config schema conversion ────────────────────────────────────────────────

/**
 * Convert the capabilities configSchema array format to a JSONSchema object
 * that the DB stores and the AI consumes.
 */
function configSchemaArrayToJsonSchema(
  fields: ManifestWidget["configSchema"]
): Record<string, unknown> {
  if (!fields || fields.length === 0) {
    return { type: "object", properties: {} };
  }

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const field of fields) {
    const prop: Record<string, unknown> = {};

    if (field.options) {
      prop.type = "string";
      prop.enum = field.options.map((o) => o.value);
    } else {
      prop.type = field.type === "select" ? "string" : field.type;
    }

    if (field.description) prop.description = field.description;
    if (field.defaultValue !== undefined) prop.default = field.defaultValue;

    properties[field.key] = prop;

    if (field.required) {
      required.push(field.key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ─── Seed function ───────────────────────────────────────────────────────────

/**
 * Seed all built-in widget definitions from the capabilities manifest.
 *
 * Idempotent: uses ON CONFLICT DO UPDATE to keep the DB in sync with
 * the manifest. Adding a new widget to @synap/capabilities + rebuilding
 * + restarting the backend is all that's needed.
 */
export async function seedWidgetDefinitions(): Promise<void> {
  const manifest = loadManifest();

  if (!manifest) {
    logger.warn("Skipping widget definition seed — no manifest available");
    return;
  }

  try {
    const db = await getDb();

    // Filter out aliases — they share the same underlying cell, no separate DB row needed
    const widgets = manifest.widgets.filter((w) => !w.aliasOf);

    let seeded = 0;
    for (const widget of widgets) {
      const configSchema = configSchemaArrayToJsonSchema(widget.configSchema);

      await db
        .insert(widgetDefinitions)
        .values({
          typeKey: widget.key,
          workspaceId: null, // system-wide
          name: widget.name,
          description: widget.description,
          icon: widget.icon,
          category: widget.category,
          rendererType: "builtin",
          rendererSource: null,
          configSchema,
          defaultConfig: {},
          defaultSize: widget.defaultSize,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [widgetDefinitions.typeKey, widgetDefinitions.workspaceId],
          set: {
            name: widget.name,
            description: widget.description,
            icon: widget.icon ?? null,
            category: widget.category,
            configSchema,
            defaultSize: widget.defaultSize,
            updatedAt: new Date(),
          },
        });

      seeded++;
    }

    logger.info(
      {
        seeded,
        manifestVersion: manifest.version,
        manifestSchemaVersion: manifest.schemaVersion ?? null,
        generatedAt: manifest.generatedAt,
      },
      "Widget definitions synced from capabilities manifest"
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Failed to seed widget definitions (non-fatal)"
    );
  }
}
