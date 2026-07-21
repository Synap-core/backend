/**
 * EntityBodyService — the canonical door for an entity's BODY (its content layer).
 *
 * Mental model: **Entity = data layer · Document = content layer · Storage = bytes.**
 * This service owns the Document/Storage half of that model: turning a piece of
 * body content (text | uploaded bytes | external url) into the right physical
 * representation, reading it back, and cleaning it up. It NEVER touches the
 * entity row's identity/properties beyond what a body implies — linking
 * `entity.documentId`, project/session placement, and governance stay with the
 * caller (see the ownership note on `setBody`).
 *
 * Wave 1 (this file) BUILDS the service and REPLICATES today's behavior exactly.
 * It does NOT rewire any caller — that is Wave 2. Sources consolidated here:
 *   - text-mode      ← `resolveContentTarget` / `materializeContentDocument`
 *                       (api/src/import/materialize-document.ts)
 *   - bytes-mode     ← `storeDocumentFromBuffer`
 *                       (api/src/routers/file-upload.ts)
 *   - url-mode       ← the external-url branch of hub-protocol/documents.ts
 *   - getPreview     ← `readDocumentVersionContent` preview column (DB-only)
 *   - getBytes       ← the 3-state resolver (fixes the `documents.get:321`
 *                       `storageKey!` non-null-assert bug class, B2)
 *   - deleteBody     ← the version+object storage-cleanup at documents.ts:450,
 *                       made an unconditional reverse-cascade (B1)
 *
 * (The raw-source-blob path — `storeEntitySourceBlob` — is a deliberately
 * SEPARATE `sourceFile*` slot, not a body; folding it onto this service is a
 * tracked follow-up, not part of W0–W3.)
 *
 * GOVERNANCE-AGNOSTIC: this service never calls `checkPermissionOrPropose` and
 * never falsifies provenance — the caller passes `provenance` in and it is
 * stamped verbatim onto the `documents` row.
 *
 * PACKAGE PLACEMENT: this lives in `@synap/database` (not `@synap/api`) so the
 * jobs materializer (`@synap/jobs`, which cannot import `@synap/api`) can adopt
 * it in Wave 2. Only DB/storage-layer deps are used.
 */

import { randomUUID } from "crypto";
import { storage } from "@synap/storage";
import { createLogger } from "@synap-core/core";
import { eq, desc } from "drizzle-orm";
import { documents, documentVersions } from "../schema/documents.js";
import { entities } from "../schema/entities.js";
import {
  DocumentRepository,
  type CreateDocumentInput,
} from "../repositories/document-repository.js";
import type { EventRepository } from "../repositories/event-repository.js";
import { uploadDocumentVersionSnapshot } from "../utils/document-version-storage.js";

const logger = createLogger({ module: "entity-body-service" });

