/**
 * Renderables — the pod's ONE read door for "what can be rendered here".
 *
 *   listRenderables(ws) = built-in catalog (in-process) ∪ widget_definitions rows
 *
 * The built-ins are CODE: `WIDGET_DEFINITIONS` from `@synap-core/types/renderables`
 * (the same catalog the browser registers from), imported in-process. There is
 * no boot seeder and no sync job — the previous seeder read a sibling repo's
 * `dist/capabilities.json` that no deploy ever shipped, so production pods knew
 * none of the built-ins, and a hand-written 18-key allowlist papered over it.
 *
 * DB rows are what only a pod can know: pack-installed cells (`cell:<pkg>:<key>`),
 * AI-defined cells (`generated:<slug>`) and Cell Studio authoring. Built-in keys
 * are RESERVED: a row whose typeKey is a built-in never shadows the catalog
 * (the write doors refuse to mint one — `assertMayWriteNamespacedTypeKey`).
 *
 * Every consumer — hub `listWidgetDefs`, MCP `synap_list_widgets`, bento
 * arrange validation — reads through here.
 */

import { getDb, and, eq, or, isNull } from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import { serializeEmbed } from "@synap-core/markdown-core/embeds";
import {
  DEFAULT_FALLBACK_TEMPLATE,
  DEFAULT_INSTALLED_PLACEMENTS,
  FENCE_RENDERABLES,
  WIDGET_BY_KEY,
  WIDGET_DEFINITIONS,
  configFieldsToJsonSchema,
  dataBindingFor,
  exampleEmbedProps,
  isAiPlaceable,
  isBuiltinRenderableKey,
  isInstalledRenderableKey,
  missingRequiredConfig,
  placementsFor,
  requiredConfigFor,
  type Placement,
  type RenderableDataBinding,
  type WidgetCapabilityDef,
} from "@synap-core/types/renderables";

/** The catalog fields every renderable row carries, built-in or installed. */
export interface RenderableCatalogFields {
  placements: Placement[];
  /** `null` = the entry has not declared a binding (not "none"). */
  dataBinding: RenderableDataBinding | null;
  requiredConfig: string[];
  /** May an agent place it (bento arrange / document embed)? */
  aiPlaceable: boolean;
  aiHint: string | null;
  /** Markdown fallback TEMPLATE (`{name}`, `{props.<key>}`). */
  fallback: string;
  form: "directive";
  package: string | null;
}

/**
 * A `widget_definitions`-shaped row (the existing GET /widget-definitions
 * contract) plus the catalog fields. `source: "catalog"` marks a built-in.
 */
export type RenderableRow = Record<string, unknown> &
  RenderableCatalogFields & {
    typeKey: string;
    name: string;
    description: string | null;
    rendererType: string;
    workspaceId: string | null;
    configSchema: Record<string, unknown>;
    source: string | null;
  };

function builtinRow(def: WidgetCapabilityDef): RenderableRow {
  const requiredConfig = requiredConfigFor(def);
  return {
    id: `catalog:${def.key}`,
    typeKey: def.key,
    name: def.name,
    description: def.description,
    icon: def.icon,
    category: def.category,
    rendererType: "builtin",
    rendererSource: null,
    workspaceId: null,
    isActive: true,
    defaultSize: def.defaultSize,
    minSize: def.minSize ?? null,
    configSchema: configFieldsToJsonSchema(
      def.configSchema,
      requiredConfig
    ) as unknown as Record<string, unknown>,
    defaultConfig: {},
    aliasOf: def.aliasOf ?? null,
    hiddenFromPicker: def.hiddenFromPicker ?? false,
    source: "catalog",
    placements: placementsFor(def),
    dataBinding: dataBindingFor(def),
    requiredConfig,
    aiPlaceable: isAiPlaceable(def),
    aiHint: def.aiHint ?? null,
    fallback: def.fallback ?? DEFAULT_FALLBACK_TEMPLATE,
    form: "directive",
    package: def.package ?? null,
  };
}

