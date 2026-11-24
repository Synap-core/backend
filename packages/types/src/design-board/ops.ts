/**
 * THE OPS — how an agent (and the Design app's save) changes a design: typed
 * operations applied to a board, each checked by the SAME validator the
 * canvas reads with (`checkBlocks`, `checkPage`, `parseBoard`) against the
 * pod's catalog snapshot. Plan 0fc746f4 §2.6.
 *
 * All or nothing: the ops run on a copy, in order; the first op that cannot
 * apply refuses the WHOLE batch, naming its index, why (`DropReason` or an
 * op-level reason) and the catalog hash, and nothing is changed. Later ops see
 * what earlier ones did, so a batch may add a block (with its own `props.id`)
 * and then fill or move it.
 *
 * `create_design` is not a board op: the pod's design door handles it (it
 * creates the `ui-design`, then applies the rest of the batch to an empty
 * board). Here it is refused with `create-not-first`.
 *
 * Pure: no I/O.
 */
import { z } from "zod";
import {
  BOARD_FORMAT,
  FRAME_PRESETS,
  boardComponents,
  checkBlocks,
  checkPage,
  newFramePage,
  nextBlockId,
  parseBoard,
  walkBlocks,
  type Board,
  type BoardFrame,
  type DropReason,
  type PageBlock,
} from "./board.js";
import { catalogSchema, type DesignCatalogSnapshot } from "./catalog.js";
import {
  GRID_COLUMNS,
  HIDE_PROP,
  SPAN_PROP,
  START_PROP,
  WIDTH_CLASSES,
  fitsPlacement,
  fitsSpan,
  type WidthClass,
} from "./grid.js";
import type { CanvasSchema } from "./schema.js";

// ─── The ops ────────────────────────────────────────────────────────────────

const ref = z.string().min(1).max(200);
const widthClass = z.enum(WIDTH_CLASSES as [WidthClass, ...WidthClass[]]);
const blockProps = z.record(z.string(), z.unknown());

