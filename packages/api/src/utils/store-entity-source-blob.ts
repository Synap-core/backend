/**
 * storeEntitySourceBlob — ONE door for "attach a raw source file to an entity
 * as provenance" (capture keepRaw, Superwhisper WAV archive, future intake).
 *
 * ── Three phases, so a GOVERNED capture can keep its file ──────────────────
 * The door is split into the three phases a proposal needs, because the write
 * and the approval happen at different times:
 *
 *   stageSourceBlob()    bytes → object storage + a `documents` row. Touches NO
 *                        entity. This is what makes a governed capture possible
 *                        at all: the proposal carries a small REFERENCE
 *                        (documentId/url/size/mime/name), never megabytes of
 *                        base64 in `proposals.data` JSONB — proposal LIST reads
 *                        select `data`, so inlining a 7MB payload would drag it
 *                        through every list.
 *   attachSourceBlob()   staged ref → the entity (properties + documentId).
 *                        Called on the granted path immediately, and on approval
 *                        from BOTH halves of the review path: the composite
 *                        branch of `applyProposalApproval` (a capture that
 *                        proposed new entities) and the `entity/update` executor
 *                        (a capture that proposed onto an existing entity).
 *   discardSourceBlob()  delete the object + the `documents` row. Called when
 *                        the gate DENIES, and — through
 *                        `discardProposalSourceBlob` — from EVERY door that
 *                        writes a terminal proposal status without attaching:
 *                        `reject`, `batchReject`, `withdraw`, both expiry
 *                        scanners, and the partial-approval branch that
 *                        materialized no entity to attach to. So a staged blob
 *                        never outlives the decision that ended its proposal.
 *                        (`__tripwires__/source-blob-ownership-and-terminal-discard`
 *                        derives that door list from `ProposalStatus` itself.)
 *
 * Producers of the staged reference: `storeEntitySourceBlob` below (the direct
 * door, on a `proposed` verdict) and `capture.execute`'s propose branch via
 * `fileAnchoredCaptureProposals`.
 *
 * `storeEntitySourceBlob` composes them (stage → gate → attach) and remains the
 * door every direct caller uses.
 *
 * GOVERNED: the write it performs is a mutation of an existing entity's
 * `properties` (+ `documentId`), so it goes through `checkPermissionOrPropose`
 * as `entity`/`update` — the same governed door `entities.update` uses. A
 * first-party human write is auto-approved exactly as before; an AGENT write is
 * now scored by the governance ladder instead of mutating `entities.properties`
 * ungoverned. There is NO bypass parameter: every caller of this door is gated.
 *
 * ── OWNERSHIP: the documentId is attacker-reachable, so it is never trusted ──
 * `attachSourceBlob` and `discardSourceBlob` are reached with a `documentId` /
 * `storageKey` that travelled through `proposals.data.sourceFile` — a JSONB
 * blob a reviser can patch. Neither may act on a caller-supplied identifier: the
 * `documents` row is LOADED and its `userId` must match the acting user before
 * anything is linked or deleted, and the storage key deleted is the one on the
 * LOADED row, never the one the caller passed. Without this, pointing an
 * attacker-owned entity at a victim's `documentId` handed over the victim's
 * bytes through `GET /api/files/entities/:id/url` (which authorizes on the
 * entity, by design) and let a crafted `storageKey` delete a victim's object.
 *
 * ── entity.documentId (T3) ────────────────────────────────────────────────
 * `entities.documentId` is the entity's BODY link (EntityBodyService owns it),
 * and it is ALSO the key the embedding worker, the retrieval join, and Typesense
 * enrichment all read — a source blob that never sets it is invisible to all
 * three. So it is set, but only with a `WHERE document_id IS NULL` guard: an
 * existing body document is NEVER clobbered. That guard is expressed in SQL
 * rather than read-then-write precisely so a concurrent `setBody` cannot lose.
 *
 * Merges into `entity.properties`:
 *   - sourceFileDocumentId
 *   - sourceFileUrl
 *   - sourceFileSize (bytes)
 *   - sourceFileMimeType
 *   - sourceFileName (optional)
 *
 * Binary provenance deliberately skips the document-version snapshot path used
 * by uploadBufferAsFileEntity (would double object-storage for large media).
 *
 * Best-effort semantics are the CALLER's choice: capture keepRaw swallows
 * errors; bulk import may surface them per unit.
 */

