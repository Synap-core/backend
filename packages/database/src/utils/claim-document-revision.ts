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

import { randomUUID } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { storage } from "@synap/storage";
import { checksumMatchesContent, fileChecksum } from "@synap/storage/checksum";
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
import {
  DocumentRepository,
  type CreateDocumentInput,
} from "../repositories/document-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import type { Document } from "../schema/documents.js";

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

/** The storage checksum format (`sha256:<hex>`) — the one every provider stamps. */
export function documentContentChecksum(content: string | Buffer): string {
  return fileChecksum(content);
}

/**
 * The two pod-cut checkpoints — the ONE place their options live, so the
 * callers (realtime room close, the autosave cron) and the door's test run the
 * same claim. Both are skip-if-unchanged: a document nobody edited never gets
 * a row, whatever the cadence.
 */
export const ROOM_CLOSE_CHECKPOINT = {
  checkpoint: { message: "Saved when editing ended" },
  skipIfUnchanged: true,
} as const satisfies ClaimDocumentRevisionOptions;

export const AUTOSAVE_CHECKPOINT = {
  checkpoint: { message: "Auto-save checkpoint" },
  skipIfUnchanged: true,
} as const satisfies ClaimDocumentRevisionOptions;

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
      !!lastRow && checksumMatchesContent(lastRow.checksum, current);
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
    // A write that leaves the body byte-identical to what is stored adds no
    // history: the row that already holds this content (the last checkpoint, or
    // the drift captured just below) stands for it, so `current_version` moves
    // only for a real change.
    let unchangedWrite = false;
    if (authorSwitched || options.checkpoint) {
      // Capture the content as it stands, under the author who wrote it, when
      // it drifted from their last checkpoint (their same-author saves since).
      const pre = await readPre();
      unchangedWrite = pre.equals(next);
      if (lastRow && checksumMatchesContent(lastRow.checksum, pre)) {
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

    if (unchangedWrite) {
      checkpointVersionId = undoVersionId;
    } else if (authorSwitched || options.checkpoint) {
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

// ---------------------------------------------------------------------------
// THE create door
// ---------------------------------------------------------------------------

/** Who a new document's first version belongs to (row provenance + v1 author). */
export interface DocumentCreateProvenance {
  createdByKind: "human" | "ai_agent" | "system";
  /** Defaults to the owner. */
  createdByUserId?: string;
  agentUserId?: string;
  sourceProposalId?: string;
  correlationId?: string;
}

/**
 * What a creator gets back — only what callers read. The row's other columns
 * are not part of the door's contract (the row itself is the repo's).
 */
export type CreatedDocument = Pick<
  Document,
  "id" | "title" | "contentRevision" | "metadata"
>;

export interface CreateDocumentWithContentInput {
  /** A pre-chosen id (idempotent callers); a fresh uuid otherwise. */
  id?: string;
  /** `documents.user_id`, and the storage namespace of the body. */
  ownerUserId: string;
  /** `null`/absent = pod-wide. */
  workspaceId?: string | null;
  title: string;
  /** `documents.type` (a free text column: markdown, html, code, …). */
  type: string;
  content: string;
  mimeType: string;
  /** Storage key extension; derived from `type` when absent (`markdown` → `md`). */
  extension?: string;
  language?: string;
  metadata?: Record<string, unknown>;
  provenance: DocumentCreateProvenance;
}

/** Storage extension for a document type (`markdown` → `md`). */
function extensionFor(type: string): string {
  return type === "markdown" ? "md" : type;
}

/**
 * createDocumentWithContent — THE create door for a text document with a body.
 *
 * The companion of {@link claimDocumentRevision}: that door REPLACES a live
 * body; this one BRINGS ONE INTO EXISTENCE. It owns the three steps every
 * creator used to hand-roll (routers/documents create + upload, the hub
 * `createDocument`, the promote door, the approval materializer, intake, the
 * session document, the entity body service, the html cell doors):
 *   1. the upload to a FRESH key (`<owner>/document/<new id>.<ext>`) — never
 *      over an existing `storage_key`;
 *   2. the row insert and 3. the immutable v1 checkpoint, atomically, with the
 *      v1 author derived from provenance (`initialVersionAuthor` — an agent's
 *      document is authored `ai`), via `DocumentRepository.create`, which also
 *      emits `document.create.completed`.
 *
 * Why not create-then-claim: on a document with no version rows the claim door
 * would cut a phantom empty pre-image checkpoint — a history step nobody wrote.
 *
 * `dbOrTx`: pass the caller's transaction to create the document atomically with
 * the caller's own writes (the promote door re-points an entity in the same tx).
 * The upload is not transactional; a rolled-back create leaves an unreferenced
 * blob under a key no row will ever name, never a live body overwritten.
 *
 * Tripwire: `document-content-one-door` allows a document-content upload ONLY
 * in this module.
 */
export async function createDocumentWithContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dbOrTx: any,
  eventRepo: EventRepository,
  input: CreateDocumentWithContentInput
): Promise<CreatedDocument> {
  const id = input.id ?? randomUUID();
  const key = storage.buildPath(
    input.ownerUserId,
    "document",
    id,
    input.extension ?? extensionFor(input.type)
  );
  const stored = await storage.upload(key, input.content, {
    contentType: input.mimeType,
  });
  const doc = await new DocumentRepository(dbOrTx, eventRepo).create(
    {
      id,
      title: input.title,
      // The DB column is free text; "html" is stored verbatim, as before.
      type: input.type as CreateDocumentInput["type"],
      language: input.language,
      storageUrl: stored.url,
      storageKey: stored.path,
      size: stored.size,
      mimeType: input.mimeType,
      metadata: input.metadata,
      userId: input.ownerUserId,
      workspaceId: input.workspaceId ?? null,
      content: input.content,
      createdByKind: input.provenance.createdByKind,
      createdByUserId: input.provenance.createdByUserId ?? input.ownerUserId,
      agentUserId: input.provenance.agentUserId,
      sourceProposalId: input.provenance.sourceProposalId,
      correlationId: input.provenance.correlationId,
    },
    input.ownerUserId
  );
  return {
    id: doc.id,
    title: doc.title,
    contentRevision: doc.contentRevision,
    metadata: doc.metadata,
  };
}
