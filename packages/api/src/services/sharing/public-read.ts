/**
 * THE PUBLIC READ of a published share (Sites W3) — `GET /api/hub/public/shares/:token`.
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
  documentVersions,
  readDocumentVersionContent,
} from "@synap/database";
import { resourceShares } from "@synap/database/schema";
import { hashToken } from "../../utils/share-token.js";

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

export interface PublicShareView {
  resourceType: "entity";
  /** Present only when the snapshot allowlisted `title`. */
  title?: string;
  properties: Record<string, string | number | boolean>;
  body: { format: "markdown"; content: string } | null;
  /** Day precision (YYYY-MM-DD). */
  publishedOn: string;
}

export interface PublicShareRead {
  view: PublicShareView;
  /** Weak, opaque, derived from the pinned revision + snapshot. */
  etag: string;
}

/**
 * Resolve a public token to what may be served, or `null` for every kind of
 * miss. Throws on a failed read.
 */
export async function readPublishedShare(
  token: string
): Promise<PublicShareRead | null> {
  // Hash FIRST, always; the indexed lookup runs for every shape of token.
  const tokenHash = hashToken(typeof token === "string" ? token : "");
  const [row] = await db
    .select({
      id: resourceShares.id,
      resourceType: resourceShares.resourceType,
      resourceId: resourceShares.resourceId,
      audience: resourceShares.audience,
      state: resourceShares.state,
      revokedAt: resourceShares.revokedAt,
      expiresAt: resourceShares.expiresAt,
      publishedAt: resourceShares.publishedAt,
      publishedProperties: resourceShares.publishedProperties,
      publishedDocumentVersionId: resourceShares.publishedDocumentVersionId,
    })
    .from(resourceShares)
    .where(eq(resourceShares.tokenHash, tokenHash))
    .limit(1);

  if (
    !row ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    row.audience !== "public" ||
    row.state !== "published" ||
    row.revokedAt ||
    (row.expiresAt && row.expiresAt.getTime() <= Date.now()) ||
    !row.publishedAt ||
    row.resourceType !== "entity"
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

  let body: PublicShareView["body"] = null;
  if (row.publishedDocumentVersionId) {
    const [version] = await db
      .select({
        documentId: documentVersions.documentId,
        content: documentVersions.content,
        storageKey: documentVersions.storageKey,
        mimeType: documentVersions.mimeType,
      })
      .from(documentVersions)
      .where(eq(documentVersions.id, row.publishedDocumentVersionId))
      .limit(1);
    // A pin that is not a checkpoint of THIS entity's document would serve
    // another record's body: refuse the whole share rather than guess.
    if (!version || !entity.documentId) return null;
    if (version.documentId !== entity.documentId) return null;
    const content = await readDocumentVersionContent(version);
    // Realtime (Yjs) state is not document text; never serve it.
    if (!content.startsWith("yjs:")) {
      body = { format: "markdown", content: redactInternalIds(content) };
    }
  }

  const properties = projectPublishedProperties(row.publishedProperties);
  const title =
    typeof properties.title === "string" ? properties.title : undefined;
  delete properties.title;

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
