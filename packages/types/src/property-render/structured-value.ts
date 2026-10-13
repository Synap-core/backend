/**
 * `describeValue` — the ONE reading of an arbitrary stored value as a shape a
 * surface can draw as components instead of raw JSON text.
 *
 * A proposal payload, a run output, an entity property: any of them can hold an
 * object, a list of objects, or JSON that was STORED AS A STRING. Every surface
 * that met one of those used to print `JSON.stringify(value)` (folded to "+N
 * more characters") or `String(value)` ("[object Object]"). This returns a
 * discriminated tree — records, record lists with a picked title, object refs,
 * ids, scalars — so the rendering is a switch over a known shape, and the same
 * reading serves the desktop and the phone.
 *
 * Pure: no React, no DOM. Labels go through `humanizeToken` (the vocabulary
 * door), never a local humanizer.
 *
 * HOME: here (`@synap-core/types/property-render`), moved down from app-bases
 * `@synap-core/headless/property-renderer/structured-value.ts` so pod-admin and
 * the app-bases surfaces read ONE copy. Follow-up: re-point that file's
 * importers here and delete it (see `./index.ts`).
 */

import { humanizeToken } from "../vocabulary/index.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v);

/** A reference to a real object (entity, proposal, …) a payload names. */
export interface ObjectRef {
  id: string;
  /** The object's kind, when the payload states one. Never guessed. */
  type: string | null;
  /** The object's human title, when the payload carries one. Never guessed. */
  title: string | null;
}

const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

/** A plain, non-array object (else null). */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Read `{ id, type|kind|entityType, title|name|label }` off a value. Requires a
 * UUID `id` PLUS at least one of type/title: a chip claims "this opens a real
 * object", so an arbitrary `{ id: "abc", name: "x" }` in some webhook payload
 * must NOT be dressed as one — it stays on the structured path.
 */
export function readObjectRef(value: unknown): ObjectRef | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const id =
    nonEmpty(rec.id) ?? nonEmpty(rec.entityId) ?? nonEmpty(rec.proposalId);
  if (!id || !isUuid(id)) return null;
  const type =
    nonEmpty(rec.type) ?? nonEmpty(rec.kind) ?? nonEmpty(rec.entityType);
  const title =
    nonEmpty(rec.title) ?? nonEmpty(rec.name) ?? nonEmpty(rec.label);
  if (!type && !title) return null;
  return { id, type, title };
}

