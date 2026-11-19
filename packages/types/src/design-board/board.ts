/**
 * THE CANVAS BOARD — a design laid out on an infinite canvas, as plain data.
 *
 * One format for both authors: the person edits on the canvas, and an agent
 * writes the same JSON straight to the pod (a `ui-design` whose
 * `schema-version` is BOARD_SCHEMA_VERSION). Every block is a REAL component
 * of the catalog (the Storybook-derived `CanvasSchema`), never a drawing of one.
 *
 *   frames  artboards (a desktop page, a phone screen), freely placed on the canvas
 *   page    what a frame holds: a Puck page (`root` + `content`), blocks in a
 *           FLOW layout; a container block holds more blocks in a slot prop
 *   pageOf  a frame may SHOW another frame's page instead (a viewport frame:
 *           the same page at a tablet or phone width); its own page stays empty
 *
 * Inside a frame layout is FLOW ONLY — no free x/y for a component (decision
 * 0fe103c9): a page that flows reads the same at every width, and an agent can
 * write one without measuring anything. Only frames are placed.
 *
 * Every older shape is migrated on read, so no saved design breaks; the next
 * save writes v3: a v2 board (`synap-board/1`, free-positioned items), and a
 * schema-1 Puck page of the retired page editor (one frame "Page").
 *
 * Pure: no React, no Puck runtime, no I/O. `parseBoard` refuses what it cannot
 * read (never "repairs" a broken board into an empty one).
 *
 * Moved from app-bases `apps/ui-gallery/src/design/board.ts` (plan 0fc746f4
 * §2.6) so the pod validates with the same code the canvas reads with: the
 * design door (`services/designs`, verbs `design.*`) and the Design app share
 * this one parser.
 */
import { GRID_PROPS, cleanGridProp } from "./grid.js";
import type { CanvasSchema, FieldSpec, ListSpec } from "./schema.js";

/** The format of a v3 board. */
export const BOARD_FORMAT = "synap-board/2";
/** The format of a v2 board (free-positioned items): migrated on read. */
export const LEGACY_BOARD_FORMAT = "synap-board/1";
/** `schema-version` of a board on a `ui-design` (1 = a single Puck page of the retired page editor, 2 = a v2 board; both open migrated). */
export const BOARD_SCHEMA_VERSION = 3;
/** `schema-version` of a v2 board: still a canvas, opened migrated. */
export const LEGACY_BOARD_SCHEMA_VERSION = 2;

/** One block of a page = Puck ComponentData. A slot prop holds an array of blocks. */
export interface PageBlock {
  type: string;
  props: { id: string } & Record<string, unknown>;
}

/** One frame's page = Puck Data (no `zones`: slots only). */
export interface FramePage {
  root: { props: Record<string, unknown> };
  content: PageBlock[];
}

export interface BoardFrame {
  id: string;
  name: string;
  /** Where the frame sits on the canvas. */
  x: number;
  y: number;
  /** The page width (a preset: 1440 desktop, 1280 laptop, 834 tablet, 390 phone). */
  w: number;
  /** The MINIMUM height; the frame grows with its page content. */
  h: number;
  /** Empty when the frame shows another frame's page (`pageOf`). */
  page: FramePage;
  /** The frame whose page this frame shows, at its own width (a frame that owns its page, never another viewer). */
  pageOf?: string;
}

export interface Board {
  format: typeof BOARD_FORMAT;
  frames: BoardFrame[];
}

/** The artboard sizes the canvas offers (CSS px). */
export const FRAME_PRESETS = [
  { id: "desktop", label: "Desktop", w: 1440, h: 900 },
  { id: "laptop", label: "Laptop", w: 1280, h: 800 },
  { id: "tablet", label: "Tablet", w: 834, h: 1112 },
  { id: "phone", label: "Phone", w: 390, h: 844 },
] as const;
export type FramePresetId = (typeof FRAME_PRESETS)[number]["id"];

/** Where migrated loose items go, and the gap to the rightmost frame. */
const LOOSE_FRAME_NAME = "Loose components";
const LOOSE_GAP = 160;

