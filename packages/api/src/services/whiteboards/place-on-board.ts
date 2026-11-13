/**
 * placeOnBoard — the ONE governed door for an agent (or a person) to put
 * things on a whiteboard and to change or remove what is there.
 *
 * Doors: Hub `POST /api/hub/whiteboards/:viewId/placements`, MCP
 * `synap_place_on_board`, the builtin `output.generate` verb, and the
 * `whiteboard/*` proposal executors (approval replays `applyPlacement` /
 * `applyShapeChanges`). Nothing else writes board records from the server;
 * the old `board:place` socket fan-out is retired (it duplicated shapes on
 * every open browser and lost them when none was open).
 *
 * FLOOR: the board's own room (`resolveBoardView`, shared with the read door):
 * `edit` on `resolveDocumentRoomAccess`; a key bound to a space only reaches
 * that space's boards, and a caller naming the space it acts in
 * (`workspaceId`) is refused on a board of another space.
 *
 * GOVERNANCE (founder decision, 13 Nov 2026), through `checkPermissionOrPropose`:
 *  - CREATE (`whiteboard/place`, classed reversible): by default applied at
 *    once; an agent's shapes are marked `meta.pending` (the person keeps or
 *    rejects them on the board) with `meta.placedBy` / `meta.placedAt`. Where
 *    the person made it a proposal, nothing is written until approval.
 *  - CHANGE (`whiteboard/update_shapes`, disruptive) and REMOVE
 *    (`whiteboard/delete_shapes`, destructive): proposals by default.
 *
 * WRITE: the realtime bridge `POST /yjs/:roomId/apply` (open room: one Y
 * transaction, saved at once; closed: the stored file, under the room's lock).
 * Ids are fixed by the placement key, so a retry REPLACES.
 *
 * A refusal is a `BoardPlaceError` with a reason (`BOARD_PLACE_FAILURES`);
 * a failed read or write is never reported as done.
 */

import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  and,
  inArray,
  cellInstances,
  entities,
  views,
  automations,
  getActingAgentUserId,
  userVisibleWhere,
  ownerPrivateVisibleWhere,
} from "@synap/database";
import {
  AUTOMATION_CELL_BY_MODE,
  BOARD_PLACE_FAILURES,
  BOARD_PROPS_MAX_CHARS,
  BoardApplyError,
  BoardBuildError,
  EMBED_CELL_GRID_SIZE,
  HTML_CELL_KEY,
  URL_CELL_KEY,
  boardPlacementContext,
  buildPlacementRecords,
  planBoardApply,
  placedShapeId,
  stableDigest,
  type BoardPlaceFailure,
  type BoardPlacePartResult,
  type BoardPlacedBy,
  type BoardPlacementOptions,
  type BoardRecord,
  type BoardResourceRef,
  type BoardShapeUpdate,
  type PlaceOnBoardRequest,
  type PlaceOnBoardResult,
  type PlaceableBoardResource,
} from "@synap-core/types/whiteboard";
import type {
  YjsRoomApplyError,
  YjsRoomApplyReply,
  YjsRoomApplyRequest,
} from "@synap/events/realtime-schemas";
import {
  classifyEmbedUrl,
  embedUrlRefusalMessage,
} from "@synap-core/types/embed-url";
import { bridgeRequestHeaders } from "../../utils/chat-realtime-broadcast.js";
import { podPublicOrigin } from "../../utils/deep-links.js";
import type { PermissionResult } from "../../utils/permission-check.js";
import {
  BoardSceneReadError,
  loadBoardRecords,
  resolveBoardView,
  type ResolvedBoard,
} from "./read-board-scene.js";
import {
  createHtmlCellInstance,
  insertCellInstance,
} from "../cells/create-cell-instance.js";

const logger = createLogger({ module: "place-on-board" });

/** How long the bridge write may take before it is a failure (ms). */
export const BOARD_APPLY_TIMEOUT_MS = 20_000;

export class BoardPlaceError extends Error {
  readonly status: (typeof BOARD_PLACE_FAILURES)[BoardPlaceFailure];
  constructor(
    readonly reason: BoardPlaceFailure,
    message: string
  ) {
    super(message);
    this.name = "BoardPlaceError";
    this.status = BOARD_PLACE_FAILURES[reason];
  }
}

