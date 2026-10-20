/**
 * An entity's body is never replaced silently — the ONE rule.
 *
 * `entities.documentId` holds ONE body. Attaching another document to an
 * entity that already has one REPLACES it, and the old document then hangs off
 * nothing (2026-10-20: `synap_create_document({ entityId })` replaced a
 * decision's foundation document with no warning). Every attach converges on
 * `entities.update({ documentId })` — MCP `synap_create_document`, Hub REST
 * `POST /documents` (and the IS `create_document` tool behind it), a capture
 * plan's `create_document` step at approval — so the refusal lives there, and
 * the create doors and the plan preflight run the SAME check before anything
 * is written, so a refused attach never leaves a fresh orphan document behind.
 *
 * Replacing on purpose stays possible: `replaceBody: true`.
 */

import { and, db as defaultDb, eq, isNull } from "@synap/database";
import { documents, entities } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { entityWriteVisibleWhere } from "../../routers/entities/helpers.js";
import { entityBodyDocumentIdFrom } from "../../utils/store-entity-source-blob.js";

type BodyDb = Pick<typeof defaultDb, "select">;

export interface ExistingBody {
  documentId: string;
  title: string | null;
}

/** The body document's id + title, for the refusal to name it. */
export async function loadExistingBody(
  documentId: string,
  database: BodyDb = defaultDb
): Promise<ExistingBody> {
  const [row] = await database
    .select({ title: documents.title })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  return { documentId, title: row?.title ?? null };
}

/**
 * The refusal, naming the existing body and the doors that do what the
 * caller most likely meant: a RELATED document is its own entity, linked to
 * this one (it then shows under the entity's connections), never a second body.
 */
export function bodyReplaceRefusal(
  entityId: string,
  body: ExistingBody
): string {
  const name = body.title ? ` "${body.title}"` : "";
  return (
    `Entity ${entityId} already has a body: document ${body.documentId}${name}. ` +
    `Attaching another document would REPLACE it and leave that document attached to nothing, so nothing was written. ` +
    `To add a RELATED document, create it as its own entity and link it: ` +
    `synap_create_entity({ profileSlug: "note", title, content }), then ` +
    `synap_link_entities({ sourceEntityId: <the new id>, targetEntityId: "${entityId}", type: "relates_to" }) ` +
    `— or both in one reviewable call with synap_capture (entities + relations). ` +
    `To edit the body, use synap_update_document({ documentId: "${body.documentId}" }). ` +
    `To really replace it, use synap_create_document({ entityId, replaceBody: true }).`
  );
}

/**
 * Throws CONFLICT when attaching a new document to `entity` would replace its
 * BODY without `replaceBody`. The caller has already decided the attach really
 * changes the link (a document id different from the current one).
 *
 * "Has a body" is `entityBodyDocumentIdFrom`: a source file attached as
 * provenance also sets `documentId`, and giving such an entity its first body
 * is not a replacement (the file stays named by `sourceFileDocumentId`).
 */
export async function assertBodyNotReplacedSilently(
  args: {
    entity: { id: string; documentId: string | null; properties?: unknown };
    replaceBody?: boolean;
  },
  database: BodyDb = defaultDb
): Promise<void> {
  const bodyId = entityBodyDocumentIdFrom(args.entity);
  if (!bodyId || args.replaceBody === true) return;
  throw new TRPCError({
    code: "CONFLICT",
    message: bodyReplaceRefusal(
      args.entity.id,
      await loadExistingBody(bodyId, database)
    ),
  });
}

/**
 * The create doors' half (MCP `synap_create_document`, Hub REST
 * `POST /documents`): the same rule, run BEFORE the document is created, so a
 * refused attach never leaves a fresh document attached to nothing. Reads the
 * entity under the WRITE floor `entities.update` uses, so an attach to an
 * entity the caller cannot write is also refused before anything exists.
 */
export async function preflightAttachToEntity(input: {
  entityId: string;
  userId: string;
  replaceBody?: boolean;
}): Promise<void> {
  const [entity] = await defaultDb
    .select({
      id: entities.id,
      documentId: entities.documentId,
      properties: entities.properties,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, input.entityId),
        isNull(entities.deletedAt),
        entityWriteVisibleWhere(input.userId)
      )
    )
    .limit(1);
  if (!entity) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Entity not found: ${input.entityId}. Nothing was created.`,
    });
  }
  await assertBodyNotReplacedSilently({
    entity,
    replaceBody: input.replaceBody,
  });
}
