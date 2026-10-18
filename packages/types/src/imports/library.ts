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
  ImportItemMetadata,
  ImportItemView,
  ImportStageItemInput,
} from "./curate.js";
import type { EntityMediaCopy } from "../presentation/index.js";
import {
  isTransientUrlReadFailure,
  isUrlReadFailureClass,
  readReaderStamp,
  URL_READ_BLOCK_REASONS,
  URL_READ_NEXT_STEPS,
  type ReaderStamp,
  type UrlReadBlockReason,
  type UrlReadFailureClass,
  type UrlReadNextStep,
  type UrlReaderOffer,
} from "../url-read/index.js";

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
  /** The chip's words (`libraryActionLabel`: "Add to calendar", "Add expense", "Add person", "Add task"). Chips stored before 2026-10-13 may carry older words; render `libraryActionLabel(kind)`. */
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
  /** Who produced this read (the reader door stamps it; a reader never self-stamps). */
  reader?: ReaderStamp;
  /**
   * Why the reader could not read the link (a blocked read): kept on
   * `needs_file` (no reader yet) and `unreadable` (login wall, paywall,
   * challenge…) so a client can say WHY and offer the next step.
   */
  blocked?: LibraryReadBlocked;
  /**
   * The read text carries a transcript (labelled in the text): `platform` =
   * the site's own captions; `stt` = speech-to-text of the stored video (AI).
   */
  transcript?: { source: "platform" | "stt"; lang?: string };
  /**
   * Why the last try did not read, as a class — set while a read waits to be
   * tried again (`not_read`), on an `unreadable` item, and on a `needs_file`
   * item a billed reader gave up on. Absent = the last try did not fail.
   */
  failure?: LibraryReadFailure;
  /**
   * The person's "Read with X" waits on this item (its read was over today's
   * budget, or failed and waits for its retry): the reader they chose and when
   * that consent ENDS. Also on a `read` item: a re-read (or "Get the
   * pictures") waiting BESIDE its read — the status stays `read`. Projected by
   * the pod's item views (`library.list` / `group` / `search`), never by
   * {@link readLibraryItemRead} (the end depends on the pod's setting). After
   * `expiresAt` the pod never runs it: the item goes back to waiting for a
   * reader (a read item keeps its read) and the choice is forgotten.
   * `library.cancelReadWith` ends it at once. Absent = no remembered choice
   * (or it already ended).
   */
  consent?: LibraryReadConsent;
}

/** A remembered "Read with X" that waits to run (see {@link LibraryItemRead.consent}). */
export interface LibraryReadConsent {
  /** The reader id the person chose (`library.readers` offer id). */
  readerId: string;
  /** When the person tapped (ISO). */
  givenAt: string;
  /** When the consent ends (ISO): `givenAt` + the pod's consent days. */
  expiresAt: string;
  /**
   * The person also chose "with video" (`ReaderOption` `withVideo`) on that
   * tap: the waiting read downloads the video too. Absent = without.
   */
  withVideo?: true;
}

/**
 * Days a "Read with X" consent for an item waiting on the budget (or a retry)
 * lasts by default (pod env `SYNAP_LIBRARY_READ_CONSENT_DAYS`).
 */
export const LIBRARY_READ_CONSENT_DAYS_DEFAULT = 7;

/** A failed read's class, as kept on the item. */
export interface LibraryReadFailure {
  class: UrlReadFailureClass;
  /**
   * The failure was temporary (`isTransientUrlReadFailure`: the site, the
   * vendor or the pod's AI was down, busy or rate limiting) — a later try may
   * read it, so never say "could not be read" for it.
   */
  transient: boolean;
  /**
   * When the pod tries again BY ITSELF (ISO). Absent = it will not: the
   * person's "Read again" / "Read with X" is the way on.
   */
  nextAttemptAt?: string;
}

/** A blocked read's reason, as kept on the item. */
export interface LibraryReadBlocked {
  reason: UrlReadBlockReason;
  nextStep?: UrlReadNextStep;
  detail?: string;
}