export const newFramePage = (): FramePage => ({
  root: { props: {} },
  content: [],
});

export const emptyBoard = (): Board => ({ format: BOARD_FORMAT, frames: [] });

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
/** Own keys only: "constructor" is not a component of the catalog. */
const has = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** `schema-version` of a single Puck page: still a design, opened as a one-frame canvas. */
export const PAGE_SCHEMA_VERSION = 1;

/** Blocks nested deeper than this are dropped (a recursion bomb is not a design). Content is depth 0, each slot one deeper. */
export const MAX_DEPTH = 32;

/** The shape of a block: a string `type` and a `props` object (its id is not checked here). */
export type RawBlock = { type: string; props: Record<string, unknown> };

/** Is this a block (a string `type` and a `props` object)? */
export const isBlock = (v: unknown): v is RawBlock =>
  isObj(v) && typeof v.type === "string" && isObj(v.props);

/** A prop that holds blocks: a non-empty array of nothing but blocks. */
const holdsBlocks = (v: unknown): v is RawBlock[] =>
  Array.isArray(v) && v.length > 0 && v.every(isBlock);

/**
 * The slot arrays of a block, in order: with a schema, the props the catalog
 * declares as slots (that hold a list); without one, every prop that holds
 * blocks. THE definition of "where a block's children are".
 */
export function childLists(
  block: RawBlock,
  schema?: CanvasSchema
): Array<{ prop: string; blocks: PageBlock[] }> {
  if (!schema)
    return Object.entries(block.props)
      .filter(([, v]) => holdsBlocks(v))
      .map(([prop, v]) => ({ prop, blocks: v as PageBlock[] }));
  const fields = has(schema, block.type) ? schema[block.type]! : {};
  return Object.entries(fields)
    .filter(
      ([prop, spec]) => spec.kind === "slot" && Array.isArray(block.props[prop])
    )
    .map(([prop]) => ({
      prop,
      blocks: (block.props[prop] as unknown[]).filter(isBlock) as PageBlock[],
    }));
}

/** Every block of a list, parents before their children, in reading order. */
export function* walkBlocks(
  list: readonly RawBlock[],
  schema?: CanvasSchema
): Generator<PageBlock> {
  for (const b of list) {
    yield b as PageBlock;
    for (const { blocks } of childLists(b, schema))
      yield* walkBlocks(blocks, schema);
  }
}

/** `<type>-<n>`, the first number not taken; the id is added to `taken`. THE block id rule. */
export function nextBlockId(taken: Set<string>, type: string): string {
  let n = 0;
  let id: string;
  do id = `${type}-${++n}`;
  while (taken.has(id));
  taken.add(id);
  return id;
}

/**
 * A copy of `blocks` (every slot, at any depth) in which each block holds an
 * id not in `taken`: a block keeps its own id while it is free, else gets
 * `nextBlockId`. `taken` grows with every id given. Duplicating a frame passes
 * the board's ids, so every block of the copy gets a new one.
 */
export function reIdBlocks(
  blocks: readonly unknown[],
  taken: Set<string>
): PageBlock[] {
  return blocks.filter(isBlock).map((b) => {
    const id = b.props.id;
    const own = typeof id === "string" && id !== "" && !taken.has(id);
    if (own) taken.add(id);
    const props: Record<string, unknown> = {
      id: own ? id : nextBlockId(taken, b.type),
    };
    for (const [k, v] of Object.entries(b.props))
      if (k !== "id") props[k] = holdsBlocks(v) ? reIdBlocks(v, taken) : v;
    return { type: b.type, props: props as PageBlock["props"] };
  });
}

/**
 * Why a part of a stored design was left out on read. Keyed, never words: the
 * canvas's words are `dropWords` (app-bases design/copy.ts), the pod's are
 * `describeRefusal` (ops.ts).
 */
