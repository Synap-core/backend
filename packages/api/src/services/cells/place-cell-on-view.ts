/**
 * `placeOn` — define a cell AND put it on a bento view as a tile, in one act
 * (design b199a3a4, Question 2, slice 4).
 *
 * A cell an agent defines used to be "not surfaced anywhere until it is
 * bound": approving it wrote a `widget_definitions` row and nothing showed it.
 * With `placeOn: { viewId }` the ONE writer (`defineCell`) writes the cell and
 * appends a `widget` block naming its typeKey to that view's `config.blocks`,
 * in ONE database transaction: a placement that is refused rolls the cell back
 * too, so there is never an orphan cell.
 *
 * Three readers, one rule each:
 *   - `CellPlacementSchema`: the wire shape, declared once for the MCP tool,
 *     Hub `POST /cells/define` and the approve executor;
 *   - `checkCellPlacement`: may this cell land on that view (exists, is a
 *     bento, same scope, the caller may read or write it), run by a door
 *     BEFORE it files a proposal (`read`) and by `defineCell` before it writes
 *     (`write`, as the approver);
 *   - `appendCellTile`: the write, inside the caller's transaction.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb, and, eq } from "@synap/database";
import { views, widgetDefinitions } from "@synap/database/schema";
import { validateViewConfig } from "@synap-core/types";

/** Where an approved cell lands: a bento view, by id. */
export const CellPlacementSchema = z
  .object({ viewId: z.string().uuid() })
  .strict();
export type CellPlacement = z.infer<typeof CellPlacementSchema>;

/** The placement a gated proposal carries: the view's name stamped for the reviewer. */
export interface ProposedCellPlacement extends CellPlacement {
  viewName: string;
}

/**
 * The placement a stored proposal payload carries (caller-supplied:
 * re-validated). Absent ⇒ undefined; present but malformed ⇒ refused, never
 * read as "place nowhere": the reviewer approved a tile.
 */
export function readCellPlacement(value: unknown): CellPlacement | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = CellPlacementSchema.safeParse(
    typeof value === "object"
      ? { viewId: (value as { viewId?: unknown }).viewId }
      : value
  );
  if (!parsed.success)
    throw refused("BAD_REQUEST", "the proposal's placeOn is malformed.");
  return parsed.data;
}

function refused(
  code: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST",
  message: string
): TRPCError {
  return new TRPCError({
    code,
    message: `placeOn refused: ${message} Nothing was written.`,
    cause: { reasonCode: "CELL_PLACEMENT_REFUSED" },
  });
}

/**
 * May a cell of `cellWorkspaceId` land on `placeOn.viewId` for `userId`?
 * Throws a TRPCError naming why not; returns the view's name.
 *
 * Scope: a space cell renders only in its own space (`listRenderables`), so it
 * may land on a view of that space; a pod-wide cell on any view.
 */
export async function checkCellPlacement(
  placeOn: CellPlacement,
  opts: {
    cellWorkspaceId: string | null;
    userId: string;
    permission: "read" | "write";
  }
): Promise<{ viewId: string; viewName: string }> {
  const db = await getDb();
  const [view] = await db
    .select({
      id: views.id,
      name: views.name,
      type: views.type,
      workspaceId: views.workspaceId,
      userId: views.userId,
      projectId: views.projectId,
      exposedAt: views.exposedAt,
    })
    .from(views)
    .where(eq(views.id, placeOn.viewId))
    .limit(1);
  if (!view) throw refused("NOT_FOUND", `view ${placeOn.viewId} not found.`);
  // The one view read/write floor, as the views router applies it.
  const { assertViewAccess } = await import("../../routers/views.js");
  try {
    await assertViewAccess(view, opts.userId, opts.permission);
  } catch {
    throw refused(
      "FORBIDDEN",
      `you may not ${opts.permission} view ${placeOn.viewId}.`
    );
  }
  if (view.type !== "bento") {
    throw refused(
      "BAD_REQUEST",
      `view "${view.name}" is a ${view.type} view; a cell is placed as a tile on a bento view.`
    );
  }
  if (
    opts.cellWorkspaceId !== null &&
    view.workspaceId !== opts.cellWorkspaceId
  ) {
    throw refused(
      "BAD_REQUEST",
      `the cell belongs to space ${opts.cellWorkspaceId} and view "${view.name}" is ${view.workspaceId ? `in space ${view.workspaceId}` : "pod-wide"}; a space cell renders only in its own space.`
    );
  }
  return { viewId: view.id, viewName: view.name };
}

type Db = Awaited<ReturnType<typeof getDb>>;
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Append the cell's tile to the view, inside the caller's transaction. A view
 * that already shows this cell keeps its tile (no duplicate). The tile sits
 * below the lowest one, at the cell's stored `defaultSize`. The view row is
 * written as `ViewRepository.update` writes it: by its creator only.
 */
export async function appendCellTile(
  tx: DbOrTx,
  input: {
    viewId: string;
    cellId: string;
    typeKey: string;
    userId: string;
  }
): Promise<{
  viewId: string;
  workspaceId: string | null;
  blockId: string;
  alreadyPlaced: boolean;
}> {
  const [view] = await tx
    .select({
      config: views.config,
      type: views.type,
      workspaceId: views.workspaceId,
    })
    .from(views)
    .where(and(eq(views.id, input.viewId), eq(views.userId, input.userId)))
    .for("update");
  if (!view) {
    throw refused(
      "FORBIDDEN",
      `view ${input.viewId} is gone or is not yours to change.`
    );
  }
  const config = (view.config ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(config.blocks)
    ? (config.blocks as Array<Record<string, unknown>>)
    : [];
  const existing = blocks.find(
    (b) => b.kind === "widget" && b.widgetType === input.typeKey
  );
  if (existing) {
    return {
      viewId: input.viewId,
      workspaceId: view.workspaceId,
      blockId: String(existing.id),
      alreadyPlaced: true,
    };
  }
  const [cell] = await tx
    .select({ defaultSize: widgetDefinitions.defaultSize })
    .from(widgetDefinitions)
    .where(eq(widgetDefinitions.id, input.cellId));
  const size = (cell?.defaultSize ?? { w: 6, h: 4 }) as {
    w: number;
    h: number;
  };
  const bottom = blocks.reduce((max, b) => {
    const pos = b.pos as { y?: number; h?: number } | undefined;
    return Math.max(max, (pos?.y ?? 0) + (pos?.h ?? 0));
  }, 0);
  const blockId = `cell-${randomUUID()}`;
  const next = {
    ...config,
    blocks: [
      ...blocks,
      {
        id: blockId,
        kind: "widget",
        widgetType: input.typeKey,
        pos: { x: 0, y: bottom, w: size.w, h: size.h },
      },
    ],
  };
  const validation = validateViewConfig(view.type, next);
  if (!validation.valid) {
    throw refused(
      "BAD_REQUEST",
      `the view's layout would not be a valid bento: ${validation.errors?.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}.`
    );
  }
  await tx
    .update(views)
    .set({ config: next, updatedAt: new Date() })
    .where(and(eq(views.id, input.viewId), eq(views.userId, input.userId)));
  return {
    viewId: input.viewId,
    workspaceId: view.workspaceId,
    blockId,
    alreadyPlaced: false,
  };
}
