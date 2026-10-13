/**
 * The Library — THE contract for everything a person brings in.
 *
 * Capture is your words, read now. The Library is everything you KEEP:
 * shared, saved, dropped, forwarded. It is a LENS over every staged item
 * (`documents.metadata.importItem`), across import runs:
 *   - an item is read cheaply on save (the light read, `documents.metadata.importRead`);
 *   - it carries suggested action chips (date / receipt / contact / task);
 *   - it joins persistent GROUPS (the `library_groups` table), which keep their
 *     note, outputs and built state, and grow ("N new since built");
 *   - Build runs per group only when the person asks; a rebuild proposes
 *     updates to what it made before, never twins.
 *
 * Import runs (focus sessions with `importCuration`) stay the unit of undo.
 * A Library item is never a row of `captures.list` / `documents.list`.
 *
 * Pure and dependency-free: safe in the pod, the browser, relay and the CLI.
 */

import type {
  ImportGroupOutput,
  ImportItemDecision,
  ImportItemView,
  ImportStageItemInput,
} from "./curate.js";

// ── Read status and action chips ───────────────────────────────────────────

/**
 * What the light read did with one item.
 *   - `read`        text was read and summarised;
 *   - `not_read`    queued, or not attempted yet;
 *   - `over_budget` the pod's AI budget for light reads was spent: it will be
 *                   read later (never a silent drop);
 *   - `unreadable`  the read was attempted and failed;
 *   - `needs_file`  a platform the pod must not scrape (Instagram, TikTok):
 *                   read once the person attaches the file;
 *   - `title_only`  nothing beyond the title and card can be read.
 */
export const LIBRARY_READ_STATUSES = [
  "read",
  "not_read",
  "over_budget",
  "unreadable",
  "needs_file",
  "title_only",
] as const;
export type LibraryReadStatus = (typeof LIBRARY_READ_STATUSES)[number];

/** The chips a light read may suggest. AI proposes, never executes. */
export const LIBRARY_ACTION_KINDS = [
  "date",
  "receipt",
  "contact",
  "task",
] as const;
export type LibraryActionKind = (typeof LIBRARY_ACTION_KINDS)[number];

export interface LibraryAction {
  /** Stable within the item (`date-0`, `receipt-0`, …). */
  id: string;
  kind: LibraryActionKind;
  /** Short words for the chip ("Add 14 Nov to calendar"). */
  label: string;
  /** What the chip would file (date, amount + merchant, email, task title…). */
  value: Record<string, unknown>;
  /** 0..1. */
  confidence: number;
  /** `rule` = a deterministic detector; `ai` = the light read's AI pass. */
  source: "rule" | "ai";
  /** Set once the chip was run: the ONE governed proposal it filed. */
  proposalId?: string;
}

/** `documents.metadata.importRead` — written by the light read only. */
export interface LibraryItemRead {
  status: LibraryReadStatus;
  /** A short summary (a few sentences) when `status === "read"`. */
  summary?: string;
  /** Characters of body text read. */
  chars?: number;
  readAt?: string;
  suggestedActions: LibraryAction[];
}

// ── Items and groups as every client reads them ─────────────────────────────

export interface LibraryItemView extends ImportItemView {
  read: LibraryItemRead;
  /** Library groups (ids of `library_groups`) the item belongs to. */
  groupIds: string[];
  /** Groups the AI suggested and the person has not accepted or dismissed. */
  suggestedGroupIds: string[];
  /** The import run (focus session) that staged the item — the undo unit. */
  runId: string;
  /** Set when the item was archived (by hand or quietly after N days unseen). Still searchable. */
  archivedAt?: string;
  /** Set once a Build of one of its groups read it. */
  builtAt?: string;
  /** The capture holding the note typed at share time, linked to the item. */
  captureNoteId?: string;
}

export interface LibraryGroupView {
  id: string;
  /** Stable slug-like key (unique per person). */
  key: string;
  name: string;
  /** The person's instruction for the whole group; every item inherits it. */
  note?: string;
  /** Who made it: the AI, the person, or the deterministic fallback. */
  origin: "ai" | "user" | "rule";
  outputs: ImportGroupOutput[];
  /** The collection entity Build minted (or reused); rebuilds update it. */
  containerEntityId?: string;
  builtAt?: string;
  /** Set while a Build holds the group. */
  buildingAt?: string;
  counts: {
    items: number;
    read: number;
    notRead: number;
    needsFile: number;
    /** Kept items staged after `builtAt` (all items when never built). */
    newSinceBuilt: number;
  };
  workspaceId?: string;
  archivedAt?: string;
  updatedAt: string;
}

/** Library health for orient's `StartHere.library`. No inbox counters in UI. */
export interface LibraryHealth {
  /** Items not read yet (`not_read` + `over_budget`), archived excluded. */
  unread: number;
  /** Unarchived groups with items never built (or new since built). */
  groupsWaiting: number;
  /** Age in days of the oldest such waiting item, null when none waits. */
  oldestWaitDays: number | null;
}

// ── Curation ────────────────────────────────────────────────────────────────

