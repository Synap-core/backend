/**
 * claimDocumentRevision — THE content-write door for a document.
 *
 * Every write that replaces a document's stored content goes through here: a
 * human save, a collaborative write-back, a version restore, an approved AI
 * edit, a section write, a checkpoint snapshot. The door does four things, in
 * one transaction:
 *
 *   1. COMPARE-AND-SET on `documents.content_revision` (and, for proposals filed
 *      before revisions existed, on the legacy `current_version`). A writer that
 *      read an older revision gets `DocumentRevisionConflictError` and nothing is
 *      written. The UPDATE also row-locks the document, so concurrent writers are
 *      serialised even when neither passes a base.
 *   2. AUTHOR-SWITCH CHECKPOINTS (documents-centerpiece plan §5.1). History rows
 *      are cut only when they carry information: when the writer differs from the
 *      author of the last checkpoint, the content as it stands is first captured
 *      under the PREVIOUS author (only if it drifted from that checkpoint), and the
 *      new content becomes a row under the NEW author. Same-author saves stay
 *      cheap and add no rows. Invariant: the author of the latest row is the last
 *      content writer — which is what makes blame over the chain honest.
 *   3. The storage upload over `documents.storage_key`. The tripwire
 *      `document-content-one-door.tripwire.test.ts` forbids that upload anywhere
 *      else.
 *   4. The Yjs cache marker: a collaborative write-back (the room's leader wrote
 *      the room's own content) marks `working_state` as current; every other
 *      writer leaves the marker behind, so a stale Yjs cache is never loaded over
 *      newer markdown.
 *
 * `current_version` keeps its meaning: the latest CHECKPOINT row. It moves only
 * when this door cuts a row.
 */

import { createHash, randomUUID } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { storage } from "@synap/storage";
import type { db } from "../client-pg.js";
import {
  documents,
  documentVersions,
  type DocumentVersionAuthor,
} from "../schema/documents.js";
import {
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "./document-version-storage.js";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who is writing. `authorId` is the agent id for `ai`, the user id for `user`. */
export interface DocumentWriteAuthor {
  authorKind: DocumentVersionAuthor;
  authorId: string;
}

/**
 * For a checkpoint-only claim cut by the pod (autosave cron, room close): the
 * row goes to the last checkpoint's author. By the door's invariant (an author
 * switch always cuts a row) that is who wrote the drift being checkpointed.
 */
export const INHERIT_LAST_AUTHOR = "inherit-last-author" as const;

/**
 * The content moved past what the writer read. Duck-typed as a SynapError
 * (`code` + `statusCode`) so the tRPC error middleware maps it to CONFLICT and
 * the Hub routes answer 409 — the writer's cue to re-read.
 */
export class DocumentRevisionConflictError extends Error {
  readonly code = "CONFLICT";
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "DocumentRevisionConflictError";
  }
}

export class DocumentWriteTargetError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: "NOT_FOUND" | "BAD_REQUEST",
    message: string
  ) {
    super(message);
    this.name = "DocumentWriteTargetError";
    this.statusCode = code === "NOT_FOUND" ? 404 : 400;
  }
}

export interface ClaimDocumentRevisionOptions {
  /**
   * The new content. Omit for a checkpoint-only claim (snapshot): the current
   * stored content is checkpointed and the revision does not move.
   */
  content?: string | Buffer;
  /**
   * Legacy base: the `current_version` a proposal filed before content
   * revisions recorded. Checked in the same compare-and-set.
   */
  baseVersion?: number;
  /** Cut a checkpoint row for THIS write, with this message (approval, restore, section, snapshot). */
  checkpoint?: { message: string };
  /** Content type for the upload; defaults to the document's own. */
  mimeType?: string;
  /**
   * The realtime room's leader writing the room's own content back as
   * markdown: the Yjs cache is then known to equal the new revision.
   */
  source?: "collab-writeback";
  /** The content the caller already read (saves a storage read when a pre-image is needed). */
  preContent?: string | Buffer;
  /** Checkpoint-only claims: add no row when the content equals the last checkpoint. */
  skipIfUnchanged?: boolean;
}

