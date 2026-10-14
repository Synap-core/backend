/**
 * ITEM PACK — one proposal that carries N independent items, each reviewed on
 * its own. Two packs use it today:
 *
 *   - `pod_hygiene/cleanup_pack` (items at the TOP LEVEL of `proposals.data`,
 *     shape in `../pod-hygiene/cleanup-pack.ts`);
 *   - `entity/update_pack` (filed through the gate, so its items sit inside
 *     the request-shaped envelope at `proposals.data.data`; shape below).
 *
 * Both share ONE review mechanic, decided here so the pod, desktop and relay
 * cannot fork it:
 *   - every item has a `ref`, unique in its pack;
 *   - a reviewer's per-item reject is `data.dispositions[ref]` (written by
 *     `proposals.rejectItem`, removed by `proposals.restoreItem`);
 *   - approval applies every item that is not rejected, independently (never
 *     all-or-none), and records `data.outcomes[ref]` as each one lands.
 *
 * Pure + dependency-free (same contract as `../vocabulary`).
 */

import type { ProposalItemDisposition } from "./index.js";

// ── The shared model ─────────────────────────────────────────────────────────

/** What applying one pack item did. */
export const ITEM_PACK_OUTCOMES = [
  "applied",
  "skipped_by_reviewer",
  "refused",
] as const;
export type ItemPackOutcome = (typeof ITEM_PACK_OUTCOMES)[number];

