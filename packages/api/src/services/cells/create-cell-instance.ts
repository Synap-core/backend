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
 * An HTML cell is a PLACEMENT: its page is an
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
  documents,
} from "@synap/database";
import { HTML_CELL_KEY } from "@synap-core/types/whiteboard";
import { sql as drizzleSql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

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

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertCellInstance(
  input: NewCellInstance
): Promise<CellInstanceRow> {
  const [row] = await cellInstanceInsert(db, input).returning();
  return row;
}

function cellInstanceInsert(tx: DbOrTx, input: NewCellInstance) {
  return tx.insert(cellInstances).values({
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
  });
}

/**
 * Who may place a page, and where: the placer's OWN html page, of the space
 * the cell is placed in (review of backend#1357). One sentence for every
 * refusal (no such page, a page of another space or person, not html, a cell
 * id that names something else), so a refusal never says whether an id exists
 * elsewhere.
 */
function placementRefused(): TRPCError {
  return new TRPCError({
    code: "FORBIDDEN",
    message:
      "This page cannot be placed as a cell here: only your own html page of this space is placed. Nothing was placed.",
    cause: { reasonCode: "CELL_PLACEMENT_REFUSED" },
  });
}

type PlacementKey = {
  documentId: string;
  workspaceId: string;
  userId: string;
};

/** The cell at `id` IS this placement (same page, space, person, html-embed). */
function isSamePlacement(cell: CellInstanceRow, key: PlacementKey): boolean {
  return (
    cell.cellType === HTML_CELL_KEY &&
    cell.sourceDocumentId === key.documentId &&
    cell.workspaceId === key.workspaceId &&
    cell.userId === key.userId
  );
}

/**
 * May a placement land under `id`? True when no cell holds it yet, or the cell
 * there is already this placement (a retry). False when it names any other
 * cell: the caller reserves another id or refuses, without saying which.
 */
export async function isPlacementIdUsable(
  id: string,
  key: PlacementKey
): Promise<boolean> {
  const [atId] = await db
    .select()
    .from(cellInstances)
    .where(eq(cellInstances.id, id))
    .limit(1);
  return !atId || isSamePlacement(atId, key);
}

/**
 * Place an html page (a document the page door wrote) as an html-embed cell.
 * Only the placer's own live html page of the same space is placed
 * (`placementRefused` otherwise: FORBIDDEN, nothing written).
 * Idempotent: a cell already at `id` that is this placement, else this
 * person's html-embed cell of the same page in the same space, is returned
 * instead of a second one (a retried create, an approval run twice).
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
  const [page] = await db
    .select({
      type: documents.type,
      workspaceId: documents.workspaceId,
      userId: documents.userId,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, input.documentId))
    .limit(1);
  if (
    !page ||
    page.deletedAt ||
    page.type !== "html" ||
    page.workspaceId !== input.workspaceId ||
    page.userId !== input.userId
  ) {
    throw placementRefused();
  }
  const key: PlacementKey = {
    documentId: input.documentId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  };
  // One placement at a time per (page, space, person): the lock is held until
  // the transaction ends, so a concurrent retry waits, then finds this cell.
  return db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtext(${`html-place|${key.documentId}|${key.workspaceId}|${key.userId}`}))`
    );
    if (input.id) {
      const [atId] = await tx
        .select()
        .from(cellInstances)
        .where(eq(cellInstances.id, input.id))
        .limit(1);
      if (atId) {
        if (!isSamePlacement(atId, key)) throw placementRefused();
        return atId;
      }
    }
    const [placed] = await tx
      .select()
      .from(cellInstances)
      .where(
        and(
          eq(cellInstances.sourceDocumentId, key.documentId),
          eq(cellInstances.cellType, HTML_CELL_KEY),
          eq(cellInstances.workspaceId, key.workspaceId),
          eq(cellInstances.userId, key.userId)
        )
      )
      .limit(1);
    if (placed) return placed;
    const [row] = await cellInstanceInsert(tx, {
      id: input.id,
      workspaceId: key.workspaceId,
      userId: key.userId,
      cellType: HTML_CELL_KEY,
      config: { sourceDocumentId: key.documentId },
      name: input.name,
      sourceDocumentId: key.documentId,
      agentUserId: input.agentUserId,
    })
      .onConflictDoNothing({ target: cellInstances.id })
      .returning();
    // The caller's id was taken meanwhile by another cell (not this
    // placement: that would have been found above, under the lock).
    if (!row) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This cell id was just taken by another cell. Nothing was placed: place the page again with another id, or none.",
        cause: { reasonCode: "CELL_ID_TAKEN" },
      });
    }
    return row;
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