export interface ClaimedDocumentRevision {
  documentId: string;
  workspaceId: string | null;
  ownerUserId: string;
  /** `content_revision` after this claim. */
  revision: number;
  /** `current_version` (latest checkpoint) after this claim. */
  currentVersion: number;
  /** The checkpoint row this claim cut for the NEW content, if any. */
  checkpointVersionId: string | null;
  /**
   * The row holding the content from BEFORE this write, when a checkpoint or an
   * author switch made the door look (the undo target). Null for a same-author
   * save, which never reads the pre-image.
   */
  undoVersionId: string | null;
  /** True when the writer differs from the author of the last checkpoint. */
  authorSwitched: boolean;
  /** True when content changed (a real replace — open editors must hear of it). */
  contentChanged: boolean;
  /** Checkpoint-only claim that found nothing new to record. */
  skipped: boolean;
}

/** The storage checksum format (`sha256:<hex>`), so rows and content compare directly. */
export function documentContentChecksum(content: string | Buffer): string {
  const buf = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf-8");
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

function toBuffer(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
}

/**
 * Claim the next content revision of `documentId` and write through it.
 *
 * `baseRevision` = the `content_revision` the writer read; `undefined` =
 * unchecked (a writer with nothing to compare, e.g. a proposal filed before
 * revisions existed — it still applies, as it always did).
 */
export async function claimDocumentRevision(
  tx: DbTx,
  documentId: string,
  baseRevision: number | undefined,
  writer: DocumentWriteAuthor | typeof INHERIT_LAST_AUTHOR,
  options: ClaimDocumentRevisionOptions = {}
): Promise<ClaimedDocumentRevision> {
  const writesContent = options.content !== undefined;
  if (writer === INHERIT_LAST_AUTHOR && writesContent) {
    throw new Error(
      "claimDocumentRevision: a content write must name its author; only a checkpoint-only claim may inherit"
    );
  }
  const collab = options.source === "collab-writeback";

  const conditions = [eq(documents.id, documentId)];
  if (baseRevision !== undefined) {
    conditions.push(eq(documents.contentRevision, baseRevision));
  }
  if (options.baseVersion !== undefined) {
    conditions.push(eq(documents.currentVersion, options.baseVersion));
  }

  // 1. The compare-and-set, which also row-locks the document for the rest of
  //    the transaction. A checkpoint-only claim moves nothing but still locks.
  const [claimed] = await tx
    .update(documents)
    .set({
      contentRevision: writesContent
        ? sql`${documents.contentRevision} + 1`
        : sql`${documents.contentRevision}`,
      ...(writesContent ? { updatedAt: new Date() } : {}),
      ...(writesContent && collab
        ? { workingStateRevision: sql`${documents.contentRevision} + 1` }
        : {}),
    })
    .where(and(...conditions))
    .returning({
      id: documents.id,
      userId: documents.userId,
      workspaceId: documents.workspaceId,
      type: documents.type,
      mimeType: documents.mimeType,
      storageKey: documents.storageKey,
      contentRevision: documents.contentRevision,
      currentVersion: documents.currentVersion,
    });

  if (!claimed) {
    const [exists] = await tx
      .select({
        contentRevision: documents.contentRevision,
        currentVersion: documents.currentVersion,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!exists) {
      throw new DocumentWriteTargetError("NOT_FOUND", "Document not found");
    }
    const drafted =
      baseRevision !== undefined
        ? `revision ${baseRevision}, now revision ${exists.contentRevision}`
        : `version ${options.baseVersion}, now version ${exists.currentVersion}`;
    throw new DocumentRevisionConflictError(
      `This document changed after the edit was drafted (drafted against ${drafted}). ` +
        "Nothing was applied — reload the document and draft the edit again."
    );
  }

  if (!claimed.storageKey) {
    throw new DocumentWriteTargetError(
      "BAD_REQUEST",
      "This document has no stored content (an external reference); there is nothing to write."
    );
  }
  const storageKey = claimed.storageKey;
  const mimeType = options.mimeType || claimed.mimeType || "text/plain";

  // 2. The last checkpoint — its author is, by the invariant above, the last
  //    content writer.
  const [lastRow] = await tx
    .select({
      id: documentVersions.id,
      version: documentVersions.version,
      author: documentVersions.author,
      authorId: documentVersions.authorId,
      checksum: documentVersions.checksum,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.version), desc(documentVersions.createdAt))
    .limit(1);

  const author: DocumentWriteAuthor =
    writer !== INHERIT_LAST_AUTHOR
      ? writer
      : lastRow
        ? { authorKind: lastRow.author, authorId: lastRow.authorId }
        : { authorKind: "system", authorId: "checkpoint" };

  const authorSwitched =
    !lastRow ||
    lastRow.author !== author.authorKind ||
    lastRow.authorId !== author.authorId;

  let version = Math.max(claimed.currentVersion, lastRow?.version ?? 0);
  const startVersion = claimed.currentVersion;

  const insertRow = async (
    content: Buffer,
    rowAuthor: DocumentWriteAuthor,
    message: string | null,
    /** Fill this exact version number (a checkpoint the row table never got). */
    atVersion?: number
  ): Promise<string> => {
    const versionId = randomUUID();
    if (atVersion === undefined) version += 1;
    const snapshot = await uploadDocumentVersionSnapshot({
      userId: claimed.userId,
      documentId,
      versionId,
      documentType: claimed.type,
      mimeType,
      content,
    });
    await tx.insert(documentVersions).values({
      id: versionId,
      documentId,
      version: atVersion ?? version,
      ...storedVersionValues(snapshot),
      author: rowAuthor.authorKind,
      authorId: rowAuthor.authorId,
      message,
    });
    return versionId;
  };

  const readPre = async (): Promise<Buffer> =>
    options.preContent !== undefined
      ? toBuffer(options.preContent)
      : storage.downloadBuffer(storageKey);

  let undoVersionId: string | null = null;
  let checkpointVersionId: string | null = null;
  let skipped = false;

  if (!writesContent) {
    // Checkpoint-only (snapshot). The content is whatever the last writer
    // left; the row is attributed to the author passed in (Cmd+S: the saver;
    // the autosave cron passes the last checkpoint's author).
    const current = await readPre();
    const unchanged =
      !!lastRow && lastRow.checksum === documentContentChecksum(current);
    if (unchanged && options.skipIfUnchanged) {
      skipped = true;
    } else {
      checkpointVersionId = await insertRow(
        current,
        author,
        options.checkpoint?.message ?? null
      );
    }
  } else {
    const next = toBuffer(options.content!);
    if (authorSwitched || options.checkpoint) {
      // Capture the content as it stands, under the author who wrote it, when
      // it drifted from their last checkpoint (their same-author saves since).
      const pre = await readPre();
      if (lastRow && lastRow.checksum === documentContentChecksum(pre)) {
        undoVersionId = lastRow.id;
      } else {
        // `current_version` names a checkpoint no row holds (a document created
        // without its v1 row): the pre-image fills THAT number rather than
        // inventing a new one, so the rail has no hole and no phantom step.
        const holeAtCurrent =
          !lastRow || lastRow.version < claimed.currentVersion;
        undoVersionId = await insertRow(
          pre,
          lastRow
            ? { authorKind: lastRow.author, authorId: lastRow.authorId }
            : { authorKind: "system", authorId: "pre-image" },
          authorSwitched
            ? "Checkpoint before a change by another author"
            : "Checkpoint before this change",
          holeAtCurrent ? claimed.currentVersion : undefined
        );
      }
    }

    // THE upload over a document's body — the only one allowed (tripwire
    // `document-content-one-door`, which keys on this `.storageKey` shape).
    await storage.upload(claimed.storageKey, next, { contentType: mimeType });

    if (authorSwitched || options.checkpoint) {
      checkpointVersionId = await insertRow(
        next,
        author,
        options.checkpoint?.message ?? null
      );
    }
  }

  if (version !== startVersion) {
    await tx
      .update(documents)
      .set({ currentVersion: version, lastSavedVersion: version })
      .where(eq(documents.id, documentId));
  }

  return {
    documentId,
    workspaceId: claimed.workspaceId,
    ownerUserId: claimed.userId,
    revision: claimed.contentRevision,
    currentVersion: version,
    checkpointVersionId,
    undoVersionId,
    authorSwitched,
    contentChanged: writesContent,
    skipped,
  };
}
