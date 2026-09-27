/**
 * Promote a text PROPERTY to its entity's BODY document ("Open as document"),
 * and the undo of that move. Text tiers W3; founder decision (a): promotion
 * MOVES the prose — the document is created from the property value, linked
 * as `entities.document_id`, and the property is cleared — with undo.
 *
 * ONE transaction: the entity row is locked, the document (row + v1 version)
 * is created, and the entity is re-pointed and the property removed. A failure
 * anywhere rolls all of it back, so the text is never in neither place and
 * never in both. (Before this door the only path was two client writes —
 * `documents.create` then `entities.update` — which could orphan a document or
 * leave the text split-brain between the property and the body.)
 *
 * The document is created through `createDocumentWithContent` (the create
 * door beside `claimDocumentRevision`), not claimed: on a brand-new document the
 * claim door would cut a phantom empty pre-image checkpoint. The UNDO does not
 * write document content at all — it reads it back.
 *
 * The UNDO RECORD lives on the document it describes: `metadata.promotedFrom
 * {entityId, propertySlug, revision}`. Undo is refused once the document moved
 * past that revision (`edited_since` — undoing would throw that work away) or
 * when the link changed (`not_promoted`). The restored text is read from the
 * stored body, never taken from the caller. (The proposal receipt + revert
 * pattern does not fit here: a person's write mints no receipt, and revert
 * cannot restore a `documentId` change — see `entities.update`.)
 *
 * WHO may promote: the entity's write floor — `entityWriteVisibleWhere` to find
 * it (NOT_FOUND otherwise) and `assertWorkspaceWrite` on the LOADED row (editor+
 * member, or the owner of a pod-wide entity). It is a person's gesture: an
 * agent-attributed caller is refused (`agent_caller`); an agent edits the body
 * through `update_document` once it exists, on the entity lane (decision b).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  isNull,
  eventRepository,
  createDocumentWithContent,
  EntityBodyService,
  ProfileResolutionService,
  PropertyIndexService,
  getActingAgentUserId,
} from "@synap/database";
import { entities, documents } from "@synap/database/schema";
import { storage } from "@synap/storage";
import { createLogger } from "@synap-core/core";
import {
  isBodyPropertyDef,
  type PromoteToBodyRefusal,
  type UndoPromoteToBodyRefusal,
} from "@synap-core/types/documents";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import { entityWriteVisibleWhere } from "../../routers/entities/helpers.js";

const logger = createLogger({ module: "promote-property-to-body" });

/** The undo record, stamped on the document the promotion created. */
export interface PromotedFromStamp {
  entityId: string;
  propertySlug: string;
  /** `documents.content_revision` right after the move. */
  revision: number;
}

export type PromotePropertyToBodyResult =
  | {
      status: "promoted";
      entityId: string;
      propertySlug: string;
      documentId: string;
      revision: number;
    }
  | { status: "refused"; reason: PromoteToBodyRefusal; message: string };

export type UndoPromotePropertyToBodyResult =
  | {
      status: "restored";
      entityId: string;
      propertySlug: string;
      documentId: string;
    }
  | { status: "refused"; reason: UndoPromoteToBodyRefusal; message: string };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const refuse = <R extends string>(reason: R, message: string) =>
  ({ status: "refused", reason, message }) as const;

