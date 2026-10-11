/**
 * Apps proxy — `GET /api/apps` (list), `DELETE /api/apps` (revoke, or
 * `{ action: "remove" }` to remove a revoked app for good), plus
 * `GET /api/apps?publicId=<id>` for ONE app (the detail page).
 *
 * The pod's `apps.list` / `apps.get` / `apps.revoke` / `apps.remove` tRPC
 * procedures are the
 * HUMAN door to a person's Applications (App Connect v1). They live behind the
 * pod's Kratos cookie, which the browser holds — but the browser cannot call
 * the pod's tRPC origin directly from here (server-owned origin), so this route
 * forwards the session cookie. `apps.*` is self-scoped to the authenticated
 * user, so this proxy can only ever read/revoke/remove the caller's own apps.
 *
 * It goes through the RAW pod caller (`callPodQuery` / `callPodMutation`)
 * rather than the typed client because a newly added procedure is invisible to
 * `@synap-core/api-types` until that generated artifact is regenerated — see
 * `lib/pod-trpc.ts`.
 */

import { whoamiFromCookie } from "../../../lib/kratos";
import { callPodMutation, callPodQuery } from "../../../lib/pod-trpc";

export const dynamic = "force-dynamic";

/** The only mutations this proxy forwards — an allowlist, never a passthrough. */
const END_PROCEDURE = {
  revoke: "apps.revoke",
  remove: "apps.remove",
} as const;

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

  // One app: the detail page's read. `apps.get` is self-scoped, so a public id
  // that is not the caller's returns NOT_FOUND rather than someone else's app.
  const publicId = new URL(req.url).searchParams.get("publicId");
  if (publicId) {
    const one = await callPodQuery<AppRow>("apps.get", { publicId }, cookie);
    if (!one.ok) {
      return Response.json({ error: one.message }, { status: one.status });
    }
    return Response.json({ app: one.data });
  }

  // The list opts into revoked apps so the page can show them under "Revoked"
  // rather than have them vanish — see `apps.list` in the pod's apps router.
  const res = await callPodQuery<AppRow[]>(
    "apps.list",
    { includeRevoked: true },
    cookie
  );
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
    action?: unknown;
  } | null;
  const publicId = body?.publicId;
  if (typeof publicId !== "string" || !publicId.trim()) {
    return Response.json({ error: "publicId is required" }, { status: 400 });
  }
  const action = body?.action ?? "revoke";
  if (action !== "revoke" && action !== "remove") {
    return Response.json(
      { error: "action must be revoke or remove" },
      { status: 400 }
    );
  }
  const res = await callPodMutation<{ revoked?: boolean; removed?: boolean }>(
    END_PROCEDURE[action],
    { publicId },
    cookie
  );
  if (!res.ok) {
    return Response.json({ error: res.message }, { status: res.status });
  }
  return Response.json(res.data);
}
