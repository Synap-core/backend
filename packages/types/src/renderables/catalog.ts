/**
 * Renderable catalog helpers — the ONE place that reads the optional catalog
 * fields (`placements`, `dataBinding`, `fallback`, `requiredConfig`) and turns
 * them into answers. Every consumer (backend list/arrange, browser pickers,
 * relay fallback, AI discovery) calls these instead of re-deriving a default.
 *
 * Pure data → data. No React, no zod, no DB.
 */

import type { Placement } from "./content-kinds.js";
import type {
  CellSettingsField,
  RenderableDataBinding,
  WidgetCapabilityDef,
} from "./types.js";
import { WIDGET_TYPE_KEYS } from "./types.js";
import { WIDGET_BY_KEY } from "./widgets.js";
import { CHART_DATA_EXAMPLES } from "./chart-data.js";

/**
 * Where a catalog widget renders when its entry declares no `placements`.
 * Every catalog widget is document-embeddable (decision D-embed, 2026-09-25);
 * an entry narrows this by declaring its own list.
 */
export const DEFAULT_WIDGET_PLACEMENTS: readonly Placement[] = [
  "bento",
  "inline",
  "floating",
];

/**
 * Where an INSTALLED frame cell (`cell:<pkg>:<key>` / `generated:<slug>`)
 * renders when its row declares nothing (decision D-place, 2026-09-25).
 */
export const DEFAULT_INSTALLED_PLACEMENTS: readonly Placement[] = [
  "bento",
  "inline",
];

/** Fallback template used when an entry declares none. */
export const DEFAULT_FALLBACK_TEMPLATE = "{name}: {props.label}";

export function placementsFor(
  def: Pick<WidgetCapabilityDef, "placements">
): Placement[] {
  return [...(def.placements ?? DEFAULT_WIDGET_PLACEMENTS)];
}

/** `inline` placement = may be written as `:::synap-cell{cellKey}` in a document. */
export function isDocumentEmbeddable(
  def: Pick<WidgetCapabilityDef, "placements">
): boolean {
  return placementsFor(def).includes("inline");
}

/**
 * The config keys an embed/arrange MUST carry. The explicit `requiredConfig`
 * wins; otherwise the schema's `required: true` fields.
 */
export function requiredConfigFor(
  def: Pick<WidgetCapabilityDef, "requiredConfig" | "configSchema">
): string[] {
  if (def.requiredConfig) return [...def.requiredConfig];
  return def.configSchema.filter((f) => f.required).map((f) => f.key);
}

/**
 * An agent may place this widget only when the catalog has CURATED its
 * required config (an explicit `requiredConfig`, even `[]`). A widget whose
 * required config is merely derived from the schema may still need host
 * context nobody declared (a channel, a session) — placing it would render a
 * broken cell, so it stays human-placed until someone curates it.
 */
export function isAiPlaceable(
  def: Pick<WidgetCapabilityDef, "requiredConfig">
): boolean {
  return def.requiredConfig !== undefined;
}

/** The required keys a given config leaves empty (null / undefined / ""). */
export function missingRequiredConfig(
  def: Pick<WidgetCapabilityDef, "requiredConfig" | "configSchema">,
  config: Record<string, unknown> | undefined
): string[] {
  return requiredConfigFor(def).filter((key) => {
    const value = config?.[key];
    return value == null || value === "";
  });
}

/** The declared binding, or `null` when the entry has not been classified. */
export function dataBindingFor(
  def: Pick<WidgetCapabilityDef, "dataBinding">
): RenderableDataBinding | null {
  if (!def.dataBinding) return null;
  return {
    supports: [...def.dataBinding.supports],
    default: def.dataBinding.default,
    ...(def.dataBinding.dataShape
      ? { dataShape: def.dataBinding.dataShape }
      : {}),
  };
}

/**
 * Render a fallback template without React. `{name}` → the entry name;
 * `{props.<key>}` → that prop when it is a string/number/boolean, else empty.
 * Separators orphaned by an empty placeholder (": ", " — ") are trimmed, and an
 * empty result falls back to the name — a fallback is never blank.
 */
export function renderRenderableFallback(
  template: string,
  input: { name: string; props?: Record<string, unknown> }
): string {
  const rendered = template.replace(
    /\{(name|props\.([A-Za-z0-9_-]+))\}/g,
    (_whole, token: string, propKey: string | undefined) => {
      if (token === "name") return input.name;
      const value = propKey ? input.props?.[propKey] : undefined;
      return typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
        ? String(value)
        : "";
    }
  );
  const trimmed = rendered
    .replace(/^[\s:—–-]+/, "")
    .replace(/[\s:—–-]+$/, "")
    .trim();
  return trimmed.length > 0 ? trimmed : input.name;
}