import { createLogger } from "@synap-core/core";
import {
  DocumentRepository,
  EntityRepository,
  documentVersionSnapshotFromUpload,
  documents as documentsTable,
  entities as entitiesTable,
  eventRepository,
  and,
  eq,
  isNull,
  type db as DbType,
} from "@synap/database";
import { randomUUID } from "crypto";
import {
  checkPermissionOrPropose,
  type PermissionResult,
} from "./permission-check.js";

const logger = createLogger({ module: "store-entity-source-blob" });

/** Default max for provenance blobs (audio dogfood — covers Superwhisper max ~25MB). */
export const SOURCE_BLOB_MAX_BYTES = 32 * 1024 * 1024;

export class SourceBlobTooLargeError extends Error {
  readonly code = "SOURCE_BLOB_TOO_LARGE" as const;
  constructor(
    readonly size: number,
    readonly maxBytes: number = SOURCE_BLOB_MAX_BYTES
  ) {
    super(
      `Source blob too large (${(size / 1024 / 1024).toFixed(2)}MB > max ${maxBytes / 1024 / 1024}MB)`
    );
    this.name = "SourceBlobTooLargeError";
  }
}

/** A hard RBAC/CBAC denial of the attach. The staged blob has been discarded. */
export class SourceBlobDeniedError extends Error {
  readonly code = "SOURCE_BLOB_DENIED" as const;
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SourceBlobDeniedError";
  }
}

/**
 * The `documents` row named by a staged reference does not belong to the acting
 * user (or the reference names no document at all). ALWAYS a refusal — never
 * downgraded to a warn, because the only way to reach it is a reference that
 * crossed a tenant boundary.
 */
export class SourceBlobOwnershipError extends Error {
  readonly code = "SOURCE_BLOB_NOT_OWNED" as const;
  constructor(
    readonly documentId: string,
    readonly userId: string
  ) {
    super(
      `Source blob document ${documentId} is not owned by the acting user — refusing`
    );
    this.name = "SourceBlobOwnershipError";
  }
}

export class SourceBlobEmptyError extends Error {
  readonly code = "SOURCE_BLOB_EMPTY" as const;
  constructor() {
    super("Source blob is empty");
    this.name = "SourceBlobEmptyError";
  }
}

export interface StageSourceBlobInput {
  database: typeof DbType;
  userId: string;
  buffer: Buffer;
  mimeType: string;
  filename?: string;
  /** Ambient workspace for the document row only (entity may be pod-wide). */
  workspaceId?: string | null;
  /** Override size cap (tests / special doors). Default SOURCE_BLOB_MAX_BYTES. */
  maxBytes?: number;
  /**
   * Storage-key namespace. Historically the key was derived from the entity id
   * (`.../entity/<entityId>.<ext>`); a STAGED blob has no entity yet, so the
   * caller passes the capture/correlation id instead. Both land in the same
   * per-user prefix, so nothing about retrieval or cleanup changes.
   */
  keyScope: string;
  /**
   * Text already extracted from `buffer` upstream — the IS `/api/structure`
   * extraction pass (`extraction.text` for PDF/DOCX/image/audio).
   *
   * When present it is persisted as the v1 `document_versions.content`, which is
   * what makes an attached binary VISIBLE to the three consumers that read that
   * column: the entity-embedding worker, the retrieval body join, and Typesense
   * enrichment. Without it a PDF attached to an entity is, to all three, an
   * empty document. The ORIGINAL bytes are still the stored object — the text
   * only fills the text column (see `documentVersionSnapshotFromUpload`).
   */
  extractedText?: string;
  /**
   * The upstream extractor truncated `extractedText`. Recorded on the document's
   * `metadata` so "this body is partial" is a durable fact rather than a
   * silently-short string — a reader cannot otherwise tell a 64k clip from a
   * complete 64k document.
   */
  extractedTextTruncated?: boolean;
}