export type DropReason =
  /** Something in a block list that is not a block (no `type` or no `props`). */
  | { kind: "not-a-block" }
  /** A component the catalog does not have. */
  | { kind: "unknown-type"; type: string }
  /** Blocks under a prop the catalog does not list as a slot (they would never render). */
  | { kind: "not-a-slot"; type: string; prop: string }
  /** A prop the component does not declare, or a value that does not fit it (wrong kind, outside its options). */
  | { kind: "bad-prop"; type: string; prop: string }
  /** An item of a list prop: a field it does not declare or of the wrong kind, or the item lacks a required field. */
  | { kind: "bad-list-item"; type: string; prop: string }
  /** A block in a slot that does not take it (a label slot takes inline blocks only). */
  | { kind: "not-allowed"; type: string; parent: string; prop: string }
  /** A block nested deeper than MAX_DEPTH. */
  | { kind: "too-deep"; type: string }
  /** Puck `zones` (the retired page editor's DropZones): a page is slots only. */
  | { kind: "legacy-zones"; keys: string[] }
  /** A frame without id or position. */
  | { kind: "bad-frame" }
  /** A second frame with an id already used. */
  | { kind: "duplicate-frame"; id: string }
  /** A `pageOf` that names no frame owning a page (itself, a missing frame, another viewer), or on a frame holding blocks of its own. */
  | { kind: "bad-page-of"; frame: string }
  /** A v2 item without id, component or position. */
  | { kind: "bad-v2-item" };

export type ParseResult =
  | { ok: true; board: Board; dropped: DropReason[]; migrated: boolean }
  | { ok: false; error: string };

function valueFits(spec: FieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "text":
      return typeof value === "string";
    case "number":
      return num(value);
    case "boolean":
      return typeof value === "boolean";
    case "select":
      return typeof value === "string" && spec.options.includes(value);
    case "slot":
    case "list":
      return Array.isArray(value);
  }
}

const itemFits = (kind: ListSpec["item"][string]["kind"], v: unknown) =>
  kind === "text"
    ? typeof v === "string"
    : kind === "number"
      ? num(v)
      : typeof v === "boolean";

/** A list prop's items: undeclared or mistyped fields go, an item missing a required field goes. */
function cleanItems(
  list: unknown[],
  spec: ListSpec,
  type: string,
  prop: string,
  dropped: DropReason[]
) {
  const out: Record<string, unknown>[] = [];
  for (const raw of list) {
    if (!isObj(raw)) {
      dropped.push({ kind: "bad-list-item", type, prop });
      continue;
    }
    const item: Record<string, unknown> = {};
    let bad = false;
    for (const [k, v] of Object.entries(raw)) {
      const field = has(spec.item, k) ? spec.item[k] : undefined;
      if (field && itemFits(field.kind, v)) item[k] = v;
      else bad = true;
    }
    if (bad || spec.required.some((k) => !(k in item)))
      dropped.push({ kind: "bad-list-item", type, prop });
    if (spec.required.every((k) => k in item)) out.push(item);
  }
  return out;
}

/** A slot being cleaned: its holder, and the types it takes. */
type Slot = { type: string; prop: string; allow?: string[] };

/**
 * THE validation of a block list (content, or a slot's blocks): a block that
 * is not a block, whose type the catalog does not have, that its slot does not
 * allow, or that sits deeper than MAX_DEPTH is DROPPED and named; in a kept
 * block, a prop the catalog does not declare or whose value does not fit is
 * dropped and named; slots are cleaned the same way, recursively. Ids are not
 * touched here (`assignIds`). Without a schema only the shape and the depth
 * are checked, and a slot is any prop that holds blocks.
 */
