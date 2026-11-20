/**
 * THE DESIGN DOOR — read, and change through typed ops, a Design app canvas
 * (a `ui-design` whose `design-json` is a board), validated against the
 * catalog snapshot the installed `design` capability carries. Plan 0fc746f4
 * §2.6. Behind the builtin verbs `design.read`, `design.catalog` and
 * `design.apply` (`capabilities/builtin-verbs.ts`), and behind the Hub
 * routes `GET /designs/catalog`, `GET /designs/:id` and `POST /designs/apply`
 * (`routers/hub-protocol/rest/designs.ts`), which the Design app calls with
 * the person's app token (ops `replace_board` / `replace_page` for a save), so
 * a person's save and an agent's change pass one parser.
 *
 * GOVERNANCE: every write goes through the governed entity door
 * (`entitiesRouter.create` / `.update`, `checkPermissionOrPropose`, whose rung
 * 0 checks the calling key's grant) as the caller: the acting agent when there
 * is one, else the person. An agent's change is reviewed as the ENTITY diff,
 * never a generic capability run. `design.apply` is self-gated: when the outer
 * gate asked for review (`mustPropose`) the entity door is told `forcePropose`;
 * the Hub routes never set it.
 *
 * What this door never does: move a design's status (the lifecycle door,
 * `expectedStatus`, does); write a design that is past its review (the change
 * becomes a revision, a NEW design in the initial state, the rule of
 * `designEditability`); overwrite a design changed since the caller read it
 * (`baseUpdatedAt`); erase parts of a stored design the catalog cannot place
 * unless the caller says so (`acceptDrops`).
 */
import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  desc,
  eq,
  isNull,
  entities,
  relations,
  getWorkspaceMembership,
} from "@synap/database";
import { capabilities } from "@synap/database/schema";
import {
  BOARD_SCHEMA_VERSION,
  DESIGN_CAPABILITY_KEY,
  DESIGN_CATALOG_METADATA_KEY,
  FRAME_PRESETS,
  GRID_COLUMNS,
  WIDTH_CLASS_BREAKPOINTS,
  applyOps,
  catalogSchema,
  composeAppCatalog,
  designEditability,
  designOpSchema,
  describeRefusal,
  emptyBoard,
  parseBoard,
  readDesignCatalog,
  readDesignLifecycle,
  widthClassOf,
  type Board,
  type DesignCatalogSnapshot,
  type DesignChange,
  type DesignKitCatalog,
  type DesignLifecycle,
  type DropReason,
  type Editability,
  type OpRefusalReason,
  type PageBlock,
  type WidthClass,
} from "@synap-core/types/design-board";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import type { Context } from "../../context.js";
import { readAppKit } from "./app-kit.js";

/** The kind of a design (builder.yaml). */
export const UI_DESIGN_PROFILE = "ui-design";
/** The catalog template whose one space holds every design (one space per domain). */
export const UI_DESIGN_TEMPLATE = "builder-workspace";
/** The ui-design property naming the app (`devplane_app`) a design is for. */
export const DESIGN_APP_PROPERTY = "design-app";
/** Project membership: a `relations` row design → belongs_to_project → project. */
const BELONGS_TO_PROJECT = "belongs_to_project";

/**
 * What a revision copies from the design it revises (the canvas's rule,
 * app-bases boardStore `REVISION_COPIES`): the request it answers, never the
 * outcome of the old one (critique, screenshot, PR, status).
 */
const REVISION_COPIES = [
  "schema-version",
  "motion",
  "variant-group",
  "target-surface",
  "design-scope",
  "design-goal",
  "current-story-id",
  DESIGN_APP_PROPERTY,
] as const;

export interface DesignDoorContext {
  userId: string;
  workspaceId: string | null;
  /** The acting agent, when an agent runs the verb: the entity door governs as it. */
  agentUserId?: string | null;
  sessionId?: string | null;
  /** The outer gate asked for review: every write is filed as a proposal. */
  mustPropose?: boolean;
}

// ─── The catalog ────────────────────────────────────────────────────────────

export type CatalogRead =
  | {
      status: "installed";
      catalog: DesignCatalogSnapshot;
      /** The app's own kit, when the catalog is an app's (its components, Synap's canvas blocks). */
      kit?: DesignKitCatalog;
    }
  | { status: "missing"; message: string }
  | { status: "unreadable"; message: string };

