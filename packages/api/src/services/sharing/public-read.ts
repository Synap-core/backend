/**
 * THE PUBLIC READ of a published share — `GET /api/hub/public/shares/:token`.
 *
 * Credentialless. The token in the path IS the capability; there is no caller
 * identity, and nothing here reads one. What a stranger holding the token may
 * see is fixed AT PUBLISH TIME and never derived from the live record:
 *
 *   - the SNAPSHOT `resource_shares.published_properties` (allowlisted by the
 *     publisher, re-filtered here to plain string / number / boolean values),
 *   - the body of the PINNED `published_document_version_id` (a stored
 *     checkpoint, so a later edit cannot publish itself),
 *   - `title` only when the snapshot allowlisted a `title` key.
 *
 * Never: an internal id (owner, workspace, project, the entity's own id, the
 * share id, a relation target — every UUID-shaped token is removed from values
 * and body), an actor identity, or a relation to an object that was not itself
 * shared.
 *
 * UNIFORM MISS. Unknown token, revoked, expired, draft (unpublished), link
 * audience, a non-entity resource (views and standalone documents are not
 * publishable in v1), a deleted entity, a pin that does not belong to the
 * entity's document: ALL return `null`, and the route answers every `null` with
 * the byte-identical 404. A FAILED read (database, storage) throws — a 500 is
 * never folded into a 404.
 *
 * LOOKUP. One indexed query on the unique `token_hash` index (0276), never a
 * scan. The token is hashed before anything else happens, whatever its shape.
 */

import { createHash } from "node:crypto";
import {
  db,
  eq,
  entities,
  documents,
  documentVersions,
  readDocumentVersionContent,
  type DocumentType,
} from "@synap/database";
import { resourceShares } from "@synap/database/schema";
import { hashToken } from "../../utils/share-token.js";
import { isPublicationLive } from "./publication-live.js";
import { publicDoorsOpenFor } from "./public-doors-switch.js";

/** The ONE body every miss is answered with. */
export const PUBLIC_NOT_FOUND_BODY = { error: "Not found" } as const;

/** A token longer than this cannot have been minted (32 bytes base64url = 43). */
const MAX_TOKEN_LENGTH = 256;

const UUID_GLOBAL =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_EXACT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What replaces an internal id inside served text. */
export const REDACTED_ID = "[redacted]";

/**
 * Snapshot keys that name an actor, an owner or a container. Refused even when
 * a publisher allowlisted them — they are identity, not content.
 */
const IDENTITY_KEYS = new Set(
  [
    "id",
    "userId",
    "ownerId",
    "workspaceId",
    "projectId",
    "createdBy",
    "createdByUserId",
    "updatedBy",
    "agentUserId",
    "authorId",
    "assigneeId",
    "sourceProposalId",
    "correlationId",
  ].map((k) => k.toLowerCase())
);

/** Remove every UUID-shaped token from served text. */
export function redactInternalIds(text: string): string {
  return text.replace(UUID_GLOBAL, REDACTED_ID);
}

/**
 * The snapshot, re-filtered: only string / finite number / boolean values
 * survive; a value that IS an id (a relation-typed property) is dropped; ids
 * embedded in text are redacted; identity keys are dropped whatever their value.
 */
