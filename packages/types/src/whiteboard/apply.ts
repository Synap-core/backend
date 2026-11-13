/**
 * What a write to a board does to the records it holds NOW: pure, so the
 * realtime server runs it on the live map (under the room's lock) and a test
 * runs it on a plain object.
 *
 * WHY HERE AND NOT IN THE API. The API reads a board, merges, and writes whole
 * records back; a person's move or text edit made in between is lost, and a
 * child or arrow added in between is left pointing at nothing. The API now
 * sends INTENT (create these, patch these, remove these) and the realtime
 * server decides against the board as it is at the moment of the write.
 *
 *  - create: a record whose id the board already holds is written only when
 *    it is still pending and the same actor placed it (a retry replaces); a
 *    shape the person kept (or moved) is never reset, it is reported skipped.
 *  - patch: merged into the live record. Only props the shape already has,
 *    of the type they have; w/h only where the shape has them; reference
 *    props are never patched; the merged record stays small.
 *  - remove: the shapes, what they hold and the bindings that point at them,
 *    all from the live map.
 */

import {
  BOARD_REFERENCE_PROP_KEYS,
  type BoardShapeUpdate,
} from "./resources.js";
import {
  BOARD_PLACEMENT_META_KEYS,
  isPendingPlacement,
  readPlacedBy,
  shapeRemovalIds,
  type BoardRecord,
} from "./records.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The most a single record may serialize to once patched (chars). */
export const BOARD_RECORD_MAX_CHARS = 100_000;

export interface BoardApplyOps {
  create?: readonly BoardRecord[];
  patch?: readonly BoardShapeUpdate[];
  /** Shape ids; their children and bindings go with them. */
  remove?: readonly string[];
}

export interface BoardApplyPlan {
  /** Records to put whole. */
  put: BoardRecord[];
  /** Record ids to delete (the removal closure). */
  delete: string[];
  /** Created record ids actually written. */
  created: string[];
  /** Created record ids left alone (the board holds them, kept). */
  skipped: string[];
}

export type BoardApplyFailure = "shape_not_found" | "bad_request";

export class BoardApplyError extends Error {
  constructor(
    readonly reason: BoardApplyFailure,
    message: string
  ) {
    super(message);
    this.name = "BoardApplyError";
  }
}

const kindOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

function sameActor(
  a: ReturnType<typeof readPlacedBy>,
  b: ReturnType<typeof readPlacedBy>
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.userId === b.userId &&
    (a.agentUserId ?? null) === (b.agentUserId ?? null)
  );
}

/** May a created record replace what the board holds under its id? */
function replaceable(existing: unknown, created: BoardRecord): boolean {
  if (!isRec(existing)) return true;
  if (created.typeName !== "shape") return false; // a page that exists stays
  return (
    existing.typeName === "shape" &&
    isPendingPlacement(existing) &&
    sameActor(
      readPlacedBy(existing),
      readPlacedBy(created as { meta?: unknown })
    )
  );
}

function patchRecord(current: Rec, u: BoardShapeUpdate): BoardRecord {
  const props = isRec(current.props) ? current.props : {};
  const nextProps: Rec = { ...props };
  const set = (key: string, value: unknown) => {
    if (!(key in props)) {
      throw new BoardApplyError(
        "bad_request",
        `Shape ${u.shapeId} has no prop "${key}" to change (change only what the shape already has; read the board for its props).`
      );
    }
    if (
      props[key] !== null &&
      props[key] !== undefined &&
      kindOf(props[key]) !== kindOf(value)
    ) {
      throw new BoardApplyError(
        "bad_request",
        `Shape ${u.shapeId} prop "${key}" is a ${kindOf(props[key])}; got a ${kindOf(value)}.`
      );
    }
    nextProps[key] = value;
  };
  for (const [key, value] of Object.entries(u.props ?? {})) {
    if ((BOARD_REFERENCE_PROP_KEYS as readonly string[]).includes(key)) {
      throw new BoardApplyError(
        "bad_request",
        `Prop "${key}" points at something and cannot be changed: place a new shape instead.`
      );
    }
    if (value === undefined) continue;
    set(key, value);
  }
  if (u.w !== undefined) set("w", u.w);
  if (u.h !== undefined) set("h", u.h);
  const next = {
    ...current,
    ...(u.x !== undefined ? { x: u.x } : {}),
    ...(u.y !== undefined ? { y: u.y } : {}),
    props: nextProps,
  } as unknown as BoardRecord;
  if (JSON.stringify(next).length > BOARD_RECORD_MAX_CHARS) {
    throw new BoardApplyError(
      "bad_request",
      `Shape ${u.shapeId} would grow past ${BOARD_RECORD_MAX_CHARS} characters.`
    );
  }
  return next;
}

/**
 * Decide what the write does to `current` (the board's records, id → record).
 * Throws `BoardApplyError` (nothing is written) when a patch or removal names
 * a shape the board does not hold, or a patch the shape cannot take.
 */
export function planBoardApply(
  current: Record<string, unknown>,
  ops: BoardApplyOps
): BoardApplyPlan {
  const put: BoardRecord[] = [];
  const created: string[] = [];
  const skipped: string[] = [];

  const missing: string[] = [];
  for (const u of ops.patch ?? []) {
    const rec = current[u.shapeId];
    if (!isRec(rec) || rec.typeName !== "shape") {
      missing.push(u.shapeId);
      continue;
    }
    put.push(patchRecord(rec, u));
  }
  const removal = ops.remove?.length
    ? shapeRemovalIds(current, ops.remove)
    : { ids: [], missing: [] as string[] };
  missing.push(...removal.missing);
  if (missing.length > 0) {
    throw new BoardApplyError(
      "shape_not_found",
      `The board holds no shape ${[...new Set(missing)].join(", ")} (read the board for its shape ids). Nothing was changed.`
    );
  }

  // A shape that is removed is not also patched.
  const removed = new Set(removal.ids);
  const patched = put.filter((r) => !removed.has(r.id));

  const createdRecords: BoardRecord[] = [];
  for (const record of ops.create ?? []) {
    if (replaceable(current[record.id], record)) {
      createdRecords.push(record);
      created.push(record.id);
    } else {
      skipped.push(record.id);
    }
  }
  // A skipped shape's children are skipped with it (they share its fate).
  const skippedSet = new Set(skipped);
  const writtenCreates = createdRecords.filter(
    (r) => !(typeof r.parentId === "string" && skippedSet.has(r.parentId))
  );
  for (const r of createdRecords) {
    if (!writtenCreates.includes(r)) {
      created.splice(created.indexOf(r.id), 1);
      skipped.push(r.id);
    }
  }

  return {
    put: [...patched, ...writtenCreates],
    delete: removal.ids,
    created,
    skipped,
  };
}

/** The meta key a created shape's pending mark lives under (re-exported for tests). */
export const PENDING_META_KEY = BOARD_PLACEMENT_META_KEYS.pending;
