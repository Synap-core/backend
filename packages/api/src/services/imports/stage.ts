/**
 * STAGE — the Collect step of Import → Curate → Build.
 *
 * Each item becomes ONE intake-source document (`stageIntakeSource`, the one
 * door that turns an intake input into a document) WITHOUT reading content:
 *   - a link keeps its URL as the body and a preview CARD on
 *     `metadata.importItem` (oEmbed / OpenGraph via `readPublicUrl` — title,
 *     a SHORT description, image, author). The page body is never stored here:
 *     Build reads it later, only for kept items;
 *   - typed text keeps the text (the person wrote it — it is the item);
 *   - a file keeps its bytes (inline ≤ `IMPORT_LIMITS.inlineFileBytesMax`), or
 *     ADOPTS a document the presigned upload lane already stored.
 *
 * Every staged document carries `intakeSource.pending = "awaiting_curation"`
 * (no capture/document list shows it, search skips it) and a default
 * `importCuration` ({ decision: "keep", groupKeys: [] }).
 *
 * Idempotent per (session, content hash): re-staging the same link, text or
 * bytes into the same import returns the existing item (`deduplicated`). The
 * session's run manifest gains every staged id, so `focusSessions.runSources`
 * lists the items. A refused item is NAMED with its index and reason; one bad
 * item never fails the batch.
 */

import { createHash } from "crypto";
import { createLogger } from "@synap-core/core";
import {
  db as defaultDb,
  documents,
  and,
  eq,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  IMPORT_LIMITS,
  IMPORT_STAGED_MARKER,
  importContentStatusFor,
  importHostOf,
  importPlatformOf,
  type ImportItemCard,
  type ImportItemCuration,
  type ImportItemMetadata,
  type ImportItemSource,
  type ImportStageItemInput,
} from "@synap-core/types/imports";
import {
  computeIntakeContentHash,
  stageIntakeSource,
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceKind,
  type IntakeSourceMetadata,
} from "../intake/stage-intake-source.js";
import { recordSessionRunManifest } from "../intake/record-session-run-manifest.js";
import {
  lonePublicHttpUrl,
  readPublicUrl,
  type PublicUrlRead,
} from "../capabilities/read-public-url.js";
import {
  IMPORT_ITEM_CURATION_KEY,
  IMPORT_ITEM_KEY,
  importItemsWhere,
} from "./read-model.js";
import type { ImportDb, ImportSessionRow } from "./session.js";

const logger = createLogger({ module: "imports/stage" });

/** The door every staged import item records (`intakeSource.door`). */
export const IMPORT_COLLECT_DOOR = "import";

const STAGE_CONCURRENCY = 4;
/** A card description is a preview, not the page. */
export const CARD_DESCRIPTION_MAX = 280;
const TITLE_MAX = 200;

export type ImportStageRefusal =
  | "import_full"
  | "invalid_url"
  | "empty_text"
  | "file_too_large"
  | "file_type_not_allowed"
  | "file_missing"
  | "document_not_found"
  | "document_in_other_import"
  | "note_too_long"
  | "stage_failed";

export interface ImportStageOutcome {
  staged: Array<{ itemId: string; deduplicated: boolean }>;
  refused: Array<{ index: number; reason: ImportStageRefusal }>;
}

export interface ImportStageDeps {
  /** Injected in tests; defaults to the SSRF-guarded public reader. */
  readUrl?: (url: string) => Promise<PublicUrlRead>;
}

function clip(
  text: string | undefined | null,
  max: number
): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/** A preview card from a public read — never the body. */
export function cardFromRead(
  read: PublicUrlRead,
  host: string | null
): ImportItemCard | undefined {
  if (read.kind !== "read") return host ? { siteName: host } : undefined;
  const card: ImportItemCard = {
    ...(read.title ? { title: clip(read.title, TITLE_MAX) } : {}),
    ...(read.text
      ? { description: clip(read.text, CARD_DESCRIPTION_MAX) }
      : {}),
    ...(read.imageUrl ? { imageUrl: read.imageUrl } : {}),
    ...(read.author ? { authorName: read.author } : {}),
    ...(host ? { siteName: host } : {}),
  };
  return Object.keys(card).length ? card : undefined;
}

function defaultCuration(note?: string): ImportItemCuration {
  return {
    decision: "keep",
    ...(note?.trim() ? { note: note.trim() } : {}),
    groupKeys: [],
  };
}

