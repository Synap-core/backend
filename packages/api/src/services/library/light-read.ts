/**
 * LIGHT READ — what every Library item gets on save, before any Build.
 *
 * Reads the item's text cheaply, keeps a short summary and the action chips,
 * and makes it searchable. It never structures the item, never files an
 * entity, never spends beyond the person's daily budget:
 *
 *   | item                         | read                                   | AI? |
 *   | typed text                   | its own body                           | no  |
 *   | any link                     | THE reader door `readUrl` (below)      | no* |
 *   | link + page the browser sent | that page (`readSentPage`), no request | no  |
 *   | file: text-like              | its bytes as text                      | no  |
 *   | file: photo / PDF / document | IS extraction (vision on the BULK lane, | yes |
 *   |                              | the pod's vision-model preference)     |     |
 *   | file: audio / video          | IS transcript                          | yes |
 *
 * A link is read through the ONE door (`services/capabilities/url-readers.ts`):
 * automatically (keep, sweep, Build's inline read) by the pod's built-in
 * ladder only; EXPLICITLY (`reader` on the job: "Read with X",
 * `library.readWith`) by the named reader — a billed one (*) first takes the
 * item's ONE unit of the daily budget and is checkpointed before its media is
 * copied, so a re-run never bills twice. How the door's answer becomes the
 * stored read is `light-read-map.ts`; how a failed try is retried (by its
 * class, with backoff) is `retryPlan` below. Media a read returns is copied in
 * the same job; a copied video is transcribed when the reader gave none.
 *
 * Writes: the read text beside the item (`libraryReadTextKey`, never over its
 * body), `metadata.importRead` (under a row lock, never on a deleted item),
 * one `search-index` job — and the owner is told (`library:item:updated`).
 *
 * Modules: this file is the job (`lightReadLibraryItem`); the content read is
 * `light-read-content.ts`, the door → stored-read mapping `light-read-map.ts`,
 * the stored state, its reader, writers and the job lease `light-read-store.ts`,
 * the deps and their real wiring `light-read-deps.ts`, the bounds
 * `light-read-limits.ts`.
 */

import { createLogger } from "@synap-core/core";
import { libraryReadTextKey } from "@synap/database";
import {
  detectLibraryActions,
  mergeLibraryActions,
  libraryItemOf,
  normalizeLibraryActions,
  type ImportItemMetadata,
  type LibraryAction,
  type LibraryReadStatus,
} from "@synap-core/types/imports";
import { isTransientUrlReadFailure } from "@synap-core/types/url-read";
import {
  groupIdsFromNames,
  loadGroupProfiles,
  scoreGroupSuggestions,
  writeGroupSuggestions,
  type GroupProfile,
} from "./suggest-groups.js";
import type { LibraryReadDb } from "./read-budget.js";
import {
  forgetLibraryReadConsent,
  heldFromStatus,
  isLibraryReadConsentLive,
} from "./read-consent.js";
import type { LightReadDeps } from "./light-read-deps.js";
import type { Got } from "./light-read-map.js";
import { loadRow, readContent } from "./light-read-content.js";
import {
  readStoredLibraryRead,
  recordLastAttempt,
  writeRead,
  type StoredLibraryRead,
} from "./light-read-store.js";
import {
  LIGHT_READ_GROUPS_OFFERED,
  LIGHT_READ_MAX_ATTEMPTS,
  LIGHT_READ_SHORT_TEXT,
  lightReadRetryDelayMs,
  LIGHT_READ_SUGGEST_TEXT_MAX,
  LIGHT_READ_SUMMARY_INPUT_MAX,
  LIGHT_READ_SUMMARY_MAX,
  LIGHT_READ_TEXT_MAX,
} from "./light-read-limits.js";

const logger = createLogger({ module: "library/light-read" });

export interface LightReadResult {
  itemId: string;
  status: LibraryReadStatus | "skipped";
  chars?: number;
  actions?: number;
  usedAi?: boolean;
  /** Groups suggested for the item (never membership). */
  suggestedGroupIds?: string[];
}