/** A place-door refusal as a tRPC error (the one status → code map). */
export function boardPlaceErrorToTrpc(err: BoardPlaceError): TRPCError {
  const code =
    err.status === 404
      ? "NOT_FOUND"
      : err.status === 403
        ? "FORBIDDEN"
        : err.status === 409
          ? "CONFLICT"
          : err.status === 400
            ? "BAD_REQUEST"
            : err.status === 504
              ? "TIMEOUT"
              : "INTERNAL_SERVER_ERROR";
  return new TRPCError({
    code,
    message: `${err.message} (reason: ${err.reason})`,
  });
}

/** The read door's reasons, as the place door words them. */
function fromReadError(err: BoardSceneReadError): BoardPlaceError {
  const reason: BoardPlaceFailure =
    err.reason === "live_unavailable" || err.reason === "stored_unavailable"
      ? "unavailable"
      : err.reason === "live_unreadable" || err.reason === "stored_unreadable"
        ? "unreadable"
        : err.reason;
  return new BoardPlaceError(reason, err.message);
}

async function readBoard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BoardSceneReadError) throw fromReadError(err);
    throw err;
  }
}

function realtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

// ── The one write: the realtime bridge ──────────────────────────────────────

/**
 * Write to the board (`POST /yjs/:roomId/apply`): create records, patch and
 * remove shapes, decided against the board AS IT IS under the room's lock.
 * Any answer but a 200 is a refusal with a reason; a realtime server that
 * does not answer is `unavailable`; one that answers too late is `timeout`
 * (the write MAY have landed). Retry is safe either way (records replace
 * themselves by id while pending; a kept shape is never reset).
 */
export async function applyToBoard(
  board: Pick<ResolvedBoard, "roomId" | "documentId">,
  request: Omit<YjsRoomApplyRequest, "documentId">
): Promise<YjsRoomApplyReply> {
  let res: Response;
  try {
    res = await fetch(
      `${realtimeUrl()}/yjs/${encodeURIComponent(board.roomId)}/apply`,
      {
        method: "POST",
        headers: bridgeRequestHeaders(),
        body: JSON.stringify({ ...request, documentId: board.documentId }),
        signal: AbortSignal.timeout(BOARD_APPLY_TIMEOUT_MS),
      }
    );
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    logger.warn(
      { err, roomId: board.roomId, timedOut },
      "board apply: realtime did not answer"
    );
    throw timedOut
      ? new BoardPlaceError(
          "timeout",
          "The realtime server did not answer in time. The write may or may not have landed: retry is safe (the same call replaces itself, a shape you kept is never reset)."
        )
      : new BoardPlaceError(
          "unavailable",
          "The realtime server could not be reached, so nothing was written. Retry shortly: the same call replaces itself."
        );
  }
  const body = (await res.json().catch(() => null)) as
    (YjsRoomApplyReply & Partial<YjsRoomApplyError>) | null;
  if (res.ok && body?.applied === true) return body;
  const reason = body?.reason;
  if (
    reason === "load_failed" ||
    reason === "not_found" ||
    reason === "save_failed" ||
    reason === "bad_request" ||
    reason === "shape_not_found" ||
    reason === "timeout" ||
    reason === "unavailable"
  ) {
    throw new BoardPlaceError(
      reason,
      body?.error ?? `The board refused the write (${reason}).`
    );
  }
  logger.warn(
    { status: res.status, roomId: board.roomId },
    "board apply: unexpected answer"
  );
  throw new BoardPlaceError(
    "unavailable",
    `The realtime server answered ${res.status} without applying the write (an older realtime server has no apply route). Nothing was written.`
  );
}

/** A refused patch or removal, as the place door words it. */
function fromApplyError(err: unknown): unknown {
  return err instanceof BoardApplyError
    ? new BoardPlaceError(err.reason, err.message)
    : err;
}

/**
 * Did a write whose answer was lost (`timeout`) land? Read the board: the
 * shapes it creates are there / the shapes it removes are gone.
 */
export async function writeLanded(
  board: Pick<ResolvedBoard, "roomId" | "documentId">,
  expect: { present?: readonly string[]; absent?: readonly string[] }
): Promise<boolean> {
  try {
    const { records } = await loadBoardRecords(board.roomId, board.documentId);
    return (
      (expect.present ?? []).every((id) => id in records) &&
      (expect.absent ?? []).every((id) => !(id in records)) &&
      (expect.present?.length ?? 0) + (expect.absent?.length ?? 0) > 0
    );
  } catch {
    return false;
  }
}