/**
 * A blob whose bytes + `documents` row exist, but which is not yet attached to
 * any entity. This is the object that travels inside `proposals.data.sourceFile`
 * — small, JSON-safe, and enough to attach on approval or to clean up on reject.
 */
export interface StagedSourceBlob {
  documentId: string;
  storageKey: string;
  storageUrl: string;
  size: number;
  mimeType: string;
  filename?: string;
}

export interface StoreEntitySourceBlobInput extends Omit<
  StageSourceBlobInput,
  "keyScope"
> {
  entityId: string;
  /** Storage-key namespace. Defaults to `entityId` (the historical key shape). */
  keyScope?: string;
  /** Shared id joining this write to the capture that produced it. */
  correlationId?: string;
  sessionId?: string;
}

export type StoreEntitySourceBlobResult =
  | ({ status: "stored" } & StagedSourceBlob)
  | {
      /**
       * Governance parked the attach. The blob IS staged (bytes + document row
       * exist) and its reference rides the proposal, so approval attaches it —
       * the file is not lost. `proposals.reject` discards it.
       */
      status: "proposed";
      proposalId: string;
      proposalType: string;
      reviewUrl: string;
      staged: StagedSourceBlob;
    };

function extFromMime(mimeType: string): string {
  const raw = (mimeType.split("/")[1] || "bin").split(";")[0].split("+")[0];
  // audio/wav → wav; audio/mpeg → mpeg (ok); video/quicktime → quicktime
  if (raw === "mpeg" && mimeType.startsWith("audio/")) return "mp3";
  if (raw === "mp4" && mimeType.startsWith("audio/")) return "m4a";
  if (raw === "x-wav" || raw === "wave") return "wav";
  return raw || "bin";
}

/**
 * Map mime → documents.type (schema comment: text|markdown|code|pdf|docx).
 * Binary media is stored with type "text" + real mimeType column — same as
 * historical keepRaw behaviour for non-PDF blobs.
 */
function documentTypeForMime(
  mimeType: string
): "text" | "markdown" | "code" | "pdf" | "docx" {
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (mimeType === "text/markdown") return "markdown";
  return "text";
}

/**
 * Read the source-file document id back off an entity's `properties`.
 *
 * Lives HERE, beside the only code that writes `sourceFileDocumentId`, so the
 * reader and the writer of that key can never drift. The hard-delete cascade
 * (`entities.adminDelete` / `adminBatchDelete`) resolved documents from
 * `entities.document_id` ALONE, so a source blob attached to an entity that
 * already had a body document was never reclaimed — the object and its
 * `documents` row survived the entity permanently.
 */
export function sourceFileDocumentIdFrom(
  properties: unknown
): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const id = (properties as Record<string, unknown>).sourceFileDocumentId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The entity's BODY document, if it has one — `entities.documentId` MINUS the
 * source-blob meaning it also carries.
 *
 * `attachSourceBlob` sets `documentId` for a PDF/WAV attached as provenance, so
 * since then the column has answered two different questions with one value:
 * "does this entity have a body?" and "does this entity have a file?". Every
 * reader that means the first one must go through here. The dedup path in
 * `entities.create` did not, so an entity with an attached file but no body
 * reported `matchHasBody` and a genuine long-form body arriving on a deduped
 * create was DISCARDED — reintroducing exactly the drop the B3 fix removed.
 *
 * The discriminator is `properties.sourceFileDocumentId`, written by the same
 * function that takes the `documentId` link, so the two can never disagree.
 */