function isFinal(read: StoredLibraryRead, item: ImportItemMetadata): boolean {
  if (read.status === "read" || read.status === "unreadable") return true;
  if (read.status === "title_only") return true;
  // A needs_file link stops waiting once the person attached the file.
  if (read.status === "needs_file") return !item.source.documentId;
  return false;
}

/** The first sentences, up to the summary cap. */
export function extractiveSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= LIGHT_READ_SUMMARY_MAX) return flat;
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > LIGHT_READ_SUMMARY_MAX) break;
    out += s;
  }
  if (out.trim()) return out.trim();
  const cut = flat.slice(0, LIGHT_READ_SUMMARY_MAX);
  const space = cut.lastIndexOf(" ");
  return (
    space > LIGHT_READ_SUMMARY_MAX * 0.6 ? cut.slice(0, space) : cut
  ).trim();
}

/**
 * The read is written; an index enqueue that failed must not fail the job (a
 * retry would find the read final and skip). Loud, and the next full reindex
 * picks the item up.
 */
async function indexQuietly(deps: LightReadDeps, itemId: string) {
  try {
    await deps.index(itemId);
  } catch (err) {
    logger.error(
      { err, itemId },
      "library light read: search-index enqueue FAILED — the item is read but not searchable until the next reindex"
    );
  }
}

/** What one job knows about the item, shared by both endings. */
interface ReadJob {
  database: LibraryReadDb;
  userId: string;
  itemId: string;
  deps: LightReadDeps;
  item: ImportItemMetadata;
  prev: StoredLibraryRead;
  reader?: string;
  /**
   * When the person gave the consent `reader` runs on (ISO): now for a fresh
   * tap, the remembered tap's date for the sweep's retry of it.
   */
  consentAt?: string;
  /** The person's "with video" choice for `reader` (a fresh tap's, or the remembered one). */
  withVideo?: boolean;
  force?: boolean;
  now: Date;
  title: string;
  cardText: string;
  siteName?: string;
  groups: GroupProfile[];
}

/**
 * The person's groups an ungrouped item could join (an item already in a
 * group is not offered others: nothing re-clusters). A failed load means no
 * suggestions this time, never a failed read.
 */
async function groupsToOffer(
  database: LibraryReadDb,
  args: { userId: string; workspaceId: string | null; itemId: string },
  meta: Record<string, unknown> | null
): Promise<GroupProfile[]> {
  const grouped =
    ((meta?.importCuration as { groupIds?: unknown[] } | undefined)?.groupIds
      ?.length ?? 0) > 0;
  if (grouped) return [];
  try {
    return await loadGroupProfiles(database, {
      userId: args.userId,
      workspaceId: args.workspaceId,
    });
  } catch (err) {
    logger.warn(
      { err, itemId: args.itemId },
      "library light read: groups NOT loaded — no suggestions this time"
    );
    return [];
  }
}

async function suggestGroups(
  job: ReadJob,
  itemText: string,
  aiNames?: unknown
): Promise<string[] | undefined> {
  if (job.groups.length === 0) return undefined;
  try {
    return await writeGroupSuggestions(job.database, {
      itemId: job.itemId,
      ruleIds: scoreGroupSuggestions(itemText, job.groups).map(
        (g) => g.groupId
      ),
      aiIds: groupIdsFromNames(aiNames, job.groups),
    });
  } catch (err) {
    logger.warn(
      { err, itemId: job.itemId },
      "library light read: group suggestions NOT written"
    );
    return undefined;
  }
}

/**
 * What a failed try does to the item, by its CLASS (never by its prose):
 *   - transient (site / vendor / IS down, rate limited, extractor busy) of a
 *     reader that bills nothing → `not_read`, the attempt budget untouched,
 *     tried again after an exponential wait (`failure.nextAttemptAt`, which
 *     the sweep honours). It never ends `unreadable`;
 *   - transient of a BILLED reader → each try may cost, so it counts; at the
 *     cap the pod stops trying by itself and the item waits for the person
 *     (`needs_file`: "needs a reader", the reader's door offered again) —
 *     still never `unreadable`;
 *   - anything else (refused, bad output, unknown) counts; at the cap
 *     `unreadable`, the class kept.
 */
