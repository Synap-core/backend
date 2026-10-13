/**
 * Import → Curate → Build — THE contract for a metadata-first import.
 *
 * Capture reads one thing now and files it. An IMPORT is a batch the person did
 * not write: it is STAGED without reading content (titles, sources, preview
 * cards only), grouped by one cheap pass over titles, CURATED by the person
 * (a note per group, exceptions per item), then BUILT one group at a time —
 * the AI reads only the kept items, steered only by the person's notes, and
 * files ONE governed bundle (things, the group as a collection, Tools,
 * Templates, Rules, Lists).
 *
 * Storage (no new tables):
 *   - an import IS a focus session; its curation state lives on
 *     `focus_sessions.metadata.importCuration` ({@link ImportSessionCuration});
 *   - each staged item IS an intake-source document; its preview lives on
 *     `documents.metadata.importItem` ({@link ImportItemMetadata}) and the
 *     person's decision and note on `documents.metadata.importCuration`
 *     ({@link ImportItemCuration}).
 *
 * Pure and dependency-free: safe in the pod, the browser, relay (Hermes) and
 * the CLI via this subpath.
 */

/** Where an import stands. One phase per session, moved only by the pod. */
export const IMPORT_PHASES = [
  "collecting",
  "curating",
  "building",
  "done",
] as const;
export type ImportPhase = (typeof IMPORT_PHASES)[number];

/**
 * What Build can read for an item, decided at staging from metadata alone.
 *   - `readable`   a public page whose text the pod can read;
 *   - `captions`   a video whose captions can be fetched (YouTube);
 *   - `file`       the person gave the bytes (a document, a video file, …);
 *   - `needs_file` a platform the pod must not scrape (Instagram, TikTok):
 *                  Build reads it only once the person attaches the file;
 *   - `title_only` nothing beyond the title and card (Build uses the metadata).
 */
export const IMPORT_CONTENT_STATUSES = [
  "readable",
  "captions",
  "file",
  "needs_file",
  "title_only",
] as const;
export type ImportContentStatus = (typeof IMPORT_CONTENT_STATUSES)[number];

/** The person's triage of one item. Untouched items are `keep`: they follow their group. */
export const IMPORT_ITEM_DECISIONS = ["keep", "later", "exclude"] as const;
export type ImportItemDecision = (typeof IMPORT_ITEM_DECISIONS)[number];

/**
 * What a group may become at Build. User words map to object kinds through the
 * vocabulary door (`list` → view, `tool` → skill, `template` → playbook,
 * `rule` → automation/rule, `project` → project, `things` → the items as entities).
 */
export const IMPORT_GROUP_OUTPUTS = [
  "things",
  "list",
  "project",
  "tool",
  "template",
  "rule",
] as const;
export type ImportGroupOutput = (typeof IMPORT_GROUP_OUTPUTS)[number];

/** A recognised platform, from the URL host only (never from fetched content). */
export const IMPORT_PLATFORMS = [
  "youtube",
  "instagram",
  "tiktok",
  "x",
  "linkedin",
  "github",
  "web",
] as const;
export type ImportPlatform = (typeof IMPORT_PLATFORMS)[number];

/** Hard limits shared by every door (pod validation, client affordances). */
export const IMPORT_LIMITS = {
  /** Items accepted by one `imports.stage` call. */
  stageBatchMax: 100,
  /** Items one import may hold. */
  itemsMax: 2000,
  /** Groups one import may hold. */
  groupsMax: 40,
  /** A group or item note, in characters. Group + item notes together must fit the pod's 2000-char instructions budget. */
  groupNoteMax: 1200,
  itemNoteMax: 600,
  groupNameMax: 80,
  /** Page HTML a url item may carry, in characters (the same cap as capture). */
  pageHtmlMax: 50_000,
  /** Inline file bytes accepted by `imports.stage` (bigger files go through presigned upload). */
  inlineFileBytesMax: 8 * 1024 * 1024,
} as const;

/** A preview card, read from oEmbed / OpenGraph / the upload — never the body. */
export interface ImportItemCard {
  title?: string;
  description?: string;
  imageUrl?: string;
  authorName?: string;
  siteName?: string;
  durationSeconds?: number;
}

export interface ImportItemSource {
  kind: "url" | "file" | "text";
  url?: string;
  host?: string;
  platform?: ImportPlatform;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  /**
   * The document holding the item's bytes when they are not on the item's own
   * row — a file the person attached later to a `needs_file` link.
   */
  documentId?: string;
}