export function entityBodyDocumentIdFrom(row: {
  documentId?: string | null;
  properties?: unknown;
}): string | undefined {
  if (!row.documentId) return undefined;
  return sourceFileDocumentIdFrom(row.properties) === row.documentId
    ? undefined
    : row.documentId;
}

/**
 * Every `documents` row a hard-deleted entity OWNED: its body document and its
 * source-file document, deduped (they are the same row when `attachSourceBlob`
 * took the `documentId` link).
 */
export function ownedDocumentIds(row: {
  documentId?: string | null;
  properties?: unknown;
}): string[] {
  const ids = new Set<string>();
  if (row.documentId) ids.add(row.documentId);
  const src = sourceFileDocumentIdFrom(row.properties);
  if (src) ids.add(src);
  return [...ids];
}

/**
 * PHASE 1 — bytes → object storage + a `documents` row. Touches NO entity.
 *
 * Split out of `storeEntitySourceBlob` so a GOVERNED capture can stage its file
 * before the proposal is filed and attach it on approval. There is exactly one
 * upload + document-create implementation; `storeEntitySourceBlob` calls this.
 */
export async function stageSourceBlob(
  input: StageSourceBlobInput
): Promise<StagedSourceBlob> {
  const maxBytes = input.maxBytes ?? SOURCE_BLOB_MAX_BYTES;
  if (!input.buffer || input.buffer.length === 0) {
    throw new SourceBlobEmptyError();
  }
  if (input.buffer.length > maxBytes) {
    throw new SourceBlobTooLargeError(input.buffer.length, maxBytes);
  }

  const { storage } = await import("@synap/storage");
  const ext = extFromMime(input.mimeType);
  const key = storage.buildPath(input.userId, "entity", input.keyScope, ext);
  const metadata = await storage.upload(key, input.buffer, {
    contentType: input.mimeType,
  });

  // v1 `document_versions` row. `preUploadedVersion` is the no-double-upload
  // door: we already put the bytes in object storage above, so the repository
  // writes the version row from THIS snapshot instead of uploading again — the
  // reason this path historically skipped versioning entirely. Skipping it left
  // a document with `currentVersion = 1` and NO version row, which the retrieval
  // join (`documentVersions.version = documents.currentVersion`) can never
  // match; the extracted text now rides in on the same row.
  const extractedText = input.extractedText?.trim()
    ? input.extractedText
    : undefined;
  const docRepo = new DocumentRepository(input.database, eventRepository);
  const createdDocument = await docRepo.create(
    {
      title: input.filename || "Source file",
      type: documentTypeForMime(input.mimeType),
      storageUrl: metadata.url,
      storageKey: metadata.path,
      size: metadata.size,
      mimeType: input.mimeType,
      userId: input.userId,
      workspaceId: input.workspaceId ?? undefined,
      ...(input.extractedTextTruncated
        ? { metadata: { extractedTextTruncated: true } }
        : {}),
      preUploadedVersion: {
        versionId: randomUUID(),
        snapshot: documentVersionSnapshotFromUpload({
          metadata,
          mimeType: input.mimeType,
          ...(extractedText ? { extractedText } : {}),
        }),
        message: input.extractedTextTruncated
          ? "Initial version (extracted text truncated)"
          : "Initial version",
      },
    },
    input.userId
  );

  return {
    documentId: createdDocument.id,
    storageKey: metadata.path,
    storageUrl: metadata.url,
    size: metadata.size,
    mimeType: input.mimeType,
    ...(input.filename ? { filename: input.filename } : {}),
  };
}

/**
 * Load the `documents` row a staged reference names and prove it belongs to the
 * acting user. The ONE ownership predicate both phase-2 (attach) and phase-3
 * (discard) go through — a second copy is how the two legs would drift.
 *
 * Returns the LOADED row: callers must act on its `storageKey`, never on the
 * one the caller handed in (a crafted key is how the discard door deleted an
 * arbitrary object).
 */