// ── Materializing resources into what the board can hold ────────────────────

/**
 * A cell instance id fixed by the placement AND the cell's content: a retry
 * reuses the same cell; the same key reused with different content makes a
 * new one (the second call's html is never dropped for the first's).
 */
export function placedCellId(
  placementKey: string,
  resourceIndex: number,
  part: string,
  content: unknown
): string {
  const h = createHash("sha256")
    .update(
      `synap-placed-cell:${placementKey}:${resourceIndex}:${part}:${JSON.stringify(content)}`
    )
    .digest("hex");
  // A v4-shaped uuid (version and variant nibbles set) from the digest.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(
    (parseInt(h.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface MaterializeContext {
  placementKey: string;
  userId: string;
  agentUserId?: string | null;
  workspaceId: string | null;
}

/** The existing cell with this id, or a new one made by `create`. */
async function ensureCell(
  id: string,
  ctx: MaterializeContext,
  create: () => Promise<{ id: string }>
): Promise<string> {
  const [existing] = await db
    .select({ id: cellInstances.id, workspaceId: cellInstances.workspaceId })
    .from(cellInstances)
    .where(eq(cellInstances.id, id))
    .limit(1);
  if (existing) {
    if (existing.workspaceId !== ctx.workspaceId) {
      throw new BoardPlaceError(
        "materialize_failed",
        "A cell this placement would reuse belongs to another space."
      );
    }
    return existing.id;
  }
  return (await create()).id;
}

/**
 * Turn the resources the board cannot hold as they are (html, url,
 * automation, a new cell, a deck) into cell instances, as the browser placer
 * does, with ids fixed by the placement so a retry reuses them. A cell that
 * cannot be created is an error: never placed as an empty shape.
 */
export async function materializeBoardResources(
  resources: readonly BoardResourceRef[],
  ctx: MaterializeContext
): Promise<PlaceableBoardResource[]> {
  const needsCell = resources.some(
    (r) => r.kind !== "entity" && r.kind !== "view" && r.kind !== "cellInstance"
  );
  if (needsCell && !ctx.workspaceId) {
    throw new BoardPlaceError(
      "bad_request",
      "This board is in no space, so html, url, automation, cell and deck resources (cells) cannot be created on it. Place entities or views."
    );
  }
  const workspaceId = ctx.workspaceId as string;
  const base = {
    workspaceId,
    userId: ctx.userId,
    agentUserId: ctx.agentUserId ?? null,
  };
  const out: PlaceableBoardResource[] = [];
  try {
    for (const [i, r] of resources.entries()) {
      if (
        r.kind === "entity" ||
        r.kind === "view" ||
        r.kind === "cellInstance"
      ) {
        out.push(r);
      } else if (r.kind === "cellDefinition") {
        const id = placedCellId(ctx.placementKey, i, "main", {
          k: r.cellKey,
          p: r.props,
          n: r.name,
        });
        await ensureCell(id, ctx, () =>
          insertCellInstance({
            ...base,
            id,
            cellType: r.cellKey,
            config: r.props,
            name: r.name,
          })
        );
        out.push({
          kind: "cellInstance",
          cellInstanceId: id,
          cellKey: r.cellKey,
          props: r.props,
          title: r.name,
          defaultSize: r.defaultSize,
        });
      } else if (r.kind === "html") {
        const id = placedCellId(ctx.placementKey, i, "main", {
          h: r.html,
          n: r.name,
        });
        await ensureCell(id, ctx, () =>
          createHtmlCellInstance({ ...base, id, html: r.html, name: r.name })
        );
        out.push({
          kind: "cellInstance",
          cellInstanceId: id,
          cellKey: HTML_CELL_KEY,
          title: r.name,
          defaultSize: { ...EMBED_CELL_GRID_SIZE },
        });
      } else if (r.kind === "automation") {
        const def = AUTOMATION_CELL_BY_MODE[r.mode];
        const props = { automationId: r.automationId };
        const id = placedCellId(ctx.placementKey, i, "main", {
          a: r.automationId,
          m: r.mode,
          t: r.title,
        });
        await ensureCell(id, ctx, () =>
          insertCellInstance({
            ...base,
            id,
            cellType: def.cellKey,
            config: props,
            name: r.title ?? def.title,
          })
        );
        out.push({
          kind: "cellInstance",
          cellInstanceId: id,
          cellKey: def.cellKey,
          props,
          title: r.title ?? def.title,
          defaultSize: def.defaultSize,
        });
      } else if (r.kind === "url") {
        const props = {
          url: r.url,
          ...(r.title !== undefined ? { title: r.title } : {}),
        };
        const id = placedCellId(ctx.placementKey, i, "main", props);
        await ensureCell(id, ctx, () =>
          insertCellInstance({
            ...base,
            id,
            cellType: URL_CELL_KEY,
            config: props,
            name: r.title ?? r.url,
          })
        );
        out.push({
          kind: "cellInstance",
          cellInstanceId: id,
          cellKey: URL_CELL_KEY,
          props,
          title: r.title ?? r.url,
          defaultSize: { ...EMBED_CELL_GRID_SIZE },
        });
      } else {
        // artboard-deck: one html-embed cell per slide.
        const slides: Array<{ cellInstanceId: string; title?: string }> = [];
        for (const [j, slide] of r.slides.entries()) {
          const id = placedCellId(ctx.placementKey, i, `slide-${j}`, {
            h: slide.html,
            n: slide.title ?? r.title,
          });
          await ensureCell(id, ctx, () =>
            createHtmlCellInstance({
              ...base,
              id,
              html: slide.html,
              name: slide.title ?? r.title,
            })
          );
          slides.push({
            cellInstanceId: id,
            ...(slide.title !== undefined ? { title: slide.title } : {}),
          });
        }
        out.push({
          kind: "artboard-deck-materialized",
          preset: r.preset,
          ...(r.title !== undefined ? { title: r.title } : {}),
          slides,
        });
      }
    }
  } catch (err) {
    if (err instanceof BoardPlaceError) throw err;
    logger.error({ err }, "board placement: a cell could not be created");
    throw new BoardPlaceError(
      "materialize_failed",
      `A cell the placement needs could not be created: ${err instanceof Error ? err.message : String(err)}. Nothing was placed.`
    );
  }
  return out;
}

/** The url a resource would embed in an iframe, if any. */
function embeddedUrlOf(r: BoardResourceRef): string | null {
  if (r.kind === "url") return r.url;
  if (
    (r.kind === "cellDefinition" && r.cellKey === URL_CELL_KEY) ||
    (r.kind === "cellInstance" && r.cellKey === URL_CELL_KEY)
  ) {
    const url = r.props?.url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

/**
 * The browser's embed rule, on the server (`classifyEmbedUrl`, shared from
 * `@synap-core/types/embed-url`): an agent's url embed must be a website
 * (https, not a stored file, not the pod itself) before it reaches a board.
 * HTML is not a url embed: it renders as a sandboxed `srcdoc` (scripts, no
 * same origin), so this rule does not apply to it.
 */
export function assertEmbeddableResources(
  resources: readonly BoardResourceRef[]
): void {
  const podUrl = podPublicOrigin() ?? null;
  resources.forEach((r, i) => {
    const url = embeddedUrlOf(r);
    if (url === null) return;
    const verdict = classifyEmbedUrl(url, { podUrl });
    if (verdict.kind === "website") return;
    throw new BoardPlaceError(
      "embed_refused",
      `resources[${i}]: ${embedUrlRefusalMessage(verdict)} (${verdict.kind === "refused" ? verdict.reason : verdict.kind}). Nothing was placed.`
    );
  });
}

// ── The cores the door and the executors share ──────────────────────────────

/**
 * The placement key: the caller's idempotency key, else the request itself.
 * Both are scoped to the board AND the actor, so two actors using the key
 * "1" never share shape ids or cells.
 */
export function placementKeyFor(input: {
  viewId: string;
  actorId: string;
  idempotencyKey?: string;
  resources: readonly BoardResourceRef[];
  options?: BoardPlacementOptions;
}): string {
  if (input.idempotencyKey)
    return `${input.viewId}:${input.actorId}:key:${input.idempotencyKey}`;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        actor: input.actorId,
        resources: input.resources,
        options: input.options ?? {},
      })
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.viewId}:req:${digest}`;
}

/** The top-level shape ids a placement writes (known before it runs). */
export function predictedShapeIds(
  placementKey: string,
  resources: readonly BoardResourceRef[]
): string[] {
  return resources.flatMap((r, i) =>
    r.kind === "artboard-deck"
      ? r.slides.map((_, j) => placedShapeId(placementKey, i, `slide-${j}`))
      : [placedShapeId(placementKey, i)]
  );
}

// ── References: every id a resource names is checked and its card filled ──

/**
 * Resolve the ids a resource points at, as the person: it must exist, be
 * readable by them, and (for a key bound to a space) lie in that space; a
 * cell or automation must belong to the board's own space. The shape shows
 * what the ROW says (an entity card's title and type), never what the agent
 * wrote. A reference that does not resolve refuses the whole call.
 */
export async function resolveBoardReferences(
  resources: readonly BoardResourceRef[],
  ctx: {
    userId: string;
    boardWorkspaceId: string | null;
    confinedWorkspaceId?: string | null;
  }
): Promise<BoardResourceRef[]> {
  const entityIds = new Set<string>();
  const viewIds = new Set<string>();
  const cellIds = new Set<string>();
  const automationIds = new Set<string>();
  for (const r of resources) {
    if (r.kind === "entity") entityIds.add(r.entityId);
    else if (r.kind === "view") viewIds.add(r.viewId);
    else if (r.kind === "cellInstance") cellIds.add(r.cellInstanceId);
    else if (r.kind === "automation") automationIds.add(r.automationId);
  }
  const confined = ctx.confinedWorkspaceId ?? null;
  const inConfined = (ws: string | null, home?: string | null) =>
    !confined || ws === confined || (ws === null && home === confined);
  const notFound = (what: string, id: string) =>
    new BoardPlaceError(
      "reference_not_found",
      `${what} ${id} does not exist, or you cannot read it from this board's space. Nothing was placed.`
    );

  const entityRows = entityIds.size
    ? await db
        .select({
          id: entities.id,
          type: entities.type,
          title: entities.title,
          profileId: entities.profileId,
          workspaceId: entities.workspaceId,
          homeWorkspaceId: entities.homeWorkspaceId,
          properties: entities.properties,
          status: entities.status,
          updatedAt: entities.updatedAt,
        })
        .from(entities)
        .where(
          and(
            inArray(entities.id, [...entityIds]),
            userVisibleWhere(entities.workspaceId, ctx.userId)
          )
        )
    : [];
  const entityById = new Map(entityRows.map((r) => [r.id, r]));
  const viewRows = viewIds.size
    ? await db
        .select({
          id: views.id,
          type: views.type,
          name: views.name,
          workspaceId: views.workspaceId,
        })
        .from(views)
        .where(
          and(
            inArray(views.id, [...viewIds]),
            ownerPrivateVisibleWhere(
              views.workspaceId,
              views.userId,
              ctx.userId
            )
          )
        )
    : [];
  const viewById = new Map(viewRows.map((r) => [r.id, r]));
  const cellRows = cellIds.size
    ? await db
        .select({
          id: cellInstances.id,
          cellType: cellInstances.cellType,
          name: cellInstances.name,
          workspaceId: cellInstances.workspaceId,
        })
        .from(cellInstances)
        .where(inArray(cellInstances.id, [...cellIds]))
    : [];
  const cellById = new Map(cellRows.map((r) => [r.id, r]));
  const automationRows = automationIds.size
    ? await db
        .select({ id: automations.id, workspaceId: automations.workspaceId })
        .from(automations)
        .where(inArray(automations.id, [...automationIds]))
    : [];
  const automationById = new Map(automationRows.map((r) => [r.id, r]));

  return resources.map((r) => {
    if (r.kind === "entity") {
      const row = entityById.get(r.entityId);
      if (!row || !inConfined(row.workspaceId, row.homeWorkspaceId))
        throw notFound("Entity", r.entityId);
      const properties =
        row.properties && typeof row.properties === "object"
          ? (row.properties as Record<string, unknown>)
          : {};
      return {
        kind: "entity",
        entityId: row.id,
        entityType: row.type,
        profileId: row.profileId,
        title: row.title,
        properties:
          JSON.stringify(properties).length <= BOARD_PROPS_MAX_CHARS
            ? properties
            : {},
        ...(row.status ? { status: row.status } : {}),
        updatedAt: row.updatedAt?.toISOString(),
      };
    }
    if (r.kind === "view") {
      const row = viewById.get(r.viewId);
      if (!row || !inConfined(row.workspaceId))
        throw notFound("View", r.viewId);
      return {
        kind: "view",
        viewId: row.id,
        viewType: row.type,
        title: row.name,
      };
    }
    if (r.kind === "cellInstance") {
      const row = cellById.get(r.cellInstanceId);
      if (!row || row.workspaceId !== ctx.boardWorkspaceId)
        throw notFound("Cell", r.cellInstanceId);
      return {
        ...r,
        cellKey: row.cellType,
        title: row.name ?? r.title ?? null,
      };
    }
    if (r.kind === "automation") {
      const row = automationById.get(r.automationId);
      if (!row || row.workspaceId !== ctx.boardWorkspaceId)
        throw notFound("Automation", r.automationId);
    }
    return r;
  });
}

// ── The cores the door and the executors share ──────────────────────────────

/**
 * Materialize and build a placement's records against the board as it is now
 * (new shapes stack above what it holds). Shared by the door (granted) and
 * the `whiteboard/place` executor (approved): the same records either way.
 */
export async function buildPlacement(input: {
  board: ResolvedBoard;
  userId: string;
  agentUserId?: string | null;
  confinedWorkspaceId?: string | null;
  resources: readonly BoardResourceRef[];
  options?: BoardPlacementOptions;
  placementKey: string;
  placedBy: BoardPlacedBy;
  pending: boolean;
}): Promise<{ records: BoardRecord[]; shapeIds: string[] }> {
  assertEmbeddableResources(input.resources);
  const workspaceId = input.board.view.workspaceId ?? null;
  const resolved = await resolveBoardReferences(input.resources, {
    userId: input.userId,
    boardWorkspaceId: workspaceId,
    confinedWorkspaceId: input.confinedWorkspaceId,
  });
  const placeable = await materializeBoardResources(resolved, {
    placementKey: input.placementKey,
    userId: input.userId,
    agentUserId: input.agentUserId,
    workspaceId,
  });
  // Read the board AFTER the cells exist, as close to the write as possible.
  const current = await readBoard(() =>
    loadBoardRecords(input.board.roomId, input.board.documentId)
  );
  try {
    const built = buildPlacementRecords({
      resources: placeable,
      options: input.options,
      placementKey: input.placementKey,
      context: boardPlacementContext(current.records),
      placedBy: input.placedBy,
      placedAt: new Date().toISOString(),
      pending: input.pending,
    });
    return { records: built.records, shapeIds: built.shapeIds };
  } catch (err) {
    if (err instanceof BoardBuildError)
      throw new BoardPlaceError(err.reason, err.message);
    throw err;
  }
}

/** What a create wrote: its top-level shapes, minus those the board kept. */
function createdPart(
  shapeIds: string[],
  reply: YjsRoomApplyReply,
  pending: boolean
): BoardPlacePartResult {
  const skipped = shapeIds.filter((id) => reply.skipped.includes(id));
  return {
    status: "applied",
    shapeIds: shapeIds.filter((id) => !reply.skipped.includes(id)),
    target: reply.target,
    pending,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/** Build and write an approved placement (the `whiteboard/place` executor). */
export async function applyPlacement(
  input: Parameters<typeof buildPlacement>[0]
): Promise<BoardPlacePartResult> {
  const built = await buildPlacement(input);
  const reply = await applyToBoard(input.board, {
    put: built.records,
    origin: placeOrigin(input.placedBy),
  });
  return createdPart(built.shapeIds, reply, input.pending);
}

/** Apply approved (or granted) changes to existing shapes. */
export async function applyShapeChanges(input: {
  board: ResolvedBoard;
  update?: readonly BoardShapeUpdate[];
  remove?: readonly string[];
  actor: BoardPlacedBy;
}): Promise<{ target: "live" | "stored"; shapeIds: string[] }> {
  const reply = await applyToBoard(input.board, {
    ...(input.update?.length ? { patch: [...input.update] } : {}),
    ...(input.remove?.length ? { remove: [...input.remove] } : {}),
    origin: placeOrigin(input.actor),
  });
  return {
    target: reply.target,
    shapeIds: [
      ...(input.update ?? []).map((u) => u.shapeId),
      ...(input.remove ?? []),
    ],
  };
}

function placeOrigin(by: BoardPlacedBy): string {
  return `synap-place:${by.agentUserId ?? by.userId}`;
}

// ── The door ────────────────────────────────────────────────────────────────

export interface PlaceOnBoardInput {
  viewId: string;
  /** The person the call is for (the key's linked user). */
  userId: string;
  /** The agent acting, when one is. */
  agentUserId?: string | null;
  /** A key bound to one space reaches only that space's boards. */
  confinedWorkspaceId?: string | null;
  request: PlaceOnBoardRequest;
}

type Gate = PermissionResult;

function proposedPart(perm: Gate, shapeIds: string[]): BoardPlacePartResult {
  return {
    status: "proposed",
    proposalId: "proposalId" in perm ? perm.proposalId : "",
    ...("reviewUrl" in perm ? { reviewUrl: perm.reviewUrl } : {}),
    shapeIds,
  };
}

function deniedError(perm: Gate): BoardPlaceError | null {
  if ("denied" in perm && perm.denied) {
    return new BoardPlaceError("denied", perm.reason);
  }
  return null;
}

/**
 * Place on a board, or change what it holds.
 *
 * Order: (1) the floor and every check that needs no write (frame, shapes,
 * references, embeds); (2) EVERY governance gate; (3) ONE write that carries
 * every granted part (a create, patches and removals land in one Y
 * transaction). A refusal anywhere in (1) or (2) wrote nothing to the board;
 * a proposal filed before a later refusal stays reviewable. A write whose
 * answer was lost is `timeout`: it may have landed, retry is safe.
 */
export async function placeOnBoard(
  input: PlaceOnBoardInput
): Promise<PlaceOnBoardResult> {
  const { request } = input;
  // The same identity governance uses (`getActingAgentUserId() ?? supplied`):
  // an agent acting through a key is pending-marked and governed as an agent.
  const agentUserId = getActingAgentUserId() ?? input.agentUserId ?? null;
  const board = await readBoard(() =>
    resolveBoardView({
      viewId: input.viewId,
      userId: input.userId,
      confinedWorkspaceId: input.confinedWorkspaceId,
    })
  );
  const workspaceId = board.view.workspaceId ?? null;
  // The write-side fence: a caller acting in one space never writes a board of
  // another (no oracle: the same answer as an unknown board).
  if (request.workspaceId && request.workspaceId !== workspaceId) {
    throw new BoardPlaceError(
      "wrong_workspace",
      "Board not found in the space you act in. List boards with synap_list_views."
    );
  }
  if (board.access !== "edit") {
    throw new BoardPlaceError(
      "read_only",
      "You can read this board but not change it."
    );
  }

  const resources = request.resources ?? [];
  const update = request.update ?? [];
  const remove = request.remove ?? [];

  // (1) Check the whole call against the board BEFORE governance or any
  // write: a bad frame, reference, embed or unknown shape refuses everything.
  assertEmbeddableResources(resources);
  await resolveBoardReferences(resources, {
    userId: input.userId,
    boardWorkspaceId: workspaceId,
    confinedWorkspaceId: input.confinedWorkspaceId,
  });
  const current = await readBoard(() =>
    loadBoardRecords(board.roomId, board.documentId)
  );
  const frameId = request.options?.frameId;
  if (frameId && resources.length > 0) {
    const ctx = boardPlacementContext(current.records);
    if (ctx.pagePosition[frameId] === undefined) {
      throw new BoardPlaceError(
        "frame_not_found",
        `frameId ${frameId} names no shape on this board (read the board for its frame ids). Nothing was placed.`
      );
    }
  }
  if (update.length > 0 || remove.length > 0) {
    try {
      planBoardApply(current.records, { patch: update, remove });
    } catch (err) {
      throw fromApplyError(err);
    }
  }

  // (2) Every gate, before any write.
  const { checkPermissionOrPropose } =
    await import("../../utils/permission-check.js");
  const gateBase = {
    userId: input.userId,
    ...(agentUserId ? { agentUserId, source: "intelligence" } : {}),
    workspaceId,
    reasoning: request.reasoning,
    sourceMessageId: request.sourceMessageId,
  };
  const actor: BoardPlacedBy = {
    userId: input.userId,
    ...(agentUserId ? { agentUserId } : {}),
  };
  const result: PlaceOnBoardResult = {
    viewId: board.view.id,
    documentId: board.documentId,
    workspaceId,
  };

  let create:
    { placementKey: string; shapeIds: string[]; pending: boolean } | undefined;
  let patch: BoardShapeUpdate[] | undefined;
  let removal: string[] | undefined;

  if (resources.length > 0) {
    const placementKey = placementKeyFor({
      viewId: board.view.id,
      actorId: agentUserId ?? input.userId,
      idempotencyKey: request.idempotencyKey,
      resources,
      options: request.options,
    });
    const perm = await checkPermissionOrPropose({
      ...gateBase,
      subjectType: "whiteboard",
      action: "place",
      data: {
        viewId: board.view.id,
        documentId: board.documentId,
        resources,
        options: request.options,
        placementKey,
        resourceCount: resources.length,
      },
    });
    const denied = deniedError(perm);
    if (denied) throw denied;
    const shapeIds = predictedShapeIds(placementKey, resources);
    if ("proposalId" in perm) {
      result.created = proposedPart(perm, shapeIds);
    } else {
      create = { placementKey, shapeIds, pending: agentUserId !== null };
    }
  }

  if (update.length > 0) {
    // An agent's change beyond its key's grant is a proposal, not a refusal.
    const perm = await checkPermissionOrPropose({
      ...gateBase,
      proposeBeyondGrant: true,
      subjectType: "whiteboard",
      action: "update_shapes",
      data: {
        viewId: board.view.id,
        documentId: board.documentId,
        update,
        shapeCount: update.length,
      },
    });
    const denied = deniedError(perm);
    if (denied) throw denied;
    if ("proposalId" in perm) {
      result.updated = proposedPart(
        perm,
        update.map((u) => u.shapeId)
      );
    } else {
      patch = [...update];
    }
  }

  if (remove.length > 0) {
    const perm = await checkPermissionOrPropose({
      ...gateBase,
      proposeBeyondGrant: true,
      subjectType: "whiteboard",
      action: "delete_shapes",
      data: {
        viewId: board.view.id,
        documentId: board.documentId,
        shapeIds: remove,
        shapeCount: remove.length,
      },
    });
    const denied = deniedError(perm);
    if (denied) throw denied;
    if ("proposalId" in perm) {
      result.removed = proposedPart(perm, [...remove]);
    } else {
      removal = [...remove];
    }
  }

  // (3) One write for everything granted.
  if (!create && !patch && !removal) return result;
  const built = create
    ? await buildPlacement({
        board,
        userId: input.userId,
        agentUserId,
        confinedWorkspaceId: input.confinedWorkspaceId,
        resources,
        options: request.options,
        placementKey: create.placementKey,
        placedBy: actor,
        pending: create.pending,
      })
    : undefined;
  const reply = await applyToBoard(board, {
    ...(built ? { put: built.records } : {}),
    ...(patch ? { patch } : {}),
    ...(removal ? { remove: removal } : {}),
    origin: placeOrigin(actor),
  });
  if (create && built) {
    result.created = createdPart(built.shapeIds, reply, create.pending);
  }
  if (patch) {
    result.updated = {
      status: "applied",
      shapeIds: patch.map((u) => u.shapeId),
      target: reply.target,
    };
  }
  if (removal) {
    result.removed = {
      status: "applied",
      shapeIds: removal,
      target: reply.target,
    };
  }
  return result;
}

/**
 * The board a proposal names, for the person approving it: their own floor
 * (`edit`), never the proposer's. Used by the `whiteboard/*` executors.
 */
export async function resolveBoardForApprover(
  viewId: string,
  approverUserId: string
): Promise<ResolvedBoard> {
  const board = await readBoard(() =>
    resolveBoardView({ viewId, userId: approverUserId })
  );
  if (board.access !== "edit") {
    throw new BoardPlaceError(
      "read_only",
      "You can read this board but not change it, so you cannot approve a change to it."
    );
  }
  return board;
}
