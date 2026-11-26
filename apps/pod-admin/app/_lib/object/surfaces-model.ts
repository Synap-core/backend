/**
 * The Surfaces list of one object's page: which rows of `surfaces.forObject`
 * it shows and where each one opens. Pure. The rules themselves (which rows
 * are listed, the cap, the noun a body reads as, the kind its page is) live
 * once in `@synap-core/types/surfaces`; this file only adds pod admin's own
 * links.
 *
 * An ATTACHED surface opens the object's page on it
 * (`/open/<kind>/<id>?surface=<id>`); any other opens its own page.
 */
import {
  listedSurfaceRows,
  surfaceBodyLabel,
  surfaceObjectKind,
  type SurfaceAnchor,
  type SurfaceRow,
} from "@synap-core/types/surfaces";

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
  return listedSurfaceRows(rows).map((r) => {
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
    return {
      key: `${r.relation}:${r.body}:${r.id}:${r.slot ?? ""}`,
      id: r.id,
      title: r.title.trim(),
      kind,
      label: surfaceBodyLabel(r.body),
      href,
      external,
    };
  });
}