/**
 * Why one media file was NOT copied (`metadata.importMediaFailures[].reason`):
 *   blocked          — not a public address (SSRF refusal)
 *   expired          — the link no longer serves the file (HTTP 403 / 404 /
 *                      410): signed CDN links die within days
 *   http_4xx         — any other refusal of the request
 *   http_retry_later — the server said later (408 / 429)
 *   http_5xx         — the server failed
 *   too_large        — over the size cap (or a decoder-bomb image)
 *   not_image / not_video — the bytes are not an allowed image / video
 *   empty            — no bytes
 *   timeout / fetch_failed — the download did not finish
 *   store_failed     — the bytes were fine; storing them failed
 *   store_unavailable — the pod has no storage configured
 */
export const LIBRARY_MEDIA_FAILURE_REASONS = [
  "blocked",
  "expired",
  "http_4xx",
  "http_retry_later",
  "http_5xx",
  "too_large",
  "not_image",
  "not_video",
  "empty",
  "timeout",
  "fetch_failed",
  "store_failed",
  "store_unavailable",
] as const;
export type LibraryMediaFailureReason =
  (typeof LIBRARY_MEDIA_FAILURE_REASONS)[number];

/**
 * Reasons trying again cannot change: the pod never re-fetches them on its
 * own, and a client offers no "Try again" when EVERY failed copy has one
 * (lead with "Read again with X" or the plain tile instead).
 */
export const PERMANENT_LIBRARY_MEDIA_FAILURES = [
  "blocked",
  "expired",
  "http_4xx",
  "too_large",
  "not_image",
  "not_video",
  "empty",
] as const satisfies readonly LibraryMediaFailureReason[];

/** Reasons a later copy may fix (the pod retries them a few times by itself). */
export const RETRYABLE_LIBRARY_MEDIA_FAILURES = [
  "http_retry_later",
  "http_5xx",
  "timeout",
  "fetch_failed",
  "store_failed",
  "store_unavailable",
] as const satisfies readonly LibraryMediaFailureReason[];

// Coverage floor: every reason is classified permanent OR retryable — a new
// reason that is neither stops the build.
type _MediaFailureClassified =
  Exclude<
    LibraryMediaFailureReason,
    | (typeof PERMANENT_LIBRARY_MEDIA_FAILURES)[number]
    | (typeof RETRYABLE_LIBRARY_MEDIA_FAILURES)[number]
  > extends never
    ? true
    : never;
const _mediaFailureClassified: _MediaFailureClassified = true;
void _mediaFailureClassified;

/** Can "Try again" never fix a copy that failed for `reason`? */
export function isPermanentLibraryMediaFailure(reason: unknown): boolean {
  return (
    typeof reason === "string" &&
    (PERMANENT_LIBRARY_MEDIA_FAILURES as readonly string[]).includes(reason)
  );
}

/**
 * One media file of an item the pod copied into itself (images, video), in
 * reading order. Stored on `documents.metadata.importMedia` (an array, written
 * by the media copy only); failed copies are counted on
 * `documents.metadata.importMediaFailed`. Read back with {@link readLibraryItemMedia}.
 */