// ---------------------------------------------------------------------------
// Long-form heuristic — LOCAL COPY.
//
// The canonical `shouldMaterializeAsDocument` lives in `@synap-core/types/documents`,
// but `@synap-core/types` depends on `@synap/database` (circular), so this
// package cannot import it. This is a deliberate, behavior-identical copy —
// the same precedent as `create-unified-event.ts`. A follow-up wave should make
// `@synap/database` the canonical home and re-export from `@synap-core/types`
// (types → database is allowed) to collapse the duplicate; that is a separate
// cross-package diff, out of Wave 1's scope.
// ---------------------------------------------------------------------------
const HEADING_RE = /^#{1,6} /gm;
const CODE_FENCE_RE = /^(```|~~~)/m;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+\S/gm;
const PARAGRAPH_SPLIT_RE = /\n\s*\n/;
const LONG_FORM_LENGTH = 600;

function countMatches(re: RegExp, text: string): number {
  let count = 0;
  for (const _ of text.matchAll(re)) count++;
  return count;
}

/** Behavior-identical local copy of `@synap-core/types`'s `shouldMaterializeAsDocument`. */
function shouldMaterializeAsDocument(content: string): boolean {
  if (!content) return false;
  const text = content.trim();
  if (!text) return false;
  if (text.length >= LONG_FORM_LENGTH) return true;
  if (countMatches(HEADING_RE, text) >= 2) return true;
  if (CODE_FENCE_RE.test(text)) return true;
  if (countMatches(LIST_ITEM_RE, text) >= 3) return true;
  const paragraphCount = text
    .split(PARAGRAPH_SPLIT_RE)
    .filter((p) => p.trim().length > 0).length;
  if (paragraphCount >= 4) return true;
  return false;
}

/**
 * Map a mime type → `documents.type`. Behavior-identical to file-upload.ts's
 * `documentTypeForMimeType` (returns "file" for unknown/binary — the DB column
 * is free `text`, so the value is stored verbatim).
 */
function documentTypeForMimeType(mimeType: string): string {
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/html") return "html";
  if (mimeType.startsWith("text/")) return "text";
  if (mimeType === "application/json") return "code";
  if (mimeType === "application/pdf") return "pdf";
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  return "file";
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * WHO/WHAT authored the body. Passed in by the caller and stamped verbatim onto
 * the `documents` row — the service NEVER defaults or falsifies it (an agent
 * write is never re-labelled `human`).
 */
export interface BodyProvenance {
  createdByKind: "human" | "ai_agent" | "system";
  createdByUserId: string;
  agentUserId?: string;
  sourceProposalId?: string;
  correlationId?: string;
}

interface SetBodyCommon {
  /** The entity whose body this is. Used for the text-mode storage path. */
  entityId: string;
  /** `null` = pod-wide document. */
  workspaceId?: string | null;
  /** The owning user (storage namespacing + `documents.user_id`). */
  userId: string;
  /** Human-facing document title. */
  title?: string;
  provenance: BodyProvenance;
}

export type SetBodyParams =
  | (SetBodyCommon & { text: string })
  | (SetBodyCommon & { bytes: Buffer; mimeType: string; filename: string })
  | (SetBodyCommon & { url: string });

/**
 * Result of {@link EntityBodyService.setBody}.
 * - text-mode long  → `{ documentId }`
 * - text-mode short → `{ inlineContent }` (caller writes `properties.content`)
 * - bytes-mode      → `{ documentId, storageKey, storageUrl, size }`
 * - url-mode        → `{ documentId }`
 */
export interface SetBodyResult {
  documentId?: string;
  inlineContent?: string;
  storageKey?: string;
  storageUrl?: string;
  size?: number;
}

/** 3-state body read. Never non-null-asserts `storageKey` (fixes B2). */
export type EntityBodyBytes =
  | { kind: "bytes"; buffer: Buffer; mimeType: string | null }
  | { kind: "external"; url: string }
  | { kind: "inline"; content: string };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EntityBodyService {
  private readonly docRepo: DocumentRepository;

  constructor(
    private readonly db: any,
    eventRepo: EventRepository
  ) {
    this.docRepo = new DocumentRepository(db, eventRepo);
  }

  private provenanceFields(
    p: BodyProvenance
  ): Pick<
    CreateDocumentInput,
    | "createdByKind"
    | "createdByUserId"
    | "agentUserId"
    | "sourceProposalId"
    | "correlationId"
  > {
    return {
      createdByKind: p.createdByKind,
      createdByUserId: p.createdByUserId,
      agentUserId: p.agentUserId,
      sourceProposalId: p.sourceProposalId,
      correlationId: p.correlationId,
    };
  }

  /**
   * Write an entity's body. ONE of `text` | `bytes` | `url` on `params`.
   *
   * CALLER OWNERSHIP: this service creates/updates the DOCUMENT + storage only.
   * It does NOT link `entity.documentId`, write `properties.content`, stamp the
   * project/session, or run governance — the caller does those at its call site
   * (Wave 2 wires them). For text-mode short content the service returns
   * `inlineContent` for the caller to place into `properties.content`.
   */
  async setBody(params: SetBodyParams): Promise<SetBodyResult> {
    if ("bytes" in params) return this.setBodyBytes(params);
    if ("url" in params) return this.setBodyUrl(params);
    return this.setBodyText(params);
  }

  // --- text mode (← resolveContentTarget / materializeContentDocument) -------
  private async setBodyText(
    params: SetBodyCommon & { text: string }
  ): Promise<SetBodyResult> {
    const { text, entityId, userId, workspaceId, title, provenance } = params;
    if (!text) return {};
    // Behavior-preserving: apply the EXISTING heuristic. The always-document
    // flip (materialize every body) is Wave 4, NOT here.
    if (!shouldMaterializeAsDocument(text)) return { inlineContent: text };

    try {
      const key = storage.buildPath(userId, "entity", entityId, "md");
      const metadata = await storage.upload(key, text, {
        contentType: "text/markdown",
      });
      const doc = await this.docRepo.create(
        {
          title: title || "Untitled",
          type: "markdown",
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          userId,
          workspaceId: workspaceId ?? undefined,
          content: text,
          ...this.provenanceFields(provenance),
        },
        userId
      );
      return { documentId: doc.id };
    } catch (err) {
      // Best-effort fold-back-to-inline — a materialization failure never blocks
      // the entity write (mirrors resolveContentTarget).
      logger.warn(
        { err, entityId },
        "Body materialization failed, folding content into inline property"
      );
      return { inlineContent: text };
    }
  }

  // --- bytes mode (← storeDocumentFromBuffer) --------------------------------
  private async setBodyBytes(
    params: SetBodyCommon & {
      bytes: Buffer;
      mimeType: string;
      filename: string;
    }
  ): Promise<SetBodyResult> {
    const {
      bytes,
      mimeType,
      filename,
      userId,
      workspaceId,
      title,
      provenance,
    } = params;
    const displayTitle = title?.trim() || filename;

    const storageId = randomUUID();
    // Sanitize the caller filename for the storage KEY (defense-in-depth for a
    // local-fs backend). The random storageId already namespaces each blob.
    const safeName = (filename || "file")
      .replace(/[\\/]/g, "_")
      .replace(/\.\./g, "_");
    const storagePath = `files/${workspaceId ?? "pod"}/${storageId}/${safeName}`;

    // Upload the canonical current-content object.
    const metadata = await storage.upload(storagePath, bytes, {
      contentType: mimeType,
    });

    // Upload the immutable v1 version snapshot (a SECOND object, so cleanup can
    // delete both) — then hand it to the repo pre-uploaded to avoid re-upload.
    const documentId = randomUUID();
    const versionId = randomUUID();
    const documentType = documentTypeForMimeType(mimeType);
    const snapshot = await uploadDocumentVersionSnapshot({
      userId,
      documentId,
      versionId,
      documentType,
      mimeType,
      content: bytes,
    });

    const doc = await this.docRepo.create(
      {
        id: documentId,
        title: displayTitle,
        // The DB column is free `text`; "file"/"html" are stored verbatim, same
        // as storeDocumentFromBuffer. Cast past the narrow repo union.
        type: documentType as CreateDocumentInput["type"],
        storageUrl: metadata.url,
        storageKey: metadata.path,
        size: metadata.size,
        mimeType,
        metadata: {
          originalFileName: filename,
          uploadKind: "file-upload",
        },
        userId,
        workspaceId: workspaceId ?? undefined,
        preUploadedVersion: {
          versionId,
          snapshot,
          message: "Initial upload",
        },
        ...this.provenanceFields(provenance),
      },
      userId
    );

    return {
      documentId: doc.id,
      storageKey: metadata.path,
      storageUrl: metadata.url,
      size: metadata.size,
    };
  }

  // --- url mode (← hub-protocol/documents.ts external branch) ----------------
  private async setBodyUrl(
    params: SetBodyCommon & { url: string }
  ): Promise<SetBodyResult> {
    const { url, userId, workspaceId, title, provenance } = params;
    // External reference: storageKey NULL, size 0, mimeType NULL,
    // metadata.external = true. No storage upload, no version snapshot.
    const doc = await this.docRepo.create(
      {
        title: title || "Untitled",
        type: "markdown",
        storageUrl: url,
        storageKey: null,
        size: 0,
        mimeType: null,
        metadata: { external: true },
        userId,
        workspaceId: workspaceId ?? undefined,
        ...this.provenanceFields(provenance),
      },
      userId
    );
    return { documentId: doc.id };
  }

  /**
   * DB-only preview of the body: the latest `document_versions.content` column
   * (≤64k, the `TEXT_PREVIEW_LIMIT`). Cheap — for indexers/embedders. Returns
   * `null` when the document has no version rows.
   *
   * NOTE: the cheap-read counterpart to `getBytes` (storage). Readers still call
   * `readDocumentVersionContent` directly today; the indexer/embedder read
   * consolidation onto this method lands with the W4 always-document flip.
   */
  async getPreview(documentId: string): Promise<string | null> {
    const [version] = await this.db
      .select({ content: documentVersions.content })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.version))
      .limit(1);
    return version ? version.content : null;
  }

  /**
   * Full body via the 3-state resolver:
   *   1. `storageKey` set        → download the bytes.
   *   2. `storageKey` NULL + url → return the external URL reference (NO fetch).
   *   3. neither                 → fall back to the latest version's inline content.
   * NEVER non-null-asserts `storageKey` — this is the correct shape the buggy
   * `documents.get:321` (`storageKey!`) should adopt in Wave 3. Returns `null`
   * for a missing document.
   */
  async getBytes(documentId: string): Promise<EntityBodyBytes | null> {
    const [doc] = await this.db
      .select({
        storageKey: documents.storageKey,
        storageUrl: documents.storageUrl,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc) return null;

    if (doc.storageKey) {
      const buffer = await storage.downloadBuffer(doc.storageKey);
      return { kind: "bytes", buffer, mimeType: doc.mimeType ?? null };
    }
    if (doc.storageUrl) {
      return { kind: "external", url: doc.storageUrl };
    }
    const [version] = await this.db
      .select({ content: documentVersions.content })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.version))
      .limit(1);
    return { kind: "inline", content: version ? version.content : "" };
  }

  /**
   * The ONE reverse-cascade + shared storage-cleanup (fixes B1). Deletes the
   * `documents` row AND unconditionally deletes its `documents.storageKey`
   * object plus EVERY `document_versions.storageKey` object — the cleanup that
   * today lives only inline at documents.ts:450 and is nowhere reused. No
   * user-pref gate (that gate — B1 — is removed here so Wave 3 can adopt this).
   *
   * Accepts a `documentId` directly, or an `entityId` (its `documentId` is
   * resolved). A no-op when there is nothing to delete.
   */
  async deleteBody(params: {
    documentId?: string;
    entityId?: string;
  }): Promise<void> {
    let documentId = params.documentId;
    if (!documentId && params.entityId) {
      const [ent] = await this.db
        .select({ documentId: entities.documentId })
        .from(entities)
        .where(eq(entities.id, params.entityId))
        .limit(1);
      documentId = ent?.documentId ?? undefined;
    }
    if (!documentId) return;

    const [doc] = await this.db
      .select({
        storageKey: documents.storageKey,
        userId: documents.userId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc) return;

    // Collect version object keys BEFORE deleting the row (versions cascade on
    // the FK, so read them first).
    const versions = await this.db
      .select({ storageKey: documentVersions.storageKey })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));

    // Delete the row (+ cascaded versions) and emit `document.delete.completed`
    // via the repo's one door.
    await this.docRepo.delete(documentId, doc.userId);

    // Unconditional storage cleanup — the current-content object + every version
    // snapshot object. Best-effort: a storage miss never resurrects the row.
    if (doc.storageKey) {
      await storage
        .delete(doc.storageKey)
        .catch((err: unknown) =>
          logger.warn({ err, documentId }, "Failed to delete document object")
        );
    }
    await Promise.allSettled(
      versions
        .map((v: { storageKey: string | null }) => v.storageKey)
        .filter((k: string | null): k is string => !!k)
        .map((k: string) => storage.delete(k))
    );
  }
}