async function findStagedByHash(
  database: ImportDb,
  userId: string,
  sessionId: string,
  contentHash: string
): Promise<string | null> {
  const [row] = await database
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        importItemsWhere(userId, sessionId),
        drizzleSql`${documents.metadata} #>> '{intakeSource,contentHash}' = ${contentHash}`
      )
    )
    .limit(1);
  return row?.id ?? null;
}

type Prepared =
  | {
      kind: "stage";
      sourceKind: IntakeSourceKind;
      title: string;
      text?: string;
      url?: string;
      file?: { buffer: Buffer; mimeType: string; filename: string };
      contentHash: string;
      source: ImportItemSource;
      card?: ImportItemCard;
      note?: string;
      needsCard?: boolean;
    }
  | {
      kind: "adopt";
      documentId: string;
      title: string;
      source: ImportItemSource;
      note?: string;
      sha256?: string;
    }
  | { kind: "refuse"; reason: ImportStageRefusal };

async function prepare(item: ImportStageItemInput): Promise<Prepared> {
  if ((item.note?.length ?? 0) > IMPORT_LIMITS.itemNoteMax) {
    return { kind: "refuse", reason: "note_too_long" };
  }
  if (item.kind === "url") {
    const url = lonePublicHttpUrl(item.url ?? "");
    if (!url) return { kind: "refuse", reason: "invalid_url" };
    const normalized = new URL(url).toString();
    const host = importHostOf(normalized);
    const platform = importPlatformOf(normalized) ?? "web";
    const source: ImportItemSource = {
      kind: "url",
      url: normalized,
      ...(host ? { host } : {}),
      platform,
    };
    return {
      kind: "stage",
      sourceKind: "url",
      title: clip(item.title, TITLE_MAX) ?? "",
      // The URL IS the stored body: nothing of the page is kept at staging.
      text: normalized,
      url: normalized,
      contentHash: computeIntakeContentHash({
        kind: "url",
        url: normalized,
        text: normalized,
      }),
      source,
      needsCard: true,
      ...(item.note ? { note: item.note } : {}),
    };
  }
  if (item.kind === "text") {
    const text = item.text?.trim();
    if (!text) return { kind: "refuse", reason: "empty_text" };
    const firstLine = text.split("\n")[0] ?? text;
    return {
      kind: "stage",
      sourceKind: "text",
      title: clip(item.title, TITLE_MAX) ?? clip(firstLine, 80) ?? "Note",
      text,
      contentHash: computeIntakeContentHash({ kind: "text", text }),
      source: { kind: "text" },
      ...(item.note ? { note: item.note } : {}),
    };
  }
  // file
  const filename = item.filename?.trim() || "file";
  const mimeType = item.mimeType?.trim() || "application/octet-stream";
  if (item.documentId) {
    return {
      kind: "adopt",
      documentId: item.documentId,
      title: clip(filename, TITLE_MAX) ?? filename,
      source: {
        kind: "file",
        filename,
        mimeType,
        ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
      },
      ...(item.note ? { note: item.note } : {}),
      ...(item.sha256 ? { sha256: item.sha256.toLowerCase() } : {}),
    };
  }
  if (!item.contentBase64) return { kind: "refuse", reason: "file_missing" };
  // Size from the base64 length BEFORE decoding, so an oversize body is never
  // materialized in memory a second time.
  const approxBytes = Math.floor((item.contentBase64.length * 3) / 4);
  if (approxBytes > IMPORT_LIMITS.inlineFileBytesMax + 3) {
    return { kind: "refuse", reason: "file_too_large" };
  }
  const buffer = Buffer.from(item.contentBase64, "base64");
  if (buffer.length === 0) return { kind: "refuse", reason: "file_missing" };
  if (buffer.length > IMPORT_LIMITS.inlineFileBytesMax) {
    return { kind: "refuse", reason: "file_too_large" };
  }
  if (!(await isImportableMime(mimeType))) {
    return { kind: "refuse", reason: "file_type_not_allowed" };
  }
  return {
    kind: "stage",
    sourceKind: "file",
    title: clip(filename, TITLE_MAX) ?? filename,
    file: { buffer, mimeType, filename },
    contentHash: computeIntakeContentHash({ kind: "file", bytes: buffer }),
    source: { kind: "file", filename, mimeType, sizeBytes: buffer.length },
    ...(item.note ? { note: item.note } : {}),
  };
}

/** The upload door's allowlist (images, video and audio included) — the one rule for an import file. */
export async function isImportableMime(mimeType: string): Promise<boolean> {
  const { isAllowedMimeType } = await import("../../routers/file-upload.js");
  return isAllowedMimeType(mimeType);
}

