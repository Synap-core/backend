/**
 * The board scene: what a whiteboard holds, as an agent reads it.
 *
 * A board's content is a tldraw 2.4.6 store, `{ [recordId]: record }`, held in
 * two places: the live Y.Doc of the realtime room (map `tl_map_<documentId>`)
 * and the JSON file at `documents.storageKey` (`{ store }`). Both hold the SAME
 * records, so one pure function turns either into the scene.
 *
 * Tolerant by design: Synap's custom shape props have NO validators or
 * migrations (synap-app `packages/web/src/whiteboard/shapes/*ShapeUtil.tsx`,
 * `packages/web/src/artboards/model.ts`), so old boards carry old or missing
 * props. A prop that is absent or of the wrong type is left out of the scene,
 * never guessed. A record that is not a shape, an arrow binding or a page is
 * skipped and COUNTED (`counts.skipped`, by `typeName`), never a crash.
 *
 * Arrows (tldraw 2.4.6, `@tldraw/tlschema` `arrowShapeVersions.ExtractBindings`):
 * an arrow's endpoints are SEPARATE `binding` records
 * `{ typeName: "binding", type: "arrow", fromId: <arrow>, toId: <shape>,
 *    props: { terminal: "start" | "end", normalizedAnchor, isExact, isPrecise } }`,
 * and the arrow's own `props.start` / `props.end` are `{ x, y }` points relative
 * to the arrow (`{0,0}` placeholders once bound). A store written before that
 * migration keeps `props.start = { type: "binding", boundShapeId, ... }` on the
 * arrow itself; both forms are read.
 *
 * Coordinates: tldraw stores `x`/`y` relative to the parent (a frame, an
 * artboard or a group). The scene gives PAGE coordinates (the parents' offsets
 * added). Rotation is NOT applied: a shape's own `rotation` is reported but its
 * bounds are unrotated, and a ROTATED parent frame's rotation is not applied to
 * its children's page `x`/`y` (they are offset as if the frame were upright).
 */

/** What a shape points at, read from its props (only the keys present). */
export interface BoardShapeRefs {
  entityId?: string;
  entityType?: string;
  viewId?: string;
  viewType?: string;
  cellInstanceId?: string;
  cellKey?: string;
  url?: string;
}

/** `meta.placedBy`, written by the governed place door (next PR). */
export interface BoardPlacedBy {
  agentUserId?: string;
  proposalId?: string;
}

export interface BoardSceneShape {
  /** The tldraw record id (`shape:…`). */
  id: string;
  /**
   * The tldraw shape type as stored: Synap's `entityCard`, `view`, `cell`,
   * `sticky`, `artboard`, legacy `synap-frame`, or a tldraw native type
   * (`frame` = a section, `text`, `geo`, `note`, `draw`, `line`, `image`,
   * `bookmark`, `embed`, `group`, …). Unknown types are kept as they are.
   */
  type: string;
  /** The parent SHAPE (a frame, an artboard or a group); null = on a page. */
  parentId: string | null;
  /** The page the shape is on (null when its parent chain is broken). */
  pageId: string | null;
  /** The nearest frame, artboard or legacy synap-frame holding it. */
  frameId: string | null;
  /** Page coordinates (parents' offsets added, rotation not applied). */
  x: number;
  y: number;
  /** Size, when the props carry one (or the points give one); else null. */
  w: number | null;
  h: number | null;
  rotation: number;
  /** A title or name the props carry (card title, frame name, artboard title). */
  title?: string;
  /** Text content (sticky content, text/geo/note label), capped. */
  text?: string;
  textTruncated?: true;
  refs?: BoardShapeRefs;
  /** Artboard output settings (`artboard` shapes only). */
  artboard?: {
    presetId?: string;
    pageIndex?: number;
    outputWidth?: number;
    outputHeight?: number;
  };
  placedBy?: BoardPlacedBy;
  /** `meta.pending === true`: placed by an agent, not yet approved. */
  pending?: true;
}

export interface BoardArrowEnd {
  /** The shape this end is bound to; null for a free end. */
  shapeId: string | null;
  /** Page coordinates of the end (the bound shape's anchor when bound). */
  x: number | null;
  y: number | null;
  /** How the end was read: a 2.4 binding record, a pre-2.4 bound terminal, or a free point. */
  via: "binding" | "legacy-terminal" | "point";
}

