/**
 * The tldraw 2.4.6 records a placement writes, built OUTSIDE the editor.
 *
 * ONE pure builder for every writer that is not a live editor (the backend
 * place door today; the browser placer can move onto it later): the same
 * sizes, layouts, artboard deck and frame reparenting as synap-app
 * `whiteboard/placement/placeResourcesOnWhiteboard.ts`, written as the records
 * tldraw itself would store.
 *
 * WHY THE ENVELOPE MATTERS. A record in the board's Y.Map is `store.put` by
 * every client as it arrives. tldraw validates the envelope of every shape
 * (`createShapeValidator`: id `shape:…`, typeName, x, y, rotation, a valid
 * fractional `index`, a `page:`/`shape:` parentId, isLocked, opacity in 0..1,
 * props and meta as JSON). Synap's own shapes declare no prop validators
 * (props are any JSON), so their props must match what their ShapeUtil
 * renders: the defaults below are copied from each `getDefaultProps`. JSON
 * means no `undefined` anywhere.
 *
 * PERSISTED NAMES ARE FROZEN. Shape types, the meta keys and the id prefix are
 * stored in boards; renaming any of them orphans every board that holds it.
 */

import { indexAbove, isValidIndexKey } from "./fractional-index.js";
import type {
  AutomationEmbedMode,
  BoardPlacementOptions,
} from "./resources.js";

// ── Frozen persisted names ───────────────────────────────────────────────────

/** Synap's shape types as stored in boards. FROZEN. */
export const BOARD_SHAPE_TYPES = {
  entityCard: "entityCard",
  view: "view",
  cell: "cell",
  sticky: "sticky",
  artboard: "artboard",
  /** Legacy Synap frame (tldraw's native section is `frame`). */
  synapFrame: "synap-frame",
} as const;

/** Shape `meta` keys the place door writes. FROZEN. */
export const BOARD_PLACEMENT_META_KEYS = {
  /** `true` while an agent's shape waits for the person to keep it. */
  pending: "pending",
  /** Who placed it: `BoardPlacedBy`. */
  placedBy: "placedBy",
  /** ISO time it was placed. */
  placedAt: "placedAt",
  /** synap-app's "fit me to my media once" flag on a default-size card. */
  fitToMedia: "fitToMedia",
} as const;

/** Prefix of every shape id the place door makes. FROZEN. */
export const PLACED_SHAPE_ID_PREFIX = "shape:synap-placed-";

/** The realtime room of a board document. FROZEN. */
export function boardRoomId(documentId: string): string {
  return `whiteboard-${documentId}`;
}

/** The Y.Map that holds a board's tldraw records. FROZEN. */
export function boardStoreMapName(documentId: string): string {
  return `tl_map_${documentId}`;
}

/** `meta.placedBy`. */
export interface BoardPlacedBy {
  /** The person the placement was made for. */
  userId: string;
  /** The agent that placed it, when an agent did. */
  agentUserId?: string;
  /** The proposal it was approved through, when one was filed. */
  proposalId?: string;
}

// ── What the builder places ──────────────────────────────────────────────────

/**
 * A resource with everything it needs on the board. The door turns `html`,
 * `url`, `automation`, `cellDefinition` and `artboard-deck` resources into
 * cell instances first (as the browser placer does), so only these remain.
 */
export type PlaceableBoardResource =
  | {
      kind: "entity";
      entityId: string;
      entityType?: string | null;
      profileId?: string | null;
      title?: string | null;
      properties?: Record<string, unknown>;
      status?: string;
      updatedAt?: string;
    }
  | {
      kind: "view";
      viewId: string;
      viewType?: string | null;
      title?: string | null;
    }
  | {
      kind: "cellInstance";
      cellInstanceId: string;
      cellKey?: string;
      props?: Record<string, unknown>;
      title?: string | null;
      defaultSize?: { w: number; h: number };
    }
  | {
      kind: "artboard-deck-materialized";
      preset: string;
      title?: string;
      slides: Array<{ cellInstanceId: string; title?: string }>;
    };

