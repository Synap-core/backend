/**
 * Forwards one call to the pod's REST `/api/pod-updates/*` with the caller's
 * cookie and address (`podCallerHeaders`). REST rather than tRPC because that is the door the pod exposes for
 * updates (`apps/api/src/routers/pod-updates.ts`); the pod re-checks the
 * session and, for a write, the pod_admin role — this only relays.
 *
 * The body is plain JSON (no tRPC envelope), so the pod's own status and body
 * pass through untouched: a 503 stays "the pod could not read its setting", a
 * 403 stays "not an admin".
 */

import { whoamiFromCookie } from "../../../lib/kratos";
import { podCallerHeaders } from "../../../lib/pod-caller-headers";

const INTERNAL_POD_URL = (
  process.env.POD_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

export async function forwardToPod(
  req: Request,
  path: string,
  write?: { body: unknown }
): Promise<Response> {
  if (!(await whoamiFromCookie(req.headers))) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  let res: Response;
  try {
    res = await fetch(`${INTERNAL_POD_URL}/api/pod-updates${path}`, {
      method: write ? "PUT" : "GET",
      headers: {
        Accept: "application/json",
        ...podCallerHeaders(req.headers),
        ...(write ? { "Content-Type": "application/json" } : {}),
      },
      body: write ? JSON.stringify(write.body) : undefined,
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "Could not reach this pod." },
      { status: 502 }
    );
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A non-JSON answer (an old pod's 404 page) is never relayed as data.
    return Response.json(
      { error: `Pod returned ${res.status}.` },
      { status: res.ok ? 502 : res.status }
    );
  }
  return Response.json(body, { status: res.status });
}