async function assertOwnedDocument(input: {
  database: typeof DbType;
  userId: string;
  documentId: string;
}): Promise<{ id: string; userId: string; storageKey: string | null }> {
  const doc = await input.database.query.documents.findFirst({
    where: eq(documentsTable.id, input.documentId),
    columns: { id: true, userId: true, storageKey: true },
  });
  if (!doc || doc.userId !== input.userId) {
    throw new SourceBlobOwnershipError(input.documentId, input.userId);
  }
  return doc;
}

/**
 * PHASE 2 — attach a staged blob to an entity.
 *
 * Two writes, deliberately separate:
 *  1. `properties.sourceFile*` through `EntityRepository.update` (merging, event-emitting).
 *  2. `entities.document_id`, ONLY when it is still NULL (see the T3 note in the
 *     file header). Expressed as a guarded SQL UPDATE rather than read-then-write
 *     so a concurrent `EntityBodyService.setBody` can never be clobbered by a
 *     stale read. `linkedAsBody` reports whether the link was actually taken.
 */
export async function attachSourceBlob(input: {
  database: typeof DbType;
  userId: string;
  entityId: string;
  staged: StagedSourceBlob;
}): Promise<{ linkedAsBody: boolean }> {
  const { database, userId, entityId, staged } = input;

  // ── Ownership, on the LOADED row ────────────────────────────────────────
  // `staged.documentId` arrives from `proposals.data.sourceFile` — JSONB that
  // a revise can patch — so it is request-supplied input, not a fact. Linking
  // it without loading the document made `entities.document_id` an
  // attacker-writable pointer at ANY document row, and the presigned-URL door
  // (`GET /api/files/entities/:id/url`) deliberately authorizes on the ENTITY,
  // trusting this column. Load the document and refuse unless it is the acting
  // user's own. (The `properties` write below is already owner-scoped inside
  // `EntityRepository.update`; this is the leg that was not.)
  await assertOwnedDocument({
    database,
    userId,
    documentId: staged.documentId,
  });

  const entityRepo = new EntityRepository(database, eventRepository);
  await entityRepo.update(
    entityId,
    {
      properties: {
        sourceFileDocumentId: staged.documentId,
        sourceFileUrl: staged.storageUrl,
        sourceFileSize: staged.size,
        sourceFileMimeType: staged.mimeType,
        ...(staged.filename ? { sourceFileName: staged.filename } : {}),
      },
    },
    userId
  );

  // The canonical entity↔document link. Every downstream consumer that can see
  // an attached file keys off THIS column — the embedding worker
  // (jobs/workers/entity-embedding.ts), the retrieval join, and Typesense
  // enrichment — so leaving it NULL made an attached source file invisible to
  // search and to semantic recall. `IS NULL` in the predicate is the whole
  // safety story: an entity that already has a body document keeps it.
  const linked = await database
    .update(entitiesTable)
    .set({ documentId: staged.documentId })
    .where(
      and(
        eq(entitiesTable.id, entityId),
        // Owner floor on the raw SQL leg too. `EntityRepository.update` above
        // scopes by userId; this statement did not, so it wrote through a bare
        // id — the same class of hole as trusting the documentId.
        eq(entitiesTable.userId, userId),
        isNull(entitiesTable.documentId)
      )
    )
    .returning({ id: entitiesTable.id });

  logger.info(
    {
      userId,
      entityId,
      documentId: staged.documentId,
      size: staged.size,
      mimeType: staged.mimeType,
      linkedAsBody: linked.length > 0,
    },
    "source blob attached as entity provenance"
  );

  return { linkedAsBody: linked.length > 0 };
}

/**
 * Read a staged-blob reference back off a proposal's `data` JSONB.
 *
 * Lives HERE, beside the only code that WRITES `data.sourceFile`, for the same
 * reason `sourceFileDocumentIdFrom` does: reader and writer of a JSONB key must
 * not be able to drift. It validates at runtime rather than trusting a TS
 * optional field, because `proposals.data` comes back from the database as
 * genuinely unknown JSON — a declared interface would be a claim, not a check.
 *
 * The three approval/rejection call sites (the composite branch of
 * `applyProposalApproval`, the `entity/update` executor, and `proposals.reject`
 * / `batchReject`) all narrow through this one function.
 */
