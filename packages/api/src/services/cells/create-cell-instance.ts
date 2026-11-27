/**
 * Creating a cell instance: the ONE insert every door calls (tRPC
 * `cellInstances.create` / `createHtmlCell`, Hub `POST /cell-instances` and
 * `/cell-instances/html`, the whiteboard place door, the `document/create`
 * approval of a page placed as a cell). Doors keep their own floors and
 * governance; this is only what a created cell IS.
 *
 * Provenance from the actor: an agent's cell is `createdByKind: "agent"` and
 * `trustLevel: "generated"` (conservative: it proposes its own writes); a
 * person's is `user` / `trusted`.
 *
 * An HTML cell is a PLACEMENT (founder decision, 27 Nov 2026): its page is an
 * html document written by the HTML page door (`createHtmlPage`, the same
 * checks and stored shape as `synap_create_document {type: "html"}`), and the
 * cell only points at it (`sourceDocumentId`, also in its props). The cell
 * holds no copy of the content.
 */

import {
  db,
  eq,
  and,
  eventRepository,
  createHtmlPage,
  cellInstances,
} from "@synap/database";
import { HTML_CELL_KEY } from "@synap-core/types/whiteboard";

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

/**
 * Place an html page (a document the page door wrote) as an html-embed cell.
 * Idempotent: a cell already at `id`, else this person's html-embed cell of
 * the same page in the same space, is returned instead of a second one (a
 * retried create, an approval run twice).
 */
export async function placeHtmlPage(input: {
  /** A caller-fixed id (a placement key, a proposal's reserved id). */
  id?: string;
  documentId: string;
  workspaceId: string;
  userId: string;
  name?: string;
  agentUserId?: string | null;
}): Promise<CellInstanceRow> {
  if (input.id) {
    const [atId] = await db
      .select()
      .from(cellInstances)
      .where(eq(cellInstances.id, input.id))
      .limit(1);
    if (atId) {
      if (atId.sourceDocumentId !== input.documentId) {
        throw new Error(
          `Cell ${atId.id} already exists and does not place page ${input.documentId}.`
        );
      }
      return atId;
    }
  }
  const [placed] = await db
    .select()
    .from(cellInstances)
    .where(
      and(
        eq(cellInstances.sourceDocumentId, input.documentId),
        eq(cellInstances.cellType, HTML_CELL_KEY),
        eq(cellInstances.workspaceId, input.workspaceId),
        eq(cellInstances.userId, input.userId)
      )
    )
    .limit(1);
  if (placed) return placed;
  return insertCellInstance({
    id: input.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    cellType: HTML_CELL_KEY,
    config: { sourceDocumentId: input.documentId },
    name: input.name,
    sourceDocumentId: input.documentId,
    agentUserId: input.agentUserId,
  });
}

/**
 * Write an html page through the page door, then place it as a cell. For a
 * caller already past its gate (a person's own create; the whiteboard place
 * door after `whiteboard/place`). An agent's html cell from the cell routes
 * goes through the Hub document door instead, whose gate files the page.
 * A page the door refuses throws `HtmlPageRefusal`, and nothing is written.
 */
export async function createHtmlCellInstance(input: {
  id?: string;
  workspaceId: string;
  userId: string;
  html: string;
  name?: string;
  /** The page's declared reads (checked by the door); absent = undeclared. */
  reads?: unknown;
  agentUserId?: string | null;
}): Promise<CellInstanceRow> {
  const page = await createHtmlPage(db, eventRepository, {
    ownerUserId: input.userId,
    workspaceId: input.workspaceId,
    title: input.name ?? "HTML Cell",
    content: input.html,
    reads: input.reads,
    provenance: input.agentUserId
      ? { createdByKind: "ai_agent", agentUserId: input.agentUserId }
      : { createdByKind: "human" },
  });
  return placeHtmlPage({
    id: input.id,
    documentId: page.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    name: input.name,
    agentUserId: input.agentUserId,
  });
}