/**
 * The snapshot the installed `design` capability carries (its container's
 * `metadata.designCatalog`, the newest container first). `missing` when no
 * container carries one, `unreadable` when the one it carries cannot be
 * trusted: never an empty catalog.
 */
export async function readInstalledCatalog(): Promise<CatalogRead> {
  const rows = await db
    .select({ metadata: capabilities.metadata })
    .from(capabilities)
    .where(eq(capabilities.templateKey, DESIGN_CAPABILITY_KEY))
    .orderBy(desc(capabilities.updatedAt))
    .limit(5);
  for (const r of rows) {
    const raw = (r.metadata as Record<string, unknown> | null)?.[
      DESIGN_CATALOG_METADATA_KEY
    ];
    if (raw === undefined) continue;
    const read = readDesignCatalog(raw);
    if (!read.ok)
      return {
        status: "unreadable",
        message: `The installed design capability carries a catalog the pod cannot read: ${read.error} Update the design capability.`,
      };
    return { status: "installed", catalog: read.catalog };
  }
  return {
    status: "missing",
    message:
      "No design catalog on this pod: the `design` capability is not installed (or carries no catalog). Install it from the market (market.install, slug `design`, kind capability); nothing can be checked against a catalog until then.",
  };
}

/**
 * The catalog a design of `appId` is checked against (plan 0fc746f4 W6). No
 * app, or an app that names no kit: Synap's installed catalog. An app with a
 * kit: the kit's components with Synap's canvas blocks (`composeAppCatalog`).
 * An app whose kit cannot be read is `unreadable` with the reason, never
 * Synap's catalog in its place: its designs would be checked against
 * components the canvas does not draw them with.
 */
export async function readCatalogFor(
  userId: string,
  appId: string | null
): Promise<CatalogRead> {
  const synap = await readInstalledCatalog();
  if (synap.status !== "installed" || !appId) return synap;
  let app: Awaited<ReturnType<typeof readAppKit>>;
  try {
    app = await readAppKit(userId, appId);
  } catch (err) {
    if (err instanceof TRPCError)
      return { status: "unreadable", message: err.message };
    throw err;
  }
  if (app.status === "none") return synap;
  const composed = composeAppCatalog(synap.catalog, app.kit);
  if (!composed.ok)
    return {
      status: "unreadable",
      message: `App ${appId}'s design kit cannot be drawn with Synap's canvas blocks: ${composed.error}`,
    };
  return { status: "installed", catalog: composed.catalog, kit: app.kit };
}

/** The app a design is for (`design-app`), or null. */
const appOf = (p: Record<string, unknown>): string | null => {
  const v = p[DESIGN_APP_PROPERTY];
  return typeof v === "string" && v !== "" ? v : null;
};

/**
 * design.catalog's answer: the kit, its components and props, the canvas
 * blocks, the grid, the frame presets. With `appId`, the catalog of that
 * app's designs; when the app has its own kit, `kit` says how the Design app
 * loads it (React major, the two files' hashes, how a dropped block starts).
 */
export async function designCatalog(
  userId: string,
  appId: string | null = null
) {
  const read = await readCatalogFor(userId, appId);
  if (read.status !== "installed")
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: read.message });
  const { catalog, kit } = read;
  return {
    kitId: catalog.kitId,
    hash: catalog.hash,
    components: catalog.components,
    layout: catalog.layout,
    grid: { columns: GRID_COLUMNS, breakpoints: WIDTH_CLASS_BREAKPOINTS },
    frames: FRAME_PRESETS,
    ...(catalog.generatedAt ? { generatedAt: catalog.generatedAt } : {}),
    ...(appId ? { appId } : {}),
    ...(kit
      ? {
          kit: {
            kitId: kit.kitId,
            hash: kit.hash,
            react: kit.kit.react,
            files: {
              js: {
                sha256: kit.kit.files.js.sha256,
                bytes: kit.kit.files.js.bytes,
              },
              css: {
                sha256: kit.kit.files.css.sha256,
                bytes: kit.kit.files.css.bytes,
              },
            },
            canvas: kit.canvas,
          },
        }
      : {}),
  };
}

// ─── Reading a design ───────────────────────────────────────────────────────

interface DesignRow {
  id: string;
  title: string | null;
  type: string;
  workspaceId: string | null;
  properties: Record<string, unknown>;
  updatedAt: Date;
}