function retryPlan(
  prev: StoredLibraryRead,
  got: Extract<Got, { kind: "retry" }>,
  now: Date
): {
  status: LibraryReadStatus;
  attempts: number;
  transientFailures: number;
  failure: NonNullable<StoredLibraryRead["failure"]>;
} {
  const transient = isTransientUrlReadFailure(got.failure);
  const billed = got.reader?.billed === true;
  if (transient && !billed) {
    const transientFailures = (prev.transientFailures ?? 0) + 1;
    const nextAttemptAt = new Date(
      now.getTime() +
        lightReadRetryDelayMs(transientFailures, got.retryAfterSec)
    ).toISOString();
    return {
      status: "not_read",
      attempts: prev.attempts ?? 0,
      transientFailures,
      failure: { class: got.failure, transient, nextAttemptAt },
    };
  }
  const attempts = (prev.attempts ?? 0) + 1;
  const spent = attempts >= LIGHT_READ_MAX_ATTEMPTS;
  const nextAttemptAt = spent
    ? undefined
    : new Date(
        now.getTime() + lightReadRetryDelayMs(attempts, got.retryAfterSec)
      ).toISOString();
  return {
    status: spent ? (transient ? "needs_file" : "unreadable") : "not_read",
    attempts,
    transientFailures: 0,
    failure: {
      class: got.failure,
      transient,
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
    },
  };
}

/** The content did not read (a status, or a retry): write that, honestly. */
async function finishUnread(
  job: ReadJob,
  got: Exclude<Got, { kind: "text" }>
): Promise<LightReadResult> {
  const { database, itemId, deps, prev, reader, now, title, cardText } = job;
  const facts = {
    ...(got.reader ? { reader: got.reader } : {}),
    ...(got.blocked ? { blocked: got.blocked } : {}),
  };
  const retry = got.kind === "retry" ? retryPlan(prev, got, now) : null;
  const attempts = retry?.attempts ?? prev.attempts ?? 0;
  const status: LibraryReadStatus =
    got.kind === "status" ? got.status : retry!.status;
  if (reader && prev.status === "read") {
    // An explicit RE-read that did not read: the read the item has stays,
    // the attempt is recorded (never silent, never an erased read).
    const noted = await recordLastAttempt(database, itemId, {
      readerId: reader,
      status,
      ...(got.blocked ? { blocked: got.blocked } : {}),
      ...(got.error ? { error: got.error } : {}),
      at: now.toISOString(),
    });
    if (!noted) return { itemId, status: "skipped" };
    return { itemId, status, usedAi: got.usedAi ?? false };
  }
  // The person's choice waits with the item until it can run.
  const waiting = status === "not_read" || status === "over_budget";
  // Nothing read: chips can still come from the title and card.
  const actions = detectLibraryActions({
    title,
    text: cardText,
    ...(job.siteName ? { siteName: job.siteName } : {}),
    now,
  });
  const written = await writeRead(
    database,
    itemId,
    {
      status,
      suggestedActions: actions,
      ...facts,
      ...(attempts ? { attempts } : {}),
      ...(retry?.transientFailures
        ? { transientFailures: retry.transientFailures }
        : {}),
      ...(retry ? { failure: retry.failure } : {}),
      ...(got.error ? { lastError: got.error.slice(0, 500) } : {}),
      ...(reader && waiting
        ? {
            requestedReader: reader,
            requestedAt: job.consentAt ?? now.toISOString(),
            // The choice waits with the consent and ends with it.
            ...(job.withVideo ? { requestedWithVideo: true as const } : {}),
            ...(heldFromStatus(prev) ? { heldFrom: heldFromStatus(prev) } : {}),
          }
        : {}),
      ...(status !== "not_read" && status !== "over_budget"
        ? { readAt: now.toISOString() }
        : {}),
    },
    !reader && !job.force
  );
  if (!written) return { itemId, status: "skipped" };
  if (status !== "not_read") await indexQuietly(deps, itemId);
  const suggested = await suggestGroups(job, `${title}\n${cardText}`);
  return {
    itemId,
    status,
    actions: actions.length,
    usedAi: got.usedAi ?? false,
    ...(suggested ? { suggestedGroupIds: suggested } : {}),
  };
}