/** The cell each automation mode is shown as (synap-app AUTOMATION_CELL_BY_MODE). */
export const AUTOMATION_CELL_BY_MODE: Record<
  AutomationEmbedMode,
  { cellKey: string; title: string; defaultSize: { w: number; h: number } }
> = {
  flow: {
    cellKey: "automation-flow",
    title: "Automation flow",
    defaultSize: { w: 5, h: 4 },
  },
  detail: {
    cellKey: "automation-detail",
    title: "Automation detail",
    defaultSize: { w: 4, h: 4 },
  },
  status: {
    cellKey: "automation-status",
    title: "Automation status",
    defaultSize: { w: 3, h: 2 },
  },
  trigger: {
    cellKey: "trigger-button",
    title: "Automation trigger",
    defaultSize: { w: 2, h: 2 },
  },
};

/** The cell a materialized html / url resource becomes. */
export const HTML_CELL_KEY = "html-embed";
export const URL_CELL_KEY = "iframe-embed";
/** Grid size of an html / url cell (synap-app `defaultSize: { w: 6, h: 4 }`). */
export const EMBED_CELL_GRID_SIZE = { w: 6, h: 4 } as const;

// ── Artboard presets (synap-app `artboards/model.ts`) ────────────────────────

export const ARTBOARD_PRESET_SIZES: Record<
  string,
  { label: string; outputWidth: number; outputHeight: number }
> = {
  "slide-16-9": { label: "Slide", outputWidth: 1920, outputHeight: 1080 },
  "slide-4-3": { label: "Slide 4:3", outputWidth: 1024, outputHeight: 768 },
  "a4-portrait": {
    label: "A4 Portrait",
    outputWidth: 2480,
    outputHeight: 3508,
  },
  letter: { label: "Letter", outputWidth: 2550, outputHeight: 3300 },
  "social-square": {
    label: "Social Square",
    outputWidth: 1080,
    outputHeight: 1080,
  },
  story: { label: "Story / Reel", outputWidth: 1080, outputHeight: 1920 },
  "linkedin-carousel": {
    label: "LinkedIn Carousel",
    outputWidth: 1080,
    outputHeight: 1350,
  },
  "web-hero": { label: "Web Hero", outputWidth: 1600, outputHeight: 900 },
};
const DEFAULT_ARTBOARD_PRESET = "slide-16-9";

function artboardDisplaySize(outputWidth: number, outputHeight: number) {
  const safeW = Math.max(1, outputWidth);
  const safeH = Math.max(1, outputHeight);
  const ratio = safeW / safeH;
  if (ratio >= 1) return { w: 640, h: Math.round(640 / ratio) };
  return { w: Math.round(640 * ratio), h: 640 };
}

/** synap-app `createArtboardProps` (background "paper"). */
export function artboardProps(input: {
  presetId: string;
  pageIndex: number;
  title?: string;
}): Record<string, unknown> {
  // An unknown preset (and "custom") is sized as the default one
  // (`getArtboardPreset`); the id is kept as given, as the browser does.
  const preset =
    ARTBOARD_PRESET_SIZES[input.presetId] ??
    ARTBOARD_PRESET_SIZES[DEFAULT_ARTBOARD_PRESET];
  const size = artboardDisplaySize(preset.outputWidth, preset.outputHeight);
  return {
    w: size.w,
    h: size.h,
    title:
      input.title ??
      (input.presetId === "custom"
        ? `Custom artboard ${input.pageIndex}`
        : `${preset.label} ${input.pageIndex}`),
    presetId: input.presetId,
    outputWidth: preset.outputWidth,
    outputHeight: preset.outputHeight,
    pageIndex: input.pageIndex,
    background: "paper",
    showSafeArea: true,
    safeInset: Math.max(18, Math.round(Math.min(size.w, size.h) * 0.07)),
    showBleed: false,
    bleed: 18,
  };
}

// ── Sizes and layout (synap-app placeResourcesOnWhiteboard) ──────────────────

const ENTITY_CARD_SIZE = { w: 240, h: 160 };
const DEFAULT_VIEW_SIZE = { w: 600, h: 400 };
const DEFAULT_CELL_SIZE = { w: 360, h: 240 };
const GRID_GAP = 32;
const DECK_GAP = 48;
/** Gap between what the board holds and an auto-anchored placement. */
const AUTO_ANCHOR_GAP = 120;

