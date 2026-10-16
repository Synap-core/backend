/**
 * Reading an item's CONTENT for the light read — one function per kind of
 * item: a file (its bytes, or the IS: extraction / transcript), typed text
 * (its body), a link (THE reader door, or the page the browser sent; then the
 * read's media copied in the same job and a copied video transcribed). Each
 * returns a `Got` (light-read-map.ts); the caller writes it.
 */

import { createLogger } from "@synap-core/core";
import { documents, and, eq, isNull } from "@synap/database";
import type { db as DbType } from "@synap/database";
import {
  readLibraryItemMedia,
  type ImportItemMetadata,
} from "@synap-core/types/imports";
import type { UrlRead } from "@synap-core/types/url-read";
import { readSentPage } from "../capabilities/web-read/read-builtin.js";
import { readLibraryPageMeta } from "./page-html.js";
import type { LibraryReadDb } from "./read-budget.js";
import type { LightReadDeps } from "./light-read-deps.js";
import { mapDoorRead, type Got } from "./light-read-map.js";
import { resumableRead, saveReadCheckpoint } from "./light-read-store.js";
import {
  LIGHT_READ_FILE_BYTES_MAX,
  LIGHT_READ_TEXT_FILE_BYTES_MAX,
  LIGHT_READ_TEXT_MAX,
  LIGHT_READ_TRANSCRIBE_BYTES_MAX,
} from "./light-read-limits.js";

const logger = createLogger({ module: "library/light-read" });

export interface ItemRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  metadata: unknown;
  storageKey: string | null;
  mimeType: string | null;
  /** Stored bytes (0 when unknown). */
  size: number | null;
}

const TEXT_LIKE =
  /^(text\/|application\/(json|xml|csv|x-ndjson|ld\+json|x-yaml|yaml|markdown|x-markdown))/i;