export type LibraryItemMedia = EntityMediaCopy & {
  kind: "image" | "video";
  role?: "cover" | "slide";
  order: number;
};

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
  /** Media copied into the pod for this item, in order (absent when none). */
  media?: LibraryItemMedia[];
  /** Media files whose copy failed (absent when none) — shown, never silent. */
  mediaFailed?: number;
  /**
   * Why they failed, each reason once (absent when none failed). When every
   * reason `isPermanentLibraryMediaFailure` (an expired CDN link…), "Try
   * again" cannot succeed: do not offer it.
   */
  mediaFailedReasons?: LibraryMediaFailureReason[];
  /**
   * When the newest failed copy was last tried (absent when none failed). A
   * `library.retryMedia` landed when this moved: tried again, kept or not.
   */
  mediaFailedAt?: string;
  /**
   * A reader OTHER than the one that produced the read can serve this item's
   * link (installed: ready / enable / connect, or one to install from the
   * catalog) — the row's "Needs a reader" without asking `library.readers`
   * per row. Set only on a weak read (needs_file / title_only / unreadable)
   * by the person's doors (`library.list` / `group` / `search`); absent =
   * not a weak read, or not known (the lookup failed — never guessed false).
   */
  readerAvailable?: boolean;
  /**
   * The item's picture was never kept because its signed CDN link (old
   * Instagram / TikTok posts) had already EXPIRED: the pod skipped it quietly
   * — no failure, no error mark; draw the platform tile. Re-reading the post
   * with a reader brings fresh pictures (`library.readWith` with
   * `missingMedia: true`, or this item's id). Absent = not skipped.
   */
  mediaExpired?: true;
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
  /**
   * The group's newest bundle while it still waits for review: a rebuild is
   * refused until it is decided (`previous_build_pending`). "Open the review".
   */
  pendingBuildProposalId?: string;
  counts: {
    items: number;
    read: number;
    notRead: number;
    needsFile: number;
    /** Kept items staged after `builtAt` (all items when never built). */
    newSinceBuilt: number;
    /** Suggested chips not run yet, over the group's unarchived items. */
    actions: number;
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
      /**
       * The space Build files this group into (`library_groups.workspace_id`);
       * `null` clears it (Build then uses the import run's space). The person
       * must be able to write that space.
       */
      workspaceId?: string | null;
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
  | { op: "item.archive" | "item.unarchive"; itemIds: string[] }
  /**
   * Remove kept items. A soft delete the person can undo for
   * `LIBRARY_LIMITS.deleteUndoDays` (`item.restore`); after that the pod
   * purges the stored read text, the saved page HTML and the search row.
   * Refused for an item a pending or applied bundle was built from.
   */
  | { op: "item.delete" | "item.restore"; itemIds: string[] }
  /** The person opened / looked at the items: the auto-archive clock restarts. */
  | { op: "item.seen"; itemIds: string[] }
  | { op: "group.unarchive"; groupId: string };

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
  "item.delete",
  "item.restore",
  "item.seen",
  "group.unarchive",
] as const satisfies ReadonlyArray<LibraryCurateOp["op"]>;

// ── Agent proposals: organise what is already kept ─────────────────────────

/**
 * What an AGENT may PROPOSE about the Library — its ORGANISATION, never its
 * content (founder rule, 2026-10-18: nothing an agent SENDS lands in the
 * Library; an agent may PROPOSE how to organise what is already there). Every
 * op is filed as a governed proposal (`library/organize`, always propose for
 * an agent) and applied on approval by the SAME code as the person's own
 * `library.curate` / `library.build`.
 *   - `group.create`  a new group, optionally with existing items and a note;
 *   - `group.items`   add / remove existing items of an existing group;
 *   - `group.update`  rename, set the note, or set the space Build files into
 *                     (`workspaceId`, `null` clears it);
 *   - `group.build`   ask for an existing group to be built (approval runs
 *                     Build, whose bundle is then reviewed as always).
 * Adding or uploading items is NOT here: an agent's content goes to
 * `synap_capture`.
 */
export type LibraryOrganizeOp =
  | { op: "group.create"; name: string; note?: string; itemIds?: string[] }
  | { op: "group.items"; groupId: string; add?: string[]; remove?: string[] }
  | {
      op: "group.update";
      groupId: string;
      name?: string;
      note?: string;
      workspaceId?: string | null;
    }
  | { op: "group.build"; groupId: string };

export const LIBRARY_ORGANIZE_OPS = [
  "group.create",
  "group.items",
  "group.update",
  "group.build",
] as const satisfies ReadonlyArray<LibraryOrganizeOp["op"]>;

/** Ops one organise proposal holds at most. */
export const LIBRARY_ORGANIZE_OPS_MAX = 50;

/**
 * The governed door an organise proposal is filed under:
 * `proposals.targetType = "library"`, `proposals.proposalType = "organize"`
 * (event key `library.organize`).
 */
export const LIBRARY_ORGANIZE_DOOR = {
  subjectType: "library",
  action: "organize",
} as const;

/** Input of `library.propose` (tRPC) / `POST /library/propose` (Hub REST) — agents only. */
export interface LibraryProposeRequest {
  ops: LibraryOrganizeOp[];
  /** Why — shown on the proposal card. */
  reasoning?: string;
}

