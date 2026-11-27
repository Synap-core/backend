/**
 * DECLARED reads (and writes) of one surface: what a cell type or an HTML
 * page says it will ask its host for. The global tables stay the CEILING
 * (`CELL_BRIDGE_READ_OPS`, `CELL_BRIDGE_WRITE_OPS`): a declaration is a
 * subset of them, never a widening.
 *
 * Stored on the surface (`widget_definitions.reads` / `.writes` for a cell
 * type, `documents.metadata.reads` for an HTML page) and checked by the
 * SERVER on its one frame read door (`surfaces.frameRead`, Hub
 * `POST /frame/read`): a read outside the declaration is refused there
 * (`FRAME_READ_UNDECLARED`), whatever the host did.
 *
 *   - `null` / absent: the surface declares nothing. The door answers every
 *     ceiling op (backward compatible while hosts and authors migrate) and
 *     logs the call `declared: false`.
 *   - `[]`: it declares that it reads nothing. Every read is refused.
 *   - An entry `{ op, params? }`: the op is allowed. Each NAMED param must
 *     hold exactly that value (`"*"` = any value, or none); a param the entry
 *     does not name is free within the ceiling (`limit`, `offset` ...).
 *
 * Pure and dependency-free, like the rest of this leaf.
 */

import {
  CELL_BRIDGE_READ_OPS,
  isCellBridgeReadOp,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "./read-ops.js";
import { isCellBridgeWriteOp, type CellBridgeWriteOp } from "./write-ops.js";

/** A declared param value meaning "any value of this param". */
export const CELL_BRIDGE_ANY_VALUE = "*" as const;

/** One declared read: an op of the ceiling, optionally pinned params. */
export interface CellBridgeDeclaredRead {
  op: CellBridgeReadOp;
  /** Param name (of the op's own list) → exact value, or `"*"`. */
  params?: Partial<Record<string, string | typeof CELL_BRIDGE_ANY_VALUE>>;
}

export type CellBridgeDeclaredReads = CellBridgeDeclaredRead[];

/** One declared write: an op of the write ceiling. */
export interface CellBridgeDeclaredWrite {
  op: CellBridgeWriteOp;
}

export type CellBridgeDeclaredWrites = CellBridgeDeclaredWrite[];

/** The most entries one declaration may hold. */
export const CELL_BRIDGE_DECLARED_MAX = 50;

/** Machine code of a read the server refuses because it was not declared. */
export const FRAME_READ_UNDECLARED = "FRAME_READ_UNDECLARED" as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A caller's declared reads, checked against the ceiling: every op in
 * `CELL_BRIDGE_READ_OPS`, every param in that op's list, every value a
 * non-empty string of at most 200 characters (or `"*"`). The first problem
 * is the error; nothing is dropped silently.
 */
export function parseDeclaredReads(
  raw: unknown
): Parsed<CellBridgeDeclaredReads> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "`reads` must be a list of { op, params? }." };
  }
  if (raw.length > CELL_BRIDGE_DECLARED_MAX) {
    return {
      ok: false,
      error: `\`reads\` holds at most ${CELL_BRIDGE_DECLARED_MAX} entries.`,
    };
  }
  const out: CellBridgeDeclaredReads = [];
  for (const [i, entry] of raw.entries()) {
    if (!isPlainObject(entry)) {
      return { ok: false, error: `reads[${i}] must be { op, params? }.` };
    }
    const op = entry.op;
    if (!isCellBridgeReadOp(op)) {
      return {
        ok: false,
        error: `reads[${i}].op ${JSON.stringify(op)} is not a frame read (one of ${Object.keys(CELL_BRIDGE_READ_OPS).join(", ")}).`,
      };
    }
    if (entry.params === undefined) {
      out.push({ op });
      continue;
    }
    if (!isPlainObject(entry.params)) {
      return {
        ok: false,
        error: `reads[${i}].params must be an object of param → value.`,
      };
    }
    const allowed = CELL_BRIDGE_READ_OPS[op] as readonly string[];
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(entry.params)) {
      if (!allowed.includes(name)) {
        return {
          ok: false,
          error: `reads[${i}].params.${name} is not a param of "${op}" (${allowed.join(", ") || "it takes none"}).`,
        };
      }
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 200
      ) {
        return {
          ok: false,
          error: `reads[${i}].params.${name} must be a value (a string of 1 to 200 characters) or "*".`,
        };
      }
      params[name] = value;
    }
    out.push({ op, params });
  }
  return { ok: true, value: out };
}