export async function loadRow(
  database: Pick<typeof DbType, "select">,
  userId: string,
  id: string
): Promise<ItemRow | null> {
  const [row] = await database
    .select({
      id: documents.id,
      userId: documents.userId,
      workspaceId: documents.workspaceId,
      title: documents.title,
      metadata: documents.metadata,
      storageKey: documents.storageKey,
      mimeType: documents.mimeType,
      size: documents.size,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, id),
        eq(documents.userId, userId),
        isNull(documents.deletedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

interface ReadContentArgs {
  database: LibraryReadDb;
  row: ItemRow;
  item: ImportItemMetadata;
  deps: LightReadDeps;
  /** The reader the person chose (explicit read); absent = automatic. */
  reader?: string;
  /** `importRead.readCheckpoint` as stored (a billed read to resume). */
  checkpoint?: unknown;
}

/** Read one item's content, by what it is. */
export async function readContent(args: ReadContentArgs): Promise<Got> {
  const s = args.item.source;
  if (args.item.contentStatus === "file" || s.documentId) {
    return readFileContent(args);
  }
  if (s.kind === "text") return readTextContent(args);
  if (!s.url) return { kind: "status", status: "title_only" };
  return readLinkContent(args, s.url);
}

const reserveFor = (args: ReadContentArgs) => () =>
  args.deps.reserveAi({ userId: args.row.userId, itemId: args.row.id });

/** A file: its bytes as text when text-like, else the IS (transcript / extraction). */
async function readFileContent(args: ReadContentArgs): Promise<Got> {
  const { row, item, deps } = args;
  const s = item.source;
  // A file the person attached later lives on its own document.
  const holder = s.documentId
    ? await loadRow(args.database, row.userId, s.documentId)
    : row;
  if (!holder?.storageKey) return { kind: "status", status: "unreadable" };
  const mimeType = s.mimeType ?? holder.mimeType ?? "application/octet-stream";
  // The size is known BEFORE reading (the item's card, else the stored
  // row): a file too big for a light read is never buffered at all.
  const size =
    typeof s.sizeBytes === "number" ? s.sizeBytes : (holder.size ?? 0);
  if (TEXT_LIKE.test(mimeType)) {
    if (size > LIGHT_READ_TEXT_FILE_BYTES_MAX) {
      return { kind: "status", status: "unreadable" };
    }
    const bytes = await deps.readBytes(holder.storageKey);
    // A size the row did not know: the bound still holds after the read.
    const text = bytes
      .subarray(0, LIGHT_READ_TEXT_FILE_BYTES_MAX)
      .toString("utf-8")
      .slice(0, LIGHT_READ_TEXT_MAX);
    return text.trim()
      ? { kind: "text", text, usedAi: false }
      : { kind: "status", status: "unreadable" };
  }
  if (size > LIGHT_READ_FILE_BYTES_MAX) {
    return { kind: "status", status: "unreadable" };
  }
  if (!(await reserveFor(args)())) {
    return { kind: "status", status: "over_budget" };
  }
  const bytes = await deps.readBytes(holder.storageKey);
  if (bytes.length > LIGHT_READ_FILE_BYTES_MAX) {
    return { kind: "status", status: "unreadable", usedAi: false };
  }
  const content = bytes.toString("base64");
  if (/^(audio|video)\//i.test(mimeType)) {
    const got = await deps.transcribe({ content, mimeType });
    if (got === null) {
      return { kind: "retry", usedAi: true, failure: "unavailable" };
    }
    return got.ok && got.text.trim()
      ? { kind: "text", text: got.text, usedAi: true }
      : { kind: "status", status: "unreadable", usedAi: true };
  }
  const got = await deps.extractFile({
    content,
    mimeType,
    ...(s.filename ? { filename: s.filename } : {}),
    title: item.title,
  });
  if (got === null) {
    return { kind: "retry", usedAi: true, failure: "unavailable" };
  }
  return !got.degraded && got.text?.trim()
    ? {
        kind: "text",
        text: got.text,
        usedAi: true,
        ...(got.summary?.trim() ? { summary: got.summary.trim() } : {}),
      }
    : { kind: "status", status: "unreadable", usedAi: true };
}

/** Typed text: its own body. */
async function readTextContent(args: ReadContentArgs): Promise<Got> {
  if (!args.row.storageKey) return { kind: "status", status: "unreadable" };
  const text = (await args.deps.readBytes(args.row.storageKey)).toString(
    "utf-8"
  );
  return text.trim()
    ? { kind: "text", text, usedAi: false }
    : { kind: "status", status: "unreadable" };
}

/**
 * The link's read: the page the browser sent, a resumed billed read, or THE
 * reader door. A billed explicit read takes the item's unit first and is
 * checkpointed before the slow part (media copy).
 */
async function readLink(
  args: ReadContentArgs,
  url: string
): Promise<{ read: UrlRead; usedAi: boolean } | { over: true }> {
  const { row, deps } = args;
  // The page the person's browser sent (a login-only page): read it, not
  // the URL — and even for a platform the pod never fetches, since the person
  // gave the page themselves. Its text is DATA, like any page. A reader the
  // person names explicitly reads the link itself.
  const page = args.reader ? null : readLibraryPageMeta(row.metadata);
  if (page) {
    const html = (await deps.readBytes(page.htmlKey)).toString("utf-8");
    return { read: await readSentPage(html, url, deps.now()), usedAi: false };
  }
  const resumed = args.reader
    ? resumableRead(args.checkpoint, args.reader, url, deps.now())
    : null;
  if (resumed) {
    // The same reader already read this item (its unit is spent): the job
    // that died or expired copying its media resumes — no second bill.
    logger.info(
      { itemId: row.id, reader: args.reader },
      "library light read: resumed from the checkpointed read — reader not run again"
    );
    return { read: resumed, usedAi: resumed.via.billed };
  }
  let usedAi = false;
  if (args.reader) {
    // A billed reader takes the item's ONE unit first (an AI summary that
    // follows reuses it). Over budget ⇒ marked, read later — never a drop.
    const offer = (await deps.readers(url)).find(
      (o) => o.readerId === args.reader
    );
    if (offer?.billing === "account") {
      if (!(await reserveFor(args)())) return { over: true };
      usedAi = true;
    }
  }
  const read = await deps.readUrl(
    url,
    args.reader
      ? { reader: args.reader, allowBilled: true, interactive: true }
      : { allowBilled: false }
  );
  if (
    args.reader &&
    read.via.billed &&
    (read.status === "ok" || read.status === "partial")
  ) {
    await saveReadCheckpoint(args.database, row.id, {
      readerId: args.reader,
      at: deps.now().toISOString(),
      read,
    });
  }
  return { read, usedAi };
}

/** A link: read it, copy its media in the same job, transcribe a copied video. */
async function readLinkContent(
  args: ReadContentArgs,
  url: string
): Promise<Got> {
  const { row, item, deps } = args;
  const link = await readLink(args, url);
  if ("over" in link) return { kind: "status", status: "over_budget" };
  const { read } = link;
  let usedAi = link.usedAi;

  let transcript:
    { source: "platform" | "stt"; text: string; lang?: string } | undefined =
    read.transcript?.text.trim()
      ? {
          source: read.transcript.source,
          text: read.transcript.text,
          ...(read.transcript.lang ? { lang: read.transcript.lang } : {}),
        }
      : undefined;
  if (
    (read.status === "ok" || read.status === "partial") &&
    read.media?.length
  ) {
    // In the SAME job as the read: a social CDN link expires within days.
    const copied = await deps.copyMedia({
      userId: row.userId,
      itemId: row.id,
      media: read.media,
    });
    if (copied.status === "failed") {
      // The copy run itself failed (nothing recorded on the item): loud, and
      // never mistaken for "no media" — the next read re-plans the copy.
      logger.error(
        { itemId: row.id, error: copied.error },
        "library light read: media copy FAILED — nothing recorded, a read again retries it"
      );
    } else if (copied.failed > 0) {
      logger.warn(
        { itemId: row.id, failed: copied.failed },
        "library light read: some media NOT copied (counted on the item)"
      );
    }
    if (!transcript && read.media.some((m) => m.kind === "video")) {
      const stt = await transcribeCopiedVideo({
        ...args,
        reserve: reserveFor(args),
      });
      if (stt) {
        transcript = stt;
        usedAi = true;
      }
    }
  }
  const got = mapDoorRead(read, item.contentStatus, transcript);
  return got.kind === "text" || got.kind === "retry"
    ? { ...got, usedAi: got.usedAi || usedAi }
    : { ...got, usedAi };
}

/**
 * The first copied video's speech, when the reader gave no transcript. Takes
 * the item's AI unit (the summary reuses it); a video over the transcriber's
 * one-upload ceiling is not sent. Any failure leaves the read without a
 * transcript (logged) — the read itself stands.
 */
async function transcribeCopiedVideo(args: {
  database: Pick<typeof DbType, "select">;
  row: ItemRow;
  deps: LightReadDeps;
  reserve: () => Promise<boolean>;
}): Promise<{ source: "stt"; text: string; lang?: string } | null> {
  const fresh = await loadRow(args.database, args.row.userId, args.row.id);
  const video = readLibraryItemMedia(fresh?.metadata).media.find(
    (m) =>
      m.kind === "video" &&
      (typeof m.bytes !== "number" ||
        m.bytes <= LIGHT_READ_TRANSCRIBE_BYTES_MAX)
  );
  if (!video) return null;
  if (!(await args.reserve())) {
    logger.info(
      { itemId: args.row.id },
      "library light read: video NOT transcribed — the day's read budget is spent"
    );
    return null;
  }
  const got = await args.deps.transcribeStored(
    video.documentId,
    args.row.userId
  );
  if ("text" in got && got.text.trim()) {
    return {
      source: "stt",
      text: got.text,
      ...(got.lang ? { lang: got.lang } : {}),
    };
  }
  logger.warn(
    { itemId: args.row.id, failed: "failed" in got ? got.failed : "empty" },
    "library light read: video NOT transcribed — the read keeps its text"
  );
  return null;
}