export function stagedSourceBlobFrom(
  data: unknown
): StagedSourceBlob | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = (data as Record<string, unknown>).sourceFile;
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.documentId !== "string" || !s.documentId) return undefined;
  if (typeof s.storageKey !== "string" || !s.storageKey) return undefined;
  return {
    documentId: s.documentId,
    storageKey: s.storageKey,
    storageUrl: typeof s.storageUrl === "string" ? s.storageUrl : "",
    size: typeof s.size === "number" ? s.size : 0,
    mimeType:
      typeof s.mimeType === "string" ? s.mimeType : "application/octet-stream",
    ...(typeof s.filename === "string" ? { filename: s.filename } : {}),
  };
}

/**
 * Discard the blob a TERMINAL proposal was carrying, if it carried one.
 *
 * The ONE call every door that writes a terminal `ProposalStatus` makes —
 * `reject`, `batchReject`, `withdraw`, and both expiry scanners. A staged blob
 * whose proposal reached a terminal state is orphaned PERMANENTLY otherwise: nothing else
 * will ever decide its fate and a decided proposal is never deleted. Best-effort
 * and a no-op for the overwhelming majority of proposals, which have no
 * `sourceFile` at all — so it is safe to call unconditionally, which is exactly
 * what keeps the doors from drifting.
 *
 * An OWNERSHIP refusal is not swallowed into the generic cleanup warn: it means
 * a staged reference crossed a tenant boundary, which is a security event, so it
 * is logged at error level with its own message and NOTHING is deleted.
 */
export async function discardProposalSourceBlob(input: {
  database: typeof DbType;
  /** See {@link discardSourceBlob}. `null` ONLY for the expiry scanners. */
  userId: string | null;
  proposalData: unknown;
}): Promise<void> {
  const staged = stagedSourceBlobFrom(input.proposalData);
  if (!staged) return;
  try {
    await discardSourceBlob({
      database: input.database,
      userId: input.userId,
      staged,
    });
  } catch (err) {
    if (err instanceof SourceBlobOwnershipError) {
      logger.error(
        {
          userId: input.userId,
          documentId: staged.documentId,
          storageKey: staged.storageKey,
        },
        "discardProposalSourceBlob: REFUSED — the proposal's staged reference names a document the actor does not own; nothing deleted"
      );
      return;
    }
    throw err;
  }
}

/**
 * PHASE 3 — undo a stage. Deletes the object AND the `documents` row.
 *
 * Called when the governance gate DENIES, and from every terminal proposal door
 * (reject / batchReject / withdraw / expiry), so a staged blob never outlives
 * the decision that refused it.
 *
 * ── What is best-effort and what is NOT ────────────────────────────────────
 * A storage or DB *failure* stays best-effort: a cleanup hiccup must never fail
 * the rejection it is cleaning up after, so it is logged loudly and swallowed.
 * An OWNERSHIP failure is the opposite — it THROWS
 * ({@link SourceBlobOwnershipError}) and deletes nothing. The door used to
 * `storage.delete()` a caller-supplied `storageKey` with no validation at all,
 * so a crafted reference deleted another tenant's object and the failure (or
 * success) vanished into a generic warn. The key deleted is now the one on the
 * LOADED `documents` row; `staged.storageKey` is never used as an argument.
 */