export interface BoardSceneArrow {
  id: string;
  parentId: string | null;
  pageId: string | null;
  frameId: string | null;
  start: BoardArrowEnd;
  end: BoardArrowEnd;
  /** The arrow's label. */
  text?: string;
  /** `meta.relationId`: the pod relation this arrow draws. */
  relationId?: string;
  /** `meta.graphSourced`: drawn by the board from the relation graph. */
  graphSourced?: true;
  placedBy?: BoardPlacedBy;
  pending?: true;
}

export interface BoardScenePage {
  id: string;
  name: string | null;
}

export interface BoardScene {
  pages: BoardScenePage[];
  /** Every shape but arrows, in reading order (page, then top to bottom, left to right). */
  shapes: BoardSceneShape[];
  arrows: BoardSceneArrow[];
  counts: {
    /** Records read. */
    records: number;
    shapes: number;
    arrows: number;
    /** Shapes (arrows included) by tldraw type. */
    byType: Record<string, number>;
    /**
     * Records that are not a page, a shape or an arrow binding (tldraw's
     * document, camera, instance, pointer, asset records; another binding
     * type; anything unknown), by `typeName` (`invalid` = not a record).
     */
    skipped: Record<string, number>;
  };
  /** Page-space box around every sized shape and arrow end; null when none. */
  bounds: { x: number; y: number; w: number; h: number } | null;
}

/** Cap on a shape's text, so one long note cannot fill an agent's reply. */
export const BOARD_TEXT_MAX_CHARS = 2_000;

/** Container shapes that make a "frame" for the shapes inside them. */
const FRAME_TYPES: ReadonlySet<string> = new Set([
  "frame",
  "artboard",
  "synap-frame",
]);

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Text from a tldraw rich-text document (`{ type: "doc", content: [...] }`),
 * the shape newer tldraw versions store; 2.4.6 stores a plain string.
 */
function richText(v: unknown): string | undefined {
  const parts: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (!isRec(node) || depth > 32) return;
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) {
      for (const c of node.content) walk(c, depth + 1);
      if (node.type === "paragraph") parts.push("\n");
    }
  };
  walk(v, 0);
  const out = parts.join("").trim();
  return out.length > 0 ? out : undefined;
}

function shapeText(type: string, props: Rec): string | undefined {
  if (type === "sticky") return str(props.content);
  return str(props.text) ?? richText(props.richText);
}

function shapeTitle(type: string, props: Rec): string | undefined {
  if (type === "frame") return str(props.name);
  return str(props.title);
}

/** `url` / `src` out of a cell's `cellProps` (a JSON string, or an old object). */
function cellPropsUrl(raw: unknown): string | undefined {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!isRec(parsed)) return undefined;
  return str(parsed.url) ?? str(parsed.src);
}

function shapeRefs(type: string, props: Rec): BoardShapeRefs | undefined {
  const refs: BoardShapeRefs = {};
  const entityId = str(props.entityId);
  if (entityId) {
    refs.entityId = entityId;
    const entityType = str(props.entityType);
    if (entityType) refs.entityType = entityType;
  }
  const viewId = str(props.viewId);
  if (viewId) {
    refs.viewId = viewId;
    const viewType = str(props.viewType);
    if (viewType) refs.viewType = viewType;
  }
  if (type === "cell") {
    // `cellInstanceId: ""` is the documented "no instance" value.
    const cellInstanceId = str(props.cellInstanceId);
    if (cellInstanceId) refs.cellInstanceId = cellInstanceId;
    const cellKey = str(props.cellKey);
    if (cellKey) refs.cellKey = cellKey;
    const url = cellPropsUrl(props.cellProps);
    if (url) refs.url = url;
  }
  const url = str(props.url);
  if (url) refs.url = url;
  return Object.keys(refs).length > 0 ? refs : undefined;
}

function placedByOf(meta: Rec): BoardPlacedBy | undefined {
  if (!isRec(meta.placedBy)) return undefined;
  const out: BoardPlacedBy = {};
  const agentUserId = str(meta.placedBy.agentUserId);
  const proposalId = str(meta.placedBy.proposalId);
  if (agentUserId) out.agentUserId = agentUserId;
  if (proposalId) out.proposalId = proposalId;
  return out;
}