/** One edit of `library.curate`. Applied in order, in one transaction. */
export type LibraryCurateOp =
  | { op: "group.create"; name: string; note?: string; itemIds?: string[] }
  | {
      op: "group.update";
      groupId: string;
      name?: string;
      note?: string;
      outputs?: ImportGroupOutput[];
    }
  | { op: "group.archive"; groupId: string }
  | { op: "group.merge"; fromId: string; intoId: string }
  | { op: "group.items"; groupId: string; add?: string[]; remove?: string[] }
  | { op: "item.decide"; itemIds: string[]; decision: ImportItemDecision }
  | { op: "item.note"; itemId: string; note: string }
  | { op: "item.groups"; itemId: string; add?: string[]; remove?: string[] }
  | {
      op: "suggestion.accept" | "suggestion.dismiss";
      itemId: string;
      groupId: string;
    }
  | { op: "item.archive" | "item.unarchive"; itemIds: string[] };

export const LIBRARY_CURATE_OPS = [
  "group.create",
  "group.update",
  "group.archive",
  "group.merge",
  "group.items",
  "item.decide",
  "item.note",
  "item.groups",
  "suggestion.accept",
  "suggestion.dismiss",
  "item.archive",
  "item.unarchive",
] as const satisfies ReadonlyArray<LibraryCurateOp["op"]>;

// ── Requests and results ────────────────────────────────────────────────────

export interface LibraryAddRequest {
  items: ImportStageItemInput[];
  /** A note typed at share time: filed as a Capture, linked to the item(s). */
  note?: string;
  /** Build the item(s) now (the explicit "Read now"). */
  readNow?: boolean;
  workspaceId?: string;
  projectId?: string;
  /** `relay`, `browser`, `extension`, `cli`, … — names the open run "Kept from <device>, <day>". */
  device?: string;
}

export interface LibraryAddResult {
  runId: string;
  staged: Array<{ itemId: string; deduplicated: boolean }>;
  refused: Array<{ index: number; reason: string }>;
  captureNoteId?: string;
  readNowProposalId?: string;
}

export interface LibraryListRequest {
  cursor?: string;
  limit?: number;
  groupId?: string | "ungrouped";
  status?: LibraryReadStatus;
  archived?: boolean;
  workspaceId?: string;
  projectId?: string;
  q?: string;
}

export interface LibraryListResult {
  items: LibraryItemView[];
  nextCursor?: string;
}

export interface LibraryGroupsResult {
  groups: LibraryGroupView[];
  /** Unarchived items in no group. */
  ungrouped: number;
  /** Archived items. */
  archived: number;
}

export interface LibraryRunActionResult {
  proposalId: string;
  status: "proposed" | "applied";
}

/** Hard limits shared by every Library door. */
export const LIBRARY_LIMITS = {
  /** Items accepted by one `library.add` call. */
  addBatchMax: 100,
  /** Page size of `library.list` (default / max). */
  pageDefault: 50,
  pageMax: 200,
  /** Ops accepted by one `library.curate` call. */
  curateOpsMax: 200,
  /** Note typed at share time, in characters (it becomes a Capture). */
  shareNoteMax: 2000,
  /** Days unseen before an item is quietly archived (pod default). */
  autoArchiveDays: 90,
} as const;

// ── Pure readers (shared by pod, browser and relay) ─────────────────────────

/** The read of an item that was never touched by the light read. */
export function libraryReadFallback(contentStatus?: string): LibraryItemRead {
  const status: LibraryReadStatus =
    contentStatus === "needs_file"
      ? "needs_file"
      : contentStatus === "title_only"
        ? "title_only"
        : "not_read";
  return { status, suggestedActions: [] };
}

function isActionKind(v: unknown): v is LibraryActionKind {
  return (
    typeof v === "string" &&
    (LIBRARY_ACTION_KINDS as readonly string[]).includes(v)
  );
}

/**
 * Reads `documents.metadata.importRead`. An item with no read (or a malformed
 * one) falls back from its content status: never `read`, never invented.
 */
export function readLibraryItemRead(
  metadata: unknown,
  contentStatus?: string
): LibraryItemRead {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).importRead
      : undefined;
  if (!raw || typeof raw !== "object")
    return libraryReadFallback(contentStatus);
  const r = raw as Partial<LibraryItemRead>;
  if (
    typeof r.status !== "string" ||
    !(LIBRARY_READ_STATUSES as readonly string[]).includes(r.status)
  ) {
    return libraryReadFallback(contentStatus);
  }
  const actions = Array.isArray(r.suggestedActions)
    ? r.suggestedActions.filter(
        (a): a is LibraryAction =>
          !!a &&
          typeof a === "object" &&
          typeof (a as LibraryAction).id === "string" &&
          isActionKind((a as LibraryAction).kind)
      )
    : [];
  return {
    status: r.status,
    summary: typeof r.summary === "string" ? r.summary : undefined,
    chars: typeof r.chars === "number" ? r.chars : undefined,
    readAt: typeof r.readAt === "string" ? r.readAt : undefined,
    suggestedActions: actions,
  };
}

/** True when the item still waits for the light read. */
export function isLibraryUnread(
  read: Pick<LibraryItemRead, "status">
): boolean {
  return read.status === "not_read" || read.status === "over_budget";
}