/** The entity under the caller's write floor, row-locked for this transaction. */
async function lockWritableEntity(tx: Tx, userId: string, entityId: string) {
  const [entity] = await tx
    .select({
      id: entities.id,
      userId: entities.userId,
      workspaceId: entities.workspaceId,
      profileId: entities.profileId,
      title: entities.title,
      documentId: entities.documentId,
      properties: entities.properties,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        isNull(entities.deletedAt),
        entityWriteVisibleWhere(userId)
      )
    )
    .for("update")
    .limit(1);
  if (!entity) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Entity not found: ${entityId}`,
    });
  }
  await assertWorkspaceWrite(tx, userId, {
    workspaceId: entity.workspaceId,
    ownerId: entity.userId,
  });
  return entity;
}

async function isBodyProperty(
  profileId: string | null,
  workspaceId: string | null,
  slug: string
): Promise<boolean> {
  if (isBodyPropertyDef({ slug })) return true;
  if (!profileId) return false;
  const defs = await new ProfileResolutionService(db).getEffectiveProperties(
    profileId,
    workspaceId
  );
  const def = defs.find((d) => d.slug === slug);
  return !!def && isBodyPropertyDef(def);
}

export async function promotePropertyToBody(input: {
  userId: string;
  entityId: string;
  propertySlug: string;
}): Promise<PromotePropertyToBodyResult> {
  const { userId, entityId, propertySlug } = input;
  if (getActingAgentUserId()) {
    return refuse(
      "agent_caller",
      "Moving a field into the document is a person's action. Edit the document with update_document once it exists."
    );
  }

  const outcome = await db.transaction(async (tx) => {
    const entity = await lockWritableEntity(tx, userId, entityId);
    if (
      !(await isBodyProperty(
        entity.profileId,
        entity.workspaceId,
        propertySlug
      ))
    ) {
      return refuse(
        "not_body_property",
        "Only the field that holds this object's main text can become its document."
      );
    }
    if (entity.documentId) {
      return refuse(
        "body_exists",
        "This object already has a document. Nothing was moved."
      );
    }
    const properties = (entity.properties ?? {}) as Record<string, unknown>;
    const value = properties[propertySlug];
    if (typeof value !== "string" || !value.trim()) {
      return refuse("empty_value", "There is no text to move.");
    }

    // The ONE create door (fresh key + row + v1 checkpoint), in THIS tx.
    const doc = await createDocumentWithContent(tx, eventRepository, {
      ownerUserId: userId,
      workspaceId: entity.workspaceId,
      title: entity.title || "Untitled",
      type: "markdown",
      content: value,
      mimeType: "text/markdown",
      provenance: { createdByKind: "human" },
    });
    const stamp: PromotedFromStamp = {
      entityId,
      propertySlug,
      revision: doc.contentRevision,
    };
    await tx
      .update(documents)
      .set({
        metadata: {
          ...((doc.metadata ?? {}) as Record<string, unknown>),
          promotedFrom: stamp,
        },
      })
      .where(eq(documents.id, doc.id));

    const { [propertySlug]: _moved, ...rest } = properties;
    await tx
      .update(entities)
      .set({ documentId: doc.id, properties: rest, updatedAt: new Date() })
      .where(eq(entities.id, entityId));

    return {
      status: "promoted" as const,
      entityId,
      propertySlug,
      documentId: doc.id,
      revision: doc.contentRevision,
      workspaceId: entity.workspaceId,
      profileId: entity.profileId,
      properties: rest,
    };
  });

  if (outcome.status !== "promoted") return outcome;
  await afterEntityWrite({
    userId,
    entityId,
    workspaceId: outcome.workspaceId,
    profileId: outcome.profileId,
    properties: outcome.properties,
    changedKeys: [propertySlug, "documentId"],
  });
  return {
    status: "promoted",
    entityId,
    propertySlug,
    documentId: outcome.documentId,
    revision: outcome.revision,
  };
}

export async function undoPromotePropertyToBody(input: {
  userId: string;
  entityId: string;
  documentId: string;
}): Promise<UndoPromotePropertyToBodyResult> {
  const { userId, entityId, documentId } = input;

  const outcome = await db.transaction(async (tx) => {
    const entity = await lockWritableEntity(tx, userId, entityId);
    const [doc] = await tx
      .select({
        id: documents.id,
        metadata: documents.metadata,
        storageKey: documents.storageKey,
        contentRevision: documents.contentRevision,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update")
      .limit(1);
    const stamp = (doc?.metadata as { promotedFrom?: PromotedFromStamp } | null)
      ?.promotedFrom;
    if (
      !doc ||
      !stamp ||
      stamp.entityId !== entityId ||
      entity.documentId !== documentId ||
      !doc.storageKey
    ) {
      return refuse(
        "not_promoted",
        "This document was not moved out of one of this object's fields."
      );
    }
    const properties = (entity.properties ?? {}) as Record<string, unknown>;
    const slotTaken =
      properties[stamp.propertySlug] !== undefined &&
      properties[stamp.propertySlug] !== null &&
      properties[stamp.propertySlug] !== "";
    if (doc.contentRevision !== stamp.revision || slotTaken) {
      return refuse(
        "edited_since",
        "The document changed after the move, so undoing it would lose that work."
      );
    }
    // The text comes back from the stored body — exactly what was moved,
    // since the revision has not moved.
    const text = (await storage.downloadBuffer(doc.storageKey)).toString(
      "utf-8"
    );
    const restored = { ...properties, [stamp.propertySlug]: text };
    await tx
      .update(entities)
      .set({ documentId: null, properties: restored, updatedAt: new Date() })
      .where(eq(entities.id, entityId));
    return {
      status: "restored" as const,
      propertySlug: stamp.propertySlug,
      workspaceId: entity.workspaceId,
      profileId: entity.profileId,
      properties: restored,
    };
  });

  if (outcome.status !== "restored") return outcome;
  // The document is no longer anyone's body; remove it with its versions and
  // blobs. Best-effort AFTER the commit: a failure leaves an unlinked document,
  // never a lost text (the text is already back in the property).
  await new EntityBodyService(db, eventRepository)
    .deleteBody({ documentId })
    .catch((err: unknown) =>
      logger.error(
        { err, documentId, entityId },
        "[undoPromotePropertyToBody] the unlinked document was not deleted"
      )
    );
  await afterEntityWrite({
    userId,
    entityId,
    workspaceId: outcome.workspaceId,
    profileId: outcome.profileId,
    properties: outcome.properties,
    changedKeys: [outcome.propertySlug, "documentId"],
  });
  return {
    status: "restored",
    entityId,
    propertySlug: outcome.propertySlug,
    documentId,
  };
}

/** The timeline + fan-out record and the property index, after the commit. */
async function afterEntityWrite(opts: {
  userId: string;
  entityId: string;
  workspaceId: string | null;
  profileId: string | null;
  properties: Record<string, unknown>;
  changedKeys: string[];
}): Promise<void> {
  if (opts.profileId) {
    new PropertyIndexService(db)
      .reindexEntity(
        opts.entityId,
        opts.properties,
        opts.profileId,
        opts.workspaceId
      )
      .catch((err: unknown) =>
        logger.warn(
          { err, entityId: opts.entityId },
          "[promote-property-to-body] property reindex failed"
        )
      );
  }
  await recordDomainMutation({
    subjectType: "entity",
    action: "update",
    subjectId: opts.entityId,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    data: { changedKeys: opts.changedKeys },
    logData: {},
  });
}