/** Result of `library.propose`: always a proposal for an agent — nothing changed yet. */
export interface LibraryProposeResult {
  status: "proposed";
  proposalId: string;
  reviewUrl?: string;
}

/**
 * `proposals.data` of a `library/organize` proposal — what the card renders.
 * `ops` is what approval applies (re-validated then, owner-floored on the
 * proposal's subject); `groups` / `items` are the names and titles the
 * referenced EXISTING groups and items had when it was filed (display only).
 */
export interface LibraryOrganizeProposalData {
  ops: LibraryOrganizeOp[];
  groups: Array<{ id: string; name: string }>;
  items: Array<{ id: string; title: string }>;
  /** One line, e.g. `Create group "Recipes" with 4 items`. */
  summary: string;
}

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
  /**
   * A share split over several calls: link these items to the note an earlier
   * call made (`LibraryAddResult.captureNoteId`) instead of making a new one.
   */
  captureNoteId?: string;
}

export interface LibraryAddResult {
  runId: string;
  staged: Array<{ itemId: string; deduplicated: boolean }>;
  refused: Array<{ index: number; reason: string }>;
  captureNoteId?: string;
  readNowProposalId?: string;
  /** Read now was asked and did not file a bundle: why (the item is kept regardless). */
  readNowFailed?: string;
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

/**
 * One reader offer for an item, a group or the whole Library's waiting items
 * (`library.readers`). For many items, `count` = how many of the WAITING
 * items (needs a reader / title only / could not be read) this reader reads.
 */
export type LibraryReaderOffer = UrlReaderOffer & { count?: number };

/**
 * Input of `library.readers` — exactly ONE of:
 *   - `itemId`       one item's live offers (`current` on the one that read it);
 *   - `groupId`      a group's WAITING items, one offer per reader with `count`;
 *   - `waiting`      every waiting item of the person's Library, same shape;
 *   - `missingMedia` every item whose pictures were never kept because their
 *                    signed CDN link had expired (`LibraryItemView.mediaExpired`):
 *                    "Get pictures for N old <platform> posts with X".
 */
export interface LibraryReadersRequest {
  itemId?: string;
  groupId?: string;
  waiting?: true;
  missingMedia?: true;
}

/** Result of `library.readers` — live, never stored. */
export interface LibraryReadersResult {
  offers: LibraryReaderOffer[];
  /**
   * The items with a link that were looked at: a group's or the whole
   * Library's WAITING items (`groupId` / `waiting`), or the items missing
   * their pictures (`missingMedia`); at most 1 000, oldest first. Absent for
   * one item.
   */
  waiting?: number;
  /**
   * `missingMedia` only: those items by the platform of their link (a
   * `@synap-core/types/service-marks` id: `instagram`, `tiktok`), most first —
   * the "<platform>" of "Get pictures for N old <platform> posts". Items of
   * another site are counted in `waiting`, not here.
   */
  platforms?: Array<{ serviceId: string; count: number }>;
  /**
   * `groupId` / `waiting` only: the items of that scope (the group's, or the
   * whole Library's; archived excluded) that hold a LIVE "Read with X" consent
   * — waiting for tomorrow's budget or a retry, each showing `read.consent`.
   * What `library.cancelReadWith` with the same scope ends: "Cancel 37
   * waiting reads". 0 when none.
   */
  consented?: number;
}

/**
 * Input of `library.readWith`: exactly ONE scope — `itemIds`, a group's
 * waiting items (`groupId`), every waiting item (`waiting`), or every item
 * missing its expired pictures (`missingMedia`) — and one reader.
 */
export interface LibraryReadWithRequest {
  itemIds?: string[];
  groupId?: string;
  waiting?: true;
  /**
   * Re-read the items whose pictures expired, to KEEP their pictures: an item
   * that already has a read keeps its read text; only the media is added.
   * Billed, budgeted and leased like any "Read with X".
   */
  missingMedia?: true;
  readerId: string;
  /**
   * Also download the video file (`ReaderOption` `withVideo`). Sent only to a
   * reader whose offer lists it in `options`; ignored for any other reader.
   * Off by default — the vendor may bill more per item.
   */
  withVideo?: boolean;
}

/**
 * Input of `library.cancelReadWith` (person only): end the remembered
 * "Read with X" consent of exactly ONE scope — `itemIds`, a group's items
 * (`groupId`), or every item that holds one (`waiting: true`). The items go
 * back to waiting for a reader; nothing is read, nothing is billed.
 */
export interface LibraryCancelReadWithRequest {
  itemIds?: string[];
  groupId?: string;
  waiting?: true;
}

/** Result of `library.cancelReadWith`. */
export interface LibraryCancelReadWithResult {
  /** Items whose waiting consent was ended (0 = none held one). */
  cancelled: number;
}

/** Result of `library.retryMedia`: the failed copies queued to be tried again (0 = none failed). */
export interface LibraryRetryMediaResult {
  queued: number;
}

/** Result of `library.readWith`. */
export interface LibraryReadWithResult {
  /** Reads queued (one job per item). */
  queued: number;
  /**
   * Items not read now: this reader bills your account and today's read
   * budget is spent. They wait (`over_budget`, the reader remembered) and are
   * read with it once the budget has room; an item already read keeps its read.
   */
  overBudget: number;
  /** Items this reader cannot read now (no link, not a link it reads, not ready, gone). */
  skipped: number;
  /**
   * When `overBudget > 0`: when the consent the tap gave for those waiting
   * items ends (ISO) — "waits for tomorrow's reading budget, until <date>".
   */
  consentExpiresAt?: string;
}

export interface LibraryRunActionResult {
  proposalId: string;
  status: "proposed" | "applied";
}

/** Input of `library.groups`: an optional lens (counts and groups narrow to it). */
export interface LibraryGroupsRequest {
  workspaceId?: string;
  projectId?: string;
}

/** Result of `library.curate`: what changed, so a client can reconcile its optimistic state. */
export interface LibraryCurateResult {
  /** Ids of groups made by `group.create` ops, in op order. */
  createdGroupIds: string[];
  changedGroupIds: string[];
  changedItemIds: string[];
  /** The created and changed groups as they now read (archived ones included). */
  groups: LibraryGroupView[];
}

/** Result of `library.group`: one group and the first page of its items. */
export interface LibraryGroupResult {
  group: LibraryGroupView;
  items: LibraryItemView[];
  nextCursor?: string;
}

/** One of the person's captures (their own words) found by `library.search`. */
export interface LibraryCaptureHit {
  /** The capture's source document id (`captures.get`). */
  id: string;
  title: string;
  createdAt: string;
}

/** Result of `library.search`: ONE search over Capture (your words) and the Library. */
export interface LibrarySearchResult {
  captures: LibraryCaptureHit[];
  items: LibraryItemView[];
  /**
   * Whether the search over items' READ TEXT ran: `"down"` = the index could
   * not be asked, so items found only by their read text may be missing —
   * say so, never present the list as complete. Absent = not reported.
   */
  readTextSearch?: "ok" | "down";
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
  /** Days a deleted item can be restored before its stored text, page and search row are purged. */
  deleteUndoDays: 30,
} as const;

// ── Pure readers (shared by pod, browser and relay) ─────────────────────────

/**
 * `documents.metadata.importItem` — the staged item — or undefined when the
 * row is not a Library item (no bag, or a bag without a `source`). THE
 * reader of the bag: never cast `metadata.importItem` at a call site.
 */
export function libraryItemOf(
  metadata: unknown
): ImportItemMetadata | undefined {
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).importItem
      : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const source = (raw as { source?: unknown }).source;
  return source && typeof source === "object"
    ? (raw as ImportItemMetadata)
    : undefined;
}

