/**
 * Each read a frame may ask for (`CELL_BRIDGE_READ_OPS`,
 * `@synap-core/types/cell-bridge`) → the tRPC procedure its hosts map it to
 * today, called SERVER-SIDE with the VIEWER's own context. The same mapping
 * as pod admin's `readForPage` (`apps/pod-admin/app/_lib/object/content/
 * html-bridge-reads.ts`) and the desktop's Hub REST twins (each a thin caller
 * of these procedures): one read per op, never a second predicate. The pod
 * floors every answer to what this viewer may see; nothing here widens it.
 *
 * The LENS is the door's, never the frame's: `workspaceId` is stamped here
 * (the frame's params never carry it, `pickBridgeParams` dropped it). With no
 * space the read is the viewer's whole floor; a read of ONE space's page with
 * no space is refused (`cellBridgeReadRefusal`).
 *
 * Each router is imported when its op is asked, like `measure-check-read.ts`
 * (which maps four of these ops for a criterion): the door does not load the
 * whole router tree.
 */

import {
  cellBridgeReadRefusal,
  cellBridgeViewPage,
  narrowHomeToSpace,
  projectPillarsAnswer,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "@synap-core/types/cell-bridge";
import { LENS_PAGE_READ_CAPS } from "@synap-core/types/lens";
import { TRPCError } from "@trpc/server";
import type { Context } from "../../types/context.js";

type Params = Record<string, CellBridgeParamValue>;

const str = (v: CellBridgeParamValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
const bool = (v: CellBridgeParamValue | undefined): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;
/** An integer in [min, max], or undefined (the procedure's own default). */
function int(
  v: CellBridgeParamValue | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}
/** Drops undefined keys, so a procedure's own default applies. */
function defined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined)
  ) as T;
}
/** A read the frame asked wrongly is the caller's error: 400, never a 500. */
function badRequest(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}
function required(op: string, name: string, v: string | undefined): string {
  if (!v) throw badRequest(`"${op}" needs ${name}.`);
  return v;
}

/**
 * Run `op` as the viewer in `ctx`, in the space `workspaceId` (null: no
 * space). A refusal or a failed read THROWS: the frame gets an error, never
 * an empty answer.
 */