/** Stage one prepared item. Returns the item id, or throws. */
async function stageOne(args: {
  database: ImportDb;
  userId: string;
  session: ImportSessionRow;
  prepared: Extract<Prepared, { kind: "stage" }>;
  readUrl: (url: string) => Promise<PublicUrlRead>;
  /** Take one slot of the import's item cap; false = the import is full. */
  claimRoom: () => boolean;
}): Promise<
  { itemId: string; deduplicated: boolean } | { refused: ImportStageRefusal }
> {
  const { database, userId, session, prepared } = args;
  // Dedup BEFORE any outbound read: a re-sent link costs nothing.
  const existing = await findStagedByHash(
    database,
    userId,
    session.id,
    prepared.contentHash
  );
  if (existing) return { itemId: existing, deduplicated: true };
  if (!args.claimRoom()) return { refused: "import_full" };

  let card = prepared.card;
  let title = prepared.title;
  if (prepared.needsCard && prepared.url) {
    let read: PublicUrlRead = { kind: "unavailable", sourceUrl: prepared.url };
    try {
      read = await args.readUrl(prepared.url);
    } catch (err) {
      // A preview that could not be read is a card-less item, not a failure.
      logger.warn(
        { err, url: prepared.url },
        "import stage: preview read failed"
      );
    }
    card = cardFromRead(read, prepared.source.host ?? null);
    title = title || card?.title || prepared.source.host || prepared.url;
  }
  const source = prepared.source;
  const importItem: ImportItemMetadata = {
    version: 1,
    title: title || "Untitled",
    source,
    ...(card ? { card } : {}),
    contentStatus: importContentStatusFor(source),
    stagedAt: new Date().toISOString(),
  };
  const staged = await stageIntakeSource({
    database,
    userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    door: IMPORT_COLLECT_DOOR,
    kind: prepared.sourceKind,
    title: importItem.title,
    ...(prepared.text !== undefined ? { text: prepared.text } : {}),
    ...(prepared.url ? { url: prepared.url } : {}),
    ...(prepared.file
      ? {
          file: {
            buffer: prepared.file.buffer,
            mimeType: prepared.file.mimeType,
            filename: prepared.file.filename,
            keepBytes: true,
          },
        }
      : {}),
    pending: IMPORT_STAGED_MARKER,
    extraMetadata: {
      [IMPORT_ITEM_KEY]: importItem,
      [IMPORT_ITEM_CURATION_KEY]: defaultCuration(prepared.note),
    },
  });
  return { itemId: staged.documentId, deduplicated: staged.deduplicated };
}

/**
 * ADOPT a document the presigned upload lane stored: stamp it as this import's
 * staged item (intake source + marker + preview + default curation). Owner
 * floored; a document already staged in ANOTHER import is refused, one already
 * in this import is a dedup.
 */
async function adoptOne(args: {
  database: ImportDb;
  userId: string;
  session: ImportSessionRow;
  prepared: Extract<Prepared, { kind: "adopt" }>;
  claimRoom: () => boolean;
}): Promise<
  { itemId: string; deduplicated: boolean } | { refused: ImportStageRefusal }