/** The fallback markdown for one catalog widget + its embed props. */
export function fallbackFor(
  def: Pick<WidgetCapabilityDef, "name" | "fallback">,
  props?: Record<string, unknown>
): string {
  return renderRenderableFallback(def.fallback ?? DEFAULT_FALLBACK_TEMPLATE, {
    name: def.name,
    props,
  });
}

// ─── JSON Schema (the AI-facing props schema) ────────────────────────────────

export interface RenderableJsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/**
 * Picker kinds whose stored value is a string (an id, slug, key, hex, icon
 * name). They render a smart editor in the UI but are plain strings on the wire.
 */
const STRING_VALUED_FIELD_TYPES = new Set<CellSettingsField["type"]>([
  "string",
  "select",
  "profile",
  "property",
  "entity",
  "relation-type",
  "view",
  "channel",
  "automation",
  "command",
  "icon",
  "color",
  "date",
  "variant",
  "url",
]);

function fieldToJsonSchema(field: CellSettingsField): Record<string, unknown> {
  if (field.jsonSchema) return { ...field.jsonSchema };
  const prop: Record<string, unknown> = {};
  if (field.options && field.options.length > 0) {
    prop.type = "string";
    prop.enum = field.options.map((o) => o.value);
  } else if (STRING_VALUED_FIELD_TYPES.has(field.type)) {
    prop.type = "string";
  } else if (field.type === "number" || field.type === "boolean") {
    prop.type = field.type;
  } else if (field.type === "list") {
    prop.type = "array";
    prop.items = field.itemSchema
      ? configFieldsToJsonSchema(field.itemSchema)
      : { type: "object" };
  } else if (field.type === "array") {
    prop.type = "array";
    prop.items = { type: "string" };
  } else {
    // "object" and "filter" (a condition-builder value) are objects.
    prop.type = "object";
  }
  if (field.description) prop.description = field.description;
  if (field.defaultValue !== undefined) prop.default = field.defaultValue;
  return prop;
}

/**
 * The catalog's `CellSettingsField[]` → a JSON Schema object (what the DB
 * stores for installed cells and what an agent reads). `required` carries the
 * CURATED required config when the caller passes it, so the schema and
 * `requiredConfigFor` never disagree.
 */
export function configFieldsToJsonSchema(
  fields: CellSettingsField[] | undefined,
  required?: string[]
): RenderableJsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const field of fields ?? []) {
    properties[field.key] = fieldToJsonSchema(field);
  }
  const requiredKeys =
    required ?? (fields ?? []).filter((f) => f.required).map((f) => f.key);
  for (const key of requiredKeys) {
    if (!properties[key]) properties[key] = { type: "string" };
  }
  return {
    type: "object",
    properties,
    ...(requiredKeys.length > 0 ? { required: requiredKeys } : {}),
  };
}

// ─── Example embed props (the document grammar, plan §3 / decision D1) ───────

/**
 * The props of an example embed of this renderable: its required keys as
 * `<key>` placeholders, a `label` when it takes one, and — for a
 * snapshot-by-default chart (D2) — example `data` + `capturedAt`.
 *
 * Props only, never markup: the directive itself is written by markdown-core's
 * `serializeEmbed`, the ONE embed writer (this leaf cannot import it).
 */
export function exampleEmbedProps(
  def: Pick<
    WidgetCapabilityDef,
    "requiredConfig" | "configSchema" | "dataBinding"
  >
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const key of requiredConfigFor(def)) props[key] = `<${key}>`;
  if (def.configSchema.some((f) => f.key === "label")) props.label = "<label>";
  // A snapshot-by-default entry (D2) shows its frozen data: the query keys stay
  // (so "make live" works), `data` + `capturedAt` carry what the text describes.
  const shape = def.dataBinding?.dataShape;
  if (shape && def.dataBinding?.default === "inline") {
    props.data = CHART_DATA_EXAMPLES[shape];
    props.capturedAt = "<ISO date>";
  }
  return props;
}

// ─── Key namespaces ──────────────────────────────────────────────────────────

const BUILTIN_KEYS: ReadonlySet<string> = new Set<string>([
  ...WIDGET_TYPE_KEYS,
  ...Object.keys(WIDGET_BY_KEY),
]);

/**
 * Built-in widget keys are RESERVED: no pack, workspace or AI definition may
 * claim one. Installed cells are always namespaced (`cell:` / `generated:`).
 */
export function isBuiltinRenderableKey(key: string): boolean {
  return BUILTIN_KEYS.has(key);
}

/** An installed (pack) or AI-generated cell key — lives in `widget_definitions`. */
export function isInstalledRenderableKey(key: string): boolean {
  return key.startsWith("cell:") || key.startsWith("generated:");
}
