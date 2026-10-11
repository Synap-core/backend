/**
 * Computer defaults proxy — `GET` / `PUT /api/machine-defaults`.
 *
 * The pod default lifetime of a computer's key (and its agents' keys), founder
 * decision 4 of MACHINE-IDENTITY-PLAN. `apiKeys.getMachineDefaults` /
 * `apiKeys.setMachineDefaults` are `podAdminProcedure`s — the pod re-checks the
 * role, this route only forwards the cookie through the RAW caller (the
 * procedures are newer than `@synap-core/api-types`; see `lib/pod-trpc.ts`).
 */

import { whoamiFromCookie } from "../../../lib/kratos";
import { callPodMutation, callPodQuery } from "../../../lib/pod-trpc";
import type { MachineDefaults } from "../../../lib/machine-defaults";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  if (!(await whoamiFromCookie(cookie)))
    return Response.json({ error: "Not signed in" }, { status: 401 });
  const res = await callPodQuery<MachineDefaults>(
    "apiKeys.getMachineDefaults",
    undefined,
    cookie
  );
  if (!res.ok)
    return Response.json({ error: res.message }, { status: res.status });
  return Response.json(res.data);
}

export async function PUT(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  if (!(await whoamiFromCookie(cookie)))
    return Response.json({ error: "Not signed in" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    keyTtlDays?: unknown;
  } | null;
  const days = body?.keyTtlDays;
  if (typeof days !== "number" || !Number.isInteger(days))
    return Response.json(
      { error: "keyTtlDays must be a whole number of days" },
      { status: 400 }
    );
  const res = await callPodMutation<MachineDefaults>(
    "apiKeys.setMachineDefaults",
    { keyTtlDays: days },
    cookie
  );
  if (!res.ok)
    return Response.json({ error: res.message }, { status: res.status });
  return Response.json(res.data);
}
