/**
 * Install a marketplace cell type into a space, or retire one: the two Hub
 * REST cell doors (`POST /cells/install`, `DELETE /cells/:typeKey`) and the
 * `cell/install` / `cell/retire` approve executors run THESE functions, so a
 * proposal's approval does exactly what the person's direct call does, and
 * checks the approver with the same floor the door checked the filer with.
 *
 * Both doors used to write with no governance gate (finding on the Hub REST
 * cell doors, Surfaces wave P0-fix): an agent key could retire a pod-wide cell
 * type (`workspace_id IS NULL`) with no access check at all.
 */

import { getDb, and, eq, isNull } from "@synap/database";
import {
  widgetDefinitions,
  isPackageCellRendererType,
  type PackageCellRendererType,
} from "@synap/database/schema";
import { controlPlaneBaseUrl } from "@synap-core/core/control-plane-url";
import { canWrite, userPrincipal } from "../../access/door.js";
import { isPodAdmin } from "../../utils/workspace-role.js";
import { admitOfficialDefinition } from "../capabilities/official-catalog-trust.js";
import { defineCell, validateDeps } from "./define-cell.js";
import { resolveCellContentKind } from "./install-cell-from-definition.js";

/** A refusal or a failure, with the HTTP status the Hub door answers. */
export interface CellLifecycleRefusal {
  ok: false;
  status: 400 | 403 | 404 | 412 | 502 | 503;
  error: string;
}

/** One cell as the Control Plane marketplace serves it. */
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

/**
 * Who may install a cell type into `workspaceId`: a person who may write in
 * it. Checked on the person behind the call when it is filed, and on the
 * approver when it is approved. Null = allowed.
 */
export async function cellInstallRefusal(
  userId: string,
  workspaceId: string
): Promise<CellLifecycleRefusal | null> {
  return (await canWrite(userPrincipal(userId), { workspace: workspaceId }))
    ? null
    : { ok: false, status: 403, error: "Access denied to workspace" };
}

/**
 * Who may retire a cell type: in a space, a person who may write in it; a
 * POD-WIDE one (`workspaceId` null), a pod admin, since every space draws it.
 * Checked on the filer and again on the approver. Null = allowed.
 */
export async function cellRetireRefusal(
  userId: string,
  workspaceId: string | null
): Promise<CellLifecycleRefusal | null> {
  if (workspaceId) return cellInstallRefusal(userId, workspaceId);
  return (await isPodAdmin(userId))
    ? null
    : {
        ok: false,
        status: 403,
        error:
          "Only a pod admin can retire a pod-wide cell type: every space draws it. Name the space (workspaceId) to retire it there.",
      };
}

/**
 * Who may DEFINE a pod-wide cell type (`workspaceId` null): a pod admin, as
 * for retiring one (`cellRetireRefusal`), since every space draws it
 * (security review M1, 27 Nov 2026). A cell in one space is judged by that
 * door's own space check (membership, or the agent gate). Checked on the
 * person behind the call when it is filed, and on the approver when it is
 * approved. Null = allowed.
 */
export async function cellDefineScopeRefusal(
  userId: string,
  workspaceId: string | null
): Promise<CellLifecycleRefusal | null> {
  if (workspaceId) return null;
  return (await isPodAdmin(userId))
    ? null
    : {
        ok: false,
        status: 403,
        error:
          "Only a pod admin can define a pod-wide cell type: every space draws it. Name the space (workspaceId) to define it there.",
      };
}

/** The active cell type row a retire would deactivate, or null. */
export async function findActiveCellType(
  typeKey: string,
  workspaceId: string | null
): Promise<{ id: string; name: string } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ id: widgetDefinitions.id, name: widgetDefinitions.name })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.typeKey, typeKey),
        eq(widgetDefinitions.isActive, true),
        workspaceId
          ? eq(widgetDefinitions.workspaceId, workspaceId)
          : isNull(widgetDefinitions.workspaceId)
      )
    )
    .limit(1);
  return row ?? null;
}

/** Retire (soft-delete) a cell type in one scope. True when a row was retired. */
export async function retireCellType(
  typeKey: string,
  workspaceId: string | null
): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(widgetDefinitions)
    .set({ isActive: false, status: "retired", updatedAt: new Date() })
    .where(
      and(
        eq(widgetDefinitions.typeKey, typeKey),
        eq(widgetDefinitions.isActive, true),
        workspaceId
          ? eq(widgetDefinitions.workspaceId, workspaceId)
          : isNull(widgetDefinitions.workspaceId)
      )
    )
    .returning({ id: widgetDefinitions.id });
  return rows.length > 0;
}

/**
 * Fetch a cell from the Control Plane marketplace, admit it against Synap's
 * signed index, and define it in `workspaceId` through the ONE door
 * (`defineCell`) as `userId`.
 */
export async function installMarketplaceCell(input: {
  packageSlug: string;
  cellKey: string;
  workspaceId: string;
  userId: string;
}): Promise<{ ok: true; typeKey: string } | CellLifecycleRefusal> {
  const { packageSlug, cellKey, workspaceId, userId } = input;
  const cpUrl = controlPlaneBaseUrl();
  if (!cpUrl) {
    return {
      ok: false,
      status: 503,
      error:
        "Cell marketplace install requires CONTROL_PLANE_URL (or CP_URL) to be configured on this pod",
    };
  }

  const resp = await fetch(
    `${cpUrl}/api/marketplace/cells?q=${encodeURIComponent(cellKey)}`
  );
  if (!resp.ok) {
    return {
      ok: false,
      status: 502,
      error: `CP responded with ${resp.status}`,
    };
  }
  const data = (await resp.json()) as { cells?: CellDef[] } | CellDef[];
  const list = Array.isArray(data)
    ? data
    : ((data as { cells?: CellDef[] }).cells ?? []);
  const cell = list.find(
    (cell) => cell?.key === cellKey || cell?.key === `${packageSlug}:${cellKey}`
  );

  if (!cell) {
    return {
      ok: false,
      status: 404,
      error: `Cell '${cellKey}' not found in package '${packageSlug}'`,
    };
  }

  // Fix 4: verify CP-returned key matches what was requested
  const resolvedKey = cell.key.includes(":")
    ? cell.key.split(":").pop()!
    : cell.key;
  if (resolvedKey !== cellKey) {
    return {
      ok: false,
      status: 400,
      error: `CP returned cell key '${cell.key}' which does not match requested '${cellKey}'`,
    };
  }

  // Synap's signature rule: the cell the Control Plane served must be the
  // one its signed index lists for this package (refused once enforced).
  const admission = await admitOfficialDefinition({
    kind: "cell",
    slug: `${packageSlug}/${cellKey}`,
    definition: cell as unknown as Record<string, unknown>,
  });
  if (!admission.admitted) {
    return { ok: false, status: 412, error: admission.reason };
  }

  const depsError = validateDeps(cell.deps);
  if (depsError) {
    return { ok: false, status: 400, error: depsError };
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
    // A person installs it (directly, or by approving `cell/install`):
    // its frame writes directly (`resolveViewTrust`).
    trustLevel: "installed",
    userId,
  });
  return { ok: true, typeKey };
}