/** Size from props, or from the points of a draw/line/highlight shape. */
function sizeOf(props: Rec): { w: number | null; h: number | null } {
  const w = num(props.w);
  const h = num(props.h);
  if (w !== undefined && h !== undefined) return { w, h };
  const pts: Array<{ x: number; y: number }> = [];
  const take = (p: unknown) => {
    if (!isRec(p)) return;
    const x = num(p.x);
    const y = num(p.y);
    if (x !== undefined && y !== undefined) pts.push({ x, y });
  };
  if (Array.isArray(props.segments)) {
    for (const seg of props.segments) {
      if (isRec(seg) && Array.isArray(seg.points)) seg.points.forEach(take);
    }
  }
  if (isRec(props.points)) Object.values(props.points).forEach(take);
  if (pts.length === 0) return { w: w ?? null, h: h ?? null };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    w: w ?? Math.max(...xs) - Math.min(...xs),
    h: h ?? Math.max(...ys) - Math.min(...ys),
  };
}

interface RawShape {
  id: string;
  type: string;
  parentId: string | null;
  x: number;
  y: number;
  rotation: number;
  props: Rec;
  meta: Rec;
}

/**
 * Turn a tldraw store into the board scene. Pure: no I/O, never throws on
 * content (a non-object input is an empty scene with one `invalid` skip).
 */