/** One item's outcome, stored on `data.outcomes[ref]` the moment it happens. */
export interface StoredItemOutcome {
  outcome: ItemPackOutcome;
  /** Why it was refused (a stale item, a door that said no). */
  reason?: string;
  /** ISO. */
  at: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The reviewer's per-item decisions, keyed by ref. Absent ⇒ `{}`. */
export function readItemDispositions(
  data: unknown
): Record<string, ProposalItemDisposition> {
  const dispositions = asRecord(asRecord(data)?.dispositions);
  return (dispositions ?? {}) as Record<string, ProposalItemDisposition>;
}

/** True when the reviewer rejected this item (`proposals.rejectItem`). */
export function isItemRejected(data: unknown, ref: string): boolean {
  return readItemDispositions(data)[ref]?.status === "reject";
}

/**
 * Outcomes already recorded, keyed by ref. A legacy array (cleanup pack v1)
 * reads as none: it is replaced by the keyed object on the next write.
 */
export function readItemOutcomes(
  data: unknown
): Record<string, StoredItemOutcome> {
  const outcomes = asRecord(asRecord(data)?.outcomes);
  const out: Record<string, StoredItemOutcome> = {};
  for (const [ref, raw] of Object.entries(outcomes ?? {})) {
    const o = asRecord(raw);
    if (
      o &&
      typeof o.outcome === "string" &&
      (ITEM_PACK_OUTCOMES as readonly string[]).includes(o.outcome) &&
      typeof o.at === "string"
    ) {
      out[ref] = {
        outcome: o.outcome as ItemPackOutcome,
        ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
        at: o.at,
      };
    }
  }
  return out;
}

/** Counts a review surface needs ("Apply 409 of 412", the receipt). */
export interface ItemPackTally {
  total: number;
  rejected: number;
  /** Not rejected — what Approve will try to apply. */
  toApply: number;
  applied: number;
  refused: number;
}

/** PURE: tally a pack's items against its dispositions and outcomes. */
export function tallyItemPack(
  data: unknown,
  refs: readonly string[]
): ItemPackTally {
  const dispositions = readItemDispositions(data);
  const outcomes = readItemOutcomes(data);
  let rejected = 0;
  let applied = 0;
  let refused = 0;
  for (const ref of refs) {
    if (dispositions[ref]?.status === "reject") rejected++;
    if (outcomes[ref]?.outcome === "applied") applied++;
    if (outcomes[ref]?.outcome === "refused") refused++;
  }
  return {
    total: refs.length,
    rejected,
    toApply: refs.length - rejected,
    applied,
    refused,
  };
}

/**
 * The refs a per-item door may write a disposition for: a cleanup pack's
 * top-level `items[].ref`, or an update pack's (inside the request-shaped
 * envelope). Empty when the proposal is neither — the door then leaves the ref
 * unchecked (a composite graph keys its own `$opN` refs).
 */
export function readItemPackRefs(data: unknown): string[] {
  const top = asRecord(data);
  // A workspace JOIN keeps the agent's blocked writes on `deferredWrites`
  // (each with a `ref`), so a per-item drop on a join is checked too.
  const items = Array.isArray(top?.items)
    ? top.items
    : isUpdatePackData(top?.data)
      ? (top.data as { items: unknown[] }).items
      : Array.isArray(top?.deferredWrites)
        ? top.deferredWrites
        : [];
  return items
    .map((item) => asRecord(item)?.ref)
    .filter((ref): ref is string => typeof ref === "string");
}

// ── The update pack (`entity/update_pack`) ───────────────────────────────────

export const UPDATE_PACK_SCHEMA = 1;
/** Items per batch call, and so per pack (the filing/move precedent). */
export const UPDATE_PACK_MAX_ITEMS = 500;

/**
 * The fields a batch update may change (founder D3). No kind change, no
 * document content, no placement: those keep their own reviewed doors.
 */
export interface EntityUpdatePatch {
  title?: string;
  description?: string;
  properties?: Record<string, unknown>;
  deleteProperties?: string[];
  /** The lifecycle status the caller saw — compare-and-set on a status move. */
  expectedStatus?: string | null;
}

export const ENTITY_UPDATE_PATCH_FIELDS = [
  "title",
  "description",
  "properties",
  "deleteProperties",
  "expectedStatus",
] as const satisfies ReadonlyArray<keyof EntityUpdatePatch>;
type _PatchFieldsClassified =
  Exclude<
    keyof EntityUpdatePatch,
    (typeof ENTITY_UPDATE_PATCH_FIELDS)[number]
  > extends never
    ? true
    : never;
const _patchFieldsClassified: _PatchFieldsClassified = true;
void _patchFieldsClassified;

/**
 * What the item's touched fields held when the pack was filed. Approval
 * refuses an item whose current values no longer match (someone edited it
 * meanwhile). A property that did not exist is `null`.
 */
export interface EntityUpdateBefore {
  title?: string | null;
  description?: string | null;
  properties?: Record<string, unknown>;
}

export interface UpdatePackItem {
  /** The entity id — unique per pack, and the `rejectItem` key. */
  ref: string;
  id: string;
  /** For the review surface: the record's kind and name at filing. */
  subject: { kind: string | null; name: string | null };
  patch: EntityUpdatePatch;
  before: EntityUpdateBefore;
}

/** The gate payload of an `entity/update_pack` proposal (`proposals.data.data`). */
export interface UpdatePackData {
  schema: typeof UPDATE_PACK_SCHEMA;
  /** The batch call that filed it; its auto-applied receipts carry it too. */
  batchId: string;
  items: UpdatePackItem[];
}

/** True for an update pack's gate payload. */
export function isUpdatePackData(data: unknown): data is UpdatePackData {
  const d = asRecord(data);
  return (
    d?.schema === UPDATE_PACK_SCHEMA &&
    typeof d.batchId === "string" &&
    Array.isArray(d.items)
  );
}

/**
 * Read an update pack from a stored proposal row's `data` (the request-shaped
 * envelope) or from the bare gate payload. Items that do not parse are counted
 * in `unreadable`, never dropped silently.
 */
export function readUpdatePackItems(stored: unknown): {
  batchId: string | null;
  items: UpdatePackItem[];
  unreadable: number;
} {
  const top = asRecord(stored);
  const pack = isUpdatePackData(top)
    ? top
    : isUpdatePackData(top?.data)
      ? (top.data as UpdatePackData)
      : null;
  if (!pack) return { batchId: null, items: [], unreadable: 0 };
  const items: UpdatePackItem[] = [];
  let unreadable = 0;
  for (const raw of pack.items as unknown[]) {
    const item = asRecord(raw);
    if (
      item &&
      typeof item.ref === "string" &&
      typeof item.id === "string" &&
      asRecord(item.patch) &&
      asRecord(item.before)
    ) {
      const subject = asRecord(item.subject);
      items.push({
        ref: item.ref,
        id: item.id,
        subject: {
          kind: typeof subject?.kind === "string" ? subject.kind : null,
          name: typeof subject?.name === "string" ? subject.name : null,
        },
        patch: item.patch as EntityUpdatePatch,
        before: item.before as EntityUpdateBefore,
      });
    } else {
      unreadable++;
    }
  }
  return { batchId: pack.batchId, items, unreadable };
}