/** The item's link (trimmed), or null for a typed note, a file, or no item. */
export function libraryItemUrl(metadata: unknown): string | null {
  const url = libraryItemOf(metadata)?.source.url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

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
  const reader = readReaderStamp(r.reader);
  const blocked = readBlocked(r.blocked);
  const transcript = readTranscript(r.transcript);
  const failure = readFailure(r.failure);
  return {
    status: r.status,
    summary: typeof r.summary === "string" ? r.summary : undefined,
    chars: typeof r.chars === "number" ? r.chars : undefined,
    readAt: typeof r.readAt === "string" ? r.readAt : undefined,
    suggestedActions: actions,
    ...(reader ? { reader } : {}),
    ...(blocked ? { blocked } : {}),
    ...(transcript ? { transcript } : {}),
    ...(failure ? { failure } : {}),
  };
}

function readFailure(raw: unknown): LibraryReadFailure | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const f = raw as Record<string, unknown>;
  if (!isUrlReadFailureClass(f.class)) return undefined;
  // `transient` is derived from the class, never trusted as stored.
  return {
    class: f.class,
    transient: isTransientUrlReadFailure(f.class),
    ...(typeof f.nextAttemptAt === "string" &&
    !Number.isNaN(Date.parse(f.nextAttemptAt))
      ? { nextAttemptAt: f.nextAttemptAt }
      : {}),
  };
}

