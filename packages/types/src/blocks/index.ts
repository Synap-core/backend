/** @folder The one Block: what a composed body (bento, sheet canvas, markdown document, whiteboard) places. */
/**
 * THE ONE BLOCK (Surfaces P5, audit appendix B §4 Q2). Five bodies place the
 * same three things, a saved VIEW, one ENTITY, or a CELL, and each had its own
 * type for it: the bento zod (`kind:"widget"`, `widgetType`, `config`), the
 * app's `BentoWidgetBlock` (`cellInstanceId`), the template `BentoBlockDef`,
 * the sheet canvas (`kind:"cell"`, `cellKey`, `props`), markdown embeds
 * (`synap-cell{cellKey|instanceId}` + a json props block) and whiteboard cell
 * shapes (`cellProps` as a JSON string). `Block` is the one shape; where a body
 * puts it is the body's own `place` (`PlacedBlock<P>`).
 *
 * Every reader goes through {@link readLegacyBlock}, which accepts the old
 * spellings: `kind:"widget"` → `"cell"`, `widgetType` → `cellKey`, `config` →
 * `props`, `cellInstanceId` → `instanceId`, `cellProps` (JSON) → `props`.
 * Writers may emit the canonical `{ kind: "cell", cellKey }`.
 *
 * PLACEMENT RULE (where a cell's config lives):
 *   - By default a cell is placed INLINE: `{ kind: "cell", cellKey, props }`.
 *     The body stores the props; nothing else is written.
 *   - A `cell_instances` row (`instanceId`) only when the cell has its OWN
 *     state, shared or edited outside the body that places it, or an HTML
 *     body (an `html-embed` cell's document), as the whiteboard does today.
 *   - An instance carries its own config: a block naming an `instanceId`
 *     carries no inline `props` (one home for a cell's config). Every
 *     renderer already reads the instance and ignores inline props; the bento
 *     write door refuses a block that carries both
 *     (`BLOCK_PROPS_ON_INSTANCE`, `views/config-schemas.ts`).
 *
 * Dependency: zod only (the schema). No database, no React: markdown readers,
 * web, native and the browser may import it.
 */

import { z } from "zod";

// ─── The Block ───────────────────────────────────────────────────────────────

