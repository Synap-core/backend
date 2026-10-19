/**
 * One-title BACKFILL — existing documents stop printing their name twice.
 *
 * Founder 2026-10-19: a document's NAME is its one title. Since lane OA the
 * create and replace doors store a markdown body WITHOUT a leading heading
 * equal to the name (`namedDocumentBody` → markdown-core
 * `resolveDocumentTitle`). Documents written before that still open with it.
 * This pass removes that heading ONCE from each of them, on every pod.
 *
 * The rule is markdown-core's, never a copy: `leadingHeading` + `isSameTitle`
 * decide, `bodyWithoutTitleHeading` gives the body. Only a heading EQUAL to
 * the name goes (trim, case, whitespace and marks ignored); a heading that
 * differs is content and stays; the document is never renamed.
 *
 * Every change is a NEW REVISION through THE content-write door
 * (`claimDocumentRevision`), compare-and-set on the revision the pass read,
 * checkpointed under the system author with
 * {@link DOCUMENT_TITLE_HEADING_BACKFILL_MESSAGE}. The door first keeps the
 * body as it stood under its previous author, so the version history shows
 * the before and after and either can be restored. Open editors are told
 * (`document:content-replaced`). No `emitSideEffects`: a document "update"
 * fires user automations, and a pod-side cleanup must not.
 *
 * Scope (SQL): live markdown documents (`documents.type`, not mimeType — the
 * hub stores html as text/markdown) with a stored body, created at or before
 * the pass's `cutoff` (fixed at its first run: the documents that existed
 * before the create door applied the rule). Skipped in code, counted by
 * reason: no name, an intake raw (`metadata.intakeSource`, kept verbatim —
 * a re-structure replays it), no leading heading, a heading that differs.
 *
 * Shape of the run — rides the boot pass after the startup hooks (index.ts,
 * beside the media backfills), off the boot path, sequential:
 *   - keyset pages of {@link DOCUMENT_TITLE_HEADING_BACKFILL_BATCH} by
 *     `documents.id`; the marker (`pod_settings.settings.<key>`) is written
 *     after every page, so a crash resumes at the page it was on;
 *   - a failure on one document is recorded on the marker and the pass goes
 *     on; the NEXT run retries it (at most
 *     {@link DOCUMENT_TITLE_HEADING_BACKFILL_MAX_ATTEMPTS} runs, then it is
 *     listed as `abandoned` and logged — never folded into "changed").
 *
 * THE MARKER asserts only what this pass checked: "every in-scope document up
 * to `cursor`, created at or before `cutoff`, was read and judged by rule
 * v{@link DOCUMENT_TITLE_HEADING_BACKFILL_VERSION}"; `completedAt` adds "…and
 * the scan reached the end with nothing left to retry". Bump the version when
 * the rule changes: a stamp written by an older rule then stops counting and
 * the pass runs again over the documents existing at that time.
 */

import {
  db,
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  lte,
  documents,
  claimDocumentRevision,
  emitDocumentContentReplaced,
  type DocumentWriteAuthor,
} from "@synap/database";
import { storage } from "@synap/storage";
import { createLogger } from "@synap-core/core";
import {
  bodyWithoutTitleHeading,
  isSameTitle,
  leadingHeading,
} from "@synap-core/markdown-core/sections";
import {
  readPodSettingsKey,
  writePodSettingsKey,
} from "../media-copy/backfill-media-copy.js";

const logger = createLogger({ module: "document-title-backfill" });

/** Bump when the rule changes: a stamp from an older rule stops counting. */
export const DOCUMENT_TITLE_HEADING_BACKFILL_VERSION = 1;
export const DOCUMENT_TITLE_HEADING_BACKFILL_SETTINGS_KEY =
  "documentTitleHeadingBackfill";
export const DOCUMENT_TITLE_HEADING_BACKFILL_BATCH = 100;
/** Runs a failing document is retried in before it is abandoned. */
export const DOCUMENT_TITLE_HEADING_BACKFILL_MAX_ATTEMPTS = 3;
/** The version-history line a person reads on each changed document. */
export const DOCUMENT_TITLE_HEADING_BACKFILL_MESSAGE =
  "Removed the title repeated as the first heading";
/** The system author of the checkpoint (`document_versions.author_id`). */
export const DOCUMENT_TITLE_HEADING_BACKFILL_AUTHOR: DocumentWriteAuthor = {
  authorKind: "system",
  authorId: "document-title-backfill",
};

export type TitleHeadingSkipReason =
  "nameless" | "verbatim" | "noHeading" | "differs";

