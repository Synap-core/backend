/**
 * What an agent asks to place on a whiteboard, and what it asks to change:
 * the ONE schema of the place door (Hub `POST /api/hub/whiteboards/:viewId/placements`,
 * MCP `synap_place_on_board`, the IS place tools, the browser placer).
 *
 * It replaces four hand copies of `BoardResourceRef` (backend route, builtin
 * verb, IS tool, synap-app placer). The union is the one the browser placer
 * has always accepted, so a payload that placed before still parses.
 *
 * Schemas are exported WHOLE (`PlaceOnBoardRequestSchema`) so a caller parses
 * with them and never composes them into its own zod instance (this package
 * and its consumers may resolve different zod majors).
 */

import { z } from "zod";

const BOARD_LAYOUTS = ["stack", "grid", "flow", "freeform"] as const;

// ── Size limits: checked before any work (a cell, an upload) is done ────────

/** Longest html a resource or deck slide carries (chars). */
export const BOARD_HTML_MAX_CHARS = 400_000;
/** Longest title / name (chars). */
export const BOARD_TITLE_MAX_CHARS = 500;
/** Largest props / properties object (serialized chars). */
export const BOARD_PROPS_MAX_CHARS = 20_000;
/**
 * The most cells one call may create (html, url, automation, deck slides…).
 * It also bounds the records: a deck slide is two (artboard + cell), so a call
 * stays far under the realtime server's apply cap and a call it would refuse
 * is refused before any cell is made.
 */
export const BOARD_PLACE_MAX_NEW_CELLS = 100;
/** Largest serialized request body the doors take (bytes). */
export const BOARD_PLACE_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Props that point at something else: set when a shape is placed, never
 * patched (placing a new shape is the way to point elsewhere). */
export const BOARD_REFERENCE_PROP_KEYS = [
  "entityId",
  "viewId",
  "cellInstanceId",
  "cellKey",
  "cellProps",
  "automationId",
] as const;

const title = z.string().max(BOARD_TITLE_MAX_CHARS);
const html = z.string().max(BOARD_HTML_MAX_CHARS);
const props = z
  .record(z.string(), z.unknown())
  .refine((v) => jsonSize(v) <= BOARD_PROPS_MAX_CHARS, {
    message: `Props must serialize to at most ${BOARD_PROPS_MAX_CHARS} characters.`,
  });

function jsonSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

export const AUTOMATION_EMBED_MODES = [
  "flow",
  "detail",
  "status",
  "trigger",
] as const;
export type AutomationEmbedMode = (typeof AUTOMATION_EMBED_MODES)[number];

/** Where and how to lay the new shapes out (page units). */
export const BoardPlacementOptionsSchema = z.object({
  /** Anchor. Omitted: to the right of what the board already holds. */
  x: z.number().finite().min(-1e7).max(1e7).optional(),
  y: z.number().finite().min(-1e7).max(1e7).optional(),
  /** Size of every placed shape (both or neither; else each kind's default). */
  w: z.number().finite().positive().max(100_000).optional(),
  h: z.number().finite().positive().max(100_000).optional(),
  /** A frame or artboard on the board to place INTO (a shape id from a read). */
  frameId: z.string().min(1).optional(),
  layout: z.enum(BOARD_LAYOUTS).optional(),
});
export type BoardPlacementOptions = z.infer<typeof BoardPlacementOptionsSchema>;

const sizeHint = z.object({
  w: z.number().positive().max(100),
  h: z.number().positive().max(100),
});

export const ArtboardDeckSlideSchema = z.object({
  html,
  title: title.optional(),
});

/** The `artboard-deck` resource without its `kind` (the deck verb's input). */
export const ArtboardDeckSchema = z.object({
  preset: z.string().max(64),
  title: title.optional(),
  slides: z.array(ArtboardDeckSlideSchema).min(1).max(50),
});
export type ArtboardDeck = z.infer<typeof ArtboardDeckSchema>;