function cleanBlocks(
  list: unknown[],
  schema: CanvasSchema | undefined,
  dropped: DropReason[],
  depth: number,
  slot?: Slot
): PageBlock[] {
  const out: PageBlock[] = [];
  for (const b of list) {
    if (!isBlock(b)) {
      dropped.push({ kind: "not-a-block" });
      continue;
    }
    if (depth > MAX_DEPTH) {
      dropped.push({ kind: "too-deep", type: b.type });
      continue;
    }
    if (schema && !has(schema, b.type)) {
      dropped.push({ kind: "unknown-type", type: b.type });
      continue;
    }
    if (slot?.allow && !slot.allow.includes(b.type)) {
      dropped.push({
        kind: "not-allowed",
        type: b.type,
        parent: slot.type,
        prop: slot.prop,
      });
      continue;
    }
    const fields = schema?.[b.type];
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(b.props)) {
      if (key === "id") props.id = value;
      else if (!fields)
        props[key] = holdsBlocks(value)
          ? cleanBlocks(value, schema, dropped, depth + 1)
          : value;
      else if (GRID_PROPS.includes(key)) {
        // Span and hide per width class (grid.ts): every block has them.
        const grid = cleanGridProp(key, value);
        if (grid.bad)
          dropped.push({ kind: "bad-prop", type: b.type, prop: key });
        if (grid.value) props[key] = grid.value;
      } else {
        const spec = has(fields, key) ? fields[key] : undefined;
        if (!spec && holdsBlocks(value))
          dropped.push({ kind: "not-a-slot", type: b.type, prop: key });
        else if (!spec)
          dropped.push({ kind: "bad-prop", type: b.type, prop: key });
        else if (!valueFits(spec, value))
          dropped.push({ kind: "bad-prop", type: b.type, prop: key });
        else if (spec.kind === "slot")
          props[key] = cleanBlocks(
            value as unknown[],
            schema,
            dropped,
            depth + 1,
            {
              type: b.type,
              prop: key,
              allow: spec.allow,
            }
          );
        else if (spec.kind === "list")
          props[key] = cleanItems(
            value as unknown[],
            spec,
            b.type,
            key,
            dropped
          );
        else props[key] = value;
      }
    }
    out.push({ type: b.type, props: props as PageBlock["props"] });
  }
  return out;
}

/**
 * Every block of the BOARD gets a string `props.id`, unique across all its
 * frames (a critique's `nodeId` and a motion entry address the whole design).
 * An id already there is kept (the first holder, in frame then reading order,
 * keeps it); a missing or repeated one becomes `nextBlockId` — deterministic,
 * so reading the same board twice gives the same ids.
 */
function assignIds(frames: readonly FramePage[]): void {
  const taken = new Set<string>();
  const needs: PageBlock[] = [];
  for (const page of frames)
    for (const b of walkBlocks(page.content)) {
      const id = (b.props as { id?: unknown }).id;
      if (typeof id === "string" && id !== "" && !taken.has(id)) taken.add(id);
      else needs.push(b);
    }
  for (const b of needs) b.props.id = nextBlockId(taken, b.type);
}

/** A page: its blocks cleaned; non-empty `zones` (slots only now) dropped and named. Null when it is not a page. */
function cleanPage(
  raw: unknown,
  schema: CanvasSchema | undefined,
  dropped: DropReason[]
): FramePage | null {
  if (raw === undefined) return newFramePage();
  if (!isObj(raw) || !Array.isArray(raw.content)) return null;
  const content = cleanBlocks(raw.content, schema, dropped, 0);
  if (isObj(raw.zones)) {
    const keys = Object.entries(raw.zones)
      .filter(([, z]) => Array.isArray(z) && z.length > 0)
      .map(([k]) => k);
    if (keys.length > 0) dropped.push({ kind: "legacy-zones", keys });
  }
  const root = isObj(raw.root) && isObj(raw.root.props) ? raw.root.props : {};
  return { root: { props: root }, content };
}

function parseV3(
  v: Record<string, unknown>,
  schema: CanvasSchema | undefined
): ParseResult {
  if (!Array.isArray(v.frames))
    return { ok: false, error: "A board needs a `frames` list." };
  const dropped: DropReason[] = [];
  const frames: BoardFrame[] = [];
  const seen = new Set<string>();
  for (const f of v.frames) {
    if (
      !isObj(f) ||
      typeof f.id !== "string" ||
      !num(f.x) ||
      !num(f.y) ||
      !num(f.w) ||
      !num(f.h)
    ) {
      dropped.push({ kind: "bad-frame" });
      continue;
    }
    if (seen.has(f.id)) {
      dropped.push({ kind: "duplicate-frame", id: f.id });
      continue;
    }
    seen.add(f.id);
    const page = cleanPage(f.page, schema, dropped);
    // A page that is not a page is never opened as an empty one: saving would erase it.
    if (!page)
      return {
        ok: false,
        error: `Frame ${f.id} has a page that is not a Puck page (no \`content\` list).`,
      };
    frames.push({
      // Keys this version does not know pass through untouched (they never
      // render): a save must not erase a field a newer writer added.
      ...f,
      id: f.id,
      name: typeof f.name === "string" ? f.name : "Frame",
      x: f.x,
      y: f.y,
      w: Math.max(1, f.w),
      h: Math.max(1, f.h),
      page,
    });
  }
  checkPageOf(frames, dropped);
  assignIds(frames.map((f) => f.page));
  return {
    ok: true,
    board: { format: BOARD_FORMAT, frames },
    dropped,
    migrated: false,
  };
}

