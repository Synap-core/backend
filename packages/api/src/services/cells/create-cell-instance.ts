/**
 * Creating a cell instance: the ONE insert every door calls (tRPC
 * `cellInstances.create` / `createHtmlCell`, Hub `POST /cell-instances` and
 * `/cell-instances/html`, the whiteboard place door). Doors keep their own
 * floors and governance; this is only what a created cell IS.
 *
 * Provenance from the actor: an agent's cell is `createdByKind: "agent"` and
 * `trustLevel: "generated"` (conservative: it proposes its own writes); a
 * person's is `user` / `trusted`.
 *
 * An HTML cell's content is a versioned `documents` row created through the
 * ONE create door (`createDocumentWithContent`: fresh-key upload, row, v1
 * checkpoint); the cell references it (`sourceDocumentId`).
 */

import {
  db,
  eventRepository,
  createDocumentWithContent,
  normalizeDocumentType,
  cellInstances,
} from "@synap/database";

export interface NewCellInstance {
  /** A caller-fixed id (the place door's retry-safe ids); else generated. */
  id?: string;
  workspaceId: string;
  userId: string;
  cellType: string;
  config?: Record<string, unknown>;
  name?: string;
  isTemplate?: boolean;
  sourceDocumentId?: string;
  /** The agent that created it, when one did (provenance and trust). */
  agentUserId?: string | null;
}

export type CellInstanceRow = typeof cellInstances.$inferSelect;

export async function insertCellInstance(
  input: NewCellInstance
): Promise<CellInstanceRow> {
  const [row] = await db
    .insert(cellInstances)
    .values({
      ...(input.id ? { id: input.id } : {}),
      workspaceId: input.workspaceId,
      userId: input.userId,
      cellType: input.cellType,
      config: input.config ?? {},
      name: input.name,
      isTemplate: input.isTemplate ?? false,
      sourceDocumentId: input.sourceDocumentId,
      createdByKind: input.agentUserId ? "agent" : "user",
      trustLevel: input.agentUserId ? "generated" : "trusted",
    })
    .returning();
  return row;
}

export async function createHtmlCellInstance(input: {
  id?: string;
  workspaceId: string;
  userId: string;
  html: string;
  name?: string;
  agentUserId?: string | null;
}): Promise<CellInstanceRow> {
  const document = await createDocumentWithContent(db, eventRepository, {
    ownerUserId: input.userId,
    workspaceId: input.workspaceId,
    title: input.name ?? "HTML Cell",
    type: normalizeDocumentType("text", "text"),
    extension: "html",
    content: input.html,
    mimeType: "text/html",
    provenance: { createdByKind: input.agentUserId ? "ai_agent" : "human" },
  });
  return insertCellInstance({
    id: input.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    cellType: "html-embed",
    name: input.name,
    sourceDocumentId: document.id,
    agentUserId: input.agentUserId,
  });
}