/** `documents.metadata.importItem` — written once by the pod at staging. */
export interface ImportItemMetadata {
  version: 1;
  title: string;
  source: ImportItemSource;
  card?: ImportItemCard;
  contentStatus: ImportContentStatus;
  stagedAt: string;
}

/** `documents.metadata.importCuration` — the person's decision and note on one item. */
export interface ImportItemCuration {
  decision: ImportItemDecision;
  note?: string;
  /** Groups this item belongs to (many-to-many). */
  groupKeys: string[];
}

export interface ImportGroup {
  /** Stable within the import (slug-like). */
  key: string;
  name: string;
  /** The person's instruction for the whole group; every item inherits it. */
  note?: string;
  /** Who made the group: the AI, the person, or the deterministic fallback (`rule` — by platform / host / file type, no AI). */
  origin: "ai" | "user" | "rule";
  /** What Build should propose for this group. */
  outputs: ImportGroupOutput[];
  /** One line: why the AI grouped these (shown behind "Why these"). */
  reason?: string;
  /** Set while a Build holds the group (cleared when it lands or fails). */
  buildingAt?: string;
  /** Set once the group was built. */
  builtAt?: string;
  buildProposalId?: string;
}

/** `focus_sessions.metadata.importCuration`. Its presence marks a session as an import. */
export interface ImportSessionCuration {
  version: 1;
  phase: ImportPhase;
  groups: ImportGroup[];
  groupedAt?: string;
  /** Device the import started on (`relay`, `browser`, `cli`, …) — for "Started on iPhone". */
  origin?: string;
  updatedAt: string;
}

/** One staged item as every client reads it (`imports.get`). */
export interface ImportItemView {
  /** The staged source document's id. */
  id: string;
  title: string;
  source: ImportItemSource;
  card?: ImportItemCard;
  contentStatus: ImportContentStatus;
  decision: ImportItemDecision;
  note?: string;
  groupKeys: string[];
  stagedAt: string;
}

export interface ImportView {
  sessionId: string;
  title: string;
  phase: ImportPhase;
  origin?: string;
  groups: ImportGroup[];
  items: ImportItemView[];
  counts: ImportCounts;
  /** Opaque cursor when more items exist (`imports.get({ cursor })`). */
  nextCursor?: string | null;
}

export interface ImportCounts {
  items: number;
  keep: number;
  later: number;
  excluded: number;
  groups: number;
  groupsWithNote: number;
  ungrouped: number;
}

/** Input of `imports.stage`: one entry per item. */
export type ImportStageItemInput =
  | {
      kind: "url";
      url: string;
      title?: string;
      note?: string;
      /**
       * The page as the person's browser rendered it (≤
       * `IMPORT_LIMITS.pageHtmlMax`) — a login-only page the pod cannot fetch.
       * Kept beside the item (never as its body); the light read prefers it.
       */
      html?: string;
    }
  | { kind: "text"; text: string; title?: string; note?: string }
  | {
      kind: "file";
      filename: string;
      mimeType: string;
      /** A document already uploaded through the presigned door. */
      documentId?: string;
      /** Or the bytes inline (≤ IMPORT_LIMITS.inlineFileBytesMax). */
      contentBase64?: string;
      sizeBytes?: number;
      sha256?: string;
      note?: string;
    };

/** One edit of `imports.curate`. Applied in order, in one transaction. */
export type ImportCurateOp =
  | { op: "setGroupNote"; groupKey: string; note: string }
  | { op: "setGroupOutputs"; groupKey: string; outputs: ImportGroupOutput[] }
  | { op: "renameGroup"; groupKey: string; name: string }
  | { op: "createGroup"; name: string; itemIds?: string[] }
  | { op: "mergeGroups"; fromKey: string; intoKey: string }
  | { op: "deleteGroup"; groupKey: string }
  | { op: "addToGroup"; groupKey: string; itemIds: string[] }
  | { op: "removeFromGroup"; groupKey: string; itemIds: string[] }
  | { op: "setItemNote"; itemId: string; note: string }
  | { op: "setDecision"; itemIds: string[]; decision: ImportItemDecision };

/**
 * The marker a staged item carries on `documents.metadata.intakeSource.pending`
 * until its group is built. Every list of captures/documents and the search
 * reindex skip a source that carries it: a staged item is nobody's capture yet.
 */
export const IMPORT_STAGED_MARKER = "awaiting_curation" as const;