export async function runFrameReadOp(
  viewerCtx: Context,
  op: CellBridgeReadOp,
  p: Params,
  workspaceId: string | null
): Promise<unknown> {
  // The space the procedures that read it from the context see (the console
  // sends it as a header per call): the door's lens, nothing else. A role
  // derived for another space does not follow the lens: cleared, so a
  // workspace procedure derives it again for this one.
  const ctx = {
    ...viewerCtx,
    workspaceId,
    workspaceRole:
      workspaceId === (viewerCtx.workspaceId ?? null)
        ? viewerCtx.workspaceRole
        : undefined,
  } as Context;
  const ws = workspaceId ?? undefined;
  switch (op) {
    case "entities.list": {
      const { entitiesRouter } = await import("../../routers/entities.js");
      return entitiesRouter.createCaller(ctx).list(
        defined({
          profileSlug: str(p.profileSlug),
          facetSlug: str(p.facetSlug),
          includeDescendants: bool(p.includeDescendants),
          limit: int(p.limit, 1, 100) ?? 50,
          offset: int(p.offset, 0, 100_000) ?? 0,
          workspaceId: ws,
        })
      );
    }
    case "entities.get": {
      const { entitiesRouter } = await import("../../routers/entities.js");
      return entitiesRouter
        .createCaller(ctx)
        .get({ id: required(op, "an id", str(p.id)) });
    }
    case "views.list": {
      const { viewsRouter } = await import("../../routers/views.js");
      return viewsRouter.createCaller(ctx).list(
        defined({
          // The procedure validates it.
          type: str(p.type) as never,
          profileSlug: str(p.profileSlug),
          limit: int(p.limit, 1, 100) ?? 50,
          offset: int(p.offset, 0, 100_000) ?? 0,
          workspaceId: ws,
        })
      );
    }
    case "profiles.list": {
      const { profilesRouter } = await import("../../routers/profiles.js");
      return profilesRouter
        .createCaller(ctx)
        .list(defined({ creatableOnly: bool(p.creatableOnly) }));
    }
    case "lifecycle.board": {
      const { lifecycleRouter } = await import("../../routers/lifecycle.js");
      const days = int(p.windowDays, 1, 366);
      return lifecycleRouter.createCaller(ctx).board(
        defined({
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          window: days ? { days } : undefined,
          firstN: int(p.firstN, 0, 50),
          column: str(p.column),
          cursor: str(p.cursor),
          limit: int(p.limit, 1, 100),
          workedBy: bool(p.workedBy),
          workspaceId: ws,
        })
      );
    }
    case "flow.of": {
      const { flowRouter } = await import("../../routers/flow.js");
      const days = int(p.windowDays, 1, 366);
      return flowRouter.createCaller(ctx).of(
        defined({
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          window: days ? { days } : undefined,
          firstN: int(p.firstN, 0, 50),
          properties: bool(p.properties),
          workspaceId: ws,
        })
      );
    }
    case "lifecycle.throughput": {
      const { lifecycleRouter } = await import("../../routers/lifecycle.js");
      const bucket = str(p.bucket);
      const count = int(p.count, 1, 366);
      return lifecycleRouter.createCaller(ctx).throughput(
        defined({
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          period:
            bucket || count
              ? {
                  // The procedure validates it (day | week | month).
                  bucket: (bucket ?? "week") as "day" | "week" | "month",
                  count: count ?? 12,
                }
              : undefined,
          workspaceId: ws,
        })
      );
    }
    case "attention.needsYou": {
      const { signalsRouter } = await import("../../routers/signals.js");
      return signalsRouter.createCaller(ctx).list(
        defined({
          lens: "needs-you" as const,
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          limit: int(p.limit, 1, 100),
          workspaceId: ws,
        }) as never
      );
    }
    case "attention.count": {
      const { signalsRouter } = await import("../../routers/signals.js");
      return signalsRouter.createCaller(ctx).count(
        defined({
          profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
          trackId: str(p.trackId),
          workspaceId: ws,
        })
      );
    }
    case "sessions.list": {
      const { focusSessionsRouter } =
        await import("../../routers/focus-sessions.js");
      const profileSlug = str(p.profileSlug);
      const entityId = str(p.entityId);
      return focusSessionsRouter.createCaller(ctx).list(
        defined({
          subject: profileSlug
            ? { profileSlug }
            : entityId
              ? { entityIds: [entityId] }
              : undefined,
          // The procedure validates both.
          status: str(p.status),
          kind: str(p.kind) ?? "work",
          limit: int(p.limit, 1, 50) ?? 20,
          workspaceId: ws,
        }) as never
      );
    }
    case "lifecycle.home": {
      const { lifecycleRouter } = await import("../../routers/lifecycle.js");
      // Lists every space the viewer sees: narrowed to the frame's own.
      return narrowHomeToSpace(
        await lifecycleRouter.createCaller(ctx).home({}),
        workspaceId
      );
    }
    case "lifecycle.moving": {
      const { lifecycleRouter } = await import("../../routers/lifecycle.js");
      return lifecycleRouter
        .createCaller(ctx)
        .moving(
          defined({ limit: int(p.limit, 1, 100) ?? 30, workspaceId: ws })
        );
    }
    case "lens.page": {
      // One space's own page: refused with no space to stamp.
      const refusal = cellBridgeReadRefusal(op, { workspaceId });
      if (refusal || !ws) throw badRequest(refusal ?? `"${op}" needs a space.`);
      const { signalsRouter } = await import("../../routers/signals.js");
      return signalsRouter.createCaller(ctx).list(
        defined({
          lens: "page" as const,
          workspaceId: ws,
          caps: { ...LENS_PAGE_READ_CAPS },
          since: str(p.since),
        }) as never
      );
    }
    case "documents.get": {
      const { documentsRouter } = await import("../../routers/documents.js");
      return documentsRouter.createCaller(ctx).get({
        documentId: required(op, "a documentId", str(p.documentId)),
        format: str(p.format) === "readable" ? "readable" : "raw",
      });
    }
    // One object by its id: the procedure its own page reads, unlensed (the
    // pod floors it to the viewer).
    case "sessions.get": {
      const { focusSessionsRouter } =
        await import("../../routers/focus-sessions.js");
      return focusSessionsRouter
        .createCaller(ctx)
        .getLean({ id: required(op, "an id", str(p.id)) });
    }
    case "playbook.process": {
      const { playbooksRouter } = await import("../../routers/playbooks.js");
      return playbooksRouter.createCaller(ctx).process({
        playbookId: required(op, "a playbookId", str(p.playbookId)),
      });
    }
    case "playbook.scorecard": {
      const { playbooksRouter } = await import("../../routers/playbooks.js");
      return playbooksRouter.createCaller(ctx).scorecard({
        playbookId: required(op, "a playbookId", str(p.playbookId)),
      });
    }
    case "project.pillars": {
      const { projectsRouter } = await import("../../routers/projects.js");
      return projectPillarsAnswer(
        await projectsRouter.createCaller(ctx).get({
          id: required(op, "an id", str(p.id)),
          include: ["pillars"],
        })
      );
    }
    case "views.get": {
      const { viewsRouter } = await import("../../routers/views.js");
      return viewsRouter
        .createCaller(ctx)
        .get({ id: required(op, "an id", str(p.id)) });
    }
    case "views.execute": {
      const { viewsRouter } = await import("../../routers/views.js");
      // One page of the STORED query (`cellBridgeViewPage`, the one parser
      // every host uses); absent, the view's own stored pair.
      return viewsRouter.createCaller(ctx).execute({
        id: required(op, "an id", str(p.id)),
        ...cellBridgeViewPage(p),
      });
    }
    case "profiles.get": {
      const { profilesRouter } = await import("../../routers/profiles.js");
      return profilesRouter.createCaller(ctx).get(
        defined({
          identifier: required(op, "an identifier", str(p.identifier)),
          fill: bool(p.fill),
        })
      );
    }
    case "propertyDefs.list": {
      // Fields are read in a space (the procedure needs one): a frame in no
      // space gets the pod's refusal as its error.
      const { propertyDefsRouter } =
        await import("../../routers/property-defs.js");
      const profileId = str(p.profileId);
      return propertyDefsRouter
        .createCaller(ctx)
        .list(profileId ? { profileIds: [profileId] } : undefined);
    }
    case "lifecycle.get": {
      const { lifecycleRouter } = await import("../../routers/lifecycle.js");
      return lifecycleRouter.createCaller(ctx).get({
        profileSlug: required(op, "a profileSlug", str(p.profileSlug)),
        workspaceId,
      });
    }
    default: {
      // Every op of the one table has a case: a new op fails the build here.
      const unanswered: never = op;
      throw new Error(`"${String(unanswered)}" has no frame read.`);
    }
  }
}