/** Every op's shape. A field an op does not declare is refused (`.strict()`). */
export const designOpSchema = z.discriminatedUnion("op", [
  /** Handled by the pod's door, first op of a batch only: a new design for this app (a `devplane_app`), filed into the project. */
  z
    .object({
      op: z.literal("create_design"),
      title: z.string().min(1).max(500),
      appId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    })
    .strict(),
  /** A new frame of a preset size, right of the rightmost one. `pageOf`: it SHOWS that frame's page at its own width. */
  z
    .object({
      op: z.literal("add_frame"),
      preset: z.string().min(1),
      name: z.string().min(1).max(200).optional(),
      id: ref.optional(),
      pageOf: ref.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    })
    .strict(),
  /** Rename, move or resize a frame (a preset sets both sizes). */
  z
    .object({
      op: z.literal("update_frame"),
      frameId: ref,
      name: z.string().min(1).max(200).optional(),
      preset: z.string().min(1).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().positive().optional(),
      h: z.number().positive().optional(),
    })
    .strict(),
  /** Remove a frame. Refused while another frame shows its page. */
  z.object({ op: z.literal("remove_frame"), frameId: ref }).strict(),
  /**
   * Add one block (its slot props may hold more blocks). `parentId` null or
   * absent: the page's own content. `slot`: the parent's slot prop (may be
   * omitted when the parent has exactly one). `index` absent: at the end. A
   * frame that shows another frame's page adds to that page.
   */
  z
    .object({
      op: z.literal("add_block"),
      frameId: ref,
      parentId: ref.nullable().optional(),
      slot: z.string().min(1).optional(),
      index: z.number().int().min(0).optional(),
      type: z.string().min(1),
      props: blockProps.optional(),
    })
    .strict(),
  /** Set props of a block (a given prop replaces its value), and `unset` props. Its id and type never change. */
  z
    .object({
      op: z.literal("update_block"),
      id: ref,
      props: blockProps.optional(),
      unset: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  /** Move a block (with its children) to another place, in the same page or another one. */
  z
    .object({
      op: z.literal("move_block"),
      id: ref,
      frameId: ref.optional(),
      parentId: ref.nullable().optional(),
      slot: z.string().min(1).optional(),
      index: z.number().int().min(0).optional(),
    })
    .strict(),
  /** Remove a block and everything in its slots. */
  z.object({ op: z.literal("remove_block"), id: ref }).strict(),
  /** How many columns a block spans at one width class; null = full width again. */
  z
    .object({
      op: z.literal("set_span"),
      id: ref,
      class: widthClass,
      span: z.number().nullable(),
    })
    .strict(),
  /** The column (1-based) a block starts at, at one width class; null = the grid places it again. */
  z
    .object({
      op: z.literal("set_start"),
      id: ref,
      class: widthClass,
      start: z.number().nullable(),
    })
    .strict(),
  /** Hide (or show again) a block at one width class. */
  z
    .object({
      op: z.literal("set_hide"),
      id: ref,
      class: widthClass,
      hide: z.boolean(),
    })
    .strict(),
  /** Replace one frame's whole page (whole-page generation). The frame must own its page. */
  z
    .object({ op: z.literal("replace_page"), frameId: ref, page: z.unknown() })
    .strict(),
  /** Replace the whole board (the Design app's own save): it must read clean, as v3. */
  z.object({ op: z.literal("replace_board"), board: z.unknown() }).strict(),
]);

export type DesignOp = z.infer<typeof designOpSchema>;
export type DesignOpName = DesignOp["op"];

/** The op names, in the order they are documented. */
export const DESIGN_OP_NAMES: readonly DesignOpName[] = [
  "create_design",
  "add_frame",
  "update_frame",
  "remove_frame",
  "add_block",
  "update_block",
  "move_block",
  "remove_block",
  "set_span",
  "set_start",
  "set_hide",
  "replace_page",
  "replace_board",
];

/** At most this many ops in one batch. */
export const MAX_DESIGN_OPS = 200;

// ─── Refusals and changes ───────────────────────────────────────────────────

/** Why an op cannot apply: a `DropReason` (the validator's), or one of these. Keyed, never words. */
export type OpRefusalReason =
  | DropReason
  /** The op's own shape (unknown op, missing or mistyped field). */
  | { kind: "bad-op"; detail: string }
  /** `create_design` anywhere but first in a batch with no design. */
  | { kind: "create-not-first" }
  | { kind: "bad-preset"; preset: string }
  | { kind: "no-frame"; frameId: string }
  | { kind: "duplicate-frame"; id: string }
  | { kind: "no-block"; id: string }
  /** An id a new block (or page) asks for that another block already holds. */
  | { kind: "duplicate-id"; id: string }
  /** The parent has no slot prop by that name, or several and none was named. */
  | { kind: "bad-slot"; type: string; prop: string | null }
  | { kind: "bad-index"; index: number; length: number }
  /** A block moved into its own slots. */
  | { kind: "into-itself"; id: string }
  /** A span that is not a whole number of the class's columns. */
  | { kind: "span-too-wide"; class: WidthClass; span: number; columns: number }
  /** A start that is not a column of the class, or a start and a span that together run past its columns. */
  | {
      kind: "start-past-grid";
      class: WidthClass;
      start: number;
      span: number | null;
      columns: number;
    }
  /** `replace_page` on a frame that shows another frame's page. */
  | { kind: "frame-shows-page"; frameId: string; pageOf: string }
  /** A frame whose page other frames show cannot go before they do. */
  | { kind: "frame-has-viewers"; frameId: string; viewers: string[] }
  /** `replace_board` / `replace_page` given something that is not one. */
  | { kind: "not-a-board"; error: string }
  /** `replace_board` given an older format: write v3. */
  | { kind: "not-v3" }
  /** `update_block` naming `id` or `type`. */
  | { kind: "fixed-prop"; prop: string };

export type DesignChange =
  | { change: "frame-added"; frameId: string }
  | { change: "frame-updated"; frameId: string }
  | { change: "frame-removed"; frameId: string }
  | { change: "block-added"; blockId: string; frameId: string }
  | { change: "block-updated"; blockId: string }
  | { change: "block-moved"; blockId: string; frameId: string }
  | { change: "block-removed"; blockId: string }
  | { change: "page-replaced"; frameId: string }
  | { change: "board-replaced" };

export type ApplyOpsResult =
  | {
      ok: true;
      board: Board;
      /** What each op did, in order (`opIndex` = its place in the batch). */
      changes: Array<DesignChange & { opIndex: number }>;
      /** The components the new board uses (the `components-used` property). */
      componentsUsed: string[];
      catalogHash: string;
    }
  | {
      ok: false;
      /** The op that refused (its place in the batch); nothing was applied. */
      opIndex: number;
      op: string;
      reasons: OpRefusalReason[];
      catalogHash: string;
      /** The refusal in words, for an agent to act on. */
      message: string;
    };

/** One reason, in words an agent can act on. */
export function describeRefusal(r: OpRefusalReason): string {
  switch (r.kind) {
    case "not-a-block":
      return "something in a block list is not a block (it needs a string `type` and a `props` object)";
    case "unknown-type":
      return `"${r.type}" is not a component of the catalog (read design.catalog)`;
    case "not-a-slot":
      return `${r.type}.${r.prop} holds blocks but is not a slot of ${r.type}`;
    case "bad-prop":
      return `${r.type}.${r.prop} is not a prop of ${r.type}, or its value does not fit it (a select takes one of its options, which for spacing, radius and colour are token steps)`;
    case "bad-list-item":
      return `an item of ${r.type}.${r.prop} has a field it does not declare, of the wrong kind, or lacks a required one`;
    case "not-allowed":
      return `${r.parent}.${r.prop} does not take a ${r.type}`;
    case "too-deep":
      return `${r.type} is nested deeper than the board allows`;
    case "legacy-zones":
      return `the page has Puck zones (${r.keys.join(", ")}); a page is slots only`;
    case "bad-frame":
      return "a frame has no id or no position";
    case "duplicate-frame":
      return `frame id "${r.id}" is already used`;
    case "bad-page-of":
      return `frame "${r.frame}" shows a page that is not a page-owning frame of the board (or holds blocks of its own)`;
    case "bad-v2-item":
      return "a v2 item has no id, component or position";
    case "bad-op":
      return `the op is malformed: ${r.detail}`;
    case "create-not-first":
      return "create_design is only the first op of a batch that names no design";
    case "bad-preset":
      return `"${r.preset}" is not a frame preset (${FRAME_PRESETS.map((p) => p.id).join(", ")})`;
    case "no-frame":
      return `no frame "${r.frameId}" in this design`;
    case "no-block":
      return `no block "${r.id}" in this design`;
    case "duplicate-id":
      return `block id "${r.id}" is already used in this design`;
    case "bad-slot":
      return r.prop
        ? `${r.type} has no slot "${r.prop}"`
        : `${r.type} has no single slot: name one with \`slot\``;
    case "bad-index":
      return `index ${r.index} is past the end of a list of ${r.length}`;
    case "into-itself":
      return `block "${r.id}" cannot move into its own slots`;
    case "span-too-wide":
      return `a span at the ${r.class} width is a whole number from 1 to ${r.columns} columns, not ${r.span}`;
    case "start-past-grid":
      return r.span === null
        ? `a start at the ${r.class} width is a column from 1 to ${r.columns}, not ${r.start}`
        : `at the ${r.class} width a block starting at column ${r.start} and spanning ${r.span} ends past column ${r.columns}: lower the start or the span (set_span) first`;
    case "frame-shows-page":
      return `frame "${r.frameId}" shows the page of "${r.pageOf}"; change that frame's page`;
    case "frame-has-viewers":
      return `frame "${r.frameId}" is shown by ${r.viewers.join(", ")}; remove those first`;
    case "not-a-board":
      return r.error;
    case "not-v3":
      return `replace_board takes a v3 board (format "${BOARD_FORMAT}")`;
    case "fixed-prop":
      return `\`${r.prop}\` of a block never changes (remove the block and add another)`;
  }
}

// ─── The applier ────────────────────────────────────────────────────────────

class Refusal {
  constructor(readonly reasons: OpRefusalReason[]) {}
}
/** Refuse the op (and so the batch). A declaration with a `never` return, so the checker narrows after it. */
function refuse(...reasons: OpRefusalReason[]): never {
  throw new Refusal(reasons);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A block's stored number for one width class of a grid prop (span or start), when it has one. */
function gridNumberAt(
  block: PageBlock,
  prop: string,
  cls: WidthClass
): number | undefined {
  const v = block.props[prop];
  const n = isObj(v) ? v[cls] : undefined;
  return typeof n === "number" ? n : undefined;
}
const spanAt = (block: PageBlock, cls: WidthClass) =>
  gridNumberAt(block, SPAN_PROP, cls);
const startAt = (block: PageBlock, cls: WidthClass) =>
  gridNumberAt(block, START_PROP, cls);

/** A block's slot props (declared by the schema) as the LIVE arrays, so a change lands in the board. */
function slotsOf(
  block: PageBlock,
  schema: CanvasSchema
): Array<{ prop: string; blocks: PageBlock[] }> {
  const fields = Object.prototype.hasOwnProperty.call(schema, block.type)
    ? schema[block.type]!
    : {};
  return Object.entries(fields)
    .filter(
      ([prop, spec]) => spec.kind === "slot" && Array.isArray(block.props[prop])
    )
    .map(([prop]) => ({ prop, blocks: block.props[prop] as PageBlock[] }));
}

interface Located {
  frame: BoardFrame;
  list: PageBlock[];
  index: number;
  block: PageBlock;
  depth: number;
}

function locate(
  board: Board,
  id: string,
  schema: CanvasSchema
): Located | null {
  const find = (
    frame: BoardFrame,
    list: PageBlock[],
    depth: number
  ): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const block = list[i]!;
      if (block.props.id === id) return { frame, list, index: i, block, depth };
      for (const { blocks } of slotsOf(block, schema)) {
        const hit = find(frame, blocks, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const frame of board.frames) {
    if (frame.pageOf) continue;
    const hit = find(frame, frame.page.content, 0);
    if (hit) return hit;
  }
  return null;
}

function frameOf(board: Board, frameId: string): BoardFrame {
  return (
    board.frames.find((f) => f.id === frameId) ??
    refuse({ kind: "no-frame", frameId })
  );
}

/** The frame whose page an op on `frameId` changes: itself, or the frame it shows. */
function pageFrame(board: Board, frameId: string): BoardFrame {
  const frame = frameOf(board, frameId);
  return frame.pageOf ? frameOf(board, frame.pageOf) : frame;
}

/** Every block id in the board. */
function boardIds(board: Board): Set<string> {
  const ids = new Set<string>();
  for (const f of board.frames)
    for (const b of walkBlocks(f.page.content)) ids.add(b.props.id);
  return ids;
}

/**
 * Ids for new blocks: one a block asks for is kept when free and refused when
 * taken (later ops may name it); a missing one gets `nextBlockId`.
 */
function giveIds(blocks: PageBlock[], taken: Set<string>): void {
  for (const b of walkBlocks(blocks)) {
    const id = (b.props as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") {
      if (taken.has(id)) refuse({ kind: "duplicate-id", id });
      taken.add(id);
    } else b.props.id = nextBlockId(taken, b.type);
  }
}

/** The list a block goes into: the page's content, or one slot of a parent. */
function targetList(
  board: Board,
  schema: CanvasSchema,
  frameId: string | undefined,
  parentId: string | null | undefined,
  slot: string | undefined
): {
  frame: BoardFrame;
  list: PageBlock[];
  depth: number;
  slot?: { type: string; prop: string; allow?: string[] };
  parent: PageBlock | null;
} {
  if (parentId === null || parentId === undefined) {
    if (frameId === undefined)
      refuse({
        kind: "bad-op",
        detail:
          "frameId: a block placed in a page's own content names its frame",
      });
    const frame = pageFrame(board, frameId);
    return { frame, list: frame.page.content, depth: 0, parent: null };
  }
  const at =
    locate(board, parentId, schema) ??
    refuse({ kind: "no-block", id: parentId });
  // The parent names the page; a frame given too must draw that same page.
  if (frameId !== undefined && pageFrame(board, frameId).id !== at.frame.id)
    refuse({ kind: "no-block", id: parentId });
  const frame = at.frame;
  const fields = schema[at.block.type] ?? {};
  const slotProps = Object.entries(fields)
    .filter(([, spec]) => spec.kind === "slot")
    .map(([p]) => p);
  const prop =
    slot ??
    (slotProps.length === 1
      ? slotProps[0]!
      : refuse({ kind: "bad-slot", type: at.block.type, prop: null }));
  const spec = fields[prop];
  if (!spec || spec.kind !== "slot")
    refuse({ kind: "bad-slot", type: at.block.type, prop });
  if (!Array.isArray(at.block.props[prop])) at.block.props[prop] = [];
  return {
    frame,
    list: at.block.props[prop] as PageBlock[],
    depth: at.depth + 1,
    slot: {
      type: at.block.type,
      prop,
      ...(spec && spec.kind === "slot" && spec.allow
        ? { allow: spec.allow }
        : {}),
    },
    parent: at.block,
  };
}

function insertAt(
  list: PageBlock[],
  index: number | undefined,
  block: PageBlock
) {
  const at = index ?? list.length;
  if (at > list.length)
    refuse({ kind: "bad-index", index: at, length: list.length });
  list.splice(at, 0, block);
}

/** One block checked for its place: anything the validator would drop refuses the op. */
function checkOne(
  raw: unknown,
  schema: CanvasSchema,
  place: {
    depth: number;
    slot?: { type: string; prop: string; allow?: string[] };
  }
): PageBlock {
  const { blocks, dropped } = checkBlocks([raw], schema, place);
  if (dropped.length > 0) refuse(...dropped);
  return blocks[0]!;
}

function preset(id: string) {
  return (
    FRAME_PRESETS.find((p) => p.id === id) ??
    refuse({ kind: "bad-preset", preset: id })
  );
}

function applyOne(
  board: Board,
  op: DesignOp,
  schema: CanvasSchema
): { board: Board; change: DesignChange } {
  switch (op.op) {
    case "create_design":
      return refuse({ kind: "create-not-first" });

    case "add_frame": {
      const p = preset(op.preset);
      const ids = new Set(board.frames.map((f) => f.id));
      let id = op.id;
      if (id !== undefined && ids.has(id))
        refuse({ kind: "duplicate-frame", id });
      if (id === undefined) {
        id = p.id;
        for (let n = 2; ids.has(id); n++) id = `${p.id}-${n}`;
      }
      if (op.pageOf !== undefined) {
        const source = board.frames.find((f) => f.id === op.pageOf);
        if (!source || source.pageOf)
          refuse({ kind: "bad-page-of", frame: id });
      }
      const right = board.frames.length
        ? Math.max(...board.frames.map((f) => f.x + f.w)) + FRAME_GAP
        : 0;
      const top = board.frames.length
        ? Math.min(...board.frames.map((f) => f.y))
        : 0;
      const frame: BoardFrame = {
        id,
        name: op.name ?? p.label,
        x: op.x ?? right,
        y: op.y ?? top,
        w: p.w,
        h: p.h,
        page: newFramePage(),
        ...(op.pageOf !== undefined ? { pageOf: op.pageOf } : {}),
      };
      board.frames.push(frame);
      return { board, change: { change: "frame-added", frameId: id } };
    }

    case "update_frame": {
      const frame = frameOf(board, op.frameId);
      if (op.preset !== undefined) {
        const p = preset(op.preset);
        frame.w = p.w;
        frame.h = p.h;
      }
      if (op.name !== undefined) frame.name = op.name;
      if (op.x !== undefined) frame.x = op.x;
      if (op.y !== undefined) frame.y = op.y;
      if (op.w !== undefined) frame.w = op.w;
      if (op.h !== undefined) frame.h = op.h;
      return { board, change: { change: "frame-updated", frameId: frame.id } };
    }

    case "remove_frame": {
      const frame = frameOf(board, op.frameId);
      const viewers = board.frames
        .filter((f) => f.pageOf === frame.id)
        .map((f) => f.id);
      if (viewers.length > 0)
        refuse({ kind: "frame-has-viewers", frameId: frame.id, viewers });
      board.frames = board.frames.filter((f) => f !== frame);
      return { board, change: { change: "frame-removed", frameId: frame.id } };
    }

    case "add_block": {
      const target = targetList(
        board,
        schema,
        op.frameId,
        op.parentId,
        op.slot
      );
      const block = checkOne(
        { type: op.type, props: { ...(op.props ?? {}) } },
        schema,
        { depth: target.depth, ...(target.slot ? { slot: target.slot } : {}) }
      );
      giveIds([block], boardIds(board));
      insertAt(target.list, op.index, block);
      return {
        board,
        change: {
          change: "block-added",
          blockId: block.props.id,
          frameId: target.frame.id,
        },
      };
    }

    case "update_block": {
      for (const fixed of ["id", "type"])
        if (op.props && fixed in op.props)
          refuse({ kind: "fixed-prop", prop: fixed });
      if (op.unset?.includes("id")) refuse({ kind: "fixed-prop", prop: "id" });
      const at =
        locate(board, op.id, schema) ?? refuse({ kind: "no-block", id: op.id });
      const props: Record<string, unknown> = {
        ...at.block.props,
        ...(op.props ?? {}),
      };
      for (const k of op.unset ?? []) delete props[k];
      const parentSlot = slotOfList(board, at.list, schema);
      const block = checkOne({ type: at.block.type, props }, schema, {
        depth: at.depth,
        ...(parentSlot ? { slot: parentSlot } : {}),
      });
      // The block's own subtree is being replaced: its ids are free again,
      // except its own id, which it keeps.
      const taken = boardIds(board);
      for (const b of walkBlocks([at.block], schema)) taken.delete(b.props.id);
      taken.add(at.block.props.id);
      for (const { blocks } of slotsOf(block, schema)) giveIds(blocks, taken);
      at.list[at.index] = block;
      return { board, change: { change: "block-updated", blockId: op.id } };
    }

    case "move_block": {
      const at =
        locate(board, op.id, schema) ?? refuse({ kind: "no-block", id: op.id });
      if (op.parentId) {
        const inside = [...walkBlocks([at.block], schema)].some(
          (b) => b.props.id === op.parentId
        );
        if (inside) refuse({ kind: "into-itself", id: op.id });
      }
      at.list.splice(at.index, 1);
      // No frame and no parent: the same page's content; a parent names its own page.
      const frameId = op.frameId ?? (op.parentId ? undefined : at.frame.id);
      const target = targetList(board, schema, frameId, op.parentId, op.slot);
      const block = checkOne(at.block, schema, {
        depth: target.depth,
        ...(target.slot ? { slot: target.slot } : {}),
      });
      insertAt(target.list, op.index, block);
      return {
        board,
        change: {
          change: "block-moved",
          blockId: op.id,
          frameId: target.frame.id,
        },
      };
    }

    case "remove_block": {
      const at =
        locate(board, op.id, schema) ?? refuse({ kind: "no-block", id: op.id });
      at.list.splice(at.index, 1);
      return { board, change: { change: "block-removed", blockId: op.id } };
    }

    case "set_span": {
      const at =
        locate(board, op.id, schema) ?? refuse({ kind: "no-block", id: op.id });
      const span = isObj(at.block.props[SPAN_PROP])
        ? { ...(at.block.props[SPAN_PROP] as Record<string, unknown>) }
        : {};
      if (op.span === null) delete span[op.class];
      else if (!fitsSpan(op.class, op.span))
        refuse({
          kind: "span-too-wide",
          class: op.class,
          span: op.span,
          columns: GRID_COLUMNS[op.class],
        });
      else {
        // A wider span must still fit from where the block starts.
        const start = startAt(at.block, op.class);
        if (start !== undefined && !fitsPlacement(op.class, start, op.span))
          refuse({
            kind: "start-past-grid",
            class: op.class,
            start,
            span: op.span,
            columns: GRID_COLUMNS[op.class],
          });
        span[op.class] = op.span;
      }
      if (Object.keys(span).length > 0) at.block.props[SPAN_PROP] = span;
      else delete at.block.props[SPAN_PROP];
      return { board, change: { change: "block-updated", blockId: op.id } };
    }

    case "set_start": {
      const at =
        locate(board, op.id, schema) ?? refuse({ kind: "no-block", id: op.id });
      const start = isObj(at.block.props[START_PROP])
        ? { ...(at.block.props[START_PROP] as Record<string, unknown>) }
        : {};
      if (op.start === null) delete start[op.class];
      else {
        const span = spanAt(at.block, op.class);
        if (
          !fitsSpan(op.class, op.start) ||
          !fitsPlacement(op.class, op.start, span)
        )
          refuse({
            kind: "start-past-grid",
            class: op.class,
            start: op.start,
            span: span ?? null,
            columns: GRID_COLUMNS[op.class],
          });
        start[op.class] = op.start;
      }
      if (Object.keys(start).length > 0) at.block.props[START_PROP] = start;
      else delete at.block.props[START_PROP];
      return { board, change: { change: "block-updated", blockId: op.id } };
    }

    case "set_hide": {
      const at =
        locate(board, op.id, schema) ?? refuse({ kind: "no-block", id: op.id });
      const hide = isObj(at.block.props[HIDE_PROP])
        ? { ...(at.block.props[HIDE_PROP] as Record<string, unknown>) }
        : {};
      // Absent = shown: a block is stored hidden only where it is.
      if (op.hide) hide[op.class] = true;
      else delete hide[op.class];
      if (Object.keys(hide).length > 0) at.block.props[HIDE_PROP] = hide;
      else delete at.block.props[HIDE_PROP];
      return { board, change: { change: "block-updated", blockId: op.id } };
    }

    case "replace_page": {
      const frame = frameOf(board, op.frameId);
      if (frame.pageOf)
        refuse({
          kind: "frame-shows-page",
          frameId: frame.id,
          pageOf: frame.pageOf,
        });
      const { page, dropped } = checkPage(op.page, schema);
      if (!page)
        refuse({
          kind: "not-a-board",
          error: "The page is not a Puck page (it needs a `content` list).",
        });
      if (dropped.length > 0) refuse(...dropped);
      const taken = boardIds({
        format: BOARD_FORMAT,
        frames: board.frames.filter((f) => f !== frame),
      });
      giveIds(page!.content, taken);
      frame.page = page!;
      return { board, change: { change: "page-replaced", frameId: frame.id } };
    }

    case "replace_board": {
      const parsed = parseBoard(op.board, schema);
      if (!parsed.ok)
        return refuse({ kind: "not-a-board", error: parsed.error });
      if (parsed.migrated) refuse({ kind: "not-v3" });
      if (parsed.dropped.length > 0) refuse(...parsed.dropped);
      return { board: parsed.board, change: { change: "board-replaced" } };
    }
  }
}

/** Gap between a new frame and the rightmost one (CSS px). */
const FRAME_GAP = 160;

/** The slot a list belongs to (null for a page's own content): its holder's type, prop and allow-list. */
function slotOfList(
  board: Board,
  list: PageBlock[],
  schema: CanvasSchema
): { type: string; prop: string; allow?: string[] } | null {
  for (const f of board.frames)
    for (const b of walkBlocks(f.page.content, schema))
      for (const { prop, blocks } of slotsOf(b, schema))
        if (blocks === list) {
          const spec = schema[b.type]?.[prop];
          return {
            type: b.type,
            prop,
            ...(spec && spec.kind === "slot" && spec.allow
              ? { allow: spec.allow }
              : {}),
          };
        }
  return null;
}

/**
 * Apply `ops` to `board`, all or nothing, against the catalog snapshot. The
 * board given is never changed. A refusal names the op (its index), every
 * reason, and the catalog hash.
 */
export function applyOps(
  board: Board,
  ops: readonly unknown[],
  catalog: DesignCatalogSnapshot
): ApplyOpsResult {
  const schema = catalogSchema(catalog);
  let next = JSON.parse(JSON.stringify(board)) as Board;
  const changes: Array<DesignChange & { opIndex: number }> = [];
  for (let i = 0; i < ops.length; i++) {
    const raw = ops[i];
    const name = isObj(raw) && typeof raw.op === "string" ? raw.op : "?";
    const parsed = designOpSchema.safeParse(raw);
    try {
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        refuse({
          kind: "bad-op",
          detail: issue
            ? `${issue.path.join(".") || "op"}: ${issue.message}`
            : "unreadable op",
        });
      }
      const done = applyOne(next, parsed.data!, schema);
      next = done.board;
      changes.push({ ...done.change, opIndex: i });
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      return {
        ok: false,
        opIndex: i,
        op: name,
        reasons: err.reasons,
        catalogHash: catalog.hash,
        message: `Op ${i} (${name}) refused, nothing was changed: ${err.reasons
          .map(describeRefusal)
          .join("; ")}. Catalog ${catalog.kitId}@${catalog.hash}.`,
      };
    }
  }
  return {
    ok: true,
    board: next,
    changes,
    componentsUsed: boardComponents(next),
    catalogHash: catalog.hash,
  };
}