/**
 * Why one item was not read by Build. `unreadable`: its content could not be
 * read or structured (no captions reader, the page did not answer, the AI
 * failed on it) — it was filed from its title and card only.
 */
export type ImportBuildSkipReason =
  "excluded" | "later" | "needs_file" | "unreadable";

/** Result of `imports.build`. `proposed` is success: the bundle awaits review. */
export interface ImportBuildResult {
  status: "proposed" | "applied" | "refused";
  proposalId?: string;
  reason?: string;
  read: number;
  skipped: Array<{ itemId: string; reason: ImportBuildSkipReason }>;
  /** Existing Templates / Rules the group matched — reused, not proposed again. */
  matched?: Array<{ kind: "template" | "rule"; id: string; name: string }>;
  /** The Tools/Templates/Rules were written from the note alone (the AI did not answer). */
  infrastructureDegraded?: boolean;
}

// ── Pure helpers (shared by pod, browser and relay) ────────────────────────

const PLATFORM_HOSTS: ReadonlyArray<[ImportPlatform, readonly string[]]> = [
  [
    "youtube",
    ["youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"],
  ],
  ["instagram", ["instagram.com"]],
  ["tiktok", ["tiktok.com", "vm.tiktok.com"]],
  ["x", ["x.com", "twitter.com", "mobile.twitter.com"]],
  ["linkedin", ["linkedin.com"]],
  ["github", ["github.com"]],
];

