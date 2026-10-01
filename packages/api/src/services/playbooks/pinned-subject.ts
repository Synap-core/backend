/**
 * Pin list — the ordered whitelist a playbook consumes from the front.
 *
 * Ids live on `metadata.pinnedEntityIds` (the owner's bag; reconcile does not
 * own it). The strategy kind and the fallback filter live on `inputStrategy`,
 * which reconcile DOES own. This module is pure: the run spine and the update
 * door supply the rows they already loaded.
 */
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  PIN_LIST_CAP,
  PINNED_ENTITY_IDS_KEY,
} from "@synap-core/types/vocabulary";
import type { PinnedFallback } from "@synap/playbooks";

export { PIN_LIST_CAP, PINNED_ENTITY_IDS_KEY };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PinnedStrategy {
  kind: "pinned";
  fallback?: PinnedFallback;
}

export function isPinnedStrategy(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "pinned"
  );
}

/** Narrow a stored inputStrategy. Unknown shapes are not pinned. */
export function readPinnedStrategy(value: unknown): PinnedStrategy | null {
  if (!isPinnedStrategy(value)) return null;
  const raw = (value as { fallback?: unknown }).fallback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "pinned" };
  }
  const f = raw as Record<string, unknown>;
  const fallback: PinnedFallback = {};
  if (f.filter && typeof f.filter === "object" && !Array.isArray(f.filter)) {
    fallback.filter = f.filter as Record<string, unknown>;
  }
  if (typeof f.orderBy === "string" && f.orderBy.trim()) {
    fallback.orderBy = f.orderBy.trim();
  }
  if (f.orderDir === "asc" || f.orderDir === "desc") {
    fallback.orderDir = f.orderDir;
  }
  return Object.keys(fallback).length > 0
    ? { kind: "pinned", fallback }
    : { kind: "pinned" };
}

export function subjectProfileSlug(subjectProfile: unknown): string | null {
  if (!subjectProfile || typeof subjectProfile !== "object") return null;
  const slug = (subjectProfile as { profileSlug?: unknown }).profileSlug;
  return typeof slug === "string" && slug.trim() ? slug.trim() : null;
}

/**
 * Runtime read. Drops blanks, non-ids, and duplicates, and stops at the cap.
 * A write that got here was already strict; this only keeps a bad stored bag
 * from crashing a run.
 */
export function readPinnedIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>)[PINNED_ENTITY_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= PIN_LIST_CAP) break;
  }
  return out;
}

export type PinnedIdsParse =
  { ok: true; ids: string[] } | { ok: false; message: string };

/**
 * Write door. Rejects — does not repair — a non-list, a non-id, a duplicate,
 * or a list longer than the cap. Order is the order the person sent. An empty
 * list is a clear.
 */
export function parsePinnedEntityIds(raw: unknown): PinnedIdsParse {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "The pin list has to be a list of records." };
  }
  if (raw.length > PIN_LIST_CAP) {
    return {
      ok: false,
      message: `A pin list holds at most ${PIN_LIST_CAP} records.`,
    };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !UUID_RE.test(item)) {
      return { ok: false, message: "Each pin has to be a record id." };
    }
    if (seen.has(item)) {
      return { ok: false, message: "That record is already on the list." };
    }
    seen.add(item);
    ids.push(item);
  }
  return { ok: true, ids };
}

export interface VisibleEntityRow {
  id: string;
  type: string;
}

/**
 * First id in list order that the caller cannot pin, or null when every id
 * is visible and, when the playbook names a kind, of that kind.
 * `rows` are the visible matches only — an id missing from them is treated
 * as unavailable, so a hidden record is not described.
 */
export function explainPinnedIdRejection(
  ids: readonly string[],
  rows: readonly VisibleEntityRow[],
  profileSlug: string | null
): string | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return "That record is not available to pin.";
    if (profileSlug && row.type !== profileSlug) {
      return `This playbook runs on ${resolveObjectNoun(profileSlug)} records. That one is a ${resolveObjectNoun(row.type)}.`;
    }
  }
  return null;
}

/**
 * The first id the predicate accepts. Order is the list order — the front
 * of the whitelist runs next. Returning the last id is the wrong rule; the
 * order test exists to catch that swap.
 */
export function pickFirstEligible(
  ids: readonly string[],
  eligible: (id: string) => boolean
): string | null {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id !== undefined && eligible(id)) return id;
  }
  return null;
}

export type PinnedDecision =
  | { outcome: "caller"; subjectId: string }
  | { outcome: "pin"; subjectId: string }
  | { outcome: "fallback"; subjectId: string }
  | { outcome: "skip" };

/**
 * Who this run is about.
 *
 * A caller-supplied subject wins and the list is not consulted. Otherwise
 * the first eligible pin wins. Otherwise one fallback id, which the caller
 * computed and which is NOT written back onto the list. Otherwise nothing
 * runs.
 */
export function decidePinnedSubject(args: {
  callerSubjectId?: string | null;
  pinnedIds: readonly string[];
  eligibleIds: ReadonlySet<string>;
  fallbackId: string | null;
}): PinnedDecision {
  const caller =
    typeof args.callerSubjectId === "string" ? args.callerSubjectId.trim() : "";
  if (caller) return { outcome: "caller", subjectId: caller };
  const pin = pickFirstEligible(args.pinnedIds, (id) =>
    args.eligibleIds.has(id)
  );
  if (pin) return { outcome: "pin", subjectId: pin };
  if (args.fallbackId)
    return { outcome: "fallback", subjectId: args.fallbackId };
  return { outcome: "skip" };
}

interface ParamDecl {
  name: string;
  type: string;
  required?: boolean;
}

function readParamDecls(params: unknown): ParamDecl[] {
  if (!Array.isArray(params)) return [];
  const out: ParamDecl[] = [];
  for (const item of params) {
    if (!item || typeof item !== "object") continue;
    const o = item as { name?: unknown; type?: unknown; required?: unknown };
    if (typeof o.name !== "string" || typeof o.type !== "string") continue;
    out.push({ name: o.name, type: o.type, required: o.required === true });
  }
  return out;
}

function paramIsEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * When the run has a subject and exactly one required entity param is empty,
 * that param IS the subject. Two required entity params are not guessed.
 * Text params (platform, format) are left for the person. A value already
 * set is left alone.
 */
export function fillSoleRequiredEntityParam(
  params: Record<string, unknown>,
  declared: unknown,
  subjectId: string
): Record<string, unknown> {
  const requiredEntity = readParamDecls(declared).filter(
    (p) => p.type === "entity" && p.required === true
  );
  if (requiredEntity.length !== 1) return params;
  const name = requiredEntity[0]!.name;
  if (!paramIsEmpty(params[name])) return params;
  return { ...params, [name]: subjectId };
}

/**
 * Drop one id from the stored list. Returns null when the id is not there,
 * so the caller does not write. Other metadata keys are copied through.
 * The list is otherwise left as stored — this is not a rewrite.
 */
export function metadataAfterUnpin(
  metadata: unknown,
  subjectId: string
): Record<string, unknown> | null {
  const bag =
    metadata && typeof metadata === "object"
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  const raw = bag[PINNED_ENTITY_IDS_KEY];
  if (!Array.isArray(raw)) return null;
  let removed = false;
  const next = raw.filter((item) => {
    if (item === subjectId) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) return null;
  return { ...bag, [PINNED_ENTITY_IDS_KEY]: next };
}

/** A successful close drops the pin. Cancel and fail keep it. */
export function shouldDropPin(terminalStatus: string): boolean {
  return terminalStatus === "closed";
}