/**
 * The read's summary: a file's extraction summary, else the AI (one unit,
 * the same call picks groups and chips) when the text is long and the budget
 * allows, else the first sentences.
 */
async function summarizeRead(
  job: ReadJob,
  got: Extract<Got, { kind: "text" }>,
  text: string
): Promise<{
  summary: string;
  usedAi: boolean;
  aiActions: LibraryAction[];
  aiGroups: unknown;
}> {
  const { deps, userId, itemId, now, title } = job;
  let usedAi = got.usedAi;
  let summary = extractiveSummary(text);
  let aiActions: LibraryAction[] = [];
  let aiGroups: unknown;
  if (got.summary) {
    // ONE AI call per file: the extraction that read it already summarised it
    // (chips come from the rule detectors; groups from the lexical match).
    summary = got.summary.slice(0, LIGHT_READ_SUMMARY_MAX);
  } else if (text.length > LIGHT_READ_SHORT_TEXT) {
    // The summary is the read's one AI call (a file already holds its unit).
    const may = usedAi || (await deps.reserveAi({ userId, itemId }));
    if (may) {
      usedAi = true;
      try {
        const answer = await deps.summarize({
          title,
          text: text.slice(0, LIGHT_READ_SUMMARY_INPUT_MAX),
          today: now.toISOString().slice(0, 10),
          // The same call picks groups: no second AI call for suggestions.
          groups: job.groups
            .slice(0, LIGHT_READ_GROUPS_OFFERED)
            .map((g) => g.name),
        });
        aiGroups = answer?.groups;
        const aiSummary =
          typeof answer?.summary === "string" ? answer.summary.trim() : "";
        if (aiSummary) summary = aiSummary.slice(0, LIGHT_READ_SUMMARY_MAX);
        aiActions = normalizeLibraryActions(answer?.actions);
      } catch (err) {
        logger.warn(
          { err, itemId },
          "library light read: AI summary failed — kept the first sentences"
        );
      }
    }
  }
  return { summary, usedAi, aiActions, aiGroups };
}

/** The content read: store the text, summarise, write the read, index. */
async function finishRead(
  job: ReadJob,
  got: Extract<Got, { kind: "text" }>
): Promise<LightReadResult> {
  const { database, userId, itemId, deps, now, title, cardText } = job;
  const text = got.text.trim().slice(0, LIGHT_READ_TEXT_MAX);
  const ruleActions = detectLibraryActions({
    title,
    text: cardText ? `${cardText}\n${text}` : text,
    ...(job.siteName ? { siteName: job.siteName } : {}),
    now,
  });
  const { summary, usedAi, aiActions, aiGroups } = await summarizeRead(
    job,
    got,
    text
  );

  const textKey = libraryReadTextKey(userId, itemId);
  // A text written for an item deleted meanwhile is not indexed (below) and
  // goes with the item's purge (same key).
  await deps.writeText(textKey, text);
  const actions = mergeLibraryActions(ruleActions, aiActions);
  const written = await writeRead(database, itemId, {
    status: "read",
    summary,
    chars: text.length,
    readAt: now.toISOString(),
    suggestedActions: actions,
    textKey,
    ...(got.reader ? { reader: got.reader } : {}),
    ...(got.blocked ? { blocked: got.blocked } : {}),
    ...(got.transcript ? { transcript: got.transcript } : {}),
  });
  if (!written) return { itemId, status: "skipped" };
  await indexQuietly(deps, itemId);
  const suggested = await suggestGroups(
    job,
    [title, cardText, summary, text.slice(0, LIGHT_READ_SUGGEST_TEXT_MAX)].join(
      "\n"
    ),
    aiGroups
  );
  return {
    itemId,
    status: "read",
    chars: text.length,
    actions: actions.length,
    usedAi,
    ...(suggested ? { suggestedGroupIds: suggested } : {}),
  };
}

/**
 * Read one Library item. Idempotent: a final read is kept unless `force`.
 * Throws only when the pod itself failed (a database or storage write).
 */
