/**
 * Apps proxy — `GET /api/apps` (list) and `DELETE /api/apps` (revoke).
 *
 * The pod's `apps.list` / `apps.revoke` tRPC procedures are the HUMAN door to a
 * person's Applications (App Connect v1). They live behind the pod's Kratos
 * cookie, which the browser holds — but the browser cannot call the pod's tRPC
 * origin directly from here (server-owned origin), so this route forwards the
 * session cookie. `apps.*` is self-scoped to the authenticated user, so this
 * proxy can only ever read/revoke the caller's own apps.
 *
 * It goes through the RAW pod caller (`callPodQuery` / `callPodMutation`)
 * rather than the typed client because a newly added procedure is invisible to
 * `@synap-core/api-types` until that generated artifact is regenerated — see
 * `lib/pod-trpc.ts`.
 */

import { whoamiFromCookie } from "../../../lib/kratos";
import { callPodMutation, callPodQuery } from "../../../lib/pod-trpc";

export const dynamic = "force-dynamic";

interface AppRow {
  public_id: string;
  [key: string]: unknown;
}

export async function GET(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const identity = await whoamiFromCookie(cookie);
  if (!identity) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const res = await callPodQuery<AppRow[]>("apps.list", undefined, cookie);
  if (!res.ok) {
    return Response.json({ error: res.message }, { status: res.status });
  }
  return Response.json({ apps: res.data });
}

export async function DELETE(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const identity = await whoamiFromCookie(cookie);
  if (!identity) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as {
    publicId?: unknown;
  } | null;
  const publicId = body?.publicId;
  if (typeof publicId !== "string" || !publicId.trim()) {
    return Response.json({ error: "publicId is required" }, { status: 400 });
  }
  const res = await callPodMutation<{ revoked: boolean }>(
    "apps.revoke",
    { publicId },
    cookie
  );
  if (!res.ok) {
    return Response.json({ error: res.message }, { status: res.status });
  }
  return Response.json(res.data);
}
