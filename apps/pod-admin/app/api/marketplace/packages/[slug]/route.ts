/**
 * Package detail proxy — `GET /api/marketplace/packages/:slug`.
 *
 * `GET {CP}/api/packages/:slug` returns the catalog row PLUS the full
 * `definition` — which is what the detail page reads to describe the install.
 */

import { whoamiFromCookie } from "../../../../../lib/kratos";
import { controlPlaneUrl } from "../../../../../lib/marketplace";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const identity = await whoamiFromCookie(req.headers.get("cookie") ?? "");
  if (!identity) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }

  const { slug } = await ctx.params;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slug)) {
    return Response.json({ error: "Invalid package slug" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(
      `${controlPlaneUrl()}/api/packages/${encodeURIComponent(slug)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" }
    );
  } catch {
    return Response.json(
      { error: "Could not reach the Synap catalog." },
      { status: 502 }
    );
  }

  if (res.status === 404) {
    return Response.json({ error: "Package not found" }, { status: 404 });
  }
  if (!res.ok) {
    return Response.json(
      { error: `Catalog returned ${res.status}.` },
      { status: 502 }
    );
  }

  return Response.json(await res.json());
}