/** What a body can place. Order is the canonical order (manifest, docs). */
export const BLOCK_KINDS = ["view", "entity", "cell"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** How an entity block draws its entity. */
export const ENTITY_BLOCK_VARIANTS = ["card", "compact", "detailed"] as const;
export type EntityBlockVariant = (typeof ENTITY_BLOCK_VARIANTS)[number];

/** A saved view, drawn live. `overrides` are the body's presentation tweaks. */
export interface ViewBlock {
  kind: "view";
  viewId: string;
  overrides?: Record<string, unknown>;
}

/** One entity, drawn by its kind's renderer. */
export interface EntityBlock {
  kind: "entity";
  entityId: string;
  variant?: EntityBlockVariant;
}

/**
 * A cell: inline by key + props (the default), or a `cell_instances` row by
 * `instanceId` (see the placement rule above). An instance-only block (a
 * markdown `synap-cell{instanceId}`) names no key: the instance row does.
 */
export type CellBlock =
  | {
      kind: "cell";
      cellKey: string;
      props?: Record<string, unknown>;
      instanceId?: string;
    }
  | {
      kind: "cell";
      cellKey?: undefined;
      props?: undefined;
      instanceId: string;
    };

export type Block = ViewBlock | EntityBlock | CellBlock;

/**
 * A block where a body put it. `place` is the body's own coordinates:
 * {@link BentoPlace} for a bento, a range for a sheet, a box for a board; a
 * markdown document places by document order (no place).
 */
export interface PlacedBlock<P> {
  id: string;
  block: Block;
  place: P;
  title?: string;
  /** The body's shell treatment (bento `chrome`). */
  chrome?: string;
}

/** A bento tile's grid position (12-column units). */
export interface BentoPlace {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const PropsSchema = z.record(z.string(), z.unknown());

export const ViewBlockSchema = z.object({
  kind: z.literal("view"),
  viewId: z.string().uuid(),
  overrides: PropsSchema.optional(),
});

export const EntityBlockSchema = z.object({
  kind: z.literal("entity"),
  entityId: z.string().uuid(),
  variant: z.enum(ENTITY_BLOCK_VARIANTS).optional(),
});

/**
 * The cell arm's fields. A discriminated union needs one object per `kind`,
 * so "a key or an instance" and the placement rule are checked by
 * {@link cellBlockIssues}, which every schema that holds a cell arm runs.
 */
export const CellBlockSchema = z.object({
  kind: z.literal("cell"),
  cellKey: z.string().min(1).optional(),
  props: PropsSchema.optional(),
  instanceId: z.string().min(1).optional(),
});

/** Why a cell-arm value breaks the cell rules (empty = it does not). */
export function cellBlockIssues(value: {
  cellKey?: unknown;
  instanceId?: unknown;
  props?: unknown;
}): string[] {
  const issues: string[] = [];
  if (!value.cellKey && !value.instanceId) {
    issues.push("a cell block names a cellKey or an instanceId");
  }
  if (value.instanceId && hasProps(value.props)) {
    issues.push(BLOCK_PROPS_ON_INSTANCE);
  }
  return issues;
}

/** The placement rule's refusal, word for word (one string, every door). */
export const BLOCK_PROPS_ON_INSTANCE =
  "a cell block that names an instanceId carries no inline props: the cell_instances row holds its config";

function hasProps(props: unknown): boolean {
  return (
    !!props &&
    typeof props === "object" &&
    Object.keys(props as object).length > 0
  );
}

/** THE Block schema: a view, an entity, or a cell (key or instance). */
export const BlockSchema = z
  .discriminatedUnion("kind", [
    ViewBlockSchema,
    EntityBlockSchema,
    CellBlockSchema,
  ])
  .superRefine((block, ctx) => {
    if (block.kind !== "cell") return;
    for (const message of cellBlockIssues(block)) {
      ctx.addIssue({ code: "custom", message });
    }
  }) as unknown as z.ZodType<Block>;

// ─── The read codec (every legacy spelling → Block) ──────────────────────────

const LEGACY_CELL_KINDS = new Set(["cell", "widget"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Props from the first channel that carries them: `props`, then the legacy
 * `config`, then `cellProps` (an object, or a JSON string on a whiteboard
 * shape). `{ error }` when a channel carries props that cannot be read:
 * unreadable props are not "no props" (the cell would draw with an empty
 * config), so the caller refuses the block.
 */
function readProps(
  raw: Record<string, unknown>
): { props?: Record<string, unknown> } | { error: true } {
  for (const key of ["props", "config", "cellProps"]) {
    const v = raw[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string") {
      try {
        const parsed: unknown = JSON.parse(v);
        const obj = record(parsed);
        return obj ? { props: obj } : { error: true };
      } catch {
        return { error: true };
      }
    }
    const obj = record(v);
    return obj ? { props: obj } : { error: true };
  }
  return {};
}

/**
 * Read any stored block shape into the one {@link Block}, or `null` when it
 * names nothing drawable (no view id, no entity id, neither a cell key nor an
 * instance) or its props cannot be read.
 *
 * Accepts: bento `view` / `entity` / `widget` (`widgetType`, `config`,
 * `cellInstanceId`) and `cell`; the sheet canvas `view` / `entity` / `cell`;
 * whiteboard shape props (`cellKey`, `cellProps` JSON, `cellInstanceId`;
 * `viewId`; `entityId`), which carry no `kind` (inferred from the fields).
 * Body-local extras (`id`, `pos`, `chrome`, `query`, `range`, a sheet `table`
 * or `note`) are not part of a Block: the body keeps them.
 *
 * A block naming an instance reads WITHOUT inline props (the placement rule:
 * the instance holds the config; every renderer ignores inline props then).
 */
export function readLegacyBlock(raw: unknown): Block | null {
  const r = record(raw);
  if (!r) return null;
  const kind =
    str(r.kind) ??
    (str(r.cellKey) || str(r.widgetType)
      ? "cell"
      : str(r.viewId)
        ? "view"
        : str(r.entityId)
          ? "entity"
          : undefined);
  if (kind === "view") {
    const viewId = str(r.viewId);
    if (!viewId) return null;
    const overrides = record(r.overrides);
    return { kind: "view", viewId, ...(overrides ? { overrides } : {}) };
  }
  if (kind === "entity") {
    const entityId = str(r.entityId);
    if (!entityId) return null;
    const variant = (ENTITY_BLOCK_VARIANTS as readonly string[]).includes(
      r.variant as string
    )
      ? (r.variant as EntityBlockVariant)
      : undefined;
    return { kind: "entity", entityId, ...(variant ? { variant } : {}) };
  }
  if (kind && LEGACY_CELL_KINDS.has(kind)) {
    const instanceId = str(r.instanceId) ?? str(r.cellInstanceId);
    const cellKey = str(r.cellKey) ?? str(r.widgetType);
    if (!cellKey) return instanceId ? { kind: "cell", instanceId } : null;
    if (instanceId) return { kind: "cell", cellKey, instanceId };
    const read = readProps(r);
    if ("error" in read) return null;
    return { kind: "cell", cellKey, ...(read.props ? { props: read.props } : {}) };
  }
  return null;
}

/** The key a block draws with, when it names one (an instance-only cell does not). */
export function blockCellKey(block: Block): string | undefined {
  return block.kind === "cell" ? block.cellKey : undefined;
}

// ─── Markdown embeds ↔ Block ─────────────────────────────────────────────────
//
// markdown-core parses (`readEmbed` → `Embed`) and writes (`serializeEmbed` ←
// `EmbedInput`) the directives; it depends on no Synap package, so the codec
// lives here and speaks those two shapes structurally (the same split as
// `renderables/embed-model.ts`). The directive names and their reference
// attributes are stored content: they do not change.

/** The parts of a markdown-core `Embed` the codec reads. */
export interface EmbedParts {
  /** `synap-cell` | `synap-view` | `synap-entity` (others are not blocks). */
  directive: string;
  ref: Record<string, string>;
  props?: Record<string, unknown>;
}

/** The directive that writes each Block kind. */
export const BLOCK_EMBED_DIRECTIVES = {
  view: "synap-view",
  entity: "synap-entity",
  cell: "synap-cell",
} as const satisfies Record<BlockKind, string>;
export type BlockEmbedDirective =
  (typeof BLOCK_EMBED_DIRECTIVES)[BlockKind];

/** Is this embed directive one that carries a Block (not `synap-ask`, not a frame)? */
export function isBlockEmbedDirective(
  directive: string
): directive is BlockEmbedDirective {
  return (Object.values(BLOCK_EMBED_DIRECTIVES) as string[]).includes(
    directive
  );
}

/**
 * A markdown embed as a Block, or `null` (not a block directive, or no
 * reference). Reads the legacy `data-*` reference attributes too.
 */
export function embedToBlock(embed: EmbedParts): Block | null {
  const ref = embed.ref;
  switch (embed.directive) {
    case "synap-view": {
      const viewId = str(ref.viewId) ?? str(ref["data-view-id"]);
      if (!viewId) return null;
      const overrides = embed.props && hasProps(embed.props) ? embed.props : undefined;
      return { kind: "view", viewId, ...(overrides ? { overrides } : {}) };
    }
    case "synap-entity": {
      const entityId = str(ref.id);
      if (!entityId) return null;
      return readLegacyBlock({ kind: "entity", entityId, variant: ref.variant });
    }
    case "synap-cell": {
      const instanceId = str(ref.instanceId) ?? str(ref["data-instance-id"]);
      const cellKey = str(ref.cellKey) ?? str(ref["data-cell-key"]);
      if (!cellKey) return instanceId ? { kind: "cell", instanceId } : null;
      if (instanceId) return { kind: "cell", cellKey, instanceId };
      return {
        kind: "cell",
        cellKey,
        ...(embed.props && hasProps(embed.props) ? { props: embed.props } : {}),
      };
    }
    default:
      return null;
  }
}

/** A Block as the parts markdown-core's `serializeEmbed` writes. */
export function blockToEmbed(block: Block): EmbedParts {
  switch (block.kind) {
    case "view":
      return {
        directive: BLOCK_EMBED_DIRECTIVES.view,
        ref: { viewId: block.viewId },
        ...(block.overrides && hasProps(block.overrides)
          ? { props: block.overrides }
          : {}),
      };
    case "entity":
      return {
        directive: BLOCK_EMBED_DIRECTIVES.entity,
        ref: {
          id: block.entityId,
          ...(block.variant ? { variant: block.variant } : {}),
        },
      };
    case "cell":
      return {
        directive: BLOCK_EMBED_DIRECTIVES.cell,
        ref: {
          ...(block.cellKey ? { cellKey: block.cellKey } : {}),
          ...(block.instanceId ? { instanceId: block.instanceId } : {}),
        },
        ...(!block.instanceId && block.props && hasProps(block.props)
          ? { props: block.props }
          : {}),
      };
  }
}