/**
 * A viewport frame shows the page of a frame that owns one: `pageOf` names
 * another frame of the board that has no `pageOf` itself. A frame that holds
 * blocks keeps them: a `pageOf` on it would hide them, so it goes (named), like
 * any `pageOf` that does not name such a frame.
 */
function checkPageOf(frames: BoardFrame[], dropped: DropReason[]): void {
  const owners = new Set(
    frames.filter((f) => !("pageOf" in f)).map((f) => f.id)
  );
  for (const f of frames) {
    if (!("pageOf" in f)) continue;
    const ok =
      typeof f.pageOf === "string" &&
      f.pageOf !== f.id &&
      owners.has(f.pageOf) &&
      f.page.content.length === 0;
    if (ok) continue;
    delete f.pageOf;
    dropped.push({ kind: "bad-page-of", frame: f.id });
  }
}

/** The frame whose page `frame` draws: its source when it shows another frame's page (`pageOf`), else itself. */
export function pageOwner(board: Board, frame: BoardFrame): BoardFrame {
  return (
    (frame.pageOf
      ? board.frames.find((f) => f.id === frame.pageOf)
      : undefined) ?? frame
  );
}

/**
 * v2 → v3. Each frame's items become its page in reading order (y, then x);
 * x/y/w/h go (flow); an item on no frame goes into one new frame "Loose
 * components" right of the rightmost frame. No item is lost.
 */
function migrateV2(
  v: Record<string, unknown>,
  schema: CanvasSchema | undefined
): ParseResult {
  if (!Array.isArray(v.frames) || !Array.isArray(v.items))
    return { ok: false, error: "A board needs `frames` and `items` lists." };
  const dropped: DropReason[] = [];
  const frames: Array<Omit<BoardFrame, "page">> = [];
  for (const f of v.frames) {
    if (
      isObj(f) &&
      typeof f.id === "string" &&
      num(f.x) &&
      num(f.y) &&
      num(f.w) &&
      num(f.h)
    )
      frames.push({
        id: f.id,
        name: typeof f.name === "string" ? f.name : "Frame",
        x: f.x,
        y: f.y,
        w: Math.max(1, f.w),
        h: Math.max(1, f.h),
      });
    else dropped.push({ kind: "bad-frame" });
  }
  const frameIds = new Set(frames.map((f) => f.id));
  const byFrame = new Map<
    string,
    Array<{ x: number; y: number; block: unknown }>
  >();
  const loose: Array<{ x: number; y: number; block: unknown }> = [];
  for (const it of v.items) {
    if (
      !isObj(it) ||
      typeof it.id !== "string" ||
      typeof it.component !== "string" ||
      !num(it.x) ||
      !num(it.y)
    ) {
      dropped.push({ kind: "bad-v2-item" });
      continue;
    }
    const entry = {
      x: it.x,
      y: it.y,
      block: {
        type: it.component,
        props: { ...(isObj(it.props) ? it.props : {}), id: it.id },
      },
    };
    if (typeof it.frame === "string" && frameIds.has(it.frame)) {
      const list = byFrame.get(it.frame) ?? [];
      list.push(entry);
      byFrame.set(it.frame, list);
    } else loose.push(entry);
  }
  const page = (
    entries: Array<{ x: number; y: number; block: unknown }>
  ): FramePage => ({
    root: { props: {} },
    content: cleanBlocks(
      [...entries].sort((a, b) => a.y - b.y || a.x - b.x).map((e) => e.block),
      schema,
      dropped,
      0
    ),
  });
  const out: BoardFrame[] = frames.map((f) => ({
    ...f,
    page: page(byFrame.get(f.id) ?? []),
  }));
  if (loose.length > 0) {
    let id = "loose";
    for (let n = 2; frameIds.has(id); n++) id = `loose-${n}`;
    out.push({
      id,
      name: LOOSE_FRAME_NAME,
      x: frames.length
        ? Math.max(...frames.map((f) => f.x + f.w)) + LOOSE_GAP
        : 0,
      y: frames.length ? Math.min(...frames.map((f) => f.y)) : 0,
      w: 1440,
      h: 900,
      page: page(loose),
    });
  }
  assignIds(out.map((f) => f.page));
  return {
    ok: true,
    board: { format: BOARD_FORMAT, frames: out },
    dropped,
    migrated: true,
  };
}

