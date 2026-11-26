/**
 * Hub Protocol REST — cells (marketplace install/uninstall/list lifecycle)
 */

import { z } from "zod";
import { getDb, and, eq, inArray, isNull, or } from "@synap/database";
import { widgetDefinitions, CONTENT_KINDS } from "@synap/database/schema";
import {
  assertCellSourceMounts,
  CellDefinitionError,
  defineCell,
  AgentCellRequiresProposalError,
  validateDeps,
} from "../../../services/cells/define-cell.js";
import {
  cellInstallRefusal,
  cellRetireRefusal,
  findActiveCellType,
  installMarketplaceCell,
  retireCellType,
} from "../../../services/cells/marketplace-cell-lifecycle.js";
import {
  declaredFrameIoFields,
  readDeclaredFrameIo,
} from "../../../services/cells/declared-frame-io.js";
// typeKey PROVENANCE FLOOR — the SAME guard the tRPC door (`widgetDefinitions.
// upsert`) applies, not a second implementation. This door declared `typeKey`
// and passed it straight to `defineCell`, so an operator-scoped key could MINT
// `cell:<pkg>:<key>` and land on the row an installed vendor cell occupies.
import {
  assertMayWriteNamespacedTypeKey,
  NamespacedTypeKeyError,
} from "../../../services/cells/namespaced-type-key.js";
import {
  hasScope,
  logger,
  verifyWorkspaceReadAccess,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";
import { canWrite, userPrincipal } from "../../../access/door.js";
import { jsonGoverned } from "../proposal-response.js";
import { grantWriteDenial } from "../../../utils/grant-write-check.js";
import { ErrorSchema, uuidQueryParam } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { grantReadPredicate } from "../../../access/grant-read.js";
import {
  CellPlacementSchema,
  checkCellPlacement,
} from "../../../services/cells/place-cell-on-view.js";

// deps validation now lives INSIDE the defineCell door (security review
// 2026-07-12: marketplace-install called defineCell without it — enforcing at
// the door means no caller can skip it). Re-exported for the existing test.
export { validateDeps };

const InstallBodySchema = z.object({
  packageSlug: z.string().min(1),
  cellKey: z.string().min(1),
  workspaceId: uuidQueryParam.optional(),
  /** Why an agent asks for it: shown to the person on the proposal. */
  reasoning: z.string().max(2000).optional(),
});

/** One installed source cell, as `GET /cells` projects it. */
const InstalledCellSchema = z.object({
  typeKey: z.string(),
  name: z.string(),
  rendererType: z.enum(["frame", "iframe"]),
  deps: z.record(z.string(), z.string()),
  rendererSource: z.string(),
  viewTypes: z.array(z.string()).nullable(),
  contentKind: z.string().nullable(),
  externalHosts: z.array(z.string()).nullable(),
});

type InstalledCellRow = typeof widgetDefinitions.$inferSelect;

/** One installed source cell, as `GET /cells` and `GET /cells/:typeKey` project it. */
function projectInstalledCell(
  r: InstalledCellRow
): z.infer<typeof InstalledCellSchema> {
  return {
    typeKey: r.typeKey,
    name: r.name,
    // `frame` | `iframe`: how a surface draws `rendererSource`.
    rendererType: r.rendererType as "frame" | "iframe",
    deps: (r.deps as Record<string, string>) ?? {},
    rendererSource: r.rendererSource ?? "",
    // Null when the cell declares no view-renderer affinity (0221).
    viewTypes: r.viewRendererViewTypes ?? null,
    // The slot this cell can fill (entity-detail / entity-card /
    // entity-profile / collection / widget). ACCEPTING IS NOT PRODUCING:
    // `POST /cells/define` takes `contentKind` and `defineCell` persists
    // it, but this read door omitted it — so an agent could set the slot
    // and then never see it, and could not tell a pickable renderer from
    // an unpickable one. Same class as the MCP tool that accepted
    // `contentKind` without advertising it. Found by dogfooding the
    // approved probe cell on 2026-09-05.
    contentKind: r.contentKind ?? null,
    // The frame's declared egress (0249). Projected for the same
    // "accepting is not producing" reason `contentKind` is: the pod
    // PERSISTS this list, and a read door that omits it leaves an
    // operator unable to tell a connected cell from a contained one —
    // which is the whole question this column exists to answer. Null =
    // declares none = the frame reaches no external origin.
    externalHosts: r.externalHosts ?? null,
  };
}

export function registerCellsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/cells",
    tags: ["Cells"],
    summary: "List installed source cells (frame and iframe)",
    description:
      "The active frame / iframe cells of one space (`workspaceId`, your membership checked) plus the pod-wide ones; with no `workspaceId`, the pod-wide ones only. A key whose grant is limited reads only the cells its grant reaches (`widget.read`; a key pinned to spaces: the cells of those spaces).",
    request: { query: z.object({ workspaceId: uuidQueryParam.optional() }) },
    responses: {
      200: {
        description: "Installed cells",
        schema: z.array(InstalledCellSchema),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /cells?workspaceId=...
   * List installed source cells for a workspace — `frame` (an ES-module React
   * cell) and `iframe` (an HTML page) — plus pod-global cells (workspaceId IS
   * NULL). workspaceId is optional — when omitted, only pod-global cells are
   * returned.
   *
   * Both mechanisms, because a cell an agent defines is stored as `iframe`
   * when its source is an HTML page (`defineCell`, migration 0366): listing
   * `frame` alone hid every page an agent made from the agent that made it.
   */
  app.get("/cells", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId");
    if (
      workspaceId &&
      !(await verifyWorkspaceReadAccess(userId, workspaceId))
    ) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
    try {
      const db = await getDb();
      const rows = await db.query.widgetDefinitions.findMany({
        where: and(
          inArray(widgetDefinitions.rendererType, ["frame", "iframe"]),
          eq(widgetDefinitions.isActive, true),
          // The calling key's grant (`widget` subject), narrow-only: the
          // fence admits a key holding `widget.read` however it is pinned
          // (grant-door-fence.ts `NARROWED("widget")`), and this clause is
          // what keeps a key pinned to spaces inside them.
          grantReadPredicate(widgetDefinitions),
          workspaceId
            ? or(
                isNull(widgetDefinitions.workspaceId),
                eq(widgetDefinitions.workspaceId, workspaceId)
              )
            : isNull(widgetDefinitions.workspaceId)
        ),
        orderBy: (t, { asc }) => [asc(t.name)],
      });
      return c.json(rows.map(projectInstalledCell));
    } catch (err) {
      logger.error({ err }, "cells.listInstalled failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/cells/{typeKey}",
    tags: ["Cells"],
    summary: "Read one installed source cell (frame or iframe)",
    description:
      "One active frame / iframe cell by typeKey (URL-encoded: `generated%3Amy-cell`), in the space `workspaceId` names (your membership checked) or, with no `workspaceId`, pod-wide. Read through the same grant as `GET /cells`: a key whose grant does not reach the cell gets 404.",
    request: {
      params: z.object({ typeKey: z.string().min(1) }),
      query: z.object({ workspaceId: uuidQueryParam.optional() }),
    },
    responses: {
      200: { description: "The cell", schema: InstalledCellSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "No such cell for you", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /cells/:typeKey?workspaceId=...
   * One installed source cell — the row `GET /cells` lists, by key, so a host
   * (a client app mounting a bento tile) reads the source of the tile it draws
   * without listing every cell. Same fence (`NARROWED("widget")`), same grant
   * clause, same projection.
   */
  app.get("/cells/:typeKey", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const typeKey = c.req.param("typeKey");
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId");
    if (
      workspaceId &&
      !(await verifyWorkspaceReadAccess(userId, workspaceId))
    ) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
    try {
      const db = await getDb();
      const row = await db.query.widgetDefinitions.findFirst({
        where: and(
          eq(widgetDefinitions.typeKey, typeKey),
          inArray(widgetDefinitions.rendererType, ["frame", "iframe"]),
          eq(widgetDefinitions.isActive, true),
          grantReadPredicate(widgetDefinitions),
          workspaceId
            ? eq(widgetDefinitions.workspaceId, workspaceId)
            : isNull(widgetDefinitions.workspaceId)
        ),
      });
      if (!row) return c.json({ error: "Cell not found" }, 404);
      return c.json(projectInstalledCell(row));
    } catch (err) {
      logger.error({ err }, "cells.getInstalled failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /cells/install
   * Install a cell from the marketplace into a workspace.
   * Body: { packageSlug, cellKey, workspaceId, reasoning? }
   *
   * GOVERNED: an agent's install is a `cell/install` proposal (floored, 2.09:
   * an agent adding to what the pod can draw always asks); approving it runs
   * the SAME `installMarketplaceCell` as the approver. A person installs
   * directly. The person behind the call must be able to write in the space.
   */
  app.post("/cells/install", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const rawBody = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!rawBody) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = InstallBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }

    const { packageSlug, cellKey, workspaceId, reasoning } = parsed.data;
    if (!workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    const userId = c.get("userId") ?? "";
    const refused = await cellInstallRefusal(userId, workspaceId);
    if (refused) return c.json({ error: refused.error }, refused.status);

    try {
      const { checkPermissionOrPropose, proposedMessageFor } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: c.get("agentUserId") as string | undefined,
        workspaceId,
        subjectType: "cell",
        action: "install",
        data: { packageSlug, cellKey, workspaceId },
        reasoning:
          reasoning ??
          `Install the cell "${cellKey}" from the package "${packageSlug}" in this space.`,
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm && perm.proposalId) {
        return jsonGoverned(c, {
          status: "proposed",
          proposalId: perm.proposalId,
          reviewUrl: perm.reviewUrl,
          message: proposedMessageFor(
            perm.proposalType,
            "Installing this cell was proposed: it is installed once the person approves it."
          ),
        });
      }

      const result = await installMarketplaceCell({
        packageSlug,
        cellKey,
        workspaceId,
        userId,
      });
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ success: true, typeKey: result.typeKey });
    } catch (err) {
      if (err instanceof AgentCellRequiresProposalError) {
        return c.json({ error: err.message, code: err.code }, 403);
      }
      logger.error({ err }, "cells.install failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /cells/define
   * Define a new cell from raw source (Capability B: AI-generated cells).
   * Idempotent upsert on (typeKey, workspaceId).
   * When workspaceId is omitted the cell is pod-global (visible in all workspaces).
   * Body: { name, rendererSource, workspaceId?, typeKey?, description?, defaultSize?,
   *         agentUserId?, reasoning? }
   *
   * GOVERNED (agent callers only) — the SAME `{cell, define}` gate the MCP door
   * (`mcp/adapter.ts` synap_create_cell) already applies: two doors, one gate.
   * Defining a cell writes AI-generated renderer SOURCE (arbitrary JS executed in
   * the cell-runtime sandbox) into `widget_definitions` with
   * `trustLevel: "generated"`, so `cell.define` is deliberately NOT in
   * DEFAULT_AUTO_APPROVE and an agent gets a proposal. On propose the source
   * rides in the gate `data` so the existing `cell/define` approve-executor
   * materializes through THIS same `defineCell` door on approval.
   */
  app.post("/cells/define", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const rawBody = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!rawBody) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = z
      .object({
        name: z.string().min(1).max(120),
        rendererSource: z.string().min(1),
        workspaceId: uuidQueryParam.min(1).optional(),
        typeKey: z.string().min(1).max(120).optional(),
        description: z.string().max(500).optional(),
        defaultSize: z.object({ w: z.number(), h: z.number() }).optional(),
        /** View-type affinity for using this cell as a view renderer (0221). */
        viewTypes: z.array(z.string().min(1).max(64)).max(32).optional(),
        /**
         * Renderer SLOT. `defineCell` has always accepted this; NO write door
         * declared it, and a plain z.object STRIPS an undeclared key — so a
         * caller sending `contentKind` got a 201 and a cell that silently took
         * the column default `widget`, placeable on a bento but never offered
         * as an entity-detail / entity-card / entity-profile / collection
         * renderer. Enum built from the `CONTENT_KINDS` runtime SSOT, never
         * retyped here.
         */
        contentKind: z.enum(CONTENT_KINDS).optional(),
        deps: z
          .record(z.string(), z.string())
          .optional()
          .superRefine((val, ctx) => {
            const message = validateDeps(val);
            if (message) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message });
            }
          }),
        // Governance identity + provenance. The IS hub client has always SENT
        // these (`is-hub-client.ts` defineCell) — the schema used to drop them,
        // so the agent caller was indistinguishable from an operator here.
        // Not `.uuid()`: a malformed id must not 400 the door, it must simply
        // fail the agent-user lookup inside the gate.
        agentUserId: z.string().min(1).optional(),
        reasoning: z.string().max(2000).optional(),
        /** Place the cell as a tile on this bento view when it is defined. */
        placeOn: CellPlacementSchema.optional(),
        /**
         * The reads its frame declares (`CellBridgeDeclaredReads`): a subset
         * of `CELL_BRIDGE_READ_OPS`, enforced by `POST /frame/read`. Absent =
         * undeclared (every ceiling read, logged).
         */
        reads: z
          .array(
            z.object({
              op: z.string(),
              params: z.record(z.string(), z.string()).optional(),
            })
          )
          .nullable()
          .optional(),
        /** The writes its frame declares (`CellBridgeDeclaredWrites`). */
        writes: z
          .array(z.object({ op: z.string() }))
          .nullable()
          .optional(),
      })
      .safeParse(rawBody);

    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }

    const {
      name,
      rendererSource,
      workspaceId,
      description,
      defaultSize,
      deps,
      viewTypes,
      contentKind,
      reasoning,
      placeOn,
    } = parsed.data;
    // Checked against the ceiling before anything is filed (400).
    const declared = readDeclaredFrameIo(parsed.data);
    if (!declared.ok) return c.json({ error: declared.error }, 400);
    const declaredFields = declaredFrameIoFields(declared);
    const userId = c.get("userId");
    // body.agentUserId wins; fall back to the auto-injected context value the
    // auth middleware sets for an agent API key (same resolution order as the
    // entities door).
    const agentUserId =
      parsed.data.agentUserId ?? (c.get("agentUserId") as string | undefined);

    // Only gate workspace access when a specific workspace is targeted — and
    // only on the OPERATOR path. An agent routes through the governance gate
    // below, which owns RBAC (the person's membership, and a role that lacks
    // the write turned into a proposal); a manual write check here would
    // hard-deny what the gate would otherwise let PROPOSE. Same reasoning as the
    // MCP `synap_create_cell` door.
    if (
      !agentUserId &&
      workspaceId &&
      !(await canWrite(userPrincipal(userId), { workspace: workspaceId }))
    ) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }

    // The grant bounds every key — the governance gate below runs for agents
    // only, so a non-agent key would otherwise define renderer code unbounded.
    const grantDenied = await grantWriteDenial({
      subjectType: "cell",
      action: "define",
      workspaceId: workspaceId ?? null,
    });
    if (grantDenied) return c.json({ error: grantDenied }, 403);

    try {
      // PROVENANCE FLOOR — runs BEFORE the governance gate so a forged
      // `cell:`/`generated:` key cannot even become a PROPOSAL that a reviewer
      // would then approve on the strength of its (forged) origin.
      if (parsed.data.typeKey) {
        await assertMayWriteNamespacedTypeKey(
          parsed.data.typeKey,
          workspaceId ?? null
        );
      }

      // DEFINE-TIME CHECK — also before the gate, for the same reason: a
      // source that cannot mount in the frame must not become a proposal a
      // person approves and then watches fail on every open. A refusal is a
      // `CellDefinitionError` (400 below) naming the line and the fix.
      const advice = await assertCellSourceMounts({
        name,
        rendererSource,
        typeKey: parsed.data.typeKey,
        workspaceId: workspaceId ?? null,
        deps,
      });

      // A placement that cannot land is refused before it becomes a proposal.
      // The view's name rides in the proposal so the reviewer sees where the
      // tile lands; whether the APPROVER may write that view is checked again
      // when it is approved (and, on the direct path, by `defineCell`).
      const proposedPlacement =
        placeOn && agentUserId
          ? await checkCellPlacement(placeOn, {
              cellWorkspaceId: workspaceId ?? null,
              userId: userId ?? "",
              permission: "read",
            })
          : undefined;

      // Governance membrane — AGENT callers only. Operator-initiated defines
      // (CLI `synap cell push` / `synap artifact`, which post to this same
      // route with no agentUserId) stay DIRECT writes: hub-protocol calls are
      // all branded source:"intelligence", so gating them unconditionally would
      // route an operator's own CLI push to a proposal. Mirrors the identical
      // `if (input.agentUserId)` carve-out in automationsRouter.create.
      if (agentUserId) {
        const { checkPermissionOrPropose, proposedMessageFor } =
          await import("../../../utils/permission-check.js");
        const perm = await checkPermissionOrPropose({
          userId: userId ?? "",
          agentUserId,
          workspaceId: workspaceId ?? null,
          subjectType: "cell",
          action: "define",
          // Agent-authored AI-generated renderer source — brand the provenance
          // "intelligence" for consistent attribution/telemetry, matching the
          // automation execute door (automations.ts). Reached only on the agent
          // path (`if (agentUserId)`); on the not-agent defence-in-depth
          // fall-through in checkPermissionOrPropose this now routes to a
          // proposal instead of a direct grant — the safer direction.
          source: "intelligence",
          // Carry the FULL define input so the `cell/define` approve-executor
          // materializes a real cell on approval, not a labelled shell.
          data: {
            name,
            rendererSource,
            workspaceId: workspaceId ?? null,
            description: description ?? null,
            // Carried so the `cell/define` approve-executor materializes the
            // view-renderer affinity too — dropping it here would approve a
            // renderer that can never be selected for a view.
            ...(viewTypes ? { viewTypes } : {}),
            // Same reason as `viewTypes`: without it an APPROVED agent-authored
            // cell materializes into the default `widget` slot, so the reviewer
            // approves one thing and the pod writes another.
            ...(contentKind ? { contentKind } : {}),
            // Carried for the same reason as `viewTypes`/`contentKind`: without
            // it an approved cell materialises under `generated:<slug(name)>`,
            // so the reviewer approves one key and the pod writes another. Safe
            // to carry because the executor re-runs the SAME provenance floor
            // against the scope the proposal was REVIEWED at (a `revise` can
            // re-target `proposals.workspaceId` after this payload is written).
            ...(parsed.data.typeKey ? { typeKey: parsed.data.typeKey } : {}),
            // Where approving places the cell: the executor defines it AND
            // adds its tile to this view, in one act.
            ...(proposedPlacement ? { placeOn: proposedPlacement } : {}),
            // What its frame declares it reads / writes.
            ...declaredFields,
          },
          reasoning,
        });
        if ("denied" in perm && perm.denied) {
          return c.json({ error: perm.reason }, 403);
        }
        if ("proposalId" in perm) {
          return jsonGoverned(c, {
            status: "proposed",
            proposalId: perm.proposalId,
            summary: perm.summary,
            reasoning: perm.reasoning,
            reviewPath: perm.reviewPath,
            reviewUrl: perm.reviewUrl,
            ...(perm.deduped ? { deduped: true } : {}),
            message: proposedMessageFor(
              perm.proposalType,
              "Cell definition proposed for review (AI-generated renderer source is governed) — it materializes on approval."
            ),
            ...(advice.length > 0 ? { advice } : {}),
          });
        }
      }

      const { typeKey, placed } = await defineCell({
        name,
        rendererSource,
        workspaceId: workspaceId ?? null,
        typeKey: parsed.data.typeKey,
        description,
        defaultSize,
        deps,
        viewTypes,
        contentKind,
        placeOn,
        ...declaredFields,
        userId: userId ?? "",
      });

      return c.json(
        {
          success: true,
          typeKey,
          ...(placed ? { placed } : {}),
          ...(advice.length > 0 ? { advice } : {}),
        },
        201
      );
    } catch (err) {
      // A forged namespaced typeKey is a CALLER error — 400, not the 500 a
      // bare rethrow would produce.
      if (
        err instanceof NamespacedTypeKeyError ||
        err instanceof CellDefinitionError
      ) {
        return c.json({ error: err.message }, 400);
      }
      logger.error({ err }, "cells.define failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * DELETE /cells/:typeKey?workspaceId=...
   * Retire (soft-delete) an installed cell type.
   * workspaceId is optional — when omitted, retires the POD-WIDE row
   * (workspaceId IS NULL), which only a pod admin may do: every space draws it.
   *
   * GOVERNED: an agent's retire is a `cell/retire` proposal (floored, 2.09);
   * approving it re-checks the approver with the same floor and retires it.
   */
  app.delete("/cells/:typeKey", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const typeKey = c.req.param("typeKey");
    const workspaceId = c.req.query("workspaceId") || null;
    const userId = c.get("userId") ?? "";
    const refused = await cellRetireRefusal(userId, workspaceId);
    if (refused) return c.json({ error: refused.error }, refused.status);
    try {
      const cell = await findActiveCellType(typeKey, workspaceId);
      if (!cell) return c.json({ error: "Cell not found" }, 404);

      const { checkPermissionOrPropose, proposedMessageFor } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: c.get("agentUserId") as string | undefined,
        workspaceId,
        subjectType: "cell",
        action: "retire",
        data: { id: cell.id, typeKey, workspaceId, name: cell.name },
        reasoning: `Retire the cell "${cell.name}": every view that draws it stops drawing it.`,
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm && perm.proposalId) {
        return jsonGoverned(c, {
          status: "proposed",
          proposalId: perm.proposalId,
          reviewUrl: perm.reviewUrl,
          message: proposedMessageFor(
            perm.proposalType,
            "Retiring this cell was proposed: it is retired once the person approves it."
          ),
        });
      }

      await retireCellType(typeKey, workspaceId);
      return c.json({ success: true });
    } catch (err) {
      logger.error({ err }, "cells.uninstall failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