/** One thing to put on a board. */
export const BoardResourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    /** A card for a pod entity. */
    kind: z.literal("entity"),
    entityId: z.string().uuid(),
    entityType: z.string().max(100).nullable().optional(),
    profileId: z.string().uuid().nullable().optional(),
    title: title.nullable().optional(),
    properties: props.optional(),
    status: z.string().max(100).optional(),
    updatedAt: z.string().max(100).optional(),
  }),
  z.object({
    /** A live embed of a saved view (always rendered by id). */
    kind: z.literal("view"),
    viewId: z.string().uuid(),
    viewType: z.string().max(100).nullable().optional(),
    title: title.nullable().optional(),
  }),
  z.object({
    /** An existing cell instance. */
    kind: z.literal("cellInstance"),
    cellInstanceId: z.string().uuid(),
    cellKey: z.string().max(100).optional(),
    props: props.optional(),
    title: title.nullable().optional(),
    defaultSize: sizeHint.optional(),
  }),
  z.object({
    /** A new cell of a registered cell type (an instance is created). */
    kind: z.literal("cellDefinition"),
    cellKey: z.string().min(1).max(100),
    props: props.optional(),
    name: title.optional(),
    defaultSize: sizeHint.optional(),
  }),
  z.object({
    /** HTML, kept as a versioned html-embed cell. */
    kind: z.literal("html"),
    name: title.min(1),
    html,
  }),
  z.object({
    /** A multi-slide deck or carousel: one artboard per slide. */
    kind: z.literal("artboard-deck"),
    ...ArtboardDeckSchema.shape,
  }),
  z.object({
    /** An automation, shown as one of its cells. */
    kind: z.literal("automation"),
    automationId: z.string().uuid(),
    mode: z.enum(AUTOMATION_EMBED_MODES),
    title: title.optional(),
  }),
  z.object({
    /** A web page, embedded (iframe-embed cell). */
    kind: z.literal("url"),
    url: z.string().url().max(2048),
    title: title.optional(),
  }),
]);
export type BoardResourceRef = z.infer<typeof BoardResourceRefSchema>;

/**
 * A change to a shape already on the board. Fields left out are kept; `props`
 * is merged into the shape's props key by key (its type and id never change).
 */
export const BoardShapeUpdateSchema = z.object({
  shapeId: z.string().startsWith("shape:").max(200),
  x: z.number().finite().min(-1e7).max(1e7).optional(),
  y: z.number().finite().min(-1e7).max(1e7).optional(),
  w: z.number().finite().positive().max(100_000).optional(),
  h: z.number().finite().positive().max(100_000).optional(),
  /**
   * Only props the shape already has, of the type they have (checked on the
   * live board), and never a reference prop (`BOARD_REFERENCE_PROP_KEYS`).
   */
  props: props
    .refine((v) => BOARD_REFERENCE_PROP_KEYS.every((k) => !(k in v)), {
      message: `Props that point at something (${BOARD_REFERENCE_PROP_KEYS.join(", ")}) cannot be changed: place a new shape instead.`,
    })
    .optional(),
});
export type BoardShapeUpdate = z.infer<typeof BoardShapeUpdateSchema>;

/** The most a single call may create, change or remove (each). */
export const BOARD_PLACE_LIMIT = 50;

/** Cells a resource list creates (entity, view and cellInstance create none). */
export function placementCellCount(
  resources: ReadonlyArray<{ kind: string; slides?: unknown[] }>
): number {
  return resources.reduce(
    (n, r) =>
      n +
      (r.kind === "artboard-deck"
        ? (r.slides?.length ?? 0)
        : r.kind === "entity" || r.kind === "view" || r.kind === "cellInstance"
          ? 0
          : 1),
    0
  );
}

/**
 * The place door's request. `resources` CREATES shapes (no approval by
 * default: they appear at once, marked pending for the person to keep or
 * reject); `update` and `remove` CHANGE what is already there and go through
 * governance (a proposal by default). At least one of the three.
 */
