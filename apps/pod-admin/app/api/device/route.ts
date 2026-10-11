/**
 * Device proxy — `GET /api/device?code=XXXX-XXXX` (read the waiting computer)
 * and `POST /api/device` (the ONE decision: approve or deny).
 *
 * The pod's `apiKeys.getDeviceRequest` / `apiKeys.decideDeviceRequest` are the
 * HUMAN door to a computer asking to connect (MACHINE-IDENTITY-PLAN W2). They
 * accept a signed-in session only — a key never approves a computer — so this
 * route forwards the browser's Kratos cookie through the RAW pod caller (the
 * procedures are newer than `@synap-core/api-types`; see `lib/pod-trpc.ts`).
 *
 * The POST is an allowlist, never a passthrough: only the decision fields are
 * forwarded, and `decision` must be `approve` or `deny`.
 */

import { whoamiFromCookie } from "../../../lib/kratos";
import { callPodMutation, callPodQuery } from "../../../lib/pod-trpc";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  if (!(await whoamiFromCookie(cookie)))
    return Response.json({ error: "Not signed in" }, { status: 401 });

  const code = new URL(req.url).searchParams.get("code")?.trim() ?? "";
  if (!code)
    return Response.json({ error: "code is required" }, { status: 400 });

  const res = await callPodQuery<unknown>(
    "apiKeys.getDeviceRequest",
    { userCode: code },
    cookie
  );
  if (!res.ok)
    return Response.json(
      { error: res.message, code: res.code },
      { status: res.status }
    );
  return Response.json({ request: res.data });
}

export async function POST(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  if (!(await whoamiFromCookie(cookie)))
    return Response.json({ error: "Not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const decision = body?.decision;
  if (decision !== "approve" && decision !== "deny")
    return Response.json(
      { error: "decision must be approve or deny" },
      { status: 400 }
    );
  const requestId = body?.requestId;
  const userCode = body?.userCode;
  if (typeof requestId !== "string" || typeof userCode !== "string")
    return Response.json(
      { error: "requestId and userCode are required" },
      { status: 400 }
    );

  const input: Record<string, unknown> = { requestId, userCode, decision };
  if (decision === "approve") {
    if (Array.isArray(body?.agents))
      input.agents = body.agents.filter((a) => typeof a === "string");
    if (typeof body?.reuseComputerId === "string")
      input.reuseComputerId = body.reuseComputerId;
    if (typeof body?.computerName === "string" && body.computerName.trim())
      input.computerName = body.computerName.trim();
  }

  const res = await callPodMutation<{ status: string }>(
    "apiKeys.decideDeviceRequest",
    input,
    cookie
  );
  if (!res.ok)
    return Response.json(
      { error: res.message, code: res.code },
      { status: res.status }
    );
  return Response.json(res.data);
}
