/**
 * Hub Protocol REST — cells (marketplace install/uninstall/list lifecycle)
 */

import { z } from "zod";
import { getDb, and, eq, inArray, isNull, or } from "@synap/database";
import {
  widgetDefinitions,
  CONTENT_KINDS,
  isPackageCellRendererType,
  type PackageCellRendererType,
} from "@synap/database/schema";
import {
  assertCellSourceMounts,
  CellDefinitionError,
  defineCell,
  AgentCellRequiresProposalError,
  validateDeps,
} from "../../../services/cells/define-cell.js";
// The ONE explicit-then-derive-from-viewTypes rule for a package cell's
// renderer slot — shared with the tRPC twin and both package appliers.
import { resolveCellContentKind } from "../../../services/cells/install-cell-from-definition.js";
import { admitOfficialDefinition } from "../../../services/capabilities/official-catalog-trust.js";
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
import { controlPlaneBaseUrl } from "@synap-core/core/control-plane-url";
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
   * Body: { packageSlug, cellKey, workspaceId }
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

    const { packageSlug, cellKey, workspaceId } = parsed.data;
    if (!workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    const userId = c.get("userId");
    if (!(await canWrite(userPrincipal(userId), { workspace: workspaceId }))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }

    const cpUrl = controlPlaneBaseUrl();
    if (!cpUrl) {
      return c.json(
        {
          error:
            "Cell marketplace install requires CONTROL_PLANE_URL (or CP_URL) to be configured on this pod",
        },
        503
      );
    }

    try {
      const resp = await fetch(
        `${cpUrl}/api/marketplace/cells?q=${encodeURIComponent(cellKey)}`
      );
      if (!resp.ok) {
        return c.json({ error: `CP responded with ${resp.status}` }, 502);
      }
      const data = (await resp.json()) as { cells?: CellDef[] } | CellDef[];
      const list = Array.isArray(data)
        ? data
        : ((data as { cells?: CellDef[] }).cells ?? []);
      const cell = list.find(
        (cell) =>
          cell?.key === cellKey || cell?.key === `${packageSlug}:${cellKey}`
      );

      if (!cell) {
        return c.json(
          { error: `Cell '${cellKey}' not found in package '${packageSlug}'` },
          404
        );
      }

      // Fix 4: verify CP-returned key matches what was requested
      const resolvedKey = cell.key.includes(":")
        ? cell.key.split(":").pop()!
        : cell.key;
      if (resolvedKey !== cellKey) {
        return c.json(
          {
            error: `CP returned cell key '${cell.key}' which does not match requested '${cellKey}'`,
          },
          400
        );
      }

      // Synap's signature rule: the cell the Control Plane served must be the
      // one its signed index lists for this package (refused once enforced).
      const admission = await admitOfficialDefinition({
        kind: "cell",
        slug: `${packageSlug}/${cellKey}`,
        definition: cell as unknown as Record<string, unknown>,
      });
      if (!admission.admitted) {
        return c.json({ error: admission.reason }, 412);
      }

      const depsError = validateDeps(cell.deps);
      if (depsError) {
        return c.json({ error: depsError }, 400);
      }

      // Route through the ONE door (defineCell) — same idempotent upsert +
      // realtime event MCP's synap_create_cell and POST /cells/define use.
      // Pass the pre-existing marketplace typeKey scheme explicitly so
      // already-installed cells keep resolving under it.
      const { typeKey } = await defineCell({
        name: cell.name,
        rendererSource: cell.code,
        workspaceId,
        typeKey: `cell:${packageSlug}:${cellKey}`,
        description: cell.description,
        defaultSize: cell.defaultSize,
        // Parity with the other two install doors (`installCellFromDefinition`
        // and `/packages/apply`). Dropped here, the SAME CP cell installed
        // through THIS door loses its render floor.
        minSize: cell.minSize,
        deps: cell.deps,
        viewTypes: cell.viewTypes,
        // Renderer SLOT. Its tRPC twin (`routers/cells.ts` cells.install) has
        // threaded this since the raw-insert fix; this Hub door had not, so the
        // SAME CP cell installed here landed as the column default `widget` and
        // was invisible to `renderersForType`. Resolved through the ONE shared
        // resolver so the explicit-then-derive-from-viewTypes rule cannot fork.
        contentKind: resolveCellContentKind(cell.contentKind, cell.viewTypes),
        // Rendering MECHANISM. Unrecognised values are dropped rather than
        // forwarded — `"builtin"`/`"native"` must never reach the column
        // through a marketplace payload.
        rendererType: isPackageCellRendererType(cell.rendererType)
          ? cell.rendererType
          : undefined,
        userId: userId ?? "",
      });

      return c.json({ success: true, typeKey });
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
    const userId = c.get("userId");
    // body.agentUserId wins; fall back to the auto-injected context value the
    // auth middleware sets for an agent API key (same resolution order as the
    // entities door).
    const agentUserId =
      parsed.data.agentUserId ?? (c.get("agentUserId") as string | undefined);

    // Only gate workspace access when a specific workspace is targeted — and
    // only on the OPERATOR path. An agent routes through the governance gate
    // below, which owns RBAC (including turning a non-member agent into a
    // `workspace.join` proposal); a manual write check here would
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
   * Uninstall a cell (soft-delete widget_definition).
   * workspaceId is optional — when omitted, deletes the pod-global row (workspaceId IS NULL).
   */
  app.delete("/cells/:typeKey", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const typeKey = c.req.param("typeKey");
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId");
    if (
      workspaceId &&
      !(await canWrite(userPrincipal(userId), { workspace: workspaceId }))
    ) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
    try {
      const db = await getDb();
      await db
        .update(widgetDefinitions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(widgetDefinitions.typeKey, typeKey),
            workspaceId
              ? eq(widgetDefinitions.workspaceId, workspaceId)
              : isNull(widgetDefinitions.workspaceId)
          )
        );
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

interface CellDef {
  key: string;
  name: string;
  code: string;
  deps?: Record<string, string>;
  description?: string;
  defaultSize?: { w: number; h: number };
  /** Minimum grid footprint declared by the package — the Card's render floor. */
  minSize?: { w: number; h: number };
  /** View-type affinity declared by the package (0221) — optional. */
  viewTypes?: string[];
  /** Renderer slot declared by the package — see `resolveCellContentKind`. */
  contentKind?: string;
  /**
   * Rendering MECHANISM declared by the package. Absent ⇒ `defineCell`'s
   * `"frame"` default — which is exactly how an `iframe` HTML Card used to
   * install as an ESM React cell and fail to mount.
   */
  rendererType?: PackageCellRendererType;
}