/** An array whose every member is an object ref (else null — mixed stays structured). */
export function readObjectRefList(value: unknown): ObjectRef[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const refs: ObjectRef[] = [];
  for (const item of value) {
    const ref = readObjectRef(item);
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
}

/**
 * A string that holds a JSON object or array, parsed (else undefined). Only a
 * trimmed `{…}` / `[…]` is tried: a bare `"42"` or `"true"` is text, not data.
 */
export function parseJsonContainer(
  value: string
): unknown[] | Record<string, unknown> | undefined {
  const t = value.trim();
  const first = t[0];
  const last = t[t.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(t);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as unknown[] | Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Would {@link describeValue} draw this as STRUCTURE (records, lists of
 * objects, object refs, JSON-in-a-string) rather than one scalar/tag line?
 * The question a host asks before choosing between its scalar renderer and
 * the structured one.
 */
export function isStructuredValue(value: unknown): boolean {
  if (typeof value === "string") return parseJsonContainer(value) !== undefined;
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(
      (item) =>
        (item !== null && typeof item === "object") ||
        (typeof item === "string" && parseJsonContainer(item) !== undefined)
    );
  }
  return true;
}

// ─── The shape tree ───────────────────────────────────────────────────────────

/** One labelled field of a record. `key` is the stored key, verbatim. */
export interface ValueEntry {
  key: string;
  label: string;
  value: ValueShape;
}

/** One object of a record list, with the fields a reader scans first lifted out. */
export interface RecordListItem {
  /** The item's human name (name / label / title / statement / goal / key). */
  title: string | null;
  /** The stored key the title came from (dropped from `entries`). */
  titleKey: string | null;
  /** A second line of prose (description / goal / statement / label / summary / hint). */
  subtitle: string | null;
  subtitleKey: string | null;
  /** A short classifying value (status / stage / category / type / kind). */
  badge: { key: string; label: string; value: string } | null;
  /** Everything else, in stored order. */
  entries: ValueEntry[];
}

export type ValueShape =
  | { kind: "empty" }
  | { kind: "text"; text: string; long: boolean }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "date"; iso: string }
  | { kind: "id"; id: string }
  | { kind: "objectRef"; ref: ObjectRef }
  | { kind: "objectRefs"; refs: ObjectRef[] }
  | { kind: "list"; items: ValueShape[] }
  | { kind: "record"; entries: ValueEntry[] }
  | { kind: "recordList"; items: RecordListItem[] }
  /** Past the depth cap (or a value with no better reading): pretty JSON. */
  | { kind: "json"; text: string };

export type ValueShapeKind = ValueShape["kind"];

export interface DescribeValueOptions {
  /**
   * How many containers deep the tree nests before the rest renders as a JSON
   * block. The root container is depth 0. Default 3.
   */
  maxDepth?: number;
}

/** Text past this many characters (or with a line break) clamps with an expand. */
export const LONG_TEXT_CHARS = 160;

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Item fields that NAME the item, in priority order. */
export const TITLE_KEYS = [
  "name",
  "label",
  "title",
  "statement",
  "goal",
  "key",
] as const;
/** Item fields that DESCRIBE it in a sentence, in priority order. */
export const SUBTITLE_KEYS = [
  "description",
  "goal",
  "statement",
  "label",
  "summary",
  "hint",
] as const;
/** Item fields that CLASSIFY it in a word — rendered as a badge. */
export const BADGE_KEYS = [
  "status",
  "stage",
  "category",
  "type",
  "kind",
] as const;
/** Item fields that only ORDER the list — consumed by the sort, never shown. */
export const ORDER_KEYS = ["position", "order"] as const;

const BADGE_MAX_CHARS = 32;

function stringify(value: unknown, pretty: boolean): string {
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Drop null/undefined, keep stored order. */
function presentEntries(rec: Record<string, unknown>): [string, unknown][] {
  return Object.entries(rec).filter(([, v]) => v !== undefined && v !== null);
}

function toEntries(
  pairs: [string, unknown][],
  depth: number,
  maxDepth: number
): ValueEntry[] {
  return pairs.map(([key, v]) => ({
    key,
    label: humanizeToken(key),
    value: describeAt(v, depth, maxDepth),
  }));
}

/** The first `keys` member holding a non-empty string, skipping `taken`. */
function pickString(
  rec: Record<string, unknown>,
  keys: readonly string[],
  taken: ReadonlySet<string>
): string | null {
  for (const k of keys) {
    if (taken.has(k)) continue;
    if (nonEmpty(rec[k])) return k;
  }
  return null;
}

/** The ordering key every item carries as a finite number (else null). */
function orderKeyOf(items: Record<string, unknown>[]): string | null {
  for (const k of ORDER_KEYS) {
    if (
      items.every((it) => typeof it[k] === "number" && Number.isFinite(it[k]))
    ) {
      return k;
    }
  }
  return null;
}

function describeRecordList(
  records: Record<string, unknown>[],
  depth: number,
  maxDepth: number
): ValueShape {
  const orderKey = orderKeyOf(records);
  const ordered = orderKey
    ? records
        .map((rec, i) => ({ rec, i }))
        .sort(
          (a, b) =>
            (a.rec[orderKey] as number) - (b.rec[orderKey] as number) ||
            a.i - b.i
        )
        .map(({ rec }) => rec)
    : records;

  const items = ordered.map((rec): RecordListItem => {
    const taken = new Set<string>(orderKey ? [orderKey] : []);
    const titleKey = pickString(rec, TITLE_KEYS, taken);
    if (titleKey) taken.add(titleKey);
    const subtitleKey = pickString(rec, SUBTITLE_KEYS, taken);
    if (subtitleKey) taken.add(subtitleKey);
    let badge: RecordListItem["badge"] = null;
    for (const k of BADGE_KEYS) {
      if (taken.has(k)) continue;
      const v = rec[k];
      if (typeof v === "string" && v.trim() && v.length <= BADGE_MAX_CHARS) {
        badge = { key: k, label: humanizeToken(k), value: v };
        taken.add(k);
        break;
      }
    }
    return {
      title: titleKey ? (rec[titleKey] as string) : null,
      titleKey,
      subtitle: subtitleKey ? (rec[subtitleKey] as string) : null,
      subtitleKey,
      badge,
      entries: toEntries(
        presentEntries(rec).filter(([k]) => !taken.has(k)),
        depth + 1,
        maxDepth
      ),
    };
  });
  return { kind: "recordList", items };
}

function describeAt(
  value: unknown,
  depth: number,
  maxDepth: number
): ValueShape {
  if (value === null || value === undefined) return { kind: "empty" };

  if (typeof value === "string") {
    const parsed = parseJsonContainer(value);
    if (parsed !== undefined) return describeAt(parsed, depth, maxDepth);
    if (!value.trim()) return { kind: "empty" };
    if (UUID_RE.test(value)) return { kind: "id", id: value };
    if (ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))) {
      return { kind: "date", iso: value };
    }
    return {
      kind: "text",
      text: value,
      long: value.length > LONG_TEXT_CHARS || value.includes("\n"),
    };
  }
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (value instanceof Date) return { kind: "date", iso: value.toISOString() };
  if (typeof value !== "object")
    return { kind: "text", text: String(value), long: false };

  const refs = readObjectRefList(value);
  if (refs) return { kind: "objectRefs", refs };
  const ref = readObjectRef(value);
  if (ref) return { kind: "objectRef", ref };

  if (Array.isArray(value)) {
    const present = value.filter((v) => v !== null && v !== undefined);
    if (present.length === 0) return { kind: "empty" };
    if (depth >= maxDepth)
      return { kind: "json", text: stringify(value, true) };
    // JSON-in-a-string items are unpacked before deciding the list's shape.
    const unpacked = present.map((v) =>
      typeof v === "string" ? (parseJsonContainer(v) ?? v) : v
    );
    const records = unpacked.map(asRecord);
    if (records.every((r): r is Record<string, unknown> => r !== null)) {
      return describeRecordList(records, depth, maxDepth);
    }
    return {
      kind: "list",
      items: unpacked.map((v) => describeAt(v, depth + 1, maxDepth)),
    };
  }

  const rec = value as Record<string, unknown>;
  const pairs = presentEntries(rec);
  if (pairs.length === 0) return { kind: "empty" };
  if (depth >= maxDepth) return { kind: "json", text: stringify(value, true) };
  return { kind: "record", entries: toEntries(pairs, depth + 1, maxDepth) };
}