function cellPixels(defaultSize?: { w: number; h: number }) {
  if (!defaultSize) return DEFAULT_CELL_SIZE;
  return {
    w: Math.max(defaultSize.w * 60, 240),
    h: Math.max(defaultSize.h * 60, 160),
  };
}

function sizeFor(
  resource: PlaceableBoardResource,
  options: BoardPlacementOptions
): { w: number; h: number } {
  if (options.w && options.h) return { w: options.w, h: options.h };
  if (resource.kind === "entity") return ENTITY_CARD_SIZE;
  if (resource.kind === "view") return DEFAULT_VIEW_SIZE;
  if (resource.kind === "cellInstance") return cellPixels(resource.defaultSize);
  return DEFAULT_CELL_SIZE;
}

function positionFor(
  index: number,
  size: { w: number; h: number },
  anchor: { x: number; y: number },
  layout: BoardPlacementOptions["layout"]
) {
  if (layout === "grid") {
    return {
      x: anchor.x + (index % 2) * (size.w + GRID_GAP) - size.w / 2,
      y: anchor.y + Math.floor(index / 2) * (size.h + GRID_GAP) - size.h / 2,
    };
  }
  if (layout === "flow") {
    return {
      x: anchor.x + index * (size.w + GRID_GAP) - size.w / 2,
      y: anchor.y - size.h / 2,
    };
  }
  if (layout === "freeform") {
    return { x: anchor.x - size.w / 2, y: anchor.y - size.h / 2 };
  }
  return {
    x: anchor.x + index * 24 - size.w / 2,
    y: anchor.y + index * 24 - size.h / 2,
  };
}

// ── Reading the board the placement lands on ────────────────────────────────

/** A tldraw record as stored: an object with at least an id. */
export type BoardRecord = { id: string; typeName: string } & Record<
  string,
  unknown
>;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** What the builder needs to know about the board it writes into. */
export interface BoardPlacementContext {
  /** The page new top-level shapes go on. */
  pageId: string;
  /** No page record exists yet: the builder writes one. */
  needsPage: boolean;
  /** The highest sibling index under each parent (page or shape id). */
  topIndexByParent: Record<string, string>;
  /** The highest artboard `pageIndex` on the board (0 = none). */
  maxArtboardPageIndex: number;
  /** Page-space position of every shape (for frame reparenting). */
  pagePosition: Record<string, { x: number; y: number }>;
  /** Shape type by id. */
  shapeType: Record<string, string>;
  /** Page-space bounds of what the page holds; null when empty. */
  bounds: { x: number; y: number; w: number; h: number } | null;
}

/** The default page id tldraw creates (`PageRecordType.createId("page")`). */
export const DEFAULT_PAGE_ID = "page:page";

/**
 * Read a board's records (the map's JSON: id → record) into what the builder
 * needs. Tolerant: a record that is not a well-formed shape is skipped.
 */
