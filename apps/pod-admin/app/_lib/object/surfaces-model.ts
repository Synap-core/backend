/**
 * The Surfaces list of one object's page: which rows of `surfaces.forObject`
 * it shows and where each one opens. Pure. The rules themselves (which rows
 * are listed, the cap, the noun a body reads as, the kind its page is) live
 * once in `@synap-core/types/surfaces`; this file only adds pod admin's own
 * links and row verbs.
 *
 * An ATTACHED surface opens the object's page on it
 * (`/open/<kind>/<id>?surface=<id>`); any other opens its own page. A row
 * that opens nowhere here (a cell, an app or a Site with no outside link) is
 * not listed: everything named is a door.
 */
import {
  listedSurfaceRows,
  surfaceBodyLabel,
  surfaceObjectKind,
  type SurfaceAnchor,
  type SurfaceBody,
  type SurfaceRef,
  type SurfaceRow,
} from "@synap-core/types/surfaces";
import type { Locale } from "@synap-core/types/i18n";

export { SURFACES_CAP } from "@synap-core/types/surfaces";

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
  /** The object kind its page is (its icon). */
  kind: string;
  /** The noun its body reads as (View, HTML artifact, Bento…). */
  label: string;
  /** In-app href; null when it opens outside the pod (`external`). */
  href: string | null;
  /** An outside link (an external app, a URL start page). */
  external: string | null;
  /**
   * What `surfaces.detach` takes off this object, or null when this row is
   * not an attachment the door can remove (Detach is then not offered).
   */
  detach: SurfaceRef | null;
}

/** The stored type a body is attached as (`ATTACHABLE_SURFACE_TYPES`). */
function attachedAs(body: SurfaceBody): SurfaceRef["type"] | null {
  switch (body) {
    case "view":
    case "bento":
    case "whiteboard":
      return "view";
    case "document":
    case "html":
      return "document";
    case "cell":
      return "cell_instance";
    default:
      return null;
  }
}

/**
 * The surface `surfaces.detach` removes for this row: only an attachment
 * read from the `attaches` links (the edge the door deletes). A row a legacy
 * store still lists as attached has no edge to remove, so it is not offered.
 */
export function detachableSurface(row: SurfaceRow): SurfaceRef | null {
  if (row.relation !== "attached" || row.source !== "attaches") return null;
  const type = attachedAs(row.body);
  return type ? { type, id: row.id } : null;
}

export function surfaceListRows(
  rows: readonly SurfaceRow[],
  anchor: SurfaceAnchor,
  objectPage: (kind: string, id: string) => string | null,
  locale?: Locale
): SurfaceListRow[] {
  return listedSurfaceRows(rows).flatMap((r) => {
    const kind = surfaceObjectKind(r.body);
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
    // Named and not openable is not a door: the row is not listed.
    if (!href && !external) return [];
    return [
      {
        key: `${r.relation}:${r.body}:${r.id}:${r.slot ?? ""}`,
        id: r.id,
        title: r.title.trim(),
        kind,
        label: surfaceBodyLabel(r.body, locale),
        href,
        external,
        detach: detachableSurface(r),
      },
    ];
  });
}

/** The address "Copy link" puts on the clipboard: absolute, shareable. */
export function surfaceRowLink(
  row: Pick<SurfaceListRow, "href" | "external">,
  origin: string
): string | null {
  if (row.external) return row.external;
  return row.href ? new URL(row.href, origin).toString() : null;
}