/** The bare host of a URL (no `www.`), or null when it does not parse. */
export function importHostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The platform of a URL from its host alone. Unknown hosts are `web`. */
export function importPlatformOf(url: string): ImportPlatform | null {
  const host = importHostOf(url);
  if (!host) return null;
  for (const [platform, hosts] of PLATFORM_HOSTS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`)))
      return platform;
  }
  return "web";
}

/**
 * What Build can read for a source, decided from metadata only.
 * Instagram and TikTok are never scraped by the pod: their content arrives
 * only as a file the person provides.
 */
export function importContentStatusFor(
  source: ImportItemSource
): ImportContentStatus {
  if (source.kind === "file") return "file";
  if (source.kind === "text") return "readable";
  switch (source.platform) {
    case "youtube":
      return "captions";
    case "instagram":
    case "tiktok":
      return "needs_file";
    case "x":
    case "linkedin":
      return "title_only";
    default:
      return "readable";
  }
}

/** Reads `focus_sessions.metadata.importCuration`, or null when the session is not an import. */
export function readImportCuration(
  metadata: unknown
): ImportSessionCuration | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).importCuration;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<ImportSessionCuration>;
  if (
    c.version !== 1 ||
    !c.phase ||
    !(IMPORT_PHASES as readonly string[]).includes(c.phase)
  ) {
    return null;
  }
  return {
    version: 1,
    phase: c.phase,
    groups: Array.isArray(c.groups) ? c.groups : [],
    groupedAt: c.groupedAt,
    origin: c.origin,
    updatedAt: c.updatedAt ?? "",
  };
}

/** True iff a session's metadata marks it as an import. */
export function isImportSession(metadata: unknown): boolean {
  return readImportCuration(metadata) !== null;
}

/** Items of a group, in stable order. */
export function importItemsInGroup(
  items: readonly ImportItemView[],
  groupKey: string
): ImportItemView[] {
  return items.filter((i) => i.groupKeys.includes(groupKey));
}

export interface ImportBuildEstimate {
  /** Items Build will read (kept and readable, or with a file). */
  willRead: number;
  /** Kept items whose content needs a file the person has not given. */
  needsFile: number;
  /** Kept items Build will use by title and card only. */
  titleOnly: number;
  /** Items skipped because excluded or set aside. */
  skipped: number;
}

/** What building one group would read — the same rule the pod's Build applies. */
export function importBuildEstimate(
  items: readonly ImportItemView[],
  groupKey: string
): ImportBuildEstimate {
  const est: ImportBuildEstimate = {
    willRead: 0,
    needsFile: 0,
    titleOnly: 0,
    skipped: 0,
  };
  for (const item of importItemsInGroup(items, groupKey)) {
    if (item.decision !== "keep") {
      est.skipped += 1;
    } else if (item.contentStatus === "needs_file") {
      est.needsFile += 1;
    } else if (item.contentStatus === "title_only") {
      est.titleOnly += 1;
    } else {
      est.willRead += 1;
    }
  }
  return est;
}

/** Counts shown in every header ("48 items · 6 groups · 2 with notes"). */
export function importCounts(
  items: readonly ImportItemView[],
  groups: readonly ImportGroup[]
): ImportCounts {
  const groupKeys = new Set(groups.map((g) => g.key));
  let keep = 0;
  let later = 0;
  let excluded = 0;
  let ungrouped = 0;
  for (const item of items) {
    if (item.decision === "keep") keep += 1;
    else if (item.decision === "later") later += 1;
    else excluded += 1;
    if (!item.groupKeys.some((k) => groupKeys.has(k))) ungrouped += 1;
  }
  return {
    items: items.length,
    keep,
    later,
    excluded,
    groups: groups.length,
    groupsWithNote: groups.filter((g) => (g.note ?? "").trim().length > 0)
      .length,
    ungrouped,
  };
}

/**
 * The instruction Build passes for one item: the group note first, then the
 * item note. Imported text is never part of it — only the person's words steer.
 */
export function importItemInstructions(
  item: Pick<ImportItemView, "note" | "groupKeys">,
  groups: readonly ImportGroup[]
): string {
  const parts: string[] = [];
  for (const g of groups) {
    if (item.groupKeys.includes(g.key) && g.note?.trim()) {
      parts.push(`Group "${g.name}": ${g.note.trim()}`);
    }
  }
  if (item.note?.trim()) parts.push(`This item: ${item.note.trim()}`);
  return parts.join("\n");
}

/** A stable group key from a name (`Films to watch` → `films-to-watch`). */
export function importGroupKey(
  name: string,
  taken: Iterable<string> = []
): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "group";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// ── Wire results the clients read (added by F1 for the client hooks) ───────

/** Input of `import.stage`. Opens the import (phase `collecting`) when `sessionId` is absent, else appends. */
export interface ImportStageRequest {
  sessionId?: string;
  title?: string;
  /** Device the import started on (`relay`, `browser`, `cli`, …). */
  origin?: string;
  workspaceId?: string | null;
  projectId?: string | null;
  items: ImportStageItemInput[];
}

/** Input of `import.attachFile`: the bytes Build needs for a `needs_file` item. */
export interface ImportAttachFileRequest {
  sessionId: string;
  itemId: string;
  filename: string;
  mimeType: string;
  documentId?: string;
  contentBase64?: string;
}

/** Result of `import.stage`. A refused item keeps its input index so the door can say which one. */
export interface ImportStageResult {
  sessionId: string;
  staged: Array<{ itemId: string; deduplicated: boolean }>;
  refused: Array<{ index: number; reason: string }>;
}

/** One open import in `import.list` (newest first). */
export interface ImportListEntry {
  sessionId: string;
  title: string;
  phase: ImportPhase;
  origin?: string;
  counts: ImportCounts;
  updatedAt: string;
}

/** Result of `import.group`: the view, plus whether the AI pass fell back to the deterministic one. */
export type ImportGroupResult = ImportView & { groupingDegraded?: boolean };

/**
 * `proposals.data.importBuild` — stamped by Build on the ONE bundle it files,
 * so the review can say what each block was made from. Keys of `byRef` are
 * the composite op `ref`s of that bundle.
 */
export interface ImportBuildProvenance {
  version: 1;
  sessionId: string;
  groupKey: string;
  groupName: string;
  byRef: Record<
    string,
    {
      /** Staged item ids the op was made from. */
      itemIds: string[];
      /** True when the group note steered it. */
      groupNote: boolean;
      /** How many item notes steered it. */
      itemNotes: number;
    }
  >;
  /**
   * Dry run of each Rule (`create_automation` / `create_rule` op ref): how
   * often it would have run over the window. Absent when no dry run was made.
   */
  dryRun?: Record<string, { wouldHaveRun: number; windowDays: number }>;
}

/** Reads `proposals.data.importBuild`, or null when the proposal is not an import build. */
export function readImportBuildProvenance(
  data: unknown
): ImportBuildProvenance | null {
  if (!data || typeof data !== "object") return null;
  const raw = (data as Record<string, unknown>).importBuild;
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<ImportBuildProvenance>;
  if (p.version !== 1 || typeof p.groupKey !== "string") return null;
  return {
    version: 1,
    sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
    groupKey: p.groupKey,
    groupName: typeof p.groupName === "string" ? p.groupName : p.groupKey,
    byRef: p.byRef && typeof p.byRef === "object" ? p.byRef : {},
    dryRun: p.dryRun && typeof p.dryRun === "object" ? p.dryRun : undefined,
  };
}