export function boardPlacementContext(
  records: Record<string, unknown>
): BoardPlacementContext {
  const shapes = new Map<string, Rec>();
  const pages: Array<{ id: string; index: string }> = [];
  for (const [key, value] of Object.entries(records)) {
    if (!isRec(value)) continue;
    const id = typeof value.id === "string" ? value.id : key;
    if (value.typeName === "page") {
      pages.push({
        id,
        index: typeof value.index === "string" ? value.index : "a0",
      });
    } else if (value.typeName === "shape") {
      shapes.set(id, value);
    }
  }
  pages.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  const pageId = pages[0]?.id ?? DEFAULT_PAGE_ID;

  const topIndexByParent: Record<string, string> = {};
  const shapeType: Record<string, string> = {};
  let maxArtboardPageIndex = 0;
  for (const [id, s] of shapes) {
    shapeType[id] = typeof s.type === "string" ? s.type : "";
    const parent = typeof s.parentId === "string" ? s.parentId : null;
    if (parent && isValidIndexKey(s.index)) {
      const top = topIndexByParent[parent];
      if (top === undefined || s.index > top)
        topIndexByParent[parent] = s.index;
    }
    if (s.type === BOARD_SHAPE_TYPES.artboard && isRec(s.props)) {
      const p = num(s.props.pageIndex);
      if (p !== undefined && p > maxArtboardPageIndex) maxArtboardPageIndex = p;
    }
  }

  // Page-space positions: a child's x/y are relative to its parent shape
  // (rotation ignored: placement never rotates and frames rarely are).
  const pagePosition: Record<string, { x: number; y: number }> = {};
  const resolve = (id: string, depth: number): { x: number; y: number } => {
    const cached = pagePosition[id];
    if (cached) return cached;
    const s = shapes.get(id);
    if (!s || depth > 64) return { x: 0, y: 0 };
    const own = { x: num(s.x) ?? 0, y: num(s.y) ?? 0 };
    const parent = typeof s.parentId === "string" ? s.parentId : "";
    const base = shapes.has(parent)
      ? resolve(parent, depth + 1)
      : { x: 0, y: 0 };
    const at = { x: base.x + own.x, y: base.y + own.y };
    pagePosition[id] = at;
    return at;
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, s] of shapes) {
    const at = resolve(id, 0);
    const props = isRec(s.props) ? s.props : {};
    const w = num(props.w) ?? 0;
    const h = num(props.h) ?? 0;
    minX = Math.min(minX, at.x);
    minY = Math.min(minY, at.y);
    maxX = Math.max(maxX, at.x + w);
    maxY = Math.max(maxY, at.y + h);
  }
  return {
    pageId,
    needsPage: pages.length === 0,
    topIndexByParent,
    maxArtboardPageIndex,
    pagePosition,
    shapeType,
    bounds:
      shapes.size > 0
        ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
        : null,
  };
}

// ── Deterministic ids ────────────────────────────────────────────────────────

/** FNV-1a, two independent 32-bit lanes: a stable, dependency-free digest. */
export function stableDigest(input: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
  }
  return a.toString(36).padStart(7, "0") + b.toString(36).padStart(7, "0");
}

/**
 * The id of a placed shape: fixed by the placement key, the resource's index
 * in the call and its part (a deck slide's artboard or its cell). The same
 * call retried writes the same ids, so it REPLACES, never duplicates.
 */
export function placedShapeId(
  placementKey: string,
  resourceIndex: number,
  part: string = "main"
): string {
  return `${PLACED_SHAPE_ID_PREFIX}${stableDigest(placementKey)}-${resourceIndex}-${part}`;
}

// ── The builder ──────────────────────────────────────────────────────────────

export class BoardPlacementError extends Error {
  constructor(
    readonly reason: "frame_not_found" | "bad_request",
    message: string
  ) {
    super(message);
    this.name = "BoardPlacementError";
  }
}

export interface BuildPlacementInput {
  resources: PlaceableBoardResource[];
  options?: BoardPlacementOptions;
  /** Fixes the ids (`placedShapeId`). */
  placementKey: string;
  context: BoardPlacementContext;
  placedBy: BoardPlacedBy;
  /** ISO time. */
  placedAt: string;
  /** Mark the shapes pending (an agent placed them; the person keeps them). */
  pending: boolean;
}

export interface BuiltPlacement {
  /** Every record to write (a page when the board has none, then shapes). */
  records: BoardRecord[];
  /** The top-level shape of each resource (an artboard per deck slide). */
  shapeIds: string[];
}

/** Drop `undefined` (tldraw props are JSON; `undefined` fails validation). */
function json<T extends Rec>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined)
  ) as T;
}

function safeProps(props: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(props ?? {});
  } catch {
    return "{}";
  }
}