> {
  const { database, userId, session, prepared } = args;
  return database.transaction(async (tx) => {
    const [doc] = await tx
      .select({
        id: documents.id,
        metadata: documents.metadata,
        mimeType: documents.mimeType,
        size: documents.size,
        storageKey: documents.storageKey,
        title: documents.title,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, prepared.documentId),
          eq(documents.userId, userId),
          isNull(documents.deletedAt)
        )
      )
      .for("update")
      .limit(1);
    if (!doc || !doc.storageKey)
      return { refused: "document_not_found" as const };
    const meta = (doc.metadata ?? {}) as Record<string, unknown>;
    const existingSource = meta[INTAKE_SOURCE_METADATA_KEY] as
      IntakeSourceMetadata | undefined;
    if (existingSource) {
      return existingSource.sessionId === session.id && meta[IMPORT_ITEM_KEY]
        ? { itemId: doc.id, deduplicated: true }
        : { refused: "document_in_other_import" as const };
    }
    const mimeType = doc.mimeType ?? prepared.source.mimeType;
    if (!mimeType || !(await isImportableMime(mimeType))) {
      return { refused: "file_type_not_allowed" as const };
    }
    if (!args.claimRoom()) return { refused: "import_full" as const };
    const source: ImportItemSource = {
      ...prepared.source,
      ...(mimeType ? { mimeType } : {}),
      sizeBytes: doc.size,
    };
    const contentHash =
      prepared.sha256 ??
      createHash("sha256").update(`file\0${doc.storageKey}`).digest("hex");
    const intakeSource: IntakeSourceMetadata = {
      version: 1,
      kind: "file",
      contentHash,
      sessionId: session.id,
      door: IMPORT_COLLECT_DOOR,
      ...(source.filename ? { filename: source.filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(prepared.sha256 ? { fileSha256: prepared.sha256 } : {}),
      pending: IMPORT_STAGED_MARKER,
    };
    const importItem: ImportItemMetadata = {
      version: 1,
      title: prepared.title,
      source,
      contentStatus: "file",
      stagedAt: new Date().toISOString(),
    };
    await tx
      .update(documents)
      .set({
        metadata: {
          ...meta,
          [INTAKE_SOURCE_METADATA_KEY]: intakeSource,
          [IMPORT_ITEM_KEY]: importItem,
          [IMPORT_ITEM_CURATION_KEY]: defaultCuration(prepared.note),
        },
        updatedAt: new Date(),
      })
      .where(eq(documents.id, doc.id));
    return { itemId: doc.id, deduplicated: false };
  });
}

async function countItems(
  database: ImportDb,
  userId: string,
  sessionId: string
): Promise<number> {
  const [row] = await database
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(documents)
    .where(importItemsWhere(userId, sessionId));
  return Number(row?.n ?? 0);
}

/** Stage a batch into an OPEN import session. */
export async function stageImportItems(args: {
  database?: ImportDb;
  userId: string;
  session: ImportSessionRow;
  items: readonly ImportStageItemInput[];
  deps?: ImportStageDeps;
}): Promise<ImportStageOutcome> {
  const database = args.database ?? defaultDb;
  const readUrl = args.deps?.readUrl ?? ((url: string) => readPublicUrl(url));
  const out: ImportStageOutcome = { staged: [], refused: [] };
  const results: Array<
    | { index: number; itemId: string; deduplicated: boolean }
    | { index: number; reason: ImportStageRefusal }
  > = [];

  // Room left in the import. Dedups do not consume it, so a batch that only
  // re-sends known items is never refused for size. Claimed synchronously after
  // each item's dedup check, so concurrent items never overshoot the cap.
  let room =
    IMPORT_LIMITS.itemsMax -
    (await countItems(database, args.userId, args.session.id));
  const claimRoom = () => {
    if (room <= 0) return false;
    room -= 1;
    return true;
  };

  // Prepared (base64 decoded) one wave at a time, so a batch of inline files
  // never holds more than STAGE_CONCURRENCY decoded buffers at once.
  for (let start = 0; start < args.items.length; start += STAGE_CONCURRENCY) {
    const wave = args.items.slice(start, start + STAGE_CONCURRENCY);
    const waveResults = await Promise.all(
      wave.map(async (item, offset) => {
        const index = start + offset;
        try {
          const p = await prepare(item);
          if (p.kind === "refuse") return { index, reason: p.reason };
          const r =
            p.kind === "adopt"
              ? await adoptOne({
                  database,
                  userId: args.userId,
                  session: args.session,
                  prepared: p,
                  claimRoom,
                })
              : await stageOne({
                  database,
                  userId: args.userId,
                  session: args.session,
                  prepared: p,
                  readUrl,
                  claimRoom,
                });
          return "refused" in r
            ? { index, reason: r.refused }
            : { index, ...r };
        } catch (err) {
          logger.error(
            { err, sessionId: args.session.id, index },
            "import stage: item NOT staged"
          );
          return { index, reason: "stage_failed" as const };
        }
      })
    );
    results.push(...waveResults);
  }

  for (const r of results.sort((a, b) => a.index - b.index)) {
    if ("itemId" in r) {
      out.staged.push({ itemId: r.itemId, deduplicated: r.deduplicated });
    } else {
      out.refused.push({ index: r.index, reason: r.reason });
    }
  }

  const newIds = out.staged.filter((s) => !s.deduplicated).map((s) => s.itemId);
  if (newIds.length > 0) {
    // Nothing was structured: the run is deterministic until Build answers.
    const recorded = await recordSessionRunManifest({
      database,
      sessionId: args.session.id,
      userId: args.userId,
      patch: {
        sourceDocumentIds: newIds,
        engine: "deterministic",
        model: null,
        provider: null,
        promptVersion: "none",
      },
    });
    if (!recorded.ok) {
      logger.error(
        { sessionId: args.session.id, reason: recorded.reason },
        "import stage: run manifest NOT recorded — runSources will not list these items"
      );
    }
  }
  return out;
}