async function loadDesignRow(
  userId: string,
  designId: string
): Promise<DesignRow> {
  const [row] = await db
    .select({
      id: entities.id,
      title: entities.title,
      type: entities.type,
      workspaceId: entities.workspaceId,
      properties: entities.properties,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, designId),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(userId)
      )
    )
    .limit(1);
  if (!row)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No design ${designId} you can read.`,
    });
  if (row.type !== UI_DESIGN_PROFILE)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${designId} is a ${row.type}, not a ${UI_DESIGN_PROFILE}.`,
    });
  return {
    ...row,
    properties: (row.properties ?? {}) as Record<string, unknown>,
  };
}

/** The ui-design kind's declared lifecycle, as the canvas reads it. */
async function loadLifecycle(
  workspaceId: string | null
): Promise<DesignLifecycle> {
  const { resolveProfileLifecycle, toLifecycleWire } =
    await import("../lifecycle/board-lens.js");
  const p = await resolveProfileLifecycle(UI_DESIGN_PROFILE, workspaceId);
  return readDesignLifecycle(toLifecycleWire(UI_DESIGN_PROFILE, p));
}

/** A block tree with ids and types only: what an agent addresses ops to. */
interface OutlineBlock {
  id: string;
  type: string;
  slots?: Record<string, OutlineBlock[]>;
}

function outline(
  list: readonly PageBlock[],
  schema: ReturnType<typeof catalogSchema> | null
): OutlineBlock[] {
  return list.map((b) => {
    const slots: Record<string, OutlineBlock[]> = {};
    for (const [prop, value] of Object.entries(b.props)) {
      const isSlot = schema
        ? schema[b.type]?.[prop]?.kind === "slot"
        : Array.isArray(value) &&
          value.length > 0 &&
          value.every((v) => v && typeof v === "object" && "type" in v);
      if (isSlot && Array.isArray(value))
        slots[prop] = outline(value as PageBlock[], schema);
    }
    return {
      id: b.props.id,
      type: b.type,
      ...(Object.keys(slots).length > 0 ? { slots } : {}),
    };
  });
}

function frameOutline(
  board: Board,
  schema: ReturnType<typeof catalogSchema> | null
) {
  return board.frames.map((f) => {
    const widthClass: WidthClass = widthClassOf(f.w);
    return {
      id: f.id,
      name: f.name,
      w: f.w,
      h: f.h,
      widthClass,
      columns: GRID_COLUMNS[widthClass],
      ...(f.pageOf
        ? { pageOf: f.pageOf }
        : { blocks: outline(f.page.content, schema) }),
    };
  });
}

const statusOf = (p: Record<string, unknown>, lifecycle: DesignLifecycle) => {
  const v = p[lifecycle.property];
  return typeof v === "string" ? v : undefined;
};

/**
 * design.read: the design, its board (every block with its id), an outline
 * per frame (width class and columns), whether it may be edited, and what the
 * parser leaves out against the installed catalog. With no catalog installed
 * the board is read for its shape only, and the answer says so.
 */