function readBlocked(raw: unknown): LibraryReadBlocked | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  if (!(URL_READ_BLOCK_REASONS as readonly unknown[]).includes(b.reason)) {
    return undefined;
  }
  return {
    reason: b.reason as UrlReadBlockReason,
    ...((URL_READ_NEXT_STEPS as readonly unknown[]).includes(b.nextStep)
      ? { nextStep: b.nextStep as UrlReadNextStep }
      : {}),
    ...(typeof b.detail === "string" && b.detail
      ? { detail: b.detail.slice(0, 500) }
      : {}),
  };
}

function readTranscript(raw: unknown): LibraryItemRead["transcript"] {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (t.source !== "platform" && t.source !== "stt") return undefined;
  return {
    source: t.source,
    ...(typeof t.lang === "string" && t.lang ? { lang: t.lang } : {}),
  };
}

/**
 * Reads `documents.metadata.importMedia` / `importMediaFailed` (written by the
 * media copy). Malformed entries are dropped; the rest come back in `order`.
 */
export function readLibraryItemMedia(metadata: unknown): {
  media: LibraryItemMedia[];
  failed: number;
  /** The newest `lastAttemptAt` of the failed copies (`importMediaFailures`), when any. */
  failedAt?: string;
  /** Each known reason of the failed copies once, in vocabulary order (empty when none). */
  failedReasons: LibraryMediaFailureReason[];
} {
  const m =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : {};
  const raw = Array.isArray(m.importMedia) ? m.importMedia : [];
  const media = raw
    .filter(
      (x): x is LibraryItemMedia =>
        !!x &&
        typeof x === "object" &&
        typeof (x as LibraryItemMedia).documentId === "string" &&
        typeof (x as LibraryItemMedia).mime === "string" &&
        typeof (x as LibraryItemMedia).sourceUrl === "string" &&
        ((x as LibraryItemMedia).kind === "image" ||
          (x as LibraryItemMedia).kind === "video") &&
        typeof (x as LibraryItemMedia).order === "number"
    )
    .sort((a, b) => a.order - b.order);
  const failed =
    typeof m.importMediaFailed === "number" &&
    Number.isFinite(m.importMediaFailed) &&
    m.importMediaFailed > 0
      ? Math.floor(m.importMediaFailed)
      : 0;
  let failedAt: string | undefined;
  const reasons = new Set<string>();
  for (const f of Array.isArray(m.importMediaFailures)
    ? m.importMediaFailures
    : []) {
    if (!f || typeof f !== "object") continue;
    const at = (f as Record<string, unknown>).lastAttemptAt;
    if (typeof at === "string" && (!failedAt || at > failedAt)) failedAt = at;
    const reason = (f as Record<string, unknown>).reason;
    if (typeof reason === "string") reasons.add(reason);
  }
  const failedReasons = failed
    ? LIBRARY_MEDIA_FAILURE_REASONS.filter((r) => reasons.has(r))
    : [];
  return {
    media,
    failed,
    ...(failed && failedAt ? { failedAt } : {}),
    failedReasons,
  };
}

/** True when the item still waits for the light read. */
export function isLibraryUnread(
  read: Pick<LibraryItemRead, "status">
): boolean {
  return read.status === "not_read" || read.status === "over_budget";
}