export async function discardSourceBlob(input: {
  database: typeof DbType;
  /**
   * The user whose ownership authorizes this discard. `null` ONLY for the
   * expiry SCANNERS, which have no acting human at all — with `null` the
   * document is deleted as its OWN owner (read off the loaded row), which is
   * still never a cross-tenant delete because the row itself supplies both the
   * storage key and the deleting principal.
   */
  userId: string | null;
  staged: Pick<StagedSourceBlob, "documentId" | "storageKey">;
}): Promise<void> {
  const { database, userId, staged } = input;

  // Load first — the row is the authority for BOTH what gets deleted and who
  // deletes it. A reference naming a document that is gone is a no-op, not a
  // failure: the blob it pointed at cannot be orphaned by us.
  const doc = await database.query.documents.findFirst({
    where: eq(documentsTable.id, staged.documentId),
    columns: { id: true, userId: true, storageKey: true },
  });
  if (!doc) {
    logger.info(
      { userId, documentId: staged.documentId },
      "discardSourceBlob: document already gone (nothing to discard)"
    );
    return;
  }
  if (userId !== null && doc.userId !== userId) {
    throw new SourceBlobOwnershipError(staged.documentId, userId);
  }
  const ownerId = doc.userId;

  if (doc.storageKey) {
    try {
      const { storage } = await import("@synap/storage");
      await storage.delete(doc.storageKey);
    } catch (err) {
      logger.warn(
        { err, userId: ownerId, storageKey: doc.storageKey },
        "discardSourceBlob: object delete failed (document row still removed)"
      );
    }
  }
  try {
    const docRepo = new DocumentRepository(database, eventRepository);
    await docRepo.delete(staged.documentId, ownerId);
  } catch (err) {
    logger.warn(
      { err, userId: ownerId, documentId: staged.documentId },
      "discardSourceBlob: document row delete failed (blob may be orphaned)"
    );
  }
}

/**
 * Upload buffer to object storage, create a documents row, and stamp provenance
 * properties on the entity — through the governance gate.
 *
 * Order is stage → gate → attach|discard, NOT gate → stage: on a `proposed`
 * verdict the bytes must already exist for approval to attach them (that is the
 * whole point of T4). A DENY discards immediately, and a rejected proposal is
 * discarded by `proposals.reject`.
 */
export async function storeEntitySourceBlob(
  input: StoreEntitySourceBlobInput
): Promise<StoreEntitySourceBlobResult> {
  const staged = await stageSourceBlob({
    database: input.database,
    userId: input.userId,
    buffer: input.buffer,
    mimeType: input.mimeType,
    filename: input.filename,
    workspaceId: input.workspaceId,
    maxBytes: input.maxBytes,
    keyScope: input.keyScope ?? input.entityId,
    ...(input.extractedText !== undefined
      ? { extractedText: input.extractedText }
      : {}),
    ...(input.extractedTextTruncated !== undefined
      ? { extractedTextTruncated: input.extractedTextTruncated }
      : {}),
  });

  const perm: PermissionResult = await checkPermissionOrPropose({
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    subjectType: "entity",
    action: "update",
    reasoning: `Attach source file ${staged.filename ?? staged.mimeType} as provenance`,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    data: {
      // `data.id` is the proposal's targetId AND what the entity/update
      // executor patches — so an approval replays exactly this write.
      id: input.entityId,
      properties: {
        sourceFileDocumentId: staged.documentId,
        sourceFileUrl: staged.storageUrl,
        sourceFileSize: staged.size,
        sourceFileMimeType: staged.mimeType,
        ...(staged.filename ? { sourceFileName: staged.filename } : {}),
      },
      // The staged reference the approval path re-attaches through
      // `attachSourceBlob` (which also takes the documentId link) and the
      // reject path discards. Small by construction — never the bytes.
      sourceFile: staged,
    },
  });

  if ("denied" in perm && perm.denied) {
    await discardSourceBlob({
      database: input.database,
      userId: input.userId,
      staged,
    });
    throw new SourceBlobDeniedError(perm.reason);
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      reviewUrl: perm.reviewUrl,
      staged,
    };
  }

  await attachSourceBlob({
    database: input.database,
    userId: input.userId,
    entityId: input.entityId,
    staged,
  });

  return { status: "stored", ...staged };
}