export const PlaceOnBoardRequestObject = z.object({
  resources: z.array(BoardResourceRefSchema).max(BOARD_PLACE_LIMIT).optional(),
  options: BoardPlacementOptionsSchema.optional(),
  update: z.array(BoardShapeUpdateSchema).max(BOARD_PLACE_LIMIT).optional(),
  remove: z
    .array(z.string().startsWith("shape:").max(200))
    .max(BOARD_PLACE_LIMIT)
    .optional(),
  /**
   * Retry key. The same key (or, without one, the same request) places the
   * same shape ids, so a retry REPLACES what the first call placed, never
   * duplicates it.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
  /** The space the caller acts in: must be the board's own space. */
  workspaceId: z.string().uuid().optional(),
  reasoning: z.string().max(2000).optional(),
  sourceMessageId: z.string().max(200).optional(),
});

export const PlaceOnBoardRequestSchema = PlaceOnBoardRequestObject.refine(
  (r) =>
    (r.resources?.length ?? 0) +
      (r.update?.length ?? 0) +
      (r.remove?.length ?? 0) >
    0,
  { message: "Nothing to do: pass resources, update or remove." }
).refine(
  (r) => placementCellCount(r.resources ?? []) <= BOARD_PLACE_MAX_NEW_CELLS,
  {
    message: `A call creates at most ${BOARD_PLACE_MAX_NEW_CELLS} cells (html, url, automation, cell and deck-slide resources). Split it.`,
  }
);
export type PlaceOnBoardRequest = z.infer<typeof PlaceOnBoardRequestSchema>;

/** What one part of a place call did. */
export type BoardPlacePartResult =
  | {
      status: "applied";
      /** Top-level shape ids written (an artboard per deck slide). */
      shapeIds: string[];
      /** Where it was written: the open board, or its saved file. */
      target: "live" | "stored";
      /** Created shapes carry `meta.pending` until the person keeps them. */
      pending?: boolean;
      /**
       * Top-level shape ids NOT written because the board already holds
       * them and the person has kept (or moved) them: a repeat never resets
       * what a person kept.
       */
      skipped?: string[];
    }
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      /** The shape ids the approval will write (create) or touch. */
      shapeIds: string[];
    };

export interface PlaceOnBoardResult {
  viewId: string;
  documentId: string;
  workspaceId: string | null;
  created?: BoardPlacePartResult;
  updated?: BoardPlacePartResult;
  removed?: BoardPlacePartResult;
}

/**
 * Why a place call was refused. A MACHINE code (the doors map it to an HTTP
 * status); a refused call wrote nothing. Never "empty".
 */
export const BOARD_PLACE_FAILURES = {
  /** No such board, or the caller may not see it (no existence oracle). */
  not_found: 404,
  /** The view is not a whiteboard. */
  not_a_board: 400,
  /** The board has no content document. */
  not_initialized: 409,
  /** The caller may read the board but not change it. */
  read_only: 403,
  /** The board lives in another space than the one the caller acts in. */
  wrong_workspace: 404,
  /** The request is malformed (bad frame, unknown shape, …). */
  bad_request: 400,
  /** `frameId` names no frame or artboard on the board. */
  frame_not_found: 400,
  /** An `update`/`remove` names a shape the board does not hold. */
  shape_not_found: 400,
  /**
   * An entity, view, cell or automation the call names does not exist, is not
   * readable by the person, or is not in the board's space.
   */
  reference_not_found: 400,
  /** Governance said never. */
  denied: 403,
  /** The open board failed to load its saved content: it takes no write. */
  load_failed: 409,
  /** The realtime server or storage did not answer. */
  unavailable: 503,
  /**
   * The write took too long: it MAY have landed. Retry is safe (the same
   * records replace themselves, a kept shape is never reset).
   */
  timeout: 504,
  /** The board's content could not be read or decoded. */
  unreadable: 502,
  /** The write was applied in memory but could not be saved. */
  save_failed: 503,
  /** A cell the placement needs could not be created. */
  materialize_failed: 502,
  /**
   * A url embed that is not a website (`classifyEmbedUrl`,
   * `@synap-core/types/embed-url`): not https, a stored file, the pod itself.
   */
  embed_refused: 400,
} as const;
export type BoardPlaceFailure = keyof typeof BOARD_PLACE_FAILURES;