/** Read any stored value as a shape tree. See the module doc. */
export function describeValue(
  value: unknown,
  options: DescribeValueOptions = {}
): ValueShape {
  return describeAt(value, 0, options.maxDepth ?? 3);
}

/**
 * A record's fields as labelled entries — ALWAYS rows, even when the record
 * itself would read as an object ref. For a host that owns the top-level row
 * list (a run step's detail, a payload section) and must never see its whole
 * subject collapse into one chip. Entries nest from depth 1.
 */
export function describeRecordEntries(
  record: Record<string, unknown>,
  options: DescribeValueOptions = {}
): ValueEntry[] {
  return toEntries(presentEntries(record), 1, options.maxDepth ?? 3);
}

/**
 * ONE line for a shape — for a dense host (a table cell, a kanban card) that
 * cannot draw a block. Names what is there (item titles, field labels, object
 * titles) rather than a count where it can; a count only when nothing names it.
 */
export function summarizeShape(shape: ValueShape): string {
  switch (shape.kind) {
    case "empty":
      return "";
    case "text":
      return shape.text;
    case "number":
      return String(shape.value);
    case "boolean":
      return shape.value ? "Yes" : "No";
    case "date":
      return shape.iso;
    case "id":
      return shape.id.slice(0, 8);
    case "objectRef":
      return shape.ref.title ?? shape.ref.id.slice(0, 8);
    case "objectRefs":
      return shape.refs.map((r) => r.title ?? r.id.slice(0, 8)).join(", ");
    case "list":
      return shape.items.map(summarizeShape).filter(Boolean).join(", ");
    case "record":
      return shape.entries.map((e) => e.label).join(", ");
    case "recordList": {
      const titles = shape.items
        .map((i) => i.title)
        .filter((t): t is string => !!t);
      const n = shape.items.length;
      return titles.length === n
        ? titles.join(", ")
        : `${n} ${n === 1 ? "item" : "items"}`;
    }
    case "json":
      return shape.text.replace(/\s+/g, " ");
  }
}