export interface DocumentTitleHeadingBackfillMarker {
  version: number;
  /** Documents created at or before this instant are in scope (ISO). */
  cutoff: string;
  /** Last `documents.id` whose page was fully judged; null = none yet. */
  cursor: string | null;
  scanned: number;
  changed: number;
  skipped: Record<TitleHeadingSkipReason, number>;
  /** Documents to retry next run: id → runs tried + the last error. */
  failed: Record<string, { attempts: number; error: string }>;
  /** Documents given up on after the max attempts (logged when abandoned). */
  abandoned: string[];
  startedAt: string;
  scanCompletedAt?: string;
  completedAt?: string;
}

export interface DocumentTitleHeadingBackfillResult {
  status: "already-complete" | "completed" | "pending-retries";
  scanned: number;
  changed: number;
  skipped: Record<TitleHeadingSkipReason, number>;
  failed: number;
  abandoned: number;
}

export interface DocumentTitleHeadingBackfillDeps {
  now?: () => Date;
  batchSize?: number;
}

type Outcome =
  | { kind: "changed" }
  | { kind: "skipped"; reason: TitleHeadingSkipReason }
  | { kind: "failed"; error: string };

const IN_SCOPE_BASE = and(
  eq(documents.type, "markdown"),
  isNull(documents.deletedAt),
  isNotNull(documents.storageKey)
);

const ROW = {
  id: documents.id,
  title: documents.title,
  storageKey: documents.storageKey,
  mimeType: documents.mimeType,
  contentRevision: documents.contentRevision,
  metadata: documents.metadata,
};

type ScopeRow = {
  id: string;
  title: string;
  storageKey: string | null;
  mimeType: string | null;
  contentRevision: number;
  metadata: unknown;
};

function emptySkips(): Record<TitleHeadingSkipReason, number> {
  return { nameless: 0, verbatim: 0, noHeading: 0, differs: 0 };
}

async function readMarker(): Promise<DocumentTitleHeadingBackfillMarker | null> {
  const raw = await readPodSettingsKey(
    DOCUMENT_TITLE_HEADING_BACKFILL_SETTINGS_KEY
  );
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<DocumentTitleHeadingBackfillMarker>;
  if (
    m.version !== DOCUMENT_TITLE_HEADING_BACKFILL_VERSION ||
    typeof m.cutoff !== "string"
  )
    return null;
  return {
    version: m.version,
    cutoff: m.cutoff,
    cursor: typeof m.cursor === "string" ? m.cursor : null,
    scanned: typeof m.scanned === "number" ? m.scanned : 0,
    changed: typeof m.changed === "number" ? m.changed : 0,
    skipped: { ...emptySkips(), ...(m.skipped ?? {}) },
    failed: m.failed && typeof m.failed === "object" ? { ...m.failed } : {},
    abandoned: Array.isArray(m.abandoned) ? [...m.abandoned] : [],
    startedAt: typeof m.startedAt === "string" ? m.startedAt : "",
    ...(typeof m.scanCompletedAt === "string"
      ? { scanCompletedAt: m.scanCompletedAt }
      : {}),
    ...(typeof m.completedAt === "string"
      ? { completedAt: m.completedAt }
      : {}),
  };
}

