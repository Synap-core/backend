/**
 * The READ operations a framed page may ask its host for, and the params each
 * one may carry. The hard ceiling: a host never answers an op outside this
 * table, and never forwards a param outside the op's own list.
 *
 * Ported from the desktop's `VIEW_FRAME_QUERY_OPS` (synap-app
 * `packages/web/src/cell-runtime/ViewFrame.tsx`) and its param whitelist
 * (`INTENT_READS`, browser `cells/createViewFrameHandlers.ts`), plus
 * `documents.get` for a document's content. This is the ONE table: both
 * desktop hosts import it instead of keeping their own list.
 *
 * The LENS is never a param: `workspaceId` and `projectId` are in no list, so
 * a page cannot choose which space it reads. The host stamps its own lens
 * after picking (`pickBridgeParams` drops anything else). `trackId` is a
 * param: it only narrows, and the pod floors every read anyway.
 */

/** Op → the frame params it may carry (names as the frame sends them). */
export const CELL_BRIDGE_READ_OPS = {
  "entities.list": [
    "profileSlug",
    "facetSlug",
    "includeDescendants",
    "limit",
    "offset",
  ],
  "entities.get": ["id"],
  "views.list": ["type", "profileSlug", "limit", "offset"],
  "profiles.list": ["creatableOnly"],
  "lifecycle.board": [
    "profileSlug",
    "trackId",
    "windowDays",
    "firstN",
    "column",
    "cursor",
    "limit",
    "workedBy",
  ],
  "lifecycle.throughput": ["profileSlug", "trackId", "bucket", "count"],
  "attention.needsYou": ["profileSlug", "trackId", "limit"],
  "attention.count": ["profileSlug", "trackId"],
  "sessions.list": ["profileSlug", "entityId", "status", "kind", "limit"],
  "lifecycle.home": [],
  "lifecycle.moving": ["limit"],
  "documents.get": ["documentId", "format"],
  // A lens page, WHOLE (`signals.list({ lens: "page" })`, the read every lens
  // host makes): a space package's overview. The page may only bound
  // Happened (`since`, an ISO instant); the host stamps the space and project.
  "lens.page": ["since"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type CellBridgeReadOp = keyof typeof CELL_BRIDGE_READ_OPS;

/** Every allowed read op, in table order. */
export const CELL_BRIDGE_READ_OP_NAMES = Object.freeze(
  Object.keys(CELL_BRIDGE_READ_OPS)
) as readonly CellBridgeReadOp[];

/** True only for an op in the table (own keys only: `toString` is not one). */
export function isCellBridgeReadOp(op: unknown): op is CellBridgeReadOp {
  return (
    typeof op === "string" &&
    Object.prototype.hasOwnProperty.call(CELL_BRIDGE_READ_OPS, op)
  );
}

/**
 * Ops that read ONE space's own page. A host with no space to stamp (a
 * personal or pod-wide page) refuses them: unstamped, the pod would answer
 * for every space, drawn in a frame that claims to be one space's.
 */
export const CELL_BRIDGE_SPACE_READ_OPS: ReadonlySet<CellBridgeReadOp> =
  new Set<CellBridgeReadOp>(["lens.page"]);

/** Why a host refuses `op` under this lens, or null when it may answer. */
export function cellBridgeReadRefusal(
  op: CellBridgeReadOp,
  lens: { workspaceId: string | null }
): string | null {
  if (!CELL_BRIDGE_SPACE_READ_OPS.has(op) || lens.workspaceId) return null;
  return `"${op}" reads one space, and this page is not in a space`;
}

/** A param value a host forwards: a primitive, nothing nested. */
export type CellBridgeParamValue = string | number | boolean;

/**
 * The frame's params narrowed to the op's own list: unknown names, the lens
 * (`workspaceId`, `projectId`), and every non-primitive value are dropped.
 * Strings are capped at 200 characters (an id, a slug, a cursor).
 */
export function pickBridgeParams(
  op: CellBridgeReadOp,
  params: unknown
): Record<string, CellBridgeParamValue> {
  const out: Record<string, CellBridgeParamValue> = {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return out;
  }
  const given = params as Record<string, unknown>;
  for (const name of CELL_BRIDGE_READ_OPS[op] as readonly string[]) {
    if (!Object.prototype.hasOwnProperty.call(given, name)) continue;
    const value = given[name];
    if (typeof value === "string") {
      if (value.length > 0 && value.length <= 200) out[name] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[name] = value;
    } else if (typeof value === "boolean") {
      out[name] = value;
    }
  }
  return out;
}