export function buildPlacementRecords(
  input: BuildPlacementInput
): BuiltPlacement {
  const options = input.options ?? {};
  const ctx = input.context;
  const records: BoardRecord[] = [];
  const shapeIds: string[] = [];

  const frameId = options.frameId;
  if (frameId !== undefined && ctx.pagePosition[frameId] === undefined) {
    throw new BoardPlacementError(
      "frame_not_found",
      `frameId ${frameId} names no shape on this board (read the board for its frame ids).`
    );
  }
  const parentId = frameId ?? ctx.pageId;
  const origin = frameId ? ctx.pagePosition[frameId] : { x: 0, y: 0 };

  if (ctx.needsPage && !frameId) {
    records.push({
      id: ctx.pageId,
      typeName: "page",
      name: "Page 1",
      index: "a1",
      meta: {},
    });
  }

  let top: string | undefined = ctx.topIndexByParent[parentId];
  const nextIndex = () => (top = indexAbove(top));

  const baseMeta = (): Rec => ({
    [BOARD_PLACEMENT_META_KEYS.placedBy]: json({ ...input.placedBy }),
    [BOARD_PLACEMENT_META_KEYS.placedAt]: input.placedAt,
    ...(input.pending ? { [BOARD_PLACEMENT_META_KEYS.pending]: true } : {}),
  });

  const shape = (
    id: string,
    type: string,
    pageX: number,
    pageY: number,
    props: Rec,
    meta: Rec,
    parent: string = parentId,
    index: string = nextIndex()
  ): BoardRecord => ({
    id,
    typeName: "shape",
    type,
    x: parent === parentId ? pageX - origin.x : pageX,
    y: parent === parentId ? pageY - origin.y : pageY,
    rotation: 0,
    index,
    parentId: parent,
    isLocked: false,
    opacity: 1,
    props: json(props),
    meta,
  });

  // Anchor: the caller's point, else to the right of what the page holds.
  const first = input.resources[0];
  const firstSize = first ? sizeFor(first, options) : DEFAULT_CELL_SIZE;
  let anchor: { x: number; y: number };
  if (options.x !== undefined && options.y !== undefined) {
    anchor = { x: options.x, y: options.y };
  } else if (frameId) {
    anchor = {
      x: origin.x + 24 + firstSize.w / 2,
      y: origin.y + 24 + firstSize.h / 2,
    };
  } else if (ctx.bounds) {
    anchor = {
      x: ctx.bounds.x + ctx.bounds.w + AUTO_ANCHOR_GAP + firstSize.w / 2,
      y: ctx.bounds.y + firstSize.h / 2,
    };
  } else {
    anchor = { x: firstSize.w / 2, y: firstSize.h / 2 };
  }

  let nextArtboardPage = ctx.maxArtboardPageIndex + 1;

  input.resources.forEach((resource, index) => {
    if (resource.kind === "artboard-deck-materialized") {
      // N artboards left to right, each holding its slide's html cell
      // (same as the browser placer: the cell is the artboard's child at 0,0).
      let cursorX = anchor.x;
      resource.slides.forEach((slide, i) => {
        const props = artboardProps({
          presetId: resource.preset,
          pageIndex: nextArtboardPage++,
          title: slide.title ?? resource.title,
        });
        const artboardId = placedShapeId(
          input.placementKey,
          index,
          `slide-${i}`
        );
        records.push(
          shape(
            artboardId,
            BOARD_SHAPE_TYPES.artboard,
            cursorX,
            anchor.y,
            props,
            baseMeta()
          )
        );
        records.push(
          shape(
            placedShapeId(input.placementKey, index, `slide-${i}-cell`),
            BOARD_SHAPE_TYPES.cell,
            0,
            0,
            {
              w: props.w,
              h: props.h,
              cellInstanceId: slide.cellInstanceId,
              cellKey: HTML_CELL_KEY,
              cellProps: "{}",
              title: slide.title ?? "",
            },
            baseMeta(),
            artboardId,
            "a1"
          )
        );
        shapeIds.push(artboardId);
        cursorX += (props.w as number) + DECK_GAP;
      });
      return;
    }

    const size = sizeFor(resource, options);
    const at = positionFor(index, size, anchor, options.layout ?? "stack");
    const id = placedShapeId(input.placementKey, index);

    if (resource.kind === "entity") {
      const fit = !(options.w && options.h);
      records.push(
        shape(
          id,
          BOARD_SHAPE_TYPES.entityCard,
          at.x,
          at.y,
          {
            w: size.w,
            h: size.h,
            entityId: resource.entityId,
            entityType: resource.entityType ?? "entity",
            profileId: resource.profileId ?? null,
            title: resource.title ?? "Untitled",
            properties: resource.properties ?? {},
            status: resource.status ?? "active",
            progress: 0,
            updatedAt: resource.updatedAt,
          },
          {
            ...(fit ? { [BOARD_PLACEMENT_META_KEYS.fitToMedia]: true } : {}),
            ...baseMeta(),
          }
        )
      );
    } else if (resource.kind === "view") {
      records.push(
        shape(
          id,
          BOARD_SHAPE_TYPES.view,
          at.x,
          at.y,
          {
            w: size.w,
            h: size.h,
            referenceMode: "live",
            viewId: resource.viewId,
            viewType: resource.viewType ?? "table",
            title: resource.title ?? "Embedded View",
          },
          baseMeta()
        )
      );
    } else {
      records.push(
        shape(
          id,
          BOARD_SHAPE_TYPES.cell,
          at.x,
          at.y,
          {
            w: size.w,
            h: size.h,
            cellInstanceId: resource.cellInstanceId,
            cellKey: resource.cellKey ?? "",
            cellProps: safeProps(resource.props),
            title: resource.title ?? "",
          },
          baseMeta()
        )
      );
    }
    shapeIds.push(id);
  });

  return { records, shapeIds };
}

