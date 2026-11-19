/**
 * THE CATALOG SNAPSHOT — what a design may be made of, as data the pod holds,
 * so the pod can refuse a design the canvas could not draw (plan 0fc746f4
 * §2.6, §3.3 option S1).
 *
 * Synap's snapshot is GENERATED in app-bases (from the same derivation the
 * canvas's Puck config uses) and ships inside the `design` capability package,
 * in the definition's `metadata` under {@link DESIGN_CATALOG_METADATA_KEY}.
 * The pod stores a definition's `metadata` on the installed capability
 * container (`capabilities.metadata`) and re-stamps it when the package
 * updates, so the snapshot a pod validates with is the one its installed
 * package carries. Every refusal names the snapshot's `hash`.
 *
 * Pure: no I/O. `readDesignCatalog` refuses a snapshot it cannot trust
 * (never "repairs" one into an empty catalog).
 */
import { isUuid } from "../property-render/structured-value.js";
import { GRID_PROPS } from "./grid.js";
import type { CanvasSchema, FieldSpec, ItemFieldSpec } from "./schema.js";

/** The catalog key of the capability package that carries the design verbs and Synap's snapshot. */
export const DESIGN_CAPABILITY_KEY = "design";

/** Where the snapshot rides in the package definition's `metadata` (and so in the installed container's). */
export const DESIGN_CATALOG_METADATA_KEY = "designCatalog";

/** The kit id of Synap's own component catalog (a client app's kit gets its own id, W6). */
export const SYNAP_KIT_ID = "synap";

export interface DesignCatalogSnapshot {
  /** Which component kit this is: {@link SYNAP_KIT_ID} for Synap's own. */
  kitId: string;
  /** Content hash of `components` + `layout`, written by the generator. Named in every refusal. */
  hash: string;
  /** The kit's components: name → declared props (a slot is a prop of kind `slot`). */
  components: CanvasSchema;
  /**
   * The canvas's own blocks (Section, Box, Stack, Row, Grid, Heading, Text,
   * Motion): name → declared props. Their spacing, radius and colour props are
   * `select`s whose options are token steps.
   */
  layout: CanvasSchema;
  /** When the generator wrote it (ISO), for people; never compared. */
  generatedAt?: string;
}

export type ReadCatalogResult =
  { ok: true; catalog: DesignCatalogSnapshot } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

function itemSpecOk(v: unknown): v is ItemFieldSpec {
  return (
    isObj(v) &&
    (v.kind === "text" || v.kind === "number" || v.kind === "boolean")
  );
}

function fieldSpecOk(v: unknown): v is FieldSpec {
  if (!isObj(v)) return false;
  switch (v.kind) {
    case "text":
      return v.multiline === undefined || typeof v.multiline === "boolean";
    case "number":
    case "boolean":
      return true;
    case "select":
      return strings(v.options);
    case "slot":
      return v.allow === undefined || strings(v.allow);
    case "list":
      return (
        isObj(v.item) &&
        Object.values(v.item).every(itemSpecOk) &&
        strings(v.required)
      );
    default:
      return false;
  }
}

function schemaProblem(label: string, raw: unknown): string | null {
  if (!isObj(raw)) return `\`${label}\` is not an object of components.`;
  for (const [name, fields] of Object.entries(raw)) {
    if (!isObj(fields)) return `${label}.${name} is not an object of props.`;
    for (const [prop, spec] of Object.entries(fields)) {
      if (GRID_PROPS.includes(prop))
        return `${label}.${name} declares \`${prop}\`, which every block already has (span and hide per width class).`;
      if (!fieldSpecOk(spec))
        return `${label}.${name}.${prop} is not a prop spec the canvas knows.`;
    }
  }
  return null;
}

/**
 * Read a snapshot as stored (the installed container's metadata). Refuses a
 * missing hash or kit, a prop spec of an unknown kind, a component named in
 * both halves, and a component declaring `span` / `hide` itself.
 */
export function readDesignCatalog(raw: unknown): ReadCatalogResult {
  if (!isObj(raw))
    return { ok: false, error: "The design catalog is not an object." };
  if (typeof raw.kitId !== "string" || raw.kitId === "")
    return { ok: false, error: "The design catalog names no kit (`kitId`)." };
  if (typeof raw.hash !== "string" || raw.hash === "")
    return { ok: false, error: "The design catalog has no `hash`." };
  const problem =
    schemaProblem("components", raw.components) ??
    schemaProblem("layout", raw.layout);
  if (problem) return { ok: false, error: problem };
  const components = raw.components as CanvasSchema;
  const layout = raw.layout as CanvasSchema;
  const both = Object.keys(components).filter((n) =>
    Object.prototype.hasOwnProperty.call(layout, n)
  );
  if (both.length > 0)
    return {
      ok: false,
      error: `The design catalog names ${both.join(", ")} both as a component and as a canvas block.`,
    };
  return {
    ok: true,
    catalog: {
      kitId: raw.kitId,
      hash: raw.hash,
      components,
      layout,
      ...(typeof raw.generatedAt === "string"
        ? { generatedAt: raw.generatedAt }
        : {}),
    },
  };
}