export function buildBoardScene(records: unknown): BoardScene {
  const skipped: Record<string, number> = {};
  const skip = (key: string) => {
    skipped[key] = (skipped[key] ?? 0) + 1;
  };

  const pages: BoardScenePage[] = [];
  const raw = new Map<string, RawShape>();
  /** arrowId → terminal → bound shape id + anchor */
  const bindings = new Map<
    string,
    Partial<
      Record<
        "start" | "end",
        { toId: string; anchor: { x: number; y: number } | null }
      >
    >
  >();

  const entries: Array<[string, unknown]> = isRec(records)
    ? Object.entries(records)
    : [];
  if (!isRec(records)) skip("invalid");

  for (const [key, rec] of entries) {
    if (!isRec(rec)) {
      skip("invalid");
      continue;
    }
    const typeName = typeof rec.typeName === "string" ? rec.typeName : "";
    const id = str(rec.id) ?? key;
    if (typeName === "shape") {
      const type = str(rec.type);
      if (!type) {
        skip("invalid");
        continue;
      }
      const parent = str(rec.parentId);
      raw.set(id, {
        id,
        type,
        parentId: parent ?? null,
        x: num(rec.x) ?? 0,
        y: num(rec.y) ?? 0,
        rotation: num(rec.rotation) ?? 0,
        props: isRec(rec.props) ? rec.props : {},
        meta: isRec(rec.meta) ? rec.meta : {},
      });
    } else if (typeName === "page") {
      pages.push({ id, name: str(rec.name) ?? null });
    } else if (typeName === "binding" && rec.type === "arrow") {
      const fromId = str(rec.fromId);
      const toId = str(rec.toId);
      const props = isRec(rec.props) ? rec.props : {};
      const terminal = props.terminal;
      if (!fromId || !toId || (terminal !== "start" && terminal !== "end")) {
        skip("invalid");
        continue;
      }
      const a = isRec(props.normalizedAnchor) ? props.normalizedAnchor : null;
      const ax = a ? num(a.x) : undefined;
      const ay = a ? num(a.y) : undefined;
      const ends = bindings.get(fromId) ?? {};
      ends[terminal] = {
        toId,
        anchor: ax !== undefined && ay !== undefined ? { x: ax, y: ay } : null,
      };
      bindings.set(fromId, ends);
    } else {
      skip(
        typeName === "binding"
          ? `binding:${str(rec.type) ?? "?"}`
          : typeName || "invalid"
      );
    }
  }

  // Page coordinates, page and frame: walk each shape's parent chain once.
  const placed = new Map<
    string,
    { x: number; y: number; pageId: string | null; frameId: string | null }
  >();
  const place = (
    id: string,
    seen: Set<string>
  ): {
    x: number;
    y: number;
    pageId: string | null;
    frameId: string | null;
  } => {
    const done = placed.get(id);
    if (done) return done;
    const s = raw.get(id)!;
    let out: {
      x: number;
      y: number;
      pageId: string | null;
      frameId: string | null;
    };
    const parent = s.parentId ? raw.get(s.parentId) : undefined;
    if (!s.parentId || s.parentId.startsWith("page:")) {
      out = { x: s.x, y: s.y, pageId: s.parentId, frameId: null };
    } else if (!parent || seen.has(parent.id)) {
      // A parent that is not in the store (or a cycle): keep local coordinates.
      out = { x: s.x, y: s.y, pageId: null, frameId: null };
    } else {
      seen.add(s.id);
      const p = place(parent.id, seen);
      out = {
        x: p.x + s.x,
        y: p.y + s.y,
        pageId: p.pageId,
        frameId: FRAME_TYPES.has(parent.type) ? parent.id : p.frameId,
      };
    }
    placed.set(id, out);
    return out;
  };

  const byType: Record<string, number> = {};
  const shapes: BoardSceneShape[] = [];
  const arrows: BoardSceneArrow[] = [];

  for (const s of raw.values()) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
    const pos = place(s.id, new Set([s.id]));
    const parentId = s.parentId?.startsWith("page:") ? null : s.parentId;
    const placedBy = placedByOf(s.meta);
    const pending = s.meta.pending === true;

    if (s.type === "arrow") {
      const ends = bindings.get(s.id) ?? {};
      const endOf = (terminal: "start" | "end"): BoardArrowEnd => {
        const bound = ends[terminal];
        const legacy = isRec(s.props[terminal])
          ? (s.props[terminal] as Rec)
          : {};
        const toId =
          bound?.toId ??
          (legacy.type === "binding" ? str(legacy.boundShapeId) : undefined);
        if (toId) {
          const anchorRec = bound
            ? bound.anchor
            : isRec(legacy.normalizedAnchor)
              ? {
                  x: num(legacy.normalizedAnchor.x) ?? 0.5,
                  y: num(legacy.normalizedAnchor.y) ?? 0.5,
                }
              : null;
          const target = raw.get(toId);
          let x: number | null = null;
          let y: number | null = null;
          if (target) {
            const tp = place(target.id, new Set([target.id]));
            const size = sizeOf(target.props);
            const anchor = anchorRec ?? { x: 0.5, y: 0.5 };
            x = tp.x + (size.w ?? 0) * anchor.x;
            y = tp.y + (size.h ?? 0) * anchor.y;
          }
          return {
            shapeId: toId,
            x,
            y,
            via: bound ? "binding" : "legacy-terminal",
          };
        }
        const px = num(legacy.x);
        const py = num(legacy.y);
        return {
          shapeId: null,
          x: px !== undefined ? pos.x + px : null,
          y: py !== undefined ? pos.y + py : null,
          via: "point",
        };
      };
      const arrow: BoardSceneArrow = {
        id: s.id,
        parentId,
        pageId: pos.pageId,
        frameId: pos.frameId,
        start: endOf("start"),
        end: endOf("end"),
      };
      const text = shapeText(s.type, s.props);
      if (text) arrow.text = text.slice(0, BOARD_TEXT_MAX_CHARS);
      const relationId = str(s.meta.relationId);
      if (relationId) arrow.relationId = relationId;
      if (s.meta.graphSourced === true) arrow.graphSourced = true;
      if (placedBy) arrow.placedBy = placedBy;
      if (pending) arrow.pending = true;
      arrows.push(arrow);
      continue;
    }

    const size = sizeOf(s.props);
    const shape: BoardSceneShape = {
      id: s.id,
      type: s.type,
      parentId,
      pageId: pos.pageId,
      frameId: pos.frameId,
      x: pos.x,
      y: pos.y,
      w: size.w,
      h: size.h,
      rotation: s.rotation,
    };
    const title = shapeTitle(s.type, s.props);
    if (title) shape.title = title;
    const text = shapeText(s.type, s.props);
    if (text) {
      shape.text = text.slice(0, BOARD_TEXT_MAX_CHARS);
      if (text.length > BOARD_TEXT_MAX_CHARS) shape.textTruncated = true;
    }
    const refs = shapeRefs(s.type, s.props);
    if (refs) shape.refs = refs;
    if (s.type === "artboard") {
      const artboard: NonNullable<BoardSceneShape["artboard"]> = {};
      const presetId = str(s.props.presetId);
      const pageIndex = num(s.props.pageIndex);
      const outputWidth = num(s.props.outputWidth);
      const outputHeight = num(s.props.outputHeight);
      if (presetId) artboard.presetId = presetId;
      if (pageIndex !== undefined) artboard.pageIndex = pageIndex;
      if (outputWidth !== undefined) artboard.outputWidth = outputWidth;
      if (outputHeight !== undefined) artboard.outputHeight = outputHeight;
      shape.artboard = artboard;
    }
    if (placedBy) shape.placedBy = placedBy;
    if (pending) shape.pending = true;
    shapes.push(shape);
  }

  const pageOrder = new Map(pages.map((p, i) => [p.id, i]));
  shapes.sort(
    (a, b) =>
      (pageOrder.get(a.pageId ?? "") ?? pages.length) -
        (pageOrder.get(b.pageId ?? "") ?? pages.length) ||
      a.y - b.y ||
      a.x - b.x ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  arrows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number, w = 0, h = 0) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const s of shapes) {
    if (s.w !== null && s.h !== null) grow(s.x, s.y, s.w, s.h);
  }
  for (const a of arrows) {
    for (const e of [a.start, a.end]) {
      if (e.x !== null && e.y !== null) grow(e.x, e.y);
    }
  }
  const bounds =
    minX === Infinity
      ? null
      : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

  return {
    pages,
    shapes,
    arrows,
    counts: {
      records: entries.length,
      shapes: shapes.length,
      arrows: arrows.length,
      byType,
      skipped,
    },
    bounds,
  };
}