export function projectPublishedProperties(
  snapshot: unknown
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return out;
  }
  for (const [key, value] of Object.entries(
    snapshot as Record<string, unknown>
  )) {
    if (IDENTITY_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      if (UUID_EXACT.test(value.trim())) continue;
      out[key] = redactInternalIds(value);
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The snapshot as served: re-filtered by {@link projectPublishedProperties},
 * with `title` lifted out (served only when the snapshot allowlisted it).
 */
export function publicTitleAndProperties(snapshot: unknown): {
  title?: string;
  properties: Record<string, string | number | boolean>;
} {
  const properties = projectPublishedProperties(snapshot);
  const title =
    typeof properties.title === "string" ? properties.title : undefined;
  delete properties.title;
  return { ...(title !== undefined ? { title } : {}), properties };
}

/**
 * The format a published body is served in, so a reader renders it as what it
 * IS: `markdown` is text a reader parses as safe markdown; `html` is a whole
 * HTML document a reader shows only inside a sandboxed frame (`ui-rules.md`,
 * `SpatialMediaPreview`: `<iframe sandbox="" srcdoc>`, never in its own DOM).
 */
export type PublicBodyFormat = "markdown" | "html";

export interface PublicBody {
  format: PublicBodyFormat;
  content: string;
}

/**
 * Every document type, classified by how its body is served publicly. Decided
 * by the DOCUMENT'S type, not the version's mime type: versions written before
 * the materializer fix carry `text/markdown` for an html body. A binary body
 * (pdf, docx) or a canvas is NOT served as text — decoding its bytes as utf-8
 * and calling them markdown was the bug — so its publication has no body.
 * A type added to `DocumentType` and not classified here fails the build.
 */
const BODY_FORMAT_BY_TYPE = {
  markdown: "markdown",
  text: "markdown",
  code: "markdown",
  html: "html",
  pdf: null,
  docx: null,
  whiteboard: null,
} as const satisfies Record<DocumentType, PublicBodyFormat | null>;

/** The served format of a document type; an unknown type is not served. */
export function publicBodyFormat(
  documentType: string | null | undefined
): PublicBodyFormat | null {
  if (
    !documentType ||
    !Object.prototype.hasOwnProperty.call(BODY_FORMAT_BY_TYPE, documentType)
  ) {
    return null;
  }
  return BODY_FORMAT_BY_TYPE[documentType as DocumentType];
}

/**
 * Bumped when what a record read SERVES changes for the same pinned revision
 * (2: the body carries its real format). Part of every record ETag, so a
 * client holding a body served under the old contract revalidates to the new
 * one instead of a 304 that keeps it.
 */
export const PUBLIC_BODY_CONTRACT = 2;

/**
 * The body of a publication's PINNED checkpoint, ids redacted, in its real
 * format ({@link publicBodyFormat}). `ok: false` when the pin is not a
 * checkpoint of THIS entity's document — serving it would serve another
 * record's body, so the caller refuses the whole read rather than guess. No
 * pin, or a body that is not text, = no body. Throws on a failed read.
 */
export async function readPinnedBody(
  pinId: string | null,
  entityDocumentId: string | null
): Promise<{ ok: true; body: PublicBody | null } | { ok: false }> {
  if (!pinId) return { ok: true, body: null };
  const [version] = await db
    .select({
      documentId: documentVersions.documentId,
      content: documentVersions.content,
      storageKey: documentVersions.storageKey,
      mimeType: documentVersions.mimeType,
      documentType: documents.type,
    })
    .from(documentVersions)
    .leftJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(eq(documentVersions.id, pinId))
    .limit(1);
  if (!version || !entityDocumentId) return { ok: false };
  if (version.documentId !== entityDocumentId) return { ok: false };
  const format = publicBodyFormat(version.documentType);
  if (!format) return { ok: true, body: null };
  const content = await readDocumentVersionContent(version);
  // Realtime (Yjs) state is not document text; never serve it.
  if (content.startsWith("yjs:")) return { ok: true, body: null };
  return {
    ok: true,
    body: { format, content: redactInternalIds(content) },
  };
}

export interface PublicShareView {
  resourceType: "entity";
  /** Present only when the snapshot allowlisted `title`. */
  title?: string;
  properties: Record<string, string | number | boolean>;
  body: PublicBody | null;
  /** Day precision (YYYY-MM-DD). */
  publishedOn: string;
}

export interface PublicShareRead {
  view: PublicShareView;
  /** Weak, opaque, derived from the pinned revision + snapshot. */
  etag: string;
}

/** A live share whose workspace's public doors are switched off. */
export interface PublicShareClosed {
  closed: true;
}

/**
 * Resolve a public token to what may be served, `null` for every kind of miss,
 * or {@link PublicShareClosed} when the share is live but its workspace's
 * public doors are off (`public-doors-switch.ts`) — decided LAST, so only a
 * token that would otherwise have been served can learn the switch is off.
 * Throws on a failed read.
 */
export async function readPublishedShare(
  token: string
): Promise<PublicShareRead | PublicShareClosed | null> {
  // Hash FIRST, always; the indexed lookup runs for every shape of token.
  const tokenHash = hashToken(typeof token === "string" ? token : "");
  const [row] = await db
    .select({
      id: resourceShares.id,
      workspaceId: resourceShares.workspaceId,
      resourceType: resourceShares.resourceType,
      resourceId: resourceShares.resourceId,
      audience: resourceShares.audience,
      state: resourceShares.state,
      revokedAt: resourceShares.revokedAt,
      expiresAt: resourceShares.expiresAt,
      publishedAt: resourceShares.publishedAt,
      publishedProperties: resourceShares.publishedProperties,
      publishedDocumentVersionId: resourceShares.publishedDocumentVersionId,
      siteShareId: resourceShares.siteShareId,
    })
    .from(resourceShares)
    .where(eq(resourceShares.tokenHash, tokenHash))
    .limit(1);

  if (
    !row ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    // Found by its token hash, so a url exists.
    !isPublicationLive({ ...row, hasToken: true }) ||
    // Implied by the rule above; repeated so the type narrows for the view.
    !row.publishedAt
  ) {
    return null;
  }

  const [entity] = await db
    .select({
      documentId: entities.documentId,
      deletedAt: entities.deletedAt,
    })
    .from(entities)
    .where(eq(entities.id, row.resourceId))
    .limit(1);
  if (!entity || entity.deletedAt) return null;

  const pinned = await readPinnedBody(
    row.publishedDocumentVersionId,
    entity.documentId
  );
  if (!pinned.ok) return null;
  const body = pinned.body;

  if (!(await publicDoorsOpenFor(row.workspaceId))) return { closed: true };

  const { title, properties } = publicTitleAndProperties(
    row.publishedProperties
  );

  const view: PublicShareView = {
    resourceType: "entity",
    ...(title !== undefined ? { title } : {}),
    properties,
    body,
    publishedOn: row.publishedAt.toISOString().slice(0, 10),
  };

  const etag = `W/"${createHash("sha256")
    .update(
      JSON.stringify([
        PUBLIC_BODY_CONTRACT,
        row.id,
        row.publishedDocumentVersionId,
        row.publishedAt.toISOString(),
        row.publishedProperties ?? null,
      ])
    )
    .digest("hex")
    .slice(0, 32)}"`;

  return { view, etag };
}

/**
 * RFC 9110 §8.8.3.2 — If-None-Match uses WEAK comparison and may be a list or `*`.
 */
export function ifNoneMatchHits(
  header: string | undefined,
  etag: string
): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const ours = strip(etag);
  return trimmed.split(",").some((candidate) => strip(candidate) === ours);
}
