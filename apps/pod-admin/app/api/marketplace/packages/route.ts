/**
 * Catalog proxy — `GET /api/marketplace/packages`.
 *
 * Forwards to the Control Plane's ONE catalog door, `GET {CP}/api/packages`.
 * It lives here rather than in the browser for two reasons: the CP origin
 * stays server-owned (no CORS grant to this app, no build-time bake), and the
 * pod's own Kratos session — which the browser holds as a cookie — gates it.
 *
 * Only `search` / `category` / `limit` / `offset` are forwarded. The CP door
 * is `.strict()` and answers 400 `UNKNOWN_QUERY_PARAM` to anything else, so an
 * unrecognised param must be dropped here rather than passed through.
 */

import { whoamiFromCookie } from "../../../../lib/kratos";
import { controlPlaneUrl, isPackageKind } from "../../../../lib/marketplace";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const identity = await whoamiFromCookie(req.headers.get("cookie") ?? "");
  if (!identity) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }

  const incoming = new URL(req.url).searchParams;
  const query = new URLSearchParams();

  const search = incoming.get("search")?.trim();
  if (search) query.set("search", search);

  const category = incoming.get("category");
  // Silently dropping an unknown category would render "all packages" under a
  // filter chip the user believes is applied. Reject instead.
  if (category) {
    if (!isPackageKind(category)) {
      return Response.json(
        { error: `Unknown package kind: ${category}` },
        { status: 400 }
      );
    }
    query.set("category", category);
  }

  const limit = Number(incoming.get("limit") ?? 60);
  query.set(
    "limit",
    String(Number.isFinite(limit) ? Math.min(limit, 100) : 60)
  );
  const offset = Number(incoming.get("offset") ?? 0);
  query.set(
    "offset",
    String(Number.isFinite(offset) && offset > 0 ? offset : 0)
  );

  let res: Response;
  try {
    res = await fetch(`${controlPlaneUrl()}/api/packages?${query}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "Could not reach the Synap catalog." },
      { status: 502 }
    );
  }

  if (!res.ok) {
    return Response.json(
      { error: `Catalog returned ${res.status}.` },
      { status: res.status === 400 ? 400 : 502 }
    );
  }

  return Response.json(await res.json());
}
