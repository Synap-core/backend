/**
 * Updates proxy — `PUT /api/pod-updates/settings` with `{ auto?, channel? }`.
 * The pod validates the patch and the pod_admin role.
 */

import { forwardToPod } from "../_forward";

export const dynamic = "force-dynamic";

export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  return forwardToPod(req, "/settings", { body });
}
