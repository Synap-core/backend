/**
 * Library ADD — keep something (CAPTURE_LIBRARY_PLAN L2, decision 3).
 *
 * `library.add` is `import.stage` without a batch to manage: items append to
 * the person's OPEN "Kept from <device>, <day>" run (one import session per
 * device, day and lens, opened through `openImportSession`), which stays the
 * unit of undo. A link, text or file already kept anywhere in the Library is
 * the same item (`deduplicated`), never a twin.
 *
 * A note typed at share time IS a Capture (your words), linked to the item(s):
 * it is staged as a typed-text intake source (door `library_note`, so it is a
 * row of "my captures") and each item records `captureNoteId`.
 *
 * `readNow` (one item) is the explicit "Read now": a one-item Build, governed.
 *
 * The AI's capture door (MCP `synap_capture`, Hub capture for agents) never
 * reaches this: nothing an agent sends lands in the Library.
 */

import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  db as defaultDb,
  documents,
  focusSessions,
  and,
  eq,
  inArray,
  isNull,
  desc,
  drizzleSql,
} from "@synap/database";
import {
  IMPORT_LIMITS,
  LIBRARY_LIMITS,
  type LibraryAddRequest,
  type LibraryAddResult,
} from "@synap-core/types/imports";
import { resolveImportOriginLabel } from "@synap-core/types/vocabulary";
import {
  loadImportSession,
  openImportSession,
  type ImportSessionRow,
} from "../imports/session.js";
import { stageImportItems, type ImportStageDeps } from "../imports/stage.js";
import { stageIntakeSource } from "../intake/stage-intake-source.js";
import { libraryItemsWhere, type LibraryDb } from "./read-model.js";

const logger = createLogger({ module: "library/add" });

/** `focus_sessions.metadata.libraryRun` — marks an import run the Library door opened. */
export const LIBRARY_RUN_KEY = "libraryRun";

/** The door a share-time note records (a capture: the person's words). */
export const LIBRARY_NOTE_DOOR = "library_note";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Kept from your phone, 13 Oct" — the run's name. */
export function libraryRunTitle(device: string | null, day: string): string {
  const [, m, d] = day.split("-");
  const when = `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""}`.trim();
  const from = resolveImportOriginLabel(device);
  return from ? `Kept from ${from}, ${when}` : `Kept, ${when}`;
}

/** The person's open Library run for (device, day, lens), opened when missing or full. */
export async function ensureLibraryRun(args: {
  database?: LibraryDb;
  userId: string;
  device: string | null;
  workspaceId: string | null;
  projectId: string | null;
  incoming: number;
  now?: Date;
}): Promise<ImportSessionRow> {
  const database = args.database ?? defaultDb;
  const day = (args.now ?? new Date()).toISOString().slice(0, 10);
  const marker = {
    device: args.device ?? "",
    day,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
  };
  const candidates = await database
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, args.userId),
        eq(focusSessions.status, "active"),
        drizzleSql`${focusSessions.metadata} -> ${LIBRARY_RUN_KEY} @> ${JSON.stringify(marker)}::jsonb`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: Library runs only (the `libraryRun` key) — one population.
    .orderBy(desc(focusSessions.createdAt))
    .limit(5);
  for (const c of candidates) {
    const [row] = await database
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(documents)
      .where(
        and(
          libraryItemsWhere(args.userId),
          drizzleSql`${documents.metadata} #>> '{intakeSource,sessionId}' = ${c.id}`
        )
      );
    // A run full enough to refuse the batch makes way for a fresh one.
    if (Number(row?.n ?? 0) + args.incoming <= IMPORT_LIMITS.itemsMax) {
      return loadImportSession({
        database,
        userId: args.userId,
        sessionId: c.id,
      });
    }
  }
  const opened = await openImportSession({
    database,
    userId: args.userId,
    // A person's run: the Library never takes an agent's write.
    agentUserId: null,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    title: libraryRunTitle(args.device, day),
    origin: args.device,
  });
  await database
    .update(focusSessions)
    .set({
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [LIBRARY_RUN_KEY]: marker })}::jsonb`,
    })
    .where(
      and(
        eq(focusSessions.id, opened.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    );
  return loadImportSession({
    database,
    userId: args.userId,
    sessionId: opened.sessionId,
  });
}

/** Link more items to an existing share note (owner-floored, share notes only). */
export async function linkShareNote(args: {
  database?: LibraryDb;
  userId: string;
  noteId: string;
  itemIds: readonly string[];
}): Promise<string> {
  const database = args.database ?? defaultDb;
  const [note] = await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(${documents.metadata}, '{libraryNoteFor}', (SELECT COALESCE(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(${documents.metadata} -> 'libraryNoteFor', '[]'::jsonb) || ${JSON.stringify([...args.itemIds])}::jsonb) AS x), true)`,
    })
    .where(
      and(
        eq(documents.id, args.noteId),
        eq(documents.userId, args.userId),
        isNull(documents.deletedAt),
        drizzleSql`${documents.metadata} #>> '{intakeSource,door}' = ${LIBRARY_NOTE_DOOR}`
      )
    )
    .returning({ id: documents.id });
  if (!note) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Note not found" });
  }
  await linkItemsToNote(database, args.userId, args.itemIds, note.id);
  return note.id;
}