export async function lightReadLibraryItem(args: {
  database: LibraryReadDb;
  userId: string;
  itemId: string;
  force?: boolean;
  /**
   * The reader the person chose ("Read with X"): implies `force`, may bill
   * (one budget unit), and is interactive. Absent = automatic (free only).
   */
  reader?: string;
  /**
   * With `reader`: an item that already has a read KEEPS it — the read's
   * media is copied, its text is not written (`missingMedia`).
   */
  keepRead?: boolean;
  /** With `reader`: download the video too (the reader declares `withVideo`). */
  withVideo?: boolean;
  deps: LightReadDeps;
}): Promise<LightReadResult> {
  const { database, userId, itemId, deps } = args;
  const row = await loadRow(database, userId, itemId);
  const meta = (row?.metadata ?? null) as Record<string, unknown> | null;
  const item = libraryItemOf(meta);
  if (!row || !item) return { itemId, status: "skipped" };
  const { exists: everRead, read: prev } = readStoredLibraryRead(
    meta,
    item.contentStatus
  );
  // An explicit read, or the retry of one (the sweep's job carries no reader:
  // the reader the person chose is remembered on the item).
  const now = deps.now();
  // A remembered consent runs only while it lasts (`read-consent.ts`): an
  // ended one is forgotten here and NEVER run — the item goes back to waiting
  // for a reader, nothing is billed.
  if (
    !args.reader &&
    prev.requestedReader &&
    !isLibraryReadConsentLive(prev, now)
  ) {
    const forgot = await forgetLibraryReadConsent(database, userId, itemId);
    if (forgot) deps.notify?.({ userId, itemId, metadata: meta });
    logger.info(
      { itemId, reader: prev.requestedReader },
      "library light read: the person's consent for this reader has ended — not run, forgotten"
    );
    return { itemId, status: "skipped" };
  }
  const reader = args.reader ?? prev.requestedReader;
  // "Get the pictures": the item's read stays as it is — the reader's media
  // was copied in `readContent`; nothing of its text is written.
  const keepsRead = !!args.reader && !!args.keepRead && prev.status === "read";
  const consentAt = args.reader ? now.toISOString() : prev.requestedAt;
  // A fresh tap carries its own choice; the sweep's retry reads the one
  // remembered with the consent.
  const withVideo = args.reader
    ? args.withVideo === true
    : reader !== undefined && prev.requestedWithVideo === true;
  if (!args.force && !args.reader && everRead && isFinal(prev, item)) {
    return { itemId, status: "skipped" };
  }

  const card = item.card;
  const job: ReadJob = {
    database,
    userId,
    itemId,
    deps,
    item,
    prev,
    ...(reader ? { reader } : {}),
    ...(reader && consentAt ? { consentAt } : {}),
    ...(reader && withVideo ? { withVideo: true } : {}),
    ...(args.force ? { force: true } : {}),
    now,
    title: item.title || row.title,
    cardText: [card?.title, card?.description]
      .filter((t): t is string => !!t?.trim())
      .join("\n"),
    ...((card?.siteName ?? item.source.host)
      ? { siteName: card?.siteName ?? item.source.host }
      : {}),
    groups: await groupsToOffer(
      database,
      { userId, workspaceId: row.workspaceId, itemId },
      meta
    ),
  };

  let got: Got;
  try {
    got = await readContent({
      database,
      row,
      item,
      deps,
      ...(reader ? { reader } : {}),
      ...(prev.readCheckpoint ? { checkpoint: prev.readCheckpoint } : {}),
      ...(reader && withVideo ? { withVideo: true } : {}),
      // Media only: no speech-to-text for a read whose text is kept.
      ...(keepsRead ? { mediaOnly: true } : {}),
    });
  } catch (err) {
    // A reader that threw (storage, the IS transport, the reader lookup) is a
    // failed read, not an empty one: count the attempt, the sweep retries.
    logger.warn({ err, itemId }, "library light read: content NOT read");
    got = {
      kind: "retry",
      usedAi: false,
      // The pod's own dependency (storage, the IS transport): transient.
      failure: "unavailable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const result =
    got.kind === "text" && keepsRead
      ? { itemId, status: "read" as const, usedAi: got.usedAi }
      : got.kind === "text"
        ? await finishRead(job, got)
        : await finishUnread(job, got);
  if (result.status !== "skipped") {
    deps.notify?.({ userId, itemId, metadata: meta });
  }
  return result;
}