/** A schema-1 Puck page `{content, root, zones?}` → one frame "Page" (non-empty zones are dropped and named). */
function migratePage(
  v: Record<string, unknown>,
  schema: CanvasSchema | undefined
): ParseResult {
  const dropped: DropReason[] = [];
  const page = cleanPage(v, schema, dropped);
  if (!page) return { ok: false, error: "The page has no `content` list." };
  assignIds([page]);
  return {
    ok: true,
    board: {
      format: BOARD_FORMAT,
      frames: [{ id: "page", name: "Page", x: 0, y: 0, w: 1440, h: 900, page }],
    },
    dropped,
    migrated: true,
  };
}

/**
 * THE door into a design: read a board from what the pod (or an agent) handed
 * over — v3 as it is, v2 migrated (`migrated: true`), and a schema-1 Puck page
 * as one frame. With the catalog's schema, everything the catalog cannot
 * place is DROPPED and named in `dropped` (so the rest still opens and the
 * person sees what was left out), never rendered as a guess: see
 * `cleanBlocks`. Refuses (`ok: false`) only what it cannot read at all.
 */
export function parseBoard(raw: unknown, schema?: CanvasSchema): ParseResult {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { ok: false, error: "The board is not valid JSON." };
    }
  }
  if (!isObj(v)) return { ok: false, error: "The board is not an object." };
  if (v.format === BOARD_FORMAT) return parseV3(v, schema);
  if (v.format === LEGACY_BOARD_FORMAT) return migrateV2(v, schema);
  if (v.format === undefined && Array.isArray(v.content) && isObj(v.root))
    return migratePage(v, schema);
  return {
    ok: false,
    error: `This is not a canvas board (format ${JSON.stringify(v.format)}, expected "${BOARD_FORMAT}").`,
  };
}

/** Component names the board uses, in every frame and every slot, sorted (the `components-used` property). */
export function boardComponents(board: Board): string[] {
  const types = new Set<string>();
  for (const f of board.frames)
    for (const b of walkBlocks(f.page.content)) types.add(b.type);
  return [...types].sort();
}

/** Where blocks are checked: their depth (page content is 0) and the slot that holds them, if any. */
export interface BlockPlace {
  depth: number;
  slot?: { type: string; prop: string; allow?: string[] };
}

/**
 * THE validation of blocks for one place in a page, exported for the op
 * applier (`applyOps`): the same `cleanBlocks` the reader runs, so a block an
 * op adds is held to exactly what a stored design is. What it would drop is
 * returned, never silently kept.
 */
export function checkBlocks(
  list: unknown[],
  schema: CanvasSchema,
  place: BlockPlace
): { blocks: PageBlock[]; dropped: DropReason[] } {
  const dropped: DropReason[] = [];
  const blocks = cleanBlocks(list, schema, dropped, place.depth, place.slot);
  return { blocks, dropped };
}

/** A whole page checked the same way (`replace_page`): null when it is not a page (no `content` list). */
export function checkPage(
  raw: unknown,
  schema: CanvasSchema
): { page: FramePage | null; dropped: DropReason[] } {
  const dropped: DropReason[] = [];
  if (raw === undefined) return { page: null, dropped };
  return { page: cleanPage(raw, schema, dropped), dropped };
}