/** Judge one document and, when its body opens with its name, write the rest. */
async function backfillOne(row: ScopeRow): Promise<Outcome> {
  if (!row.title.trim()) return { kind: "skipped", reason: "nameless" };
  const meta = row.metadata as Record<string, unknown> | null;
  if (meta && meta.intakeSource != null)
    return { kind: "skipped", reason: "verbatim" };
  try {
    const content = (await storage.downloadBuffer(row.storageKey!)).toString(
      "utf-8"
    );
    const lead = leadingHeading(content);
    if (!lead) return { kind: "skipped", reason: "noHeading" };
    if (!isSameTitle(lead.text, row.title))
      return { kind: "skipped", reason: "differs" };
    const next = bodyWithoutTitleHeading(content, row.title);
    const claimed = await db.transaction((tx) =>
      claimDocumentRevision(
        tx,
        row.id,
        row.contentRevision,
        DOCUMENT_TITLE_HEADING_BACKFILL_AUTHOR,
        {
          content: next,
          preContent: content,
          mimeType: row.mimeType || "text/markdown",
          checkpoint: { message: DOCUMENT_TITLE_HEADING_BACKFILL_MESSAGE },
        }
      )
    );
    const emitted = await emitDocumentContentReplaced({
      documentId: claimed.documentId,
      revision: claimed.revision,
      workspaceId: claimed.workspaceId,
      ownerUserId: claimed.ownerUserId,
    });
    if (!emitted.ok) {
      logger.warn(
        { documentId: row.id, error: emitted.error },
        "document:content-replaced emit failed after the title backfill — open editors were not told"
      );
    }
    return { kind: "changed" };
  } catch (err) {
    return {
      kind: "failed",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
}

function tally(
  marker: DocumentTitleHeadingBackfillMarker,
  outcome: Exclude<Outcome, { kind: "failed" }>
): void {
  if (outcome.kind === "changed") marker.changed++;
  else marker.skipped[outcome.reason]++;
}

function resultOf(
  marker: DocumentTitleHeadingBackfillMarker,
  status: DocumentTitleHeadingBackfillResult["status"]
): DocumentTitleHeadingBackfillResult {
  return {
    status,
    scanned: marker.scanned,
    changed: marker.changed,
    skipped: { ...marker.skipped },
    failed: Object.keys(marker.failed).length,
    abandoned: marker.abandoned.length,
  };
}

/**
 * Run (or resume) the pass. Idempotent: a completed stamp returns at once, and
 * a document already without the heading is judged `noHeading`/`differs`.
 */
export async function backfillDocumentTitleHeadings(
  deps: DocumentTitleHeadingBackfillDeps = {}
): Promise<DocumentTitleHeadingBackfillResult> {
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? DOCUMENT_TITLE_HEADING_BACKFILL_BATCH;
  const key = DOCUMENT_TITLE_HEADING_BACKFILL_SETTINGS_KEY;

  const previous = await readMarker();
  if (previous?.completedAt) return resultOf(previous, "already-complete");
  const startedAt = now().toISOString();
  const marker: DocumentTitleHeadingBackfillMarker = previous ?? {
    version: DOCUMENT_TITLE_HEADING_BACKFILL_VERSION,
    cutoff: startedAt,
    cursor: null,
    scanned: 0,
    changed: 0,
    skipped: emptySkips(),
    failed: {},
    abandoned: [],
    startedAt,
  };
  const inScope = and(
    IN_SCOPE_BASE,
    lte(documents.createdAt, new Date(marker.cutoff))
  );

  // 1. Retry what failed in an EARLIER run (never this run's own failures).
  const retryIds = Object.keys(marker.failed);
  if (retryIds.length > 0) {
    const rows = await db
      .select(ROW)
      .from(documents)
      .where(and(inScope, inArray(documents.id, retryIds)));
    const byId = new Map(rows.map((r) => [r.id, r as ScopeRow]));
    for (const id of retryIds) {
      const prior = marker.failed[id]!;
      const row = byId.get(id);
      if (!row) {
        // Gone (deleted, no longer in scope): nothing left to judge.
        delete marker.failed[id];
        continue;
      }
      const outcome = await backfillOne(row);
      if (outcome.kind === "failed") {
        const attempts = prior.attempts + 1;
        if (attempts >= DOCUMENT_TITLE_HEADING_BACKFILL_MAX_ATTEMPTS) {
          delete marker.failed[id];
          marker.abandoned.push(id);
          logger.warn(
            { documentId: id, attempts, error: outcome.error },
            "document title backfill: gave up on a document"
          );
        } else {
          marker.failed[id] = { attempts, error: outcome.error };
        }
        continue;
      }
      delete marker.failed[id];
      tally(marker, outcome);
    }
    await writePodSettingsKey(key, marker);
  }

  // 2. Scan (or resume) the documents not judged yet.
  while (!marker.scanCompletedAt) {
    const page = (await db
      .select(ROW)
      .from(documents)
      .where(
        marker.cursor ? and(inScope, gt(documents.id, marker.cursor)) : inScope
      )
      .orderBy(asc(documents.id))
      .limit(batchSize)) as ScopeRow[];
    for (const row of page) {
      const outcome = await backfillOne(row);
      if (outcome.kind === "failed") {
        marker.failed[row.id] = { attempts: 1, error: outcome.error };
        logger.warn(
          { documentId: row.id, error: outcome.error },
          "document title backfill: a document failed (retried next run)"
        );
      } else {
        tally(marker, outcome);
      }
    }
    if (page.length > 0) {
      marker.cursor = page[page.length - 1]!.id;
      marker.scanned += page.length;
    }
    if (page.length < batchSize) marker.scanCompletedAt = now().toISOString();
    await writePodSettingsKey(key, marker);
  }

  if (Object.keys(marker.failed).length > 0) {
    logger.info(marker, "document title backfill: scan done, retries pending");
    return resultOf(marker, "pending-retries");
  }
  marker.completedAt = now().toISOString();
  await writePodSettingsKey(key, marker);
  logger.info(marker, "document title backfill: complete");
  return resultOf(marker, "completed");
}