async function linkItemsToNote(
  database: LibraryDb,
  userId: string,
  itemIds: readonly string[],
  noteId: string
) {
  if (itemIds.length === 0) return;
  await database
    .update(documents)
    .set({
      metadata: drizzleSql`jsonb_set(${documents.metadata}, '{importCuration,captureNoteId}', ${JSON.stringify(noteId)}::jsonb, true)`,
    })
    .where(
      and(
        libraryItemsWhere(userId),
        inArray(documents.id, [...itemIds]),
        drizzleSql`${documents.metadata} ? 'importCuration'`
      )
    );
}

/** Stage the share-time note as a capture and link it to the items. */
export async function keepShareNote(args: {
  database?: LibraryDb;
  userId: string;
  workspaceId: string | null;
  note: string;
  itemIds: readonly string[];
}): Promise<string> {
  const database = args.database ?? defaultDb;
  const text = args.note.trim();
  const firstLine = text.split("\n")[0] ?? text;
  const staged = await stageIntakeSource({
    database,
    userId: args.userId,
    workspaceId: args.workspaceId,
    sessionId: null,
    door: LIBRARY_NOTE_DOOR,
    kind: "text",
    title: firstLine.slice(0, 80) || "Note",
    text,
    extraMetadata: { libraryNoteFor: [...args.itemIds] },
  });
  await linkItemsToNote(database, args.userId, args.itemIds, staged.documentId);
  return staged.documentId;
}

export async function addToLibrary(args: {
  database?: LibraryDb;
  userId: string;
  request: LibraryAddRequest;
  /** Default workspace when the request names none (the caller's lens). */
  workspaceId?: string | null;
  deps?: ImportStageDeps;
  /** The one-item Build behind "Read now" (injected by the router). */
  readNow?: (
    itemId: string
  ) => Promise<{ proposalId?: string; refused?: string }>;
}): Promise<LibraryAddResult> {
  const database = args.database ?? defaultDb;
  const req = args.request;
  if (req.items.length === 0 || req.items.length > LIBRARY_LIMITS.addBatchMax) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Keep between 1 and ${LIBRARY_LIMITS.addBatchMax} items at once.`,
    });
  }
  if (req.readNow && req.items.length !== 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Read now applies to one item at a time.",
    });
  }
  const workspaceId = req.workspaceId ?? args.workspaceId ?? null;
  const run = await ensureLibraryRun({
    database,
    userId: args.userId,
    device: req.device?.trim() || null,
    workspaceId,
    projectId: req.projectId ?? null,
    incoming: req.items.length,
  });
  const outcome = await stageImportItems({
    database,
    userId: args.userId,
    session: run,
    items: req.items,
    deps: { ...(args.deps ?? {}), dedupScope: "library" },
  });
  const itemIds = outcome.staged.map((s) => s.itemId);
  // A re-kept item that had been archived comes back.
  if (itemIds.length > 0) {
    await database
      .update(documents)
      .set({
        metadata: drizzleSql`(${documents.metadata} #- '{importCuration,archivedAt}')`,
      })
      .where(
        and(
          eq(documents.userId, args.userId),
          isNull(documents.deletedAt),
          inArray(documents.id, itemIds),
          drizzleSql`(${documents.metadata} #>> '{importCuration,archivedAt}') IS NOT NULL`
        )
      );
  }
  const result: LibraryAddResult = {
    runId: run.id,
    staged: outcome.staged,
    refused: outcome.refused,
  };
  if (req.captureNoteId) {
    // A share split over several calls: these items join the note an earlier
    // call made. A note that is not the caller's share note reads NOT_FOUND.
    result.captureNoteId = await linkShareNote({
      database,
      userId: args.userId,
      noteId: req.captureNoteId,
      itemIds,
    });
  } else if (req.note?.trim()) {
    if (req.note.length > LIBRARY_LIMITS.shareNoteMax) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A note is at most ${LIBRARY_LIMITS.shareNoteMax} characters.`,
      });
    }
    result.captureNoteId = await keepShareNote({
      database,
      userId: args.userId,
      workspaceId,
      note: req.note,
      itemIds,
    });
  }
  if (req.readNow && itemIds[0] && args.readNow) {
    try {
      const built = await args.readNow(itemIds[0]);
      if (built.proposalId) result.readNowProposalId = built.proposalId;
      else if (built.refused) result.readNowFailed = built.refused;
    } catch (err) {
      // The item is KEPT either way; the failed read is said on the result
      // (and the item keeps its Read-now door), never folded into success.
      logger.error({ err, itemId: itemIds[0] }, "library add: Read now failed");
      result.readNowFailed =
        err instanceof Error ? err.message.slice(0, 200) : "read_now_failed";
    }
  }
  return result;
}

/**
 * What follows a keep, for what is NEW to the Library: the light read is
 * queued, and a title-only search row so a kept item is findable at once (the
 * light read re-indexes it with its text). A failed enqueue is said in the log
 * and left to the hourly sweep / the next full reindex — the item is kept and
 * reads "Not read yet", never lost.
 */
export async function startKeptItemReads(
  userId: string,
  result: Pick<LibraryAddResult, "staged">
): Promise<void> {
  const fresh = result.staged
    .filter((s) => !s.deduplicated)
    .map((s) => s.itemId);
  if (fresh.length === 0) return;
  const { enqueueLibraryLightRead } = await import("./light-read-queue.js");
  await enqueueLibraryLightRead(fresh.map((itemId) => ({ userId, itemId })));
  try {
    const { getBoss } = await import("@synap/jobs");
    const boss = getBoss();
    for (const documentId of fresh) {
      await boss.send("search-index", {
        collection: "documents",
        operation: "upsert",
        documentId,
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    logger.warn(
      { err, count: fresh.length },
      "library add: search-index enqueue FAILED — findable after the next reindex"
    );
  }
}