/** Which part of a scene a reader asked for. */
export interface BoardSceneWindow {
  /** Only what a frame or artboard holds, at any depth (and the frame itself). */
  frameId?: string;
  /** Skip this many shapes (reading order). */
  offset?: number;
  /** At most this many shapes. */
  limit?: number;
}

export interface BoardSceneWindowed extends BoardScene {
  /** Present when a window was asked for; `counts` and `bounds` stay whole-board. */
  window?: {
    frameId: string | null;
    offset: number;
    /** Shapes in the frame (or the board) before paging. */
    matched: number;
    /** Pass as `offset` for the next page; null when this page is the last. */
    nextOffset: number | null;
  };
}

/**
 * Narrow a scene to a frame and/or a page of shapes, so a big board can be
 * read in parts. `counts`, `bounds` and `pages` describe the WHOLE board. An
 * arrow is kept when it sits in the frame or one of its ends is bound to a
 * shape kept. Pure.
 */
export function windowBoardScene(
  scene: BoardScene,
  win: BoardSceneWindow
): BoardSceneWindowed {
  const asked =
    win.frameId !== undefined ||
    win.offset !== undefined ||
    win.limit !== undefined;
  if (!asked) return scene;

  const parentOf = new Map<string, string | null>();
  for (const s of scene.shapes) parentOf.set(s.id, s.parentId);
  for (const a of scene.arrows) parentOf.set(a.id, a.parentId);
  const inFrame = (id: string): boolean => {
    if (!win.frameId) return true;
    let cur: string | null | undefined = id;
    for (let depth = 0; cur && depth < 64; depth++) {
      if (cur === win.frameId) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };

  const matched = scene.shapes.filter((s) => inFrame(s.id));
  const offset = Math.max(0, Math.floor(win.offset ?? 0));
  const end =
    win.limit !== undefined
      ? offset + Math.max(0, Math.floor(win.limit))
      : matched.length;
  const shapes = matched.slice(offset, end);
  const kept = new Set(shapes.map((s) => s.id));
  const paged = offset > 0 || end < matched.length;
  const arrows = scene.arrows.filter((a) => {
    const touches =
      (a.start.shapeId !== null && kept.has(a.start.shapeId)) ||
      (a.end.shapeId !== null && kept.has(a.end.shapeId));
    // Paged: only arrows that touch this page's shapes (free arrows in the
    // frame ride with the first page).
    if (paged)
      return (
        touches ||
        (offset === 0 &&
          inFrame(a.id) &&
          a.start.shapeId === null &&
          a.end.shapeId === null)
      );
    return touches || inFrame(a.id);
  });
  return {
    ...scene,
    shapes,
    arrows,
    window: {
      frameId: win.frameId ?? null,
      offset,
      matched: matched.length,
      nextOffset: end < matched.length ? end : null,
    },
  };
}