/** The built-in catalog as rows — pure, no DB. */
export function builtinRenderableRows(): RenderableRow[] {
  return WIDGET_DEFINITIONS.map(builtinRow);
}

function schemaRequired(configSchema: unknown): string[] {
  const required = (configSchema as { required?: unknown } | null)?.required;
  return Array.isArray(required)
    ? required.filter((k): k is string => typeof k === "string")
    : [];
}

type WidgetDefinitionRow = typeof widgetDefinitions.$inferSelect;

function installedRow(row: WidgetDefinitionRow): RenderableRow {
  return {
    ...row,
    configSchema: row.configSchema ?? {},
    source: row.source ?? null,
    // No placements column: installed cells default per decision D-place.
    placements: [...DEFAULT_INSTALLED_PLACEMENTS],
    dataBinding: null,
    requiredConfig: schemaRequired(row.configSchema),
    // Arrange admits a namespaced (pack / AI-defined) cell that EXISTS here.
    // A bare-kebab studio row is not curated for agents.
    aiPlaceable: isInstalledRenderableKey(row.typeKey),
    aiHint: null,
    fallback: DEFAULT_FALLBACK_TEMPLATE,
    form: "directive",
    package: row.typeKey.startsWith("cell:")
      ? (row.typeKey.split(":")[1] ?? null)
      : null,
  };
}

/**
 * Built-in catalog ∪ the active `widget_definitions` rows visible at
 * `workspaceId` (pod-global rows always; that workspace's rows when given).
 * A row whose typeKey is a built-in is dropped — built-in keys are reserved,
 * so the catalog entry always wins.
 */
export async function listRenderables(
  workspaceId: string | null
): Promise<RenderableRow[]> {
  const db = await getDb();
  const rows = await db.query.widgetDefinitions.findMany({
    where: and(
      or(
        isNull(widgetDefinitions.workspaceId),
        workspaceId ? eq(widgetDefinitions.workspaceId, workspaceId) : undefined
      ),
      eq(widgetDefinitions.isActive, true)
    ),
    orderBy: (t, { asc }) => [asc(t.workspaceId), asc(t.name)],
  });
  const installed = rows
    .filter((row) => !isBuiltinRenderableKey(row.typeKey))
    .map(installedRow);
  return [...builtinRenderableRows(), ...installed];
}

// ─── Arrange validation ──────────────────────────────────────────────────────

const AI_PLACEABLE_BUILTIN_KEYS = WIDGET_DEFINITIONS.filter(
  (d) => isAiPlaceable(d) && !d.aliasOf
).map((d) => d.key);

/**
 * Error string if an agent may not arrange `key` with `config`; null if ok.
 *
 * `installed` maps each placeable installed typeKey visible in this workspace
 * to its required config (from `listRenderables`). A namespaced key that is
 * not in it is refused — it must EXIST on this pod, even when the pod has no
 * installed cells at all.
 */
export function renderableArrangeError(
  key: string,
  config: Record<string, unknown> | undefined,
  installed: ReadonlyMap<string, readonly string[]>
): string | null {
  const def = WIDGET_BY_KEY[key];
  if (def) {
    if (!isAiPlaceable(def)) {
      return (
        `Widget "${key}" is not agent-placeable: it needs host context the ` +
        `catalog has not curated. Use one of: ${AI_PLACEABLE_BUILTIN_KEYS.join(", ")}.`
      );
    }
    const missing = missingRequiredConfig(def, config);
    if (missing.length > 0) {
      return `Widget "${key}" needs config.${missing.join(", config.")}.${def.aiHint ? ` ${def.aiHint}` : ""}`;
    }
    return null;
  }
  if (isInstalledRenderableKey(key)) {
    const required = installed.get(key);
    if (!required) {
      return `Unknown installed cell "${key}" in this workspace. Call synap_list_widgets / GET /widget-definitions first.`;
    }
    const missing = required.filter((k) => {
      const value = config?.[k];
      return value == null || value === "";
    });
    return missing.length > 0
      ? `Cell "${key}" needs config.${missing.join(", config.")}.`
      : null;
  }
  return (
    `Unknown widget "${key}". Use one of: ${AI_PLACEABLE_BUILTIN_KEYS.join(", ")}. ` +
    `Or a cell:<pkg>:<key> / generated:<slug> cell from synap_list_widgets.`
  );
}