/** The one schema a design is validated against: the canvas blocks and the kit's components. */
export function catalogSchema(catalog: DesignCatalogSnapshot): CanvasSchema {
  return { ...catalog.layout, ...catalog.components };
}

// ─── A client app's kit (plan 0fc746f4 §3.1 K1, W6) ────────────────────────

/**
 * The `devplane_app` property naming the app's kit: a `file` entity holding
 * the kit's catalog.json (`pnpm design:kit --publish` in a Website Factory
 * app). Absent = the app is drawn with Synap's own kit.
 */
export const DESIGN_KIT_PROPERTY = "design-kit";

/** One of the kit's two code files on the pod, pinned by its bytes' sha256. */
export interface KitFileRef {
  entityId: string;
  sha256: string;
  bytes: number;
}

/** The kit's two code files. */
export type KitPart = "js" | "css";
export const KIT_PARTS: readonly KitPart[] = ["js", "css"];

/**
 * A client app's catalog.json: the snapshot shape (its `layout` empty: the
 * canvas's own blocks are Synap's, the pod adds them, {@link composeAppCatalog}),
 * plus `kit` (the React major it was built against and its two files) and
 * `canvas` (how a dropped block starts: the Design app's business, passed
 * through as it is).
 */
export interface DesignKitCatalog extends DesignCatalogSnapshot {
  kit: {
    /** The React MAJOR the kit was built against ("19"): the Design app lends its own React. */
    react: string;
    files: Record<KitPart, KitFileRef>;
    /** Where it was built (repo, sha), for people; never compared. */
    build?: unknown;
  };
  canvas: { components: Record<string, unknown>; categories?: unknown };
}

export type ReadKitCatalogResult =
  { ok: true; catalog: DesignKitCatalog } | { ok: false; error: string };

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Read a client kit's catalog.json. Refuses what the snapshot reader refuses,
 * plus: Synap's own kit id, canvas blocks declared by the kit, a component
 * with no `canvas` entry, no React major, a code file without its id and
 * sha256. Never "repairs" a kit into an empty one.
 */
export function readKitCatalog(raw: unknown): ReadKitCatalogResult {
  const base = readDesignCatalog(raw);
  if (!base.ok) return base;
  const r = raw as Record<string, unknown>;
  if (base.catalog.kitId === SYNAP_KIT_ID)
    return {
      ok: false,
      error: `A client kit cannot be named "${SYNAP_KIT_ID}": that is Synap's own kit.`,
    };
  if (Object.keys(base.catalog.layout).length > 0)
    return {
      ok: false,
      error:
        "A client kit declares no canvas blocks (`layout` is empty): Section, Stack, Text… are Synap's, the pod adds them.",
    };
  if (Object.keys(base.catalog.components).length === 0)
    return { ok: false, error: "The kit has no components." };
  const canvas = r.canvas;
  if (!isObj(canvas) || !isObj(canvas.components))
    return { ok: false, error: "The kit's catalog has no `canvas` block." };
  for (const name of Object.keys(base.catalog.components))
    if (!isObj(canvas.components[name]))
      return {
        ok: false,
        error: `The kit's canvas block has no entry for ${name}.`,
      };
  const kit = r.kit;
  if (!isObj(kit) || typeof kit.react !== "string" || !/^\d+$/.test(kit.react))
    return {
      ok: false,
      error: 'The kit names no React major (`kit.react`, e.g. "19").',
    };
  if (!isObj(kit.files))
    return { ok: false, error: "The kit lists no code files (`kit.files`)." };
  const files = {} as Record<KitPart, KitFileRef>;
  for (const part of KIT_PARTS) {
    const f = kit.files[part];
    if (
      !isObj(f) ||
      typeof f.entityId !== "string" ||
      !isUuid(f.entityId) ||
      typeof f.sha256 !== "string" ||
      !SHA256.test(f.sha256) ||
      typeof f.bytes !== "number"
    )
      return {
        ok: false,
        error: `The kit's ${part} file is not published (kit.files.${part} needs entityId, sha256 and bytes): run \`pnpm design:kit --publish\`.`,
      };
    files[part] = { entityId: f.entityId, sha256: f.sha256, bytes: f.bytes };
  }
  return {
    ok: true,
    catalog: {
      ...base.catalog,
      kit: {
        react: kit.react,
        files,
        ...(kit.build !== undefined ? { build: kit.build } : {}),
      },
      canvas: {
        components: canvas.components,
        ...(canvas.categories !== undefined
          ? { categories: canvas.categories }
          : {}),
      },
    },
  };
}

/**
 * The catalog a design of an app with a kit is validated against: the kit's
 * components, Synap's canvas blocks (the same for every kit, plan D1). Its
 * hash names both (`<kit>+<synap>`), so a refusal says which changed. A kit
 * component named like a canvas block is refused, as in any snapshot.
 */
export function composeAppCatalog(
  synap: DesignCatalogSnapshot,
  kit: DesignKitCatalog
): ReadCatalogResult {
  return readDesignCatalog({
    kitId: kit.kitId,
    hash: `${kit.hash}+${synap.hash}`,
    components: kit.components,
    layout: synap.layout,
    ...(kit.generatedAt ? { generatedAt: kit.generatedAt } : {}),
  });
}