/** A caller's declared writes, checked against the write ceiling. */
export function parseDeclaredWrites(
  raw: unknown
): Parsed<CellBridgeDeclaredWrites> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "`writes` must be a list of { op }." };
  }
  if (raw.length > CELL_BRIDGE_DECLARED_MAX) {
    return {
      ok: false,
      error: `\`writes\` holds at most ${CELL_BRIDGE_DECLARED_MAX} entries.`,
    };
  }
  const out: CellBridgeDeclaredWrites = [];
  for (const [i, entry] of raw.entries()) {
    if (!isPlainObject(entry) || !isCellBridgeWriteOp(entry.op)) {
      return {
        ok: false,
        error: `writes[${i}].op must be a frame write (create_entity, update_entity, delete_entity or create_relation).`,
      };
    }
    out.push({ op: entry.op });
  }
  return { ok: true, value: out };
}

/**
 * The declaration a surface STORES, as the door reads it: `null` when it
 * declares nothing (absent or null), else the parsed list. A stored value
 * that does not parse declares nothing ALLOWED: `[]` (every read refused),
 * never "undeclared".
 */
export function storedDeclaredReads(
  stored: unknown
): CellBridgeDeclaredReads | null {
  if (stored === null || stored === undefined) return null;
  const parsed = parseDeclaredReads(stored);
  return parsed.ok ? parsed.value : [];
}

/**
 * Is this read (its op and the params the host forwards, already narrowed by
 * `pickBridgeParams`) inside the declaration? An entry matches when its op is
 * the op and every param it names holds its value (`"*"`: anything, or
 * absent). Values compare as strings (`limit: 10` matches `"10"`).
 */
export function isReadDeclared(
  declared: readonly CellBridgeDeclaredRead[],
  op: CellBridgeReadOp,
  params: Readonly<Record<string, CellBridgeParamValue>>
): boolean {
  return declared.some((entry) => {
    if (entry.op !== op) return false;
    for (const [name, want] of Object.entries(entry.params ?? {})) {
      if (want === undefined || want === CELL_BRIDGE_ANY_VALUE) continue;
      const got = Object.prototype.hasOwnProperty.call(params, name)
        ? params[name]
        : undefined;
      if (got === undefined || String(got) !== want) return false;
    }
    return true;
  });
}

/**
 * The reads a PUBLISHED page may carry onto the public web (surfaces review
 * D2 / M2, 27 Nov 2026): at publish, each declared read runs once and its
 * answer is frozen into the public page, so only reads of records a person
 * would show a stranger are publishable: entities, documents, views and
 * kinds. Work status (`sessions.*`, `attention.*`, `lifecycle.*`,
 * `lens.page`, `flow.of`), playbooks, projects and the graph never are.
 * The ONE allowlist: the publish door refuses the rest, and the review card
 * names what will be frozen public through it.
 */
export const CELL_BRIDGE_PUBLISHABLE_READ_OPS: ReadonlySet<CellBridgeReadOp> =
  new Set<CellBridgeReadOp>([
    "entities.list",
    "entities.get",
    "documents.get",
    "views.list",
    "views.get",
    "views.execute",
    "profiles.list",
    "profiles.get",
  ]);

/**
 * Why a declared read may NOT be published, or null when it may. Outside the
 * allowlist: refused. `entities.list` must name its kind (`profileSlug`,
 * pinned to one value) and may hold no `"*"` param: a list of every record
 * the publisher sees is never frozen public.
 */
export function publishedReadRefusal(
  entry: CellBridgeDeclaredRead
): string | null {
  if (!CELL_BRIDGE_PUBLISHABLE_READ_OPS.has(entry.op)) {
    return `"${entry.op}" is not a read a published page may carry: only entity, document, view and kind reads are published.`;
  }
  if (entry.op === "entities.list") {
    const params = entry.params ?? {};
    const kind = params.profileSlug;
    if (!kind || kind === CELL_BRIDGE_ANY_VALUE) {
      return 'A published page lists records of ONE kind: declare "entities.list" with a profileSlug value, not "*".';
    }
    if (Object.values(params).some((v) => v === CELL_BRIDGE_ANY_VALUE)) {
      return 'A published "entities.list" holds no "*" param: pin each param it names.';
    }
  }
  return null;
}

/** One declared read as words: `entities.list (profileSlug: deal)`. */
export function describeDeclaredRead(entry: CellBridgeDeclaredRead): string {
  const params = Object.entries(entry.params ?? {}).filter(
    ([, v]) => v !== undefined
  );
  return params.length === 0
    ? entry.op
    : `${entry.op} (${params.map(([k, v]) => `${k}: ${v}`).join(", ")})`;
}