/** The placeable installed keys → required config, from a `listRenderables` result. */
export function placeableInstalledKeys(
  rows: readonly RenderableRow[]
): Map<string, readonly string[]> {
  return new Map(
    rows
      .filter((r) => r.source !== "catalog" && r.aiPlaceable)
      .map((r) => [r.typeKey, r.requiredConfig] as const)
  );
}

// ─── AI discovery (MCP synap_list_widgets) ───────────────────────────────────

export type RenderableSurface = "document" | "bento";

/** The fallback slot of an example embed: what the author writes there. */
const EXAMPLE_FALLBACK = "<one sentence: what this shows>";

export interface RenderableDiscoveryEntry {
  key: string;
  name: string;
  description: string;
  /** JSON Schema of the embed props / block config. */
  propsSchema: Record<string, unknown>;
  requiredConfig: string[];
  binding: RenderableDataBinding | null;
  /** The embed written in the document grammar (plan §3). */
  exampleDirective: string;
  fallback: string;
  aiHint: string | null;
  defaultSize?: unknown;
  installed: boolean;
}

/**
 * What an agent may place on `surface`: agent-placeable, non-alias rows whose
 * placements include it (`document` ⇒ `inline`).
 */
export function discoverRenderables(
  rows: readonly RenderableRow[],
  surface: RenderableSurface
): RenderableDiscoveryEntry[] {
  const placement: Placement = surface === "document" ? "inline" : "bento";
  return rows
    .filter(
      (r) => r.aiPlaceable && !r.aliasOf && r.placements.includes(placement)
    )
    .map((r) => ({
      key: r.typeKey,
      name: r.name,
      description: r.description ?? "",
      propsSchema: r.configSchema,
      requiredConfig: r.requiredConfig,
      binding: r.dataBinding,
      exampleDirective: serializeEmbed({
        directive: "synap-cell",
        ref: { cellKey: r.typeKey },
        props: exampleEmbedProps({
          requiredConfig: r.requiredConfig,
          configSchema:
            r.source === "catalog"
              ? (WIDGET_BY_KEY[r.typeKey]?.configSchema ?? [])
              : [],
          // A document embed shows its snapshot form (D2); a dashboard stays live.
          ...(surface === "document" && r.dataBinding
            ? { dataBinding: r.dataBinding }
            : {}),
        }),
        fallback: EXAMPLE_FALLBACK,
      }),
      fallback: r.fallback,
      aiHint: r.aiHint,
      ...(surface === "bento" ? { defaultSize: r.defaultSize } : {}),
      installed: r.source !== "catalog",
    }));
}

/** A content language a document writes as a fenced block (catalog `form: "fence"`). */
export interface FenceDiscoveryEntry {
  key: string;
  name: string;
  description: string;
  /** Info-string languages that select it; `[]` = any other language (code). */
  languages: readonly string[];
  aiHint: string;
}

/**
 * The fence rows of the ONE catalog (`FENCE_RENDERABLES`) that a document may
 * hold — derived, never a hand list, so a new fence row is discoverable by
 * existing.
 */
export function discoverFences(): FenceDiscoveryEntry[] {
  return FENCE_RENDERABLES.filter((f) => f.placements.includes("inline")).map(
    (f) => ({
      key: f.key,
      name: f.name,
      description: f.description,
      languages: f.languages,
      aiHint: f.aiHint,
    })
  );
}
