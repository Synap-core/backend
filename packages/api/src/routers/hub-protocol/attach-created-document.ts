/**
 * Attach a just-created document to an entity — the ONE attach step shared by
 * every create door that accepts `entityId` (MCP `synap_create_document`,
 * Hub REST `POST /documents`).
 *
 * The link lives on `entities.documentId` (`documents.entityId` was removed),
 * so attaching is a separate GOVERNED entity update through the regular
 * entities router, never a side effect of the document write. Its outcome is
 * reported on the create response as `attached`, so a caller can never read a
 * create that did not attach as one that did.
 */

import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { createHubProtocolCallerContext } from "./utils.js";

export interface AttachCreatedDocumentInput {
  /** The `documents.createDocument` result. */
  created: unknown;
  entityId: string;
  userId: string;
  scopes: string[];
  /**
   * Membership-gated lens, never a raw model-supplied id — this drives a
   * GOVERNED entity update.
   */
  workspaceId: string | null | undefined;
  sessionId?: string | null;
  sourceMessageId?: string | null;
  agentUserId?: string;
  keyType?: string | null;
  keyWorkspaceId?: string | null;
  reasoning: string;
}

export async function attachCreatedDocument(
  input: AttachCreatedDocumentInput
): Promise<Record<string, unknown>> {
  const doc = input.created as Record<string, unknown>;
  const { entityId } = input;
  // A proposal-gated document has no row yet: `documentId` is only the id it
  // WILL get. Linking to it now would leave a dangling reference, so say so
  // instead of pretending the attach happened.
  if (doc.status === "proposed") {
    return {
      ...doc,
      attached: {
        entityId,
        status: "skipped",
        reason:
          "The document itself is awaiting review — approve it first, then set the entity's documentId (MCP: synap_update_entity).",
      },
    };
  }
  const documentId =
    typeof doc.documentId === "string"
      ? doc.documentId
      : typeof doc.id === "string"
        ? doc.id
        : undefined;
  if (!documentId) {
    return {
      ...doc,
      attached: {
        entityId,
        status: "failed",
        reason: "The create returned no document id, so nothing was attached.",
      },
    };
  }
  const attachCtx = await createHubProtocolCallerContext(
    input.userId,
    input.scopes,
    input.workspaceId,
    input.sourceMessageId,
    input.sessionId,
    input.agentUserId,
    input.keyType,
    input.keyWorkspaceId
  );
  const attached = await regularEntitiesRouter.createCaller(attachCtx).update({
    id: entityId,
    documentId,
    reasoning: input.reasoning,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
  });
  return {
    ...doc,
    attached: {
      entityId,
      documentId,
      // Governed like every other entity update: an agent may get a proposal
      // here even though the document itself was auto-approved.
      ...(attached as Record<string, unknown>),
    },
  };
}