// ── Changing and removing shapes already there ───────────────────────────────

/**
 * The records an update writes: each target shape with the given position,
 * size and props merged in. A target that is not a shape on the board is
 * returned in `missing` (the door refuses the whole call: `shape_not_found`).
 */
export function buildShapeUpdates(
  records: Record<string, unknown>,
  updates: ReadonlyArray<{
    shapeId: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    props?: Record<string, unknown>;
  }>
): { records: BoardRecord[]; missing: string[] } {
  const out: BoardRecord[] = [];
  const missing: string[] = [];
  for (const u of updates) {
    const current = records[u.shapeId];
    if (!isRec(current) || current.typeName !== "shape") {
      missing.push(u.shapeId);
      continue;
    }
    const props: Rec = {
      ...(isRec(current.props) ? current.props : {}),
      ...json({ ...(u.props ?? {}) }),
      ...(u.w !== undefined ? { w: u.w } : {}),
      ...(u.h !== undefined ? { h: u.h } : {}),
    };
    out.push({
      ...(current as BoardRecord),
      ...(u.x !== undefined ? { x: u.x } : {}),
      ...(u.y !== undefined ? { y: u.y } : {}),
      props,
    });
  }
  return { records: out, missing };
}

/**
 * Every record id a removal deletes: the shapes, everything they hold (a
 * frame's or artboard's children, at any depth) and the bindings (arrow ends)
 * that point at any of them, so no record is left pointing at nothing.
 */
export function shapeRemovalIds(
  records: Record<string, unknown>,
  shapeIds: readonly string[]
): { ids: string[]; missing: string[] } {
  const children = new Map<string, string[]>();
  const bindings: Array<{ id: string; fromId: unknown; toId: unknown }> = [];
  for (const [key, value] of Object.entries(records)) {
    if (!isRec(value)) continue;
    const id = typeof value.id === "string" ? value.id : key;
    if (value.typeName === "shape" && typeof value.parentId === "string") {
      const list = children.get(value.parentId) ?? [];
      list.push(id);
      children.set(value.parentId, list);
    } else if (value.typeName === "binding") {
      bindings.push({ id, fromId: value.fromId, toId: value.toId });
    }
  }
  const missing: string[] = [];
  const removed = new Set<string>();
  const walk = (id: string) => {
    if (removed.has(id)) return;
    removed.add(id);
    for (const child of children.get(id) ?? []) walk(child);
  };
  for (const id of shapeIds) {
    const current = records[id];
    if (!isRec(current) || current.typeName !== "shape") {
      missing.push(id);
      continue;
    }
    walk(id);
  }
  for (const b of bindings) {
    if (
      (typeof b.fromId === "string" && removed.has(b.fromId)) ||
      (typeof b.toId === "string" && removed.has(b.toId))
    ) {
      removed.add(b.id);
    }
  }
  return { ids: [...removed], missing };
}
