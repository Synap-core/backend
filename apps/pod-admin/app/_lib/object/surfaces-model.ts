/**
 * The Surfaces list of one object's page (Surfaces P3): which rows of
 * `surfaces.forObject` it shows and where each one opens. Pure.
 *
 * The page already draws the object's BODY (its document) and its DETAIL look
 * (the renderer slot), so those two relations are not listed again. An
 * ATTACHED surface opens the object's page on it
 * (`/open/<kind>/<id>?surface=<id>`); any other opens its own page.
 */
import type { SurfaceAnchor, SurfaceRow } from "@synap-core/types/surfaces";

/** How many rows show before "Show all". */
export const SURFACES_CAP = 5;

/** The noun a surface's body reads as (its kind in the vocabulary). */
export function surfaceKind(row: Pick<SurfaceRow, "body">): string {
  switch (row.body) {
    case "html":
      return "document";
    case "bento":
    case "whiteboard":
      return "view";
    case "site":
      return "project";
    default:
      return row.body;
  }
}

/** Pod admin's own page for an attached surface: the object, opened on it. */
export function surfacePagePath(
  anchor: SurfaceAnchor,
  surfaceId: string
): string {
  return `/open/${encodeURIComponent(anchor.kind)}/${encodeURIComponent(anchor.id)}?surface=${encodeURIComponent(surfaceId)}`;
}

export interface SurfaceListRow {
  key: string;
  id: string;
  title: string;
  kind: string;
  /** In-app href; null when the surface has no page here (an app, a Site). */
  href: string | null;
  /** An outside link (an external app, a URL start page). */
  external: string | null;
}

export function surfaceListRows(
  rows: readonly SurfaceRow[],
  anchor: SurfaceAnchor,
  objectPage: (kind: string, id: string) => string | null
): SurfaceListRow[] {
  return rows
    .filter((r) => r.relation !== "body" && r.relation !== "renders")
    .map((r) => {
      const kind = surfaceKind(r);
      // The pod's own `/open/…` links (absolute when PUBLIC_URL is set) are
      // pages here; any other http(s) address is outside the pod.
      const external =
        /^https?:\/\//.test(r.openUrl) && !/\/open\//.test(r.openUrl)
          ? r.openUrl
          : null;
      const href = external
        ? null
        : r.relation === "attached"
          ? surfacePagePath(anchor, r.id)
          : r.body === "cell" || r.body === "app" || r.body === "site"
            ? null
            : objectPage(kind, r.id);
      return {
        key: `${r.relation}:${r.body}:${r.id}:${r.slot ?? ""}`,
        id: r.id,
        title: r.title.trim(),
        kind,
        href,
        external,
      };
    });
}