export async function readDesign(ctx: DesignDoorContext, designId: string) {
  const row = await loadDesignRow(ctx.userId, designId);
  const raw = row.properties["design-json"];
  if (raw === undefined || raw === null)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Design ${designId} has no design-json; it is not a canvas yet.`,
    });
  const read = await readCatalogFor(ctx.userId, appOf(row.properties));
  const catalog = read.status === "installed" ? read.catalog : null;
  const schema = catalog ? catalogSchema(catalog) : null;
  const parsed = parseBoard(raw, schema ?? undefined);
  if (!parsed.ok)
    throw new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: `Design ${designId} cannot be read as a canvas: ${parsed.error}`,
    });
  const lifecycle = await loadLifecycle(row.workspaceId);
  const status = statusOf(row.properties, lifecycle);
  return {
    design: {
      id: row.id,
      title: row.title,
      status: status ?? null,
      updatedAt: row.updatedAt.toISOString(),
      appId: appOf(row.properties),
      schemaVersion: row.properties["schema-version"] ?? null,
      editable: designEditability(status, lifecycle),
    },
    board: parsed.board,
    frames: frameOutline(parsed.board, schema),
    migrated: parsed.migrated,
    dropped: parsed.dropped,
    droppedText: parsed.dropped.map(describeRefusal),
    catalog:
      read.status === "installed"
        ? { kitId: read.catalog.kitId, hash: read.catalog.hash }
        : { kitId: null, hash: null, note: read.message },
  };
}

// ─── Changing a design ──────────────────────────────────────────────────────

export interface ApplyDesignInput {
  designId?: string;
  baseUpdatedAt?: string;
  ops: unknown[];
  acceptDrops?: boolean;
}

/** What design.apply answers. `refused` and `conflict` changed nothing. */
export type ApplyDesignReply =
  | {
      status: "applied" | "created" | "revised";
      designId: string;
      /** `revised`: the design past its review that this revision copies (it was not written). */
      revisedFrom?: string;
      updatedAt: string | null;
      changes: Array<DesignChange & { opIndex: number }>;
      componentsUsed: string[];
      catalogHash: string;
      /** Parts of the stored design the catalog could not place, left out of this version (`acceptDrops`). */
      dropped: DropReason[];
    }
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl: string | null;
      designId: string | null;
      revisedFrom?: string;
      changes: Array<DesignChange & { opIndex: number }>;
      componentsUsed: string[];
      catalogHash: string;
      dropped: DropReason[];
    }
  | {
      status: "refused";
      opIndex: number | null;
      op: string | null;
      reasons: OpRefusalReason[];
      catalogHash: string;
      message: string;
    }
  | {
      status: "conflict";
      designId: string;
      updatedAt: string;
      message: string;
    };

type EntitiesCaller = ReturnType<
  (typeof import("../../routers/entities.js"))["entitiesRouter"]["createCaller"]
>;

async function entitiesCaller(
  userId: string,
  workspaceId: string | null
): Promise<EntitiesCaller> {
  let workspaceRole: string | undefined;
  if (workspaceId) {
    const membership = await getWorkspaceMembership(db, workspaceId, userId);
    if (!membership)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No access to the designs' space.",
      });
    workspaceRole = membership.role;
  }
  const { entitiesRouter } = await import("../../routers/entities.js");
  return entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId,
    workspaceId,
    workspaceRole,
  } as unknown as Context);
}

/**
 * Under `mustPropose`, the write is filed for review. The entity door honours
 * `forcePropose` on the agent path; a run with no agent identity cannot be
 * forced to propose there (a trusted operator is never made to), so it is
 * refused rather than written.
 */
function governance(ctx: DesignDoorContext): {
  agentUserId?: string;
  forcePropose?: boolean;
} {
  if (ctx.mustPropose && !ctx.agentUserId)
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This change needs review, but no agent identity reaches the design door to file it as one. Nothing was written.",
    });
  return {
    ...(ctx.agentUserId ? { agentUserId: ctx.agentUserId } : {}),
    ...(ctx.mustPropose ? { forcePropose: true } : {}),
  };
}

type WriteAck =
  | { kind: "written"; id: string; updatedAt: string | null }
  | {
      kind: "proposed";
      proposalId: string;
      reviewUrl: string | null;
      id: string | null;
    };

/** The entity door's answer, read without guessing: a proposal is never reported as written. */
function ackOf(result: unknown, fallbackId: string | null): WriteAck {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.status === "proposed" && typeof r.proposalId === "string")
    return {
      kind: "proposed",
      proposalId: r.proposalId,
      reviewUrl: typeof r.reviewUrl === "string" ? r.reviewUrl : null,
      id:
        typeof r.proposedEntityId === "string"
          ? r.proposedEntityId
          : fallbackId,
    };
  const entity = (r.entity ?? r) as Record<string, unknown>;
  const id = typeof entity.id === "string" ? entity.id : fallbackId;
  if (!id)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The entity door accepted the design but returned no id.",
    });
  const at = entity.updatedAt;
  return {
    kind: "written",
    id,
    updatedAt:
      at instanceof Date
        ? at.toISOString()
        : typeof at === "string"
          ? at
          : null,
  };
}

function boardProperties(board: Board, componentsUsed: string[]) {
  return {
    "design-json": board,
    "components-used": componentsUsed,
    "schema-version": BOARD_SCHEMA_VERSION,
  };
}

/** The space holding every design: the one installed from the Builder template, as the caller sees it. */
async function designSpace(userId: string): Promise<string> {
  const { installedTemplateSpace } =
    await import("../installed-template-space.js");
  const space = await installedTemplateSpace(UI_DESIGN_TEMPLATE, userId);
  if (!space)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `No space you can see holds designs (the ${UI_DESIGN_TEMPLATE} template). Install it first.`,
    });
  return space.id;
}

async function projectOf(designId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: relations.targetEntityId })
    .from(relations)
    .where(
      and(
        eq(relations.sourceEntityId, designId),
        eq(relations.type, BELONGS_TO_PROJECT)
      )
    )
    .limit(1);
  return row?.projectId ?? null;
}

/**
 * design.apply: run the ops (all or nothing) and write the result through the
 * governed entity door. No `designId`: the first op must be `create_design`.
 */
export async function applyDesign(
  ctx: DesignDoorContext,
  input: ApplyDesignInput
): Promise<ApplyDesignReply> {
  const first = designOpSchema.safeParse(input.ops[0]);
  const create =
    first.success && first.data.op === "create_design" ? first.data : null;
  // The catalog of the design's app: a new design's (`create_design.appId`),
  // else the stored design's `design-app`; Synap's when there is none.
  const catalogOf = async (appId: string | null) => {
    const read = await readCatalogFor(ctx.userId, appId);
    if (read.status !== "installed")
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: read.message,
      });
    return read.catalog;
  };

  if (!input.designId) {
    const catalog = await catalogOf(create?.appId ?? null);
    if (!create)
      return refusedBatch(0, input.ops[0], catalog, {
        kind: "bad-op",
        detail: "no designId: the first op must be create_design",
      });
    return createDesign(ctx, create, input.ops.slice(1), catalog);
  }
  if (create)
    return refusedBatch(0, input.ops[0], await catalogOf(null), {
      kind: "create-not-first",
    });

  const row = await loadDesignRow(ctx.userId, input.designId);
  const catalog = await catalogOf(appOf(row.properties));
  if (!input.baseUpdatedAt)
    return refusedBatch(null, null, catalog, {
      kind: "bad-op",
      detail:
        "baseUpdatedAt: the updatedAt design.read returned is required to change a design",
    });
  const current = row.updatedAt.toISOString();
  const base = new Date(input.baseUpdatedAt);
  if (Number.isNaN(base.getTime()) || base.toISOString() !== current)
    return {
      status: "conflict",
      designId: row.id,
      updatedAt: current,
      message: `Design ${row.id} changed since ${input.baseUpdatedAt} (now ${current}). Read it again (design.read) and apply your ops to what it is now.`,
    };

  const raw = row.properties["design-json"];
  const parsed =
    raw === undefined || raw === null
      ? {
          ok: true as const,
          board: emptyBoard(),
          dropped: [] as DropReason[],
          migrated: false,
        }
      : parseBoard(raw, catalogSchema(catalog));
  if (!parsed.ok)
    throw new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: `Design ${row.id} cannot be read as a canvas, so it cannot be changed by ops: ${parsed.error}`,
    });
  if (parsed.dropped.length > 0 && input.acceptDrops !== true)
    return {
      status: "refused",
      opIndex: null,
      op: null,
      reasons: parsed.dropped,
      catalogHash: catalog.hash,
      message: `The stored design has parts catalog ${catalog.kitId}@${catalog.hash} cannot place (${parsed.dropped
        .map(describeRefusal)
        .join(
          "; "
        )}). Writing it would leave them out: pass acceptDrops: true to do so, or update the design capability if the catalog is behind the canvas.`,
    };

  const result = applyOps(parsed.board, input.ops, catalog);
  if (!result.ok)
    return {
      status: "refused",
      opIndex: result.opIndex,
      op: result.op,
      reasons: result.reasons,
      catalogHash: result.catalogHash,
      message: result.message,
    };

  const lifecycle = await loadLifecycle(row.workspaceId);
  const editability: Editability = designEditability(
    statusOf(row.properties, lifecycle),
    lifecycle
  );
  const done = {
    changes: result.changes,
    componentsUsed: result.componentsUsed,
    catalogHash: result.catalogHash,
    dropped: parsed.dropped,
  };

  if (!editability.editable) {
    // Past its review: the change is a REVISION (a new design in the initial
    // state, copying the request), and the reviewed design is never written.
    const properties: Record<string, unknown> = {};
    for (const slug of REVISION_COPIES) {
      const v = row.properties[slug];
      if (v !== undefined && v !== null) properties[slug] = v;
    }
    Object.assign(
      properties,
      boardProperties(result.board, result.componentsUsed)
    );
    if (lifecycle.initialStatus)
      properties[lifecycle.property] = lifecycle.initialStatus;
    const projectId = await projectOf(row.id);
    const caller = await entitiesCaller(ctx.userId, row.workspaceId);
    const ack = ackOf(
      await caller.create({
        profileSlug: UI_DESIGN_PROFILE,
        title: `${row.title ?? "Design"} (revision)`,
        properties,
        ...(row.workspaceId ? { targetWorkspaceId: row.workspaceId } : {}),
        ...(projectId ? { projectId } : {}),
        reasoning: `A change to "${row.title ?? row.id}", which is past its review (${editability.option.label}): filed as a revision.`,
        ...governance(ctx),
      }),
      null
    );
    return ack.kind === "proposed"
      ? {
          status: "proposed",
          proposalId: ack.proposalId,
          reviewUrl: ack.reviewUrl,
          designId: ack.id,
          revisedFrom: row.id,
          ...done,
        }
      : {
          status: "revised",
          designId: ack.id,
          revisedFrom: row.id,
          updatedAt: ack.updatedAt,
          ...done,
        };
  }

  const caller = await entitiesCaller(ctx.userId, row.workspaceId);
  const ack = ackOf(
    await caller.update({
      id: row.id,
      properties: boardProperties(result.board, result.componentsUsed),
      ...governance(ctx),
    }),
    row.id
  );
  if (ack.kind === "proposed")
    return {
      status: "proposed",
      proposalId: ack.proposalId,
      reviewUrl: ack.reviewUrl,
      designId: row.id,
      ...done,
    };
  // The door's answer may not carry the row's new time: read it, so the next
  // call's baseUpdatedAt is the stored one.
  const updatedAt =
    ack.updatedAt ??
    (await loadDesignRow(ctx.userId, row.id)).updatedAt.toISOString();
  return { status: "applied", designId: row.id, updatedAt, ...done };
}

async function createDesign(
  ctx: DesignDoorContext,
  create: Extract<
    ReturnType<typeof designOpSchema.parse>,
    { op: "create_design" }
  >,
  rest: unknown[],
  catalog: DesignCatalogSnapshot
): Promise<ApplyDesignReply> {
  const result = applyOps(emptyBoard(), rest, catalog);
  if (!result.ok)
    return {
      status: "refused",
      // The batch's index: create_design is op 0.
      opIndex: result.opIndex + 1,
      op: result.op,
      reasons: result.reasons,
      catalogHash: result.catalogHash,
      message: result.message.replace(
        /^Op (\d+)/,
        (_, n: string) => `Op ${Number(n) + 1}`
      ),
    };
  const workspaceId = await designSpace(ctx.userId);
  const lifecycle = await loadLifecycle(workspaceId);
  const caller = await entitiesCaller(ctx.userId, workspaceId);
  const ack = ackOf(
    await caller.create({
      profileSlug: UI_DESIGN_PROFILE,
      title: create.title,
      properties: {
        ...boardProperties(result.board, result.componentsUsed),
        "design-scope": "page",
        ...(create.appId ? { [DESIGN_APP_PROPERTY]: create.appId } : {}),
        ...(lifecycle.initialStatus
          ? { [lifecycle.property]: lifecycle.initialStatus }
          : {}),
      },
      targetWorkspaceId: workspaceId,
      ...(create.projectId ? { projectId: create.projectId } : {}),
      ...governance(ctx),
    }),
    null
  );
  // The first op (create_design) is the design itself.
  const changes = result.changes.map((c) => ({ ...c, opIndex: c.opIndex + 1 }));
  const done = {
    changes,
    componentsUsed: result.componentsUsed,
    catalogHash: result.catalogHash,
    dropped: [],
  };
  return ack.kind === "proposed"
    ? {
        status: "proposed",
        proposalId: ack.proposalId,
        reviewUrl: ack.reviewUrl,
        designId: ack.id,
        ...done,
      }
    : {
        status: "created",
        designId: ack.id,
        updatedAt: ack.updatedAt,
        ...done,
      };
}

function refusedBatch(
  opIndex: number | null,
  op: unknown,
  catalog: DesignCatalogSnapshot,
  reason: OpRefusalReason
): ApplyDesignReply {
  const name =
    op &&
    typeof op === "object" &&
    typeof (op as { op?: unknown }).op === "string"
      ? (op as { op: string }).op
      : null;
  return {
    status: "refused",
    opIndex,
    op: name,
    reasons: [reason],
    catalogHash: catalog.hash,
    message: `${opIndex === null ? "The call" : `Op ${opIndex} (${name ?? "?"})`} refused, nothing was changed: ${describeRefusal(reason)}.`,
  };
}
